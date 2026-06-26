/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN usage stats model (transcript-derived, pure)
// Pure, UI-free, fs-free logic that turns the raw Claude session transcripts (~/.claude/projects/**/*.jsonl)
// into the dashboard's IClaudeStats shape - the accurate, always-current alternative to the engine's
// stats-cache.json (which only the interactive CLI recomputes, so it goes stale for days). This is the same
// source ccusage aggregates. Two pieces:
//   - UsageFileAccumulator: fed one JSONL line at a time (the node service streams a file line-by-line, never
//     buffering the whole 100MB+ file), dedupes assistant messages by (message.id, requestId) - mandatory,
//     since streaming snapshots repeat a logical message many times with byte-identical usage - and emits a
//     per-file IUsageFilePartial.
//   - mergePartials: combines per-file partials (kept in the incremental cache, one per file) into IClaudeStats.
//     Cross-file dedup is unnecessary: each file is exactly one sessionId.
// The IClaudeStats family lives here (re-exported by the workbench usage data layer) so the platform node
// service and the renderer share one definition. Cost is never computed - usage tokens only.

// --- Dashboard stats shape (single source of truth; re-exported from the workbench usage data layer) --------

export interface IClaudeModelStat {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadInputTokens?: number;
	readonly cacheCreationInputTokens?: number;
	readonly webSearchRequests?: number;
}

export interface IClaudeDailyActivity {
	readonly date?: string;
	readonly messageCount?: number;
	readonly sessionCount?: number;
	readonly toolCallCount?: number;
}

/** Per-day per-model token totals (in + out; drives the Tokens-per-Day line chart). */
export interface IClaudeDailyModelTokens {
	readonly date?: string;
	readonly tokensByModel?: { readonly [model: string]: number };
}

/** The single longest session by wall-clock duration (ms). */
export interface IClaudeLongestSession {
	readonly sessionId?: string;
	readonly duration?: number;
	readonly messageCount?: number;
	readonly timestamp?: string;
}

export interface IClaudeStats {
	readonly modelUsage?: { readonly [model: string]: IClaudeModelStat };
	readonly dailyActivity?: ReadonlyArray<IClaudeDailyActivity>;
	readonly dailyModelTokens?: ReadonlyArray<IClaudeDailyModelTokens>;
	readonly hourCounts?: { readonly [hour: string]: number };
	readonly longestSession?: IClaudeLongestSession;
	readonly totalSessions?: number;
	readonly totalMessages?: number;
	readonly firstSessionDate?: string;
	readonly lastComputedDate?: string;
}

// --- Per-file partial aggregate (the unit cached per transcript file) ----------------------------------------

interface IModelTokens { input: number; output: number; cacheRead: number; cacheCreate: number; webSearch: number }

/** A file's contribution to the merged stats. Additive across files (one sessionId per file). JSON-friendly. */
export interface IUsageFilePartial {
	readonly sessionId?: string;
	/** A subagent transcript (under a `subagents/` dir): its tokens + activity count, but it is NOT its own
	 *  "session" (a user didn't start it) and never the longest session. Set by the service from the file path. */
	readonly isSubagent?: boolean;
	/** Deduped message count (assistant turns + user messages). */
	readonly messageCount: number;
	/** Min / max message timestamp in this file (epoch ms), for first-session-date + session duration. */
	readonly firstTsMs?: number;
	readonly lastTsMs?: number;
	readonly modelUsage: { [model: string]: IModelTokens };
	/** date (YYYY-MM-DD, local) -> model -> in+out tokens. */
	readonly dailyTokens: { [date: string]: { [model: string]: number } };
	/** date (YYYY-MM-DD, local) -> deduped message count. */
	readonly dailyMessages: { [date: string]: number };
	/** local hour (0..23 as string) -> message count. */
	readonly hourCounts: { [hour: string]: number };
}

function emptyModelTokens(): IModelTokens {
	return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, webSearch: 0 };
}

/** Local YYYY-MM-DD for an epoch-ms timestamp (the dashboard heatmap + charts are in local time). */
function localDateKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function asFiniteNumber(v: unknown): number {
	return typeof v === 'number' && isFinite(v) ? v : 0;
}

/**
 * Streaming accumulator for ONE transcript file. Feed it raw JSONL lines (in any order); call {@link finish} for
 * the file's partial. Dedupes assistant messages by (message.id, requestId) so a logical message counts once.
 */
