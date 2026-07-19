/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - Sidebar (Activity Bar) ViewPane
// A native-DOM ViewPane (pattern: clawdiusContextBudgetView) listing the ultracode WORKFLOWS the reader seam
// enumerates - workflow runs, not chat sessions. The top-level list is sourced through the validated root envelope
// `listWorkflows` (the discriminated live/terminal/unknown-shape model + the honest ok/partial/read-error
// envelope), then ADAPTED to the render pipeline's existing row shape by `toMissionShape` - a temporary bridge so
// this data-path change is behavior-neutral on the REAL corpus (which always carries a workflowName); the tree/renderers are re-modeled in a later slice. Each
// row renders with the name its script declared, its real status, and the honesty labels (coverage / freshness /
// completeness + ownership); a foreign or suppressed run is rendered PRESENT-WITH-LABEL, never hidden. The
// row-expand/transcript-open drill-in still reads through the shipped `listMissionAgents` journal path (unchanged
// by the bridge). The view consumes ONLY the seam: it resolves the config root from IPathService.userHome (never a
// hardcoded ~/.claude) - no direct Claude config-tree read, no egress. Rows carry data-* hooks so the real-build
// Playwright render can assert them. A large fleet is appended in animation-frame batches so enumeration never
// blocks the workbench thread.
//
// READ-ONLY BY CONSTRUCTION, not by policy. The view observes; it cannot act on a workflow run. Clawdius holds a
// live `Query` only for a session IT launched, so a run launched by the Claude Code CLI - which today is every
// run on disk - has no handle to stop or steer. A control surface here would be unreachable, so there is
// none. Launching workflows from Clawdius is the roadmap item that would make controls meaningful; until then
// the honest product is an observatory.

