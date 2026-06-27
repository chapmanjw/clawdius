/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN permission-mode status pill (N3-3a) unit tests
// Covers the user-visible behaviors of the default-permission-mode pill without booting a workbench:
// the chat-matching titles/descriptions, the tone->color mapping, the effective-mode honesty clamp (a
// configured-but-gated-off Bypass must display as the Default mode), and the one-way bypass-enable on select.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ALLOW_BYPASS_KEY,
	INITIAL_PERMISSION_MODE_KEY,
	parsePermissionMode,
	permissionModeDisplay,
	permissionModePicks,
	permissionModeWrites,
	shouldRestartAfterPermissionChange,
} from '../../browser/clawdiusPermissionModeStatusEntry.js';

suite('Clawdius permission-mode pill', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('config keys match the official anthropic.claude-code settings contract', () => {
		assert.strictEqual(INITIAL_PERMISSION_MODE_KEY, 'claudeCode.initialPermissionMode');
		assert.strictEqual(ALLOW_BYPASS_KEY, 'claudeCode.allowDangerouslySkipPermissions');
	});

	test('parsePermissionMode clamps unset / unknown values to default', () => {
		assert.strictEqual(parsePermissionMode(undefined), 'default');
		assert.strictEqual(parsePermissionMode(''), 'default');
		assert.strictEqual(parsePermissionMode('nonsense'), 'default');
		assert.strictEqual(parsePermissionMode('auto'), 'default'); // Auto is not in the public enum
		assert.strictEqual(parsePermissionMode('plan'), 'plan');
		assert.strictEqual(parsePermissionMode('acceptEdits'), 'acceptEdits');
		assert.strictEqual(parsePermissionMode('bypassPermissions'), 'bypassPermissions');
	});

	test('titles mirror the plugin chat selector', () => {
		assert.strictEqual(permissionModeDisplay('plan', false).label, 'Plan mode');
		assert.strictEqual(permissionModeDisplay('default', false).label, 'Ask before edits');
		assert.strictEqual(permissionModeDisplay('acceptEdits', false).label, 'Edit automatically');
		assert.strictEqual(permissionModeDisplay('bypassPermissions', true).label, 'Bypass permissions');
	});

	test('descriptions mirror the plugin chat selector', () => {
		const byMode = new Map(permissionModePicks('default').map(p => [p.mode, p.detail]));
		assert.strictEqual(byMode.get('plan'), 'Claude will explore the code and present a plan before editing');
		assert.strictEqual(byMode.get('default'), 'Claude will ask for approval before making each edit');
		assert.strictEqual(byMode.get('acceptEdits'), 'Claude will edit your selected text or the whole file');
		assert.strictEqual(byMode.get('bypassPermissions'), 'Claude will not ask for approval before running potentially dangerous commands');
	});

	test('status text carries the per-mode codicon + label', () => {
		assert.strictEqual(permissionModeDisplay('plan', false).text, '$(eye) Plan mode');
		assert.strictEqual(permissionModeDisplay('default', false).text, '$(shield) Ask before edits');
		assert.strictEqual(permissionModeDisplay('acceptEdits', false).text, '$(edit) Edit automatically');
		assert.strictEqual(permissionModeDisplay('bypassPermissions', true).text, '$(zap) Bypass permissions');
	});

	test('tone: Plan=safe (green), Default=none (plain), Accept=warn, Bypass=danger', () => {
		assert.strictEqual(permissionModeDisplay('plan', false).tone, 'safe');
		assert.strictEqual(permissionModeDisplay('default', false).tone, 'none');
		assert.strictEqual(permissionModeDisplay('acceptEdits', false).tone, 'warn');
		assert.strictEqual(permissionModeDisplay('bypassPermissions', true).tone, 'danger');
	});

	test('Bypass configured + gate OFF clamps to the Default mode (honesty fix) and explains in the tooltip', () => {
		const d = permissionModeDisplay('bypassPermissions', false);
		assert.strictEqual(d.mode, 'default');
		assert.strictEqual(d.label, 'Ask before edits');
		assert.strictEqual(d.tone, 'none');
		assert.strictEqual(d.bypassGatedOff, true);
		assert.ok(/fall back to/i.test(d.tooltip), 'gated tooltip should explain the fallback');
	});

	test('non-bypass modes are never marked gated off, regardless of the bypass gate', () => {
		for (const allow of [true, false]) {
			assert.strictEqual(permissionModeDisplay('plan', allow).bypassGatedOff, false);
			assert.strictEqual(permissionModeDisplay('default', allow).bypassGatedOff, false);
			assert.strictEqual(permissionModeDisplay('acceptEdits', allow).bypassGatedOff, false);
		}
	});

	test('picker always offers all four modes (Bypass is never hidden - selecting it enables the gate)', () => {
		const modes = permissionModePicks('default').map(p => p.mode);
		assert.deepStrictEqual(modes, ['plan', 'default', 'acceptEdits', 'bypassPermissions']);
	});

	test('exactly one pick is marked Current and it matches the current mode', () => {
		const picks = permissionModePicks('acceptEdits');
		const current = picks.filter(p => p.description === 'Current');
		assert.strictEqual(current.length, 1);
		assert.strictEqual(current[0].mode, 'acceptEdits');
	});

	test('every pick carries an icon class', () => {
		for (const pick of permissionModePicks('default')) {
			assert.ok(pick.iconClass && /codicon-/.test(pick.iconClass), `pick ${pick.mode} should have a codicon class`);
		}
	});

	test('selecting a non-bypass mode writes only initialPermissionMode (never touches the bypass gate)', () => {
		for (const mode of ['plan', 'default', 'acceptEdits'] as const) {
			const writes = permissionModeWrites(mode);
			assert.deepStrictEqual(writes, [{ key: INITIAL_PERMISSION_MODE_KEY, value: mode }]);
			assert.ok(!writes.some(w => w.key === ALLOW_BYPASS_KEY), 'must not write the bypass gate');
		}
	});

	test('selecting Bypass writes the mode AND enables the gate (true), never false', () => {
		const writes = permissionModeWrites('bypassPermissions');
		assert.deepStrictEqual(writes, [
			{ key: INITIAL_PERMISSION_MODE_KEY, value: 'bypassPermissions' },
			{ key: ALLOW_BYPASS_KEY, value: true },
		]);
		assert.ok(!writes.some(w => w.value === false), 'must never set the bypass gate to false');
	});

	test('shouldRestartAfterPermissionChange: restart only when the effective config changed', () => {
		assert.deepStrictEqual([
			shouldRestartAfterPermissionChange('plan', false, 'plan'),                          // same non-bypass reselected
			shouldRestartAfterPermissionChange('plan', false, 'default'),                       // any mode change
			shouldRestartAfterPermissionChange('bypassPermissions', true, 'bypassPermissions'),  // reselect Bypass, gate already on
			shouldRestartAfterPermissionChange('bypassPermissions', false, 'bypassPermissions'), // reselect Bypass, gate off (mode unchanged)
		], [false, true, false, true]);
	});
});
// CLAWDIUS-END
