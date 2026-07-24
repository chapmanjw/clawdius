/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Workspace-trust gate (node)
// Host-side resolution of the workspace-trust state that drives the deny-by-default gate. Reads the forwarded
// trust config (populated by the workbench trust forwarder from VS Code's workspace-trust service) and resolves
// the trusted flag for a session. The canUseTool gate calls evaluateTrust (pure) + these helpers.

import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITrustState, TrustReason, UNTRUSTED } from '../../common/claudeTrust.js';
import { AgentHostWorkspaceTrustDenyByDefaultConfigKey, platformRootSchema } from '../../common/agentHostSchema.js';
import { AgentHostTrustConfigKey, AgentHostTrustKey, trustConfigSchema } from '../../common/trustConfigSchema.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';

/**
 * Resolve the trust STATE for a session from the forwarded trust config. Absent config => the opt-in
 * deny-by-default policy decides: dormant TRUSTED when off (the default, preserving current behaviour until a
 * trust source connects), or UNTRUSTED (fail closed) when on. A forwarded-but-schema-invalid config always fails
 * closed, so a malformed value cannot invert the deny-by-default posture.
 */
export function resolveTrustState(configurationService: IAgentConfigurationService, sessionUri: URI): ITrustState {
	// Session-first fail-closed: a trust value forwarded at the SESSION layer decides THIS session's trust. If it
	// is present but MALFORMED, fail closed for the session rather than letting getEffectiveValue skip it and
	// silently inherit a (valid) root value - a per-session value that was forwarded but validated away must
	// never inherit trust from another layer.
	const rawSession = configurationService.getSessionConfigValues(sessionUri.toString());
	const sessionTrustRaw = rawSession?.[AgentHostTrustConfigKey.Trust];
	if (sessionTrustRaw !== undefined) {
		// validate() is a boolean type-guard (narrows to ITrustConfigValue) - a malformed value returns false.
		if (trustConfigSchema.validate(AgentHostTrustConfigKey.Trust, sessionTrustRaw)) {
			return { trusted: sessionTrustRaw[AgentHostTrustKey.Trusted] === true };
		}
		return UNTRUSTED;
	}

	// No session-layer value: resolve from the remaining chain (parent subagent -> root).
	const trust = configurationService.getEffectiveValue(sessionUri.toString(), trustConfigSchema, AgentHostTrustConfigKey.Trust);
	if (trust !== undefined) {
		return { trusted: trust[AgentHostTrustKey.Trusted] === true };
	}
	// getEffectiveValue is undefined for a truly-absent config AND a present-but-schema-invalid ROOT value. A
	// root value that WAS forwarded but validated away must FAIL CLOSED rather than fall back to dormant-trusted.
	if (hasRawTrustKey(configurationService, sessionUri)) {
		return UNTRUSTED;
	}
	// Truly absent: no trust source has connected yet. The opt-in deny-by-default policy (forwarded to root by the
	// agent-host clients, default off) decides whether this dormant state fails closed or preserves the legacy
	// dormant-trusted behaviour. Off => dormant TRUSTED (unchanged); on => UNTRUSTED, so a surface a trust decision
	// never reached (e.g. a remote root the window-wide trust forwarder does not push to) fails closed.
	return isDenyByDefaultEnabled(configurationService) ? UNTRUSTED : { trusted: true };
}

/**
 * Whether the opt-in deny-by-default policy is enabled. Read from the root config (forwarded there by the local
 * and remote agent-host clients from the `clawdius.agent.workspaceTrust.denyByDefault` setting). Default off, so
 * an absent/false value preserves the legacy dormant-trusted behaviour.
 */
function isDenyByDefaultEnabled(configurationService: IAgentConfigurationService): boolean {
	return configurationService.getRootValue(platformRootSchema, AgentHostWorkspaceTrustDenyByDefaultConfigKey) === true;
}

/**
 * Resolve whether a session's working directory is TRUSTED (for the buildOptions reachability clamp). Delegates to
 * {@link resolveTrustState} so the two never diverge.
 */
export function resolveTrusted(configurationService: IAgentConfigurationService, sessionUri: URI): boolean {
	return resolveTrustState(configurationService, sessionUri).trusted;
}

/** Whether a raw (possibly malformed) trust key sits at the root or session layer. */
function hasRawTrustKey(configurationService: IAgentConfigurationService, sessionUri: URI): boolean {
	const rawRoot = configurationService.getRootConfigValues();
	const rawSession = configurationService.getSessionConfigValues(sessionUri.toString());
	return !!((rawRoot && rawRoot[AgentHostTrustConfigKey.Trust] !== undefined) ||
		(rawSession && rawSession[AgentHostTrustConfigKey.Trust] !== undefined));
}

/**
 * Whether ANY trust value has been forwarded for this session: a validated effective value at some layer, or a
 * raw (possibly malformed) trust key at the root or session layer. When false, no trust source has connected
 * yet and {@link resolveTrustState} is reporting the dormant default rather than a real trust decision.
 */
export function isTrustForwarded(configurationService: IAgentConfigurationService, sessionUri: URI): boolean {
	return configurationService.getEffectiveValue(sessionUri.toString(), trustConfigSchema, AgentHostTrustConfigKey.Trust) !== undefined
		|| hasRawTrustKey(configurationService, sessionUri);
}

/** Bounded wait for {@link whenTrustForwarded}: long enough for a window's first trust dispatch to land after
 *  the agent host connects, short enough that a topology with no trust source attached does not visibly stall
 *  session startup. */
export const TRUST_FORWARD_TIMEOUT_MS = 3000;

/**
 * Materialize barrier. Callers that resolve trust ONCE and bake it into long-lived SDK options must not act on
 * a transiently-absent trust config (a trust source connected, first write still in flight). Resolves 'present'
 * immediately when a trust value is already forwarded for `sessionUri`; 'forwarded' when one arrives while
 * waiting (a root- or session-layer write); 'timeout' after `timeoutMs` with nothing forwarded (the caller
 * proceeds with the dormant default); 'aborted' when `signal` fires first.
 */
export async function whenTrustForwarded(
	configurationService: IAgentConfigurationService,
	sessionUri: URI,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<'present' | 'forwarded' | 'timeout' | 'aborted'> {
	if (isTrustForwarded(configurationService, sessionUri)) {
		return 'present';
	}
	if (signal?.aborted) {
		return 'aborted';
	}
	const store = new DisposableStore();
	try {
		return await new Promise<'forwarded' | 'timeout' | 'aborted'>(resolve => {
			const timer = setTimeout(() => resolve('timeout'), timeoutMs);
			store.add(toDisposable(() => clearTimeout(timer)));
			const recheck = () => {
				if (isTrustForwarded(configurationService, sessionUri)) {
					resolve('forwarded');
				}
			};
			store.add(configurationService.onDidRootConfigChange(recheck));
			store.add(configurationService.onDidSessionConfigChange(changed => {
				if (changed.session === sessionUri.toString()) {
					recheck();
				}
			}));
			if (signal) {
				const onAbort = () => resolve('aborted');
				signal.addEventListener('abort', onAbort, { once: true });
				store.add(toDisposable(() => signal.removeEventListener('abort', onAbort)));
			}
		});
	} finally {
		store.dispose();
	}
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
