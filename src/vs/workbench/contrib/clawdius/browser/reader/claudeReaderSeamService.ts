/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Reader-seam transcript adapter + version-keyed shell
// The Slice-2 read implementation behind the pure `common/claudeReaderSeam.ts` interface: a version-keyed
// adapter shell (a per-format version key + an unknown-shape canary that degrades a schema shift to a labeled
// result instead of throwing) and the transcript JSONL adapter. The adapter builds the
// `projects/<encodeProjectDir>/*.jsonl` path off the RESOLVED config root (never a hardcoded `~/.claude`),
// REUSES the config store's navigation primitives (`encodeProjectDir` + `*.jsonl` mtime-latest selection), and
// ADDS a byte-offset tail read via `IFileService.readFileStream` (`position`/`length`) so a large append-only
// transcript never loads whole, byte accounting stays exact across a UTF-8 window boundary, and a half-written
// trailing line is never emitted as a complete record. Reads are target-aware (`IFileService` over URIs that keep the active
// window's scheme + authority), read-only, and never register as the SDK `sessionStore`.

import { streamToBuffer, VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	AdapterVersionStamp, CompletenessState, CostRecord, CoverageLabel, FreshnessLabel, IReaderRequest,
	IReaderResult, IReaderSeam, ReaderConfigRoot, ReaderEntityKind, ReaderScope, Run, Session, Subagent, TaskList,
	TeamRoster, Transcript, TranscriptIndexKey,
} from '../../common/claudeReaderSeam.js';
import { FleetRun, FleetSubagent } from '../../common/claudeFleetModel.js';
import { encodeProjectDir } from '../clawdiusConfigStore.js';

/** The transcript read-model entities this adapter can produce, by request kind. */
type ReaderTranscriptEntity = Run | Session | Subagent | Transcript;

/** Request kinds served by the transcript JSONL adapter (Slice 2). Cost (Slice 3) is derived from the same
 *  transcript records but routed separately; teams / tasks are their own adapters gated behind TEAMS-14. */
const TRANSCRIPT_KINDS: ReadonlySet<ReaderEntityKind> = new Set<ReaderEntityKind>([
	'runs', 'session', 'subagent', 'transcript-slice',
]);

/** Request kinds served by the teams / tasks adapters (Slice 3), gated behind the TEAMS-14 experimental probe. */
const TEAMS_TASKS_KINDS: ReadonlySet<ReaderEntityKind> = new Set<ReaderEntityKind>(['team-roster', 'task-list']);

/** The known transcript record types (Claude CLI transcript JSONL). A line the adapter RECOGNIZES is a JSON
 *  object whose `type` is one of these; anything else is a foreign shape that trips the unknown-shape canary. */
const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'summary']);

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
interface IParsedTranscript {
	readonly records: readonly ITranscriptRecord[];
	/** At least one complete JSON object line was parsed. */
	readonly sawJson: boolean;
	/** At least one parsed line matched a recognized transcript shape. */
	readonly recognized: boolean;
	/** At least one complete JSON object line did NOT match a recognized shape (a schema drift / unreadable
	 *  record). Distinct from an extra FIELD on a recognized record, which parses forward-compatibly. */
	readonly sawForeign: boolean;
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
				// A non-JSON or half-written line: skip it so a truncated record is never surfaced as complete.
			}
		}
		offset += byteLength(rawLine) + 1; // + the '\n' (always one byte) that split() removed
	}
	return { records, sawJson, recognized, sawForeign };
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
 *  with its label, never dropped - SC-002), in-scope when the run declares no cwd (scope cannot be narrowed, so
 *  the conservative choice is not to hide it). With no active folders a run that declares a cwd is foreign. */
function coverageForEnum(records: readonly ITranscriptRecord[], folders: readonly URI[]): CoverageLabel {
	const cwd = records.map(r => r.cwd).find(c => c !== undefined);
	if (cwd === undefined) { return CoverageLabel.InScope; }
	const c = normalizePath(cwd);
	return folders.some(f => normalizePath(f.fsPath) === c) ? CoverageLabel.InScope : CoverageLabel.Foreign;
}

/** The honesty ladder for an enumerated session file, mirroring the transcript adapter's read: an empty file is
 *  `absent`; JSON present but no recognized line is `unknown-shape` (the canary); a recognized read with an
 *  unreadable record alongside OR a windowed tail (`base > 0`) is a known gap (`partial`); else `complete`. The
 *  out-of-band completeness probe is a per-transcript drill-in concern, not run over every enumerated file. */
