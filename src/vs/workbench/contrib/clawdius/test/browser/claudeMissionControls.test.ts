/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet - owned-run control tests
// Carries the OWNED stop/steer positive proof the sanitized Playwright harness cannot produce (its null agent
// host has no owned session, so every harness run is foreign). Proves, against an injected control host - no live
// agent host:
//   - an OWNED run exposes {stop, steerInFlight}; invoking them DISPATCHES a ChatTurnCancelled / a
//     ChatPendingMessageSet (kind Steering) action via the host `dispatch` (spied) - never a direct abortSession
//     (that runs node-side on the per-provider IAgent, unreachable from the browser);
//   - a FOREIGN run exposes ONLY {terminalHandoff} and no control verb - invoking it reveals the run read-only;
//   - the CEILING guard: the affordance set is exactly the three named verbs, and a source-scan asserts
//     the unplumbed low-level interrupt/stop-task stub names appear NOWHERE in the control module.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ActionType } from '../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import { PendingMessageKind } from '../../../../../platform/agentHost/common/state/protocol/channels-chat/state.js';
import { FleetControlAction, IMissionControlHost, affordancesFor, controlChannelForRun } from '../../browser/missions/claudeMissionControls.js';
import { FleetRun } from '../../common/claudeFleetModel.js';
import { CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';

/** A minimally-labeled FleetRun carrying the given ids - enumeration always emits `foreign`. */
function run(runId: string, sessionId: string): FleetRun {
	return {
		runId, sessionId, kind: 'single', status: 'unknown', ownership: 'foreign',
		coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete,
		adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
	};
}

/** One recorded dispatch call (the channel the action rode + the action itself). */
interface DispatchCall {
	readonly channel: string;
	readonly action: FleetControlAction;
}

/** A recording control host: captures dispatch calls, holds an owned set + an optional active-turn id, and
 *  records the read-only reveal - so the test drives the real affordance path without a live agent host. */
function host(ownedSessionIds: ReadonlySet<string>, activeTurnId: string | undefined): {
	readonly source: IMissionControlHost;
	readonly dispatched: DispatchCall[];
	readonly revealed: FleetRun[];
} {
	const dispatched: DispatchCall[] = [];
	const revealed: FleetRun[] = [];
	return {
		dispatched,
		revealed,
		source: {
			dispatch: (channel, action) => { dispatched.push({ channel, action }); },
			getOwnedSessionIds: () => ownedSessionIds,
			getActiveTurnId: () => activeTurnId,
			revealReadOnly: r => { revealed.push(r); },
		},
	};
}

suite('Clawdius missions fleet - owned-run control', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const OWNED = run('owned-0001', 'sess-owned');
	const FOREIGN = run('foreign-0001', 'sess-foreign');

	test('an OWNED run stop dispatches ChatTurnCancelled on the run session default chat channel (not abortSession)', () => {
		const h = host(new Set(['sess-owned']), 'turn-42');
		const aff = affordancesFor(OWNED, h.source);
		assert.strictEqual(aff.ownership, 'owned');
		if (aff.ownership !== 'owned') { return; }
		aff.stop();
		assert.deepStrictEqual(h.dispatched, [{
			channel: controlChannelForRun(OWNED),
			action: { type: ActionType.ChatTurnCancelled, turnId: 'turn-42' },
		}]);
	});

	test('an OWNED run stop with no in-flight turn is a noop-success (nothing to cancel)', () => {
		const h = host(new Set(['sess-owned']), undefined);
		const aff = affordancesFor(OWNED, h.source);
		if (aff.ownership !== 'owned') { assert.fail('expected owned'); }
		aff.stop();
		assert.deepStrictEqual(h.dispatched, []);
	});

	test('an OWNED run steerInFlight dispatches ChatPendingMessageSet with the STEERING kind, not queued', () => {
		const h = host(new Set(['sess-owned']), 'turn-42');
		const aff = affordancesFor(OWNED, h.source);
		if (aff.ownership !== 'owned') { assert.fail('expected owned'); }
		aff.steerInFlight('narrow it to the failing test');
		const call = h.dispatched[0];
		const action = call?.action.type === ActionType.ChatPendingMessageSet ? call.action : undefined;
		assert.deepStrictEqual(
			{
				count: h.dispatched.length,
				channel: call?.channel,
				type: action?.type,
				kind: action?.kind,
				notQueued: action?.kind !== PendingMessageKind.Queued,
				text: action?.message.text,
			},
			{
				count: 1,
				channel: controlChannelForRun(OWNED),
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Steering,
				notQueued: true,
				text: 'narrow it to the failing test',
			},
		);
	});

	test('a FOREIGN run exposes ONLY a read-only terminal handoff - no control verb', () => {
		const h = host(new Set(['sess-owned']), 'turn-42');
		const aff = affordancesFor(FOREIGN, h.source);
		assert.strictEqual(aff.ownership, 'foreign');
		if (aff.ownership !== 'foreign') { return; }
		aff.terminalHandoff();
		const keys = Object.keys(aff);
		assert.deepStrictEqual(
			{
				verbs: keys.filter(k => k !== 'ownership').sort(),
				hasStop: keys.includes('stop'),
				hasSteer: keys.includes('steerInFlight'),
				dispatched: h.dispatched.length,
				revealed: h.revealed.map(r => r.runId),
			},
			{ verbs: ['terminalHandoff'], hasStop: false, hasSteer: false, dispatched: 0, revealed: ['foreign-0001'] },
		);
	});

	test('CEILING: the control surface is only {stop, steerInFlight, terminalHandoff}; no interrupt/stop-task stub appears', async () => {
		const ownedVerbs = Object.keys(affordancesFor(OWNED, host(new Set(['sess-owned']), 'turn-42').source)).filter(k => k !== 'ownership').sort();
		const foreignVerbs = Object.keys(affordancesFor(FOREIGN, host(new Set(['sess-owned']), 'turn-42').source)).filter(k => k !== 'ownership').sort();
		const source = await (await fetch(new URL('../../browser/missions/claudeMissionControls.js', import.meta.url))).text();
		assert.deepStrictEqual(
			{
				ownedVerbs,
				foreignVerbs,
				hasQueryInterrupt: /Query\.interrupt/.test(source),
				hasStopTask: /\bstopTask\b/.test(source),
			},
			{
				ownedVerbs: ['steerInFlight', 'stop'],
				foreignVerbs: ['terminalHandoff'],
				hasQueryInterrupt: false,
				hasStopTask: false,
			},
		);
	});
});
// CLAWDIUS-END