export class UsageFileAccumulator {
	private readonly seenAssistant = new Set<string>();
	private sessionId: string | undefined;
	private messageCount = 0;
	private firstTsMs: number | undefined;
	private lastTsMs: number | undefined;
	private readonly modelUsage = new Map<string, IModelTokens>();
	private readonly dailyTokens = new Map<string, Map<string, number>>();
	private readonly dailyMessages = new Map<string, number>();
	private readonly hourCounts = new Map<string, number>();

	/** Parse + fold one JSONL line. Malformed lines and non-message bookkeeping lines are ignored. */
	addLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.charCodeAt(0) !== 0x7b /* '{' */) { return; }
		let o: Record<string, unknown>;
		try {
			o = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			return;
		}
		const type = o['type'];
		if (type !== 'assistant' && type !== 'user') { return; }
		if (typeof o['sessionId'] === 'string' && !this.sessionId) { this.sessionId = o['sessionId'] as string; }

		const tsRaw = o['timestamp'];
		const tsMs = typeof tsRaw === 'string' ? Date.parse(tsRaw) : NaN;
		const validTs = !isNaN(tsMs);
		const message = (o['message'] && typeof o['message'] === 'object') ? o['message'] as Record<string, unknown> : undefined;

		if (type === 'assistant') {
			// Dedup: streaming snapshots repeat the same (message.id, requestId) with identical usage.
			const id = message && typeof message['id'] === 'string' ? message['id'] as string : undefined;
			const reqId = typeof o['requestId'] === 'string' ? o['requestId'] as string : undefined;
			const key = id || reqId ? `${id ?? ''}::${reqId ?? ''}` : (typeof o['uuid'] === 'string' ? `u:${o['uuid']}` : undefined);
			if (key !== undefined) {
				if (this.seenAssistant.has(key)) { return; }
				this.seenAssistant.add(key);
			}
			const model = message && typeof message['model'] === 'string' ? message['model'] as string : undefined;
			const usage = message && message['usage'] && typeof message['usage'] === 'object' ? message['usage'] as Record<string, unknown> : undefined;
			if (model && usage) {
				const input = asFiniteNumber(usage['input_tokens']);
				const output = asFiniteNumber(usage['output_tokens']);
				const cacheRead = asFiniteNumber(usage['cache_read_input_tokens']);
				const cacheCreate = asFiniteNumber(usage['cache_creation_input_tokens']);
				const webSearch = usage['server_tool_use'] && typeof usage['server_tool_use'] === 'object'
					? asFiniteNumber((usage['server_tool_use'] as Record<string, unknown>)['web_search_requests']) : 0;
				const mu = this.modelUsage.get(model) ?? emptyModelTokens();
				mu.input += input; mu.output += output; mu.cacheRead += cacheRead; mu.cacheCreate += cacheCreate; mu.webSearch += webSearch;
				this.modelUsage.set(model, mu);
				if (validTs) {
					const dk = localDateKey(tsMs);
					const byModel = this.dailyTokens.get(dk) ?? new Map<string, number>();
					byModel.set(model, (byModel.get(model) ?? 0) + input + output);
					this.dailyTokens.set(dk, byModel);
				}
			}
		}

		// Count this (deduped) message toward totals + per-day + per-hour activity.
		this.messageCount++;
		if (validTs) {
			if (this.firstTsMs === undefined || tsMs < this.firstTsMs) { this.firstTsMs = tsMs; }
			if (this.lastTsMs === undefined || tsMs > this.lastTsMs) { this.lastTsMs = tsMs; }
			const dk = localDateKey(tsMs);
			this.dailyMessages.set(dk, (this.dailyMessages.get(dk) ?? 0) + 1);
			const hr = String(new Date(tsMs).getHours());
			this.hourCounts.set(hr, (this.hourCounts.get(hr) ?? 0) + 1);
		}
	}

	finish(): IUsageFilePartial {
		const modelUsage: { [model: string]: IModelTokens } = {};
		for (const [m, v] of this.modelUsage) { modelUsage[m] = v; }
		const dailyTokens: { [date: string]: { [model: string]: number } } = {};
		for (const [d, byModel] of this.dailyTokens) {
			const obj: { [model: string]: number } = {};
			for (const [m, n] of byModel) { obj[m] = n; }
			dailyTokens[d] = obj;
		}
		const dailyMessages: { [date: string]: number } = {};
		for (const [d, n] of this.dailyMessages) { dailyMessages[d] = n; }
		const hourCounts: { [hour: string]: number } = {};
		for (const [h, n] of this.hourCounts) { hourCounts[h] = n; }
		return {
			sessionId: this.sessionId,
			messageCount: this.messageCount,
			firstTsMs: this.firstTsMs,
			lastTsMs: this.lastTsMs,
			modelUsage,
			dailyTokens,
			dailyMessages,
			hourCounts,
		};
	}
}

