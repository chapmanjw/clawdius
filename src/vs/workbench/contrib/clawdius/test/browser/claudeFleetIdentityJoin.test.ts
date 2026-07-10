/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet identity-join tests
// Drives the pure `joinFleetIdentity` correlation over the sanitized read-model skeletons in `identity/`:
//   • clean: every subagent correlates to its correct run with NO cross-run mixup, and - with an owned
//     set built the way the ownership probe builds it (`AgentSession.id` over a `<provider>:/<rawId>` URI) - the
//     run whose `sessionId` equals that raw id is `active` while the other is `detached`, proving the
//     `AgentSession.id` <-> `FleetRun.sessionId` namespace join is exact string equality.
//   • collision: a subagent id reused across two runs is labeled `ambiguous` and held out of any single group,
//     never merged; a distinct clean subagent still correlates.
//   • ambiguous: a duplicated run identity yields `ambiguous` groups and an `ambiguous` unjoined subagent; an
//     orphan subagent (parent run absent) is labeled `orphan`; a degraded (unknown-shape) run's lifecycle is
//     `unknown`.

import assert from 'assert';
import { FileAccess } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { FleetRun, FleetSubagent } from '../../common/claudeFleetModel.js';
import { joinFleetIdentity } from '../../common/claudeFleetIdentityJoin.js';

// The committed JSON skeletons are the single source of truth, read via the browser harness's file bridge (the
// same mechanism the enumeration/seam tests use) - no inline duplicate fixtures.
declare const __readFileInTests: (path: string) => Promise<string>;
const FIXTURE_DIR = 'vs/workbench/contrib/clawdius/test/fixtures/reader-seam/identity';

interface IJoinFixture {
	readonly runs: FleetRun[];
	readonly subagents: FleetSubagent[];
}

async function loadFixture(name: string): Promise<IJoinFixture> {
	const src = URI.joinPath(FileAccess.asFileUri(''), '../src');
	return JSON.parse(await __readFileInTests(URI.joinPath(src, FIXTURE_DIR, name).fsPath)) as IJoinFixture;
}

/** A compact, snapshot-friendly projection of a group: identity + the ids it grouped + its labels. */
function summarizeGroups(join: ReturnType<typeof joinFleetIdentity>) {
	return join.groups.map(g => ({
		runId: g.run.runId,
		sessionId: g.run.sessionId,
		subagentIds: g.subagents.map(s => s.subagentId),
		confidence: g.confidence,
		lifecycle: g.lifecycle,
	}));
}

/** A compact projection of the unjoined subagents: which subagent, its named parent, and why it stayed out. */
function summarizeUnjoined(join: ReturnType<typeof joinFleetIdentity>) {
	return join.unjoined.map(u => ({
		subagentId: u.subagent.subagentId,
		parentRunId: u.subagent.parentRunId,
		reason: u.reason,
	}));
}

suite('Clawdius missions fleet - identity join', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('clean: subagents correlate to the correct run, and the sessionId liveness join marks the held run active', async () => {
		const { runs, subagents } = await loadFixture('clean.json');
		// The owned set is built the way the ownership probe builds it: AgentSession.id over a <provider>:/<rawId>
		// session URI. That raw id is the SAME string as FleetRun.sessionId, so run-alpha resolves active.
		const ownedSessionIds = new Set<string>([AgentSession.id(AgentSession.uri('claude', 'sess-alpha-0001'))]);
		const join = joinFleetIdentity({ runs, subagents, ownedSessionIds });
		assert.deepStrictEqual(
			{ groups: summarizeGroups(join), unjoined: summarizeUnjoined(join) },
			{
				groups: [
					{ runId: 'run-alpha', sessionId: 'sess-alpha-0001', subagentIds: ['sub-alpha-a', 'sub-alpha-b'], confidence: 'high', lifecycle: 'active' },
					{ runId: 'run-beta', sessionId: 'sess-beta-0002', subagentIds: ['sub-beta-a'], confidence: 'high', lifecycle: 'detached' },
				],
				unjoined: [],
			},
		);
	});

	test('collision: a subagent id reused across runs is labeled ambiguous and never merged into one run', async () => {
		const { runs, subagents } = await loadFixture('collision.json');
		const join = joinFleetIdentity({ runs, subagents });
		assert.deepStrictEqual(
			{ groups: summarizeGroups(join), unjoined: summarizeUnjoined(join) },
			{
				groups: [
					// run-x keeps only its distinct clean subagent; the reused id is held out of BOTH groups.
					{ runId: 'run-x', sessionId: 'sess-x-0001', subagentIds: ['sub-x-clean'], confidence: 'ambiguous', lifecycle: 'unknown' },
					{ runId: 'run-y', sessionId: 'sess-y-0002', subagentIds: [], confidence: 'ambiguous', lifecycle: 'unknown' },
				],
				unjoined: [
					{ subagentId: 'sub-shared', parentRunId: 'run-x', reason: 'ambiguous' },
					{ subagentId: 'sub-shared', parentRunId: 'run-y', reason: 'ambiguous' },
				],
			},
		);
	});

	test('ambiguous: a duplicated run identity is ambiguous, an orphan is labeled, a degraded run is lifecycle unknown', async () => {
		const { runs, subagents } = await loadFixture('ambiguous.json');
		// A liveness poll is supplied but holds neither run, so a healthy run is detached and the degraded run unknown.
		const join = joinFleetIdentity({ runs, subagents, ownedSessionIds: new Set<string>() });
		assert.deepStrictEqual(
			{ groups: summarizeGroups(join), unjoined: summarizeUnjoined(join) },
			{
				groups: [
					{ runId: 'run-dup', sessionId: 'sess-dup-a-0001', subagentIds: [], confidence: 'ambiguous', lifecycle: 'detached' },
					{ runId: 'run-dup', sessionId: 'sess-dup-b-0002', subagentIds: [], confidence: 'ambiguous', lifecycle: 'detached' },
					{ runId: 'run-degraded', sessionId: 'sess-degraded-0003', subagentIds: [], confidence: 'high', lifecycle: 'unknown' },
				],
				unjoined: [
					{ subagentId: 'sub-dup-child', parentRunId: 'run-dup', reason: 'ambiguous' },
					{ subagentId: 'sub-orphan', parentRunId: 'run-missing', reason: 'orphan' },
				],
			},
		);
	});
});
// CLAWDIUS-END
