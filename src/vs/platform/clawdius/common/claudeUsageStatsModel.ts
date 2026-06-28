/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN usage stats model (transcript-derived, pure)
// Pure, UI-free, fs-free logic that turns the raw Claude session transcripts (~/.claude/projects/**/*.jsonl)
// into the dashboard's IClaudeStats shape - the accurate, always-current alternative to the engine's
// stats-cache.json (which only the interactive CLI recomputes, so it goes stale for days). This is the same
// source ccusage aggregates. Two pieces:
//   - UsageFileAccumulator: fed one JSONL line at a time (the node service streams a file line-by-line, never
//     buffering the whole 100MB+ file), dedupes assistant messages by (message.id, requestId) - mandatory,
//     since streaming snapshots repeat a logical message many times. Each message is COUNTED once, but its
//     token usage is taken from the FINAL/maximal snapshot (early streaming snapshots can carry placeholder
//     token values), and it emits a per-file IUsageFilePartial.
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

/** Per-day per-model token totals. `tokensByModel` is the in+out scalar that drives the Tokens-per-Day line
 *  chart; `statsByModel` is the full per-model split (in / out / cache), summed over the in-window days to drive
 *  the (windowed) model breakdown without reading the unbounded lifetime `modelUsage`. */
export interface IClaudeDailyModelTokens {
	readonly date?: string;
	readonly tokensByModel?: { readonly [model: string]: number };
	readonly statsByModel?: { readonly [model: string]: IClaudeModelStat };
}

/** Per-day hour-of-day (0..23, local) message distribution; summed over in-window days for the 24h activity chart. */
export interface IClaudeDailyHourCounts {
	readonly date?: string;
	readonly hourCounts?: { readonly [hour: string]: number };
}

/** The single longest session by wall-clock duration (ms). */
export interface IClaudeLongestSession {
	readonly sessionId?: string;
	readonly duration?: number;
	readonly messageCount?: number;
	readonly timestamp?: string;
}

/** One non-subagent session's window-able summary; the view picks the longest whose start day is in the window. */
export interface IClaudeSessionSummary {
	readonly sessionId?: string;
	/** Local YYYY-MM-DD of the session's first message (the day used to test window membership). */
	readonly startDate?: string;
	/** Wall-clock duration (last - first message timestamp), in ms. */
	readonly duration?: number;
	readonly messageCount?: number;
}

export interface IClaudeStats {
	readonly modelUsage?: { readonly [model: string]: IClaudeModelStat };
	readonly dailyActivity?: ReadonlyArray<IClaudeDailyActivity>;
	readonly dailyModelTokens?: ReadonlyArray<IClaudeDailyModelTokens>;
	readonly dailyHourCounts?: ReadonlyArray<IClaudeDailyHourCounts>;
	readonly sessions?: ReadonlyArray<IClaudeSessionSummary>;
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
	/** date (YYYY-MM-DD, local) -> model -> full token split, so the merged per-day series can be windowed. */
	readonly dailyTokens: { [date: string]: { [model: string]: IModelTokens } };
	/** date (YYYY-MM-DD, local) -> deduped message count. */
	readonly dailyMessages: { [date: string]: number };
	/** local hour (0..23 as string) -> message count (whole-file total). */
	readonly hourCounts: { [hour: string]: number };
	/** date (YYYY-MM-DD, local) -> local hour (0..23 as string) -> message count, for the windowed 24h chart. */
	readonly dailyHourCounts: { [date: string]: { [hour: string]: number } };
}

function emptyModelTokens(): IModelTokens {
	return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, webSearch: 0 };
}

/** Total token count for a snapshot's usage (the basis for picking the maximal/final streaming snapshot). */
function tokenTotal(t: IModelTokens): number {
	return t.input + t.output + t.cacheRead + t.cacheCreate;
}

