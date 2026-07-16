/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN usage-contribution fetch (#usage) - node implementation
// Runs `<claude> -p /usage` (the CLI's print-mode slash command) and captures its stdout - the engine's verbatim
// "What's contributing to your limits usage?" text (session bars + the Last-24h / Last-7d behaviour breakdown) -
// so the Control Center Usage dashboard can render it. The Agent SDK's stream input treats a "/usage" message as
// a PROMPT (an assistant turn), NOT a slash command, so we shell out to the CLI, which processes the slash command
// locally (no model turn - just the usage-API read the dashboard already does). Timeout-guarded; on-demand only
// (dashboard open / Refresh). Uses the same resolved CLI backend + subprocess env as the SDK spawn.

import { spawn } from 'child_process';
import { ILogService } from '../../../log/common/log.js';
import { IClawdiusCliConfigService } from '../../../clawdius/common/clawdiusCliConfig.js';
import { IClaudeUsageContributionResult, IClaudeUsageContributionService } from '../../common/claudeUsageContribution.js';
import { buildSubprocessEnv } from './claudeSdkOptions.js';
import { redactSecrets } from '../agentHostSecretRedact.js';

/** Total budget for one /usage fetch. The local command is fast; capped so a hang cannot pin a process. */
const USAGE_TIMEOUT_MS = 25_000;

export class ClaudeUsageContributionService implements IClaudeUsageContributionService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IClawdiusCliConfigService private readonly cliConfig: IClawdiusCliConfigService,
		@ILogService private readonly logService: ILogService,
	) { }

	async fetchUsageContribution(workingDirectoryPath: string): Promise<IClaudeUsageContributionResult> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
		try {
			const cli = await this.cliConfig.resolveCliBackend();
			// `--output-format json` wraps the /usage text in { result, is_error, subtype } so we get a clean
			// success/error signal + the exact text; `-p` is print mode; "/usage" is the local slash command.
			const usageArgs = ['-p', '/usage', '--output-format', 'json'];
			const cliPath = cli.pathToClaudeCodeExecutable;
			let exe: string;
			let args: string[];
			if (cliPath && /\.[mc]?js$/i.test(cliPath)) {
				// A JS entrypoint (a pinned user cli.js): run it under the resolved JS runtime - 'node' maps to the
				// current binary as Electron-as-node (ELECTRON_RUN_AS_NODE is set in the env below).
				exe = cli.executable === 'node' ? process.execPath : cli.executable;
				args = [cliPath, ...usageArgs];
			} else if (cliPath) {
				// A native launcher (the auto-detected installed `claude` binary): spawn it DIRECTLY. Node cannot
				// load a native PE/Mach-O/ELF binary as a module (that produced `SyntaxError` on the exe header);
				// the SDK spawns this native path directly too.
				exe = cliPath;
				args = usageArgs;
			} else {
				// Bundled engine with no standalone CLI entrypoint exposed: nothing to spawn for a one-shot /usage.
				this.logService.info('[usage-contrib] no CLI path resolved (bundled engine); skipping /usage fetch');
				return { text: undefined, status: 'error' };
			}
			const env = { ...cli.extraEnv, ...buildSubprocessEnv(false) };
			const out = await this.runCli(exe, args, workingDirectoryPath, env, controller.signal);
			if (out === undefined) {
				return { text: undefined, status: controller.signal.aborted ? 'timeout' : 'error' };
			}
			const text = extractUsageText(out);
			return text !== undefined ? { text, status: 'ok' } : { text: undefined, status: 'empty' };
		} catch (err) {
			if (controller.signal.aborted) { return { text: undefined, status: 'timeout' }; }
			this.logService.warn(`[usage-contrib] failed: ${err instanceof Error ? err.message : String(err)}`);
			return { text: undefined, status: 'error' };
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}

	/**
	 * Spawn the CLI (`-p /usage`) and capture stdout. Resolves to the text on exit 0, or `undefined` on spawn
	 * error / non-zero exit that produced no output. Never rejects (the caller maps that to a non-`ok` status).
	 */
	private runCli(exe: string, args: readonly string[], cwd: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<string | undefined> {
		return new Promise<string | undefined>(resolve => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const finish = (value: string | undefined) => { if (!settled) { settled = true; resolve(value); } };
			try {
				const child = spawn(exe, [...args], { cwd, env, windowsHide: true, signal });
				child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
				child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
				child.on('error', () => finish(undefined));
				child.on('close', (code: number | null) => {
					if (code !== 0 && stdout.length === 0) {
						this.logService.warn(`[usage-contrib] cli exited ${code}: ${redactSecrets(stderr).slice(0, 300)}`);
						finish(undefined);
					} else {
						finish(stdout);
					}
				});
			} catch {
				finish(undefined);
			}
		});
	}
}

/**
 * `<claude> -p /usage --output-format json` prints a single JSON object `{ type, subtype, is_error, result, ... }`
 * whose `result` is the verbatim /usage text (session bars + the Last-24h / Last-7d behaviour breakdown). Extract
 * that text on success. Falls back to the raw stdout when the payload is not JSON (an older CLI that ignores the
 * flag), so the feature degrades to plain text rather than vanishing. Returns undefined when there is nothing usable.
 */
function extractUsageText(raw: string): string | undefined {
	try {
		const parsed = JSON.parse(raw) as { result?: unknown; is_error?: unknown };
		if (parsed.is_error === true) { return undefined; }
		const result = typeof parsed.result === 'string' ? parsed.result.trim() : '';
		return result.length > 0 ? result : undefined;
	} catch {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
}
// CLAWDIUS-END
