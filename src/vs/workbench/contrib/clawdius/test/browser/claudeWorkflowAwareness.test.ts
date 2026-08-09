/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - awareness (failure watermark + container badge) tests
// Drives `ClaudeWorkflowObservationService` over a REAL `FileService` + `InMemoryFileSystemProvider` (the same
// real-watcher philosophy as the sibling `claudeWorkflowObservation.test.ts`), a real `TestStorageService`
// (in-memory but the genuine `IStorageService` scope/target machinery, never a hand-rolled key-value stub), and a
// small local RECORDING `IActivityService` fake - the shared `TestActivityService` test util does not record its
// calls, and this suite specifically needs to inspect which badge (if any) is currently showing.
//
// The workspace-SCOPE half of the suite stages runs under TWO `projects/<enc>` dirs - one encoding the open folder,
// one encoding a different project - because that is the only way to tell a badge that respects the scope from one
// that ignores it. Both storage writes it exercises (the scope enum) go through the real `IStorageService`, at the
// same key and scope the Workflows view's own control writes, so the reactivity being proved is the shipped path
// and not a test-only poke at the service.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode, FileType, IFileService, IStat } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { ViewContainer } from '../../../../common/views.js';
import { IActivity, IActivityService, IBadge, NumberBadge, WarningBadge } from '../../../../services/activity/common/activity.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import {
	ClaudeWorkflowObservationService, FAILURE_WATERMARK_STORAGE_KEY, IClaudeWorkflowObservationService,
	WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY, WORKFLOWS_VIEW_CONTAINER_ID, workflowWorkspaceProjectKeys, WorkflowSnapshot,
} from '../../browser/workflows/claudeWorkflowObservationService.js';
import { CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';
import {
	LiveWorkflowRun, matchesWorkflowWorkspaceScope, workflowRunIdentity, WorkflowWorkspaceScope,
} from '../../common/claudeWorkflowModel.js';

/** A recording `IActivityService` fake: tracks every LIVE (not-yet-disposed) `showViewContainerActivity`
 *  registration per container, so a test can read back exactly what the container's badge currently is - the
 *  shared `TestActivityService` test util deliberately does not track this. */
class RecordingActivityService implements IActivityService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeActivity: Event<string | ViewContainer> = Event.None;

	private readonly active = new Map<number, { readonly viewContainerId: string; readonly badge: IBadge }>();
	private nextId = 0;

	showViewContainerActivity(viewContainerId: string, activity: IActivity): IDisposable {
		const id = this.nextId++;
		this.active.set(id, { viewContainerId, badge: activity.badge });
		return toDisposable(() => { this.active.delete(id); });
	}
	getViewContainerActivities(): IActivity[] { return []; }
	showViewActivity(): IDisposable { return Disposable.None; }
	showAccountsActivity(): IDisposable { return Disposable.None; }
	showGlobalActivity(): IDisposable { return Disposable.None; }
	getActivity(): IActivity[] { return []; }

	/** The badge currently showing for `viewContainerId` (not yet disposed/replaced), or `undefined` if none -
	 *  mirrors what the real activity bar would render right now, since the service under test always disposes
	 *  the prior registration (a `MutableDisposable`) before installing a new one or clearing. */
	currentBadge(viewContainerId: string): IBadge | undefined {
		for (const entry of this.active.values()) {
			if (entry.viewContainerId === viewContainerId) { return entry.badge; }
		}
		return undefined;
	}
}

/** A `TestContextService` whose open-folder set can CHANGE, firing the real `onDidChangeWorkspaceFolders` the
 *  workbench fires - what proves the observation service re-badges on a folder add/remove. `TestContextService`
 *  keeps its own folder-change emitter private and never fires it, so the event is re-declared here rather than
 *  reaching into it; `setWorkspace` (which it does expose) still supplies the new folder set. */
class MutableWorkspaceContextService extends TestContextService implements IDisposable {

