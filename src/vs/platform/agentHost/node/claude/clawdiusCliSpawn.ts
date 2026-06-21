/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN cli backend resolution: enterprise process wrapper
// Builds the SDK's `spawnClaudeCodeProcess` for `wrapper` mode (`clawdius.cli.wrapperPath`). The SDK calls
// it INSTEAD of its default local spawn, handing us the launch command it would have run; we spawn the
// enterprise wrapper with that command as argv[0] (matching the official extension's `claudeProcessWrapper`:
// "the bundled binary path is passed as an argument"). The wrapper then execs the real CLI with whatever
// auth / proxy / Bedrock / Vertex / policy it injects. The `signal` is the SDK's GRACEFUL abort (it fires
// only after stdin-EOF + ~2s grace), so it is safe to pass straight to Node `spawn({signal})`.
//
// This is the SOLE process-spawn in the Clawdius CLI path. The resolver (`IClawdiusCliConfigService`) stays
// strictly spawn-free / network-free; the spawn happens here only at an explicit, user-initiated session
// launch.

import { spawn } from 'child_process';
import type { Options, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

/** Node-`spawn`-shaped seam, injectable so the wrapper invocation is unit-testable without a real process. */
export interface IWrapperChildOptions {
	readonly cwd?: string;
	readonly env: Record<string, string | undefined>;
	readonly signal: AbortSignal;
	readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
	readonly windowsHide: boolean;
	readonly shell: boolean;
}

export type SpawnFn = (command: string, args: readonly string[], options: IWrapperChildOptions) => SpawnedProcess;

const defaultSpawnFn: SpawnFn = (command, args, options) =>
	// A Node ChildProcess (stdio piped) structurally satisfies SpawnedProcess (non-null stdin/stdout, kill,
	// exitCode, exit/error events); the cast bridges the nullable-stream typings.
	spawn(command, [...args], { cwd: options.cwd, env: options.env, signal: options.signal, stdio: [...options.stdio], windowsHide: options.windowsHide, shell: options.shell }) as unknown as SpawnedProcess;

/**
 * Build the SDK `spawnClaudeCodeProcess` callback that launches the engine through the enterprise wrapper.
 * The wrapper is spawned with the SDK's intended launch command as argv[0]:
 *   `spawn(wrapperPath, [options.command, ...options.args], ...)`.
 *
 * `wrapperPath` must be a DIRECTLY-spawnable executable. We deliberately use `shell:false` (never `shell:true`
 * — that is a shell-injection surface), so on Windows a `.cmd`/`.bat` BATCH wrapper does not launch directly
 * (a dedicated Windows command-runner is a planned follow-up). Use an `.exe`, or a shebang script on
 * POSIX/WSL. Failure here is fail-closed (the launch errors visibly); it never falls back to an unwrapped engine.
 */
export function createClaudeProcessWrapperSpawn(wrapperPath: string, spawnFn: SpawnFn = defaultSpawnFn): NonNullable<Options['spawnClaudeCodeProcess']> {
	return (options: SpawnOptions) => spawnFn(wrapperPath, [options.command, ...options.args], {
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
		shell: false,
	});
}
// CLAWDIUS-END
