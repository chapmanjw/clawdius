/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Sandbox config model + preflight
// The `sandbox.*` subtree of Claude Code settings, parsed into a typed model, plus a pure preflight: "would this
// domain / write path be allowed by the active sandbox config?" Clawdius does not enforce the sandbox (the kernel
// does - Seatbelt on macOS, bubblewrap on Linux/WSL2); this is the config surface + a dry-run so the Sandbox tab
// can answer "npm publish would prompt: registry.npmjs.org is not in the allowlist" before anything runs.

import { posix } from '../../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';

/** Windows + macOS default filesystems are case-insensitive, so the sandbox resolves paths case-insensitively
 *  there; Linux/WSL2 is case-sensitive. Path matching must follow suit or a `.git` deny is dodged by `.GIT`. */
const CASE_INSENSITIVE_FS = isWindows || isMacintosh;

/** The user-facing shape of the `sandbox.*` settings subtree. Absent scalars stay undefined (unset != false). */
export interface ISandboxConfig {
	readonly enabled: boolean | undefined;
	readonly allowedDomains: readonly string[];
	readonly deniedDomains: readonly string[];
	readonly allowManagedDomainsOnly: boolean;
	readonly allowWrite: readonly string[];
	readonly denyWrite: readonly string[];
	readonly allowRead: readonly string[];
	readonly denyRead: readonly string[];
	readonly allowManagedReadPathsOnly: boolean;
	readonly allowUnsandboxedCommands: boolean | undefined;
	readonly excludedCommands: readonly string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
}

function bool(v: unknown): boolean | undefined {
	return typeof v === 'boolean' ? v : undefined;
}

/** Parse the `sandbox` block of a settings object into {@link ISandboxConfig}. Accepts any parsed-JSON object
 *  shape (a scope's settings.json, or a reconstructed effective subtree). */
export function parseSandboxConfig(settings: Record<string, unknown> | undefined): ISandboxConfig {
	const sandbox = settings && isObject(settings['sandbox']) ? settings['sandbox'] : {};
	const network = isObject(sandbox['network']) ? sandbox['network'] : {};
	const filesystem = isObject(sandbox['filesystem']) ? sandbox['filesystem'] : {};
	return {
		enabled: bool(sandbox['enabled']),
		allowedDomains: strings(network['allowedDomains']),
		deniedDomains: strings(network['deniedDomains']),
		allowManagedDomainsOnly: bool(network['allowManagedDomainsOnly']) === true,
		allowWrite: strings(filesystem['allowWrite']),
		denyWrite: strings(filesystem['denyWrite']),
		allowRead: strings(filesystem['allowRead']),
		denyRead: strings(filesystem['denyRead']),
		allowManagedReadPathsOnly: bool(filesystem['allowManagedReadPathsOnly']) === true,
		allowUnsandboxedCommands: bool(sandbox['allowUnsandboxedCommands']),
		excludedCommands: strings(sandbox['excludedCommands']),
	};
}

/** True when a domain matches an allow/deny pattern: exact, or a `*.example.com` wildcard over any subdomain. */
export function domainMatches(pattern: string, domain: string): boolean {
	const p = pattern.trim().toLowerCase();
	const d = domain.trim().toLowerCase();
	if (p.length === 0 || d.length === 0) { return false; }
	if (p === d) { return true; }
	if (p.startsWith('*.')) {
		const bare = p.slice(2); // "example.com"
		return d === bare || d.endsWith(`.${bare}`);
	}
	return false;
}

/** Normalise a path for comparison: backslashes to `/`, `.`/`..` segments resolved (lexically - these are config
 *  paths, not fs lookups), trailing slash dropped, and lower-cased on a case-insensitive filesystem. */
function normPath(s: string): string {
	const str = posix.normalize(s.replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
	return CASE_INSENSITIVE_FS ? str.toLowerCase() : str;
}

/**
 * True when `path` is at or below the allow/deny entry `base` - `..`/`.` resolved, path-SEGMENT aware (not a bare
 * string prefix, so `/repo-secret` is not under `/repo`), and case-folded on case-insensitive filesystems. An
 * empty base or path never matches; a `/` base matches every path (a deny-all / allow-all root rule).
 */
export function pathUnder(path: string, base: string): boolean {
	if (path.trim().length === 0 || base.trim().length === 0) { return false; }
	const p = normPath(path);
	const b = normPath(base);
	if (b === '/') { return true; }
	return p === b || p.startsWith(`${b}/`);
}

export type SandboxNetworkVerdict = 'sandbox-off' | 'allowed' | 'denied' | 'prompt';

/**
 * Preflight a network destination against the sandbox config.
 * - `sandbox-off`: the sandbox is explicitly disabled; the connection is unrestricted.
 * - `denied`: a deny rule matches, or `allowManagedDomainsOnly` is set and the domain is not on the allowlist.
 * - `allowed`: an allow rule matches.
 * - `prompt`: neither list matches; the sandbox would fire a first-use approval prompt.
 */
export function checkDomain(config: ISandboxConfig, domain: string): SandboxNetworkVerdict {
	if (config.enabled === false) { return 'sandbox-off'; }
	if (config.deniedDomains.some(p => domainMatches(p, domain))) { return 'denied'; }
	if (config.allowedDomains.some(p => domainMatches(p, domain))) { return 'allowed'; }
	if (config.allowManagedDomainsOnly) { return 'denied'; }
	return 'prompt';
}

export type SandboxWriteVerdict = 'sandbox-off' | 'allowed' | 'denied';

/**
 * Preflight a filesystem write against the sandbox config. Deny-first, then allow; default-deny outside the
 * allowlist (the sandbox permits writes under the working directory by default - the caller passes cwd in
 * `allowWrite` if it wants that reflected).
 */
export function checkWrite(config: ISandboxConfig, path: string): SandboxWriteVerdict {
	if (config.enabled === false) { return 'sandbox-off'; }
	if (config.denyWrite.some(base => pathUnder(path, base))) { return 'denied'; }
	if (config.allowWrite.some(base => pathUnder(path, base))) { return 'allowed'; }
	return 'denied';
}
// CLAWDIUS-END
