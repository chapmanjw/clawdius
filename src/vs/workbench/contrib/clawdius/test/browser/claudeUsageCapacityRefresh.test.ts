/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN usage-capacity refresh ROUTING unit tests
// Covers the local-vs-remote routing of ClaudeUsageCapacityRefresh.refresh(force): a remote window drives the REH
// server's capacity service over the remote-agent IPC channel (and never the local command), while a local window
// runs the clawdius.refreshUsageCapacity command (and never touches the channel). The class is constructed with
// hand stubs so the routing is exercised without the DI container or a real remote connection.
//
// The SAME router answers the "signed in" probe (hasCredentials), so the second suite below covers its caching
// contract - the part that is subtle enough to have been a real bug at every step: memoise for the TTL (the status
// bar polls every 15s and on macOS the renderer's file fast path ALWAYS misses), invalidate on refresh(force) (the
// user may have just run `claude login`), never memoise an INDETERMINATE answer and never let it downgrade a known
// "signed in" to "Signed out", share the in-flight probe, and never let a probe that started BEFORE a refresh(force)
// clobber the fresher answer that landed after it.

import assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ClaudeUsageCapacityChannelName } from '../../../../../platform/clawdius/common/claudeUsageCapacity.js';
import { USAGE_CAPACITY_TTL_MS } from '../../../../../platform/clawdius/common/claudeUsageProvider.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ClaudeUsageCapacityRefresh } from '../../browser/usage/claudeUsageCapacityRefresh.js';
import { HAS_CREDENTIALS_COMMAND_ID, REFRESH_CAPACITY_COMMAND_ID } from '../../browser/usage/claudeUsageData.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';

interface IRecordedCall {
	readonly command: string;
	readonly arg: unknown;
}

/** How the fake host answers the credential probe. `undefined` and a rejection both model an INDETERMINATE answer. */
type ProbeResponder = () => Promise<boolean | undefined>;

/** Build a ClaudeUsageCapacityRefresh over hand stubs; returns the recorders the tests assert on. */
function makeRefresh(remoteAuthority: string | undefined) {
	const channelCalls: IRecordedCall[] = [];
	const executeCalls: unknown[][] = [];
	const channelNames: string[] = [];
	let getConnectionCalls = 0;
	let probeCalls = 0;
	let responder: ProbeResponder = async () => true;

	/** Routes hasCredentials to the responder; every other call records and resolves undefined (no real IPC). */
	const channel: IChannel = {
		call: <T>(command: string, arg?: unknown): Promise<T> => {
			channelCalls.push({ command, arg });
			if (command === 'hasCredentials') {
				probeCalls++;
				return responder() as Promise<T>;
			}
			return Promise.resolve(undefined as T);
		},
		listen: <T>(): Event<T> => Event.None,
	};

	const environmentService = { remoteAuthority } as unknown as IWorkbenchEnvironmentService;

	const connection = {
		getChannel: <T extends IChannel>(name: string): T => { channelNames.push(name); return channel as unknown as T; },
	};
	const remoteAgentService = {
		getConnection: () => { getConnectionCalls++; return connection; },
	} as unknown as IRemoteAgentService;

	const commandService = {
		executeCommand: (...args: unknown[]) => {
			executeCalls.push(args);
			if (args[0] === HAS_CREDENTIALS_COMMAND_ID) {
				probeCalls++;
				return responder();
			}
			return Promise.resolve(undefined);
		},
	} as unknown as ICommandService;

	// userHome resolves to a remote POSIX home (the value the refresh forwards as the channel's first arg).
	const remoteHome = URI.from({ scheme: Schemas.vscodeRemote, authority: 'wsl+ubuntu', path: '/home/jdoe' });
	const pathService = { userHome: () => Promise.resolve(remoteHome) } as unknown as IPathService;

	const refresh = new ClaudeUsageCapacityRefresh(environmentService, remoteAgentService, commandService, pathService);
	return {
		refresh,
		channel: { calls: channelCalls },
		executeCalls,
		channelNames,
		/** Swap how the fake host answers the probe (models a login, a locked keychain, or a missing ext host). */
		setProbe(next: ProbeResponder) { responder = next; },
		get probeCalls() { return probeCalls; },
		get getConnectionCalls() { return getConnectionCalls; },
	};
}

