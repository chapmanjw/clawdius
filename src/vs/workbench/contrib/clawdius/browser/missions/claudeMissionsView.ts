/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet - Sidebar (Activity Bar) ViewPane (US1)
// A native-DOM ViewPane (pattern: clawdiusContextBudgetView) listing the runs the reader seam enumerates
// (Slice 1's listRuns). Each FleetRun renders with its coarse status and the four honesty labels (coverage /
// freshness / completeness + ownership); a foreign or suppressed run is rendered PRESENT-WITH-LABEL (SC-002),
// never hidden. The view consumes ONLY the seam (FR-002): it resolves the config root from IPathService.userHome
// (never a hardcoded ~/.claude) and calls the seam's listRuns - no direct Claude config-tree read, no egress.
// Rows carry data-* hooks so the real-build Playwright render can assert them. A large fleet is appended in
// animation-frame batches so enumeration of many runs never blocks the workbench thread.

import './media/claudeMissions.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
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
import { FleetRun, FleetSubagent } from '../../common/claudeFleetModel.js';
import { CoverageLabel, ReaderConfigRoot, ReaderScope, resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';
import { ClaudeMissionTranscriptInput } from './claudeMissionTranscriptInput.js';

export const MISSIONS_VIEW_CONTAINER_ID = 'workbench.view.clawdiusMissions';
export const MISSIONS_VIEW_ID = 'clawdius.missions';

/** The minimal run-enumeration surface the fleet view binds to (Slice 1's listRuns). Structural so a unit test
 *  can supply a fake without instantiating the full seam service. */
export interface IFleetRunSource {
	listRuns(root: ReaderConfigRoot, scope?: ReaderScope): Promise<readonly FleetRun[]>;
}

/** Append one FleetRun as a labeled row, carrying every honesty label as both a badge and a `data-*` hook so a
 *  Playwright render can assert it. A foreign/suppressed run gets a `foreign` marker class but is never omitted. */
export function appendRunRow(parent: HTMLElement, run: FleetRun): HTMLElement {
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
	append(labels, $(`.clawdius-missions-label.coverage-${run.coverage}`, undefined, localize('clawdius.missions.coverage', "coverage: {0}", run.coverage)));
	append(labels, $(`.clawdius-missions-label.freshness-${run.freshness}`, undefined, localize('clawdius.missions.freshness', "freshness: {0}", run.freshness)));
	append(labels, $(`.clawdius-missions-label.completeness-${run.completeness}`, undefined, localize('clawdius.missions.completeness', "completeness: {0}", run.completeness)));
	append(labels, $(`.clawdius-missions-label.ownership-${run.ownership}`, undefined, localize('clawdius.missions.ownership', "ownership: {0}", run.ownership)));
	return row;
}

/** The per-row drill-in wiring the ViewPane supplies (kept out of the pure list so a unit test can render rows
 *  without a workbench host): expand a run to its subagents, and open a subagent's transcript in the editor area. */
export interface IFleetRowInteractions {
	/** List a run's subagents through the seam (SC-002: present-with-label, never dropped). */
	listSubagents(run: FleetRun): Promise<readonly FleetSubagent[]>;
	/** Open a subagent's transcript in the editor area (the drill-in - US2). */
	openSubagent(subagent: FleetSubagent): void;
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

	/** @param interactions when supplied, each run row expands to its subagents and a subagent opens its transcript;
	 *  omitted (the pure unit-test path) leaves rows non-interactive. */
	constructor(private readonly container: HTMLElement, private readonly interactions?: IFleetRowInteractions) {
		super();
		// A render (or disposal) after an expand's async listSubagents was issued must invalidate that in-flight
		// expansion; the generation counter is the guard the expand closure checks after its await.
		this._register(toDisposable(() => { this.generation++; }));
	}

	render(runs: readonly FleetRun[]): void {
		this.pendingBatch.clear();
		this.rowStore.clear();
		this.generation++;
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
				const row = appendRunRow(this.container, runs[i]);
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

	/** Make a run row expandable: a click (or Enter/Space) toggles an inline child list of the run's subagents,
	 *  fetched lazily through the seam; clicking a subagent opens its transcript. Only wired when interactions were
	 *  supplied. */
	private wireRunRow(row: HTMLElement, run: FleetRun): void {
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
			let subs: readonly FleetSubagent[] = [];
			try { subs = await interactions.listSubagents(run); } catch { subs = []; }
			// Bail if this expansion is stale: a collapse/re-expand replaced this child (child !== mine), OR a
			// full render() / disposal tore the row down (generation moved) - in the latter case mine is detached
			// and childStore is already disposed, so appending or adding listeners would be a leak/no-op warning.
			if (child !== mine || this.generation !== gen) { return; }
			clearNode(mine);
			if (subs.length === 0) {
				append(mine, $('.clawdius-missions-subempty', { 'data-clawdius-missions-subempty': 'true' })).textContent =
					localize('clawdius.missions.noSubagents', "No subagents for this run.");
				return;
			}
			for (const sub of subs) {
				const subrow = appendSubagentRow(mine, sub);
				const open = () => interactions.openSubagent(sub);
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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		// The seam service is not a registered singleton; instantiate it (teams probe off) so the view reads runs
		// through the SAME enumeration the Slice-1 tests exercise. It is stateless + read-only (not a disposable).
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
			listSubagents: run => this.listSubagentsFor(run),
			openSubagent: sub => this.openSubagent(sub),
		}));
		void this.refresh();
	}

	/** List a run's subagents through the seam against the last-resolved root (the drill-in expand - US2). */
	private async listSubagentsFor(run: FleetRun): Promise<readonly FleetSubagent[]> {
		if (!this.root) { return []; }
		try {
			return await this.seam.listSubagents(this.root, run);
		} catch {
			return [];
		}
	}

	/** Open a subagent's transcript in the editor area via IEditorService (the drill-in - US2). */
	private openSubagent(sub: FleetSubagent): void {
		void this.editorService.openEditor(new ClaudeMissionTranscriptInput(sub), { pinned: true, revealIfOpened: true });
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listEl) {
			this.listEl.style.height = `${height}px`;
		}
	}

	/** Resolve the config root from the active window's home (never a hardcoded path) and list the enumerated runs
	 *  through the seam (FR-002 - the only data path). Honest on failure: an empty labeled list renders the empty
	 *  state rather than throwing. */
	private async refresh(): Promise<void> {
		this.refreshStore.clear();
		const home = await this.pathService.userHome();
		if (this.disposed) { return; }
		const root = resolveConfigRoot(undefined, home);
		this.root = root;
		let runs: readonly FleetRun[] = [];
		try {
			runs = await this.seam.listRuns(root);
		} catch {
			runs = [];
		}
		if (this.disposed) { return; }
		this.list?.render(runs);
	}
}
// CLAWDIUS-END
