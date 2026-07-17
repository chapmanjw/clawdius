/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Reader-seam transcript adapter + version-keyed shell
// The read implementation behind the pure `common/claudeReaderSeam.ts` interface: a version-keyed
// adapter shell (a per-format version key + an unknown-shape canary that degrades a schema shift to a labeled
// result instead of throwing) and the transcript JSONL adapter. The adapter builds the
// `projects/<encodeProjectDir>/*.jsonl` path off the RESOLVED config root (never a hardcoded `~/.claude`),
// REUSES the config store's navigation primitives (`encodeProjectDir` + `*.jsonl` mtime-latest selection), and
// ADDS a byte-offset tail read via `IFileService.readFileStream` (`position`/`length`) so a large append-only
// transcript never loads whole, byte accounting stays exact across a UTF-8 window boundary, and a half-written
// trailing line is never emitted as a complete record. Reads are target-aware (`IFileService` over URIs that keep the active
// window's scheme + authority), read-only, and never register as the SDK `sessionStore`.

import { streamToBuffer, VSBuffer } from '../../../../../base/common/buffer.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	AdapterVersionStamp, CompletenessState, CostRecord, CoverageLabel, FreshnessLabel, IReaderRequest,
	IReaderResult, IReaderSeam, ReaderConfigRoot, ReaderEntityKind, ReaderScope, Run, Session, Subagent, TaskList,
	TeamRoster, Transcript, TranscriptIndexKey,
} from '../../common/claudeReaderSeam.js';
import { FleetRun, FleetSubagent, FleetTranscriptSlice, MissionAgent, MissionPhase, MissionProgressEntry, MissionProgressKind, MissionRun, MissionStatus } from '../../common/claudeFleetModel.js';
import { encodeProjectDir } from '../clawdiusConfigStore.js';

/** The transcript read-model entities this adapter can produce, by request kind. */
type ReaderTranscriptEntity = Run | Session | Subagent | Transcript;

/** Request kinds served by the transcript JSONL adapter. Cost is derived from the same
 *  transcript records but routed separately; teams / tasks are their own adapters gated behind an experimental probe. */
const TRANSCRIPT_KINDS: ReadonlySet<ReaderEntityKind> = new Set<ReaderEntityKind>([
	'runs', 'session', 'subagent', 'transcript-slice',
]);

/** Request kinds served by the teams / tasks adapters, gated behind the experimental teams probe. */
const TEAMS_TASKS_KINDS: ReadonlySet<ReaderEntityKind> = new Set<ReaderEntityKind>(['team-roster', 'task-list']);

/** The known transcript record types (Claude CLI transcript JSONL). A line the adapter RECOGNIZES is a JSON
 *  object whose `type` is one of these; anything else is a foreign shape that trips the unknown-shape canary. */
const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'summary']);

/** The ledger file the launcher appends to DURING a workflow run (one `started`/`result` per agent). */
const JOURNAL_NAME = 'journal.jsonl';

/** A workflow run id, matching the launcher's own `wf_`-prefixed id contract. Guards against stray files. */
const RUN_ID_RE = /^wf_[a-z0-9-]{6,}$/;
/** A workflow agent id, as a PATH-SAFE token. The id is read off the journal and interpolated into
 *  `agent-<id>.jsonl` / `agent-<id>.meta.json`, so it is untrusted path input: anything outside this charset (a
 *  separator, a `..`) is rejected rather than joined, mirroring the guard `oobRef` applies to a transcript's
 *  out-of-band ref. Matches the launcher's own ids, which are plain alphanumeric/dash/underscore. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Whether an id read off the journal is safe to interpolate into a sibling `agent-<id>.*` path. */
function isAgentId(id: string): boolean {
	return AGENT_ID_RE.test(id);
}

/**
 * The on-disk shape of a workflow run manifest (`workflows/<runId>.json`). Every field is optional here on
 * purpose: this is UNDOCUMENTED launcher-internal surface, so the seam validates what it reads rather than
 * trusting a schema, and degrades a manifest it cannot recognize to `unknown-shape` + the canary stamp instead of
 * throwing.
 */
interface IWorkflowManifest {
	readonly workflowName?: string;
	readonly status?: string;
	readonly agentCount?: number;
	readonly durationMs?: number;
	readonly totalTokens?: number;
	readonly totalToolCalls?: number;
	readonly defaultModel?: string;
	readonly scriptPath?: string;
	readonly error?: string;
	readonly phases?: readonly { readonly title?: string; readonly detail?: string }[];
	readonly workflowProgress?: readonly { readonly index?: number; readonly title?: string; readonly type?: string }[];
}

/** One record of a run journal: a `started` when an agent begins, a `result` when it reports back. */
interface IWorkflowJournalRecord {
	readonly type?: string;
	readonly agentId?: string;
}

/** Whether a name is a run id (a stray file in the workflows dir is not a mission). */
function isRunId(name: string): boolean {
	return RUN_ID_RE.test(name);
}

/**
 * The manifest's status vocabulary. There is deliberately no running state: the manifest is written only when a
 * run finishes, so a live mission is recognized by its manifest-LESS journal, never by a status field.
 */
function isTerminalStatus(status: string | undefined): status is MissionStatus {
	return status === 'completed' || status === 'failed';
}

/** Whether a progress entry's type is one the read model carries. */
function isProgressKind(type: string | undefined): type is MissionProgressKind {
	return type === 'workflow_phase' || type === 'workflow_agent';
}

/** Sort precedence: the missions a user can still act on come first, so a control surface leads with live work. */
function statusRank(status: MissionStatus): number {
	switch (status) {
		case 'running': return 0;
		case 'failed': return 1;
		case 'completed': return 2;
		default: return 3;
	}
}

/** The version key stamped on a canary-tripped (unrecognized-shape) read - same format, an explicit key. */
const UNKNOWN_SHAPE_KEY = 'unknown-shape';

/** A single parsed transcript record, reduced to the index-only fields the seam needs (never the message body).
 *  `byteOffset` locates the record's line within the read window. */
interface ITranscriptRecord {
	readonly type: string;
	readonly sessionId?: string;
	readonly uuid?: string;
	readonly parentUuid?: string;
	readonly isSidechain: boolean;
	readonly cwd?: string;
	/** A reference to an out-of-band tool-result file (relative to the transcript's directory), when present. */
	readonly oobRef?: string;
	/** The model that produced an assistant record (from `message.model`), when present - for the cost rollup. */
	readonly model?: string;
	/** Authoritative input token count for this record (from `message.usage.input_tokens`), when present. */
	readonly inputTokens?: number;
	/** Authoritative output token count for this record (from `message.usage.output_tokens`), when present. */
	readonly outputTokens?: number;
	readonly byteOffset: number;
}

/** The outcome of parsing a transcript window: the recognized records plus the flags that let the adapter tell
 *  an empty file (absent) apart from a wholly-unknown shape (unknown-shape) apart from a recognized read that
 *  still contained an unreadable record shape (partial). */
/** The outcome of reading a workflow journal: its records plus whether any line was DROPPED as unparseable. A
 *  dropped `started` / `result` record silently undercounts a live mission's agents, so - exactly as for a torn
 *  transcript record - the drop must degrade completeness rather than pass unmentioned under a `complete` claim. */
interface IParsedJournal {
	readonly records: readonly IWorkflowJournalRecord[];
	readonly sawTorn: boolean;
}

