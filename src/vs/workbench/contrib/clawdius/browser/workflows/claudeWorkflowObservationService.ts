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
// Cost control, and the reason this file reads the way it does. A refresh here is a WHOLE-CORPUS read - every
// manifest and every journal under every project dir - so two invariants hold it in check, both of them load-
// bearing rather than tidiness. FIRST, at most ONE enumeration exists at a time, with at most one rerun queued
// behind it (`refreshInFlight` / `rerunRequested`): `RunOnceScheduler` only cancel-and-rearms a TIMER and knows
// nothing about an async runner, so without the guard every quiet gap during a pass started another whole-corpus
// read on top of the one still running, and on a large corpus the passes diverged instead of plateauing until the
// renderer ran out of heap. SECOND, a superseded pass is CANCELLED rather than left to allocate its way to a
// result nobody will read - bounded by an alternation rule (`previousPassCancelled`) so a continuously-writing
// workflow can never cancel every pass and freeze the snapshot this service exists to publish.
//
// Awareness: a persisted failure watermark (a versioned identity SET, `IStorageService` at
// `StorageScope.PROFILE`/`StorageTarget.MACHINE` - the config root is machine-local and profile-global, never
// workspace-scoped) plus a container activity-bar badge fed from it. On the first `ok` enumeration with no stored
// watermark, every currently-failed run is baselined into "seen" WITHOUT badging (no cold-start alarm over
// pre-existing history); after that, `unseenFailures` is the failed identities not yet in the seen set.
// `markFailuresSeen()` (called by the view on focus/visibility) adds the currently-known IN-SCOPE failures to the
// seen set and clears the badge. A `partial`/`read-error` read never advances the watermark and never touches the
// badge - only an `ok` read participates, so a degraded read can neither manufacture nor hide a failure indicator.
// The badge itself prioritizes a live-run count (`NumberBadge`) over an unseen-failure indicator (`WarningBadge`) -
// live activity is more actionable than a failure the developer has not yet looked at.
//
// The badge is WORKSPACE-SCOPED, by the same `matchesWorkflowWorkspaceScope` predicate and the same persisted scope
// the Workflows pane filters its list with. Unscoped, the badge advertised live runs from other projects while the
// pane - defaulting to This Workspace - correctly said "no workflow runs were recorded under an open folder": the
// badge and the list disagreed about what was being observed. Three consequences worth stating outright:
//   - Only the WORKSPACE scope is applied. The pane's status and text filters deliberately are NOT: the badge is an
//     activity signal, so narrowing the list to "Failed" must not hide that a run is going right now, and the text
//     query is session-only view state this service cannot read anyway.
//   - `WorkflowSnapshot.liveCount` keeps its published meaning (how many ENUMERATED runs are live) and is NOT
//     re-defined as a scoped count. Scoping happens at badge computation; the snapshot never lies about the read.
//   - `markFailuresSeen()` marks only the IN-SCOPE failures. Marking every known failure while badging only the
//     in-scope ones would let an out-of-scope failure be absorbed into the watermark having never been surfaced -
//     the developer would widen to All Workspaces later and find no badge for a failure nobody ever showed them.
//     The watermark means "already surfaced to you", and the badge is the surfacing.
// Because the scope and the folder set can both change with no file changing, the badge is recomputed from the LAST
// `ok` read on `IStorageService.onDidChangeValue` and `onDidChangeWorkspaceFolders` - never by re-walking the disk,
// and never through the view, which may never have been opened at all (see `ClaudeWorkflowObservationActivator`).

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { extUriIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileChangesEvent, IFileService, isFileSystemWatcher, IWatchOptionsWithCorrelation } from '../../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../../nls.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IActivityService, NumberBadge, WarningBadge } from '../../../../services/activity/common/activity.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import {
	DEFAULT_WORKFLOW_WORKSPACE_SCOPE, FailureWatermark, isWorkflowWorkspaceScope, matchesWorkflowWorkspaceScope,
	TerminalWorkflowRun, WorkflowRun, WorkflowRunListResult, WorkflowWorkspaceScope,
} from '../../common/claudeWorkflowModel.js';
import { encodeProjectDir } from '../clawdiusConfigStore.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';

/** Coalesces a burst of workflow-file activity (a manifest write followed immediately by its journal's last
 *  append, several agents landing at once, ...) into ONE re-read, mirroring `ClawdiusConfigStore`'s own
 *  watch-then-debounce pattern for the sibling config surface. */
