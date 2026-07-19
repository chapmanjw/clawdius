/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - observation service (live watch + coalesced snapshot + awareness)
// A delayed workbench singleton that is the single source of truth for the CURRENT enumerated workflow state. It
// watches the resolved config root's `projects` tree, coalesces bursts of file activity, and re-runs the SAME
// enumeration the Workflows view read directly before this change (`ClawdiusReaderSeamService.listWorkflows`),
// emitting one immutable snapshot per coalesced refresh. The Workflows view no longer reads the seam itself for
// its primary data path - it binds to `onDidChangeSnapshot` / `snapshot` instead (see `claudeWorkflowsView.ts`).
//
// Root reconciliation is intentionally NOT reimplemented here: the reader seam's own manifest-first enumeration
// (`claudeReaderSeamService.ts`'s `enumerateWorkflows`) already resolves, per run, whether a VALID manifest exists
// (terminal authority) or the run is still represented by its journal (live) - an unparseable ("torn") manifest
// file is simply absent from the manifest set there, so the run falls through to its journal and stays `live`;
// it never creates a terminal sibling row. Because every refresh here re-runs that SAME whole-corpus read, the
// result is already a race-safe, internally-consistent reconciliation across every `(sessionId, runId)` in one
// pass - there is no separate manifest-changed / journal-changed code path that could observably disagree.
//
// Awareness: a persisted failure watermark (a versioned identity SET, `IStorageService` at
// `StorageScope.PROFILE`/`StorageTarget.MACHINE` - the config root is machine-local and profile-global, never
// workspace-scoped) plus a container activity-bar badge fed from it. On the first `ok` enumeration with no stored
// watermark, every currently-failed run is baselined into "seen" WITHOUT badging (no cold-start alarm over
// pre-existing history); after that, `unseenFailures` is the failed identities not yet in the seen set.
// `markFailuresSeen()` (called by the view on focus/visibility) adds the currently-known failures to the seen set
// and clears the badge. A `partial`/`read-error` read never advances the watermark and never touches the badge -
// only an `ok` read participates, so a degraded read can neither manufacture nor hide a failure indicator. The
// badge itself prioritizes a live-run count (`NumberBadge`) over an unseen-failure indicator (`WarningBadge`) -
// live activity is more actionable than a failure the developer has not yet looked at.

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileChangesEvent, IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { localize } from '../../../../../nls.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IActivityService, NumberBadge, WarningBadge } from '../../../../services/activity/common/activity.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import { FailureWatermark, WorkflowRun, WorkflowRunListResult } from '../../common/claudeWorkflowModel.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';

/** Coalesces a burst of workflow-file activity (a manifest write followed immediately by its journal's last
 *  append, several agents landing at once, ...) into ONE re-read, mirroring `ClawdiusConfigStore`'s own
 *  watch-then-debounce pattern for the sibling config surface. */
const COALESCE_DELAY_MS = 250;

/** One immutable snapshot of the enumerated workflow state, emitted once per coalesced refresh. */
export interface WorkflowSnapshot {
	/** The reader seam's own root envelope - ok / partial / read-error, never re-labeled here. */
	readonly result: WorkflowRunListResult;
	/** How many enumerated runs currently carry `kind: 'live'`. */
	readonly liveCount: number;
	/** Failed run identities not yet in the persisted "seen" watermark (see
	 *  {@link IClaudeWorkflowObservationService.markFailuresSeen}). Computed only from an `ok` read; a
	 *  `partial`/`read-error` read carries the previous value forward unchanged rather than deriving awareness
	 *  from data that might not reflect the real failed set. */
	readonly unseenFailures: readonly string[];
}

const EMPTY_SNAPSHOT: WorkflowSnapshot = { result: { state: 'ok', runs: [] }, liveCount: 0, unseenFailures: [] };

/** The persisted failure-watermark storage key - a versioned SET (see {@link FailureWatermark}) of failure
 *  identities the developer has already seen, at `StorageScope.PROFILE`/`StorageTarget.MACHINE` (the Claude
 *  config root is machine-local and global across workspaces within a profile, never workspace-scoped). */
export const FAILURE_WATERMARK_STORAGE_KEY = 'clawdius.ultracodeWorkflows.failureWatermark.v1';

// PRESERVED for backward compat: this is the view CONTAINER id VS Code persists (activity-bar placement, pinned
// state, visibility) across restarts. It must NOT change with the rename, or a pre-rename user's pinned
// activity-bar placement/visibility of this container would fail to restore - the same backward-compat rationale
// as the transcript editor-input-serializer typeId. Defined HERE (re-exported by `claudeWorkflowsView.ts`) rather
// than the other way around, so this service can target the container's activity badge without an import cycle -
// the view already depends on this module for its snapshot type, never the reverse.
export const WORKFLOWS_VIEW_CONTAINER_ID = 'workbench.view.clawdiusMissions';

