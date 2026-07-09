/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet seam-enumeration tests (Slice 1)
// Drives the seam's cross-project run-/subagent-enumeration over the sanitized `runs/` fixtures staged into an
// in-memory filesystem across several encoded project dirs: `listRuns` returns EVERY observable run each labeled
// coverage/freshness/completeness + adapter stamp (SC-001); a foreign run is present-with-label, not omitted
// (SC-002); a malformed file is present labeled `unknown-shape`; `listSubagents` lists a run's subagent roots;
// a no-config / empty-projects tree degrades to an empty labeled result; and `ownership` is `foreign` at this
// layer, NEVER `owned` (owned requires the later registry probe - the honesty ceiling).

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { FleetRun } from '../../common/claudeFleetModel.js';
import { CompletenessState, CoverageLabel, FreshnessLabel, ReaderConfigRoot } from '../../common/claudeReaderSeam.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import { ClawdiusReaderSeamService } from '../../browser/reader/claudeReaderSeamService.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';

// The committed .jsonl skeletons are the single source of truth, read via the browser harness's file bridge (the
// same mechanism the Slice-2/3 seam tests use) - no inline duplicate fixtures.
declare const __readFileInTests: (path: string) => Promise<string>;
const FIXTURE_DIR = 'vs/workbench/contrib/clawdius/test/fixtures/reader-seam/runs';

async function loadFixture(name: string): Promise<string> {
	const src = URI.joinPath(FileAccess.asFileUri(''), '../src');
	return await __readFileInTests(URI.joinPath(src, FIXTURE_DIR, name).fsPath);
}

/** The full labeled shape of a FleetRun - a run is fully labeled iff it carries exactly these keys (SC-001). */
const FLEET_RUN_KEYS = ['adapterVersion', 'completeness', 'coverage', 'freshness', 'kind', 'ownership', 'runId', 'sessionId', 'status'];

