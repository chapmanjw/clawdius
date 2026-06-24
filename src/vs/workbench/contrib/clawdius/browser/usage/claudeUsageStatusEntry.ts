/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude usage status-bar indicator + hover popup
// A bottom-right status-bar entry that shows the Claude wordmark (inheriting the status-bar text color) and a
// single inline horizontal bar visualizing the current session's subscription usage. Hovering opens a popup
// with the account identity and a simple set of horizontal Session / Weekly bars. Clicking
// opens the full usage dashboard. The session bar is hidden when the engine provider has no subscription
// windows (Bedrock/Vertex/custom). All data is local; opening the hover is the sole, user-initiated trigger
// for the one allowed /api/oauth/usage refresh.

import './media/claudeUsage.css';
import { $ as h, addDisposableListener, append, clearNode, disposableWindowInterval, EventType } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { blockBar } from './claudeUsageCharts.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import product from '../../../../../platform/product/common/product.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	appendClaudeLogo, capacityWindows, compact, IClaudeAccount, IClaudeCapacity, IClaudeStats, IUsageWindow,
	OPEN_USAGE_DASHBOARD_COMMAND_ID, providerHasLimits, providerLabel, readAccount, readCapacity, readStats,
	REFRESH_CAPACITY_COMMAND_ID, resetLabel,
} from './claudeUsageData.js';

/** Middle-dot separator, built via char code to keep the source ASCII-only. */
const SEP = String.fromCharCode(0xB7);

/** Width (in block characters) of the inline session bar in the status-bar label. */
const STATUS_BAR_CELLS = 10;

/** Utilization thresholds for the bar color state. */
function utilState(util: number): 'ok' | 'warn' | 'crit' {
	if (util >= 90) { return 'crit'; }
	if (util >= 70) { return 'warn'; }
	return 'ok';
}

/** Append a CSS track + fill bar for the hover popup capacity bars. */
function appendBar(parent: HTMLElement, util: number): void {
	const track = append(parent, h('.clawdius-usage-bar'));
	const fill = append(track, h('.clawdius-usage-bar-fill'));
	const state = utilState(util);
	if (state !== 'ok') { fill.classList.add(`state-${state}`); }
	fill.style.width = `${Math.max(2, Math.min(100, util))}%`;
}

