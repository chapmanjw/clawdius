/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Clawdius "Check for Updates" - a NOTIFY-AND-LINK update check powered by the GitHub Releases API. There is
// no auto-update server (product.json sets no updateUrl), so this never downloads or installs anything: it
// compares the running version against the latest published release and, when newer, shows a notification that
// links to the release page. Zero-egress contract: the single GitHub request fires ONLY when the user runs the
// Check-for-Updates action, or at startup IF the user opted in via `clawdius.update.checkOnStartup` (default
// false). There is no constructor fetch, no timer, and no other trigger. The pure helpers (pickRelease,
// isNewer) carry no network/DI and are unit-tested in isolation.

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { gt, valid } from '../../../../../base/common/semver/semver.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { asJson, IRequestService } from '../../../../../platform/request/common/request.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';

export const IClawdiusUpdateService = createDecorator<IClawdiusUpdateService>('clawdiusUpdateService');

export interface IClawdiusUpdateService {
	readonly _serviceBrand: undefined;
	/**
	 * Compare the running version against the latest GitHub release on the configured channel and, if a newer
	 * release exists, notify the user with links to it. `trigger` decides the quiet path: a 'user' check reports
	 * "up to date" and surfaces errors; a 'startup' check stays silent on both.
	 */
	checkForUpdates(trigger: 'user' | 'startup'): Promise<void>;
}

/** The subset of a GitHub Releases API object Clawdius reads. */
export interface IGithubRelease {
	tag_name: string;
	html_url: string;
	prerelease: boolean;
	draft: boolean;
}

/** Release channel the user can pick. 'stable' = published, non-prerelease only; 'prerelease' = include both. */
export type ClawdiusUpdateChannel = 'stable' | 'prerelease';

/** GitHub owner/repo Clawdius releases are published under. */
const CLAWDIUS_REPO = 'chapmanjw/clawdius';

/** Fallback release-page link, used only if a chosen release object carries no html_url. */
const CLAWDIUS_RELEASES_PAGE = `https://github.com/${CLAWDIUS_REPO}/releases`;

/** Strip a single leading 'v'/'V' from a git tag so 'v1.2.3' and '1.2.3' compare identically. */
function stripTagPrefix(tag: string): string {
	return tag.replace(/^v/i, '');
}

/**
 * Pick the newest release to offer for a channel. Drafts are always dropped; on the 'stable' channel
 * prereleases are dropped too. Tags that are not valid semver (after stripping a leading 'v') are ignored.
 * Returns the release with the highest semver tag, or undefined if none qualify.
 */
export function pickRelease(releases: readonly IGithubRelease[], channel: ClawdiusUpdateChannel): IGithubRelease | undefined {
	let best: IGithubRelease | undefined;
	let bestVersion: string | undefined;
	for (const release of releases) {
		if (release.draft) {
			continue;
		}
		if (channel === 'stable' && release.prerelease) {
			continue;
		}
		const version = valid(stripTagPrefix(release.tag_name));
		if (!version) {
			continue;
		}
		if (bestVersion === undefined || gt(version, bestVersion)) {
			best = release;
			bestVersion = version;
		}
	}
	return best;
}

/**
 * True when the release tag is a strictly newer semver than the current version. A leading 'v' is stripped from
 * the tag; either side failing to parse as semver yields false (never throws, never offers a bogus update).
 */
export function isNewer(releaseTag: string, currentVersion: string): boolean {
	const release = valid(stripTagPrefix(releaseTag));
	const current = valid(currentVersion);
	if (!release || !current) {
		return false;
	}
	return gt(release, current);
}

