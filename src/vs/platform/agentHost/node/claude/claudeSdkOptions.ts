/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { delimiter, dirname } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { IClawdiusCliResolution } from '../../../clawdius/common/clawdiusCliConfig.js';
import { createClaudeProcessWrapperSpawn } from './clawdiusCliSpawn.js';
import { ClaudePermissionMode } from '../../common/claudeSessionConfigKeys.js';
import { resolveClaudeEffort } from '../../common/claudeModelConfig.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { buildClientToolMcpServer } from './clientTools/claudeClientToolMcpServer.js';
import { IClaudeProxyHandle } from './claudeProxyService.js';
import { SessionClientToolsDiff } from './clientTools/claudeSessionClientToolsModel.js';

/**
 * Inputs to {@link buildOptions} that vary per startup. Pure-data: no
 * services, no live event subscribers. The function is a deterministic
 * projection from this bag plus a {@link IClaudeProxyHandle} onto the
 * SDK's {@link Options} discriminated union.
 */
export interface IBuildOptionsInput {
	readonly sessionId: string;
	readonly workingDirectory: URI;
	readonly model: ModelSelection | undefined;
	readonly abortController: AbortController;
	readonly permissionMode: ClaudePermissionMode;
	readonly canUseTool: NonNullable<Options['canUseTool']>;
	readonly isResume: boolean;
	readonly mcpServers: Record<string, McpSdkServerConfigWithInstance> | undefined;
	/**
	 * SDK-prefixed tool names to auto-approve without prompting (projected
	 * onto `Options.allowedTools`). Used for the agent host's feedback server
	 * tools, which only touch the session's annotations channel and are always
	 * safe. Omitted from the returned options when empty so the SDK keeps its
	 * default.
	 */
	readonly allowedTools?: readonly string[];
	/**
	 * Local plugin directories to load at SDK startup. Projected onto
	 * `Options.plugins` as `{ type: 'local', path }`. Omitted from the
	 * returned options entirely when empty so the SDK keeps its default
	 * (no plugins). Built per-session from
	 * {@link SessionClientCustomizationsDiff.consume}.
	 */
	readonly plugins?: readonly URI[];
	/**
	 * Resolved SDK agent name (matches a key in `Options.agents`, or an
	 * agent loaded from `~/.claude/agents/**`). Projected onto
	 * `Options.agent` — the SDK's `--agent` flag. The plugin URI captured
	 * at startup is the only path the SDK consults, so any `changeAgent`
	 * after materialize triggers a yield-restart through the rematerializer.
	 * Omit when no custom agent is selected (SDK default behavior).
	 */
	readonly agent?: string;
	// CLAWDIUS-BEGIN cli backend resolution
	/**
	 * The resolved Claude Code engine to launch (the bundled SDK cli.js vs the user's installed cli.js) plus
	 * its environment overlay, from {@link IClawdiusCliConfigService}. Projected onto `executable` /
	 * `pathToClaudeCodeExecutable` / `env`. Resolved fresh by the caller at each materialize / rematerialize.
	 */
	readonly cliResolution: IClawdiusCliResolution;
	// CLAWDIUS-END
}

/**
 * Build the SDK {@link Options} bag for a Claude session startup.
 * Deterministic over its declared inputs plus three ambient reads:
 *   1. `process.env.PATH` (composed into `Options.settings.env.PATH`
 *      so ripgrep wins over any system install),
 *   2. `process.env` keys via {@link buildSubprocessEnv} (used to
 *      strip `VSCODE_*` / `ELECTRON_*` / `NODE_OPTIONS` /
 *      `ANTHROPIC_API_KEY` from the spawn env),
 *   3. the memoized `rgDiskPath()` lookup.
 * The returned options carry the caller-supplied `abortController` so a
 * racing dispose unwinds `sdk.startup()` cleanly.
 *
 * Used by both the initial materialize and the yield-restart rematerialize
 * — both call sites pass a freshly-built `mcpServers` snapshot consumed
 * from the session's {@link SessionClientToolsDiff}.
 */
