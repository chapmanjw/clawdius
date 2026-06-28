/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * How the user wants Clawdius to launch the Claude Code engine.
 *  - `oauth`   : native `~/.claude` OAuth (the default; same as the `claude` CLI).
 *  - `bedrock` : Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`).
 *  - `vertex`  : Google Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`).
 *  - `foundry` : Azure AI Foundry — configured through `clawdius.cli.environmentVariables`.
 *  - `custom`  : a bespoke provider — fully configured through `clawdius.cli.environmentVariables`.
 */
export type ClawdiusCliProviderPreset = 'oauth' | 'bedrock' | 'vertex' | 'foundry' | 'custom';

/**
 * Which Claude Code engine the agent-host SDK should launch.
 *  - `bundled` : the Agent SDK's own vendored `cli.js`, run via Electron-as-node. The default
 *                (`executable:'node'`, no `pathToClaudeCodeExecutable`).
 *  - `userCli` : the user's installed Claude Code `cli.js` (an ABSOLUTE JS path), passed as
 *                `pathToClaudeCodeExecutable` (true one-shared-config).
 *  - `wrapper` : an ENTERPRISE wrapper — a process launcher (`clawdius.cli.wrapperPath`) that injects
 *                auth / proxy / Bedrock / Vertex / policy around the real CLI, like the official extension's
 *                `claudeProcessWrapper`. Launched via the SDK's `spawnClaudeCodeProcess` (the wrapper receives
 *                the SDK's intended launch command as argv[0]). A wrapper is NEVER silently bypassed: if its
 *                path is invalid the resolution STILL uses wrapper mode and surfaces the problem, so an
 *                enterprise policy layer can't be skipped by misconfiguration.
 */
export type ClawdiusCliMode = 'bundled' | 'userCli' | 'wrapper';

/**
 * The raw `clawdius.cli.*` settings, as read from the user `settings.json`. Every field is optional; an
 * absent field means "use the default" (which resolves to the bundled engine + native OAuth).
 */
export interface IClawdiusCliSettings {
	/**
	 * Absolute path to an enterprise Claude process wrapper (a launcher script/executable that injects
	 * auth/proxy/provider/policy around the real CLI), like the official extension's `claudeProcessWrapper`.
	 * When set, selects `wrapper` mode and is never silently bypassed.
	 */
	readonly wrapperPath?: string;
	/** ABSOLUTE path to the user's installed Claude Code `cli.js` (a JS entrypoint). Selects `userCli` mode. */
	readonly nodeCliPath?: string;
	/** Extra environment variables overlaid onto the Claude subprocess env. */
	readonly environmentVariables?: Readonly<Record<string, string>>;
	/** Force-suppress the interactive OAuth login prompt (e.g. for headless / provider-backed setups). */
	readonly disableLoginPrompt?: boolean;
	/** Which provider the engine should authenticate against. Defaults to `oauth`. */
	readonly providerPreset?: ClawdiusCliProviderPreset;
}

/**
 * Whether the paths named in {@link IClawdiusCliSettings} exist on disk. Supplied by the resolver service
 * (which does the async existence checks) so {@link projectCliResolution} stays a pure, synchronous,
 * fully-testable projection. NO process is ever spawned to compute these — existence checks only.
 */
export interface IClawdiusCliPathExistence {
	readonly wrapperPathExists: boolean;
	readonly nodeCliPathExists: boolean;
}

/**
 * The resolved backend the agent-host SDK should launch. Projected onto the Agent SDK `Options` by
 * `buildOptions` (executable + optional `pathToClaudeCodeExecutable` + an env overlay). Pure data.
 */
