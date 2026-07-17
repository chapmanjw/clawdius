/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet - Sidebar (Activity Bar) ViewPane
// A native-DOM ViewPane (pattern: clawdiusContextBudgetView) listing the runs the reader seam enumerates
// (listRuns). Each FleetRun renders with its coarse status and the four honesty labels (coverage /
// freshness / completeness + ownership); a foreign or suppressed run is rendered PRESENT-WITH-LABEL,
// never hidden. The view consumes ONLY the seam: it resolves the config root from IPathService.userHome
// (never a hardcoded ~/.claude) and calls the seam's listRuns - no direct Claude config-tree read, no egress.
// Rows carry data-* hooks so the real-build Playwright render can assert them. A large fleet is appended in
// animation-frame batches so enumeration of many runs never blocks the workbench thread.

import './media/claudeMissions.css';
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
import { FleetRun, FleetSubagent, MissionAgent, MissionRun } from '../../common/claudeFleetModel.js';
import { CoverageLabel, ReaderConfigRoot, resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';
import { BadgeSignal, ClaudeMissionBadgeFeed } from './claudeMissionBadges.js';
import { ownedSessionIdsFromHost } from './claudeMissionOwnership.js';
import { ClaudeMissionTranscriptInput } from './claudeMissionTranscriptInput.js';

export const MISSIONS_VIEW_CONTAINER_ID = 'workbench.view.clawdiusMissions';
export const MISSIONS_VIEW_ID = 'clawdius.missions';

/** The minimal run-enumeration surface the fleet view binds to (listRuns). Structural so a unit test
 *  can supply a fake without instantiating the full seam service. */
export interface IFleetRunSource {
	listMissions(root: ReaderConfigRoot): Promise<readonly MissionRun[]>;
}

/** Row -> its dedicated badge-host element, so the live badge can be updated by direct reference (never a
 *  selector lookup). A `WeakMap` keyed by the row element releases automatically when the row is cleared. */
const badgeHosts = new WeakMap<HTMLElement, HTMLElement>();

/** The badge-host element for a rendered run row, if it has one (created by {@link appendRunRow}). */
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
		? localize('clawdius.missions.badge.needsInput', "needs input")
		: localize('clawdius.missions.badge.completion', "completed");
	append(host, $(`.clawdius-missions-badge.badge-${signal.kind}.freshness-${signal.freshness}`, {
		'data-badge-kind': signal.kind,
		'data-badge-freshness': signal.freshness,
	}, text));
}

/** Append one FleetRun as a labeled row, carrying every honesty label as both a badge and a `data-*` hook so a
 *  Playwright render can assert it. A foreign/suppressed run gets a `foreign` marker class but is never omitted.
 *  When a live `BadgeSignal` is supplied (an owned run that fired an event), its needs-input/completion decoration
 *  is rendered too; otherwise only the seam's honest labels show (no fabricated live badge). */
export function appendRunRow(parent: HTMLElement, run: FleetRun, badge?: BadgeSignal): HTMLElement {
	const foreign = run.coverage === CoverageLabel.Foreign;
	const row = append(parent, $(`.clawdius-missions-row${foreign ? '.foreign' : ''}`, {
		'data-run-id': run.runId,
		'data-session-id': run.sessionId,
		'data-kind': run.kind,
		'data-status': run.status,
		'data-ownership': run.ownership,
		'data-coverage': run.coverage,
		'data-freshness': run.freshness,
		'data-completeness': run.completeness,
	}));
	const name = append(row, $('.clawdius-missions-run'));
	name.textContent = run.runId;
	name.title = localize('clawdius.missions.runTitle', "Run {0} · session {1}", run.runId, run.sessionId);
	append(row, $('.clawdius-missions-status', undefined, localize('clawdius.missions.status', "status: {0}", run.status)));
	const labels = append(row, $('.clawdius-missions-labels'));
	// A dedicated badge host leads the labels area; the live badge (if any) is rendered into it by direct
	// reference, so no fragile selector lookup is needed to update it later.
	const host = append(labels, $('.clawdius-missions-badgehost'));
	badgeHosts.set(row, host);
	append(labels, $(`.clawdius-missions-label.coverage-${run.coverage}`, undefined, localize('clawdius.missions.coverage', "coverage: {0}", run.coverage)));
	append(labels, $(`.clawdius-missions-label.freshness-${run.freshness}`, undefined, localize('clawdius.missions.freshness', "freshness: {0}", run.freshness)));
	append(labels, $(`.clawdius-missions-label.completeness-${run.completeness}`, undefined, localize('clawdius.missions.completeness', "completeness: {0}", run.completeness)));
	append(labels, $(`.clawdius-missions-label.ownership-${run.ownership}`, undefined, localize('clawdius.missions.ownership', "ownership: {0}", run.ownership)));
	renderRunBadge(host, badge);
	return row;
}

