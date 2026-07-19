/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - observation service + graduation tests
// Two kinds of proof, deliberately kept separate:
//   - The OBSERVATION SERVICE tests drive `ClaudeWorkflowObservationService` over a REAL `FileService` +
//     `InMemoryFileSystemProvider` (never a stub of the file-watching machinery itself), staged in the launcher's
//     real on-disk layout - watcher coalescing, the per-run manifest-vs-journal reconcile, and the torn-manifest
//     stays-live guarantee are all real behavior, not reimplemented assertions.
//   - The GRADUATION tests drive `reconcileWorkflowTree` (claudeWorkflowTree.ts) against a directly-constructed
//     `ObjectTree` (the same base class `WorkbenchObjectTree` extends, so this is the real tree-diffing engine,
//     just without the workbench services a full ViewPane would need) - the no-duplicate-row guarantee, the
//     preserved-reference-across-graduation guarantee, and stable live ordering.

import assert from 'assert';
import { ObjectTree } from '../../../../../base/browser/ui/tree/objectTree.js';
import { ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import {
	ClaudeWorkflowObservationService, IClaudeWorkflowObservationService, WorkflowSnapshot,
} from '../../browser/workflows/claudeWorkflowObservationService.js';
import {
	describeLiveProgress, reconcileWorkflowTree, resolveTrackedElements, WorkflowStoryHeightCache, WorkflowTreeElement,
	WorkflowTreeIdentityProvider, WorkflowTreeReconcileState, WorkflowTreeTemplateId, WorkflowTreeVirtualDelegate,
	workflowTreeElementId,
} from '../../browser/workflows/claudeWorkflowTree.js';
import { CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';
import {
	LiveWorkflowRun, TerminalWorkflowAgent, TerminalWorkflowRun, workflowRunIdentity,
} from '../../common/claudeWorkflowModel.js';

const STAMP = { format: 'transcript-jsonl', versionKey: 'v1' };

/** A minimally-labeled live run - every honesty label is the honest default for a freshly-observed run. */
function liveRun(sessionId: string, runId: string, overrides: Partial<LiveWorkflowRun> = {}): LiveWorkflowRun {
	return {
		kind: 'live', sessionId, runId, identity: workflowRunIdentity(sessionId, runId),
		startedCount: 1, resultCount: 0, seenCount: 1, landedResults: [], journalLastWriteTime: 1_700_000_000_000,
		ownership: 'foreign', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Live,
		completeness: CompletenessState.Complete, adapterVersion: STAMP,
		...overrides,
	};
}

function terminalAgent(agentId: string): TerminalWorkflowAgent {
	return { agentId, label: agentId, state: 'done' };
}

/** A minimally-labeled terminal run carrying one agent, so its story + agent children are non-empty. */
function terminalRun(sessionId: string, runId: string, overrides: Partial<TerminalWorkflowRun> = {}): TerminalWorkflowRun {
	return {
		kind: 'terminal', sessionId, runId, identity: workflowRunIdentity(sessionId, runId),
		status: 'completed', phases: [], agents: [terminalAgent('a1')],
		ownership: 'foreign', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled,
		completeness: CompletenessState.Complete, adapterVersion: STAMP,
		...overrides,
	};
}

// --- observation service: real watcher + real seam re-read -----------------------------------------------------

suite('Clawdius Claude Code Ultracode Workflows - observation service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const HOME = URI.file('/home/tester');
	const ROOT = URI.joinPath(HOME, '.claude');
	const FOLDER = URI.file('/work/fixture-proj');
	const SESSION = '5c2af930-2a73-4f6b-9011-72fdfa851624';

	function sessionDir(): URI {
		return URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER), SESSION);
	}

	function makeFs(): FileService {
		const fs = store.add(new FileService(new NullLogService()));
		store.add(fs.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		return fs;
	}

	function makeService(fs: IFileService): ClaudeWorkflowObservationService {
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IFileService, fs);
		instantiationService.stub(IWorkspaceContextService, new TestContextService(testWorkspace(FOLDER)));
		instantiationService.stub(IPathService, new TestPathService(HOME, HOME.scheme));
		return store.add(instantiationService.createInstance(ClaudeWorkflowObservationService));
	}

	/** Resolves with the NEXT snapshot the service emits (a one-shot listener, self-disposing on fire). */
	function nextSnapshot(service: IClaudeWorkflowObservationService): Promise<WorkflowSnapshot> {
		return new Promise(resolve => {
			const d = store.add(service.onDidChangeSnapshot(s => { d.dispose(); resolve(s); }));
		});
	}

	async function stageManifest(fs: IFileService, runId: string, manifest: object): Promise<void> {
		const dir = URI.joinPath(sessionDir(), 'workflows');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `${runId}.json`), VSBuffer.fromString(JSON.stringify(manifest)));
	}

	/** Stage a manifest file that is present but NOT valid JSON - the "torn manifest" shape: the reader seam
	 *  cannot parse it, so the run is simply absent from its manifest set and falls through to its journal. */
	async function stageTornManifest(fs: IFileService, runId: string): Promise<void> {
		const dir = URI.joinPath(sessionDir(), 'workflows');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `${runId}.json`), VSBuffer.fromString('{"status":"completed", "truncated mid-w'));
	}

	async function stageJournal(fs: IFileService, runId: string, lines: readonly object[]): Promise<void> {
		const dir = URI.joinPath(sessionDir(), 'subagents', 'workflows', runId);
		await fs.createFolder(dir);
		const text = lines.map(l => JSON.stringify(l) + '\n').join('');
		await fs.writeFile(URI.joinPath(dir, 'journal.jsonl'), VSBuffer.fromString(text));
	}

	test('the first snapshot reflects a manifest-backed terminal run AND a manifest-less live run in ONE read', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_11111111-aaa', {
			workflowName: 'audit', status: 'completed',
			workflowProgress: [{ index: 0, agentId: 'a1', label: 'audit:fleet', type: 'workflow_agent', state: 'done' }],
		});
		await stageJournal(fs, 'wf_22222222-bbb', [{ type: 'started', agentId: 'a1' }]);

		const snapshot = await nextSnapshot(makeService(fs));

		assert.strictEqual(snapshot.result.state, 'ok');
		assert.deepStrictEqual(
			snapshot.result.state === 'ok' ? snapshot.result.runs.map(r => ({ runId: r.runId, kind: r.kind })).sort((a, b) => a.runId.localeCompare(b.runId)) : [],
			[{ runId: 'wf_11111111-aaa', kind: 'terminal' }, { runId: 'wf_22222222-bbb', kind: 'live' }],
		);
		assert.strictEqual(snapshot.liveCount, 1);
		// Deferred: no persisted watermark exists yet, so awareness is always empty here.
		assert.deepStrictEqual(snapshot.unseenFailures, []);
	});

	test('a torn (unparseable) manifest never creates a terminal sibling - the run stays live', async () => {
		const fs = makeFs();
		await stageTornManifest(fs, 'wf_33333333-ccc');
		await stageJournal(fs, 'wf_33333333-ccc', [{ type: 'started', agentId: 'a1' }, { type: 'started', agentId: 'a2' }]);

		const snapshot = await nextSnapshot(makeService(fs));

		assert.strictEqual(snapshot.result.state, 'ok');
		const runs = snapshot.result.state === 'ok' ? snapshot.result.runs : [];
		assert.strictEqual(runs.length, 1); // exactly one row for this run - never a torn "terminal" AND a live sibling
		assert.strictEqual(runs[0].kind, 'live');
		assert.strictEqual(snapshot.liveCount, 1);
	});

	test('markFailuresSeen() is a no-op - there is no persisted watermark yet to mark', async () => {
		const fs = makeFs();
		const service = makeService(fs);
		await nextSnapshot(service);
		assert.doesNotThrow(() => service.markFailuresSeen());
		assert.deepStrictEqual(service.snapshot.unseenFailures, []);
	});

	test('a burst of file-change events yields ONE coalesced snapshot, not one per event', async function () {
		this.timeout(5000);
		const fs = makeFs();
		const service = makeService(fs);
		await nextSnapshot(service); // the initial (empty) read

		let fired = 0;
		store.add(service.onDidChangeSnapshot(() => { fired++; }));

		// Three separate writes, each spaced past the in-memory provider's own 5ms internal batching window (so
		// each is a DISTINCT onDidFilesChange firing) but all well within the service's 250ms coalescing window.
		await stageJournal(fs, 'wf_44444444-ddd', [{ type: 'started', agentId: 'a1' }]);
		await new Promise(resolve => setTimeout(resolve, 30));
		await stageJournal(fs, 'wf_55555555-eee', [{ type: 'started', agentId: 'a1' }]);
		await new Promise(resolve => setTimeout(resolve, 30));
		await stageJournal(fs, 'wf_66666666-fff', [{ type: 'started', agentId: 'a1' }]);

		// Wait past the coalescing window (250ms from the LAST relevant event) for the one coalesced refresh to land.
		await new Promise(resolve => setTimeout(resolve, 450));

		assert.strictEqual(fired, 1);
		assert.strictEqual(service.snapshot.liveCount, 3);
	});

	test('readAgain() re-runs the enumeration immediately, without waiting out the coalescing delay', async () => {
		const fs = makeFs();
		const service = makeService(fs);
		await nextSnapshot(service);

		await stageJournal(fs, 'wf_77777777-ggg', [{ type: 'started', agentId: 'a1' }]);
		const next = nextSnapshot(service);
		service.readAgain();
		const snapshot = await next;
		assert.strictEqual(snapshot.liveCount, 1);
	});
});

