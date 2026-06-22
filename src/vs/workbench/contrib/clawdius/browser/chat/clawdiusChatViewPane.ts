/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native webview Claude chat (Phase 3 INC-1: agent-host text round-trip)
// The native Claude chat ViewPane. It hosts a first-party webview (NOT the extension-backed
// WebviewViewPane) whose SPA is a faithful, from-scratch replica of the official Claude Code plugin chat -
// warm palette, message list, composer. The ViewPane is the BRIDGE: the webview iframe cannot import
// workbench services, so this pane owns the agent-host Claude session and relays to/from the SPA over
// postMessage. INC-1 drives a real turn: on submit it lazily creates a `claude` session via
// IAgentHostService, dispatches a SessionTurnStarted action, subscribes to the session state, and streams
// the assistant's markdown text into the SPA (reading the authoritative SessionState on each change rather
// than hand-accumulating deltas). Tool cards / thinking / diffs / permissions are INC-2+. The SPA loads
// only local assets with zero network egress (CSP default-src 'none').

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentSubscription } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import { ActionType, SessionTurnCancelledAction, SessionTurnStartedAction } from '../../../../../platform/agentHost/common/state/sessionActions.js';
import { MessageKind, ResponsePartKind, StateComponents, TurnState, type MarkdownResponsePart, type SessionState } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../webview/browser/webview.js';

