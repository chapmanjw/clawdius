/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN sandbox model + preflight unit tests
// Covers parsing the sandbox.* subtree, domain matching (exact + wildcard), path containment (segment-aware),
// and the network + write preflight verdicts (deny-first, allow, prompt, managed-only, sandbox-off).

import assert from 'assert';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	checkDomain,
	checkWrite,
	domainMatches,
	parseSandboxConfig,
	pathUnder,
} from '../../common/claudeSandbox.js';

suite('Clawdius sandbox model + preflight', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseSandboxConfig reads the sandbox.* subtree', () => {
		const cfg = parseSandboxConfig({
			sandbox: {
				enabled: true,
				network: { allowedDomains: ['registry.npmjs.org'], deniedDomains: ['evil.com'], allowManagedDomainsOnly: true },
				filesystem: { allowWrite: ['/repo'], denyWrite: ['/repo/.git'] },
				allowUnsandboxedCommands: false,
				excludedCommands: ['git'],
			},
		});
		assert.strictEqual(cfg.enabled, true);
		assert.deepStrictEqual(cfg.allowedDomains, ['registry.npmjs.org']);
		assert.deepStrictEqual(cfg.deniedDomains, ['evil.com']);
		assert.strictEqual(cfg.allowManagedDomainsOnly, true);
		assert.deepStrictEqual(cfg.allowWrite, ['/repo']);
		assert.deepStrictEqual(cfg.denyWrite, ['/repo/.git']);
		assert.deepStrictEqual(cfg.excludedCommands, ['git']);
		// Absent scalars stay undefined; absent arrays are empty.
		const empty = parseSandboxConfig({});
		assert.strictEqual(empty.enabled, undefined);
		assert.deepStrictEqual(empty.allowedDomains, []);
		assert.strictEqual(empty.allowManagedDomainsOnly, false);
	});

	test('domainMatches: exact + *. wildcard over subdomains (and the bare domain)', () => {
		assert.strictEqual(domainMatches('registry.npmjs.org', 'registry.npmjs.org'), true);
		assert.strictEqual(domainMatches('registry.npmjs.org', 'other.org'), false);
		assert.strictEqual(domainMatches('*.npmjs.org', 'registry.npmjs.org'), true);
		assert.strictEqual(domainMatches('*.npmjs.org', 'npmjs.org'), true);
		assert.strictEqual(domainMatches('*.npmjs.org', 'npmjs.org.evil.com'), false);
		assert.strictEqual(domainMatches('*.npmjs.org', 'REGISTRY.NPMJS.ORG'), true); // case-insensitive
	});

	test('pathUnder: segment-aware, resolves .., guards empty + root, case-folds where the FS does', () => {
		assert.strictEqual(pathUnder('/repo/src/a.ts', '/repo'), true);
		assert.strictEqual(pathUnder('/repo', '/repo'), true);
		assert.strictEqual(pathUnder('/repo-secret/x', '/repo'), false); // not a child of /repo (segment boundary)
		assert.strictEqual(pathUnder('C:\\repo\\src', 'C:/repo'), true); // backslashes normalised
		assert.strictEqual(pathUnder('/repo/', '/repo'), true);          // trailing slash normalised
		// '..' is resolved, so a traversal cannot dodge the boundary (the confirmed false-allow)
		assert.strictEqual(pathUnder('/repo/../etc/passwd', '/repo'), false);
		assert.strictEqual(pathUnder('/repo/../etc/passwd', '/etc'), true);
		// an empty base/path never matches; a '/' base matches everything
		assert.strictEqual(pathUnder('/anything', ''), false);
		assert.strictEqual(pathUnder('', '/repo'), false);
		assert.strictEqual(pathUnder('/anywhere/x', '/'), true);
		// case-folding follows the filesystem
		assert.strictEqual(pathUnder('/repo/.GIT/config', '/repo/.git'), isWindows || isMacintosh);
	});

	test('checkDomain: deny-first, then allow, then managed-only, else prompt; sandbox-off short-circuits', () => {
		const cfg = parseSandboxConfig({ sandbox: { enabled: true, network: { allowedDomains: ['*.npmjs.org'], deniedDomains: ['bad.npmjs.org'] } } });
		assert.strictEqual(checkDomain(cfg, 'bad.npmjs.org'), 'denied');       // deny wins even though allow would match
		assert.strictEqual(checkDomain(cfg, 'registry.npmjs.org'), 'allowed');
		assert.strictEqual(checkDomain(cfg, 'example.com'), 'prompt');         // neither list -> first-use prompt

		const managed = parseSandboxConfig({ sandbox: { enabled: true, network: { allowedDomains: ['a.com'], allowManagedDomainsOnly: true } } });
		assert.strictEqual(checkDomain(managed, 'b.com'), 'denied');           // managed-only: off-list is denied, not prompted

		const off = parseSandboxConfig({ sandbox: { enabled: false, network: { deniedDomains: ['x.com'] } } });
		assert.strictEqual(checkDomain(off, 'x.com'), 'sandbox-off');          // disabled -> unrestricted
	});

	test('checkWrite: deny-first, allow, default-deny outside the allowlist; sandbox-off short-circuits', () => {
		const cfg = parseSandboxConfig({ sandbox: { enabled: true, filesystem: { allowWrite: ['/repo'], denyWrite: ['/repo/.git'] } } });
		assert.strictEqual(checkWrite(cfg, '/repo/src/a.ts'), 'allowed');
		assert.strictEqual(checkWrite(cfg, '/repo/.git/config'), 'denied');    // deny wins under an allowed parent
		assert.strictEqual(checkWrite(cfg, '/etc/passwd'), 'denied');          // default-deny outside the allowlist
		assert.strictEqual(checkWrite(cfg, '/repo/../etc/cron.d/x'), 'denied'); // .. traversal cannot escape the allowlist
		assert.strictEqual(checkWrite(parseSandboxConfig({ sandbox: { enabled: false } }), '/etc/x'), 'sandbox-off');
	});
});
// CLAWDIUS-END
