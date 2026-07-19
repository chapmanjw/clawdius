/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - transcript drill-in tests
// The drill-in path: the seam reads a subagent's transcript through its opaque transcriptRef and returns a
// labeled, INDEX-ONLY slice (record types in view + the four honesty labels), which the editor's pure render
// helper paints with `data-*` hooks. The headline case: a subagent transcript referencing a MISSING
// out-of-band tool-result file drills in as `partial`, not `complete` - the drill-in read runs the out-of-band
// probe the coarse enumeration deliberately skips. A subagent whose transcript has no missing ref is `complete`.
// Fixtures are the committed sanitized `runs/` skeletons (no real ~/.claude content), staged into an in-memory FS.

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { CompletenessState, CoverageLabel, FreshnessLabel, ReaderConfigRoot } from '../../common/claudeReaderSeam.js';
import { FleetTranscriptSlice } from '../../common/claudeFleetModel.js';
import { WorkflowTranscriptRef } from '../../common/claudeWorkflowModel.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import { ClawdiusReaderSeamService } from '../../browser/reader/claudeReaderSeamService.js';
import { renderTranscriptSlice } from '../../browser/workflows/claudeWorkflowTranscriptEditor.js';
import { ClaudeWorkflowTranscriptInput, ClaudeWorkflowTranscriptInputSerializer } from '../../browser/workflows/claudeWorkflowTranscriptInput.js';
import { WORKFLOWS_VIEW_CONTAINER_ID, WORKFLOWS_VIEW_ID } from '../../browser/workflows/claudeWorkflowsView.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';

// The committed .jsonl skeletons are the single source of truth, read via the browser harness's file bridge.
declare const __readFileInTests: (path: string) => Promise<string>;
const FIXTURE_DIR = 'vs/workbench/contrib/clawdius/test/fixtures/reader-seam/runs';

async function loadFixture(name: string): Promise<string> {
	const src = URI.joinPath(FileAccess.asFileUri(''), '../src');
	return await __readFileInTests(URI.joinPath(src, FIXTURE_DIR, name).fsPath);
}