interface IParsedTranscript {
	readonly records: readonly ITranscriptRecord[];
	/** At least one complete JSON object line was parsed. */
	readonly sawJson: boolean;
	/** At least one parsed line matched a recognized transcript shape. */
	readonly recognized: boolean;
	/** At least one complete JSON object line did NOT match a recognized shape (a schema drift / unreadable
	 *  record). Distinct from an extra FIELD on a recognized record, which parses forward-compatibly. */
	readonly sawForeign: boolean;
	/** At least one line opened like a JSON object but did not parse - a torn or half-written record that was
	 *  DROPPED from the read. The record is gone from the result, so this is a real gap and must degrade
	 *  completeness; without it a lossy read reports `complete`, which is the one thing the ladder exists to
	 *  prevent. Distinct from {@link sawForeign}, where the line parsed and the loss is one of interpretation. */
	readonly sawTorn: boolean;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === 'string' ? v : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
	const v = obj[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A non-null, non-array object - the shape every recognized JSON record/document must have. */
function isObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Reduce a parsed JSON line to a recognized transcript record, or undefined when the shape is not recognized. */
function toRecord(parsed: unknown, byteOffset: number): ITranscriptRecord | undefined {
	if (!isObject(parsed)) { return undefined; }
	const obj = parsed;
	const type = obj['type'];
	if (typeof type !== 'string' || !KNOWN_RECORD_TYPES.has(type)) { return undefined; }
	// Token accounting for the cost rollup: authoritative counts from `message.usage`, model from `message.model`.
	// Absent on records that carry no usage (e.g. user turns) - the cost adapter simply skips those.
	const message = obj['message'];
	const usage = isObject(message) ? message['usage'] : undefined;
	return {
		type,
		sessionId: readString(obj, 'sessionId'),
		uuid: readString(obj, 'uuid'),
		parentUuid: readString(obj, 'parentUuid'),
		isSidechain: obj['isSidechain'] === true,
		cwd: readString(obj, 'cwd'),
		oobRef: readString(obj, 'oobRef'),
		model: isObject(message) ? readString(message, 'model') : undefined,
		inputTokens: isObject(usage) ? readNumber(usage, 'input_tokens') : undefined,
		outputTokens: isObject(usage) ? readNumber(usage, 'output_tokens') : undefined,
		byteOffset,
	};
}

/** UTF-8 byte length of a string. A record's `byteOffset` is a file-absolute BYTE position, so line lengths are
 *  measured in bytes (`String.length` is UTF-16 code units and would diverge on any non-ASCII content). */
function byteLength(s: string): number {
	return VSBuffer.fromString(s).byteLength;
}

/**
 * Parse a transcript JSONL window into recognized records. Two lines are never emitted as complete records: a
 * line that is not complete JSON (a non-JSON or half-written line), AND a non-empty FINAL line with no trailing
 * newline - in an append-only JSONL the newline is the durable record boundary, so an unterminated tail is the
 * actively-appended record even when it happens to be valid JSON. `baseOffset` is the window's file-absolute
 * BYTE start, so every record's `byteOffset` is file-absolute. Pure over its input; exported for unit testing.
 */
export function parseTranscriptRecords(text: string, baseOffset = 0): IParsedTranscript {
	const records: ITranscriptRecord[] = [];
	let sawJson = false;
	let recognized = false;
	let sawForeign = false;
	let sawTorn = false;
	let offset = baseOffset;
	const lines = text.split('\n');
	const lastIdx = lines.length - 1;
	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		// A non-empty last line means the text did NOT end in '\n': the actively-appended tail record - skip it.
		const unterminatedTail = i === lastIdx && rawLine.length > 0;
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		const trimmed = line.trim();
		if (!unterminatedTail && trimmed.length > 0 && trimmed[0] === '{') {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				sawJson = true;
				const rec = toRecord(parsed, offset);
				if (rec) { records.push(rec); recognized = true; } else { sawForeign = true; }
			} catch {
				// A non-JSON or half-written line. Skipping alone does NOT keep a truncated record from being
				// surfaced as complete - it is precisely what surfaces the REST as complete, with the dropped
				// record unaccounted for. So record that the drop happened; the completeness ladder ORs this in
				// and degrades the read to `partial`, which is what a read that lost a record actually is.
				sawTorn = true;
			}
		}
		offset += byteLength(rawLine) + 1; // + the '\n' (always one byte) that split() removed
	}
	return { records, sawJson, recognized, sawForeign, sawTorn };
}

/**
 * Parses one on-disk Claude format behind a per-format version key. A recognized shape parses to a labeled
 * entity; an UNRECOGNIZED shape trips the unknown-shape canary to a degraded result carrying the adapter
 * version stamp, never throwing. Concrete adapters supply the recognizer + the entity derivation.
 */
abstract class VersionKeyedAdapter {
	/** Which on-disk format this adapter reads. */
	abstract readonly format: string;
	/** The recognized shape's version key. */
	abstract readonly versionKey: string;

	/** The stamp identifying a recognized read. */
	protected get stamp(): AdapterVersionStamp { return { format: this.format, versionKey: this.versionKey }; }
	/** The stamp for a canary-tripped read: the same format, an explicit unknown-shape key. */
	protected get canaryStamp(): AdapterVersionStamp { return { format: this.format, versionKey: UNKNOWN_SHAPE_KEY }; }

	/** Wrap an entity with the four honesty labels for a recognized read. */
	protected result<T>(entity: T, coverage: CoverageLabel, freshness: FreshnessLabel, completeness: CompletenessState): IReaderResult<T> {
		return { entity, coverage, freshness, completeness, adapterVersion: this.stamp };
	}

	/** The canary result: completeness=unknown-shape + the adapter version stamp. Never throws. */
	protected unknownShape<T>(entity: T, coverage: CoverageLabel, freshness: FreshnessLabel): IReaderResult<T> {
		return { entity, coverage, freshness, completeness: CompletenessState.UnknownShape, adapterVersion: this.canaryStamp };
	}
}

/** Build the index-only entity of the requested kind from a set of parsed records. */
function deriveEntity(kind: ReaderEntityKind, records: readonly ITranscriptRecord[], fileIdentity: string): ReaderTranscriptEntity {
	// Prefer a real turn (user/assistant) for the main line so the run identity + index point at a turn, not a
	// leading `summary` header; fall back to the first non-sidechain record.
	const main = records.find(r => !r.isSidechain && (r.type === 'user' || r.type === 'assistant'))
		?? records.find(r => !r.isSidechain);
	const sub = records.find(r => r.isSidechain);
	const sessionId = records.map(r => r.sessionId).find(s => s !== undefined) ?? '';
	const indexAt = (rec: ITranscriptRecord | undefined): TranscriptIndexKey => ({ fileIdentity, byteOffset: rec?.byteOffset ?? 0 });
	switch (kind) {
		case 'runs': return { runId: main?.uuid ?? sessionId, sessionId, index: indexAt(main) };
		case 'subagent': return { subagentId: sub?.uuid ?? '', parentRunId: sessionId, index: indexAt(sub) };
		case 'transcript-slice': return { sessionId, index: indexAt(main) };
		default: return { sessionId, index: indexAt(main) };
	}
}

/** An empty index-only entity of the requested kind, for a degraded (absent / unknown-shape) result. */
function emptyEntity(kind: ReaderEntityKind): ReaderTranscriptEntity {
	return deriveEntity(kind, [], '');
}

