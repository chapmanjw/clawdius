/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Config model
// Types for the "Claude Code Config" model: the user's Claude Code configuration across two scopes (Global
// ~/.claude and the workspace's Project .claude) and the sections within each (memories, agents, skills,
// slash commands, plugins, MCP servers, hooks, permissions). Everything is read from local files only.

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Where a configuration item lives. `Managed` is the org-policy scope (a system path, highest precedence,
 *  read-only); it is scanned for MEMORIES only and is invisible to the Control Center (which has no Memories
 *  tab and filters its other tabs to Global/Project). */
export const enum ConfigScope {
	Global = 'global',
	Project = 'project',
	Managed = 'managed',
}

/** A section of Claude Code configuration. */
export const enum ConfigSection {
	Memories = 'memories',
	Agents = 'agents',
	Skills = 'skills',
	Commands = 'commands',
	Plugins = 'plugins',
	Mcp = 'mcp',
	Hooks = 'hooks',
	Permissions = 'permissions',
}

/** The fixed display order + a stable list of sections (one collapsible view each). */
export const CONFIG_SECTIONS: ReadonlyArray<ConfigSection> = [
	ConfigSection.Memories,
	ConfigSection.Commands,
	ConfigSection.Skills,
	ConfigSection.Agents,
	ConfigSection.Hooks,
	ConfigSection.Permissions,
	ConfigSection.Mcp,
	ConfigSection.Plugins,
];

/** Label for the section's primary "create" action. */
export function sectionCreateLabel(section: ConfigSection): string {
	switch (section) {
		case ConfigSection.Memories: return 'New Memory File';
		case ConfigSection.Commands: return 'New Command';
		case ConfigSection.Skills: return 'New Skill';
		case ConfigSection.Agents: return 'New Sub-Agent';
		case ConfigSection.Hooks: return 'New Hook';
		case ConfigSection.Permissions: return 'New Permission Rule';
		case ConfigSection.Mcp: return 'New MCP Server';
		case ConfigSection.Plugins: return 'Open Plugins Config';
	}
}

/** How an item is backed on disk - drives delete/move semantics. */
export const enum ConfigBacking {
	/** A standalone file (memory, command, agent). */
	File = 'file',
	/** A folder (a skill). */
	Folder = 'folder',
	/** A property/array-entry inside a JSONC settings file (hook, permission, mcp server, plugin). */
	Jsonc = 'jsonc',
}

/** A position to reveal when opening an item's underlying file. */
export interface IConfigReveal {
	readonly lineNumber: number;
	readonly column?: number;
}

/** How a memory / rule / skill source enters Claude's context for a turn. */
export const enum ContextInclusion {
	/** Loaded every turn (CLAUDE.md / CLAUDE.local.md / MEMORY.md, or a rule with no `paths`). */
	Always = 'always',
	/** A path-scoped rule loaded only when Claude touches a file matching its frontmatter `paths`. */
	Glob = 'glob',
	/** Loaded on demand (a skill - on-invoke, not every turn). */
	Manual = 'manual',
}

/** A transitively-resolved `@`-import from a memory/rule file (Claude Code expands these into context). */
export interface IConfigBudgetImport {
	/** The imported file's URI as a string. The resolver dedupes always-on sources by this, so an imported
	 *  file that is also auto-scanned (e.g. a `rules/` file) is counted once. */
	readonly uri: string;
	/** A short display label (workspace- or home-relative). */
	readonly label: string;
	/** Estimated tokens (chars / 4) for the imported file body. */
	readonly approxTokens: number;
}

/** Context-budget metadata computed during the scan (the file's content is already read there) and consumed by
 *  the Context Budget Inspector. `approxTokens` is an estimate (chars/4), never an exact count. */
export interface IConfigBudgetMeta {
	/** What kind of context source this is. `automem` is Claude Code's per-project auto memory (MEMORY.md). */
	readonly kind: 'memory' | 'rule' | 'skill' | 'automem';
	/** Estimated tokens for the file body (chars / 4). Marked "estimated" in the UI - never exact. */
	readonly approxTokens: number;
	/** Character count the estimate was derived from (so a real tokenizer can replace the heuristic later). */
	readonly chars: number;
	/** How this source enters context. */
	readonly inclusion: ContextInclusion;
	/** For a path-scoped rule: the frontmatter `paths` glob patterns (Claude Code's `paths:` key - NOT
	 *  Cursor's `globs:`). The rule loads only when Claude touches a file matching one of these. */
	readonly paths?: readonly string[];
	/** Files this source `@`-imports (transitively resolved). They load always-on with their importer; the
	 *  resolver folds their tokens into the always-on total, deduped by uri against other sources. */
	readonly imports?: readonly IConfigBudgetImport[];
}