// --- graduation: the tree-diffing reconciliation, driven against a real ObjectTree ------------------------------

/** A renderer that does nothing beyond satisfying the interface - the graduation tests exercise the TREE MODEL's
 *  own diffing/identity mechanics (`reconcileWorkflowTree`), not DOM output, which the sibling renderer test
 *  suites already cover directly. */
class NoopRenderer implements ITreeRenderer<WorkflowTreeElement, FuzzyScore, HTMLElement> {
	constructor(readonly templateId: string) { }
	renderTemplate(container: HTMLElement): HTMLElement { return container; }
	renderElement(_node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, _template: HTMLElement): void { }
	disposeTemplate(_template: HTMLElement): void { }
}

function makeTree(store: Pick<DisposableStore, 'add'>): ObjectTree<WorkflowTreeElement, FuzzyScore> {
	const heights = new WorkflowStoryHeightCache();
	const container = document.createElement('div');
	return store.add(new ObjectTree<WorkflowTreeElement, FuzzyScore>(
		'test-clawdius-workflow-tree',
		container,
		new WorkflowTreeVirtualDelegate(heights),
		[
			new NoopRenderer(WorkflowTreeTemplateId.Run), new NoopRenderer(WorkflowTreeTemplateId.Story),
			new NoopRenderer(WorkflowTreeTemplateId.LiveProgress), new NoopRenderer(WorkflowTreeTemplateId.Phase),
			new NoopRenderer(WorkflowTreeTemplateId.Agent),
		],
		{ identityProvider: new WorkflowTreeIdentityProvider() },
	));
}

