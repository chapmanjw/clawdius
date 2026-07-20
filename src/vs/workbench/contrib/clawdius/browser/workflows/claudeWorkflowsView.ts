/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - Sidebar (Activity Bar) ViewPane
// A native `WorkbenchObjectTree` ViewPane listing the ultracode WORKFLOWS the reader seam enumerates - workflow
// runs, not chat sessions. The top-level list is sourced through the validated root envelope `listWorkflows` (the
// discriminated live/terminal/unknown-shape model + the honest ok/partial/read-error envelope, `common/
// claudeWorkflowModel.ts`) and rendered DIRECTLY through the tree - no bridge back to a legacy row shape. A
// TERMINAL run expands (native tree expansion, collapsed by default) to its story leaf (summary + cost + result,
// variable-height and measured) and its phases/agents (grouped under phase nodes only when the run declared more
// than one - see `claudeWorkflowTree.ts`'s `buildTerminalRunChildren`). Drill-in editors open on `onDidOpen`
// (Enter or mouse activation): the story leaf opens the run's FULL result, an agent row opens its DETAIL - both
// the discriminated `ClaudeWorkflowDetailInput`/`Editor` (`claudeWorkflowDetailInput.ts` /
// `claudeWorkflowDetailEditor.ts`), rendered from the SAME in-memory `TerminalWorkflowRun`/`TerminalWorkflowAgent`
// the tree already holds - no second seam read. An agent's raw transcript is reachable FROM its detail pane (an
// "Open Transcript" action, withheld unless `agent.transcriptRef` is present); `run` (toggles expansion) and
// `phase` (a grouping node) never open an editor.
//
// The ownership-chrome rule is split across this file and `claudeWorkflowTree.ts`: `refreshDisplay()` below
// computes `uniformlyForeign` ONCE per re-render (never per-row, off the DISPLAYED runs after the status/text
// filter) and paints the single SURFACE ownership label above the tree ONLY while every displayed run is foreign;
// the tree's row renderer reads that already-computed signal off a shared mutable context and paints NO per-run
// ownership chrome in the common (uniformly-foreign) case, falling back to a per-run label the instant ownership
// can differ. The view's data source is the `IClaudeWorkflowObservationService` singleton
// (`claudeWorkflowObservationService.ts`), which owns the config-root resolution and the seam read - the view
// itself no longer touches either directly; `refreshDisplay()` re-derives from the last snapshot it HELD
// (`lastResult`) both on a fresh snapshot and on a filter/sort/status-filter change, so the latter never waits on
// a new one (the persistent find/sort view state - see the "find/sort" block below the view id exports).
//
// READ-ONLY BY CONSTRUCTION, not by policy. The view observes; it cannot act on a workflow run. Clawdius holds a
// live `Query` only for a session IT launched, so a run launched by the Claude Code CLI - which today is every
// run on disk - has no handle to stop or steer. A control surface here would be unreachable, so there is
// none. Launching workflows from Clawdius is a future direction that would make controls meaningful; until then
// the honest product is an observatory. The read-error state's "Read again" affordance is a RE-READ of the same
// enumeration (`observationService.readAgain()`), never a run control.

import './media/claudeWorkflows.css';
import { $, append, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectOptionItem, SelectBox } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { disposableTimeout, RunOnceScheduler } from '../../../../../base/common/async.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { localize } from '../../../../../nls.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	LiveWorkflowRun, TerminalWorkflowAgent, TerminalWorkflowRun, UnrecognizedWorkflowRun, WorkflowRun, WorkflowRunListResult,
} from '../../common/claudeWorkflowModel.js';
import { BadgeSignal, ClaudeWorkflowBadgeFeed } from './claudeWorkflowBadges.js';
import { boundResultText, ClaudeWorkflowAgentDetailPayload, ClaudeWorkflowDetailInput, ClaudeWorkflowResultDetailPayload } from './claudeWorkflowDetailInput.js';
import { IClaudeWorkflowObservationService, WORKFLOWS_VIEW_CONTAINER_ID, WorkflowSnapshot } from './claudeWorkflowObservationService.js';
import { ownedSessionIdsFromHost } from './claudeWorkflowOwnership.js';
import {
	computeUniformlyForeign, IWorkflowRenderContext, reconcileWorkflowTree, renderWorkflowsStateMessage,
	resolveTrackedElements, resolveWorkflowsDisplayState, WorkflowAgentRowRenderer, WorkflowLiveProgressRenderer,
	WorkflowPhaseRowRenderer, WorkflowRunRowRenderer, WorkflowStoryHeightCache, WorkflowStoryLeafRenderer,
	WorkflowTreeAccessibilityProvider, WorkflowTreeElement, WorkflowTreeIdentityProvider,
	WorkflowTreeKeyboardNavigationLabelProvider, WorkflowTreeVirtualDelegate, workflowTreeElementId,
} from './claudeWorkflowTree.js';

/** How long a graduated run's transient visual highlight stays applied before clearing (see `announceGraduations`).
 *  Skipped entirely under reduced motion - the accessibility alert still always fires, motion-independent. */
const GRADUATION_HIGHLIGHT_MS = 1500;