import './media/claudeWorkflows.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { FleetSubagent, MissionAgent as WorkflowAgent, MissionAgentList as WorkflowAgentList, MissionRun as WorkflowRun } from '../../common/claudeFleetModel.js';
import { CompletenessState, CoverageLabel, ReaderConfigRoot, resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import { WorkflowRun as WorkflowRunModel } from '../../common/claudeWorkflowModel.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';
import { BadgeSignal, ClaudeWorkflowBadgeFeed } from './claudeWorkflowBadges.js';
import { ownedSessionIdsFromHost } from './claudeWorkflowOwnership.js';
import { ClaudeWorkflowTranscriptInput } from './claudeWorkflowTranscriptInput.js';

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

/** The minimal workflow-enumeration surface the view binds to (listMissions). Structural so a unit test
 *  can supply a fake without instantiating the full seam service. */
export interface IFleetRunSource {
	listMissions(root: ReaderConfigRoot): Promise<readonly WorkflowRun[]>;
}

/** Row -> its dedicated badge-host element, so the live badge can be updated by direct reference (never a
 *  selector lookup). A `WeakMap` keyed by the row element releases automatically when the row is cleared. */
const badgeHosts = new WeakMap<HTMLElement, HTMLElement>();

/** The badge-host element for a rendered run row, if it has one (created by {@link appendWorkflowRow}). */
export function badgeHostOf(row: HTMLElement): HTMLElement | undefined {
	return badgeHosts.get(row);
}

/** Render (or clear) a run's LIVE needs-input/completion badge into its dedicated badge-host element. Idempotent -
 *  clears the host first, then, when a signal is present, fills it with a decoration carrying a `data-live-badge`
 *  hook plus the kind/freshness `data-*` attributes so the receipt and the DOM test can assert it. A cleared host
 *  (no signal) leaves the row showing only its seam-derived honest labels (no fabricated live state). Operates on
 *  the host by direct reference (no fragile selector lookups). */
export function renderRunBadge(host: HTMLElement, signal: BadgeSignal | undefined): void {
	clearNode(host);
	if (!signal) {
		host.removeAttribute('data-live-badge');
		return;
	}
	host.setAttribute('data-live-badge', signal.kind);
	const text = signal.kind === 'needs-input'
		? localize('clawdius.workflows.badge.needsInput', "needs input")
		: localize('clawdius.workflows.badge.completion', "completed");
	append(host, $(`.clawdius-workflows-badge.badge-${signal.kind}.freshness-${signal.freshness}`, {
		'data-badge-kind': signal.kind,
		'data-badge-freshness': signal.freshness,
	}, text));
}

/**
 * The one-line summary of a workflow run's error: its first non-empty line, whitespace-collapsed. A workflow
 * failure arrives as a multi-line stack trace, and only its leading line names the actual fault - the frames below
 * it are bundler paths of no use in a 300px sidebar. PURE, so the clamp is unit-testable without a DOM. The row
 * keeps the FULL error on its tooltip and the model keeps it whole: this shortens what is painted, never what is
 * known.
 */
export function errorSummary(error: string): string {
	const first = error.split('\n').find(line => line.trim().length > 0) ?? '';
	return first.trim().replace(/\s+/g, ' ');
}

/**
 * Append one ultracode WORKFLOW run as a labeled row - the Workflows list's primary row. A run leads with the name
 * its script declared (a run is a thing the user named, not an opaque id) and carries its real status, agent count
 * and phase count, plus every honesty label as both a badge and a `data-*` hook so a Playwright render can assert
 * it.
 *
 * The status is the seam's, never fabricated: `running` is only ever reached by a run whose journal has no manifest
 * beside it, so a row reading `running` is a genuinely in-flight run. A live run additionally shows how far it
 * has got (`finished/total` agents), which is the only progress signal that exists before a manifest is written.
 */
export function appendWorkflowRow(parent: HTMLElement, run: WorkflowRun, badge?: BadgeSignal): HTMLElement {
	const foreign = run.coverage === CoverageLabel.Foreign;
	const row = append(parent, $(`.clawdius-workflows-row${foreign ? '.foreign' : ''}`, {
		'data-run-id': run.runId,
		'data-session-id': run.sessionId,
		'data-kind': 'workflow',
		'data-status': run.status,
		'data-workflow-name': run.name,
		'data-agent-count': run.agentCount === undefined ? '' : String(run.agentCount),
		'data-ownership': run.ownership,
		'data-coverage': run.coverage,
		'data-freshness': run.freshness,
		'data-completeness': run.completeness,
	}));
	const name = append(row, $('.clawdius-workflows-run'));
	name.textContent = run.name;
	name.title = localize('clawdius.workflows.runTitle', "Workflow {0} · run {1} · session {2}", run.name, run.runId, run.sessionId);
	append(row, $(`.clawdius-workflows-status.status-${run.status}`, undefined, localize('clawdius.workflows.status', "status: {0}", run.status)));
	const labels = append(row, $('.clawdius-workflows-labels'));
	// A dedicated badge host leads the labels area; the live badge (if any) is rendered into it by direct
	// reference, so no fragile selector lookup is needed to update it later.
	const host = append(labels, $('.clawdius-workflows-badgehost'));
	badgeHosts.set(row, host);
	// A live run has no manifest yet, so `finished/total` off its journal is the only progress it can honestly
	// report; a terminal run reports the agent count its manifest recorded.
	const agents = run.status === 'running' && run.resultCount !== undefined
		? localize('clawdius.workflows.agentsProgress', "agents: {0}/{1}", run.resultCount, run.agentCount)
		: localize('clawdius.workflows.agents', "agents: {0}", run.agentCount === undefined ? '—' : run.agentCount);
	append(labels, $('.clawdius-workflows-label.agents', undefined, agents));
	if (run.phases.length > 0) {
		append(labels, $('.clawdius-workflows-label.phases', undefined, localize('clawdius.workflows.phases', "phases: {0}", run.phases.length)));
	}
	append(labels, $(`.clawdius-workflows-label.freshness-${run.freshness}`, undefined, localize('clawdius.workflows.freshness', "freshness: {0}", run.freshness)));
	append(labels, $(`.clawdius-workflows-label.completeness-${run.completeness}`, undefined, localize('clawdius.workflows.completeness', "completeness: {0}", run.completeness)));
	append(labels, $(`.clawdius-workflows-label.ownership-${run.ownership}`, undefined, localize('clawdius.workflows.ownership', "ownership: {0}", run.ownership)));
	if (run.error) {
		// A failed run's error is usually a multi-line stack trace, so rendering it whole let a single
		// failure wrap to eight lines and swallow the sidebar. Show its FIRST line, clamped to one row, with the
		// full text on the tooltip: the error stays PRESENT and complete - a failure the user cannot see is the
		// defect this view exists to prevent - it just no longer crowds out the workflows around it.
		const error = append(row, $('.clawdius-workflows-error', { 'data-workflow-error': '' }));
		error.textContent = errorSummary(run.error);
		error.title = run.error;
	}
	renderRunBadge(host, badge);
	return row;
}

/**
 * Append one of a workflow run's agents as a clickable child row. Unlike a Task subagent - a sidechain record
 * inside its parent's transcript - a workflow agent is its own file, so the row is keyed by `agentId` and carries
 * the role its meta sidecar recorded. An agent that started but never reported a result is rendered WITH that
 * label (`data-finished="false"`), never omitted: an unfinished agent is exactly what a user opening a live
 * workflow run needs to see.
 */
export function appendWorkflowAgentRow(parent: HTMLElement, agent: WorkflowAgent): HTMLElement {
	const row = append(parent, $('.clawdius-workflows-subrow', {
		'data-agent-id': agent.agentId,
		'data-parent-run-id': agent.runId,
		'data-agent-type': agent.agentType ?? '',
		'data-finished': String(agent.finished),
		'data-coverage': agent.coverage,
		'data-freshness': agent.freshness,
		'data-completeness': agent.completeness,
	}));
	row.setAttribute('role', 'button');
	row.tabIndex = 0;
	const name = append(row, $('.clawdius-workflows-subagent'));
	name.textContent = agent.agentType ? `${agent.agentType} · ${agent.agentId}` : agent.agentId;
	name.title = localize('clawdius.workflows.agentTitle', "Open transcript for agent {0}", agent.agentId);
	const labels = append(row, $('.clawdius-workflows-sublabels'));
	append(labels, $(`.clawdius-workflows-label.finished-${agent.finished}`, undefined, agent.finished
		? localize('clawdius.workflows.agentFinished', "finished")
		: localize('clawdius.workflows.agentRunning', "in flight")));
	append(labels, $(`.clawdius-workflows-label.freshness-${agent.freshness}`, undefined, localize('clawdius.workflows.freshness', "freshness: {0}", agent.freshness)));
	append(labels, $(`.clawdius-workflows-label.completeness-${agent.completeness}`, undefined, localize('clawdius.workflows.completeness', "completeness: {0}", agent.completeness)));
	return row;
}

/** The per-row drill-in wiring the ViewPane supplies (kept out of the pure list so a unit test can render rows
 *  without a workbench host): expand a run to its agents, and open an agent's transcript in the editor area. */
export interface IFleetRowInteractions {
	/** List a run's agents through the seam (present-with-label, never dropped). */
	listAgents(run: WorkflowRun): Promise<WorkflowAgentList>;
	/** Open an agent's transcript in the editor area (the drill-in). */
	openAgent(agent: WorkflowAgent): void;
}

/**
 * Renders a labeled list of enumerated runs into a container, incrementally. The first batch paints synchronously
 * so the initial render always has content; the remainder is appended in animation-frame batches so a large fleet
 * never blocks the workbench thread. Re-rendering (or disposal) cancels any pending batch. The list itself holds
 * no seam state - it is handed the already-enumerated FleetRun list.
 */
export class FleetRunsList extends Disposable {

	/** Rows appended per animation-frame batch - large enough that a typical fleet paints in one synchronous batch. */
	private static readonly BATCH_SIZE = 40;

	private readonly pendingBatch = this._register(new MutableDisposable());
	/** Listeners + child-container disposables for the interactive rows; cleared and rebuilt on every render. */
	private readonly rowStore = this._register(new DisposableStore());
	/** Bumped on every render() (and on dispose) so a subagent list still in flight from a torn-down row can detect
	 *  that its row no longer exists and bail before touching detached DOM or a disposed child store. */
	private generation = 0;
	/** The live badges to paint per run on (re)render; the authoritative map is owned by the view and re-passed. */
	private badges: ReadonlyMap<string, BadgeSignal> = new Map();
	/** runId -> its rendered row, so a live badge poke reaches the row by direct reference (no selector lookup);
	 *  rebuilt on every render. */
	private readonly rowByRunId = new Map<string, HTMLElement>();

	/** @param interactions when supplied, each run row expands to its subagents and a subagent opens its transcript;
	 *  omitted (the pure unit-test path) leaves rows non-interactive. */
	constructor(private readonly container: HTMLElement, private readonly interactions?: IFleetRowInteractions) {
		super();
		// A render (or disposal) after an expand's async listSubagents was issued must invalidate that in-flight
		// expansion; the generation counter is the guard the expand closure checks after its await.
		this._register(toDisposable(() => { this.generation++; }));
	}

	render(runs: readonly WorkflowRun[], badges?: ReadonlyMap<string, BadgeSignal>): void {
		this.pendingBatch.clear();
		this.rowStore.clear();
		this.generation++;
		this.badges = badges ?? new Map();
		this.rowByRunId.clear();
		clearNode(this.container);
		this.container.setAttribute('data-clawdius-workflows', String(runs.length));
		if (runs.length === 0) {
			const empty = append(this.container, $('.clawdius-workflows-empty', { 'data-clawdius-workflows-empty': 'true' }));
			empty.textContent = localize('clawdius.workflows.empty', "No Claude runs found under your Claude config root.");
			return;
		}
		let i = 0;
		const step = () => {
			const end = Math.min(i + FleetRunsList.BATCH_SIZE, runs.length);
			for (; i < end; i++) {
				const row = appendWorkflowRow(this.container, runs[i], this.badges.get(runs[i].runId));
				this.rowByRunId.set(runs[i].runId, row);
				if (this.interactions) { this.wireRunRow(row, runs[i]); }
			}
			if (i < runs.length) {
				this.pendingBatch.value = scheduleAtNextAnimationFrame(getWindow(this.container), step);
			} else {
				this.pendingBatch.clear();
			}
		};
		step();
	}

	/** Apply a live badge to an already-rendered run row (best-effort - if the row is not yet painted the badge is
	 *  picked up from the map on the next render). The view owns the authoritative badge map; this is the live poke.
	 *  Reaches the row and its badge host by direct reference (no selector lookup). */
	decorateRun(signal: BadgeSignal): void {
		const row = this.rowByRunId.get(signal.runId);
		const host = row && badgeHostOf(row);
		if (host) {
			renderRunBadge(host, signal);
		}
	}

	/** Make a run row expandable: a click (or Enter/Space) toggles an inline child list of the run's subagents,
	 *  fetched lazily through the seam; clicking a subagent opens its transcript. Only wired when interactions were
	 *  supplied. */
	private wireRunRow(row: HTMLElement, run: WorkflowRun): void {
		const interactions = this.interactions!;
		row.classList.add('expandable');
		row.setAttribute('role', 'button');
		row.tabIndex = 0;
		row.setAttribute('data-expanded', 'false');
		const twistie = $('.clawdius-workflows-twistie.codicon.codicon-chevron-right');
		twistie.setAttribute('aria-hidden', 'true');
		row.insertBefore(twistie, row.firstChild);

		const childStore = new DisposableStore();
		this.rowStore.add(childStore);
		let child: HTMLElement | undefined;

		const collapse = () => {
			child?.remove();
			child = undefined;
			childStore.clear();
			row.classList.remove('expanded');
			row.setAttribute('data-expanded', 'false');
		};

		const expand = async () => {
			row.classList.add('expanded');
			row.setAttribute('data-expanded', 'true');
			const gen = this.generation;
			const mine = $('.clawdius-workflows-subagents', { 'data-parent-run-id': run.runId });
			child = mine;
			row.after(mine);
			let list: WorkflowAgentList = { agents: [], completeness: CompletenessState.UnknownShape };
			try { list = await interactions.listAgents(run); } catch { list = { agents: [], completeness: CompletenessState.UnknownShape }; }
			// Bail if this expansion is stale: a collapse/re-expand replaced this child (child !== mine), OR a
			// full render() / disposal tore the row down (generation moved) - in the latter case mine is detached
			// and childStore is already disposed, so appending or adding listeners would be a leak/no-op warning.
			if (child !== mine || this.generation !== gen) { return; }
			clearNode(mine);
			const subs = list.agents;
			if (subs.length === 0) {
				// An empty list is two different facts, and the label is the only thing that separates them: a
				// workflow that ran no agents, versus a read whose agents were unreadable. Say which.
				const empty = append(mine, $('.clawdius-workflows-subempty', {
					'data-clawdius-workflows-subempty': 'true',
					'data-completeness': list.completeness,
				}));
				empty.textContent = list.completeness === CompletenessState.Partial
					? localize('clawdius.workflows.agentsUnreadable', "This workflow's agents could not be read (the run's journal is damaged).")
					: localize('clawdius.workflows.noAgents', "No agents for this workflow.");
				return;
			}
			for (const sub of subs) {
				const subrow = appendWorkflowAgentRow(mine, sub);
				const open = () => interactions.openAgent(sub);
				childStore.add(addDisposableListener(subrow, EventType.CLICK, open));
				childStore.add(addDisposableListener(subrow, EventType.KEY_DOWN, e => {
					const ke = new StandardKeyboardEvent(e);
					if (ke.keyCode === KeyCode.Enter || ke.keyCode === KeyCode.Space) { ke.preventDefault(); open(); }
				}));
			}
		};

		const toggle = () => { if (child) { collapse(); } else { void expand(); } };
		this.rowStore.add(addDisposableListener(row, EventType.CLICK, toggle));
		this.rowStore.add(addDisposableListener(row, EventType.KEY_DOWN, e => {
			const ke = new StandardKeyboardEvent(e);
			if (ke.keyCode === KeyCode.Enter || ke.keyCode === KeyCode.Space) { ke.preventDefault(); toggle(); }
		}));
	}
}

/**
 * Adapt the validated {@link WorkflowRunModel} (the seam's new discriminated live/terminal/unknown-shape read
 * model, `listWorkflows`) into the legacy {@link WorkflowRun} shape this view's render pipeline
 * (`appendWorkflowRow` / `FleetRunsList`) already consumes. A TEMPORARY BRIDGE: this moves the view's data path
 * onto the new validated model + honest root envelope WITHOUT re-modeling the tree/renderers (that is a later
 * piece of work), so on the REAL corpus it renders identically - every field the renderer reads (name/status/agentCount/
 * phases.length/error/coverage/freshness/completeness/ownership) is carried through unchanged; the fields the
 * renderer never reads (`progress`) are simply empty. The row-expand/transcript-open interactions are untouched
 * and keep reading through the shipped `listMissionAgents`/journal path - only the top-level list is re-sourced.
 * One input-space divergence (absent from the real corpus, which always carries a workflowName): a MALFORMED
 * manifest with a valid status but no workflowName reads terminal-by-status here with the runId as its name, where
 * the legacy projection read unknown-shape - the more honest reading of a missing optional field, not a regression.
 */
export function toMissionShape(run: WorkflowRunModel): WorkflowRun {
	const base = {
		runId: run.runId, sessionId: run.sessionId, progress: [],
		ownership: run.ownership, coverage: run.coverage, freshness: run.freshness,
		completeness: run.completeness, adapterVersion: run.adapterVersion,
	};
	switch (run.kind) {
		case 'live':
			return {
				...base, name: run.runId, status: 'running',
				agentCount: run.startedCount, startedCount: run.startedCount, resultCount: run.resultCount,
				phases: [],
			};
		case 'terminal':
			return {
				...base, name: run.workflowName ?? run.runId, status: run.status,
				agentCount: run.agentCount,
				phases: run.phases.map(p => (p.detail !== undefined ? { title: p.title, detail: p.detail } : { title: p.title })),
				durationMs: run.durationMs, totalTokens: run.totalTokens, totalToolCalls: run.totalToolCalls,
				defaultModel: run.defaultModel, error: run.error,
			};
		case 'unknown-shape':
			return { ...base, name: run.runId, status: 'unknown', agentCount: undefined, phases: [] };
	}
}

/** The Claude Code Ultracode Workflows Sidebar view: enumerates runs through the reader seam and lists them,
 *  honestly labeled. */
export class ClawdiusWorkflowsView extends ViewPane {

	static readonly ID = WORKFLOWS_VIEW_ID;

	private listEl: HTMLElement | undefined;
	private list: FleetRunsList | undefined;
	private readonly seam: ClawdiusReaderSeamService;
	private disposed = false;
	/** The config root resolved on the last refresh, reused by the drill-in to list a run's subagents. */
	private root: ReaderConfigRoot | undefined;
	/** The runs painted on the last refresh, correlated against by the live badge feed. */
	private currentRuns: readonly WorkflowRun[] = [];
	/** The authoritative live badges per run; re-applied on every render and updated live by the feed. */
	private readonly badges = new Map<string, BadgeSignal>();
	/** The live needs-input/completion badge feed (created in renderBody, disposed with the view). */
	private badgeFeed: ClaudeWorkflowBadgeFeed | undefined;

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
		@IEditorService private readonly editorService: IEditorService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		// The seam service is not a registered singleton; instantiate it (teams probe off) so the view reads runs
		// through the SAME enumeration the sibling tests exercise. It is stateless + read-only (not a disposable).
		this.seam = instantiationService.createInstance(ClawdiusReaderSeamService, false);
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.listEl = append(container, $('.clawdius-workflows'));
		this.list = this._register(new FleetRunsList(this.listEl, {
			listAgents: run => this.listAgentsFor(run),
			openAgent: agent => this.openAgent(agent),
		}));
		// The LIVE-only badge feed: an owned run's `onDidAction` needs-input/completion event raises a `live` badge on
		// its row. In a runtime with no agent host the null service's `onDidAction` is `Event.None`, so nothing fires
		// and the rows keep the seam's honest polled status - never a fabricated badge.
		this.badgeFeed = this._register(new ClaudeWorkflowBadgeFeed({
			onDidAction: this.agentHostService.onDidAction,
			getRuns: () => this.currentRuns,
			getOwnedSessionIds: () => ownedSessionIdsFromHost(this.agentHostService),
		}));
		this._register(this.badgeFeed.onDidChangeBadge(signal => {
			this.badges.set(signal.runId, signal);
			this.list?.decorateRun(signal);
		}));
		void this.refresh();
	}

	/** List a workflow run's agents through the seam against the last-resolved root (the drill-in expand). */
	private async listAgentsFor(run: WorkflowRun): Promise<WorkflowAgentList> {
		// No resolved root, or a read that threw: both are reads that did not happen, which is not the same claim as
		// "this run has no agents". Label them rather than return a bare empty list that reads as the latter.
		if (!this.root) { return { agents: [], completeness: CompletenessState.Absent }; }
		try {
			return await this.seam.listMissionAgents(this.root, run);
		} catch {
			return { agents: [], completeness: CompletenessState.Partial };
		}
	}

	/**
	 * Open a workflow agent's transcript in the editor area via IEditorService (the drill-in). The transcript editor
	 * reads through the seam by `transcriptRef` alone, so a workflow agent is adapted to the drill-in shape it
	 * already accepts rather than duplicating an editor for the same read.
	 */
	private openAgent(agent: WorkflowAgent): void {
		const subagent: FleetSubagent = {
			subagentId: agent.agentId,
			parentRunId: agent.runId,
			transcriptRef: agent.transcriptRef,
			coverage: agent.coverage,
			freshness: agent.freshness,
			completeness: agent.completeness,
		};
		void this.editorService.openEditor(new ClaudeWorkflowTranscriptInput(subagent), { pinned: true, revealIfOpened: true });
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listEl) {
			this.listEl.style.height = `${height}px`;
		}
	}

	/**
	 * Resolve the config root from the active window's home (never a hardcoded path) and list the enumerated runs
	 * through the seam's validated root envelope (`listWorkflows`) - the honest replacement for the previous
	 * blanket `catch { runs = [] }` (a read failure and a genuinely empty read are no longer the same code path,
	 * even though this bridge paints them the same until the read-error state gets its own row in a later piece
	 * of work). `listWorkflows` itself never throws; it degrades to a labeled `read-error` instead.
	 */
	private async refresh(): Promise<void> {
		const home = await this.pathService.userHome();
		if (this.disposed) { return; }
		const root = resolveConfigRoot(undefined, home);
		this.root = root;
		const result = await this.seam.listWorkflows(root);
		if (this.disposed) { return; }
		// The temporary bridge: `read-error` paints the same empty list its predecessor's catch already produced
		// (the distinct honest read-error row is a later piece of work); `ok`/`partial` both render whatever runs
		// WERE read, adapted to the render pipeline's legacy shape.
		const runs: readonly WorkflowRun[] = result.state === 'read-error' ? [] : result.runs.map(toMissionShape);
		this.currentRuns = runs;
		// Drop badges for runs no longer enumerated so a stale live badge never outlives its run.
		const present = new Set(runs.map(run => run.runId));
		for (const runId of [...this.badges.keys()]) {
			if (!present.has(runId)) { this.badges.delete(runId); }
		}
		this.list?.render(runs, this.badges);
	}
}
// CLAWDIUS-END
