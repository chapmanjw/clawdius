/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';

// CLAWDIUS-BEGIN retained local loopback-proxy bearer auth
// Extracted from the now-removed `claude/claudeProxyAuth.ts` (the Anthropic->CAPI proxy, deleted
// with the GitHub Copilot / CAPI transport). The Bearer-token parsing itself is transport-agnostic
// and still needed by the retained BYOK LOCAL loopback proxy (`byokLmProxyService.ts`), which
// authenticates inbound requests to its own `127.0.0.1`-only HTTP server — no network/proxy
// transport is added back by keeping this helper.

/**
 * Result of {@link parseProxyBearer}. `valid` is `true` only when the
 * `Authorization` header contains `Bearer <expectedNonce>.<sessionId>`
 * with a non-empty `sessionId`.
 *
 * Deliberately does NOT accept a legacy `Bearer <nonce>` (no dot) format —
 * callers always issue full `nonce.sessionId` tokens.
 */
export interface ProxyBearerAuth {
	readonly valid: boolean;
	readonly sessionId: string | undefined;
}

const INVALID: ProxyBearerAuth = Object.freeze({ valid: false, sessionId: undefined });

/**
 * Parses + validates the inbound Bearer token on a local loopback proxy request.
 *
 * Accepts only `Authorization: Bearer <nonce>.<sessionId>` where the
 * leading nonce equals `expectedNonce` and `sessionId` is non-empty.
 * The `x-api-key` header is ignored to prevent a user's
 * `ANTHROPIC_API_KEY` env var from interfering with proxy auth.
 *
 * Rejects (returns `{ valid: false, sessionId: undefined }`):
 * - missing or non-`Bearer` `Authorization`
 * - `Bearer <nonce>` (no dot)
 * - `Bearer <nonce>.` (empty sessionId)
 * - `Bearer <wrong-nonce>.<sessionId>`
 */
export function parseProxyBearer(headers: http.IncomingHttpHeaders, expectedNonce: string): ProxyBearerAuth {
	const authHeader = headers['authorization'];
	if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
		return INVALID;
	}

	const token = authHeader.slice('Bearer '.length);
	const dotIndex = token.indexOf('.');
	if (dotIndex === -1) {
		return INVALID;
	}

	const nonce = token.slice(0, dotIndex);
	const sessionId = token.slice(dotIndex + 1);
	if (nonce !== expectedNonce || sessionId.length === 0) {
		return INVALID;
	}

	return { valid: true, sessionId };
}
// CLAWDIUS-END