/** A single configuration item (an agent, a skill, a slash command, a hook event, a permission rule, ...). */
export interface IConfigItem {
	/** Stable identity, e.g. `global:agents:reviewer`. */
	readonly id: string;
	readonly scope: ConfigScope;
	readonly section: ConfigSection;
	readonly label: string;
	readonly description?: string;
	/** The on-disk file to open when the item is activated. */
	readonly resource?: URI;
	/** Optional position to reveal in that file. */
	readonly reveal?: IConfigReveal;
	/** A brand color (e.g. an agent's frontmatter `color`). */
	readonly color?: string;
	/** How this item is backed on disk - drives delete / move-scope. Absent = read-only (e.g. a heading). */
	readonly backing?: ConfigBacking;
	/** The file/folder to delete or copy for `File`/`Folder` backing, when it differs from `resource`
	 *  (e.g. a skill opens its SKILL.md but deletes the whole skill folder). Defaults to `resource`. */
	readonly targetResource?: URI;
	/** For `ConfigBacking.Jsonc`, the JSON path to this exact entry, e.g. `['mcpServers','name']`,
	 *  `['hooks','PreToolUse']`, or `['permissions','allow',2]` (the array index of one rule). Used to remove
	 *  the entry with a targeted edit that leaves the rest of the file (and its comments) untouched. */
	readonly jsonPath?: ReadonlyArray<string | number>;
	/** Whether this item can be deleted from its scope (default: derived from `backing`). */
	readonly canDelete?: boolean;
	/** Whether this item can be copied/moved to the other scope (default: derived from `backing`). */
	readonly canMove?: boolean;
	/** Nested items (markdown headings, hook commands, permission rules, ...). */
	readonly children?: ReadonlyArray<IConfigItem>;
	/** Context-budget metadata for memory / rule / skill items (used by the Context Budget Inspector); absent
	 *  for sections that never enter Claude's context (settings, mcp, plugins, hooks, permissions). */
	readonly budget?: IConfigBudgetMeta;
}

/** All items in one section of one scope. */
export interface IConfigSectionGroup {
	readonly section: ConfigSection;
	readonly items: ReadonlyArray<IConfigItem>;
}

/** One scope (Global or a Project folder) and its sections. */
export interface IConfigScopeGroup {
	readonly scope: ConfigScope;
	/** Stable identity for this scope instance ('global', or the workspace folder URI for a project). Unique
	 *  across multi-root workspaces so tree identity / expansion state never collides between project folders. */
	readonly key: string;
	/** The `.claude` directory backing this scope. */
	readonly root: URI;
	/** For a project scope, the workspace folder name; for global, undefined. */
	readonly folderName?: string;
	/** Whether the backing `.claude` directory exists yet. */
	readonly exists: boolean;
	readonly sections: ReadonlyArray<IConfigSectionGroup>;
}

/** A full snapshot of the user's Claude Code configuration across scopes. */
export interface IClawdiusConfigSnapshot {
	readonly scopes: ReadonlyArray<IConfigScopeGroup>;
}

/** Shared, container-wide config service: one scan + watcher set produces the snapshot the Control Center reads. */
export const IClawdiusConfigService = createDecorator<IClawdiusConfigService>('clawdiusConfigService');

export interface IClawdiusConfigService {
	readonly _serviceBrand: undefined;
	/** Fires whenever the on-disk configuration changes (a watched file is added / removed / edited). */
	readonly onDidChange: Event<void>;
	/** The most recent snapshot. Empty until the first `refresh()` resolves. */
	readonly snapshot: IClawdiusConfigSnapshot;
	/** False until the first scan completes, so surfaces can show a "scanning..." state instead of rendering
	 *  the empty initial snapshot as a definitive "nothing found" / zero. */
	readonly hasResolved: boolean;
	/** Re-scan both scopes from disk. Pass `force` after a write to guarantee a scan that starts after it. */
	refresh(force?: boolean): Promise<void>;
}

/** Codicon id used for a section row. */
export function sectionIconId(section: ConfigSection): string {
	switch (section) {
		case ConfigSection.Memories: return 'book';
		case ConfigSection.Agents: return 'organization';
		case ConfigSection.Skills: return 'lightbulb';
		case ConfigSection.Commands: return 'terminal';
		case ConfigSection.Plugins: return 'plug';
		case ConfigSection.Mcp: return 'server';
		case ConfigSection.Hooks: return 'symbol-event';
		case ConfigSection.Permissions: return 'shield';
	}
}
// CLAWDIUS-END