/** Local YYYY-MM-DD for an epoch-ms timestamp (the dashboard heatmap + charts are in local time). */
export function localDateKey(ms: number): string {
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
	/** Per (message.id, requestId): the kept (final/maximal) usage snapshot, folded into the totals in {@link finish}. */
	private readonly assistantUsage = new Map<string, { readonly model: string; readonly dateKey: string | undefined; readonly tokens: IModelTokens }>();
	private sessionId: string | undefined;
	private messageCount = 0;
	private firstTsMs: number | undefined;
	private lastTsMs: number | undefined;
	private readonly modelUsage = new Map<string, IModelTokens>();
	private readonly dailyTokens = new Map<string, Map<string, IModelTokens>>();
	private readonly dailyMessages = new Map<string, number>();
	private readonly hourCounts = new Map<string, number>();
	private readonly dailyHourCounts = new Map<string, Map<string, number>>();

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
			// Dedup key: streaming snapshots repeat the same logical message under one (message.id, requestId).
			const id = message && typeof message['id'] === 'string' ? message['id'] as string : undefined;
			const reqId = typeof o['requestId'] === 'string' ? o['requestId'] as string : undefined;
			const key = id || reqId ? `${id ?? ''}::${reqId ?? ''}` : (typeof o['uuid'] === 'string' ? `u:${o['uuid']}` : undefined);
			const model = message && typeof message['model'] === 'string' ? message['model'] as string : undefined;
			const usage = message && message['usage'] && typeof message['usage'] === 'object' ? message['usage'] as Record<string, unknown> : undefined;
			let tokens: IModelTokens | undefined;
			if (model && usage) {
				tokens = {
					input: asFiniteNumber(usage['input_tokens']),
					output: asFiniteNumber(usage['output_tokens']),
					cacheRead: asFiniteNumber(usage['cache_read_input_tokens']),
					cacheCreate: asFiniteNumber(usage['cache_creation_input_tokens']),
					webSearch: usage['server_tool_use'] && typeof usage['server_tool_use'] === 'object'
						? asFiniteNumber((usage['server_tool_use'] as Record<string, unknown>)['web_search_requests']) : 0,
				};
			}
			const dk = validTs ? localDateKey(tsMs) : undefined;
			if (key !== undefined) {
				const firstSnapshot = !this.seenAssistant.has(key);
				if (firstSnapshot) { this.seenAssistant.add(key); }
				// Keep-FINAL/MAX usage per (message.id, requestId): early streaming snapshots can carry placeholder
				// token values, so retain the snapshot with the largest total (ties resolve to the later/final one).
				if (model && tokens) {
					const prev = this.assistantUsage.get(key);
					if (!prev || tokenTotal(tokens) >= tokenTotal(prev.tokens)) {
						this.assistantUsage.set(key, { model, dateKey: dk, tokens });
					}
				}
				// Count the logical message (and its per-day / per-hour activity) exactly once, on its first snapshot.
				if (!firstSnapshot) { return; }
			} else if (model && tokens) {
				// No dedup key (rare): the message can't be a streaming duplicate, so fold its usage directly.
				this.addModelUsage(model, dk, tokens);
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
			const byHour = this.dailyHourCounts.get(dk) ?? new Map<string, number>();
			byHour.set(hr, (byHour.get(hr) ?? 0) + 1);
			this.dailyHourCounts.set(dk, byHour);
		}
	}

	/** Fold one message's token usage into the per-model + per-day token totals. */
	private addModelUsage(model: string, dateKey: string | undefined, tokens: IModelTokens): void {
		const mu = this.modelUsage.get(model) ?? emptyModelTokens();
		mu.input += tokens.input; mu.output += tokens.output; mu.cacheRead += tokens.cacheRead; mu.cacheCreate += tokens.cacheCreate; mu.webSearch += tokens.webSearch;
		this.modelUsage.set(model, mu);
		if (dateKey !== undefined) {
			const byModel = this.dailyTokens.get(dateKey) ?? new Map<string, IModelTokens>();
			const cur = byModel.get(model) ?? emptyModelTokens();
			cur.input += tokens.input; cur.output += tokens.output; cur.cacheRead += tokens.cacheRead; cur.cacheCreate += tokens.cacheCreate; cur.webSearch += tokens.webSearch;
			byModel.set(model, cur);
			this.dailyTokens.set(dateKey, byModel);
		}
	}

	finish(): IUsageFilePartial {
		// Fold the kept (final/maximal) usage for each deduped assistant message into the per-model + per-day totals.
		for (const { model, dateKey, tokens } of this.assistantUsage.values()) {
			this.addModelUsage(model, dateKey, tokens);
		}
		const modelUsage: { [model: string]: IModelTokens } = {};
		for (const [m, v] of this.modelUsage) { modelUsage[m] = v; }
		const dailyTokens: { [date: string]: { [model: string]: IModelTokens } } = {};
		for (const [d, byModel] of this.dailyTokens) {
			const obj: { [model: string]: IModelTokens } = {};
			for (const [m, t] of byModel) { obj[m] = t; }
			dailyTokens[d] = obj;
		}
		const dailyMessages: { [date: string]: number } = {};
		for (const [d, n] of this.dailyMessages) { dailyMessages[d] = n; }
		const hourCounts: { [hour: string]: number } = {};
		for (const [h, n] of this.hourCounts) { hourCounts[h] = n; }
		const dailyHourCounts: { [date: string]: { [hour: string]: number } } = {};
		for (const [d, byHour] of this.dailyHourCounts) {
			const obj: { [hour: string]: number } = {};
			for (const [h, n] of byHour) { obj[h] = n; }
			dailyHourCounts[d] = obj;
		}
		return {
			sessionId: this.sessionId,
			messageCount: this.messageCount,
			firstTsMs: this.firstTsMs,
			lastTsMs: this.lastTsMs,
			modelUsage,
			dailyTokens,
			dailyMessages,
			hourCounts,
			dailyHourCounts,
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
	const dailyTokens = new Map<string, Map<string, IModelTokens>>();
	const dailyMessages = new Map<string, number>();
	const dailySessions = new Map<string, number>();
	const hourCounts = new Map<string, number>();
	const dailyHourCounts = new Map<string, Map<string, number>>();
	const sessions: IClaudeSessionSummary[] = [];
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
			const into = dailyTokens.get(d) ?? new Map<string, IModelTokens>();
			for (const [m, t] of Object.entries(byModel)) {
				const cur = into.get(m) ?? emptyModelTokens();
				cur.input += t.input; cur.output += t.output; cur.cacheRead += t.cacheRead; cur.cacheCreate += t.cacheCreate; cur.webSearch += t.webSearch;
				into.set(m, cur);
			}
			dailyTokens.set(d, into);
		}
		for (const [d, n] of Object.entries(p.dailyMessages)) {
			dailyMessages.set(d, (dailyMessages.get(d) ?? 0) + n);
			if (!p.isSubagent) { dailySessions.set(d, (dailySessions.get(d) ?? 0) + 1); } // a session active on date d
		}
		for (const [h, n] of Object.entries(p.hourCounts)) { hourCounts.set(h, (hourCounts.get(h) ?? 0) + n); }
		for (const [d, byHour] of Object.entries(p.dailyHourCounts)) {
			const into = dailyHourCounts.get(d) ?? new Map<string, number>();
			for (const [h, n] of Object.entries(byHour)) { into.set(h, (into.get(h) ?? 0) + n); }
			dailyHourCounts.set(d, into);
		}

		if (!p.isSubagent && p.firstTsMs !== undefined && p.lastTsMs !== undefined) {
			const duration = p.lastTsMs - p.firstTsMs;
			sessions.push({ sessionId: p.sessionId, startDate: localDateKey(p.firstTsMs), duration, messageCount: p.messageCount });
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
		const statsByModel: { [model: string]: IClaudeModelStat } = {};
		for (const [m, t] of byModel) {
			tokensByModel[m] = t.input + t.output;
			statsByModel[m] = { inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead, cacheCreationInputTokens: t.cacheCreate, webSearchRequests: t.webSearch };
		}
		return { date, tokensByModel, statsByModel };
	});
	const hourCountsOut: { [hour: string]: number } = {};
	for (const [h, n] of hourCounts) { hourCountsOut[h] = n; }
	const dailyHourCountsOut: IClaudeDailyHourCounts[] = [...dailyHourCounts.keys()].sort().map(date => {
		const byHour = dailyHourCounts.get(date)!;
		const hc: { [hour: string]: number } = {};
		for (const [h, n] of byHour) { hc[h] = n; }
		return { date, hourCounts: hc };
	});

	return {
		modelUsage: modelUsageOut,
		dailyActivity,
		dailyModelTokens,
		dailyHourCounts: dailyHourCountsOut,
		sessions,
		hourCounts: hourCountsOut,
		longestSession: longest,
		totalSessions,
		totalMessages,
		firstSessionDate: firstTsMs !== undefined ? new Date(firstTsMs).toISOString() : undefined,
		lastComputedDate: todayKey,
	};
}

