/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude usage status-bar indicator + hover popup
// A bottom-right status-bar entry that shows the Claude wordmark (inheriting the status-bar text color) and two
// inline horizontal bars - "S:" (session) and "W:" (week) - visualizing the current subscription usage.
// Hovering opens a popup with the account identity and the same Session / Weekly bars. Clicking opens the
// Control Center on its Usage tab. The bars are hidden when the engine provider has no subscription windows
// (Bedrock/Vertex/custom). All data is local; opening the hover is the sole, user-initiated trigger for the one
// allowed /api/oauth/usage refresh.

import './media/claudeUsage.css';
import { $ as h, append, clearNode, disposableWindowInterval } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { blockBar } from './claudeUsageCharts.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import product from '../../../../../platform/product/common/product.js';
import { registerColor } from '../../../../../platform/theme/common/colorRegistry.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	appendClaudeLogo, capacityWindows, compact, IClaudeAccount, IClaudeCapacity, IClaudeStats, IUsageWindow,
	providerHasLimits, providerLabel, readAccount, readCapacity, readStats, resetLabel,
} from './claudeUsageData.js';
import { IClaudeUsageCapacityRefresh } from './claudeUsageCapacityRefresh.js';
import { OPEN_CONTROL_CENTER_COMMAND_ID } from '../control/claudeControlCenterInput.js';

/** Middle-dot separator, built via char code to keep the source ASCII-only. */
const SEP = String.fromCharCode(0xB7);

/** NUL sentinel the label renderer recognises to emit per-cell bar spans (so the bar sizes/aligns like the
 * effort meter). The "usage" class keeps the cells in the entry's own colour. */
const NUL = String.fromCharCode(0);

/** Width (in block characters) of each inline bar in the status-bar label (two bars share the row, so narrow). */
const STATUS_BAR_CELLS = 6;

// Self-contained colors for the hover popup progress bars (the "Current session" / "Current week" capacity
// bars). We deliberately do NOT derive the track/fill from --vscode- theme tokens: the old track used
// statusBarItem.remoteBackground, which third-party themes (e.g. Dracula) paint a light purple nearly identical
// to the lavender fill, so the fill level became unreadable. Pinning a brand-orange FILL over a neutral-gray
// TRACK, with explicit dark/light/hcDark/hcLight values, guarantees fill-vs-track contrast on ANY theme. These
// registrations emit the CSS variables --vscode-clawdius-usageBarFill / --vscode-clawdius-usageBarTrack that
// media/claudeUsage.css consumes (every registered color becomes a --vscode-<id> variable via colorThemeCss).
registerColor('clawdius.usageBarFill', {
	dark: '#D97757', light: '#C15F3C', hcDark: '#FF9E7A', hcLight: '#8A3A1A'
}, localize('clawdius.usage.barFill', "Fill color of the Claude Code Usage hover progress bars (session / weekly capacity)."));
registerColor('clawdius.usageBarTrack', {
	dark: '#4D4D4D', light: '#CDCDCD', hcDark: '#4D4D4D', hcLight: '#CDCDCD'
}, localize('clawdius.usage.barTrack', "Track (unfilled) color of the Claude Code Usage hover progress bars."));

/** Utilization thresholds for the bar color state. */
export function utilState(util: number): 'ok' | 'warn' | 'crit' {
	if (util >= 90) { return 'crit'; }
	if (util >= 70) { return 'warn'; }
	return 'ok';
}

/**
 * The status-bar entry's label text + aria label for an account + capacity snapshot. Pure (no DOM, no IO): the
 * Claude mark, plus "S:" (session) and "W:" (week) NUL-delimited block-bar runs when the provider has
 * subscription windows; just the bare mark otherwise (non-subscription providers, or a cold capacity cache).
 */
export function usageStatusText(account: IClaudeAccount | undefined, capacity: IClaudeCapacity | undefined): { text: string; ariaLabel: string } {
	const hasLimits = account ? providerHasLimits(account.provider) : true;
	const windows = hasLimits ? capacityWindows(capacity) : [];
	const session = windows.find(w => w.key === 'session');
	const weekly = windows.find(w => w.key === 'week');
	const seg = (w: IUsageWindow) => `${NUL}usage${NUL}${blockBar(w.util / 100, STATUS_BAR_CELLS)}${NUL}`;
	const parts: string[] = [];
	if (session) { parts.push(`${localize('clawdius.usage.sessionShort', "S:")}${seg(session)}`); }
	if (weekly) { parts.push(`${localize('clawdius.usage.weekShort', "W:")}${seg(weekly)}`); }
	const text = parts.length > 0 ? `$(claude) ${parts.join('  ')}` : '$(claude)';

	const ariaParts: string[] = [];
	if (session) { ariaParts.push(localize('clawdius.usage.ariaSession', "session {0}% used", Math.round(session.util))); }
	if (weekly) { ariaParts.push(localize('clawdius.usage.ariaWeek', "week {0}% used", Math.round(weekly.util))); }
	const ariaLabel = ariaParts.length > 0
		? localize('clawdius.usage.ariaWithUsage', "Claude Code usage: {0}", ariaParts.join(', '))
		: localize('clawdius.usage.aria', "Claude Code usage");
	return { text, ariaLabel };
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
	private currentTooltip: HTMLElement | undefined;
	private stats: IClaudeStats | undefined;
	private capacity: IClaudeCapacity | undefined;
	private account: IClaudeAccount | undefined;
	private _refreshingOnDemand = false;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IClaudeUsageCapacityRefresh private readonly capacityRefresh: IClaudeUsageCapacityRefresh,
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
			await this.capacityRefresh.refresh(false);
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

	private update(): void {
		const props = this.getProps();
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			// Absolute priority (not a relative anchor): anchoring next to status.editor.mode drops this into the
			// status bar's relative-entry bucket and, when that reference entry is absent or shares the number,
			// the slot oscillates (drifting left of effort / right of the budget pill). A fixed number pins it.
			// The Clawdius cluster, left -> right (higher priority = further left): effort 100.07, permission
			// 100.06, context budget 100.05, usage 100.04 (rightmost, just right of the budget pill).
			this.entry.value = this.statusbarService.addEntry(props, 'clawdius.usage', StatusbarAlignment.RIGHT, 100.04);
		}
	}

	private getProps(): IStatusbarEntry {
		// Render the Claude mark + (when subscription windows apply) two labelled block-character bars as the
		// entry's LABEL TEXT: "S: <bar>  W: <bar>". Each bar is a NUL-delimited meter run the label renderer
		// splits into per-cell spans (the "usage" class keeps them in the entry's own colour). The native
		// status-bar item handles cursor / hover-highlight / click via its `command` and updates in place.
		const { text, ariaLabel } = usageStatusText(this.account, this.capacity);
		return {
			name: localize('clawdius.usage.name', "Claude Code Usage"),
			text,
			ariaLabel,
			command: { id: OPEN_CONTROL_CENTER_COMMAND_ID, title: localize('clawdius.usage.openControlCenter', "Open Claude Code Control Center"), arguments: ['usage'] },
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
		// No CTA: clicking the status-bar entry itself opens the Control Center (Usage tab).
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
