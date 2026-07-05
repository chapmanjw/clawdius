/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN settings-merge helper unit tests
// Covers the within-source deep merge used to fold managed drop-ins (scalars higher-wins, arrays concat+dedupe,
// objects recurse), the ordered chain fold, the policyHelper detector, and the tolerant policy-JSON parser.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	detectPolicyHelper,
	mergeSettingsBodies,
	mergeSettingsChain,
	parsePolicySettings,
} from '../../common/clawdiusSettingsMerge.js';

suite('Clawdius settings-merge helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('mergeSettingsBodies: scalars higher-wins, arrays concat+dedupe, objects recurse', () => {
		const merged = mergeSettingsBodies(
			{ model: 'sonnet', env: { A: '1', B: '1' }, permissions: { deny: ['x', 'y'] }, only: 'lower' },
			{ model: 'opus', env: { B: '2', C: '2' }, permissions: { deny: ['y', 'z'] } },
		);
		assert.deepStrictEqual(merged, {
			model: 'opus',                       // scalar: higher wins
			env: { A: '1', B: '2', C: '2' },     // object: deep-merged, higher wins per-key
			permissions: { deny: ['x', 'y', 'z'] }, // array: concat + de-duped, lower first
			only: 'lower',                        // key only in lower survives
		});
	});

	test('mergeSettingsChain folds base then drop-ins in order (later overrides earlier)', () => {
		const merged = mergeSettingsChain([
			{ model: 'a', tags: ['base'] },
			{ model: 'b', tags: ['d1'] },
			{ model: 'c', tags: ['d2'] },
		]);
		assert.deepStrictEqual(merged, { model: 'c', tags: ['base', 'd1', 'd2'] });
		assert.deepStrictEqual(mergeSettingsChain([]), {});
	});

	test('detectPolicyHelper: true only when an admin body declares a non-empty policyHelper.path', () => {
		assert.strictEqual(detectPolicyHelper([{ policyHelper: { path: '/usr/local/bin/claude-policy' } }]), true);
		assert.strictEqual(detectPolicyHelper([undefined, { model: 'x' }, { policyHelper: { path: 'c:\\p.exe' } }]), true);
		assert.strictEqual(detectPolicyHelper([{ policyHelper: { path: '' } }]), false); // empty path
		assert.strictEqual(detectPolicyHelper([{ policyHelper: 'not-an-object' }]), false);
		assert.strictEqual(detectPolicyHelper([undefined, { model: 'x' }]), false);
	});

	test('parsePolicySettings: object JSON only; empty/invalid/non-object -> undefined', () => {
		assert.deepStrictEqual(parsePolicySettings('{"model":"opus"}'), { model: 'opus' });
		assert.strictEqual(parsePolicySettings(undefined), undefined);
		assert.strictEqual(parsePolicySettings('   '), undefined);
		assert.strictEqual(parsePolicySettings('not json'), undefined);
		assert.strictEqual(parsePolicySettings('[1,2,3]'), undefined); // array is not a settings object
		assert.strictEqual(parsePolicySettings('42'), undefined);
	});
});
// CLAWDIUS-END
