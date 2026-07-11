/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN workspace-trust gate (node) unit tests
// Covers the trust-state resolution from the forwarded config (absent => dormant-trusted; explicit => fail-closed;
// present-but-schema-invalid => fail-closed) and the deny messages.

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostTrustKey, ITrustConfigValue } from '../../common/trustConfigSchema.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { isTrustForwarded, resolveTrustState, resolveTrusted, trustDenyMessage, whenTrustForwarded } from '../../node/claude/claudeTrustGate.js';

/** Minimal IAgentConfigurationService double: getEffectiveValue (validated) + the raw root/session getters the
 *  trust resolver reads. `rawRoot` / `rawSession` let a test model a present-but-schema-invalid forwarded config
 *  at either layer (the forwarder writes trust at the ROOT layer). */
function fakeConfig(trust: ITrustConfigValue | undefined, rawSession?: Record<string, unknown>, rawRoot?: Record<string, unknown>): IAgentConfigurationService {
	return { getEffectiveValue: () => trust, getSessionConfigValues: () => rawSession, getRootConfigValues: () => rawRoot } as unknown as IAgentConfigurationService;
}

/** An evented config-service double for the materialize barrier: trust starts absent, `setTrust` makes it
 *  present, and the two emitters model the root-/session-layer change events the barrier listens to. */
function eventedConfig(store: Pick<DisposableStore, 'add'>) {
	let trust: ITrustConfigValue | undefined;
	const rootChange = store.add(new Emitter<void>());
	const sessionChange = store.add(new Emitter<string>());
	const svc = {
		getEffectiveValue: () => trust,
		getSessionConfigValues: () => undefined,
		getRootConfigValues: () => undefined,
		onDidRootConfigChange: rootChange.event,
		onDidSessionConfigChange: sessionChange.event,
	} as unknown as IAgentConfigurationService;
	return { svc, setTrust: (t: ITrustConfigValue | undefined) => { trust = t; }, rootChange, sessionChange };
}

suite('Clawdius workspace-trust gate (node)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('resolveTrustState: absent => dormant trusted; explicit => fail-closed on missing/false flag', () => {
		// No trust source connected yet: dormant-trusted (current behaviour preserved).
		assert.deepStrictEqual(resolveTrustState(fakeConfig(undefined), URI.file('/s')), { trusted: true });
		// Explicit untrusted.
		assert.deepStrictEqual(resolveTrustState(fakeConfig({ [AgentHostTrustKey.Trusted]: false }), URI.file('/s')), { trusted: false });
		// Explicit trusted.
		assert.deepStrictEqual(resolveTrustState(fakeConfig({ [AgentHostTrustKey.Trusted]: true }), URI.file('/s')), { trusted: true });
		// A config missing the trusted flag fails closed.
		assert.strictEqual(resolveTrustState(fakeConfig({}), URI.file('/s')).trusted, false);
		// resolveTrusted delegates to the same resolution.
		assert.strictEqual(resolveTrusted(fakeConfig(undefined), URI.file('/s')), true);
		assert.strictEqual(resolveTrusted(fakeConfig({ [AgentHostTrustKey.Trusted]: false }), URI.file('/s')), false);
	});

	test('resolveTrustState fails closed on a present-but-invalid trust config at either layer', () => {
		// getEffectiveValue validated the value away (undefined), but a raw config HAS a trust key - so it was
		// forwarded and is malformed: fail closed to UNTRUSTED rather than fall back to dormant-trusted.
		// The forwarder writes at the ROOT layer, so that must be covered:
		assert.deepStrictEqual(resolveTrustState(fakeConfig(undefined, undefined, { trust: { trusted: 'false' } }), URI.file('/s')), { trusted: false });
		// ...and a malformed value at the session layer is also caught:
		assert.deepStrictEqual(resolveTrustState(fakeConfig(undefined, { trust: { trusted: 'false' } }), URI.file('/s')), { trusted: false });
	});

	test('isTrustForwarded: absent => false; effective value or raw key at either layer => true', () => {
		assert.deepStrictEqual(
			[
				isTrustForwarded(fakeConfig(undefined), URI.file('/s')),
				isTrustForwarded(fakeConfig({ [AgentHostTrustKey.Trusted]: true }), URI.file('/s')),
				isTrustForwarded(fakeConfig({ [AgentHostTrustKey.Trusted]: false }), URI.file('/s')),
				isTrustForwarded(fakeConfig(undefined, undefined, { trust: { trusted: 'garbage' } }), URI.file('/s')),
				isTrustForwarded(fakeConfig(undefined, { trust: {} }), URI.file('/s')),
			],
			[false, true, true, true, true],
		);
	});

	test('whenTrustForwarded resolves present immediately when a trust value is already forwarded', async () => {
		const { svc, setTrust } = eventedConfig(store);
		setTrust({ [AgentHostTrustKey.Trusted]: false });
		assert.strictEqual(await whenTrustForwarded(svc, URI.file('/s'), 5), 'present');
	});

	test('whenTrustForwarded wakes on a root-config write that carries trust', async () => {
		const { svc, setTrust, rootChange } = eventedConfig(store);
		const p = whenTrustForwarded(svc, URI.file('/s'), 5_000);
		setTrust({ [AgentHostTrustKey.Trusted]: true });
		rootChange.fire();
		assert.strictEqual(await p, 'forwarded');
	});

	test('whenTrustForwarded wakes on a session-config write for THIS session only', async () => {
		const { svc, setTrust, sessionChange } = eventedConfig(store);
		const p = whenTrustForwarded(svc, URI.file('/s'), 5_000);
		setTrust({ [AgentHostTrustKey.Trusted]: true });
		// A different session's config write must not wake the barrier even though trust is now readable.
		sessionChange.fire(URI.file('/other').toString());
		assert.strictEqual(await Promise.race([p, timeout(20).then(() => 'still-waiting' as const)]), 'still-waiting');
		sessionChange.fire(URI.file('/s').toString());
		assert.strictEqual(await p, 'forwarded');
	});

	test('whenTrustForwarded times out bounded when no trust source connects', async () => {
		const { svc } = eventedConfig(store);
		assert.strictEqual(await whenTrustForwarded(svc, URI.file('/s'), 5), 'timeout');
	});

	test('whenTrustForwarded resolves aborted when the signal fires first (or already fired)', async () => {
		const { svc } = eventedConfig(store);
		const ac = new AbortController();
		const p = whenTrustForwarded(svc, URI.file('/s'), 5_000, ac.signal);
		ac.abort();
		assert.strictEqual(await p, 'aborted');
		assert.strictEqual(await whenTrustForwarded(svc, URI.file('/s'), 5_000, ac.signal), 'aborted');
	});

	test('trustDenyMessage returns a message for each reason', () => {
		assert.ok(trustDenyMessage('untrusted-write').length > 0);
		assert.ok(trustDenyMessage('untrusted-shell').length > 0);
		assert.ok(trustDenyMessage('untrusted-mcp').length > 0);
		assert.ok(trustDenyMessage('untrusted-url').length > 0);
		assert.ok(trustDenyMessage('untrusted-tool').length > 0);
		assert.ok(trustDenyMessage(undefined).length > 0);
	});
});
// CLAWDIUS-END