export interface IClawdiusCliResolution {
	readonly mode: ClawdiusCliMode;
	/** The SDK `executable` runtime enum. Always `node` today (the SDK runs cli.js under a JS runtime). */
	readonly executable: 'node' | 'bun' | 'deno';
	/** When set, the SDK launches this `cli.js` instead of its vendored one (`userCli`, or a `wrapper` targeting the user cli). */
	readonly pathToClaudeCodeExecutable?: string;
	/**
	 * The enterprise wrapper path (`wrapper` mode). Projected onto the SDK's `spawnClaudeCodeProcess` so the
	 * wrapper launches the engine. Present whenever the user configured a wrapper, even if the path is invalid
	 * (see `unsupportedReason`) — the wrapper is never silently bypassed.
	 */
	readonly wrapperPath?: string;
	/** In `wrapper` mode, what the wrapper launches: the bundled cli.js, or the user's cli.js. */
	readonly wrapperTarget?: 'bundled' | 'userCli';
	/** Environment overlay for the Claude subprocess (provider-preset env + user `environmentVariables`). */
	readonly extraEnv: Readonly<Record<string, string | undefined>>;
	readonly providerPreset: ClawdiusCliProviderPreset;
	/**
	 * Resolved from `clawdius.cli.disableLoginPrompt`. Carried as metadata for a later phase that wires
	 * login-prompt suppression; NOT yet enforced by `buildOptions`. Defaults to `false`.
	 */
	readonly disableLoginPrompt: boolean;
	/**
	 * Set when a configured path is invalid: a `wrapperPath` that is not an absolute existing executable
	 * (STILL used in `wrapper` mode — launch fails visibly rather than bypassing the policy layer), or a
	 * `nodeCliPath` that is not an absolute existing JS entrypoint (falls back to `bundled`). A human-readable
	 * reason for logging; never a silent condition.
	 */
	readonly unsupportedReason?: string;
}

const JS_ENTRYPOINT = /\.(?:js|mjs|cjs)$/i;

/** Provider-preset environment overlay. Bedrock/Vertex set their documented flags; the rest defer to
 * `environmentVariables` (we do not invent env var names we are not sure of). */
function providerPresetEnv(preset: ClawdiusCliProviderPreset): Record<string, string | undefined> {
	switch (preset) {
		case 'bedrock': return { CLAUDE_CODE_USE_BEDROCK: '1' };
		case 'vertex': return { CLAUDE_CODE_USE_VERTEX: '1' };
		case 'foundry':
		case 'custom':
		case 'oauth':
		default: return {};
	}
}

/**
 * A FULLY-QUALIFIED absolute path: a Windows drive (`C:\` / `C:/`), a UNC root (`\\server` / `//server`), or
 * a POSIX root (`/`). Deliberately REJECTS a single leading backslash (`\foo`): on POSIX that is not a root
 * at all, and on Windows it is only drive-relative (ambiguous) — neither is safe to launch as an engine.
 */
function isAbsolutePath(p: string): boolean {
	return /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(p);
}

/**
 * Pure projection from the user's `clawdius.cli.*` settings (+ on-disk existence of the paths they name)
 * onto a {@link IClawdiusCliResolution}. Deterministic, synchronous, network-free, spawn-free — the resolver
 * service does the async existence checks and hands the booleans in. Resolution rules (precedence):
 *  1. `wrapperPath` set -> `wrapper` mode (enterprise wrapper, launched via `spawnClaudeCodeProcess`). If a
 *     valid absolute `nodeCliPath` is also set the wrapper targets the user cli (`pathToClaudeCodeExecutable`
 *     + `wrapperTarget:'userCli'`); else it targets the bundled cli. An INVALID `wrapperPath` (not an
 *     absolute existing executable) STILL resolves to `wrapper` mode with an `unsupportedReason` — a wrapper
 *     is never silently bypassed (that would skip the enterprise policy layer); launch fails visibly instead.
 *  2. no wrapper, `nodeCliPath` absolute + JS entrypoint + exists -> `userCli`.
 *  3. no wrapper, `nodeCliPath` set but not an absolute existing JS entrypoint -> `bundled` + reason.
 *  4. otherwise -> `bundled` (the default; SDK runs its vendored cli.js via Electron-as-node).
 */
