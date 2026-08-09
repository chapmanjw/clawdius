/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows enumeration tests
// Drives the seam's WORKFLOW enumeration (listMissions) - the Workflows view's primary read - over an in-memory
// tree staged in the launcher's real on-disk layout. The load-bearing property under test is the ASYMMETRY the
// launcher actually exhibits (observed against a live run, not assumed): the run manifest is written ONLY at a
// terminal state, so a journal with no manifest beside it is a run still IN FLIGHT. That is the only way a live
// workflow run is visible at all, and it is why `running` is inferred from artifact topology rather than read
// from a status field.
//
// Pinned here: a terminal manifest yields its own status/name/phases/progress; a manifest-less journal is `running`
// + `live` + counted, and is NOT degraded for lacking a manifest (in-flight is not incomplete); a manifest WINS
// over its own journal (the terminal record of the same run); an unrecognized manifest degrades to `unknown-shape`
// + the canary stamp rather than throwing; a stray non-run-id file is not a workflow run; a plain chat session is
// NEVER enumerated as one (Workflows is an ultracode control surface, not a transcript browser); a `no-config` root
// degrades to an empty labeled list; and agents are resolved lazily from the journal, with an agent that never
// reported a result present-with-label (`finished: false`), never omitted.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode, FileType, IStat } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { MissionRun as WorkflowRun } from '../../common/claudeFleetModel.js';
import { CompletenessState, FreshnessLabel, ReaderConfigRoot } from '../../common/claudeReaderSeam.js';
import {
	LiveWorkflowRun, TerminalWorkflowRun, UnrecognizedWorkflowRun, WorkflowRun as WorkflowRunModel, WorkflowTranscriptRef,
} from '../../common/claudeWorkflowModel.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import { ClawdiusReaderSeamService } from '../../browser/reader/claudeReaderSeamService.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';

// The committed honest-degenerate-shape fixtures (a torn journal tail, a result-before-start journal, a
// duplicate-agentId manifest) are the single source of truth for the tests that exercise
// the READER's own classification of them, read via the browser harness's file bridge (the same mechanism
// `claudeReaderSeamFormats.test.ts` uses for its own committed fixtures) - no inline duplicate fixtures.
declare const __readFileInTests: (path: string) => Promise<string>;
const WORKFLOW_FIXTURE_ROOT = 'vs/workbench/contrib/clawdius/test/browser/fixtures/workflows';

async function loadWorkflowFixture(name: string): Promise<string> {
	const src = URI.joinPath(FileAccess.asFileUri(''), '../src');
	return await __readFileInTests(URI.joinPath(src, WORKFLOW_FIXTURE_ROOT, name).fsPath);
}

suite('Clawdius Claude Code Ultracode Workflows - enumeration', () => {
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
		const mission = (await service.listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await service.listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await service.listMissions(RESOLVED))[0] as WorkflowRun;
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
			const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await service.listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await service.listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await service.listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
			const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await makeService(fs).listMissions(RESOLVED))[0] as WorkflowRun;
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
		const mission = (await service.listMissions(RESOLVED))[0] as WorkflowRun;
		const list = await service.listMissionAgents(RESOLVED, mission);
		assert.deepStrictEqual(
			{ ids: list.agents.map(a => a.agentId), ref: list.agents[0].transcriptRef.endsWith('agent-a1.jsonl') },
			{ ids: ['a1'], ref: true });
	});

	test('a mission with no journal lists no agents rather than throwing', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_f96a6688-77e', manifestOf());
		const service = makeService(fs);
		const mission = (await service.listMissions(RESOLVED))[0] as WorkflowRun;
		// No journal at all is `absent` - there was nothing to read - which is a different claim from `partial` (a
		// read that lost something) and from a mission that genuinely ran no agents.
		assert.deepStrictEqual(await service.listMissionAgents(RESOLVED, mission),
			{ agents: [], completeness: CompletenessState.Absent });
	});
});

// A provider that can be told to fail `stat`/`readdir` on one exact path - simulates a `projects/` tree that
// EXISTS but cannot be read (a permission/provider error), the case the root envelope must tell apart from a
// tree that genuinely does not exist.
class FlakyProvider extends InMemoryFileSystemProvider {
	private brokenPath: string | undefined;
	private breakStatAfterN = 0;
	private brokenStatHits = 0;
	breakOn(path: string): void { this.brokenPath = path; }
	/** Break `stat` on `path` only from the (n+1)th stat call on it, so an earlier `exists` check can succeed while
	 *  a later `stat` (e.g. a live journal's mtime read) fails - isolating a stat-only failure on a file the walk
	 *  also `exists`-checks. */
	breakStatOnAfter(path: string, n: number): void { this.brokenPath = path; this.breakStatAfterN = n; }
	override async stat(resource: URI): Promise<IStat> {
		if (this.brokenPath && resource.path === this.brokenPath && this.brokenStatHits++ >= this.breakStatAfterN) {
			throw createFileSystemProviderError('simulated read failure', FileSystemProviderErrorCode.NoPermissions);
		}
		return super.stat(resource);
	}
	override async readdir(resource: URI): Promise<[string, FileType][]> {
		if (this.brokenPath && resource.path === this.brokenPath) {
			throw createFileSystemProviderError('simulated read failure', FileSystemProviderErrorCode.NoPermissions);
		}
		return super.readdir(resource);
	}
}

