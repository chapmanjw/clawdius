/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { ISessionDataService } from '../common/sessionDataService.js';
import { ActionType } from '../common/state/sessionActions.js';
import { isAhpChatChannel, isDefaultChatUri, type Turn, type URI as ProtocolURI } from '../common/state/sessionState.js';
import { persistSessionMetadata } from './shared/persistSessionMetadata.js';
import { AgentHostStateManager } from './agentHostStateManager.js';

const MAX_TITLE_LENGTH = 200;

export interface IAgentHostSessionTitleControllerOptions {
	readonly sessionDataService: ISessionDataService;
}

/**
 * Seeds a session's (or additional chat's) title from the first user message,
 * or from a locally handled command's suggested title. In Clawdius mode there
 * is no CAPI utility model to generate or refine a nicer title, so the
 * normalized first-message or suggested text is the only title source the
 * host produces; the Claude SDK's own session summaries take over once
 * available (see `AgentService.listSessions`).
 */
export class AgentHostSessionTitleController extends Disposable {

	/**
	 * The most recent title this controller applied for a given session/chat
	 * key. Used to detect whether the title was changed (e.g. a manual
	 * `/rename` or user edit) since we last set it, so we never clobber a
	 * deliberate title with a suggested one.
	 */
	private readonly _lastAppliedTitle = new Map<ProtocolURI, string>();

	/**
	 * Session/chat keys whose current title is a provisional placeholder set by
	 * {@link seedProvisionalTitle} (e.g. from a `!command`). Such a title does
	 * not describe the session's topic, so the first subsequent request that
	 * carries real intent replaces it via {@link seedTitleFromFirstMessage}.
	 */
	private readonly _provisionalTitles = new Set<ProtocolURI>();

	constructor(
		private readonly _stateManager: AgentHostStateManager,
		private readonly _options: IAgentHostSessionTitleControllerOptions,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	seedTitleFromFirstMessage(channel: ProtocolURI, userPrompt: string, chatChannel?: ProtocolURI): void {
		const fallbackTitle = this._normalizeTitle(userPrompt);
		if (!fallbackTitle) {
			return;
		}

		const additionalChat = this._additionalChatChannel(chatChannel);
		const key = additionalChat ?? channel;
		const state = additionalChat ? this._stateManager.getChatState(additionalChat) : this._stateManager.getSessionState(channel);
		if (!state || !this._canSeedFirstMessageTitle(key, state.turns.length, state.title)) {
			return;
		}
		const replacesProvisionalTitle = this._provisionalTitles.has(key);
		this._provisionalTitles.delete(key);
		this._applySeedTitle(channel, additionalChat, fallbackTitle);
		if (replacesProvisionalTitle) {
			this._persistSeedTitle(channel, additionalChat, fallbackTitle);
		}
	}

	/** Seeds and persists a provisional title suggested by a locally handled command. */
	seedProvisionalTitle(channel: ProtocolURI, suggestedTitle: string, chatChannel?: ProtocolURI): void {
		const title = this._normalizeTitle(suggestedTitle);
		if (!title) {
			return;
		}

		const additionalChat = this._additionalChatChannel(chatChannel);
		const key = additionalChat ?? channel;
		const state = additionalChat ? this._stateManager.getChatState(additionalChat) : this._stateManager.getSessionState(channel);
		if (!state || !this._canSeedProvisionalTitle(key, state.title)) {
			return;
		}
		this._provisionalTitles.add(key);
		this._applySeedTitle(channel, additionalChat, title);
		this._persistSeedTitle(channel, additionalChat, title);
	}

	refineTitleFromFirstTurn(_channel: ProtocolURI, _chatChannel?: ProtocolURI): void {
		// Fallback-only titles in Clawdius mode: there is no CAPI utility model to
		// refine the seeded title from the first turn's fuller context, so this is
		// a no-op. The Claude SDK's own session summaries supersede it once available.
	}

	generateForkedTitle(_channel: ProtocolURI, _chatChannel: ProtocolURI | undefined, _turns: readonly Turn[], _fallbackTitle: string, _sourceTitle?: string): void {
		// Fallback-only titles in Clawdius mode: the caller already applied the
		// placeholder `Forked: …` title when creating the forked session/chat, and
		// there is no CAPI utility model to refine it from the inherited
		// conversation, so this is a no-op. The Claude SDK's own session summaries
		// supersede it once available.
	}

	cancelTitleGeneration(_session: ProtocolURI): void {
		// Fallback-only titles are produced synchronously; there is nothing async to cancel.
	}

	/** Trims, collapses whitespace, and length-caps a candidate title. */
	private _normalizeTitle(text: string): string {
		return text.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH);
	}

	/**
	 * The peer (additional) chat a seed should title, or `undefined` to title
	 * the session itself. The default chat maps to the session.
	 */
	private _additionalChatChannel(chatChannel?: ProtocolURI): ProtocolURI | undefined {
		return !!chatChannel && isAhpChatChannel(chatChannel) && !isDefaultChatUri(chatChannel) ? chatChannel : undefined;
	}

	/**
	 * Applies `title` to the addressed peer chat (`additionalChat`) or, when
	 * that is `undefined`, to the session itself, recording it as last-applied.
	 */
	private _applySeedTitle(channel: ProtocolURI, additionalChat: ProtocolURI | undefined, title: string): void {
		if (additionalChat) {
			this._applyTitle(additionalChat, title, t => this._stateManager.updateChatTitle(channel, additionalChat, t));
		} else {
			this._applyTitle(channel, title, t => this._stateManager.dispatchServerAction(channel, {
				type: ActionType.SessionTitleChanged,
				title: t,
			}));
		}
	}

	/** Persists `title` as the custom title of the addressed peer chat or session. */
	private _persistSeedTitle(channel: ProtocolURI, additionalChat: ProtocolURI | undefined, title: string): void {
		persistSessionMetadata(this._options.sessionDataService, this._logService, channel, additionalChat ? `customChatTitle:${additionalChat}` : 'customTitle', title);
	}

	private _applyTitle(key: ProtocolURI, title: string, dispatch: (title: string) => void): void {
		this._lastAppliedTitle.set(key, title);
		dispatch(title);
	}

	/**
	 * Whether {@link seedTitleFromFirstMessage} may (re)title `key`: true for a
	 * fresh, untitled target (its first message) or when its title is a
	 * provisional placeholder we applied and no one has changed it since — the
	 * first real request supersedes the placeholder.
	 */
	private _canSeedFirstMessageTitle(key: ProtocolURI, turnsLength: number, currentTitle: string | undefined): boolean {
		if (turnsLength === 0 && !currentTitle) {
			return true;
		}
		return this._provisionalTitles.has(key) && !!currentTitle && currentTitle === this._lastAppliedTitle.get(key);
	}

	/**
	 * Whether {@link seedProvisionalTitle} may (re)title `key`: true when it is
	 * untitled (the first message carried a suggestion) or when its title is a
	 * provisional placeholder we applied and no one has changed it since —
	 * successive suggestions keep the newest one visible without clobbering a
	 * manual rename.
	 */
	private _canSeedProvisionalTitle(key: ProtocolURI, currentTitle: string | undefined): boolean {
		if (!currentTitle) {
			return true;
		}
		return this._provisionalTitles.has(key) && currentTitle === this._lastAppliedTitle.get(key);
	}

	override dispose(): void {
		this._lastAppliedTitle.clear();
		this._provisionalTitles.clear();
		super.dispose();
	}
}
