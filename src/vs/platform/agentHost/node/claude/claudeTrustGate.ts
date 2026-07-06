/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Workspace-trust gate (node)
// Host-side resolution of the workspace-trust state that drives the deny-by-default gate. Reads the forwarded
// trust config (populated by the workbench trust forwarder from VS Code's workspace-trust service) and resolves
// the trusted flag for a session. The canUseTool gate calls evaluateTrust (pure) + these helpers.

import { URI } from '../../../../base/common/uri.js';
import { ITrustState, TrustReason, UNTRUSTED } from '../../common/claudeTrust.js';
import { AgentHostTrustConfigKey, AgentHostTrustKey, trustConfigSchema } from '../../common/trustConfigSchema.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';

/**
 * Resolve the trust STATE for a session from the forwarded trust config. Absent config => dormant TRUSTED
 * (preserving current behaviour until a trust source connects). A forwarded-but-schema-invalid config fails closed
 * (untrusted), so a malformed value cannot invert the deny-by-default posture.
 */
export function resolveTrustState(configurationService: IAgentConfigurationService, sessionUri: URI): ITrustState {
	const trust = configurationService.getEffectiveValue(sessionUri.toString(), trustConfigSchema, AgentHostTrustConfigKey.Trust);
	if (trust !== undefined) {
		return { trusted: trust[AgentHostTrustKey.Trusted] === true };
	}
	// getEffectiveValue is undefined for BOTH a truly-absent config AND a present-but-schema-invalid one. A trust
	// value that WAS forwarded but validated away must FAIL CLOSED rather than fall back to dormant-trusted. Check
	// BOTH the root layer (where the forwarder writes it) AND the session layer, so a malformed value at either
	// cannot invert the deny-by-default posture.
	const rawRoot = configurationService.getRootConfigValues();
	const rawSession = configurationService.getSessionConfigValues(sessionUri.toString());
	if ((rawRoot && rawRoot[AgentHostTrustConfigKey.Trust] !== undefined) ||
		(rawSession && rawSession[AgentHostTrustConfigKey.Trust] !== undefined)) {
		return UNTRUSTED;
	}
	// Truly absent: no trust source has connected yet - dormant, trusted.
	return { trusted: true };
}

/**
 * Resolve whether a session's working directory is TRUSTED (for the buildOptions reachability clamp). Delegates to
 * {@link resolveTrustState} so the two never diverge.
 */
export function resolveTrusted(configurationService: IAgentConfigurationService, sessionUri: URI): boolean {
	return resolveTrustState(configurationService, sessionUri).trusted;
}

/** A user-facing message for a trust denial, surfaced in the inline DENY card. */
export function trustDenyMessage(reason: TrustReason | undefined): string {
	switch (reason) {
		case 'untrusted-write': return 'Workspace not trusted: file writes are blocked. Trust the workspace to allow edits.';
		case 'untrusted-shell': return 'Workspace not trusted: running commands is blocked.';
		case 'untrusted-mcp': return 'Workspace not trusted: MCP tools are blocked.';
		case 'untrusted-url': return 'Workspace not trusted: web access is blocked.';
		case 'untrusted-tool': return 'Workspace not trusted: this tool is blocked.';
		default: return 'Blocked by workspace trust.';
	}
}
// CLAWDIUS-END
