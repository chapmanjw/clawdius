/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN usage-capacity refresh router (#94)
// Routes the single, user-initiated /api/oauth/usage capacity refresh to the host that owns the user's
// ~/.claude. In a LOCAL window the clawdius-chat extension (whose extension host runs locally) performs the
// fetch via the `clawdius.refreshUsageCapacity` command. In a WSL/SSH REMOTE window ~/.claude lives on the
// remote - and the clawdius-chat extension is a "ui" extension that runs on the LOCAL host - so we instead drive
// the REH server's capacity service over the remote-agent connection, which fetches against the REMOTE ~/.claude.
// On-demand only - no startup fetch, no timer (zero uninitiated egress).
//
// The SAME router answers the "signed in" probe (hasCredentials), because it already knows which host owns
// ~/.claude - and that host is the only place that can read the macOS login Keychain, where the Claude Code CLI
// actually stores its OAuth credentials. The renderer has no child_process, so it cannot answer this itself.
// The probe is pull-only (driven by the status-bar poll / a view load): no timer, and it makes NO network call.

import { raceTimeout } from '../../../../../base/common/async.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ClaudeUsageCapacityChannelName, IClaudeUsageCapacityService } from '../../../../../platform/clawdius/common/claudeUsageCapacity.js';
import { USAGE_CAPACITY_TTL_MS } from '../../../../../platform/clawdius/common/claudeUsageProvider.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { HAS_CREDENTIALS_COMMAND_ID, REFRESH_CAPACITY_COMMAND_ID } from './claudeUsageData.js';

/**
 * Bound the credential probe's hop to its host. Comfortably above the node side's own 3s /usr/bin/security
 * timeout (so a slow-but-succeeding Keychain read is never cut off), and well under the status bar's 15s poll
 * (so probes can't stack). Unlike the user-initiated capacity refresh this runs on an AUTOMATIC path, and
 * executeCommand on a not-yet-registered command waits for the extension host - so it must fail fast.
 */
const PROBE_TIMEOUT_MS = 5_000;

export const IClaudeUsageCapacityRefresh = createDecorator<IClaudeUsageCapacityRefresh>('claudeUsageCapacityRefresh');

export interface IClaudeUsageCapacityRefresh {
	readonly _serviceBrand: undefined;
	/** Refresh the cached subscription limits on whichever host owns ~/.claude. `force` bypasses the 60s TTL. */
	refresh(force: boolean): Promise<void>;
	/**
	 * Whether the host that owns ~/.claude has usable Claude Code CLI credentials (the "signed in" gate). Memoised
	 * for the capacity TTL; an INDETERMINATE answer (locked keychain, ext host not up yet, older REH) keeps the last
	 * known value and is never memoised, so a signed-in user is never flipped to "Signed out" by a transient miss.
	 * `undefined` = still indeterminate with NO last known value: the caller must render an UNKNOWN state, never
	 * "Signed out" - claiming signed-out on a locked keychain is the exact lie this whole change exists to kill.
	 */
	hasCredentials(): Promise<boolean | undefined>;
}

export class ClaudeUsageCapacityRefresh implements IClaudeUsageCapacityRefresh {

	declare readonly _serviceBrand: undefined;

	/** The memoised probe answer, stamped when it LANDED. Only ever holds a definitive true/false. */
	private credentials: { readonly at: number; readonly value: boolean } | undefined;
	/** Bumped by refresh(force): makes a probe started before the refresh a no-op when its late answer lands. */
	private generation = 0;
	/** The in-flight probe, shared so the status bar and the dashboard can't spawn `security` twice on a cold memo. */
	private inFlight: Promise<boolean | undefined> | undefined;

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ICommandService private readonly commandService: ICommandService,
		@IPathService private readonly pathService: IPathService,
	) { }

	async refresh(force: boolean): Promise<void> {
		if (force) {
			// The user may have just run `claude login`. Drop the memo AND abandon any in-flight probe: its answer
			// predates the login, so the next caller must start a fresh one. The generation bump makes the abandoned
			// probe's late answer a no-op when it lands, so it can't clobber the fresher result.
			this.credentials = undefined;
			this.inFlight = undefined;
			this.generation++;
		}
		if (this.environmentService.remoteAuthority) {
			// Remote (WSL/SSH) window: ~/.claude lives on the remote, so drive the REH server's capacity service
			// over the remote-agent connection. The local "ui" extension host can't reach the remote home directory.
			const connection = this.remoteAgentService.getConnection();
			if (connection) {
				const proxy = ProxyChannel.toService<IClaudeUsageCapacityService>(connection.getChannel(ClaudeUsageCapacityChannelName));
				const home = (await this.pathService.userHome()).path;
				// Bound the remote round trip. getChannel returns a DELAYED channel that queues until the remote-agent
				// connection is up, and the service-side fetch is network I/O - so a wedged channel or a stalled network
				// could otherwise leave the awaiting UI (open dashboard / Refresh) hanging. Best-effort - on timeout the
				// dashboard renders the last cached limits. raceTimeout (NOT Promise.race with a bare timeout): the
				// latter leaves the loser's timer to fire, which trips the unit-test leak tracker.
				await raceTimeout(proxy.refreshCapacity(home, force), 30_000);
				return;
			}
		}
		// Local window: the clawdius-chat extension (local extension host) fetches against the local ~/.claude.
		// `force` is forwarded so the explicit Refresh button bypasses the freshness TTL.
		await this.commandService.executeCommand(REFRESH_CAPACITY_COMMAND_ID, force);
	}

	async hasCredentials(): Promise<boolean | undefined> {
		// Memoise for the TTL: the status bar polls every 15s and on macOS the renderer's file fast path ALWAYS
		// misses, so without this we would spawn /usr/bin/security four times a minute, forever. With it: ~1/min.
		if (this.credentials && Date.now() - this.credentials.at < USAGE_CAPACITY_TTL_MS) {
			return this.credentials.value;
		}
		const generation = this.generation;
		const probed = await (this.inFlight ?? this.startProbe());

		if (probed === undefined) {
			// Indeterminate: locked keychain, ext host not up yet, or an older REH without this channel command. Keep
			// the last known answer and re-probe on the next poll - do NOT cache a "no" we are unsure of. Caching a
			// startup-race `false` here would pin "Signed out" for the whole TTL at every launch.
			//
			// With NO last known value we propagate `undefined`, we do NOT fall back to `false`: a locked login
			// keychain (exit 36, e.g. headless / SSH / launchd) would otherwise render a perfectly signed-in user as
			// "Signed out" - reintroducing the very bug this change exists to fix, on the platform it targets.
			return this.credentials?.value;
		}
		if (generation === this.generation) {
			// Stamp when the answer LANDED, not when we started asking, and only if no refresh(force) intervened.
			// Otherwise a slow pre-login "signed out" probe could land after the fresh post-login "signed in" one and
			// pin "Signed out" for 60s.
			this.credentials = { at: Date.now(), value: probed };
		}
		return probed;
	}

	/** The identity check matters: a probe abandoned by refresh(force) must not clear its successor's slot. */
	private startProbe(): Promise<boolean | undefined> {
		const probe = this.probeCredentials().finally(() => {
			if (this.inFlight === probe) {
				this.inFlight = undefined;
			}
		});
		this.inFlight = probe;
		return probe;
	}

	/** Ask the host that owns ~/.claude. `undefined` = INDETERMINATE (never "signed out"). Makes no network call. */
	private async probeCredentials(): Promise<boolean | undefined> {
		try {
			if (this.environmentService.remoteAuthority) {
				const connection = this.remoteAgentService.getConnection();
				if (!connection) {
					return undefined;
				}
				const proxy = ProxyChannel.toService<IClaudeUsageCapacityService>(connection.getChannel(ClaudeUsageCapacityChannelName));
				const home = (await this.pathService.userHome()).path;
				const result = await raceTimeout(proxy.hasCredentials(home), PROBE_TIMEOUT_MS);
				return typeof result === 'boolean' ? result : undefined;
			}
			// Bound the LOCAL hop too - see PROBE_TIMEOUT_MS.
			const local = await raceTimeout(this.commandService.executeCommand<boolean | undefined>(HAS_CREDENTIALS_COMMAND_ID), PROBE_TIMEOUT_MS);
			return typeof local === 'boolean' ? local : undefined;
		} catch {
			// Ext host not activated yet, or the channel command is missing on an older REH ("Unknown channel command"):
			// INDETERMINATE, never "signed out" - a remote window just degrades to the previous behaviour.
			return undefined;
		}
	}
}
// CLAWDIUS-END