suite('Clawdius Claude Code Ultracode Workflows - validated model + root envelope + identity join', () => {
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

	function sessionDir(sessionId: string = SESSION): URI {
		return URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER), sessionId);
	}

	async function stageManifest(fs: FileService, runId: string, manifest: object, sessionId: string = SESSION): Promise<void> {
		const dir = URI.joinPath(sessionDir(sessionId), 'workflows');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `${runId}.json`), VSBuffer.fromString(JSON.stringify(manifest)));
	}

	async function stageJournalText(fs: FileService, runId: string, text: string, sessionId: string = SESSION): Promise<void> {
		const dir = URI.joinPath(sessionDir(sessionId), 'subagents', 'workflows', runId);
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, 'journal.jsonl'), VSBuffer.fromString(text));
	}

	async function stageJournal(fs: FileService, runId: string, lines: readonly object[], sessionId: string = SESSION): Promise<void> {
		await stageJournalText(fs, runId, lines.map(l => JSON.stringify(l) + '\n').join(''), sessionId);
	}

	async function stageAgentTranscript(fs: FileService, runId: string, agentId: string, lines: readonly object[], sessionId: string = SESSION): Promise<void> {
		const dir = URI.joinPath(sessionDir(sessionId), 'subagents', 'workflows', runId);
		await fs.createFolder(dir);
		const text = lines.map(l => JSON.stringify(l) + '\n').join('');
		await fs.writeFile(URI.joinPath(dir, `agent-${agentId}.jsonl`), VSBuffer.fromString(text));
	}

	/** A well-formed `workflow_agent` progress entry in the launcher's real shape - every rich field present, so a
	 *  single override isolates exactly one guard against an otherwise-valid neighbor. */
	function agentEntry(overrides: object = {}): object {
		return {
			type: 'workflow_agent', index: 1, agentId: 'a1', label: 'audit:fleet', state: 'done',
			model: 'claude-opus-4-8[1m]', tokens: 12000, toolCalls: 6, durationMs: 45000,
			phaseTitle: 'Analyze', phaseIndex: 0, lastToolName: 'Read', agentType: 'general-purpose',
			promptPreview: 'Audit the fleet module', resultPreview: 'Found 3 issues',
			...overrides,
		};
	}

	function terminalManifest(overrides: object = {}): object {
		return {
			workflowName: 'unreleased-validation-audit', summary: 'Audited the fleet module for correctness.',
			status: 'completed', startTime: 1750000000000, timestamp: 1750000605027,
			agentCount: 1, durationMs: 605027, totalTokens: 781753, totalToolCalls: 191,
			defaultModel: 'claude-opus-4-8[1m]', result: 'The audit found three issues, all fixed.',
			phases: [{ title: 'Analyze', detail: 'one agent per theme' }],
			workflowProgress: [agentEntry()],
			...overrides,
		};
	}

	/** List through the new root envelope and assert exactly one `ok` run - the common-case shorthand every
	 *  field-validation test below builds on. */
	async function listOne(fs: FileService): Promise<WorkflowRunModel> {
		const res = await makeService(fs).listWorkflows(RESOLVED);
		assert.strictEqual(res.state, 'ok');
		assert.strictEqual(res.runs.length, 1);
		return res.runs[0];
	}

	// --- the discriminant literals + stable identity ---------------------------------------------------------

	test('a recognized terminal manifest carries kind:"terminal" and the composite run: identity', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest());
		const run = await listOne(fs);
		assert.strictEqual(run.kind, 'terminal');
		assert.strictEqual(run.identity, `run:${SESSION}:wf_a1b2c3d4-e5f`);
	});

	test('a manifest-less journal carries kind:"live"', async () => {
		const fs = makeFs();
		await stageJournal(fs, 'wf_d980f960-543', [{ type: 'started', agentId: 'a1' }]);
		const run = await listOne(fs);
		assert.strictEqual(run.kind, 'live');
	});

	test('every enumerated run carries the projects/<enc> directory it was walked out of, verbatim - terminal, live, and unknown-shape alike', async () => {
		// The join key the view's workspace-scope filter compares against. It is bound ONCE per project dir in the
		// enumeration walk, so a run kind that forgot to carry it would silently drop out of "This Workspace".
		const fs = makeFs();
		await stageManifest(fs, 'wf_terminal-run', terminalManifest());
		await stageManifest(fs, 'wf_unknown-run', { status: 'not-a-terminal-status' });
		await stageJournal(fs, 'wf_live-run', [{ type: 'started', agentId: 'a1' }]);
		const res = await makeService(fs).listWorkflows(RESOLVED);
		assert.strictEqual(res.state, 'ok');
		assert.deepStrictEqual(res.runs.map(r => ({ runId: r.runId, kind: r.kind, projectDirName: r.projectDirName })), [
			// Runs sort by sessionId then runId; all three share one session, so live < terminal < unknown.
			{ runId: 'wf_live-run', kind: 'live', projectDirName: encodeProjectDir(FOLDER) },
			{ runId: 'wf_terminal-run', kind: 'terminal', projectDirName: encodeProjectDir(FOLDER) },
			{ runId: 'wf_unknown-run', kind: 'unknown-shape', projectDirName: encodeProjectDir(FOLDER) },
		]);
	});

	test('an unrecognized manifest carries kind:"unknown-shape"', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', { totallyDifferent: true });
		const run = await listOne(fs);
		assert.strictEqual(run.kind, 'unknown-shape');
	});

	// --- the validated TERMINAL projection --------------------------------------------------------------------

	test('a recognized terminal manifest carries its validated summary/cost/result/phase/agent fields', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest());
		await stageJournal(fs, 'wf_a1b2c3d4-e5f', [{ type: 'started', agentId: 'a1' }]);
		await stageAgentTranscript(fs, 'wf_a1b2c3d4-e5f', 'a1', [{ type: 'user', uuid: 'u1' }]);
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual({
			workflowName: run.workflowName, summary: run.summary, status: run.status,
			resultText: run.resultText, resultPreview: run.resultPreview, phases: run.phases.length,
			agentCount: run.agentCount, completeness: run.completeness,
		}, {
			workflowName: 'unreleased-validation-audit', summary: 'Audited the fleet module for correctness.',
			status: 'completed', resultText: 'The audit found three issues, all fixed.',
			resultPreview: 'The audit found three issues, all fixed.', phases: 1, agentCount: 1,
			completeness: CompletenessState.Complete,
		});
		assert.deepStrictEqual(run.agents.map(a => ({ agentId: a.agentId, label: a.label, state: a.state, model: a.model, tokens: a.tokens, transcriptRef: a.transcriptRef })), [
			{
				agentId: 'a1', label: 'audit:fleet', state: 'done', model: 'claude-opus-4-8[1m]', tokens: 12000,
				transcriptRef: { sessionId: SESSION, runId: 'wf_a1b2c3d4-e5f', agentId: 'a1' },
			},
		]);
	});

	test('a manifest timestamp stored as an ISO-8601 string is parsed to epoch ms, not dropped', async () => {
		const fs = makeFs();
		// The launcher writes the run `timestamp` (completion) as an ISO-8601 string; the seam must PARSE it, not
		// reject it as non-numeric - rejecting it collapsed every real terminal run to `partial`.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({ timestamp: '2026-06-07T17:53:05.254Z' }));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ timestamp: run.timestamp, completeness: run.completeness },
			{ timestamp: Date.parse('2026-06-07T17:53:05.254Z'), completeness: CompletenessState.Complete });
	});

	test('a manifest timestamp that is neither a number nor a parseable date is a dropped field -> partial', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({ timestamp: 'not-a-real-date' }));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ timestamp: run.timestamp, completeness: run.completeness },
			{ timestamp: undefined, completeness: CompletenessState.Partial });
	});

	test('a structured object result is serialized to JSON text, not dropped into "No result" + partial', async () => {
		const fs = makeFs();
		// A workflow script returns structured data, so the manifest's run-level `result` is commonly an object/array.
		// The seam serializes it to plain JSON text (textContent-safe) rather than dropping it - which would both
		// hide the result AND degrade the read to `partial`.
		const structured = { clouds: [{ cloud: 'AWS', available: 'yes' }], fetched: 3 };
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({ result: structured }));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ resultText: run.resultText, hasPreview: run.resultPreview !== undefined, completeness: run.completeness },
			{ resultText: JSON.stringify(structured, null, 2), hasPreview: true, completeness: CompletenessState.Complete });
	});

	test('a timestamp string that is not strict ISO-8601-with-timezone is a dropped field -> partial', async () => {
		// Timezone-naive, date-only, and bare-numeric strings are REJECTED rather than coerced by Date.parse into a
		// plausible-but-wrong (or timezone-ambiguous) epoch under a false `complete`.
		for (const bad of ['2026-06-07T17:53:05', '2026-06-07', '1750000000000']) {
			const fs = makeFs();
			await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({ timestamp: bad }));
			const run = await listOne(fs) as TerminalWorkflowRun;
			assert.deepStrictEqual(
				{ bad, timestamp: run.timestamp, completeness: run.completeness },
				{ bad, timestamp: undefined, completeness: CompletenessState.Partial });
		}
	});

	test('the seam validates the CALENDAR, not just the ISO shape: real leap days parse, impossible dates drop', async () => {
		// Date.parse silently NORMALIZES an out-of-range day/time (Feb 30 -> Mar 2) into a valid-but-wrong instant, so
		// the seam validates real month/day/time bounds: a genuine leap-year Feb 29 parses; an impossible calendar
		// date-time drops the field -> partial rather than riding under `complete` on a rolled-over epoch.
		const cases: { ts: string; ok: boolean }[] = [
			{ ts: '2024-02-29T00:00:00Z', ok: true },   // 2024 IS a leap year
			{ ts: '2026-02-29T00:00:00Z', ok: false },  // 2026 is not
			{ ts: '2026-02-30T17:53:05Z', ok: false },
			{ ts: '2026-04-31T17:53:05Z', ok: false },
			{ ts: '2026-06-07T25:00:00Z', ok: false },
		];
		for (const { ts, ok } of cases) {
			const fs = makeFs();
			await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({ timestamp: ts }));
			const run = await listOne(fs) as TerminalWorkflowRun;
			assert.deepStrictEqual(
				{ ts, present: run.timestamp !== undefined, completeness: run.completeness },
				{ ts, present: ok, completeness: ok ? CompletenessState.Complete : CompletenessState.Partial });
		}
	});

	test('phase agent counts use one index-first predicate, so a conflicting agent is counted where it nests', async () => {
		const fs = makeFs();
		// An agent whose phaseIndex (0) and phaseTitle ('B') DISAGREE: the shared predicate is index-first, so the
		// agent counts in phase index 0 ('A') only - the reader's count and the tree's nesting cannot diverge.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({
			phases: [{ title: 'A' }, { title: 'B' }],
			workflowProgress: [agentEntry({ agentId: 'a1', phaseIndex: 0, phaseTitle: 'B' })],
		}));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(run.phases.map(p => ({ index: p.index, title: p.title, agentCount: p.agentCount })), [
			{ index: 0, title: 'A', agentCount: 1 },
			{ index: 1, title: 'B', agentCount: 0 },
		]);
	});

	test('phase counts assign a title-only agent to the FIRST duplicate-titled phase once, never double-counted', async () => {
		const fs = makeFs();
		// Two phases legally share a title; a title-only agent (no phaseIndex) matches BOTH by title but is counted in
		// the FIRST only - the same first-match assignment the tree nests with, so a count can never exceed the rows.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({
			phases: [{ title: 'Build' }, { title: 'Build' }],
			workflowProgress: [agentEntry({ agentId: 'a1', phaseIndex: undefined, phaseTitle: 'Build' })],
		}));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(run.phases.map(p => ({ index: p.index, title: p.title, agentCount: p.agentCount })), [
			{ index: 0, title: 'Build', agentCount: 1 },
			{ index: 1, title: 'Build', agentCount: 0 },
		]);
	});

	test('a terminal manifest with no declared agentCount reads it as absent, never derived from its agent list', async () => {
		const fs = makeFs();
		// The manifest fixture otherwise declares one valid workflow_agent entry - if the run-level count were still
		// derived from `agents.length` (the fallback this honest model removed), it would read `1` instead of
		// `undefined`.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({ agentCount: undefined }));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.strictEqual(run.agentCount, undefined);
	});

	test('a negative durationMs is dropped, not clamped, and degrades the run to partial', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...terminalManifest(), durationMs: -5 });
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ durationMs: run.durationMs, completeness: run.completeness },
			{ durationMs: undefined, completeness: CompletenessState.Partial });
	});

	test('a fractional totalToolCalls is dropped, not rounded, and degrades the run to partial', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...terminalManifest(), totalToolCalls: 1.5 });
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ totalToolCalls: run.totalToolCalls, completeness: run.completeness },
			{ totalToolCalls: undefined, completeness: CompletenessState.Partial });
	});

	test('a wrong-typed run-level scalar field is a drop: erased and the read degrades to partial', async () => {
		for (const [key, bad] of [['summary', 42], ['startTime', 'yesterday'], ['timestamp', {}], ['workflowName', 7], ['defaultModel', []]] as const) {
			const fs = makeFs();
			await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...terminalManifest(), [key]: bad });
			const run = await listOne(fs) as TerminalWorkflowRun;
			assert.deepStrictEqual(
				{ key, value: (run as unknown as Record<string, unknown>)[key], completeness: run.completeness },
				{ key, value: undefined, completeness: CompletenessState.Partial });
		}
	});

	test('a bare scalar run-level result (neither string nor structured) is a dropped field -> partial', async () => {
		const fs = makeFs();
		// A number/boolean is neither the string nor the structured object/array shape the `result` contract allows;
		// it is an unexpected type, dropped like any wrong-typed field, degrading the read - never serialized under
		// a false `complete`.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...terminalManifest(), result: 12345 });
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ resultText: run.resultText, resultPreview: run.resultPreview, completeness: run.completeness },
			{ resultText: undefined, resultPreview: undefined, completeness: CompletenessState.Partial });
	});

	test('an explicit null run-level field is absent, not a drop - the read stays complete', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...terminalManifest(), summary: null, result: null });
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ summary: run.summary, resultText: run.resultText, completeness: run.completeness },
			{ summary: undefined, resultText: undefined, completeness: CompletenessState.Complete });
	});

	test('an absent run-level field is not a drop - the read stays complete', async () => {
		const fs = makeFs();
		const manifest = terminalManifest() as Record<string, unknown>;
		delete manifest.summary; delete manifest.result; delete manifest.startTime;
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', manifest);
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ summary: run.summary, resultText: run.resultText, startTime: run.startTime, completeness: run.completeness },
			{ summary: undefined, resultText: undefined, startTime: undefined, completeness: CompletenessState.Complete });
	});

	test('an unrecognized status degrades the WHOLE run to unknown-shape, never guessed into terminal or live', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', { ...terminalManifest(), status: 'totally-different' });
		const run = await listOne(fs) as UnrecognizedWorkflowRun;
		assert.deepStrictEqual({ kind: run.kind, completeness: run.completeness }, { kind: 'unknown-shape', completeness: CompletenessState.UnknownShape });
	});

	test('a workflow_agent entry missing agentId/label/a valid state is dropped, siblings preserved, partial', async () => {
		for (const bad of [
			{ ...agentEntry(), agentId: undefined },
			{ ...agentEntry(), label: undefined },
			{ ...agentEntry(), state: 'running' }, // not in the measured done/error vocabulary
		]) {
			const fs = makeFs();
			await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
				...terminalManifest(),
				workflowProgress: [bad, agentEntry({ agentId: 'a2', label: 'audit:trust' })],
			});
			const run = await listOne(fs) as TerminalWorkflowRun;
			assert.deepStrictEqual(
				{ ids: run.agents.map(a => a.agentId), completeness: run.completeness },
				{ ids: ['a2'], completeness: CompletenessState.Partial });
		}
	});

	test('an errored agent with no authoritative error field degrades the run to partial', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
			...terminalManifest(),
			workflowProgress: [agentEntry({ state: 'error', error: undefined, resultPreview: undefined })],
		});
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ state: run.agents[0].state, error: run.agents[0].error, completeness: run.completeness },
			{ state: 'error', error: undefined, completeness: CompletenessState.Partial });
	});

	test('an errored agent WITH its authoritative error stays complete', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
			...terminalManifest(),
			workflowProgress: [agentEntry({ state: 'error', error: 'ENOENT: script not found', resultPreview: undefined })],
		});
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ state: run.agents[0].state, error: run.agents[0].error, completeness: run.completeness },
			{ state: 'error', error: 'ENOENT: script not found', completeness: CompletenessState.Complete });
	});

	test('attempt is surfaced only when greater than 1', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
			...terminalManifest(),
			workflowProgress: [agentEntry({ agentId: 'a1', attempt: 1 }), agentEntry({ agentId: 'a2', label: 'a2', attempt: 3 })],
		});
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			run.agents.map(a => ({ id: a.agentId, attempt: a.attempt })),
			[{ id: 'a1', attempt: undefined }, { id: 'a2', attempt: 3 }]);
	});

	test('phase agent/error counts are DERIVED from the validated agents, not a raw manifest field', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', {
			...terminalManifest(),
			phases: [{ title: 'Analyze' }, { title: 'Synthesize' }],
			workflowProgress: [
				agentEntry({ agentId: 'a1', phaseIndex: 0, phaseTitle: 'Analyze', state: 'done' }),
				agentEntry({ agentId: 'a2', label: 'a2', phaseIndex: 0, phaseTitle: 'Analyze', state: 'error', error: 'boom' }),
				agentEntry({ agentId: 'a3', label: 'a3', phaseIndex: 1, phaseTitle: 'Synthesize', state: 'done' }),
			],
		});
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			run.phases.map(p => ({ index: p.index, title: p.title, agentCount: p.agentCount, errorCount: p.errorCount })),
			[{ index: 0, title: 'Analyze', agentCount: 2, errorCount: 1 }, { index: 1, title: 'Synthesize', agentCount: 1, errorCount: 0 }]);
	});

	// --- the validated LIVE projection -----------------------------------------------------------------------

	test('a manifest-less journal reports started/result counts and journalLastWriteTime from the journal mtime', async () => {
		const fs = makeFs();
		await stageJournal(fs, 'wf_d980f960-543', [
			{ type: 'started', agentId: 'a1' }, { type: 'started', agentId: 'a2' },
			{ type: 'result', agentId: 'a1', result: 'ok' },
		]);
		const journalUri = URI.joinPath(sessionDir(), 'subagents', 'workflows', 'wf_d980f960-543', 'journal.jsonl');
		const expectedMtime = (await fs.stat(journalUri)).mtime;
		const run = await listOne(fs) as LiveWorkflowRun;
		assert.deepStrictEqual(
			{ started: run.startedCount, results: run.resultCount, mtime: run.journalLastWriteTime, degradation: run.degradation },
			{ started: 2, results: 1, mtime: expectedMtime, degradation: undefined });
	});

	test('seenCount is the UNION of started/result agent ids - a result whose own started record never survived still counts toward "seen"', async () => {
		const fs = makeFs();
		await stageJournal(fs, 'wf_d980f960-543', [
			{ type: 'started', agentId: 'a1' },
			{ type: 'result', agentId: 'a1', result: 'ok' },
			// a2's `started` line never survived (e.g. a torn line dropped it), but its `result` still landed -
			// resultCount(2) > startedCount(1), the exact shape that used to invert the "agents seen so far" ratio.
			{ type: 'result', agentId: 'a2', result: 'ok too' },
		]);
		const run = await listOne(fs) as LiveWorkflowRun;
		assert.deepStrictEqual(
			{ started: run.startedCount, results: run.resultCount, seen: run.seenCount },
			{ started: 1, results: 2, seen: 2 });
	});

	test('(fixture) result-before-start: a result record with NO surviving started record is still counted, honestly, never inverting the ratio', async () => {
		const fs = makeFs();
		// The committed fixture: a bare `result` record for an agent that never has a `started` line at all (not
		// merely torn away) - the limit case of the union rule: startedCount 0, resultCount 1, seenCount MUST still
		// be 1 (the union), so "1 of 1 agents seen so far" is what renders, never "1 of 0".
		await stageJournalText(fs, 'wf_d980f960-543', await loadWorkflowFixture('result-before-start-journal.jsonl'));
		const run = await listOne(fs) as LiveWorkflowRun;
		assert.deepStrictEqual(
			{ started: run.startedCount, results: run.resultCount, seen: run.seenCount, completeness: run.completeness },
			{ started: 0, results: 1, seen: 1, completeness: CompletenessState.Complete });
	});

	test('landed results read a string payload as a preview', async () => {
		const fs = makeFs();
		await stageJournal(fs, 'wf_d980f960-543', [{ type: 'started', agentId: 'a1' }, { type: 'result', agentId: 'a1', result: 'The fleet module is clean.' }]);
		const run = await listOne(fs) as LiveWorkflowRun;
		assert.deepStrictEqual(run.landedResults, [{ agentId: 'a1', preview: 'The fleet module is clean.' }]);
	});

	test('landed results fall back to "Result landed" for a non-displayable payload', async () => {
		const fs = makeFs();
		await stageJournal(fs, 'wf_d980f960-543', [{ type: 'started', agentId: 'a1' }, { type: 'result', agentId: 'a1', result: { ok: true } }]);
		const run = await listOne(fs) as LiveWorkflowRun;
		assert.deepStrictEqual(run.landedResults, [{ agentId: 'a1', preview: 'Result landed' }]);
	});

	test('a torn live journal degrades to degradation: "partial"', async () => {
		const fs = makeFs();
		await stageJournalText(fs, 'wf_d980f960-543',
			JSON.stringify({ type: 'started', agentId: 'a1' }) + '\n'
			+ '{"type":"started","agen' + '\n'
			+ JSON.stringify({ type: 'result', agentId: 'a1' }) + '\n');
		const run = await listOne(fs) as LiveWorkflowRun;
		assert.deepStrictEqual({ completeness: run.completeness, degradation: run.degradation }, { completeness: CompletenessState.Partial, degradation: 'partial' });
	});

	test('(fixture) a torn journal tail degrades the run to partial while its readable records still render, never crashing the list', async () => {
		const fs = makeFs();
		// The committed fixture: a `started` record, a torn (unparseable) line NOT at the tail, then a `result`
		// record - the same shape the inline test above pins, loaded from the on-disk fixture that also backs the
		// real-build proof so the two never drift apart.
		await stageJournalText(fs, 'wf_d980f960-543', await loadWorkflowFixture('torn-tail-journal.jsonl'));
		await stageManifest(fs, 'wf_healthy-sibling', terminalManifest(), 'a-healthy-sibling-session');
		const res = await makeService(fs).listWorkflows(RESOLVED);
		assert.strictEqual(res.state, 'ok'); // a torn line degrades the ONE run, never the whole enumeration
		const torn = res.runs.find(r => r.runId === 'wf_d980f960-543') as LiveWorkflowRun;
		assert.deepStrictEqual(
			{ kind: torn.kind, completeness: torn.completeness, degradation: torn.degradation, startedCount: torn.startedCount, resultCount: torn.resultCount },
			// The readable records (the started AND the result) still render - a torn line drops only itself.
			{ kind: 'live', completeness: CompletenessState.Partial, degradation: 'partial', startedCount: 1, resultCount: 1 });
		assert.strictEqual(res.runs.some(r => r.runId === 'wf_healthy-sibling'), true, 'a healthy sibling run must still render beside the torn one');
	});

	test('a journal with content but nothing recognizable degrades to degradation: "unknown-shape"', async () => {
		const fs = makeFs();
		await stageJournalText(fs, 'wf_d980f960-543', '{"totally broken\n');
		const run = await listOne(fs) as LiveWorkflowRun;
		// completeness is DERIVED from degradation, so an unknown-shape degradation must read UnknownShape too.
		assert.deepStrictEqual({ degradation: run.degradation, completeness: run.completeness }, { degradation: 'unknown-shape', completeness: CompletenessState.UnknownShape });
	});

	// --- the deterministic manifest-agent -> transcript join (the #1 must-prove) -------------------------------

	test('the join succeeds end to end: transcriptRef is present and reads the exact agent transcript', async () => {
		const fs = makeFs();
		const runId = 'wf_a1b2c3d4-e5f';
		await stageManifest(fs, runId, { ...terminalManifest(), workflowProgress: [agentEntry({ agentId: 'a1' })] });
		await stageJournal(fs, runId, [{ type: 'started', agentId: 'a1' }, { type: 'result', agentId: 'a1' }]);
		await stageAgentTranscript(fs, runId, 'a1', [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'u2' }]);
		const service = makeService(fs);
		const run = (await service.listWorkflows(RESOLVED)).runs[0] as TerminalWorkflowRun;
		const ref = run.agents[0].transcriptRef;
		assert.deepStrictEqual(ref, { sessionId: SESSION, runId, agentId: 'a1' });
		const slice = await service.readWorkflowAgentTranscript(RESOLVED, ref!);
		assert.deepStrictEqual({ records: slice.records.length, completeness: slice.completeness }, { records: 2, completeness: CompletenessState.Complete });
	});

	// The heuristic TRAP: the manifest declares its agents in the OPPOSITE order from the journal's `started`
	// records, and each agent's transcript file carries a DIFFERENT, distinguishable record count. An
	// implementation that joined by array position or declaration order rather than exact agentId would pair the
	// wrong agent with the wrong file; exact identity matching cannot.
	test('the join is by exact identity, never declaration/journal order (heuristic trap)', async () => {
		const fs = makeFs();
		const runId = 'wf_a1b2c3d4-e5f';
		await stageManifest(fs, runId, {
			...terminalManifest(),
			// 'b' declared FIRST, 'a' second - the reverse of the journal's started order below.
			workflowProgress: [agentEntry({ agentId: 'b', label: 'agent-b' }), agentEntry({ agentId: 'a', label: 'agent-a' })],
		});
		await stageJournal(fs, runId, [
			{ type: 'started', agentId: 'a' }, { type: 'started', agentId: 'b' },
			{ type: 'result', agentId: 'a' }, { type: 'result', agentId: 'b' },
		]);
		await stageAgentTranscript(fs, runId, 'a', [{ type: 'user', uuid: 'u1' }]); // 1 record
		await stageAgentTranscript(fs, runId, 'b', [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'u2' }, { type: 'user', uuid: 'u3' }]); // 3 records
		const service = makeService(fs);
		const run = (await service.listWorkflows(RESOLVED)).runs[0] as TerminalWorkflowRun;
		const byId = new Map(run.agents.map(a => [a.agentId, a]));
		const sliceA = await service.readWorkflowAgentTranscript(RESOLVED, byId.get('a')!.transcriptRef!);
		const sliceB = await service.readWorkflowAgentTranscript(RESOLVED, byId.get('b')!.transcriptRef!);
		assert.deepStrictEqual({ a: sliceA.records.length, b: sliceB.records.length }, { a: 1, b: 3 });
	});

	test('an agentId that is not path-safe never receives a transcriptRef (the whole entry is dropped)', async () => {
		const fs = makeFs();
		const runId = 'wf_a1b2c3d4-e5f';
		await stageManifest(fs, runId, { ...terminalManifest(), workflowProgress: [agentEntry({ agentId: '../escape', label: 'evil' })] });
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual({ agents: run.agents.length, completeness: run.completeness }, { agents: 0, completeness: CompletenessState.Partial });
	});

	test('a duplicate agentId within the manifest is placed ONCE (first occurrence), never a duplicate row, and receives no transcriptRef', async () => {
		const fs = makeFs();
		const runId = 'wf_a1b2c3d4-e5f';
		// The manifest names the SAME agentId twice - a launcher-side identity collision, not a read gap. The tree
		// keys an agent row on `agent:<runIdentity>:<agentId>` (workflowTreeElementId), so two surviving entries
		// would be two rows sharing one identity; the reader dedupes to the FIRST occurrence instead.
		await stageManifest(fs, runId, {
			...terminalManifest(),
			workflowProgress: [agentEntry({ agentId: 'a1', label: 'first' }), agentEntry({ agentId: 'a1', label: 'second' })],
		});
		await stageJournal(fs, runId, [{ type: 'started', agentId: 'a1' }]);
		await stageAgentTranscript(fs, runId, 'a1', [{ type: 'user', uuid: 'u1' }]);
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ labels: run.agents.map(a => a.label), transcriptRefs: run.agents.map(a => a.transcriptRef), completeness: run.completeness },
			// Still no transcriptRef: the manifest-level ambiguity (idFreq > 1) withholds the identity join even for
			// the surviving occurrence, per the join's "unique within the manifest" condition. Dropping the repeat
			// is itself a known gap, so the read degrades to partial rather than riding under a false `complete`.
			{ labels: ['first'], transcriptRefs: [undefined], completeness: CompletenessState.Partial });
	});

	test('(fixture) a duplicate agentId within the manifest is placed ONCE, never a duplicate row, no crash', async () => {
		const fs = makeFs();
		const runId = 'wf_dup-agent-fixture';
		const dir = URI.joinPath(sessionDir(), 'workflows');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `${runId}.json`), VSBuffer.fromString(await loadWorkflowFixture('duplicate-agent-manifest.json')));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{ agentIds: run.agents.map(a => a.agentId), labels: run.agents.map(a => a.label), completeness: run.completeness },
			{ agentIds: ['a1'], labels: ['first'], completeness: CompletenessState.Partial });
	});

	// --- the honest degenerate-shape catalogue: missing numbers, zero agents ------------------------------------

	test('an ABSENT run-level cost total / agent metric is a genuinely missing number, never a drop - the read stays complete', async () => {
		const fs = makeFs();
		// Distinct from the wrong-typed-field tests above: these fields are simply not IN the manifest at all (the
		// launcher's own real shape when a cost figure was never computed), so the read must stay `complete` - a
		// dash on the tree, never a fabricated 0 AND never a spurious `partial` for legitimate absence.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({
			durationMs: undefined, totalTokens: undefined, totalToolCalls: undefined, defaultModel: undefined, agentCount: undefined,
			workflowProgress: [agentEntry({ agentId: 'a1', model: undefined, tokens: undefined, toolCalls: undefined, durationMs: undefined })],
		}));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual(
			{
				durationMs: run.durationMs, totalTokens: run.totalTokens, totalToolCalls: run.totalToolCalls,
				defaultModel: run.defaultModel, agentCount: run.agentCount, completeness: run.completeness,
				agent: { model: run.agents[0].model, tokens: run.agents[0].tokens, toolCalls: run.agents[0].toolCalls, durationMs: run.agents[0].durationMs },
			},
			{
				durationMs: undefined, totalTokens: undefined, totalToolCalls: undefined,
				defaultModel: undefined, agentCount: undefined, completeness: CompletenessState.Complete,
				agent: { model: undefined, tokens: undefined, toolCalls: undefined, durationMs: undefined },
			});
	});

	test('a terminal run with genuinely no declared agents renders as itself: an empty agent list, completeness stays complete', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({ workflowProgress: [] }));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual({ agents: run.agents, completeness: run.completeness }, { agents: [], completeness: CompletenessState.Complete });
	});

	test('a terminal run whose only agent entries were unreadable is ALSO an empty agent list, but reads partial - distinct from a genuinely agent-less run', async () => {
		const fs = makeFs();
		// Same observable shape (agents: []) as the test above, opposite cause: the entry existed but could not be
		// listed (no agentId/state). The envelope this proves - an empty list that still says partial - is the same
		// one `WorkflowAgentList`'s doc comment names for the legacy mission model, carried through to the honest
		// `WorkflowRun` model via `completeness`.
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest({
			workflowProgress: [{ type: 'workflow_agent', label: 'no id or state' }],
		}));
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.deepStrictEqual({ agents: run.agents, completeness: run.completeness }, { agents: [], completeness: CompletenessState.Partial });
	});

	test('an agentId absent from the journal\'s started records receives no transcriptRef', async () => {
		const fs = makeFs();
		const runId = 'wf_a1b2c3d4-e5f';
		await stageManifest(fs, runId, { ...terminalManifest(), workflowProgress: [agentEntry({ agentId: 'a1' })] });
		// No journal at all staged for this run - the "present in journal" join condition fails.
		await stageAgentTranscript(fs, runId, 'a1', [{ type: 'user', uuid: 'u1' }]);
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.strictEqual(run.agents[0].transcriptRef, undefined);
	});

	test('a missing sibling transcript file receives no transcriptRef', async () => {
		const fs = makeFs();
		const runId = 'wf_a1b2c3d4-e5f';
		await stageManifest(fs, runId, { ...terminalManifest(), workflowProgress: [agentEntry({ agentId: 'a1' })] });
		await stageJournal(fs, runId, [{ type: 'started', agentId: 'a1' }]);
		// No agent-a1.jsonl staged.
		const run = await listOne(fs) as TerminalWorkflowRun;
		assert.strictEqual(run.agents[0].transcriptRef, undefined);
	});

	test('readWorkflowAgentTranscript re-derives the path from identities and rejects an unsafe component', async () => {
		const fs = makeFs();
		const runId = 'wf_a1b2c3d4-e5f';
		await stageAgentTranscript(fs, runId, 'a1', [{ type: 'user', uuid: 'u1' }]);
		const service = makeService(fs);
		const good: WorkflowTranscriptRef = { sessionId: SESSION, runId, agentId: 'a1' };
		const okSlice = await service.readWorkflowAgentTranscript(RESOLVED, good);
		assert.strictEqual(okSlice.completeness, CompletenessState.Complete);
		const badRefs: WorkflowTranscriptRef[] = [
			{ sessionId: '../../elsewhere', runId, agentId: 'a1' },
			{ sessionId: SESSION, runId: '../escape', agentId: 'a1' },
			{ sessionId: SESSION, runId, agentId: '../../etc/passwd' },
		];
		for (const bad of badRefs) {
			const slice = await service.readWorkflowAgentTranscript(RESOLVED, bad);
			assert.deepStrictEqual({ records: slice.records.length, completeness: slice.completeness }, { records: 0, completeness: CompletenessState.Absent });
		}
	});

	// --- the typed root envelope - read-error != empty != no-match -------------------------------------------

	test('a projects dir that EXISTS but cannot be read is read-error, never the empty [] state', async () => {
		const fs = store.add(new FileService(new NullLogService()));
		const provider = store.add(new FlakyProvider());
		store.add(fs.registerProvider(Schemas.file, provider));
		const projectsDir = URI.joinPath(ROOT, 'projects');
		await fs.createFolder(projectsDir);
		provider.breakOn(projectsDir.path);
		const res = await makeService(fs).listWorkflows(RESOLVED);
		assert.strictEqual(res.state, 'read-error');
		assert.deepStrictEqual(res.runs, []);
		assert.ok(res.state === 'read-error' && res.message.length > 0, 'a read-error result must carry a message');
	});

	test('a project directory that exists but cannot be listed degrades the read to partial, readable runs still present', async () => {
		const fs = store.add(new FileService(new NullLogService()));
		const provider = store.add(new FlakyProvider());
		store.add(fs.registerProvider(Schemas.file, provider));
		// A SIBLING project dir, unrelated to the fixture's own `FOLDER` project - breaking it must not blank the
		// list, only degrade it: the healthy project beside it still enumerates.
		const brokenProjectDir = URI.joinPath(ROOT, 'projects', 'broken-project');
		await fs.createFolder(brokenProjectDir);
		provider.breakOn(brokenProjectDir.path);
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest());
		const res = await makeService(fs).listWorkflows(RESOLVED);
		assert.strictEqual(res.state, 'partial');
		assert.deepStrictEqual(res.runs.map(r => r.runId), ['wf_a1b2c3d4-e5f']);
	});

	test('a session whose manifest dir cannot be read degrades the read to partial, readable runs still present', async () => {
		const fs = store.add(new FileService(new NullLogService()));
		const provider = store.add(new FlakyProvider());
		store.add(fs.registerProvider(Schemas.file, provider));
		// A SIBLING session under the same project, unrelated to the fixture's own `SESSION` - a provider error
		// reading its `workflows/` dir (a real, non-FileNotFound error, not "the dir does not exist yet") must
		// degrade the list rather than being swallowed the way a genuinely-absent dir is.
		const brokenWorkflowsDir = URI.joinPath(sessionDir('broken-session'), 'workflows');
		await fs.createFolder(brokenWorkflowsDir);
		provider.breakOn(brokenWorkflowsDir.path);
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest());
		const res = await makeService(fs).listWorkflows(RESOLVED);
		assert.strictEqual(res.state, 'partial');
		assert.deepStrictEqual(res.runs.map(r => r.runId), ['wf_a1b2c3d4-e5f']);
	});

	test('a live journal whose write-time cannot be read degrades to partial, never complete', async () => {
		const fs = store.add(new FileService(new NullLogService()));
		const provider = store.add(new FlakyProvider());
		store.add(fs.registerProvider(Schemas.file, provider));
		// A manifest-LESS journal is a LIVE run: its records read fine (via readFile), but a `stat` failure means the
		// journal write-time - the only freshness signal a live run has - is a known gap. So the run must read
		// `partial`, NEVER `complete`. The walk's own `exists(journal)` stat must still succeed (so the run projects
		// at all), so the mtime `stat` is broken only from the THIRD stat on that path (exists + readFile's own
		// stat succeed first).
		await stageJournal(fs, 'wf_live0000-aaa', [{ type: 'started', agentId: 'a1' }]);
		provider.breakStatOnAfter(URI.joinPath(sessionDir(), 'subagents', 'workflows', 'wf_live0000-aaa', 'journal.jsonl').path, 2);
		const run = await listOne(fs) as LiveWorkflowRun;
		// startedCount > 0 proves the journal CONTENT read fine (readFile succeeded); only the mtime stat failed -
		// the exact case that must NOT ride under a `complete` label.
		assert.deepStrictEqual(
			{ kind: run.kind, contentRead: run.startedCount > 0, completeness: run.completeness, degradation: run.degradation },
			{ kind: 'live', contentRead: true, completeness: CompletenessState.Partial, degradation: 'partial' });
	});

	test('a missing projects dir is the honest empty state ("ok" + []), not read-error', async () => {
		const res = await makeService(makeFs()).listWorkflows(RESOLVED);
		assert.deepStrictEqual(res, { state: 'ok', runs: [] });
	});

	test('a no-config root is the honest empty state', async () => {
		const res = await makeService(makeFs()).listWorkflows({ kind: 'no-config' });
		assert.deepStrictEqual(res, { state: 'ok', runs: [] });
	});

	test('listWorkflows is re-callable and returns fresh data on every call - a re-read, never a cache', async () => {
		const fs = makeFs();
		const service = makeService(fs);
		const first = await service.listWorkflows(RESOLVED);
		assert.deepStrictEqual(first, { state: 'ok', runs: [] });
		await stageManifest(fs, 'wf_a1b2c3d4-e5f', terminalManifest());
		const second = await service.listWorkflows(RESOLVED);
		assert.strictEqual(second.state, 'ok');
		assert.strictEqual(second.runs.length, 1);
	});

	test('the seam exposes no run-control verb anywhere on its public surface', () => {
		const methods = Object.getOwnPropertyNames(ClawdiusReaderSeamService.prototype);
		for (const verb of ['launch', 'stop', 'steer', 'cancel', 'retry']) {
			assert.ok(!methods.some(m => m.toLowerCase().includes(verb)), `unexpected control verb "${verb}" on the reader seam: ${methods.join(', ')}`);
		}
	});
});
// CLAWDIUS-END