suite('claudeUsageCapacityRefresh', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('remote window: routes to the capacity channel (refreshCapacity [home, force]), not the local command', async () => {
		const h = makeRefresh('wsl+ubuntu');
		// No fake-timer dance needed: refresh() bounds the round trip with raceTimeout, which CLEARS its timer when
		// the call wins. (With the old Promise.race([call, timeout(30_000)]) the loser's timer was orphaned and the
		// strict leak tracker flagged it at teardown unless the test fired it by hand.)
		await h.refresh.refresh(true);

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

suite('claudeUsageCapacityRefresh (hasCredentials probe)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('remote window: probes over the capacity channel (hasCredentials [home]), not the local command', async () => {
		const h = makeRefresh('wsl+ubuntu');

		assert.strictEqual(await h.refresh.hasCredentials(), true);
		assert.deepStrictEqual(h.channel.calls, [{ command: 'hasCredentials', arg: ['/home/jdoe'] }]);
		assert.deepStrictEqual(h.executeCalls, []);
	});

	test('local window: probes via the ext-host command and never touches the remote channel', async () => {
		const h = makeRefresh(undefined);

		assert.strictEqual(await h.refresh.hasCredentials(), true);
		assert.deepStrictEqual(h.executeCalls, [[HAS_CREDENTIALS_COMMAND_ID]]);
		assert.deepStrictEqual([h.channel.calls.length, h.getConnectionCalls], [0, 0]);
	});

	test('memoised for the TTL, then re-probed (else the 15s poll spawns security four times a minute)', async () => {
		const h = makeRefresh(undefined);
		const clock = sinon.useFakeTimers();
		try {
			await h.refresh.hasCredentials();
			await h.refresh.hasCredentials();
			const cachedCalls = h.probeCalls;

			clock.tick(USAGE_CAPACITY_TTL_MS + 1);
			await h.refresh.hasCredentials();

			assert.deepStrictEqual([cachedCalls, h.probeCalls], [1, 2]);
		} finally {
			clock.restore();
		}
	});

	test('refresh(force) invalidates the memo (the user may have just run `claude login`)', async () => {
		const h = makeRefresh(undefined);
		const clock = sinon.useFakeTimers();
		try {
			h.setProbe(async () => false);
			assert.strictEqual(await h.refresh.hasCredentials(), false);

			h.setProbe(async () => true);
			await h.refresh.refresh(true);

			// Without the invalidation this would still be the memoised `false` for the rest of the TTL.
			assert.deepStrictEqual([await h.refresh.hasCredentials(), h.probeCalls], [true, 2]);
		} finally {
			clock.restore();
		}
	});

	test('an INDETERMINATE probe keeps the last known value (a locked keychain must not say "Signed out")', async () => {
		const h = makeRefresh(undefined);
		const clock = sinon.useFakeTimers();
		try {
			assert.strictEqual(await h.refresh.hasCredentials(), true);

			clock.tick(USAGE_CAPACITY_TTL_MS + 1);
			// exit 36 (locked keychain) surfaces as undefined; a not-yet-activated ext host surfaces as a rejection.
			h.setProbe(async () => undefined);
			const afterUndefined = await h.refresh.hasCredentials();

			clock.tick(USAGE_CAPACITY_TTL_MS + 1);
			h.setProbe(() => Promise.reject(new Error('command not found')));
			const afterReject = await h.refresh.hasCredentials();

			// Both keep the known "signed in" rather than downgrading it.
			assert.deepStrictEqual([afterUndefined, afterReject], [true, true]);
		} finally {
			clock.restore();
		}
	});

	test('an INDETERMINATE probe with NO last known value stays UNKNOWN - it never degrades to "signed out"', async () => {
		const h = makeRefresh(undefined);
		const clock = sinon.useFakeTimers();
		try {
			// Nothing known yet and the probe cannot answer (a locked login keychain, exit 36). `false` here would
			// render a signed-in mac user as "Signed out" - the exact bug this change exists to fix.
			h.setProbe(async () => undefined);
			const first = await h.refresh.hasCredentials();

			// And it must not be cached, so the very next poll re-probes and corrects itself within the TTL.
			h.setProbe(async () => true);
			const second = await h.refresh.hasCredentials();

			assert.deepStrictEqual([first, second, h.probeCalls], [undefined, true, 2]);
		} finally {
			clock.restore();
		}
	});

	test('concurrent callers share ONE in-flight probe (the status bar and the dashboard both call readAccount)', async () => {
		const h = makeRefresh(undefined);
		const deferred = new DeferredPromise<boolean | undefined>();
		h.setProbe(() => deferred.p);

		const both = Promise.all([h.refresh.hasCredentials(), h.refresh.hasCredentials()]);
		await deferred.complete(true);

		assert.deepStrictEqual([await both, h.probeCalls], [[true, true], 1]);
	});

	test('a probe in flight across a refresh(force) does not clobber the fresher answer that landed first', async () => {
		const h = makeRefresh(undefined);
		const clock = sinon.useFakeTimers();
		try {
			// The slow PRE-login probe: started first, but it will land LAST.
			const stale = new DeferredPromise<boolean | undefined>();
			h.setProbe(() => stale.p);
			const staleCall = h.refresh.hasCredentials();

			// The user runs `claude login` and hits Refresh: the memo and the in-flight probe are both abandoned.
			await h.refresh.refresh(true);

			// The fresh POST-login probe lands with the truth, and memoises it.
			h.setProbe(async () => true);
			assert.strictEqual(await h.refresh.hasCredentials(), true);

			// Only NOW does the abandoned pre-login probe answer "signed out". It must not stamp the memo.
			await stale.complete(false);
			assert.strictEqual(await staleCall, false);

			// The memo still holds the fresher "signed in" - without the generation counter this read would be a
			// stale `false`, pinning "Signed out" for the whole 60s TTL right after a successful login.
			assert.strictEqual(await h.refresh.hasCredentials(), true);
		} finally {
			clock.restore();
		}
	});
});
// CLAWDIUS-END