export async function buildOptions(
	input: IBuildOptionsInput,
	// CLAWDIUS-BEGIN native ~/.claude auth: handle is undefined in Clawdius mode (no CAPI proxy); the SDK subprocess then authenticates via ~/.claude OAuth like the claude CLI
	proxyHandle: IClaudeProxyHandle | undefined,
	// CLAWDIUS-END
	logStderr: (data: string) => void,
	logElicitation: (msg: string) => void,
): Promise<Options> {
	// CLAWDIUS-BEGIN native ~/.claude auth: only strip ANTHROPIC_API_KEY when proxying
	const subprocessEnv = buildSubprocessEnv(proxyHandle !== undefined);
	// CLAWDIUS-END
	const resolvedRgDiskPath = await rgDiskPath();
	const settingsEnv: Record<string, string> = {
		// CLAWDIUS-BEGIN native ~/.claude auth: only redirect to the local CAPI proxy when a handle exists
		...(proxyHandle ? {
			ANTHROPIC_BASE_URL: proxyHandle.baseUrl,
			ANTHROPIC_AUTH_TOKEN: `${proxyHandle.nonce}.${input.sessionId}`,
		} : {}),
		// CLAWDIUS-END
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		USE_BUILTIN_RIPGREP: '0',
		PATH: `${dirname(resolvedRgDiskPath)}${delimiter}${process.env.PATH ?? ''}`,
	};

	return {
		cwd: input.workingDirectory.fsPath,
		// CLAWDIUS-BEGIN cli backend resolution
		// Map the resolved runtime: 'node' -> the current binary (Electron-as-node via ELECTRON_RUN_AS_NODE,
		// which preserves the bundled vendored-cli.js behavior); bun/deno pass through. In userCli mode point
		// the SDK at the user's installed cli.js. The env overlay carries provider-preset + user env vars.
		executable: input.cliResolution.executable === 'node' ? (process.execPath as 'node') : input.cliResolution.executable,
		...(input.cliResolution.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: input.cliResolution.pathToClaudeCodeExecutable } : {}),
		// subprocessEnv MUST win over the user overlay so a clawdius.cli.environmentVariables entry can never
		// reintroduce a scrubbed reserved key (NODE_OPTIONS / ELECTRON_* / VSCODE_* / proxy-mode
		// ANTHROPIC_API_KEY) that would break the Electron-as-node Claude subprocess.
		env: { ...input.cliResolution.extraEnv, ...subprocessEnv },
		// Enterprise wrapper mode: route the engine launch through the user's wrapper (which injects
		// auth / proxy / provider / policy). The SDK calls this instead of its default local spawn.
		...(input.cliResolution.wrapperPath ? { spawnClaudeCodeProcess: createClaudeProcessWrapperSpawn(input.cliResolution.wrapperPath) } : {}),
		// CLAWDIUS-END
		abortController: input.abortController,
		// CLAWDIUS-BEGIN respect the permission mode instead of always skipping
		// Was hardcoded `true`, which silently overrode the "Approvals" / permissionMode setting and
		// auto-approved EVERY tool, so no Allow/Deny ever surfaced in the native chat. Per the SDK contract
		// (sdk.d.ts: only `bypassPermissions` "Bypass all permission checks (requires
		// allowDangerouslySkipPermissions)"), ONLY that mode sets this flag. `dontAsk` means "don't prompt,
		// DENY if not pre-approved" (an auto-DENY path, sdk.d.ts), so it must NOT skip-and-run; letting it set
		// this flag would re-open the auto-approve hole. default/acceptEdits/plan/auto/dontAsk all defer to the
		// SDK's canUseTool + permissionMode gate (honoring ~/.claude allow-rules via settingSources below).
		allowDangerouslySkipPermissions: input.permissionMode === 'bypassPermissions',
		// CLAWDIUS-END
		canUseTool: input.canUseTool,
		onElicitation: async req => {
			logElicitation(req.message ?? '');
			return { action: 'cancel' };
		},
		disallowedTools: ['WebSearch'],
		includePartialMessages: true,
		forwardSubagentText: true,
		enableFileCheckpointing: true,
		model: input.model?.id,
		effort: resolveClaudeEffort(input.model),
		permissionMode: input.permissionMode,
		...(input.isResume
			? { resume: input.sessionId }
			: { sessionId: input.sessionId }),
		...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
		...(input.allowedTools && input.allowedTools.length > 0 ? { allowedTools: [...input.allowedTools] } : {}),
		...(input.plugins && input.plugins.length > 0
			? { plugins: input.plugins.map(p => ({ type: 'local' as const, path: p.fsPath })) }
			: {}),
		...(input.agent ? { agent: input.agent } : {}),
		settingSources: ['user', 'project', 'local'],
		settings: { env: settingsEnv },
		systemPrompt: { type: 'preset', preset: 'claude_code' },
		stderr: logStderr,
	};
}

/**
 * Consume the diff (clears its dirty bit) and build the in-process MCP
 * server config from the resulting tool snapshot. Resolves to
 * `undefined` when the snapshot is empty so `Options.mcpServers` is
 * omitted entirely and the SDK keeps its default.
 *
 * On builder throw the caller is responsible for re-marking the diff
 * dirty (the diff has already been consumed). See
 * {@link SessionClientToolsDiff.markDirty}.
 */
export async function buildClientMcpServers(
	toolDiff: SessionClientToolsDiff,
	registry: PendingRequestRegistry<CallToolResult>,
	sdkService: IClaudeAgentSdkService,
): Promise<Record<string, McpSdkServerConfigWithInstance> | undefined> {
	const { tools } = toolDiff.consume();
	if (!tools || tools.length === 0) {
		return undefined;
	}
	const server = await buildClientToolMcpServer(tools, id => registry.register(id), sdkService);
	return { client: server };
}

/**
 * Build the {@link Options.env} payload for the Claude subprocess.
 *
 * The agent host runs in an Electron utility process; the spawn env
 * inherits the parent's env which contains `NODE_OPTIONS`,
 * `ELECTRON_*`, and `VSCODE_*` variables that break the Claude
 * subprocess (it's a plain Node script driven by Electron's
 * `process.execPath` + `ELECTRON_RUN_AS_NODE`). Strip them via
 * {@link Options.env} `undefined` semantics (sdk.d.ts:1075-1078:
 * "Set a key to `undefined` to remove an inherited variable").
 *
 * Mirror of CopilotAgent's strip pattern at copilotAgent.ts:434-450.
 *
 * Exported for unit testing as a pure function over `process.env`.
 */
export function buildSubprocessEnv(stripAnthropicApiKey: boolean = true): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		ELECTRON_RUN_AS_NODE: '1',
		NODE_OPTIONS: undefined,
		// CLAWDIUS-BEGIN native ~/.claude auth: only strip the key when routing through the CAPI proxy; native OAuth mode keeps the inherited env intact
		...(stripAnthropicApiKey ? { ANTHROPIC_API_KEY: undefined } : {}),
		// CLAWDIUS-END
	};
	for (const key of Object.keys(process.env)) {
		if (key === 'ELECTRON_RUN_AS_NODE') { continue; }
		if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
			env[key] = undefined;
		}
	}
	return env;
}
