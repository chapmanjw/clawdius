/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { ActionType } from '../common/state/sessionActions.js';
import { type URI as ProtocolURI } from '../common/state/sessionState.js';
import { AgentHostStateManager } from './agentHostStateManager.js';

const MAX_TITLE_LENGTH = 200;

/**
 * Seeds a session's title from the first user message. In Clawdius mode there
 * is no CAPI utility model to generate a nicer title, so the truncated
 * first-message text is the only title source the host produces; the Claude
 * SDK's own session summaries take over once available (see
 * `AgentService.listSessions`).
 */
export class AgentHostSessionTitleController extends Disposable {

	constructor(
		private readonly _stateManager: AgentHostStateManager,
	) {
		super();
	}

	seedTitleFromFirstMessage(channel: ProtocolURI, userPrompt: string): void {
		const state = this._stateManager.getSessionState(channel);
		const fallbackTitle = userPrompt.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH);
		if (!state || state.turns.length !== 0 || state.summary.title || fallbackTitle.length === 0) {
			return;
		}

		this._stateManager.dispatchServerAction(channel, {
			type: ActionType.SessionTitleChanged,
			title: fallbackTitle,
		});
	}

	cancelTitleGeneration(_session: ProtocolURI): void {
		// Fallback-only titles are produced synchronously; there is nothing async to cancel.
	}
}
