/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN control center tab models (Skills, Plugins, ...)
// Pure, UI-free parse + write logic for the non-permission Control Center tabs. Each tab reads a few keys out
// of a Claude Code settings.json object and produces IJSONEditingService write intents (an absolute key set,
// not a relative mutation - so a simple re-read-then-write at apply time is race-safe). No file or service
// access here; the editor pane does the IO. Keys + value shapes are verified against
// claude-code-settings.schema.json (the official plugin's schema).

import { IJsonWrite } from './claudePermissionsModel.js';

// --- Skills ----------------------------------------------------------------------------------------------

/**
 * A per-skill listing override (`skillOverrides[name]`). Absent = `on`. `name-only` lists the skill without
 * its description (saves context); `user-invocable-only` hides it from the model but keeps `/name`; `off`
 * hides it from both. We treat `on` as "no override" and DELETE the key for it, to keep settings.json minimal.
 */
export type SkillOverride = 'on' | 'name-only' | 'user-invocable-only' | 'off';
export const SKILL_OVERRIDES: readonly SkillOverride[] = ['on', 'name-only', 'user-invocable-only', 'off'];

/** True when `value` is one of the documented skillOverrides strings. */
export function isSkillOverride(value: unknown): value is SkillOverride {
	return typeof value === 'string' && (SKILL_OVERRIDES as readonly string[]).includes(value);
}

/** The parsed skill-related settings: the per-name overrides and the bundled-skills kill switch. */
export interface ISkillsState {
	readonly overrides: Readonly<Record<string, SkillOverride>>;
	readonly disableBundled: boolean;
}

/** Parse `skillOverrides` + `disableBundledSkills` out of a settings.json object (tolerant of junk values). */
export function parseSkills(settings: Record<string, unknown>): ISkillsState {
	const overrides: Record<string, SkillOverride> = {};
	const raw = settings['skillOverrides'];
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
			if (isSkillOverride(value)) { overrides[name] = value; }
		}
	}
	return { overrides, disableBundled: settings['disableBundledSkills'] === true };
}

/** The write to set a skill's override. `on` deletes the key (absent = on), keeping settings.json minimal. */
export function skillOverrideWrite(name: string, override: SkillOverride): IJsonWrite {
	return { path: ['skillOverrides', name], value: override === 'on' ? undefined : override };
}

/** The write to set the bundled-skills kill switch. `false` deletes the key (absent = enabled). */
export function disableBundledSkillsWrite(value: boolean): IJsonWrite {
	return { path: ['disableBundledSkills'], value: value ? true : undefined };
}

// --- Plugins ---------------------------------------------------------------------------------------------

/**
 * The parsed `enabledPlugins` map, keyed by `plugin-id@marketplace-id`. The schema value is boolean, an array
 * of version constraints, or absent; we collapse to a tri-state per key: explicitly on, explicitly off, or
 * unset (no key). An array (version pin) reads as `on` for display - we preserve the raw value on undo only
 * for booleans; pinning versions is out of v1 scope.
 */
export type PluginState = 'on' | 'off' | 'unset';

/** The parsed plugin enablement: the resolved state for each `id@marketplace` key present in settings. */
export interface IPluginsState {
	readonly states: Readonly<Record<string, PluginState>>;
}

/** Parse `enabledPlugins` out of a settings.json object into a per-key tri-state. */
export function parsePlugins(settings: Record<string, unknown>): IPluginsState {
	const states: Record<string, PluginState> = {};
	const raw = settings['enabledPlugins'];
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
			if (value === true || Array.isArray(value)) { states[id] = 'on'; }
			else if (value === false) { states[id] = 'off'; }
			// absent / null / junk -> leave unset (no entry)
		}
	}
	return { states };
}

/** Resolve a plugin id's state from the parsed map (missing key = `unset`). */
export function pluginState(state: IPluginsState, id: string): PluginState {
	return state.states[id] ?? 'unset';
}

/** The write to set a plugin's enabled flag. `unset` deletes the key; on/off write the boolean. */
export function pluginEnabledWrite(id: string, next: PluginState): IJsonWrite {
	return { path: ['enabledPlugins', id], value: next === 'unset' ? undefined : next === 'on' };
}

// --- Hooks ---------------------------------------------------------------------------------------------------

/** Whether the `disableAllHooks` kill switch is set (also disables statusLine execution). Absent = false. */
export function parseDisableAllHooks(settings: Record<string, unknown>): boolean {
	return settings['disableAllHooks'] === true;
}

/** The write to set the all-hooks kill switch. `false` deletes the key (absent = enabled). */
export function disableAllHooksWrite(value: boolean): IJsonWrite {
	return { path: ['disableAllHooks'], value: value ? true : undefined };
}
// CLAWDIUS-END
