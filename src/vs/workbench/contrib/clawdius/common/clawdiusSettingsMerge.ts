/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Settings-body merge helpers
// Pure helpers used when assembling the effective-config tier inputs: a deep merge for the managed drop-in
// directory (systemd convention - base first, then *.json alphabetically), a policyHelper detector, and a
// tolerant JSON-string parser for the registry-delivered policy bodies. The array de-dupe rule is shared with
// the resolver's array-union so a drop-in fold and the cross-tier union agree.

import { JsonObject, JsonValue, dedupeKey } from './clawdiusEffectiveConfig.js';

function isObject(v: JsonValue | undefined): v is JsonObject {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArray(v: JsonValue | undefined): v is ReadonlyArray<JsonValue> {
	return Array.isArray(v);
}

/**
 * Deep-merge `higher` onto `lower`, returning a new body: scalars take `higher`, arrays concat + de-dupe (lower
 * first, then higher), objects recurse. This is the WITHIN-source merge used to fold the managed-settings.d
 * drop-ins onto managed-settings.json - NOT the cross-tier precedence merge (that is the resolver's job).
 */
export function mergeSettingsBodies(lower: JsonObject, higher: JsonObject): JsonObject {
	const out: { [key: string]: JsonValue | undefined } = { ...lower };
	for (const key of Object.keys(higher)) {
		const h = higher[key];
		const l = lower[key];
		if (isObject(h) && isObject(l)) {
			out[key] = mergeSettingsBodies(l, h);
		} else if (isArray(h) && isArray(l)) {
			const merged: JsonValue[] = [];
			const seen = new Set<string>();
			for (const entry of [...l, ...h]) {
				const k = dedupeKey(entry);
				if (!seen.has(k)) { seen.add(k); merged.push(entry); }
			}
			out[key] = merged;
		} else if (h !== undefined) {
			out[key] = h;
		}
	}
	return out;
}

/** Fold an ordered list of bodies (base first, drop-ins in read order) into one, later bodies overriding earlier. */
export function mergeSettingsChain(bodies: ReadonlyArray<JsonObject>): JsonObject {
	return bodies.reduce<JsonObject>((acc, b) => mergeSettingsBodies(acc, b), {});
}

/** True when any admin-managed body declares a non-empty `policyHelper.path` - the signal that a managed policy
 *  program owns the whole managed band (Clawdius never executes it; the tier is surfaced as opaque). */
export function detectPolicyHelper(adminBodies: ReadonlyArray<JsonObject | undefined>): boolean {
	for (const body of adminBodies) {
		if (!isObject(body)) { continue; }
		const helper = body['policyHelper'];
		if (isObject(helper) && typeof helper['path'] === 'string' && helper['path'].length > 0) { return true; }
	}
	return false;
}

/** Parse a registry-delivered policy JSON string into a body. Returns undefined on empty/invalid input (the
 *  caller decides whether an unreadable-but-present source becomes an opaque tier). */
export function parsePolicySettings(raw: string | undefined): JsonObject | undefined {
	if (!raw || raw.trim().length === 0) { return undefined; }
	try {
		const parsed = JSON.parse(raw);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
// CLAWDIUS-END
