/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Config store
// Reads the user's Claude Code configuration from local files only and produces a typed snapshot across the
// Global (~/.claude) and Project (<workspaceFolder>/.claude) scopes. No network access. Registered as the
// container-wide `IClawdiusConfigService` singleton: one scan + watcher set feeds all eight section views.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { MarshalledId } from '../../../../base/common/marshallingIds.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { dirname, extUriIgnorePathCase } from '../../../../base/common/resources.js';
import { parse as parseJsonc } from '../../../../base/common/jsonc.js';
import { match as globMatch, splitGlobAware } from '../../../../base/common/glob.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { FileChangesEvent, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import {
	ConfigBacking, ConfigScope, ConfigSection, CONFIG_SECTIONS, ContextInclusion, IClawdiusConfigService,
	IClawdiusConfigSnapshot, IConfigBudgetImport, IConfigBudgetMeta, IConfigItem, IConfigScopeGroup, IConfigSectionGroup,
	IConfirmedLoad, IMeasuredPrefix, PLUGIN_REGISTRY_FILES,
} from '../common/clawdiusConfig.js';
import { containingFolderOf, estimateTokens, normalizeConfirmedPath } from '../common/clawdiusContextBudget.js';
import { REMOTE_SETTINGS_JSON } from '../common/clawdiusTierPaths.js';

interface IScopeRoots {
	readonly scope: ConfigScope;
	/** Stable unique identity for this scope ('global' or the workspace folder URI). */
	readonly key: string;
	/** The `.claude` directory. */
	readonly claudeDir: URI;
	/** The base directory (home for global, the workspace folder for project) - where the root CLAUDE.md lives. */
	readonly baseDir: URI;
	readonly folderName?: string;
}

/** One installed plugin's bundled contents, scanned from its install directory. A plugin ships skills / agents /
 *  commands / hooks in its own convention dirs (`skills/`, `agents/`, `commands/`, `hooks/hooks.json`). Its skills
 *  fold into the Global Skills section (so the Skills tab lists them with plugin provenance); the full set hangs off
 *  the plugin's row as children (the Plugins tab's contents view). */
interface IPluginContentScan {
	/** The plugin id (`plugin-name@marketplace`) - matches an installed_plugins.json / enabledPlugins key. */
	readonly id: string;
	/** The plugin name (the id up to `@`) - shown as the source on each bundled skill row. */
	readonly pluginName: string;
	readonly skills: IConfigItem[];
	readonly agents: IConfigItem[];
	readonly commands: IConfigItem[];
	readonly hooks: IConfigItem[];
}

/** The install directory of an installed plugin, from its first install record's `installPath` (an absolute fs
 *  path the CLI wrote, e.g. `<home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>`). undefined when the
 *  record shape is unexpected. Exported for direct testing. */
export function firstInstallPath(recs: unknown): string | undefined {
	if (Array.isArray(recs) && recs.length > 0 && recs[0] && typeof recs[0] === 'object') {
		const p = (recs[0] as Record<string, unknown>)['installPath'];
		if (typeof p === 'string' && p.length > 0) { return p; }
	}
	return undefined;
}

/** Extract a flat key/value map from a leading `--- ... ---` YAML frontmatter block (defensive, no deps). */
function frontMatter(content: string): { readonly fields: Record<string, string>; readonly bodyLine: number } {
	const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content);
	if (!m) { return { fields: {}, bodyLine: 1 }; }
	const fields: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line.trim());
		if (kv) { fields[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim(); }
	}
	const bodyLine = m[0].split(/\r?\n/).length;
	return { fields, bodyLine };
}

/** Parse an inline frontmatter `paths` value into a list of glob patterns: a scalar (`*.ts`), an inline array
 *  (`["*.ts","*.tsx"]`), or a comma list (`*.ts, *.tsx`). Uses splitGlobAware so a `,` inside a `{...}` brace
 *  group (e.g. `*.{ts,tsx}`) is NOT split. */
function parseGlobList(raw: string | undefined): string[] | undefined {
	let s = (raw ?? '').trim();
	if (!s) { return undefined; }
	if (s.startsWith('[') && s.endsWith(']')) { s = s.slice(1, -1); }
	const parts = splitGlobAware(s, ',').map(p => p.trim().replace(/^["']|["']$/g, '').trim().replace(/\\/g, '/')).filter(Boolean);
	return parts.length ? parts : undefined;
}

/** Extract a rule's `paths` patterns from its frontmatter block - Claude Code's path-scoping key (NOT Cursor's
 *  `globs:`/`alwaysApply:`). Accepts an inline scalar/array/comma-list on the `paths:` line OR a shallow YAML
 *  block list. Returns undefined when there is no `paths:` key, or when it is just `**` - both mean the rule is
 *  unconditional / always-on. A trailing `/**` is stripped (matching the engine). Exported for unit tests. */
export function extractPaths(content: string): string[] | undefined {
	const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content);
	if (!m) { return undefined; }
	const lines = m[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = /^paths[ \t]*:[ \t]*(.*)$/i.exec(lines[i]);
		if (!kv) { continue; }
		let patterns: string[] | undefined;
		if (kv[1].trim()) {
			patterns = parseGlobList(kv[1]);
		} else {
			const items: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				const li = /^[ \t]+-[ \t]*(.+?)[ \t]*$/.exec(lines[j]);
				if (!li) { break; }
				items.push(li[1].replace(/^["']|["']$/g, '').trim().replace(/\\/g, '/'));
			}
			patterns = items.length ? items : undefined;
		}
		// Keep patterns as authored (the resolver's matcher handles `src/**` directory forms directly); only a
		// bare `**` (or empty) means the rule is unconditional / always-on.
		const cleaned = patterns?.map(p => p.trim()).filter(p => p.length > 0);
		if (!cleaned || cleaned.length === 0 || cleaned.every(p => p === '**')) { return undefined; }
		return cleaned;
	}
	return undefined;
}

/** Context-budget metadata for a memory/rule file (own-file token estimate + rule path-scoping; the caller adds
 *  `@`-imports). Content is already read by the caller, so this is free. CLAUDE.md / CLAUDE.local.md are always-on
 *  memory; a rule is path-scoped (conditional) when it declares a real `paths:` frontmatter, else always-on (the
 *  Claude Code default - rules WITHOUT `paths` load every session alongside CLAUDE.md). */
function memoryBudget(isRule: boolean, content: string): IConfigBudgetMeta {
	const chars = content.length;
	const approxTokens = estimateTokens(content);
	if (!isRule) {
		return { kind: 'memory', approxTokens, chars, inclusion: ContextInclusion.Always };
	}
	const paths = extractPaths(content);
	return paths
		? { kind: 'rule', approxTokens, chars, inclusion: ContextInclusion.Glob, paths }
		: { kind: 'rule', approxTokens, chars, inclusion: ContextInclusion.Always };
}

/** Blank out fenced code blocks + inline code spans so `@`-imports inside them are NOT parsed (Claude Code skips
 *  code spans and fenced blocks). Line-based so it handles >=3 backtick OR tilde fences (closing fence same char,
 *  >= length) and single- or multi-backtick inline spans, and an unterminated fence swallows to end-of-file. */
function stripCode(content: string): string {
	const out: string[] = [];
	let fence: string | undefined;
	for (const line of content.split(/\r?\n/)) {
		const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence !== undefined) {
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length) { fence = undefined; }
			out.push('');
			continue;
		}
		if (m) { fence = m[1]; out.push(''); continue; }
		out.push(line.replace(/(`+)[^`]*?\1/g, ''));
	}
	return out.join('\n');
}

/** Parse `@`-import target strings from a memory file body. Mirrors the engine: the target follows
 *  start-of-line / whitespace; `./`, `../`, `~/`, absolute `/`, or a bare `[A-Za-z0-9._-]` name; escaped spaces
 *  (`\ `) are allowed; a trailing `#anchor` is stripped; code spans / fences are skipped. Exported for tests. */
export function parseImportTargets(content: string): string[] {
	const out: string[] = [];
	const body = stripCode(content);
	const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		let p = m[1];
		const hash = p.indexOf('#');
		if (hash !== -1) { p = p.slice(0, hash); }
		p = p.replace(/\\ /g, ' ').trim();
		if (!p) { continue; }
		if (p.startsWith('./') || p.startsWith('../') || p.startsWith('~/') || (p.startsWith('/') && p !== '/') || /^[A-Za-z0-9._-]/.test(p)) {
			out.push(p);
		}
	}
	return out;
}

/** Resolve an `@`-import target to a URI: `~/` from home, absolute from the filesystem, otherwise relative to
 *  the importing file's directory. */
function resolveImportUri(target: string, importerDir: URI, home: URI): URI | undefined {
	try {
		if (target.startsWith('~/')) { return URI.joinPath(home, target.slice(2)); }
		// Absolute (POSIX `/abs` or Windows `C:\abs` / `C:/abs`): resolve on the IMPORTER's own provider, so an
		// absolute import in a remote workspace stays remote rather than becoming a local file: URI.
		if ((target.startsWith('/') && target !== '/') || /^[A-Za-z]:[\\/]/.test(target)) {
			return importerDir.with({ path: URI.file(target).path });
		}
		return URI.joinPath(importerDir, target);
	} catch {
		return undefined;
	}
}

/** Claude Code's per-project key for ~/.claude/projects/<enc>: EVERY non-alphanumeric in the absolute path is
 *  replaced with '-' (verified against real dirs, e.g. C:\Users\x\.ai -> C--Users-x--ai - the dot also flips).
 *  Replacing only separators silently mismatched any path containing a '.', dropping MEMORY.md auto-memory and
 *  the measured-prefix overlay for dotted project paths. Exported for direct testing. */
export function encodeProjectDir(folder: URI): string {
	return folder.fsPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Drop the partial leading line from a byte-range tail read (up to and including the first '\n'), so per-line
 *  JSON.parse never sees a truncated first record. A window with no newline (one over-long record) is kept whole. */
export function dropPartialFirstLine(text: string): string {
	const nl = text.indexOf('\n');
	return nl >= 0 ? text.slice(nl + 1) : text;
}

/** The directories strictly between `folder` (exclusive - its root CLAUDE.md is in the static scan) and the
 *  active file's own directory (inclusive), outer-first. Returns [] when the file sits directly in the folder.
 *  Bounded (64) and terminates at the filesystem root. Pure: depends only on dirname + path identity. */
export function nestedDirChain(activeFile: URI, folder: URI): URI[] {
	const chain: URI[] = [];
	let dir = dirname(activeFile);
	for (let guard = 0; guard < 64 && extUriIgnorePathCase.isEqualOrParent(dir, folder) && !extUriIgnorePathCase.isEqual(dir, folder); guard++) {
		chain.push(dir);
		const up = dirname(dir);
		if (extUriIgnorePathCase.isEqual(up, dir)) { break; } // filesystem root reached
		dir = up;
	}
	return chain.reverse();
}

/** Parse the InstructionsLoaded JSONL tail into (normalized file path) -> most-recent record, keeping only
 *  records whose session `cwd` is inside one of `scopes` (already-normalized workspace folder paths; empty =
 *  no scoping). Tail order => the LAST record for a path wins. Pure; the store supplies the text + scopes. */
export function parseConfirmedLoads(text: string, scopes: readonly string[]): Map<string, IConfirmedLoad> {
	const out = new Map<string, IConfirmedLoad>();
	const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
	const inScope = (cwd: unknown): boolean => {
		if (scopes.length === 0) { return true; }
		if (typeof cwd !== 'string') { return false; }
		const c = normalizeConfirmedPath(cwd);
		return scopes.some(s => c === s || c.startsWith(s + '/'));
	};
	for (const line of text.split(/\r?\n/).slice(-1000)) {
		const t = line.trim();
		if (!t || t[0] !== '{') { continue; }
		try {
			const obj = JSON.parse(t);
			if (typeof obj?.file_path === 'string' && inScope(obj?.cwd)) {
				out.set(normalizeConfirmedPath(obj.file_path), {
					loadReason: str(obj?.load_reason), memoryType: str(obj?.memory_type), parentFilePath: str(obj?.parent_file_path),
				});
			}
		} catch { /* skip a non-JSON line */ }
	}
	return out;
}

/** Claude Code loads only the first ~200 lines / 25KB of MEMORY.md, so estimate from that slice. */
function capAutoMemory(content: string): string {
	return content.split(/\r?\n/).slice(0, 200).join('\n').slice(0, 25 * 1024);
}

/**
 * Does the `claudeMdExcludes` setting suppress this CLAUDE.md file? Each pattern is an absolute path (exact
 * match) or a glob applied to the absolute path - both forms verified live against claude.exe. Comparison is
 * case-insensitive on Windows. Excludes apply to CLAUDE.md-family memory files, not the org-managed policy file.
 */
export function isClaudeMdExcluded(fsPath: string, patterns: readonly string[], caseInsensitive: boolean = isWindows): boolean {
	if (patterns.length === 0) { return false; }
	const norm = (s: string): string => { const f = s.replace(/\\/g, '/'); return caseInsensitive ? f.toLowerCase() : f; };
	const path = norm(fsPath);
	for (const raw of patterns) {
		const pat = norm(raw);
		if (/[*?[\]{}]/.test(pat)) {
			if (globMatch(pat, path)) { return true; }
		} else if (pat === path) {
			return true;
		}
	}
	return false;
}

/** Scan a session transcript (JSONL) from the end for the last assistant turn with usage, returning its full
 *  cached prefix (cache_read + cache_creation input tokens) - the MEASURED always-on size for that session.
 *  Exported for unit tests. */
export function parseMeasuredPrefix(text: string): IMeasuredPrefix | undefined {
	const lines = text.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line || line[0] !== '{') { continue; }
		try {
			const obj = JSON.parse(line);
			const usage = obj?.message?.usage;
			if (obj?.type === 'assistant' && usage && typeof usage === 'object') {
				const cached = (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0)
					+ (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0);
				const tokens = cached > 0 ? cached : (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0);
				if (tokens > 0) { return { tokens, atIso: typeof obj.timestamp === 'string' ? obj.timestamp : undefined }; }
			}
		} catch { /* skip a non-JSON line */ }
	}
	return undefined;
}

