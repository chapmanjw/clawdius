/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Workspace-trust config schema
// The persisted/forwarded `trust` object for the agent host. A host (today: the workbench client, via the trust
// forwarder) projects VS Code workspace-trust state into this bag; the node trust gate reads it to decide the
// deny-by-default posture. Mirrors sandboxConfigSchema.ts.

import { localize } from '../../../nls.js';
import { createSchema, schemaProperty } from './agentHostSchema.js';

/** Top-level key: all trust values live under a single nested `"trust": { ... }` object. */
export const enum AgentHostTrustConfigKey {
	Trust = 'trust',
}

/** Well-known sub-keys inside the agent host's `trust` object. */
export const enum AgentHostTrustKey {
	/** Whether the workspace is trusted. Absent => the gate defaults trusted (no trust source connected yet). */
	Trusted = 'trusted',
	/** Canonical absolute directories granted write access in a trusted workspace (empty => no writes). */
	WriteRoots = 'writeRoots',
}

/** Shape of the persisted/forwarded `trust` object. */
export type ITrustConfigValue = Partial<{
	[AgentHostTrustKey.Trusted]: boolean;
	[AgentHostTrustKey.WriteRoots]: string[];
}>;

/** Schema for the workspace-trust values a host may forward into the agent host's config bag. */
export const trustConfigSchema = createSchema({
	[AgentHostTrustConfigKey.Trust]: schemaProperty<ITrustConfigValue>({
		type: 'object',
		title: localize('agentHost.config.trust.title', "Workspace Trust"),
		properties: {
			[AgentHostTrustKey.Trusted]: {
				type: 'boolean',
				title: localize('agentHost.config.trust.trusted.title', "Workspace Trusted"),
			},
			[AgentHostTrustKey.WriteRoots]: {
				type: 'array',
				title: localize('agentHost.config.trust.writeRoots.title', "Trusted Write Roots"),
				items: { type: 'string', title: localize('agentHost.config.trust.writeRoots.item.title', "Path") },
			},
		},
	}),
});
// CLAWDIUS-END
