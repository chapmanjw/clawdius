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
// than one - see `claudeWorkflowTree.ts`'s `buildTerminalRunChildren`). Drill-in editors (opening the full result /
// an agent's transcript on Enter) are a later change: the tree here is the list + native expansion only.
//
// The ownership-chrome rule is split across this file and `claudeWorkflowTree.ts`: `refresh()` below
// computes `uniformlyForeign` ONCE per read (never per-row) and paints the single SURFACE ownership label above the
// tree ONLY while every run is foreign; the tree's row renderer reads that already-computed signal off a shared
// mutable context and paints NO per-run ownership chrome in the common (uniformly-foreign) case, falling back to a
// per-run label the instant ownership can differ. The view consumes ONLY the seam: it resolves the config root
// from IPathService.userHome (never a hardcoded ~/.claude) - no direct Claude config-tree read, no egress.
//
// READ-ONLY BY CONSTRUCTION, not by policy. The view observes; it cannot act on a workflow run. Clawdius holds a
// live `Query` only for a session IT launched, so a run launched by the Claude Code CLI - which today is every
// run on disk - has no handle to stop or steer. A control surface here would be unreachable, so there is
// none. Launching workflows from Clawdius is the roadmap item that would make controls meaningful; until then
// the honest product is an observatory. The read-error state's "Read again" affordance is a RE-READ of the same
// enumeration, never a run control.

import './media/claudeWorkflows.css';
import { $, append, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
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
import { IPathService } from '../../../../services/path/common/pathService.js';
import { resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import { WorkflowRun } from '../../common/claudeWorkflowModel.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';
import { BadgeSignal, ClaudeWorkflowBadgeFeed } from './claudeWorkflowBadges.js';
import { ownedSessionIdsFromHost } from './claudeWorkflowOwnership.js';
import {
	buildWorkflowTreeChildren, computeUniformlyForeign, IWorkflowRenderContext, renderWorkflowsStateMessage,
	resolveWorkflowsDisplayState, WorkflowAgentRowRenderer, WorkflowPhaseRowRenderer, WorkflowRunRowRenderer,
	WorkflowsDisplayState, WorkflowStoryHeightCache, WorkflowStoryLeafRenderer, WorkflowTreeAccessibilityProvider,
	WorkflowTreeElement, WorkflowTreeIdentityProvider, WorkflowTreeKeyboardNavigationLabelProvider,
	WorkflowTreeVirtualDelegate,
} from './claudeWorkflowTree.js';

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

	private readonly seam: ClawdiusReaderSeamService;
	private disposed = false;
	/** The runs painted on the last refresh, correlated against by the live badge feed. */
	private currentRuns: readonly WorkflowRun[] = [];
	/** The authoritative live badges per run; read by the run-row renderer at render time via `renderContext`. */
	private readonly badges = new Map<string, BadgeSignal>();
	/** The live needs-input/completion badge feed (created in renderBody, disposed with the view). */
	private badgeFeed: ClaudeWorkflowBadgeFeed | undefined;
	/** Whether a filter is currently active and matching nothing. A filter itself is future work - nothing sets
	 *  this true yet - but the `no-match` state + this field's wiring into `resolveWorkflowsDisplayState` exist now
	 *  so a later filter slice only has to flip it, never invent the state. */
	private filterActive = false;

	/** Per-run measured story-leaf heights, shared between the virtual delegate and the story renderer. */
	private readonly storyHeights = new WorkflowStoryHeightCache();
	/** The mutable, view-owned ownership signal every row renderer reads at render time (never recomputed by a
	 *  renderer, never a second disk read). Mutated in place on every `refresh()`. */
	private readonly renderContext: IWorkflowRenderContext;
	/** runId -> its current top-level tree element, so a live badge poke can `tree.rerender` the exact row without
	 *  a full re-render; rebuilt on every `refresh()`. */
	private readonly runElementsByRunId = new Map<string, WorkflowTreeElement>();
	private readonly stateMessageStore = this._register(new MutableDisposable());
	private readonly storyRemeasureSchedule = this._register(new MutableDisposable());

	private surfaceLabelEl!: HTMLElement;
	private stateContainer!: HTMLElement;
	private treeContainer!: HTMLElement;
	private tree!: WorkbenchObjectTree<WorkflowTreeElement, FuzzyScore>;
	private storyRenderer!: WorkflowStoryLeafRenderer;
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
		@IPathService private readonly pathService: IPathService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		// The seam service is not a registered singleton; instantiate it (teams probe off) so the view reads runs
		// through the SAME enumeration the sibling tests exercise. It is stateless + read-only (not a disposable).
		this.seam = instantiationService.createInstance(ClawdiusReaderSeamService, false);
		this.renderContext = { uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: runId => this.badges.get(runId) };
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
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
		const runRenderer = this._register(new WorkflowRunRowRenderer(this.renderContext, hoverDelegate));
		const phaseRenderer = new WorkflowPhaseRowRenderer();
		const agentRenderer = this._register(new WorkflowAgentRowRenderer(hoverDelegate));

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<WorkflowTreeElement, FuzzyScore>,
			'ClawdiusWorkflowsTree',
			this.treeContainer,
			new WorkflowTreeVirtualDelegate(this.storyHeights),
			[runRenderer, this.storyRenderer, phaseRenderer, agentRenderer],
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

		void this.refresh();
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
	 * Resolve the config root from the active window's home (never a hardcoded path) and list the enumerated runs
	 * through the seam's validated root envelope (`listWorkflows`), then render the result: the tree when runs are
	 * present, one of the three distinct message states otherwise. `listWorkflows` itself never throws; it degrades
	 * to a labeled `read-error` instead. This is also the RE-READ entry point the read-error state's "Read again"
	 * button calls - never a run control, always the same re-enumeration.
	 */
	private async refresh(): Promise<void> {
		const home = await this.pathService.userHome();
		if (this.disposed) { return; }
		const root = resolveConfigRoot(undefined, home);
		const result = await this.seam.listWorkflows(root);
		if (this.disposed) { return; }

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

		this.applyDisplayState(resolveWorkflowsDisplayState(result, this.filterActive));
	}

	private applyDisplayState(state: WorkflowsDisplayState): void {
		if (state.kind !== 'tree') {
			this.runElementsByRunId.clear();
			this.surfaceLabelEl.style.display = 'none';
			this.treeContainer.style.display = 'none';
			this.stateContainer.style.display = '';
			this.stateMessageStore.value = renderWorkflowsStateMessage(this.stateContainer, state, () => { void this.refresh(); });
			return;
		}
		this.stateMessageStore.clear();
		this.stateContainer.style.display = 'none';
		this.treeContainer.style.display = '';

		this.runElementsByRunId.clear();
		const children = buildWorkflowTreeChildren(state.runs);
		for (const child of children) {
			if (child.element.kind === 'run') {
				this.runElementsByRunId.set(child.element.run.runId, child.element);
			}
		}
		this.tree.setChildren(null, children);
		this.updateSurfaceOwnershipLabel();
	}

	/** The surface ownership label: painted only alongside a non-empty tree, and only while every run in it is
	 *  foreign - dropped the instant ownership can differ (any run resolves owned). */
	private updateSurfaceOwnershipLabel(): void {
		const show = this.currentRuns.length > 0 && this.renderContext.uniformlyForeign;
		this.surfaceLabelEl.style.display = show ? '' : 'none';
		this.surfaceLabelEl.setAttribute('data-clawdius-workflows-surface-ownership', String(show));
	}
}
// CLAWDIUS-END
