/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN effective-config precedence: realistic server-managed payload
// The resolver's precedence model is unit-tested with minimal synthetic bodies elsewhere. This suite verifies
// the SAME order and semantics against a realistic, full-shape server-managed remote-settings.json payload -
// model, env, permission arrays, mcpServers, hooks, a nested sandbox, and the managed-only lock booleans -
// resolved against conflicting managed-file, project, and user tiers. It confirms, on a real-world body:
//   - the server-managed tier wins the managed band (rank 2 beats managed-file rank 4);
//   - the band is non-merging: the managed-file body is replaced whole, not merged;
//   - a lower admin tier's lock still ORs in even when its body was replaced (managed-file's hooks lock);
//   - a locked key keeps only the managed allowlist (project permission + mcp rules are dropped, deny included);
//   - a NON-locked key (env) still deep-merges across the tiers below the band.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IEffectiveConfig,
	IResolvedSetting,
	JsonObject,
	ManagedLockKey,
	SettingsTier,
	resolveEffectiveConfig,
} from '../../common/clawdiusEffectiveConfig.js';

function at(result: IEffectiveConfig, path: string): IResolvedSetting {
	const found = result.settings.find(s => s.path === path);
	assert.ok(found, `expected a resolved setting at "${path}"`);
	return found;
}

function has(result: IEffectiveConfig, path: string): boolean {
	return result.settings.some(s => s.path === path);
}

/** A realistic server-delivered remote-settings.json body (~/.claude/remote-settings.json), full shape. */
const SERVER_MANAGED: JsonObject = {
	model: 'claude-sonnet-4-5',
	env: { ANTHROPIC_LOG: 'info', DISABLE_TELEMETRY: '1' },
	permissions: {
		defaultMode: 'acceptEdits',
		allow: ['Read', 'Edit', 'Bash(git:*)'],
		deny: ['Bash(rm:-rf*)', 'Read(./secrets/**)'],
		ask: ['Bash(npm:publish*)'],
	},
	mcpServers: { 'corp-tools': { command: 'corp-mcp', args: ['--stdio'] } },
	hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit-log' }] }] },
	sandbox: {
		network: { allowedDomains: ['api.anthropic.com', 'registry.npmjs.org'], allowManagedDomainsOnly: true },
		filesystem: { readPaths: ['/etc/corp'], allowManagedReadPathsOnly: true },
	},
	allowManagedPermissionRulesOnly: true,
	allowManagedMcpServersOnly: true,
};

/** A managed-settings.json body (rank 4). Its body is replaced by the server tier, but its hooks lock still ORs in. */
const MANAGED_FILE: JsonObject = {
	model: 'managed-file-model',
	outputStyle: 'managed-file-only', // a unique, non-locked key: it must NOT survive the non-merging band replacement
	permissions: { allow: ['Bash(sudo:*)'] },
	allowManagedHooksOnly: true,
};

/** A shared project settings.json (rank 7), below the managed band. */
const PROJECT: JsonObject = {
	model: 'opus',
	env: { PROJECT_VAR: 'x' },
	permissions: { allow: ['WebSearch'], deny: ['Bash(curl:*)'] },
	mcpServers: { 'local-tool': { command: 'local-mcp' } },
};

/** The user / global settings.json (rank 8). */
const USER: JsonObject = { model: 'haiku', env: { USER_VAR: 'y' } };

suite('Clawdius effective-config: realistic server-managed payload', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const r = resolveEffectiveConfig([
		{ tier: SettingsTier.User, body: USER },
		{ tier: SettingsTier.Project, body: PROJECT },
		{ tier: SettingsTier.ManagedFile, body: MANAGED_FILE },
		{ tier: SettingsTier.ServerManaged, body: SERVER_MANAGED },
	]);

	test('the server-managed tier wins the managed band (rank 2 over managed-file rank 4)', () => {
		assert.strictEqual(r.managedWinner, SettingsTier.ServerManaged);
		assert.strictEqual(r.managedOpaque, false);
	});

	test('a scalar takes the server-managed value over managed-file, project, and user', () => {
		const model = at(r, 'model');
		assert.strictEqual(model.effective, 'claude-sonnet-4-5');
		assert.strictEqual(model.winner, SettingsTier.ServerManaged);
		assert.strictEqual(model.provisional, false);
	});

	test('the managed band is non-merging: the managed-file body is replaced, not merged', () => {
		// managed-file's unique, non-locked key never appears: if the band merged, `outputStyle` would resolve.
		assert.ok(!has(r, 'outputStyle'), 'the managed-file body must not merge into the resolution');
		// ...and the winning scalar carries no managed-file contribution.
		assert.ok(!at(r, 'model').contributions.some(c => c.tier === SettingsTier.ManagedFile));
	});

	test('a lower admin tier\'s lock ORs in even though its body was replaced', () => {
		// managed-file supplied allowManagedHooksOnly; the server supplied the other four. All five are active.
		const expected: ManagedLockKey[] = [
			'allowManagedPermissionRulesOnly',
			'allowManagedMcpServersOnly',
			'allowManagedHooksOnly',
			'sandbox.filesystem.allowManagedReadPathsOnly',
			'sandbox.network.allowManagedDomainsOnly',
		];
		assert.deepStrictEqual([...r.activeLocks].sort(), expected.sort());
	});

	test('a locked key keeps only the managed allowlist (project allow AND deny are dropped)', () => {
		const allow = at(r, 'permissions.allow');
		assert.deepStrictEqual(allow.effective, ['Read', 'Edit', 'Bash(git:*)']);
		assert.strictEqual(allow.locked, true);
		// Even a project DENY is dropped under the managed-only-rules lock.
		assert.deepStrictEqual(at(r, 'permissions.deny').effective, ['Bash(rm:-rf*)', 'Read(./secrets/**)']);
	});

	test('a locked object-valued key keeps only the managed servers', () => {
		assert.ok(has(r, 'mcpServers.corp-tools.command'), 'the managed mcp server survives');
		assert.ok(!has(r, 'mcpServers.local-tool.command'), 'the project mcp server is dropped by the lock');
	});

	test('a NON-locked key still deep-merges across the tiers below the band', () => {
		// env has no managed lock, so the server value and the project/user values all survive.
		assert.strictEqual(at(r, 'env.ANTHROPIC_LOG').effective, 'info');
		assert.strictEqual(at(r, 'env.PROJECT_VAR').winner, SettingsTier.Project);
		assert.strictEqual(at(r, 'env.USER_VAR').winner, SettingsTier.User);
	});
});

// CLAWDIUS-END