export const IClaudeWorkflowObservationService = createDecorator<IClaudeWorkflowObservationService>('claudeWorkflowObservationService');

/** The single source of truth for the current enumerated workflow snapshot; the Workflows view (and the
 *  container's activity-bar badge) binds to this instead of reading the reader seam directly. */
export interface IClaudeWorkflowObservationService {
	readonly _serviceBrand: undefined;
	/** Fires once per coalesced refresh with the new immutable snapshot. */
	readonly onDidChangeSnapshot: Event<WorkflowSnapshot>;
	/** The latest snapshot; `EMPTY_SNAPSHOT`-shaped until the first read resolves. */
	readonly snapshot: WorkflowSnapshot;
	/** Marks every currently-known failure (from the last `ok` read) as seen: adds it to the persisted watermark
	 *  and clears the unseen-failure badge. A no-op before any `ok` read has ever landed - there is nothing
	 *  known-good to mark yet. Called by the view on focus and on becoming visible. */
	markFailuresSeen(): void;
	/** Re-runs the seam's enumeration immediately (bypassing the coalescing delay) - the read-error state's
	 *  "Read again" affordance calls this. A data RE-READ, never a run control. */
	readAgain(): void;
}

/** Whether a changed path is one this service cares about: a workflow manifest (`workflows/<runId>.json`), a run
 *  journal (`subagents/workflows/<runId>/journal.jsonl`), or an agent sidecar (`subagents/workflows/<runId>/
 *  agent-<agentId>.jsonl` / `.meta.json`) - every one of these lives under a `workflows/` path segment with a
 *  `.json`/`.jsonl` extension. Deliberately a LOOSE match (not the exact run/agent-id charset the seam itself
 *  validates): this filter only decides whether a refresh is worth scheduling, so over-matching costs at most one
 *  extra debounced read, while under-matching would silently miss a real update - the read itself is the only
 *  place that needs to be exact. A plain chat transcript (no `workflows/` segment) never matches, so an ordinary
 *  chat session does not churn the watcher. */
function isWorkflowArtifactPath(uri: URI): boolean {
	return /(?:^|\/)workflows\//.test(uri.path) && (uri.path.endsWith('.json') || uri.path.endsWith('.jsonl'));
}

/** Validate-don't-cast: a stored value only counts as a real watermark when it is exactly the versioned shape - a
 *  foreign/corrupt string under this key reads as "nothing stored" (see {@link loadFailureWatermark}) rather than
 *  throwing, or being coerced into an empty-but-present watermark, which would incorrectly skip baselining. */
function isFailureWatermarkShape(value: unknown): value is FailureWatermark {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as { version?: unknown; seen?: unknown };
	return candidate.version === 1 && Array.isArray(candidate.seen) && candidate.seen.every(id => typeof id === 'string');
}

/** Load the persisted failure watermark, distinguishing "never stored" from "stored, possibly empty" - the
 *  distinction the baseline rule in {@link ClaudeWorkflowObservationService.doRefresh} needs (an
 *  empty-but-PRESENT watermark, e.g. after baselining a corpus with zero failures, must never re-baseline). A
 *  corrupt/foreign value at this key reads as "never stored" rather than throwing or trusting data we cannot
 *  validate. */
function loadFailureWatermark(storageService: IStorageService): { readonly present: boolean; readonly seen: ReadonlySet<string> } {
	const raw = storageService.get(FAILURE_WATERMARK_STORAGE_KEY, StorageScope.PROFILE);
	if (raw === undefined) {
		return { present: false, seen: new Set() };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isFailureWatermarkShape(parsed)) {
			return { present: true, seen: new Set(parsed.seen) };
		}
	} catch {
		// Falls through to "never stored" below.
	}
	return { present: false, seen: new Set() };
}

/** The identities of every currently-`failed` terminal run in `runs` - the set the watermark baselines/compares
 *  against. Only a terminal run carries a `status`; a live or unknown-shape run can never be "failed". */
function failedRunIdentities(runs: readonly WorkflowRun[]): readonly string[] {
	const failed: string[] = [];
	for (const run of runs) {
		if (run.kind === 'terminal' && run.status === 'failed') {
			failed.push(run.identity);
		}
	}
	return failed;
}