/** Normalize a path for a coarse, scheme-agnostic, case-folded compare. This is coverage SCOPING only
 *  (defense-in-depth: an other-workspace run is surfaced as foreign, never dropped), not record identity; the
 *  case fold is a cross-platform tolerance, deliberately conservative (it can only widen in-scope, never hide a
 *  run). Record identity is `fileIdentity` + `byteOffset`, not this. */
function normalizePath(p: string): string {
	return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** in-scope unless a session declares a working dir outside `folder` (an other-workspace run is surfaced as
 *  foreign, never silently dropped). Shared by the transcript and cost adapters. */
function coverageOf(records: readonly ITranscriptRecord[], folder: URI): CoverageLabel {
	const cwd = records.map(r => r.cwd).find(c => c !== undefined);
	if (cwd === undefined) { return CoverageLabel.InScope; }
	return normalizePath(cwd) === normalizePath(folder.fsPath) ? CoverageLabel.InScope : CoverageLabel.Foreign;
}

/** The enumeration analogue of {@link coverageOf} against the set of active workspace folders: in-scope when the
 *  run's declared cwd matches ANY active folder, foreign when it matches none (an other-workspace run is surfaced
 *  with its label, never dropped), in-scope when the run declares no cwd (scope cannot be narrowed, so
 *  the conservative choice is not to hide it). With no active folders a run that declares a cwd is foreign. */
function coverageForEnum(records: readonly ITranscriptRecord[], folders: readonly URI[]): CoverageLabel {
	const cwd = records.map(r => r.cwd).find(c => c !== undefined);
	if (cwd === undefined) { return CoverageLabel.InScope; }
	const c = normalizePath(cwd);
	return folders.some(f => normalizePath(f.fsPath) === c) ? CoverageLabel.InScope : CoverageLabel.Foreign;
}

/**
 * Whether a parsed read has a KNOWN GAP - the single rule behind every `partial` this seam reports, expressed once
 * because all four ladders below must agree on what a gap is. Three ways to be missing something, all real:
 *   - `sawTorn`   - a line opened like JSON and did not parse, so the record was DROPPED from the result.
 *   - `sawForeign`- a line parsed but matched no known shape, so the record is real content the read cannot surface.
 *   - `base > 0`  - the tail window started mid-file, so records older than the window were never in view.
 * `complete` therefore means what it says: nothing was dropped, nothing was unreadable, and nothing fell outside
 * the window. Any doubt resolves DOWN to `partial` - the ladder's whole purpose is that it can never overclaim.
 */
function hasKnownGap(parsed: IParsedTranscript, base: number): boolean {
	return parsed.sawTorn || parsed.sawForeign || base > 0;
}

/** The honesty ladder for an enumerated session file, mirroring the transcript adapter's read: an empty file is
 *  `absent`; JSON present but no recognized line is `unknown-shape` (the canary); a read with any known gap
 *  ({@link hasKnownGap}) is `partial`; else `complete`. The out-of-band completeness probe is a per-transcript
 *  drill-in concern, not run over every enumerated file. */
function enumCompleteness(parsed: IParsedTranscript, base: number): CompletenessState {
	if (!parsed.sawJson) { return CompletenessState.Absent; }
	if (!parsed.recognized) { return CompletenessState.UnknownShape; }
	return hasKnownGap(parsed, base) ? CompletenessState.Partial : CompletenessState.Complete;
}

/** The `<sessionId>` stem of a session file (Claude names each transcript `<sessionId>.jsonl`), used as a stable
 *  id fallback when the file's records carry no session/run id (e.g. an empty or unknown-shape file). */
function fileStem(file: URI): string {
	const name = file.path.split('/').pop() ?? '';
	return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
}

/**
 * The transcript JSONL adapter. Reads the active session file under
 * `<root>/projects/<encodeProjectDir(folder)>/*.jsonl`, byte-offset tail-read, and produces the requested
 * index-only entity with all four honesty labels. Read-only.
 */
export class TranscriptJsonlAdapter extends VersionKeyedAdapter {
	readonly format = 'transcript-jsonl';
	readonly versionKey = 'v1';

	/** Default cap on the tail read so a multi-MB append-only transcript never loads whole (bounded like the
	 *  config store's own tail reads). Injectable so a test can force the `start > 0` window path. */
	static readonly DEFAULT_MAX_TAIL_BYTES = 1024 * 1024;

	constructor(
		private readonly fileService: IFileService,
		private readonly maxTailBytes: number = TranscriptJsonlAdapter.DEFAULT_MAX_TAIL_BYTES,
	) { super(); }

	/**
	 * Read the active transcript for `folder` under the resolved config `root`, as the requested entity. Never
	 * throws: a missing tree is `absent`, an unrecognized shape is `unknown-shape`, a missing out-of-band file
	 * is `partial`. `freshness` is always `polled` here - the live-event source is a consuming-surface concern.
	 */
	async read(root: URI, folder: URI, kind: ReaderEntityKind): Promise<IReaderResult<ReaderTranscriptEntity>> {
		const active = await this.readActive(root, folder);
		if (!active) {
			// No session file under the projects dir: absent, not an error.
			return this.result(emptyEntity(kind), CoverageLabel.InScope, FreshnessLabel.Polled, CompletenessState.Absent);
		}
		const { parsed, file, base } = active;
		if (!parsed.sawJson) {
			// The file exists but has no content (a fresh / empty session): absent, not unknown-shape.
			return this.result(emptyEntity(kind), CoverageLabel.InScope, FreshnessLabel.Polled, CompletenessState.Absent);
		}
		if (!parsed.recognized) {
			// JSON was present but NO line matched a known shape: a wholesale schema shift - trip the canary.
			return this.unknownShape(emptyEntity(kind), CoverageLabel.InScope, FreshnessLabel.Polled);
		}
		const coverage = coverageOf(parsed.records, folder);
		// A read with any known gap ({@link hasKnownGap}: a dropped torn record, an unreadable shape, or a tail
		// window that started mid-file) is `partial`. Otherwise defer to the out-of-band check.
		const completeness = hasKnownGap(parsed, base)
			? CompletenessState.Partial
			: await this.completenessOf(parsed.records, file);
		return this.result(deriveEntity(kind, parsed.records, file.toString()), coverage, FreshnessLabel.Polled, completeness);
	}

	/**
	 * Locate + tail-read + parse the active transcript for `folder` under `root` - the shared read step behind
	 * BOTH the transcript entity and the token-first cost rollup (which is computed from the same records).
	 * Returns undefined when there is no session file. Read-only.
	 */
	async readActive(root: URI, folder: URI): Promise<{ readonly parsed: IParsedTranscript; readonly file: URI; readonly base: number } | undefined> {
		const projectsDir = URI.joinPath(root, 'projects', encodeProjectDir(folder));
		const file = await this.selectActiveFile(projectsDir);
		if (!file) { return undefined; }
		const { parsed, base } = await this.parseFile(file);
		return { parsed, file, base };
	}

	/** Tail-read + parse one specific session file - the shared read step behind both {@link readActive} (which
	 *  selects the active file in a folder's project dir) and the cross-project enumeration (which reads every
	 *  file it walked). Read-only. */
	private async parseFile(file: URI): Promise<{ readonly parsed: IParsedTranscript; readonly base: number }> {
		const { text, base } = await this.readTail(file);
		return { parsed: parseTranscriptRecords(text, base), base };
	}

	/**
	 * Enumerate every run across the resolved config root's `projects/*` dirs as a LABELED LIST of {@link FleetRun}
	 * - the cross-project walk the fleet lists (the shipped {@link read} returns ONE entity for a
	 * single folder's active file). Each session file becomes one run, carrying coverage (against `folders`) /
	 * freshness=polled / completeness + the adapter-version stamp; a foreign or unknown-shape run is present WITH
	 * its label, never omitted. `ownership` is always `foreign` here (the never-falsely-owned
	 * floor). Deterministically ordered. Read-only - never reads outside `projects/` and never writes.
	 */
	async enumerateRuns(root: URI, folders: readonly URI[]): Promise<readonly FleetRun[]> {
		const out: FleetRun[] = [];
		for (const file of await this.listProjectFiles(root)) {
			const { parsed, base } = await this.parseFile(file);
			const runEntity = deriveEntity('runs', parsed.records, file.toString()) as Run;
			const sessionId = runEntity.sessionId || fileStem(file);
			const canary = parsed.sawJson && !parsed.recognized;
			out.push({
				runId: runEntity.runId || sessionId,
				sessionId,
				kind: 'single',
				status: 'unknown',
				ownership: 'foreign',
				coverage: coverageForEnum(parsed.records, folders),
				freshness: FreshnessLabel.Polled,
				completeness: enumCompleteness(parsed, base),
				adapterVersion: canary ? this.canaryStamp : this.stamp,
			});
		}
		return out.sort((a, b) => a.runId.localeCompare(b.runId) || a.sessionId.localeCompare(b.sessionId));
	}

	/**
	 * Enumerate every ultracode workflow MISSION under the resolved config root as a LABELED LIST of
	 * {@link MissionRun} - the fleet's primary read. A mission is identified by its RUN ARTIFACTS, never by a field
	 * inside a transcript, because the launcher records a run in two places and the pair is what makes a mission
	 * legible:
	 *
	 *  - `projects/<enc>/<session>/workflows/<runId>.json` - the manifest, written ONLY when the run reaches a
	 *    terminal state. It carries the whole summary (name, status, phases, progress, agent count, totals), so a
	 *    finished mission is described without opening a single transcript.
	 *  - `projects/<enc>/<session>/subagents/workflows/<runId>/journal.jsonl` - the ledger, appended DURING the
	 *    run (one `started` per agent, one `result` per agent that finished).
	 *
	 * The asymmetry is the whole design: a journal with NO manifest beside it is a run still IN FLIGHT, which is
	 * the only way to see a live mission at all (the manifest's own status vocabulary has no running state). A
	 * live mission is therefore `running` with counts read off its journal, and is NOT degraded for lacking a
	 * manifest - in-flight is not incomplete.
	 *
	 * This walk never reads a transcript: it resolves session sidecar dirs and reads small JSON/ledger files, so
	 * listing missions costs a bounded number of tiny reads rather than a tail-read per session file.
	 * Deterministically ordered, most actionable first. Read-only.
	 */
	async enumerateMissions(root: URI): Promise<readonly MissionRun[]> {
		const out: MissionRun[] = [];
		for (const sessionDir of await this.listSessionSidecarDirs(root)) {
			const sessionId = basename(sessionDir);
			const manifests = await this.readMissionManifests(sessionDir);
			for (const [runId, manifest] of manifests) {
				out.push(this.missionFromManifest(runId, sessionId, manifest));
			}
			for (const [runId, journal] of await this.listMissionJournals(sessionDir)) {
				// A manifest wins: it is the terminal record of the same run. Only a manifest-less journal is live.
				if (!manifests.has(runId)) {
					out.push(await this.missionFromJournal(runId, sessionId, journal));
				}
			}
		}
		return out.sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.runId.localeCompare(b.runId));
	}

	/**
	 * Enumerate one mission's agents as a LABELED LIST of {@link MissionAgent}, resolved LAZILY on drill-in (never
	 * during the mission list). Unlike a Task subagent - a sidechain record inside its parent's transcript - a
	 * workflow agent is its OWN file, so the journal's `agentId` is the join key to the sibling
	 * `agent-<agentId>.jsonl`. An agent that reported no `result` is `finished: false` (in flight, failed, or
	 * aborted) and is listed WITH that label, never omitted. Returns [] when the mission has no journal.
	 */
	async enumerateMissionAgents(root: URI, mission: MissionRun): Promise<readonly MissionAgent[]> {
		const dir = await this.findMissionJournalDir(root, mission);
		if (!dir) { return []; }
		const { records, sawTorn } = await this.readJournal(URI.joinPath(dir, JOURNAL_NAME));
		const finished = new Set(records.filter(r => r.type === 'result' && r.agentId).map(r => r.agentId));
		const seen = new Set<string>();
		const out: MissionAgent[] = [];
		for (const record of records) {
			const agentId = record.agentId;
			// An agent's id is the join key to its sibling `agent-<id>.jsonl`, so it is a path component read off
			// disk: hold it to the same charset guard `oobRef` applies to a transcript's out-of-band ref rather than
			// interpolating it raw. A `..` or separator here would steer the join outside the mission dir.
			if (record.type !== 'started' || !agentId || !isAgentId(agentId) || seen.has(agentId)) { continue; }
			seen.add(agentId);
			out.push({
				agentId,
				runId: mission.runId,
				agentType: await this.readAgentType(dir, agentId),
				finished: finished.has(agentId),
				transcriptRef: URI.joinPath(dir, `agent-${agentId}.jsonl`).toString(),
				coverage: mission.coverage,
				freshness: mission.freshness,
				// A torn journal line may have DROPPED a `started` record, in which case that agent is missing from
				// this list entirely and no row can carry its absence. Label every row `partial` so the gap is
				// visible on the list the user actually reads: a short list that claims `complete` is the lie.
				completeness: sawTorn ? CompletenessState.Partial : mission.completeness,
			});
		}
		return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
	}

	/** Build a mission from its terminal manifest. Status comes straight off the record - never inferred. */
	private missionFromManifest(runId: string, sessionId: string, m: IWorkflowManifest): MissionRun {
		const phases: MissionPhase[] = (m.phases ?? [])
			.filter(p => typeof p?.title === 'string')
			.map(p => (p.detail !== undefined ? { title: p.title!, detail: p.detail } : { title: p.title! }));
		const progress: MissionProgressEntry[] = (m.workflowProgress ?? [])
			.filter(p => typeof p?.title === 'string' && isProgressKind(p.type))
			.map(p => ({ index: p.index ?? 0, title: p.title!, kind: p.type as MissionProgressKind }));
		const recognized = typeof m.workflowName === 'string' && isTerminalStatus(m.status);
		return {
			runId,
			sessionId,
			name: m.workflowName ?? runId,
			status: isTerminalStatus(m.status) ? m.status as MissionStatus : 'unknown',
			agentCount: m.agentCount ?? progress.filter(p => p.kind === 'workflow_agent').length,
			phases,
			progress,
			durationMs: m.durationMs,
			totalTokens: m.totalTokens,
			totalToolCalls: m.totalToolCalls,
			defaultModel: m.defaultModel,
			scriptPath: m.scriptPath,
			error: m.error,
			ownership: 'foreign',
			coverage: CoverageLabel.InScope,
			freshness: FreshnessLabel.Polled,
			completeness: recognized ? CompletenessState.Complete : CompletenessState.UnknownShape,
			adapterVersion: recognized ? this.stamp : this.canaryStamp,
		};
	}

	/**
	 * Build a mission from a manifest-less journal: a run still IN FLIGHT. Everything the manifest would carry
	 * (name, phases, totals) is simply not on disk yet, so this reports what the ledger actually proves - how many
	 * agents started and how many finished - and labels the read `live`. It is `Complete` because the journal is a
	 * whole record of what has happened SO FAR; a run in progress is not a partial read.
	 */
	private async missionFromJournal(runId: string, sessionId: string, journal: URI): Promise<MissionRun> {
		const { records, sawTorn } = await this.readJournal(journal);
		const started = new Set(records.filter(r => r.type === 'started' && r.agentId).map(r => r.agentId)).size;
		const results = new Set(records.filter(r => r.type === 'result' && r.agentId).map(r => r.agentId)).size;
		return {
			runId,
			sessionId,
			name: runId,
			status: 'running',
			agentCount: started,
			startedCount: started,
			resultCount: results,
			phases: [],
			progress: [],
			ownership: 'foreign',
			coverage: CoverageLabel.InScope,
			freshness: FreshnessLabel.Live,
			// A torn journal line is a DROPPED record, and these counts are derived from exactly those records: a lost
			// `started` / `result` silently undercounts the mission's agents, so a row would read "agents: 4/5" for a
			// 5/6 run while claiming `complete`. Degrade to `partial` - the counts are still the best available, but
			// they are no longer a whole read and must not be labeled as one.
			completeness: sawTorn ? CompletenessState.Partial
				: records.length > 0 ? CompletenessState.Complete : CompletenessState.Absent,
			adapterVersion: this.stamp,
		};
	}

	/** Every `projects/<enc>/<session>/` sidecar dir (only sessions that produced run artifacts have one). */
	private async listSessionSidecarDirs(root: URI): Promise<URI[]> {
		const dirs: URI[] = [];
		let projectDirs: readonly URI[];
		try {
			const stat = await this.fileService.resolve(URI.joinPath(root, 'projects'));
			projectDirs = (stat.children ?? []).filter(c => c.isDirectory).map(c => c.resource);
		} catch { return dirs; }
		for (const dir of projectDirs) {
			try {
				const stat = await this.fileService.resolve(dir);
				for (const c of stat.children ?? []) {
					if (c.isDirectory && c.name !== 'memory') { dirs.push(c.resource); }
				}
			} catch { /* skip an unreadable project dir */ }
		}
		return dirs;
	}

	/** The terminal manifests under a session's `workflows/` dir, keyed by run id. Unparseable ones are skipped. */
	private async readMissionManifests(sessionDir: URI): Promise<Map<string, IWorkflowManifest>> {
		const out = new Map<string, IWorkflowManifest>();
		let files: readonly URI[];
		try {
			const stat = await this.fileService.resolve(URI.joinPath(sessionDir, 'workflows'));
			files = (stat.children ?? []).filter(c => !c.isDirectory && c.name.endsWith('.json')).map(c => c.resource);
		} catch { return out; }
		for (const file of files) {
			const runId = basename(file).slice(0, -'.json'.length);
			if (!isRunId(runId)) { continue; }
			try {
				const parsed: unknown = JSON.parse((await this.fileService.readFile(file)).value.toString());
				if (parsed && typeof parsed === 'object') { out.set(runId, parsed as IWorkflowManifest); }
			} catch { /* an unreadable/!JSON manifest is simply not a legible mission */ }
		}
		return out;
	}

	/** The run journals under a session's `subagents/workflows/` dir, keyed by run id. */
	private async listMissionJournals(sessionDir: URI): Promise<Map<string, URI>> {
		const out = new Map<string, URI>();
		let runDirs: readonly URI[];
		try {
			const stat = await this.fileService.resolve(URI.joinPath(sessionDir, 'subagents', 'workflows'));
			runDirs = (stat.children ?? []).filter(c => c.isDirectory).map(c => c.resource);
		} catch { return out; }
		for (const dir of runDirs) {
			const runId = basename(dir);
			if (!isRunId(runId)) { continue; }
			const journal = URI.joinPath(dir, JOURNAL_NAME);
			if (await this.fileService.exists(journal)) { out.set(runId, journal); }
		}
		return out;
	}

	/** Locate a mission's journal DIR (which also holds its agent transcripts), or undefined when it has none. */
	private async findMissionJournalDir(root: URI, mission: MissionRun): Promise<URI | undefined> {
		for (const sessionDir of await this.listSessionSidecarDirs(root)) {
			if (basename(sessionDir) !== mission.sessionId) { continue; }
			const dir = URI.joinPath(sessionDir, 'subagents', 'workflows', mission.runId);
			if (await this.fileService.exists(URI.joinPath(dir, JOURNAL_NAME))) { return dir; }
		}
		return undefined;
	}

	/** A journal's records. Never throws: a missing/torn ledger yields only the lines that did parse. */
	private async readJournal(journal: URI): Promise<IParsedJournal> {
		let text: string;
		try { text = (await this.fileService.readFile(journal)).value.toString(); } catch { return { records: [], sawTorn: false }; }
		const records: IWorkflowJournalRecord[] = [];
		let sawTorn = false;
		const lines = text.split('\n');
		const lastIdx = lines.length - 1;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line.trim()) { continue; }
			// A non-empty LAST line means the file did not end in '\n': the record the launcher is appending right
			// now. Expected on a live run and not a tear - skip it without flagging, mirroring
			// `parseTranscriptRecords`. Any OTHER unparseable line is a real tear: the journal is append-only, so a
			// line with a terminator after it was fully written and then damaged.
			if (i === lastIdx) { continue; }
			try {
				const parsed: unknown = JSON.parse(line);
				if (parsed && typeof parsed === 'object') { records.push(parsed as IWorkflowJournalRecord); } else { sawTorn = true; }
			} catch {
				sawTorn = true;
			}
		}
		return { records, sawTorn };
	}

	/** The agent role from its `agent-<id>.meta.json` sidecar, or undefined when there is none. */
	private async readAgentType(dir: URI, agentId: string): Promise<string | undefined> {
		try {
			const file = URI.joinPath(dir, `agent-${agentId}.meta.json`);
			const parsed: unknown = JSON.parse((await this.fileService.readFile(file)).value.toString());
			const agentType = (parsed as { agentType?: unknown } | null)?.agentType;
			return typeof agentType === 'string' ? agentType : undefined;
		} catch { return undefined; }
	}

	/**
	 * Enumerate a run's subagents as a LABELED LIST of {@link FleetSubagent}. A subagent is a sidechain
	 * ROOT - a `isSidechain` record whose parent is a main-line record (i.e. where a Task spawned it) - so a
	 * subagent's own multi-turn sidechain collapses to the single subagent that owns it. Each carries the run's
	 * coverage / freshness / completeness and a `transcriptRef` (the file identity) drillable via the shipped
	 * `subagent` / `transcript-slice` reads. Returns [] when the run's file cannot be located. Read-only.
	 */
	async enumerateSubagents(root: URI, run: FleetRun, folders: readonly URI[]): Promise<readonly FleetSubagent[]> {
		const file = await this.findRunFile(root, run);
		if (!file) { return []; }
		const { parsed, base } = await this.parseFile(file);
		const completeness = enumCompleteness(parsed, base);
		const coverage = coverageForEnum(parsed.records, folders);
		const transcriptRef = file.toString();
		const sidechainUuids = new Set(parsed.records.filter(r => r.isSidechain && r.uuid).map(r => r.uuid));
		const out: FleetSubagent[] = parsed.records
			.filter(r => r.isSidechain && (r.parentUuid === undefined || !sidechainUuids.has(r.parentUuid)))
			.map(r => ({
				subagentId: r.uuid ?? '',
				parentRunId: run.runId,
				transcriptRef,
				coverage,
				freshness: FreshnessLabel.Polled,
				completeness,
			}));
		return out.sort((a, b) => a.subagentId.localeCompare(b.subagentId));
	}

	/**
	 * Read a subagent's on-disk transcript by its opaque `transcriptRef` (the file identity handed out at
	 * enumeration) as a labeled {@link FleetTranscriptSlice} - the per-subagent drill-in read. Unlike the
	 * coarse enumeration completeness, this runs the out-of-band tool-result probe, so a transcript referencing a
	 * missing out-of-band file degrades to `partial`, not `complete`. The records are INDEX-ONLY (type +
	 * sidechain flag; never the message body). Never throws: a missing/empty file is `absent`, an unrecognized
	 * shape is `unknown-shape`. Read-only - reads only the seam's own indexed file, never writes.
	 */
	async readTranscriptSlice(subagent: FleetSubagent, folders: readonly URI[]): Promise<FleetTranscriptSlice> {
		const ref = subagent.transcriptRef;
		if (!ref) {
			return { subagentId: subagent.subagentId, records: [], coverage: CoverageLabel.OutOfScope, freshness: FreshnessLabel.Stale, completeness: CompletenessState.Absent, adapterVersion: this.stamp };
		}
		let file: URI;
		try {
			file = URI.parse(ref);
		} catch {
			return { subagentId: subagent.subagentId, records: [], coverage: CoverageLabel.OutOfScope, freshness: FreshnessLabel.Stale, completeness: CompletenessState.Absent, adapterVersion: this.stamp };
		}
		const { parsed, base } = await this.parseFile(file);
		if (!parsed.sawJson) {
			// The file is missing / empty (a fresh or removed session): absent, not an error.
			return { subagentId: subagent.subagentId, records: [], coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Absent, adapterVersion: this.stamp };
		}
		if (!parsed.recognized) {
			// JSON present but no recognized shape: a wholesale schema shift - trip the canary.
			return { subagentId: subagent.subagentId, records: [], coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.UnknownShape, adapterVersion: this.canaryStamp };
		}
		// A known gap ({@link hasKnownGap}) is `partial`, as is - the drill-in's extra probe - a referenced
		// out-of-band tool-result file that is missing. Otherwise the read is whole.
		const completeness = hasKnownGap(parsed, base)
			? CompletenessState.Partial
			: await this.completenessOf(parsed.records, file);
		return {
			subagentId: subagent.subagentId,
			records: parsed.records.map(r => ({ type: r.type, isSidechain: r.isSidechain })),
			coverage: coverageForEnum(parsed.records, folders),
			freshness: FreshnessLabel.Polled,
			completeness,
			adapterVersion: this.stamp,
		};
	}

	/** Locate the session file for a run: first by the `<sessionId>.jsonl` naming convention (no read), else by
	 *  parsing each file and matching the derived session/run id. Undefined when no file matches. Read-only. */
	private async findRunFile(root: URI, run: FleetRun): Promise<URI | undefined> {
		const files = await this.listProjectFiles(root);
		const byStem = files.find(f => fileStem(f) === run.sessionId);
		if (byStem) { return byStem; }
		for (const file of files) {
			const { parsed } = await this.parseFile(file);
			const e = deriveEntity('runs', parsed.records, file.toString()) as Run;
			if ((e.sessionId && e.sessionId === run.sessionId) || (e.runId && e.runId === run.runId)) { return file; }
		}
		return undefined;
	}

	/** Every `*.jsonl` session file under `<root>/projects/*` (one directory deep, matching Claude's per-project
	 *  layout). A missing/unreadable `projects/` dir yields [] (no config -> empty labeled result). Read-only. */
	private async listProjectFiles(root: URI): Promise<URI[]> {
		const files: URI[] = [];
		let projectDirs: readonly URI[];
		try {
			const stat = await this.fileService.resolve(URI.joinPath(root, 'projects'));
			projectDirs = (stat.children ?? []).filter(c => c.isDirectory).map(c => c.resource);
		} catch { return files; }
		for (const dir of projectDirs) {
			try {
				const stat = await this.fileService.resolve(dir);
				for (const c of stat.children ?? []) {
					if (!c.isDirectory && c.name.endsWith('.jsonl')) { files.push(c.resource); }
				}
			} catch { /* skip an unreadable project dir */ }
		}
		return files;
	}

	/** The newest `*.jsonl` session file under the projects dir (mtime-latest), or undefined when there is none. */
	private async selectActiveFile(projectsDir: URI): Promise<URI | undefined> {
		try {
			const stat = await this.fileService.resolve(projectsDir, { resolveMetadata: true });
			const files = (stat.children ?? []).filter(c => !c.isDirectory && c.name.endsWith('.jsonl'));
			if (files.length === 0) { return undefined; }
			let latest = files[0];
			for (const f of files) { if (f.mtime > latest.mtime) { latest = f; } }
			return latest.resource;
		} catch { return undefined; }
	}

	/** Byte-offset tail read via `readFileStream` (position/length): read at most the last `maxTailBytes` and,
	 *  when the window started mid-file, drop the partial leading line AND advance `base` past it so every
	 *  record's `byteOffset` stays file-absolute. The newline is located in the RAW BYTES (not the decoded
	 *  string) so a `start` that lands inside a multi-byte UTF-8 sequence cannot corrupt the byte count via a
	 *  U+FFFD replacement; only the retained suffix (which begins at a record boundary) is decoded.
	 *  Best-effort - returns an empty window on any read error. */
	private async readTail(file: URI): Promise<{ readonly text: string; readonly base: number }> {
		try {
			const size = (await this.fileService.stat(file)).size ?? 0;
			if (size === 0) { return { text: '', base: 0 }; }
			const start = size > this.maxTailBytes ? size - this.maxTailBytes : 0;
			const stream = await this.fileService.readFileStream(file, { position: start, length: size - start });
			const buffer = await streamToBuffer(stream.value);
			if (start === 0) { return { text: buffer.toString(), base: 0 }; }
			const nl = buffer.buffer.indexOf(0x0a); // first '\n' byte in the window
			// No newline in the whole window: one over-long record - keep it whole, base stays at the window start.
			if (nl < 0) { return { text: buffer.toString(), base: start }; }
			return { text: buffer.slice(nl + 1).toString(), base: start + nl + 1 };
		} catch { return { text: '', base: 0 }; }
	}

	/** partial when the transcript references an out-of-band tool-result file that is missing; else complete. */
	private async completenessOf(records: readonly ITranscriptRecord[], file: URI): Promise<CompletenessState> {
		const dir = URI.joinPath(file, '..');
		for (const r of records) {
			if (!r.oobRef) { continue; }
			const segments = r.oobRef.split('/').filter(s => s.length > 0);
			// A ref that is empty or tries to escape the transcript dir (`..`) is treated as an unresolvable
			// (missing) reference - never probe outside the transcript's own directory from a transcript field.
			if (segments.length === 0 || segments.includes('..')) { return CompletenessState.Partial; }
			if (!(await this.fileService.exists(URI.joinPath(dir, ...segments)))) { return CompletenessState.Partial; }
		}
		return CompletenessState.Complete;
	}
}

