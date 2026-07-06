/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Workspace-trust gate (node)
// Host-side resolution of the workspace-trust state that drives the deny-by-default gate. Reads the forwarded
// trust config (populated by the workbench trust forwarder from VS Code's workspace-trust service), resolves the
// trusted flag + write roots for a session, and checks a write path against those roots with the shared,
// symlink-following canonicalizer. The canUseTool gate calls evaluateTrust (pure) + these helpers.

import { extUriBiasedIgnorePathCase, normalizePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ITrustState, TrustReason, UNTRUSTED } from '../../common/claudeTrust.js';
import { AgentHostTrustConfigKey, AgentHostTrustKey, trustConfigSchema } from '../../common/trustConfigSchema.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { assertPathIsSafe, resolveRealPathForNonexistent } from '../writePathCanonicalization.js';

/**
 * Resolve the full trust STATE (trusted flag + write roots) for a session from the forwarded trust config. Absent
 * config => dormant: trusted, with the working directory writable (preserving current behaviour until a trust
 * source connects). An explicit config fails closed on a missing/false `trusted` flag.
 */
export function resolveTrustState(configurationService: IAgentConfigurationService, sessionUri: URI, workingDirectory: URI | undefined): ITrustState {
	const trust = configurationService.getEffectiveValue(sessionUri.toString(), trustConfigSchema, AgentHostTrustConfigKey.Trust);
	if (trust !== undefined) {
		return {
			trusted: trust[AgentHostTrustKey.Trusted] === true,
			writeRoots: (trust[AgentHostTrustKey.WriteRoots] ?? []).filter((r): r is string => typeof r === 'string'),
		};
	}
	// getEffectiveValue is undefined for BOTH a truly-absent config AND a present-but-schema-invalid one. A trust
	// value that WAS forwarded but validated away must FAIL CLOSED (untrusted) rather than fall back to
	// dormant-trusted - otherwise a malformed config would invert the deny-by-default posture.
	const rawSession = configurationService.getSessionConfigValues(sessionUri.toString());
	if (rawSession && rawSession[AgentHostTrustConfigKey.Trust] !== undefined) {
		return UNTRUSTED;
	}
	// Truly absent: no trust source has connected yet - dormant, trusted, with the working directory writable.
	return { trusted: true, writeRoots: workingDirectory ? [workingDirectory.fsPath] : [] };
}

/**
 * Resolve whether a session's working directory is TRUSTED (just the flag, for the buildOptions reachability
 * clamp). Delegates to {@link resolveTrustState} so the two never diverge.
 */
export function resolveTrusted(configurationService: IAgentConfigurationService, sessionUri: URI): boolean {
	return resolveTrustState(configurationService, sessionUri, undefined).trusted;
}

/**
 * True when `targetPath` resolves (symlinks followed, even for a not-yet-created file) to a location at or under
 * one of the canonicalized write roots. Fail-closed: empty roots, an unsafe path (ADS / reserved / 8.3), or a
 * realpath failure all return false.
 */
export async function isWriteInScope(targetPath: string, writeRoots: readonly string[]): Promise<boolean> {
	if (writeRoots.length === 0) { return false; }
	let realTarget: URI;
	try {
		assertPathIsSafe(targetPath);
		realTarget = normalizePath(URI.file(await resolveRealPathForNonexistent(targetPath)));
	} catch {
		return false;
	}
	for (const root of writeRoots) {
		try {
			assertPathIsSafe(root);
			const realRoot = normalizePath(URI.file(await resolveRealPathForNonexistent(root)));
			if (extUriBiasedIgnorePathCase.isEqualOrParent(realTarget, realRoot)) {
				return true;
			}
		} catch {
			// Skip a malformed write root rather than throwing the whole check.
		}
	}
	return false;
}

/** A user-facing message for a trust denial, surfaced in the inline DENY card. */
export function trustDenyMessage(reason: TrustReason | undefined): string {
	switch (reason) {
		case 'untrusted-write': return 'Workspace not trusted: file writes are blocked. Trust the workspace to allow edits.';
		case 'out-of-scope-write': return 'Blocked: this path is outside the trusted write scope for this workspace.';
		case 'untrusted-shell': return 'Workspace not trusted: running commands is blocked.';
		case 'untrusted-mcp': return 'Workspace not trusted: MCP tools are blocked.';
		case 'untrusted-url': return 'Workspace not trusted: web access is blocked.';
		case 'untrusted-tool': return 'Workspace not trusted: this tool is blocked.';
		case 'no-working-directory': return 'No working directory is set, so this write is blocked.';
		default: return 'Blocked by workspace trust.';
	}
}
// CLAWDIUS-END