/**
 * The one-line summary of a mission's error: its first non-empty line, whitespace-collapsed. A workflow failure
 * arrives as a multi-line stack trace, and only its leading line names the actual fault - the frames below it are
 * bundler paths of no use in a 300px sidebar. PURE, so the clamp is unit-testable without a DOM. The row keeps the
 * FULL error on its tooltip and the model keeps it whole: this shortens what is painted, never what is known.
 */
export function errorSummary(error: string): string {
	const first = error.split('\n').find(line => line.trim().length > 0) ?? '';
	return first.trim().replace(/\s+/g, ' ');
}

/**
 * Append one ultracode MISSION as a labeled row - the Missions list's primary row. A mission leads with the name
 * its script declared (a run is a thing the user named, not an opaque id) and carries its real status, agent count
 * and phase count, plus every honesty label as both a badge and a `data-*` hook so a Playwright render can assert
 * it.
 *
 * The status is the seam's, never fabricated: `running` is only ever reached by a run whose journal has no manifest
 * beside it, so a row reading `running` is a genuinely in-flight mission. A live run additionally shows how far it
 * has got (`finished/total` agents), which is the only progress signal that exists before a manifest is written.
 */
export function appendMissionRow(parent: HTMLElement, mission: MissionRun, badge?: BadgeSignal): HTMLElement {
	const foreign = mission.coverage === CoverageLabel.Foreign;
	const row = append(parent, $(`.clawdius-missions-row${foreign ? '.foreign' : ''}`, {
		'data-run-id': mission.runId,
		'data-session-id': mission.sessionId,
		'data-kind': 'workflow',
		'data-status': mission.status,
		'data-mission-name': mission.name,
		'data-agent-count': String(mission.agentCount),
		'data-ownership': mission.ownership,
		'data-coverage': mission.coverage,
		'data-freshness': mission.freshness,
		'data-completeness': mission.completeness,
	}));
	const name = append(row, $('.clawdius-missions-run'));
	name.textContent = mission.name;
	name.title = localize('clawdius.missions.missionTitle', "Mission {0} · run {1} · session {2}", mission.name, mission.runId, mission.sessionId);
	append(row, $(`.clawdius-missions-status.status-${mission.status}`, undefined, localize('clawdius.missions.status', "status: {0}", mission.status)));
	const labels = append(row, $('.clawdius-missions-labels'));
	// A dedicated badge host leads the labels area; the live badge (if any) is rendered into it by direct
	// reference, so no fragile selector lookup is needed to update it later.
	const host = append(labels, $('.clawdius-missions-badgehost'));
	badgeHosts.set(row, host);
	// A live mission has no manifest yet, so `finished/total` off its journal is the only progress it can honestly
	// report; a terminal mission reports the agent count its manifest recorded.
	const agents = mission.status === 'running' && mission.resultCount !== undefined
		? localize('clawdius.missions.agentsProgress', "agents: {0}/{1}", mission.resultCount, mission.agentCount)
		: localize('clawdius.missions.agents', "agents: {0}", mission.agentCount);
	append(labels, $('.clawdius-missions-label.agents', undefined, agents));
	if (mission.phases.length > 0) {
		append(labels, $('.clawdius-missions-label.phases', undefined, localize('clawdius.missions.phases', "phases: {0}", mission.phases.length)));
	}
	append(labels, $(`.clawdius-missions-label.freshness-${mission.freshness}`, undefined, localize('clawdius.missions.freshness', "freshness: {0}", mission.freshness)));
	append(labels, $(`.clawdius-missions-label.completeness-${mission.completeness}`, undefined, localize('clawdius.missions.completeness', "completeness: {0}", mission.completeness)));
	append(labels, $(`.clawdius-missions-label.ownership-${mission.ownership}`, undefined, localize('clawdius.missions.ownership', "ownership: {0}", mission.ownership)));
	if (mission.error) {
		// A failed mission's error is usually a multi-line stack trace, so rendering it whole let a single
		// failure wrap to eight lines and swallow the sidebar. Show its FIRST line, clamped to one row, with the
		// full text on the tooltip: the error stays PRESENT and complete - a failure the user cannot see is the
		// defect this view exists to prevent - it just no longer crowds out the missions around it.
		const error = append(row, $('.clawdius-missions-error', { 'data-mission-error': '' }));
		error.textContent = errorSummary(mission.error);
		error.title = mission.error;
	}
	renderRunBadge(host, badge);
	return row;
}

