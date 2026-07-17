/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions ultracode workflow enumeration tests
// Drives the seam's MISSION enumeration - the Missions view's primary read - over an in-memory tree staged in the
// launcher's real on-disk layout. The load-bearing property under test is the ASYMMETRY the launcher actually
// exhibits (observed against a live run, not assumed): the run manifest is written ONLY at a terminal state, so a
// journal with no manifest beside it is a run still IN FLIGHT. That is the only way a live mission is visible at
// all, and it is why `running` is inferred from artifact topology rather than read from a status field.
//
// Pinned here: a terminal manifest yields its own status/name/phases/progress; a manifest-less journal is `running`
// + `live` + counted, and is NOT degraded for lacking a manifest (in-flight is not incomplete); a manifest WINS
// over its own journal (the terminal record of the same run); an unrecognized manifest degrades to `unknown-shape`
// + the canary stamp rather than throwing; a stray non-run-id file is not a mission; a plain chat session is NEVER
// enumerated as one (Missions is an ultracode control surface, not a transcript browser); a `no-config` root
// degrades to an empty labeled list; and agents are resolved lazily from the journal, with an agent that never
// reported a result present-with-label (`finished: false`), never omitted.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { MissionRun } from '../../common/claudeFleetModel.js';
import { CompletenessState, FreshnessLabel, ReaderConfigRoot } from '../../common/claudeReaderSeam.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import { ClawdiusReaderSeamService } from '../../browser/reader/claudeReaderSeamService.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';