// The view CONTAINER id is defined in `claudeWorkflowObservationService.ts` (re-exported here) so the observation
// service can target the container's activity badge without an import cycle - this view already depends on that
// module for its snapshot type, never the reverse. See that module's own PRESERVED-for-backward-compat comment
// on the constant itself.
export { WORKFLOWS_VIEW_CONTAINER_ID };
// PRESERVED for backward compat: this is the view id VS Code persists (panel/sidebar placement, visibility,
// size) across restarts. It must NOT change with the rename, or a pre-rename user's restored view state for
// this view would fail to restore - the same backward-compat rationale as the transcript editor-input-serializer
// typeId.
export const WORKFLOWS_VIEW_ID = 'clawdius.missions';

// --- find/sort: the persistent text filter, the status-category filter, and the deterministic sort modes --------
//
// EXPORTED as pure functions (never methods) so a unit test drives them directly, without constructing the view.
// The view composes them in `refreshDisplay()`: status filter -> text filter -> sort, in that order - a LIVE run is
// therefore pinned first only AMONG MATCHES (`sortWorkflowRuns` never even sees a run either filter already
// dropped) and is excluded outright the moment its own runId fails the text filter; there is no separate
// "force-show a live run" path layered on top.

/** How long after the filter input's last keystroke the (debounced) re-render fires, so typing does not re-render
 *  the tree once per character - comfortably inside the "narrows the list ... within 300 ms" budget once the
 *  render itself (typically well under 100 ms) is added on top. */
const FILTER_DEBOUNCE_MS = 200;

/** The run-set sort mode the toolbar's sort control drives - see {@link sortWorkflowRuns}. */
export const enum WorkflowSortMode {
	Recency = 'recency',
	Cost = 'cost',
	Status = 'status',
}

/** The status-CATEGORY filter the toolbar's status control drives - narrows the run set to exactly one kind/status
 *  BEFORE the text filter and sort apply. Distinct from {@link TerminalWorkflowRun.status} (`completed`/`failed`
 *  only): this filter also has `live` and the default `all`. */
export const enum WorkflowStatusFilter {
	All = 'all',
	Live = 'live',
	Completed = 'completed',
	Failed = 'failed',
}

/**
 * Whether `run` belongs to the `filter` category: `all` matches every run; `live` matches only a `kind: 'live'`
 * run; `completed`/`failed` match only a TERMINAL run with that exact status. An `unknown-shape` run matches none
 * of `live`/`completed`/`failed` (it is none of the three) but does match `all`.
 */
export function matchesWorkflowStatusFilter(run: WorkflowRun, filter: WorkflowStatusFilter): boolean {
	switch (filter) {
		case WorkflowStatusFilter.All: return true;
		case WorkflowStatusFilter.Live: return run.kind === 'live';
		case WorkflowStatusFilter.Completed: return run.kind === 'terminal' && run.status === 'completed';
		case WorkflowStatusFilter.Failed: return run.kind === 'terminal' && run.status === 'failed';
	}
}

/**
 * The text-filter corpus: a case-insensitive substring match against a terminal run's `workflowName`, `summary`,
 * `runId`, each of its agents' `label`, and the run's OWN `error` text - and NOTHING else. It NEVER reads
 * `resultText`/`resultPreview` (a run's full result or its preview) or any agent's `resultPreview`/transcript -
 * those are large and can carry private data, so this function does not even look at them. An empty query matches
 * every run. A `live`/`unknown-shape` run carries none of the terminal-only fields, so only its `runId` can ever
 * match it.
 */
export function matchesWorkflowFilter(run: WorkflowRun, query: string): boolean {
	if (query.length === 0) {
		return true;
	}
	const needle = query.toLowerCase();
	if (run.runId.toLowerCase().includes(needle)) {
		return true;
	}
	if (run.kind !== 'terminal') {
		return false;
	}
	if (run.workflowName?.toLowerCase().includes(needle)) {
		return true;
	}
	if (run.summary?.toLowerCase().includes(needle)) {
		return true;
	}
	if (run.error?.toLowerCase().includes(needle)) {
		return true;
	}
	return run.agents.some(agent => agent.label.toLowerCase().includes(needle));
}

function isLiveRun(run: WorkflowRun): run is LiveWorkflowRun {
	return run.kind === 'live';
}

/** The ONE tie-break every sort mode falls back to: a run's composite `identity` (never the bare `runId`, which
 *  can collide across sessions - see `workflowRunIdentity`'s doc comment) is unique per run, so comparing by it
 *  alone can never itself produce a remaining tie - it is what makes every mode's order UNIQUE, not merely
 *  deterministic. Plain relational operators (never `localeCompare`, which is locale-dependent) keep this an
 *  ordinal, machine-independent comparison. */
function compareByRunIdentity(a: WorkflowRun, b: WorkflowRun): number {
	if (a.identity < b.identity) { return -1; }
	if (a.identity > b.identity) { return 1; }
	return 0;
}

/** `recency`'s per-run key: a terminal run's completion `timestamp`; `undefined` for every other case (a live run
 *  never reaches this - it is pinned separately below; an unknown-shape run has no timestamp at all) - `undefined`
 *  sorts LAST, per {@link compareDescendingMissingLast}. */
function recencyKey(run: WorkflowRun): number | undefined {
	return run.kind === 'terminal' ? run.timestamp : undefined;
}

/** `cost`'s per-run key: a terminal run's `totalTokens`; `undefined` otherwise (same reasoning as {@link recencyKey}). */
function costKey(run: WorkflowRun): number | undefined {
	return run.kind === 'terminal' ? run.totalTokens : undefined;
}

/** Descending numeric compare (highest/newest first) with a missing (`undefined`) key sorted LAST - shared by the
 *  `recency` and `cost` modes, and by the `status` mode's own newest-first sub-order. Returns 0 ONLY on a genuine
 *  remaining tie (both missing, or numerically equal) - the caller then breaks that tie by run identity. */