/**
 * Append one of a mission's agents as a clickable child row. Unlike a Task subagent - a sidechain record inside its
 * parent's transcript - a workflow agent is its own file, so the row is keyed by `agentId` and carries the role its
 * meta sidecar recorded. An agent that started but never reported a result is rendered WITH that label
 * (`data-finished="false"`), never omitted: an unfinished agent is exactly what a user opening a live mission needs
 * to see.
 */
export function appendMissionAgentRow(parent: HTMLElement, agent: MissionAgent): HTMLElement {
	const row = append(parent, $('.clawdius-missions-subrow', {
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
	const name = append(row, $('.clawdius-missions-subagent'));
	name.textContent = agent.agentType ? `${agent.agentType} · ${agent.agentId}` : agent.agentId;
	name.title = localize('clawdius.missions.agentTitle', "Open transcript for agent {0}", agent.agentId);
	const labels = append(row, $('.clawdius-missions-sublabels'));
	append(labels, $(`.clawdius-missions-label.finished-${agent.finished}`, undefined, agent.finished
		? localize('clawdius.missions.agentFinished', "finished")
		: localize('clawdius.missions.agentRunning', "in flight")));
	append(labels, $(`.clawdius-missions-label.freshness-${agent.freshness}`, undefined, localize('clawdius.missions.freshness', "freshness: {0}", agent.freshness)));
	append(labels, $(`.clawdius-missions-label.completeness-${agent.completeness}`, undefined, localize('clawdius.missions.completeness', "completeness: {0}", agent.completeness)));
	return row;
}

/** The per-row drill-in wiring the ViewPane supplies (kept out of the pure list so a unit test can render rows
 *  without a workbench host): expand a mission to its agents, and open an agent's transcript in the editor area. */
export interface IFleetRowInteractions {
	/** List a mission's agents through the seam (present-with-label, never dropped). */
	listAgents(mission: MissionRun): Promise<readonly MissionAgent[]>;
	/** Open an agent's transcript in the editor area (the drill-in). */
	openAgent(agent: MissionAgent): void;
}

/** Append one FleetSubagent as a clickable child row under its run, carrying its honesty labels as `data-*` hooks
 *  so a Playwright render can assert them. Clicking (or Enter/Space) the row opens the subagent's transcript. */
export function appendSubagentRow(parent: HTMLElement, sub: FleetSubagent): HTMLElement {
	const row = append(parent, $('.clawdius-missions-subrow', {
		'data-subagent-id': sub.subagentId,
		'data-parent-run-id': sub.parentRunId,
		'data-coverage': sub.coverage,
		'data-freshness': sub.freshness,
		'data-completeness': sub.completeness,
	}));
	row.setAttribute('role', 'button');
	row.tabIndex = 0;
	const name = append(row, $('.clawdius-missions-subagent'));
	name.textContent = sub.subagentId || localize('clawdius.missions.subagentRoot', "subagent");
	name.title = localize('clawdius.missions.subagentTitle', "Open transcript for subagent {0}", sub.subagentId || '');
	const labels = append(row, $('.clawdius-missions-sublabels'));
	append(labels, $(`.clawdius-missions-label.coverage-${sub.coverage}`, undefined, localize('clawdius.missions.coverage', "coverage: {0}", sub.coverage)));
	append(labels, $(`.clawdius-missions-label.freshness-${sub.freshness}`, undefined, localize('clawdius.missions.freshness', "freshness: {0}", sub.freshness)));
	append(labels, $(`.clawdius-missions-label.completeness-${sub.completeness}`, undefined, localize('clawdius.missions.completeness', "completeness: {0}", sub.completeness)));
	return row;
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

	render(runs: readonly MissionRun[], badges?: ReadonlyMap<string, BadgeSignal>): void {
		this.pendingBatch.clear();
		this.rowStore.clear();
		this.generation++;
		this.badges = badges ?? new Map();
		this.rowByRunId.clear();
		clearNode(this.container);
		this.container.setAttribute('data-clawdius-missions', String(runs.length));
		if (runs.length === 0) {
			const empty = append(this.container, $('.clawdius-missions-empty', { 'data-clawdius-missions-empty': 'true' }));
			empty.textContent = localize('clawdius.missions.empty', "No Claude runs found under your Claude config root.");
			return;
		}
		let i = 0;
		const step = () => {
			const end = Math.min(i + FleetRunsList.BATCH_SIZE, runs.length);
			for (; i < end; i++) {
				const row = appendMissionRow(this.container, runs[i], this.badges.get(runs[i].runId));
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
	private wireRunRow(row: HTMLElement, run: MissionRun): void {
		const interactions = this.interactions!;
		row.classList.add('expandable');
		row.setAttribute('role', 'button');
		row.tabIndex = 0;
		row.setAttribute('data-expanded', 'false');
		const twistie = $('.clawdius-missions-twistie.codicon.codicon-chevron-right');
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
			const mine = $('.clawdius-missions-subagents', { 'data-parent-run-id': run.runId });
			child = mine;
			row.after(mine);
			let subs: readonly MissionAgent[] = [];
			try { subs = await interactions.listAgents(run); } catch { subs = []; }
			// Bail if this expansion is stale: a collapse/re-expand replaced this child (child !== mine), OR a
			// full render() / disposal tore the row down (generation moved) - in the latter case mine is detached
			// and childStore is already disposed, so appending or adding listeners would be a leak/no-op warning.
			if (child !== mine || this.generation !== gen) { return; }
			clearNode(mine);
			if (subs.length === 0) {
				append(mine, $('.clawdius-missions-subempty', { 'data-clawdius-missions-subempty': 'true' })).textContent =
					localize('clawdius.missions.noAgents', "No agents for this mission.");
				return;
			}
			for (const sub of subs) {
				const subrow = appendMissionAgentRow(mine, sub);
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

/** The Missions fleet Sidebar view: enumerates runs through the reader seam and lists them, honestly labeled. */
export class ClawdiusMissionsView extends ViewPane {

	static readonly ID = MISSIONS_VIEW_ID;

	private listEl: HTMLElement | undefined;
	private list: FleetRunsList | undefined;
	private readonly seam: ClawdiusReaderSeamService;
	private readonly refreshStore = this._register(new DisposableStore());
	private disposed = false;
	/** The config root resolved on the last refresh, reused by the drill-in to list a run's subagents. */
	private root: ReaderConfigRoot | undefined;
	/** The runs painted on the last refresh, correlated against by the live badge feed. */
	private currentRuns: readonly MissionRun[] = [];
	/** The authoritative live badges per run; re-applied on every render and updated live by the feed. */
	private readonly badges = new Map<string, BadgeSignal>();
	/** The live needs-input/completion badge feed (created in renderBody, disposed with the view). */
	private badgeFeed: ClaudeMissionBadgeFeed | undefined;

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
		this.listEl = append(container, $('.clawdius-missions'));
		this.list = this._register(new FleetRunsList(this.listEl, {
			listAgents: mission => this.listAgentsFor(mission),
			openAgent: agent => this.openAgent(agent),
		}));
		// The LIVE-only badge feed: an owned run's `onDidAction` needs-input/completion event raises a `live` badge on
		// its row. In a runtime with no agent host the null service's `onDidAction` is `Event.None`, so nothing fires
		// and the rows keep the seam's honest polled status - never a fabricated badge.
		this.badgeFeed = this._register(new ClaudeMissionBadgeFeed({
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

	/** List a mission's agents through the seam against the last-resolved root (the drill-in expand). */
	private async listAgentsFor(mission: MissionRun): Promise<readonly MissionAgent[]> {
		if (!this.root) { return []; }
		try {
			return await this.seam.listMissionAgents(this.root, mission);
		} catch {
			return [];
		}
	}

	/**
	 * Open a mission agent's transcript in the editor area via IEditorService (the drill-in). The transcript editor
	 * reads through the seam by `transcriptRef` alone, so a mission agent is adapted to the drill-in shape it
	 * already accepts rather than duplicating an editor for the same read.
	 */
	private openAgent(agent: MissionAgent): void {
		const subagent: FleetSubagent = {
			subagentId: agent.agentId,
			parentRunId: agent.runId,
			transcriptRef: agent.transcriptRef,
			coverage: agent.coverage,
			freshness: agent.freshness,
			completeness: agent.completeness,
		};
		void this.editorService.openEditor(new ClaudeMissionTranscriptInput(subagent), { pinned: true, revealIfOpened: true });
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listEl) {
			this.listEl.style.height = `${height}px`;
		}
	}

	/** Resolve the config root from the active window's home (never a hardcoded path) and list the enumerated runs
	 *  through the seam (the only data path). Honest on failure: an empty labeled list renders the empty
	 *  state rather than throwing. */
	private async refresh(): Promise<void> {
		this.refreshStore.clear();
		const home = await this.pathService.userHome();
		if (this.disposed) { return; }
		const root = resolveConfigRoot(undefined, home);
		this.root = root;
		let runs: readonly MissionRun[] = [];
		try {
			runs = await this.seam.listMissions(root);
		} catch {
			runs = [];
		}
		if (this.disposed) { return; }
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
