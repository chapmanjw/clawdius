/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN live MCP tool discovery (#93)
// Service contract for enumerating a configured MCP server's tools by briefly connecting to it through the
// Claude Agent SDK (the SDK auths remote servers with the user's ~/.claude creds, so this covers stdio AND
// remote servers without a hand-rolled MCP client). The node implementation runs in the agentHost utility
// process; the renderer calls it over the agentHost IPC channel. This is USER-INITIATED only (the Control
// Center "Load tool names..." click) - never on startup, never automatically - because connecting starts a
// short-lived engine session and may contact a remote server.

import { createDecorator } from '../../instantiation/common/instantiation.js';

/** IPC channel name for the discovery service (registered in the agentHost process, consumed by the renderer). */
export const ClaudeMcpToolDiscoveryChannelName = 'clawdiusMcpToolDiscovery';

/** A single tool reported by a connected MCP server. */
export interface IClaudeMcpTool {
	readonly name: string;
	readonly description?: string;
}

/** Terminal outcome of a discovery attempt. `connected` carries tools; the rest explain why none were read. */
export type McpDiscoveryStatus = 'connected' | 'failed' | 'needs-auth' | 'disabled' | 'untrusted' | 'not-found' | 'timeout' | 'error';

export interface IClaudeMcpToolDiscoveryResult {
	readonly status: McpDiscoveryStatus;
	readonly tools: readonly IClaudeMcpTool[];
	/** Human-readable detail for the non-connected statuses (shown to the user). */
	readonly message?: string;
}

export const IClaudeMcpToolDiscoveryService = createDecorator<IClaudeMcpToolDiscoveryService>('claudeMcpToolDiscoveryService');

export interface IClaudeMcpToolDiscoveryService {
	readonly _serviceBrand: undefined;
	/**
	 * Connect to the named MCP server (via a short-lived SDK session rooted at `workingDirectoryPath`, which
	 * scopes which project `.mcp.json` servers load) and return its tools. `trusted` is the caller's
	 * workspace-trust decision (the renderer owns trust): when false the service refuses (`untrusted`) without
	 * starting a session, so repo-controlled `.mcp.json` server commands never spawn. Resolves to a `connected` result
	 * with tools, or a non-connected status with a message. No CancellationToken arg: tokens do not round-trip
	 * through the agentHost ProxyChannel, so the node side self-caps (25s) and the renderer races its own
	 * timeout.
	 */
	discoverServerTools(serverName: string, workingDirectoryPath: string, trusted: boolean): Promise<IClaudeMcpToolDiscoveryResult>;
}
// CLAWDIUS-END