suite('Clawdius missions - ultracode workflow enumeration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const ROOT = URI.file('/home/tester/.claude');
	const FOLDER = URI.file('/work/fixture-proj');
	const RESOLVED: ReaderConfigRoot = { kind: 'resolved', root: ROOT };
	const SESSION = '5c2af930-2a73-4f6b-9011-72fdfa851624';

	function makeFs(): FileService {
		const fs = store.add(new FileService(new NullLogService()));
		store.add(fs.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		return fs;
	}

	function makeService(fs: FileService): ClawdiusReaderSeamService {
		return new ClawdiusReaderSeamService(false, fs, new TestContextService(testWorkspace(FOLDER)));
	}

	/** The owning session's sidecar dir: `<root>/projects/<enc>/<session>/`. */
	function sessionDir(): URI {
		return URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER), SESSION);
	}

	/** Stage a TERMINAL run: the manifest the launcher writes only once the run finishes. */
	async function stageManifest(fs: FileService, runId: string, manifest: object): Promise<void> {
		const dir = URI.joinPath(sessionDir(), 'workflows');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `${runId}.json`), VSBuffer.fromString(JSON.stringify(manifest)));
	}

	/** Stage a run's journal ledger - written DURING the run, one `started`/`result` per agent. Every record is
	 *  newline-TERMINATED, as the launcher writes them: measured against the real config root, all journals on disk
	 *  end in '\n'. A fixture that omitted the terminator would make the last record look like the half-written tail
	 *  of a live run and quietly test a shape the launcher never emits. */
	async function stageJournal(fs: FileService, runId: string, lines: readonly object[]): Promise<void> {
		await stageJournalText(fs, runId, lines.map(l => JSON.stringify(l) + '\n').join(''));
	}

	/** Stage a journal's RAW text, for the shapes a record list cannot express (a torn line, a live partial tail). */
	async function stageJournalText(fs: FileService, runId: string, text: string): Promise<void> {
		const dir = URI.joinPath(sessionDir(), 'subagents', 'workflows', runId);
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, 'journal.jsonl'), VSBuffer.fromString(text));
	}

	/** Stage an agent's meta sidecar (the role a workflow agent carries; a Task subagent carries a toolUseId). */
	async function stageAgentMeta(fs: FileService, runId: string, agentId: string, agentType: string): Promise<void> {
		const dir = URI.joinPath(sessionDir(), 'subagents', 'workflows', runId);
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `agent-${agentId}.meta.json`), VSBuffer.fromString(JSON.stringify({ agentType })));
	}

	/** A complete manifest in the launcher's real shape. */
	function manifestOf(overrides: object = {}): object {
		return {
			runId: 'wf_f96a6688-77e',
			workflowName: 'unreleased-validation-audit',
			status: 'completed',
			agentCount: 2,
			durationMs: 605027,
			totalTokens: 781753,
			totalToolCalls: 191,
			defaultModel: 'claude-opus-4-8[1m]',
			scriptPath: '/home/tester/.claude/scripts/audit.js',
			phases: [{ title: 'Analyze', detail: 'one agent per theme' }, { title: 'Synthesize' }],
			workflowProgress: [
				{ index: 1, title: 'Analyze', type: 'workflow_phase' },
				{ index: 1, title: 'audit:fleet', type: 'workflow_agent' },
				{ index: 2, title: 'audit:trust', type: 'workflow_agent' },
			],
			...overrides,
		};
	}

	test('a terminal manifest is one mission carrying its own status, name, phases and progress', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_f96a6688-77e', manifestOf());
		const missions = await makeService(fs).listMissions(RESOLVED);

		assert.deepStrictEqual(missions.map(m => ({
			runId: m.runId, sessionId: m.sessionId, name: m.name, status: m.status,
			agentCount: m.agentCount, phases: m.phases.length, progress: m.progress.length,
			durationMs: m.durationMs, totalTokens: m.totalTokens, defaultModel: m.defaultModel,
			freshness: m.freshness, completeness: m.completeness, ownership: m.ownership,
		})), [{
			runId: 'wf_f96a6688-77e', sessionId: SESSION, name: 'unreleased-validation-audit', status: 'completed',
			agentCount: 2, phases: 2, progress: 3,
			durationMs: 605027, totalTokens: 781753, defaultModel: 'claude-opus-4-8[1m]',
			freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete, ownership: 'foreign',
		}]);
	});

	test('a failed manifest keeps its status and carries the recorded error', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_aaaaaaaa-bbb', manifestOf({ runId: 'wf_aaaaaaaa-bbb', status: 'failed', error: 'script threw' }));
		const missions = await makeService(fs).listMissions(RESOLVED);

		assert.deepStrictEqual(missions.map(m => ({ status: m.status, error: m.error })), [{ status: 'failed', error: 'script threw' }]);
	});

	// THE load-bearing case: the manifest does not exist until the run finishes, so this is the ONLY shape a live
	// mission ever has on disk. It must read `running` + `live` and must NOT be degraded for the missing manifest.
	test('a journal with NO manifest is a run in flight: running + live + counted, never degraded', async () => {
		const fs = makeFs();
		await stageJournal(fs, 'wf_d980f960-543', [
			{ type: 'started', agentId: 'a1', key: 'v2:aaa' },
			{ type: 'started', agentId: 'a2', key: 'v2:bbb' },
			{ type: 'result', agentId: 'a1', key: 'v2:aaa', result: 'done' },
		]);
		const missions = await makeService(fs).listMissions(RESOLVED);

		assert.deepStrictEqual(missions.map(m => ({
			runId: m.runId, status: m.status, agentCount: m.agentCount,
			startedCount: m.startedCount, resultCount: m.resultCount,
			freshness: m.freshness, completeness: m.completeness,
		})), [{
			runId: 'wf_d980f960-543', status: 'running', agentCount: 2,
			startedCount: 2, resultCount: 1,
			freshness: FreshnessLabel.Live, completeness: CompletenessState.Complete,
		}]);
	});

	test('a manifest WINS over its own journal - the terminal record of the same run is not also running', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_f96a6688-77e', manifestOf());
		await stageJournal(fs, 'wf_f96a6688-77e', [{ type: 'started', agentId: 'a1' }, { type: 'result', agentId: 'a1' }]);
		const missions = await makeService(fs).listMissions(RESOLVED);

		assert.deepStrictEqual(missions.map(m => ({ runId: m.runId, status: m.status })), [{ runId: 'wf_f96a6688-77e', status: 'completed' }]);
	});

	test('an unrecognized manifest degrades to unknown-shape with the canary stamp, never throws', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_cccccccc-ddd', { totallyDifferent: true });
		const missions = await makeService(fs).listMissions(RESOLVED);

		assert.deepStrictEqual(missions.map(m => ({ name: m.name, status: m.status, completeness: m.completeness })), [
			{ name: 'wf_cccccccc-ddd', status: 'unknown', completeness: CompletenessState.UnknownShape },
		]);
	});

	test('a stray non-run-id file in the workflows dir is not a mission', async () => {
		const fs = makeFs();
		const dir = URI.joinPath(sessionDir(), 'workflows');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, 'notes.json'), VSBuffer.fromString('{"workflowName":"nope","status":"completed"}'));
		assert.deepStrictEqual(await makeService(fs).listMissions(RESOLVED), []);
	});

	// Missions is an ultracode control surface, not a transcript browser: a plain chat session has no run
	// artifacts and must never be enumerated as a mission (the pre-fix view listed 1200 of these and 0 missions).
	test('a plain chat session transcript is never enumerated as a mission', async () => {
		const fs = makeFs();
		const dir = URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER));
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `${SESSION}.jsonl`), VSBuffer.fromString('{"type":"user","uuid":"u1"}'));
		assert.deepStrictEqual(await makeService(fs).listMissions(RESOLVED), []);
	});

	test('a no-config root degrades to an empty labeled list', async () => {
		assert.deepStrictEqual(await makeService(makeFs()).listMissions({ kind: 'no-config' }), []);
	});

	test('missions are ordered most-actionable-first: running, then failed, then completed', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_11111111-aaa', manifestOf({ runId: 'wf_11111111-aaa', status: 'completed' }));
		await stageManifest(fs, 'wf_22222222-bbb', manifestOf({ runId: 'wf_22222222-bbb', status: 'failed' }));
		await stageJournal(fs, 'wf_33333333-ccc', [{ type: 'started', agentId: 'a1' }]);
		const missions = await makeService(fs).listMissions(RESOLVED);

		assert.deepStrictEqual(missions.map(m => m.status), ['running', 'failed', 'completed']);
	});

	test('agents resolve lazily from the journal; a started-but-unfinished agent is present-with-label', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_f96a6688-77e', manifestOf());
		await stageJournal(fs, 'wf_f96a6688-77e', [
			{ type: 'started', agentId: 'a1' },
			{ type: 'started', agentId: 'a2' },
			{ type: 'result', agentId: 'a1', result: 'ok' },
		]);
		await stageAgentMeta(fs, 'wf_f96a6688-77e', 'a1', 'workflow-subagent');
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as MissionRun;
		const agents = await service.listMissionAgents(RESOLVED, mission);

		assert.deepStrictEqual(agents.agents.map(a => ({ agentId: a.agentId, runId: a.runId, agentType: a.agentType, finished: a.finished })), [
			{ agentId: 'a1', runId: 'wf_f96a6688-77e', agentType: 'workflow-subagent', finished: true },
			{ agentId: 'a2', runId: 'wf_f96a6688-77e', agentType: undefined, finished: false },
		]);
	});

	// The journal analogue of the transcript's torn-record hole, and the same lie: these counts are DERIVED from the
	// journal's records, so a dropped `started`/`result` silently undercounts a live mission's agents. Reported as
	// `complete` alongside `freshness: live`, a short count reads as a confident one. A tear must degrade to
	// `partial` - the counts remain the best available, they just stop claiming to be whole.
	test('a torn journal line is a known gap: the live mission counts what it can and reports partial', async () => {
		const fs = makeFs();
		// Two agents started, one finished, and a THIRD `started` record torn mid-file (the launcher wrote it, then
		// it was damaged) - so the honest read is 2 started / 1 result, labeled as incomplete rather than whole.
		await stageJournalText(fs, 'wf_a1b2c3d4-e5f',
			JSON.stringify({ type: 'started', agentId: 'a-1' }) + '\n'
			+ JSON.stringify({ type: 'started', agentId: 'a-2' }) + '\n'
			+ '{"type":"started","agen' + '\n'
			+ JSON.stringify({ type: 'result', agentId: 'a-1' }) + '\n');
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{ status: mission.status, started: mission.startedCount, results: mission.resultCount, completeness: mission.completeness },
			{ status: 'running', started: 2, results: 1, completeness: CompletenessState.Partial });
	});

	test('a live journal whose last record is still being written is NOT torn (an in-flight run stays whole)', async () => {
		const fs = makeFs();
		// The launcher appends record-by-record, so a journal read mid-write ends in a half-line. That is the live
		// tail, not damage: skipped before any parse, exactly as the transcript reader does, so an in-flight mission
		// is not permanently labeled `partial` merely for being in flight.
		await stageJournalText(fs, 'wf_b2c3d4e5-f60',
			JSON.stringify({ type: 'started', agentId: 'a-1' }) + '\n'
			+ '{"type":"started","agen');
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{ status: mission.status, started: mission.startedCount, completeness: mission.completeness },
			{ status: 'running', started: 1, completeness: CompletenessState.Complete });
	});

	// F4 from review: the agent-list guards below were previously asserted by nothing - deleting them left the suite
	// green. Each of these fails if its guard is removed, which is the only thing that makes the guard real.

	test('a torn journal degrades the AGENT LIST, and every row it did produce, to partial', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifestOf({ status: 'completed' }));
		await stageJournalText(fs, 'wf_a1b2c3d4-e5f',
			JSON.stringify({ type: 'started', agentId: 'a1' }) + '\n'
			+ '{"type":"started","agen' + '\n'
			+ JSON.stringify({ type: 'result', agentId: 'a1' }) + '\n');
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as MissionRun;
		const list = await service.listMissionAgents(RESOLVED, mission);
		// The surviving row is real and still listed - but it must not read `complete` off a manifest while the
		// journal beside it lost an agent the row cannot mention.
		assert.deepStrictEqual(
			{ completeness: list.completeness, rows: list.agents.map(a => ({ id: a.agentId, c: a.completeness })) },
			{ completeness: CompletenessState.Partial, rows: [{ id: 'a1', c: CompletenessState.Partial }] });
	});

	test('an agent id that is not path-safe is dropped AND degrades the list', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifestOf({ status: 'completed' }));
		// `../../escape` would steer the `agent-<id>.jsonl` join outside the mission dir. Refusing to join it means
		// that agent cannot be listed, which is a gap in the list, not a silent omission.
		await stageJournal(fs, 'wf_a1b2c3d4-e5f', [
			{ type: 'started', agentId: 'a1' },
			{ type: 'started', agentId: '../../escape' },
		]);
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as MissionRun;
		const list = await service.listMissionAgents(RESOLVED, mission);
		assert.deepStrictEqual(
			{ completeness: list.completeness, ids: list.agents.map(a => a.agentId) },
			{ completeness: CompletenessState.Partial, ids: ['a1'] });
	});

	test('a non-string agent id is a dropped record on the LIVE path, not a silently uncounted agent', async () => {
		const fs = makeFs();
		// Found by mutation-testing the recognizer: without its `typeof agentId === 'string'` check this record
		// survives with `agentId: undefined` (readString coerces it away), so `missionFromJournal`'s
		// `type === 'started' && r.agentId` filter quietly skips it and NOTHING marks the read torn - the mission
		// loses an agent and still reports `complete`. The agent-list path masks this (isAgentId drops it either
		// way), so only the live counts expose it.
		await stageJournalText(fs, 'wf_a1b2c3d4-e5f',
			JSON.stringify({ type: 'started', agentId: 'a1' }) + '\n'
			+ JSON.stringify({ type: 'started', agentId: 7 }) + '\n');
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{ started: mission.startedCount, completeness: mission.completeness },
			{ started: 1, completeness: CompletenessState.Partial });
	});

	test('a TERMINAL mission\'s unterminated last line is damage, not a live tail', async () => {
		const fs = makeFs();
		// The lifecycle distinction: nothing appends to a finished run, so a half-written last record can only be
		// damage. Exempting it here - as the live path rightly does - would let a corrupt terminal journal report a
		// whole read.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifestOf({ status: 'completed' }));
		await stageJournalText(fs, 'wf_a1b2c3d4-e5f',
			JSON.stringify({ type: 'started', agentId: 'a1' }) + '\n'
			+ '{"type":"started","agen');
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as MissionRun;
		const list = await service.listMissionAgents(RESOLVED, mission);
		assert.deepStrictEqual(
			{ completeness: list.completeness, ids: list.agents.map(a => a.agentId) },
			{ completeness: CompletenessState.Partial, ids: ['a1'] });
	});

	test('when EVERY agent is unreadable the list is empty but still says partial, never a bare []', async () => {
		const fs = makeFs();
		// The limit case the envelope exists for: with no label, this is indistinguishable from a mission that ran
		// no agents at all - opposite facts, identical output.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifestOf({ status: 'completed' }));
		await stageJournalText(fs, 'wf_a1b2c3d4-e5f', '{"type":"started","agen' + '\n' + '{"type":"star' + '\n');
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(await service.listMissionAgents(RESOLVED, mission),
			{ agents: [], completeness: CompletenessState.Partial });
	});

	test('a mission with no journal lists no agents rather than throwing', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_f96a6688-77e', manifestOf());
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as MissionRun;
		// No journal at all is `absent` - there was nothing to read - which is a different claim from `partial` (a
		// read that lost something) and from a mission that genuinely ran no agents.
		assert.deepStrictEqual(await service.listMissionAgents(RESOLVED, mission),
			{ agents: [], completeness: CompletenessState.Absent });
	});
});
// CLAWDIUS-END
