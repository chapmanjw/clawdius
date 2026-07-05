/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Effective-config resolver
// The merged-precedence resolver behind the Control Center's EFFECTIVE view: given the parsed settings body from
// each source tier, it computes the winning value of every setting AND the provenance (which tier won, which were
// shadowed) so the UI can explain "why is this value what it is". The precedence order + merge semantics follow
// the verified Claude Code settings-resolution model. The key subtleties this encodes:
//   - The MANAGED BAND is non-merging: policyHelper (if present) replaces the whole band; otherwise the first
//     admin source (server-managed > mdm > managed-file) with any keys supplies the band's whole body; the
//     user-writable HKCU registry is a fallback consulted only when every higher admin source is empty.
//   - LOCK booleans (allowManaged*Only, the two sandbox allowlist locks) OR across the admin tiers (NOT HKCU),
//     and when a lock is set only the managed allowlist for that key survives.
//   - Everything BELOW the managed band deep-merges: scalars take the highest tier, objects deep-merge, arrays
//     concat + de-dupe. Permission arrays are deny-first (a deny at any tier is kept).

/** A JSON value as parsed from a settings.json body. */
export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
export interface JsonArray extends ReadonlyArray<JsonValue> { }
export interface JsonObject { readonly [key: string]: JsonValue | undefined }

/** The source tiers Clawdius can resolve on a desktop install, HIGHEST precedence first. `flag` and the in-memory
 *  plugin base are part of the real model but out of Clawdius's reach today; they are omitted rather than faked. */
export const enum SettingsTier {
	/** Managed policy program output. When present (from an admin source) it REPLACES the whole managed band. */
	PolicyHelper = 'policyHelper',
	/** Server-managed / remote policy, cached at ~/.claude/remote-settings.json. */
	ServerManaged = 'serverManaged',
	/** Enterprise MDM: Windows HKLM registry, or the macOS managed-preferences plist. */
	MdmRegistry = 'mdmRegistry',
	/** managed-settings.json (+ managed-settings.d drop-ins, pre-merged by the reader). */
	ManagedFile = 'managedFile',
	/** Windows HKCU policy registry - the user-writable managed fallback (excluded from lock keys). */
	HkcuRegistry = 'hkcuRegistry',
	/** Project-local, gitignored: <repo>/.claude/settings.local.json. */
	ProjectLocal = 'projectLocal',
	/** Shared project, checked in: <repo>/.claude/settings.json. */
	Project = 'project',
	/** User / global: ~/.claude/settings.json. */
	User = 'user',
}

/** Precedence rank, 1 = highest-wins. Mirrors the verified resolution order. */
export const TIER_RANK: Readonly<Record<SettingsTier, number>> = {
	[SettingsTier.PolicyHelper]: 1,
	[SettingsTier.ServerManaged]: 2,
	[SettingsTier.MdmRegistry]: 3,
	[SettingsTier.ManagedFile]: 4,
	[SettingsTier.HkcuRegistry]: 5,
	[SettingsTier.ProjectLocal]: 6,
	[SettingsTier.Project]: 7,
	[SettingsTier.User]: 8,
};

/** True for tiers whose bodies belong to the managed band (resolved non-merging). */
export function isManagedTier(tier: SettingsTier): boolean {
	return TIER_RANK[tier] <= TIER_RANK[SettingsTier.HkcuRegistry];
}

/** True for the ADMIN-controlled managed tiers whose lock booleans OR together. HKCU is user-writable, so it is
 *  managed for body precedence but excluded from the cross-source lock keys. */
export function isAdminManagedTier(tier: SettingsTier): boolean {
	return tier === SettingsTier.PolicyHelper
		|| tier === SettingsTier.ServerManaged
		|| tier === SettingsTier.MdmRegistry
		|| tier === SettingsTier.ManagedFile;
}

/** The managed-only lock booleans. When true, only the managed allowlist for the paired key applies. */
export const MANAGED_LOCK_KEYS = [
	'allowManagedPermissionRulesOnly',
	'allowManagedMcpServersOnly',
	'allowManagedHooksOnly',
	'strictPluginOnlyCustomization',
	'sandbox.filesystem.allowManagedReadPathsOnly',
	'sandbox.network.allowManagedDomainsOnly',
] as const;
export type ManagedLockKey = typeof MANAGED_LOCK_KEYS[number];

