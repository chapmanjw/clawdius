/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet ownership-probe tests
// Exercises the PURE ownership resolver + the thin `getActiveSubscriptions()` adapter mapping against injected
// data - NO live agent host. Proves: `resolveOwnership` returns `owned` iff the run's `sessionId` is in the
// owned set and `foreign` otherwise (the never-falsely-owned safety floor); the adapter keeps only
// `StateComponents.Session` subscriptions and extracts each raw id via `AgentSession.id`; and that when the
// agent-host raw id and a seam-style `FleetRun.sessionId` are the SAME string the run resolves `owned` (the join
// mechanism), while a run whose id does not align stays `foreign` (the honest default - the namespace
// join is future work).

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { IActiveSubscriptionInfo } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import { StateComponents } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { ownedSessionIdsFromSubscriptions, resolveOwnership } from '../../browser/missions/claudeMissionOwnership.js';
import { AdapterVersionStamp, CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';
import { FleetRun } from '../../common/claudeFleetModel.js';

const STAMP: AdapterVersionStamp = { format: 'transcript-jsonl', versionKey: 'v1' };

/** A minimally-labeled `FleetRun` carrying the given session id - enumeration always emits `foreign`. */
function run(sessionId: string): FleetRun {
	return {
		runId: `run-${sessionId}`,
		sessionId,
		kind: 'single',
		status: 'unknown',
		ownership: 'foreign',
		coverage: CoverageLabel.InScope,
		freshness: FreshnessLabel.Polled,
		completeness: CompletenessState.Complete,
		adapterVersion: STAMP,
	};
}

/** A realistic active subscription of the given kind over a `<provider>:/<rawId>` session URI. */
function subscription(kind: StateComponents, provider: string, rawId: string): IActiveSubscriptionInfo {
	return {
		resource: AgentSession.uri(provider, rawId),
		kind,
		refCount: 1,
		holders: [{ owner: 'test', count: 1 }],
		status: 'snapshot',
	};
}

suite('Clawdius missions fleet - ownership probe', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolveOwnership: owned iff sessionId is in the owned set, else foreign (safety floor)', () => {
		const owned = new Set<string>(['sess-held']);
		assert.deepStrictEqual(
			[resolveOwnership(run('sess-held'), owned), resolveOwnership(run('sess-disk-only'), owned)],
			['owned', 'foreign'],
		);
	});

	test('resolveOwnership: an empty owned set never promotes any run (never falsely owned)', () => {
		assert.strictEqual(resolveOwnership(run('sess-any'), new Set<string>()), 'foreign');
	});

	test('adapter: maps only Session subscriptions through AgentSession.id into the owned set', () => {
		const subs: IActiveSubscriptionInfo[] = [
			subscription(StateComponents.Session, 'claude', 'raw-owned-1'),
			subscription(StateComponents.Session, 'claude', 'raw-owned-2'),
			subscription(StateComponents.Chat, 'claude', 'raw-chat'),
			subscription(StateComponents.Terminal, 'claude', 'raw-terminal'),
		];
		assert.deepStrictEqual(
			[...ownedSessionIdsFromSubscriptions(subs)].sort(),
			['raw-owned-1', 'raw-owned-2'],
		);
	});

	test('join: a run whose sessionId equals the adapter raw id resolves owned; a mismatch stays foreign', () => {
		// When the agent-host raw id and the seam-style FleetRun.sessionId are the SAME string, the join fires
		// (owned). When they do not align - the namespace question left for future work - the run stays
		// foreign, the honest never-falsely-owned default.
		const owned = ownedSessionIdsFromSubscriptions([subscription(StateComponents.Session, 'claude', 'shared-id')]);
		assert.deepStrictEqual(
			[resolveOwnership(run('shared-id'), owned), resolveOwnership(run('different-namespace-id'), owned)],
			['owned', 'foreign'],
		);
	});
});
// CLAWDIUS-END