const COALESCE_DELAY_MS = 250;

/** Correlation ids for this service's own recursive watch request, allocated DOWNWARDS FROM -1 so they can never
 *  collide with one `FileService.createWatcher` minted. That allocator (`FileService.WATCHER_CORRELATION_IDS`)
 *  starts at 0 and only ever increments, and it is the only other minter of correlation ids in the product, so
 *  "negative" is a proof of disjointness rather than a probability argument - which matters, because two watch
 *  requests sharing an id would cross-deliver each other's events and neither would reach the uncorrelated bus.
 *  Nothing downstream constrains the sign: every consumer tests `typeof cId === 'number'` or compares for strict
 *  equality (files.ts `FileChangesEvent`, watcher.ts `isWatchRequestWithCorrelation`, the parcel watcher's own
 *  request key), and `BaseWatcher.computeId` already yields negative ids for uncorrelated requests via `hash()`. */
let nextWatchCorrelationId = -1;

/** One immutable snapshot of the enumerated workflow state, emitted once per coalesced refresh. */
export interface WorkflowSnapshot {
	/** The reader seam's own root envelope - ok / partial / read-error, never re-labeled here. */
	readonly result: WorkflowRunListResult;
	/** How many enumerated runs currently carry `kind: 'live'`. Counted over the WHOLE enumeration in
	 *  {@link result}, deliberately UNSCOPED: this is a fact about the read, and the activity badge's own
	 *  workspace-scoped count is derived separately at badge time (see the file header). Narrowing this field to
	 *  the scoped count would make the published snapshot describe a run set that is not the one it published. */
	readonly liveCount: number;
	/** Failed run identities not yet in the persisted "seen" watermark (see
	 *  {@link IClaudeWorkflowObservationService.markFailuresSeen}). Computed only from an `ok` read; a
	 *  `partial`/`read-error` read carries the previous value forward unchanged rather than deriving awareness
	 *  from data that might not reflect the real failed set. UNSCOPED, for the same reason as {@link liveCount} -
	 *  a failure the workspace scope currently hides is still an unseen failure. */
	readonly unseenFailures: readonly string[];
}

const EMPTY_SNAPSHOT: WorkflowSnapshot = { result: { state: 'ok', runs: [] }, liveCount: 0, unseenFailures: [] };

/** The persisted failure-watermark storage key - a versioned SET (see {@link FailureWatermark}) of failure
 *  identities the developer has already seen, at `StorageScope.PROFILE`/`StorageTarget.MACHINE` (the Claude
 *  config root is machine-local and global across workspaces within a profile, never workspace-scoped). */
export const FAILURE_WATERMARK_STORAGE_KEY = 'clawdius.ultracodeWorkflows.failureWatermark.v1';

/** The persisted workspace scope ({@link WorkflowWorkspaceScope}) - WRITTEN by the Workflows view's scope control,
 *  READ here to scope the container's activity badge to the same runs the pane lists.
 *
 *  `StorageScope.WORKSPACE`/`StorageTarget.USER`, and this one alone among the pane's four persisted settings is
 *  NOT a profile preference: its whole MEANING is "relative to whichever folders this window has open". Stored at
 *  PROFILE, a single "All Workspaces" choice made once in one project would silently widen every other project's
 *  default forever, contradicting the shipped default. The stored value is the abstract enum, never a resolved
 *  folder set, so it stays meaningful in any window. `USER` rather than `MACHINE` because it is an abstract
 *  preference enum that means the same thing on any machine (unlike {@link FAILURE_WATERMARK_STORAGE_KEY}, whose
 *  value is a set of identities of runs on THIS disk).
 *
 *  Defined HERE and imported by `claudeWorkflowsView.ts` - the same placement precedent as
 *  {@link WORKFLOWS_VIEW_CONTAINER_ID}, and for the same reason: the view already depends on this module, so a
 *  storage key the SERVICE reads cannot live in the view without closing an import cycle. (The key is not pure -
 *  it is a fact about persistence, not about the read model - so `common/` is the wrong home for it, unlike the
 *  scope enum and predicate themselves.) */
export const WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY = 'clawdius.ultracodeWorkflows.workspaceScope.v1';

