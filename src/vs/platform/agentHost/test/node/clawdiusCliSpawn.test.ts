/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN cli backend resolution: enterprise wrapper spawn tests
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createClaudeProcessWrapperSpawn, IWrapperChildOptions } from '../../node/claude/clawdiusCliSpawn.js';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

suite('clawdiusCliSpawn / enterprise wrapper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const fakeProcess = {} as unknown as SpawnedProcess;

	test('spawns the wrapper with the SDK launch command as argv[0] and forwards cwd/env/signal/stdio', () => {
		const calls: { command: string; args: readonly string[]; options: IWrapperChildOptions }[] = [];
		const spawnFn = (command: string, args: readonly string[], options: IWrapperChildOptions): SpawnedProcess => {
			calls.push({ command, args, options });
			return fakeProcess;
		};
		const spawnClaude = createClaudeProcessWrapperSpawn('/opt/ent/claude-wrapper', spawnFn);

		const signal = new AbortController().signal;
		const result = spawnClaude({ command: '/usr/bin/node', args: ['/cli.js', '--output-format', 'stream-json'], cwd: '/work', env: { PATH: '/bin', NODE_OPTIONS: undefined }, signal });

		assert.strictEqual(result, fakeProcess);
		assert.strictEqual(calls.length, 1);
		const call = calls[0];
		// The WRAPPER is the spawned process; the SDK's intended launch command is argv[0].
		assert.strictEqual(call.command, '/opt/ent/claude-wrapper');
		assert.deepStrictEqual(call.args, ['/usr/bin/node', '/cli.js', '--output-format', 'stream-json']);
		assert.strictEqual(call.options.cwd, '/work');
		assert.deepStrictEqual(call.options.env, { PATH: '/bin', NODE_OPTIONS: undefined });
		assert.strictEqual(call.options.signal, signal);
		assert.deepStrictEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
		assert.strictEqual(call.options.windowsHide, true);
		assert.strictEqual(call.options.shell, false);
	});
});
// CLAWDIUS-END
