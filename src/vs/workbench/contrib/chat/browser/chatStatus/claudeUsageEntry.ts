/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude usage entry
// A bottom-right status-bar entry + hover popup that mirror the Claude Code CLI's own `/usage` view.
// - The status bar shows the Claude rate-limit "capacity" windows as mini bars.
// - The popup shows: the capacity bars (Current session / Current week / per-model), and a Stats section
//   (contribution heatmap + favorite model / total tokens / sessions / streaks), in Claude Code's look.
//
// Two data sources, both the user's own:
// - ~/.claude/stats-cache.json (written by the CLI): historical tokens, sessions, daily activity.
// - GET https://api.anthropic.com/api/oauth/usage (the endpoint the CLI's /usage calls): live capacity %
//   per rate-limit window. This is network EGRESS to Claude's own API using the user's existing CLI OAuth
//   token (~/.claude/.credentials.json). It only runs for this Clawdius usage entry. The user asked for live
//   capacity bars that reference real Claude capacity, so this egress is intended; if it ever needs to be
//   opt-out, gate it behind a setting.

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

// --- Live capacity (rate-limit windows) from /api/oauth/usage ---

interface ICapacityWindow {
	readonly utilization?: number; // 0-100
	readonly resets_at?: string | null;
}

interface IClaudeCapacity {
	readonly five_hour?: ICapacityWindow | null;
	readonly seven_day?: ICapacityWindow | null;
	readonly seven_day_opus?: ICapacityWindow | null;
	readonly seven_day_sonnet?: ICapacityWindow | null;
}

// --- Historical stats from ~/.claude/stats-cache.json ---

interface IClaudeModelStat {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly costUSD?: number;
}

interface IClaudeDailyActivity {
	readonly date?: string;
	readonly messageCount?: number;
}

interface IClaudeStats {
	readonly modelUsage?: { readonly [model: string]: IClaudeModelStat };
	readonly dailyActivity?: ReadonlyArray<IClaudeDailyActivity>;
	readonly totalSessions?: number;
	readonly totalMessages?: number;
	readonly firstSessionDate?: string;
}

// The clawdius-chat extension (node, no CORS) fetches /api/oauth/usage and writes this cache; the renderer
// can't reach api.anthropic.com directly (CORS), so the status entry reads the cache the extension writes.
const CAPACITY_CACHE_FILE = '.clawdius-usage-cache.json';
const HEATMAP_WEEKS = 14;

function compact(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
	return `${Math.round(n)}`;
}

