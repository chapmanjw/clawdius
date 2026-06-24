/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN shared Claude Code usage data layer
// Types, local-file readers, and shared helpers behind the Clawdius usage surfaces (status-bar indicator,
// hover popup, and the usage dashboard). Everything here reads the USER'S OWN local files - never the
// network. The ONLY allowed network egress is GET /api/oauth/usage, performed on demand by the clawdius-chat
// extension (the `clawdius.refreshUsageCapacity` command) when the user opens a usage surface; that response
// is cached locally to `.clawdius-usage-cache.json` and read here. No startup fetch, no background timer.

import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

// --- Live capacity (subscription rate-limit windows) from /api/oauth/usage, cached locally ---

export interface ICapacityWindow {
	readonly utilization?: number; // 0-100
	readonly resets_at?: string | null;
}

export interface IClaudeCapacity {
	readonly five_hour?: ICapacityWindow | null;
	readonly seven_day?: ICapacityWindow | null;
	readonly seven_day_opus?: ICapacityWindow | null;
	readonly seven_day_sonnet?: ICapacityWindow | null;
	// The oauth/usage response may also carry account / subscription identity; read defensively (no secrets).
	readonly account?: { readonly email?: string; readonly uuid?: string } | null;
	readonly organization?: { readonly name?: string } | null;
	readonly subscription?: { readonly type?: string; readonly plan?: string } | null;
}

// --- Historical stats from ~/.claude/stats-cache.json (written by the CLI) ---

export interface IClaudeModelStat {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadInputTokens?: number;
	readonly cacheCreationInputTokens?: number;
	readonly webSearchRequests?: number;
}

export interface IClaudeDailyActivity {
	readonly date?: string;
	readonly messageCount?: number;
	readonly sessionCount?: number;
	readonly toolCallCount?: number;
}

/** Per-day per-model token totals (drives the Tokens-per-Day line chart). */
export interface IClaudeDailyModelTokens {
	readonly date?: string;
	readonly tokensByModel?: { readonly [model: string]: number };
}

/** The single longest session by wall-clock duration (ms). */
export interface IClaudeLongestSession {
	readonly sessionId?: string;
	readonly duration?: number;
	readonly messageCount?: number;
	readonly timestamp?: string;
}

export interface IClaudeStats {
	readonly modelUsage?: { readonly [model: string]: IClaudeModelStat };
	readonly dailyActivity?: ReadonlyArray<IClaudeDailyActivity>;
	readonly dailyModelTokens?: ReadonlyArray<IClaudeDailyModelTokens>;
	readonly hourCounts?: { readonly [hour: string]: number };
	readonly longestSession?: IClaudeLongestSession;
	readonly totalSessions?: number;
	readonly totalMessages?: number;
	readonly firstSessionDate?: string;
	readonly lastComputedDate?: string;
}

/** A model token row resolved for charts: friendly label + family + total tokens (in+out). */
export interface IModelTokenRow {
	readonly id: string;
	readonly label: string;
	readonly family: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheCreate: number;
	readonly total: number;
}

/** Active-day streak summary derived from dailyActivity. */
export interface IStreaks {
	readonly activeDays: number;
	readonly spanDays: number;
	readonly longest: number;
	readonly current: number;
	readonly mostActiveDate?: string;
	readonly mostActiveCount: number;
}

// --- Account identity + engine provider ---

export const enum ClaudeProvider {
	Anthropic = 'anthropic',
	Bedrock = 'bedrock',
	Vertex = 'vertex',
	Custom = 'custom',
}

export interface IClaudeAccount {
	readonly signedIn: boolean;
	readonly email?: string;
	readonly organization?: string;
	readonly planTier?: string;
	readonly provider: ClaudeProvider;
}

/** A resolved capacity window for rendering: a human label, utilization %, and reset time. */
export interface IUsageWindow {
	readonly key: 'session' | 'week' | 'weekOpus' | 'weekSonnet';
	readonly label: string;
	readonly util: number;
	readonly resets?: string | null;
}