/** The open folders' `projects/<enc>` keys, CASE-FOLDED - what {@link matchesWorkflowWorkspaceScope} compares a
 *  run's `projectDirName` against. Shared by the Workflows view's list derivation and this service's badge
 *  computation rather than written twice, so the pane and the badge can never disagree about what "this workspace"
 *  resolves to.
 *
 *  Recomputed per use rather than cached: the folder set is one to three entries in practice, and a cache is one
 *  missed invalidation away from scoping against folders that are no longer open. */
export function workflowWorkspaceProjectKeys(workspaceContextService: IWorkspaceContextService): ReadonlySet<string> {
	return new Set(workspaceContextService.getWorkspace().folders.map(folder => encodeProjectDir(folder.uri).toLowerCase()));
}

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
	/** Fires once per coalesced refresh with the new immutable snapshot. Not the only thing that moves
	 *  {@link snapshot} - see the seam documented there. */
	readonly onDidChangeSnapshot: Event<WorkflowSnapshot>;
	/**
	 * The latest snapshot; `EMPTY_SNAPSHOT`-shaped until the first read resolves.
	 *
	 * Read it live; do not CACHE it across a call into this service. {@link markFailuresSeen} is a SECOND write path:
	 * it replaces this value with one whose newly-seen failures have been dropped from `unseenFailures`, at the same
	 * moment it clears the badge, and it does not fire {@link onDidChangeSnapshot} - so a held reference goes on
	 * reporting failures the badge has already dropped.
	 *
	 * The silence there is deliberate. That event is what the Workflows view rebuilds its whole tree on, and
	 * `markFailuresSeen` runs on every focus and every visibility change, so firing it would buy a rebuild per focus
	 * to refresh a value no consumer holds: the view seeds from this property once when it binds and re-derives from
	 * the snapshot the event hands it thereafter, calling `markFailuresSeen` only for the badge side effect. A future
	 * consumer that needs to observe the clearing wants a signal of its own, not this one widened.
	 */
	readonly snapshot: WorkflowSnapshot;
	/** Marks the currently-known failures the BADGE could have shown - the failures from the last `ok` read that are
	 *  IN the persisted workspace scope - as seen: adds them to the persisted watermark, clears the unseen-failure
	 *  badge, and replaces {@link snapshot} with one that no longer lists them in `unseenFailures` - without firing
	 *  {@link onDidChangeSnapshot} (see {@link snapshot} for why, and for what a consumer must not do because of it).
	 *
	 *  Scoped, NOT "every known failure", and that asymmetry is the point: the badge is scoped, so marking an
	 *  out-of-scope failure seen would absorb into the watermark a failure that was never surfaced, and widening to
	 *  All Workspaces later would show no badge for it. A no-op before any `ok` read has ever landed - there is
	 *  nothing known-good to mark yet. Called by the view on focus and on becoming visible. */
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

/** Every currently-`failed` terminal run in `runs` - the set the watermark baselines/compares against. Only a
 *  terminal run carries a `status`; a live or unknown-shape run can never be "failed". Returns the RUNS, not just
 *  their identities: the badge also has to ask {@link matchesWorkflowWorkspaceScope} about each one, which reads
 *  the run's `projectDirName`. */
function failedRuns(runs: readonly WorkflowRun[]): readonly TerminalWorkflowRun[] {
	return runs.filter((run): run is TerminalWorkflowRun => run.kind === 'terminal' && run.status === 'failed');
}

/** Everything the activity badge is allowed to be computed from: the live and failed runs of the LAST `ok`
 *  enumeration. Held apart from {@link ClaudeWorkflowObservationService.snapshot} because that snapshot is replaced
 *  by degraded reads too, and the badge doctrine is that only an `ok` read may move it - and because a workspace
 *  scope or folder-set change has to recompute the badge from the last known-good runs with NO disk re-read. */
interface IBadgeInputs {
	readonly live: readonly WorkflowRun[];
	readonly failed: readonly TerminalWorkflowRun[];
}

