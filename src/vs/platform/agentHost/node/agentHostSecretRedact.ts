/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN redact provider secrets from agent-host subprocess output before logging
// The Claude engine subprocess inherits ANTHROPIC_* auth in its env, and an enterprise wrapper or a
// misconfiguration can surface AWS / LWA / SP-API credentials in its stderr (a crash dump, or an error that
// echoes an env var). The agent host logs those stderr lines verbatim, so a secret could otherwise land in a
// shareable log file. Redact secret-shaped tokens before logging. Best-effort defense-in-depth: only tokens
// with a distinctive prefix are matched, so ordinary log text is never mangled, and the generic 40-char AWS
// secret-access-key shape (no prefix; would false-positive on hashes / base64 blobs) is intentionally NOT
// matched here - the known-secret env-assignment pass below covers it when it appears as `NAME=value`.
//
// Applied to every agent-host stderr sink whose process can surface these credentials: the Claude engine
// sessions (initial + rematerialize), MCP tool discovery, and the /usage fetch (all authenticate with the
// provider and can echo an auth value on error); the agent-host utility process, whose Node crash /
// unhandled-error path can serialize the inherited env; and git, which - though git itself never emits these
// vars - runs user-configured filters, hooks, and helpers (arbitrary code inheriting the env) that write to
// the stderr git then logs. Excluded are native tools that run NO user-supplied code and so cannot echo the
// env: ripgrep (spawned with --no-config, so no ~/.ripgreprc preprocessor runs) and wsl --list (queries the host, runs no distro command). Remote SSH/WSL
// transport stderr is a distinct concern (a connection token, redacted by redactToken where it appears);
// provider auth is not forwarded into remote command environments.

const REDACTED = '<redacted>';

/** Secret / credential shapes anchored on a distinctive prefix. Global so every occurrence on a line is redacted. */
const SECRET_PATTERNS: readonly RegExp[] = [
	/sk-ant-[A-Za-z0-9_-]{8,}/g,                        // Anthropic API key / OAuth token (sk-ant-api03-, sk-ant-oat01-)
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,                   // AWS access key id
	/amzn1\.application-oa2-client\.[A-Za-z0-9]{16,}/g, // Amazon LWA client id (an identifier, redacted defensively; not the client secret)
	/Atzr\|[A-Za-z0-9_-]{16,}/g,                        // SP-API / LWA refresh token
];

/**
 * Value of a known-secret environment assignment (e.g. `ANTHROPIC_API_KEY=...`). Redacts the value but keeps
 * the name, so the log still records WHICH variable leaked without exposing it. Catches secrets whose value
 * has no distinctive prefix (e.g. an AWS secret access key).
 */
const SECRET_ENV_ASSIGNMENT = /\b(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_ACCESS_KEY_ID)=(\S+)/g;

/**
 * Redact provider secrets from a free-form log string (an agent-host subprocess's stderr) before it is written
 * to the log. Replaces secret-shaped tokens with `<redacted>`. Best-effort by design (see the pattern notes
 * above): it is a logging safety net, not an authorization boundary.
 */
export function redactSecrets(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, REDACTED);
	}
	return out.replace(SECRET_ENV_ASSIGNMENT, `$1=${REDACTED}`);
}
// CLAWDIUS-END
