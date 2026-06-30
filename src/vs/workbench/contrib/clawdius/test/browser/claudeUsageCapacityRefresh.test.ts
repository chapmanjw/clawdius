/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN usage-capacity refresh ROUTING unit tests
// Covers the local-vs-remote routing of ClaudeUsageCapacityRefresh.refresh(force): a remote window drives the REH
// server's capacity service over the remote-agent IPC channel (and never the local command), while a local window
// runs the clawdius.refreshUsageCapacity command (and never touches the channel). The class is constructed with
// hand stubs so the routing is exercised without the DI container or a real remote connection.

import assert from 'assert';
import * as sinon from 'sinon';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ClaudeUsageCapacityChannelName } from '../../../../../platform/clawdius/common/claudeUsageCapacity.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ClaudeUsageCapacityRefresh } from '../../browser/usage/claudeUsageCapacityRefresh.js';
import { REFRESH_CAPACITY_COMMAND_ID } from '../../browser/usage/claudeUsageData.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';

interface IRecordedCall {
	readonly command: string;
	readonly arg: unknown;
}

/** A fake IChannel that records every call(command, arg) ProxyChannel routes through it (no real IPC). */
class RecordingChannel implements IChannel {
	readonly calls: IRecordedCall[] = [];
	call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		return Promise.resolve(undefined as T);
	}
	listen<T>(): Event<T> {
		return Event.None;
	}
}

/** Build a ClaudeUsageCapacityRefresh over hand stubs; returns the recorders the tests assert on. */
function makeRefresh(remoteAuthority: string | undefined) {
	const channel = new RecordingChannel();
	const executeCalls: unknown[][] = [];
	const channelNames: string[] = [];
	let getConnectionCalls = 0;

	const environmentService = { remoteAuthority } as unknown as IWorkbenchEnvironmentService;

	const connection = {
		getChannel: <T extends IChannel>(name: string): T => { channelNames.push(name); return channel as unknown as T; },
	};
	const remoteAgentService = {
		getConnection: () => { getConnectionCalls++; return connection; },
	} as unknown as IRemoteAgentService;

	const commandService = {
		executeCommand: (...args: unknown[]) => { executeCalls.push(args); return Promise.resolve(undefined); },
	} as unknown as ICommandService;

	// userHome resolves to a remote POSIX home (the value the refresh forwards as the channel's first arg).
	const remoteHome = URI.from({ scheme: Schemas.vscodeRemote, authority: 'wsl+ubuntu', path: '/home/jdoe' });
	const pathService = { userHome: () => Promise.resolve(remoteHome) } as unknown as IPathService;

	const refresh = new ClaudeUsageCapacityRefresh(environmentService, remoteAgentService, commandService, pathService);
	return {
		refresh,
		channel,
		executeCalls,
		channelNames,
		get getConnectionCalls() { return getConnectionCalls; },
	};
}

suite('claudeUsageCapacityRefresh', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('remote window: routes to the capacity channel (refreshCapacity [home, force]), not the local command', async () => {
		const h = makeRefresh('wsl+ubuntu');
		// refresh() races the remote call against timeout(30_000); the fast fake channel wins the race, so the timer
		// is orphaned (never cancelled). Fake timers let us fire that orphaned timeout so its cancellation listeners
		// dispose synchronously here - otherwise the strict leak tracker flags them at teardown.
		const clock = sinon.useFakeTimers();
		try {
			await h.refresh.refresh(true);
			await clock.runAllAsync();
		} finally {
			clock.restore();
		}

		// ProxyChannel.toService turns proxy.refreshCapacity(home, force) into channel.call('refreshCapacity', [home, force]).
		assert.deepStrictEqual(h.channel.calls, [{ command: 'refreshCapacity', arg: ['/home/jdoe', true] }]);
		assert.deepStrictEqual(h.channelNames, [ClaudeUsageCapacityChannelName]);
		// The local command path must NOT run for a remote window.
		assert.deepStrictEqual(h.executeCalls, []);
	});

	test('local window: runs the refresh command (id, force) and never touches the remote channel', async () => {
		const h = makeRefresh(undefined);
		await h.refresh.refresh(false);

		assert.deepStrictEqual(h.executeCalls, [[REFRESH_CAPACITY_COMMAND_ID, false]]);
		// No remote authority -> the connection / channel is never consulted.
		assert.deepStrictEqual([h.channel.calls.length, h.channelNames.length, h.getConnectionCalls], [0, 0, 0]);
	});
});
// CLAWDIUS-END