export function projectCliResolution(settings: IClawdiusCliSettings, existence: IClawdiusCliPathExistence): IClawdiusCliResolution {
	const providerPreset: ClawdiusCliProviderPreset = settings.providerPreset ?? 'oauth';
	// Honest pass-through metadata: mirrors the explicit setting (default false). Not yet enforced; a later
	// phase wires actual login-prompt suppression. (Do not auto-disable per preset - that implies behavior
	// this phase does not deliver.)
	const disableLoginPrompt = settings.disableLoginPrompt ?? false;
	const extraEnv: Record<string, string | undefined> = {
		...providerPresetEnv(providerPreset),
		...(settings.environmentVariables ?? {}),
	};
	const base = { executable: 'node' as const, extraEnv, providerPreset, disableLoginPrompt };

	const wrapperPath = settings.wrapperPath?.trim();
	const nodeCliPath = settings.nodeCliPath?.trim();

	// A user cli.js is valid only as an ABSOLUTE path to an existing JS entrypoint — the SDK does not
	// PATH-resolve `pathToClaudeCodeExecutable`, so a bare `claude` must never resolve to a real engine.
	const userCliValid = !!nodeCliPath && isAbsolutePath(nodeCliPath) && JS_ENTRYPOINT.test(nodeCliPath) && existence.nodeCliPathExists;

	if (wrapperPath) {
		const wrapperValid = isAbsolutePath(wrapperPath) && existence.wrapperPathExists;
		const targetUserCli = userCliValid && !!nodeCliPath;
		// Accumulate every config problem so a typo is never silent: an invalid wrapper (still applied), and a
		// set-but-invalid nodeCliPath that quietly downgraded the wrapper target from the user cli to bundled.
		const reasons: string[] = [];
		if (!wrapperValid) {
			reasons.push(`clawdius.cli.wrapperPath ('${wrapperPath}') must be an absolute path to an existing executable. The wrapper is still applied (the enterprise policy layer is never silently bypassed) — fix the path or launch will fail.`);
		}
		if (nodeCliPath && !userCliValid) {
			reasons.push(`clawdius.cli.nodeCliPath ('${nodeCliPath}') is not an absolute existing JS entrypoint, so the wrapper targets the bundled cli instead of your install.`);
		}
		return {
			...base,
			mode: 'wrapper',
			wrapperPath,
			...(targetUserCli
				? { pathToClaudeCodeExecutable: nodeCliPath, wrapperTarget: 'userCli' as const }
				: { wrapperTarget: 'bundled' as const }),
			...(reasons.length > 0 ? { unsupportedReason: reasons.join(' ') } : {}),
		};
	}

	if (nodeCliPath) {
		if (userCliValid) {
			return { ...base, mode: 'userCli', pathToClaudeCodeExecutable: nodeCliPath };
		}
		return {
			...base,
			mode: 'bundled',
			unsupportedReason: `clawdius.cli.nodeCliPath ('${nodeCliPath}') must be an absolute path to an existing JS entrypoint (.js/.mjs/.cjs); using the bundled engine.`,
		};
	}

	return { ...base, mode: 'bundled' };
}

/**
 * Resolves which Claude Code engine the agent-host SDK launches, from the user's `clawdius.cli.*` settings.
 * Runs in the agent-host node process (reads its `IConfigurationService`, which is backed by the user
 * `settings.json`). Resolution performs file-existence checks only — never any network or process spawn.
 */
export interface IClawdiusCliConfigService {
	readonly _serviceBrand: undefined;
	/** Resolve the backend afresh (callers resolve at each session materialize / rematerialize). */
	resolveCliBackend(): Promise<IClawdiusCliResolution>;
}

export const IClawdiusCliConfigService = createDecorator<IClawdiusCliConfigService>('clawdiusCliConfigService');

/** The configuration key prefix for all Clawdius CLI engine settings. */
export const CLAWDIUS_CLI_CONFIG_SECTION = 'clawdius.cli';
