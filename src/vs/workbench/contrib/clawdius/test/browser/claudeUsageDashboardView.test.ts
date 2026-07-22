/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildHeatmapModel, buildModelSeries, dateKey, effectiveCleanupPeriodDays, limitFillWidthPercent, roundedStepPath,
	utilStateOf, windowStartKey,
} from '../../browser/usage/claudeUsageDashboardView.js';

suite('claudeUsageDashboardView', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// --- roundedStepPath --------------------------------------------------------------------------------------

	test('roundedStepPath: empty series or non-positive size yields an empty path', () => {
		assert.deepStrictEqual(
			[
				roundedStepPath([], 100, 30, 20),
				roundedStepPath([5], 100, 0, 20),
				roundedStepPath([5], 100, 30, 0),
			],
			['', '', ''],
		);
	});

	test('roundedStepPath: a single value and an all-equal series are one straight M..L with no Q', () => {
		const single = roundedStepPath([5], 100, 30, 20);
		const allEqual = roundedStepPath([5, 5, 5], 100, 30, 20);
		assert.deepStrictEqual(
			[single, allEqual, single.includes('Q'), allEqual.includes('Q')],
			['M 0.00 17.51 L 30.00 17.51', 'M 0.00 17.51 L 30.00 17.51', false, false],
		);
	});

	test('roundedStepPath: a [0,100,0] spike rounds its corners (Q) and pins the full geometry', () => {
		const spike = roundedStepPath([0, 100, 0], 100, 30, 20);
		assert.deepStrictEqual(
			[spike.includes('Q'), spike],
			[true, 'M 0.00 18.25 L 6.00 18.25 Q 10.00 18.25 10.00 14.25 L 10.00 7.50 Q 10.00 3.50 14.00 3.50 L 16.00 3.50 Q 20.00 3.50 20.00 7.50 L 20.00 14.25 Q 20.00 18.25 24.00 18.25 L 30.00 18.25'],
		);
	});

	test('roundedStepPath: values above max are clamped to the at-max geometry (y stays on/above baseline)', () => {
		// An over-max spike must trace exactly the same path as one clamped to max - the baseline (max y) is never crossed.
		assert.deepStrictEqual(
			roundedStepPath([0, 200, 0], 100, 30, 20),
			roundedStepPath([0, 100, 0], 100, 30, 20),
		);
	});

	// --- buildModelSeries -------------------------------------------------------------------------------------

	test('buildModelSeries: empty, fully out-of-range, and the data max floored at 1', () => {
		assert.deepStrictEqual(
			[
				buildModelSeries([], '2026-06-01', '2026-06-30', 5),
				buildModelSeries([{ date: '2026-05-01', tokensByModel: { x: 5 } }], '2026-06-01', '2026-06-30', 5),
				buildModelSeries([{ date: '2026-06-02', tokensByModel: { m: 0.4 } }], '2026-06-01', '2026-06-30', 5),
			],
			[
				{ dates: [], max: 1, models: [] },
				{ dates: [], max: 1, models: [] },
				{ dates: ['2026-06-02'], max: 1, models: [{ id: 'm', label: 'm', values: [0.4] }] },
			],
		);
	});

	test('buildModelSeries: a gap zero-fills the date axis, drops zero/over-N models, aligns values', () => {
		// Data on 06-01 and 06-04 (gap of two days), one all-zero model, one model that loses the top-2 cut,
		// and an out-of-range 05-01 row; the axis is the contiguous 4-day span and every model aligns to it.
		assert.deepStrictEqual(
			buildModelSeries([
				{ date: '2026-06-01', tokensByModel: { 'claude-opus-4-8': 100, 'claude-sonnet-4-5': 50, 'zero-model': 0 } },
				{ date: '2026-06-04', tokensByModel: { 'claude-opus-4-8': 200, 'claude-haiku-4-5': 30 } },
				{ date: '2026-05-01', tokensByModel: { 'claude-opus-4-8': 9999 } },
			], '2026-06-01', '2026-06-30', 2),
			{
				dates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'],
				max: 200,
				models: [
					{ id: 'claude-opus-4-8', label: 'Opus 4.8', values: [100, 0, 0, 200] },
					{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', values: [50, 0, 0, 0] },
				],
			},
		);
	});

	// --- effectiveCleanupPeriodDays ---------------------------------------------------------------------------

	test('effectiveCleanupPeriodDays: an integer >= 1 wins; default 30 for unset/zero/fraction/string', () => {
		assert.deepStrictEqual(
			[
				effectiveCleanupPeriodDays({ cleanupPeriodDays: 7 }),
				effectiveCleanupPeriodDays({}),
				effectiveCleanupPeriodDays({ cleanupPeriodDays: 0 }),
				effectiveCleanupPeriodDays({ cleanupPeriodDays: 2.5 }),
				effectiveCleanupPeriodDays({ cleanupPeriodDays: '7' }),
			],
			[7, 30, 30, 30, 30],
		);
	});

	// --- dateKey / windowStartKey -----------------------------------------------------------------------------

	test('dateKey zero-pads local Y-M-D; windowStartKey backs off N-1 days for an inclusive window', () => {
		// 30-day inclusive window ending Sat 2026-06-27 starts 29 days earlier on 2026-05-29.
		assert.deepStrictEqual(
			[dateKey(new Date(2026, 0, 5)), windowStartKey(new Date(2026, 5, 27), 30)],
			['2026-01-05', '2026-05-29'],
		);
	});

	// --- utilStateOf ------------------------------------------------------------------------------------------

	test('utilStateOf: below 70 undefined, [70,90) warn, >= 90 crit (boundaries inclusive)', () => {
		assert.deepStrictEqual(
			[utilStateOf(0), utilStateOf(69), utilStateOf(70), utilStateOf(89), utilStateOf(90), utilStateOf(100)],
			[undefined, undefined, 'warn', 'warn', 'crit', 'crit'],
		);
	});

	// --- limitFillWidthPercent --------------------------------------------------------------------------------

	test('limitFillWidthPercent: zero is 0 (no rounded-cap sliver), any true non-zero floors at 1, clamped to 100', () => {
		assert.deepStrictEqual(
			[
				limitFillWidthPercent(0), limitFillWidthPercent(0.4), limitFillWidthPercent(1),
				limitFillWidthPercent(50), limitFillWidthPercent(100), limitFillWidthPercent(150),
				limitFillWidthPercent(-5), limitFillWidthPercent(NaN),
			],
			[0, 1, 1, 50, 100, 100, 0, 0],
		);
	});

	// --- buildHeatmapModel ------------------------------------------------------------------------------------

	test('buildHeatmapModel: Sunday-aligned grid, week count, 1..4 level buckets, future/out-of-window hidden', () => {
		// 7-day window ending Wed 2026-06-17; the grid starts the prior Sunday (2026-06-07, getDay() === 0) and
		// spans 2 weeks. Counts 1..4 map to levels 1..4 against the in-window max (4); 0 -> level 0. Days before
		// the window start (06-07..06-10) and after today (06-18..06-20) are flagged not visible.
		const model = buildHeatmapModel([
			{ date: '2026-06-11', messageCount: 1 },
			{ date: '2026-06-12', messageCount: 2 },
			{ date: '2026-06-13', messageCount: 3 },
			{ date: '2026-06-14', messageCount: 4 },
		], new Date(2026, 5, 17), 7);
		assert.deepStrictEqual(model, {
			weeks: 2,
			cells: [
				{ key: '2026-06-07', count: 0, level: 0, visible: false },
				{ key: '2026-06-08', count: 0, level: 0, visible: false },
				{ key: '2026-06-09', count: 0, level: 0, visible: false },
				{ key: '2026-06-10', count: 0, level: 0, visible: false },
				{ key: '2026-06-11', count: 1, level: 1, visible: true },
				{ key: '2026-06-12', count: 2, level: 2, visible: true },
				{ key: '2026-06-13', count: 3, level: 3, visible: true },
				{ key: '2026-06-14', count: 4, level: 4, visible: true },
				{ key: '2026-06-15', count: 0, level: 0, visible: true },
				{ key: '2026-06-16', count: 0, level: 0, visible: true },
				{ key: '2026-06-17', count: 0, level: 0, visible: true },
				{ key: '2026-06-18', count: 0, level: 0, visible: false },
				{ key: '2026-06-19', count: 0, level: 0, visible: false },
				{ key: '2026-06-20', count: 0, level: 0, visible: false },
			],
		});
	});
});