/**
 * Reads a single small JSON document under the resolved config root (the teams / tasks config files, read
 * WHOLE because they are small config docs - unlike the append-only transcript that needs a byte-offset tail).
 * The honest ladder mirrors the transcript adapter's: a missing / empty document is `absent`; a recognized
 * shape parses to the entity + `complete`; any other JSON (or non-JSON) trips the unknown-shape canary. These
 * are global under the config root (not workspace-scoped), so coverage is always in-scope. Read-only.
 */
abstract class JsonDocAdapter<E> extends VersionKeyedAdapter {
	constructor(protected readonly fileService: IFileService) { super(); }

	/** The document this adapter reads, relative to the resolved config root. */
	protected abstract locate(root: URI): URI;
	/** True when the parsed JSON object is a shape this adapter version recognizes. */
	protected abstract recognizes(obj: Record<string, unknown>): boolean;
	/** Derive the index-only entity from a recognized JSON object. */
	protected abstract derive(obj: Record<string, unknown>): E;
	/** The empty entity for a degraded (absent / unknown-shape) result. */
	protected abstract empty(): E;

	async read(root: URI): Promise<IReaderResult<E>> {
		const text = await this.readWhole(this.locate(root));
		if (text === undefined || text.trim().length === 0) {
			// Missing file, unreadable, or an empty document (fresh install / disbanded team): absent, not an error.
			return this.result(this.empty(), CoverageLabel.InScope, FreshnessLabel.Polled, CompletenessState.Absent);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// A non-JSON / half-written document is an unrecognized shape, never a throw.
			return this.unknownShape(this.empty(), CoverageLabel.InScope, FreshnessLabel.Polled);
		}
		if (!isObject(parsed) || !this.recognizes(parsed)) {
			// Valid JSON but not a shape this adapter version knows: a schema shift - trip the canary.
			return this.unknownShape(this.empty(), CoverageLabel.InScope, FreshnessLabel.Polled);
		}
		return this.result(this.derive(parsed), CoverageLabel.InScope, FreshnessLabel.Polled, CompletenessState.Complete);
	}