	private readonly folderChange = new Emitter<IWorkspaceFoldersChangeEvent>();
	override get onDidChangeWorkspaceFolders(): Event<IWorkspaceFoldersChangeEvent> { return this.folderChange.event; }

	/** Swap the open folders and announce it exactly as the workbench does. The event PAYLOAD is intentionally
	 *  empty: the service under test re-derives the whole key set from `getWorkspace()` rather than applying a
	 *  delta, so a faithful added/removed list would prove nothing the swap itself does not. */
	setFolders(folders: readonly URI[]): void {
		this.setWorkspace(testWorkspace(...folders));
		this.folderChange.fire({ added: [], removed: [], changed: [] });
	}

	dispose(): void {
		this.folderChange.dispose();
	}
}

/** An `InMemoryFileSystemProvider` that counts how many times ONE directory was listed. That directory is the
 *  config root's `projects` tree, which every whole-corpus enumeration lists exactly once and first - so the count
 *  is a black-box proxy for "how many enumeration passes have run", measured without reaching into the service's
 *  private state. It is what lets a test assert that a scope or folder change re-badged from the LAST snapshot
 *  rather than by re-walking the disk. */
class ListingCountingFileSystemProvider extends InMemoryFileSystemProvider {

	/** How many times {@link counted} has been listed - i.e. how many enumeration passes have run. */
	listings = 0;

	constructor(private readonly counted: URI) { super(); }

	override async readdir(resource: URI): Promise<[string, FileType][]> {
		if (resource.toString() === this.counted.toString()) { this.listings++; }
		return super.readdir(resource);
	}
}

/** An `InMemoryFileSystemProvider` whose `stat()` fails for exactly one URI with a NON-"file not found" error -
 *  the shape `claudeReaderSeamService.ts`'s `resolveChildDirs` needs to distinguish "exists but unreadable" (a
 *  `read-error`/`partial` root envelope) from "genuinely absent" (an honest empty `ok`). Starts `armed: false` so
 *  building the fixture itself (which may itself `stat()` the failing path, e.g. to check for an existing entry)
 *  never trips the synthetic failure - a test arms it right before constructing the service under test. */
class StatFailingFileSystemProvider extends InMemoryFileSystemProvider {
	armed = false;
	constructor(private readonly failOn: URI) { super(); }
	override async stat(resource: URI): Promise<IStat> {
		if (this.armed && resource.toString() === this.failOn.toString()) {
			throw createFileSystemProviderError('synthetic unreadable path', FileSystemProviderErrorCode.NoPermissions);
		}
		return super.stat(resource);
	}
}

