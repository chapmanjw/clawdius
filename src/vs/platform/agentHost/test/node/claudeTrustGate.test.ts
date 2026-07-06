/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN workspace-trust gate (node) unit tests
// Covers the write-scope containment (symlink/realpath-based, traversal-safe, fail-closed on empty/unsafe roots),
// the trust-state resolution from the forwarded config (absent => dormant-trusted; explicit => fail-closed), and
// the deny messages.

import assert from 'assert';
import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostTrustKey, ITrustConfigValue } from '../../common/trustConfigSchema.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { isWriteInScope, resolveTrustState, resolveTrusted, trustDenyMessage } from '../../node/claude/claudeTrustGate.js';

/** Minimal IAgentConfigurationService double: getEffectiveValue (validated) + getSessionConfigValues (raw), the
 *  two the trust resolver reads. `rawSession` lets a test model a present-but-schema-invalid forwarded config. */
function fakeConfig(trust: ITrustConfigValue | undefined, rawSession?: Record<string, unknown>): IAgentConfigurationService {
	return { getEffectiveValue: () => trust, getSessionConfigValues: () => rawSession } as unknown as IAgentConfigurationService;
}

suite('Clawdius workspace-trust gate (node)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolveTrustState: absent config => dormant trusted with cwd writable; explicit => fail-closed', () => {
		const cwd = URI.file('/repo');
		// No trust source connected: trusted, working directory writable (current behaviour preserved).
		assert.deepStrictEqual(resolveTrustState(fakeConfig(undefined), URI.file('/s'), cwd), { trusted: true, writeRoots: [cwd.fsPath] });
		// Explicit untrusted: not trusted, no write roots.
		assert.deepStrictEqual(resolveTrustState(fakeConfig({ [AgentHostTrustKey.Trusted]: false }), URI.file('/s'), cwd), { trusted: false, writeRoots: [] });
		// Explicit trusted with roots.
		assert.deepStrictEqual(resolveTrustState(fakeConfig({ [AgentHostTrustKey.Trusted]: true, [AgentHostTrustKey.WriteRoots]: ['/a', '/b'] }), URI.file('/s'), cwd), { trusted: true, writeRoots: ['/a', '/b'] });
		// A config missing the trusted flag fails closed (not trusted).
		assert.strictEqual(resolveTrustState(fakeConfig({}), URI.file('/s'), cwd).trusted, false);
		// resolveTrusted delegates to the same resolution.
		assert.strictEqual(resolveTrusted(fakeConfig(undefined), URI.file('/s')), true);
		assert.strictEqual(resolveTrusted(fakeConfig({ [AgentHostTrustKey.Trusted]: false }), URI.file('/s')), false);
	});

	test('resolveTrustState fails closed on a present-but-invalid trust config (not dormant-trusted)', () => {
		// getEffectiveValue validated the value away (undefined), but the raw session config HAS a trust key - so it
		// was forwarded and is malformed: fail closed to UNTRUSTED rather than fall back to dormant-trusted.
		const state = resolveTrustState(fakeConfig(undefined, { trust: { trusted: 'false' } }), URI.file('/s'), URI.file('/repo'));
		assert.deepStrictEqual(state, { trusted: false, writeRoots: [] });
	});

	test('isWriteInScope: in-scope allowed; outside + traversal + empty + missing-root denied (fail-closed)', async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'clawdius-trust-')));
		// A (not-yet-created) file under the root is in scope.
		assert.strictEqual(await isWriteInScope(join(root, 'sub', 'a.ts'), [root]), true);
		// The root itself is in scope.
		assert.strictEqual(await isWriteInScope(root, [root]), true);
		// A path that resolves OUTSIDE the root via traversal is denied (realpath resolves the ..).
		assert.strictEqual(await isWriteInScope(join(root, '..', 'elsewhere', 'x'), [root]), false);
		// Empty write roots => deny (untrusted / no grants).
		assert.strictEqual(await isWriteInScope(join(root, 'a'), []), false);
	});

	test('trustDenyMessage returns a message for each reason', () => {
		assert.ok(trustDenyMessage('untrusted-write').length > 0);
		assert.ok(trustDenyMessage('out-of-scope-write').length > 0);
		assert.ok(trustDenyMessage('untrusted-shell').length > 0);
		assert.ok(trustDenyMessage(undefined).length > 0);
	});
});
// CLAWDIUS-END
