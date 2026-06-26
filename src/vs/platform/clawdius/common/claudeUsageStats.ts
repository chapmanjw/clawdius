/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN transcript-derived usage stats service contract (#94)
// Service contract for the accurate, always-current usage stats aggregated from the raw Claude session
// transcripts (~/.claude/projects/**/*.jsonl) - the alternative to the engine's stats-cache.json, which only
// the interactive CLI recomputes and so goes stale for days. The node implementation runs in the agentHost
// utility process (off the UI thread; node streaming keeps memory flat over 100MB+ files) and maintains an
// incremental per-file cache. The renderer calls it over the agentHost IPC channel. All local file reads -
// ZERO egress.

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IClaudeStats } from './claudeUsageStatsModel.js';

/** IPC channel name for the usage stats service (registered in the agentHost process, consumed by the renderer). */
export const ClaudeUsageStatsChannelName = 'clawdiusUsageStats';

/** Outcome of an aggregation request. `ok` carries the merged stats; the rest explain why none were produced. */
export type UsageStatsStatus = 'ok' | 'unavailable' | 'error';

export interface IClaudeUsageStatsResult {
	readonly status: UsageStatsStatus;
	/** The merged, transcript-derived stats (present when status === 'ok'). */
	readonly stats?: IClaudeStats;
	/** When the aggregate was computed (epoch ms). */
	readonly computedAt?: number;
	/** Number of transcript files considered (for diagnostics). */
	readonly fileCount?: number;
	/** Human-readable detail for the non-ok statuses. */
	readonly message?: string;
}

export const IClaudeUsageStatsService = createDecorator<IClaudeUsageStatsService>('claudeUsageStatsService');

export interface IClaudeUsageStatsService {
	readonly _serviceBrand: undefined;
	/**
	 * Aggregate the transcripts under `<homeDirPath>/.claude/projects` into IClaudeStats, using + updating the
	 * incremental cache at `<homeDirPath>/.claude/.clawdius-usage-stats.json` (only changed/new files are
	 * re-parsed). No CancellationToken arg: tokens do not round-trip through the agentHost ProxyChannel, so the
	 * node side just runs to completion (a cold parse is a few seconds; warm is near-instant) and the renderer
	 * races its own timeout. Zero egress - local file reads only.
	 */
	getUsageStats(homeDirPath: string): Promise<IClaudeUsageStatsResult>;
}
// CLAWDIUS-END
