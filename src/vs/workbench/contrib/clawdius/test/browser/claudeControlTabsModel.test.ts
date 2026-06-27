/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN control center tab models unit tests
// Covers the pure parse + write logic for the Skills / Plugins / Hooks tabs. The write builders all encode the
// same delete-on-default contract: writing the default (on / off / false) yields value:undefined, which DELETES
// the settings.json key so the file stays minimal; any other value writes the concrete value.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PluginState, SKILL_OVERRIDES, SkillOverride, disableAllHooksWrite, disableBundledSkillsWrite, isSkillOverride,
	parseDisableAllHooks, parsePlugins, parseSkills, pluginEnabledWrite, pluginState, skillOverrideWrite,
} from '../../browser/control/claudeControlTabsModel.js';

suite('claudeControlTabsModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// --- Skills ---------------------------------------------------------------------------------------------

	test('parseSkills keeps documented overrides, drops junk, and reads disableBundledSkills only when === true', () => {
		assert.deepStrictEqual(
			[
				parseSkills({ skillOverrides: { a: 'on', b: 'name-only', c: 'user-invocable-only', d: 'off', e: 'bogus', f: 42, g: null }, disableBundledSkills: true }),
				parseSkills({ skillOverrides: ['on'], disableBundledSkills: 'true' }), // array / truthy-non-true tolerated
				parseSkills({}),
			],
			[
				{ overrides: { a: 'on', b: 'name-only', c: 'user-invocable-only', d: 'off' }, disableBundled: true },
				{ overrides: {}, disableBundled: false },
				{ overrides: {}, disableBundled: false },
			],
		);
	});

	test('isSkillOverride accepts the four documented values (case-sensitive), rejects junk', () => {
		assert.deepStrictEqual(
			['on', 'name-only', 'user-invocable-only', 'off', 'OFF', '', 'bogus', 42, null, undefined].map(isSkillOverride),
			[true, true, true, true, false, false, false, false, false, false],
		);
	});

	test('SKILL_OVERRIDES is the documented set in display order', () => {
		assert.deepStrictEqual([...SKILL_OVERRIDES], ['on', 'name-only', 'user-invocable-only', 'off']);
	});

	test('skillOverrideWrite deletes the key for the default (on), writes the concrete override otherwise', () => {
		assert.deepStrictEqual(
			SKILL_OVERRIDES.map(o => skillOverrideWrite('my-skill', o)),
			[
				{ path: ['skillOverrides', 'my-skill'], value: undefined },
				{ path: ['skillOverrides', 'my-skill'], value: 'name-only' },
				{ path: ['skillOverrides', 'my-skill'], value: 'user-invocable-only' },
				{ path: ['skillOverrides', 'my-skill'], value: 'off' },
			],
		);
	});

	test('disableBundledSkillsWrite deletes on false (default), writes true otherwise', () => {
		assert.deepStrictEqual(
			[disableBundledSkillsWrite(false), disableBundledSkillsWrite(true)],
			[{ path: ['disableBundledSkills'], value: undefined }, { path: ['disableBundledSkills'], value: true }],
		);
	});

	// --- Plugins --------------------------------------------------------------------------------------------

	test('parsePlugins: true OR an array -> on, false -> off, null/junk -> no entry, non-object tolerated', () => {
		assert.deepStrictEqual(
			[
				parsePlugins({ enabledPlugins: { a: true, b: ['>=1.0.0'], c: [], d: false, e: null, f: 'on', g: 0 } }),
				parsePlugins({ enabledPlugins: [1, 2] }),
				parsePlugins({}),
			],
			[
				{ states: { a: 'on', b: 'on', c: 'on', d: 'off' } },
				{ states: {} },
				{ states: {} },
			],
		);
	});

	test('pluginState resolves a present key and defaults a missing key to unset', () => {
		const state = parsePlugins({ enabledPlugins: { 'fmt@mp': true, 'lint@mp': false } });
		assert.deepStrictEqual(
			[pluginState(state, 'fmt@mp'), pluginState(state, 'lint@mp'), pluginState(state, 'missing@mp')],
			['on', 'off', 'unset'],
		);
	});

	test('pluginEnabledWrite deletes the key on unset (default), writes the boolean for on/off', () => {
		const cases: PluginState[] = ['on', 'off', 'unset'];
		assert.deepStrictEqual(
			cases.map(next => pluginEnabledWrite('fmt@mp', next)),
			[
				{ path: ['enabledPlugins', 'fmt@mp'], value: true },
				{ path: ['enabledPlugins', 'fmt@mp'], value: false },
				{ path: ['enabledPlugins', 'fmt@mp'], value: undefined },
			],
		);
	});

	// --- Hooks ----------------------------------------------------------------------------------------------

	test('parseDisableAllHooks is true only when the key is strictly true', () => {
		assert.deepStrictEqual(
			[parseDisableAllHooks({ disableAllHooks: true }), parseDisableAllHooks({ disableAllHooks: 'true' }), parseDisableAllHooks({})],
			[true, false, false],
		);
	});

	test('disableAllHooksWrite deletes on false (default), writes true otherwise', () => {
		assert.deepStrictEqual(
			[disableAllHooksWrite(false), disableAllHooksWrite(true)],
			[{ path: ['disableAllHooks'], value: undefined }, { path: ['disableAllHooks'], value: true }],
		);
	});

	// Keep SkillOverride referenced so the type import is exercised (the write builders are typed by it).
	test('SkillOverride covers exactly the documented strings', () => {
		const all: SkillOverride[] = ['on', 'name-only', 'user-invocable-only', 'off'];
		assert.deepStrictEqual(all, [...SKILL_OVERRIDES]);
	});
});
// CLAWDIUS-END