const EMPTY_RECONCILE_STATE: WorkflowTreeReconcileState = { elementByRunId: new Map(), liveIdentities: new Set(), renderedSignatureByRunId: new Map() };

/** The tree's current top-level row ids, in order - `ITreeNode<T | null, ...>.element` is typed `T | null` only
 *  because the ROOT node itself can hold `null`; a top-level (depth-1) node's element is never actually null. */
function topLevelIds(tree: ObjectTree<WorkflowTreeElement, FuzzyScore>): string[] {
	return tree.getNode(null).children
		.map(c => c.element)
		.filter((e): e is WorkflowTreeElement => e !== null)
		.map(workflowTreeElementId);
}

suite('Clawdius Claude Code Ultracode Workflows - graduation reconciliation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a live run graduating to terminal replaces its row in place - no duplicate, same tracked element', () => {
		const tree = makeTree(store);
		const sessionId = 'sess-1', runId = 'wf_11111111-aaa';
		const live = liveRun(sessionId, runId);

		const r1 = reconcileWorkflowTree(tree, [live], EMPTY_RECONCILE_STATE);
		assert.deepStrictEqual(
			{ topLevelCount: tree.getNode(null).children.length, graduated: r1.graduated.length, liveChildren: tree.getNode(r1.elementByRunId.get(runId)!).children.length },
			{ topLevelCount: 1, graduated: 0, liveChildren: 1 }, // the one live-progress leaf
		);

		const terminal = terminalRun(sessionId, runId);
		const r2 = reconcileWorkflowTree(tree, [terminal], { elementByRunId: r1.elementByRunId, liveIdentities: r1.liveIdentities, renderedSignatureByRunId: r1.renderedSignatureByRunId });

		const trackedAfter = r2.elementByRunId.get(runId);
		assert.deepStrictEqual(
			{
				topLevelCount: tree.getNode(null).children.length, // still exactly one row - never two
				graduatedRunIds: r2.graduated.map(g => g.runId),
				samePreservedReference: trackedAfter === r1.elementByRunId.get(runId), // genuinely the same row, not a delete+recreate
				childrenNowPresent: tree.getNode(trackedAfter!).children.length > 0, // story + agent replaced the live-progress leaf
				stillLive: r2.liveIdentities.has(live.identity),
			},
			{ topLevelCount: 1, graduatedRunIds: [runId], samePreservedReference: true, childrenNowPresent: true, stillLive: false },
		);
	});

	test('a run that stays live across a reconcile is never reported as graduated, and its identity stays tracked', () => {
		const tree = makeTree(store);
		const sessionId = 'sess-2', runId = 'wf_22222222-bbb';
		const r1 = reconcileWorkflowTree(tree, [liveRun(sessionId, runId, { startedCount: 1, resultCount: 0 })], EMPTY_RECONCILE_STATE);
		const r2 = reconcileWorkflowTree(tree, [liveRun(sessionId, runId, { startedCount: 2, resultCount: 1 })], { elementByRunId: r1.elementByRunId, liveIdentities: r1.liveIdentities, renderedSignatureByRunId: r1.renderedSignatureByRunId });

		assert.deepStrictEqual(
			{ graduated: r2.graduated.length, stillLive: [...r2.liveIdentities], rowCount: tree.getNode(null).children.length },
			{ graduated: 0, stillLive: [workflowRunIdentity(sessionId, runId)], rowCount: 1 },
		);
	});

	test('a run that is ALREADY terminal on first sight is never reported as graduated (only a live -> terminal transition is)', () => {
		const tree = makeTree(store);
		const result = reconcileWorkflowTree(tree, [terminalRun('sess-3', 'wf_33333333-ccc')], EMPTY_RECONCILE_STATE);
		assert.deepStrictEqual(result.graduated, []);
	});

	test('concurrent live runs hold a stable order by run identifier across repeated reconciles', () => {
		const tree = makeTree(store);
		const runs: LiveWorkflowRun[] = [
			liveRun('sess-a', 'wf_11111111-aaa'), liveRun('sess-b', 'wf_22222222-bbb'), liveRun('sess-c', 'wf_33333333-ccc'),
		]; // already in the seam's own deterministic (sessionId, runId) sort order
		const expectedOrder = runs.map(r => workflowTreeElementId({ kind: 'run', run: r }));

		const r1 = reconcileWorkflowTree(tree, runs, EMPTY_RECONCILE_STATE);
		const orderAfterFirst = topLevelIds(tree);

		// Reconcile again with the SAME identities in the SAME order, but with advancing live data - the order must
		// not shuffle just because each run's own counts changed.
		const advanced = runs.map(r => ({ ...r, startedCount: r.startedCount + 1 }));
		reconcileWorkflowTree(tree, advanced, { elementByRunId: r1.elementByRunId, liveIdentities: r1.liveIdentities, renderedSignatureByRunId: r1.renderedSignatureByRunId });
		const orderAfterSecond = topLevelIds(tree);

		assert.deepStrictEqual({ orderAfterFirst, orderAfterSecond }, { orderAfterFirst: expectedOrder, orderAfterSecond: expectedOrder });
	});

	test('focus/selection restore after a reconcile that KEEPS a run\'s identity never throws - idToElement hands back the TRACKED reference, not a fresh build', () => {
		// Reproduces the capture -> reconcile -> restore sequence `claudeWorkflowsView.ts`'s `applyTreeSnapshot` /
		// `restoreFocusAndSelection` perform: `setChildren(null, children, {diffIdentityProvider})` keeps the OLD
		// element for a persisting identity, so `idToElement` must resolve a captured id to that SAME tracked
		// reference - handing `setFocus`/`setSelection` a freshly-built (untracked) one throws `TreeError`.
		const tree = makeTree(store);
		const sessionId = 'sess-6', runId = 'wf_66666666-fff';
		const hasElement = (e: WorkflowTreeElement) => tree.hasElement(e);
		const captureIds = () => new Set(
			[...tree.getFocus(), ...tree.getSelection()].filter((e): e is WorkflowTreeElement => e !== null).map(workflowTreeElementId));
		const restore = (ids: ReadonlySet<string>, idToElement: ReadonlyMap<string, WorkflowTreeElement>) => {
			const elements = resolveTrackedElements(ids, idToElement, hasElement);
			if (elements.length > 0) { tree.setFocus(elements); tree.setSelection(elements); }
		};

		const r1 = reconcileWorkflowTree(tree, [liveRun(sessionId, runId, { startedCount: 1, resultCount: 0 })], EMPTY_RECONCILE_STATE);
		const runElement = r1.elementByRunId.get(runId)!;
		tree.setFocus([runElement]);
		tree.setSelection([runElement]);

		// A live-refresh reconcile: SAME identity, advancing counts - the top-level diff keeps the OLD element.
		const ids1 = captureIds();
		const r2 = reconcileWorkflowTree(tree, [liveRun(sessionId, runId, { startedCount: 2, resultCount: 1 })],
			{ elementByRunId: r1.elementByRunId, liveIdentities: r1.liveIdentities, renderedSignatureByRunId: r1.renderedSignatureByRunId });
		assert.doesNotThrow(() => restore(ids1, r2.idToElement));
		assert.deepStrictEqual(
			{ focusIsRunRow: tree.getFocus()[0] === r2.elementByRunId.get(runId), selectionIsRunRow: tree.getSelection()[0] === r2.elementByRunId.get(runId) },
			{ focusIsRunRow: true, selectionIsRunRow: true },
		);

		// Graduate: SAME identity, now terminal - restore must still never throw.
		const ids2 = captureIds();
		const r3 = reconcileWorkflowTree(tree, [terminalRun(sessionId, runId)],
			{ elementByRunId: r2.elementByRunId, liveIdentities: r2.liveIdentities, renderedSignatureByRunId: r2.renderedSignatureByRunId });
		assert.doesNotThrow(() => restore(ids2, r3.idToElement));
	});

	test('a run that is already terminal before and after, but whose manifest was REWRITTEN, gets its children replaced (not left stale)', () => {
		const tree = makeTree(store);
		const sessionId = 'sess-8', runId = 'wf_88888888-iii';
		const completed = terminalRun(sessionId, runId, { status: 'completed', agents: [terminalAgent('a1')] });
		const r1 = reconcileWorkflowTree(tree, [completed], EMPTY_RECONCILE_STATE);
		assert.deepStrictEqual(r1.graduated, []); // already terminal on first sight - not a graduation

		const failed = terminalRun(sessionId, runId, { status: 'failed', error: 'boom', agents: [{ ...terminalAgent('a1'), state: 'error' }] });
		const r2 = reconcileWorkflowTree(tree, [failed],
			{ elementByRunId: r1.elementByRunId, liveIdentities: r1.liveIdentities, renderedSignatureByRunId: r1.renderedSignatureByRunId });

		const tracked = r2.elementByRunId.get(runId)!;
		const storyElement = tree.getNode(tracked).children[0].element as Extract<WorkflowTreeElement, { kind: 'story' }>;
		assert.deepStrictEqual(
			{
				sameTrackedReference: tracked === r1.elementByRunId.get(runId), // still the same row, not a delete+recreate
				notReportedAsGraduated: r2.graduated,
				storyRunStatus: storyElement.run.status, // the rebuilt story leaf reflects the REWRITTEN data
			},
			{ sameTrackedReference: true, notReportedAsGraduated: [], storyRunStatus: 'failed' },
		);
	});

	test('a terminal rewrite that touches ONLY a previously-under-signed field (summary + an agent label, same status/tally) still re-renders', () => {
		const tree = makeTree(store);
		const sessionId = 'sess-8b', runId = 'wf_8b8b8b8b-kkk';
		const before = terminalRun(sessionId, runId, { summary: 'first summary', agents: [{ ...terminalAgent('a1'), label: 'reviewer' }] });
		const r1 = reconcileWorkflowTree(tree, [before], EMPTY_RECONCILE_STATE);

		// SAME status / agent count / result - only the summary and one agent's label move. A coarse signature keyed
		// on status + tallies + a result prefix would miss both and leave the row stale; the full-projection hash does not.
		const after = terminalRun(sessionId, runId, { summary: 'second summary', agents: [{ ...terminalAgent('a1'), label: 'auditor' }] });
		const r2 = reconcileWorkflowTree(tree, [after],
			{ elementByRunId: r1.elementByRunId, liveIdentities: r1.liveIdentities, renderedSignatureByRunId: r1.renderedSignatureByRunId });

		const tracked = r2.elementByRunId.get(runId)!;
		const storyElement = tree.getNode(tracked).children[0].element as Extract<WorkflowTreeElement, { kind: 'story' }>;
		assert.deepStrictEqual(
			{ sameTrackedReference: tracked === r1.elementByRunId.get(runId), storySummary: storyElement.run.summary, notReportedAsGraduated: r2.graduated },
			{ sameTrackedReference: true, storySummary: 'second summary', notReportedAsGraduated: [] },
		);
	});

	test('a run that is already terminal before and after, and UNCHANGED since it was last rendered, is left untouched', () => {
		const tree = makeTree(store);
		const sessionId = 'sess-9', runId = 'wf_99999999-jjj';
		const r1 = reconcileWorkflowTree(tree, [terminalRun(sessionId, runId)], EMPTY_RECONCILE_STATE);
		const tracked = r1.elementByRunId.get(runId)!;
		const storyElementBefore = tree.getNode(tracked).children[0].element;

		// A SECOND, distinct-but-equal run object (same data, not the same reference) - the signature must compare
		// CONTENT, not object identity, so this still counts as "unchanged".
		const r2 = reconcileWorkflowTree(tree, [terminalRun(sessionId, runId)],
			{ elementByRunId: r1.elementByRunId, liveIdentities: r1.liveIdentities, renderedSignatureByRunId: r1.renderedSignatureByRunId });
		const storyElementAfter = tree.getNode(r2.elementByRunId.get(runId)!).children[0].element;

		assert.deepStrictEqual(
			{ sameStoryElementReference: storyElementAfter === storyElementBefore, notReportedAsGraduated: r2.graduated },
			{ sameStoryElementReference: true, notReportedAsGraduated: [] },
		);
	});

	test('a read-error interlude that ALSO clears the tree (the fix) recovers cleanly - the next successful read never throws and the run renders again', () => {
		// Reproduces what `claudeWorkflowsView.ts`'s non-tree (`read-error`) branch now does: bookkeeping resets to
		// empty AND the tree itself is cleared, so the two stay in lockstep. Without the tree clear, the tree would
		// still hold the OLD node for this identity while `previous.elementByRunId` believes nothing exists - the
		// next reconcile would then compute `tracked` as a freshly-built (tree-untracked) element and throw scoping
		// `setChildren`/`rerender` to it.
		const tree = makeTree(store);
		const sessionId = 'sess-10', runId = 'wf_10101010-kkk';
		reconcileWorkflowTree(tree, [liveRun(sessionId, runId)], EMPTY_RECONCILE_STATE);
		assert.strictEqual(tree.getNode(null).children.length, 1);

		// Simulate the FIXED non-tree branch: clear the tree alongside the bookkeeping reset.
		tree.setChildren(null, []);

		let threw = false;
		let r2: ReturnType<typeof reconcileWorkflowTree> | undefined;
		try {
			r2 = reconcileWorkflowTree(tree, [liveRun(sessionId, runId)], EMPTY_RECONCILE_STATE);
		} catch {
			threw = true;
		}

		assert.strictEqual(threw, false);
		const trackedAfter = r2?.elementByRunId.get(runId);
		assert.deepStrictEqual(
			{ topLevelCount: tree.getNode(null).children.length, tracked: trackedAfter !== undefined && tree.hasElement(trackedAfter), stillLive: r2 ? [...r2.liveIdentities] : [] },
			{ topLevelCount: 1, tracked: true, stillLive: [workflowRunIdentity(sessionId, runId)] },
		);
	});
});