/** Friendly model label, e.g. 'claude-opus-4-8' -> 'Opus 4.8'. */
function modelLabel(id: string): string {
	const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(id);
	if (m) { return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`; }
	const m2 = /^claude-(opus|sonnet|haiku)-(.+)$/.exec(id);
	if (m2) { return `${m2[1].charAt(0).toUpperCase()}${m2[1].slice(1)} ${m2[2]}`; }
	return id;
}

function resetLabel(resets_at: string | null | undefined): string | undefined {
	if (!resets_at) { return undefined; }
	const d = new Date(resets_at);
	if (isNaN(d.getTime())) { return undefined; }
	const now = new Date();
	const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (d.toDateString() === now.toDateString()) { return localize('clawdius.usage.resetsToday', "Resets {0}", time); }
	const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	return localize('clawdius.usage.resetsDay', "Resets {0}, {1}", day, time);
}

/** The Claude mark: a small radial sunburst, referencing actual Claude capacity. */
function appendClaudeMark(parent: HTMLElement, size: number): void {
	const NS = 'http://www.w3.org/2000/svg';
	const doc = parent.ownerDocument;
	const svg = doc.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.classList.add('clawdius-claude-mark');
	for (let i = 0; i < 12; i++) {
		const ray = doc.createElementNS(NS, 'rect');
		ray.setAttribute('x', '11');
		ray.setAttribute('y', '1.5');
		ray.setAttribute('width', '2');
		ray.setAttribute('height', '7');
		ray.setAttribute('rx', '1');
		ray.setAttribute('transform', `rotate(${i * 30} 12 12)`);
		svg.appendChild(ray);
	}
	parent.appendChild(svg);
}

/** A small capacity bar (track + fill) for the status-bar content element. */
function appendCapacityPip(parent: HTMLElement, util: number): void {
	const doc = parent.ownerDocument;
	const track = doc.createElement('span');
	track.className = 'clawdius-usage-pip';
	const fill = doc.createElement('span');
	fill.className = 'clawdius-usage-pip-fill';
	fill.style.height = `${Math.max(10, Math.min(100, util))}%`;
	track.appendChild(fill);
	parent.appendChild(track);
}

export class ClaudeUsageStatusEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusUsageStatusEntry';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private stats: IClaudeStats | undefined;
	private capacity: IClaudeCapacity | undefined;

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
		// Both data sources are local files (the extension does the actual API egress every ~60s), so polling
		// them often is cheap and gives prompt pickup when the capacity cache is (re)written.
		this._register(disposableWindowInterval(mainWindow, () => this.refresh(), 15_000));
	}

	private async refresh(): Promise<void> {
		await Promise.all([this.refreshStats(), this.refreshCapacity()]);
		this.update();
	}

	private async refreshStats(): Promise<void> {
		try {
			const home = await this.pathService.userHome();
			const content = await this.fileService.readFile(URI.joinPath(home, '.claude', 'stats-cache.json'));
			this.stats = JSON.parse(content.value.toString()) as IClaudeStats;
		} catch {
			this.stats = undefined;
		}
	}

	private async refreshCapacity(): Promise<void> {
		try {
			const home = await this.pathService.userHome();
			const content = await this.fileService.readFile(URI.joinPath(home, '.claude', CAPACITY_CACHE_FILE));
			this.capacity = JSON.parse(content.value.toString()) as IClaudeCapacity;
		} catch {
			this.capacity = undefined; // cache not written yet / offline - stats-only
		}
	}

	/** The capacity windows that apply (non-null), in Claude Code's order. */
	private capacityWindows(): { label: string; util: number; resets?: string | null }[] {
		const c = this.capacity;
		if (!c) { return []; }
		const out: { label: string; util: number; resets?: string | null }[] = [];
		const add = (w: ICapacityWindow | null | undefined, label: string) => {
			if (w && typeof w.utilization === 'number') { out.push({ label, util: w.utilization, resets: w.resets_at }); }
		};
		add(c.five_hour, localize('clawdius.usage.session', "Current session"));
		add(c.seven_day, localize('clawdius.usage.week', "Current week (all models)"));
		add(c.seven_day_opus, localize('clawdius.usage.weekOpus', "Current week (Opus)"));
		add(c.seven_day_sonnet, localize('clawdius.usage.weekSonnet', "Current week (Sonnet)"));
		return out;
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
		const windows = this.capacityWindows();
		// Custom content: the Claude mark + one small capacity bar per Claude rate-limit window.
		const content = mainWindow.document.createElement('div');
		content.className = 'clawdius-usage-statusbar';
		appendClaudeMark(content, 13);
		if (windows.length > 0) {
			const pips = mainWindow.document.createElement('span');
			pips.className = 'clawdius-usage-pips';
			for (const w of windows) {
				appendCapacityPip(pips, w.util);
			}
			content.appendChild(pips);
		} else if (typeof this.stats?.totalMessages === 'number') {
			const label = mainWindow.document.createElement('span');
			label.className = 'clawdius-usage-statusbar-label';
			label.textContent = compact(this.stats.totalMessages);
			content.appendChild(label);
		}
		return {
			name: localize('clawdius.usage.name', "Claude Code Usage"),
			text: '',
			ariaLabel: localize('clawdius.usage.aria', "Claude Code usage"),
			content,
			tooltip: { element: () => this.buildTooltip() },
		};
	}

	private buildTooltip(): HTMLElement {
		const root = h('.chat-status-bar-entry-tooltip.clawdius-usage-tooltip');
		const header = append(root, h('.clawdius-usage-header'));
		appendClaudeMark(header, 16);
		append(header, h('span.clawdius-usage-header-text')).textContent = localize('clawdius.usage.brand', "Claude Code");

		// --- Usage: capacity bars (Current session / week / per-model) ---
		const windows = this.capacityWindows();
		if (windows.length > 0) {
			const section = append(root, h('.clawdius-usage-section'));
			append(section, h('.clawdius-usage-section-title')).textContent = localize('clawdius.usage.usageTitle', "Usage");
			for (const w of windows) {
				const block = append(section, h('.clawdius-usage-capacity'));
				const head = append(block, h('.clawdius-usage-capacity-head'));
				append(head, h('span.clawdius-usage-capacity-label')).textContent = w.label;
				append(head, h('span.clawdius-usage-capacity-pct')).textContent = localize('clawdius.usage.pctUsed', "{0}% used", Math.round(w.util));
				const track = append(block, h('.quota-bar'));
				append(track, h('.quota-bit')).style.width = `${Math.max(1, Math.min(100, w.util))}%`;
				const reset = resetLabel(w.resets);
				if (reset) { append(block, h('.clawdius-usage-capacity-reset')).textContent = reset; }
			}
		}

		// --- Stats: contribution heatmap + grid ---
		const stats = this.stats;
		if (stats) {
			const section = append(root, h('.clawdius-usage-section'));
			append(section, h('.clawdius-usage-section-title')).textContent = localize('clawdius.usage.statsTitle', "Stats");
			this.buildHeatmap(section, stats.dailyActivity ?? []);

			const models = Object.entries(stats.modelUsage ?? {})
				.map(([id, s]) => ({ id, tokens: (s.inputTokens ?? 0) + (s.outputTokens ?? 0) }))
				.filter(m => m.tokens > 0)
				.sort((a, b) => b.tokens - a.tokens);
			const totalTokens = models.reduce((sum, m) => sum + m.tokens, 0);

			const grid = append(section, h('.clawdius-usage-grid'));
			const cell = (label: string, value: string) => {
				const c = append(grid, h('.clawdius-usage-cell'));
				append(c, h('span.clawdius-usage-cell-label')).textContent = label;
				append(c, h('span.clawdius-usage-cell-value')).textContent = value;
			};
			if (models[0]) { cell(localize('clawdius.usage.favorite', "Favorite model"), modelLabel(models[0].id)); }
			cell(localize('clawdius.usage.totalTokens', "Total tokens"), compact(totalTokens));
			cell(localize('clawdius.usage.sessionsLabel', "Sessions"), compact(stats.totalSessions ?? 0));
			cell(localize('clawdius.usage.messagesLabel', "Messages"), compact(stats.totalMessages ?? 0));
		}

		if (windows.length === 0 && !stats) {
			append(root, h('.clawdius-usage-empty')).textContent = localize('clawdius.usage.noData', "No Claude Code usage data yet.");
		}

		return root;
	}

	/** A compact GitHub-style contribution heatmap of the most recent weeks (7 rows x N columns). */
	private buildHeatmap(parent: HTMLElement, activity: ReadonlyArray<IClaudeDailyActivity>): void {
		const byDate = new Map<string, number>();
		let max = 1;
		for (const a of activity) {
			if (a.date) {
				const count = a.messageCount ?? 0;
				byDate.set(a.date.slice(0, 10), count);
				max = Math.max(max, count);
			}
		}
		const grid = append(parent, h('.clawdius-usage-heatmap'));
		const today = new Date();
		// Walk back to the start of the grid (Sunday HEATMAP_WEEKS ago), then forward column by column.
		const start = new Date(today);
		start.setDate(start.getDate() - (HEATMAP_WEEKS * 7 - 1));
		for (let col = 0; col < HEATMAP_WEEKS; col++) {
			const week = append(grid, h('.clawdius-usage-heatmap-week'));
			for (let row = 0; row < 7; row++) {
				const day = new Date(start);
				day.setDate(start.getDate() + col * 7 + row);
				const cell = append(week, h('.clawdius-usage-heatmap-day'));
				if (day > today) {
					cell.style.visibility = 'hidden';
					continue;
				}
				const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
				const count = byDate.get(key) ?? 0;
				const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
				cell.classList.add(`level-${level}`);
			}
		}
	}
}
// CLAWDIUS-END
