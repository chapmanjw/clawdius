/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code credential resolution (node) unit tests
// Covers the resolution order the CLI itself uses (CLAUDE_CODE_OAUTH_TOKEN, then the macOS login Keychain, then the
// plaintext file), the exact `security` argv, and the full exit-code contract - in particular that 36
// (errSecInteractionNotAllowed, a locked keychain) is INDETERMINATE and must never be rendered as "Signed out".
// Everything runs through the injected IClaudeCredentialDeps seam: ZERO real spawns, no dependence on the
// developer's own keychain, and the suite behaves identically on macOS, Windows, and Linux.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	IClaudeCredentialDeps, ISecurityResult, hasClaudeCredentials, keychainAccountName, keychainServiceName,
	parseCredentials, readClaudeOAuthToken,
} from '../../node/claudeCredentials.js';

const CLAUDE_DIR = '/Users/jdoe/.claude';
const KEYCHAIN_TOKEN = 'oat-keychain-token';
const FILE_TOKEN = 'oat-file-token';

/** errSecItemNotFound - the item genuinely does not exist. */
const NOT_FOUND = 44;
/** errSecInteractionNotAllowed - a locked keychain / headless SSH / launchd session. INDETERMINATE. */
const INTERACTION_NOT_ALLOWED = 36;

function credentialsJson(token: string): string {
	return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'r', expiresAt: 1784000496259 } });
}

interface IFakeOptions {
	readonly platform?: string;
	readonly env?: { readonly [key: string]: string | undefined };
	readonly username?: string;
	/** The file contents at <claudeDir>/.credentials.json, or undefined to make the read throw (ENOENT). */
	readonly file?: string;
	/** Queued `security` results, consumed in order. An exhausted queue means "the code spawned more than expected". */
	readonly security?: readonly ISecurityResult[];
}

/** A deps double that records every `security` argv, so the tests can assert the EXACT arguments and spawn count. */
function fakeDeps(options: IFakeOptions = {}): IClaudeCredentialDeps & { readonly spawns: string[][] } {
	const queue = [...(options.security ?? [])];
	const spawns: string[][] = [];
	return {
		spawns,
		platform: options.platform ?? 'darwin',
		env: options.env ?? {},
		username: options.username ?? 'jdoe',
		readFile: async () => {
			if (options.file === undefined) {
				throw new Error('ENOENT: no such file or directory');
			}
			return options.file;
		},
		runSecurity: async (args: readonly string[]) => {
			spawns.push([...args]);
			return queue.shift() ?? { code: NOT_FOUND, stdout: '' };
		},
	};
}

