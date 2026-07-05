/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ClaudeProvider, IClaudeCapacity, capacityWindows, compact, computeStreaks, formatDuration,
	modelFamily, modelLabel, normalizeStats, providerFromEnv, resolveModelRows,
} from '../../browser/usage/claudeUsageData.js';
import { blockBar } from '../../browser/usage/claudeUsageCharts.js';

// The status-bar bar glyphs, built from char codes so this test source stays ASCII-only (matching the primitive).
const FULL = String.fromCharCode(0x2588);  // full block (filled portion)
const LIGHT = String.fromCharCode(0x2591); // light shade (empty track)

suite('claudeUsageData', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// --- computeStreaks ---------------------------------------------------------------------------------------

	test('computeStreaks: empty activity is all zeros with spanDays 0', () => {
		assert.deepStrictEqual(
			computeStreaks([], undefined, '2026-06-27'),
			{ activeDays: 0, spanDays: 0, longest: 0, current: 0, mostActiveDate: undefined, mostActiveCount: 0 },
		);
	});

	test('computeStreaks: a 3-day run, a gap, then 2 days -> longest 3, widened span, trailing current', () => {
		// Intentionally unsorted to exercise the internal sort; mostActive comes from the original (unsorted) order.
		const activity = [
			{ date: '2026-06-10', messageCount: 8 },
			{ date: '2026-06-02', messageCount: 10 },
			{ date: '2026-06-01', messageCount: 5 },
			{ date: '2026-06-11', messageCount: 2 },
			{ date: '2026-06-03', messageCount: 3 },
		];
		assert.deepStrictEqual(
			computeStreaks(activity, undefined, '2026-06-12'),
			{ activeDays: 5, spanDays: 12, longest: 3, current: 2, mostActiveDate: '2026-06-02', mostActiveCount: 10 },
		);
	});

	test('computeStreaks: last active day == today -> current includes today', () => {
		const activity = [
			{ date: '2026-06-25', messageCount: 4 },
			{ date: '2026-06-26', messageCount: 6 },
			{ date: '2026-06-27', messageCount: 9 },
		];
		assert.deepStrictEqual(
			computeStreaks(activity, undefined, '2026-06-27'),
			{ activeDays: 3, spanDays: 3, longest: 3, current: 3, mostActiveDate: '2026-06-27', mostActiveCount: 9 },
		);
	});

	test('computeStreaks: last active day older than yesterday -> current is 0', () => {
		const activity = [
			{ date: '2026-06-20', messageCount: 4 },
			{ date: '2026-06-21', messageCount: 6 },
		];
		assert.deepStrictEqual(
			computeStreaks(activity, undefined, '2026-06-27'),
			{ activeDays: 2, spanDays: 8, longest: 2, current: 0, mostActiveDate: '2026-06-21', mostActiveCount: 6 },
		);
	});

	test('computeStreaks: firstSessionDate earlier than the first active day widens spanDays', () => {
		const activity = [
			{ date: '2026-06-08', messageCount: 3 },
			{ date: '2026-06-09', messageCount: 7 },
		];
		assert.deepStrictEqual(
			computeStreaks(activity, '2026-06-01', '2026-06-10'),
			{ activeDays: 2, spanDays: 10, longest: 2, current: 2, mostActiveDate: '2026-06-09', mostActiveCount: 7 },
		);
	});

	// --- blockBar (claudeUsageCharts) -------------------------------------------------------------------------

	test('blockBar: clamps fraction to [0,1], NaN is empty, renders full/light glyphs', () => {
		assert.deepStrictEqual(
			[blockBar(0, 10), blockBar(1, 10), blockBar(1.5, 10), blockBar(-1, 10), blockBar(NaN, 10)],
			[LIGHT.repeat(10), FULL.repeat(10), FULL.repeat(10), LIGHT.repeat(10), LIGHT.repeat(10)],
		);
	});

	test('blockBar: filled + empty length always equals width', () => {
		assert.deepStrictEqual(
			[blockBar(0.37, 10).length, blockBar(2, 5).length, blockBar(-3, 7).length, blockBar(NaN, 4).length, blockBar(0.5, 0).length],
			[10, 5, 7, 4, 0],
		);
	});

	// --- capacityWindows --------------------------------------------------------------------------------------

	test('capacityWindows: undefined -> [], numeric-only utilization in fixed order, resets passthrough', () => {
		// Capacity is unchecked JSON read from the cache file, so a window's utilization can be a non-number;
		// build the fixtures the same way (single-quoted literals keep the source free of double-quoted strings).
		const kept = JSON.parse('{"five_hour":{"utilization":0,"resets_at":"r1"},"seven_day":{"utilization":73.5,"resets_at":null},"seven_day_opus":{"resets_at":"rx"},"seven_day_sonnet":{"utilization":12,"resets_at":"r4"}}') as IClaudeCapacity;
		const dropped = JSON.parse('{"five_hour":{"utilization":null},"seven_day":{"utilization":"90"},"seven_day_opus":null}') as IClaudeCapacity;
		assert.deepStrictEqual(
			[
				capacityWindows(undefined),
				capacityWindows(dropped),
				capacityWindows(kept).map(w => ({ key: w.key, util: w.util, resets: w.resets })),
			],
			[
				[],
				[],
				[
					{ key: 'session', util: 0, resets: 'r1' },
					{ key: 'week', util: 73.5, resets: null },
					{ key: 'weekSonnet', util: 12, resets: 'r4' },
				],
			],
		);
	});

	test('capacityWindows: limits[] preferred, per-model scoped windows dynamic + ordered, malformed dropped, empty falls back', () => {
		// The current /api/oauth/usage shape: a `limits` array. Per-model weekly windows arrive as
		// `weekly_scoped` carrying scope.model.display_name. Unchecked JSON, so percent may be missing / a
		// non-number and entries may be null - all of which must drop, never crash or mislabel.
		const live = JSON.parse('{"limits":[{"kind":"session","percent":27,"resets_at":"r1","is_active":true,"scope":null},{"kind":"weekly_all","percent":26,"resets_at":"r2","is_active":false,"scope":null},{"kind":"weekly_scoped","percent":27,"resets_at":"r3","is_active":false,"scope":{"model":{"id":null,"display_name":"Fable"},"surface":null}}]}') as IClaudeCapacity;
		// A hypothetical EXTRA model (Nimbus) renders with zero code change; order is session/week/scoped; a scoped
		// entry with no model name, a non-number percent, a null entry, and an unknown kind all drop.
		const extra = JSON.parse('{"limits":[{"kind":"weekly_scoped","percent":10,"scope":{"model":{"display_name":"Nimbus"}}},{"kind":"session","percent":5},{"kind":"weekly_scoped","percent":99,"scope":{"model":{"display_name":null}}},{"kind":"weekly_scoped","percent":"bad"},null,{"kind":"mystery","percent":50},{"kind":"weekly_all","percent":20}]}') as IClaudeCapacity;
		// A non-empty limits[] wins over the legacy flat keys; an EMPTY limits[] falls back to them.
		const preferred = JSON.parse('{"limits":[{"kind":"session","percent":42}],"five_hour":{"utilization":1},"seven_day":{"utilization":2}}') as IClaudeCapacity;
		const emptyLimits = JSON.parse('{"limits":[],"five_hour":{"utilization":9,"resets_at":"r9"}}') as IClaudeCapacity;
		assert.deepStrictEqual(
			[
				capacityWindows(live).map(w => ({ key: w.key, util: w.util, resets: w.resets, model: w.model, active: w.active })),
				capacityWindows(extra).map(w => ({ key: w.key, util: w.util })),
				capacityWindows(preferred).map(w => ({ key: w.key, util: w.util })),
				capacityWindows(emptyLimits).map(w => ({ key: w.key, util: w.util })),
			],
			[
				[
					{ key: 'session', util: 27, resets: 'r1', model: undefined, active: true },
					{ key: 'week', util: 26, resets: 'r2', model: undefined, active: false },
					{ key: 'week:fable', util: 27, resets: 'r3', model: 'Fable', active: false },
				],
				[
					{ key: 'session', util: 5 },
					{ key: 'week', util: 20 },
					{ key: 'week:nimbus', util: 10 },
				],
				[{ key: 'session', util: 42 }],
				[{ key: 'session', util: 9 }],
			],
		);
	});

	// --- modelLabel / modelFamily -----------------------------------------------------------------------------

	test('modelLabel: claude major.minor, single-number, word suffix, passthrough, long-id truncation', () => {
		assert.deepStrictEqual(
			[
				modelLabel('claude-opus-4-8'),
				modelLabel('claude-fable-5'),
				modelLabel('claude-sonnet-preview'),
				modelLabel('gpt-4o-mini'),
				modelLabel('a'.repeat(30)),
			],
			['Opus 4.8', 'Fable 5', 'Sonnet preview', 'gpt-4o-mini', 'a'.repeat(21) + '.'],
		);
	});

	test('modelFamily: capitalized Claude family or Other', () => {
		assert.deepStrictEqual(
			[
				modelFamily('claude-opus-4-8'),
				modelFamily('claude-sonnet-4-5'),
				modelFamily('claude-haiku-4-5'),
				modelFamily('claude-fable-5'),
				modelFamily('gpt-4o'),
			],
			['Opus', 'Sonnet', 'Haiku', 'Fable', 'Other'],
		);
	});

	// --- compact / formatDuration -----------------------------------------------------------------------------

	test('compact: thousands and millions with one decimal', () => {
		assert.deepStrictEqual(
			[compact(0), compact(999), compact(1000), compact(1_500_000)],
			['0', '999', '1.0K', '1.5M'],
		);
	});

	test('formatDuration: 0/NaN floor to 0s; seconds/minutes/hours/days roll up', () => {
		assert.deepStrictEqual(
			[
				formatDuration(0),
				formatDuration(NaN),
				formatDuration(12_000),
				formatDuration(90_000),
				formatDuration(3_600_000),
				formatDuration(233_280_000),
			],
			['0s', '0s', '12s', '1m', '1h 0m', '2d 16h 48m'],
		);
	});

	// --- resolveModelRows -------------------------------------------------------------------------------------

	test('resolveModelRows: undefined -> [], drops fully-zero, keeps cache-only, sorts by total desc with labels', () => {
		const modelUsage = {
			'claude-opus-4-8': { inputTokens: 1000, outputTokens: 500 },
			'claude-sonnet-4-5': { inputTokens: 200, outputTokens: 100 },
			'claude-haiku-4-5': { cacheReadInputTokens: 5000 },
			'zero-model': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
		};
		assert.deepStrictEqual(
			[resolveModelRows(undefined), resolveModelRows(modelUsage)],
			[
				[],
				[
					{ id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'Opus', input: 1000, output: 500, cacheRead: 0, cacheCreate: 0, total: 1500 },
					{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', family: 'Sonnet', input: 200, output: 100, cacheRead: 0, cacheCreate: 0, total: 300 },
					{ id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'Haiku', input: 0, output: 0, cacheRead: 5000, cacheCreate: 0, total: 0 },
				],
			],
		);
	});

	// --- normalizeStats ---------------------------------------------------------------------------------------

	test('normalizeStats: non-object / array inputs yield undefined', () => {
		assert.deepStrictEqual(
			[
				normalizeStats(undefined),
				normalizeStats(null),
				normalizeStats(42),
				normalizeStats('stats'),
				normalizeStats([{ date: '2026-06-01' }]),
			],
			[undefined, undefined, undefined, undefined, undefined],
		);
	});

	test('normalizeStats: skips junk models, sorts activity, bounds hour keys, zeroes non-finite tokens', () => {
		const raw = {
			modelUsage: {
				'claude-opus-4-8': { inputTokens: NaN, outputTokens: Infinity, cacheReadInputTokens: 5, cacheCreationInputTokens: -Infinity, webSearchRequests: 2 },
				'bad': null,
				'arr': [1, 2],
			},
			dailyActivity: [
				{ date: '2026-06-03', messageCount: 3, sessionCount: 1, toolCallCount: 2 },
				'junk',
				{ date: '2026-06-01', messageCount: NaN, sessionCount: 1, toolCallCount: 0 },
				{ messageCount: 9 },
				{ date: '2026-06-02', messageCount: 5, sessionCount: 2, toolCallCount: 1 },
			],
			hourCounts: { '0': 4, '23': 7, '24': 1, '-1': 2, '9.5': 3, 'x': 8, '12': 0 },
			sessions: 'notarray',
			totalSessions: Infinity,
			totalMessages: 100,
			firstSessionDate: '2026-06-01',
			lastComputedDate: '2026-06-03',
		};
		assert.deepStrictEqual(normalizeStats(raw), {
			modelUsage: {
				'claude-opus-4-8': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, webSearchRequests: 2 },
			},
			dailyActivity: [
				{ date: '2026-06-01', messageCount: 0, sessionCount: 1, toolCallCount: 0 },
				{ date: '2026-06-02', messageCount: 5, sessionCount: 2, toolCallCount: 1 },
				{ date: '2026-06-03', messageCount: 3, sessionCount: 1, toolCallCount: 2 },
			],
			dailyModelTokens: [],
			dailyHourCounts: [],
			sessions: [],
			hourCounts: { '0': 4, '23': 7, '12': 0 },
			longestSession: undefined,
			totalSessions: 0,
			totalMessages: 100,
			firstSessionDate: '2026-06-01',
			lastComputedDate: '2026-06-03',
		});
	});

	test('normalizeStats: dailyActivity is sorted then capped to the last 800 days', () => {
		const many: { date: string; messageCount: number }[] = [];
		for (let i = 0; i < 805; i++) {
			many.push({ date: String(i).padStart(4, '0'), messageCount: i });
		}
		many.reverse(); // feed in descending order so the internal sort has to fix it
		const norm = normalizeStats({ dailyActivity: many });
		assert.deepStrictEqual(
			[norm?.dailyActivity?.length, norm?.dailyActivity?.[0]?.date, norm?.dailyActivity?.[799]?.date],
			[800, '0005', '0804'],
		);
	});

	// --- providerFromEnv (pure core of detectProvider) --------------------------------------------------------

	test('providerFromEnv: Bedrock/Vertex truthiness, custom base URL, Anthropic default + precedence', () => {
		assert.deepStrictEqual(
			[
				providerFromEnv({}),
				providerFromEnv({ CLAUDE_CODE_USE_BEDROCK: true }),
				providerFromEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }),
				providerFromEnv({ CLAUDE_CODE_USE_BEDROCK: false }),
				providerFromEnv({ CLAUDE_CODE_USE_VERTEX: 1 }),
				providerFromEnv({ CLAUDE_CODE_USE_VERTEX: 'true' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://proxy.internal/v1' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: '' }),
				providerFromEnv({ CLAUDE_CODE_USE_BEDROCK: true, CLAUDE_CODE_USE_VERTEX: true, ANTHROPIC_BASE_URL: 'https://proxy' }),
			],
			[
				ClaudeProvider.Anthropic,
				ClaudeProvider.Bedrock,
				ClaudeProvider.Bedrock,
				ClaudeProvider.Anthropic,
				ClaudeProvider.Vertex,
				ClaudeProvider.Vertex,
				ClaudeProvider.Custom,
				ClaudeProvider.Anthropic,
				ClaudeProvider.Anthropic,
				ClaudeProvider.Bedrock,
			],
		);
	});
});
