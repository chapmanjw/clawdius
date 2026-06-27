/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN usage status-entry label unit tests
// Covers the pure status-bar label/aria builder (usageStatusText): subscription providers get the Claude mark
// plus "S:" / "W:" block bars; non-subscription providers (and a cold capacity cache) get the bare mark. Also
// the bar-color thresholds (utilState 70 / 90). The DOM hover / refresh / click wiring stays in the (untested)
// contribution class - only the pure helpers are exercised here.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeProvider, IClaudeAccount, IClaudeCapacity } from '../../browser/usage/claudeUsageData.js';
import { blockBar } from '../../browser/usage/claudeUsageCharts.js';
import { usageStatusText, utilState } from '../../browser/usage/claudeUsageStatusEntry.js';

/** NUL sentinel + cell count mirror the status-entry constants (kept ASCII via char code). */
const NUL = String.fromCharCode(0);
const STATUS_BAR_CELLS = 6;
/** Rebuild one labelled bar segment exactly as the entry does, so the snapshot pins the NUL framing + width. */
function seg(util: number): string {
	return `${NUL}usage${NUL}${blockBar(util / 100, STATUS_BAR_CELLS)}${NUL}`;
}

const anthropic: IClaudeAccount = { signedIn: true, provider: ClaudeProvider.Anthropic };
const bedrock: IClaudeAccount = { signedIn: true, provider: ClaudeProvider.Bedrock };

suite('claudeUsageStatusEntry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('usageStatusText: both windows -> mark + S/W bars + percent aria', () => {
		const capacity: IClaudeCapacity = { five_hour: { utilization: 50 }, seven_day: { utilization: 80 } };
		assert.deepStrictEqual(usageStatusText(anthropic, capacity), {
			text: `$(claude) S:${seg(50)}  W:${seg(80)}`,
			ariaLabel: 'Claude Code usage: session 50% used, week 80% used',
		});
	});

	test('usageStatusText: session-only window', () => {
		assert.deepStrictEqual(usageStatusText(anthropic, { five_hour: { utilization: 50 } }), {
			text: `$(claude) S:${seg(50)}`,
			ariaLabel: 'Claude Code usage: session 50% used',
		});
	});

	test('usageStatusText: weekly-only window', () => {
		assert.deepStrictEqual(usageStatusText(anthropic, { seven_day: { utilization: 80 } }), {
			text: `$(claude) W:${seg(80)}`,
			ariaLabel: 'Claude Code usage: week 80% used',
		});
	});

	test('usageStatusText: no windows (cold capacity cache) -> bare mark', () => {
		assert.deepStrictEqual(usageStatusText(anthropic, undefined), {
			text: '$(claude)',
			ariaLabel: 'Claude Code usage',
		});
	});

	test('usageStatusText: a non-subscription provider suppresses the bars even with windows present', () => {
		const capacity: IClaudeCapacity = { five_hour: { utilization: 50 }, seven_day: { utilization: 80 } };
		assert.deepStrictEqual(usageStatusText(bedrock, capacity), {
			text: '$(claude)',
			ariaLabel: 'Claude Code usage',
		});
	});

	test('utilState thresholds: <70 ok, [70,90) warn, >=90 crit', () => {
		assert.deepStrictEqual(
			[utilState(0), utilState(69), utilState(70), utilState(89), utilState(90), utilState(100)],
			['ok', 'ok', 'warn', 'warn', 'crit', 'crit'],
		);
	});
});
// CLAWDIUS-END