function enumCompleteness(parsed: IParsedTranscript, base: number): CompletenessState {
	if (!parsed.sawJson) { return CompletenessState.Absent; }
	if (!parsed.recognized) { return CompletenessState.UnknownShape; }
	return (parsed.sawForeign || base > 0) ? CompletenessState.Partial : CompletenessState.Complete;
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
		// A read is a known GAP (partial), not complete, when EITHER an unreadable record shape was present
		// alongside recognized ones (additive drift - never silently dropped under a `complete` claim) OR the
		// tail window started mid-file (`base > 0`), so records older than the window are not in view. Otherwise
		// defer to the out-of-band check.
		const completeness = (parsed.sawForeign || base > 0)
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
	 * (Slice 1) - the new cross-project walk the fleet lists (the shipped {@link read} returns ONE entity for a
	 * single folder's active file). Each session file becomes one run, carrying coverage (against `folders`) /
	 * freshness=polled / completeness + the adapter-version stamp; a foreign or unknown-shape run is present WITH
	 * its label, never omitted (SC-001/SC-002). `ownership` is always `foreign` here (the never-falsely-owned
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
	 * Enumerate a run's subagents as a LABELED LIST of {@link FleetSubagent} (Slice 1). A subagent is a sidechain
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
 * The teams roster adapter (Slice 3, behind the TEAMS-14 probe): reads `<root>/teams/config.json` and produces
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
 * The tasks adapter (Slice 3, behind the TEAMS-14 probe): reads `<root>/tasks/tasks.json` and produces a
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
 * US-dollar figure - a list-price USD would be an estimate, so the cost read model carries tokens only (FR-011).
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
 * The token-first cost adapter (Slice 3): computes a {@link CostRecord} from the SAME active transcript the
 * transcript adapter reads (cost IS token-first from the transcript, FR-011), so it delegates to that adapter's
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
		const completeness = (active.parsed.sawForeign || active.base > 0)
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
 * The reader seam over every local Claude format (Slice 2 transcript + Slice 3 teams / tasks / cost). Read-only
 * and index-only: it delegates to the per-format adapters for the active workspace folder / config root and is
 * NEVER the SDK `sessionStore`. The request carries the already-resolved config root (see `resolveConfigRoot`);
 * a `no-config` root degrades to an absent result. Teams / tasks are gated behind the TEAMS-14 experimental
 * probe: when it is off, a team-roster / task-list request degrades to an honest absent result rather than
 * half-lighting an unshipped surface.
 */
export class ClawdiusReaderSeamService implements IReaderSeam {
	private readonly transcript: TranscriptJsonlAdapter;
	private readonly teams: TeamsAdapter;
	private readonly tasks: TasksAdapter;
	private readonly cost: CostAdapter;

	/**
	 * @param teamsProbeEnabled the TEAMS-14 gating probe: when false (the default), the experimental teams / tasks
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
		// Teams / tasks: global under the config root, gated behind the TEAMS-14 experimental probe.
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
	 * {@link FleetRun} (Slice 1) - the data foundation the fleet UI binds to. A `no-config` root degrades to an
	 * empty list (honest, never an error). `scope` is CARRIED, not enforced here (FR-013): coverage is computed
	 * against the active workspace folders regardless, so a foreign run is surfaced with its label rather than
	 * filtered out. Read-only.
	 */
	async listRuns(root: ReaderConfigRoot, scope?: ReaderScope): Promise<readonly FleetRun[]> {
		if (root.kind === 'no-config') { return []; }
		return this.transcript.enumerateRuns(root.root, this.scopeFolders(scope));
	}

	/**
	 * Enumerate a run's subagents as a labeled list of {@link FleetSubagent} (Slice 1) - the per-run drill-in
	 * prerequisite. A `no-config` root degrades to an empty list. Read-only.
	 */
	async listSubagents(root: ReaderConfigRoot, run: FleetRun): Promise<readonly FleetSubagent[]> {
		if (root.kind === 'no-config') { return []; }
		return this.transcript.enumerateSubagents(root.root, run, this.scopeFolders());
	}

	/** The active workspace folders coverage is scored against. Consent-scope is CARRIED not enforced at the seam
	 *  (FR-013), so `scope` does not narrow the folder set here - a foreign run stays present-with-label. */
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
