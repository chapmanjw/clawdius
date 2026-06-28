/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN effort-level status pill (N3-3d) unit tests
// Covers the chat-matching labels, the 10-cell meter mapping (Max one short of full, only Ultracode full),
// the animation state per selection (rainbow for Max, purple-white for Ultracode), Ultracode winning over the
// level, and the settings.json write logic (a normal level clears the ultracode key; Ultracode sets it true).

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	EFFORT_LEVEL_KEY,
	ULTRACODE_KEY,
	IEffortWrite,
	effortDisplay,
	effortPicks,
	effortWrites,
	meterMarkup,
	parseEffortLevel,
	parseSettingsState,
	planEffortEdit,
} from '../../browser/clawdiusEffortStatusEntry.js';

/** U+2588 FULL BLOCK, referenced by code point to keep this source ASCII-only. */
const FULL = String.fromCharCode(0x2588);
function filledCells(meter: string): number {
	return meter.split(FULL).length - 1;
}

/**
 * Mirror of IJSONEditingService's merge for single-segment paths: set the key, or delete it when the value is
 * undefined. Used to prove our write intents preserve unrelated keys (the real edit is exercised at runtime).
 */
function applyWrites(base: Record<string, unknown>, writes: readonly IEffortWrite[]): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const w of writes) {
		const key = w.path[0];
		if (w.value === undefined) {
			delete out[key];
		} else {
			out[key] = w.value;
		}
	}
	return out;
}

