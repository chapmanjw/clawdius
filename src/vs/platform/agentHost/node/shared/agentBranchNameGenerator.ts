/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN fork-local deterministic branch-name generator
// Upstream's `AgentBranchNameGenerator` (from the "Unify worktree isolation across agents"
// merge) calls `ICopilotApiService.utilityChatCompletion()` to ask GitHub Copilot's utility-chat
// endpoint for an AI-suggested branch name, authenticated with a GitHub token. Clawdius has no
// GitHub Copilot account and makes no uninitiated network calls, so `copilotApiService.ts` was
// removed with the rest of the CAPI transport. This fork-local generator keeps the exact same
// public surface (`IAgentBranchNameGenerator`, `AGENT_BRANCH_PREFIX`, collision-retry naming) but
// always uses the local, deterministic slug derived from the user's message
// ({@link getAgentBranchNameHintFromMessage}) instead of the network-backed hint — no egress.
// CLAWDIUS-END

import { ILogService } from '../../../log/common/log.js';

/**
 * Branch-name prefix for worktree-isolated agent sessions, e.g.
 * `agents/add-feature`. Shared by every agent-host provider via
 * {@link WorktreeIsolation}.
 */
export const AGENT_BRANCH_PREFIX = 'agents/';
const AGENT_BRANCH_SESSION_ID_SUFFIX_LENGTH = 8;
const MAX_BRANCH_NAME_HINT_LENGTH = 48;
const MAX_BRANCH_NAME_CANDIDATES = 100;

export interface IAgentBranchNameGeneratorRequest {
	readonly sessionId: string;
	readonly message?: string;
	/**
	 * Unused by the fork-local generator (retained for structural parity with
	 * upstream's request shape). See the CLAWDIUS note above: Clawdius never
	 * has a GitHub token to authenticate a branch-name-generation call with.
	 */
	readonly githubToken?: string;
	readonly signal?: AbortSignal;
	/**
	 * Optional prefix prepended before the built-in {@link AGENT_BRANCH_PREFIX}
	 * when constructing the branch name (e.g. the user's `git.branchPrefix`
	 * setting). An empty or omitted value preserves the historical
	 * `agents/<hint>` naming.
	 */
	readonly branchPrefix?: string;
	/**
	 * Optional predicate used to check whether a candidate branch name collides
	 * with an existing branch or its corresponding worktree path.
	 */
	readonly branchNameCollides?: (branchName: string) => Promise<boolean>;
}

export interface IAgentBranchNameGenerator {
	generateBranchName(request: IAgentBranchNameGeneratorRequest): Promise<string>;
}

/**
 * Deterministic, network-free branch-name generator: slugifies the user's
 * first message locally (see {@link getAgentBranchNameHintFromMessage}) and
 * falls back to the session id when the message yields no usable hint.
 */
export class AgentBranchNameGenerator implements IAgentBranchNameGenerator {

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	async generateBranchName(request: IAgentBranchNameGeneratorRequest): Promise<string> {
		const branchNameHint = getAgentBranchNameHintFromMessage(request.message ?? '');
		return this._buildBranchName(request, branchNameHint);
	}

	private async _buildBranchName(request: IAgentBranchNameGeneratorRequest, branchNameHint: string | undefined): Promise<string> {
		// Prepend the caller-supplied prefix (e.g. `git.branchPrefix`) ahead of
		// the built-in `agents/` prefix. An empty/omitted value keeps the
		// historical `agents/<hint>` shape.
		const prefix = `${request.branchPrefix ?? ''}${AGENT_BRANCH_PREFIX}`;

		const branchName = `${prefix}${branchNameHint ?? request.sessionId}`;
		const collisionBase = branchNameHint
			? `${branchName}-${request.sessionId.substring(0, AGENT_BRANCH_SESSION_ID_SUFFIX_LENGTH)}`
			: branchName;
		for (let candidateIndex = 0; candidateIndex < MAX_BRANCH_NAME_CANDIDATES; candidateIndex++) {
			const candidate = candidateIndex === 0
				? branchName
				: branchNameHint && candidateIndex === 1
					? collisionBase
					: `${collisionBase}-${branchNameHint ? candidateIndex : candidateIndex + 1}`;
			if (!request.branchNameCollides || !await request.branchNameCollides(candidate)) {
				return candidate;
			}
		}

		this._logService.warn(`[AgentBranchNameGenerator] Unable to find an available branch name after checking ${MAX_BRANCH_NAME_CANDIDATES} candidates`);
		throw new Error(`Unable to find an available branch name after checking ${MAX_BRANCH_NAME_CANDIDATES} candidates`);
	}
}

/**
 * Only supports alphanumeric characters and dashes for simplicity. Exported
 * for tests / reuse by other slug-shaped naming needs.
 */
export function normalizeAgentBranchName(branchName: string): string {
	let normalized = branchName.replace(/[^a-zA-Z0-9\-]/g, '').toLowerCase();
	// Collapse consecutive dots (..) into a single dot
	normalized = normalized.replace(/\.{2,}/g, '.');
	// Strip leading '-' or '.'
	normalized = normalized.replace(/^[-.]+/, '');
	// Strip trailing '.' or '/'
	normalized = normalized.replace(/[./]+$/, '');
	// Strip trailing .lock
	normalized = normalized.replace(/\.lock$/, '');
	return normalized;
}

/**
 * Derives a slug-style branch-name hint from the user's first message. The
 * sole, always-local source of the branch-name hint in Clawdius (no
 * network-backed alternative — see the CLAWDIUS note at the top of this file).
 */
export function getAgentBranchNameHintFromMessage(message: string): string | undefined {
	const words = message
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.split('-')
		.filter(word => word.length > 0)
		.slice(0, 8);
	const hint = words.join('-').slice(0, MAX_BRANCH_NAME_HINT_LENGTH).replace(/-+$/g, '');
	return hint.length > 0 ? hint : undefined;
}
