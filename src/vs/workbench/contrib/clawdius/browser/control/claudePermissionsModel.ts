/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN permissions control model (Config Control Center MVP)
// Pure, UI-free logic for the interactive Permissions control pane: parse the `permissions` block of a Claude
// Code settings.json and compute the exact IJSONEditingService write intents for editing it (set defaultMode,
// add / remove / move a rule between the allow / ask / deny buckets). A rule lives in exactly ONE bucket, so
// adding or moving a rule removes it from the other buckets (de-dupe). Whole-array writes per changed bucket
// keep the surrounding settings.json formatting intact. No file or service access here - that lives in the
// editor pane - so this is fully unit-testable.

/** The three permission rule buckets (least -> most restrictive intent is not implied; they are independent). */
export type PermissionBucket = 'allow' | 'ask' | 'deny';
export const PERMISSION_BUCKETS: readonly PermissionBucket[] = ['allow', 'ask', 'deny'];

/** The documented `permissions.defaultMode` values (from claude-code-settings.schema.json). */
export type PermissionDefaultMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export const PERMISSION_DEFAULT_MODES: readonly PermissionDefaultMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

/** True when `value` is one of the documented defaultMode strings. */
export function isPermissionDefaultMode(value: string | undefined): value is PermissionDefaultMode {
	return value !== undefined && (PERMISSION_DEFAULT_MODES as readonly string[]).includes(value);
}

/** The parsed `permissions` block. Arrays are de-duplicated, order-preserving. */
export interface IPermissionsState {
	readonly defaultMode: PermissionDefaultMode | undefined;
	readonly allow: readonly string[];
	readonly ask: readonly string[];
	readonly deny: readonly string[];
	readonly additionalDirectories: readonly string[];
}

/** The three rule buckets as mutable arrays (intermediate compute form). */
interface IBuckets {
	allow: string[];
	ask: string[];
	deny: string[];
}

/** A single IJSONEditingService edit: set `value` at `path` (value `undefined` deletes the key). */
export interface IJsonWrite {
	readonly path: ReadonlyArray<string>;
	readonly value: string | ReadonlyArray<string> | undefined;
}

/** Trim a rule; return undefined for blank input (blank rules are never written). */
export function normalizeRule(rule: string): string | undefined {
	const trimmed = rule.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** De-duplicate a string array, preserving first-occurrence order. */
function dedupe(values: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (!seen.has(v)) { seen.add(v); out.push(v); }
	}
	return out;
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value) ? dedupe(value.filter((v): v is string => typeof v === 'string')) : [];
}

/**
 * Parse the `permissions` block from an already-parsed settings object. Missing/invalid -> empty state.
 * Arrays are de-duplicated (order-preserving) so the control surface shows each rule once.
 */
export function parsePermissions(settings: unknown): IPermissionsState {
	const perms = (settings && typeof settings === 'object')
		? (settings as { permissions?: unknown }).permissions
		: undefined;
	const p = (perms && typeof perms === 'object') ? perms as Record<string, unknown> : {};
	const rawMode = typeof p.defaultMode === 'string' ? p.defaultMode : undefined;
	return {
		defaultMode: isPermissionDefaultMode(rawMode) ? rawMode : undefined,
		allow: readStringArray(p.allow),
		ask: readStringArray(p.ask),
		deny: readStringArray(p.deny),
		additionalDirectories: readStringArray(p.additionalDirectories),
	};
}

function bucketsOf(state: IPermissionsState): IBuckets {
	return { allow: [...state.allow], ask: [...state.ask], deny: [...state.deny] };
}

/** Remove a rule from every bucket (used before placing it in its target bucket). */
function removeEverywhere(buckets: IBuckets, rule: string): void {
	for (const b of PERMISSION_BUCKETS) {
		buckets[b] = buckets[b].filter(r => r !== rule);
	}
}

/**
 * Place `rawRule` in `target`, removing it from the other buckets (a rule belongs to exactly one bucket).
 * Returns the next buckets, or undefined when the rule is blank. Adding a rule already in `target` is a no-op
 * on that bucket but still clears any stale copies elsewhere.
 */
export function addRule(state: IPermissionsState, target: PermissionBucket, rawRule: string): IBuckets | undefined {
	const rule = normalizeRule(rawRule);
	if (!rule) { return undefined; }
	const buckets = bucketsOf(state);
	removeEverywhere(buckets, rule);
	buckets[target].push(rule);
	return buckets;
}

/** Remove `rule` from `bucket`. Returns the next buckets. */
export function removeRule(state: IPermissionsState, bucket: PermissionBucket, rule: string): IBuckets {
	const buckets = bucketsOf(state);
	buckets[bucket] = buckets[bucket].filter(r => r !== rule);
	return buckets;
}