export class ClaudeUsageStatusEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusUsageStatusEntry';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly hoverStore = this._register(new DisposableStore());
	private currentTooltip: HTMLElement | undefined;
	private stats: IClaudeStats | undefined;
	private capacity: IClaudeCapacity | undefined;
	private account: IClaudeAccount | undefined;
	private _refreshingOnDemand = false;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		// Only render in Clawdius mode (defaultChatAgent has no entitlementUrl). Elsewhere the upstream
		// quota status entry owns this slot.
		if (product.defaultChatAgent?.entitlementUrl) {
			return;
		}

		void this.refresh();
		// Both data sources are LOCAL files (no network): stats-cache.json and the on-demand capacity cache.
		// Polling them every 15s is cheap and picks up the capacity cache promptly after a user-initiated fetch.
		this._register(disposableWindowInterval(mainWindow, () => this.refresh(), 15_000));
	}

	private async claudeDir(): Promise<URI> {
		return URI.joinPath(await this.pathService.userHome(), '.claude');
	}

	/**
	 * Trigger the clawdius-chat extension's capacity fetch ON DEMAND (the user just opened the usage popup),
	 * then re-read the cache it writes and re-render. This is the sole api.anthropic.com egress for the usage
	 * surfaces and it is user-initiated; there is no startup fetch or background poll.
	 */
	private async refreshOnDemand(): Promise<void> {
		if (this._refreshingOnDemand) {
			return;
		}
		this._refreshingOnDemand = true;
		try {
			await this.commandService.executeCommand(REFRESH_CAPACITY_COMMAND_ID);
			await this.refresh();
			// If the hover is still open, re-render it in place with the freshly fetched capacity (the first
			// cold-cache hover would otherwise keep showing the local-only fallback until the next hover).
			if (this.currentTooltip?.isConnected) {
				this.renderTooltipInto(this.currentTooltip);
			}
		} catch {
			// best-effort: offline / extension not yet active / expired token - keep showing any cached data
		} finally {
			this._refreshingOnDemand = false;
		}
	}

	private async refresh(): Promise<void> {
		const dir = await this.claudeDir();
		const [stats, capacity] = await Promise.all([readStats(this.fileService, dir), readCapacity(this.fileService, dir)]);
		this.stats = stats;
		this.capacity = capacity;
		this.account = await readAccount(this.fileService, dir, capacity);
		this.update();
	}

	/** The session (5-hour) window, the one summarized inline in the status bar. */
	private sessionWindow(): IUsageWindow | undefined {
		return capacityWindows(this.capacity).find(w => w.key === 'session');
	}

	private update(): void {
		const props = this.getProps();
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			this.entry.value = this.statusbarService.addEntry(props, 'clawdius.usage', StatusbarAlignment.RIGHT, { location: { id: 'status.editor.mode', priority: 100.05 }, alignment: StatusbarAlignment.RIGHT });
		}
	}

	private getProps(): IStatusbarEntry {
		// Render the Claude mark + (when a subscription session window applies) a block-character bar as the
		// entry's LABEL TEXT. The native status-bar item then handles cursor / hover-highlight / click via its
		// `command`, and updates the label in place - so there is no custom DOM to swap and no hover flicker.
		const hasLimits = this.account ? providerHasLimits(this.account.provider) : true;
		const session = hasLimits ? this.sessionWindow() : undefined;
		const text = session ? `$(claude) ${blockBar(session.util / 100, STATUS_BAR_CELLS)}` : '$(claude)';

		return {
			name: localize('clawdius.usage.name', "Claude Code Usage"),
			text,
			ariaLabel: session
				? localize('clawdius.usage.ariaWithSession', "Claude Code usage: session {0}% used", Math.round(session.util))
				: localize('clawdius.usage.aria', "Claude Code usage"),
			command: OPEN_USAGE_DASHBOARD_COMMAND_ID,
			// Opening the popup is the user-initiated signal to refresh live capacity (on-demand egress).
			tooltip: { element: () => { void this.refreshOnDemand(); return this.buildTooltip(); } },
		};
	}

	private buildTooltip(): HTMLElement {
		const root = h('.chat-status-bar-entry-tooltip.clawdius-usage-tooltip');
		this.currentTooltip = root;
		this.renderTooltipInto(root);
		return root;
	}

	/** (Re)render the hover contents into `root`. Called on open and again when an on-demand refresh lands. */
	private renderTooltipInto(root: HTMLElement): void {
		this.hoverStore.clear();
		clearNode(root);

		// Header: brand + account identity row.
		const header = append(root, h('.clawdius-usage-header'));
		appendClaudeLogo(header, 16);
		append(header, h('span.clawdius-usage-header-text')).textContent = localize('clawdius.usage.brand', "Claude Code Usage");
		this.appendAccountLine(root);

		const account = this.account;
		const hasLimits = account ? providerHasLimits(account.provider) : true;
		const windows = capacityWindows(this.capacity);

		if (hasLimits && windows.length > 0) {
			// Simple set of horizontal usage bars (Session / Weekly / per-model).
			const section = append(root, h('.clawdius-usage-section'));
			for (const w of windows) {
				const block = append(section, h('.clawdius-usage-capacity'));
				const head = append(block, h('.clawdius-usage-capacity-head'));
				append(head, h('span.clawdius-usage-capacity-label')).textContent = w.label;
				append(head, h('span.clawdius-usage-capacity-pct')).textContent = localize('clawdius.usage.pctUsed', "{0}% used", Math.round(w.util));
				appendBar(block, w.util);
				const reset = resetLabel(w.resets);
				if (reset) { append(block, h('.clawdius-usage-capacity-reset')).textContent = reset; }
			}
		} else if (!hasLimits && account) {
			// Non-subscription provider: limits do not apply. Show a calm note + local activity instead.
			append(root, h('.clawdius-usage-note')).textContent = localize('clawdius.usage.noLimits', "Subscription limits don't apply on {0}.", providerLabel(account.provider));
			this.appendLocalSummary(root);
		} else {
			// Anthropic provider but no cached capacity yet (the on-demand fetch is in flight on first open).
			this.appendLocalSummary(root);
		}

		// CTA into the full dashboard, with a trailing external-link glyph to read as a link.
		const cta = append(root, h('a.clawdius-usage-cta'));
		append(cta, h('span')).textContent = localize('clawdius.usage.openDashboard', "Open Usage Dashboard");
		append(cta, h('span.codicon.codicon-link-external.clawdius-usage-cta-icon'));
		cta.setAttribute('role', 'button');
		cta.setAttribute('tabindex', '0');
		const open = () => void this.commandService.executeCommand(OPEN_USAGE_DASHBOARD_COMMAND_ID);
		this.hoverStore.add(addDisposableListener(cta, EventType.CLICK, open));
		this.hoverStore.add(addDisposableListener(cta, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
		}));
	}

	private appendAccountLine(root: HTMLElement): void {
		const account = this.account;
		if (!account) { return; }
		const line = append(root, h('.clawdius-usage-account'));
		const parts: string[] = [];
		if (account.email) { parts.push(account.email); }
		if (account.planTier) { parts.push(account.planTier); }
		parts.push(providerLabel(account.provider));
		line.textContent = parts.join(` ${SEP} `);
		if (!account.signedIn) {
			append(line, h('span.clawdius-usage-account-state')).textContent = localize('clawdius.usage.signedOut', "Signed out");
		}
	}

	private appendLocalSummary(root: HTMLElement): void {
		const stats = this.stats;
		if (!stats || typeof stats.totalMessages !== 'number') { return; }
		const line = append(root, h('.clawdius-usage-note'));
		line.textContent = localize('clawdius.usage.localSummary', "{0} messages · {1} sessions", compact(stats.totalMessages), compact(stats.totalSessions ?? 0));
	}
}
// CLAWDIUS-END