function compareDescendingMissingLast(a: number | undefined, b: number | undefined): number {
	if (a === undefined && b === undefined) { return 0; }
	if (a === undefined) { return 1; }
	if (b === undefined) { return -1; }
	return b - a;
}

function compareByRecency(a: WorkflowRun, b: WorkflowRun): number {
	return compareDescendingMissingLast(recencyKey(a), recencyKey(b));
}

function compareByCost(a: WorkflowRun, b: WorkflowRun): number {
	return compareDescendingMissingLast(costKey(a), costKey(b));
}

const STATUS_RANK: { readonly completed: number; readonly failed: number } = { failed: 0, completed: 1 };

/** `status`'s comparator: failed before completed; `undefined` (an unknown-shape run - a terminal run's own
 *  `status` is never optional) sorts LAST; newest-first ({@link compareByRecency}'s key) WITHIN the same status;
 *  any tie still remaining after that falls through to the caller's identity tie-break. */
function compareByStatus(a: WorkflowRun, b: WorkflowRun): number {
	const sa = a.kind === 'terminal' ? a.status : undefined;
	const sb = b.kind === 'terminal' ? b.status : undefined;
	if (sa === undefined && sb === undefined) { return 0; }
	if (sa === undefined) { return 1; }
	if (sb === undefined) { return -1; }
	if (sa !== sb) { return STATUS_RANK[sa] - STATUS_RANK[sb]; }
	return compareDescendingMissingLast(recencyKey(a), recencyKey(b));
}

function comparatorForMode(mode: WorkflowSortMode): (a: WorkflowRun, b: WorkflowRun) => number {
	switch (mode) {
		case WorkflowSortMode.Recency: return compareByRecency;
		case WorkflowSortMode.Cost: return compareByCost;
		case WorkflowSortMode.Status: return compareByStatus;
	}
}

/**
 * The run set's ONE deterministic total order for `mode`: every LIVE run first (ordered among themselves by run
 * identity, stable - a live journal has no trustworthy time, so it is never mode-ordered), then every
 * terminal/unknown-shape run ordered by `mode`'s own key with a missing key sorted last, any remaining tie
 * (including a `status`-mode tie after its own newest-first sub-order) broken by run identity - which, because
 * every run's identity is unique, guarantees a single UNIQUE order, never merely "deterministic with possible
 * ties". `runs` is never mutated; a NEW array is always returned.
 */
export function sortWorkflowRuns(runs: readonly WorkflowRun[], mode: WorkflowSortMode): WorkflowRun[] {
	const live = runs.filter(isLiveRun).slice().sort(compareByRunIdentity);
	const modeCompare = comparatorForMode(mode);
	const rest = runs.filter(run => !isLiveRun(run)).slice().sort((a, b) => {
		const primary = modeCompare(a, b);
		return primary !== 0 ? primary : compareByRunIdentity(a, b);
	});
	return [...live, ...rest];
}

/** The Claude Code Ultracode Workflows Sidebar view: enumerates runs through the reader seam and renders them
 *  through a `WorkbenchObjectTree`, honestly labeled. */
export class ClawdiusWorkflowsView extends ViewPane {

	static readonly ID = WORKFLOWS_VIEW_ID;

	/** The RAW runs from the last applied snapshot (before the status-filter/text-filter/sort derivation below) -
	 *  correlated against by the live badge feed, so a badge for a run the current filter happens to hide is still
	 *  tracked and ready the instant that run becomes visible again. See `currentDisplayedRuns` for what the tree
	 *  actually shows. */
	private currentRuns: readonly WorkflowRun[] = [];
	/** The authoritative live badges per run; read by the run-row renderer at render time via `renderContext`. */
	private readonly badges = new Map<string, BadgeSignal>();
	/** The live needs-input/completion badge feed (created in renderBody, disposed with the view). */
	private badgeFeed: ClaudeWorkflowBadgeFeed | undefined;
	/** Whether the CURRENT filter (a non-empty text query, or a status filter narrower than `all`) is active and
	 *  matches zero of the last held snapshot's runs - drives the `no-match` display state via
	 *  `resolveWorkflowsDisplayState`. Recomputed on every `refreshDisplay()` call; never toggled directly. */
	private filterActive = false;
	/** The persistent free-text filter query (see `matchesWorkflowFilter`), updated on every InputBox keystroke;
	 *  the (debounced) re-render it drives runs through `filterDebounceScheduler`, never per-keystroke. */
	private filterQuery = '';
	/** The persistent status-category filter (see `matchesWorkflowStatusFilter`) driven by the toolbar's status
	 *  SelectBox - applied immediately on change (a discrete selection, not something to debounce). */
	private statusFilter: WorkflowStatusFilter = WorkflowStatusFilter.All;
	/** The persistent sort mode (see `sortWorkflowRuns`) driven by the toolbar's sort SelectBox. Newest-first is
	 *  the default: with hundreds of runs, the most recently active ones are the most likely starting point. */
	private sortMode: WorkflowSortMode = WorkflowSortMode.Recency;
	/** The raw envelope from the LAST applied observation-service snapshot - held so a filter/sort/status-filter
	 *  change alone can re-derive the displayed runs and re-render WITHOUT waiting for the next snapshot (the
	 *  find/sort surface's persistent-view-state requirement). `undefined` until the view's first snapshot arrives. */
	private lastResult: WorkflowRunListResult | undefined;
	/** The runs actually shown on the last render, AFTER the status filter, text filter, and sort mode all
	 *  applied - distinct from `currentRuns` (see that field's doc comment). Used by `updateSurfaceOwnershipLabel`
	 *  to gate the surface label on what is actually visible, not on the full unfiltered snapshot. */
	private currentDisplayedRuns: readonly WorkflowRun[] = [];

