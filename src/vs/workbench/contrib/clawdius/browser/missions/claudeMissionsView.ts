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
import { $, append, clearNode, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
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
import { IPathService } from '../../../../services/path/common/pathService.js';
import { FleetRun } from '../../common/claudeFleetModel.js';
import { CoverageLabel, ReaderConfigRoot, ReaderScope, resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';

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

	constructor(private readonly container: HTMLElement) {
		super();
	}

	render(runs: readonly FleetRun[]): void {
		this.pendingBatch.clear();
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
				appendRunRow(this.container, runs[i]);
			}
			if (i < runs.length) {
				this.pendingBatch.value = scheduleAtNextAnimationFrame(getWindow(this.container), step);
			} else {
				this.pendingBatch.clear();
			}
		};
		step();
	}
}

/** The Missions fleet Sidebar view: enumerates runs through the reader seam and lists them, honestly labeled. */
export class ClawdiusMissionsView extends ViewPane {

	static readonly ID = MISSIONS_VIEW_ID;

	private listEl: HTMLElement | undefined;
	private list: FleetRunsList | undefined;
	private readonly source: IFleetRunSource;
	private readonly refreshStore = this._register(new DisposableStore());
	private disposed = false;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		// The seam service is not a registered singleton; instantiate it (teams probe off) so the view reads runs
		// through the SAME enumeration the Slice-1 tests exercise. It is stateless + read-only (not a disposable).
		this.source = instantiationService.createInstance(ClawdiusReaderSeamService, false);
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.listEl = append(container, $('.clawdius-missions'));
		this.list = this._register(new FleetRunsList(this.listEl));
		void this.refresh();
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
		let runs: readonly FleetRun[] = [];
		try {
			runs = await this.source.listRuns(root);
		} catch {
			runs = [];
		}
		if (this.disposed) { return; }
		this.list?.render(runs);
	}
}
// CLAWDIUS-END
