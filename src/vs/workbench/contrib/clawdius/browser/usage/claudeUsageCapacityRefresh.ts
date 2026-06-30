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

import { timeout } from '../../../../../base/common/async.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ClaudeUsageCapacityChannelName, IClaudeUsageCapacityService } from '../../../../../platform/clawdius/common/claudeUsageCapacity.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { REFRESH_CAPACITY_COMMAND_ID } from './claudeUsageData.js';

export const IClaudeUsageCapacityRefresh = createDecorator<IClaudeUsageCapacityRefresh>('claudeUsageCapacityRefresh');

export interface IClaudeUsageCapacityRefresh {
	readonly _serviceBrand: undefined;
	/** Refresh the cached subscription limits on whichever host owns ~/.claude. `force` bypasses the 60s TTL. */
	refresh(force: boolean): Promise<void>;
}

export class ClaudeUsageCapacityRefresh implements IClaudeUsageCapacityRefresh {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ICommandService private readonly commandService: ICommandService,
		@IPathService private readonly pathService: IPathService,
	) { }

	async refresh(force: boolean): Promise<void> {
		if (this.environmentService.remoteAuthority) {
			// Remote (WSL/SSH) window: ~/.claude lives on the remote, so drive the REH server's capacity service
			// over the remote-agent connection. The local "ui" extension host can't reach the remote home directory.
			const connection = this.remoteAgentService.getConnection();
			if (connection) {
				const proxy = ProxyChannel.toService<IClaudeUsageCapacityService>(connection.getChannel(ClaudeUsageCapacityChannelName));
				const home = (await this.pathService.userHome()).path;
				// Bound the remote round trip. getChannel returns a DELAYED channel that queues until the remote-agent
				// connection is up, and the service-side fetch is network I/O - so a wedged channel or a stalled network
				// could otherwise leave the awaiting UI (open dashboard / Refresh) hanging. Race against a timeout like
				// the stats path; best-effort - on timeout the dashboard renders the last cached limits.
				await Promise.race([proxy.refreshCapacity(home, force), timeout(30_000)]);
				return;
			}
		}
		// Local window: the clawdius-chat extension (local extension host) fetches against the local ~/.claude.
		// `force` is forwarded so the explicit Refresh button bypasses the freshness TTL.
		await this.commandService.executeCommand(REFRESH_CAPACITY_COMMAND_ID, force);
	}
}
// CLAWDIUS-END