/** The parsed settings body from one tier. `body: undefined` means the source is absent (not on disk / no policy);
 *  an empty object means present-but-empty, which still counts as "delivered nothing" for the managed band. */
export interface ITierInput {
	readonly tier: SettingsTier;
	readonly body: JsonObject | undefined;
	/** Present but unreadable (e.g. a policyHelper we do not execute, or a registry we could not read): the tier
	 *  exists and may win, but its body is unknown. Rendered as "managed, value hidden" rather than resolved. */
	readonly opaque?: boolean;
}

/** One tier's contribution to a resolved leaf, for the drill-in. */
export interface IContribution {
	readonly tier: SettingsTier;
	readonly value: JsonValue;
	/** True when this contribution is the winner (its value is the effective one, or - for merged arrays - it is
	 *  one of the surviving contributors). */
	readonly winning: boolean;
}

/** A single resolved setting: its effective value + who set it + who was shadowed. */
export interface IResolvedSetting {
	/** Dotted path, e.g. `permissions.defaultMode` or `env.FOO`. */
	readonly path: string;
	readonly effective: JsonValue;
	/** How the value was produced: `scalar` (highest tier wins) or `array-union` (deny-first concat + de-dupe). */
	readonly kind: 'scalar' | 'array-union';
	/** The winning tier for a scalar; undefined for an array-union (multiple tiers may contribute). */
	readonly winner: SettingsTier | undefined;
	/** All contributing tiers, HIGHEST precedence first. */
	readonly contributions: readonly IContribution[];
	/** True when a managed-only lock forced this key to the managed allowlist (lower tiers were dropped, not merged). */
	readonly locked: boolean;
	/** True when an OPAQUE managed policy (a policyHelper we do not execute, or an unreadable admin source) outranks
	 *  this value: the shown value is the best-effort lower-tier result, and the hidden managed policy may override
	 *  it. The UI must NOT present a provisional value as a definitive effective value. */
	readonly provisional: boolean;
}

/** The full resolution: every leaf + the managed-band summary the UI needs for badging. */
export interface IEffectiveConfig {
	readonly settings: readonly IResolvedSetting[];
	/** Which tier supplied the managed body (undefined when no managed source delivered anything). */
	readonly managedWinner: SettingsTier | undefined;
	/** The lock keys that are in force (OR'd across admin tiers). */
	readonly activeLocks: readonly ManagedLockKey[];
	/** Tiers that are present but whose body is opaque (shown as "managed, value hidden"). */
	readonly opaqueTiers: readonly SettingsTier[];
	/** True when the WINNING managed tier is opaque (its body is unknown): the managed policy is active but its
	 *  values are hidden, so every resolved setting below is `provisional` and must be qualified in the UI. */
	readonly managedOpaque: boolean;
}

// --- helpers ---------------------------------------------------------------------------------------------------

function isObject(v: JsonValue | undefined): v is JsonObject {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArray(v: JsonValue | undefined): v is JsonArray {
	return Array.isArray(v);
}

/** Read a dotted path (e.g. `sandbox.network.allowManagedDomainsOnly`) out of a body. Own-enumerable keys only,
 *  so an inherited `constructor` / `toString` / `__proto__` is never mistaken for a configured value. */
function readPath(body: JsonObject | undefined, dotted: string): JsonValue | undefined {
	if (!body) { return undefined; }
	let cur: JsonValue | undefined = body;
	for (const seg of dotted.split('.')) {
		if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) { return undefined; }
		cur = cur[seg];
	}
	return cur;
}

/** Stable key for array de-dupe: primitives by value, objects/arrays by canonical JSON. Exported so the managed
 *  drop-in merge shares one de-dupe rule with the resolver's array-union. */
export function dedupeKey(v: JsonValue): string {
	return typeof v === 'object' && v !== null ? JSON.stringify(v) : `${typeof v}:${String(v)}`;
}