export class ClawdiusUpdateService implements IClawdiusUpdateService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IRequestService private readonly requestService: IRequestService,
		@IOpenerService private readonly openerService: IOpenerService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) { }

	async checkForUpdates(trigger: 'user' | 'startup'): Promise<void> {
		const channel: ClawdiusUpdateChannel = this.configurationService.getValue<string>('clawdius.update.channel') === 'prerelease' ? 'prerelease' : 'stable';
		try {
			const release = await this.fetchRelease(channel);
			if (release && isNewer(release.tag_name, this.productService.version)) {
				const url = release.html_url || CLAWDIUS_RELEASES_PAGE;
				const version = stripTagPrefix(release.tag_name);
				this.notificationService.prompt(
					Severity.Info,
					localize('clawdius.update.available', "Clawdius {0} is available.", version),
					// One action: the GitHub release page carries both the notes and the downloadable assets, so two
					// buttons to the same URL would be redundant.
					[{ label: localize('clawdius.update.viewRelease', "View Release"), run: () => { void this.openerService.open(URI.parse(url)); } }],
				);
				return;
			}
			// Up to date (or no qualifying release): a user-initiated check confirms; a startup check stays silent.
			if (trigger === 'user') {
				this.notificationService.info(localize('clawdius.update.upToDate', "Clawdius is up to date."));
			}
		} catch (err) {
			// Never throw out of an update check. A user-initiated check surfaces a brief warning; a startup check
			// (a single opt-in best-effort request) only logs, so an offline launch is silent.
			this.logService.warn('[ClawdiusUpdate] update check failed', err);
			if (trigger === 'user') {
				this.notificationService.warn(localize('clawdius.update.failed', "Could not check for updates. See the log for details."));
			}
		}
	}

	/**
	 * Issue the single GitHub Releases request for the channel and return the release to consider, or undefined.
	 * 'stable' reads the dedicated `releases/latest` endpoint (GitHub already excludes drafts + prereleases there);
	 * 'prerelease' reads the recent list and picks the newest non-draft via {@link pickRelease}.
	 */
	private async fetchRelease(channel: ClawdiusUpdateChannel): Promise<IGithubRelease | undefined> {
		const headers: Record<string, string> = {
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'Clawdius',
			'X-GitHub-Api-Version': '2022-11-28',
		};
		// The timeout caps a stalled network so the await cannot hang; the token is only passed to satisfy the
		// request API (it is never cancelled) and is disposed in finally.
		const source = new CancellationTokenSource();
		try {
			if (channel === 'prerelease') {
				const url = `https://api.github.com/repos/${CLAWDIUS_REPO}/releases?per_page=20`;
				const context = await this.requestService.request({ type: 'GET', url, headers, timeout: 15000, callSite: 'clawdius.update.list' }, source.token);
				const releases = await asJson<IGithubRelease[]>(context);
				return releases ? pickRelease(releases, 'prerelease') : undefined;
			}
			const url = `https://api.github.com/repos/${CLAWDIUS_REPO}/releases/latest`;
			const context = await this.requestService.request({ type: 'GET', url, headers, timeout: 15000, callSite: 'clawdius.update.latest' }, source.token);
			// A repo with only prereleases/drafts has no "latest" release - GitHub returns 404. Treat that as "no
			// qualifying release" (-> up to date) rather than an error, so a Stable-channel check on a prerelease-
			// only repo does not surface a scary failure. Other non-2xx still throws via asJson and is handled above.
			if (context.res.statusCode === 404) {
				return undefined;
			}
			const release = await asJson<IGithubRelease>(context);
			return release ?? undefined;
		} finally {
			source.dispose();
		}
	}
}

/**
 * Startup gate for the update check. This is the ONLY automatic trigger and it fires solely when the user has
 * opted in via `clawdius.update.checkOnStartup` (default false), so out of the box launch performs no request.
 * Registered at the Eventually phase, well after restore, so it never competes with startup.
 */
export class ClawdiusUpdateStartupContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusUpdateStartup';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IClawdiusUpdateService updateService: IClawdiusUpdateService,
	) {
		if (configurationService.getValue('clawdius.update.checkOnStartup') === true) {
			void updateService.checkForUpdates('startup');
		}
	}
}