/**
 * A CONTENT signature for a config snapshot - what makes {@link ClawdiusConfigStore.onDidChange} edge-triggered.
 *
 * `JSON.stringify` on its own is not usable here, and the reason is not obvious. `URI.toJSON()` emits its memoized
 * `external` (filled in by `toString()`) and `fsPath` (filled in by `.fsPath`) fields only once something has
 * actually asked for them, so two byte-identical scans serialize DIFFERENTLY depending on which URIs some consumer
 * happened to touch in between - and that is a moving target this store does not control. The replacer collapses
 * every marshalled URI back to its canonical string, which is the only thing about a URI this comparison cares
 * about, so the signature depends on the configuration and nothing else.
 *
 * Comparing content is sound because `IConfigItem` carries no mtime, ctime or size - every field on it is derived
 * from the file's own content (its frontmatter, its measured budget) - so a real edit always moves the signature
 * while a touch-only event never does.
 *
 * What it deliberately does NOT cover is the reason {@link ClawdiusConfigStore.recordSourceBody} exists: the
 * snapshot SUMMARISES several JSON files rather than carrying them, and never opens others at all, so a change
 * confined to a summarised-away key - or to a settings source no section scans - is invisible here and needs its own
 * contribution to the fired signature.
 */
function snapshotSignature(snapshot: IClawdiusConfigSnapshot): string {
	// `unknown` is unavoidable in a JSON replacer: it visits every value in an arbitrarily-nested structure, and
	// the narrowing below is exactly what recovers the type.
	return JSON.stringify(snapshot, (_key: string, value: unknown): unknown => {
		if (typeof value === 'object' && value !== null && (value as { readonly $mid?: MarshalledId }).$mid === MarshalledId.Uri) {
			return URI.revive(value as UriComponents).toString();
		}
		return value;
	});
}

/**
 * Whether `resource` is Claude Code TRANSCRIPT state under `projectsRoot` (`<claudeDir>/projects`) - runtime data
 * this store never opens, written continuously while an agent session runs.
 *
 * The one exception, and it is a real one both sweeps of this bug initially missed: `scanMemories` reads the
 * per-project auto memory at `projects/<enc>/memory/MEMORY.md`, so anything inside a `<enc>/memory/` folder is
 * config, not transcript. The check is on the folder rather than the exact filename deliberately - over-matching
 * costs one redundant scan, under-matching would silently stop refreshing a file the inspector shows.
 */
function isTranscriptPath(resource: URI, projectsRoot: URI): boolean {
	if (!extUriIgnorePathCase.isEqualOrParent(resource, projectsRoot)) { return false; }
	const rest = resource.path.slice(projectsRoot.path.length).split('/').filter(segment => segment.length > 0);
	return !(rest.length >= 2 && rest[1].toLowerCase() === 'memory');
}

/** Markdown ATX headings (`#`..`######`) with 1-based line numbers. */
function headings(content: string): { readonly text: string; readonly line: number }[] {
	const out: { text: string; line: number }[] = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
		if (m) { out.push({ text: `${' '.repeat((m[1].length - 1) * 2)}${m[2]}`, line: i + 1 }); }
	}
	return out;
}

