/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code credential resolution (node)
// Resolves the Claude Code CLI's OAuth credentials THE SAME WAY THE CLI ITSELF DOES. The CLI's secure-storage
// backend is "keychain-with-plaintext-fallback": on macOS the credentials live in the LOGIN KEYCHAIN as a
// generic-password item (service "Claude Code-credentials", account $USER), and <configDir>/.credentials.json is
// only written when the Keychain write FAILS; on Windows/Linux there is no secret store at all, so the plaintext
// file is the only place they ever land. Reading the file alone therefore works on Windows/Linux and is a TOTAL
// MISS on macOS - which is exactly why the usage surfaces reported "Signed out" for signed-in mac users.
//
// We read the Keychain by SPAWNING /usr/bin/security, never a native binding (Electron safeStorage / keytar /
// node-keychain / @napi-rs/keyring). This is not a style preference: macOS evaluates the item's ACL against the
// process that calls the Keychain API. The item was created by `security add-generic-password` WITHOUT -A, so its
// trusted-application list contains /usr/bin/security (platform-signed, root:wheel) and nothing else. Spawning it
// reads the secret SILENTLY - a native binding would make Clawdius.app the calling process, which is NOT in the
// ACL, and macOS would show a blocking "Clawdius wants to use your confidential information" prompt at every
// launch. This module spawns ONLY the Apple keychain CLI and makes NO network calls. The token is NEVER logged.
//
// This is a DELIBERATE MIRROR of the credential resolution in extensions/clawdius-chat/src/extension.ts (which
// serves LOCAL windows; extensions cannot import src/vs). branding-guard.ts pins both copies so they can't drift.

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { userInfo } from 'os';
import { join } from '../../../base/common/path.js';
import { CREDENTIALS_FILE } from '../common/claudeUsageProvider.js';

/** The macOS login-Keychain generic-password service the CLI stores its OAuth credentials under. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** The CLI's fallback Keychain account when the unix username is not a safe attribute value. */
const KEYCHAIN_FALLBACK_ACCOUNT = 'claude-code-user';
/** Apple's keychain CLI, by ABSOLUTE path: no PATH lookup (no hijack, no GUI-launch PATH ambiguity). */
const SECURITY_BIN = '/usr/bin/security';
/** Bound the Keychain read - a locked keychain awaiting UI could otherwise stall the awaiting status bar. */
const KEYCHAIN_TIMEOUT_MS = 3_000;
/** errSecItemNotFound: the item genuinely does not exist (a definitive "signed out"). */
const ERR_SEC_ITEM_NOT_FOUND = 44;

/** The credential document (identical in the Keychain item and the plaintext file). Only the token is ever read. */
export interface IClaudeCredentials {
	readonly claudeAiOauth?: { readonly accessToken?: string };
}

/** The result of one `security` invocation. `stdout` carries the SECRET - never log it, never wrap it in an Error. */
export interface ISecurityResult {
	/** Exit code: 0 = found, 44 = errSecItemNotFound, 36 = errSecInteractionNotAllowed (locked), -1 = spawn failure. */
	readonly code: number;
	readonly stdout: string;
}

/**
 * The injectable I/O seam: platform, env, unix username, file read, and the `security` spawn. Production passes
 * {@link defaultCredentialDeps}; the unit tests pass fakes, so the resolution order and the exit-code contract are
 * exercised with ZERO real spawns and no dependence on the developer's own keychain.
 */
export interface IClaudeCredentialDeps {
	readonly platform: string;
	readonly env: { readonly [key: string]: string | undefined };
	readonly username: string | undefined;
	readFile(path: string): Promise<string>;
	runSecurity(args: readonly string[]): Promise<ISecurityResult>;
}

export function defaultCredentialDeps(): IClaudeCredentialDeps {
	return {
		platform: process.platform,
		env: process.env,
		username: safeUsername(),
		readFile: path => readFile(path, 'utf8'),
		runSecurity,
	};
}

function safeUsername(): string | undefined {
	try {
		return userInfo().username;
	} catch {
		return undefined;
	}
}

function runSecurity(args: readonly string[]): Promise<ISecurityResult> {
	return new Promise<ISecurityResult>(resolve => {
		// `-w` prints the secret on stdout. Resolve (never reject) so the secret can never ride along inside a
		// rejected Error that some outer caller logs; a non-zero exit is reported as a CODE only.
		execFile(SECURITY_BIN, [...args], { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
			resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
		});
	});
}

/**
 * The Keychain SERVICE name, derived exactly as the CLI derives it. With no config-dir override this is the plain
 * "Claude Code-credentials"; when CLAUDE_CONFIG_DIR (or CLAUDE_SECURESTORAGE_CONFIG_DIR) is set the CLI appends
 * `-<first 8 hex of sha256(NFC(dir))>`, so hardcoding the base name would silently miss those users.
 */