/** Aggregate one file's full text (or line array) into a partial. Convenience for tests; the service streams. */
export function aggregateFile(lines: Iterable<string>): IUsageFilePartial {
	const acc = new UsageFileAccumulator();
	for (const line of lines) { acc.addLine(line); }
	return acc.finish();
}

// --- Merge partials -> IClaudeStats ---------------------------------------------------------------------------

/** Merge per-file partials into the dashboard's IClaudeStats. `todayKey` is the local YYYY-MM-DD at compute time. */
export function mergePartials(partials: ReadonlyArray<IUsageFilePartial>, todayKey: string): IClaudeStats {
	const modelUsage = new Map<string, IModelTokens>();
	const dailyTokens = new Map<string, Map<string, number>>();
	const dailyMessages = new Map<string, number>();
	const dailySessions = new Map<string, number>();
	const hourCounts = new Map<string, number>();
	let totalMessages = 0;
	let totalSessions = 0;
	let firstTsMs: number | undefined;
	let longest: IClaudeLongestSession | undefined;

	for (const p of partials) {
		if (p.messageCount <= 0) { continue; }
		// Subagent transcripts contribute tokens + activity, but are not counted as their own "session".
		if (!p.isSubagent) { totalSessions++; }
		totalMessages += p.messageCount;
		if (p.firstTsMs !== undefined && (firstTsMs === undefined || p.firstTsMs < firstTsMs)) { firstTsMs = p.firstTsMs; }

		for (const [m, v] of Object.entries(p.modelUsage)) {
			const mu = modelUsage.get(m) ?? emptyModelTokens();
			mu.input += v.input; mu.output += v.output; mu.cacheRead += v.cacheRead; mu.cacheCreate += v.cacheCreate; mu.webSearch += v.webSearch;
			modelUsage.set(m, mu);
		}
		for (const [d, byModel] of Object.entries(p.dailyTokens)) {
			const into = dailyTokens.get(d) ?? new Map<string, number>();
			for (const [m, n] of Object.entries(byModel)) { into.set(m, (into.get(m) ?? 0) + n); }
			dailyTokens.set(d, into);
		}
		for (const [d, n] of Object.entries(p.dailyMessages)) {
			dailyMessages.set(d, (dailyMessages.get(d) ?? 0) + n);
			if (!p.isSubagent) { dailySessions.set(d, (dailySessions.get(d) ?? 0) + 1); } // a session active on date d
		}
		for (const [h, n] of Object.entries(p.hourCounts)) { hourCounts.set(h, (hourCounts.get(h) ?? 0) + n); }

		if (!p.isSubagent && p.firstTsMs !== undefined && p.lastTsMs !== undefined) {
			const duration = p.lastTsMs - p.firstTsMs;
			if (!longest || duration > (longest.duration ?? 0)) {
				longest = { sessionId: p.sessionId, duration, messageCount: p.messageCount, timestamp: new Date(p.firstTsMs).toISOString() };
			}
		}
	}

	const modelUsageOut: { [model: string]: IClaudeModelStat } = {};
	for (const [m, v] of modelUsage) {
		modelUsageOut[m] = { inputTokens: v.input, outputTokens: v.output, cacheReadInputTokens: v.cacheRead, cacheCreationInputTokens: v.cacheCreate, webSearchRequests: v.webSearch };
	}
	const dailyActivity: IClaudeDailyActivity[] = [...dailyMessages.keys()].sort().map(date => ({
		date, messageCount: dailyMessages.get(date) ?? 0, sessionCount: dailySessions.get(date) ?? 0,
	}));
	const dailyModelTokens: IClaudeDailyModelTokens[] = [...dailyTokens.keys()].sort().map(date => {
		const byModel = dailyTokens.get(date)!;
		const tokensByModel: { [model: string]: number } = {};
		for (const [m, n] of byModel) { tokensByModel[m] = n; }
		return { date, tokensByModel };
	});
	const hourCountsOut: { [hour: string]: number } = {};
	for (const [h, n] of hourCounts) { hourCountsOut[h] = n; }

	return {
		modelUsage: modelUsageOut,
		dailyActivity,
		dailyModelTokens,
		hourCounts: hourCountsOut,
		longestSession: longest,
		totalSessions,
		totalMessages,
		firstSessionDate: firstTsMs !== undefined ? new Date(firstTsMs).toISOString() : undefined,
		lastComputedDate: todayKey,
	};
}
// CLAWDIUS-END
