/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Workspace-trust decision model
// The pure, deny-by-default trust decision the host gate enforces: given a trust state and the SURFACE a tool
// call touches (read / write / shell / mcp / url / other), decide proceed | deny | needs-write-scope. This lives
// in platform/agentHost/common (not workbench) because the NODE gate enforces it - platform cannot import
// workbench, and a bug here is a security hole, so it is pure and unit-tested in isolation. Fail-closed is the
// rule: anything that cannot be positively classified as safe, in an untrusted workspace, denies.

/** The trust state for a session's working directory. `trusted` gates shell/MCP/URL/other tools; `writeRoots`
 *  (canonical absolute dirs, realpath-resolved by the node caller) gate file writes. Untrusted = both empty. */
export interface ITrustState {
	readonly trusted: boolean;
	readonly writeRoots: readonly string[];
}

/** The fail-closed default: returned whenever trust cannot be resolved (absent, malformed, no working dir). */
export const UNTRUSTED: ITrustState = Object.freeze({ trusted: false, writeRoots: Object.freeze([]) as readonly string[] });

/** What a tool call touches, for the trust decision. Reads are always safe; writes are scope-checked; the rest
 *  are gated on the trust flag. */
export type TrustSurface =
	| { readonly kind: 'read' }
	| { readonly kind: 'write'; readonly path: string | undefined }
	| { readonly kind: 'shell' }
	| { readonly kind: 'mcp'; readonly server: string | undefined }
	| { readonly kind: 'url' }
	| { readonly kind: 'tool'; readonly name: string };

export type TrustClass = 'proceed' | 'deny' | 'needs-write-scope';

/** Why a call was denied / needs a scope check - carried into the inline DENY card. */
export type TrustReason =
	| 'untrusted-write'
	| 'out-of-scope-write'
	| 'untrusted-shell'
	| 'untrusted-mcp'
	| 'untrusted-url'
	| 'untrusted-tool'
	| 'no-working-directory';

export interface ITrustDecision {
	/** `proceed`: the trust tier permits the call to CONTINUE to the sandbox/session/prompt pipeline (NOT that it
	 *  is approved). `deny`: hard-denied here. `needs-write-scope`: the gate must check the path against writeRoots. */
	readonly cls: TrustClass;
	readonly reason?: TrustReason;
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'BashOutput', 'KillBash', 'KillShell']);
const URL_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch']);

/** The write path an editing tool targets, from its input bag (`file_path` / `path` / `notebook_path`). */
function writePathOf(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) { return undefined; }
	const bag = input as Record<string, unknown>;
	for (const key of ['file_path', 'path', 'notebook_path']) {
		if (typeof bag[key] === 'string' && (bag[key] as string).length > 0) { return bag[key] as string; }
	}
	return undefined;
}

/**
 * Classify a tool call into the {@link TrustSurface} it touches. Pure name-based mapping (no host imports), so
 * both the node gate and the Trust tab agree. An unrecognised tool is a `tool` surface - gated as untrusted-other,
 * so a new/unknown tool fails closed rather than slipping through.
 */
export function surfaceForToolCall(toolName: string, input: unknown): TrustSurface {
	if (toolName.startsWith('mcp__')) { return { kind: 'mcp', server: toolName.split('__')[1] || undefined }; }
	if (READ_TOOLS.has(toolName)) { return { kind: 'read' }; }
	if (WRITE_TOOLS.has(toolName)) { return { kind: 'write', path: writePathOf(input) }; }
	if (SHELL_TOOLS.has(toolName)) { return { kind: 'shell' }; }
	if (URL_TOOLS.has(toolName)) { return { kind: 'url' }; }
	return { kind: 'tool', name: toolName };
}

/**
 * The deny-by-default trust decision. Reads always proceed (you must read a repo before deciding to trust it, and
 * there is no egress in an untrusted workspace). Writes need a scope check when there are writable roots, else
 * deny. Shell / MCP / URL / other proceed only when the workspace is trusted; otherwise they hard-deny.
 */
export function evaluateTrust(state: ITrustState, surface: TrustSurface): ITrustDecision {
	switch (surface.kind) {
		case 'read':
			return { cls: 'proceed' };
		case 'write':
			// Defense-in-depth: require BOTH trusted AND writable roots, so a malformed untrusted-but-with-roots
			// state still hard-denies rather than softening to a scope check.
			return (state.trusted && state.writeRoots.length > 0) ? { cls: 'needs-write-scope' } : { cls: 'deny', reason: 'untrusted-write' };
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