// --- live-progress content: the ratio-moves-backward honesty rule ------------------------------------------------

suite('Clawdius Claude Code Ultracode Workflows - live-progress honesty', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the started/result ratio can move BACKWARD between renders - never clamped or smoothed', () => {
		const before = describeLiveProgress(liveRun('sess', 'wf_aaaaaaaa-bbb', { startedCount: 2, resultCount: 2, seenCount: 2 }));
		// A new agent starts before any new result lands: resultCount stays put, startedCount (and so seenCount,
		// the union) rises, so the SAME run's ratio genuinely gets worse from one render to the next.
		const after = describeLiveProgress(liveRun('sess', 'wf_aaaaaaaa-bbb', { startedCount: 3, resultCount: 2, seenCount: 3 }));

		assert.deepStrictEqual(
			{
				before: { started: before.startedCount, result: before.resultCount, running: before.runningCount },
				after: { started: after.startedCount, result: after.resultCount, running: after.runningCount },
				ratioChanged: before.ratioCaption !== after.ratioCaption,
			},
			{ before: { started: 2, result: 2, running: 0 }, after: { started: 3, result: 2, running: 1 }, ratioChanged: true },
		);
	});

	test('the running count is never negative even if a read momentarily has more results than starts', () => {
		const content = describeLiveProgress(liveRun('sess', 'wf_aaaaaaaa-bbb', { startedCount: 1, resultCount: 3, seenCount: 3 }));
		assert.strictEqual(content.runningCount, 0);
	});
});
// CLAWDIUS-END