export const CAPACITY_CACHE_FILE = '.clawdius-usage-cache.json';
export const STATS_CACHE_FILE = 'stats-cache.json';
export const CREDENTIALS_FILE = '.credentials.json';
export const SETTINGS_FILE = 'settings.json';

/** Command (clawdius-chat extension) that performs the single allowed, user-initiated /api/oauth/usage fetch. */
export const REFRESH_CAPACITY_COMMAND_ID = 'clawdius.refreshUsageCapacity';
/** Command (registered by the dashboard contribution) that opens the full usage dashboard editor. */
export const OPEN_USAGE_DASHBOARD_COMMAND_ID = 'clawdius.openUsageDashboard';

/** Whether the resolved provider exposes subscription rate-limit windows (only Anthropic's own API does). */
export function providerHasLimits(provider: ClaudeProvider): boolean {
	return provider === ClaudeProvider.Anthropic;
}

/** Friendly provider label, e.g. 'Amazon Bedrock'. */
export function providerLabel(provider: ClaudeProvider): string {
	switch (provider) {
		case ClaudeProvider.Bedrock: return localize('clawdius.usage.providerBedrock', "Amazon Bedrock");
		case ClaudeProvider.Vertex: return localize('clawdius.usage.providerVertex', "Google Vertex AI");
		case ClaudeProvider.Custom: return localize('clawdius.usage.providerCustom', "Custom endpoint");
		default: return localize('clawdius.usage.providerAnthropic', "Anthropic");
	}
}

/** Compact a number: 1234 -> 1.2K, 1_500_000 -> 1.5M. */
export function compact(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
	return `${Math.round(n)}`;
}

