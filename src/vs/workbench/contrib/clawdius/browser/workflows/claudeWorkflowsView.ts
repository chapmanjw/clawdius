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
// The ownership-chrome rule is split across this file and `claudeWorkflowTree.ts`: `applySnapshot()` below
// computes `uniformlyForeign` ONCE per applied snapshot (never per-row) and paints the single SURFACE ownership
// label above the tree ONLY while every run is foreign; the tree's row renderer reads that already-computed signal
// off a shared mutable context and paints NO per-run ownership chrome in the common (uniformly-foreign) case,
// falling back to a per-run label the instant ownership can differ. The view's data source is the
// `IClaudeWorkflowObservationService` singleton (`claudeWorkflowObservationService.ts`), which owns the config-root
// resolution and the seam read - the view itself no longer touches either directly.
//
// READ-ONLY BY CONSTRUCTION, not by policy. The view observes; it cannot act on a workflow run. Clawdius holds a
// live `Query` only for a session IT launched, so a run launched by the Claude Code CLI - which today is every
// run on disk - has no handle to stop or steer. A control surface here would be unreachable, so there is
// none. Launching workflows from Clawdius is a future direction that would make controls meaningful; until then
// the honest product is an observatory. The read-error state's "Read again" affordance is a RE-READ of the same
// enumeration (`observationService.readAgain()`), never a run control.

import './media/claudeWorkflows.css';
import { $, append, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { localize } from '../../../../../nls.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	TerminalWorkflowAgent, TerminalWorkflowRun, UnrecognizedWorkflowRun, WorkflowRun,
} from '../../common/claudeWorkflowModel.js';
import { BadgeSignal, ClaudeWorkflowBadgeFeed } from './claudeWorkflowBadges.js';
import { boundResultText, ClaudeWorkflowAgentDetailPayload, ClaudeWorkflowDetailInput, ClaudeWorkflowResultDetailPayload } from './claudeWorkflowDetailInput.js';
import { IClaudeWorkflowObservationService, WorkflowSnapshot } from './claudeWorkflowObservationService.js';
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

// PRESERVED for backward compat: this is the view CONTAINER id VS Code persists (activity-bar placement,
// pinned state, visibility) across restarts. It must NOT change with the rename, or a pre-rename user's
// pinned activity-bar placement/visibility of this container would fail to restore - the same backward-compat
// rationale as the transcript editor-input-serializer typeId.
export const WORKFLOWS_VIEW_CONTAINER_ID = 'workbench.view.clawdiusMissions';
// PRESERVED for backward compat: this is the view id VS Code persists (panel/sidebar placement, visibility,
// size) across restarts. It must NOT change with the rename, or a pre-rename user's restored view state for
// this view would fail to restore - the same backward-compat rationale as the transcript editor-input-serializer
// typeId.
export const WORKFLOWS_VIEW_ID = 'clawdius.missions';

/** The Claude Code Ultracode Workflows Sidebar view: enumerates runs through the reader seam and renders them
 *  through a `WorkbenchObjectTree`, honestly labeled. */
export class ClawdiusWorkflowsView extends ViewPane {

	static readonly ID = WORKFLOWS_VIEW_ID;

	/** The runs painted on the last applied snapshot, correlated against by the live badge feed. */
	private currentRuns: readonly WorkflowRun[] = [];
	/** The authoritative live badges per run; read by the run-row renderer at render time via `renderContext`. */
	private readonly badges = new Map<string, BadgeSignal>();
	/** The live needs-input/completion badge feed (created in renderBody, disposed with the view). */
	private badgeFeed: ClaudeWorkflowBadgeFeed | undefined;
	/** Whether a filter is currently active and matching nothing. A filter itself is future work - nothing sets
	 *  this true yet - but the `no-match` state + this field's wiring into `resolveWorkflowsDisplayState` exist now
	 *  so a later filter slice only has to flip it, never invent the state. */
	private filterActive = false;

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

	private surfaceLabelEl!: HTMLElement;
	private stateContainer!: HTMLElement;
	private treeContainer!: HTMLElement;
	private tree!: WorkbenchObjectTree<WorkflowTreeElement, FuzzyScore>;
	private storyRenderer!: WorkflowStoryLeafRenderer;
	private liveProgressRenderer!: WorkflowLiveProgressRenderer;
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
				accessibilityProvider: new WorkflowTreeAccessibilityProvider(),
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
	 * Apply one immutable snapshot from the observation service - the view's PRIMARY data path.
	 * Renders the tree when runs are present, one of the three distinct message states otherwise. This is also
	 * effectively the RE-READ entry point: the read-error state's "Read again" button calls
	 * `observationService.readAgain()`, whose eventual snapshot flows back through this exact same method - never a
	 * run control, always the same re-enumeration.
	 */
	private applySnapshot(snapshot: WorkflowSnapshot): void {
		const result = snapshot.result;
		const runs: readonly WorkflowRun[] = result.state === 'read-error' ? [] : result.runs;
		this.currentRuns = runs;
		const ownedSessionIds = ownedSessionIdsFromHost(this.agentHostService);
		this.renderContext.ownedSessionIds = ownedSessionIds;
		this.renderContext.uniformlyForeign = computeUniformlyForeign(runs, ownedSessionIds);

		// Drop badges for runs no longer enumerated so a stale live badge never outlives its run.
		const present = new Set(runs.map(run => run.runId));
		for (const runId of [...this.badges.keys()]) {
			if (!present.has(runId)) { this.badges.delete(runId); }
		}

		// Refresh the freshness side-table BEFORE any tree mutation, so a `rerender()` triggered below always paints
		// the run's CURRENT data (see `IWorkflowRenderContext.runOf`'s doc comment in claudeWorkflowTree.ts).
		this.latestRunByIdentity.clear();
		for (const run of runs) { this.latestRunByIdentity.set(run.identity, run); }

		const state = resolveWorkflowsDisplayState(result, this.filterActive);
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
	 *  foreign - dropped the instant ownership can differ (any run resolves owned). */
	private updateSurfaceOwnershipLabel(): void {
		const show = this.currentRuns.length > 0 && this.renderContext.uniformlyForeign;
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
