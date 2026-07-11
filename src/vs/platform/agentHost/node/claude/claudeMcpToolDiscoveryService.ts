/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN live MCP tool discovery (#93) - node implementation
// Runs in the agentHost utility process. Enumerates a configured MCP server's tools by opening a SHORT-LIVED
// Claude Agent SDK session and reading `query.mcpServerStatus()` (each McpServerStatus carries `tools[]` once
// the server connects). The SDK connects to remote servers with the user's ~/.claude creds, so this works for
// stdio AND remote servers without a hand-rolled MCP client. The session sends NO prompt (a non-yielding input
// iterable keeps it open while MCP connects, then we tear it down) - so no model turn, no token cost. Strictly
// user-initiated (the "Load tool names..." click); never on startup, never automatically.

import type { CanUseTool, SDKUserMessage, WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { timeout } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';
import { IClawdiusCliConfigService } from '../../../clawdius/common/clawdiusCliConfig.js';
import { IClaudeMcpTool, IClaudeMcpToolDiscoveryResult, IClaudeMcpToolDiscoveryService } from '../../common/claudeMcpToolDiscovery.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { buildOptions } from './claudeSdkOptions.js';
import { redactSecrets } from '../agentHostSecretRedact.js';

/** Total budget for one discovery: enough for a remote server to connect, capped so a hang cannot pin a process. */
const DISCOVERY_TIMEOUT_MS = 25_000;
/** Poll interval while the target server is still `pending`. */
const POLL_INTERVAL_MS = 600;

export class ClaudeMcpToolDiscoveryService implements IClaudeMcpToolDiscoveryService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IClaudeAgentSdkService private readonly sdkService: IClaudeAgentSdkService,
		@IClawdiusCliConfigService private readonly cliConfig: IClawdiusCliConfigService,
		@ILogService private readonly logService: ILogService,
	) { }

	async discoverServerTools(serverName: string, workingDirectoryPath: string): Promise<IClaudeMcpToolDiscoveryResult> {
		const abort = new AbortController();
		let warm: WarmQuery | undefined;
		try {
			const cliResolution = await this.cliConfig.resolveCliBackend();
			// The SDK never invokes tools here (we send no prompt); deny defensively so nothing can run.
			const denyTool: CanUseTool = async () => ({ behavior: 'deny', message: 'MCP tool discovery never executes tools' });
			const options = await buildOptions(
				{
					sessionId: generateUuid(),
					workingDirectory: URI.file(workingDirectoryPath),
					model: undefined,
					abortController: abort,
					permissionMode: 'plan',
					trusted: true, // discovery never runs a governed tool, so the trust clamp is moot here
					canUseTool: denyTool,
					isResume: false,
					mcpServers: undefined,
					cliResolution,
				},
				data => this.logService.trace(`[mcp-discovery stderr] ${redactSecrets(data)}`),
				msg => this.logService.trace(`[mcp-discovery] declined elicitation: ${msg}`),
			);

			warm = await this.sdkService.startup({ options });

			// Bind a query whose input never yields: the session stays open while MCP servers connect, but no
			// prompt is ever sent, so the model is never called.
			const query = warm.query(this.neverYield(abort.signal));

			const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const servers = await query.mcpServerStatus();
				const server = servers.find(s => s.name === serverName);
				if (!server) {
					return { status: 'not-found', tools: [], message: `MCP server "${serverName}" is not configured for this scope.` };
				}
				if (server.status !== 'pending') {
					const tools: IClaudeMcpTool[] = (server.tools ?? []).map(t => ({ name: t.name, description: t.description }));
					return {
						status: server.status,
						tools,
						message: server.status === 'connected' ? undefined : `Server status: ${server.status}.`,
					};
				}
				await timeout(POLL_INTERVAL_MS);
			}
			return { status: 'timeout', tools: [], message: `Timed out connecting to "${serverName}".` };
		} catch (err) {
			this.logService.warn('[mcp-discovery] failed', err);
			return { status: 'error', tools: [], message: err instanceof Error ? err.message : String(err) };
		} finally {
			abort.abort();
			try {
				await warm?.[Symbol.asyncDispose]();
			} catch {
				// best-effort teardown of the short-lived session
			}
		}
	}

	/** An input stream that yields nothing and resolves only when the session is aborted. */
	private async *neverYield(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
		if (signal.aborted) { return; }
		await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
	}
}
// CLAWDIUS-END
