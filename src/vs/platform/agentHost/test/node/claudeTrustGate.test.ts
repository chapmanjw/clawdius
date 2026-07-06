/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN workspace-trust gate (node) unit tests
// Covers the trust-state resolution from the forwarded config (absent => dormant-trusted; explicit => fail-closed;
// present-but-schema-invalid => fail-closed) and the deny messages.

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostTrustKey, ITrustConfigValue } from '../../common/trustConfigSchema.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { resolveTrustState, resolveTrusted, trustDenyMessage } from '../../node/claude/claudeTrustGate.js';

/** Minimal IAgentConfigurationService double: getEffectiveValue (validated) + getSessionConfigValues (raw), the
 *  two the trust resolver reads. `rawSession` lets a test model a present-but-schema-invalid forwarded config. */
function fakeConfig(trust: ITrustConfigValue | undefined, rawSession?: Record<string, unknown>): IAgentConfigurationService {
	return { getEffectiveValue: () => trust, getSessionConfigValues: () => rawSession } as unknown as IAgentConfigurationService;
}

suite('Clawdius workspace-trust gate (node)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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

	test('resolveTrustState fails closed on a present-but-invalid trust config (not dormant-trusted)', () => {
		// getEffectiveValue validated the value away (undefined), but the raw session config HAS a trust key - so it
		// was forwarded and is malformed: fail closed to UNTRUSTED rather than fall back to dormant-trusted.
		assert.deepStrictEqual(resolveTrustState(fakeConfig(undefined, { trust: { trusted: 'false' } }), URI.file('/s')), { trusted: false });
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
