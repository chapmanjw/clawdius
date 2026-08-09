/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - Sidebar (Activity Bar) ViewPane
// A native `WorkbenchObjectTree` ViewPane listing the ultracode WORKFLOWS the reader seam enumerates - workflow
// runs, not chat sessions. The top-level list is sourced through the validated root envelope `listWorkflows` (the
// discriminated live/terminal/unknown-shape model + the honest ok/partial/read-error envelope, `common/
// claudeWorkflowModel.ts`) and rendered DIRECTLY through the tree - no bridge back to a legacy row shape, and
// COMPACT: every row is fixed-height, and a run's own summary/result/error text is never inlined into the tree
// (see `claudeWorkflowTree.ts`'s file header comment). A TERMINAL run expands (native tree expansion, collapsed by
// default) to ONLY its phases/agents (grouped under phase nodes only when the run declared more than one - see
// `claudeWorkflowTree.ts`'s `buildTerminalRunChildren`); a live or unknown-shape run has no children. Drill-in
// editors open on `onDidOpen` (Enter or mouse activation, never the twistie/single-click that merely toggles
// expansion): activating a TERMINAL `run` row opens its FULL result, an `agent` row opens its DETAIL - both the
// discriminated `ClaudeWorkflowDetailInput`/`Editor` (`claudeWorkflowDetailInput.ts` /
// `claudeWorkflowDetailEditor.ts`), rendered from the SAME in-memory `TerminalWorkflowRun`/`TerminalWorkflowAgent`
// the tree already holds - no second seam read. An agent's raw transcript is reachable FROM its detail pane (an
// "Open Transcript" action, withheld unless `agent.transcriptRef` is present); a non-terminal `run` and a `phase`
// (a grouping node) never open an editor.
//
// The ownership-chrome rule is split across this file and `claudeWorkflowTree.ts`: `refreshDisplay()` below
// computes `uniformlyForeign` ONCE per re-render (never per-row, off the DISPLAYED runs after the workspace scope
// and the status/text filters) and paints the single SURFACE ownership label above the tree ONLY while every displayed run is foreign;
// the tree's row renderer reads that already-computed signal off a shared mutable context and paints NO per-run
// ownership chrome in the common (uniformly-foreign) case, falling back to a per-run label the instant ownership
// can differ. The view's data source is the `IClaudeWorkflowObservationService` singleton
// (`claudeWorkflowObservationService.ts`), which owns the config-root resolution and the seam read - the view
// itself no longer touches either directly; `refreshDisplay()` re-derives from the last snapshot it HELD
// (`lastResult`) both on a fresh snapshot and on a filter/sort/status/scope change (including a workspace-folder
// add or remove), so none of the latter ever waits on a new one (the persistent find/sort view state - see the
// "find/sort" block below the view id exports).
//
// READ-ONLY BY CONSTRUCTION, not by policy. The view observes; it cannot act on a workflow run. Clawdius holds a
// live `Query` only for a session IT launched, so a run launched by the Claude Code CLI - which today is every
// run on disk - has no handle to stop or steer. A control surface here would be unreachable, so there is
// none. Launching workflows from Clawdius is a future direction that would make controls meaningful; until then
// the honest product is an observatory. The read-error state's "Read again" affordance is a RE-READ of the same
// enumeration (`observationService.readAgain()`), never a run control.

