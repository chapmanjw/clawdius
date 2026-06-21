/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
 *  - `bundled`      : the Agent SDK's own vendored `cli.js`, run via Electron-as-node. The default and the
 *                     current behavior (`executable:'node'`, no `pathToClaudeCodeExecutable`).
 *  - `userCli`      : the user's installed `@anthropic-ai/claude-code` `cli.js`, passed as
 *                     `pathToClaudeCodeExecutable` (true one-shared-config).
 *  - `nativeBinary` : a compiled `claude` binary (claude.exe / musl) the SDK cannot launch as a JS
 *                     entrypoint. NOT yet supported — requires a raw stream-json adapter (later phase);
 *                     a request for it resolves to `bundled` with an `unsupportedReason`.
 */
export type ClawdiusCliMode = 'bundled' | 'userCli' | 'nativeBinary';

/**
 * The raw `clawdius.cli.*` settings, as read from the user `settings.json`. Every field is optional; an
 * absent field means "use the default" (which resolves to the bundled engine + native OAuth).
 */
export interface IClawdiusCliSettings {
	/** Path to a wrapper script / native `claude` binary. Reserved: native-binary launch is not yet supported. */
	readonly wrapperPath?: string;
	/** Path to the user's installed Claude Code `cli.js` (a JS entrypoint). Selects `userCli` mode. */
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
	/** When set, the SDK launches this `cli.js` instead of its vendored one (`userCli` mode). */
	readonly pathToClaudeCodeExecutable?: string;
	/** Environment overlay for the Claude subprocess (provider-preset env + user `environmentVariables`). */
	readonly extraEnv: Readonly<Record<string, string | undefined>>;
	readonly providerPreset: ClawdiusCliProviderPreset;
	/**
	 * Resolved from `clawdius.cli.disableLoginPrompt`. Carried as metadata for a later phase that wires
	 * login-prompt suppression; NOT yet enforced by `buildOptions`. Defaults to `false`.
	 */
	readonly disableLoginPrompt: boolean;
	/**
	 * Set when the user requested a mode that is not yet supported (a native-binary `wrapperPath`, or a
	 * `nodeCliPath` that is missing / not a JS entrypoint) and the resolver fell back to `bundled`. Carries
	 * a human-readable reason so the fallback is visible/loggable and is never silent.
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
 * Pure projection from the user's `clawdius.cli.*` settings (+ on-disk existence of the paths they name)
 * onto a {@link IClawdiusCliResolution}. Deterministic, synchronous, network-free, spawn-free — the
 * resolver service does the async existence checks and hands the booleans in. Resolution rules:
 *  1. `wrapperPath` set -> native-binary requested -> NOT supported yet -> `bundled` + `unsupportedReason`.
 *  2. `nodeCliPath` set, exists, and is a JS entrypoint -> `userCli` (path wiring only; no probe/spawn).
 *  3. `nodeCliPath` set but missing / not a JS entrypoint -> `bundled` + `unsupportedReason`.
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
	if (wrapperPath) {
		return {
			...base,
			mode: 'bundled',
			unsupportedReason: `clawdius.cli.wrapperPath ('${wrapperPath}') selects a native-binary / wrapper-script engine, which is not supported yet (a planned raw stream-json adapter); using the bundled engine.`,
		};
	}

	const nodeCliPath = settings.nodeCliPath?.trim();
	if (nodeCliPath) {
		if (existence.nodeCliPathExists && JS_ENTRYPOINT.test(nodeCliPath)) {
			return { ...base, mode: 'userCli', pathToClaudeCodeExecutable: nodeCliPath };
		}
		return {
			...base,
			mode: 'bundled',
			unsupportedReason: `clawdius.cli.nodeCliPath ('${nodeCliPath}') was not found or is not a JS entrypoint (.js/.mjs/.cjs); using the bundled engine.`,
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
