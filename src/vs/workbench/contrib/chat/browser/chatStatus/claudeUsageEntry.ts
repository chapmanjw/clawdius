/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude usage entry
// A bottom-right status-bar entry that visualizes the local Claude Code CLI's own usage stats
// (~/.claude/stats-cache.json) - model token usage, cost, and session counts - in the CLI's visual language.
// This replaces the Copilot quota entry (which is suppressed in Clawdius, see chatStatusEntry.ts) so the
// status bar reflects the tool actually powering the chat. Clawdius is "an extension of Claude Code".

import './media/chatStatus.css';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { URI } from '../../../../../base/common/uri.js';
import { $ as h, append, disposableWindowInterval } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import product from '../../../../../platform/product/common/product.js';

interface IClaudeModelStat {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadInputTokens?: number;
	readonly cacheCreationInputTokens?: number;
	readonly costUSD?: number;
}

interface IClaudeStats {
	readonly modelUsage?: { readonly [model: string]: IClaudeModelStat };
	readonly totalSessions?: number;
	readonly totalMessages?: number;
	readonly firstSessionDate?: string;
}

function compact(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
	return `${n}`;
}

/** Friendly model label from a raw model id, e.g. 'claude-opus-4-8' -> 'Opus 4-8'. */
function modelLabel(id: string): string {
	const m = /^claude-(opus|sonnet|haiku)-(.+)$/.exec(id);
	if (m) {
		return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}`;
	}
	return id;
}

export class ClaudeUsageStatusEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusUsageStatusEntry';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private stats: IClaudeStats | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();

		// Only render in Clawdius (Copilot eliminated => defaultChatAgent has no entitlementUrl). Elsewhere
		// the normal Copilot quota entry owns this slot.
		if (product.defaultChatAgent?.entitlementUrl) {
			return;
		}

		this.refresh();
		// Poll periodically - the CLI rewrites stats-cache.json as the user works; a slow poll is plenty.
		this._register(disposableWindowInterval(mainWindow, () => this.refresh(), 30_000));
	}

	private async refresh(): Promise<void> {
		try {
			const home = await this.pathService.userHome();
			const statsUri = URI.joinPath(home, '.claude', 'stats-cache.json');
			const content = await this.fileService.readFile(statsUri);
			this.stats = JSON.parse(content.value.toString()) as IClaudeStats;
		} catch {
			this.stats = undefined; // file missing / unreadable - show the neutral entry
		}
		this.update();
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
		const messages = this.stats?.totalMessages;
		const text = typeof messages === 'number' ? `$(sparkle) ${compact(messages)}` : '$(sparkle) Claude';
		return {
			name: localize('clawdius.usage.name', "Claude Code Usage"),
			text,
			ariaLabel: localize('clawdius.usage.aria', "Claude Code usage"),
			tooltip: { element: () => this.buildTooltip() },
		};
	}

	private buildTooltip(): HTMLElement {
		const root = h('.chat-status-bar-entry-tooltip.clawdius-usage-tooltip');
		const stats = this.stats;

		if (!stats) {
			append(root, h('.quota-title')).textContent = localize('clawdius.usage.none', "Claude Code");
			append(root, h('.quota-details')).textContent = localize('clawdius.usage.noData', "No usage data yet. Use Claude in a terminal or the chat to start tracking.");
			return root;
		}

		// --- Header: total cost across all models ---
		const models = Object.entries(stats.modelUsage ?? {})
			.map(([id, s]) => ({ id, tokens: (s.inputTokens ?? 0) + (s.outputTokens ?? 0), cost: s.costUSD ?? 0 }))
			.filter(m => m.tokens > 0)
			.sort((a, b) => b.tokens - a.tokens);
		const totalCost = models.reduce((sum, m) => sum + m.cost, 0);

		const header = append(root, h('.quota-title'));
		header.textContent = localize('clawdius.usage.title', "Claude Code");
		const costEl = append(header, h('span.quota-value-suffix'));
		costEl.textContent = `  $${totalCost.toFixed(2)}`;

		// --- Model usage bars (top 5 by tokens) ---
		const maxTokens = models[0]?.tokens || 1;
		const list = append(root, h('.clawdius-usage-models'));
		for (const m of models.slice(0, 5)) {
			const row = append(list, h('.clawdius-usage-row'));
			append(row, h('.clawdius-usage-row-label')).textContent = modelLabel(m.id);
			const barTrack = append(row, h('.quota-bar'));
			const barFill = append(barTrack, h('.quota-bit'));
			barFill.style.width = `${Math.max(2, Math.round((m.tokens / maxTokens) * 100))}%`;
			append(row, h('.clawdius-usage-row-value')).textContent = compact(m.tokens);
		}

		// --- Session stats ---
		const footer = append(root, h('.clawdius-usage-footer.quota-details'));
		const sessions = stats.totalSessions ?? 0;
		const totalMessages = stats.totalMessages ?? 0;
		footer.textContent = localize('clawdius.usage.sessions', "{0} sessions . {1} messages", compact(sessions), compact(totalMessages));
		if (stats.firstSessionDate) {
			const since = new Date(stats.firstSessionDate);
			if (!isNaN(since.getTime())) {
				append(root, h('.clawdius-usage-since.quota-reset')).textContent = localize('clawdius.usage.since', "Since {0}", since.toLocaleDateString());
			}
		}

		return root;
	}
}
// CLAWDIUS-END