	/** Per-run measured story-leaf / live-progress-leaf heights, shared between the virtual delegate and the two
	 *  measured-leaf renderers. */
	private readonly storyHeights = new WorkflowStoryHeightCache();
	/** The mutable, view-owned ownership signal every row renderer reads at render time (never recomputed by a
	 *  renderer, never a second disk read). Mutated in place on every applied snapshot. */
	private readonly renderContext: IWorkflowRenderContext;
	/** identity -> the CURRENT authoritative run data, read by `renderContext.runOf` - see that field's doc comment
	 *  in `claudeWorkflowTree.ts` for why the tree's own element can go stale for an unchanged identity. Rebuilt on
	 *  every applied snapshot BEFORE any tree mutation, so a `rerender()` triggered during that mutation always
	 *  paints current data. */
	private readonly latestRunByIdentity = new Map<string, WorkflowRun>();
	/** The run identities currently within their transient post-graduation visual highlight window; a run is added
	 *  here only when motion is NOT reduced (see `announceGraduations`) and removed again after the highlight window. */
	private readonly recentlyGraduated = new Set<string>();
	/** The identities carrying `kind: 'live'` as of the last applied snapshot - compared against the new snapshot
	 *  to detect a graduation (live -> terminal/unknown-shape) without needing the tree's own state. */
	private readonly liveIdentities = new Set<string>();
	/** runId -> its current top-level tree element - the EXACT reference the tree tracks for that row (never a
	 *  freshly-built duplicate; see `applyTreeSnapshot`), so a live badge poke or a graduation can `tree.rerender` /
	 *  `tree.setChildren` the exact row without a full rebuild. Rebuilt on every applied snapshot. */
	private readonly runElementsByRunId = new Map<string, WorkflowTreeElement>();
	/** runId -> the content signature last actually rendered for that run - threaded into `reconcileWorkflowTree`
	 *  so an already-terminal run whose manifest was rewritten (e.g. a corrected status) re-renders instead of
	 *  being assumed immutable; see that function's doc comment in claudeWorkflowTree.ts. Rebuilt on every applied
	 *  snapshot from the reconcile's own result, exactly like `runElementsByRunId`/`liveIdentities`. */
	private readonly renderedSignatureByRunId = new Map<string, string>();
	private readonly stateMessageStore = this._register(new MutableDisposable());
	private readonly storyRemeasureSchedule = this._register(new MutableDisposable());
	/** Clears a graduated run's transient highlight after `GRADUATION_HIGHLIGHT_MS`. Passed as `disposableTimeout`'s
	 *  own `store` argument (below) rather than `.add()`-ed after the fact, so a FIRED timer is automatically
	 *  evicted from this store the moment it runs - never held for the rest of the view's life, which an unbounded
	 *  `DisposableStore.add()` with no matching removal would otherwise do over a long session. */
	private readonly graduationHighlightTimers = this._register(new DisposableStore());
	/** Fires `refreshDisplay()` `FILTER_DEBOUNCE_MS` after the LAST scheduling call - `RunOnceScheduler.schedule()`
	 *  reschedules a still-pending timer rather than stacking a second one, which is what turns a burst of
	 *  keystrokes into exactly one re-render. */
	private readonly filterDebounceScheduler = this._register(new RunOnceScheduler(() => this.refreshDisplay(), FILTER_DEBOUNCE_MS));

	private surfaceLabelEl!: HTMLElement;
	private stateContainer!: HTMLElement;
	private treeContainer!: HTMLElement;
	private tree!: WorkbenchObjectTree<WorkflowTreeElement, FuzzyScore>;
	private storyRenderer!: WorkflowStoryLeafRenderer;
	private liveProgressRenderer!: WorkflowLiveProgressRenderer;
	private filterInput!: InputBox;
	private statusFilterSelect!: SelectBox;
	private sortModeSelect!: SelectBox;
	private lastWidth: number | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
		@IEditorService private readonly editorService: IEditorService,
		@IClaudeWorkflowObservationService private readonly observationService: IClaudeWorkflowObservationService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.renderContext = {
			uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: runId => this.badges.get(runId),
			runOf: identity => this.latestRunByIdentity.get(identity),
			justGraduated: identity => this.recentlyGraduated.has(identity),
		};
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('clawdius-workflows');

		// The single surface ownership label: shown only while every currently-enumerated run is foreign (see
		// `updateSurfaceOwnershipLabel`), dropped the instant ownership can differ.
		this.surfaceLabelEl = append(container, $('.clawdius-workflows-surface-label'));
		this.surfaceLabelEl.textContent = localize('clawdius.workflows.surfaceForeign', "All runs shown are foreign - observed on disk, not owned by this workbench.");
		this.surfaceLabelEl.style.display = 'none';

		// The persistent filter/status-filter/sort toolbar, mounted ABOVE the tree/state pair (never inside it),
		// so a filter that produced the `no-match` state stays reachable to clear or change.
		this.renderToolbar(container);

