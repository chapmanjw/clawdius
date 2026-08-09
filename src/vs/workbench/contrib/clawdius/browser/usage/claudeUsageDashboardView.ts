/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude usage dashboard view (reusable)
// The usage dashboard rendering, extracted from the editor pane so it can be hosted in two places: the
// standalone Usage editor AND the Control Center's Usage tab. A native DOM view (no webview => trivially
// zero-egress) in the monospace terminal aesthetic of the CLI's /usage view: block-shade limit bars, a
// contribution heatmap, an SVG Tokens-per-Day chart, a model breakdown, and 24h activity. The dashboard is
// framed around the Claude Code transcript RETENTION WINDOW: Claude Code keeps each session transcript on disk
// for `cleanupPeriodDays` days (default 30) then prunes it, so the lifetime tiles summarize exactly the
// sessions still on disk. The session/token stats are computed live from those local transcripts (the
// agentHost aggregator, backed by our incremental cache); the oauth capacity/limit bars come from the cached
// /api/oauth/usage response. All reads are of the user's own local files. `load()` only READS local files; the
// live /api/oauth/usage refresh runs only on the Refresh button (user-initiated). The view renders
// `.clawdius-usage-dashboard-inner` into the container it is given - the caller owns the outer scroll/padding
// wrapper. Cost is never shown - usage and limits only.

import './media/claudeUsage.css';
import { $ as h, addDisposableListener, append, clearNode, DisposableResizeObserver, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClaudeUsageCapacityRefresh } from './claudeUsageCapacityRefresh.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IJSONEditingService } from '../../../../services/configuration/common/jsonEditing.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { classifySettings } from '../control/claudeControlCenterData.js';
import {
	capacityWindows, compact, computeStreaks, formatDuration, IClaudeAccount, IClaudeCapacity, IClaudeDailyActivity,
	IClaudeDailyModelTokens, IClaudeModelStat, IClaudeStats, IWindowedStats, modelLabel, providerHasLimits, providerLabel,
	readAccount, readCapacity, resetLabel, resolveModelRows, usageHomePath, windowStats,
} from './claudeUsageData.js';

/** Default transcript retention when `cleanupPeriodDays` is unset / invalid in ~/.claude/settings.json. */
const DEFAULT_CLEANUP_PERIOD_DAYS = 30;
const MAX_CHART_MODELS = 5;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Per-model line colors for the chart + legend (lavender / green / gold / sky / pink / gray). */
const MODEL_COLORS = ['#a78bfa', '#7bc96f', '#e3b341', '#38bdf8', '#f472b6', '#9aa4b2'];

/** Tokens-per-day chart: model line stroke weight (px) and the base/target corner radius (px) for the rounded step. */
const CHART_STROKE_WIDTH = 1.75;
const CHART_CORNER_RADIUS = 7;

export function utilStateOf(util: number): 'warn' | 'crit' | undefined {
	if (util >= 90) { return 'crit'; }
	if (util >= 70) { return 'warn'; }
	return undefined;
}

/** The limit bar's fill width, as a `0-100` CSS percentage. Genuinely zero usage renders `width: 0` - an empty
 *  fill, no leading-edge rounded corner to show as a stray nub - while any TRUE non-zero usage is floored at 1 so
 *  it stays visible even when it would otherwise round down to an invisible sub-pixel sliver (item 26: the prior
 *  fix rounded only the fill's leading edge, which stopped the "floating blob" look for a wide fill but still
 *  painted a small rounded cap at exactly 0%, since `Math.max(1, ...)` gave even zero usage a 1% fill). Clamped to
 *  `[0, 100]` first so an out-of-range or non-finite `util` can never yield a negative or NaN width. */
export function limitFillWidthPercent(util: number): number {
	const clamped = Math.max(0, Math.min(100, util));
	return clamped > 0 ? Math.max(1, clamped) : 0;
}

/** Read `cleanupPeriodDays` from a parsed settings object; default + validate (integer >= 1). */
export function effectiveCleanupPeriodDays(settings: Record<string, unknown>): number {
	const v = settings['cleanupPeriodDays'];
	return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_CLEANUP_PERIOD_DAYS;
}

interface ILoaded {
	readonly stats: IClaudeStats | undefined;
	readonly capacity: IClaudeCapacity | undefined;
	readonly account: IClaudeAccount;
	readonly refreshedAt: Date | undefined;
	/** True while the first transcript scan is still running (the brief loading state). */
	readonly loading: boolean;
	/** The engine's verbatim "What's contributing to your usage" text (from a one-shot `/usage`), or undefined
	 *  when unavailable / not yet fetched. Rendered as a collapsed sub-section under the heatmap. */
	readonly contribution: string | undefined;
	/** True when the transcript-stats load THREW (distinct from genuinely-no-stats), so render shows error + Retry. */
	readonly statsError: boolean;
}