/** Move `rule` from `from` to `to` (remove everywhere, then add to `to`). No-op shape when from === to. */
export function moveRule(state: IPermissionsState, from: PermissionBucket, to: PermissionBucket, rule: string): IBuckets {
	const buckets = bucketsOf(state);
	removeEverywhere(buckets, rule);
	buckets[to].push(rule);
	return buckets;
}

/** Emit a whole-array write for each bucket whose contents changed vs `state`. */
export function bucketWrites(state: IPermissionsState, next: IBuckets): IJsonWrite[] {
	const writes: IJsonWrite[] = [];
	for (const b of PERMISSION_BUCKETS) {
		const before = state[b];
		const after = next[b];
		if (before.length !== after.length || before.some((r, i) => r !== after[i])) {
			writes.push({ path: ['permissions', b], value: after });
		}
	}
	return writes;
}

/** The write to set (or clear, when undefined) `permissions.defaultMode`. */
export function defaultModeWrite(mode: PermissionDefaultMode | undefined): IJsonWrite {
	return { path: ['permissions', 'defaultMode'], value: mode };
}

/** The write to set `permissions.additionalDirectories`. */
export function additionalDirectoriesWrite(dirs: ReadonlyArray<string>): IJsonWrite {
	return { path: ['permissions', 'additionalDirectories'], value: dedupe([...dirs]) };
}

/**
 * Build an `mcp__<server>__<tool>` permission rule string. A blank tool targets the whole server
 * (`mcp__<server>`), which Claude Code reads as "all tools on this server".
 */
export function mcpToolRule(server: string, tool: string): string | undefined {
	const s = server.trim();
	if (!s) { return undefined; }
	const t = tool.trim();
	return t ? `mcp__${s}__${t}` : `mcp__${s}`;
}

/** A friendlier, structured view of a rule for display - chips instead of the raw string. */
export interface IRuleView {
	readonly raw: string;
	/** 'mcp' = an mcp__server__tool rule; 'tool' = Tool(pattern); 'bare' = a bare tool name or anything else. */
	readonly kind: 'mcp' | 'tool' | 'bare';
	/** Headline chip: the MCP server, or the tool name. */
	readonly primary: string;
	/** Detail: the MCP tool (omitted = whole server), or the tool's pattern. Undefined for bare. */
	readonly secondary?: string;
}

/**
 * Parse a permission rule into its display parts. `mcp__github__create_issue` -> {mcp, github, create_issue};
 * `Bash(git push:*)` -> {tool, Bash, "git push:*"}; `WebFetch` -> {bare, WebFetch}. Always round-trips: the
 * raw string is preserved so power users still see (via tooltip) and edit the exact value.
 */
export function parseRule(raw: string): IRuleView {
	const rule = raw.trim();
	if (rule.startsWith('mcp__')) {
		const rest = rule.slice('mcp__'.length);
		const sep = rest.indexOf('__');
		if (sep === -1) {
			return { raw: rule, kind: 'mcp', primary: rest, secondary: undefined };
		}
		const tool = rest.slice(sep + 2);
		return { raw: rule, kind: 'mcp', primary: rest.slice(0, sep), secondary: tool.length > 0 ? tool : undefined };
	}
	const m = /^([A-Za-z][\w-]*)\((.*)\)$/.exec(rule);
	if (m) {
		return { raw: rule, kind: 'tool', primary: m[1], secondary: m[2].length > 0 ? m[2] : undefined };
	}
	return { raw: rule, kind: 'bare', primary: rule, secondary: undefined };
}

/**
 * The curated set of Claude Code built-in tools the "Claude Tools" add mode offers. Not exhaustive by design -
 * anything not here (a future tool, an odd form) is still addable via the Raw Rule mode, so the list never
 * becomes a hard gate. Order is roughly by how often each is permission-gated.
 */
export const BUILTIN_TOOLS: readonly string[] = [
	'Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'LS',
	'Task', 'NotebookRead', 'NotebookEdit', 'BashOutput', 'KillBash', 'TodoWrite', 'ExitPlanMode',
];

/**
 * Build a built-in tool rule from a tool name + optional specifier. Blank tool -> undefined (nothing chosen);
 * blank specifier -> the bare `Tool` (all uses); otherwise `Tool(specifier)`.
 */
export function builtinRule(tool: string, specifier: string): string | undefined {
	const t = tool.trim();
	if (!t) { return undefined; }
	const s = specifier.trim();
	return s.length > 0 ? `${t}(${s})` : t;
}

/** Classify a rule into the three add-mode buckets: an MCP rule, a known built-in Claude tool, or raw/other. */
export function classifyRule(raw: string): 'mcp' | 'builtin' | 'raw' {
	const view = parseRule(raw);
	if (view.kind === 'mcp') { return 'mcp'; }
	if ((view.kind === 'tool' || view.kind === 'bare') && BUILTIN_TOOLS.includes(view.primary)) { return 'builtin'; }
	return 'raw';
}
// CLAWDIUS-END