export class ClaudeWorkflowObservationService extends Disposable implements IClaudeWorkflowObservationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSnapshot = this._register(new Emitter<WorkflowSnapshot>());
	readonly onDidChangeSnapshot: Event<WorkflowSnapshot> = this._onDidChangeSnapshot.event;

	private _snapshot: WorkflowSnapshot = EMPTY_SNAPSHOT;
	get snapshot(): WorkflowSnapshot { return this._snapshot; }

	private readonly seam: ClawdiusReaderSeamService;
	private readonly watchers = this._register(new DisposableStore());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => void this.doRefresh(), COALESCE_DELAY_MS));
	/** Monotonically-increasing refresh generation: a slow older read checks this AFTER awaiting the seam and
	 *  drops its own result if a newer refresh has since started, so it can never overwrite a fresher snapshot. */
	private generation = 0;
	private disposed = false;

	/** The persisted failure watermark's in-memory mirror: every failure identity the developer has already seen.
	 *  Loaded from storage at construction and kept in lockstep with it (see {@link persistWatermark}). */
	private seenFailures: Set<string>;
	/** Whether a watermark has ever been established - either loaded already-present from storage, or established
	 *  by this session's own baseline/mark-seen. `false` is exactly the "no cold-start alarm" trigger below. */
	private hasWatermark: boolean;
	/** The failed identities from the LAST `ok` read, or `undefined` before any `ok` read has ever landed - what
	 *  {@link markFailuresSeen} adds to the seen set. Never populated from a `partial`/`read-error` read: marking
	 *  seen from data that might not reflect the real failed set could silently absorb a failure the developer
	 *  never actually got to see. */
	private lastKnownFailedIdentities: readonly string[] | undefined;
	/** The live-run count from the LAST `ok` read - the live component of the badge is only ever driven from this,
	 *  never from a `partial`/`read-error` snapshot whose `liveCount` reflects a degraded (possibly incomplete or
	 *  zeroed) run set. Lets {@link markFailuresSeen}, which can fire (on view focus/visibility) while the last read
	 *  was degraded, clear the failure indicator without clobbering or fabricating the live badge. */
	private lastOkLiveCount = 0;
	/** Holds the current container activity registration so each update replaces (and disposes) the prior one -
	 *  never more than one badge registered for this container at a time; disposed with the service. */
	private readonly badgeHandle = this._register(new MutableDisposable<IDisposable>());

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@IActivityService private readonly activityService: IActivityService,
	) {
		super();
		// Not a registered singleton; instantiated the same way the view instantiated it before this change (teams
		// probe off) so both consumers read runs through the identical enumeration.
		this.seam = instantiationService.createInstance(ClawdiusReaderSeamService, false);
		const loaded = loadFailureWatermark(this.storageService);
		this.seenFailures = new Set(loaded.seen);
		this.hasWatermark = loaded.present;
		void this.start();
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	private async start(): Promise<void> {
		const home = await this.pathService.userHome();
		if (this.disposed) { return; }
		const root = resolveConfigRoot(undefined, home);
		if (root.kind === 'resolved') {
			this.watch(root.root);
		}
		// Kick the first read immediately (no need to wait out the coalescing delay for the very first snapshot).
		this.refreshScheduler.schedule(0);
	}

	/** `IFileService.watch(<root>/projects, { recursive: true })`, filtered to workflow manifest / journal / agent
	 *  sidecar paths - a burst of matching events schedules ONE coalesced refresh via {@link refreshScheduler}. */
	private watch(root: URI): void {
		const projects = URI.joinPath(root, 'projects');
		try {
			this.watchers.add(this.fileService.watch(projects, { recursive: true, excludes: [] }));
		} catch {
			// Best-effort, mirroring the sibling config watcher: a watch failure (an unsupported provider, a
			// not-yet-existing tree) still leaves `readAgain()` / the initial read working, just without live updates.
		}
		this.watchers.add(this.fileService.onDidFilesChange(e => {
			if (this.isRelevant(e)) { this.refreshScheduler.schedule(); }
		}));
	}

	private isRelevant(e: FileChangesEvent): boolean {
		for (const uri of e.rawAdded) { if (isWorkflowArtifactPath(uri)) { return true; } }
		for (const uri of e.rawUpdated) { if (isWorkflowArtifactPath(uri)) { return true; } }
		for (const uri of e.rawDeleted) { if (isWorkflowArtifactPath(uri)) { return true; } }
		return false;
	}

	readAgain(): void {
		this.refreshScheduler.schedule(0);
	}

	markFailuresSeen(): void {
		if (this.lastKnownFailedIdentities === undefined) {
			// No `ok` read has landed yet - there is nothing known-good to mark seen. Doing nothing here (rather
			// than establishing an empty watermark) leaves the very first `ok` read free to baseline normally.
			return;
		}
		for (const identity of this.lastKnownFailedIdentities) {
			this.seenFailures.add(identity);
		}
		this.hasWatermark = true;
		this.persistWatermark();
		if (this._snapshot.unseenFailures.length > 0) {
			this._snapshot = { ...this._snapshot, unseenFailures: [] };
		}
		// Every known failure is now seen, so the failure component is cleared; the live component is driven from the
		// last `ok` read (never `this._snapshot.liveCount`, which may be a degraded read's count) so a focus during a
		// transient degraded read cannot clear or fabricate the live badge.
		this.updateBadge(this.lastOkLiveCount, []);
	}

	private persistWatermark(): void {
		const watermark: FailureWatermark = { version: 1, seen: [...this.seenFailures] };
		this.storageService.store(FAILURE_WATERMARK_STORAGE_KEY, JSON.stringify(watermark), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	/** Live count wins over a failure indicator - live activity is more actionable than a failure the developer
	 *  has not yet looked at. Below that, an unseen failure gets a warning indicator; with neither, the badge
	 *  clears. Only ever driven from an `ok` read (see {@link doRefresh}) - a degraded read leaves the last-known
	 *  badge exactly as it was. */
	private updateBadge(liveCount: number, unseenFailures: readonly string[]): void {
		if (liveCount > 0) {
			this.badgeHandle.value = this.activityService.showViewContainerActivity(WORKFLOWS_VIEW_CONTAINER_ID, {
				badge: new NumberBadge(liveCount, count => count === 1
					? localize('clawdius.workflows.badge.live.one', "1 Claude Code workflow run is live")
					: localize('clawdius.workflows.badge.live.many', "{0} Claude Code workflow runs are live", count)),
			});
			return;
		}
		if (unseenFailures.length > 0) {
			const count = unseenFailures.length;
			this.badgeHandle.value = this.activityService.showViewContainerActivity(WORKFLOWS_VIEW_CONTAINER_ID, {
				badge: new WarningBadge(() => count === 1
					? localize('clawdius.workflows.badge.unseenFailure.one', "1 Claude Code workflow run failed since you last opened this view")
					: localize('clawdius.workflows.badge.unseenFailure.many', "{0} Claude Code workflow runs failed since you last opened this view", count)),
			});
			return;
		}
		this.badgeHandle.clear();
	}

	private async doRefresh(): Promise<void> {
		const generation = ++this.generation;
		const home = await this.pathService.userHome();
		if (this.disposed) { return; }
		const root = resolveConfigRoot(undefined, home);
		const result = await this.seam.listWorkflows(root);
		// A newer refresh already started while this one was in flight - drop this result rather than overwrite a
		// fresher snapshot with a stale one.
		if (this.disposed || generation !== this.generation) { return; }
		const liveCount = result.state === 'read-error' ? 0 : result.runs.filter(run => run.kind === 'live').length;

		let unseenFailures: readonly string[];
		if (result.state === 'ok') {
			this.lastOkLiveCount = liveCount;
			const failedIdentities = failedRunIdentities(result.runs);
			this.lastKnownFailedIdentities = failedIdentities;
			if (!this.hasWatermark) {
				// Baseline: absorb every currently-failed run as already-seen, WITHOUT badging - the no-cold-start
				// -alarm rule. A fresh install over a pile of old failures must never look like a NEW failure.
				this.seenFailures = new Set(failedIdentities);
				this.hasWatermark = true;
				this.persistWatermark();
				unseenFailures = [];
			} else {
				unseenFailures = failedIdentities.filter(identity => !this.seenFailures.has(identity));
			}
		} else {
			// A `partial`/`read-error` read never advances the watermark and never emits awareness from data that
			// might not reflect the real failed set - the previous (known-good) awareness state carries forward
			// unchanged, so a degraded read can neither manufacture nor hide a failure badge.
			unseenFailures = this._snapshot.unseenFailures;
		}

		this._snapshot = { result, liveCount, unseenFailures };
		this._onDidChangeSnapshot.fire(this._snapshot);
		if (result.state === 'ok') {
			this.updateBadge(liveCount, unseenFailures);
		}
	}
}

/** Forces the delayed {@link IClaudeWorkflowObservationService} singleton to instantiate right after restore, so
 *  it starts watching immediately rather than only once the Workflows view happens to be opened - the same
 *  "inject to activate" idiom used elsewhere for a service that must run before any UI surface asks for it. This
 *  is what lets the awareness badge reflect a live snapshot even when the view has never been opened in this
 *  session. */
export class ClaudeWorkflowObservationActivator implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeWorkflowObservationActivator';
	constructor(@IClaudeWorkflowObservationService _observationService: IClaudeWorkflowObservationService) { }
}
// CLAWDIUS-END
