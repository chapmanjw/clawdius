/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Config model
// Types for the "Claude Code Config" tree: the user's Claude Code configuration across two scopes (Global
// ~/.claude and the workspace's Project .claude) and the sections within each (memories, agents, skills,
// slash commands, plugins, MCP servers, hooks, permissions). Everything is read from local files only.

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Where a configuration item lives. */
export const enum ConfigScope {
	Global = 'global',
	Project = 'project',
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

/** The view id for a section's collapsible pane in the Clawdius container. */
export function sectionViewId(section: ConfigSection): string {
	return `workbench.view.clawdius.config.${section}`;
}

/** The section a `sectionViewId()` refers to, or undefined if the id is not a section view. */
export function sectionFromViewId(viewId: string): ConfigSection | undefined {
	const suffix = viewId.startsWith('workbench.view.clawdius.config.') ? viewId.slice('workbench.view.clawdius.config.'.length) : undefined;
	return CONFIG_SECTIONS.find(s => s === suffix);
}

/** A one-line description shown as the section's welcome text (Kiro-style). */
export function sectionDescription(section: ConfigSection): string {
	switch (section) {
		case ConfigSection.Memories: return 'Persistent instructions Claude Code loads every session (CLAUDE.md).';
		case ConfigSection.Commands: return 'Reusable slash commands you can run in Claude Code.';
		case ConfigSection.Skills: return 'Reusable agent skills, each a folder with a SKILL.md.';
		case ConfigSection.Agents: return 'Task-specific sub-agents with their own prompt and tools.';
		case ConfigSection.Hooks: return 'Shell commands Claude Code runs on events (PreToolUse, SessionStart, ...).';
		case ConfigSection.Permissions: return 'Allow / ask / deny rules controlling what Claude Code may do.';
		case ConfigSection.Mcp: return 'Model Context Protocol servers that give Claude Code extra tools.';
		case ConfigSection.Plugins: return 'Installed Claude Code plugins and their enabled state.';
	}
}

/** Label for the section's primary "create" action / welcome button. */
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

/** Human label for a section. */
export function sectionLabel(section: ConfigSection): string {
	switch (section) {
		case ConfigSection.Memories: return 'Memories';
		case ConfigSection.Agents: return 'Sub-Agents';
		case ConfigSection.Skills: return 'Skills';
		case ConfigSection.Commands: return 'Slash Commands';
		case ConfigSection.Plugins: return 'Plugins';
		case ConfigSection.Mcp: return 'MCP Servers';
		case ConfigSection.Hooks: return 'Hooks';
		case ConfigSection.Permissions: return 'Permissions';
	}
}

/** Shared, container-wide config service: one scan + watcher set feeds all eight section views. */
export const IClawdiusConfigService = createDecorator<IClawdiusConfigService>('clawdiusConfigService');

export interface IClawdiusConfigService {
	readonly _serviceBrand: undefined;
	/** Fires whenever the on-disk configuration changes (a watched file is added / removed / edited). */
	readonly onDidChange: Event<void>;
	/** The most recent snapshot. Empty until the first `refresh()` resolves. */
	readonly snapshot: IClawdiusConfigSnapshot;
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
