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

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode, IFileService, IStat } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { ViewContainer } from '../../../../common/views.js';
import { IActivity, IActivityService, IBadge, NumberBadge, WarningBadge } from '../../../../services/activity/common/activity.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import {
	ClaudeWorkflowObservationService, FAILURE_WATERMARK_STORAGE_KEY, IClaudeWorkflowObservationService,
	WORKFLOWS_VIEW_CONTAINER_ID, WorkflowSnapshot,
} from '../../browser/workflows/claudeWorkflowObservationService.js';
import { workflowRunIdentity } from '../../common/claudeWorkflowModel.js';

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
	const FOLDER = URI.file('/work/fixture-proj');
	const SESSION = '5c2af930-2a73-4f6b-9011-72fdfa851624';

	function sessionDir(): URI {
		return URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER), SESSION);
	}

	function makeFs(provider: InMemoryFileSystemProvider = new InMemoryFileSystemProvider()): FileService {
		const fs = store.add(new FileService(new NullLogService()));
		store.add(fs.registerProvider(Schemas.file, store.add(provider)));
		return fs;
	}

	function makeService(fs: IFileService, storageService: IStorageService, activityService: IActivityService): ClaudeWorkflowObservationService {
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IFileService, fs);
		instantiationService.stub(IWorkspaceContextService, new TestContextService(testWorkspace(FOLDER)));
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

	async function stageManifest(fs: IFileService, runId: string, manifest: object): Promise<void> {
		const dir = URI.joinPath(sessionDir(), 'workflows');
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, `${runId}.json`), VSBuffer.fromString(JSON.stringify(manifest)));
	}

	async function stageJournal(fs: IFileService, runId: string, lines: readonly object[]): Promise<void> {
		const dir = URI.joinPath(sessionDir(), 'subagents', 'workflows', runId);
		await fs.createFolder(dir);
		const text = lines.map(l => JSON.stringify(l) + '\n').join('');
		await fs.writeFile(URI.joinPath(dir, 'journal.jsonl'), VSBuffer.fromString(text));
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
});
// CLAWDIUS-END
