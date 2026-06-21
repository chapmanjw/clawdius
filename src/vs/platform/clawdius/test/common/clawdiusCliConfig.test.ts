/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IClawdiusCliPathExistence, IClawdiusCliSettings, projectCliResolution } from '../../common/clawdiusCliConfig.js';

const NONE: IClawdiusCliPathExistence = { wrapperPathExists: false, nodeCliPathExists: false };
const NODE_CLI_PRESENT: IClawdiusCliPathExistence = { wrapperPathExists: false, nodeCliPathExists: true };

function resolve(settings: IClawdiusCliSettings, existence: IClawdiusCliPathExistence = NONE) {
	return projectCliResolution(settings, existence);
}

suite('Clawdius CLI resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty settings -> bundled default, native OAuth, no unsupportedReason', () => {
		const r = resolve({});
		assert.deepStrictEqual(r, {
			mode: 'bundled',
			executable: 'node',
			extraEnv: {},
			providerPreset: 'oauth',
			disableLoginPrompt: false,
		});
		assert.strictEqual(r.pathToClaudeCodeExecutable, undefined);
		assert.strictEqual(r.unsupportedReason, undefined);
	});

	test('valid nodeCliPath that exists and is a JS entrypoint -> userCli', () => {
		const r = resolve({ nodeCliPath: '/home/me/.npm/claude-code/cli.js' }, NODE_CLI_PRESENT);
		assert.strictEqual(r.mode, 'userCli');
		assert.strictEqual(r.pathToClaudeCodeExecutable, '/home/me/.npm/claude-code/cli.js');
		assert.strictEqual(r.executable, 'node');
		assert.strictEqual(r.unsupportedReason, undefined);
	});

	test('nodeCliPath that does not exist -> bundled with an unsupportedReason', () => {
		const r = resolve({ nodeCliPath: '/nope/cli.js' }, NONE);
		assert.strictEqual(r.mode, 'bundled');
		assert.strictEqual(r.pathToClaudeCodeExecutable, undefined);
		assert.ok(r.unsupportedReason && /not be|not found|JS entrypoint/i.test(r.unsupportedReason));
	});

	test('nodeCliPath that exists but is not a JS entrypoint -> bundled with an unsupportedReason', () => {
		const r = resolve({ nodeCliPath: '/usr/local/bin/claude' }, NODE_CLI_PRESENT);
		assert.strictEqual(r.mode, 'bundled');
		assert.ok(r.unsupportedReason);
	});

	test('wrapperPath (native binary) -> not supported yet, bundled with an unsupportedReason', () => {
		const r = resolve({ wrapperPath: 'C:/tools/claude.exe' }, { wrapperPathExists: true, nodeCliPathExists: false });
		assert.strictEqual(r.mode, 'bundled');
		assert.ok(r.unsupportedReason && /native binary|raw stream-json/i.test(r.unsupportedReason));
	});

	test('wrapperPath takes precedence over nodeCliPath (both flagged unsupported -> bundled)', () => {
		const r = resolve({ wrapperPath: '/x/claude', nodeCliPath: '/y/cli.js' }, { wrapperPathExists: true, nodeCliPathExists: true });
		assert.strictEqual(r.mode, 'bundled');
		assert.ok(r.unsupportedReason && /wrapperPath/i.test(r.unsupportedReason));
	});

	test('bedrock preset sets CLAUDE_CODE_USE_BEDROCK (login prompt is not auto-disabled)', () => {
		const r = resolve({ providerPreset: 'bedrock' });
		assert.strictEqual(r.providerPreset, 'bedrock');
		assert.strictEqual(r.extraEnv.CLAUDE_CODE_USE_BEDROCK, '1');
		assert.strictEqual(r.disableLoginPrompt, false);
	});

	test('vertex preset sets CLAUDE_CODE_USE_VERTEX', () => {
		const r = resolve({ providerPreset: 'vertex' });
		assert.strictEqual(r.extraEnv.CLAUDE_CODE_USE_VERTEX, '1');
	});

	test('user environmentVariables overlay onto and override preset env', () => {
		const r = resolve({ providerPreset: 'bedrock', environmentVariables: { AWS_REGION: 'us-west-2', CLAUDE_CODE_USE_BEDROCK: '0' } });
		assert.strictEqual(r.extraEnv.AWS_REGION, 'us-west-2');
		// user value wins over the preset default
		assert.strictEqual(r.extraEnv.CLAUDE_CODE_USE_BEDROCK, '0');
	});

	test('explicit disableLoginPrompt is honored (resolved metadata for a later phase)', () => {
		assert.strictEqual(resolve({ disableLoginPrompt: true }).disableLoginPrompt, true);
		assert.strictEqual(resolve({ providerPreset: 'bedrock', disableLoginPrompt: false }).disableLoginPrompt, false);
	});

	test('oauth preset (default) keeps the login prompt and adds no provider env', () => {
		const r = resolve({ providerPreset: 'oauth' });
		assert.strictEqual(r.disableLoginPrompt, false);
		assert.deepStrictEqual(r.extraEnv, {});
	});

	test('whitespace-only paths are treated as unset -> bundled default', () => {
		const r = resolve({ wrapperPath: '   ', nodeCliPath: '  ' });
		assert.strictEqual(r.mode, 'bundled');
		assert.strictEqual(r.unsupportedReason, undefined);
	});
});
