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
	IClawdiusConfigSnapshot, IConfigBudgetMeta, IConfigItem, IConfigScopeGroup, IConfigSectionGroup,
} from '../common/clawdiusConfig.js';

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

/** Parse an inline frontmatter `globs` value into a list of patterns: a scalar (`*.ts`), an inline array
 *  (`["*.ts","*.tsx"]`), or a comma list (`*.ts, *.tsx`). Uses splitGlobAware so a `,` inside a `{...}` brace
 *  group (e.g. `*.{ts,tsx}`) is NOT split. */
function parseGlobList(raw: string | undefined): string[] | undefined {
	let s = (raw ?? '').trim();
	if (!s) { return undefined; }
	if (s.startsWith('[') && s.endsWith(']')) { s = s.slice(1, -1); }
	const parts = splitGlobAware(s, ',').map(p => p.trim().replace(/^["']|["']$/g, '').trim().replace(/\\/g, '/')).filter(Boolean);
	return parts.length ? parts : undefined;
}

/** Extract a rule's `globs` patterns from its frontmatter block: an inline scalar/array/comma-list on the
 *  `globs:` line, OR a shallow YAML block list (`globs:` followed by indented `- pattern` lines). Returns
 *  undefined when there is no `globs:` key (an unconditional, always-on rule). Exported for unit tests. */
export function extractGlobs(content: string): string[] | undefined {
	const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content);
	if (!m) { return undefined; }
	const lines = m[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = /^globs[ \t]*:[ \t]*(.*)$/i.exec(lines[i]);
		if (!kv) { continue; }
		if (kv[1].trim()) { return parseGlobList(kv[1]); }
		// Block list: collect subsequent indented `- pattern` lines until the indentation ends.
		const items: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const li = /^[ \t]+-[ \t]*(.+?)[ \t]*$/.exec(lines[j]);
			if (!li) { break; }
			items.push(li[1].replace(/^["']|["']$/g, '').trim().replace(/\\/g, '/'));
		}
		return items.length ? items : undefined;
	}
	return undefined;
}

/** Context-budget metadata for a memory/rule file (token estimate + rule glob applicability). The content is
 *  already read by the caller, so this is free. Root CLAUDE.md/CLAUDE.local.md are always-on memory; a rule is
 *  glob-scoped when it declares `globs` (and not `alwaysApply`), else always-on (the Claude Code default). */
function memoryBudget(isRule: boolean, content: string): IConfigBudgetMeta {
	const chars = content.length;
	const approxTokens = Math.ceil(chars / 4);
	if (!isRule) {
		return { kind: 'memory', approxTokens, chars, inclusion: ContextInclusion.Always };
	}
	const alwaysApply = /^(true|yes)$/i.test(frontMatter(content).fields['alwaysapply'] ?? '');
	const globs = extractGlobs(content);
	return globs && !alwaysApply
		? { kind: 'rule', approxTokens, chars, inclusion: ContextInclusion.Glob, globs }
		: { kind: 'rule', approxTokens, chars, inclusion: ContextInclusion.Always };
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
		const roots: IScopeRoots[] = [{ scope: ConfigScope.Global, key: 'global', claudeDir: URI.joinPath(home, '.claude'), baseDir: home }];
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
			const roots = await this.scopeRoots();
			const scopes = await Promise.all(roots.map(r => this.scanScope(r)));
			this._snapshot = { scopes };
			this.updateWatchers(roots);
			this._onDidChange.fire();
		} catch (err) {
			this.logService.warn('[Clawdius] config refresh failed', err);
		}
	}

	// --- per-scope scanning ---

	private async scanScope(r: IScopeRoots): Promise<IConfigScopeGroup> {
		const exists = await this.exists(r.claudeDir);
		const sections: IConfigSectionGroup[] = [];
		for (const section of CONFIG_SECTIONS) {
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
		// Claude Code reads memory from several places. Global: ~/.claude/CLAUDE.md (+ rules). Project: the
		// folder-root CLAUDE.md / CLAUDE.local.md, the .claude/CLAUDE.md, and .claude/rules/**.
		const candidates: { label: string; uri: URI }[] = r.scope === ConfigScope.Global
			? [{ label: 'CLAUDE.md', uri: URI.joinPath(r.claudeDir, 'CLAUDE.md') }]
			: [
				{ label: 'CLAUDE.md', uri: URI.joinPath(r.baseDir, 'CLAUDE.md') },
				{ label: 'CLAUDE.local.md', uri: URI.joinPath(r.baseDir, 'CLAUDE.local.md') },
				{ label: '.claude/CLAUDE.md', uri: URI.joinPath(r.claudeDir, 'CLAUDE.md') },
			];
		const rulesDir = URI.joinPath(r.claudeDir, 'rules');
		for (const rf of await this.walkMarkdown(rulesDir, rulesDir, 0)) {
			candidates.push({ label: `rules/${rf.rel.replace(/\\/g, '/')}`, uri: rf.resource });
		}

		const items: IConfigItem[] = [];
		for (const c of candidates) {
			const content = await this.readText(c.uri);
			if (content === undefined) { continue; }
			items.push({
				id: this.id(r.key, ConfigSection.Memories, c.label),
				scope: r.scope, section: ConfigSection.Memories, label: c.label, resource: c.uri,
				backing: ConfigBacking.File, canDelete: true, canMove: false,
				budget: memoryBudget(c.label.startsWith('rules/'), content),
				children: headings(content).map((hd, i) => ({
					id: this.id(r.key, ConfigSection.Memories, `${c.label}:h${i}`),
					scope: r.scope, section: ConfigSection.Memories, label: hd.text.trim(), resource: c.uri, reveal: { lineNumber: hd.line },
				})),
			});
		}
		return items;
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
				// Skills are on-invoke (loaded when triggered), not part of every-turn context.
				budget: { kind: 'skill', approxTokens: Math.ceil((content?.length ?? 0) / 4), chars: content?.length ?? 0, inclusion: ContextInclusion.Manual },
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
