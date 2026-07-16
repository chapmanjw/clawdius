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
// Credential resolution (the macOS login Keychain OR the plaintext file) lives in one node module, hand-mirrored by
// the clawdius-chat extension. See claudeCredentials.ts for why the Keychain is read by spawning /usr/bin/security.
import { hasClaudeCredentials, readClaudeOAuthToken } from './claudeCredentials.js';
// Provider gate + capacity constants come from the shared common module (the single source of truth, also imported
// by the renderer usage data layer), so the node service and the renderer can never drift apart.
import {
	engineIsAnthropic, oauthUsageHeaders, CAPACITY_CACHE_FILE, SETTINGS_FILE,
	USAGE_CAPACITY_TTL_MS, OAUTH_USAGE_URL,
} from '../common/claudeUsageProvider.js';

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
			// The gate logic lives in the shared common module; this service only supplies the parsed settings env.
			if (!engineIsAnthropic(await this.readSettingsEnv(claudeDir))) {
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
				headers: oauthUsageHeaders(token),
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
	 * Read the engine-provider `env` map from `<claudeDir>/settings.json` for the shared {@link engineIsAnthropic}
	 * gate. Returns `{}` when the settings file is absent / unreadable, so the gate defaults to Anthropic.
	 */
	private async readSettingsEnv(claudeDir: string): Promise<{ readonly [key: string]: unknown }> {
		try {
			const settings = JSON.parse(await readFile(join(claudeDir, SETTINGS_FILE), 'utf8'));
			return (settings && settings.env) || {};
		} catch {
			return {};
		}
	}

	/**
	 * The "signed in" probe for the renderer, which cannot spawn /usr/bin/security itself. On-demand only: driven by
	 * the usage surfaces over the capacity IPC channel. Makes NO network call and never logs the token.
	 */
	async hasCredentials(homeDirPath: string): Promise<boolean | undefined> {
		return hasClaudeCredentials(join(homeDirPath, '.claude'));
	}

	/**
	 * The CLI OAuth access token: the macOS login Keychain first (the CLI's primary store), then the plaintext
	 * `<claudeDir>/.credentials.json` (the only store on Windows/Linux). Returned to the caller only; never logged.
	 */
	private async readOAuthToken(claudeDir: string): Promise<string | undefined> {
		return readClaudeOAuthToken(claudeDir);
	}
}
// CLAWDIUS-END