import './media/claudeWorkflows.css';
import { $, append, Dimension } from '../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectOptionItem, SelectBox } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { Toggle } from '../../../../../base/browser/ui/toggle/toggle.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { disposableTimeout, RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
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
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { defaultInputBoxStyles, defaultSelectBoxStyles, defaultToggleStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	DEFAULT_WORKFLOW_WORKSPACE_SCOPE, isWorkflowWorkspaceScope, LiveWorkflowRun, matchesWorkflowWorkspaceScope,
	TerminalWorkflowAgent, TerminalWorkflowRun, UnrecognizedWorkflowRun, WorkflowRun, WorkflowRunListResult,
	WorkflowWorkspaceScope,
} from '../../common/claudeWorkflowModel.js';
import { BadgeSignal, ClaudeWorkflowBadgeFeed } from './claudeWorkflowBadges.js';
import { boundResultText, ClaudeWorkflowAgentDetailPayload, ClaudeWorkflowDetailInput, ClaudeWorkflowResultDetailPayload } from './claudeWorkflowDetailInput.js';
import {
	IClaudeWorkflowObservationService, WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY, WORKFLOWS_VIEW_CONTAINER_ID,
	workflowWorkspaceProjectKeys, WorkflowSnapshot,
} from './claudeWorkflowObservationService.js';
import { ownedSessionIdsFromHost } from './claudeWorkflowOwnership.js';
import {
	computeUniformlyForeign, IWorkflowRenderContext, IWorkflowsEmptyDiagnosis, reconcileWorkflowTree,
	renderWorkflowsStateMessage, resolveTrackedElements, resolveWorkflowsDisplayState, WorkflowAgentRowRenderer,
	WorkflowPhaseRowRenderer, WorkflowRunRowRenderer,
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
// The workspace-scope vocabulary and its predicate now live in the pure `common/` read model (see the "workspace
// scope" block in claudeWorkflowModel.ts for why: the observation service scopes the container's activity badge
// with the SAME predicate and cannot import it from here). Re-exported so the existing callers that reach for them
// through this module - the view's own filter/sort unit tests - keep working unchanged.
export { matchesWorkflowWorkspaceScope, WorkflowWorkspaceScope };
// PRESERVED for backward compat: this is the view id VS Code persists (panel/sidebar placement, visibility,
// size) across restarts. It must NOT change with the rename, or a pre-rename user's restored view state for
// this view would fail to restore - the same backward-compat rationale as the transcript editor-input-serializer
// typeId.
export const WORKFLOWS_VIEW_ID = 'clawdius.missions';

// --- find/sort: the workspace scope, the text filter, the status-category filter, and the sort modes ------------
//
// EXPORTED as pure functions (never methods) so a unit test drives them directly, without constructing the view.
// The view composes them in `refreshDisplay()`: WORKSPACE SCOPE -> status filter -> text filter -> sort, in that
// order. All four are pure predicates, so the RESULT SET is order-independent; the order is a statement about
// meaning and cost. Scope runs first because it is the only stage that asks whether a run is in the developer's
// world at ALL, rather than whether its content matches - so the two content filters, the sort's live-pin,
// `computeUniformlyForeign`, and the surface-ownership label all operate on exactly the set the developer considers
// theirs. It is also the cheapest (one lowercased `Set.has` per run, versus `matchesWorkflowFilter`'s walk over
// name/summary/error/every agent label). Sort stays LAST: a LIVE run is therefore pinned first only AMONG MATCHES
// (`sortWorkflowRuns` never even sees a run any filter already dropped) and is excluded outright the moment its own
// runId fails the text filter; there is no separate "force-show a live run" path layered on top.

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

/** The status control's option ORDER - the single source both the control's index-aligned options array and every
 *  value->index lookup read (the restore-from-storage seed, and the "Clear Filters" action's resync), so a selected
 *  index can never mean two things. Same shape as {@link WORKFLOW_WORKSPACE_SCOPE_ORDER}. */
const WORKFLOW_STATUS_FILTER_ORDER: readonly WorkflowStatusFilter[] = [
	WorkflowStatusFilter.All, WorkflowStatusFilter.Live, WorkflowStatusFilter.Completed, WorkflowStatusFilter.Failed,
];

/** The localized label for one status-filter option. EXHAUSTIVE over the enum, so adding a category is a compile
 *  error here rather than a silently unlabeled option. */
function workflowStatusFilterLabel(filter: WorkflowStatusFilter): string {
	switch (filter) {
		case WorkflowStatusFilter.All: return localize('clawdius.workflows.statusFilter.all', "All Statuses");
		case WorkflowStatusFilter.Live: return localize('clawdius.workflows.statusFilter.live', "Live");
		case WorkflowStatusFilter.Completed: return localize('clawdius.workflows.statusFilter.completed', "Completed");
		case WorkflowStatusFilter.Failed: return localize('clawdius.workflows.statusFilter.failed', "Failed");
	}
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

/** The scope control's option ORDER - the single source both the control's index-aligned options array and
 *  `updateWorkspaceScopeControl`'s value->index lookup read, so a selected index can never mean two things. */
const WORKFLOW_WORKSPACE_SCOPE_ORDER: readonly WorkflowWorkspaceScope[] = [
	WorkflowWorkspaceScope.ThisWorkspace, WorkflowWorkspaceScope.AllWorkspaces,
];

/** The localized label for one workspace-scope option. EXHAUSTIVE over the enum, so adding a scope is a compile
 *  error here rather than a silently unlabeled option. */
function workflowWorkspaceScopeLabel(scope: WorkflowWorkspaceScope): string {
	switch (scope) {
		case WorkflowWorkspaceScope.ThisWorkspace: return localize('clawdius.workflows.scope.this', "This Workspace");
		case WorkflowWorkspaceScope.AllWorkspaces: return localize('clawdius.workflows.scope.all', "All Workspaces");
	}
}

/**
 * Whether a control HIDDEN behind the collapsed filter button is currently NARROWING the list - what drives the
 * button's filled-vs-outline icon, so a narrowed list is never silently narrowed.
 *
 * The two dimensions are probed ASYMMETRICALLY, and deliberately so. The STATUS filter is probed by
 * non-default-ness: its default (`all`) hides nothing, so any other value is the developer's own explicit
 * narrowing. The WORKSPACE SCOPE cannot be probed that way, because its DEFAULT (`this-workspace`) is the value
 * that withholds - lighting the icon for `all-workspaces` would light it on the one setting that hides nothing and
 * leave it dark on the shipped default that does. So the caller passes `scopeIsWithholding`: whether the scope
 * stage actually dropped a run this render.
 *
 * The SORT MODE is excluded entirely: sorting reorders and never hides, and an indicator that lit up for a sort
 * choice would claim runs are being withheld when none are.
 */
export function workflowFiltersAreNarrowing(statusFilter: WorkflowStatusFilter, scopeIsWithholding: boolean): boolean {
	return statusFilter !== WorkflowStatusFilter.All || scopeIsWithholding;
}

/**
 * The filter button's accessible NAME (and its hover text - `Toggle.setTitle` writes both), carrying the narrowing
 * fact as a WORD rather than only as the filled-vs-outline glyph.
 *
 * The glyph alone cannot carry it: while the panel is collapsed its three SelectBoxes are `display: none`, so they
 * are gone from the accessibility tree entirely (by design - see claudeWorkflows.css) and this button is the only
 * surviving trace of a status filter or a workspace scope that is withholding runs. An icon swap is a CSS class
 * change and touches no ARIA, so without this the button would announce identically whether it hides three runs or
 * three hundred - strictly less than the always-visible dropdowns it replaced told a screen-reader user.
 *
 * DISCLOSURE state is deliberately NOT in here: expanded/collapsed belongs in `aria-expanded` (see
 * `applyFiltersExpansion`), and the two are independent facts.
 */
function workflowFiltersToggleTitle(narrowing: boolean): string {
	return narrowing
		? localize('clawdius.workflows.filters.toggle.narrowing', "Filter Options (Filters Applied)")
		: localize('clawdius.workflows.filters.toggle', "Filter Options");
}

// --- persisted view state ---------------------------------------------------------------------------------------
//
// Four keys, named after the in-feature precedent (`FAILURE_WATERMARK_STORAGE_KEY` in
// claudeWorkflowObservationService.ts). Each is written on CHANGE, never from `saveState()`: `ViewPane.saveState()`
// fires only from its container's `onWillSaveState`, so a crash or hard kill loses the setting, and a container the
// developer never opened never writes at all. Store-on-change is the shipped shape.
//
// The free-text query is deliberately NOT among them: it stays session-only, exactly as today.

/** The persisted expanded/collapsed state of the toolbar's dropdown panel. PROFILE/USER: a chrome preference about
 *  how this pane is read, identical in every window, and worth roaming with settings sync. */
const WORKFLOW_FILTERS_EXPANDED_STORAGE_KEY = 'clawdius.ultracodeWorkflows.filtersExpanded.v1';
/** The persisted status-category filter. PROFILE/USER, for the same reason: "show me only failures" is a reading
 *  habit, not a fact about one project. */
const WORKFLOW_STATUS_FILTER_STORAGE_KEY = 'clawdius.ultracodeWorkflows.statusFilter.v1';
/** The persisted sort mode. PROFILE/USER, same reasoning. */
const WORKFLOW_SORT_MODE_STORAGE_KEY = 'clawdius.ultracodeWorkflows.sortMode.v1';
//
// The FOURTH key - the persisted workspace scope - is `WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY`, defined in
// claudeWorkflowObservationService.ts and imported above. It is the only one of the four the service also reads
// (it scopes the container's activity badge by the same value this pane scopes its list by), and a storage key is
// not pure enough for `common/`, so it follows the same placement precedent as `WORKFLOWS_VIEW_CONTAINER_ID`:
// defined in the service, consumed here, never the reverse edge. See its own doc comment there for the
// WORKSPACE/USER scope-and-target reasoning.

/** The collapsible dropdown panel's DOM id, referenced by the disclosure toggle's `aria-controls`. There is exactly
 *  one instance of this view per window, so a stable literal id is unambiguous. */
const WORKFLOW_FILTERS_PANEL_DOM_ID = 'clawdius-workflows-filters';

/** Whether a persisted string is a value this build's status filter actually offers - a stored value from a newer
 *  (or corrupt) profile reads as "never stored" and falls back to the default, never as a filter nothing matches. */
function isWorkflowStatusFilter(value: string | undefined): value is WorkflowStatusFilter {
	return value === WorkflowStatusFilter.All || value === WorkflowStatusFilter.Live
		|| value === WorkflowStatusFilter.Completed || value === WorkflowStatusFilter.Failed;
}

/** As {@link isWorkflowStatusFilter}, for the sort mode. */
function isWorkflowSortMode(value: string | undefined): value is WorkflowSortMode {
	return value === WorkflowSortMode.Recency || value === WorkflowSortMode.Cost || value === WorkflowSortMode.Status;
}

// The third member of that family - `isWorkflowWorkspaceScope` - lives beside the scope enum in
// claudeWorkflowModel.ts and is imported above: the observation service validates the SAME stored value with it
// before scoping the badge, and one shared guard is what keeps the two from ever disagreeing about whether a
// stored string is a scope at all.

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

	/** The RAW runs from the last applied snapshot (before the scope/status-filter/text-filter/sort derivation
	 *  below) - correlated against by the live badge feed, so a badge for a run the current filter or workspace
	 *  scope happens to hide is still tracked and ready the instant that run becomes visible again. See
	 *  `currentDisplayedRuns` for what the tree actually shows. */
	private currentRuns: readonly WorkflowRun[] = [];
	/** The authoritative live badges per run; read by the run-row renderer at render time via `renderContext`. */
	private readonly badges = new Map<string, BadgeSignal>();
	/** The live needs-input/completion badge feed (created in renderBody, disposed with the view). */
	private badgeFeed: ClaudeWorkflowBadgeFeed | undefined;
	/** The SESSION-ONLY free-text filter query (see `matchesWorkflowFilter`), updated on every InputBox keystroke;
	 *  the (debounced) re-render it drives runs through `filterDebounceScheduler`, never per-keystroke. Deliberately
	 *  not persisted - a restored query would silently narrow the pane with no visible cause on the next launch. */
	private filterQuery = '';
	/** The PERSISTED status-category filter (see `matchesWorkflowStatusFilter`) driven by the toolbar's status
	 *  SelectBox - applied immediately on change (a discrete selection, not something to debounce). */
	private statusFilter: WorkflowStatusFilter = WorkflowStatusFilter.All;
	/** The PERSISTED sort mode (see `sortWorkflowRuns`) driven by the toolbar's sort SelectBox. Newest-first is
	 *  the default: with hundreds of runs, the most recently active ones are the most likely starting point. */
	private sortMode: WorkflowSortMode = WorkflowSortMode.Recency;
	/** The PERSISTED workspace scope (see `matchesWorkflowWorkspaceScope`), driven by the toolbar's scope SelectBox
	 *  and by the out-of-scope state's one-click widen. Seeded from the SHARED default the observation service also
	 *  falls back to, so a fresh profile cannot have the badge counting one set of runs while this pane lists
	 *  another. */
	private workspaceScope: WorkflowWorkspaceScope = DEFAULT_WORKFLOW_WORKSPACE_SCOPE;
	/** Whether the toolbar's dropdown panel is expanded. Restored from storage in the constructor; COLLAPSED is the
	 *  default on a fresh profile - the free-text filter is the everyday control, the three dropdowns are not. */
	private filtersExpanded = false;
	/** Whether the workspace-scope stage ACTUALLY dropped a run on the last `refreshDisplay()` - the honest input to
	 *  `workflowFiltersAreNarrowing` (see that function for why the scope cannot be probed by non-default-ness).
	 *  Recomputed on every refresh; never toggled directly. */
	private scopeIsWithholding = false;
	/** The LAST dimension the split view handed `layoutBody` - held so expanding/collapsing the filter panel (a
	 *  chrome-height change the split view never observes) can re-run the body sizing on demand. */
	private lastBodyDimension: Dimension | undefined;
	/** The raw envelope from the LAST applied observation-service snapshot - held so a filter/sort/status/scope
	 *  change alone (or a workspace-folder add or remove) can re-derive the displayed runs and re-render WITHOUT
	 *  waiting for the next snapshot (the find/sort surface's persistent-view-state requirement). `undefined` until
	 *  the view's first snapshot arrives. */
	private lastResult: WorkflowRunListResult | undefined;
	/** The runs actually shown on the last render, AFTER the workspace scope, status filter, text filter, and sort
	 *  mode all applied - distinct from `currentRuns` (see that field's doc comment). Used by
	 *  `updateSurfaceOwnershipLabel` to gate the surface label on what is actually visible, not on the full
	 *  unfiltered snapshot. */
	private currentDisplayedRuns: readonly WorkflowRun[] = [];

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
	/** Clears a graduated run's transient highlight after `GRADUATION_HIGHLIGHT_MS`. Passed as `disposableTimeout`'s
	 *  own `store` argument (below) rather than `.add()`-ed after the fact, so a FIRED timer is automatically
	 *  evicted from this store the moment it runs - never held for the rest of the view's life, which an unbounded
	 *  `DisposableStore.add()` with no matching removal would otherwise do over a long session. */
	private readonly graduationHighlightTimers = this._register(new DisposableStore());
	/** Fires `refreshDisplay()` `FILTER_DEBOUNCE_MS` after the LAST scheduling call - `RunOnceScheduler.schedule()`
	 *  reschedules a still-pending timer rather than stacking a second one, which is what turns a burst of
	 *  keystrokes into exactly one re-render. */
	private readonly filterDebounceScheduler = this._register(new RunOnceScheduler(() => this.refreshDisplay(), FILTER_DEBOUNCE_MS));

	private purposeLabelEl!: HTMLElement;
	private surfaceLabelEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private filtersPanelEl!: HTMLElement;
	private stateContainer!: HTMLElement;
	private treeContainer!: HTMLElement;
	private tree!: WorkbenchObjectTree<WorkflowTreeElement, FuzzyScore>;
	private filterInput!: InputBox;
	private filtersToggle!: Toggle;
	private statusFilterSelect!: SelectBox;
	private sortModeSelect!: SelectBox;
	private workspaceScopeSelect!: SelectBox;

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
		// APPENDED at the end of the decorated list, deliberately: VS Code's DI records dependency indices
		// POSITIONALLY, so inserting a service mid-list would misbind every parameter after it.
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		// Restore the persisted view state HERE, before `renderBody`: `renderToolbar` seeds each control's selected
		// index from these fields, and the first `refreshDisplay()` (driven by `applySnapshot` inside `renderBody`)
		// must already be filtering by the restored values rather than by the declared defaults.
		this.filtersExpanded = this.storageService.getBoolean(WORKFLOW_FILTERS_EXPANDED_STORAGE_KEY, StorageScope.PROFILE, false);
		const storedStatus = this.storageService.get(WORKFLOW_STATUS_FILTER_STORAGE_KEY, StorageScope.PROFILE);
		if (isWorkflowStatusFilter(storedStatus)) { this.statusFilter = storedStatus; }
		const storedSort = this.storageService.get(WORKFLOW_SORT_MODE_STORAGE_KEY, StorageScope.PROFILE);
		if (isWorkflowSortMode(storedSort)) { this.sortMode = storedSort; }
		const storedScope = this.storageService.get(WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (isWorkflowWorkspaceScope(storedScope)) { this.workspaceScope = storedScope; }
		this.renderContext = {
			uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: runId => this.badges.get(runId),
			runOf: identity => this.latestRunByIdentity.get(identity),
			justGraduated: identity => this.recentlyGraduated.has(identity),
		};
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('clawdius-workflows');

		// A short, always-shown purpose line, above the exception-only foreign-ownership caveat below. Hidden the
		// instant the surface label shows (see `updateSurfaceOwnershipLabel`) - the two lines otherwise say the same
		// "read-only, observed from Claude Code on disk" thing back-to-back (item 19).
		this.purposeLabelEl = append(container, $('.clawdius-workflows-purpose-label'));
		this.purposeLabelEl.textContent = localize('clawdius.workflows.purpose', "Ultracode workflow runs observed from Claude Code, read-only.");

		// The single surface ownership label: shown only while every currently-enumerated run is foreign (see
		// `updateSurfaceOwnershipLabel`), dropped the instant ownership can differ.
		this.surfaceLabelEl = append(container, $('.clawdius-workflows-surface-label'));
		this.surfaceLabelEl.textContent = localize('clawdius.workflows.surfaceForeign', "These runs are read-only — Clawdius is observing them from Claude Code on disk.");
		this.surfaceLabelEl.style.display = 'none';

		// The persistent filter/status-filter/sort toolbar, mounted ABOVE the tree/state pair (never inside it),
		// so a filter that produced the `no-match` state stays reachable to clear or change.
		this.renderToolbar(container);

		// The four-state message overlay and the tree container are mutually exclusive - exactly one of
		// them is visible at a time, and the TREE is the only one of the two that ever scrolls internally.
		this.stateContainer = append(container, $('.clawdius-workflows-state'));
		this.stateContainer.style.display = 'none';
		this.treeContainer = append(container, $('.clawdius-workflows-tree'));

		const hoverDelegate = this._register(this.instantiationService.createInstance(WorkbenchHoverDelegate, 'element', undefined, {}));

		const runRenderer = this._register(new WorkflowRunRowRenderer(this.renderContext, hoverDelegate));
		const phaseRenderer = new WorkflowPhaseRowRenderer();
		const agentRenderer = this._register(new WorkflowAgentRowRenderer(hoverDelegate));

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<WorkflowTreeElement, FuzzyScore>,
			'ClawdiusWorkflowsTree',
			this.treeContainer,
			new WorkflowTreeVirtualDelegate(),
			[runRenderer, phaseRenderer, agentRenderer],
			{
				identityProvider: new WorkflowTreeIdentityProvider(),
				accessibilityProvider: new WorkflowTreeAccessibilityProvider(this.renderContext),
				keyboardNavigationLabelProvider: new WorkflowTreeKeyboardNavigationLabelProvider(),
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				collapseByDefault: true,
				// Item 17: a phase/agent row's parentage under its run is otherwise legible only from indentation
				// alone - an on-hover indent guide makes that nesting unambiguous without adding permanent visual
				// noise to every row.
				renderIndentGuides: RenderIndentGuides.OnHover,
				overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			},
		));

		// Drill-in activation: `onDidOpen` fires for BOTH Enter and mouse activation, never the twistie/single-click
		// that merely toggles expansion. A TERMINAL `run` element opens the run's full RESULT detail (a live run has
		// no terminal result to show, so it opens nothing); an `agent` element opens that agent's DETAIL. `phase` (a
		// grouping node) never opens an editor.
		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element) { return; }
			if (element.kind === 'run' && element.run.kind === 'terminal') {
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

		// A folder add/remove changes only the workspace-scope PREDICATE, never the runs on disk - so re-derive from
		// the snapshot already held (`refreshDisplay`), never `observationService.readAgain()`, which would re-walk
		// the whole config root for data that did not change. Resyncing the control first also covers the
		// last-folder-closed case, where the effective scope falls back to All Workspaces. Nothing is persisted here:
		// the stored value is the developer's chosen enum, never a resolved folder set.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.updateWorkspaceScopeControl();
			this.refreshDisplay();
		}));

		// Awareness: mark known failures seen whenever the developer actually looks at this surface - on focus,
		// and whenever the view's body becomes visible (opened, expanded, or brought to the foreground), never on
		// becoming hidden. Clears the container's unseen-failure badge without waiting for a fresh read.
		this._register(this.onDidFocus(() => this.observationService.markFailuresSeen()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) { this.observationService.markFailuresSeen(); }
		}));
	}

	/**
	 * The toolbar: an ALWAYS-VISIBLE row carrying the free-text filter InputBox plus the disclosure toggle, and a
	 * COLLAPSIBLE panel beneath it holding the status-filter, sort-mode and workspace-scope SelectBoxes stacked one
	 * per row. Only the dropdowns collapse - a hidden text box would hide a filter that is actively narrowing the
	 * list with no way to see or clear it.
	 *
	 * All four controls drive PERSISTED view state except the query (`filtersExpanded`/`statusFilter`/`sortMode`/
	 * `workspaceScope` persist; `filterQuery` is session-only). A change to any of them re-derives the displayed
	 * runs from `lastResult` (the last-HELD snapshot) via `refreshDisplay()` immediately - never waiting for the
	 * next observation-service snapshot. Only the free-text input is debounced (`filterDebounceScheduler`); a
	 * SelectBox fires a discrete selection event, not a keystroke stream, so it re-renders immediately.
	 */
	private renderToolbar(container: HTMLElement): void {
		this.toolbarEl = append(container, $('.clawdius-workflows-toolbar'));

		const row = append(this.toolbarEl, $('.clawdius-workflows-toolbar-row'));
		const filterContainer = append(row, $('.clawdius-workflows-filter'));
		this.filterInput = this._register(new InputBox(filterContainer, this.contextViewService, {
			// Item 16: kept SHORT (never the full "name, summary, agent, or error" corpus this filter actually
			// searches - see matchesWorkflowFilter/the ariaLabel below) so it never clips mid-word at the sidebar's
			// narrower widths.
			placeholder: localize('clawdius.workflows.filter.placeholder', "Filter by name, agent, or error"),
			ariaLabel: localize('clawdius.workflows.filter.ariaLabel', "Filter Claude Code workflow runs by name, summary, run ID, agent, or error"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(this.filterInput.onDidChange(value => {
			this.filterQuery = value;
			this.filterDebounceScheduler.schedule();
		}));

		// The collapsible panel is built (and its three controls rendered into it) BEFORE the toggle references it
		// by id, and stays MOUNTED whether expanded or not: `SelectBox.render()` APPENDS its `<select>` on every
		// call, so disposing and re-rendering on collapse would stack duplicate elements. CSS alone hides it - see
		// `applyFiltersExpansion`.
		this.filtersPanelEl = append(this.toolbarEl, $('.clawdius-workflows-filters'));
		this.filtersPanelEl.id = WORKFLOW_FILTERS_PANEL_DOM_ID;

		this.filtersToggle = this._register(new Toggle({
			icon: Codicon.filter,
			// Doubles as the accessible NAME (`Toggle.setTitle` writes aria-label) and the hover tooltip (wired
			// inside the widget through the base-layer hover delegate - never a second IHoverService call). Seeded
			// with the not-narrowing wording; `applyFiltersExpansion()` at the end of this method immediately
			// re-derives it (and the icon) from the restored filter state - see `updateFiltersToggleNarrowing`.
			title: workflowFiltersToggleTitle(false),
			isChecked: this.filtersExpanded,
			actionClassName: 'clawdius-workflows-filter-toggle',
			...defaultToggleStyles,
		}));
		append(row, this.filtersToggle.domNode);
		this.filtersToggle.domNode.setAttribute('aria-controls', WORKFLOW_FILTERS_PANEL_DOM_ID);
		this._register(this.filtersToggle.onChange(() => {
			this.filtersExpanded = this.filtersToggle.checked;
			this.storageService.store(WORKFLOW_FILTERS_EXPANDED_STORAGE_KEY, this.filtersExpanded, StorageScope.PROFILE, StorageTarget.USER);
			this.applyFiltersExpansion();
			// The toolbar just grew or shrank by three rows and NOTHING outside the pane body observes that -
			// `layoutBody` is reachable only from the split view's own `Pane.layout`. Re-run the sizing ourselves.
			this.relayoutBodyContent();
		}));

		// The status-category filter - index-aligned with `WORKFLOW_STATUS_FILTER_ORDER`, the single source both this
		// options array and every value->index lookup read, so a selected index can never mean two things.
		const statusFilterContainer = append(this.filtersPanelEl, $('.clawdius-workflows-status-filter'));
		this.statusFilterSelect = this._register(new SelectBox(
			WORKFLOW_STATUS_FILTER_ORDER.map((filter): ISelectOptionItem => ({ text: workflowStatusFilterLabel(filter) })),
			Math.max(0, WORKFLOW_STATUS_FILTER_ORDER.indexOf(this.statusFilter)),
			this.contextViewService, defaultSelectBoxStyles,
			{ ariaLabel: localize('clawdius.workflows.statusFilter.ariaLabel', "Filter workflow runs by status"), useCustomDrawn: true },
		));
		this.statusFilterSelect.render(statusFilterContainer);
		this._register(this.statusFilterSelect.onDidSelect(e => {
			this.persistStatusFilter(WORKFLOW_STATUS_FILTER_ORDER[e.index] ?? WorkflowStatusFilter.All);
			this.refreshDisplay();
		}));

		// The sort mode - same index-aligned-array shape as the status filter above. No toggle-icon update on
		// change: sorting reorders and never hides (see `workflowFiltersAreNarrowing`).
		const sortModeOptions: readonly { readonly value: WorkflowSortMode; readonly label: string }[] = [
			{ value: WorkflowSortMode.Recency, label: localize('clawdius.workflows.sort.recency', "Sort: Newest First") },
			{ value: WorkflowSortMode.Cost, label: localize('clawdius.workflows.sort.cost', "Sort: Highest Cost") },
			{ value: WorkflowSortMode.Status, label: localize('clawdius.workflows.sort.status', "Sort: Failed First") },
		];
		const sortContainer = append(this.filtersPanelEl, $('.clawdius-workflows-sort'));
		this.sortModeSelect = this._register(new SelectBox(
			sortModeOptions.map((option): ISelectOptionItem => ({ text: option.label })),
			Math.max(0, sortModeOptions.findIndex(option => option.value === this.sortMode)),
			this.contextViewService, defaultSelectBoxStyles,
			{ ariaLabel: localize('clawdius.workflows.sort.ariaLabel', "Sort workflow runs"), useCustomDrawn: true },
		));
		this.sortModeSelect.render(sortContainer);
		this._register(this.sortModeSelect.onDidSelect(e => {
			this.sortMode = sortModeOptions[e.index]?.value ?? WorkflowSortMode.Recency;
			this.storageService.store(WORKFLOW_SORT_MODE_STORAGE_KEY, this.sortMode, StorageScope.PROFILE, StorageTarget.USER);
			this.refreshDisplay();
		}));

		// The workspace scope - index-aligned with `WORKFLOW_WORKSPACE_SCOPE_ORDER`, the single source both this
		// options array and `updateWorkspaceScopeControl`'s value->index lookup read.
		const scopeContainer = append(this.filtersPanelEl, $('.clawdius-workflows-workspace-scope'));
		this.workspaceScopeSelect = this._register(new SelectBox(
			WORKFLOW_WORKSPACE_SCOPE_ORDER.map((scope): ISelectOptionItem => ({ text: workflowWorkspaceScopeLabel(scope) })),
			Math.max(0, WORKFLOW_WORKSPACE_SCOPE_ORDER.indexOf(this.workspaceScope)),
			this.contextViewService, defaultSelectBoxStyles,
			{
				ariaLabel: localize('clawdius.workflows.scope.ariaLabel', "Limit workflow runs to the open workspace"),
				// `useCustomDrawn: true` UNCONDITIONALLY on all three, not the `!hasNativeContextMenu(...)` idiom
				// used for context-menu parity elsewhere: that flag resolves FALSE on a default macOS install, which
				// would put macOS on the NATIVE `<select>` - and a native select does not reliably honor an author
				// `height`, which is exactly what makes these three the same height as the InputBox beside them in a
				// stacked panel. Uniform control height in this panel is the requirement; a themed dropdown that
				// matches the rest of the pane is the bonus.
				useCustomDrawn: true,
			},
		));
		this.workspaceScopeSelect.render(scopeContainer);
		this._register(this.workspaceScopeSelect.onDidSelect(e => {
			this.setWorkspaceScope(WORKFLOW_WORKSPACE_SCOPE_ORDER[e.index] ?? WorkflowWorkspaceScope.ThisWorkspace);
		}));

		this.applyFiltersExpansion();
		this.updateWorkspaceScopeControl();
	}

	/** Paint the expansion state: ONE `expanded` class on the toolbar root drives the panel's own display (in CSS),
	 *  and the toggle is re-declared as a DISCLOSURE. `Toggle` ships the CHECKBOX contract - `role="checkbox"` plus
	 *  an `aria-checked` that its own `checked` setter re-writes on every flip - which is the wrong pattern for a
	 *  show/hide panel, so the role becomes `button` with `aria-expanded`, and the stale `aria-checked` is removed
	 *  on every pass (the setter will have just put it back). */
	private applyFiltersExpansion(): void {
		this.toolbarEl.classList.toggle('expanded', this.filtersExpanded);
		const node = this.filtersToggle.domNode;
		node.setAttribute('role', 'button');
		node.setAttribute('aria-expanded', String(this.filtersExpanded));
		node.removeAttribute('aria-checked');
		this.updateFiltersToggleNarrowing();
	}

	/** The filter button's two INDEPENDENT signals, deliberately kept apart. `Toggle.checked` (and the themed active
	 *  background it paints) tracks EXPANDED - the ordinary pressed-disclosure affordance. The NARROWING signal
	 *  tracks whether a control behind the button is actually withholding runs (`workflowFiltersAreNarrowing`), so a
	 *  COLLAPSED panel can still say "I am hiding runs from you". The two therefore diverge by design: a filled icon
	 *  on an unpressed button is the important case, not a rendering bug - it is the whole reason the indicator
	 *  exists.
	 *
	 *  The narrowing signal is painted TWICE, in two different channels, because neither reaches everyone: the glyph
	 *  (`setIcon`, a CSS class swap that touches no ARIA) for sighted users, and the accessible NAME
	 *  (`setTitle`, which writes `aria-label` and the hover text) for everyone else - see
	 *  `workflowFiltersToggleTitle` for why the glyph alone would leave a screen-reader user with no signal at all. */
	private updateFiltersToggleNarrowing(): void {
		const narrowing = workflowFiltersAreNarrowing(this.statusFilter, this.scopeIsWithholding);
		this.filtersToggle.setIcon(narrowing ? Codicon.filterFilled : Codicon.filter);
		this.filtersToggle.setTitle(workflowFiltersToggleTitle(narrowing));
	}

	/** Adopt a new workspace scope from EITHER the dropdown or the out-of-scope state's one-click widen action, so
	 *  both routes persist, resync the control, and re-derive identically. Re-entrant by construction on the widen
	 *  path (the button lives inside the state message this `refreshDisplay` then replaces): the message is fully
	 *  built before the old `DisposableStore` is disposed, and the emitter tolerates listener removal mid-delivery. */
	private setWorkspaceScope(scope: WorkflowWorkspaceScope): void {
		this.workspaceScope = scope;
		this.storageService.store(WORKFLOW_WORKSPACE_SCOPE_STORAGE_KEY, scope, StorageScope.WORKSPACE, StorageTarget.USER);
		this.updateWorkspaceScopeControl();
		this.refreshDisplay();
	}

	/** Adopt (and persist) a new status filter. The RE-DERIVE is the caller's, not this method's: the dropdown path
	 *  re-derives immediately, while `clearContentFilters` defers until it has also cleared the query, so those two
	 *  changes produce ONE render instead of two. The control resync is likewise the caller's - the dropdown is
	 *  already showing its own new value. */
	private persistStatusFilter(filter: WorkflowStatusFilter): void {
		this.statusFilter = filter;
		this.storageService.store(WORKFLOW_STATUS_FILTER_STORAGE_KEY, filter, StorageScope.PROFILE, StorageTarget.USER);
	}

	/** The `no-match` state's one-click escape: reset BOTH content filters (the persisted status filter and the
	 *  session-only query) and re-derive once. Without it that state is a dead end - the status filter it blames
	 *  survives a restart and, with the panel collapsed, is not on screen at all to be seen or cleared. */
	private clearContentFilters(): void {
		this.persistStatusFilter(WorkflowStatusFilter.All);
		this.statusFilterSelect.select(Math.max(0, WORKFLOW_STATUS_FILTER_ORDER.indexOf(WorkflowStatusFilter.All)));
		// Assigning `InputBox.value` fires its own `onDidChange`, which schedules the debounced refresh - so clear
		// the field FIRST, then cancel that pending timer, so this method's own single re-derive is the only one.
		this.filterInput.value = '';
		this.filterQuery = '';
		this.filterDebounceScheduler.cancel();
		this.refreshDisplay();
		this.focusAfterStateAction();
	}

	/** Move focus deliberately after a state-message action RESOLVED the state that carried its button.
	 *
	 *  `refreshDisplay` -> `applyTreeSnapshot` sets `stateContainer.style.display = 'none'` synchronously in this
	 *  same call stack, while the activating Button is still inside it - and a `display: none` subtree cannot hold
	 *  focus, so the browser silently resets `activeElement` to `<body>` and the keyboard user's next Tab restarts
	 *  from the top of the whole workbench. The tree that replaced the message is the right landing place; a message
	 *  that merely became a DIFFERENT message (the tree is still hidden) hands focus back to the filter toggle. The
	 *  `alert` is what makes the OUTCOME perceivable without sight - the list silently repopulating is exactly what
	 *  a screen-reader user cannot see. */
	private focusAfterStateAction(): void {
		if (this.treeContainer.style.display === 'none') {
			this.filtersToggle.focus();
			return;
		}
		this.tree.domFocus();
		this.accessibilityService.alert(this.currentDisplayedRuns.length === 1
			? localize('clawdius.workflows.nowShowing.one', "Showing 1 workflow run.")
			: localize('clawdius.workflows.nowShowing.many', "Showing {0} workflow runs.", this.currentDisplayedRuns.length));
	}

	/** Sync the scope control with BOTH the stored preference and the runtime fact that there may be no folder to
	 *  scope to. With zero folders the control switches to All Workspaces and is DISABLED: the effective scope
	 *  really is All Workspaces (see `matchesWorkflowWorkspaceScope`), and a control still reading "This Workspace"
	 *  while every run is shown would be a lie on screen. The stored preference is never written here, so opening a
	 *  folder restores whatever the developer actually chose. */
	private updateWorkspaceScopeControl(): void {
		const scoped = workflowWorkspaceProjectKeys(this.workspaceContextService).size > 0;
		const effective = scoped ? this.workspaceScope : WorkflowWorkspaceScope.AllWorkspaces;
		this.workspaceScopeSelect.select(Math.max(0, WORKFLOW_WORKSPACE_SCOPE_ORDER.indexOf(effective)));
		this.workspaceScopeSelect.setEnabled(scoped);
		this.workspaceScopeSelect.setAriaLabel(scoped
			? localize('clawdius.workflows.scope.ariaLabel', "Limit workflow runs to the open workspace")
			: localize('clawdius.workflows.scope.ariaLabelNoFolder', "Workspace scope is unavailable. No folder is open, so runs from every workspace are shown."));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastBodyDimension = new Dimension(width, height);
		this.sizeBodyContent(width, height);
	}

	/**
	 * Size the tree/state pair to the body height MINUS the chrome stacked above them. The three chrome elements are
	 * all `flex: 0 0 auto` inside a `height: 100%` flex column, so handing `tree.layout()` the FULL body height told
	 * the virtual list it was taller than its own DOM box - its last rows rendered below that box and were clipped
	 * by `.pane-body { overflow: hidden }`, unreachable by scrolling. That was already true of the single-row
	 * toolbar; three stacked dropdowns make it far worse. `offsetHeight` is 0 for a `display: none` element, so a
	 * hidden surface label and a collapsed dropdown panel each correctly contribute nothing. Measured rather than
	 * hardcoded, because this chrome's height is not fixed.
	 *
	 * Named `sizeBodyContent`, NOT `layoutBodyContent`: `FilterViewPane` declares an abstract
	 * `layoutBodyContent(height, width)` with the opposite argument order, and a same-name/swapped-args method would
	 * be a silent-breakage trap if this view were ever re-parented onto that base class.
	 */
	private sizeBodyContent(width: number, height: number): void {
		const chromeHeight = this.purposeLabelEl.offsetHeight + this.surfaceLabelEl.offsetHeight + this.toolbarEl.offsetHeight;
		const contentHeight = Math.max(0, height - chromeHeight);
		this.stateContainer.style.height = `${contentHeight}px`;
		this.treeContainer.style.height = `${contentHeight}px`;
		this.treeContainer.style.width = `${width}px`;
		this.tree.layout(contentHeight, width);
	}

	/** Re-run the body sizing against the LAST dimension the split view gave us - for the chrome-height changes the
	 *  split view never sees: expanding/collapsing the dropdown panel, and swapping the purpose line for the taller
	 *  surface-ownership label. No-ops before the first layout. */
	private relayoutBodyContent(): void {
		const dimension = this.lastBodyDimension;
		if (dimension) { this.sizeBodyContent(dimension.width, dimension.height); }
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
	 * `applySnapshot`, or simply whatever snapshot preceded a filter/sort/scope change) and re-render. This is the
	 * ONE place the workspace scope, status filter, text filter, and sort mode are actually applied, in that order
	 * (see the find/sort block comment for why): scope decides whether a run is in the developer's world at all,
	 * the status filter narrows the category within that, the text filter narrows further, and the sort orders what
	 * remains - so a LIVE run is pinned first only AMONG MATCHES and is excluded outright the moment any filter
	 * drops it (there is no separate "force-show a live run" path). Renders the tree when runs remain after
	 * filtering, one of the four distinct message states otherwise. No-ops until the first snapshot has arrived
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
		const workspaceKeys = workflowWorkspaceProjectKeys(this.workspaceContextService);
		// The scope-DROPPED runs are kept, not discarded: the toggle's narrowing indicator and the honest empty
		// state below both have to know how many runs this stage withheld.
		const scopeMatched: WorkflowRun[] = [];
		const scopeDropped: WorkflowRun[] = [];
		for (const run of rawRuns) {
			(matchesWorkflowWorkspaceScope(run, this.workspaceScope, workspaceKeys) ? scopeMatched : scopeDropped).push(run);
		}
		// Whether the scope stage ACTUALLY withheld something, not merely whether it is set to a non-default value -
		// the shipped default is the narrowing one, so non-default-ness is the wrong probe here (see
		// `workflowFiltersAreNarrowing`). Repainted before the state branch below, which can return early.
		this.scopeIsWithholding = scopeDropped.length > 0;
		this.updateFiltersToggleNarrowing();

		const statusFiltered = scopeMatched.filter(run => matchesWorkflowStatusFilter(run, this.statusFilter));
		const textFiltered = query.length === 0 ? statusFiltered : statusFiltered.filter(run => matchesWorkflowFilter(run, query));
		const displayedRuns = sortWorkflowRuns(textFiltered, this.sortMode);
		this.currentDisplayedRuns = displayedRuns;

		// Scoped to what is actually DISPLAYED (not the raw snapshot) - the surface label above the tree describes
		// what the tree currently shows.
		this.renderContext.uniformlyForeign = computeUniformlyForeign(displayedRuns, ownedSessionIds);

		// The empty-list diagnosis, whose costly half is computed only when the list IS empty (zero cost on the
		// common path): how many runs the SCOPE stage alone withheld that pass every CONTENT filter - i.e. how many
		// relaxing the scope would put back on screen. A non-zero count is what makes "no runs here, N elsewhere"
		// sayable instead of the flatly false "no runs found under your Claude config root".
		const emptyDiagnosis: IWorkflowsEmptyDiagnosis = {
			queryActive: query.length > 0,
			statusFilterActive: this.statusFilter !== WorkflowStatusFilter.All,
			matchedElsewhere: displayedRuns.length > 0 ? 0 : scopeDropped.filter(run =>
				matchesWorkflowStatusFilter(run, this.statusFilter)
				&& (query.length === 0 || matchesWorkflowFilter(run, query))).length,
		};

		const displayResult: WorkflowRunListResult = result.state === 'read-error'
			? result
			: result.state === 'partial'
				? { state: 'partial', runs: displayedRuns, message: result.message }
				: { state: 'ok', runs: displayedRuns };
		const state = resolveWorkflowsDisplayState(displayResult, emptyDiagnosis);
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
			// Restore the purpose line too: a PRIOR tree render may have hidden it in favor of the surface label
			// (item 19's dedupe), and a non-tree state has no tree left for that label to describe.
			this.purposeLabelEl.style.display = '';
			this.treeContainer.style.display = 'none';
			this.stateContainer.style.display = '';
			// The purpose line just came back and the surface label just went away, so the chrome above the
			// tree/state pair changed height - re-run the sizing the split view cannot know it needs.
			this.relayoutBodyContent();
			this.stateMessageStore.value = renderWorkflowsStateMessage(this.stateContainer, state, {
				onReadAgain: () => this.observationService.readAgain(),
				// Both widening actions move focus AFTER re-deriving: the button they were activated from is inside
				// the state container this same call stack is about to hide - see `focusAfterStateAction`.
				onShowAllWorkspaces: () => {
					this.setWorkspaceScope(WorkflowWorkspaceScope.AllWorkspaces);
					this.focusAfterStateAction();
				},
				onClearFilters: () => this.clearContentFilters(),
			});
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
		// Item 19: the two caption lines say the same "read-only, observed from Claude Code on disk" thing - hide
		// the always-on purpose line the instant the more specific surface label takes over, rather than stacking
		// two near-duplicate sentences.
		this.purposeLabelEl.style.display = show ? 'none' : '';
		// Swapping a one-line purpose caption for the taller two-line surface label changes the chrome height above
		// the tree, and nothing outside the pane body observes that - re-run the sizing (see `sizeBodyContent`).
		this.relayoutBodyContent();
	}

	/** Open the RESULT detail editor for a terminal run row's activation - a SNAPSHOT off the same in-memory
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
