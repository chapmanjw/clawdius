/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { aggregateFile, IClaudeStats, IUsageFilePartial, mergePartials, windowStats } from '../../common/claudeUsageStatsModel.js';

function assistantLine(id: string, reqId: string, opts: { model?: string; input?: number; output?: number; cacheRead?: number; cacheCreate?: number; ts?: string } = {}): string {
	return JSON.stringify({
		type: 'assistant',
		timestamp: opts.ts ?? '2026-06-20T14:00:00.000Z',
		sessionId: 's1',
		requestId: reqId,
		uuid: `${id}-${reqId}`,
		message: {
			id, role: 'assistant', model: opts.model ?? 'claude-opus-4-8',
			usage: {
				input_tokens: opts.input ?? 100, output_tokens: opts.output ?? 50,
				cache_read_input_tokens: opts.cacheRead ?? 10, cache_creation_input_tokens: opts.cacheCreate ?? 20,
				server_tool_use: { web_search_requests: 0 },
			},
		},
	});
}

function userLine(ts = '2026-06-20T13:59:00.000Z'): string {
	return JSON.stringify({ type: 'user', timestamp: ts, sessionId: 's1', uuid: `user-${ts}`, message: { role: 'user', content: 'hi' } });
}

suite('claudeUsageStatsModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('aggregateFile dedupes assistant messages by (id, requestId) and counts each once', () => {
		// Same logical message logged three times (streaming snapshots, byte-identical usage) + one user message.
		const p = aggregateFile([
			userLine(),
			assistantLine('msg_1', 'req_1'),
			assistantLine('msg_1', 'req_1'),
			assistantLine('msg_1', 'req_1'),
			'',                       // blank line ignored
			'{ not json',             // malformed line ignored
			'{"type":"system","x":1}',// non-message line ignored
		]);
		assert.strictEqual(p.messageCount, 2, 'one deduped assistant + one user');
		assert.strictEqual(p.sessionId, 's1');
		assert.deepStrictEqual(p.modelUsage['claude-opus-4-8'], { input: 100, output: 50, cacheRead: 10, cacheCreate: 20, webSearch: 0 }, 'usage counted once, not 3x');
	});

	test('aggregateFile keeps the FINAL/larger usage among duplicate snapshots of one message', () => {
		// Streaming snapshots of ONE logical message: a placeholder (zeros), then the final/larger usage, then a
		// trailing placeholder. The maximal/final snapshot holds the true usage, so it must win over the placeholders.
		const p = aggregateFile([
			assistantLine('msg_1', 'req_1', { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }),
			assistantLine('msg_1', 'req_1', { input: 100, output: 50, cacheRead: 10, cacheCreate: 20 }),
			assistantLine('msg_1', 'req_1', { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }),
		]);
		assert.strictEqual(p.messageCount, 1, 'one logical message, counted once');
		assert.deepStrictEqual(p.modelUsage['claude-opus-4-8'], { input: 100, output: 50, cacheRead: 10, cacheCreate: 20, webSearch: 0 }, 'final/larger usage wins, not the placeholder snapshots');

		// The chosen final/larger snapshot must also be what folds into the PER-DAY series (not just the global
		// modelUsage), since the windowed tiles sum the per-day series - never the lifetime totals.
		const days = Object.keys(p.dailyTokens);
		assert.strictEqual(days.length, 1, 'all snapshots land on one local day');
		assert.deepStrictEqual(p.dailyTokens[days[0]]['claude-opus-4-8'], { input: 100, output: 50, cacheRead: 10, cacheCreate: 20, webSearch: 0 }, 'final/larger usage folds into the per-day split too');
		const merged = mergePartials([p], '2026-06-25');
		assert.deepStrictEqual(merged.dailyModelTokens![0].statsByModel!['claude-opus-4-8'], { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 20, webSearchRequests: 0 }, 'and into the merged per-day statsByModel series');
		assert.strictEqual(merged.dailyModelTokens![0].tokensByModel!['claude-opus-4-8'], 150, 'per-day in+out scalar (drives the chart) reflects the final snapshot');
	});

	test('aggregateFile sums distinct messages across models', () => {
		const p = aggregateFile([
			assistantLine('msg_1', 'req_1', { model: 'claude-opus-4-8', input: 100, output: 50 }),
			assistantLine('msg_2', 'req_2', { model: 'claude-opus-4-8', input: 30, output: 20 }),
			assistantLine('msg_3', 'req_3', { model: 'claude-haiku-4-5', input: 5, output: 5 }),
		]);
		assert.strictEqual(p.messageCount, 3);
		assert.strictEqual(p.modelUsage['claude-opus-4-8'].input, 130);
		assert.strictEqual(p.modelUsage['claude-opus-4-8'].output, 70);
		assert.strictEqual(p.modelUsage['claude-haiku-4-5'].input, 5);
	});

	test('mergePartials totals sessions + tokens, and excludes subagents from the session count', () => {
		const top: IUsageFilePartial = {
			sessionId: 'a', messageCount: 10, firstTsMs: 1000, lastTsMs: 5000,
			modelUsage: { 'claude-opus-4-8': { input: 100, output: 50, cacheRead: 0, cacheCreate: 0, webSearch: 0 } },
			dailyTokens: { '2026-06-20': { 'claude-opus-4-8': { input: 100, output: 50, cacheRead: 0, cacheCreate: 0, webSearch: 0 } } },
			dailyMessages: { '2026-06-20': 10 }, hourCounts: { '14': 10 }, dailyHourCounts: { '2026-06-20': { '14': 10 } },
		};
		const sub: IUsageFilePartial = {
			sessionId: 'b', isSubagent: true, messageCount: 4, firstTsMs: 2000, lastTsMs: 9999,
			modelUsage: { 'claude-opus-4-8': { input: 20, output: 10, cacheRead: 0, cacheCreate: 0, webSearch: 0 } },
			dailyTokens: { '2026-06-20': { 'claude-opus-4-8': { input: 20, output: 10, cacheRead: 0, cacheCreate: 0, webSearch: 0 } } },
			dailyMessages: { '2026-06-20': 4 }, hourCounts: { '14': 4 }, dailyHourCounts: { '2026-06-20': { '14': 4 } },
		};
		const empty: IUsageFilePartial = { messageCount: 0, modelUsage: {}, dailyTokens: {}, dailyMessages: {}, hourCounts: {}, dailyHourCounts: {} };
		const merged = mergePartials([top, sub, empty], '2026-06-25');

		assert.strictEqual(merged.totalSessions, 1, 'subagent + empty excluded from session count');
		assert.strictEqual(merged.totalMessages, 14, 'subagent messages still counted toward activity');
		assert.strictEqual(merged.modelUsage!['claude-opus-4-8'].inputTokens, 120, 'subagent tokens included');
		assert.strictEqual(merged.modelUsage!['claude-opus-4-8'].outputTokens, 60);
		assert.strictEqual(merged.dailyModelTokens![0].tokensByModel!['claude-opus-4-8'], 180, 'daily in+out scalar merged');
		assert.deepStrictEqual(merged.dailyModelTokens![0].statsByModel!['claude-opus-4-8'], { inputTokens: 120, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 }, 'daily per-model split merged (drives the windowed breakdown)');
		assert.deepStrictEqual(merged.dailyHourCounts![0], { date: '2026-06-20', hourCounts: { '14': 14 } }, 'per-day hour counts merged across top + subagent');
		assert.deepStrictEqual(merged.sessions, [{ sessionId: 'a', startDate: merged.sessions![0].startDate, duration: 4000, messageCount: 10 }], 'one non-subagent session summary, with its window-able start day + duration');
		assert.strictEqual(merged.dailyActivity![0].sessionCount, 1, 'only the top-level session counts toward the day');
		assert.strictEqual(merged.dailyActivity![0].messageCount, 14);
		assert.strictEqual(merged.longestSession!.sessionId, 'a', 'subagent never the longest session');
		assert.strictEqual(merged.lastComputedDate, '2026-06-25');
	});

	test('windowStats sums only the in-window days, dropping days outside [windowStart .. today]', () => {
		// One day older than the window, one in window, one after today. A long session OUT of the window must not
		// win "longest", and the older/future days must not contribute to any total, model split, or hour count.
		const stats: IClaudeStats = {
			dailyActivity: [
				{ date: '2026-05-15', messageCount: 100, sessionCount: 5 }, // older than the window -> excluded
				{ date: '2026-06-20', messageCount: 10, sessionCount: 1 },  // in window
				{ date: '2026-07-05', messageCount: 99, sessionCount: 9 },  // after today -> excluded
			],
			dailyModelTokens: [
				{ date: '2026-05-15', statsByModel: { 'claude-opus-4-8': { inputTokens: 999, outputTokens: 999, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 } } },
				{ date: '2026-06-20', statsByModel: { 'claude-opus-4-8': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 20, webSearchRequests: 1 } } },
			],
			dailyHourCounts: [
				{ date: '2026-05-15', hourCounts: { '3': 50 } },
				{ date: '2026-06-20', hourCounts: { '14': 10 } },
			],
			sessions: [
				{ sessionId: 'old', startDate: '2026-05-15', duration: 999999, messageCount: 100 }, // longest overall, but out of window
				{ sessionId: 'win', startDate: '2026-06-20', duration: 5000, messageCount: 10 },
			],
			hourCounts: { '3': 50, '14': 10 },
			longestSession: { sessionId: 'old', duration: 999999 },
			totalSessions: 2, totalMessages: 209,
		};
		const w = windowStats(stats, '2026-06-01', '2026-06-30');
		assert.deepStrictEqual({
			days: w.dailyActivity.map(a => a.date),
			messages: w.totalMessages,
			sessions: w.totalSessions,
			longest: w.longestSession?.sessionId,
			opus: w.modelUsage['claude-opus-4-8'],
			hours: w.hourCounts,
		}, {
			days: ['2026-06-20'],
			messages: 10,
			sessions: 1,
			longest: 'win', // the in-window session, NOT the longer out-of-window 'old'
			opus: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 20, webSearchRequests: 1 },
			hours: { '14': 10 },
		});
	});
});
