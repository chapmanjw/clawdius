/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { ActionType } from '../common/state/sessionActions.js';
import { isAhpChatChannel, isDefaultChatUri, type URI as ProtocolURI } from '../common/state/sessionState.js';
import { AgentHostStateManager } from './agentHostStateManager.js';

const MAX_TITLE_LENGTH = 200;

/**
 * Seeds a session's (or additional chat's) title from the first user message.
 * In Clawdius mode there is no CAPI utility model to generate or refine a nicer
 * title, so the truncated first-message text is the only title source the host
 * produces; the Claude SDK's own session summaries take over once available
 * (see `AgentService.listSessions`).
 */
export class AgentHostSessionTitleController extends Disposable {

	constructor(
		private readonly _stateManager: AgentHostStateManager,
	) {
		super();
	}

	seedTitleFromFirstMessage(channel: ProtocolURI, userPrompt: string, chatChannel?: ProtocolURI): void {
		const fallbackTitle = userPrompt.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH);
		if (fallbackTitle.length === 0) {
			return;
		}

		const isAdditionalChat = !!chatChannel && isAhpChatChannel(chatChannel) && !isDefaultChatUri(chatChannel);
		if (isAdditionalChat) {
			// Auto-title the additional chat from its own first message,
			// independently of the session title.
			const chatState = this._stateManager.getChatState(chatChannel);
			if (!chatState || chatState.turns.length !== 0 || chatState.title) {
				return;
			}
			this._stateManager.updateChatTitle(channel, chatChannel, fallbackTitle);
			return;
		}

		const state = this._stateManager.getSessionState(channel);
		if (!state || state.turns.length !== 0 || state.summary.title) {
			return;
		}

		this._stateManager.dispatchServerAction(channel, {
			type: ActionType.SessionTitleChanged,
			title: fallbackTitle,
		});
	}

	refineTitleFromFirstTurn(_channel: ProtocolURI, _chatChannel?: ProtocolURI): void {
		// Fallback-only titles in Clawdius mode: there is no CAPI utility model to
		// refine the seeded title from the first turn's fuller context, so this is
		// a no-op. The Claude SDK's own session summaries supersede it once available.
	}

	cancelTitleGeneration(_session: ProtocolURI): void {
		// Fallback-only titles are produced synchronously; there is nothing async to cancel.
	}
}
