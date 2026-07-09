/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Reader-seam teams/tasks/cost adapter tests (Slice 3)
// Drives the teams, tasks, and cost adapters over the sanitized Slice-3 fixtures staged into an in-memory
// filesystem: each format's four-way matrix (present->complete, absent->absent, extra-field->forward-compatible
// complete, malformed->canary unknown-shape + stamp), an explicit assertion that the token-first cost adapter
// produces NO list-price USD figure (FR-011), and the service-level TEAMS-14 gating probe (off->absent,
// on->read) plus cost routing. freshness=live is deferred (out of scope), so fixture reads assert polled/stale.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { CostRecord, TeamRoster } from '../../common/claudeReaderSeam.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import { ClawdiusReaderSeamService, CostAdapter, TasksAdapter, TeamsAdapter, TranscriptJsonlAdapter } from '../../browser/reader/claudeReaderSeamService.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';

// The committed .jsonl / .json skeletons are the single source of truth, read via the browser harness's file
// bridge (the same mechanism the Slice-2 tests use) - no inline duplicate fixtures.
declare const __readFileInTests: (path: string) => Promise<string>;
const FIXTURE_ROOT = 'vs/workbench/contrib/clawdius/test/fixtures/reader-seam';

async function loadFixture(sub: string, name: string): Promise<string> {
	const src = URI.joinPath(FileAccess.asFileUri(''), '../src');
	return await __readFileInTests(URI.joinPath(src, FIXTURE_ROOT, sub, name).fsPath);
}