suite('claudeCredentials', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('darwin: reads the token from the Keychain with the exact CLI argv (never touching the file)', async () => {
		const deps = fakeDeps({ security: [{ code: 0, stdout: credentialsJson(KEYCHAIN_TOKEN) }] });

		assert.strictEqual(await readClaudeOAuthToken(CLAUDE_DIR, deps), KEYCHAIN_TOKEN);
		assert.deepStrictEqual(deps.spawns, [['find-generic-password', '-a', 'jdoe', '-w', '-s', 'Claude Code-credentials']]);
	});

	test('darwin: the Keychain BEATS a stale plaintext fallback file (else every capacity fetch 401s forever)', async () => {
		const deps = fakeDeps({ file: credentialsJson(FILE_TOKEN), security: [{ code: 0, stdout: credentialsJson(KEYCHAIN_TOKEN) }] });

		assert.strictEqual(await readClaudeOAuthToken(CLAUDE_DIR, deps), KEYCHAIN_TOKEN);
	});

	test('darwin: exit 44 retries once WITHOUT -a, then falls through to the file', async () => {
		const deps = fakeDeps({
			file: credentialsJson(FILE_TOKEN),
			security: [{ code: NOT_FOUND, stdout: '' }, { code: NOT_FOUND, stdout: '' }],
		});

		assert.strictEqual(await readClaudeOAuthToken(CLAUDE_DIR, deps), FILE_TOKEN);
		assert.deepStrictEqual(deps.spawns, [
			['find-generic-password', '-a', 'jdoe', '-w', '-s', 'Claude Code-credentials'],
			['find-generic-password', '-w', '-s', 'Claude Code-credentials'],
		]);
	});

	test('darwin: the -a-less retry finds an item stored under a different acct', async () => {
		const deps = fakeDeps({ security: [{ code: NOT_FOUND, stdout: '' }, { code: 0, stdout: credentialsJson(KEYCHAIN_TOKEN) }] });

		assert.strictEqual(await hasClaudeCredentials(CLAUDE_DIR, deps), true);
	});

	test('darwin: exit 44 twice and no file is a DEFINITIVE signed-out (false, not indeterminate)', async () => {
		const deps = fakeDeps({ security: [{ code: NOT_FOUND, stdout: '' }, { code: NOT_FOUND, stdout: '' }] });

		assert.strictEqual(await hasClaudeCredentials(CLAUDE_DIR, deps), false);
	});

	test('darwin: exit 36 (locked keychain) is INDETERMINATE - undefined, never false', async () => {
		const deps = fakeDeps({ security: [{ code: INTERACTION_NOT_ALLOWED, stdout: '' }] });

		// The whole point of the bug: rendering "Signed out" here would lie to a signed-in user.
		assert.strictEqual(await hasClaudeCredentials(CLAUDE_DIR, deps), undefined);
		// 36 is not 44, so there is no retry-without-a.
		assert.strictEqual(deps.spawns.length, 1);
	});

	test('darwin: a spawn failure (-1) is INDETERMINATE, but a readable file still wins', async () => {
		const indeterminate = fakeDeps({ security: [{ code: -1, stdout: '' }] });
		const withFile = fakeDeps({ file: credentialsJson(FILE_TOKEN), security: [{ code: -1, stdout: '' }] });

		assert.deepStrictEqual(
			[await hasClaudeCredentials(CLAUDE_DIR, indeterminate), await hasClaudeCredentials(CLAUDE_DIR, withFile)],
			[undefined, true],
		);
	});

	test('win32/linux: never spawns security, and reads the plaintext file (the only store there)', async () => {
		const win = fakeDeps({ platform: 'win32', file: credentialsJson(FILE_TOKEN) });
		const linux = fakeDeps({ platform: 'linux', file: credentialsJson(FILE_TOKEN) });

		assert.deepStrictEqual(
			[await readClaudeOAuthToken(CLAUDE_DIR, win), await readClaudeOAuthToken(CLAUDE_DIR, linux)],
			[FILE_TOKEN, FILE_TOKEN],
		);
		assert.deepStrictEqual([win.spawns, linux.spawns], [[], []]);
	});

	test('win32/linux: no file is a DEFINITIVE false, not a stuck indeterminate', async () => {
		const win = fakeDeps({ platform: 'win32' });
		const linux = fakeDeps({ platform: 'linux' });

		assert.deepStrictEqual(
			[await hasClaudeCredentials(CLAUDE_DIR, win), await hasClaudeCredentials(CLAUDE_DIR, linux)],
			[false, false],
		);
	});

	test('CLAUDE_CODE_OAUTH_TOKEN short-circuits every store (no spawn, no file read)', async () => {
		const deps = fakeDeps({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-env-token' } });

		assert.deepStrictEqual(
			[await readClaudeOAuthToken(CLAUDE_DIR, deps), await hasClaudeCredentials(CLAUDE_DIR, deps)],
			['oat-env-token', true],
		);
		assert.deepStrictEqual(deps.spawns, []);
	});

	test('keychainServiceName: bare by default; sha256-suffixed when a config dir is set', () => {
		// sha256('/Users/jdoe/.config/claude') -> first 8 hex. CLAUDE_SECURESTORAGE_CONFIG_DIR takes precedence, and an
		// EMPTY override means "no suffix" (mirrors the CLI's `t !== undefined ? !t : !CLAUDE_CONFIG_DIR`).
		const dir = '/Users/jdoe/.config/claude';
		const suffixed = keychainServiceName({ CLAUDE_CONFIG_DIR: dir });

		assert.deepStrictEqual(
			[
				keychainServiceName({}),
				/^Claude Code-credentials-[0-9a-f]{8}$/.test(suffixed),
				keychainServiceName({ CLAUDE_SECURESTORAGE_CONFIG_DIR: dir }) === suffixed,
				keychainServiceName({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '', CLAUDE_CONFIG_DIR: dir }),
			],
			['Claude Code-credentials', true, true, 'Claude Code-credentials'],
		);
	});

	test('keychainAccountName: $USER wins, then the unix username; a hostile value falls back to the constant', () => {
		assert.deepStrictEqual(
			[
				keychainAccountName({ USER: 'alice' }, 'jdoe'),
				keychainAccountName({}, 'jdoe'),
				keychainAccountName({ USER: 'evil; rm -rf /' }, undefined),
				keychainAccountName({}, undefined),
			],
			['alice', 'jdoe', 'claude-code-user', 'claude-code-user'],
		);
	});

	test('parseCredentials: keeps only documents that actually carry an access token', () => {
		assert.deepStrictEqual(
			[
				parseCredentials(credentialsJson(FILE_TOKEN))?.claudeAiOauth?.accessToken,
				parseCredentials(`  ${credentialsJson(FILE_TOKEN)}\n`)?.claudeAiOauth?.accessToken,
				parseCredentials('{"claudeAiOauth":{"accessToken":""}}'),
				parseCredentials('{"claudeAiOauth":{}}'),
				parseCredentials('not json'),
				parseCredentials(''),
			],
			[FILE_TOKEN, FILE_TOKEN, undefined, undefined, undefined, undefined],
		);
	});
});
// CLAWDIUS-END