export class ClawdiusConfigStore extends Disposable implements IClawdiusConfigService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _snapshot: IClawdiusConfigSnapshot = { scopes: [] };
	get snapshot(): IClawdiusConfigSnapshot { return this._snapshot; }

	private _hasResolved = false;
	get hasResolved(): boolean { return this._hasResolved; }

	/**
	 * {@link snapshotSignature} of {@link _snapshot} as of the last fire - what makes `onDidChange` EDGE-triggered.
	 * A rescan that produces an identical snapshot describes a configuration that did not change, and firing on it
	 * made every consumer tear down and rebuild for nothing: the Control Center clears its caches and rebuilds its
	 * whole tab on this event, which under the transcript-driven refresh storm meant a full rebuild about once a
	 * second.
	 *
	 * The snapshot ALONE is not a sufficient signature, and assuming it was is what an audit of the first cut of
	 * this caught. Several consumers hang cache invalidation off this event for data the snapshot only summarises:
	 * the Control Center's Effective tab re-resolves the WHOLE settings chain (every key, including `model`, `env`,
	 * `statusLine`, which no section scans), and its MCP rows re-read each server's `command`/`args`/`env` (the Mcp
	 * section models a server by NAME alone). Those caches are dropped only here, with no other invalidation path
	 * short of a manual Refresh button - so a snapshot-only edge trigger left the tab whose whole purpose is "the
	 * resolved value of every setting" showing the pre-edit value for the rest of the session. The signature is
	 * therefore the snapshot PLUS {@link sourceBodySignature}, which carries those summarised-away bodies and the
	 * sources no section reads at all ({@link recordServerManagedBody}).
	 */
	private _signature = '';

	/** Raw bodies of the JSON settings sources the snapshot SUMMARISES rather than carries, or does not read at all,
	 *  keyed by URI string and gathered during the scan that read them (see {@link recordSourceBody}). Cleared at the
	 *  start of every scan, and folded into {@link _signature} so an edit no section models still fires `onDidChange`.
	 *  Raw text, not a hash: these are settings files of a few KB, so an exact comparison needs no collision argument. */
	private readonly _sourceBodies = new Map<string, string>();

	/** The root set {@link updateWatchers} last built its watch requests for, as a stable key, or undefined before
	 *  the first build. The watch set is a pure function of the roots, so rebuilding it for an unchanged root set
	 *  is pure churn - and it was running on EVERY scan, tearing down and re-adding ~15 watch requests per refresh
	 *  and forcing the file watcher to re-plan a large recursive subtree each time. */
	private _watchedRootsKey: string | undefined;

	/** Per-refresh memo of readText() so a file imported by several memories (or both auto-scanned and imported)
	 *  is read once. Cleared at the start of every scan. */
	private readonly _readCache = new Map<string, Promise<string | undefined>>();

	/** `claudeMdExcludes` patterns gathered from settings.json at the start of each refresh; a CLAUDE.md file
	 *  matching one is suppressed (Claude Code won't load it) so the inspector doesn't show it as loaded. */
	private _claudeMdExcludes: string[] = [];

	/** Installed plugins' bundled contents, scanned once per refresh (installed plugins are global). Consumed by
	 *  the Global Skills scan (plugin skills fold in with provenance) and the Plugins scan (attached as children). */
	private _pluginContents: IPluginContentScan[] = [];

	/** The nested (subtree) CLAUDE.md files {@link nestedMemoriesFor} last probed, as URI strings - the ones a
	 *  context-budget surface is showing right now. See {@link recordNestedMemoryBodies} for why the store tracks
	 *  them at all, and why keeping only the most recent call's chain is the right bound. */
	private _nestedProbed: readonly string[] = [];

	private readonly _watchers = this._register(new DisposableStore());
	/** Coalescing timer for the two events that mean "the files this store scans, or the roots they live under,
	 *  moved on disk": the file watcher installed by {@link updateWatchers}, and a workspace-folder change (which
	 *  moves the scan roots themselves). Both drive {@link refreshFromWatcher} and never the public
	 *  {@link refresh}, which is what stops a change that lands mid-scan from being dropped. */
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => void this.refreshFromWatcher(), 250));
	/** Coalesces concurrent refreshes: all eight section views call refresh() on first render. */
	private _refreshInFlight: Promise<void> | undefined;
	/** Set when a request that needs a scan STARTING AFTER IT arrives mid-scan - a caller's `force`, or the watcher
	 *  via {@link refreshFromWatcher} - so the loop runs one more scan. A boolean rather than a counter on purpose:
	 *  N such requests during one scan collapse into ONE rerun, because they would all read the same tree. */
	private _rerunRequested = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this._refreshScheduler.schedule()));
	}

	private async scopeRoots(): Promise<IScopeRoots[]> {
		const home = await this.pathService.userHome();
		// Managed/enterprise policy memory: a system path, highest precedence, scanned for memories only.
		const managedDir = isWindows ? URI.file('C:\\Program Files\\ClaudeCode')
			: isMacintosh ? URI.file('/Library/Application Support/ClaudeCode')
				: URI.file('/etc/claude-code');
		const roots: IScopeRoots[] = [
			{ scope: ConfigScope.Managed, key: 'managed', claudeDir: URI.joinPath(managedDir, '.claude'), baseDir: managedDir },
			{ scope: ConfigScope.Global, key: 'global', claudeDir: URI.joinPath(home, '.claude'), baseDir: home },
		];
		for (const folder of this.workspaceService.getWorkspace().folders) {
			roots.push({ scope: ConfigScope.Project, key: folder.uri.toString(), claudeDir: URI.joinPath(folder.uri, '.claude'), baseDir: folder.uri, folderName: folder.name });
		}
		return roots;
	}

	/**
	 * Re-scan both scopes. Concurrent calls coalesce onto one in-flight scan. Pass `force` after a write
	 * (create / delete) you need reflected: if a scan is already running it may have begun BEFORE the write, so
	 * `force` guarantees one more scan that starts after this call resolves.
	 *
	 * The default is passive, and that is what a CONSUMER wants: this is also the "give me the configuration" call
	 * every one of the eight section views issues on first render, and queuing a rerun for each of those would buy
	 * seven redundant whole startup scans of data nobody changed. A consumer knows only that it wants data, so any
	 * scan's result will do. The WATCHER knows strictly more than that - see {@link refreshFromWatcher}, which is
	 * why it does not come through here with `force` left off.
	 */
	refresh(force = false): Promise<void> {
		if (force) { this._rerunRequested = true; }
		if (!this._refreshInFlight) {
			this._refreshInFlight = this._refreshLoop().finally(() => { this._refreshInFlight = undefined; });
		}
		return this._refreshInFlight;
	}

	/**
	 * The watcher's entry point: a file this store scans changed on disk, so ALWAYS queue a rerun rather than
	 * coalescing onto whatever scan is running.
	 *
	 * The difference from a passive {@link refresh} is the whole reason this exists. A running scan may have ALREADY
	 * READ the file that just changed, and joining it then drops the change outright: the snapshot keeps the pre-edit
	 * content, the signature does not move, the edge-triggered `onDidChange` never fires, and every consumer serves
	 * stale config until some unrelated config event happens to start another scan. Queuing the rerun holds the same
	 * pair of invariants `ClaudeWorkflowObservationService.requestRefresh` states for the transcript corpus - at most
	 * one pass running with at most one queued behind it, and a change landing mid-pass never lost.
	 */
	private refreshFromWatcher(): Promise<void> {
		return this.refresh(true);
	}

	private async _refreshLoop(): Promise<void> {
		do {
			this._rerunRequested = false;
			await this._doRefresh();
		} while (this._rerunRequested);
	}

	private async _doRefresh(): Promise<void> {
		// Assigned only by a scan that ran to completion, which is what makes the error path below honest: a scan
		// that threw part-way has a HALF-filled `_sourceBodies` and an untouched `_snapshot`, so any signature built
		// from it would describe nothing real. Leaving it undefined leaves `_signature` alone instead.
		let signature: string | undefined;
		try {
			this._readCache.clear();
			this._sourceBodies.clear();
			const roots = await this.scopeRoots();
			// The four pre-scan passes run TOGETHER, for the same reason `enumerateWorkflows` batches its per-manifest
			// work: awaited one after another they put up to ~70 sequential file round-trips in front of every scan
			// (the nested chain alone is capped at 64), and in a remote (SSH / WSL) window the round-trip IS the cost.
			// They are safe to overlap - each reads a disjoint set of files, none reads what another writes, and all
			// four only add to `_sourceBodies`, which is keyed by URI and sorted by `sourceBodySignature`, so the order
			// they complete in cannot change the signature. They all have to finish BEFORE `scanScope` runs, because
			// the scan reads `_claudeMdExcludes` and the signature is built from the recorded bodies.
			const [claudeMdExcludes] = await Promise.all([
				this.gatherClaudeMdExcludes(roots),
				this.recordServerManagedBody(roots),
				this.recordPluginRegistryBodies(roots),
				this.recordNestedMemoryBodies(),
			]);
			this._claudeMdExcludes = claudeMdExcludes;
			// Scan installed plugins' bundled contents once (plugins are global); the per-scope scan reads this for
			// the Global Skills section (plugin skills) and the Plugins section (each plugin's contents).
			this._pluginContents = await this.scanInstalledPluginContents(await this.pathService.userHome());
			const scopes = await Promise.all(roots.map(r => this.scanScope(r)));
			this._snapshot = { scopes };
			signature = `${snapshotSignature(this._snapshot)}\u0000${this.sourceBodySignature()}`;
			this.updateWatchers(roots);
		} catch (err) {
			this.logService.warn('[Clawdius] config refresh failed', err);
		} finally {
			// Mark resolved even on error so surfaces stop showing "scanning..." - they render whatever snapshot
			// exists, and `hasResolved` is what releases them from that state.
			const firstResolve = !this._hasResolved;
			this._hasResolved = true;
			// EDGE-TRIGGERED from here on (see `_signature`): fire only when the scan actually produced a different
			// configuration, or on the very first resolve. The first-resolve clause is not redundant with the
			// comparison - a consumer stuck in "scanning..." must be released even when the snapshot it is about to
			// render is the empty one it already had, which is exactly what a scan that threw before assigning
			// leaves behind. A scan that throws never fires and never moves the signature: nothing observable
			// changed, and the next completed scan must still be compared against the last one that succeeded.
			const changed = signature !== undefined && signature !== this._signature;
			if (signature !== undefined) { this._signature = signature; }
			if (changed || firstResolve) {
				this._onDidChange.fire();
			}
		}
	}

	/**
	 * Record the raw body of a settings source the snapshot only summarises (or never opens), so a change no section
	 * models still moves {@link _signature} and still fires `onDidChange` (see that field for who depends on it).
	 *
	 * Called with the SUMMARISED-AWAY surface, not necessarily the whole file, and the difference is load-bearing.
	 * `~/.claude.json` is rewritten by Claude Code continuously during a session - it carries per-project history
	 * and cost bookkeeping alongside `mcpServers` - so folding its whole body in would re-arm, through a different
	 * door, exactly the rebuild-per-write storm the edge trigger exists to stop. Callers pass the part a Control
	 * Center surface actually re-reads and nothing more.
	 */
	private recordSourceBody(uri: URI, body: string | undefined): void {
		this._sourceBodies.set(uri.toString(), body ?? '');
	}

	/**
	 * The recorded source bodies as one deterministic string. Sorted by key because the per-scope scans run
	 * concurrently (`Promise.all` in `_doRefresh`), so insertion order is not stable between passes.
	 *
	 * Sorted with plain relational operators, never `localeCompare` - the same ordinal rule `compareByRunIdentity`
	 * states in `workflows/claudeWorkflowsView.ts`, and it earns its keep here for a reason of its own. This string
	 * exists only to be compared against a PRIOR signature, so its order has to be a property of the recorded keys
	 * alone; `localeCompare` would make it a property of the host locale as well. Both sides of every comparison are
	 * built in one process today, so no fire is mis-reported now - the point is that a signature which ever crosses a
	 * process or a machine must not have to re-derive that argument first.
	 */
	private sourceBodySignature(): string {
		return [...this._sourceBodies.entries()]
			.sort((a, b) => {
				if (a[0] < b[0]) { return -1; }
				if (a[0] > b[0]) { return 1; }
				return 0;
			})
			.map(([key, body]) => `${key}\u0000${body}`)
			.join('\u0001');
	}

	// --- per-scope scanning ---

	private async scanScope(r: IScopeRoots): Promise<IConfigScopeGroup> {
		const exists = await this.exists(r.claudeDir);
		const sections: IConfigSectionGroup[] = [];
		// The Managed (org-policy) scope contributes only memories - it has no editable settings surface in
		// Clawdius, and scanning its other sections would leak policy config into the Control Center.
		const toScan = r.scope === ConfigScope.Managed ? [ConfigSection.Memories] : CONFIG_SECTIONS;
		for (const section of toScan) {
			const items = await this.scanSection(r, section);
			sections.push({ section, items });
		}
		return { scope: r.scope, key: r.key, root: r.claudeDir, folderName: r.folderName, exists, sections };
	}

	private scanSection(r: IScopeRoots, section: ConfigSection): Promise<IConfigItem[]> {
		switch (section) {
			case ConfigSection.Memories: return this.scanMemories(r);
			case ConfigSection.Agents: return this.scanAgents(r);
			case ConfigSection.Skills: return this.scanSkills(r);
			case ConfigSection.Commands: return this.scanCommands(r);
			case ConfigSection.Plugins: return this.scanPlugins(r);
			case ConfigSection.Mcp: return this.scanMcp(r);
			case ConfigSection.Hooks: return this.scanHooks(r);
			case ConfigSection.Permissions: return this.scanPermissions(r);
		}
	}

	private id(scopeKey: string, section: ConfigSection, name: string): string {
		return `${scopeKey}:${section}:${name}`;
	}

	/**
	 * Union the `claudeMdExcludes` arrays from every scope's settings.json (+ project settings.local.json).
	 *
	 * Doubles as the one place every user-editable settings file in every scope is already opened, so it is also
	 * where their raw bodies are recorded for the fired signature ({@link recordSourceBody}). The snapshot mines
	 * these files for `claudeMdExcludes`, hook event names and permission rules ONLY, while the Control Center's
	 * Effective tab re-resolves every key in them and re-reads only when `onDidChange` fires - so without the raw
	 * body an edit to `model` / `env` / `statusLine` would produce a byte-identical snapshot and leave that tab on
	 * the pre-edit value. The bound: this covers the tiers a person EDITS. The tier that changes by policy push
	 * instead - the server-managed cache (`remote-settings.json`) - is resolved by that same tab and is recorded by
	 * {@link recordServerManagedBody}, which also says why the system managed-settings file is not.
	 */
	private async gatherClaudeMdExcludes(roots: IScopeRoots[]): Promise<string[]> {
		// One read per (root, file), all in flight at once: the files are independent and the union below does not
		// care which arrives first. `Promise.all` still resolves POSITIONALLY, so the returned globs stay in
		// root-then-file order - the order the sequential version produced.
		const parsed = await Promise.all(roots.flatMap(r => {
			const files = r.scope === ConfigScope.Project ? ['settings.json', 'settings.local.json'] : ['settings.json'];
			return files.map(async file => {
				const uri = URI.joinPath(r.claudeDir, file);
				const text = await this.readText(uri);
				this.recordSourceBody(uri, text);
				return this.parseJsoncBody<{ claudeMdExcludes?: unknown }>(text);
			});
		}));
		const out: string[] = [];
		for (const json of parsed) {
			if (Array.isArray(json?.claudeMdExcludes)) {
				out.push(...json.claudeMdExcludes.filter((x: unknown): x is string => typeof x === 'string'));
			}
		}
		return out;
	}

	/**
	 * Record the server-managed settings cache (`~/.claude/remote-settings.json`) into the fired signature.
	 *
	 * The one settings source `ClawdiusEffectiveConfigService.resolve()` reads that NO section scans, which is exactly
	 * how the edge trigger lost it: a policy push rewrites this file, the write is a direct child of the watched
	 * `~/.claude` so `isRelevant` accepts it and a rescan runs, and then that rescan produces a byte-identical
	 * signature because nothing in the snapshot models the file - so `onDidChange` stayed silent and the Effective
	 * tab, whose whole purpose is the resolved value of every setting, kept serving pre-push values until the user
	 * pressed Refresh. Restoring the unconditional fire would "fix" it by declaring every scan a change, which is the
	 * ~1Hz Control Center rebuild (and the renderer memory blowup behind it) the edge trigger exists to stop: the
	 * signature has to cover more sources, not stop discriminating between them. Cost is one extra small-file read
	 * per scan; the bytes are all this needs, so nothing here parses or models server-managed policy.
	 *
	 * The SYSTEM managed-settings file is deliberately NOT recorded even though the resolver reads it too
	 * (`managed-settings.json` + the `managed-settings.d` drop-ins under {@link IScopeRoots.baseDir} of the Managed
	 * scope). Nothing would ever compare the recorded body: neither path reaches any branch of `isRelevant`, so an
	 * admin push schedules no scan in the first place. Note WHERE each one is lost, because the two differ and only
	 * one of them is a watch gap: `managed-settings.json` is a direct child of the Managed root's `baseDir`, so it IS
	 * under a watch request and its event is generated and then dropped by the relevance filter, while the drop-in
	 * directory is under no watch request at all. Recording either would be dead weight that reads like coverage.
	 * Closing that gap is a watch + relevance change AND this recording together - see the warning on `isRelevant`
	 * about why half of it is worse than none - and it belongs with the remote-managed-host work the resolver defers.
	 */
	private async recordServerManagedBody(roots: IScopeRoots[]): Promise<void> {
		// Built from the Global root's own `claudeDir` (home + `.claude`) so it is the SAME URI the resolver derives
		// from `IPathService.userHome()`, including in a remote window where home is not on the file scheme.
		const claudeDir = roots.find(r => r.scope === ConfigScope.Global)?.claudeDir;
		if (!claudeDir) { return; }
		const uri = URI.joinPath(claudeDir, REMOTE_SETTINGS_JSON);
		this.recordSourceBody(uri, await this.readText(uri));
	}

	/**
	 * Record the raw body of every {@link PLUGIN_REGISTRY_FILES} entry under `~/.claude/plugins` into the fired
	 * signature - the registry indexes the Control Center's Plugins tab re-reads on `onDidChange` and on nothing else
	 * short of its own Refresh button.
	 *
	 * Both entries were live instances of the signature invariant (see `IClawdiusConfigService.onDidChange`), for two
	 * different reasons. `known_marketplaces.json` reached NO part of the snapshot - no scan opens it - yet the tab's
	 * own "Add marketplace" button stages `claude plugin marketplace add` in a terminal without re-reading anything,
	 * so the CLI's write scheduled a scan that came out byte-identical and the new marketplace never appeared;
	 * `remove` left a dead row whose buttons still staged commands, and `update` left a stale `lastUpdated`.
	 * `installed_plugins.json` reached it only PARTLY - `scanPlugins` models it by its `plugins` keys and
	 * `firstInstallPath` - so a rewrite that relabels an entry's `version` in place, without moving the install path
	 * the version normally rides on, left the installed rows showing the old version.
	 *
	 * The loop is over the shared constant on purpose: a name added there is recorded here and walked by the
	 * regression test in the same change, and the Plugins tab cannot read a registry file that is not in it.
	 *
	 * Cost is two small-file reads per scan (a few KB each, against a scan that already reads on the order of a
	 * megabyte), and neither file is continuously rewritten - the CLI touches them on install / update / marketplace
	 * change - so unlike `~/.claude.json` they cannot re-arm the per-write rebuild storm {@link recordSourceBody}
	 * warns about.
	 */
	private async recordPluginRegistryBodies(roots: IScopeRoots[]): Promise<void> {
		// Plugins are global to the CLI (`scanPlugins` returns [] for every other scope), so there is one registry
		// directory regardless of how many workspace folders are open.
		const claudeDir = roots.find(r => r.scope === ConfigScope.Global)?.claudeDir;
		if (!claudeDir) { return; }
		await Promise.all(PLUGIN_REGISTRY_FILES.map(async file => {
			const uri = URI.joinPath(claudeDir, 'plugins', file);
			this.recordSourceBody(uri, await this.readText(uri));
		}));
	}

	/**
	 * Record the raw bodies of the nested (subtree) CLAUDE.md files {@link nestedMemoriesFor} last probed.
	 *
	 * These are the one config files no scan reaches: they are found by walking from the ACTIVE FILE up to its
	 * workspace folder, so the store cannot enumerate them the way it enumerates `~/.claude`, and a blanket recursive
	 * watch over a workspace folder is exactly the wrong price to pay for them. The context-budget panel and its
	 * status-bar pill both cache the walk per active file, and each clears that cache in exactly ONE place - its
	 * `onDidChange` handler (`clawdiusContextBudgetView`, `clawdiusContextBudgetStatusEntry`). So before this, an edit
	 * to a nested file left its tokens frozen until some UNRELATED config change fired the event. Switching editors
	 * does not clear the cache and never did; it only selects a different key, and switching back re-serves the same
	 * stale entry. Under the old unconditional fire this was masked - any `~/.claude` write refreshed them
	 * incidentally - which made the staleness intermittent rather than permanent.
	 *
	 * Bounded by tracking only the MOST RECENT chain rather than every file the user has visited. That is the right
	 * bound because the chain is what a surface is showing right now (both consumers key on the active editor, and
	 * both clear their WHOLE cache on a fire), and because `nestedDirChain` already caps a chain at 64 - so this is a
	 * handful of small reads per scan in practice, and a set that cannot grow with session length.
	 *
	 * The tracked chain moving (the user activates an editor in a different directory) grows or shrinks the recorded
	 * set, so the NEXT scan after that sees a different signature and fires once even if no file changed. That is a
	 * single event per directory change, it cannot repeat - the consumers re-walk for the same active file and land
	 * on the same chain - and paying it is what keeps this bounded instead of accumulating every file ever visited.
	 */
	private async recordNestedMemoryBodies(): Promise<void> {
		// All in flight at once, not one after another: this is the longest of the pre-scan passes (`nestedDirChain`
		// caps a chain at 64) and it sits on the critical path of every scan, so awaiting each read in turn would put
		// up to 64 sequential round-trips ahead of the scan in a remote window. The reads are independent.
		await Promise.all(this._nestedProbed.map(async key => {
			const uri = URI.parse(key);
			// Recorded even when absent (as ''), so CREATING a nested CLAUDE.md moves the signature too - the panel
			// has to grow the new file's tokens, not just track edits to one it already listed.
			this.recordSourceBody(uri, await this.readText(uri));
		}));
	}

	/** A CLAUDE.md-family file the `claudeMdExcludes` setting suppresses (never the org-managed policy file). */
	private excludedClaudeMd(uri: URI, scope: ConfigScope): boolean {
		return scope !== ConfigScope.Managed && isClaudeMdExcluded(uri.fsPath, this._claudeMdExcludes);
	}

	private async scanMemories(r: IScopeRoots): Promise<IConfigItem[]> {
		// Claude Code reads memory from several places. Managed: <policyDir>/CLAUDE.md (+ rules). Global:
		// ~/.claude/CLAUDE.md (+ rules). Project: folder-root CLAUDE.md / CLAUDE.local.md, .claude/CLAUDE.md,
		// .claude/rules/**, and per-project auto memory ~/.claude/projects/<enc>/memory/MEMORY.md.
		const home = await this.pathService.userHome();
		const items: IConfigItem[] = [];

		const memoryCandidates: { label: string; uri: URI }[] =
			r.scope === ConfigScope.Global ? [{ label: 'CLAUDE.md', uri: URI.joinPath(r.claudeDir, 'CLAUDE.md') }]
				: r.scope === ConfigScope.Managed ? [{ label: 'CLAUDE.md', uri: URI.joinPath(r.baseDir, 'CLAUDE.md') }]
					: [
						{ label: 'CLAUDE.md', uri: URI.joinPath(r.baseDir, 'CLAUDE.md') },
						{ label: 'CLAUDE.local.md', uri: URI.joinPath(r.baseDir, 'CLAUDE.local.md') },
						{ label: '.claude/CLAUDE.md', uri: URI.joinPath(r.claudeDir, 'CLAUDE.md') },
					];
		for (const c of memoryCandidates) {
			if (this.excludedClaudeMd(c.uri, r.scope)) { continue; }
			const item = await this.memoryItem(r.scope, r.key, c.label, c.uri, false, home);
			if (item) { items.push(item); }
		}

		// Auto memory (project only): the first ~200 lines / 25KB of MEMORY.md load every session.
		if (r.scope === ConfigScope.Project) {
			const autoUri = URI.joinPath(home, '.claude', 'projects', encodeProjectDir(r.baseDir), 'memory', 'MEMORY.md');
			const raw = await this.readText(autoUri);
			if (raw !== undefined) {
				const capped = capAutoMemory(raw);
				items.push({
					id: this.id(r.key, ConfigSection.Memories, 'MEMORY.md'),
					scope: r.scope, section: ConfigSection.Memories, label: 'memory/MEMORY.md', resource: autoUri,
					backing: ConfigBacking.File, canDelete: false, canMove: false,
					budget: { kind: 'automem', approxTokens: estimateTokens(capped), chars: capped.length, inclusion: ContextInclusion.Always },
				});
			}
		}

		// Rules (.claude/rules/**/*.md): auto-loaded always-on unless they declare a `paths:` frontmatter.
		const rulesDir = URI.joinPath(r.claudeDir, 'rules');
		for (const rf of await this.walkMarkdown(rulesDir, rulesDir, 0)) {
			const item = await this.memoryItem(r.scope, r.key, `rules/${rf.rel.replace(/\\/g, '/')}`, rf.resource, true, home);
			if (item) { items.push(item); }
		}

		return items;
	}

	/** Build a memory/rule item: own-file budget + transitively-resolved `@`-imports + heading children.
	 *  Returns undefined when the file does not exist. `nested` marks a subtree CLAUDE.md (lazy load). */
	private async memoryItem(scope: ConfigScope, key: string, label: string, uri: URI, isRule: boolean, home: URI, nested = false): Promise<IConfigItem | undefined> {
		const content = await this.readText(uri);
		if (content === undefined) { return undefined; }
		const visited = new ResourceMap<boolean>();
		visited.set(uri, true);
		const imports = await this.expandImports(content, uri, home, 0, visited);
		const base = memoryBudget(isRule, content);
		// Per-heading token spans (this heading's line up to the next), so the inspector can break a big file down
		// by section and jump to the heaviest. The body before the first heading is not attributed (intentional).
		const hs = headings(content);
		const lines = content.split(/\r?\n/);
		const children = hs.map((hd, i) => {
			const endLine = i + 1 < hs.length ? hs[i + 1].line : lines.length + 1;
			const spanText = lines.slice(hd.line - 1, endLine - 1).join('\n');
			return {
				id: this.id(key, ConfigSection.Memories, `${label}:h${i}`),
				scope, section: ConfigSection.Memories, label: hd.text.trim(), resource: uri, reveal: { lineNumber: hd.line },
				budget: { kind: 'memory' as const, approxTokens: estimateTokens(spanText), chars: spanText.length, inclusion: ContextInclusion.Always },
			};
		});
		const merged = imports.length ? { ...base, imports } : base;
		return {
			id: this.id(key, ConfigSection.Memories, label),
			scope, section: ConfigSection.Memories, label, resource: uri,
			backing: ConfigBacking.File, canDelete: scope !== ConfigScope.Managed, canMove: false,
			budget: nested ? { ...merged, nested: true } : merged,
			children,
		};
	}

	/** Transitively resolve `@`-imports from a memory/rule body into flat budget entries. Bounded to 4 hops
	 *  (Claude Code's max) and de-duped via `visited` (which the caller seeds with the importing file, so a file
	 *  never imports itself). The resolver dedupes again across all sources by uri. */
	private async expandImports(content: string, importerUri: URI, home: URI, depth: number, visited: ResourceMap<boolean>): Promise<IConfigBudgetImport[]> {
		if (depth >= 4) { return []; }
		const importerDir = URI.joinPath(importerUri, '..');
		const out: IConfigBudgetImport[] = [];
		for (const target of parseImportTargets(content)) {
			const uri = resolveImportUri(target, importerDir, home);
			if (!uri || visited.has(uri)) { continue; }
			visited.set(uri, true);
			const imported = await this.readTextCached(uri);
			if (imported === undefined) { continue; }
			out.push({ uri: uri.toString(), label: this.importLabel(uri, home), approxTokens: estimateTokens(imported) });
			out.push(...await this.expandImports(imported, uri, home, depth + 1, visited));
		}
		return out;
	}

	/** Short display label for an imported file: home-relative (`~/...`) when under home, else its basename. */
	private importLabel(uri: URI, home: URI): string {
		const base = home.path.endsWith('/') ? home.path : home.path + '/';
		return uri.path.startsWith(base) ? '~/' + uri.path.slice(base.length) : (uri.path.split('/').pop() ?? uri.path);
	}

	private async scanAgents(r: IScopeRoots): Promise<IConfigItem[]> {
		const dir = URI.joinPath(r.claudeDir, 'agents');
		const files = (await this.listDir(dir)).filter(c => !c.isDirectory && c.name.endsWith('.md'));
		const items: IConfigItem[] = [];
		for (const f of files) {
			const fm = frontMatter(await this.readText(f.resource) ?? '');
			const name = fm.fields['name'] || f.name.replace(/\.md$/, '');
			items.push({
				id: this.id(r.key, ConfigSection.Agents, name),
				scope: r.scope, section: ConfigSection.Agents,
				label: name, description: fm.fields['description'], color: fm.fields['color'], resource: f.resource,
				backing: ConfigBacking.File, canDelete: true, canMove: true,
			});
		}
		return items.sort((a, b) => a.label.localeCompare(b.label));
	}

	private async scanSkills(r: IScopeRoots): Promise<IConfigItem[]> {
		const dir = URI.joinPath(r.claudeDir, 'skills');
		const folders = (await this.listDir(dir)).filter(c => c.isDirectory);
		const items: IConfigItem[] = [];
		for (const folder of folders) {
			const skillMd = URI.joinPath(folder.resource, 'SKILL.md');
			const content = await this.readText(skillMd);
			const fm = frontMatter(content ?? '');
			items.push({
				id: this.id(r.key, ConfigSection.Skills, folder.name),
				scope: r.scope, section: ConfigSection.Skills,
				label: fm.fields['name'] || folder.name, description: fm.fields['description'],
				resource: content !== undefined ? skillMd : folder.resource,
				backing: ConfigBacking.Folder, targetResource: folder.resource, canDelete: true, canMove: true,
				// Skill BODY is on-invoke; the name+description "menu" line is injected always-on so the model
				// knows the skill exists (menuTokens).
				budget: {
					kind: 'skill', approxTokens: estimateTokens(content ?? ''), chars: content?.length ?? 0, inclusion: ContextInclusion.Manual,
					menuTokens: estimateTokens(`${fm.fields['name'] || folder.name}: ${fm.fields['description'] ?? ''}`),
				},
			});
		}
		// Plugin-bundled skills are global (the CLI installs plugins globally), so surface them alongside the user's
		// own ~/.claude/skills. They carry `sourcePlugin` (the Skills tab shows it as the origin) and are read-only:
		// no backing / no budget, so they never offer delete/move here and never shift the Context Budget totals.
		// Appended AFTER the user skills so a name shared with a user skill keeps the user (deletable) item first.
		if (r.scope === ConfigScope.Global) {
			for (const p of this._pluginContents) { items.push(...p.skills); }
		}
		return items.sort((a, b) => a.label.localeCompare(b.label));
	}

	/** Scan every installed plugin's bundled contents (skills / agents / commands / hooks) from its install dir.
	 *  Reads installed_plugins.json for the ids + install paths; a missing / malformed file yields []. Best-effort
	 *  and bounded to the handful of installed plugins. */
	private async scanInstalledPluginContents(home: URI): Promise<IPluginContentScan[]> {
		const installedUri = URI.joinPath(home, '.claude', 'plugins', 'installed_plugins.json');
		const plugins = (await this.readJsonc<{ plugins?: Record<string, unknown> }>(installedUri))?.plugins ?? {};
		const scans = await Promise.all(Object.entries(plugins).map(async ([id, recs]): Promise<IPluginContentScan | undefined> => {
			const installPath = firstInstallPath(recs);
			if (!installPath) { return undefined; }
			// Resolve the absolute install path on the SAME provider as home, so a remote (WSL/SSH) window reads the
			// remote plugin dir rather than a local file: URI (mirrors resolveImportUri's absolute-path handling).
			let dir: URI;
			try { dir = home.with({ path: URI.file(installPath).path }); } catch { return undefined; }
			const pluginName = id.includes('@') ? id.slice(0, id.indexOf('@')) : id;
			const [skills, agents, commands, hooks] = await Promise.all([
				this.scanPluginSkills(dir, id, pluginName),
				this.scanPluginAgents(dir, id, pluginName),
				this.scanPluginCommands(dir, id, pluginName),
				this.scanPluginHooks(dir, id, pluginName),
			]);
			return { id, pluginName, skills, agents, commands, hooks };
		}));
		return scans.filter((s): s is IPluginContentScan => !!s);
	}

	/** Stable id for a plugin-bundled item; includes the plugin id so a name shared across plugins (or with a user
	 *  item) never collides. */
	private pluginItemId(pluginId: string, section: ConfigSection, name: string): string {
		return `global:plugin:${pluginId}:${section}:${name}`;
	}

	private async scanPluginSkills(pluginDir: URI, pluginId: string, pluginName: string): Promise<IConfigItem[]> {
		const folders = (await this.listDir(URI.joinPath(pluginDir, 'skills'))).filter(c => c.isDirectory);
		const items: IConfigItem[] = [];
		for (const folder of folders) {
			const skillMd = URI.joinPath(folder.resource, 'SKILL.md');
			const content = await this.readText(skillMd);
			const fm = frontMatter(content ?? '');
			items.push({
				id: this.pluginItemId(pluginId, ConfigSection.Skills, folder.name),
				scope: ConfigScope.Global, section: ConfigSection.Skills,
				label: fm.fields['name'] || folder.name, description: fm.fields['description'],
				resource: content !== undefined ? skillMd : folder.resource,
				sourcePlugin: pluginName, canDelete: false, canMove: false,
			});
		}
		return items.sort((a, b) => a.label.localeCompare(b.label));
	}

	private async scanPluginAgents(pluginDir: URI, pluginId: string, pluginName: string): Promise<IConfigItem[]> {
		const files = (await this.listDir(URI.joinPath(pluginDir, 'agents'))).filter(c => !c.isDirectory && c.name.endsWith('.md'));
		return files
			.map(f => ({
				id: this.pluginItemId(pluginId, ConfigSection.Agents, f.name),
				scope: ConfigScope.Global, section: ConfigSection.Agents,
				label: f.name.replace(/\.md$/, ''), resource: f.resource,
				sourcePlugin: pluginName, canDelete: false, canMove: false,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}

	private async scanPluginCommands(pluginDir: URI, pluginId: string, pluginName: string): Promise<IConfigItem[]> {
		const dir = URI.joinPath(pluginDir, 'commands');
		const files = await this.walkMarkdown(dir, dir, 0);
		return files
			.map(f => ({
				id: this.pluginItemId(pluginId, ConfigSection.Commands, f.rel),
				scope: ConfigScope.Global, section: ConfigSection.Commands,
				label: `/${f.rel.replace(/\.md$/, '').replace(/[\\/]/g, ':')}`, resource: f.resource,
				sourcePlugin: pluginName, canDelete: false, canMove: false,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}

	private async scanPluginHooks(pluginDir: URI, pluginId: string, pluginName: string): Promise<IConfigItem[]> {
		const resource = URI.joinPath(pluginDir, 'hooks', 'hooks.json');
		const json = await this.readJsonc<{ hooks?: Record<string, unknown[]> }>(resource);
		const out: IConfigItem[] = [];
		for (const [event, entries] of Object.entries(json?.hooks ?? {})) {
			const count = Array.isArray(entries) ? entries.length : 0;
			out.push({
				id: this.pluginItemId(pluginId, ConfigSection.Hooks, event),
				scope: ConfigScope.Global, section: ConfigSection.Hooks,
				label: event, description: count === 1 ? '1 hook' : `${count} hooks`, resource,
				sourcePlugin: pluginName, canDelete: false, canMove: false,
			});
		}
		return out;
	}

	private async scanCommands(r: IScopeRoots): Promise<IConfigItem[]> {
		const dir = URI.joinPath(r.claudeDir, 'commands');
		const files = await this.walkMarkdown(dir, dir, 0);
		return files
			.map(f => ({
				id: this.id(r.key, ConfigSection.Commands, f.rel),
				scope: r.scope, section: ConfigSection.Commands,
				label: `/${f.rel.replace(/\.md$/, '').replace(/[\\/]/g, ':')}`, resource: f.resource,
				backing: ConfigBacking.File, canDelete: true, canMove: true,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}

	private async scanPlugins(r: IScopeRoots): Promise<IConfigItem[]> {
		if (r.scope !== ConfigScope.Global) { return []; } // plugins are global to the CLI
		const installedUri = URI.joinPath(r.claudeDir, 'plugins', 'installed_plugins.json');
		// installed_plugins.json is `{ version, plugins: { "<id>": [...] } }`; plugin ids are the keys of `plugins`.
		const settingsUri = URI.joinPath(r.claudeDir, 'settings.json');
		const installed = (await this.readJsonc<{ plugins?: Record<string, unknown> }>(installedUri))?.plugins ?? {};
		const enabledPlugins = (await this.readJsonc<{ enabledPlugins?: Record<string, unknown> }>(settingsUri))?.enabledPlugins ?? {};
		const names = new Set<string>([...Object.keys(installed), ...Object.keys(enabledPlugins)]);
		// Attach each plugin's bundled contents (scanned once this refresh) as children, so the Plugins tab can show
		// what a plugin ships. The scan is keyed by the same `plugin-name@marketplace` id used here.
		const contentById = new Map(this._pluginContents.map(p => [p.id, p]));
		return [...names].sort().map(name => {
			const content = contentById.get(name);
			const children = content ? [...content.skills, ...content.agents, ...content.commands, ...content.hooks] : [];
			return {
				id: this.id(r.key, ConfigSection.Plugins, name),
				scope: r.scope, section: ConfigSection.Plugins, label: name,
				// Open the file the row actually comes from: the install registry if installed, else the
				// settings.json that toggles it (an enabled/disabled-only row has no installed_plugins entry).
				resource: Object.hasOwn(installed, name) ? installedUri : settingsUri,
				description: enabledPlugins[name] === false ? 'disabled' : (Object.hasOwn(enabledPlugins, name) ? 'enabled' : 'installed'),
				children: children.length > 0 ? children : undefined,
			};
		});
	}

	private async scanMcp(r: IScopeRoots): Promise<IConfigItem[]> {
		// Project: <folder>/.mcp.json; Global: ~/.claude.json (the home-level CLI config), if present.
		const resource = r.scope === ConfigScope.Project ? URI.joinPath(r.baseDir, '.mcp.json') : URI.joinPath(r.baseDir, '.claude.json');
		const json = await this.readJsonc<{ mcpServers?: Record<string, unknown> }>(resource);
		const servers = json?.mcpServers ?? {};
		// The item below models a server by NAME alone, but the Control Center's MCP rows render each server's
		// transport / command / args and prune its discovered-tool list when that def changes - and they drop that
		// cache only on `onDidChange`. So the `mcpServers` object goes into the fired signature, and ONLY it: the
		// rest of `~/.claude.json` is per-project history and cost bookkeeping the CLI rewrites throughout a
		// session, and folding that in would rebuild the whole tab on every message.
		this.recordSourceBody(resource, JSON.stringify(servers));
		return Object.keys(servers).sort().map(name => ({
			id: this.id(r.key, ConfigSection.Mcp, name),
			scope: r.scope, section: ConfigSection.Mcp, label: name, resource,
			backing: ConfigBacking.Jsonc, jsonPath: ['mcpServers', name], canDelete: true, canMove: true,
		}));
	}

	private async scanHooks(r: IScopeRoots): Promise<IConfigItem[]> {
		const items: IConfigItem[] = [];
		for (const file of r.scope === ConfigScope.Global ? ['settings.json'] : ['settings.json', 'settings.local.json']) {
			const resource = URI.joinPath(r.claudeDir, file);
			const json = await this.readJsonc<{ hooks?: Record<string, unknown[]> }>(resource);
			for (const [event, entries] of Object.entries(json?.hooks ?? {})) {
				const count = Array.isArray(entries) ? entries.length : 0;
				items.push({
					id: this.id(r.key, ConfigSection.Hooks, `${file}:${event}`),
					scope: r.scope, section: ConfigSection.Hooks,
					label: event, description: count === 1 ? '1 hook' : `${count} hooks`, resource,
					backing: ConfigBacking.Jsonc, jsonPath: ['hooks', event], canDelete: true, canMove: false,
				});
			}
		}
		return items;
	}

	private async scanPermissions(r: IScopeRoots): Promise<IConfigItem[]> {
		const items: IConfigItem[] = [];
		for (const file of r.scope === ConfigScope.Global ? ['settings.json'] : ['settings.json', 'settings.local.json']) {
			const resource = URI.joinPath(r.claudeDir, file);
			const perms = (await this.readJsonc<{ permissions?: { allow?: string[]; ask?: string[]; deny?: string[] } }>(resource))?.permissions;
			if (!perms) { continue; }
			for (const kind of ['allow', 'ask', 'deny'] as const) {
				const rules = Array.isArray(perms[kind]) ? perms[kind]! : [];
				if (rules.length === 0) { continue; }
				const label = file === 'settings.json' ? kind : `${kind} (local)`;
				items.push({
					id: this.id(r.key, ConfigSection.Permissions, `${file}:${kind}`),
					scope: r.scope, section: ConfigSection.Permissions,
					label, description: `${rules.length}`, resource,
					backing: ConfigBacking.Jsonc, jsonPath: ['permissions', kind],
					children: rules.map((rule, i) => ({
						id: this.id(r.key, ConfigSection.Permissions, `${file}:${kind}:${i}`),
						scope: r.scope, section: ConfigSection.Permissions, label: rule, resource,
						// Path includes the exact array INDEX so deleting one rule removes only that row
						// (not every duplicate of the same string).
						backing: ConfigBacking.Jsonc, jsonPath: ['permissions', kind, i], canDelete: true,
					})),
				});
			}
		}
		return items;
	}

	// --- file helpers (all best-effort) ---

	private async exists(uri: URI): Promise<boolean> {
		try { return (await this.fileService.stat(uri)).isDirectory ?? true; } catch { return false; }
	}

	private async readText(uri: URI): Promise<string | undefined> {
		try { return (await this.fileService.readFile(uri)).value.toString(); } catch { return undefined; }
	}

	/** Read only the last `maxBytes` of a file, dropping the partial leading line. Bounds the read cost of an
	 *  append-only log that grows without limit (the hook log), so a big file doesn't slow the panel. */
	private async readTextTail(uri: URI, maxBytes: number): Promise<string | undefined> {
		try {
			const size = (await this.fileService.stat(uri)).size ?? 0;
			if (size <= maxBytes) { return (await this.fileService.readFile(uri)).value.toString(); }
			const buf = await this.fileService.readFile(uri, { position: size - maxBytes, length: maxBytes });
			return dropPartialFirstLine(buf.value.toString());
		} catch { return undefined; }
	}

	async nestedMemoriesFor(activeFile: URI, workspaceFolders: readonly URI[]): Promise<IConfigItem[]> {
		const folder = containingFolderOf(activeFile, workspaceFolders);
		if (!folder) { return []; }
		const home = await this.pathService.userHome();
		const key = folder.toString();
		const items: IConfigItem[] = [];
		const probed: string[] = [];
		// A CLAUDE.md in any directory between the workspace folder and the active file's dir loads on demand
		// (load_reason: nested_traversal) when Claude reads files there. nestedDirChain returns them outer-first.
		for (const d of nestedDirChain(activeFile, folder)) {
			const uri = URI.joinPath(d, 'CLAUDE.md');
			if (this.excludedClaudeMd(uri, ConfigScope.Project)) { continue; }
			// Probed, not found: the URI is remembered whether or not the file exists, because `isRelevant` and
			// `recordNestedMemoryBodies` both have to cover the file being CREATED, not only edited.
			probed.push(uri.toString());
			const rel = extUriIgnorePathCase.relativePath(folder, uri) ?? 'CLAUDE.md';
			const item = await this.memoryItem(ConfigScope.Project, key, rel, uri, false, home, true);
			if (item) { items.push(item); }
		}
		// Publish the chain so a write to one of these files is both ACCEPTED by `isRelevant` and folded into the
		// fired signature - the two legs the signature invariant needs, neither of which any scan can supply for a
		// file whose location depends on which editor is active.
		this._nestedProbed = probed;
		return items;
	}

	async readMeasuredPrefix(folder: URI): Promise<IMeasuredPrefix | undefined> {
		try {
			const home = await this.pathService.userHome();
			const dir = URI.joinPath(home, '.claude', 'projects', encodeProjectDir(folder));
			const stat = await this.fileService.resolve(dir, { resolveMetadata: true });
			const files = (stat.children ?? []).filter(c => !c.isDirectory && c.name.endsWith('.jsonl'));
			if (files.length === 0) { return undefined; }
			let latest = files[0];
			for (const f of files) { if (f.mtime > latest.mtime) { latest = f; } }
			const text = await this.readText(latest.resource);
			return text === undefined ? undefined : parseMeasuredPrefix(text);
		} catch {
			return undefined;
		}
	}

	async readConfirmedLoads(workspaceFolders: readonly URI[]): Promise<ReadonlyMap<string, IConfirmedLoad>> {
		try {
			const home = await this.pathService.userHome();
			// Tail-read so the panel stays fast even if the append-only log has grown large over time.
			const text = await this.readTextTail(URI.joinPath(home, '.claude', '.clawdius-instructions.jsonl'), 512 * 1024);
			if (text === undefined) { return new Map(); }
			// Records are scoped to sessions whose cwd is inside an open workspace folder, so a different
			// project's Claude session does not light up badges here.
			return parseConfirmedLoads(text, workspaceFolders.map(f => normalizeConfirmedPath(f.fsPath)));
		} catch { return new Map(); }
	}

	/** readText() memoized for the current refresh (see `_readCache`). */
	private readTextCached(uri: URI): Promise<string | undefined> {
		const key = uri.toString();
		let p = this._readCache.get(key);
		if (!p) { p = this.readText(uri); this._readCache.set(key, p); }
		return p;
	}

	private async readJsonc<T>(uri: URI): Promise<T | undefined> {
		return this.parseJsoncBody<T>(await this.readText(uri));
	}

	/** Parse an already-read JSONC body; undefined for an absent or unparseable one. Split out of
	 *  {@link readJsonc} for the callers that need the RAW text as well as the parse (see
	 *  {@link recordSourceBody}) and must not read the file twice to get both. */
	private parseJsoncBody<T>(text: string | undefined): T | undefined {
		if (text === undefined) { return undefined; }
		try { return parseJsonc<T>(text); } catch { return undefined; }
	}

	private async listDir(uri: URI): Promise<{ name: string; isDirectory: boolean; resource: URI }[]> {
		try {
			const stat = await this.fileService.resolve(uri);
			return (stat.children ?? []).map(c => ({ name: c.name, isDirectory: !!c.isDirectory, resource: c.resource }));
		} catch {
			return [];
		}
	}

	/** Collect markdown files under `dir`, returning their path relative to `base`. Bounded depth. */
	private async walkMarkdown(dir: URI, base: URI, depth: number): Promise<{ rel: string; resource: URI }[]> {
		if (depth > 4) { return []; }
		const out: { rel: string; resource: URI }[] = [];
		for (const child of await this.listDir(dir)) {
			if (child.isDirectory) {
				out.push(...await this.walkMarkdown(child.resource, base, depth + 1));
			} else if (child.name.endsWith('.md')) {
				const rel = child.resource.path.slice(base.path.length).replace(/^[\\/]+/, '');
				out.push({ rel, resource: child.resource });
			}
		}
		return out;
	}

	// --- watching (shared/uncorrelated; recursive only where a scan root nests) ---

	/**
	 * (Re)build the watch set for `roots`. A NO-OP when the root set is unchanged, which is the normal case: every
	 * watch request below is derived purely from a root's `claudeDir` / `baseDir`, and those only move when the
	 * workspace folders do. `_doRefresh` still drives this because it is the one place the resolved roots are in
	 * hand (they need `pathService.userHome()`), so the guard - not the call site - is what stops the churn; that
	 * also makes it impossible to lose a watch by forgetting a root transition, since every transition necessarily
	 * passes through a refresh.
	 *
	 * ADDING A WATCH REQUEST HERE IS HALF A CHANGE: the scan has to fold the newly watched file into the fired
	 * signature too, or the watch buys a scan per write and no refresh at all. See the signature invariant on
	 * {@link IClawdiusConfigService.onDidChange} for the obligation, and {@link recordSourceBody} for the mechanism.
	 * Note also that every request below is NON-RECURSIVE except commands / skills / rules: a non-recursive request
	 * reports direct children only, which is what keeps `plugins/marketplaces/**` and `plugins/cache/**` out of the
	 * watched set (deliberately - the marketplace catalogs are large and are covered through their sibling
	 * `known_marketplaces.json` write instead; see {@link PLUGIN_REGISTRY_FILES}).
	 */
	private updateWatchers(roots: IScopeRoots[]): void {
		const key = roots.map(r => r.key).join('\n');
		if (key === this._watchedRootsKey) { return; }
		this._watchedRootsKey = key;
		this._watchers.clear();
		const watched = new ResourceMap<boolean>();
		const watch = (uri: URI, recursive: boolean) => {
			if (watched.has(uri)) { return; }
			watched.set(uri, true);
			try { this._watchers.add(this.fileService.watch(uri, { recursive, excludes: [] })); } catch { /* best-effort */ }
		};
		// The per-project auto memory lives under the GLOBAL root even for a Project scope, so its watch needs the
		// global `.claude` directory rather than the project's own (see the loop below).
		const globalClaudeDir = roots.find(r => r.scope === ConfigScope.Global)?.claudeDir;
		for (const r of roots) {
			watch(r.claudeDir, false);
			watch(URI.joinPath(r.claudeDir, 'agents'), false);
			watch(URI.joinPath(r.claudeDir, 'plugins'), false);
			// commands + skills + rules nest sub-folders, so watch them recursively to catch edits within.
			for (const sub of ['commands', 'skills', 'rules']) { watch(URI.joinPath(r.claudeDir, sub), true); }
			watch(r.baseDir, false); // catches root CLAUDE.md / CLAUDE.local.md / .mcp.json / .claude.json / .claude creation
			// `scanMemories` reads the per-project auto memory at `~/.claude/projects/<enc>/memory/MEMORY.md`, and
			// nothing above reaches it: `claudeDir` is non-recursive (so it reports direct children of `~/.claude`
			// only) and the recursive requests are limited to commands/skills/rules. It used to arrive anyway, as a
			// side effect of ClaudeWorkflowObservationService installing an UNCORRELATED recursive watch over the
			// whole `projects` tree - every transcript append in the corpus landed on the global bus and this
			// store's subtree-prefix filter accepted it, which is precisely the coupling that made the Control
			// Center rebuild about once a second. That request is correlated now, so its events never reach the
			// global bus, and the auto memory needs a watch this store owns. ONE non-recursive folder per workspace
			// folder cannot reinstate the storm: it sees `memory/` and nothing else, never a transcript.
			if (globalClaudeDir && r.scope === ConfigScope.Project) {
				watch(URI.joinPath(globalClaudeDir, 'projects', encodeProjectDir(r.baseDir), 'memory'), false);
			}
		}
		this._watchers.add(this.fileService.onDidFilesChange((e: FileChangesEvent) => {
			if (this.isRelevant(e, roots)) { this._refreshScheduler.schedule(); }
		}));
	}

	/**
	 * Whether `e` touches anything this store's snapshot or fired signature is built from.
	 *
	 * From a `baseDir` this accepts EXACTLY the four named files and nothing else, which is why a broad directory
	 * such as the home dir or the managed-settings root can be watched cheaply without every unrelated write in it
	 * scheduling a scan. Anything under a `claudeDir` is accepted wholesale (`affects` is a subtree prefix match),
	 * minus the transcript pre-filter above.
	 *
	 * Widening any branch here is half a change, never a whole one: an accepted path that reaches no part of the
	 * fired signature turns a dead event into a live instance of the signature invariant (see
	 * {@link IClawdiusConfigService.onDidChange}). `managed-settings.json` is the standing example. It IS watched (it
	 * is a direct child of the Managed root's `baseDir`) and the Effective tab does resolve it, so its events are
	 * generated today and dropped right here; accepting them without also recording its body would buy nothing at all
	 * (see {@link recordServerManagedBody} for why the body is not recorded yet).
	 */
	private isRelevant(e: FileChangesEvent, roots: IScopeRoots[]): boolean {
		if (this.onlyTouchesTranscripts(e, roots)) { return false; }
		for (const r of roots) {
			if (e.affects(r.claudeDir)
				|| e.affects(URI.joinPath(r.baseDir, 'CLAUDE.md'))
				|| e.affects(URI.joinPath(r.baseDir, 'CLAUDE.local.md'))
				|| e.affects(URI.joinPath(r.baseDir, '.mcp.json'))
				|| e.affects(URI.joinPath(r.baseDir, '.claude.json'))) {
				return true;
			}
		}
		// The nested CLAUDE.md files a context-budget surface is showing (see {@link recordNestedMemoryBodies}).
		// Matched by exact URI rather than by name-under-a-workspace-folder: a subtree CLAUDE.md nobody has asked
		// about feeds no consumer, so accepting it would schedule a scan for a signature that cannot move. These
		// events arrive on the workbench's own recursive workspace watch; this store adds no watch request for them.
		return this._nestedProbed.some(key => e.affects(URI.parse(key)));
	}

	/**
	 * Whether every path in `e` is transcript state under some root's `<claudeDir>/projects` (see
	 * {@link isTranscriptPath} for the one carve-out). It has to be filtered here because
	 * `FileChangesEvent.affects(claudeDir)` is a subtree prefix match (`doContains` with `includeChildren`), so it
	 * answers true for ANY descendant of `~/.claude`, transcripts included. During an agent session that corpus is
	 * appended to continuously, and each append was scheduling a full config rescan whose event then made the
	 * Control Center rebuild its entire tab - a rebuild roughly once a second, driven by files no scan ever reads.
	 *
	 * Rejects only when the WHOLE event is transcript traffic. A batch that coalesces a transcript append with a
	 * real config write still refreshes: the config write is the fact that matters, and losing it would be a far
	 * worse failure than one redundant scan. An empty event (no raw paths) is likewise not rejected here - it
	 * falls through to the `affects` checks exactly as before, which answer false for it anyway.
	 */
	private onlyTouchesTranscripts(e: FileChangesEvent, roots: IScopeRoots[]): boolean {
		const projectsRoots = roots.map(r => URI.joinPath(r.claudeDir, 'projects'));
		let sawPath = false;
		for (const group of [e.rawAdded, e.rawUpdated, e.rawDeleted]) {
			for (const resource of group) {
				sawPath = true;
				if (!projectsRoots.some(projectsRoot => isTranscriptPath(resource, projectsRoot))) { return false; }
			}
		}
		return sawPath;
	}
}
// CLAWDIUS-END