	/** Read a small JSON document whole, or undefined when it does not exist. Best-effort, read-only. */
	private async readWhole(file: URI): Promise<string | undefined> {
		try {
			if (!(await this.fileService.exists(file))) { return undefined; }
			return (await this.fileService.readFile(file)).value.toString();
		} catch { return undefined; }
	}
}

/**
 * The teams roster adapter (behind the experimental teams probe): reads `<root>/teams/config.json` and produces
 * a {@link TeamRoster} (members + the Mailbox sub-view). The recognized shape is version-keyed, so a real
 * teams-format drift trips the canary rather than mis-parsing.
 */
export class TeamsAdapter extends JsonDocAdapter<TeamRoster> {
	readonly format = 'teams-roster';
	readonly versionKey = 'v1';

	protected locate(root: URI): URI { return URI.joinPath(root, 'teams', 'config.json'); }

	protected recognizes(obj: Record<string, unknown>): boolean {
		return typeof obj['teamId'] === 'string' && Array.isArray(obj['members']);
	}

	protected derive(obj: Record<string, unknown>): TeamRoster {
		const members = (obj['members'] as unknown[]).filter(isObject).map(m => ({
			id: readString(m, 'id') ?? '',
			status: readString(m, 'status') ?? '',
		}));
		const mailboxRaw = Array.isArray(obj['mailbox']) ? obj['mailbox'] as unknown[] : [];
		const mailbox = mailboxRaw.filter(isObject).map(x => ({
			from: readString(x, 'from') ?? '',
			to: readString(x, 'to') ?? '',
			seq: readNumber(x, 'seq') ?? 0,
		}));
		return { teamId: readString(obj, 'teamId') ?? '', members, mailbox };
	}

