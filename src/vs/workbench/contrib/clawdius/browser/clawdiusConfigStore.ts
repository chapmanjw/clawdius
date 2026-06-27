/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Config store
// Reads the user's Claude Code configuration from local files only and produces a typed snapshot across the
// Global (~/.claude) and Project (<workspaceFolder>/.claude) scopes. No network access. Registered as the
// container-wide `IClawdiusConfigService` singleton: one scan + watcher set feeds all eight section views.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { parse as parseJsonc } from '../../../../base/common/jsonc.js';
import { splitGlobAware } from '../../../../base/common/glob.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { FileChangesEvent, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import {
	ConfigBacking, ConfigScope, ConfigSection, CONFIG_SECTIONS, ContextInclusion, IClawdiusConfigService,
	IClawdiusConfigSnapshot, IConfigBudgetImport, IConfigBudgetMeta, IConfigItem, IConfigScopeGroup, IConfigSectionGroup,
	IMeasuredPrefix,
} from '../common/clawdiusConfig.js';
import { estimateTokens, normalizeConfirmedPath } from '../common/clawdiusContextBudget.js';

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

/** Claude Code's per-project auto-memory dir key: the project path with separators / colon flattened to '-'
 *  (e.g. C:\Users\x\proj -> C--Users-x-proj). Best-effort; if it does not match, MEMORY.md just isn't found. */
function encodeProjectDir(folder: URI): string {
	return folder.fsPath.replace(/[\\/:]/g, '-');
}

