/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - observation service (live watch + coalesced snapshot)
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
// Awareness (the failure watermark + the `unseenFailures` badge feed) is NOT part of this change. `WorkflowSnapshot`
// carries the full shape the contract defines so a later change can fill in the logic without a type change, but
// THIS service has no persisted baseline to compare against yet, so `unseenFailures` is always `[]` and
// `markFailuresSeen()` is a no-op - never fabricating an "unseen" claim from data with no watermark behind it.

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileChangesEvent, IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import { WorkflowRunListResult } from '../../common/claudeWorkflowModel.js';
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
	/** Failed run identities not yet in the persisted "seen" watermark. Deferred: the watermark and this feed
	 *  arrive in a later change; there is no persisted baseline yet, so this is always `[]` here - never
	 *  fabricated from a read that has nothing to compare against. */
	readonly unseenFailures: readonly string[];
}

const EMPTY_SNAPSHOT: WorkflowSnapshot = { result: { state: 'ok', runs: [] }, liveCount: 0, unseenFailures: [] };

export const IClaudeWorkflowObservationService = createDecorator<IClaudeWorkflowObservationService>('claudeWorkflowObservationService');

/** The single source of truth for the current enumerated workflow snapshot; the Workflows view (and, in a later
 *  change, an awareness badge) binds to this instead of reading the reader seam directly. */
export interface IClaudeWorkflowObservationService {
	readonly _serviceBrand: undefined;
	/** Fires once per coalesced refresh with the new immutable snapshot. */
	readonly onDidChangeSnapshot: Event<WorkflowSnapshot>;
	/** The latest snapshot; `EMPTY_SNAPSHOT`-shaped until the first read resolves. */
	readonly snapshot: WorkflowSnapshot;
	/** Marks the currently-known failures as seen. Deferred: a no-op until the failure watermark exists
	 *  (see {@link WorkflowSnapshot.unseenFailures}). */
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

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// Not a registered singleton; instantiated the same way the view instantiated it before this change (teams
		// probe off) so both consumers read runs through the identical enumeration.
		this.seam = instantiationService.createInstance(ClawdiusReaderSeamService, false);
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
		// Not in this change: the persisted failure watermark arrives in a later change; there is nothing to mark
		// seen yet (see WorkflowSnapshot.unseenFailures), so this is deliberately a no-op rather than fabricating state.
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
		this._snapshot = { result, liveCount, unseenFailures: [] };
		this._onDidChangeSnapshot.fire(this._snapshot);
	}
}

/** Forces the delayed {@link IClaudeWorkflowObservationService} singleton to instantiate right after restore, so
 *  it starts watching immediately rather than only once the Workflows view happens to be opened - the same
 *  "inject to activate" idiom used elsewhere for a service that must run before any UI surface asks for it. This
 *  is what lets a later awareness surface (e.g. a status-bar badge) read a live snapshot even when the view has
 *  never been opened in this session. */
export class ClaudeWorkflowObservationActivator implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeWorkflowObservationActivator';
	constructor(@IClaudeWorkflowObservationService _observationService: IClaudeWorkflowObservationService) { }
}
// CLAWDIUS-END
