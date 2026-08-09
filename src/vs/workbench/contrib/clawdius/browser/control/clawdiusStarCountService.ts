/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN star-count service (#star)
// Reads the Clawdius repo's aggregate GitHub star count for the "Star on GitHub" button's count pill. It issues a
// SINGLE unauthenticated GET https://api.github.com/repos/chapmanjw/clawdius -> stargazers_count - the same call
// class the update service already ships (clawdiusUpdateService.ts). Zero-egress contract: nothing is requested on
// a timer or at startup; the ONE request per session is kicked off by the Control Center rendering its tab strip,
// and it fails SILENTLY (resolves undefined) so the button always renders - offline just drops the pill. Routed
// through IRequestService, which proxies to the main process, so there is no renderer CORS concern (mirrors the
// update service).
//
// "Once per session" is a property of the memo below, not of the call site, and the distinction is load-bearing:
// renderTabs runs on EVERY render of the pane, not once per open. A memo that latched only on SUCCESS therefore
// re-armed the request after every failure and turned an offline machine, or a tripped GitHub rate limit (60/hr
// unauthenticated - which a request per render trips on its own), into an unbounded request loop for the rest of
// the session. The attempt is what is remembered here, so a failure is as final as a success.

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { asJson, IRequestService } from '../../../../../platform/request/common/request.js';

/** GitHub owner/repo Clawdius is published under (same repo the update service reads). */
const CLAWDIUS_REPO = 'chapmanjw/clawdius';

/** Format a star count compactly, GitHub-style: 942 -> "942", 1234 -> "1.2k", 12000 -> "12k", 2_000_000 -> "2m". */
export function formatStarCount(n: number): string {
	if (n < 1000) { return String(n); }
	if (n < 1_000_000) { const k = n / 1000; return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`; }
	const m = n / 1_000_000; return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}m`;
}

/** The subset of the GitHub repo object we read. */
interface IGithubRepo {
	stargazers_count: number;
}

export const IClawdiusStarCountService = createDecorator<IClawdiusStarCountService>('clawdiusStarCountService');

export interface IClawdiusStarCountService {
	readonly _serviceBrand: undefined;
	/** The star count if it has already been fetched this session, else undefined (synchronous, for immediate render). */
	readonly cachedCount: number | undefined;
	/**
	 * Fetch the repo's `stargazers_count` and return it, or `undefined` on any error / offline. Never throws - the
	 * caller renders the button with no pill when this resolves undefined. At most ONE request is made per session
	 * however often this is called: the ATTEMPT is memoized, so a failure resolves `undefined` from then on rather
	 * than re-issuing the request.
	 */
	getStarCount(): Promise<number | undefined>;
}

export class ClawdiusStarCountService implements IClawdiusStarCountService {

	declare readonly _serviceBrand: undefined;

	private _cached: number | undefined;
	/** Whether the one allowed attempt has already completed - EITHER outcome. Separate from `_cached` because a
	 *  failed attempt has no count to remember, and `_cached === undefined` alone cannot tell "never asked" from
	 *  "asked and got nothing"; conflating them is what let a failure re-arm the request on the next render. */
	private _settled = false;
	private _inFlight: Promise<number | undefined> | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) { }

	get cachedCount(): number | undefined {
		return this._cached;
	}

	getStarCount(): Promise<number | undefined> {
		if (this._settled) {
			return Promise.resolve(this._cached);
		}
		if (!this._inFlight) {
			this._inFlight = this._fetch();
		}
		return this._inFlight;
	}

	private async _fetch(): Promise<number | undefined> {
		const headers: Record<string, string> = {
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'Clawdius',
			'X-GitHub-Api-Version': '2022-11-28',
		};
		const source = new CancellationTokenSource();
		try {
			const url = `https://api.github.com/repos/${CLAWDIUS_REPO}`;
			const context = await this.requestService.request(
				{ type: 'GET', url, headers, timeout: 15000, callSite: 'clawdius.star.count' },
				source.token,
			);
			const repo = await asJson<IGithubRepo>(context);
			const count = repo && typeof repo.stargazers_count === 'number' ? repo.stargazers_count : undefined;
			if (count !== undefined) {
				this._cached = count;
			}
			return count;
		} catch (err) {
			// Fail-silent by design: the button renders with no pill. Trace only (never a user-facing error).
			// `asJson` throws on any non-2xx, so a rate-limit response lands here alongside a genuine network error.
			this.logService.trace(`[clawdius-star] star-count fetch failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		} finally {
			// In the `finally`, so the attempt latches on the error path too - that is the whole point (see _settled).
			this._settled = true;
			this._inFlight = undefined;
			source.dispose();
		}
	}
}
// CLAWDIUS-END
