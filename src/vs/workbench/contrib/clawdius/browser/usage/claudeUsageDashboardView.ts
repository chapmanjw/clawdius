/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude usage dashboard view (reusable)
// The usage dashboard rendering, extracted from the editor pane so it can be hosted in two places: the
// standalone Usage editor AND the Control Center's Usage tab. A native DOM view (no webview => trivially
// zero-egress) in the monospace terminal aesthetic of the CLI's /usage view: block-shade limit bars, a
// contribution heatmap, an SVG Tokens-per-Day chart, a model breakdown, and 24h activity. All data is the
// user's own local files (~/.claude/stats-cache.json + the on-demand capacity cache). `load()` only READS
// local files; the live /api/oauth/usage refresh runs only on the Refresh button (user-initiated). The view
// renders `.clawdius-usage-dashboard-inner` into the container it is given - the caller owns the outer
// scroll/padding wrapper. Cost is never shown - usage and limits only.

import './media/claudeUsage.css';
import { $ as h, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import {
	capacityWindows, compact, computeStreaks, formatDuration, IClaudeAccount, IClaudeCapacity, IClaudeDailyModelTokens,
	IClaudeStats, modelLabel, providerHasLimits, providerLabel, readAccount, readCapacity, readStats,
	REFRESH_CAPACITY_COMMAND_ID, resetLabel, resolveModelRows,
} from './claudeUsageData.js';

/** Where the session/token stats came from: our accurate transcript aggregate, the CLI's cache, or nothing. */
type StatsSource = 'transcripts' | 'cli' | 'none';

type Range = 'all' | '30d' | '7d';

const HEATMAP_WEEKS = 52;
const MAX_CHART_MODELS = 5;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Per-model line colors for the chart + legend (lavender / green / gold / sky / pink / gray). */
const MODEL_COLORS = ['#a78bfa', '#7bc96f', '#e3b341', '#38bdf8', '#f472b6', '#9aa4b2'];

function utilStateOf(util: number): 'warn' | 'crit' | undefined {
	if (util >= 90) { return 'crit'; }
	if (util >= 70) { return 'warn'; }
	return undefined;
}

interface ILoaded {
	readonly stats: IClaudeStats | undefined;
	readonly statsSource: StatsSource;
	readonly capacity: IClaudeCapacity | undefined;
	readonly account: IClaudeAccount;
	readonly refreshedAt: Date | undefined;
}

function dateKey(day: Date): string {
	return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/**
 * Renders the usage dashboard into a caller-owned container. Construct it, call {@link load}, dispose when the
 * host goes away. Self-contained: owns its render store, refresh token, range state, and loaded data, so its
 * range tabs + Refresh re-render only itself, independent of any host.
 */
export class ClaudeUsageDashboardView extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());
	private readonly refreshCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private refreshing = false;
	private disposed = false;
	private range: Range = 'all';
	private loaded: ILoaded | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly fileService: IFileService,
		private readonly pathService: IPathService,
		private readonly commandService: ICommandService,
		private readonly agentHostService: IAgentHostService,
	) {
		super();
	}

	private async claudeDir(): Promise<URI> {
		return URI.joinPath(await this.pathService.userHome(), '.claude');
	}

	/** Two-phase load (all local reads; zero egress). Phase 1: capacity + account + the CLI stats-cache fallback,
	 *  rendered immediately so the dashboard never blocks. Phase 2: the accurate transcript aggregate (a few
	 *  seconds cold, near-instant warm) replaces the stats when it lands. Bails if cancelled or disposed mid-read
	 *  (e.g. the Control Center left the Usage tab) so a late completion never renders into a detached node. */
	async load(token: CancellationToken): Promise<void> {
		const dir = await this.claudeDir();
		const [cliStats, capacity] = await Promise.all([readStats(this.fileService, dir), readCapacity(this.fileService, dir)]);
		if (token.isCancellationRequested || this.disposed) { return; }
		const account = await readAccount(this.fileService, dir, capacity);
		let refreshedAt: Date | undefined;
		try {
			const stat = await this.fileService.stat(URI.joinPath(dir, '.clawdius-usage-cache.json'));
			refreshedAt = stat.mtime ? new Date(stat.mtime) : undefined;
		} catch {
			refreshedAt = undefined;
		}
		if (token.isCancellationRequested || this.disposed) { return; }
		// Phase 1: paint immediately with the CLI cache (or nothing) as a fast fallback.
		this.loaded = { stats: cliStats, statsSource: cliStats ? 'cli' : 'none', capacity, account, refreshedAt };
		this.render();
		// Phase 2: compute the accurate, always-current stats from the raw transcripts and swap them in.
		await this.loadTranscriptStats(token);
	}

	/** Aggregate the raw transcripts (off the UI thread, via the agentHost) and swap in the accurate stats. */
	private async loadTranscriptStats(token: CancellationToken): Promise<void> {
		const home = (await this.pathService.userHome()).fsPath;
		let result;
		try {
			result = await this.agentHostService.getUsageStats(home);
		} catch {
			return; // keep the CLI-cache fallback already shown
		}
		if (token.isCancellationRequested || this.disposed || !this.loaded) { return; }
		if (result.status === 'ok' && result.stats) {
			this.loaded = { ...this.loaded, stats: result.stats, statsSource: 'transcripts' };
			this.render();
		}
	}

	private async refreshOnDemand(): Promise<void> {
		if (this.refreshing) { return; }
		this.refreshing = true;
		const cts = new CancellationTokenSource();
		this.refreshCts.value = cts;
		try {
			await this.commandService.executeCommand(REFRESH_CAPACITY_COMMAND_ID);
			if (cts.token.isCancellationRequested) { return; }
			await this.load(cts.token);
		} catch {
			// best-effort: offline / extension not active / expired token - keep showing cached data
		} finally {
			this.refreshing = false;
		}
	}

	override dispose(): void {
		this.disposed = true;
		this.refreshCts.value?.cancel();
		super.dispose();
	}

	// --- Rendering ---

	private render(): void {
		if (this.disposed || !this.loaded) { return; }
		const { stats, statsSource, capacity, account, refreshedAt } = this.loaded;
		this.renderStore.clear();
		clearNode(this.container);
		const inner = append(this.container, h('.clawdius-usage-dashboard-inner'));

		this.renderHero(inner, account, refreshedAt, statsSource, stats?.lastComputedDate);
		this.renderLimits(inner, capacity, account);
		if (stats) {
			this.renderOverview(inner, stats);
			this.renderTokensPerDay(inner, stats);
			this.renderHourActivity(inner, stats);
		}
		if (!stats && capacityWindows(capacity).length === 0) {
			append(inner, h('.clawdius-usage-empty')).textContent = localize('clawdius.usage.dash.noData', "No Claude Code usage data yet. Start a session to see your usage here.");
		}
	}

	private sectionTitle(parent: HTMLElement, text: string): HTMLElement {
		const block = append(parent, h('.clawdius-usage-block'));
		append(block, h('.clawdius-usage-block-title')).textContent = text;
		return block;
	}

	/** Format a YYYY-MM-DD date string in the local locale (parsed as local midnight to avoid a TZ day-shift). */
	private formatDay(date: string): string {
		const dt = new Date(`${date}T00:00:00`);
		return isNaN(dt.getTime()) ? date : dt.toLocaleDateString();
	}

	private renderHero(parent: HTMLElement, account: IClaudeAccount, refreshedAt: Date | undefined, statsSource: StatsSource, statsComputedDate: string | undefined): void {
		const hero = append(parent, h('.clawdius-usage-hero'));
		append(hero, h('.clawdius-usage-hero-mark'));
		const text = append(hero, h('.clawdius-usage-hero-text'));
		append(text, h('.clawdius-usage-hero-title')).textContent = localize('clawdius.usage.dash.title', "Claude Code Usage");

		const sub = append(text, h('.clawdius-usage-hero-sub'));
		const part = (label: string, value: string, accent = false) => {
			const span = append(sub, h('span.clawdius-usage-kv'));
			append(span, h('span.clawdius-usage-kv-label')).textContent = label;
			const v = append(span, h('span.clawdius-usage-kv-value'));
			v.textContent = value;
			if (accent) { v.classList.add('accent'); }
		};
		if (account.email) { part(localize('clawdius.usage.dash.account', "Account"), account.email, true); }
		if (account.planTier) { part(localize('clawdius.usage.dash.plan', "Plan"), account.planTier, true); }
		part(localize('clawdius.usage.dash.engine', "Engine"), providerLabel(account.provider), true);
		part(localize('clawdius.usage.dash.auth', "Auth"), account.signedIn ? localize('clawdius.usage.dash.signedIn', "Signed in") : localize('clawdius.usage.dash.signedOut', "Signed out"));

		// Two distinct data sources, made explicit so the totals are never mistaken for live: the session/token
		// stats are computed from your raw transcripts (always current, deduped - differs from the engine's
		// over-counted cache), while the limit bars are a live fetch refreshed on open / Refresh.
		const statsMeta = append(text, h('.clawdius-usage-hero-meta'));
		if (statsSource === 'transcripts') {
			statsMeta.textContent = localize('clawdius.usage.dash.statsTranscripts', "Session + token stats from your session transcripts (deduped, always current).");
		} else if (statsSource === 'cli') {
			statsMeta.textContent = statsComputedDate
				? localize('clawdius.usage.dash.statsCli', "Session + token stats from the Claude CLI cache, computed {0} (the Agent Host is off; transcript stats unavailable).", this.formatDay(statsComputedDate))
				: localize('clawdius.usage.dash.statsCliNoDate', "Session + token stats from the Claude CLI cache (the Agent Host is off).");
		} else {
			statsMeta.textContent = localize('clawdius.usage.dash.statsComputing', "Computing session + token stats from your transcripts...");
		}
		append(text, h('.clawdius-usage-hero-meta')).textContent = refreshedAt
			? localize('clawdius.usage.dash.metaRefreshed', "Live limits last refreshed {0}.", refreshedAt.toLocaleString())
			: localize('clawdius.usage.dash.metaLocal', "Live limits refresh when you open this view or click Refresh.");

		append(hero, h('.clawdius-usage-hero-spacer'));
		const refresh = append(hero, h('button.clawdius-usage-refresh'));
		refresh.textContent = localize('clawdius.usage.dash.refresh', "Refresh");
		refresh.title = localize('clawdius.usage.dash.refreshTip', "Refresh live subscription limits and recompute session + token stats from your transcripts.");
		this.renderStore.add(addDisposableListener(refresh, EventType.CLICK, () => void this.refreshOnDemand()));
	}

	private renderLimits(parent: HTMLElement, capacity: IClaudeCapacity | undefined, account: IClaudeAccount): void {
		const block = this.sectionTitle(parent, localize('clawdius.usage.dash.limits', "Subscription limits"));

		if (!providerHasLimits(account.provider)) {
			const note = append(block, h('.clawdius-usage-callout'));
			append(note, h('.clawdius-usage-callout-head')).textContent = localize('clawdius.usage.dash.nonSubHead', "Running on {0}", providerLabel(account.provider));
			append(note, h('.clawdius-usage-callout-body')).textContent = localize('clawdius.usage.dash.nonSubBody', "Claude Code subscription rate limits don't apply here - usage is billed through your provider account. Your local token history is below.");
			return;
		}

		const windows = capacityWindows(capacity);
		if (windows.length === 0) {
			append(block, h('.clawdius-usage-note')).textContent = localize('clawdius.usage.dash.noLimitsYet', "Limits load when you open this dashboard. If this persists, sign in to Claude Code and try Refresh.");
			return;
		}

		const term = append(block, h('.clawdius-usage-term'));
		for (const w of windows) {
			const state = utilStateOf(w.util);
			const row = append(term, h('.clawdius-usage-limit-row'));
			append(row, h('span.clawdius-usage-limit-label')).textContent = w.label;
			// Solid bar that flex-fills the row (fill = utilization %).
			const bar = append(row, h('.clawdius-usage-limit-bar'));
			const fill = append(bar, h('.clawdius-usage-limit-fill'));
			fill.style.width = `${Math.max(1, Math.min(100, w.util))}%`;
			if (state) { fill.classList.add(state); }
			const pct = append(row, h('span.clawdius-usage-limit-pct'));
			pct.textContent = localize('clawdius.usage.pctUsed', "{0}% used", Math.round(w.util));
			if (state) { pct.classList.add(state); }
			const reset = resetLabel(w.resets);
			if (reset) { append(term, h('.clawdius-usage-limit-reset')).textContent = reset; }
		}
	}

	private renderOverview(parent: HTMLElement, stats: IClaudeStats): void {
		const block = this.sectionTitle(parent, localize('clawdius.usage.dash.overview', "Overview"));

		// Contribution heatmap (all-time calendar) with month + weekday labels and a Less/More legend.
		this.renderHeatmap(block, stats);

		// Lifetime stat grid.
		const streaks = computeStreaks(stats.dailyActivity ?? [], stats.firstSessionDate, dateKey(new Date()));
		const rows = resolveModelRows(stats.modelUsage);
		const totalTokens = rows.reduce((s, r) => s + r.total, 0);
		const favorite = rows[0];

		const grid = append(block, h('.clawdius-usage-statgrid'));
		const cell = (label: string, value: string) => {
			const c = append(grid, h('.clawdius-usage-stat'));
			append(c, h('span.clawdius-usage-stat-label')).textContent = label;
			append(c, h('span.clawdius-usage-stat-value')).textContent = value;
		};
		cell(localize('clawdius.usage.dash.favorite', "Favorite model"), favorite ? favorite.label : '-');
		cell(localize('clawdius.usage.dash.totalTokens', "Total tokens"), compact(totalTokens));
		cell(localize('clawdius.usage.dash.sessions', "Sessions"), compact(stats.totalSessions ?? 0));
		cell(localize('clawdius.usage.dash.messages', "Messages"), compact(stats.totalMessages ?? 0));
		cell(localize('clawdius.usage.dash.activeDays', "Active days"), streaks.spanDays > 0 ? `${streaks.activeDays} / ${streaks.spanDays}` : `${streaks.activeDays}`);
		cell(localize('clawdius.usage.dash.longestSession', "Longest session"), stats.longestSession?.duration ? formatDuration(stats.longestSession.duration) : '-');
		cell(localize('clawdius.usage.dash.longestStreak', "Longest streak"), localize('clawdius.usage.dash.days', "{0} days", streaks.longest));
		cell(localize('clawdius.usage.dash.currentStreak', "Current streak"), localize('clawdius.usage.dash.days', "{0} days", streaks.current));
		if (streaks.mostActiveDate) {
			cell(localize('clawdius.usage.dash.mostActive', "Most active day"), `${streaks.mostActiveDate} (${compact(streaks.mostActiveCount)})`);
		}
	}

	private renderHeatmap(parent: HTMLElement, stats: IClaudeStats): void {
		const byDate = new Map<string, number>();
		let max = 1;
		for (const a of stats.dailyActivity ?? []) {
			if (a.date) { const c = a.messageCount ?? 0; byDate.set(a.date.slice(0, 10), c); max = Math.max(max, c); }
		}

		const today = new Date();
		const start = new Date(today);
		start.setDate(today.getDate() - (HEATMAP_WEEKS * 7 - 1));
		// Align start to the previous Sunday so weekday rows line up.
		start.setDate(start.getDate() - start.getDay());

		// Contribution heatmap: a flex grid of cells that stretch to fill the section width. Month labels track
		// the week columns, a weekday gutter (Mon/Wed/Fri) sits on the left, and a Less..More legend below.
		const wrap = append(parent, h('.clawdius-usage-heatmap'));

		const monthRow = append(wrap, h('.clawdius-usage-heatmap-months'));
		append(monthRow, h('.clawdius-usage-heatmap-gutter'));
		let prevMonth = -1;
		for (let col = 0; col < HEATMAP_WEEKS; col++) {
			const weekStart = new Date(start);
			weekStart.setDate(start.getDate() + col * 7);
			const slot = append(monthRow, h('.clawdius-usage-heatmap-mslot'));
			if (weekStart.getMonth() !== prevMonth) {
				prevMonth = weekStart.getMonth();
				slot.textContent = weekStart.toLocaleDateString(undefined, { month: 'short' });
			}
		}

		const body = append(wrap, h('.clawdius-usage-heatmap-body'));
		const gutter = append(body, h('.clawdius-usage-heatmap-weekdays'));
		for (const dn of [' ', 'Mon', ' ', 'Wed', ' ', 'Fri', ' ']) { append(gutter, h('.clawdius-usage-heatmap-wd')).textContent = dn; }

		const grid = append(body, h('.clawdius-usage-heatmap-grid'));
		for (let col = 0; col < HEATMAP_WEEKS; col++) {
			const week = append(grid, h('.clawdius-usage-heatmap-week'));
			for (let row = 0; row < 7; row++) {
				const day = new Date(start);
				day.setDate(start.getDate() + col * 7 + row);
				const cell = append(week, h('.clawdius-usage-heatmap-day'));
				if (day > today) { cell.style.visibility = 'hidden'; continue; }
				const count = byDate.get(dateKey(day)) ?? 0;
				const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
				cell.classList.add(`level-${level}`);
				cell.title = `${dateKey(day)}: ${count}`;
			}
		}

		const legend = append(wrap, h('.clawdius-usage-heatmap-legend'));
		append(legend, h('span.clawdius-usage-heatmap-legend-text')).textContent = localize('clawdius.usage.dash.less', "Less");
		for (let l = 1; l <= 4; l++) { append(legend, h(`.clawdius-usage-heatmap-day.level-${l}`)); }
		append(legend, h('span.clawdius-usage-heatmap-legend-text')).textContent = localize('clawdius.usage.dash.more', "More");
	}

	private renderTokensPerDay(parent: HTMLElement, stats: IClaudeStats): void {
		const block = this.sectionTitle(parent, localize('clawdius.usage.dash.tokensPerDay', "Tokens per day"));

		// Range tabs (chart window): All time / Last 30 days / Last 7 days.
		const tabs = append(block, h('.clawdius-usage-rangetabs'));
		const makeTab = (key: Range, label: string) => {
			const tab = append(tabs, h('a.clawdius-usage-rangetab'));
			tab.textContent = label;
			if (this.range === key) { tab.classList.add('active'); }
			this.renderStore.add(addDisposableListener(tab, EventType.CLICK, () => { this.range = key; this.render(); }));
		};
		makeTab('all', localize('clawdius.usage.dash.allTime', "All time"));
		makeTab('30d', localize('clawdius.usage.dash.last30', "Last 30 days"));
		makeTab('7d', localize('clawdius.usage.dash.last7', "Last 7 days"));

		const series = this.windowedModelTokens(stats.dailyModelTokens ?? []);
		if (series.dates.length === 0 || series.models.length === 0) {
			append(block, h('.clawdius-usage-note')).textContent = localize('clawdius.usage.dash.noTokenData', "No token activity in this range.");
			return;
		}

		const chart = append(block, h('.clawdius-usage-chart'));
		// Y-axis tick labels (top = max .. 0).
		const yaxis = append(chart, h('.clawdius-usage-chart-yaxis'));
		const TICKS = 5;
		for (let i = 0; i < TICKS; i++) {
			const v = series.max * (1 - i / (TICKS - 1));
			append(yaxis, h('span.clawdius-usage-chart-tick')).textContent = compact(v);
		}
		// Plot: an SVG multi-line chart (one polyline per model) that scales to fill the plot width.
		const plot = append(chart, h('.clawdius-usage-chart-plot'));
		const doc = plot.ownerDocument;
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 100 100');
		svg.setAttribute('preserveAspectRatio', 'none');
		svg.classList.add('clawdius-usage-chart-svg');
		const n = series.dates.length;
		for (let i = 0; i < series.models.length; i++) {
			const m = series.models[i];
			const points = m.values.map((v, idx) => {
				const x = n <= 1 ? 0 : (idx / (n - 1)) * 100;
				const y = (1 - Math.max(0, Math.min(series.max, v)) / series.max) * 100;
				return `${x.toFixed(2)},${y.toFixed(2)}`;
			}).join(' ');
			const poly = doc.createElementNS(SVG_NS, 'polyline');
			poly.setAttribute('points', points);
			poly.setAttribute('fill', 'none');
			poly.setAttribute('stroke', MODEL_COLORS[i % MODEL_COLORS.length]);
			poly.setAttribute('stroke-width', '1.5');
			poly.setAttribute('stroke-linejoin', 'round');
			poly.setAttribute('vector-effect', 'non-scaling-stroke'); // keep an even line weight under non-uniform scaling
			svg.appendChild(poly);
		}
		plot.appendChild(svg);

		// X-axis date labels (first .. mid .. last).
		const xaxis = append(block, h('.clawdius-usage-chart-xaxis'));
		const fmt = (d: string) => { const dt = new Date(`${d}T00:00:00`); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
		const first = series.dates[0];
		const mid = series.dates[Math.floor(series.dates.length / 2)];
		const last = series.dates[series.dates.length - 1];
		append(xaxis, h('span')).textContent = fmt(first);
		if (series.dates.length > 2) { append(xaxis, h('span')).textContent = fmt(mid); }
		append(xaxis, h('span')).textContent = fmt(last);

		// Legend (colored dots) + the all-time model breakdown (In / Out / share).
		const legend = append(block, h('.clawdius-usage-chart-legend'));
		series.models.forEach((m, i) => {
			const item = append(legend, h('span.clawdius-usage-legend-item'));
			const dot = append(item, h('span.clawdius-usage-legend-dot'));
			dot.style.color = MODEL_COLORS[i % MODEL_COLORS.length];
			append(item, h('span')).textContent = m.label;
		});

		this.renderModelBreakdown(block, stats);
	}

	private renderModelBreakdown(parent: HTMLElement, stats: IClaudeStats): void {
		const rows = resolveModelRows(stats.modelUsage);
		const grand = rows.reduce((s, r) => s + r.total, 0) || 1;
		if (rows.length === 0) { return; }
		const list = append(parent, h('.clawdius-usage-breakdown'));
		for (const r of rows.slice(0, 8)) {
			const row = append(list, h('.clawdius-usage-breakdown-row'));
			const head = append(row, h('.clawdius-usage-breakdown-head'));
			append(head, h('span.clawdius-usage-breakdown-name')).textContent = r.label;
			append(head, h('span.clawdius-usage-breakdown-pct')).textContent = `${((r.total / grand) * 100).toFixed(1)}%`;
			append(row, h('.clawdius-usage-breakdown-detail')).textContent = localize('clawdius.usage.dash.inOut', "In: {0}  Out: {1}  Cache: {2}", compact(r.input), compact(r.output), compact(r.cacheRead + r.cacheCreate));
		}
	}

	private renderHourActivity(parent: HTMLElement, stats: IClaudeStats): void {
		const counts: number[] = [];
		let max = 1;
		for (let hr = 0; hr < 24; hr++) { const c = stats.hourCounts?.[String(hr)] ?? 0; counts.push(c); max = Math.max(max, c); }
		if (counts.every(c => c === 0)) { return; }

		const block = this.sectionTitle(parent, localize('clawdius.usage.dash.byHour', "Activity by hour (local time)"));
		const chart = append(block, h('.clawdius-usage-hour'));
		// 24 vertical bars that flex to fill the full row width.
		const bars = append(chart, h('.clawdius-usage-hour-bars'));
		for (let hr = 0; hr < 24; hr++) {
			const col = append(bars, h('.clawdius-usage-hour-col'));
			col.title = `${String(hr).padStart(2, '0')}:00 - ${counts[hr]}`;
			const bar = append(col, h('.clawdius-usage-hour-bar'));
			bar.style.height = counts[hr] === 0 ? '0' : `${Math.max(4, Math.round((counts[hr] / max) * 100))}%`;
		}
		const axis = append(chart, h('.clawdius-usage-hour-labels'));
		for (let hr = 0; hr < 24; hr++) {
			const label = append(axis, h('.clawdius-usage-hour-label'));
			if (hr % 6 === 0 || hr === 23) { label.textContent = String(hr); }
		}
	}

	/** Build per-model value series over the selected range, aligned to a shared date axis. */
	private windowedModelTokens(daily: ReadonlyArray<IClaudeDailyModelTokens>): { dates: string[]; max: number; models: { id: string; label: string; values: number[] }[] } {
		let cutoff: string | undefined;
		if (this.range !== 'all') {
			const days = this.range === '7d' ? 7 : 30;
			const d = new Date();
			d.setDate(d.getDate() - (days - 1));
			cutoff = dateKey(d);
		}
		const windowed = daily.filter(d => d.date && (!cutoff || d.date.slice(0, 10) >= cutoff!));
		const dates = windowed.map(d => d.date!.slice(0, 10));

		// Rank models by total tokens in the window; keep the top N.
		const totals = new Map<string, number>();
		for (const d of windowed) {
			for (const [model, t] of Object.entries(d.tokensByModel ?? {})) { totals.set(model, (totals.get(model) ?? 0) + t); }
		}
		const topModels = [...totals.entries()].filter(([, t]) => t > 0).sort((a, b) => b[1] - a[1]).slice(0, MAX_CHART_MODELS).map(([id]) => id);

		let max = 1;
		const models = topModels.map(id => {
			const values = windowed.map(d => d.tokensByModel?.[id] ?? 0);
			for (const v of values) { max = Math.max(max, v); }
			return { id, label: modelLabel(id), values };
		});
		return { dates, max, models };
	}
}
// CLAWDIUS-END