export function keychainServiceName(env: { readonly [key: string]: string | undefined }): string {
	const secureDir = env['CLAUDE_SECURESTORAGE_CONFIG_DIR'];
	const configDir = env['CLAUDE_CONFIG_DIR'];
	const noSuffix = secureDir !== undefined ? !secureDir : !configDir;
	if (noSuffix) {
		return KEYCHAIN_SERVICE;
	}
	const dir = (secureDir !== undefined ? secureDir : configDir!).normalize('NFC');
	return `${KEYCHAIN_SERVICE}-${createHash('sha256').update(dir).digest('hex').substring(0, 8)}`;
}

/** The Keychain ACCOUNT name, derived exactly as the CLI derives it: $USER (or the unix username), else a constant. */
export function keychainAccountName(env: { readonly [key: string]: string | undefined }, username: string | undefined): string {
	const account = env['USER'] || username;
	return account && /^[a-zA-Z0-9._-]+$/.test(account) ? account : KEYCHAIN_FALLBACK_ACCOUNT;
}

/** Parse a credential document, keeping it only when it actually carries an OAuth access token. Pure. */
export function parseCredentials(raw: string): IClaudeCredentials | undefined {
	try {
		const parsed = JSON.parse(raw.trim());
		const token = parsed?.claudeAiOauth?.accessToken;
		return typeof token === 'string' && token.length > 0 ? parsed as IClaudeCredentials : undefined;
	} catch {
		return undefined;
	}
}

type KeychainRead =
	| { readonly kind: 'found'; readonly creds: IClaudeCredentials }
	| { readonly kind: 'absent' }
	| { readonly kind: 'transient' };

async function readKeychain(deps: IClaudeCredentialDeps): Promise<KeychainRead> {
	const service = keychainServiceName(deps.env);
	const account = keychainAccountName(deps.env, deps.username);
	let res = await deps.runSecurity(['find-generic-password', '-a', account, '-w', '-s', service]);
	if (res.code === ERR_SEC_ITEM_NOT_FOUND) {
		// `security` matches on whichever attributes you supply. Retry once WITHOUT -a before concluding the user is
		// signed out: the item may carry a different `acct` (e.g. the CLI last ran under another unix account).
		res = await deps.runSecurity(['find-generic-password', '-w', '-s', service]);
	}
	if (res.code === 0) {
		const creds = parseCredentials(res.stdout);
		return creds ? { kind: 'found', creds } : { kind: 'absent' };
	}
	if (res.code === ERR_SEC_ITEM_NOT_FOUND) {
		return { kind: 'absent' };
	}
	// 36 (errSecInteractionNotAllowed - a locked keychain / headless SSH / launchd session), a timeout, or a spawn
	// failure. INDETERMINATE, NOT "signed out": rendering "Signed out" here would lie to a signed-in user.
	return { kind: 'transient' };
}

async function readCredentialsFile(claudeDir: string, deps: IClaudeCredentialDeps): Promise<IClaudeCredentials | undefined> {
	try {
		return parseCredentials(await deps.readFile(join(claudeDir, CREDENTIALS_FILE)));
	} catch {
		return undefined;
	}
}

async function resolveCredentials(claudeDir: string, deps: IClaudeCredentialDeps): Promise<{ creds?: IClaudeCredentials; indeterminate: boolean }> {
	// An explicit CLAUDE_CODE_OAUTH_TOKEN short-circuits every store in the CLI - such a user is signed in with
	// NEITHER a Keychain item NOR a file, so honour it first or we would call them signed out.
	const envToken = deps.env['CLAUDE_CODE_OAUTH_TOKEN'];
	if (typeof envToken === 'string' && envToken.length > 0) {
		return { creds: { claudeAiOauth: { accessToken: envToken } }, indeterminate: false };
	}
	let indeterminate = false;
	if (deps.platform === 'darwin') {
		// Keychain FIRST (the CLI's primary store). Reading the file first would let a stale plaintext fallback, left
		// behind by an old failed write, shadow the live token - and every capacity fetch would then 401 forever.
		const read = await readKeychain(deps);
		if (read.kind === 'found') {
			return { creds: read.creds, indeterminate: false };
		}
		indeterminate = read.kind === 'transient';
	}
	const fromFile = await readCredentialsFile(claudeDir, deps);
	if (fromFile) {
		return { creds: fromFile, indeterminate: false };
	}
	return { creds: undefined, indeterminate };
}

/** The CLI OAuth access token, or undefined. Returned to the caller ONLY - never logged, never cached to disk. */
export async function readClaudeOAuthToken(claudeDir: string, deps: IClaudeCredentialDeps = defaultCredentialDeps()): Promise<string | undefined> {
	return (await resolveCredentials(claudeDir, deps)).creds?.claudeAiOauth?.accessToken;
}

/**
 * Whether the user has usable Claude Code credentials (the "signed in" gate the renderer renders).
 * `true` = a token exists; `false` = definitively absent; `undefined` = INDETERMINATE (a locked keychain / a spawn
 * failure) - the caller must keep its last known value rather than flipping the UI to "Signed out".
 */
export async function hasClaudeCredentials(claudeDir: string, deps: IClaudeCredentialDeps = defaultCredentialDeps()): Promise<boolean | undefined> {
	const { creds, indeterminate } = await resolveCredentials(claudeDir, deps);
	if (creds) {
		return true;
	}
	return indeterminate ? undefined : false;
}
// CLAWDIUS-END