suite('Clawdius Claude Code Ultracode Workflows - awareness (failure watermark + badge)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const HOME = URI.file('/home/tester');
	const ROOT = URI.joinPath(HOME, '.claude');
	const PROJECTS = URI.joinPath(ROOT, 'projects');
	const FOLDER = URI.file('/work/fixture-proj');
	/** A folder that is NEVER open in these fixtures - the "different project directory" half of the scope tests. */
	const OTHER_FOLDER = URI.file('/work/other-proj');
	/** A launch from a SUBDIRECTORY of the open folder: Claude Code records the launching process's cwd, not the
	 *  folder root, so this is the ordinary case the scope's prefix rule exists for. */
	const SUBDIR_OF_FOLDER = URI.joinPath(FOLDER, 'packages', 'api');
	const SESSION = '5c2af930-2a73-4f6b-9011-72fdfa851624';
	const OTHER_SESSION = 'b71e4d38-9c0a-4f21-8e55-1d3f6a204c7b';

	/** The `projects/<enc>/<session>` dir a fixture run is staged under. Defaults to the open folder's own
	 *  encoding, so every pre-existing test in this suite stages exactly where it did before. */
	function sessionDir(folder: URI = FOLDER, session: string = SESSION): URI {
		return URI.joinPath(PROJECTS, encodeProjectDir(folder), session);
	}

	function makeFs(provider: InMemoryFileSystemProvider = new InMemoryFileSystemProvider()): FileService {
		const fs = store.add(new FileService(new NullLogService()));
		store.add(fs.registerProvider(Schemas.file, store.add(provider)));
		return fs;
	}

	function makeService(
		fs: IFileService, storageService: IStorageService, activityService: IActivityService,
		workspaceContextService: IWorkspaceContextService = new TestContextService(testWorkspace(FOLDER)),
	): ClaudeWorkflowObservationService {
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IFileService, fs);
		instantiationService.stub(IWorkspaceContextService, workspaceContextService);
		instantiationService.stub(IPathService, new TestPathService(HOME, HOME.scheme));
		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IActivityService, activityService);
		return store.add(instantiationService.createInstance(ClaudeWorkflowObservationService));
	}

	/** Resolves with the NEXT snapshot the service emits (a one-shot listener, self-disposing on fire). */
	function nextSnapshot(service: IClaudeWorkflowObservationService): Promise<WorkflowSnapshot> {
		return new Promise(resolve => {
			const d = store.add(service.onDidChangeSnapshot(s => { d.dispose(); resolve(s); }));
		});
	}

	async function stageManifest(fs: IFileService, runId: string, manifest: object, session: URI = sessionDir()): Promise<void> {
		const dir = URI.joinPath(session, 'workflows');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `${runId}.json`), VSBuffer.fromString(JSON.stringify(manifest)));
	}

	async function stageJournal(fs: IFileService, runId: string, lines: readonly object[], session: URI = sessionDir()): Promise<void> {
		const dir = URI.joinPath(session, 'subagents', 'workflows', runId);
		await fs.createFolder(dir);
		const text = lines.map(l => JSON.stringify(l) + '\n').join('');
		await fs.writeFile(URI.joinPath(dir, 'journal.jsonl'), VSBuffer.fromString(text));
	}

	/** A manifest-less journal, i.e. a run the seam reports as `kind: 'live'`. */
	function liveJournal(): readonly object[] {
		return [{ type: 'started', agentId: 'a1' }];
	}

	/** The ONE fixture in this suite built in memory rather than staged on disk, for the single case the seam
	 *  cannot produce: a run with NO recorded project dir. Every label is the honest default for a freshly-observed
	 *  live run, matching the sibling fixtures in `claudeWorkflowObservation.test.ts`. */
	function liveFixtureRun(runId: string, projectDirName: string): LiveWorkflowRun {
		return {
			kind: 'live', sessionId: SESSION, runId, identity: workflowRunIdentity(SESSION, runId),
			startedCount: 1, resultCount: 0, seenCount: 1, landedResults: [], journalLastWriteTime: 0,
			ownership: 'foreign', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Live,
			completeness: CompletenessState.Complete, adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
			projectDirName,
		};
	}

	/** The number on the container's `NumberBadge`, or `undefined` when the badge is absent or is not a number
	 *  badge - one accessor so the live-count assertions read as a single value rather than an instanceof dance. */
	function liveBadgeNumber(activity: RecordingActivityService): number | undefined {
		const badge = activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID);
		return badge instanceof NumberBadge ? badge.number : undefined;
	}

	/** How many unseen failures the container's `WarningBadge` is announcing, or `undefined` when the showing badge
	 *  is not a warning badge (including when a live `NumberBadge` outranks it, and when nothing is showing). */
	function failureBadgeCount(activity: RecordingActivityService): number | undefined {
		const badge = activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID);
		if (!(badge instanceof WarningBadge)) { return undefined; }
		// The count is not exposed on `WarningBadge`; its localized description is the only place it survives, and
		// the two message forms differ only in the leading count.
		const match = /^(?<count>\d+) Claude Code workflow runs? failed/.exec(badge.getDescription());
		return match?.groups ? Number(match.groups.count) : undefined;
	}

	/** Persist a workspace scope exactly as the Workflows view's scope control does - the same key, scope and
	 *  target - so what the tests exercise is the shipped write path, not a private poke at the service. */
	function storeWorkspaceScope(storageService: IStorageService, scope: WorkflowWorkspaceScope): void {
		storageService.store(WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY, scope, StorageScope.WORKSPACE, StorageTarget.USER);
	}

	function failedManifest(): object {
		return { workflowName: 'audit', status: 'failed', workflowProgress: [] };
	}

	/** Construct a service over an EMPTY corpus (its first read baselines nothing, since nothing is staged yet),
	 *  then stage one new `failed` run and re-read - the run did not exist at baseline time, so it comes back as a
	 *  genuinely NEW unseen failure. Shared by every test below that needs exactly that starting state. */
	async function makeServiceWithFreshUnseenFailure(
		storageService: IStorageService, activityService: IActivityService, runId: string,
	): Promise<{ readonly service: ClaudeWorkflowObservationService; readonly fs: IFileService; readonly failedIdentity: string }> {
		const fs = makeFs();
		const service = makeService(fs, storageService, activityService);
		await nextSnapshot(service);

		const next = nextSnapshot(service);
		await stageManifest(fs, runId, failedManifest());
		service.readAgain();
		await next;

		return { service, fs, failedIdentity: workflowRunIdentity(SESSION, runId) };
	}

	test('cold start over a pre-existing failure shows no badge - the baseline absorbs it silently', async () => {
		const fs = makeFs();
		await stageManifest(fs, 'wf_oldfail-a', failedManifest());
		const activity = new RecordingActivityService();
		const service = makeService(fs, store.add(new TestStorageService()), activity);

		const snapshot = await nextSnapshot(service);

		assert.strictEqual(snapshot.result.state, 'ok');
		assert.deepStrictEqual(snapshot.unseenFailures, []);
		assert.strictEqual(activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID), undefined);
	});

	test('a newly-observed failure (not in the watermark) raises an unseen-failure badge', async () => {
		const activity = new RecordingActivityService();
		const { service, failedIdentity } = await makeServiceWithFreshUnseenFailure(store.add(new TestStorageService()), activity, 'wf_newfail-a');

		assert.deepStrictEqual([...service.snapshot.unseenFailures], [failedIdentity]);
		const badge = activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID);
		assert.ok(badge instanceof WarningBadge, `expected a WarningBadge, got ${badge?.constructor.name}`);
		assert.strictEqual(badge.getDescription(), '1 Claude Code workflow run failed since you last opened this view');
	});

	test('markFailuresSeen() clears the badge and writes the failure identity THROUGH to storage', async () => {
		const activity = new RecordingActivityService();
		const storageService = store.add(new TestStorageService());
		const { service, failedIdentity } = await makeServiceWithFreshUnseenFailure(storageService, activity, 'wf_newfail-b');
		assert.ok(activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID) instanceof WarningBadge);

		service.markFailuresSeen();

		assert.deepStrictEqual(service.snapshot.unseenFailures, []);
		assert.strictEqual(activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID), undefined);
		// Assert the STORED value directly, not merely the in-memory snapshot - a persistence regression (a no-op
		// write) would leave the snapshot correct but this assertion would fail.
		const stored = storageService.get(FAILURE_WATERMARK_STORAGE_KEY, StorageScope.PROFILE);
		assert.deepStrictEqual(stored ? JSON.parse(stored) : undefined, { version: 1, seen: [failedIdentity] });
	});

	test('a restart (a new service over the same storage) keeps a seen failure quiet but STILL alarms for a new one - distinguishing a persisted watermark from a re-baseline', async () => {
		const shared = store.add(new TestStorageService());
		const { service, fs, failedIdentity: seenIdentity } = await makeServiceWithFreshUnseenFailure(shared, new RecordingActivityService(), 'wf_newfail-c');
		service.markFailuresSeen();
		assert.deepStrictEqual(service.snapshot.unseenFailures, []);

		// Stage a SECOND failure, present on disk BEFORE the restart's first read. The restart is a new service over
		// the SAME storage (the persisted watermark) and the SAME fs (both failed runs on disk). This is what makes
		// the test distinguishing: a bare "still no badge" check would pass even if the watermark were LOST, because
		// a lost watermark would cold-start-baseline BOTH failures into "seen" and also show nothing. Because the
		// watermark actually persisted, the seen failure stays quiet and ONLY the new one is unseen.
		await stageManifest(fs, 'wf_newfail-c2', failedManifest());
		const newIdentity = workflowRunIdentity(SESSION, 'wf_newfail-c2');

		const restartedActivity = new RecordingActivityService();
		const restarted = makeService(fs, shared, restartedActivity);
		const snapshot = await nextSnapshot(restarted);

		assert.strictEqual(snapshot.result.state, 'ok');
		assert.deepStrictEqual([...snapshot.unseenFailures], [newIdentity]);
		assert.ok(![...snapshot.unseenFailures].includes(seenIdentity), 'the already-seen failure must not re-alarm after a restart');
		const badge = restartedActivity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID);
		assert.ok(badge instanceof WarningBadge, `expected a WarningBadge on restart for the new failure, got ${badge?.constructor.name}`);
	});

	test('a live run\'s NumberBadge wins over an unseen-failure badge', async () => {
		const activity = new RecordingActivityService();
		const { service, fs } = await makeServiceWithFreshUnseenFailure(store.add(new TestStorageService()), activity, 'wf_newfail-d');
		assert.ok(activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID) instanceof WarningBadge); // sanity: the failure badge is showing beforehand

		const next = nextSnapshot(service);
		await stageJournal(fs, 'wf_live-a', [{ type: 'started', agentId: 'a1' }]);
		service.readAgain();
		const snapshot = await next;

		assert.strictEqual(snapshot.liveCount, 1);
		assert.strictEqual(snapshot.unseenFailures.length, 1); // the failure is still unseen underneath - only the badge choice changes
		const badge = activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID);
		assert.ok(badge instanceof NumberBadge, `expected a NumberBadge, got ${badge?.constructor.name}`);
		assert.strictEqual(badge.number, 1);
	});

	test('a read-error read never advances the watermark or emits awareness from the bad read', async () => {
		const shared = store.add(new TestStorageService());
		const badProvider = new StatFailingFileSystemProvider(URI.joinPath(ROOT, 'projects'));
		badProvider.armed = true; // nothing is staged in this fs, so arming immediately is safe
		const badFs = makeFs(badProvider);
		const badService = makeService(badFs, shared, new RecordingActivityService());
		const badSnapshot = await nextSnapshot(badService);

		assert.strictEqual(badSnapshot.result.state, 'read-error');
		assert.deepStrictEqual(badSnapshot.unseenFailures, []); // carried forward from the empty starting default, never fabricated

		// The SAME storage, now read by a service over a REAL corpus with one failed run: if the read-error above
		// had wrongly established a watermark, this run would come back as an immediate (wrong) unseen failure
		// instead of being silently baselined - proving the bad read above never touched the watermark.
		const goodFs = makeFs();
		await stageManifest(goodFs, 'wf_readerr-a', failedManifest());
		const goodActivity = new RecordingActivityService();
		const goodService = makeService(goodFs, shared, goodActivity);
		const goodSnapshot = await nextSnapshot(goodService);

		assert.strictEqual(goodSnapshot.result.state, 'ok');
		assert.deepStrictEqual(goodSnapshot.unseenFailures, []);
		assert.strictEqual(goodActivity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID), undefined);
	});

	test('a partial read never advances the watermark or emits awareness from the bad read', async () => {
		const badProjectDir = URI.joinPath(ROOT, 'projects', 'unreadable-project');
		const provider = new StatFailingFileSystemProvider(badProjectDir);
		const fs = makeFs(provider);
		// The unreadable project dir must exist as a listed CHILD of `projects/` for its OWN stat to be attempted
		// (and fail) - only that exact path is intercepted, never `projects/` itself, so the top-level walk still
		// succeeds and degrades to `partial` rather than failing outright as `read-error`. Staged before arming so
		// creating it does not itself trip the synthetic failure.
		await fs.createFolder(badProjectDir);
		await stageManifest(fs, 'wf_partial-a', failedManifest());
		provider.armed = true;

		const shared = store.add(new TestStorageService());
		const activity = new RecordingActivityService();
		const service = makeService(fs, shared, activity);
		const snapshot = await nextSnapshot(service);

		assert.strictEqual(snapshot.result.state, 'partial');
		assert.deepStrictEqual(snapshot.unseenFailures, []); // carried forward, never derived from this degraded read
		assert.strictEqual(activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID), undefined);

		// The SAME storage, re-read once the unreadable project is gone: the real failed run must still baseline
		// silently on this now-genuine first OK read - proving the partial read above never consumed that baseline.
		const fs2 = makeFs();
		await stageManifest(fs2, 'wf_partial-a', failedManifest());
		const activity2 = new RecordingActivityService();
		const service2 = makeService(fs2, shared, activity2);
		const snapshot2 = await nextSnapshot(service2);

		assert.strictEqual(snapshot2.result.state, 'ok');
		assert.deepStrictEqual(snapshot2.unseenFailures, []);
		assert.strictEqual(activity2.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID), undefined);
	});

	// --- the badge respects the workspace scope --------------------------------------------------------------------
	//
	// The defect these cover: with the default "This Workspace" scope the pane could correctly report that no runs
	// were recorded under an open folder while the badge simultaneously advertised live runs from other projects.
	// Every test below stages the same corpus under two `projects/<enc>` dirs - one the open folder's, one not - and
	// asserts on the BADGE, which is the surface that was lying.

	test('the live badge counts ONLY the in-scope live runs, while the snapshot keeps publishing the whole enumeration', async () => {
		const activity = new RecordingActivityService();
		const fs = makeFs();
		await stageJournal(fs, 'wf_live-mine', liveJournal());
		await stageJournal(fs, 'wf_live-theirs-a', liveJournal(), sessionDir(OTHER_FOLDER, OTHER_SESSION));
		await stageJournal(fs, 'wf_live-theirs-b', liveJournal(), sessionDir(OTHER_FOLDER, OTHER_SESSION));
		const service = makeService(fs, store.add(new TestStorageService()), activity);

		const snapshot = await nextSnapshot(service);

		// The two halves of the honesty rule in one assertion: `liveCount` still means "how many ENUMERATED runs are
		// live" (scoping it would make the published snapshot describe a run set it did not publish), and the badge -
		// the only workspace-relative surface - counts just the one run under the open folder.
		assert.deepStrictEqual(
			{ enumeratedLiveCount: snapshot.liveCount, badge: liveBadgeNumber(activity) },
			{ enumeratedLiveCount: 3, badge: 1 });
	});

	test('a run launched from a SUBDIRECTORY of the open folder still counts toward the badge; one from a different project does not', async () => {
		const activity = new RecordingActivityService();
		const fs = makeFs();
		await stageJournal(fs, 'wf_live-root', liveJournal());
		await stageJournal(fs, 'wf_live-subdir', liveJournal(), sessionDir(SUBDIR_OF_FOLDER, OTHER_SESSION));
		await stageJournal(fs, 'wf_live-theirs', liveJournal(), sessionDir(OTHER_FOLDER, OTHER_SESSION));
		const service = makeService(fs, store.add(new TestStorageService()), activity);

		await nextSnapshot(service);

		// The badge inherits the scope predicate's prefix rule whole - the badge must not be stricter than the list
		// it sits above, or a developer who ran `claude` from a package directory would see their own live run
		// counted in the pane and missing from the badge.
		assert.strictEqual(liveBadgeNumber(activity), 2);
	});

	test('an unattributable run - one whose project dir the seam never recorded - is never hidden from the badge', () => {
		// Deliberately NOT staged on disk: the seam derives `projectDirName` from the BASENAME of a real
		// `projects/<enc>` directory, which is never empty, so this case is unreachable through the file fixture.
		// What IS assertable is that the badge applies the shared predicate to the key set the service itself
		// derives - the two inputs the badge computation is built from - so the widening cannot be lost.
		const workspaceKeys = workflowWorkspaceProjectKeys(new TestContextService(testWorkspace(FOLDER)));
		assert.deepStrictEqual({
			unattributable: matchesWorkflowWorkspaceScope(
				liveFixtureRun('wf_unattributed', ''), WorkflowWorkspaceScope.ThisWorkspace, workspaceKeys),
			elsewhere: matchesWorkflowWorkspaceScope(
				liveFixtureRun('wf_elsewhere', encodeProjectDir(OTHER_FOLDER)), WorkflowWorkspaceScope.ThisWorkspace, workspaceKeys),
		}, { unattributable: true, elsewhere: false });
	});

	test('with NO folder open the scope withholds nothing - the SAME corpus that badges 1 with a folder open badges every run', async () => {
		const fs = makeFs();
		await stageJournal(fs, 'wf_live-mine', liveJournal());
		await stageJournal(fs, 'wf_live-theirs', liveJournal(), sessionDir(OTHER_FOLDER, OTHER_SESSION));

		const scopedActivity = new RecordingActivityService();
		const scoped = makeService(fs, store.add(new TestStorageService()), scopedActivity);
		await nextSnapshot(scoped);

		// Same corpus, same (default) stored scope - only the folder set differs. With nothing to scope AGAINST the
		// effective scope is All Workspaces, exactly as `matchesWorkflowWorkspaceScope` documents: a filter must
		// never delete what there is no basis to narrow.
		const unscopedActivity = new RecordingActivityService();
		const unscoped = makeService(fs, store.add(new TestStorageService()), unscopedActivity, new TestContextService(testWorkspace()));
		await nextSnapshot(unscoped);

		assert.deepStrictEqual(
			{ withFolderOpen: liveBadgeNumber(scopedActivity), withNoFolderOpen: liveBadgeNumber(unscopedActivity) },
			{ withFolderOpen: 1, withNoFolderOpen: 2 });
	});

	test('flipping the persisted scope to All Workspaces re-badges from the last snapshot, with NO re-read of the corpus', async () => {
		const activity = new RecordingActivityService();
		const provider = new ListingCountingFileSystemProvider(PROJECTS);
		const fs = makeFs(provider);
		await stageJournal(fs, 'wf_live-mine', liveJournal());
		await stageJournal(fs, 'wf_live-theirs', liveJournal(), sessionDir(OTHER_FOLDER, OTHER_SESSION));
		const storageService = store.add(new TestStorageService());
		const service = makeService(fs, storageService, activity);
		await nextSnapshot(service);
		const listingsAfterRead = provider.listings;
		assert.strictEqual(liveBadgeNumber(activity), 1);

		// The shipped write path: the view's scope control stores exactly this. Nothing on disk changed, so a badge
		// that re-walked the corpus here would be paying a whole-corpus read for data it already holds - and the
		// service must react with the view never having been constructed at all.
		storeWorkspaceScope(storageService, WorkflowWorkspaceScope.AllWorkspaces);

		assert.deepStrictEqual(
			{ badge: liveBadgeNumber(activity), listings: provider.listings },
			{ badge: 2, listings: listingsAfterRead });
	});

	test('opening a second folder re-badges from the last snapshot, with NO re-read of the corpus', async () => {
		const activity = new RecordingActivityService();
		const provider = new ListingCountingFileSystemProvider(PROJECTS);
		const fs = makeFs(provider);
		await stageJournal(fs, 'wf_live-mine', liveJournal());
		await stageJournal(fs, 'wf_live-theirs', liveJournal(), sessionDir(OTHER_FOLDER, OTHER_SESSION));
		const workspaceContextService = store.add(new MutableWorkspaceContextService(testWorkspace(FOLDER)));
		const service = makeService(fs, store.add(new TestStorageService()), activity, workspaceContextService);
		await nextSnapshot(service);
		const listingsAfterRead = provider.listings;
		assert.strictEqual(liveBadgeNumber(activity), 1);

		// The scope enum did not change - the folder set it resolves against did, which moves the same predicate's
		// answer for every run. No file changed, so again no re-read.
		workspaceContextService.setFolders([FOLDER, OTHER_FOLDER]);

		assert.deepStrictEqual(
			{ badge: liveBadgeNumber(activity), listings: provider.listings },
			{ badge: 2, listings: listingsAfterRead });
	});

	test('the unseen-failure badge is workspace-scoped: a failure in a different project raises no badge until the scope widens', async () => {
		const activity = new RecordingActivityService();
		const storageService = store.add(new TestStorageService());
		const fs = makeFs();
		const service = makeService(fs, storageService, activity);
		await nextSnapshot(service); // an empty corpus, so the cold-start baseline absorbs nothing

		const next = nextSnapshot(service);
		await stageManifest(fs, 'wf_fail-theirs', failedManifest(), sessionDir(OTHER_FOLDER, OTHER_SESSION));
		service.readAgain();
		const snapshot = await next;

		const theirs = workflowRunIdentity(OTHER_SESSION, 'wf_fail-theirs');
		// The failure is genuinely unseen (the SNAPSHOT says so, unscoped - a failure the scope hides is still a
		// failure nobody has looked at); it is the BADGE that stays silent, because the pane it sits above would
		// not list that run either.
		assert.deepStrictEqual(
			{ unseen: [...snapshot.unseenFailures], badge: activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID) },
			{ unseen: [theirs], badge: undefined });

		storeWorkspaceScope(storageService, WorkflowWorkspaceScope.AllWorkspaces);

		assert.strictEqual(failureBadgeCount(activity), 1);
	});

	test('markFailuresSeen() marks ONLY the in-scope failures - an out-of-scope failure is never silently absorbed, and still alarms once the scope widens', async () => {
		const activity = new RecordingActivityService();
		const storageService = store.add(new TestStorageService());
		const fs = makeFs();
		const service = makeService(fs, storageService, activity);
		await nextSnapshot(service);

		const next = nextSnapshot(service);
		await stageManifest(fs, 'wf_fail-mine', failedManifest());
		await stageManifest(fs, 'wf_fail-theirs', failedManifest(), sessionDir(OTHER_FOLDER, OTHER_SESSION));
		service.readAgain();
		await next;

		const mine = workflowRunIdentity(SESSION, 'wf_fail-mine');
		const theirs = workflowRunIdentity(OTHER_SESSION, 'wf_fail-theirs');
		assert.strictEqual(failureBadgeCount(activity), 1); // only the in-scope failure was ever shown

		service.markFailuresSeen();

		// THE awareness rule: the watermark means "already surfaced to you", and the badge is the surfacing. Marking
		// every KNOWN failure seen here would write `theirs` into the watermark having never badged it once - and
		// widening the scope afterwards would then show nothing for a failure nobody was ever told about.
		const stored = storageService.get(FAILURE_WATERMARK_STORAGE_KEY, StorageScope.PROFILE);
		assert.deepStrictEqual({
			watermark: stored ? JSON.parse(stored) : undefined,
			badge: activity.currentBadge(WORKFLOWS_VIEW_CONTAINER_ID),
			stillUnseen: [...service.snapshot.unseenFailures],
		}, {
			watermark: { version: 1, seen: [mine] },
			badge: undefined,
			stillUnseen: [theirs],
		});

		storeWorkspaceScope(storageService, WorkflowWorkspaceScope.AllWorkspaces);

		assert.strictEqual(failureBadgeCount(activity), 1);
	});
});
// CLAWDIUS-END
