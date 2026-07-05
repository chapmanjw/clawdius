/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN effective-config resolver unit tests
// Encodes the verified Claude Code settings-precedence model: scalar-wins-by-rank
// below the managed band, deep-merge for objects, array-union deny-first for permissions, the non-merging
// managed band (policyHelper replaces it; server-managed > mdm > managed-file is first-wins; HKCU is fallback),
// and the managed-only lock keys that drop the non-managed contributors.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IEffectiveConfig,
	IResolvedSetting,
	ITierInput,
	JsonObject,
	SettingsTier,
	resolveEffectiveConfig,
} from '../../common/clawdiusEffectiveConfig.js';

function tier(t: SettingsTier, body: JsonObject | undefined, opaque?: boolean): ITierInput {
	return { tier: t, body, opaque };
}

function at(result: IEffectiveConfig, path: string): IResolvedSetting {
	const found = result.settings.find(s => s.path === path);
	assert.ok(found, `expected a resolved setting at "${path}"`);
	return found;
}

suite('Clawdius effective-config resolver', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('scalar precedence: local > project > user', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { model: 'sonnet' }),
			tier(SettingsTier.Project, { model: 'opus' }),
			tier(SettingsTier.ProjectLocal, { model: 'haiku' }),
		]);
		const s = at(r, 'model');
		assert.strictEqual(s.effective, 'haiku');
		assert.strictEqual(s.winner, SettingsTier.ProjectLocal);
		// Contributions are highest-first, with the winner flagged.
		assert.deepStrictEqual(s.contributions.map(c => [c.tier, c.value, c.winning]), [
			[SettingsTier.ProjectLocal, 'haiku', true],
			[SettingsTier.Project, 'opus', false],
			[SettingsTier.User, 'sonnet', false],
		]);
	});

	test('objects deep-merge across tiers (per-key winner)', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { env: { FOO: 'user', BAR: 'user' } }),
			tier(SettingsTier.Project, { env: { BAR: 'project', BAZ: 'project' } }),
		]);
		assert.strictEqual(at(r, 'env.FOO').effective, 'user');
		assert.strictEqual(at(r, 'env.BAR').effective, 'project'); // project outranks user
		assert.strictEqual(at(r, 'env.BAZ').effective, 'project');
		// The parent object is not itself a leaf - only the scalar leaves are resolved.
		assert.ok(!r.settings.some(s => s.path === 'env'));
	});

	test('permission arrays are a deny-first union (concat + de-dupe, no scalar override)', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { permissions: { deny: ['Bash(rm:*)'], allow: ['Read(*)'] } }),
			tier(SettingsTier.Project, { permissions: { deny: ['Bash(rm:*)', 'Write(/etc/*)'], allow: ['Edit(*)'] } }),
		]);
		const deny = at(r, 'permissions.deny');
		assert.strictEqual(deny.kind, 'array-union');
		assert.deepStrictEqual(deny.effective, ['Bash(rm:*)', 'Write(/etc/*)']); // union, de-duped, highest-first
		const allow = at(r, 'permissions.allow');
		assert.deepStrictEqual(allow.effective, ['Edit(*)', 'Read(*)']); // project first (higher), then user
	});

	test('managed band is first-wins non-merging: server-managed body beats managed-file entirely', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { model: 'sonnet', theme: 'dark' }),
			tier(SettingsTier.ManagedFile, { model: 'file-model', extra: 'file' }),
			tier(SettingsTier.ServerManaged, { model: 'remote-model' }),
		]);
		assert.strictEqual(r.managedWinner, SettingsTier.ServerManaged);
		assert.strictEqual(at(r, 'model').effective, 'remote-model'); // managed on top of the stack
		assert.strictEqual(at(r, 'model').winner, SettingsTier.ServerManaged);
		// managed-file lost the whole body: its `extra` key must NOT appear (non-merging within the band).
		assert.ok(!r.settings.some(s => s.path === 'extra'));
		// A key only the user set still resolves (managed body deep-merges OVER the lower stack).
		assert.strictEqual(at(r, 'theme').effective, 'dark');
	});

	test('policyHelper replaces the entire managed band', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.ServerManaged, { model: 'remote' }),
			tier(SettingsTier.ManagedFile, { model: 'file' }),
			tier(SettingsTier.PolicyHelper, { model: 'policy' }),
		]);
		assert.strictEqual(r.managedWinner, SettingsTier.PolicyHelper);
		assert.strictEqual(at(r, 'model').effective, 'policy');
	});

	test('HKCU is a fallback consulted only when every higher admin source is empty', () => {
		const withHigher = resolveEffectiveConfig([
			tier(SettingsTier.ManagedFile, { model: 'file' }),
			tier(SettingsTier.HkcuRegistry, { model: 'hkcu' }),
		]);
		assert.strictEqual(withHigher.managedWinner, SettingsTier.ManagedFile);
		assert.strictEqual(at(withHigher, 'model').effective, 'file');

		const onlyHkcu = resolveEffectiveConfig([
			tier(SettingsTier.User, { model: 'user' }),
			tier(SettingsTier.HkcuRegistry, { model: 'hkcu' }),
		]);
		assert.strictEqual(onlyHkcu.managedWinner, SettingsTier.HkcuRegistry);
		assert.strictEqual(at(onlyHkcu, 'model').effective, 'hkcu');
	});

	test('an empty (or present-but-keyless) admin body counts as "delivered nothing"', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { model: 'user' }),
			tier(SettingsTier.ServerManaged, {}), // present but empty
			tier(SettingsTier.ManagedFile, { model: 'file' }),
		]);
		assert.strictEqual(r.managedWinner, SettingsTier.ManagedFile);
		assert.strictEqual(at(r, 'model').effective, 'file');
	});

	test('lock: allowManagedPermissionRulesOnly keeps only the managed allowlist, drops non-managed rules', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { permissions: { allow: ['Bash(*)'], deny: ['Read(secret)'] } }),
			tier(SettingsTier.ManagedFile, { allowManagedPermissionRulesOnly: true, permissions: { allow: ['Read(*)'] } }),
		]);
		assert.deepStrictEqual(r.activeLocks, ['allowManagedPermissionRulesOnly']);
		const allow = at(r, 'permissions.allow');
		assert.strictEqual(allow.locked, true);
		assert.deepStrictEqual(allow.effective, ['Read(*)']); // only the managed allowlist survives
		// The user's deny had no managed counterpart, so the lock drops it entirely - no phantom empty leaf.
		assert.ok(!r.settings.some(s => s.path === 'permissions.deny'), 'locked deny with no managed value must be dropped');
	});

	test('lock booleans OR across admin tiers (mdm sets the lock; managed-file supplies the body)', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { permissions: { allow: ['Bash(*)'] } }),
			tier(SettingsTier.MdmRegistry, { allowManagedPermissionRulesOnly: true }), // lock only, no body keys beyond it
			tier(SettingsTier.ManagedFile, { permissions: { allow: ['Read(*)'] } }),
		]);
		// mdm delivered a body (the lock key), so it wins the band; managed-file's permissions are non-merging losers.
		assert.deepStrictEqual(r.activeLocks, ['allowManagedPermissionRulesOnly']);
		assert.strictEqual(r.managedWinner, SettingsTier.MdmRegistry);
		// The lock is active and the winning managed body has no permissions.allow, so the user's allow is dropped.
		assert.ok(!r.settings.some(s => s.path === 'permissions.allow'), 'locked allow with no managed value must be dropped');
	});

	test('HKCU is excluded from the lock keys (user-writable)', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { permissions: { allow: ['Bash(*)'] } }),
			tier(SettingsTier.HkcuRegistry, { allowManagedPermissionRulesOnly: true }),
		]);
		assert.deepStrictEqual(r.activeLocks, []); // HKCU cannot set a cross-source lock
		assert.deepStrictEqual(at(r, 'permissions.allow').effective, ['Bash(*)']);
	});

	test('an opaque managed tier (e.g. an unexecuted policyHelper) wins the band with a hidden body', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { model: 'user' }),
			tier(SettingsTier.PolicyHelper, undefined, /*opaque*/ true),
		]);
		assert.strictEqual(r.managedWinner, SettingsTier.PolicyHelper);
		assert.deepStrictEqual(r.opaqueTiers, [SettingsTier.PolicyHelper]);
		// The body is unknown, so the user's value still shows through (nothing to override it with).
		assert.strictEqual(at(r, 'model').effective, 'user');
	});

	// --- regressions from the adversarial resolver review ---

	test('lock: allowManagedMcpServersOnly drops non-managed servers even under an object-valued path', () => {
		const r = resolveEffectiveConfig([
			tier(SettingsTier.User, { mcpServers: { userServer: { command: 'node' } } }),
			tier(SettingsTier.ManagedFile, { allowManagedMcpServersOnly: true, mcpServers: { adminServer: { command: 'py' } } }),
		]);
		assert.deepStrictEqual(r.activeLocks, ['allowManagedMcpServersOnly']);
		// The non-managed server must NOT leak through the lock (the object-path lock-bypass bug).
		assert.ok(!r.settings.some(s => s.path.startsWith('mcpServers.userServer')), 'non-managed MCP server leaked through the lock');
		assert.strictEqual(at(r, 'mcpServers.adminServer.command').effective, 'py');
		assert.strictEqual(at(r, 'mcpServers.adminServer.command').locked, true);
	});

	test('inherited properties (constructor/__proto__) are never treated as configured values or locks', () => {
		const r = resolveEffectiveConfig([tier(SettingsTier.ManagedFile, { model: 'file' })]);
		assert.deepStrictEqual(r.activeLocks, []); // must not read Object.prototype.constructor etc. as a lock
		assert.ok(!r.settings.some(s => s.path === 'constructor' || s.path === 'toString' || s.path === '__proto__'));
	});

	test('merge regime follows the HIGHEST tier: a higher scalar beats a lower object (and vice versa)', () => {
		// higher scalar over lower object -> scalar wins; the lower object must not leak child leaves
		const a = resolveEffectiveConfig([
			tier(SettingsTier.User, { foo: { a: 1 } }),
			tier(SettingsTier.Project, { foo: 'scalar' }),
		]);
		const fooA = at(a, 'foo');
		assert.strictEqual(fooA.kind, 'scalar');
		assert.strictEqual(fooA.effective, 'scalar');
		assert.strictEqual(fooA.winner, SettingsTier.Project);
		assert.ok(!a.settings.some(s => s.path === 'foo.a'), 'lower object leaked child leaves past a higher scalar');

		// higher object over lower scalar -> deep-merge; no bare `foo` scalar leaf survives
		const b = resolveEffectiveConfig([
			tier(SettingsTier.User, { foo: 'scalar' }),
			tier(SettingsTier.Project, { foo: { a: 1 } }),
		]);
		assert.strictEqual(at(b, 'foo.a').effective, 1);
		assert.ok(!b.settings.some(s => s.path === 'foo'), 'a scalar leaf survived under a higher object');
	});

	test('a settings key that literally contains a dot resolves as one key (threaded, not re-split)', () => {
		const r = resolveEffectiveConfig([tier(SettingsTier.User, { env: { 'A.B': 'literal' } })]);
		const leaf = at(r, 'env.A.B');
		assert.strictEqual(leaf.effective, 'literal'); // old code re-split the path and dropped this value
		assert.strictEqual(leaf.winner, SettingsTier.User);
	});
});
// CLAWDIUS-END
