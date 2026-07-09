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
	AdapterVersionStamp, CompletenessState, CoverageLabel, FreshnessLabel, IReaderRequest, IReaderResult,
	IReaderSeam, ReaderEntityKind, Run, Session, Subagent, Transcript, TranscriptIndexKey,
} from '../../common/claudeReaderSeam.js';
import { encodeProjectDir } from '../clawdiusConfigStore.js';

/** The transcript read-model entities this adapter can produce, by request kind. */
type ReaderTranscriptEntity = Run | Session | Subagent | Transcript;

/** Request kinds served by the transcript JSONL adapter (Slice 2). Teams / tasks / cost land in Slice 3. */
const TRANSCRIPT_KINDS: ReadonlySet<ReaderEntityKind> = new Set<ReaderEntityKind>([
	'runs', 'session', 'subagent', 'transcript-slice',
]);

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

/** Reduce a parsed JSON line to a recognized transcript record, or undefined when the shape is not recognized. */
function toRecord(parsed: unknown, byteOffset: number): ITranscriptRecord | undefined {
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return undefined; }
	const obj = parsed as Record<string, unknown>;
	const type = obj['type'];
	if (typeof type !== 'string' || !KNOWN_RECORD_TYPES.has(type)) { return undefined; }
	return {
		type,
		sessionId: readString(obj, 'sessionId'),
		uuid: readString(obj, 'uuid'),
		parentUuid: readString(obj, 'parentUuid'),
		isSidechain: obj['isSidechain'] === true,
		cwd: readString(obj, 'cwd'),
		oobRef: readString(obj, 'oobRef'),
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
		const projectsDir = URI.joinPath(root, 'projects', encodeProjectDir(folder));
		const active = await this.selectActiveFile(projectsDir);
		if (!active) {
			return this.result(emptyEntity(kind), CoverageLabel.InScope, FreshnessLabel.Polled, CompletenessState.Absent);
		}
		const { text, base } = await this.readTail(active);
		const parsed = parseTranscriptRecords(text, base);
		if (!parsed.sawJson) {
			// The file exists but has no content (a fresh / empty session): absent, not unknown-shape.
			return this.result(emptyEntity(kind), CoverageLabel.InScope, FreshnessLabel.Polled, CompletenessState.Absent);
		}
		if (!parsed.recognized) {
			// JSON was present but NO line matched a known shape: a wholesale schema shift - trip the canary.
			return this.unknownShape(emptyEntity(kind), CoverageLabel.InScope, FreshnessLabel.Polled);
		}
		const coverage = this.coverageOf(parsed.records, folder);
		// A read is a known GAP (partial), not complete, when EITHER an unreadable record shape was present
		// alongside recognized ones (additive drift - never silently dropped under a `complete` claim) OR the
		// tail window started mid-file (`base > 0`), so records older than the window are not in view. Otherwise
		// defer to the out-of-band check.
		const completeness = (parsed.sawForeign || base > 0)
			? CompletenessState.Partial
			: await this.completenessOf(parsed.records, active);
		return this.result(deriveEntity(kind, parsed.records, active.toString()), coverage, FreshnessLabel.Polled, completeness);
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

	/** in-scope unless the session declares a working dir outside `folder` (an other-workspace run is surfaced as
	 *  foreign, never silently dropped). */
	private coverageOf(records: readonly ITranscriptRecord[], folder: URI): CoverageLabel {
		const cwd = records.map(r => r.cwd).find(c => c !== undefined);
		if (cwd === undefined) { return CoverageLabel.InScope; }
		return normalizePath(cwd) === normalizePath(folder.fsPath) ? CoverageLabel.InScope : CoverageLabel.Foreign;
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
 * The reader seam over the transcript JSONL format (Slice 2). Read-only and index-only: it delegates to the
 * transcript adapter for the active workspace folder and is NEVER the SDK `sessionStore`. The request carries
 * the already-resolved config root (see `resolveConfigRoot`); a `no-config` root degrades to an absent result.
 */
export class ClawdiusReaderSeamService implements IReaderSeam {
	private readonly transcript: TranscriptJsonlAdapter;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		this.transcript = new TranscriptJsonlAdapter(fileService);
	}

	async read<T>(request: IReaderRequest): Promise<IReaderResult<T>> {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (request.root.kind === 'no-config' || !folder || !TRANSCRIPT_KINDS.has(request.kind)) {
			// No resolvable root, no workspace, or a format this slice does not serve yet: an honest empty result.
			const absent: IReaderResult<ReaderTranscriptEntity> = {
				entity: emptyEntity(request.kind),
				coverage: request.root.kind === 'no-config' ? CoverageLabel.OutOfScope : CoverageLabel.InScope,
				freshness: FreshnessLabel.Stale,
				completeness: CompletenessState.Absent,
				adapterVersion: { format: this.transcript.format, versionKey: this.transcript.versionKey },
			};
			return absent as IReaderResult<T>;
		}
		return await this.transcript.read(request.root.root, folder, request.kind) as IReaderResult<T>;
	}
}
// CLAWDIUS-END