suite('Clawdius effort pill', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('settings keys match the CLI source-of-truth file', () => {
		assert.strictEqual(EFFORT_LEVEL_KEY, 'effortLevel');
		assert.strictEqual(ULTRACODE_KEY, 'ultracode');
	});

	test('parseEffortLevel accepts the five levels and rejects everything else', () => {
		assert.strictEqual(parseEffortLevel('low'), 'low');
		assert.strictEqual(parseEffortLevel('xhigh'), 'xhigh');
		assert.strictEqual(parseEffortLevel('max'), 'max');
		assert.strictEqual(parseEffortLevel(undefined), undefined);
		assert.strictEqual(parseEffortLevel('ultracode'), undefined); // ultracode is a flag, not a level
		assert.strictEqual(parseEffortLevel('nonsense'), undefined);
	});

	test('labels mirror the plugin effort selector', () => {
		assert.strictEqual(effortDisplay('low', false).label, 'Low');
		assert.strictEqual(effortDisplay('medium', false).label, 'Medium');
		assert.strictEqual(effortDisplay('high', false).label, 'High');
		assert.strictEqual(effortDisplay('xhigh', false).label, 'Extra high');
		assert.strictEqual(effortDisplay('max', false).label, 'Max');
	});

	test('10-cell meter: 2/4/6/8 for low..xhigh, Max=9 (one short of full), Ultracode=10 (full), Auto=0', () => {
		assert.strictEqual(filledCells(effortDisplay('low', false).meter), 2);
		assert.strictEqual(filledCells(effortDisplay('medium', false).meter), 4);
		assert.strictEqual(filledCells(effortDisplay('high', false).meter), 6);
		assert.strictEqual(filledCells(effortDisplay('xhigh', false).meter), 8);
		assert.strictEqual(filledCells(effortDisplay('max', false).meter), 9);
		assert.strictEqual(filledCells(effortDisplay('xhigh', true).meter), 10); // ultracode
		assert.strictEqual(filledCells(effortDisplay(undefined, false).meter), 0); // auto
	});

	test('Max and Ultracode have DIFFERENT meters (only Ultracode is full)', () => {
		const max = effortDisplay('max', false);
		const ultra = effortDisplay('xhigh', true);
		assert.strictEqual(max.level, 9);
		assert.strictEqual(ultra.level, 10);
		assert.notStrictEqual(max.meter, ultra.meter);
	});

	test('meter fills are monotonic increasing Auto<Low<Medium<High<Extra high<Max<Ultracode', () => {
		const fills = [
			effortDisplay(undefined, false),
			effortDisplay('low', false),
			effortDisplay('medium', false),
			effortDisplay('high', false),
			effortDisplay('xhigh', false),
			effortDisplay('max', false),
			effortDisplay('xhigh', true),
		].map(d => filledCells(d.meter));
		assert.deepStrictEqual(fills, [0, 2, 4, 6, 8, 9, 10]);
	});

	test('animation: rainbow for Max, purple-white for Ultracode, none otherwise', () => {
		assert.strictEqual(effortDisplay('max', false).animate, 'rainbow');
		assert.strictEqual(effortDisplay('xhigh', true).animate, 'ultra');
		for (const lvl of ['low', 'medium', 'high', 'xhigh'] as const) {
			assert.strictEqual(effortDisplay(lvl, false).animate, 'none');
		}
		assert.strictEqual(effortDisplay(undefined, false).animate, 'none');
	});

	test('Ultracode wins over the level, is full intensity, and is purple-toned', () => {
		const d = effortDisplay('xhigh', true);
		assert.strictEqual(d.selection, 'ultracode');
		assert.strictEqual(d.label, 'Ultracode');
		assert.strictEqual(d.level, 10);
		assert.strictEqual(d.tone, 'ultra');
		assert.strictEqual(effortDisplay('low', true).selection, 'ultracode');
	});

	test('only Ultracode gets the filled purple pill tone', () => {
		for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
			assert.strictEqual(effortDisplay(lvl, false).tone, 'none');
		}
		assert.strictEqual(effortDisplay(undefined, false).tone, 'none');
		assert.strictEqual(effortDisplay('xhigh', true).tone, 'ultra');
	});

	test('picker offers the five levels plus Ultracode, in order, with the current marked', () => {
		const picks = effortPicks('high');
		assert.deepStrictEqual(picks.map(p => p.selection), ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
		const current = picks.filter(p => p.description === 'Current');
		assert.strictEqual(current.length, 1);
		assert.strictEqual(current[0].selection, 'high');
	});

	test('selecting a normal level writes effortLevel and CLEARS the ultracode key (never false)', () => {
		for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
			// Exact match: the ultracode key is DELETED (value undefined), never written as false.
			assert.deepStrictEqual(effortWrites(lvl), [
				{ path: [EFFORT_LEVEL_KEY], value: lvl },
				{ path: [ULTRACODE_KEY], value: undefined },
			]);
		}
	});

	test('selecting Ultracode writes effortLevel:xhigh AND ultracode:true', () => {
		assert.deepStrictEqual(effortWrites('ultracode'), [
			{ path: [EFFORT_LEVEL_KEY], value: 'xhigh' },
			{ path: [ULTRACODE_KEY], value: true },
		]);
	});

	test('parseSettingsState: missing/empty/whitespace files need a seed and read as empty', () => {
		for (const raw of [undefined, '', '   ', '\n\t']) {
			assert.deepStrictEqual(parseSettingsState(raw), { kind: 'ok', settings: {}, needsSeed: true });
		}
	});

	test('parseSettingsState: valid JSON reads effort + ultracode and never needs a seed', () => {
		assert.deepStrictEqual(parseSettingsState('{"effortLevel":"high","ultracode":false}'), {
			kind: 'ok', settings: { effortLevel: 'high', ultracode: false }, needsSeed: false,
		});
		assert.deepStrictEqual(parseSettingsState('{"effortLevel":"xhigh","ultracode":true}'), {
			kind: 'ok', settings: { effortLevel: 'xhigh', ultracode: true }, needsSeed: false,
		});
		// A non-string effortLevel and a non-true ultracode normalize to undefined/false.
		assert.deepStrictEqual(parseSettingsState('{"effortLevel":5}'), {
			kind: 'ok', settings: { effortLevel: undefined, ultracode: false }, needsSeed: false,
		});
	});

	test('parseSettingsState: a malformed file is invalid (so it is never fed to the JSON editor)', () => {
		assert.deepStrictEqual(parseSettingsState('{ not json'), { kind: 'invalid' });
		assert.deepStrictEqual(parseSettingsState('{"effortLevel":"high"'), { kind: 'invalid' });
	});

	test('applying a normal-level write preserves unrelated keys and removes the ultracode flag', () => {
		const before = { model: 'claude', effortLevel: 'xhigh', ultracode: true, mcpServers: { a: 1 } };
		assert.deepStrictEqual(applyWrites(before, effortWrites('low')), {
			model: 'claude', effortLevel: 'low', mcpServers: { a: 1 },
		});
	});

	test('applying the Ultracode write preserves unrelated keys and sets xhigh + ultracode:true', () => {
		const before = { model: 'claude', effortLevel: 'low', theme: 'dark' };
		assert.deepStrictEqual(applyWrites(before, effortWrites('ultracode')), {
			model: 'claude', effortLevel: 'xhigh', theme: 'dark', ultracode: true,
		});
	});

	test('meterMarkup frames the meter in NUL sentinels and maps the animation to a state class', () => {
		const NUL = String.fromCharCode(0);
		const max = effortDisplay('max', false);     // animate: rainbow -> state-max
		const ultra = effortDisplay('xhigh', true);   // animate: ultra   -> state-ultra
		const plain = effortDisplay('low', false);    // animate: none    -> state-plain
		assert.deepStrictEqual([meterMarkup(max), meterMarkup(ultra), meterMarkup(plain)], [
			`${NUL}state-max${NUL}${max.meter}${NUL}`,
			`${NUL}state-ultra${NUL}${ultra.meter}${NUL}`,
			`${NUL}state-plain${NUL}${plain.meter}${NUL}`,
		]);
	});

	test('effortDisplay tooltip + ariaLabel: ultracode / auto / a normal level', () => {
		const ultra = effortDisplay('xhigh', true);
		const auto = effortDisplay(undefined, false);
		const high = effortDisplay('high', false);
		assert.deepStrictEqual({
			ultraTooltip: ultra.tooltip.includes('standing dynamic-workflow orchestration'),
			ultraAria: ultra.ariaLabel,
			autoTooltip: auto.tooltip.includes('Claude picks per task'),
			autoAria: auto.ariaLabel,
			highTooltip: high.tooltip.includes('effort for new Claude conversations'),
			highAria: high.ariaLabel,
		}, {
			ultraTooltip: true,
			ultraAria: 'Claude default effort: Ultracode',
			autoTooltip: true,
			autoAria: 'Claude default effort: Auto',
			highTooltip: true,
			highAria: 'Claude default effort: High',
		});
	});

	test('effortPicks marks Ultracode as current when chosen; auto marks nothing', () => {
		const ultraCurrent = effortPicks('ultracode').filter(p => p.description === 'Current').map(p => p.selection);
		const autoCurrent = effortPicks('auto').filter(p => p.description === 'Current').map(p => p.selection);
		assert.deepStrictEqual({ ultraCurrent, autoCurrent }, { ultraCurrent: ['ultracode'], autoCurrent: [] });
	});

	test('planEffortEdit mirrors the full run() branch matrix', () => {
		const ok = parseSettingsState('{}');           // ok, needsSeed false
		const seed = parseSettingsState(undefined);     // ok, needsSeed true
		const invalid = parseSettingsState('{ bad');    // invalid
		const chosen = { selection: 'high' as const };
		assert.deepStrictEqual([
			planEffortEdit(invalid, chosen, 'low', ok),                        // 1: initial read invalid
			planEffortEdit(ok, undefined, 'low', undefined),                   // 2a: nothing chosen
			planEffortEdit(ok, { selection: 'low' as const }, 'low', undefined), // 2b: chose the current
			planEffortEdit(ok, chosen, 'low', invalid),                        // 3: re-read invalid mid-pick
			planEffortEdit(ok, chosen, 'low', seed),                           // 4a: write + seed
			planEffortEdit(ok, chosen, 'low', ok),                             // 4b: write, no seed
		], [
			{ action: 'invalid', seed: false, writes: [] },
			{ action: 'noop', seed: false, writes: [] },
			{ action: 'noop', seed: false, writes: [] },
			{ action: 'invalid', seed: false, writes: [] },
			{ action: 'write', seed: true, writes: effortWrites('high') },
			{ action: 'write', seed: false, writes: effortWrites('high') },
		]);
	});
});
// CLAWDIUS-END