	protected empty(): TeamRoster { return { teamId: '', members: [], mailbox: [] }; }
}

/**
 * The tasks adapter (behind the experimental teams probe): reads `<root>/tasks/tasks.json` and produces a
 * {@link TaskList} of file-locked tasks with their claims. Version-keyed + unknown-shape canary.
 */
export class TasksAdapter extends JsonDocAdapter<TaskList> {
	readonly format = 'tasks-list';
	readonly versionKey = 'v1';

	protected locate(root: URI): URI { return URI.joinPath(root, 'tasks', 'tasks.json'); }

	protected recognizes(obj: Record<string, unknown>): boolean {
		return Array.isArray(obj['tasks']);
	}

	protected derive(obj: Record<string, unknown>): TaskList {
		const tasks = (obj['tasks'] as unknown[]).filter(isObject).map(t => ({
			id: readString(t, 'id') ?? '',
			status: readString(t, 'status') ?? '',
			claimedBy: readString(t, 'claimedBy'),
			fileLocks: Array.isArray(t['fileLocks'])
				? (t['fileLocks'] as unknown[]).filter((s): s is string => typeof s === 'string')
				: [],
		}));
		return { tasks };
	}

	protected empty(): TaskList { return { tasks: [] }; }
}

/** The empty cost rollup, for a degraded (absent / unknown-shape) result. */
const EMPTY_COST: CostRecord = { totalInputTokens: 0, totalOutputTokens: 0, perModel: [] };

