/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN write-preflight unit tests
// Covers whether a pending write reaches the effective config: a plain write takes effect, a higher-precedence
// (managed) tier overrides a scalar write, an array write contributes to the union, a managed lock drops a
// non-managed array write, an opaque managed policy makes the outcome provisional, and a write to an absent tier.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITierInput, JsonObject, SettingsTier } from '../../common/clawdiusEffectiveConfig.js';
import { previewWrite } from '../../common/clawdiusPreflight.js';

function tier(t: SettingsTier, body: JsonObject | undefined, opaque?: boolean): ITierInput {
	return { tier: t, body, opaque };
}

suite('Clawdius write preflight', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a write with no higher-precedence tier takes effect', () => {
		const p = previewWrite([tier(SettingsTier.User, { model: 'sonnet' })], SettingsTier.User, 'model', 'opus');
		assert.strictEqual(p.effectiveBefore, 'sonnet');
		assert.strictEqual(p.effectiveAfter, 'opus');
		assert.strictEqual(p.takesEffect, true);
		assert.strictEqual(p.overriddenBy, undefined);
	});

	test('a scalar write overridden by a higher managed tier does NOT take effect', () => {
		const tiers = [tier(SettingsTier.ManagedFile, { model: 'managed' }), tier(SettingsTier.Project, { model: 'old' })];
		const p = previewWrite(tiers, SettingsTier.Project, 'model', 'new');
		assert.strictEqual(p.takesEffect, false);
		assert.strictEqual(p.overriddenBy, SettingsTier.ManagedFile);
		assert.strictEqual(p.effectiveAfter, 'managed'); // the effective value stays the managed one
	});

	test('a write to an absent tier creates it and can outrank a lower tier', () => {
		const p = previewWrite([tier(SettingsTier.User, { model: 'user' })], SettingsTier.Project, 'model', 'proj');
		assert.strictEqual(p.takesEffect, true); // project outranks user
		assert.strictEqual(p.effectiveAfter, 'proj');
	});

	test('an array write contributes to the deny-first union', () => {
		const p = previewWrite([tier(SettingsTier.User, { permissions: { deny: ['a'] } })], SettingsTier.User, 'permissions.deny', ['a', 'b']);
		assert.strictEqual(p.takesEffect, true);
		assert.deepStrictEqual(p.effectiveAfter, ['a', 'b']);
	});

	test('an array write dropped by a managed lock does not take effect', () => {
		const tiers = [
			tier(SettingsTier.ManagedFile, { allowManagedPermissionRulesOnly: true, permissions: { allow: ['m'] } }),
			tier(SettingsTier.User, { permissions: { allow: [] } }),
		];
		const p = previewWrite(tiers, SettingsTier.User, 'permissions.allow', ['u']);
		assert.strictEqual(p.takesEffect, false);
		assert.strictEqual(p.overriddenBy, SettingsTier.ManagedFile);
		assert.deepStrictEqual(p.effectiveAfter, ['m']); // only the managed allowlist survives the lock
	});

	test('a write under an opaque managed policy is provisional', () => {
		const tiers = [tier(SettingsTier.PolicyHelper, undefined, /*opaque*/ true), tier(SettingsTier.User, { model: 'x' })];
		const p = previewWrite(tiers, SettingsTier.User, 'model', 'y');
		assert.strictEqual(p.provisional, true);
	});

	// --- regressions from the adversarial preflight review ---

	test('an array CLEAR does not take effect when a higher tier keeps the entry', () => {
		const tiers = [tier(SettingsTier.Project, { permissions: { deny: ['a'] } }), tier(SettingsTier.User, { permissions: { deny: ['a'] } })];
		const p = previewWrite(tiers, SettingsTier.User, 'permissions.deny', []);
		assert.strictEqual(p.takesEffect, false); // clearing the user deny does not remove the still-denied entry
		assert.deepStrictEqual(p.effectiveAfter, ['a']);
	});

	test('a wrong-typed array write (scalar into an array key) does not take effect', () => {
		const p = previewWrite([tier(SettingsTier.Project, { permissions: { deny: ['a'] } })], SettingsTier.User, 'permissions.deny', 'x');
		assert.strictEqual(p.takesEffect, false); // 'x' contributes no surviving entry to the union
	});

	test('a redundant array write (entry already present at a higher tier) does not "change" the effective config', () => {
		const tiers = [tier(SettingsTier.Project, { permissions: { deny: ['b'] } })];
		const p = previewWrite(tiers, SettingsTier.User, 'permissions.deny', ['b']);
		assert.strictEqual(p.takesEffect, false); // 'b' was already denied by project; the user entry is deduped
	});

	test('an object-valued write takes effect via its descendant leaves', () => {
		const p = previewWrite([tier(SettingsTier.User, {})], SettingsTier.User, 'env', { FOO: 'bar' });
		assert.strictEqual(p.takesEffect, true); // env.FOO resolves to the user's value
	});

	test('a lock that drops the whole node still attributes the managed blocker', () => {
		const tiers = [tier(SettingsTier.ManagedFile, { allowManagedPermissionRulesOnly: true }), tier(SettingsTier.User, { permissions: { allow: [] } })];
		const p = previewWrite(tiers, SettingsTier.User, 'permissions.allow', ['u']);
		assert.strictEqual(p.takesEffect, false);
		assert.strictEqual(p.overriddenBy, SettingsTier.ManagedFile); // the lock source, even with no managed entry
	});

	test('a nested write shadowed by a higher-tier scalar reports the overriding tier', () => {
		const tiers = [tier(SettingsTier.ManagedFile, { foo: 'scalar' }), tier(SettingsTier.User, {})];
		const p = previewWrite(tiers, SettingsTier.User, 'foo.bar', 'x');
		assert.strictEqual(p.takesEffect, false);
		assert.strictEqual(p.overriddenBy, SettingsTier.ManagedFile); // managed foo scalar shadows the nested write
	});
});
// CLAWDIUS-END