		// The three-state message overlay and the tree container are mutually exclusive - exactly one of
		// them is visible at a time, and the TREE is the only one of the two that ever scrolls internally.
		this.stateContainer = append(container, $('.clawdius-workflows-state'));
		this.stateContainer.style.display = 'none';
		this.treeContainer = append(container, $('.clawdius-workflows-tree'));

		const hoverDelegate = this._register(this.instantiationService.createInstance(WorkbenchHoverDelegate, 'element', undefined, {}));

		this.storyRenderer = this._register(new WorkflowStoryLeafRenderer(this.storyHeights));
		this._register(this.storyRenderer.onDidChangeItemHeight(({ element, height }) => {
			if (this.tree.hasElement(element)) {
				this.tree.updateElementHeight(element, height);
			}
		}));
		this.liveProgressRenderer = this._register(new WorkflowLiveProgressRenderer(this.storyHeights));
		this._register(this.liveProgressRenderer.onDidChangeItemHeight(({ element, height }) => {
			if (this.tree.hasElement(element)) {
				this.tree.updateElementHeight(element, height);
			}
		}));
		const runRenderer = this._register(new WorkflowRunRowRenderer(this.renderContext, hoverDelegate));
		const phaseRenderer = new WorkflowPhaseRowRenderer();
		const agentRenderer = this._register(new WorkflowAgentRowRenderer(hoverDelegate));

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<WorkflowTreeElement, FuzzyScore>,
			'ClawdiusWorkflowsTree',
			this.treeContainer,
			new WorkflowTreeVirtualDelegate(this.storyHeights),
			[runRenderer, this.storyRenderer, this.liveProgressRenderer, phaseRenderer, agentRenderer],
			{
				identityProvider: new WorkflowTreeIdentityProvider(),
				accessibilityProvider: new WorkflowTreeAccessibilityProvider(this.renderContext),
				keyboardNavigationLabelProvider: new WorkflowTreeKeyboardNavigationLabelProvider(),
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				collapseByDefault: true,
				overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			},
		));

		// Drill-in activation: `onDidOpen` fires for BOTH Enter and mouse activation. A `story` element opens the
		// run's full RESULT detail; an `agent` element opens that agent's DETAIL. `run` (a collapsible row) and
		// `phase` (a grouping node) open no editor - the tree's own native expand/collapse handles `run`.
		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element) { return; }
			if (element.kind === 'story') {
				void this.openResultDetail(element.run);
			} else if (element.kind === 'agent') {
				void this.openAgentDetail(element.run, element.agent);
			}
		}));

		// The LIVE-only badge feed: an owned run's `onDidAction` needs-input/completion event raises a `live` badge
		// on its row. In a runtime with no agent host the null service's `onDidAction` is `Event.None`, so nothing
		// fires and rows keep the seam's honest polled status - never a fabricated badge.
		this.badgeFeed = this._register(new ClaudeWorkflowBadgeFeed({
			onDidAction: this.agentHostService.onDidAction,
			getRuns: () => this.currentRuns,
			getOwnedSessionIds: () => ownedSessionIdsFromHost(this.agentHostService),
		}));
		this._register(this.badgeFeed.onDidChangeBadge(signal => {
			this.badges.set(signal.runId, signal);
			const element = this.runElementsByRunId.get(signal.runId);
			if (element && this.tree.hasElement(element)) {
				this.tree.rerender(element);
			}
		}));

		// The Workflows view's PRIMARY data path: bind to the observation service's coalesced snapshot instead of
		// reading the reader seam directly. Seed from whatever it already knows (the empty default
		// until its first read resolves), then re-apply on every subsequent snapshot - including the one the
		// read-error state's "Read again" button triggers via `observationService.readAgain()`.
		this._register(this.observationService.onDidChangeSnapshot(snapshot => this.applySnapshot(snapshot)));
		this.applySnapshot(this.observationService.snapshot);

		// Awareness: mark known failures seen whenever the developer actually looks at this surface - on focus,
		// and whenever the view's body becomes visible (opened, expanded, or brought to the foreground), never on
		// becoming hidden. Clears the container's unseen-failure badge without waiting for a fresh read.
		this._register(this.onDidFocus(() => this.observationService.markFailuresSeen()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) { this.observationService.markFailuresSeen(); }
		}));
	}

	/**
	 * The persistent filter InputBox + the status-filter and sort-mode SelectBoxes, mounted in one toolbar row
	 * above the tree. All three are PERSISTENT view state (`filterQuery`/`statusFilter`/`sortMode`): a change to
	 * any of them re-derives the displayed runs from `lastResult` (the last-HELD snapshot) via `refreshDisplay()`
	 * immediately - never waiting for the next observation-service snapshot. Only the free-text input is debounced
	 * (`filterDebounceScheduler`); the two SelectBoxes fire a discrete selection event, not a keystroke stream, so
	 * they re-render immediately.
	 */
	private renderToolbar(container: HTMLElement): void {
		const toolbar = append(container, $('.clawdius-workflows-toolbar'));

		const filterContainer = append(toolbar, $('.clawdius-workflows-filter'));
		this.filterInput = this._register(new InputBox(filterContainer, this.contextViewService, {
			placeholder: localize('clawdius.workflows.filter.placeholder', "Filter by name, summary, agent, or error"),
			ariaLabel: localize('clawdius.workflows.filter.ariaLabel', "Filter Claude Code workflow runs by name, summary, run ID, agent, or error"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(this.filterInput.onDidChange(value => {
			this.filterQuery = value;
			this.filterDebounceScheduler.schedule();
		}));

		// The status-category filter: index-aligned with `WorkflowStatusFilter`'s declaration order, built as one
		// array so the SelectBox's `ISelectOptionItem[]` labels and the enum values driven by its `onDidSelect`
		// index can never drift apart.
		const statusFilterOptions: readonly { readonly value: WorkflowStatusFilter; readonly label: string }[] = [
			{ value: WorkflowStatusFilter.All, label: localize('clawdius.workflows.statusFilter.all', "All Statuses") },
			{ value: WorkflowStatusFilter.Live, label: localize('clawdius.workflows.statusFilter.live', "Live") },
			{ value: WorkflowStatusFilter.Completed, label: localize('clawdius.workflows.statusFilter.completed', "Completed") },
			{ value: WorkflowStatusFilter.Failed, label: localize('clawdius.workflows.statusFilter.failed', "Failed") },
		];
		const statusFilterContainer = append(toolbar, $('.clawdius-workflows-status-filter'));
		this.statusFilterSelect = this._register(new SelectBox(
			statusFilterOptions.map((option): ISelectOptionItem => ({ text: option.label })),
			0, this.contextViewService, defaultSelectBoxStyles,
			{ ariaLabel: localize('clawdius.workflows.statusFilter.ariaLabel', "Filter workflow runs by status") },
		));
		this.statusFilterSelect.render(statusFilterContainer);
		this._register(this.statusFilterSelect.onDidSelect(e => {
			this.statusFilter = statusFilterOptions[e.index]?.value ?? WorkflowStatusFilter.All;
			this.refreshDisplay();
		}));

		// The sort mode - same index-aligned-array shape as the status filter above.
		const sortModeOptions: readonly { readonly value: WorkflowSortMode; readonly label: string }[] = [
			{ value: WorkflowSortMode.Recency, label: localize('clawdius.workflows.sort.recency', "Sort: Newest First") },
			{ value: WorkflowSortMode.Cost, label: localize('clawdius.workflows.sort.cost', "Sort: Highest Cost") },
			{ value: WorkflowSortMode.Status, label: localize('clawdius.workflows.sort.status', "Sort: Failed First") },
		];
		const sortContainer = append(toolbar, $('.clawdius-workflows-sort'));
		this.sortModeSelect = this._register(new SelectBox(
			sortModeOptions.map((option): ISelectOptionItem => ({ text: option.label })),
			0, this.contextViewService, defaultSelectBoxStyles,
			{ ariaLabel: localize('clawdius.workflows.sort.ariaLabel', "Sort workflow runs") },
		));
		this.sortModeSelect.render(sortContainer);
		this._register(this.sortModeSelect.onDidSelect(e => {
			this.sortMode = sortModeOptions[e.index]?.value ?? WorkflowSortMode.Recency;
			this.refreshDisplay();
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const widthChanged = this.lastWidth !== undefined && this.lastWidth !== width;
		this.lastWidth = width;
		const boundedHeight = Math.max(0, height);
		this.stateContainer.style.height = `${boundedHeight}px`;
		this.treeContainer.style.height = `${boundedHeight}px`;
		this.treeContainer.style.width = `${width}px`;
		this.tree.layout(height, width);
		if (widthChanged) {
			// A width change invalidates the cached story heights' correctness (the same text now wraps to a
			// different number of lines); batch a burst of resize events (a sidebar drag) into ONE remeasure pass.
			this.storyRemeasureSchedule.value = scheduleAtNextAnimationFrame(getWindow(this.treeContainer), () => this.storyRenderer.remeasureAll());
		}
	}

	/**
	 * Apply one immutable snapshot from the observation service - the view's PRIMARY data path. Holds the snapshot's
	 * envelope in `lastResult` and defers to `refreshDisplay()` for the rest, so a LATER filter/sort/status-filter
	 * change can re-run that exact same derivation against this same held envelope without waiting on the
	 * observation service again. This is also effectively the RE-READ entry point: the read-error state's "Read
	 * again" button calls `observationService.readAgain()`, whose eventual snapshot flows back through this exact
	 * same method - never a run control, always the same re-enumeration.
	 */
	private applySnapshot(snapshot: WorkflowSnapshot): void {
		this.lastResult = snapshot.result;
		this.refreshDisplay();
	}

	/**
	 * Re-derive the DISPLAYED runs from `lastResult` (the last-HELD read result - a fresh snapshot from
	 * `applySnapshot`, or simply whatever snapshot preceded a filter/sort/status-filter change) and re-render. This
	 * is the ONE place the status filter, text filter, and sort mode are actually applied - status filter narrows
	 * the category first, the text filter narrows further within it, and the sort orders what remains, so a LIVE
	 * run is pinned first only AMONG MATCHES and is excluded outright the moment its own runId fails the text
	 * filter (there is no separate "force-show a live run" path). Renders the tree when runs remain after
	 * filtering, one of the three distinct message states otherwise. No-ops until the first snapshot has arrived
	 * (`lastResult` still `undefined`).
	 */
	private refreshDisplay(): void {
		const result = this.lastResult;
		if (!result) {
			return;
		}
		const rawRuns: readonly WorkflowRun[] = result.state === 'read-error' ? [] : result.runs;
		this.currentRuns = rawRuns;
		const ownedSessionIds = ownedSessionIdsFromHost(this.agentHostService);
		this.renderContext.ownedSessionIds = ownedSessionIds;

		// Drop badges for runs no longer enumerated so a stale live badge never outlives its run.
		const present = new Set(rawRuns.map(run => run.runId));
		for (const runId of [...this.badges.keys()]) {
			if (!present.has(runId)) { this.badges.delete(runId); }
		}

		// Refresh the freshness side-table off the RAW set (every enumerated run, not just the displayed ones)
		// BEFORE any tree mutation, so a `rerender()` triggered below always paints the run's CURRENT data (see
		// `IWorkflowRenderContext.runOf`'s doc comment in claudeWorkflowTree.ts).
		this.latestRunByIdentity.clear();
		for (const run of rawRuns) { this.latestRunByIdentity.set(run.identity, run); }

		const query = this.filterQuery.trim();
		const statusFiltered = rawRuns.filter(run => matchesWorkflowStatusFilter(run, this.statusFilter));
		const textFiltered = query.length === 0 ? statusFiltered : statusFiltered.filter(run => matchesWorkflowFilter(run, query));
		const displayedRuns = sortWorkflowRuns(textFiltered, this.sortMode);
		this.currentDisplayedRuns = displayedRuns;

		// Scoped to what is actually DISPLAYED (not the raw snapshot) - the surface label above the tree describes
		// what the tree currently shows.
		this.renderContext.uniformlyForeign = computeUniformlyForeign(displayedRuns, ownedSessionIds);

		// A NON-DEFAULT filter (a non-empty text query, or a status filter narrower than `all`) that matches zero
		// runs drives the existing `no-match` state; a genuinely empty read with no filter applied still reads as
		// `empty` - the two are opposite facts (see `resolveWorkflowsDisplayState`'s own doc comment).
		const filterIsActive = query.length > 0 || this.statusFilter !== WorkflowStatusFilter.All;
		this.filterActive = filterIsActive && displayedRuns.length === 0;

		const displayResult: WorkflowRunListResult = result.state === 'read-error'
			? result
			: result.state === 'partial'
				? { state: 'partial', runs: displayedRuns, message: result.message }
				: { state: 'ok', runs: displayedRuns };
		const state = resolveWorkflowsDisplayState(displayResult, this.filterActive);
		if (state.kind !== 'tree') {
			this.liveIdentities.clear();
			this.runElementsByRunId.clear();
			this.renderedSignatureByRunId.clear();
			// Clear the TREE itself too, not just this bookkeeping: a transient non-tree state (e.g. `read-error`)
			// leaves the tree's own nodes in place while this method's own maps go empty. Without this, the NEXT
			// successful read's `reconcileWorkflowTree` call would see an empty `previous.elementByRunId` for a run
			// the tree still tracks a node for - the top-level identity diff then keeps that OLD (untracked-by-us)
			// node while the reconcile computes `tracked` as a freshly-built (tree-untracked) element instead,
			// and scoping `setChildren`/`rerender` to that untracked element throws. Emptying the tree here keeps
			// it in lockstep with the emptied bookkeeping, so the next reconcile starts from a genuinely clean slate.
			this.tree.setChildren(null, []);
			this.surfaceLabelEl.style.display = 'none';
			this.treeContainer.style.display = 'none';
			this.stateContainer.style.display = '';
			this.stateMessageStore.value = renderWorkflowsStateMessage(this.stateContainer, state, () => this.observationService.readAgain());
			return;
		}
		this.applyTreeSnapshot(state.runs);
	}

	/**
	 * Apply a snapshot that resolved to the `tree` display state - the graduation-aware path. The tree mutation
	 * itself (including its identity-diff subtlety) lives in `reconcileWorkflowTree` (claudeWorkflowTree.ts, exported
	 * so a test can drive it directly); this method captures/restores focus + selection around that call and reacts
	 * to whatever graduated.
	 */
	private applyTreeSnapshot(runs: readonly WorkflowRun[]): void {
		this.stateMessageStore.clear();
		this.stateContainer.style.display = 'none';
		this.treeContainer.style.display = '';

		// Capture focus/selection by STABLE element id first - a raw element reference is exactly what a
		// graduation replaces, but the id (keyed off the run's `identity`, not its kind) survives it.
		const isElement = (e: WorkflowTreeElement | null): e is WorkflowTreeElement => e !== null;
		const focusedIds = new Set(this.tree.getFocus().filter(isElement).map(workflowTreeElementId));
		const selectedIds = new Set(this.tree.getSelection().filter(isElement).map(workflowTreeElementId));

		const result = reconcileWorkflowTree(this.tree, runs, {
			elementByRunId: this.runElementsByRunId,
			liveIdentities: this.liveIdentities,
			renderedSignatureByRunId: this.renderedSignatureByRunId,
		});

		this.runElementsByRunId.clear();
		for (const [runId, element] of result.elementByRunId) { this.runElementsByRunId.set(runId, element); }
		this.liveIdentities.clear();
		for (const identity of result.liveIdentities) { this.liveIdentities.add(identity); }
		this.renderedSignatureByRunId.clear();
		for (const [runId, signature] of result.renderedSignatureByRunId) { this.renderedSignatureByRunId.set(runId, signature); }

		this.restoreFocusAndSelection(focusedIds, selectedIds, result.idToElement);
		this.updateSurfaceOwnershipLabel();
		if (result.graduated.length > 0) { this.announceGraduations(result.graduated); }
	}

	/** Restore focus/selection captured by id BEFORE this snapshot's mutation. An id that no longer resolves to any
	 *  element known this round (e.g. it pointed at a graduated run's old live-progress leaf, which no longer
	 *  exists), or that resolves to an element the tree does not currently track, is simply dropped rather than
	 *  guessed at - `setFocus`/`setSelection` are only called when at least one captured id still resolves to a
	 *  tracked element, so a row this refresh never touched keeps whatever the tree already preserved for it
	 *  natively. The `hasElement` check is belt-and-suspenders against `idToElement` ever handing back an untracked
	 *  reference (see `resolveTrackedElements`'s doc comment in claudeWorkflowTree.ts) - `setFocus`/`setSelection`
	 *  route through `ObjectTreeModel.getNode`, which throws on one. */
	private restoreFocusAndSelection(focusedIds: ReadonlySet<string>, selectedIds: ReadonlySet<string>, idToElement: ReadonlyMap<string, WorkflowTreeElement>): void {
		const hasElement = (element: WorkflowTreeElement) => this.tree.hasElement(element);
		const focus = resolveTrackedElements(focusedIds, idToElement, hasElement);
		if (focus.length > 0) { this.tree.setFocus(focus); }
		const selection = resolveTrackedElements(selectedIds, idToElement, hasElement);
		if (selection.length > 0) { this.tree.setSelection(selection); }
	}

	/** Announce each newly-terminal run: always an `IAccessibilityService.alert()` (an announcement, not an
	 *  animation - fires regardless of motion preference), plus a transient visual highlight on its row, SKIPPED
	 *  entirely when `accessibilityService.isMotionReduced()` - the reduced-motion path. */
	private announceGraduations(newlyTerminal: readonly (TerminalWorkflowRun | UnrecognizedWorkflowRun)[]): void {
		const reduceMotion = this.accessibilityService.isMotionReduced();
		for (const run of newlyTerminal) {
			const label = run.kind === 'terminal' ? (run.summary ?? run.workflowName ?? run.runId) : run.runId;
			this.accessibilityService.alert(run.kind === 'terminal' && run.status === 'failed'
				? localize('clawdius.workflows.graduatedFailed', "Workflow run {0} failed.", label)
				: localize('clawdius.workflows.graduatedDone', "Workflow run {0} finished.", label));

			if (reduceMotion) { continue; }
			this.recentlyGraduated.add(run.identity);
			const element = this.runElementsByRunId.get(run.runId);
			if (element && this.tree.hasElement(element)) { this.tree.rerender(element); }
			// The THIRD argument (not a separate `.add()` call) is what makes this self-evict from
			// `graduationHighlightTimers` the moment it fires - see that field's doc comment.
			disposableTimeout(() => {
				this.recentlyGraduated.delete(run.identity);
				if (element && this.tree.hasElement(element)) { this.tree.rerender(element); }
			}, GRADUATION_HIGHLIGHT_MS, this.graduationHighlightTimers);
		}
	}

	/** The surface ownership label: painted only alongside a non-empty tree, and only while every run in it is
	 *  foreign - dropped the instant ownership can differ (any run resolves owned). Gated on `currentDisplayedRuns`
	 *  (what the tree actually shows after the status/text filter), not the raw `currentRuns` snapshot - a filter
	 *  that hides every foreign run must also hide this label, since there is then nothing foreign ON SCREEN to
	 *  describe. */
	private updateSurfaceOwnershipLabel(): void {
		const show = this.currentDisplayedRuns.length > 0 && this.renderContext.uniformlyForeign;
		this.surfaceLabelEl.style.display = show ? '' : 'none';
		this.surfaceLabelEl.setAttribute('data-clawdius-workflows-surface-ownership', String(show));
	}

	/** Open the RESULT detail editor for a terminal run's story leaf - a SNAPSHOT off the same in-memory
	 *  `TerminalWorkflowRun` the tree already holds (no second seam read; see claudeWorkflowDetailInput.ts). */
	private async openResultDetail(run: TerminalWorkflowRun): Promise<void> {
		const payload: ClaudeWorkflowResultDetailPayload = {
			kind: 'result',
			identity: run.identity,
			runId: run.runId,
			workflowName: run.workflowName,
			status: run.status,
			durationMs: run.durationMs,
			totalTokens: run.totalTokens,
			totalToolCalls: run.totalToolCalls,
			defaultModel: run.defaultModel,
			agentCount: run.agentCount,
			resultText: boundResultText(run.resultText),
		};
		await this.editorService.openEditor(new ClaudeWorkflowDetailInput(payload), { pinned: true, revealIfOpened: true });
	}

	/** Open the AGENT detail editor for one agent row - a SNAPSHOT off the same in-memory `TerminalWorkflowAgent`
	 *  the tree already holds. `transcriptRef` rides along unchanged, so the detail pane's "Open Transcript"
	 *  action is withheld exactly when the tree's own identity join withheld it. */
	private async openAgentDetail(run: TerminalWorkflowRun, agent: TerminalWorkflowAgent): Promise<void> {
		const payload: ClaudeWorkflowAgentDetailPayload = {
			kind: 'agent',
			identity: run.identity,
			runId: run.runId,
			agentId: agent.agentId,
			label: agent.label,
			state: agent.state,
			model: agent.model,
			tokens: agent.tokens,
			toolCalls: agent.toolCalls,
			durationMs: agent.durationMs,
			promptPreview: agent.promptPreview,
			resultPreview: agent.resultPreview,
			error: agent.error,
			transcriptRef: agent.transcriptRef,
		};
		await this.editorService.openEditor(new ClaudeWorkflowDetailInput(payload), { pinned: true, revealIfOpened: true });
	}
}
// CLAWDIUS-END