// --- View windowing (pure) ------------------------------------------------------------------------------------

/** The retention-window slice of the stats: every metric summed over the in-window local days only. */
export interface IWindowedStats {
	readonly modelUsage: { readonly [model: string]: IClaudeModelStat };
	readonly dailyActivity: ReadonlyArray<IClaudeDailyActivity>;
	readonly dailyModelTokens: ReadonlyArray<IClaudeDailyModelTokens>;
	readonly hourCounts: { readonly [hour: string]: number };
	readonly longestSession: IClaudeLongestSession | undefined;
	readonly totalSessions: number;
	readonly totalMessages: number;
}

/**
 * Reduce the per-day / per-session aggregate to exactly the retention window, the inclusive local-day range
 * [windowStartKey .. todayKey]. Every dashboard tile derives from this slice so nothing leaks past the horizon:
 * days older than the window OR after today are dropped before anything is summed. Pure (no clock, no I/O).
 */
export function windowStats(stats: IClaudeStats, windowStartKey: string, todayKey: string): IWindowedStats {
	const inWindow = (date: string | undefined): boolean => {
		if (typeof date !== 'string') { return false; }
		const k = date.slice(0, 10);
		return k >= windowStartKey && k <= todayKey;
	};

	const dailyActivity = (stats.dailyActivity ?? []).filter(a => inWindow(a.date));
	let totalMessages = 0;
	for (const a of dailyActivity) { totalMessages += a.messageCount ?? 0; }

	const dailyModelTokens = (stats.dailyModelTokens ?? []).filter(d => inWindow(d.date));
	const modelUsage = new Map<string, IModelTokens>();
	for (const d of dailyModelTokens) {
		for (const [model, s] of Object.entries(d.statsByModel ?? {})) {
			const into = modelUsage.get(model) ?? emptyModelTokens();
			into.input += s.inputTokens ?? 0;
			into.output += s.outputTokens ?? 0;
			into.cacheRead += s.cacheReadInputTokens ?? 0;
			into.cacheCreate += s.cacheCreationInputTokens ?? 0;
			into.webSearch += s.webSearchRequests ?? 0;
			modelUsage.set(model, into);
		}
	}
	const modelUsageOut: { [model: string]: IClaudeModelStat } = {};
	for (const [m, v] of modelUsage) {
		modelUsageOut[m] = { inputTokens: v.input, outputTokens: v.output, cacheReadInputTokens: v.cacheRead, cacheCreationInputTokens: v.cacheCreate, webSearchRequests: v.webSearch };
	}

	const hourCounts: { [hour: string]: number } = {};
	for (const d of stats.dailyHourCounts ?? []) {
		if (!inWindow(d.date)) { continue; }
		for (const [hour, c] of Object.entries(d.hourCounts ?? {})) { hourCounts[hour] = (hourCounts[hour] ?? 0) + c; }
	}

	let longestSession: IClaudeLongestSession | undefined;
	let totalSessions = 0;
	for (const s of stats.sessions ?? []) {
		if (!inWindow(s.startDate)) { continue; }
		totalSessions++;
		if (!longestSession || (s.duration ?? 0) > (longestSession.duration ?? 0)) {
			longestSession = { sessionId: s.sessionId, duration: s.duration, messageCount: s.messageCount };
		}
	}

	return { modelUsage: modelUsageOut, dailyActivity, dailyModelTokens, hourCounts, longestSession, totalSessions, totalMessages };
}
// CLAWDIUS-END
