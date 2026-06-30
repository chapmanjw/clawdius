/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN subscription-capacity refresh service (node, #94)
// Fetches the user's Claude rate-limit "capacity" (the /usage windows) and caches it to disk for the usage
// dashboard, running ON the host that owns ~/.claude. This copy serves WSL/SSH REMOTE windows: it runs in the
// REH server process and reads/writes the REMOTE ~/.claude (every path derives from the homeDirPath param, never
// os.homedir()). It is a DELIBERATE MIRROR of fetchUsageCapacity() in extensions/clawdius-chat/src/extension.ts,
// which serves LOCAL windows (its extension host runs on the local machine); extensions cannot import src/vs, so
// the two implementations must be kept in sync by hand. Both are ON DEMAND ONLY - NO constructor/startup fetch
// and NO background timer - so a Clawdius install makes zero uninitiated network egress (the zero-egress
// guarantee); the bars populate only when the user looks at them. The OAuth token is NEVER logged.

import { readFile, stat, writeFile } from 'fs/promises';
import { join } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { IClaudeUsageCapacityService } from '../common/claudeUsageCapacity.js';

// Same filenames as the claudeUsageData.ts constants (that file is browser-layer and can't be imported here).
const CAPACITY_CACHE_FILE = '.clawdius-usage-cache.json';
const CREDENTIALS_FILE = '.credentials.json';
const SETTINGS_FILE = 'settings.json';

/** Minimum age of the cached limits before an automatic (non-forced) refresh re-hits the network. */
const USAGE_CAPACITY_TTL_MS = 60_000;

/** Anthropic's own subscription-usage endpoint (the only provider that exposes it). */
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export class ClaudeUsageCapacityService implements IClaudeUsageCapacityService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	async refreshCapacity(homeDirPath: string, force: boolean): Promise<void> {
		try {
			const claudeDir = join(homeDirPath, '.claude');
			// Provider gate: only Anthropic's own API exposes /api/oauth/usage. If the engine is pointed at Bedrock /
			// Vertex / a custom base URL, do NOT reach api.anthropic.com - the subscription limits don't apply there.
			if (!(await this.engineIsAnthropic(claudeDir))) {
				return;
			}
			const cachePath = join(claudeDir, CAPACITY_CACHE_FILE);
			// Freshness guard: an automatic refresh (opening a usage surface / hovering the status bar) reuses a cache
			// younger than the TTL instead of re-hitting the network on every glance. The explicit Refresh button
			// passes force=true to bypass this and always pull the latest subscription limits.
			if (!force) {
				try {
					const ageMs = Date.now() - (await stat(cachePath)).mtimeMs;
					if (ageMs >= 0 && ageMs < USAGE_CAPACITY_TTL_MS) {
						return;
					}
				} catch {
					// no cache yet - fetch
				}
			}
			const token = await this.readOAuthToken(claudeDir);
			if (!token) {
				return;
			}
			const res = await fetch(OAUTH_USAGE_URL, {
				headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
				// Bound the outbound call so a stalled api.anthropic.com connection can't hang the awaiting UI.
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) {
				// Status code ONLY - never the body or the token. A 401 (expired token) / 429 leaves the cache as-is.
				this.logService.warn(`[Clawdius] usage capacity fetch returned ${res.status}`);
				return;
			}
			await writeFile(cachePath, await res.text());
		} catch (err) {
			// offline / expired token / unreadable cache dir - leave any existing cache in place. The OAuth token is
			// never part of these errors, so this never leaks it; do NOT log the token under any circumstance.
			this.logService.warn('[Clawdius] usage capacity refresh failed', err);
		}
	}

	/**
	 * Whether `<claudeDir>/settings.json` points the engine at Anthropic's own API (vs Bedrock / Vertex / a custom
	 * base URL). Mirrors detectProvider()/engineIsAnthropic() in the local copies. Defaults to Anthropic when the
	 * settings file is absent / unreadable.
	 */
	private async engineIsAnthropic(claudeDir: string): Promise<boolean> {
		try {
			const settings = JSON.parse(await readFile(join(claudeDir, SETTINGS_FILE), 'utf8'));
			const env = (settings && settings.env) || {};
			const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
			if (truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX)) {
				return false;
			}
			const baseUrl = env.ANTHROPIC_BASE_URL;
			if (typeof baseUrl === 'string' && baseUrl.length > 0 && !/api\.anthropic\.com/i.test(baseUrl)) {
				return false;
			}
			return true;
		} catch {
			return true;
		}
	}

	/** Read the CLI OAuth access token from `<claudeDir>/.credentials.json`. Returned to the caller only; never logged. */
	private async readOAuthToken(claudeDir: string): Promise<string | undefined> {
		try {
			const creds = JSON.parse(await readFile(join(claudeDir, CREDENTIALS_FILE), 'utf8'));
			const token = creds?.claudeAiOauth?.accessToken;
			return typeof token === 'string' && token.length > 0 ? token : undefined;
		} catch {
			return undefined;
		}
	}
}
// CLAWDIUS-END
