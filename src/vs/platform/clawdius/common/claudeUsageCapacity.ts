/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN subscription-capacity refresh service contract (#94)
// Contract for the on-demand /api/oauth/usage capacity refresh, run ON THE HOST that owns the user's ~/.claude.
// In a WSL/SSH remote window the REH server implements this (node) and the renderer drives it over the
// remote-agent connection; in a local window the clawdius-chat extension performs the same fetch (the
// deliberate mirror noted in claudeUsageCapacityService.ts). On-demand only - zero uninitiated egress.

import { createDecorator } from '../../instantiation/common/instantiation.js';

/** IPC channel name for the capacity refresh service (registered on the REH server, consumed by the renderer). */
export const ClaudeUsageCapacityChannelName = 'clawdiusUsageCapacity';

export const IClaudeUsageCapacityService = createDecorator<IClaudeUsageCapacityService>('claudeUsageCapacityService');

export interface IClaudeUsageCapacityService {
	readonly _serviceBrand: undefined;
	/**
	 * Refresh the cached subscription limits at `<homeDirPath>/.claude/.clawdius-usage-cache.json` by fetching
	 * GET /api/oauth/usage with the user's CLI OAuth token. Skips the fetch when the engine provider is not
	 * Anthropic, and (unless `force`) when the cache is younger than the 60s TTL. On-demand ONLY - this is the
	 * single allowed usage egress; there is no startup fetch and no background timer.
	 */
	refreshCapacity(homeDirPath: string, force: boolean): Promise<void>;
}
// CLAWDIUS-END
