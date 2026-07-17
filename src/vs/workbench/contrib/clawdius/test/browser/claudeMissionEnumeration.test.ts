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
			// The REAL shapes, measured against the config root: a phase entry names itself `title`, an agent entry
			// names itself `label` and carries its own agentId/model/counters. A fixture that gave agents a `title`
			// tested a manifest the launcher never writes - and hid that the reader dropped every real agent entry.
			workflowProgress: [
				{ index: 1, title: 'Analyze', type: 'workflow_phase' },
				{ index: 1, label: 'audit:fleet', type: 'workflow_agent', agentId: 'a1', model: 'opus', state: 'done' },
				{ index: 2, label: 'audit:trust', type: 'workflow_agent', agentId: 'a2', model: 'opus', state: 'done' },
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

	// The agent-list guards below are each pinned by a case that fails when that guard alone is removed - the only
	// thing that makes a guard real rather than decorative.

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

	// An agent-bearing record whose id is missing or empty does not look broken - it looks like a phase line, so the
	// `type === 'started' && r.agentId` filters skip it, it is counted as nothing, and the read still calls itself
	// whole while an agent has gone missing. ONE malformed record per case, deliberately: a fixture combining them
	// asserts only that SOMETHING was torn, so a regression accepting (say) `result` but not `started` would still
	// be masked by its neighbours. Each case below is the only reason its own branch is not dead.
	for (const malformed of [
		{ label: 'a started record with NO agent id', record: { type: 'started' } },
		{ label: 'a started record with an EMPTY agent id', record: { type: 'started', agentId: '' } },
		{ label: 'a result record with NO agent id', record: { type: 'result' } },
		{ label: 'a result record with an EMPTY agent id', record: { type: 'result', agentId: '' } },
	]) {
		test(`${malformed.label} is a dropped record, not a silently uncounted agent`, async () => {
			const fs = makeFs();
			await stageJournal(fs, 'wf_a1b2c3d4-e5f', [
				{ type: 'started', agentId: 'a1' },
				{ type: 'result', agentId: 'a1' },
				malformed.record,
			]);
			const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
			// The good agent is still counted and still finished; the malformed record degrades the read rather than
			// vanishing from it.
			assert.deepStrictEqual(
				{ started: mission.startedCount, results: mission.resultCount, completeness: mission.completeness },
				{ started: 1, results: 1, completeness: CompletenessState.Partial });
		});
	}

	test('expanding a LIVE mission mid-append keeps its agent list complete (the tail is not damage)', async () => {
		const fs = makeFs();
		// The lifecycle branch on the AGENT-LIST path, which the mission-level live test does not reach: a
		// manifest-less run is being appended to, so its half-written last line is the launcher mid-write. Treating
		// it as damage here would label every in-flight drill-in `partial` for no reason but being in flight.
		await stageJournalText(fs, 'wf_a1b2c3d4-e5f',
			JSON.stringify({ type: 'started', agentId: 'a1' }) + '\n'
			+ JSON.stringify({ type: 'result', agentId: 'a1' }) + '\n'
			+ '{"type":"started","agen');
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as MissionRun;
		assert.strictEqual(mission.status, 'running');
		const list = await service.listMissionAgents(RESOLVED, mission);
		assert.deepStrictEqual(
			{ completeness: list.completeness, rows: list.agents.map(a => ({ id: a.agentId, c: a.completeness })) },
			{ completeness: CompletenessState.Complete, rows: [{ id: 'a1', c: CompletenessState.Complete }] });
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

	test('a manifest with no agentCount derives it from its own workflow_agent progress entries', async () => {
		const fs = makeFs();
		// The `?? progress.filter(...)` fallback: every other fixture sets agentCount, so this branch was dead code
		// as far as the suite could tell, and breaking it would have changed nothing that any test observed.
		const manifest = manifestOf({ status: 'completed' }) as Record<string, unknown>;
		delete manifest.agentCount;
		manifest.workflowProgress = [
			{ index: 0, title: 'a-1', type: 'workflow_agent' },
			{ index: 1, title: 'a-2', type: 'workflow_agent' },
			{ index: 2, title: 'Phase one', type: 'workflow_phase' },
		];
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifest);
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		// Two agent entries, not three: a phase entry is progress, not an agent.
		assert.strictEqual(mission.agentCount, 2);
	});

	test('a manifest field of the wrong type is not carried into the read model', async () => {
		const fs = makeFs();
		// "The launcher wrote it" is a claim about the writer, not about the bytes. A string where the model declares
		// a number must read as absent rather than flow through under a `complete` label.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
			...manifestOf({ status: 'completed' }),
			agentCount: 'two', durationMs: '5s', totalTokens: null, scriptPath: 42,
		});
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{
				agentCount: mission.agentCount, durationMs: mission.durationMs,
				totalTokens: mission.totalTokens, scriptPath: mission.scriptPath, completeness: mission.completeness,
			},
			// `agentCount: "two"` reads as absent and falls back to the progress-derived count (the fixture declares
			// two workflow_agent entries) - the point being that it is a NUMBER derived from data, never the string
			// carried through. The rest have no fallback, so they read undefined rather than a wrong-typed value -
			// and because those fields were PRESENT and unreadable, the read is partial, not complete.
			{ agentCount: 2, durationMs: undefined, totalTokens: undefined, scriptPath: undefined, completeness: CompletenessState.Partial });
	});

	test('a malformed phases/progress container degrades ONE mission and never throws out of the list', async () => {
		const fs = makeFs();
		// The blast radius is what makes this matter. `missionFromManifest` runs inside the enumeration loop with no
		// try/catch, so a throw here does not degrade one mission - it escapes `listMissions` and the view renders
		// NOTHING. `phases: 'oops'` reaches `.map` (not a function); `workflowProgress: [null]` reaches
		// `readString(null, ...)`. Both threw before the container guard.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...manifestOf({ status: 'completed' }), phases: 'oops', workflowProgress: [null] });
		await stageManifest(fs, 'wf_b2c3d4e5-f60', manifestOf({ status: 'completed' }));
		const missions = await makeService(fs).listMissions(RESOLVED);
		const broken = missions.find(m => m.runId === 'wf_a1b2c3d4-e5f')!;
		assert.deepStrictEqual(
			{ count: missions.length, phases: broken.phases, progress: broken.progress, completeness: broken.completeness },
			// The healthy mission beside it still lists - the whole point of degrading rather than throwing.
			{ count: 2, phases: [], progress: [], completeness: CompletenessState.Partial });
	});

	test('a null entry inside phases is dropped without taking the surrounding entries with it', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
			...manifestOf({ status: 'completed' }),
			phases: [{ title: 'Analyze' }, null, 'nope', { title: 'Synthesize' }],
		});
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{ phases: mission.phases, completeness: mission.completeness },
			// The two readable phases survive; the unreadable entries are a gap, so the read says partial.
			{ phases: [{ title: 'Analyze' }, { title: 'Synthesize' }], completeness: CompletenessState.Partial });
	});

	test('a wrong-typed field is a DROP: erased from the model and the read stops claiming complete', async () => {
		// `complete` means the read got everything it asked for. A field that was present but unreadable is data the
		// read lost, so reporting `complete` beside it would make a corrupt field indistinguishable from an absent
		// one. Parameterized per field: a single combined fixture would let a regression in one guard hide behind
		// another guard's drop still setting the flag.
		for (const [key, bad] of [
			['durationMs', '5s'], ['totalTokens', '1e6'], ['totalToolCalls', []],
			['defaultModel', 42], ['scriptPath', {}], ['error', true],
		] as const) {
			const fs = makeFs();
			await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...manifestOf({ status: 'completed' }), [key]: bad });
			const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
			assert.deepStrictEqual(
				{ key, value: (mission as unknown as Record<string, unknown>)[key], completeness: mission.completeness },
				{ key, value: undefined, completeness: CompletenessState.Partial });
		}
	});

	// The subtler half of the same rule. A phase object with no title, and a progress entry whose kind this reader
	// does not model, are both real content that will not reach the view - the same thing the transcript reader
	// degrades for on an unmodeled record type. Filtering them out silently under a `complete` label would be the
	// ladder contradicting itself one level down. ONE discarded entry per case: a fixture carrying both let either
	// guard regress behind the other still setting the flag, which is how the first draft of this test passed while
	// both guards were broken.

	test('an agent progress entry names itself `label`, a phase names itself `title` - both are read', async () => {
		const fs = makeFs();
		// The shape the launcher actually writes, and the bug this pins: requiring `title` of every entry dropped
		// every workflow_agent - 897 of 1093 entries across 285 real manifests - while the read still reported
		// `complete`, so 82% of the progress vanished with nothing to show it had. The honesty label is what
		// surfaced it: the drop only became visible once a dropped entry started degrading the read.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifestOf({ status: 'completed' }));
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{
				progress: mission.progress.map(p => ({ title: p.title, kind: p.kind })),
				completeness: mission.completeness,
			},
			{
				progress: [
					{ title: 'Analyze', kind: 'workflow_phase' },
					{ title: 'audit:fleet', kind: 'workflow_agent' },
					{ title: 'audit:trust', kind: 'workflow_agent' },
				],
				// Nothing was dropped, so the read is whole - the label only cries wolf when something really went.
				completeness: CompletenessState.Complete,
			});
	});

	test('a phase entry with no title is a drop, not a silent filter', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
			...manifestOf({ status: 'completed' }),
			phases: [{ title: 'Analyze' }, { detail: 'no title here' }],
		});
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{ phases: mission.phases, completeness: mission.completeness },
			{ phases: [{ title: 'Analyze' }], completeness: CompletenessState.Partial });
	});

	test('a progress entry of an unmodeled kind is a drop, not a silent filter', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
			...manifestOf({ status: 'completed' }),
			workflowProgress: [{ index: 1, title: 'audit', type: 'workflow_agent' }, { index: 2, title: 'a tool', type: 'workflow_tool' }],
		});
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{ progress: mission.progress.map(p => p.title), completeness: mission.completeness },
			{ progress: ['audit'], completeness: CompletenessState.Partial });
	});

	test('an explicit null field is ABSENT, not a drop - it alone keeps the read complete', async () => {
		const fs = makeFs();
		// Isolated on purpose: the wrong-type cases would mask this, since their read is already partial for other
		// reasons. Losing the null->absent branch would flip every ordinary run that serializes `"error": null` to
		// partial - crying wolf on healthy data, which erodes the label exactly as fast as overclaiming does.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...manifestOf({ status: 'completed' }), error: null });
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{ error: mission.error, completeness: mission.completeness },
			{ error: undefined, completeness: CompletenessState.Complete });
	});

	test('an ABSENT optional field is not a drop - the read is still complete', async () => {
		const fs = makeFs();
		// The other half of the rule, and the reason the flag distinguishes present-but-unreadable from missing: a
		// manifest that simply carries no error / scriptPath lost nothing, so degrading it would cry wolf on every
		// successful run.
		const manifest = manifestOf({ status: 'completed' }) as Record<string, unknown>;
		delete manifest.error; delete manifest.scriptPath; delete manifest.totalToolCalls;
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifest);
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as MissionRun;
		assert.deepStrictEqual(
			{ error: mission.error, scriptPath: mission.scriptPath, completeness: mission.completeness },
			{ error: undefined, scriptPath: undefined, completeness: CompletenessState.Complete });
	});

	test('an agent that reports started twice is listed once', async () => {
		const fs = makeFs();
		// The `seen` dedup: without a duplicate in any fixture, a regression emitting a row per record would pass.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifestOf({ status: 'completed' }));
		await stageJournal(fs, 'wf_a1b2c3d4-e5f', [
			{ type: 'started', agentId: 'a1' },
			{ type: 'started', agentId: 'a1' },
			{ type: 'result', agentId: 'a1' },
		]);
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as MissionRun;
		const list = await service.listMissionAgents(RESOLVED, mission);
		assert.deepStrictEqual(
			{ ids: list.agents.map(a => a.agentId), ref: list.agents[0].transcriptRef.endsWith('agent-a1.jsonl') },
			{ ids: ['a1'], ref: true });
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
