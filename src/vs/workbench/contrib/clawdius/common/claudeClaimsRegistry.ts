/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claims-to-receipts registry
// A small Clawdius-owned index that makes "every marketed product claim has a receipt" checkable rather
// than open-ended. Each entry pairs a user-visible product claim with the receipt that proves it - a test,
// a guard run, a driven scenario, or a probe receipt - the surface it backs, and whether it is KNOWN (a
// passing receipt exists today) or ESTIMATED (its receipt is a probe not yet shipped). This is NOT a shadow
// store of Claude state and NOT a marketing document; it indexes the receipts so a surface's claims can be
// read from one place.

/** Whether a claim's receipt is proven today (`known`) or still rests on a probe not yet shipped (`estimated`). */
export type ClaimStatus = 'known' | 'estimated';

/** One marketed product claim and the receipt that proves it. */
export interface IClaimReceipt {
	/** The claim as a user sees it, verbatim. */
	readonly claim: string;
	/** The receipt that proves the claim: a test, a guard run, a driven scenario, or a probe receipt. */
	readonly receipt: string;
	/** The surface (feature or area) the claim backs. */
	readonly surface: string;
	/** `known` when a passing receipt backs the claim today; `estimated` when its receipt is not yet shipped. */
	readonly status: ClaimStatus;
}

/**
 * The registry is the single index a claim-coverage check reads. `hasReceipt` is that check; the
 * cross-surface gate that runs it for each done surface lands with those surfaces. A claim absent from this
 * list has no receipt. A claim whose receipt is not yet shipped stays `estimated` until it lands, at which
 * point it is promoted to `known`.
 */
export const CLAIM_RECEIPTS: readonly IClaimReceipt[] = [
	{
		claim: 'Clawdius sends no telemetry.',
		receipt: 'product.json sets enableTelemetry to false and ships no instrumentation key; the branding guard and the forbidden-content scan assert no telemetry or instrumentation keys.',
		surface: 'privacy',
		status: 'known'
	},
	{
		claim: 'Extensions come only from Open VSX; the Microsoft Marketplace is not used.',
		receipt: 'build/hygiene.ts requires the product.json extensionsGallery to point at open-vsx.org, and the branding guard re-verifies it.',
		surface: 'extensions',
		status: 'known'
	},
	{
		claim: 'Clawdius registers no IDE account provider, so there is no account to sign in to.',
		receipt: 'defaultAccount.ts does not register the default-account provider when the entitlement URL is empty, and the branding guard pins those entitlement URLs empty.',
		surface: 'account',
		status: 'known'
	},
	{
		claim: 'The GitHub Copilot chat extension is removed.',
		receipt: 'The Copilot chat extension directory is deleted; the branding guard fails if it reappears, and the forbidden-content scan fails on any Copilot brand string in a Clawdius-owned file.',
		surface: 'chat',
		status: 'known'
	},
	{
		claim: 'The default color theme is Clawdius Dark.',
		receipt: 'The branding guard asserts the default-color-theme constant is Clawdius Dark.',
		surface: 'theme',
		status: 'known'
	},
	{
		claim: 'The effective-config precedence order is verified against a real server-delivered payload.',
		receipt: 'The base precedence tiers and the server-managed tier interaction are verified by unit tests (clawdiusEffectiveConfig.test.ts); verifying the order against a real server-delivered payload rather than synthetic tier bodies is not yet done, so this stays estimated until that receipt lands.',
		surface: 'control-center-config',
		status: 'estimated'
	},
	{
		claim: 'Every outbound call is one you configured, triggered, or opted into, except the disclosed automatic plugin setup.',
		receipt: 'PRIVACY.md enumerates the neutralized paths and the exhaustive outbound list, including the one automatic plugin setup; the boot-time guard that would automatically assert zero uninitiated egress is not yet shipped, so this stays estimated until that guard lands.',
		surface: 'privacy',
		status: 'estimated'
	},
	{
		claim: 'A branch-with-pull-request session turn makes no api.github.com request.',
		receipt: 'The pull-request-lookup surface is dropped in agentService.ts, and the Claude agent advertises no protected resources (getProtectedResources() returns empty in claudeAgent.ts); a falsifiable zero-egress-per-turn assertion is not yet shipped, so this stays estimated until that receipt lands.',
		surface: 'agent-host',
		status: 'estimated'
	}
];

/** Return the registry entry for a claim, or `undefined` if the claim is not registered. */
export function findClaimReceipt(claim: string): IClaimReceipt | undefined {
	return CLAIM_RECEIPTS.find(entry => entry.claim === claim);
}

/** True when the claim is registered with a receipt. A marketed claim that is absent has no receipt. */
export function hasReceipt(claim: string): boolean {
	return findClaimReceipt(claim) !== undefined;
}

// CLAWDIUS-END
