/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Write preflight
// Preflight a pending settings write against the full precedence model BEFORE it is applied: it answers the one
// question the per-scope editors cannot ("will this edit actually change the effective value, or will a higher-
// precedence source override it?"). It applies the write to a copy of the target tier, re-resolves, and reports
// the effective value before/after plus whether the write takes effect - so the UI can warn "a managed policy
// overrides this key; your change won't take effect" instead of letting the user edit into the void.

import {
	IEffectiveConfig, ITierInput, JsonObject, JsonValue, SettingsTier, TIER_RANK, lockForPath, resolveEffectiveConfig,
} from './clawdiusEffectiveConfig.js';

/** The outcome of preflighting one write. */
export interface IWritePreview {
	readonly path: string;
	readonly targetTier: SettingsTier;
	readonly written: JsonValue;
	/** The effective value at `path` before the write (undefined if nothing set it). */
	readonly effectiveBefore: JsonValue | undefined;
	/** The effective value at `path` after applying the write (undefined if it resolves to nothing). */
	readonly effectiveAfter: JsonValue | undefined;
	/** True when the write actually reaches the effective config - a scalar wins at the target tier, or an array
	 *  entry survives into the union. False when a higher tier overrides it or a managed lock drops it. */
	readonly takesEffect: boolean;
	/** When the write does NOT take effect, the higher-precedence tier that overrides it (undefined if unknown,
	 *  e.g. an opaque managed policy). */
	readonly overriddenBy: SettingsTier | undefined;
	/** True when an opaque managed policy makes the outcome uncertain (the write MIGHT be overridden by a hidden
	 *  value). Distinct from a known override: here we cannot see the managed body at all. */
	readonly provisional: boolean;
}

function isObject(v: JsonValue | undefined): v is JsonObject {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Return a deep copy of `body` with `path` (dotted) set to `value`, creating intermediate objects as needed. */
function deepSet(body: JsonObject, path: string, value: JsonValue): JsonObject {
	const segments = path.split('.');
	const root: { [key: string]: JsonValue | undefined } = { ...body };
	let cursor = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i];
		const existing = cursor[seg];
		const child: { [key: string]: JsonValue | undefined } = isObject(existing) ? { ...existing } : {};
		cursor[seg] = child;
		cursor = child;
	}
	cursor[segments[segments.length - 1]] = value;
	return root;
}

/** The tier list with the pending write applied to a copy of the target tier's body. */
function applyWrite(tiers: readonly ITierInput[], targetTier: SettingsTier, path: string, value: JsonValue): ITierInput[] {
	let found = false;
	const next = tiers.map(t => {
		if (t.tier !== targetTier) { return t; }
		found = true;
		return { ...t, body: deepSet(isObject(t.body) ? t.body : {}, path, value), opaque: false };
	});
	if (!found) { next.push({ tier: targetTier, body: deepSet({}, path, value) }); }
	return next;
}

/**
 * Preflight a write of `value` at `path` into `targetTier`, given the current per-tier bodies.
 *
 * Applies the write to a copy of the target tier, re-resolves the whole precedence stack, and reports whether the
 * edit reaches the effective config. Pure: it never touches disk.
 */
export function previewWrite(
	tiers: readonly ITierInput[],
	targetTier: SettingsTier,
	path: string,
	value: JsonValue,
): IWritePreview {
	const before = resolveEffectiveConfig(tiers).settings.find(s => s.path === path);
	const afterConfig = resolveEffectiveConfig(applyWrite(tiers, targetTier, path, value));

	// The write resolves to a leaf at `path` (scalar / array), or - for an OBJECT value - to descendant leaves
	// under `path.*` (the resolver never emits a leaf at an object node's own path). If it resolves to nothing,
	// the path was suppressed: a managed lock, or a higher-precedence scalar/array at an ancestor path.
	const atOrUnder = afterConfig.settings.filter(s => s.path === path || s.path.startsWith(`${path}.`));
	const exact = atOrUnder.find(s => s.path === path);

	let takesEffect: boolean;
	let overriddenBy: SettingsTier | undefined;
	let effectiveAfter: JsonValue | undefined;
	let provisional: boolean;

	if (exact) {
		provisional = exact.provisional;
		effectiveAfter = exact.effective;
		if (exact.kind === 'array-union') {
			// The write reaches the union only if the target tier contributed a SURVIVING (winning) entry - an
			// empty/redundant/wrong-typed array adds nothing and does NOT take effect, even though the union is
			// non-empty from other tiers.
			const survives = exact.contributions.some(c => c.tier === targetTier && c.winning);
			takesEffect = survives && (!exact.locked || targetTier === afterConfig.managedWinner);
			if (!takesEffect && exact.locked) { overriddenBy = afterConfig.managedWinner; }
		} else {
			// Scalar: the write takes effect only if the target tier ends up winning the key.
			takesEffect = exact.winner === targetTier;
			if (!takesEffect && exact.winner !== undefined && TIER_RANK[exact.winner] < TIER_RANK[targetTier]) {
				overriddenBy = exact.winner;
			}
		}
	} else if (atOrUnder.length > 0) {
		// An object write, resolved to descendant leaves. It takes effect if the target won at least one of them.
		provisional = atOrUnder.some(s => s.provisional);
		takesEffect = atOrUnder.some(s => s.winner === targetTier || (s.kind === 'array-union' && s.contributions.some(c => c.tier === targetTier && c.winning)));
		effectiveAfter = undefined; // an object subtree; the per-key results are visible in the Effective view
		if (!takesEffect) {
			overriddenBy = atOrUnder.map(s => s.winner).find((w): w is SettingsTier => w !== undefined && TIER_RANK[w] < TIER_RANK[targetTier]);
		}
	} else {
		// Suppressed: the write produced no effective value. Attribute the blocker.
		takesEffect = false;
		effectiveAfter = undefined;
		provisional = afterConfig.managedOpaque;
		const lock = lockForPath(path);
		overriddenBy = (lock !== undefined && afterConfig.activeLocks.includes(lock))
			? afterConfig.managedWinner
			: findAncestorOverride(afterConfig, path, targetTier);
	}

	return {
		path,
		targetTier,
		written: value,
		effectiveBefore: before?.effective,
		effectiveAfter,
		takesEffect,
		overriddenBy,
		provisional,
	};
}

/** A higher-precedence scalar/array at an ANCESTOR of `path` shadows a nested write (e.g. a managed `foo` scalar
 *  shadows a user write to `foo.bar`). Return the nearest such ancestor's winning tier, if any outranks the target. */
function findAncestorOverride(config: IEffectiveConfig, path: string, targetTier: SettingsTier): SettingsTier | undefined {
	const segments = path.split('.');
	for (let i = segments.length - 1; i >= 1; i--) {
		const leaf = config.settings.find(s => s.path === segments.slice(0, i).join('.'));
		if (leaf?.winner !== undefined && TIER_RANK[leaf.winner] < TIER_RANK[targetTier]) { return leaf.winner; }
	}
	return undefined;
}
// CLAWDIUS-END
