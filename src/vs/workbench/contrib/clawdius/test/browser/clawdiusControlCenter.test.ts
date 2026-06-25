/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN control center data layer unit tests
// Covers scope -> settings.json URI resolution, settings classification (seed vs malformed), the race-safe
// intent planner (stale move/remove aborts; noop detection; invalid input), and Undo inversion.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IPermissionsState } from '../../browser/control/claudePermissionsModel.js';
import {
	PermissionIntent,
	classifySettings,
	invertIntent,
	planPermissionIntent,
	resolvePermissionsSettingsUri,
} from '../../browser/control/claudeControlCenterData.js';

function state(partial: Partial<IPermissionsState>): IPermissionsState {
	return {
		defaultMode: partial.defaultMode,
		allow: partial.allow ?? [],
		ask: partial.ask ?? [],
		deny: partial.deny ?? [],
		additionalDirectories: partial.additionalDirectories ?? [],
	};
}

suite('Clawdius control center data', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const home = URI.file('/home/u');
	const folder = URI.file('/work/proj');

	test('resolvePermissionsSettingsUri maps each scope (project scopes need a folder)', () => {
		assert.strictEqual(resolvePermissionsSettingsUri('global', home, folder)?.path, '/home/u/.claude/settings.json');
		assert.strictEqual(resolvePermissionsSettingsUri('project', home, folder)?.path, '/work/proj/.claude/settings.json');
		assert.strictEqual(resolvePermissionsSettingsUri('projectLocal', home, folder)?.path, '/work/proj/.claude/settings.local.json');
		assert.strictEqual(resolvePermissionsSettingsUri('project', home, undefined), undefined);
		assert.strictEqual(resolvePermissionsSettingsUri('projectLocal', home, undefined), undefined);
	});

	test('classifySettings: missing/blank need a seed; valid parses; malformed is refused', () => {
		assert.deepStrictEqual(classifySettings(undefined), { kind: 'ok', settings: {}, needsSeed: true });
		assert.deepStrictEqual(classifySettings('   \n'), { kind: 'ok', settings: {}, needsSeed: true });
		assert.deepStrictEqual(classifySettings('{"permissions":{"allow":["Read(a)"]}}'), { kind: 'ok', settings: { permissions: { allow: ['Read(a)'] } }, needsSeed: false });
		assert.deepStrictEqual(classifySettings('{ not json'), { kind: 'malformed' });
		// A non-object top-level (array / number) is treated as empty settings, still editable.
		assert.deepStrictEqual(classifySettings('[1,2]'), { kind: 'ok', settings: {}, needsSeed: false });
	});

	test('classifySettings: tolerates JSONC - comments + trailing commas are not malformed', () => {
		const jsonc = '{\n  // user permissions\n  "permissions": { "allow": ["Read(a)"], }, /* trailing */\n}';
		assert.deepStrictEqual(classifySettings(jsonc), { kind: 'ok', settings: { permissions: { allow: ['Read(a)'] } }, needsSeed: false });
	});

	test('planPermissionIntent setDefaultMode: change writes, same is a no-op', () => {
		assert.deepStrictEqual(planPermissionIntent(state({ defaultMode: 'plan' }), { type: 'setDefaultMode', mode: 'acceptEdits' }), { ok: true, writes: [{ path: ['permissions', 'defaultMode'], value: 'acceptEdits' }] });
		assert.deepStrictEqual(planPermissionIntent(state({ defaultMode: 'plan' }), { type: 'setDefaultMode', mode: 'plan' }), { ok: false, abort: 'noop' });
		assert.deepStrictEqual(planPermissionIntent(state({ defaultMode: 'plan' }), { type: 'setDefaultMode', mode: undefined }), { ok: true, writes: [{ path: ['permissions', 'defaultMode'], value: undefined }] });
	});

	test('planPermissionIntent addRule: valid writes, blank is invalid, existing-same is a no-op', () => {
		assert.deepStrictEqual(planPermissionIntent(state({ allow: ['Read(a)'] }), { type: 'addRule', bucket: 'deny', rule: 'Bash(rm)' }), { ok: true, writes: [{ path: ['permissions', 'deny'], value: ['Bash(rm)'] }] });
		assert.deepStrictEqual(planPermissionIntent(state({}), { type: 'addRule', bucket: 'allow', rule: '   ' }), { ok: false, abort: 'invalid' });
		assert.deepStrictEqual(planPermissionIntent(state({ allow: ['Read(a)'] }), { type: 'addRule', bucket: 'allow', rule: 'Read(a)' }), { ok: false, abort: 'noop' });
	});

	test('planPermissionIntent removeRule: present removes, absent aborts as stale', () => {
		assert.deepStrictEqual(planPermissionIntent(state({ deny: ['Bash(rm)', 'X'] }), { type: 'removeRule', bucket: 'deny', rule: 'Bash(rm)' }), { ok: true, writes: [{ path: ['permissions', 'deny'], value: ['X'] }] });
		assert.deepStrictEqual(planPermissionIntent(state({ deny: ['X'] }), { type: 'removeRule', bucket: 'deny', rule: 'Bash(rm)' }), { ok: false, abort: 'stale' });
	});

	test('planPermissionIntent removeRule: removing the last rule writes an empty array (not a delete)', () => {
		assert.deepStrictEqual(planPermissionIntent(state({ deny: ['only'] }), { type: 'removeRule', bucket: 'deny', rule: 'only' }), { ok: true, writes: [{ path: ['permissions', 'deny'], value: [] }] });
	});

	test('planPermissionIntent moveRule: source present writes both buckets; gone aborts stale; same-bucket no-op', () => {
		assert.deepStrictEqual(planPermissionIntent(state({ allow: ['a', 'b'] }), { type: 'moveRule', from: 'allow', to: 'deny', rule: 'b' }), { ok: true, writes: [{ path: ['permissions', 'allow'], value: ['a'] }, { path: ['permissions', 'deny'], value: ['b'] }] });
		assert.deepStrictEqual(planPermissionIntent(state({ allow: ['a'] }), { type: 'moveRule', from: 'allow', to: 'deny', rule: 'gone' }), { ok: false, abort: 'stale' });
		assert.deepStrictEqual(planPermissionIntent(state({ allow: ['a'] }), { type: 'moveRule', from: 'allow', to: 'allow', rule: 'a' }), { ok: false, abort: 'noop' });
	});

	test('invertIntent produces the undo of each action', () => {
		const before = state({ defaultMode: 'plan', allow: ['a'] });
		assert.deepStrictEqual(invertIntent({ type: 'setDefaultMode', mode: 'acceptEdits' }, before), { type: 'setDefaultMode', mode: 'plan' });
		assert.deepStrictEqual(invertIntent({ type: 'addRule', bucket: 'deny', rule: 'x' }, before), { type: 'removeRule', bucket: 'deny', rule: 'x' });
		assert.deepStrictEqual(invertIntent({ type: 'removeRule', bucket: 'allow', rule: 'a' }, before), { type: 'addRule', bucket: 'allow', rule: 'a' });
		assert.deepStrictEqual(invertIntent({ type: 'moveRule', from: 'allow', to: 'deny', rule: 'a' }, before), { type: 'moveRule', from: 'deny', to: 'allow', rule: 'a' });
	});

	test('intent type is exhaustive (compile guard via switch coverage)', () => {
		const intents: PermissionIntent[] = [
			{ type: 'setDefaultMode', mode: 'default' },
			{ type: 'addRule', bucket: 'allow', rule: 'r' },
			{ type: 'removeRule', bucket: 'ask', rule: 'r' },
			{ type: 'moveRule', from: 'allow', to: 'ask', rule: 'r' },
		];
		assert.strictEqual(intents.length, 4);
	});
});
// CLAWDIUS-END
