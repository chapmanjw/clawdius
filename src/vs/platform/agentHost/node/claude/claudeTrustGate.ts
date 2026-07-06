/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Workspace-trust gate (node)
// Host-side resolution of the workspace-trust state that drives the deny-by-default gate. Reads the forwarded
// trust config (populated by the workbench trust forwarder from VS Code's workspace-trust service) and resolves
// the trusted flag for a session. The in-scope write check + the canUseTool gate build on this.

import { URI } from '../../../../base/common/uri.js';
import { AgentHostTrustConfigKey, AgentHostTrustKey, trustConfigSchema } from '../../common/trustConfigSchema.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';

/**
 * Resolve whether a session's working directory is TRUSTED, from the forwarded trust config. Defaults to trusted
 * when no trust source has populated the config yet (preserving current behaviour); an explicit forwarded
 * `trusted: false` activates the deny-by-default reachability clamp + gate.
 */
export function resolveTrusted(configurationService: IAgentConfigurationService, sessionUri: URI): boolean {
	const trust = configurationService.getEffectiveValue(sessionUri.toString(), trustConfigSchema, AgentHostTrustConfigKey.Trust);
	return trust?.[AgentHostTrustKey.Trusted] ?? true;
}
// CLAWDIUS-END
