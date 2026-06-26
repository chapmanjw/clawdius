/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { aggregateFile, IUsageFilePartial, mergePartials } from '../../common/claudeUsageStatsModel.js';

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
			dailyTokens: { '2026-06-20': { 'claude-opus-4-8': 150 } },
			dailyMessages: { '2026-06-20': 10 }, hourCounts: { '14': 10 },
		};
		const sub: IUsageFilePartial = {
			sessionId: 'b', isSubagent: true, messageCount: 4, firstTsMs: 2000, lastTsMs: 9999,
			modelUsage: { 'claude-opus-4-8': { input: 20, output: 10, cacheRead: 0, cacheCreate: 0, webSearch: 0 } },
			dailyTokens: { '2026-06-20': { 'claude-opus-4-8': 30 } },
			dailyMessages: { '2026-06-20': 4 }, hourCounts: { '14': 4 },
		};
		const empty: IUsageFilePartial = { messageCount: 0, modelUsage: {}, dailyTokens: {}, dailyMessages: {}, hourCounts: {} };
		const merged = mergePartials([top, sub, empty], '2026-06-25');

		assert.strictEqual(merged.totalSessions, 1, 'subagent + empty excluded from session count');
		assert.strictEqual(merged.totalMessages, 14, 'subagent messages still counted toward activity');
		assert.strictEqual(merged.modelUsage!['claude-opus-4-8'].inputTokens, 120, 'subagent tokens included');
		assert.strictEqual(merged.modelUsage!['claude-opus-4-8'].outputTokens, 60);
		assert.strictEqual(merged.dailyModelTokens![0].tokensByModel!['claude-opus-4-8'], 180, 'daily tokens merged');
		assert.strictEqual(merged.dailyActivity![0].sessionCount, 1, 'only the top-level session counts toward the day');
		assert.strictEqual(merged.dailyActivity![0].messageCount, 14);
		assert.strictEqual(merged.longestSession!.sessionId, 'a', 'subagent never the longest session');
		assert.strictEqual(merged.lastComputedDate, '2026-06-25');
	});
});
