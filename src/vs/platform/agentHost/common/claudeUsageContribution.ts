/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN usage-contribution fetch (#usage)
// Service contract for fetching the engine's verbatim "What's contributing to your limits usage?" text. The
// engine delivers it as a one-shot `local_command_output` from the `/usage` command (the same content Clawdius
// surfaces in the native chat). The node implementation runs in the agentHost utility process and captures it
// via a short-lived SDK session; the renderer calls it over the agentHost IPC channel to render it on the
// Control Center Usage dashboard (a collapsed sub-section under the heatmap). On-demand only (dashboard open /
// Refresh) - a session spawn, no model turn.

import { createDecorator } from '../../instantiation/common/instantiation.js';

/** IPC channel name for the usage-contribution service (registered in the agentHost process, consumed by the renderer). */
export const ClaudeUsageContributionChannelName = 'clawdiusUsageContribution';

export interface IClaudeUsageContributionResult {
	/** The verbatim engine text (markdown), or undefined when there is nothing to show. */
	readonly text: string | undefined;
	/**
	 * `ok`: text captured. `empty`: the command ran but produced no local_command_output (older engine).
	 * `timeout`: the session did not respond in time. `error`: the spawn/command failed. `disabled`: the agent
	 * host is off. The dashboard shows the section only for `ok`.
	 */
	readonly status: 'ok' | 'empty' | 'timeout' | 'error' | 'disabled';
}

export const IClaudeUsageContributionService = createDecorator<IClaudeUsageContributionService>('claudeUsageContributionService');

export interface IClaudeUsageContributionService {
	readonly _serviceBrand: undefined;
	/**
	 * Spawn a short-lived SDK session rooted at `workingDirectoryPath`, run `/usage`, and return the engine's
	 * contribution text. Never rejects: any failure resolves to a non-`ok` status so the dashboard omits the
	 * section. No CancellationToken arg (tokens don't round-trip the agentHost ProxyChannel); the node side
	 * self-caps and the renderer can race its own timeout.
	 */
	fetchUsageContribution(workingDirectoryPath: string): Promise<IClaudeUsageContributionResult>;
}
// CLAWDIUS-END
