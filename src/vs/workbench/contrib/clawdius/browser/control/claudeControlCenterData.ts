/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN control center data layer (race-safe intent planning + scope resolution)
// UI-free glue between the pure permissions model and the editor pane. The pane never holds a write computed
// at render time (that would clobber a concurrent external edit); instead it captures the user's INTENT, then
// at apply time re-reads the on-disk settings, reclassifies it, reparses the permissions, and calls
// planPermissionIntent against that LATEST state. A move/remove whose source rule has vanished aborts (the
// caller reloads + warns) rather than writing a stale whole-array. All of this is pure + unit-testable; the
// pane only does file IO, IJSONEditingService.write, and DOM.

import { parse as parseJsonc } from '../../../../../base/common/jsonc.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	IJsonWrite, IPermissionsState, PermissionBucket, PermissionDefaultMode,
	addRule, bucketWrites, defaultModeWrite, moveRule, removeRule,
} from './claudePermissionsModel.js';

/** Which settings.json the pane reads + writes. */
export type ControlScope = 'global' | 'project' | 'projectLocal';
export const CONTROL_SCOPES: readonly ControlScope[] = ['global', 'project', 'projectLocal'];

/**
 * The settings.json for a scope: Global ~/.claude/settings.json, Project <folder>/.claude/settings.json,
 * Project-local <folder>/.claude/settings.local.json. Project scopes need an open workspace folder (else
 * undefined -> the pane shows those scope tabs as unavailable).
 */
export function resolvePermissionsSettingsUri(scope: ControlScope, home: URI, workspaceFolder: URI | undefined): URI | undefined {
	switch (scope) {
		case 'global': return URI.joinPath(home, '.claude', 'settings.json');
		case 'project': return workspaceFolder ? URI.joinPath(workspaceFolder, '.claude', 'settings.json') : undefined;
		case 'projectLocal': return workspaceFolder ? URI.joinPath(workspaceFolder, '.claude', 'settings.local.json') : undefined;
	}
}

/**
 * Classify raw settings.json content. `ok` with `needsSeed` (missing or blank -> create `{}` before the first
 * JSON edit) carries the parsed object; `malformed` (exists but unparseable) means writes are refused so a
 * hand-edited file is never clobbered. Mirrors the effort writer's proven gate.
 */
export type SettingsRead =
	| { readonly kind: 'ok'; readonly settings: Record<string, unknown>; readonly needsSeed: boolean }
	| { readonly kind: 'malformed' };

export function classifySettings(raw: string | undefined): SettingsRead {
	if (raw === undefined || raw.trim().length === 0) {
		return { kind: 'ok', settings: {}, needsSeed: true };
	}
	try {
		// JSONC: ~/.claude/settings.json may carry comments / trailing commas (jsonc.parse strips both and
		// throws only on genuinely malformed JSON, which we then refuse rather than clobber).
		const parsed = parseJsonc<unknown>(raw);
		const settings = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};
		return { kind: 'ok', settings, needsSeed: false };
	} catch {
		return { kind: 'malformed' };
	}
}

/** A captured user action, resolved against the LATEST on-disk state at apply time (never at render time). */
export type PermissionIntent =
	| { readonly type: 'setDefaultMode'; readonly mode: PermissionDefaultMode | undefined }
	| { readonly type: 'addRule'; readonly bucket: PermissionBucket; readonly rule: string }
	| { readonly type: 'removeRule'; readonly bucket: PermissionBucket; readonly rule: string }
	| { readonly type: 'moveRule'; readonly from: PermissionBucket; readonly to: PermissionBucket; readonly rule: string };

/**
 * The outcome of resolving an intent against the latest state: the JSON writes to apply, or an abort reason.
 * `stale` = the rule the user clicked is gone (reload + warn); `invalid` = blank/illegal input; `noop` = the
 * action would not change anything.
 */
export type IntentPlan =
	| { readonly ok: true; readonly writes: IJsonWrite[] }
	| { readonly ok: false; readonly abort: 'stale' | 'invalid' | 'noop' };

/** Resolve a captured intent against the latest parsed permissions. Pure; the caller applies the writes. */
export function planPermissionIntent(latest: IPermissionsState, intent: PermissionIntent): IntentPlan {
	switch (intent.type) {
		case 'setDefaultMode': {
			return latest.defaultMode === intent.mode ? { ok: false, abort: 'noop' } : { ok: true, writes: [defaultModeWrite(intent.mode)] };
		}
		case 'addRule': {
			const next = addRule(latest, intent.bucket, intent.rule);
			if (!next) { return { ok: false, abort: 'invalid' }; }
			const writes = bucketWrites(latest, next);
			return writes.length > 0 ? { ok: true, writes } : { ok: false, abort: 'noop' };
		}
		case 'removeRule': {
			if (!latest[intent.bucket].includes(intent.rule)) { return { ok: false, abort: 'stale' }; }
			const writes = bucketWrites(latest, removeRule(latest, intent.bucket, intent.rule));
			return writes.length > 0 ? { ok: true, writes } : { ok: false, abort: 'noop' };
		}
		case 'moveRule': {
			if (intent.from === intent.to) { return { ok: false, abort: 'noop' }; }
			if (!latest[intent.from].includes(intent.rule)) { return { ok: false, abort: 'stale' }; }
			const writes = bucketWrites(latest, moveRule(latest, intent.from, intent.to, intent.rule));
			return writes.length > 0 ? { ok: true, writes } : { ok: false, abort: 'noop' };
		}
	}
}

/** The inverse of an applied intent, for Undo - resolved against the latest state at undo time (same gate). */
export function invertIntent(applied: PermissionIntent, before: IPermissionsState): PermissionIntent | undefined {
	switch (applied.type) {
		case 'setDefaultMode':
			return { type: 'setDefaultMode', mode: before.defaultMode };
		case 'addRule':
			// Undo an add by removing the rule from where it landed.
			return { type: 'removeRule', bucket: applied.bucket, rule: applied.rule };
		case 'removeRule':
			// Undo a remove by re-adding to the original bucket.
			return { type: 'addRule', bucket: applied.bucket, rule: applied.rule };
		case 'moveRule':
			return { type: 'moveRule', from: applied.to, to: applied.from, rule: applied.rule };
	}
}
// CLAWDIUS-END