export class ClaudeWorkflowObservationService extends Disposable implements IClaudeWorkflowObservationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSnapshot = this._register(new Emitter<WorkflowSnapshot>());
	readonly onDidChangeSnapshot: Event<WorkflowSnapshot> = this._onDidChangeSnapshot.event;

	private _snapshot: WorkflowSnapshot = EMPTY_SNAPSHOT;
	get snapshot(): WorkflowSnapshot { return this._snapshot; }

	private readonly seam: ClawdiusReaderSeamService;
	private readonly watchers = this._register(new DisposableStore());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => void this.requestRefresh(), COALESCE_DELAY_MS));
	/** The `projects` tree this service watches, once the config root has resolved - the containment half of
	 *  {@link isRelevant}. Undefined until then, which is also the honest answer for an unresolvable root. */
	private projectsRoot: URI | undefined;
	/** The in-flight enumeration pass, or undefined when none is running. THE concurrency invariant: at most ONE
	 *  pass exists at a time, and {@link rerunRequested} queues at most one more behind it. Copied from the shape
	 *  the sibling `ClawdiusConfigStore.refresh` already uses - without it, `RunOnceScheduler.schedule()` only
	 *  cancel-and-rearms a TIMER and knows nothing about an async runner, so every quiet gap during a pass started
	 *  ANOTHER whole-corpus read on top of the one still running and the passes diverged instead of plateauing. */
	private refreshInFlight: Promise<void> | undefined;
	/** Set when a refresh is requested while a pass is running, so the loop runs exactly one more pass afterwards.
	 *  A boolean, not a counter, on purpose: N requests during one pass collapse into ONE rerun (they would all
	 *  read the same tree), and the single re-run guarantees a change landing mid-pass is never lost. */
	private rerunRequested = false;
	/** The in-flight pass's cancellation source, or undefined between passes - what lets a superseded pass stop
	 *  reading instead of allocating its way to a result nobody will use. */
	private passCancellation: CancellationTokenSource | undefined;
	/** Whether the pass that just ran was cancelled. THE anti-starvation invariant: a pass may only be cancelled
	 *  when the previous one ran to completion, so two cancellations can never be adjacent. Without it, a workflow
	 *  that writes with a quiet gap shorter than one pass would cancel every pass forever and the snapshot - the
	 *  entire point of this service - would never advance during exactly the activity it exists to show. The cost
	 *  of the bound is that a sustained storm settles at half rate rather than never. */
	private previousPassCancelled = false;
	private disposed = false;

	/** The persisted failure watermark's in-memory mirror: every failure identity the developer has already seen.
	 *  Loaded from storage at construction and kept in lockstep with it (see {@link persistWatermark}). */
	private seenFailures: Set<string>;
	/** Whether a watermark has ever been established - either loaded already-present from storage, or established
	 *  by this session's own baseline/mark-seen. `false` is exactly the "no cold-start alarm" trigger below. */
	private hasWatermark: boolean;
	/** The live + failed runs from the LAST `ok` read, or `undefined` before any `ok` read has ever landed (which is
	 *  also exactly what makes {@link markFailuresSeen} a no-op until then). The badge is only ever driven from
	 *  this, never from a `partial`/`read-error` snapshot whose run set may be incomplete or zeroed - so a focus, a
	 *  scope change or a folder change arriving while the last read was degraded recomputes from the last
	 *  known-good runs instead of clobbering or fabricating a badge. */
	private lastOkBadgeInputs: IBadgeInputs | undefined;
	/** Holds the current container activity registration so each update replaces (and disposes) the prior one -
	 *  never more than one badge registered for this container at a time; disposed with the service. */
	private readonly badgeHandle = this._register(new MutableDisposable<IDisposable>());

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@IActivityService private readonly activityService: IActivityService,
		// APPENDED at the end of the decorated list, deliberately: VS Code's DI records dependency indices
		// POSITIONALLY, so inserting a service mid-list would misbind every parameter after it.
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		// Not a registered singleton; instantiated the same way the view instantiated it before this change (teams
		// probe off) so both consumers read runs through the identical enumeration.
		this.seam = instantiationService.createInstance(ClawdiusReaderSeamService, false);
		const loaded = loadFailureWatermark(this.storageService);
		this.seenFailures = new Set(loaded.seen);
		this.hasWatermark = loaded.present;

		// The badge is workspace-scoped, so BOTH halves of that scope have to move it: the developer's chosen scope
		// (written by the Workflows view's scope control, at `StorageScope.WORKSPACE`) and the folder set the scope
		// resolves against. Neither changes a byte on disk, so both recompute from the last `ok` read rather than
		// re-walking the corpus. Wired HERE rather than anywhere near the view on purpose - this service is forced to
		// instantiate at `WorkbenchPhase.AfterRestored` precisely so the badge is correct when the view has never been
		// opened (see `ClaudeWorkflowObservationActivator`), and a scope written in a previous window is already in
		// storage before this constructor runs.
		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY, this._store)(() => this.updateBadgeFromLastOkRead()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.updateBadgeFromLastOkRead()));

		void this.start();
	}

	override dispose(): void {
		this.disposed = true;
		// A pass that outlives its service can only allocate towards a snapshot nobody will read - stop it at its
		// next checkpoint. The loop's own `finally` disposes the source; cancelling here never orphans it.
		this.passCancellation?.cancel();
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

	/**
	 * Watch `<root>/projects` recursively, filtered to workflow manifest / journal / agent sidecar paths - a burst
	 * of matching events schedules ONE coalesced refresh via {@link refreshScheduler}.
	 *
	 * The watch request carries an explicit CORRELATION ID, and that is the load-bearing detail. `FileService`
	 * routes only UNCORRELATED events onto the global `onDidFilesChange` bus (fileService.ts: the
	 * `_onDidUncorrelatedFilesChange` guard), so while this request was uncorrelated every transcript append
	 * anywhere under the 141-project corpus was broadcast to EVERY file listener in the window - most damagingly
	 * `ClawdiusConfigStore`, whose subtree-prefix filter accepted them and turned each one into a full config
	 * rescan and a Control Center rebuild. Correlating the REQUEST is what severs that; which event stream this
	 * service itself then listens on is a separate, local choice.
	 *
	 * `IFileService.createWatcher()` is the usual way to correlate, but its signature admits `recursive: false`
	 * only, so the recursive case goes through `watch()` with the id set explicitly. `IFileService.watch()` is
	 * declared to return a bare `IDisposable`; the concrete `FileService` returns an `IFileSystemWatcher` whenever
	 * an id is present, which is why the result is narrowed with the platform's own `isFileSystemWatcher` guard
	 * rather than asserted.
	 *
	 * The global-bus subscription is KEPT, deliberately, and is now narrower than it was. Correlation is delivered
	 * by the file system PROVIDER: a provider that does not stamp `cId` on its change events (the in-memory
	 * provider, and any virtual provider that has not implemented it) reports everything uncorrelated, and with the
	 * correlated watcher alone this service would silently stop updating there. So both are wired to the same
	 * filter, and a given `FileChangesEvent` reaches exactly one of them - it is either correlated (watcher only)
	 * or not (bus only), never both. What changed for the bus path is the filter: it now also requires containment
	 * in this service's own `projects` tree, so a workspace file that merely happens to sit at
	 * `<some>/workflows/<name>.json` no longer schedules a whole-corpus read.
	 */
	private watch(root: URI): void {
		const projects = URI.joinPath(root, 'projects');
		this.projectsRoot = projects;
		// Built as a typed value rather than an inline literal: `IFileService.watch` is declared over
		// `IWatchOptionsWithoutCorrelation`, so an object literal carrying `correlationId` would be rejected by
		// excess-property checking even though the wider `IWatchOptions` the implementation reads declares it.
		const options: IWatchOptionsWithCorrelation = { recursive: true, excludes: [], correlationId: nextWatchCorrelationId-- };
		try {
			const handle = this.fileService.watch(projects, options);
			this.watchers.add(handle);
			if (isFileSystemWatcher(handle)) {
				this.watchers.add(handle.onDidChange(e => this.onFilesChanged(e)));
			}
		} catch {
			// Best-effort, mirroring the sibling config watcher: a watch failure (an unsupported provider, a
			// not-yet-existing tree) still leaves `readAgain()` / the initial read working, just without live updates.
		}
		this.watchers.add(this.fileService.onDidFilesChange(e => this.onFilesChanged(e)));
	}

	private onFilesChanged(e: FileChangesEvent): void {
		if (this.isRelevant(e)) { this.refreshScheduler.schedule(); }
	}

	/** Whether `e` carries at least one workflow artifact path inside this service's own watched `projects` tree.
	 *  Both halves matter: the shape test alone accepted a `<workspace>/.../workflows/x.json` reaching the global
	 *  bus from someone else's watch request, and the containment test alone would accept every transcript append. */
	private isRelevant(e: FileChangesEvent): boolean {
		const projects = this.projectsRoot;
		if (!projects) { return false; }
		const matches = (uri: URI): boolean => isWorkflowArtifactPath(uri) && extUriIgnorePathCase.isEqualOrParent(uri, projects);
		for (const uri of e.rawAdded) { if (matches(uri)) { return true; } }
		for (const uri of e.rawUpdated) { if (matches(uri)) { return true; } }
		for (const uri of e.rawDeleted) { if (matches(uri)) { return true; } }
		return false;
	}

	readAgain(): void {
		this.refreshScheduler.schedule(0);
	}

	markFailuresSeen(): void {
		const inputs = this.lastOkBadgeInputs;
		if (inputs === undefined) {
			// No `ok` read has landed yet - there is nothing known-good to mark seen. Doing nothing here (rather
			// than establishing an empty watermark) leaves the very first `ok` read free to baseline normally.
			return;
		}
		// ONLY the in-scope failures, i.e. exactly the ones the badge could have shown the developer. Marking every
		// known failure would absorb an out-of-scope failure into the watermark having never surfaced it once, and
		// widening the scope later would then show no badge for it - see `markFailuresSeen` on the interface.
		const scope = this.currentWorkspaceScope();
		const workspaceKeys = workflowWorkspaceProjectKeys(this.workspaceContextService);
		const newlySeen = new Set<string>();
		for (const run of inputs.failed) {
			if (matchesWorkflowWorkspaceScope(run, scope, workspaceKeys)) {
				this.seenFailures.add(run.identity);
				newlySeen.add(run.identity);
			}
		}
		this.hasWatermark = true;
		this.persistWatermark();
		// Deliberately NOT followed by an `onDidChangeSnapshot` fire: this is the documented seam on
		// `IClaudeWorkflowObservationService.snapshot`, which carries the reasoning and the obligation it puts on a
		// consumer (read the snapshot live, never cache it across a call into this service). The published
		// `unseenFailures` stays UNSCOPED (see `WorkflowSnapshot.unseenFailures`), so only the identities actually
		// marked seen are dropped from it - an out-of-scope failure is still genuinely unseen.
		if (this._snapshot.unseenFailures.some(identity => newlySeen.has(identity))) {
			this._snapshot = { ...this._snapshot, unseenFailures: this._snapshot.unseenFailures.filter(identity => !newlySeen.has(identity)) };
		}
		// Recomputed rather than assumed-cleared: the in-scope failure component is now empty by construction, but
		// the live component still has to be re-derived from the last `ok` read (never `this._snapshot.liveCount`,
		// which may be a degraded read's count) so a focus during a transient degraded read cannot clear or
		// fabricate the live badge.
		this.updateBadgeFromLastOkRead();
	}

	private persistWatermark(): void {
		const watermark: FailureWatermark = { version: 1, seen: [...this.seenFailures] };
		this.storageService.store(FAILURE_WATERMARK_STORAGE_KEY, JSON.stringify(watermark), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	/** The workspace scope currently in force: whatever the Workflows view last persisted, falling back to the
	 *  SHARED default the view itself seeds from ({@link DEFAULT_WORKFLOW_WORKSPACE_SCOPE}) - so on a fresh profile,
	 *  with nothing stored, the badge and the pane start out scoped identically instead of disagreeing on first run.
	 *  Read on demand, never cached: the value is one in-memory map lookup, and a cached copy is one missed
	 *  invalidation away from badging against a scope the developer has already changed. */
	private currentWorkspaceScope(): WorkflowWorkspaceScope {
		const stored = this.storageService.get(WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY, StorageScope.WORKSPACE);
		return isWorkflowWorkspaceScope(stored) ? stored : DEFAULT_WORKFLOW_WORKSPACE_SCOPE;
	}

	/**
	 * Recompute the container badge from the LAST `ok` read, narrowed to the persisted workspace scope - the ONE
	 * place the badge's inputs are derived, so the refresh path, the mark-seen path, the scope-changed path and the
	 * folder-changed path can never disagree.
	 *
	 * A no-op before any `ok` read has landed, which is what keeps a degraded read (or a scope change during one)
	 * from clearing a badge the last known-good read earned.
	 *
	 * Only the WORKSPACE scope is applied - never the pane's status or text filters. The badge is an ACTIVITY
	 * signal: filtering the list to "Failed" must not hide that a run is going right now, and the text query is
	 * session-only view state this service has no way to read.
	 */
	private updateBadgeFromLastOkRead(): void {
		const inputs = this.lastOkBadgeInputs;
		if (inputs === undefined) {
			return;
		}
		const scope = this.currentWorkspaceScope();
		const workspaceKeys = workflowWorkspaceProjectKeys(this.workspaceContextService);
		const liveCount = inputs.live.filter(run => matchesWorkflowWorkspaceScope(run, scope, workspaceKeys)).length;
		const unseenFailures = inputs.failed
			.filter(run => !this.seenFailures.has(run.identity) && matchesWorkflowWorkspaceScope(run, scope, workspaceKeys))
			.map(run => run.identity);
		this.updateBadge(liveCount, unseenFailures);
	}

	/** Live count wins over a failure indicator - live activity is more actionable than a failure the developer
	 *  has not yet looked at. Below that, an unseen failure gets a warning indicator; with neither, the badge
	 *  clears. Both arguments arrive already narrowed to the workspace scope by the single caller
	 *  ({@link updateBadgeFromLastOkRead}), and are only ever derived from an `ok` read - a degraded read leaves the
	 *  last-known badge exactly as it was. */
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

	/**
	 * The single entry point to a refresh: starts a pass when none is running, and otherwise queues exactly one
	 * rerun behind the running one. Every caller (the coalescing scheduler, the first read, `readAgain`) goes
	 * through here, so {@link refreshInFlight} is a true global cap of one enumeration at a time.
	 *
	 * Requesting a refresh also means the running pass's result is already known to be stale, so this cancels it -
	 * subject to the {@link previousPassCancelled} alternation invariant, which is what keeps a continuous workflow
	 * from cancelling every pass and freezing the snapshot.
	 */
	private requestRefresh(): Promise<void> {
		this.rerunRequested = true;
		if (this.passCancellation && !this.previousPassCancelled) {
			// Marks the RUNNING pass as the cancelled one, so the rerun this request queues cannot also be cancelled.
			this.previousPassCancelled = true;
			this.passCancellation.cancel();
		}
		if (!this.refreshInFlight) {
			this.refreshInFlight = this.refreshLoop().finally(() => { this.refreshInFlight = undefined; });
		}
		return this.refreshInFlight;
	}

	/** Runs passes until nothing more is queued. The flag is cleared BEFORE the pass so a request that lands while
	 *  the pass is running is seen on the next turn of the loop rather than swallowed by it. */
	private async refreshLoop(): Promise<void> {
		while (this.rerunRequested && !this.disposed) {
			this.rerunRequested = false;
			const source = new CancellationTokenSource();
			this.passCancellation = source;
			try {
				await this.doRefresh(source.token);
			} finally {
				this.passCancellation = undefined;
				// Carries the alternation invariant across iterations: exactly "the pass that just ran was cancelled".
				this.previousPassCancelled = source.token.isCancellationRequested;
				source.dispose();
			}
		}
	}

	/** One enumeration pass: re-read the corpus through the seam and, unless `token` says this pass has already
	 *  been superseded, publish the resulting snapshot and update the awareness badge. Only ever called from
	 *  {@link refreshLoop}, which is what makes "one pass at a time" true. */
	private async doRefresh(token: CancellationToken): Promise<void> {
		const home = await this.pathService.userHome();
		if (this.disposed || token.isCancellationRequested) { return; }
		const root = resolveConfigRoot(undefined, home);
		const result = await this.seam.listWorkflows(root, token);
		// This pass was abandoned mid-walk, so `result` is the seam's inert cancellation envelope and describes
		// nothing about the corpus - publishing it would blank the view. The rerun that superseded this pass is
		// already queued (see `requestRefresh`), so producing nothing here is exactly right.
		if (this.disposed || token.isCancellationRequested) { return; }
		const liveCount = result.state === 'read-error' ? 0 : result.runs.filter(run => run.kind === 'live').length;

		let unseenFailures: readonly string[];
		if (result.state === 'ok') {
			const failed = failedRuns(result.runs);
			this.lastOkBadgeInputs = { live: result.runs.filter(run => run.kind === 'live'), failed };
			const failedIdentities = failed.map(run => run.identity);
			if (!this.hasWatermark) {
				// Baseline: absorb every currently-failed run as already-seen, WITHOUT badging - the no-cold-start
				// -alarm rule. A fresh install over a pile of old failures must never look like a NEW failure.
				// Deliberately UNSCOPED, unlike `markFailuresSeen`: the baseline's claim is "all of this predates my
				// watching", which is true of every project's history regardless of which folder is open right now,
				// and scoping it would fire a cold-start alarm for the rest the first time the developer widened.
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
			// From the runs just recorded in `lastOkBadgeInputs`, NOT from the unscoped `liveCount`/`unseenFailures`
			// published above - the snapshot describes the whole enumeration, the badge describes this workspace.
			this.updateBadgeFromLastOkRead();
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