export function dateKey(day: Date): string {
	return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/**
 * Local YYYY-MM-DD of the first day of the inclusive `horizonDays`-day window ending on `today` (today - (N - 1)).
 * Pure core of {@link ClaudeUsageDashboardView.windowStartKey}; the clock is passed in so the off-by-one is testable.
 */
export function windowStartKey(today: Date, horizonDays: number): string {
	const d = new Date(today);
	d.setDate(d.getDate() - (horizonDays - 1));
	return dateKey(d);
}

/** Format a px coordinate for an SVG path/attribute (2 dp keeps the path compact with no visible quantization). */
function coord(value: number): string {
	return value.toFixed(2);
}

/**
 * Build a rounded-step SVG path for one model's per-day token series, in REAL pixel coordinates (the SVG
 * viewBox equals the plot's px size, 1:1), so the rounded corners render as true circles instead of the
 * ellipses a non-uniform scale would produce. Each day i holds flat across its horizontal band at y(values[i])
 * with a vertical riser between bands; every corner is rounded with a quadratic curve whose radius is capped to
 * 40% of a band (stays crisp with many narrow days) and to half the vertical jump (small jumps do not blob),
 * under a small base radius. Zero-value days rest on the 0 baseline, so an isolated big day reads as a
 * rounded-top spike and clusters read as rounded humps.
 */
export function roundedStepPath(values: number[], max: number, width: number, height: number): string {
	const n = values.length;
	if (n === 0 || width <= 0 || height <= 0) { return ''; }
	const bandWidth = width / n;
	const topInset = CHART_STROKE_WIDTH * 2; // headroom so a full-height rounded cap is not clipped at the top
	const baselineY = height - CHART_STROKE_WIDTH; // value 0 rests just above the bottom edge (the baseline line)
	const safeMax = max > 0 ? max : 1;
	const yOf = (v: number) => baselineY - (Math.max(0, Math.min(safeMax, v)) / safeMax) * (baselineY - topInset);

	// Sharp step corners first. Equal-value neighbours collapse so a flat run stays one straight segment: the
	// left point, then for every day boundary that changes value a pair {end-of-flat, end-of-riser}, then the
	// right point. This yields an alternating horizontal/vertical corner list with no zero-length segments.
	const pts: { x: number; y: number }[] = [{ x: 0, y: yOf(values[0]) }];
	for (let i = 1; i < n; i++) {
		if (values[i] !== values[i - 1]) {
			const x = i * bandWidth;
			pts.push({ x, y: yOf(values[i - 1]) });
			pts.push({ x, y: yOf(values[i]) });
		}
	}
	pts.push({ x: width, y: yOf(values[n - 1]) });

	// Nothing to round (a single day, or every day equal): one flat line at this model's held height.
	if (pts.length === 2) {
		return `M ${coord(pts[0].x)} ${coord(pts[0].y)} L ${coord(pts[1].x)} ${coord(pts[1].y)}`;
	}

	let d = `M ${coord(pts[0].x)} ${coord(pts[0].y)}`;
	for (let k = 1; k < pts.length - 1; k++) {
		const prev = pts[k - 1];
		const v = pts[k];
		const next = pts[k + 1];
		// Each interior vertex turns between one horizontal band edge and one vertical riser; the riser length
		// is whichever adjacent segment is vertical (the one sharing v.x). The radius caps keep adjacent corners
		// from overlapping: <= 0.4*band along the (shared) horizontal, <= 0.5*riser along the (shared) vertical.
		const riserLen = prev.x === v.x ? Math.abs(v.y - prev.y) : Math.abs(next.y - v.y);
		const r = Math.min(CHART_CORNER_RADIUS, bandWidth * 0.4, riserLen * 0.5);
		if (r <= 0.01) {
			d += ` L ${coord(v.x)} ${coord(v.y)}`;
			continue;
		}
		const inLen = Math.hypot(v.x - prev.x, v.y - prev.y) || 1;
		const outLen = Math.hypot(next.x - v.x, next.y - v.y) || 1;
		const enterX = v.x - ((v.x - prev.x) / inLen) * r;
		const enterY = v.y - ((v.y - prev.y) / inLen) * r;
		const exitX = v.x + ((next.x - v.x) / outLen) * r;
		const exitY = v.y + ((next.y - v.y) / outLen) * r;
		// Line into the corner, then a quadratic with the sharp corner as the control point to round it off.
		d += ` L ${coord(enterX)} ${coord(enterY)} Q ${coord(v.x)} ${coord(v.y)} ${coord(exitX)} ${coord(exitY)}`;
	}
	const last = pts[pts.length - 1];
	d += ` L ${coord(last.x)} ${coord(last.y)}`;
	return d;
}

/**
 * Build per-model value series over an inclusive [cutoffKey .. todayKey] window, aligned to a shared, contiguous
 * (zero-filled) calendar date axis, keeping the top `maxModels` models by total tokens. Pure core of
 * {@link ClaudeUsageDashboardView.windowedModelTokens}; the clock + horizon are passed in so it is unit-testable.
 */
export function buildModelSeries(daily: ReadonlyArray<IClaudeDailyModelTokens>, cutoffKey: string, todayKey: string, maxModels: number): { dates: string[]; max: number; models: { id: string; label: string; values: number[] }[] } {
	const inRange = daily.filter(d => d.date && d.date.slice(0, 10) >= cutoffKey && d.date.slice(0, 10) <= todayKey);
	if (inRange.length === 0) { return { dates: [], max: 1, models: [] }; }

	// Walk a CONTIGUOUS calendar from the first to the last day that has data, zero-filling the gaps. This makes
	// the x-axis true calendar time: the line drops to zero on days with no tokens instead of evenly spacing the
	// data points by index (which compresses gaps and makes the line appear to have values on empty dates).
	const byDate = new Map<string, { readonly [model: string]: number }>();
	for (const d of inRange) { byDate.set(d.date!.slice(0, 10), d.tokensByModel ?? {}); }
	const sortedKeys = [...byDate.keys()].sort();
	const dates: string[] = [];
	for (let cur = new Date(`${sortedKeys[0]}T00:00:00`), end = new Date(`${sortedKeys[sortedKeys.length - 1]}T00:00:00`); cur <= end; cur.setDate(cur.getDate() + 1)) {
		dates.push(dateKey(cur));
	}

	// Rank models by total tokens over the days with data; keep the top N.
	const totals = new Map<string, number>();
	for (const tokens of byDate.values()) {
		for (const [model, t] of Object.entries(tokens)) { totals.set(model, (totals.get(model) ?? 0) + t); }
	}
	const topModels = [...totals.entries()].filter(([, t]) => t > 0).sort((a, b) => b[1] - a[1]).slice(0, maxModels).map(([id]) => id);

	let max = 1;
	const models = topModels.map(id => {
		const values = dates.map(dt => byDate.get(dt)?.[id] ?? 0);
		for (const v of values) { max = Math.max(max, v); }
		return { id, label: modelLabel(id), values };
	});
	return { dates, max, models };
}

/**
 * Pure core of {@link ClaudeUsageDashboardView.renderHeatmap}: reduce the in-window daily activity to a
 * column-major grid model for the contribution heatmap. `today` + `horizonDays` are passed in so the window math
 * is unit-testable. The grid starts on the Sunday on/before the window start (so weekday rows line up) and spans
 * `weeks` full week-columns; each cell carries its date `key`, message `count`, intensity `level` (0..4, scaled
 * against the in-window `max`), and a `visible` flag (false for future days or days older than the window). Cells
 * are ordered column-major (each week top-to-bottom), matching the grid's DOM append order.
 */
export function buildHeatmapModel(activity: ReadonlyArray<IClaudeDailyActivity>, today: Date, horizonDays: number): { weeks: number; cells: { key: string; count: number; level: number; visible: boolean }[] } {
	// `activity` is the in-window slice ([windowStart .. today], both bounds applied upstream), so the intensity
	// `max` is taken from the VISIBLE cells only - a hidden future/old day can never distort the color scale.
	const byDate = new Map<string, number>();
	let max = 1;
	for (const a of activity) {
		if (a.date) { const c = a.messageCount ?? 0; byDate.set(a.date.slice(0, 10), c); max = Math.max(max, c); }
	}

	const windowStart = new Date(today);
	windowStart.setDate(today.getDate() - (horizonDays - 1));
	const windowStartKeyValue = dateKey(windowStart);
	// Align the grid start to the previous Sunday so weekday rows line up; days before the window read as gaps.
	const gridStart = new Date(windowStart);
	gridStart.setDate(windowStart.getDate() - windowStart.getDay());
	const startMid = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate()).getTime();
	const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	const weeks = Math.max(1, Math.ceil((Math.round((todayMid - startMid) / 86400000) + 1) / 7));

	// Column-major (each week top-to-bottom) to match grid-auto-flow: column in the DOM.
	const cells: { key: string; count: number; level: number; visible: boolean }[] = [];
	for (let col = 0; col < weeks; col++) {
		for (let row = 0; row < 7; row++) {
			const day = new Date(gridStart);
			day.setDate(gridStart.getDate() + col * 7 + row);
			const key = dateKey(day);
			// Hide the future and anything older than the retention window (we never render past the horizon).
			const visible = !(day > today || key < windowStartKeyValue);
			const count = byDate.get(key) ?? 0;
			const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
			cells.push({ key, count, level, visible });
		}
	}
	return { weeks, cells };
}