/** Claude Code loads only the first ~200 lines / 25KB of MEMORY.md, so estimate from that slice. */
function capAutoMemory(content: string): string {
	return content.split(/\r?\n/).slice(0, 200).join('\n').slice(0, 25 * 1024);
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

	/** Per-refresh memo of readText() so a file imported by several memories (or both auto-scanned and imported)
	 *  is read once. Cleared at the start of every scan. */
	private readonly _readCache = new Map<string, Promise<string | undefined>>();

	private readonly _watchers = this._register(new DisposableStore());
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => void this.refresh(), 250));
	/** Coalesces concurrent refreshes: all eight section views call refresh() on first render. */
	private _refreshInFlight: Promise<void> | undefined;
	/** Set when a forced refresh arrives mid-scan, so the loop runs one more scan that starts after the write. */
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
	 */
	refresh(force = false): Promise<void> {
		if (force) { this._rerunRequested = true; }
		if (!this._refreshInFlight) {
			this._refreshInFlight = this._refreshLoop().finally(() => { this._refreshInFlight = undefined; });
		}
		return this._refreshInFlight;
	}

	private async _refreshLoop(): Promise<void> {
		do {
			this._rerunRequested = false;
			await this._doRefresh();
		} while (this._rerunRequested);
	}

	private async _doRefresh(): Promise<void> {
		try {
			this._readCache.clear();
			const roots = await this.scopeRoots();
			const scopes = await Promise.all(roots.map(r => this.scanScope(r)));
			this._snapshot = { scopes };
			this.updateWatchers(roots);
		} catch (err) {
			this.logService.warn('[Clawdius] config refresh failed', err);
		} finally {
			// Mark resolved even on error so surfaces stop showing "scanning..." (they render whatever
			// snapshot exists), and always fire so they re-render.
			this._hasResolved = true;
			this._onDidChange.fire();
		}
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
			const item = await this.memoryItem(r, c.label, c.uri, false, home);
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
			const item = await this.memoryItem(r, `rules/${rf.rel.replace(/\\/g, '/')}`, rf.resource, true, home);
			if (item) { items.push(item); }
		}

		return items;
	}

	/** Build a memory/rule item: own-file budget + transitively-resolved `@`-imports + heading children.
	 *  Returns undefined when the file does not exist. */
	private async memoryItem(r: IScopeRoots, label: string, uri: URI, isRule: boolean, home: URI): Promise<IConfigItem | undefined> {
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
				id: this.id(r.key, ConfigSection.Memories, `${label}:h${i}`),
				scope: r.scope, section: ConfigSection.Memories, label: hd.text.trim(), resource: uri, reveal: { lineNumber: hd.line },
				budget: { kind: 'memory' as const, approxTokens: estimateTokens(spanText), chars: spanText.length, inclusion: ContextInclusion.Always },
			};
		});
		return {
			id: this.id(r.key, ConfigSection.Memories, label),
			scope: r.scope, section: ConfigSection.Memories, label, resource: uri,
			backing: ConfigBacking.File, canDelete: r.scope !== ConfigScope.Managed, canMove: false,
			budget: imports.length ? { ...base, imports } : base,
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
		return items.sort((a, b) => a.label.localeCompare(b.label));
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
		return [...names].sort().map(name => ({
			id: this.id(r.key, ConfigSection.Plugins, name),
			scope: r.scope, section: ConfigSection.Plugins, label: name,
			// Open the file the row actually comes from: the install registry if installed, else the
			// settings.json that toggles it (an enabled/disabled-only row has no installed_plugins entry).
			resource: Object.hasOwn(installed, name) ? installedUri : settingsUri,
			description: enabledPlugins[name] === false ? 'disabled' : (Object.hasOwn(enabledPlugins, name) ? 'enabled' : 'installed'),
		}));
	}

	private async scanMcp(r: IScopeRoots): Promise<IConfigItem[]> {
		// Project: <folder>/.mcp.json; Global: ~/.claude.json (the home-level CLI config), if present.
		const resource = r.scope === ConfigScope.Project ? URI.joinPath(r.baseDir, '.mcp.json') : URI.joinPath(r.baseDir, '.claude.json');
		const json = await this.readJsonc<{ mcpServers?: Record<string, unknown> }>(resource);
		const servers = json?.mcpServers ?? {};
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

	async readConfirmedLoads(): Promise<ReadonlySet<string>> {
		const out = new Set<string>();
		try {
			const home = await this.pathService.userHome();
			const text = await this.readText(URI.joinPath(home, '.claude', '.clawdius-instructions.jsonl'));
			if (text === undefined) { return out; }
			// Recent tail only, so the set reflects recent sessions rather than the whole history.
			for (const line of text.split(/\r?\n/).slice(-1000)) {
				const t = line.trim();
				if (!t || t[0] !== '{') { continue; }
				try {
					const obj = JSON.parse(t);
					if (typeof obj?.file_path === 'string') { out.add(normalizeConfirmedPath(obj.file_path)); }
				} catch { /* skip a non-JSON line */ }
			}
		} catch { /* best-effort */ }
		return out;
	}

	/** readText() memoized for the current refresh (see `_readCache`). */
	private readTextCached(uri: URI): Promise<string | undefined> {
		const key = uri.toString();
		let p = this._readCache.get(key);
		if (!p) { p = this.readText(uri); this._readCache.set(key, p); }
		return p;
	}

	private async readJsonc<T>(uri: URI): Promise<T | undefined> {
		const text = await this.readText(uri);
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

	// --- watching (correlated, non-recursive) ---

	private updateWatchers(roots: IScopeRoots[]): void {
		this._watchers.clear();
		const watched = new ResourceMap<boolean>();
		const watch = (uri: URI, recursive: boolean) => {
			if (watched.has(uri)) { return; }
			watched.set(uri, true);
			try { this._watchers.add(this.fileService.watch(uri, { recursive, excludes: [] })); } catch { /* best-effort */ }
		};
		for (const r of roots) {
			watch(r.claudeDir, false);
			watch(URI.joinPath(r.claudeDir, 'agents'), false);
			watch(URI.joinPath(r.claudeDir, 'plugins'), false);
			// commands + skills + rules nest sub-folders, so watch them recursively to catch edits within.
			for (const sub of ['commands', 'skills', 'rules']) { watch(URI.joinPath(r.claudeDir, sub), true); }
			watch(r.baseDir, false); // catches root CLAUDE.md / CLAUDE.local.md / .mcp.json / .claude.json / .claude creation
		}
		this._watchers.add(this.fileService.onDidFilesChange((e: FileChangesEvent) => {
			if (this.isRelevant(e, roots)) { this._refreshScheduler.schedule(); }
		}));
	}

	private isRelevant(e: FileChangesEvent, roots: IScopeRoots[]): boolean {
		for (const r of roots) {
			if (e.affects(r.claudeDir)
				|| e.affects(URI.joinPath(r.baseDir, 'CLAUDE.md'))
				|| e.affects(URI.joinPath(r.baseDir, 'CLAUDE.local.md'))
				|| e.affects(URI.joinPath(r.baseDir, '.mcp.json'))
				|| e.affects(URI.joinPath(r.baseDir, '.claude.json'))) {
				return true;
			}
		}
		return false;
	}
}
// CLAWDIUS-END
