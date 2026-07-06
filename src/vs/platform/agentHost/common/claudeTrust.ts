/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Workspace-trust decision model
// The pure, deny-by-default trust decision the host gate enforces: given a trust state and the SURFACE a tool call
// touches (read / write / shell / mcp / url / other), decide proceed | deny. This lives in
// platform/agentHost/common (not workbench) because the NODE gate enforces it - platform cannot import workbench,
// and a bug here is a security hole, so it is pure and unit-tested in isolation. Fail-closed is the rule: anything
// that cannot be positively classified as safe, in an untrusted workspace, denies. A trusted workspace grants full
// write access (matching VS Code's binary workspace trust); an untrusted one denies writes, shell, MCP, and URLs.

/** The trust state for a session's working directory. `trusted` gates writes + shell / MCP / URL / other tools. */
export interface ITrustState {
	readonly trusted: boolean;
}

/** The fail-closed default: returned whenever trust cannot be positively resolved (forwarded-but-malformed). */
export const UNTRUSTED: ITrustState = Object.freeze({ trusted: false });

/** What a tool call touches, for the trust decision. Reads are always safe; the rest are gated on the trust flag. */
export type TrustSurface =
	| { readonly kind: 'read' }
	| { readonly kind: 'write' }
	| { readonly kind: 'shell' }
	| { readonly kind: 'mcp'; readonly server: string | undefined }
	| { readonly kind: 'url' }
	| { readonly kind: 'tool'; readonly name: string };

export type TrustClass = 'proceed' | 'deny';

/** Why a call was denied - carried into the inline DENY card. */
export type TrustReason =
	| 'untrusted-write'
	| 'untrusted-shell'
	| 'untrusted-mcp'
	| 'untrusted-url'
	| 'untrusted-tool';

export interface ITrustDecision {
	/** `proceed`: the trust tier permits the call to CONTINUE to the sandbox/session/prompt pipeline (NOT that it
	 *  is approved). `deny`: hard-denied here. */
	readonly cls: TrustClass;
	readonly reason?: TrustReason;
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'BashOutput', 'KillBash', 'KillShell']);
const URL_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch']);

/**
 * Classify a tool call into the {@link TrustSurface} it touches. Pure name-based mapping (no host imports), so
 * both the node gate and the Trust tab agree. An unrecognised tool is a `tool` surface - gated as untrusted-other,
 * so a new/unknown tool fails closed rather than slipping through.
 */
export function surfaceForToolCall(toolName: string): TrustSurface {
	if (toolName.startsWith('mcp__')) { return { kind: 'mcp', server: toolName.split('__')[1] || undefined }; }
	if (READ_TOOLS.has(toolName)) { return { kind: 'read' }; }
	if (WRITE_TOOLS.has(toolName)) { return { kind: 'write' }; }
	if (SHELL_TOOLS.has(toolName)) { return { kind: 'shell' }; }
	if (URL_TOOLS.has(toolName)) { return { kind: 'url' }; }
	return { kind: 'tool', name: toolName };
}

/**
 * The deny-by-default trust decision. Reads always proceed (you must read a repo before deciding to trust it, and
 * there is no egress in an untrusted workspace). Writes, shell, MCP, URL, and other tools proceed only when the
 * workspace is trusted; otherwise they hard-deny. A trusted workspace grants full write access.
 */
export function evaluateTrust(state: ITrustState, surface: TrustSurface): ITrustDecision {
	switch (surface.kind) {
		case 'read':
			return { cls: 'proceed' };
		case 'write':
			return state.trusted ? { cls: 'proceed' } : { cls: 'deny', reason: 'untrusted-write' };
		case 'shell':
			return state.trusted ? { cls: 'proceed' } : { cls: 'deny', reason: 'untrusted-shell' };
		case 'mcp':
			return state.trusted ? { cls: 'proceed' } : { cls: 'deny', reason: 'untrusted-mcp' };
		case 'url':
			return state.trusted ? { cls: 'proceed' } : { cls: 'deny', reason: 'untrusted-url' };
		case 'tool':
			return state.trusted ? { cls: 'proceed' } : { cls: 'deny', reason: 'untrusted-tool' };
		default:
			return { cls: 'deny', reason: 'untrusted-tool' }; // fail closed on an unknown surface
	}
}
// CLAWDIUS-END