/**
 * Renders the usage dashboard into a caller-owned container. Construct it, call {@link load}, dispose when the
 * host goes away. Self-contained: owns its render store, refresh token, retention horizon, and loaded data, so
 * its Refresh + retention control re-render only itself, independent of any host.
 */
export class ClaudeUsageDashboardView extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());
	private readonly refreshCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private refreshing = false;
	private disposed = false;
	/** The transcript retention horizon (`cleanupPeriodDays`); the maximum span of every time-windowed view. */
	private horizonDays = DEFAULT_CLEANUP_PERIOD_DAYS;
	private loaded: ILoaded | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly fileService: IFileService,
		private readonly pathService: IPathService,
		private readonly capacityRefresh: IClaudeUsageCapacityRefresh,
		private readonly agentHostService: IAgentHostService,
		private readonly jsonEditingService: IJSONEditingService,
		private readonly dialogService: IDialogService,
		private readonly notificationService: INotificationService,
		private readonly quickInputService: IQuickInputService,
		private readonly hoverService: IHoverService,
	) {
		super();
	}

	private async claudeDir(): Promise<URI> {
		return URI.joinPath(await this.pathService.userHome(), '.claude');
	}

	private async readRaw(uri: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(uri)).value.toString();
		} catch {
			return undefined;
		}
	}

	/** Local YYYY-MM-DD of the first day in the retention window (today - (horizon - 1)). */
	private windowStartKey(): string {
		return windowStartKey(new Date(), this.horizonDays);
	}

	/** Transcript-only load (all local reads; zero egress). Reads the retention horizon, oauth capacity, and
	 *  account identity, paints immediately with a loading state, then computes the accurate session/token stats
	 *  live from the raw transcripts (a few seconds cold, near-instant warm via our incremental cache) and swaps
	 *  them in. Bails if cancelled or disposed mid-read (e.g. the Control Center left the Usage tab) so a late
	 *  completion never renders into a detached node. */
	async load(token: CancellationToken): Promise<void> {
		const dir = await this.claudeDir();
		const settingsUri = URI.joinPath(dir, 'settings.json');
		const [rawSettings, capacity] = await Promise.all([this.readRaw(settingsUri), readCapacity(this.fileService, dir)]);
		if (token.isCancellationRequested || this.disposed) { return; }
		const cls = classifySettings(rawSettings);
		this.horizonDays = cls.kind === 'ok' ? effectiveCleanupPeriodDays(cls.settings) : DEFAULT_CLEANUP_PERIOD_DAYS;
		// The capacity refresh router doubles as the "signed in" probe: on a .credentials.json miss it asks whichever
		// host owns ~/.claude, the only place that can read the macOS login Keychain (the renderer cannot).
		const account = await readAccount(this.fileService, dir, capacity, this.capacityRefresh);
		let refreshedAt: Date | undefined;
		try {
			const stat = await this.fileService.stat(URI.joinPath(dir, '.clawdius-usage-cache.json'));
			refreshedAt = stat.mtime ? new Date(stat.mtime) : undefined;
		} catch {
			refreshedAt = undefined;
		}
		if (token.isCancellationRequested || this.disposed) { return; }
		// Paint immediately with the limits + a loading state for the stats.
		this.loaded = { stats: undefined, capacity, account, refreshedAt, loading: true, contribution: undefined, statsError: false };
		this.render();
		// Compute the accurate, always-current stats from the raw transcripts and swap them in.
		await this.loadTranscriptStats(token);
		// Then fetch the engine's verbatim "what's contributing" text (a one-shot /usage session) and swap it in
		// when it arrives - kept separate so a slow/failed fetch never delays or blocks the rest of the dashboard.
		await this.loadContribution(token);
	}

	/** Fetch the engine's `/usage` "What's contributing to your usage" text via a short-lived session and swap it
	 *  in when available. Best-effort: any non-`ok` status simply leaves the sub-section unrendered. */
	private async loadContribution(token: CancellationToken): Promise<void> {
		const home = usageHomePath(await this.pathService.userHome());
		let text: string | undefined;
		try {
			const result = await this.agentHostService.fetchUsageContribution(home);
			text = result.status === 'ok' ? result.text : undefined;
		} catch {
			text = undefined;
		}
		if (token.isCancellationRequested || this.disposed || !this.loaded || text === undefined) { return; }
		this.loaded = { ...this.loaded, contribution: text };
		this.render();
	}

	/** Aggregate the raw transcripts (off the UI thread, via the agentHost) and swap in the accurate stats. */
	private async loadTranscriptStats(token: CancellationToken): Promise<void> {
		// CLAWDIUS (#94): scheme-aware home so the aggregator gets the right path on each host. Local Windows is a
		// file:// URI (-> C:\Users\...); a WSL/SSH remote is a vscode-remote:// URI whose `.path` is the remote
		// POSIX home (-> /home/user). `.fsPath` would mangle the remote URI, so only use it for the file scheme.
		const homeUri = await this.pathService.userHome();
		const home = usageHomePath(homeUri);
		let result;
		try {
			result = await this.agentHostService.getUsageStats(home);
		} catch {
			if (this.loaded && !this.disposed) { this.loaded = { ...this.loaded, loading: false, statsError: true }; this.render(); }
			return;
		}
		if (token.isCancellationRequested || this.disposed || !this.loaded) { return; }
		this.loaded = { ...this.loaded, stats: result.status === 'ok' ? result.stats : undefined, loading: false, statsError: false };
		this.render();
	}

	private async refreshOnDemand(): Promise<void> {
		if (this.refreshing) { return; }
		this.refreshing = true;
		this.render(); // reflect the in-progress state on the button immediately
		const cts = new CancellationTokenSource();
		this.refreshCts.value = cts;
		try {
			// force=true: the explicit Refresh button always pulls fresh limits, bypassing the freshness TTL that
			// throttles the automatic open/hover refreshes. Routed by host (local command vs remote REH service).
			await this.capacityRefresh.refresh(true);
			if (cts.token.isCancellationRequested) { return; }
			await this.load(cts.token);
		} catch {
			// best-effort: offline / extension not active / expired token - keep showing cached data
		} finally {
			this.refreshing = false;
			this.render(); // restore the button label once the refresh settles
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
		const { stats, capacity, account, refreshedAt, loading, statsError } = this.loaded;
		this.renderStore.clear();
		clearNode(this.container);
		const inner = append(this.container, h('.clawdius-usage-dashboard-inner'));

		this.renderHero(inner, account, refreshedAt);
		this.renderLimits(inner, capacity, account);
		if (stats) {
			// Reduce the aggregate to the retention window ONCE, then derive every tile from that slice so nothing
			// (totals, model breakdown, 24h activity, longest session) leaks past the [windowStart .. today] horizon.
			const windowed = windowStats(stats, this.windowStartKey(), dateKey(new Date()));
			this.renderOverview(inner, stats, windowed);
			// The engine's verbatim "what's contributing" text sits as its own row below the Overview (heatmap +
			// stats) and above Tokens per day. A flex child of the inner column, so it gets the 22px section gap.
			this.renderContribution(inner);
			this.renderTokensPerDay(inner, windowed);
			this.renderHourActivity(inner, windowed);
		} else if (loading) {
			append(inner, h('.clawdius-usage-empty')).textContent = localize('clawdius.usage.dash.statsLoading', "Computing your session stats from local transcripts...");
		} else if (statsError) {
			// A stats READ failure is distinct from having no stats: show the error + a Retry, not the empty message.
			const err = append(inner, h('.clawdius-usage-empty'));
			append(err, h('.clawdius-usage-empty-text')).textContent = localize('clawdius.usage.dash.statsError', "Couldn't read your local session stats from the Agent Host.");
			const retry = append(err, h('button.clawdius-usage-refresh'));
			this.refreshIcon(retry);
			append(retry, h('span')).textContent = localize('clawdius.usage.dash.retry', "Retry");
			this.renderStore.add(addDisposableListener(retry, EventType.CLICK, () => void this.refreshOnDemand()));
		} else {
			append(inner, h('.clawdius-usage-empty')).textContent = localize('clawdius.usage.dash.statsUnavailable', "No local session stats yet. Start a Claude Code session (with the Agent Host enabled) to see your usage here.");
		}
	}

	private sectionTitle(parent: HTMLElement, text: string): HTMLElement {
		const block = append(parent, h('.clawdius-usage-block'));
		append(block, h('.clawdius-usage-block-title')).textContent = text;
		return block;
	}

	/** Prepends the leading refresh codicon to a `.clawdius-usage-refresh` button, built exactly the way the Control
	 *  Center's `button()` helper builds its icons (icon span + separate label span) so the Usage tab's Refresh and
	 *  Retry read as the same affordance as every other Refresh in the pane. The label MUST then be appended as its
	 *  own span - setting `textContent` on the button would wipe this icon out.
	 *
	 *  No `codicon-modifier-spin` while a refresh is in flight: that modifier only animates a whitelist of glyphs
	 *  (sync / loading / gear / notebook-state-executing, see `codicon-modifiers.css`), and `codicon-refresh` is not
	 *  one of them, so the class would sit on the element doing nothing. The in-flight state is already carried by
	 *  the "Refreshing…" label and the disabled attribute, and the Control Center's own Refresh buttons do not spin
	 *  either - which is the consistency this icon is here to restore. Were it ever wanted, the whole hero is torn
	 *  down and rebuilt on both edges of `refreshOnDemand`, so a state class applied here could never stick. */
	private refreshIcon(button: HTMLElement): void {
		append(button, h('span.clawdius-usage-refresh-ico')).classList.add(...ThemeIcon.asClassNameArray(Codicon.refresh));
	}

	private renderHero(parent: HTMLElement, account: IClaudeAccount, refreshedAt: Date | undefined): void {
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
		// Three states, not two. `undefined` = the credential probe was indeterminate (a locked macOS login keychain,
		// or a host we could not reach) and we have no prior answer - report that honestly instead of asserting
		// "Signed out", which is precisely the false report this probe was added to eliminate.
		const authLabel = account.signedIn === undefined
			? localize('clawdius.usage.dash.authUnknown', "Checking...")
			: account.signedIn
				? localize('clawdius.usage.dash.signedIn', "Signed in")
				: localize('clawdius.usage.dash.signedOut', "Signed out");
		part(localize('clawdius.usage.dash.auth', "Auth"), authLabel);

		// Honest scope statement: the lifetime tiles summarize only the sessions still within the retention window.
		// Computation is live from local transcripts - there is no "as of" / cached freshness to report.
		append(text, h('.clawdius-usage-hero-meta')).textContent = localize('clawdius.usage.dash.scope', "Summarizes your local Claude Code sessions from the last {0} days, alongside your live subscription limits.", this.horizonDays);
		append(text, h('.clawdius-usage-hero-meta')).textContent = refreshedAt
			? localize('clawdius.usage.dash.metaRefreshed', "Live limits last refreshed {0}.", refreshedAt.toLocaleString())
			: localize('clawdius.usage.dash.metaLocal', "Live limits refresh when you open this view or click Refresh.");

		append(hero, h('.clawdius-usage-hero-spacer'));
		const refresh = append(hero, h('button.clawdius-usage-refresh')) as HTMLButtonElement;
		this.refreshIcon(refresh);
		// In-progress feedback: a cold recompute takes a few seconds, so reflect it instead of a static label.
		append(refresh, h('span')).textContent = this.refreshing
			? localize('clawdius.usage.dash.refreshing', "Refreshing…")
			: localize('clawdius.usage.dash.refresh', "Refresh");
		refresh.disabled = this.refreshing;
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
			fill.style.width = `${limitFillWidthPercent(w.util)}%`;
			if (state) { fill.classList.add(state); }
			const pct = append(row, h('span.clawdius-usage-limit-pct'));
			pct.textContent = localize('clawdius.usage.pctUsed', "{0}% used", Math.round(w.util));
			if (state) { pct.classList.add(state); }
			const reset = resetLabel(w.resets);
			if (reset) { append(term, h('.clawdius-usage-limit-reset')).textContent = reset; }
		}
	}

	/** Open the on-demand retention editor (a quick input shown only when the user clicks the stat's edit pencil).
	 *  Reuses {@link applyRetention} so lowering still triggers the data-loss confirm, raising still shows the
	 *  future-only note, and the write + re-render still happen. The explanatory text lives in the prompt (and the
	 *  stat-row hover) instead of an always-on inline block. */
	private async editRetention(): Promise<void> {
		const value = await this.quickInputService.input({
			title: localize('clawdius.usage.dash.retentionTitle', "Transcript retention (days)"),
			value: String(this.horizonDays),
			prompt: localize('clawdius.usage.dash.retentionPrompt', "Claude Code keeps each session transcript on disk for this many days, then deletes it. This dashboard summarizes only the sessions still within that window. Changes write cleanupPeriodDays to your ~/.claude/settings.json."),
			placeHolder: localize('clawdius.usage.dash.retentionPlaceholder', "Number of days (1 or more)"),
			validateInput: async input => {
				const n = Number(input);
				return Number.isInteger(n) && n >= 1 ? undefined : localize('clawdius.usage.dash.retentionInvalidInput', "Enter a whole number of days (1 or more).");
			},
		});
		if (value === undefined) { return; }
		await this.applyRetention(value);
	}

	/** Validate + persist a new retention period to ~/.claude/settings.json, mirroring the Control Center's write
	 *  machinery (classifySettings gate + IJSONEditingService). Lowering the value can prune transcripts, so it is
	 *  gated behind a confirmation; raising only affects future retention, surfaced as a short note. */
	private async applyRetention(rawValue: string): Promise<void> {
		const next = Number(rawValue);
		if (!Number.isInteger(next) || next < 1) {
			this.notificationService.error(localize('clawdius.usage.dash.retentionInvalid', "Enter a whole number of days (1 or more)."));
			return;
		}
		const uri = URI.joinPath(await this.claudeDir(), 'settings.json');
		const cls = classifySettings(await this.readRaw(uri));
		if (cls.kind === 'malformed') {
			this.notificationService.error(localize('clawdius.usage.dash.retentionMalformed', "Can't update settings: {0} is not valid JSON. Fix the file and try again.", uri.fsPath));
			return;
		}
		const current = effectiveCleanupPeriodDays(cls.settings);
		if (next === current) { return; }
		if (next < current) {
			const confirmed = await this.dialogService.confirm({
				type: 'warning',
				message: localize('clawdius.usage.dash.retentionLowerTitle', "Lower transcript retention to {0} days?", next),
				detail: localize('clawdius.usage.dash.retentionLowerDetail', "Claude Code may permanently delete session transcripts older than {0} days. This data can't be recovered.", next),
				primaryButton: localize('clawdius.usage.dash.retentionLowerConfirm', "Lower Retention"),
			});
			if (!confirmed.confirmed) { return; }
		}
		try {
			if (cls.needsSeed) {
				await this.fileService.writeFile(uri, VSBuffer.fromString('{}\n'));
			}
			await this.jsonEditingService.write(uri, [{ path: ['cleanupPeriodDays'], value: next }], true);
		} catch (err) {
			this.notificationService.error(localize('clawdius.usage.dash.retentionWriteFailed', "Could not update retention: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		if (next > current) {
			this.notificationService.info(localize('clawdius.usage.dash.retentionRaised', "Retention raised to {0} days. This applies to future transcripts only - it does not restore sessions that were already pruned.", next));
		}
		this.horizonDays = next;
		this.render();
	}

	private renderOverview(parent: HTMLElement, stats: IClaudeStats, windowed: IWindowedStats): void {
		const block = this.sectionTitle(parent, localize('clawdius.usage.dash.overview', "Overview"));

		// Everything in this section is the in-window slice: windowStats already dropped any day older than the
		// horizon or after today, so the heatmap, the streaks, and every tile reflect ONLY the retention window.
		const todayKey = dateKey(new Date());
		const windowStart = this.windowStartKey();
		const activity = windowed.dailyActivity;

		// Contribution heatmap over the retention window.
		this.renderHeatmap(block, activity);

		// Windowed stat grid (sessions / messages / tokens / longest session all summed from in-window days only).
		const firstSession = stats.firstSessionDate?.slice(0, 10);
		const effectiveFirst = firstSession && firstSession > windowStart ? firstSession : windowStart;
		const streaks = computeStreaks(activity, effectiveFirst, todayKey);
		const rows = resolveModelRows(windowed.modelUsage);
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
		cell(localize('clawdius.usage.dash.sessions', "Sessions"), compact(windowed.totalSessions));
		cell(localize('clawdius.usage.dash.messages', "Messages"), compact(windowed.totalMessages));
		cell(localize('clawdius.usage.dash.activeDays', "Active days"), streaks.spanDays > 0 ? `${streaks.activeDays} / ${streaks.spanDays}` : `${streaks.activeDays}`);
		cell(localize('clawdius.usage.dash.longestSession', "Longest session"), windowed.longestSession?.duration ? formatDuration(windowed.longestSession.duration) : '-');
		cell(localize('clawdius.usage.dash.longestStreak', "Longest streak"), localize('clawdius.usage.dash.days', "{0} days", streaks.longest));
		cell(localize('clawdius.usage.dash.currentStreak', "Current streak"), localize('clawdius.usage.dash.days', "{0} days", streaks.current));

		// Transcript-retention stat row, with an inline pencil that opens the on-demand editor (Change 3). The label
		// carries the explanation as a hover so it stays discoverable without an always-on block.
		const retentionStat = append(grid, h('.clawdius-usage-stat'));
		const retentionLabel = append(retentionStat, h('span.clawdius-usage-stat-label'));
		retentionLabel.textContent = localize('clawdius.usage.dash.retention', "Transcript retention");
		this.renderStore.add(this.hoverService.setupDelayedHover(retentionLabel, { content: localize('clawdius.usage.dash.retentionExplain', "Claude Code keeps each session transcript on disk for this many days, then deletes it. This dashboard summarizes only the sessions still within that window.") }));
		const retentionRight = append(retentionStat, h('.clawdius-usage-stat-retention'));
		append(retentionRight, h('span.clawdius-usage-stat-value')).textContent = localize('clawdius.usage.dash.retentionValue', "{0} days", this.horizonDays);
		const retentionEdit = append(retentionRight, h('button.clawdius-usage-stat-edit'));
		append(retentionEdit, h('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.edit));
		const retentionEditLabel = localize('clawdius.usage.dash.retentionEditAria', "Edit retention window");
		retentionEdit.setAttribute('aria-label', retentionEditLabel);
		this.renderStore.add(this.hoverService.setupDelayedHover(retentionEdit, { content: retentionEditLabel }));
		this.renderStore.add(addDisposableListener(retentionEdit, EventType.CLICK, () => void this.editRetention()));

		if (streaks.mostActiveDate) {
			cell(localize('clawdius.usage.dash.mostActive', "Most active day"), `${streaks.mostActiveDate} (${compact(streaks.mostActiveCount)})`);
		}
	}

	/** Contribution heatmap spanning exactly the retention window: every day in [today-(N-1) .. today] is a cell
	 *  (no-activity days are empty/no-data cells); days older than the window or in the future are not rendered. */
	/** Collapsed-by-default sub-section below the Overview (heatmap + stats), above Tokens per day: the engine's
	 *  verbatim `/usage` "what's contributing to your usage" text. The CLI emits plain text with newlines +
	 *  2-space indents (not markdown), so render it in a whitespace-preserving <pre> to keep it exactly as the
	 *  engine wrote it. Only present when the one-shot fetch returned content. */
	private renderContribution(parent: HTMLElement): void {
		const text = this.loaded?.contribution;
		if (!text) { return; }
		const details = append(parent, h('details.clawdius-usage-contribution'));
		append(details, h('summary.clawdius-usage-contribution-summary')).textContent = localize('clawdius.usage.dash.contribTitle', "What's contributing to your usage");
		const body = append(details, h('.clawdius-usage-contribution-body'));
		append(body, h('pre.clawdius-usage-contribution-text')).textContent = text;
	}

	private renderHeatmap(parent: HTMLElement, activity: ReadonlyArray<IClaudeDailyActivity>): void {
		const today = new Date();
		// Pure window + intensity math (week count, per-cell level/visibility); the DOM build stays here.
		const { weeks, cells } = buildHeatmapModel(activity, today, this.horizonDays);
		// gridStart (the Sunday on/before the window start) is still needed to label the month columns below.
		const windowStart = new Date(today);
		windowStart.setDate(today.getDate() - (this.horizonDays - 1));
		const gridStart = new Date(windowStart);
		gridStart.setDate(windowStart.getDate() - windowStart.getDay());

		// Contribution heatmap: a responsive CSS grid of cells that stretch to fill the section width (kept square via
		// aspect-ratio, so the whole grid grows with the pane). Month labels track the week columns, a weekday gutter
		// (Mon/Wed/Fri) sits on the left, and a Less..More legend below.
		const wrap = append(parent, h('.clawdius-usage-heatmap'));

		const monthRow = append(wrap, h('.clawdius-usage-heatmap-months'));
		append(monthRow, h('.clawdius-usage-heatmap-gutter'));
		let prevMonth = -1;
		for (let col = 0; col < weeks; col++) {
			const weekStart = new Date(gridStart);
			weekStart.setDate(gridStart.getDate() + col * 7);
			const slot = append(monthRow, h('.clawdius-usage-heatmap-mslot'));
			if (weekStart.getMonth() !== prevMonth) {
				prevMonth = weekStart.getMonth();
				slot.textContent = weekStart.toLocaleDateString(undefined, { month: 'short' });
			}
		}

		const body = append(wrap, h('.clawdius-usage-heatmap-body'));
		const gutter = append(body, h('.clawdius-usage-heatmap-weekdays'));
		for (const dn of [' ', 'Mon', ' ', 'Wed', ' ', 'Fri', ' ']) { append(gutter, h('.clawdius-usage-heatmap-wd')).textContent = dn; }

		// One CSS grid of week-columns x 7 day-rows. grid-template-columns is set inline to repeat(weeks, minmax(16px, 1fr))
		// so the columns stretch to fill the section width (cells kept square via the 16px minimum in CSS). Cells are appended
		// column-major (each week top-to-bottom) to match grid-auto-flow: column, so the grid stays responsive on resize.
		const grid = append(body, h('.clawdius-usage-heatmap-grid'));
		grid.style.gridTemplateColumns = `repeat(${weeks}, minmax(16px, 1fr))`;
		for (const c of cells) {
			const cell = append(grid, h('.clawdius-usage-heatmap-day'));
			// Hide the future and anything older than the retention window (we never render past the horizon).
			if (!c.visible) { cell.style.visibility = 'hidden'; continue; }
			cell.classList.add(`level-${c.level}`);
			cell.title = `${c.key}: ${c.count}`;
		}

		const legend = append(wrap, h('.clawdius-usage-heatmap-legend'));
		append(legend, h('span.clawdius-usage-heatmap-legend-text')).textContent = localize('clawdius.usage.dash.less', "Less");
		for (let l = 1; l <= 4; l++) { append(legend, h(`.clawdius-usage-heatmap-day.level-${l}`)); }
		append(legend, h('span.clawdius-usage-heatmap-legend-text')).textContent = localize('clawdius.usage.dash.more', "More");
	}

	private renderTokensPerDay(parent: HTMLElement, windowed: IWindowedStats): void {
		const block = this.sectionTitle(parent, localize('clawdius.usage.dash.tokensPerDay', "Tokens per day"));

		const series = this.windowedModelTokens(windowed.dailyModelTokens);
		if (series.dates.length === 0 || series.models.length === 0) {
			append(block, h('.clawdius-usage-note')).textContent = localize('clawdius.usage.dash.noTokenData', "No token activity in this range.");
			this.renderModelBreakdown(block, windowed.modelUsage);
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
		// Plot: an SVG per-model ROUNDED STEP chart drawn at REAL pixel coordinates (the viewBox equals the
		// plot's px size, 1:1) so the rounded corners stay circular instead of being squished into ellipses by a
		// non-uniform preserveAspectRatio="none" scale. A ResizeObserver recomputes the viewBox + redraws the
		// paths whenever the plot resizes, so the rounding stays uniform and the chart stays responsive.
		const plot = append(chart, h('.clawdius-usage-chart-plot'));
		const doc = plot.ownerDocument;
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.classList.add('clawdius-usage-chart-svg');
		// The 0 baseline: a subtle horizontal orange axis line that the zero-value days rest on (matches the CLI
		// reference). Drawn first so the model lines sit on top of it.
		const baseline = doc.createElementNS(SVG_NS, 'line');
		baseline.setAttribute('stroke', '#d97757');
		baseline.setAttribute('stroke-width', '1.5');
		baseline.setAttribute('stroke-linecap', 'round');
		baseline.setAttribute('vector-effect', 'non-scaling-stroke');
		baseline.setAttribute('opacity', '0.8');
		svg.appendChild(baseline);
		// One rounded-step path per model; the `d` is (re)computed at real px in redraw() below.
		const paths = series.models.map((_m, i) => {
			const path = doc.createElementNS(SVG_NS, 'path');
			path.setAttribute('fill', 'none');
			path.setAttribute('stroke', MODEL_COLORS[i % MODEL_COLORS.length]);
			path.setAttribute('stroke-width', String(CHART_STROKE_WIDTH));
			path.setAttribute('stroke-linejoin', 'round');
			path.setAttribute('stroke-linecap', 'round');
			path.setAttribute('vector-effect', 'non-scaling-stroke'); // even line weight regardless of the px size
			svg.appendChild(path);
			return path;
		});
		plot.appendChild(svg);
		// Measure the SVG's real pixel box and draw at 1:1 so every arc is a true circle. baselineY here MUST match
		// roundedStepPath's so the zero-value line and the baseline coincide exactly.
		const redraw = () => {
			const { width, height } = svg.getBoundingClientRect();
			if (width <= 0 || height <= 0) { return; }
			svg.setAttribute('viewBox', `0 0 ${coord(width)} ${coord(height)}`);
			const baselineY = height - CHART_STROKE_WIDTH;
			baseline.setAttribute('x1', '0');
			baseline.setAttribute('y1', coord(baselineY));
			baseline.setAttribute('x2', coord(width));
			baseline.setAttribute('y2', coord(baselineY));
			for (let i = 0; i < series.models.length; i++) {
				paths[i].setAttribute('d', roundedStepPath(series.models[i].values, series.max, width, height));
			}
		};
		redraw();
		// Scope the observer to the plot's OWN window (ownerDocument.defaultView) via getWindow, so it works when
		// the dashboard is hosted in an auxiliary window; disposed with the rest of this render via renderStore.
		const resizeObserver = this.renderStore.add(new DisposableResizeObserver('ClaudeUsageDashboardView.tokensPerDay', () => redraw(), getWindow(plot)));
		// observe() returns a per-target unobserve disposable; own it (the leak tracker flags it otherwise).
		this.renderStore.add(resizeObserver.observe(plot));

		// X-axis date labels (first .. mid .. last).
		const xaxis = append(block, h('.clawdius-usage-chart-xaxis'));
		const fmt = (d: string) => { const dt = new Date(`${d}T00:00:00`); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
		const first = series.dates[0];
		const mid = series.dates[Math.floor(series.dates.length / 2)];
		const last = series.dates[series.dates.length - 1];
		append(xaxis, h('span')).textContent = fmt(first);
		if (series.dates.length > 2) { append(xaxis, h('span')).textContent = fmt(mid); }
		append(xaxis, h('span')).textContent = fmt(last);

		// Legend (colored dots) + the in-window model breakdown (In / Out / share).
		const legend = append(block, h('.clawdius-usage-chart-legend'));
		series.models.forEach((m, i) => {
			const item = append(legend, h('span.clawdius-usage-legend-item'));
			const dot = append(item, h('span.clawdius-usage-legend-dot'));
			dot.style.color = MODEL_COLORS[i % MODEL_COLORS.length];
			append(item, h('span')).textContent = m.label;
		});

		this.renderModelBreakdown(block, windowed.modelUsage);
	}

	private renderModelBreakdown(parent: HTMLElement, modelUsage: { readonly [model: string]: IClaudeModelStat }): void {
		const rows = resolveModelRows(modelUsage);
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

	private renderHourActivity(parent: HTMLElement, windowed: IWindowedStats): void {
		// Hour-of-day distribution summed over the in-window days only (not the lifetime global hourCounts).
		const counts: number[] = [];
		let max = 1;
		for (let hr = 0; hr < 24; hr++) { const c = windowed.hourCounts[String(hr)] ?? 0; counts.push(c); max = Math.max(max, c); }
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

	/** Build per-model value series over the full retention window (the in-window per-day slice), aligned to a
	 *  shared date axis. Delegates to {@link buildModelSeries} with the current clock + retention horizon. */
	private windowedModelTokens(daily: ReadonlyArray<IClaudeDailyModelTokens>): { dates: string[]; max: number; models: { id: string; label: string; values: number[] }[] } {
		return buildModelSeries(daily, this.windowStartKey(), dateKey(new Date()), MAX_CHART_MODELS);
	}
}
// CLAWDIUS-END
