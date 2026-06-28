/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN permissions control model unit tests
// Covers parsing the permissions block, the add/remove/move bucket math with cross-bucket de-dupe (a rule
// lives in exactly one bucket), the "only changed buckets are written" diff, the defaultMode/additionalDirs
// writes, and the mcp__server__tool rule builder.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	BUILTIN_TOOLS,
	IPermissionsState,
	addRule,
	additionalDirectoriesWrite,
	builtinRule,
	bucketWrites,
	classifyRule,
	defaultModeWrite,
	mcpToolRule,
	moveRule,
	normalizeRule,
	parsePermissions,
	parseRule,
	removeRule,
} from '../../browser/control/claudePermissionsModel.js';

/** Build a state from partial buckets for terse tests. */
function state(partial: Partial<IPermissionsState>): IPermissionsState {
	return {
		defaultMode: partial.defaultMode,
		allow: partial.allow ?? [],
		ask: partial.ask ?? [],
		deny: partial.deny ?? [],
		additionalDirectories: partial.additionalDirectories ?? [],
	};
}

suite('Clawdius permissions model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parsePermissions: missing/invalid permissions block reads as empty', () => {
		assert.deepStrictEqual(parsePermissions(undefined), state({}));
		assert.deepStrictEqual(parsePermissions({}), state({}));
		assert.deepStrictEqual(parsePermissions({ permissions: 42 }), state({}));
	});

	test('parsePermissions: reads buckets + defaultMode, drops non-strings, de-dupes order-preserving', () => {
		const parsed = parsePermissions({
			permissions: {
				defaultMode: 'plan',
				allow: ['Read(a)', 'Read(a)', 'Bash(ls)', 7],
				ask: ['Write(b)'],
				deny: [],
				additionalDirectories: ['/tmp', '/tmp', '/var'],
			},
		});
		assert.deepStrictEqual(parsed, state({
			defaultMode: 'plan',
			allow: ['Read(a)', 'Bash(ls)'],
			ask: ['Write(b)'],
			additionalDirectories: ['/tmp', '/var'],
		}));
	});

	test('parsePermissions: an unknown defaultMode is dropped to undefined', () => {
		assert.strictEqual(parsePermissions({ permissions: { defaultMode: 'wild' } }).defaultMode, undefined);
		assert.strictEqual(parsePermissions({ permissions: { defaultMode: 'bypassPermissions' } }).defaultMode, 'bypassPermissions');
	});

	test('normalizeRule trims and rejects blank', () => {
		assert.strictEqual(normalizeRule('  Read(x)  '), 'Read(x)');
		assert.strictEqual(normalizeRule('   '), undefined);
		assert.strictEqual(normalizeRule(''), undefined);
	});

	test('addRule: a new rule appends to the target bucket', () => {
		const next = addRule(state({ allow: ['Read(a)'] }), 'allow', 'Bash(ls)');
		assert.deepStrictEqual(next, { allow: ['Read(a)', 'Bash(ls)'], ask: [], deny: [] });
	});

	test('addRule: a rule in another bucket MOVES (removed from the others - one bucket only)', () => {
		const next = addRule(state({ ask: ['Bash(rm)'], allow: ['Read(a)'] }), 'deny', 'Bash(rm)');
		assert.deepStrictEqual(next, { allow: ['Read(a)'], ask: [], deny: ['Bash(rm)'] });
	});

	test('addRule: blank rule is rejected (undefined)', () => {
		assert.strictEqual(addRule(state({}), 'allow', '   '), undefined);
	});

	test('addRule: trims, and re-adding the same rule keeps a single copy', () => {
		const next = addRule(state({ allow: ['Read(a)'] }), 'allow', '  Read(a)  ');
		assert.deepStrictEqual(next, { allow: ['Read(a)'], ask: [], deny: [] });
	});

	test('removeRule: drops just that rule from its bucket', () => {
		const next = removeRule(state({ deny: ['Bash(rm)', 'Bash(sudo)'] }), 'deny', 'Bash(rm)');
		assert.deepStrictEqual(next, { allow: [], ask: [], deny: ['Bash(sudo)'] });
	});

	test('moveRule: removes from source and appends to target', () => {
		const next = moveRule(state({ allow: ['Read(a)', 'Bash(ls)'] }), 'allow', 'ask', 'Bash(ls)');
		assert.deepStrictEqual(next, { allow: ['Read(a)'], ask: ['Bash(ls)'], deny: [] });
	});

	test('bucketWrites: only buckets that actually changed are written, as whole arrays', () => {
		const before = state({ allow: ['Read(a)'], ask: ['Write(b)'] });
		const next = addRule(before, 'deny', 'Bash(rm)')!;
		assert.deepStrictEqual(bucketWrites(before, next), [
			{ path: ['permissions', 'deny'], value: ['Bash(rm)'] },
		]);
	});

	test('bucketWrites: a move writes both affected buckets', () => {
		const before = state({ allow: ['Read(a)', 'Bash(ls)'] });
		const next = moveRule(before, 'allow', 'deny', 'Bash(ls)');
		assert.deepStrictEqual(bucketWrites(before, next), [
			{ path: ['permissions', 'allow'], value: ['Read(a)'] },
			{ path: ['permissions', 'deny'], value: ['Bash(ls)'] },
		]);
	});

	test('bucketWrites: a no-op change writes nothing', () => {
		const before = state({ allow: ['Read(a)'] });
		assert.deepStrictEqual(bucketWrites(before, { allow: ['Read(a)'], ask: [], deny: [] }), []);
	});

	test('defaultModeWrite sets or clears the key', () => {
		assert.deepStrictEqual(defaultModeWrite('acceptEdits'), { path: ['permissions', 'defaultMode'], value: 'acceptEdits' });
		assert.deepStrictEqual(defaultModeWrite(undefined), { path: ['permissions', 'defaultMode'], value: undefined });
	});

	test('additionalDirectoriesWrite de-dupes', () => {
		assert.deepStrictEqual(additionalDirectoriesWrite(['/a', '/a', '/b']), { path: ['permissions', 'additionalDirectories'], value: ['/a', '/b'] });
	});

	test('mcpToolRule: server+tool, server-only, and blank server', () => {
		assert.strictEqual(mcpToolRule('github', 'create_issue'), 'mcp__github__create_issue');
		assert.strictEqual(mcpToolRule('github', '  '), 'mcp__github');
		assert.strictEqual(mcpToolRule('  ', 'x'), undefined);
	});

	test('parseRule: MCP rules split into server + tool (whole-server when no tool)', () => {
		assert.deepStrictEqual(parseRule('mcp__github__create_issue'), { raw: 'mcp__github__create_issue', kind: 'mcp', primary: 'github', secondary: 'create_issue' });
		assert.deepStrictEqual(parseRule('mcp__github'), { raw: 'mcp__github', kind: 'mcp', primary: 'github', secondary: undefined });
		assert.deepStrictEqual(parseRule('mcp__github__'), { raw: 'mcp__github__', kind: 'mcp', primary: 'github', secondary: undefined });
	});

	test('parseRule: Tool(pattern) rules split into tool + pattern', () => {
		assert.deepStrictEqual(parseRule('Bash(git push:*)'), { raw: 'Bash(git push:*)', kind: 'tool', primary: 'Bash', secondary: 'git push:*' });
		assert.deepStrictEqual(parseRule('Read(./.env)'), { raw: 'Read(./.env)', kind: 'tool', primary: 'Read', secondary: './.env' });
		assert.deepStrictEqual(parseRule('WebFetch()'), { raw: 'WebFetch()', kind: 'tool', primary: 'WebFetch', secondary: undefined });
	});

	test('parseRule: bare tool / unknown shapes pass through', () => {
		assert.deepStrictEqual(parseRule('WebFetch'), { raw: 'WebFetch', kind: 'bare', primary: 'WebFetch', secondary: undefined });
		assert.deepStrictEqual(parseRule('  Bash(ls)  '), { raw: 'Bash(ls)', kind: 'tool', primary: 'Bash', secondary: 'ls' });
	});

	test('builtinRule: tool only -> bare, tool + specifier -> Tool(spec), blank tool -> undefined', () => {
		assert.strictEqual(builtinRule('WebFetch', ''), 'WebFetch');
		assert.strictEqual(builtinRule('Bash', 'git push:*'), 'Bash(git push:*)');
		assert.strictEqual(builtinRule('Read', '  ./.env  '), 'Read(./.env)');
		assert.strictEqual(builtinRule('  ', 'x'), undefined);
		assert.strictEqual(builtinRule('  Edit  ', ''), 'Edit');
	});

	test('BUILTIN_TOOLS holds the common Claude tools and no MCP entries', () => {
		for (const t of ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task']) {
			assert.ok(BUILTIN_TOOLS.includes(t), `${t} should be a built-in`);
		}
		assert.ok(!BUILTIN_TOOLS.some(t => t.startsWith('mcp__')));
	});

	test('classifyRule: mcp / known-builtin / raw', () => {
		assert.strictEqual(classifyRule('mcp__github__create_issue'), 'mcp');
		assert.strictEqual(classifyRule('mcp__github'), 'mcp');
		assert.strictEqual(classifyRule('Bash(git push:*)'), 'builtin');
		assert.strictEqual(classifyRule('WebFetch'), 'builtin');
		assert.strictEqual(classifyRule('SomeCustomTool(x)'), 'raw'); // not in the curated list -> raw
		assert.strictEqual(classifyRule('//weird-syntax'), 'raw');
	});

	test('parseRule: an mcp rule with extra separators keeps the remainder as the secondary (first __ splits)', () => {
		assert.deepStrictEqual(parseRule('mcp__a__b__c'), { raw: 'mcp__a__b__c', kind: 'mcp', primary: 'a', secondary: 'b__c' });
	});

	test('moveRule with from === to removes everywhere then re-appends (reorders the rule to the end)', () => {
		assert.deepStrictEqual(moveRule(state({ allow: ['a', 'b'] }), 'allow', 'allow', 'a'), { allow: ['b', 'a'], ask: [], deny: [] });
	});
});
// CLAWDIUS-END