suite('Clawdius reader seam - teams/tasks/cost adapters (Slice 3)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const ROOT = URI.file('/home/tester/.claude');
	const FOLDER = URI.file('/work/fixture-proj');

	function makeFs(): FileService {
		const fs = store.add(new FileService(new NullLogService()));
		store.add(fs.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		return fs;
	}

	async function writeTeams(fs: FileService, name: string): Promise<void> {
		const dir = URI.joinPath(ROOT, 'teams');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, 'config.json'), VSBuffer.fromString(await loadFixture('teams', name)));
	}

	async function writeTasks(fs: FileService, name: string): Promise<void> {
		const dir = URI.joinPath(ROOT, 'tasks');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, 'tasks.json'), VSBuffer.fromString(await loadFixture('tasks', name)));
	}

	async function writeCost(fs: FileService, name: string): Promise<void> {
		const dir = URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER));
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, name), VSBuffer.fromString(await loadFixture('cost', name)));
	}

	// --- Teams four-way matrix -------------------------------------------------------------------------------

	test('teams present -> complete roster (members + mailbox), all four labels', async () => {
		const fs = makeFs();
		await writeTeams(fs, 'present.json');
		const r = await new TeamsAdapter(fs).read(ROOT);
		assert.deepStrictEqual(Object.keys(r).sort(), ['adapterVersion', 'completeness', 'coverage', 'entity', 'freshness']);
		assert.strictEqual(r.completeness, 'complete');
		assert.strictEqual(r.coverage, 'in-scope');
		assert.strictEqual(r.freshness, 'polled');
		assert.deepStrictEqual(r.adapterVersion, { format: 'teams-roster', versionKey: 'v1' });
		assert.deepStrictEqual(r.entity, {
			teamId: 'team-fixture-0001',
			members: [
				{ id: 'member-fixture-01', status: 'active' },
				{ id: 'member-fixture-02', status: 'idle' },
			],
			mailbox: [{ from: 'member-fixture-01', to: 'member-fixture-02', seq: 1 }],
		});
	});

	test('teams absent (empty doc) and a missing file both -> absent, not an error', async () => {
		const fs = makeFs();
		await writeTeams(fs, 'absent.json');
		assert.strictEqual((await new TeamsAdapter(fs).read(ROOT)).completeness, 'absent');
		assert.strictEqual((await new TeamsAdapter(makeFs()).read(ROOT)).completeness, 'absent');
	});

	test('teams extra-field -> forward-compatible complete (unknown keys ignored)', async () => {
		const fs = makeFs();
		await writeTeams(fs, 'extra-field.json');
		const r = await new TeamsAdapter(fs).read(ROOT);
		assert.strictEqual(r.completeness, 'complete');
		assert.deepStrictEqual(r.entity, {
			teamId: 'team-fixture-0002',
			members: [{ id: 'member-fixture-03', status: 'active' }],
			mailbox: [],
		});
	});

	test('teams malformed (unrecognized shape) -> canary unknown-shape + stamp', async () => {
		const fs = makeFs();
		await writeTeams(fs, 'malformed.json');
		const r = await new TeamsAdapter(fs).read(ROOT);
		assert.strictEqual(r.completeness, 'unknown-shape');
		assert.deepStrictEqual(r.adapterVersion, { format: 'teams-roster', versionKey: 'unknown-shape' });
	});

	// --- Tasks four-way matrix -------------------------------------------------------------------------------

	test('tasks present -> complete task list (claims + file locks), all four labels', async () => {
		const fs = makeFs();
		await writeTasks(fs, 'present.json');
		const r = await new TasksAdapter(fs).read(ROOT);
		assert.deepStrictEqual(Object.keys(r).sort(), ['adapterVersion', 'completeness', 'coverage', 'entity', 'freshness']);
		assert.strictEqual(r.completeness, 'complete');
		assert.deepStrictEqual(r.adapterVersion, { format: 'tasks-list', versionKey: 'v1' });
		assert.deepStrictEqual(r.entity, {
			tasks: [
				{ id: 'task-fixture-01', status: 'in-progress', claimedBy: 'member-fixture-01', fileLocks: ['src/example/placeholder.ts'] },
				{ id: 'task-fixture-02', status: 'todo', claimedBy: undefined, fileLocks: [] },
			],
		});
	});

	test('tasks absent (empty doc) and a missing file both -> absent', async () => {
		const fs = makeFs();
		await writeTasks(fs, 'absent.json');
		assert.strictEqual((await new TasksAdapter(fs).read(ROOT)).completeness, 'absent');
		assert.strictEqual((await new TasksAdapter(makeFs()).read(ROOT)).completeness, 'absent');
	});

	test('tasks extra-field -> forward-compatible complete (unknown keys ignored)', async () => {
		const fs = makeFs();
		await writeTasks(fs, 'extra-field.json');
		const r = await new TasksAdapter(fs).read(ROOT);
		assert.strictEqual(r.completeness, 'complete');
		assert.deepStrictEqual(r.entity, {
			tasks: [{ id: 'task-fixture-03', status: 'done', claimedBy: 'member-fixture-02', fileLocks: [] }],
		});
	});

	test('tasks malformed (unrecognized shape) -> canary unknown-shape + stamp', async () => {
		const fs = makeFs();
		await writeTasks(fs, 'malformed.json');
		const r = await new TasksAdapter(fs).read(ROOT);
		assert.strictEqual(r.completeness, 'unknown-shape');
		assert.deepStrictEqual(r.adapterVersion, { format: 'tasks-list', versionKey: 'unknown-shape' });
	});

	// --- Cost four-way matrix (token-first) ------------------------------------------------------------------

	function costAdapter(fs: FileService): CostAdapter {
		return new CostAdapter(new TranscriptJsonlAdapter(fs));
	}

	test('cost present -> complete token rollup (per-model + totals), all four labels', async () => {
		const fs = makeFs();
		await writeCost(fs, 'present.jsonl');
		const r = await costAdapter(fs).read(ROOT, FOLDER);
		assert.deepStrictEqual(Object.keys(r).sort(), ['adapterVersion', 'completeness', 'coverage', 'entity', 'freshness']);
		assert.strictEqual(r.completeness, 'complete');
		assert.strictEqual(r.coverage, 'in-scope');
		assert.strictEqual(r.freshness, 'polled');
		assert.deepStrictEqual(r.adapterVersion, { format: 'cost-token-rollup', versionKey: 'v1' });
		assert.deepStrictEqual(r.entity, {
			totalInputTokens: 400,
			totalOutputTokens: 160,
			perModel: [
				{ model: 'model-fixture-a', inputTokens: 200, outputTokens: 70 },
				{ model: 'model-fixture-b', inputTokens: 200, outputTokens: 90 },
			],
		});
	});

	test('cost absent (empty transcript) and a missing dir both -> absent', async () => {
		const fs = makeFs();
		await writeCost(fs, 'absent.jsonl');
		assert.strictEqual((await costAdapter(fs).read(ROOT, FOLDER)).completeness, 'absent');
		assert.strictEqual((await costAdapter(makeFs()).read(ROOT, FOLDER)).completeness, 'absent');
	});

	test('cost extra-field usage -> forward-compatible complete (extra token fields ignored)', async () => {
		const fs = makeFs();
		await writeCost(fs, 'extra-field.jsonl');
		const r = await costAdapter(fs).read(ROOT, FOLDER);
		assert.strictEqual(r.completeness, 'complete');
		assert.deepStrictEqual(r.entity, {
			totalInputTokens: 50,
			totalOutputTokens: 25,
			perModel: [{ model: 'model-fixture-a', inputTokens: 50, outputTokens: 25 }],
		});
	});

	test('cost malformed (unrecognized transcript shape) -> canary unknown-shape + stamp', async () => {
		const fs = makeFs();
		await writeCost(fs, 'malformed.jsonl');
		const r = await costAdapter(fs).read(ROOT, FOLDER);
		assert.strictEqual(r.completeness, 'unknown-shape');
		assert.deepStrictEqual(r.adapterVersion, { format: 'cost-token-rollup', versionKey: 'unknown-shape' });
	});

	test('cost adapter produces NO list-price USD figure - token-first only (FR-011)', async () => {
		const fs = makeFs();
		await writeCost(fs, 'present.jsonl');
		const cost = (await costAdapter(fs).read(ROOT, FOLDER)).entity as CostRecord;
		// The read model carries token counts only: the top-level shape is exactly tokens + a per-model rollup,
		// and no field at any level names a currency / price. A list-price USD is never derived (FR-011).
		assert.deepStrictEqual(Object.keys(cost).sort(), ['perModel', 'totalInputTokens', 'totalOutputTokens']);
		const everyKey = [...Object.keys(cost), ...cost.perModel.flatMap(m => Object.keys(m))];
		assert.ok(!everyKey.some(k => /usd|dollar|price|money|cash|spend/i.test(k)), 'no monetary field may appear in the token-first cost record');
	});

	// --- Service-level TEAMS-14 gating probe + routing -------------------------------------------------------

	test('service gates teams/tasks behind the TEAMS-14 probe: off -> absent, on -> read', async () => {
		const fsOff = makeFs();
		await writeTeams(fsOff, 'present.json');
		const off = new ClawdiusReaderSeamService(false, fsOff, new TestContextService(testWorkspace(FOLDER)));
		const offRes = await off.read({ kind: 'team-roster', root: { kind: 'resolved', root: ROOT } });
		assert.strictEqual(offRes.completeness, 'absent');
		assert.deepStrictEqual(offRes.adapterVersion, { format: 'teams-roster', versionKey: 'v1' });

		const fsOn = makeFs();
		await writeTeams(fsOn, 'present.json');
		const on = new ClawdiusReaderSeamService(true, fsOn, new TestContextService(testWorkspace(FOLDER)));
		const onRes = await on.read<TeamRoster>({ kind: 'team-roster', root: { kind: 'resolved', root: ROOT } });
		assert.strictEqual(onRes.completeness, 'complete');
		assert.strictEqual(onRes.entity.teamId, 'team-fixture-0001');
	});

	test('service routes cost-rollup to the token-first cost adapter (probe-independent)', async () => {
		const fs = makeFs();
		await writeCost(fs, 'present.jsonl');
		const svc = new ClawdiusReaderSeamService(false, fs, new TestContextService(testWorkspace(FOLDER)));
		const r = await svc.read<CostRecord>({ kind: 'cost-rollup', root: { kind: 'resolved', root: ROOT } });
		assert.strictEqual(r.completeness, 'complete');
		assert.strictEqual(r.entity.totalInputTokens, 400);
	});

	test('service no-config root -> out-of-scope absent, still fully labeled (SC-001)', async () => {
		const svc = new ClawdiusReaderSeamService(true, makeFs(), new TestContextService(testWorkspace(FOLDER)));
		for (const kind of ['team-roster', 'task-list', 'cost-rollup'] as const) {
			const r = await svc.read({ kind, root: { kind: 'no-config' } });
			assert.deepStrictEqual(Object.keys(r).sort(), ['adapterVersion', 'completeness', 'coverage', 'entity', 'freshness']);
			assert.strictEqual(r.completeness, 'absent');
			assert.strictEqual(r.coverage, 'out-of-scope');
		}
	});
});
// CLAWDIUS-END