suite('Clawdius missions fleet - seam enumeration (Slice 1)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The resolved config root, and the active workspace folder in-scope runs declare as their cwd.
	const ROOT = URI.file('/home/tester/.claude');
	const FOLDER = URI.file('/work/fixture-proj');
	const RESOLVED: ReaderConfigRoot = { kind: 'resolved', root: ROOT };

	function makeFs(): FileService {
		const fs = store.add(new FileService(new NullLogService()));
		store.add(fs.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		return fs;
	}

	function makeService(fs: FileService): ClawdiusReaderSeamService {
		return new ClawdiusReaderSeamService(false, fs, new TestContextService(testWorkspace(FOLDER)));
	}

	/** Stage a fixture into `<root>/projects/<encodeProjectDir(projectFolder)>/<name>` (the on-disk layout the
	 *  enumeration walks). Different project folders produce different encoded dirs - the cross-project walk. */
	async function stage(fs: FileService, projectFolder: URI, name: string): Promise<void> {
		const dir = URI.joinPath(ROOT, 'projects', encodeProjectDir(projectFolder));
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, name), VSBuffer.fromString(await loadFixture(name)));
	}

	/** Stage the full multi-run / multi-subagent / foreign / malformed tree across several encoded project dirs. */
	async function stageFullTree(fs: FileService): Promise<void> {
		await stage(fs, URI.file('/work/fixture-proj'), 'run-a.jsonl');
		await stage(fs, URI.file('/work/fixture-proj'), 'run-b-multi-subagent.jsonl');
		await stage(fs, URI.file('/other/workspace/repo'), 'foreign.jsonl');
		await stage(fs, URI.file('/malformed-proj'), 'malformed.jsonl');
	}

	test('listRuns enumerates every run fully labeled; foreign present-with-label; ownership foreign, never owned (SC-001/SC-002)', async () => {
		const fs = makeFs();
		await stageFullTree(fs);
		const runs = await makeService(fs).listRuns(RESOLVED);

		// Every run carries the full label set - no unlabeled item (SC-001).
		assert.deepStrictEqual(runs.map(r => Object.keys(r).sort()), runs.map(() => FLEET_RUN_KEYS));
		// The labeled projection: every run present (a foreign run WITH its label not omitted - SC-002; a
		// malformed file present labeled unknown-shape), freshness=polled, and ownership=foreign for ALL runs -
		// never owned at the enumeration layer (owned requires the later registry probe - the honesty ceiling).
		assert.deepStrictEqual(runs.map(r => ({
			runId: r.runId, sessionId: r.sessionId, kind: r.kind, status: r.status,
			ownership: r.ownership, coverage: r.coverage, freshness: r.freshness, completeness: r.completeness,
		})), [
			{ runId: 'a-0001', sessionId: 'sess-fleet-run-a', kind: 'single', status: 'unknown', ownership: 'foreign', coverage: 'in-scope', freshness: 'polled', completeness: 'complete' },
			{ runId: 'b-0001', sessionId: 'sess-fleet-run-b', kind: 'single', status: 'unknown', ownership: 'foreign', coverage: 'in-scope', freshness: 'polled', completeness: 'complete' },
			{ runId: 'f-0001', sessionId: 'sess-fleet-foreign', kind: 'single', status: 'unknown', ownership: 'foreign', coverage: 'foreign', freshness: 'polled', completeness: 'complete' },
			{ runId: 'malformed', sessionId: 'malformed', kind: 'single', status: 'unknown', ownership: 'foreign', coverage: 'in-scope', freshness: 'polled', completeness: 'unknown-shape' },
		]);
	});

	test('a recognized run carries the v1 stamp; a malformed run carries the unknown-shape canary stamp', async () => {
		const fs = makeFs();
		await stageFullTree(fs);
		const runs = await makeService(fs).listRuns(RESOLVED);
		const stampBySession = new Map(runs.map(r => [r.sessionId, r.adapterVersion]));
		assert.deepStrictEqual(stampBySession.get('sess-fleet-run-a'), { format: 'transcript-jsonl', versionKey: 'v1' });
		assert.deepStrictEqual(stampBySession.get('malformed'), { format: 'transcript-jsonl', versionKey: 'unknown-shape' });
	});

	test('listSubagents lists a run\'s subagent roots, each labeled and drillable (US2 prerequisite)', async () => {
		const fs = makeFs();
		await stageFullTree(fs);
		const svc = makeService(fs);
		const runB = (await svc.listRuns(RESOLVED)).find(r => r.sessionId === 'sess-fleet-run-b')!;
		const subs = await svc.listSubagents(RESOLVED, runB);

		assert.deepStrictEqual(subs.map(s => ({
			subagentId: s.subagentId, parentRunId: s.parentRunId,
			coverage: s.coverage, freshness: s.freshness, completeness: s.completeness,
		})), [
			{ subagentId: 'sub-b-01', parentRunId: 'b-0001', coverage: 'in-scope', freshness: 'polled', completeness: 'complete' },
			{ subagentId: 'sub-b-02', parentRunId: 'b-0001', coverage: 'in-scope', freshness: 'polled', completeness: 'complete' },
		]);
		// Each subagent is drillable to its transcript via an opaque ref (the file identity).
		assert.ok(subs.every(s => s.transcriptRef.endsWith('.jsonl')));
	});

	test('a run with no subagents lists none', async () => {
		const fs = makeFs();
		await stageFullTree(fs);
		const svc = makeService(fs);
		const runA = (await svc.listRuns(RESOLVED)).find(r => r.sessionId === 'sess-fleet-run-a')!;
		assert.deepStrictEqual(await svc.listSubagents(RESOLVED, runA), []);
	});

	test('no config -> empty labeled result (never an error)', async () => {
		const svc = makeService(makeFs());
		assert.deepStrictEqual(await svc.listRuns({ kind: 'no-config' }), []);
		const stub: FleetRun = { runId: 'x', sessionId: 'x', kind: 'single', status: 'unknown', ownership: 'foreign', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Absent, adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' } };
		assert.deepStrictEqual(await svc.listSubagents({ kind: 'no-config' }, stub), []);
	});

	test('an empty projects dir -> empty labeled result', async () => {
		const fs = makeFs();
		await fs.createFolder(URI.joinPath(ROOT, 'projects'));
		assert.deepStrictEqual(await makeService(fs).listRuns(RESOLVED), []);
	});
});
// CLAWDIUS-END
