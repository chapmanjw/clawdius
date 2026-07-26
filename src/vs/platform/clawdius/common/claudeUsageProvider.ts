/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN shared usage-provider gate + capacity constants (common layer)
// The single source of truth for the engine-provider gate (Anthropic vs Bedrock/Vertex/custom base URL) and the
// capacity-fetch constants, shared by the two src/vs consumers that used to triplicate them: the REH-side node
// capacity service (src/vs/platform/clawdius/node/claudeUsageCapacityService.ts) and the renderer usage data layer
// (src/vs/workbench/contrib/clawdius/browser/usage/claudeUsageData.ts). The clawdius-chat extension keeps its OWN
// hand-mirror (extensions can't import src/vs); branding-guard.ts asserts that copy doesn't drift from this spec.
// Common layer: pure, no node/browser imports, so both the node service and the browser data layer can import it.

/** The engine provider Claude Code is pointed at, inferred from the user's settings.json `env`. */
export const enum ClaudeProvider {
	Anthropic = 'anthropic',
	Bedrock = 'bedrock',
	Vertex = 'vertex',
	Custom = 'custom',
}

/**
 * True only when a base URL's parsed host is exactly api.anthropic.com over http(s). Parsing with URL rather
 * than a substring/regex match prevents lookalike or userinfo-trick hosts - api.anthropic.com.evil,
 * api.anthropic.com@evil, evil?@api.anthropic.com - from being treated as Anthropic. Unparseable -> false.
 */
function isAnthropicApiHost(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.toLowerCase() === 'api.anthropic.com';
	} catch {
		return false;
	}
}

/**
 * Infer the engine provider from a Claude Code settings `env` map. Pure (the file read lives in each caller);
 * extracted so the provider precedence is unit-testable without a file service. Precedence: Bedrock, then Vertex,
 * then a non-Anthropic ANTHROPIC_BASE_URL (custom), else Anthropic.
 */
export function providerFromEnv(env: { readonly [key: string]: unknown }): ClaudeProvider {
	const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
	if (truthy(env['CLAUDE_CODE_USE_BEDROCK'])) { return ClaudeProvider.Bedrock; }
	if (truthy(env['CLAUDE_CODE_USE_VERTEX'])) { return ClaudeProvider.Vertex; }
	const baseUrl = env['ANTHROPIC_BASE_URL'];
	if (typeof baseUrl === 'string' && baseUrl.length > 0 && !isAnthropicApiHost(baseUrl)) {
		return ClaudeProvider.Custom;
	}
	return ClaudeProvider.Anthropic;
}

/**
 * Whether the resolved engine provider is Anthropic's own API. Only Anthropic exposes /api/oauth/usage, so this is
 * the gate that keeps the capacity fetch from ever reaching api.anthropic.com when the user's engine is elsewhere.
 * Defaults to Anthropic (via {@link providerFromEnv}) when the settings env is empty / unreadable.
 */
export function engineIsAnthropic(env: { readonly [key: string]: unknown }): boolean {
	return providerFromEnv(env) === ClaudeProvider.Anthropic;
}

/** The cached /api/oauth/usage response (subscription rate-limit windows), written under ~/.claude. */
export const CAPACITY_CACHE_FILE = '.clawdius-usage-cache.json';
/**
 * The CLI OAuth credentials file under ~/.claude. Its existence is SUFFICIENT but NOT NECESSARY for "signed in":
 * the CLI's store is keychain-with-plaintext-fallback, so on macOS the credentials normally live in the login
 * Keychain and this file is written only when that write FAILS. On Windows/Linux there is no secret store, so the
 * file is the only place they land. Treating absence as "signed out" is the exact bug that reported every
 * signed-in mac user as signed out - see platform/clawdius/node/claudeCredentials.ts. The token is never logged.
 */
export const CREDENTIALS_FILE = '.credentials.json';
/** The Claude Code settings file under ~/.claude (carries the engine-provider `env`). */
export const SETTINGS_FILE = 'settings.json';

/** Minimum age of the cached limits before an automatic (non-forced) refresh re-hits the network. */
export const USAGE_CAPACITY_TTL_MS = 60_000;

/** Anthropic's own subscription-usage endpoint (the only provider that exposes it). */
export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** The required anthropic-beta opt-in for the OAuth usage endpoint. */
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/**
 * The headers for the GET /api/oauth/usage call: the user's CLI OAuth bearer token, the anthropic-beta opt-in, and
 * JSON content type. The Authorization value carries the token, so this is built per call (never a static const)
 * and the token is NEVER logged.
 */
export function oauthUsageHeaders(token: string): Record<string, string> {
	return { 'Authorization': `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA_HEADER, 'Content-Type': 'application/json' };
}
// CLAWDIUS-END