/** Escape text that is interpolated into the webview HTML so a stray character cannot break markup. */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export class ClawdiusChatViewPane extends ViewPane {

	private _webview: IWebviewElement | undefined;
	private _webviewContainer: HTMLElement | undefined;

	// Agent-host session state (created lazily on the first user turn).
	private readonly _sessionDisposables = this._register(new DisposableStore());
	private _sessionUri: URI | undefined;
	private _subscription: IAgentSubscription<SessionState> | undefined;
	private _activeTurnId: string | undefined;
	private _sessionInit: Promise<URI> | undefined;
	private _isTurning = false;
	private _disposed = false;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	// This pane never shows the base view-welcome UI; its body is entirely the webview. Returning false keeps
	// the ViewWelcomeController (created by super.renderBody) inert so it cannot overlay or steal focus.
	override shouldShowWelcome(): boolean {
		return false;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// renderBody is called once per pane lifetime, but guard against re-entry so a second call can never
		// orphan a mounted webview (its DOM is destroyed if the parent hierarchy changes).
		if (this._webview) {
			return;
		}

		this._webviewContainer = dom.append(container, dom.$('.clawdius-chat-webview'));
		this._webviewContainer.style.width = '100%';
		this._webviewContainer.style.height = '100%';

		const webview = this._register(this._webviewService.createWebviewElement({
			title: localize('clawdius.chat.title', "Claude Code Chat"),
			options: {
				purpose: WebviewContentPurpose.WebviewView,
				disableServiceWorker: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
			},
			extension: undefined,
		}));
		this._webview = webview;

		webview.mountTo(this._webviewContainer, dom.getWindow(container));
		this._register(webview.onMessage(e => this._onDidReceiveMessage(e.message)));
		webview.setHtml(this._renderHtml());
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._webviewContainer) {
			this._webviewContainer.style.width = `${width}px`;
			this._webviewContainer.style.height = `${height}px`;
		}
	}

	override focus(): void {
		super.focus();
		this._webview?.focus();
	}

	private _onDidReceiveMessage(message: unknown): void {
		if (!this._webview || !message || typeof message !== 'object') {
			return;
		}
		const msg = message as { type?: string; text?: string };
		switch (msg.type) {
			case 'submit': {
				const text = typeof msg.text === 'string' ? msg.text.trim() : '';
				if (!text) {
					return;
				}
				this._post({ type: 'appendUser', text });
				void this._startTurn(text);
				break;
			}
		}
	}

	/**
	 * Lazily create the Claude agent-host session + state subscription. Created on the first user turn so
	 * opening the pane never spawns a Claude session until the user actually chats. Concurrent callers share
	 * the in-flight promise; a failed init is cleared so a later turn can retry.
	 */
	private _ensureSession(): Promise<URI> {
		if (!this._sessionInit) {
			this._sessionInit = (async () => {
				const workingDirectory = this._workspaceContextService.getWorkspace().folders[0]?.uri;
				const uri = await this._agentHostService.createSession({ provider: 'claude', workingDirectory });
				if (this._disposed) {
					// The pane was disposed while the session was being created: free the orphaned session.
					this._agentHostService.disposeSession(uri).catch(err => this._logService.error('[clawdius-chat] disposeSession (orphaned) failed', err));
					throw new Error('clawdius-chat: pane disposed during session creation');
				}
				this._sessionUri = uri;
				const ref = this._agentHostService.getSubscription(StateComponents.Session, uri, 'ClawdiusChatViewPane');
				// Tie the subscription reference AND its listener to a session-scoped store, disposed first in
				// dispose() so onDidChange can never fire after teardown begins.
				this._sessionDisposables.add(ref);
				this._subscription = ref.object;
				this._sessionDisposables.add(ref.object.onDidChange(() => this._onSessionStateChange()));
				return uri;
			})();
			this._sessionInit.catch(() => { this._sessionInit = undefined; });
		}
		return this._sessionInit;
	}

	/** Send the user's prompt as a new turn and stream the assistant response back to the SPA. */
	private async _startTurn(text: string): Promise<void> {
		// ViewPane-level serialization (belt-and-suspenders with the SPA's `busy` flag): never dispatch a
		// second turn while one is in flight, which would overwrite _activeTurnId and orphan the first turn.
		if (this._isTurning) {
			return;
		}
		this._isTurning = true;

		let uri: URI;
		try {
			uri = await this._ensureSession();
		} catch (err) {
			this._isTurning = false;
			if (this._disposed) {
				return;
			}
			this._logService.error('[clawdius-chat] failed to create Claude session', err);
			this._post({ type: 'chatError', text: localize('clawdius.chat.sessionError', "Could not start a Claude session. Check that the Claude Code engine is configured.") });
			return;
		}
		if (this._disposed) {
			this._isTurning = false;
			return;
		}

		const turnId = generateUuid();
		this._activeTurnId = turnId;
		this._post({ type: 'assistantPending', id: turnId });

		const action: SessionTurnStartedAction = {
			type: ActionType.SessionTurnStarted,
			turnId,
			message: { text, origin: { kind: MessageKind.User } },
		};
		try {
			this._agentHostService.dispatch(uri.toString(), action);
		} catch (err) {
			this._logService.error('[clawdius-chat] failed to dispatch turn', err);
			this._activeTurnId = undefined;
			this._isTurning = false;
			this._post({ type: 'chatError', text: localize('clawdius.chat.dispatchError', "Could not send your message to Claude."), id: turnId });
		}
	}

	/**
	 * Re-derive the active turn's assistant text from the authoritative SessionState on each change and push
	 * it to the SPA. Reading state (rather than accumulating raw deltas) keeps the bridge simple and correct:
	 * the markdown response parts always hold the full text-so-far.
	 */
	private _onSessionStateChange(): void {
		if (this._disposed) {
			return;
		}
		const turnId = this._activeTurnId;
		const subscription = this._subscription;
		if (!turnId || !subscription || !this._webview) {
			return;
		}
		const state = subscription.value;
		if (state instanceof Error) {
			this._logService.warn('[clawdius-chat] session subscription error', state);
			return;
		}
		if (!state) {
			return;
		}

		const active = state.activeTurn?.id === turnId ? state.activeTurn : undefined;
		const completed = active ? undefined : state.turns.find(turn => turn.id === turnId);
		const turn = active ?? completed;
		if (!turn) {
			return;
		}

		// INC-1: text only. Concatenate markdown response parts in stream order. Tool calls, reasoning,
		// content refs and system notifications are deferred to INC-2; a turn that produces only those leaves
		// no markdown, handled by the completion fallback below.
		const text = turn.responseParts
			.filter((part): part is MarkdownResponsePart => part.kind === ResponsePartKind.Markdown)
			.map(part => part.content)
			.join('');
		if (text) {
			this._post({ type: 'setAssistant', id: turnId, text });
		}

		if (completed) {
			// A turn has exactly one terminal signal: chatError (with the bubble id, so the SPA can clear the
			// pending bubble) OR assistantDone - never both.
			this._activeTurnId = undefined;
			this._isTurning = false;
			if (completed.state === TurnState.Error) {
				const errorText = completed.error?.message || localize('clawdius.chat.turnError', "Claude could not complete the response.");
				this._post({ type: 'chatError', text: errorText, id: turnId });
			} else {
				if (!text) {
					this._post({ type: 'setAssistant', id: turnId, text: localize('clawdius.chat.noText', "Claude finished this turn without text output.") });
				}
				this._post({ type: 'assistantDone', id: turnId });
			}
		}
	}

	/** Post to the webview, guarded against a disposed pane / torn-down webview. */
	private _post(message: unknown): void {
		if (this._disposed || !this._webview) {
			return;
		}
		try {
			void this._webview.postMessage(message);
		} catch (err) {
			this._logService.debug('[clawdius-chat] postMessage failed (webview likely disposed)', err);
		}
	}

	override dispose(): void {
		this._disposed = true;
		// Detach the subscription + its onDidChange listener FIRST so no state callback runs during teardown.
		this._sessionDisposables.dispose();
		this._subscription = undefined;
		if (this._sessionUri) {
			if (this._activeTurnId) {
				const cancel: SessionTurnCancelledAction = { type: ActionType.SessionTurnCancelled, turnId: this._activeTurnId };
				try {
					this._agentHostService.dispatch(this._sessionUri.toString(), cancel);
				} catch {
					// best-effort cancel on teardown
				}
				this._activeTurnId = undefined;
			}
			this._agentHostService.disposeSession(this._sessionUri).catch(err => this._logService.error('[clawdius-chat] disposeSession failed', err));
			this._sessionUri = undefined;
		}
		super.dispose();
	}

	private _renderHtml(): string {
		const nonce = generateUuid();

		const claudeLabel = localize('clawdius.chat.claude', "Claude");
		const headerTitle = localize('clawdius.chat.headerTitle', "Claude Code");
		const welcomeHeading = localize('clawdius.chat.welcomeHeading', "Chat with Claude");
		const welcomeSubtext = localize('clawdius.chat.welcomeSubtext', "Ask questions, request changes, or get help understanding your code.");
		const placeholder = localize('clawdius.chat.placeholder', "Ask Claude...");
		const sendLabel = localize('clawdius.chat.send', "Send");
		const workingLabel = localize('clawdius.chat.working', "Working...");

		// Localized strings used by the client script are passed as a JSON-encoded constant so translations
		// are escaped correctly and never break out of the <script> element. JSON.stringify escapes quotes and
		// </script>, but not the U+2028 / U+2029 separators, which are valid JSON yet break a JS expression -
		// so escape those too.
		const strings = JSON.stringify({ claude: claudeLabel, working: workingLabel })
			.replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
			.replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
	<style nonce="${nonce}">
		:root {
			--clawdius-orange: #d97757;
			--clawdius-clay: #c6613f;
			--clawdius-ivory: #faf9f5;
			/* Send button uses a deeper orange so ivory text clears WCAG AA (4.5:1); brand --clawdius-orange */
			/* (#d97757) is reserved for non-text accents (focus ring, status dot, welcome mark). */
			--clawdius-button-bg: #b85c40;
		}
		* { box-sizing: border-box; }
		html, body {
			margin: 0;
			padding: 0;
			height: 100%;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size, 13px);
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background, var(--vscode-editor-background));
		}
		body { display: flex; flex-direction: column; }
		.header {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
			font-weight: 600;
		}
		.header .dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: var(--clawdius-orange);
		}
		.messages {
			flex: 1 1 auto;
			overflow-y: auto;
			padding: 12px;
			display: flex;
			flex-direction: column;
			gap: 12px;
		}
		.welcome {
			margin: auto;
			max-width: 320px;
			text-align: center;
			color: var(--vscode-descriptionForeground);
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 8px;
		}
		.welcome .mark {
			width: 40px;
			height: 40px;
			border-radius: 12px;
			background: var(--clawdius-orange);
			display: flex;
			align-items: center;
			justify-content: center;
			color: var(--clawdius-ivory);
			font-weight: 700;
			font-size: 20px;
		}
		.welcome h1 { margin: 4px 0 0; font-size: 16px; color: var(--vscode-foreground); }
		.welcome p { margin: 0; font-size: 13px; line-height: 1.5; }
		.msg { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
		.msg .who {
			font-size: 11px;
			font-weight: 600;
			color: var(--vscode-descriptionForeground);
		}
		.msg .bubble {
			white-space: pre-wrap;
			word-break: break-word;
			line-height: 1.5;
		}
		.msg.user {
			align-self: flex-end;
			max-width: 85%;
		}
		.msg.user .bubble {
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 10px;
			padding: 8px 12px;
		}
		.msg.assistant .who { color: var(--clawdius-orange); }
		.msg .bubble.pending { color: var(--vscode-descriptionForeground); font-style: italic; }
		.msg.error .bubble {
			color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
			background: var(--vscode-inputValidation-errorBackground, transparent);
			border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
			border-radius: 8px;
			padding: 8px 12px;
		}
		.composer {
			flex: 0 0 auto;
			display: flex;
			align-items: flex-end;
			gap: 8px;
			padding: 8px 12px 12px;
			border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
		}
		.composer textarea {
			flex: 1 1 auto;
			resize: none;
			min-height: 36px;
			max-height: 160px;
			padding: 8px 10px;
			border-radius: 8px;
			border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			font-family: inherit;
			font-size: inherit;
			line-height: 1.4;
			outline: none;
		}
		.composer textarea:focus { border-color: var(--clawdius-orange); }
		.composer textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
		.composer .send {
			flex: 0 0 auto;
			height: 36px;
			padding: 0 14px;
			border: none;
			border-radius: 8px;
			background: var(--clawdius-button-bg);
			color: var(--clawdius-ivory);
			font-family: inherit;
			font-size: inherit;
			font-weight: 600;
			cursor: pointer;
		}
		.composer .send:hover { background: var(--clawdius-clay); }
		.composer .send:focus-visible { outline: 2px solid var(--clawdius-orange); outline-offset: 2px; }
		.composer .send:disabled {
			cursor: default;
			background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
			color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
		}
	</style>
</head>
<body>
	<div class="header"><span class="dot"></span><span>${escapeHtml(headerTitle)}</span></div>
	<div class="messages" id="messages" role="log">
		<div class="welcome" id="welcome">
			<div class="mark" aria-hidden="true">C</div>
			<h1>${escapeHtml(welcomeHeading)}</h1>
			<p>${escapeHtml(welcomeSubtext)}</p>
		</div>
	</div>
	<div class="composer">
		<textarea id="input" rows="1" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}"></textarea>
		<button class="send" id="send" type="button" disabled aria-label="${escapeHtml(sendLabel)}">${escapeHtml(sendLabel)}</button>
	</div>
	<script nonce="${nonce}">
		(function () {
			const vscode = acquireVsCodeApi();
			const STRINGS = ${strings};
			const messages = document.getElementById('messages');
			const welcome = document.getElementById('welcome');
			const input = document.getElementById('input');
			const send = document.getElementById('send');
			const assistantBubbles = Object.create(null);
			// While a turn is streaming we are 'busy': the composer is disabled so INC-1 serializes turns
			// (one in flight at a time) rather than orphaning the active turn with a concurrent dispatch.
			let busy = false;

			function clearWelcome() {
				if (welcome && welcome.parentNode) { welcome.remove(); }
			}
			// Only auto-scroll while the user is already near the bottom, so streaming updates never yank a
			// user who scrolled up to read earlier output.
			function isNearBottom() {
				return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
			}
			function toBottom() {
				messages.scrollTop = messages.scrollHeight;
			}

			function addUser(text) {
				clearWelcome();
				const msg = document.createElement('div');
				msg.className = 'msg user';
				const bubble = document.createElement('div');
				bubble.className = 'bubble';
				bubble.textContent = text;
				msg.appendChild(bubble);
				messages.appendChild(msg);
				toBottom();
			}

			function ensureAssistant(id) {
				if (assistantBubbles[id]) { return assistantBubbles[id]; }
				clearWelcome();
				const msg = document.createElement('div');
				msg.className = 'msg assistant';
				msg.setAttribute('data-turn', id);
				const who = document.createElement('div');
				who.className = 'who';
				who.textContent = STRINGS.claude;
				msg.appendChild(who);
				const bubble = document.createElement('div');
				bubble.className = 'bubble pending';
				bubble.textContent = STRINGS.working;
				msg.appendChild(bubble);
				messages.appendChild(msg);
				assistantBubbles[id] = bubble;
				toBottom();
				return bubble;
			}

			function setAssistant(id, text) {
				const bubble = ensureAssistant(id);
				const stick = isNearBottom();
				bubble.classList.remove('pending');
				bubble.textContent = text;
				if (stick) { toBottom(); }
			}

			function doneAssistant(id) {
				const bubble = assistantBubbles[id];
				if (bubble) { bubble.classList.remove('pending'); }
			}

			function removeAssistant(id) {
				const bubble = assistantBubbles[id];
				if (bubble && bubble.parentNode) { bubble.parentNode.remove(); }
				delete assistantBubbles[id];
			}

			function showError(text) {
				clearWelcome();
				const msg = document.createElement('div');
				msg.className = 'msg error';
				const bubble = document.createElement('div');
				bubble.className = 'bubble';
				bubble.textContent = text;
				msg.appendChild(bubble);
				messages.appendChild(msg);
				toBottom();
			}

			function updateSendState() {
				send.disabled = busy || input.value.trim().length === 0;
			}

			function submit() {
				if (busy) { return; }
				const text = input.value.trim();
				if (!text) { return; }
				vscode.postMessage({ type: 'submit', text: text });
				input.value = '';
				input.style.height = 'auto';
				updateSendState();
			}

			input.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					submit();
				}
			});
			input.addEventListener('input', function () {
				input.style.height = 'auto';
				input.style.height = Math.min(input.scrollHeight, 160) + 'px';
				updateSendState();
			});
			send.addEventListener('click', submit);

			window.addEventListener('message', function (event) {
				const m = event.data;
				if (!m || typeof m.type !== 'string') { return; }
				switch (m.type) {
					case 'appendUser':
						if (typeof m.text === 'string') { addUser(m.text); }
						break;
					case 'assistantPending':
						if (typeof m.id === 'string') { ensureAssistant(m.id); busy = true; updateSendState(); }
						break;
					case 'setAssistant':
						if (typeof m.id === 'string' && typeof m.text === 'string') { setAssistant(m.id, m.text); }
						break;
					case 'assistantDone':
						if (typeof m.id === 'string') { doneAssistant(m.id); }
						busy = false; updateSendState(); input.focus();
						break;
					case 'chatError':
						if (typeof m.id === 'string') { removeAssistant(m.id); }
						if (typeof m.text === 'string') { showError(m.text); }
						busy = false; updateSendState(); input.focus();
						break;
				}
			});

			vscode.postMessage({ type: 'ready' });
			input.focus();
		}());
	</script>
</body>
</html>`;
	}
}
// CLAWDIUS-END