/** Friendly model label, e.g. 'claude-opus-4-8' -> 'Opus 4.8', 'claude-fable-5' -> 'Fable 5'. */
export function modelLabel(id: string): string {
	const m = /^claude-(?<family>opus|sonnet|haiku|fable)-(?<major>\d+)-(?<minor>\d+)/.exec(id);
	if (m?.groups) {
		const { family, major, minor } = m.groups;
		return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
	}
	const m2 = /^claude-(?<family>opus|sonnet|haiku|fable)-(?<rest>.+)$/.exec(id);
	if (m2?.groups) {
		const { family, rest } = m2.groups;
		return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${rest}`;
	}
	// Non-Claude / local models: show the id, trimmed so it fits a legend.
	return id.length > 22 ? `${id.slice(0, 21)}.` : id;
}

/** A short model family token for grouping ('Opus' | 'Sonnet' | 'Haiku' | 'Fable' | 'Other'). */
export function modelFamily(id: string): string {
	const m = /claude-(?<family>opus|sonnet|haiku|fable)/.exec(id);
	if (m?.groups) { return `${m.groups.family.charAt(0).toUpperCase()}${m.groups.family.slice(1)}`; }
	return localize('clawdius.usage.modelOther', "Other");
}

/** Human reset label from an ISO timestamp, relative to today, e.g. 'Resets 3:00 PM' or 'Resets Jun 30, 9:00 AM'. */
export function resetLabel(resets_at: string | null | undefined): string | undefined {
	if (!resets_at) { return undefined; }
	const d = new Date(resets_at);
	if (isNaN(d.getTime())) { return undefined; }
	const now = new Date();
	const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (d.toDateString() === now.toDateString()) { return localize('clawdius.usage.resetsToday', "Resets {0}", time); }
	const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	return localize('clawdius.usage.resetsDay', "Resets {0}, {1}", day, time);
}

/** The non-null capacity windows that apply, in Claude Code's order. */
export function capacityWindows(capacity: IClaudeCapacity | undefined): IUsageWindow[] {
	if (!capacity) { return []; }
	const out: IUsageWindow[] = [];
	const add = (w: ICapacityWindow | null | undefined, key: IUsageWindow['key'], label: string) => {
		if (w && typeof w.utilization === 'number') { out.push({ key, label, util: w.utilization, resets: w.resets_at }); }
	};
	add(capacity.five_hour, 'session', localize('clawdius.usage.session', "Current session"));
	add(capacity.seven_day, 'week', localize('clawdius.usage.week', "Current week (all models)"));
	add(capacity.seven_day_opus, 'weekOpus', localize('clawdius.usage.weekOpus', "Current week (Opus)"));
	add(capacity.seven_day_sonnet, 'weekSonnet', localize('clawdius.usage.weekSonnet', "Current week (Sonnet)"));
	return out;
}

// --- Derived stats (pure; computed from the normalized cache for the dashboard) ---

/** Format a wall-clock duration in ms as the CLI does, e.g. '2d 17h 48m', '48m', '12s'. */
export function formatDuration(ms: number): string {
	if (!isFinite(ms) || ms <= 0) { return '0s'; }
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) { return `${d}d ${h}h ${m}m`; }
	if (h > 0) { return `${h}h ${m}m`; }
	if (m > 0) { return `${m}m`; }
	return `${s % 60}s`;
}

/** Days between two YYYY-MM-DD keys (b - a), inclusive span when added to 1. */
function dayDiff(a: string, b: string): number {
	const da = Date.parse(`${a}T00:00:00Z`);
	const db = Date.parse(`${b}T00:00:00Z`);
	if (isNaN(da) || isNaN(db)) { return 0; }
	return Math.round((db - da) / 86400000);
}

/**
 * Active-day count, calendar span, longest + current streak, and the most-active day, from dailyActivity.
 * `todayKey` is passed in (the workflow forbids Date.now in some contexts; the editor supplies a stable key).
 */
export function computeStreaks(activity: ReadonlyArray<IClaudeDailyActivity>, firstSessionDate: string | undefined, todayKey: string): IStreaks {
	const days = activity.map(a => a.date).filter((d): d is string => typeof d === 'string').map(d => d.slice(0, 10)).sort();
	const activeDays = days.length;
	const firstKey = (firstSessionDate ?? days[0] ?? todayKey).slice(0, 10);
	const spanDays = activeDays > 0 ? Math.max(activeDays, dayDiff(firstKey, todayKey) + 1) : 0;

	let longest = 0, run = 0;
	for (let i = 0; i < days.length; i++) {
		if (i > 0 && dayDiff(days[i - 1], days[i]) === 1) { run++; } else { run = 1; }
		longest = Math.max(longest, run);
	}
	// Current streak: trailing run ending today or yesterday.
	let current = 0;
	if (days.length > 0) {
		const last = days[days.length - 1];
		const gap = dayDiff(last, todayKey);
		if (gap <= 1) {
			current = 1;
			for (let i = days.length - 1; i > 0; i--) {
				if (dayDiff(days[i - 1], days[i]) === 1) { current++; } else { break; }
			}
		}
	}

	let mostActiveDate: string | undefined;
	let mostActiveCount = 0;
	for (const a of activity) {
		const c = a.messageCount ?? 0;
		if (c > mostActiveCount) { mostActiveCount = c; mostActiveDate = a.date; }
	}
	return { activeDays, spanDays, longest, current, mostActiveDate, mostActiveCount };
}

/** Resolve modelUsage into sorted rows (by total tokens desc) with friendly labels + cache split. */
export function resolveModelRows(modelUsage: { readonly [model: string]: IClaudeModelStat } | undefined): IModelTokenRow[] {
	const rows: IModelTokenRow[] = [];
	for (const [id, m] of Object.entries(modelUsage ?? {})) {
		const input = m.inputTokens ?? 0;
		const output = m.outputTokens ?? 0;
		const cacheRead = m.cacheReadInputTokens ?? 0;
		const cacheCreate = m.cacheCreationInputTokens ?? 0;
		const total = input + output;
		if (total + cacheRead + cacheCreate <= 0) { continue; }
		rows.push({ id, label: modelLabel(id), family: modelFamily(id), input, output, cacheRead, cacheCreate, total });
	}
	return rows.sort((a, b) => b.total - a.total);
}

// --- Local-file readers (all best-effort: a missing/corrupt file yields undefined, never throws) ---

async function readJson<T>(fileService: IFileService, uri: URI): Promise<T | undefined> {
	try {
		const content = await fileService.readFile(uri);
		return JSON.parse(content.value.toString()) as T;
	} catch {
		return undefined;
	}
}

/** ~2 years of daily entries; bounds render work even on a bloated/pathological stats cache. */
const MAX_DAILY_ACTIVITY = 800;

function isFiniteNumber(v: unknown): number {
	return typeof v === 'number' && isFinite(v) ? v : 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Coerce a parsed stats-cache.json into a safe shape. The file is the user's own and the CLI's schema is not
 * guaranteed, so a syntactically valid file with the wrong shape (e.g. `modelUsage: {x: null}` or
 * `dailyActivity: {}`) must not crash the renderers. Numbers are coerced to finite, objects/arrays validated,
 * and dailyActivity is sorted and capped so a huge history can't block the UI thread.
 */
function normalizeStats(raw: unknown): IClaudeStats | undefined {
	if (!isPlainObject(raw)) { return undefined; }

	const modelUsage: { [model: string]: IClaudeModelStat } = {};
	if (isPlainObject(raw.modelUsage)) {
		for (const [id, m] of Object.entries(raw.modelUsage)) {
			if (!isPlainObject(m)) { continue; }
			modelUsage[id] = {
				inputTokens: isFiniteNumber(m.inputTokens),
				outputTokens: isFiniteNumber(m.outputTokens),
				cacheReadInputTokens: isFiniteNumber(m.cacheReadInputTokens),
				cacheCreationInputTokens: isFiniteNumber(m.cacheCreationInputTokens),
				webSearchRequests: isFiniteNumber(m.webSearchRequests),
			};
		}
	}

	let dailyActivity: IClaudeDailyActivity[] = [];
	if (Array.isArray(raw.dailyActivity)) {
		dailyActivity = raw.dailyActivity
			.filter(isPlainObject)
			.map(a => ({
				date: typeof a.date === 'string' ? a.date : undefined,
				messageCount: isFiniteNumber(a.messageCount),
				sessionCount: isFiniteNumber(a.sessionCount),
				toolCallCount: isFiniteNumber(a.toolCallCount),
			}))
			.filter(a => typeof a.date === 'string')
			.sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : 1));
		if (dailyActivity.length > MAX_DAILY_ACTIVITY) {
			dailyActivity = dailyActivity.slice(-MAX_DAILY_ACTIVITY);
		}
	}

	let dailyModelTokens: IClaudeDailyModelTokens[] = [];
	if (Array.isArray(raw.dailyModelTokens)) {
		dailyModelTokens = raw.dailyModelTokens
			.filter(isPlainObject)
			.map(d => {
				const tokensByModel: { [model: string]: number } = {};
				if (isPlainObject(d.tokensByModel)) {
					for (const [model, t] of Object.entries(d.tokensByModel)) { tokensByModel[model] = isFiniteNumber(t); }
				}
				return { date: typeof d.date === 'string' ? d.date : undefined, tokensByModel };
			})
			.filter(d => typeof d.date === 'string')
			.sort((a, b) => (a.date! < b.date! ? -1 : 1));
		if (dailyModelTokens.length > MAX_DAILY_ACTIVITY) {
			dailyModelTokens = dailyModelTokens.slice(-MAX_DAILY_ACTIVITY);
		}
	}

	const hourCounts: { [hour: string]: number } = {};
	if (isPlainObject(raw.hourCounts)) {
		for (const [hour, c] of Object.entries(raw.hourCounts)) {
			const hn = Number(hour);
			if (Number.isInteger(hn) && hn >= 0 && hn <= 23) { hourCounts[String(hn)] = isFiniteNumber(c); }
		}
	}

	let longestSession: IClaudeLongestSession | undefined;
	if (isPlainObject(raw.longestSession)) {
		const ls = raw.longestSession;
		longestSession = {
			duration: isFiniteNumber(ls.duration),
			messageCount: isFiniteNumber(ls.messageCount),
			timestamp: typeof ls.timestamp === 'string' ? ls.timestamp : undefined,
		};
	}

	return {
		modelUsage,
		dailyActivity,
		dailyModelTokens,
		hourCounts,
		longestSession,
		totalSessions: isFiniteNumber(raw.totalSessions),
		totalMessages: isFiniteNumber(raw.totalMessages),
		firstSessionDate: typeof raw.firstSessionDate === 'string' ? raw.firstSessionDate : undefined,
		lastComputedDate: typeof raw.lastComputedDate === 'string' ? raw.lastComputedDate : undefined,
	};
}

export async function readStats(fileService: IFileService, claudeDir: URI): Promise<IClaudeStats | undefined> {
	return normalizeStats(await readJson<unknown>(fileService, URI.joinPath(claudeDir, STATS_CACHE_FILE)));
}

export async function readCapacity(fileService: IFileService, claudeDir: URI): Promise<IClaudeCapacity | undefined> {
	return readJson<IClaudeCapacity>(fileService, URI.joinPath(claudeDir, CAPACITY_CACHE_FILE));
}

/**
 * Resolve account identity + engine provider from local files only.
 * - signedIn: whether ~/.claude/.credentials.json exists (we never read the token itself).
 * - email/organization/planTier: from the cached oauth/usage response when present (no secrets).
 * - provider: inferred from ~/.claude/settings.json env (Bedrock/Vertex/custom base URL) else Anthropic.
 */
export async function readAccount(fileService: IFileService, claudeDir: URI, capacity: IClaudeCapacity | undefined): Promise<IClaudeAccount> {
	let signedIn = false;
	try {
		await fileService.stat(URI.joinPath(claudeDir, CREDENTIALS_FILE));
		signedIn = true;
	} catch {
		signedIn = false;
	}

	const provider = await detectProvider(fileService, claudeDir);
	const planTier = capacity?.subscription?.plan ?? capacity?.subscription?.type;
	return {
		signedIn,
		email: capacity?.account?.email,
		organization: capacity?.organization?.name,
		planTier,
		provider,
	};
}

interface IClaudeSettings {
	readonly env?: { readonly [key: string]: unknown };
}

/** Infer the engine provider from ~/.claude/settings.json env. Defaults to Anthropic. */
export async function detectProvider(fileService: IFileService, claudeDir: URI): Promise<ClaudeProvider> {
	const settings = await readJson<IClaudeSettings>(fileService, URI.joinPath(claudeDir, SETTINGS_FILE));
	const env = settings?.env ?? {};
	const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
	if (truthy(env['CLAUDE_CODE_USE_BEDROCK'])) { return ClaudeProvider.Bedrock; }
	if (truthy(env['CLAUDE_CODE_USE_VERTEX'])) { return ClaudeProvider.Vertex; }
	const baseUrl = env['ANTHROPIC_BASE_URL'];
	if (typeof baseUrl === 'string' && baseUrl.length > 0 && !/api\.anthropic\.com/i.test(baseUrl)) {
		return ClaudeProvider.Custom;
	}
	return ClaudeProvider.Anthropic;
}

// --- The Claude wordmark glyph (inline SVG, inherits currentColor so it takes the host text color) ---

/** The official Claude mark path (from anthropic.claude-code claude-logo.svg). */
const CLAUDE_LOGO_PATH = 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

/** Append the Claude mark as an inline SVG that inherits the host element's `currentColor`. */
export function appendClaudeLogo(parent: HTMLElement, size: number): SVGSVGElement {
	const NS = 'http://www.w3.org/2000/svg';
	const doc = parent.ownerDocument;
	const svg = doc.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('clawdius-claude-logo');
	const path = doc.createElementNS(NS, 'path');
	path.setAttribute('d', CLAUDE_LOGO_PATH);
	path.setAttribute('fill', 'currentColor');
	path.setAttribute('fill-rule', 'nonzero');
	svg.appendChild(path);
	parent.appendChild(svg);
	return svg;
}
// CLAWDIUS-END