suite('Clawdius Claude Code Ultracode Workflows - transcript drill-in', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

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

	async function stage(fs: FileService, projectFolder: URI, name: string): Promise<void> {
		const dir = URI.joinPath(ROOT, 'projects', encodeProjectDir(projectFolder));
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, name), VSBuffer.fromString(await loadFixture(name)));
	}

	test('a subagent transcript with a missing out-of-band ref drills in as partial, not complete', async () => {
		const fs = makeFs();
		await stage(fs, FOLDER, 'run-c-oob-subagent.jsonl');
		const svc = makeService(fs);
		const runC = (await svc.listRuns(RESOLVED)).find(r => r.sessionId === 'sess-fleet-run-c')!;
		const sub = (await svc.listSubagents(RESOLVED, runC))[0];

		const slice = await svc.readSubagentTranscript(sub);
		// Fully labeled, and honestly PARTIAL because the referenced out-of-band tool-result file is missing.
		assert.deepStrictEqual({
			subagentId: slice.subagentId, coverage: slice.coverage, freshness: slice.freshness,
			completeness: slice.completeness, adapterVersion: slice.adapterVersion, recordTypes: slice.records.map(r => r.type),
		}, {
			subagentId: 'sub-c-01', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled,
			completeness: CompletenessState.Partial, adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
			recordTypes: ['user', 'assistant', 'user', 'assistant'],
		});
	});

	test('a subagent transcript with no missing ref drills in as complete', async () => {
		const fs = makeFs();
		await stage(fs, FOLDER, 'run-b-multi-subagent.jsonl');
		const svc = makeService(fs);
		const runB = (await svc.listRuns(RESOLVED)).find(r => r.sessionId === 'sess-fleet-run-b')!;
		const sub = (await svc.listSubagents(RESOLVED, runB))[0];
		const slice = await svc.readSubagentTranscript(sub);
		assert.strictEqual(slice.completeness, CompletenessState.Complete);
		assert.strictEqual(slice.coverage, CoverageLabel.InScope);
	});

	test('the editor render helper paints the completeness label + record count as data-* hooks', async () => {
		const fs = makeFs();
		await stage(fs, FOLDER, 'run-c-oob-subagent.jsonl');
		const svc = makeService(fs);
		const runC = (await svc.listRuns(RESOLVED)).find(r => r.sessionId === 'sess-fleet-run-c')!;
		const sub = (await svc.listSubagents(RESOLVED, runC))[0];
		const slice = await svc.readSubagentTranscript(sub);

		const container = $('div');
		renderTranscriptSlice(container, slice);

		assert.deepStrictEqual({
			subagent: container.getAttribute('data-clawdius-transcript-subagent'),
			completeness: container.getAttribute('data-clawdius-transcript-completeness'),
			coverage: container.getAttribute('data-clawdius-transcript-coverage'),
			freshness: container.getAttribute('data-clawdius-transcript-freshness'),
			records: container.getAttribute('data-clawdius-transcript-records'),
			partialBadge: container.querySelectorAll('.clawdius-transcript-label.completeness-partial').length,
			sidechainRows: container.querySelectorAll('.clawdius-transcript-record.sidechain').length,
			recordRows: container.querySelectorAll('.clawdius-transcript-record').length,
		}, {
			subagent: 'sub-c-01', completeness: 'partial', coverage: 'in-scope', freshness: 'polled',
			records: '4', partialBadge: 1, sidechainRows: 2, recordRows: 4,
		});
	});

	test('an empty/degraded slice renders an honest empty state, never a crash', () => {
		const slice: FleetTranscriptSlice = {
			subagentId: 'sub-x', records: [], coverage: CoverageLabel.OutOfScope, freshness: FreshnessLabel.Stale,
			completeness: CompletenessState.Absent, adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
		};
		const container = $('div');
		renderTranscriptSlice(container, slice);
		assert.strictEqual(container.getAttribute('data-clawdius-transcript-records'), '0');
		assert.strictEqual(container.getAttribute('data-clawdius-transcript-completeness'), 'absent');
		assert.strictEqual(container.querySelectorAll('[data-clawdius-transcript-empty]').length, 1);
		assert.strictEqual(container.querySelectorAll('.clawdius-transcript-record').length, 0);
	});

	// Backward-compat persistence keys: these string values are what VS Code actually writes to disk (the
	// serializer typeId keys a restored editor tab; the view + container ids key pinned activity-bar placement
	// and visibility). None of them may change - a pre-rename user who already has state persisted under the old
	// strings would silently lose their restored editors or their pinned placement the next time they open
	// Clawdius. These tests exist so an editor rename never touches these strings again by accident.

	test('backward-compat: the transcript editor-input typeId is preserved', () => {
		assert.strictEqual(ClaudeWorkflowTranscriptInput.ID, 'workbench.input.clawdiusMissionTranscript');
	});

	// The input was migrated from carrying a FleetSubagent to carrying a WorkflowTranscriptRef identity triple
	// (sessionId/runId/agentId) - never a stored path/URI, so the seam re-derives the transcript's on-disk path
	// from these identities on every read. The typeId above stays unchanged; the full identity-migration +
	// legacy-FleetSubagent-restore coverage lives in claudeWorkflowDetails.test.ts alongside the new drill-in
	// editors it ships beside.
	test('backward-compat: the transcript serializer round-trips a WorkflowTranscriptRef identity through the preserved typeId', () => {
		const ref: WorkflowTranscriptRef = { sessionId: 'sess-rt-01', runId: 'wf_run-rt-01', agentId: 'agent-rt-01' };
		const input = store.add(new ClaudeWorkflowTranscriptInput(ref));
		const serializer = new ClaudeWorkflowTranscriptInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());

		const raw = serializer.serialize(input);
		const deserialized = serializer.deserialize(instantiationService, raw);
		assert.ok(deserialized instanceof ClaudeWorkflowTranscriptInput);
		const restored = store.add(deserialized);

		// The restored input reconstructs the same identity triple - and, because `resource` is computed FROM the
		// ref (not itself persisted), the same resource the original input had.
		assert.deepStrictEqual(restored.ref, ref);
		assert.deepStrictEqual(restored.resource, input.resource);
	});

	test('backward-compat: the Workflows view + container ids are preserved', () => {
		assert.strictEqual(WORKFLOWS_VIEW_ID, 'clawdius.missions');
		assert.strictEqual(WORKFLOWS_VIEW_CONTAINER_ID, 'workbench.view.clawdiusMissions');
	});
});
// CLAWDIUS-END