/** The tiers sorted highest-precedence first, dropping absent bodies (opaque tiers are kept for reporting). */
function orderTiers(inputs: readonly ITierInput[]): ITierInput[] {
	return [...inputs].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

/** A tier's body is present, readable, and has at least one own key. */
function hasBody(input: ITierInput): boolean {
	return !input.opaque && isObject(input.body) && Object.keys(input.body).length > 0;
}

/** A tier "delivers" a body when it exists (not absent) and {@link hasBody}. */
function delivers(input: ITierInput | undefined): input is ITierInput {
	return input !== undefined && hasBody(input);
}

// --- managed band ----------------------------------------------------------------------------------------------

interface IManagedResolution {
	/** The single winning managed body (already the whole band's contribution), or undefined if none delivered. */
	readonly body: JsonObject | undefined;
	readonly winner: SettingsTier | undefined;
	readonly locks: Set<ManagedLockKey>;
	readonly opaque: SettingsTier[];
}

/** Resolve the non-merging managed band into a single winning body + the OR'd locks. */
function resolveManagedBand(ordered: readonly ITierInput[]): IManagedResolution {
	const byTier = new Map<SettingsTier, ITierInput>();
	for (const t of ordered) { byTier.set(t.tier, t); }
	const opaque: SettingsTier[] = [];
	for (const t of ordered) {
		if (isManagedTier(t.tier) && t.opaque) { opaque.push(t.tier); }
	}

	// policyHelper, when present, REPLACES the whole band.
	const policy = byTier.get(SettingsTier.PolicyHelper);
	let winner: SettingsTier | undefined;
	let body: JsonObject | undefined;
	if (policy && (hasBody(policy) || policy.opaque)) {
		winner = SettingsTier.PolicyHelper;
		body = hasBody(policy) ? policy.body : undefined;
	} else {
		// First admin source (server-managed > mdm > managed-file) that delivers wins the whole body.
		const adminOrder = [SettingsTier.ServerManaged, SettingsTier.MdmRegistry, SettingsTier.ManagedFile];
		for (const tier of adminOrder) {
			const t = byTier.get(tier);
			if (delivers(t)) { winner = tier; body = t.body; break; }
		}
		// HKCU is the fallback, consulted only when every higher admin source delivered nothing.
		if (!winner) {
			const hkcu = byTier.get(SettingsTier.HkcuRegistry);
			if (delivers(hkcu)) { winner = SettingsTier.HkcuRegistry; body = hkcu.body; }
		}
	}

	// Lock booleans OR across the ADMIN managed tiers (never HKCU), regardless of which one supplied the body.
	const locks = new Set<ManagedLockKey>();
	for (const t of ordered) {
		if (!isAdminManagedTier(t.tier) || !isObject(t.body)) { continue; }
		for (const key of MANAGED_LOCK_KEYS) {
			if (readPath(t.body, key) === true) { locks.add(key); }
		}
	}

	return { body, winner, locks, opaque };
}

// --- merge -----------------------------------------------------------------------------------------------------

/** Which managed-lock key, if any, gates a given dotted path (so a locked key drops the non-managed contributors).
 *  Exported so the write-preflight can attribute a suppressed write to the responsible managed lock. */
export function lockForPath(path: string): ManagedLockKey | undefined {
	if (path === 'permissions.allow' || path === 'permissions.deny' || path === 'permissions.ask') {
		return 'allowManagedPermissionRulesOnly';
	}
	if (path === 'mcpServers' || path.startsWith('mcpServers.')) { return 'allowManagedMcpServersOnly'; }
	if (path === 'hooks' || path.startsWith('hooks.')) { return 'allowManagedHooksOnly'; }
	if (path === 'sandbox.filesystem.readPaths' || path === 'sandbox.filesystem.additionalReadPaths') {
		return 'sandbox.filesystem.allowManagedReadPathsOnly';
	}
	if (path === 'sandbox.network.allowedDomains' || path === 'sandbox.network.domains') {
		return 'sandbox.network.allowManagedDomainsOnly';
	}
	return undefined;
}

interface IMergeCtx {
	readonly managedWinner: SettingsTier | undefined;
	readonly locks: ReadonlySet<ManagedLockKey>;
	/** True when the managed winner's body is unknown - every emitted leaf is provisional (see IResolvedSetting). */
	readonly managedOpaque: boolean;
	readonly out: IResolvedSetting[];
}

/** One tier's value at the CURRENT node, HIGHEST precedence first. Values are threaded DOWN the recursion (never
 *  re-read from the root by a dotted path), so a settings key that literally contains a dot resolves correctly. */
interface INodeView {
	readonly tier: SettingsTier;
	readonly value: JsonValue;
}

/**
 * Resolve one node - the values every tier holds at `path` - into leaves on ctx.out.
 *
 * The merge REGIME is chosen from the HIGHEST-precedence contributor's type (`gated[0]`), so a higher scalar is
 * never overridden by a lower object/array (and vice versa); lower views of a different type are recorded as
 * shadowed. The lock gate runs FIRST for every node - object, array, or scalar - so a managed-only lock over an
 * object-valued path (mcpServers, hooks) drops the whole non-managed subtree instead of leaking through it.
 */
function resolveNode(path: string, views: readonly INodeView[], ctx: IMergeCtx): void {
	if (views.length === 0) { return; }

	const lock = lockForPath(path);
	const locked = lock !== undefined && ctx.locks.has(lock);
	const gated = locked ? views.filter(v => v.tier === ctx.managedWinner) : views;
	if (gated.length === 0) { return; } // the lock dropped every eligible contributor - emit nothing

	const top = gated[0].value;

	if (isObject(top)) {
		// Deep-merge: recurse per OWN-enumerable child key, discovered highest-tier-first. Lower non-object views
		// are shadowed by the winning object and contribute no children.
		const childKeys: string[] = [];
		const seen = new Set<string>();
		for (const v of gated) {
			if (!isObject(v.value)) { continue; }
			for (const k of Object.keys(v.value)) {
				if (!seen.has(k)) { seen.add(k); childKeys.push(k); }
			}
		}
		for (const k of childKeys) {
			const childViews: INodeView[] = [];
			for (const v of gated) {
				if (isObject(v.value) && Object.prototype.hasOwnProperty.call(v.value, k)) {
					const cv = v.value[k];
					if (cv !== undefined) { childViews.push({ tier: v.tier, value: cv }); }
				}
			}
			resolveNode(path ? `${path}.${k}` : k, childViews, ctx);
		}
		return;
	}

	if (isArray(top)) {
		// Array-union (deny-first): concat every array contributor high->low, de-duped. Lower scalars/objects are
		// shadowed by the winning array.
		const merged: JsonValue[] = [];
		const seen = new Set<string>();
		const contributions: IContribution[] = [];
		for (const v of gated) {
			if (!isArray(v.value)) { continue; }
			let added = false;
			for (const entry of v.value) {
				const key = dedupeKey(entry);
				if (!seen.has(key)) { seen.add(key); merged.push(entry); added = true; }
			}
			contributions.push({ tier: v.tier, value: v.value, winning: added });
		}
		ctx.out.push({ path, effective: merged, kind: 'array-union', winner: undefined, contributions, locked, provisional: ctx.managedOpaque });
		return;
	}

	// Scalar: the highest-precedence contributor wins; lower contributions (any type) are recorded as shadowed.
	ctx.out.push({
		path,
		effective: top,
		kind: 'scalar',
		winner: gated[0].tier,
		contributions: gated.map((v, i) => ({ tier: v.tier, value: v.value, winning: i === 0 })),
		locked,
		provisional: ctx.managedOpaque,
	});
}

/**
 * Resolve the effective configuration from the per-tier settings bodies.
 *
 * @param inputs one entry per source tier that exists (absent tiers may be omitted or passed with `body: undefined`).
 * @returns every resolved leaf with provenance, plus the managed-band summary for badging.
 */
export function resolveEffectiveConfig(inputs: readonly ITierInput[]): IEffectiveConfig {
	const ordered = orderTiers(inputs);
	const managed = resolveManagedBand(ordered);

	// Build the root view stack HIGHEST precedence first: the single winning managed body (the non-merging band's
	// whole contribution) on top, then each non-managed tier's whole body. Values thread DOWN from here.
	const rootViews: INodeView[] = [];
	if (managed.winner !== undefined && isObject(managed.body)) {
		rootViews.push({ tier: managed.winner, value: managed.body });
	}
	for (const t of ordered) {
		if (!isManagedTier(t.tier) && isObject(t.body)) { rootViews.push({ tier: t.tier, value: t.body }); }
	}

	// The managed band is opaque when a tier won it but delivered no readable body (an unexecuted policyHelper, or
	// - later - an unreadable registry/managed source). Then the hidden policy outranks every value below.
	const managedOpaque = managed.winner !== undefined && managed.body === undefined;

	const ctx: IMergeCtx = { managedWinner: managed.winner, locks: managed.locks, managedOpaque, out: [] };
	resolveNode('', rootViews, ctx);
	ctx.out.sort((a, b) => a.path.localeCompare(b.path));

	return {
		settings: ctx.out,
		managedWinner: managed.winner,
		activeLocks: [...managed.locks],
		opaqueTiers: managed.opaque,
		managedOpaque,
	};
}
// CLAWDIUS-END