/**
 * Sum authoritative token counts per model from the transcript records. Token-first: this NEVER derives a
 * US-dollar figure - a list-price USD would be an estimate, so the cost read model carries tokens only.
 */
function computeCost(records: readonly ITranscriptRecord[]): CostRecord {
	const perModel = new Map<string, { input: number; output: number }>();
	let totalInput = 0;
	let totalOutput = 0;
	for (const r of records) {
		if (r.inputTokens === undefined && r.outputTokens === undefined) { continue; }
		const acc = perModel.get(r.model ?? '') ?? { input: 0, output: 0 };
		acc.input += r.inputTokens ?? 0;
		acc.output += r.outputTokens ?? 0;
		perModel.set(r.model ?? '', acc);
		totalInput += r.inputTokens ?? 0;
		totalOutput += r.outputTokens ?? 0;
	}
	return {
		totalInputTokens: totalInput,
		totalOutputTokens: totalOutput,
		perModel: [...perModel].map(([model, t]) => ({ model, inputTokens: t.input, outputTokens: t.output })),
	};
}

/**
 * The token-first cost adapter: computes a {@link CostRecord} from the SAME active transcript the
 * transcript adapter reads (cost IS token-first from the transcript), so it delegates to that adapter's
 * shared read step rather than re-walking the tree. A windowed tail or an unreadable record among recognized
 * ones is an honest `partial` (some token usage is out of view), never a false complete. Read-only.
 */
export class CostAdapter extends VersionKeyedAdapter {
	readonly format = 'cost-token-rollup';
	readonly versionKey = 'v1';

	constructor(private readonly transcript: TranscriptJsonlAdapter) { super(); }

	async read(root: URI, folder: URI): Promise<IReaderResult<CostRecord>> {
		const active = await this.transcript.readActive(root, folder);
		if (!active || !active.parsed.sawJson) {
			return this.result(EMPTY_COST, CoverageLabel.InScope, FreshnessLabel.Polled, CompletenessState.Absent);
		}
		if (!active.parsed.recognized) {
			return this.unknownShape(EMPTY_COST, CoverageLabel.InScope, FreshnessLabel.Polled);
		}
		// Cost is a SUM, so a gap understates it: a dropped torn record's tokens are simply missing from the total.
		// Labelling that `partial` is what stops a low number from being read as a confident one.
		const completeness = hasKnownGap(active.parsed, active.base)
			? CompletenessState.Partial
			: CompletenessState.Complete;
		return this.result(computeCost(active.parsed.records), coverageOf(active.parsed.records, folder), FreshnessLabel.Polled, completeness);
	}
}

/** The empty entity for any request kind (transcript / teams / tasks / cost), for a degraded result. */
function emptyEntityForKind(kind: ReaderEntityKind): Run | Session | Subagent | Transcript | TeamRoster | TaskList | CostRecord {
	switch (kind) {
		case 'team-roster': return { teamId: '', members: [], mailbox: [] };
		case 'task-list': return { tasks: [] };
		case 'cost-rollup': return EMPTY_COST;
		default: return emptyEntity(kind);
	}
}

/**
 * The reader seam over every local Claude format (transcript + teams / tasks / cost). Read-only
 * and index-only: it delegates to the per-format adapters for the active workspace folder / config root and is
 * NEVER the SDK `sessionStore`. The request carries the already-resolved config root (see `resolveConfigRoot`);
 * a `no-config` root degrades to an absent result. Teams / tasks are gated behind the experimental teams
 * probe: when it is off, a team-roster / task-list request degrades to an honest absent result rather than
 * half-lighting an unshipped surface.
 */
export class ClawdiusReaderSeamService implements IReaderSeam {
	private readonly transcript: TranscriptJsonlAdapter;
	private readonly teams: TeamsAdapter;
	private readonly tasks: TasksAdapter;
	private readonly cost: CostAdapter;

	/**
	 * @param teamsProbeEnabled the experimental teams gating probe: when false (the default), the experimental teams / tasks
	 * read model is not exposed and a team-roster / task-list request degrades to an honest absent result.
	 */
	constructor(
		private readonly teamsProbeEnabled: boolean = false,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		this.transcript = new TranscriptJsonlAdapter(fileService);
		this.teams = new TeamsAdapter(fileService);
		this.tasks = new TasksAdapter(fileService);
		this.cost = new CostAdapter(this.transcript);
	}

	async read<T>(request: IReaderRequest): Promise<IReaderResult<T>> {
		if (request.root.kind === 'no-config') {
			return this.degradedAbsent(request.kind, CoverageLabel.OutOfScope) as IReaderResult<T>;
		}
		const root = request.root.root;
		// Teams / tasks: global under the config root, gated behind the experimental teams probe.
		if (TEAMS_TASKS_KINDS.has(request.kind)) {
			if (!this.teamsProbeEnabled) {
				return this.degradedAbsent(request.kind, CoverageLabel.InScope) as IReaderResult<T>;
			}
			const res = request.kind === 'team-roster' ? await this.teams.read(root) : await this.tasks.read(root);
			return res as IReaderResult<T>;
		}
		// Transcript + cost: scoped to the active workspace folder.
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			return this.degradedAbsent(request.kind, CoverageLabel.InScope) as IReaderResult<T>;
		}
		if (request.kind === 'cost-rollup') {
			return await this.cost.read(root, folder) as IReaderResult<T>;
		}
		if (TRANSCRIPT_KINDS.has(request.kind)) {
			return await this.transcript.read(root, folder, request.kind) as IReaderResult<T>;
		}
		return this.degradedAbsent(request.kind, CoverageLabel.InScope) as IReaderResult<T>;
	}

	/**
	 * Enumerate every observable run across the resolved config root's `projects/` dir as a labeled list of
	 * {@link FleetRun} - the data foundation the fleet UI binds to. A `no-config` root degrades to an
	 * empty list (honest, never an error). `scope` is CARRIED, not enforced here: coverage is computed
	 * against the active workspace folders regardless, so a foreign run is surfaced with its label rather than
	 * filtered out. Read-only.
	 */
	async listRuns(root: ReaderConfigRoot, scope?: ReaderScope): Promise<readonly FleetRun[]> {
		if (root.kind === 'no-config') { return []; }
		return this.transcript.enumerateRuns(root.root, this.scopeFolders(scope));
	}

	/**
	 * Enumerate every ultracode workflow MISSION as a labeled list of {@link MissionRun} - the Missions view's
	 * primary read. Unlike {@link listRuns} this is NOT scoped to workspace folders: a mission is identified by its
	 * run artifacts under the owning session, and a run launched from another folder is still the user's own
	 * mission to see. A `no-config` root degrades to an empty list. Read-only.
	 */
	async listMissions(root: ReaderConfigRoot): Promise<readonly MissionRun[]> {
		if (root.kind === 'no-config') { return []; }
		return this.transcript.enumerateMissions(root.root);
	}

	/**
	 * Enumerate one mission's agents as a labeled list of {@link MissionAgent} - the per-mission drill-in, resolved
	 * lazily so the mission list never pays for it. A `no-config` root degrades to an empty list. Read-only.
	 */
	async listMissionAgents(root: ReaderConfigRoot, mission: MissionRun): Promise<readonly MissionAgent[]> {
		if (root.kind === 'no-config') { return []; }
		return this.transcript.enumerateMissionAgents(root.root, mission);
	}

	/**
	 * Enumerate a run's subagents as a labeled list of {@link FleetSubagent} - the per-run drill-in
	 * prerequisite. A `no-config` root degrades to an empty list. Read-only.
	 */
	async listSubagents(root: ReaderConfigRoot, run: FleetRun): Promise<readonly FleetSubagent[]> {
		if (root.kind === 'no-config') { return []; }
		return this.transcript.enumerateSubagents(root.root, run, this.scopeFolders());
	}

	/**
	 * Read a subagent's transcript as a labeled {@link FleetTranscriptSlice} - the per-subagent drill-in read the
	 * transcript editor binds to. Goes through the seam's own indexed file (the subagent's
	 * `transcriptRef`), so a consuming surface never reads the Claude config tree directly. Coverage is
	 * scored against the active workspace folders; the completeness label includes the out-of-band probe (a missing
	 * tool-result ref -> `partial`). Read-only.
	 */
	async readSubagentTranscript(subagent: FleetSubagent): Promise<FleetTranscriptSlice> {
		return this.transcript.readTranscriptSlice(subagent, this.scopeFolders());
	}

	/** The active workspace folders coverage is scored against. Consent-scope is CARRIED not enforced at the seam,
	 *  so `scope` does not narrow the folder set here - a foreign run stays present-with-label. */
	private scopeFolders(_scope?: ReaderScope): readonly URI[] {
		return this.workspaceService.getWorkspace().folders.map(f => f.uri);
	}

	/** An honest fully-labeled empty result for a root/probe/workspace that cannot be read (freshness=stale: no
	 *  poll was even attempted), stamped with the format that would have served the request. */
	private degradedAbsent(kind: ReaderEntityKind, coverage: CoverageLabel): IReaderResult<unknown> {
		return {
			entity: emptyEntityForKind(kind),
			coverage,
			freshness: FreshnessLabel.Stale,
			completeness: CompletenessState.Absent,
			adapterVersion: this.stampFor(kind),
		};
	}

	/** The adapter-version stamp of the format that serves `kind`, so even a degraded result carries a stamp. */
	private stampFor(kind: ReaderEntityKind): AdapterVersionStamp {
		switch (kind) {
			case 'team-roster': return { format: this.teams.format, versionKey: this.teams.versionKey };
			case 'task-list': return { format: this.tasks.format, versionKey: this.tasks.versionKey };
			case 'cost-rollup': return { format: this.cost.format, versionKey: this.cost.versionKey };
			default: return { format: this.transcript.format, versionKey: this.transcript.versionKey };
		}
	}
}
// CLAWDIUS-END
