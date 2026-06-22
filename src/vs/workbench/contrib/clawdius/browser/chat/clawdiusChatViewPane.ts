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
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentSubscription } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import { ActionType, SessionToolCallApprovedAction, SessionToolCallDeniedAction, SessionTurnCancelledAction, SessionTurnStartedAction } from '../../../../../platform/agentHost/common/state/sessionActions.js';
import { MessageKind, ResponsePartKind, StateComponents, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, TurnState, type SessionState, type ToolCallState } from '../../../../../platform/agentHost/common/state/sessionState.js';
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
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../webview/browser/webview.js';

/** A StringOrMarkdown (string | { markdown }) flattened to plain text for the SPA. */
function flattenStringOrMarkdown(value: string | { markdown: string } | undefined): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value && typeof value.markdown === 'string') {
		return value.markdown;
	}
	return '';
}

/** A renderable block in an assistant turn, serialized to the SPA over postMessage. */
type AssistantBlock =
	| { kind: 'markdown'; text: string }
	| { kind: 'reasoning'; text: string }
	| {
		kind: 'tool';
		id: string;
		name: string;
		status: string;
		invocation: string;
		pending?: boolean;
		confirmationTitle?: string;
		options?: { id: string; label: string; kind: string }[];
		success?: boolean;
		result?: string;
		errorText?: string;
		cancelled?: boolean;
	};

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

	// An OVERLAY webview (not a plain element): it is anchored over the pane body rather than parented into
	// it, so switching auxiliary-bar containers (which tears the ViewPane out of the DOM) cannot destroy its
	// content. It is claimed when the body is visible and released when hidden; its SPA state survives.
	private readonly _webview = this._register(new MutableDisposable<IOverlayWebview>());
	private _container: HTMLElement | undefined;
	private _rootContainer: HTMLElement | undefined;

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
		// Claim the overlay when the body becomes visible, release it when hidden (e.g. another auxiliary-bar
		// container is selected). This is what lets the chat survive container switches without going blank.
		this._register(this.onDidChangeBodyVisibility(() => this._updateVisibility()));
	}

	// This pane never shows the base view-welcome UI; its body is entirely the webview. Returning false keeps
	// the ViewWelcomeController (created by super.renderBody) inert so it cannot overlay or steal focus.
	override shouldShowWelcome(): boolean {
		return false;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// renderBody may run again after a container switch with a fresh container; create the overlay once,
		// then just re-anchor the existing one (its content - the live conversation - is preserved).
		this._container = container;
		this._rootContainer = undefined;

		if (!this._webview.value) {
			const webview = this._webviewService.createWebviewOverlay({
				providedViewType: this.id,
				title: localize('clawdius.chat.title', "Claude Code Chat"),
				options: {
					purpose: WebviewContentPurpose.WebviewView,
					disableServiceWorker: true,
				},
				contentOptions: {
					allowScripts: true,
				},
				extension: undefined,
			});
			this._webview.value = webview;
			this._register(webview.onMessage(e => this._onDidReceiveMessage(e.message)));
			webview.setHtml(this._renderHtml());
		}

		this._layoutWebview();
		this._updateVisibility();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._layoutWebview();
	}

	override focus(): void {
		super.focus();
		this._webview.value?.focus();
	}

	/** Claim the overlay while the body is visible, release it when hidden, so it survives container switches. */
	private _updateVisibility(): void {
		const webview = this._webview.value;
		if (!webview) {
			return;
		}
		if (this.isBodyVisible()) {
			webview.claim(this, dom.getWindow(this.element), undefined);
			this._layoutWebview();
		} else {
			webview.release(this);
		}
	}

	/** Position the overlay over the pane body, clipped to the scrollable root (mirrors WebviewViewPane). */
	private _layoutWebview(): void {
		const webview = this._webview.value;
		if (!this._container || !webview) {
			return;
		}
		if (!this._rootContainer || !this._rootContainer.isConnected) {
			this._rootContainer = dom.findParentWithClass(this._container, 'monaco-scrollable-element') ?? undefined;
		}
		webview.setAnchorElement(this._container, this._rootContainer);
	}

	private _onDidReceiveMessage(message: unknown): void {
		if (this._disposed || !message || typeof message !== 'object') {
			return;
		}
		const msg = message as { type?: string; text?: string; href?: string; toolCallId?: string; approved?: boolean; optionId?: string };
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
			case 'openLink': {
				// Markdown links from the assistant open externally through the trusted opener (the webview
				// itself cannot navigate under the strict CSP).
				const href = typeof msg.href === 'string' ? msg.href : '';
				if (href) {
					this.openerService.open(href, { openExternal: true }).catch(err => this._logService.warn('[clawdius-chat] open link failed', err));
				}
				break;
			}
			case 'toolConfirm': {
				this._respondToToolPermission(msg.toolCallId, msg.approved === true, typeof msg.optionId === 'string' ? msg.optionId : undefined);
				break;
			}
		}
	}

	/** Approve or deny a tool call that is awaiting permission, by dispatching the confirm action. */
	private _respondToToolPermission(toolCallId: string | undefined, approved: boolean, optionId: string | undefined): void {
		const turnId = this._activeTurnId;
		if (!turnId || !this._sessionUri || typeof toolCallId !== 'string') {
			return;
		}
		const action: SessionToolCallApprovedAction | SessionToolCallDeniedAction = approved
			? { type: ActionType.SessionToolCallConfirmed, turnId, toolCallId, approved: true, confirmed: ToolCallConfirmationReason.UserAction, selectedOptionId: optionId }
			: { type: ActionType.SessionToolCallConfirmed, turnId, toolCallId, approved: false, reason: ToolCallCancellationReason.Denied, selectedOptionId: optionId };
		try {
			this._agentHostService.dispatch(this._sessionUri.toString(), action);
		} catch (err) {
			this._logService.error('[clawdius-chat] failed to dispatch tool confirmation', err);
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

		// INC-2: render the full response stream in order - markdown, reasoning (thinking), and tool calls
		// (with inline permission cards). Re-derived from the authoritative state on each change so the parts
		// always hold the full state-so-far. Content refs and system notifications are deferred to a later step.
		const blocks: AssistantBlock[] = [];
		for (const part of turn.responseParts) {
			if (part.kind === ResponsePartKind.Markdown) {
				if (part.content) {
					blocks.push({ kind: 'markdown', text: part.content });
				}
			} else if (part.kind === ResponsePartKind.Reasoning) {
				if (part.content) {
					blocks.push({ kind: 'reasoning', text: part.content });
				}
			} else if (part.kind === ResponsePartKind.ToolCall) {
				blocks.push(this._toolBlock(part.toolCall));
			}
		}
		if (blocks.length > 0) {
			this._post({ type: 'setAssistantParts', id: turnId, blocks });
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
				if (blocks.length === 0) {
					this._post({ type: 'setAssistantParts', id: turnId, blocks: [{ kind: 'markdown', text: localize('clawdius.chat.noText', "Claude finished this turn without text output.") }] });
				}
				this._post({ type: 'assistantDone', id: turnId });
			}
		}
	}

	/** Project a ToolCallState into a serializable tool block for the SPA (status drives which fields exist). */
	private _toolBlock(tc: ToolCallState): AssistantBlock {
		const block: AssistantBlock = {
			kind: 'tool',
			id: tc.toolCallId,
			name: tc.displayName || tc.toolName,
			status: tc.status,
			invocation: flattenStringOrMarkdown(tc.invocationMessage),
		};
		switch (tc.status) {
			case ToolCallStatus.PendingConfirmation:
				block.pending = true;
				block.confirmationTitle = flattenStringOrMarkdown(tc.confirmationTitle);
				block.options = (tc.options ?? []).map(option => ({ id: option.id, label: option.label, kind: option.kind }));
				break;
			case ToolCallStatus.Completed:
				block.success = tc.success;
				block.result = flattenStringOrMarkdown(tc.pastTenseMessage);
				if (tc.error) {
					block.errorText = tc.error.message;
				}
				break;
			case ToolCallStatus.Cancelled:
				block.cancelled = true;
				break;
			default:
				break;
		}
		return block;
	}

	/** Post to the webview, guarded against a disposed pane / torn-down webview. */
	private _post(message: unknown): void {
		const webview = this._webview.value;
		if (this._disposed || !webview) {
			return;
		}
		try {
			void webview.postMessage(message);
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
		const strings = JSON.stringify({
			claude: claudeLabel,
			working: workingLabel,
			thinking: localize('clawdius.chat.thinking', "Thinking"),
			allow: localize('clawdius.chat.allow', "Allow"),
			deny: localize('clawdius.chat.deny', "Deny"),
			permissionTitle: localize('clawdius.chat.permissionTitle', "Permission required"),
			cancelled: localize('clawdius.chat.cancelled', "Cancelled"),
			statusStreaming: localize('clawdius.chat.statusStreaming', "Preparing..."),
			statusPending: localize('clawdius.chat.statusPending', "Awaiting approval"),
			statusRunning: localize('clawdius.chat.statusRunning', "Running..."),
			statusDone: localize('clawdius.chat.statusDone', "Done"),
			statusFailed: localize('clawdius.chat.statusFailed', "Failed"),
		})
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
		/* Rendered-markdown blocks (assistant responses). */
		.msg .bubble.markdown { white-space: normal; }
		.msg .bubble.markdown > :first-child { margin-top: 0; }
		.msg .bubble.markdown > :last-child { margin-bottom: 0; }
		.msg .bubble.markdown p { margin: 0 0 8px; }
		.msg .bubble.markdown h1, .msg .bubble.markdown h2, .msg .bubble.markdown h3,
		.msg .bubble.markdown h4, .msg .bubble.markdown h5, .msg .bubble.markdown h6 { margin: 12px 0 6px; font-weight: 600; line-height: 1.3; }
		.msg .bubble.markdown h1 { font-size: 1.4em; }
		.msg .bubble.markdown h2 { font-size: 1.25em; }
		.msg .bubble.markdown h3 { font-size: 1.1em; }
		.msg .bubble.markdown ul, .msg .bubble.markdown ol { margin: 0 0 8px; padding-left: 22px; }
		.msg .bubble.markdown li { margin: 2px 0; }
		.msg .bubble.markdown blockquote { margin: 0 0 8px; padding: 2px 0 2px 10px; border-left: 3px solid var(--vscode-textBlockQuote-border, var(--clawdius-orange)); color: var(--vscode-descriptionForeground); }
		.msg .bubble.markdown code.inline-code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 1px 4px; border-radius: 4px; }
		.msg .bubble.markdown pre.code-block { margin: 0 0 8px; padding: 10px 12px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; overflow-x: auto; }
		.msg .bubble.markdown pre.code-block code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; white-space: pre; }
		.msg .bubble.markdown a.md-link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
		.msg .bubble.markdown a.md-link:hover { text-decoration: underline; }
		/* Tool cards, thinking blocks, permission cards (INC-2). */
		.tool-card { margin: 6px 0; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.06)); overflow: hidden; }
		.tool-header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
		.tool-name { font-weight: 600; font-size: 0.92em; }
		.tool-badge { margin-left: auto; font-size: 0.78em; padding: 1px 7px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
		.tool-card.status-completed .tool-badge { background: var(--clawdius-button-bg); color: var(--clawdius-ivory); }
		.tool-card.status-cancelled .tool-badge { background: var(--vscode-errorForeground); color: var(--clawdius-ivory); }
		.tool-invocation { padding: 0 10px 8px; font-size: 0.88em; color: var(--vscode-descriptionForeground); white-space: pre-wrap; word-break: break-word; }
		.tool-result { padding: 0 10px 8px; font-size: 0.88em; white-space: pre-wrap; word-break: break-word; }
		.tool-error { padding: 0 10px 8px; font-size: 0.88em; color: var(--vscode-errorForeground); white-space: pre-wrap; word-break: break-word; }
		.tool-cancelled { padding: 0 10px 8px; font-size: 0.85em; color: var(--vscode-descriptionForeground); font-style: italic; }
		.tool-perm { padding: 6px 10px 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
		.perm-title { flex-basis: 100%; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
		.perm-btn { height: 28px; padding: 0 12px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px; font-family: inherit; font-size: 0.86em; cursor: pointer; background: var(--vscode-input-background); color: var(--vscode-foreground); }
		.perm-btn:disabled { opacity: 0.5; cursor: default; }
		.perm-allow { background: var(--clawdius-button-bg); color: var(--clawdius-ivory); border-color: transparent; }
		.perm-allow:hover { background: var(--clawdius-clay); }
		.perm-deny:hover { border-color: var(--vscode-errorForeground); }
		details.thinking { margin: 4px 0; border-left: 2px solid var(--vscode-widget-border, rgba(127,127,127,0.3)); padding-left: 8px; }
		details.thinking > summary { cursor: pointer; font-size: 0.85em; color: var(--vscode-descriptionForeground); font-style: italic; list-style: none; user-select: none; }
		details.thinking > summary::-webkit-details-marker { display: none; }
		.thinking-body { margin-top: 4px; font-size: 0.92em; color: var(--vscode-descriptionForeground); }
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
			// Tool calls the user has already approved/denied. Persisted across the frequent full-rebuilds so a
			// re-rendered permission card cannot re-enable its buttons and allow a double-approval.
			const respondedTools = Object.create(null);
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

			// Inline markdown: code, bold, italic, links. Manual scan (no regex) so the source stays free of
			// backslashes/backticks that the outer TS template literal would mangle. Builds DOM nodes via
			// textContent only - never innerHTML - so it is XSS-safe under the strict CSP.
			function renderInline(parent, text) {
				const BT = String.fromCharCode(96);
				let i = 0;
				let buf = '';
				function flush() {
					if (buf) { parent.appendChild(document.createTextNode(buf)); buf = ''; }
				}
				while (i < text.length) {
					const ch = text[i];
					if (ch === BT) {
						const end = text.indexOf(BT, i + 1);
						if (end > i) {
							flush();
							const c = document.createElement('code');
							c.className = 'inline-code';
							c.textContent = text.slice(i + 1, end);
							parent.appendChild(c);
							i = end + 1;
							continue;
						}
					}
					if ((ch === '*' && text[i + 1] === '*') || (ch === '_' && text[i + 1] === '_')) {
						const marker = ch + ch;
						const end = text.indexOf(marker, i + 2);
						if (end > i + 1) {
							flush();
							const strong = document.createElement('strong');
							renderInline(strong, text.slice(i + 2, end));
							parent.appendChild(strong);
							i = end + 2;
							continue;
						}
					}
					if (ch === '*' || ch === '_') {
						const end = text.indexOf(ch, i + 1);
						if (end > i) {
							flush();
							const em = document.createElement('em');
							renderInline(em, text.slice(i + 1, end));
							parent.appendChild(em);
							i = end + 1;
							continue;
						}
					}
					if (ch === '[') {
						const closeBracket = text.indexOf(']', i + 1);
						if (closeBracket > i && text[closeBracket + 1] === '(') {
							const closeParen = text.indexOf(')', closeBracket + 2);
							if (closeParen > closeBracket) {
								flush();
								const a = document.createElement('a');
								a.className = 'md-link';
								a.textContent = text.slice(i + 1, closeBracket);
								a.setAttribute('data-href', text.slice(closeBracket + 2, closeParen));
								parent.appendChild(a);
								i = closeParen + 1;
								continue;
							}
						}
					}
					buf += ch;
					i++;
				}
				flush();
			}

			// Block-level markdown -> DOM: fenced code, headings, lists, blockquotes, paragraphs.
			function renderMarkdown(md) {
				const NL = String.fromCharCode(10);
				const BT = String.fromCharCode(96);
				const FENCE = BT + BT + BT;
				const frag = document.createDocumentFragment();
				const lines = md.split(NL);
				function orderedItem(s) {
					let j = 0;
					while (j < s.length && s[j] >= '0' && s[j] <= '9') { j++; }
					if (j > 0 && s[j] === '.' && s[j + 1] === ' ') { return s.slice(j + 2); }
					return null;
				}
				function unorderedItem(s) {
					if (s.startsWith('- ') || s.startsWith('* ') || s.startsWith('+ ')) { return s.slice(2); }
					return null;
				}
				let i = 0;
				while (i < lines.length) {
					const t = lines[i].trimStart();
					if (t.startsWith(FENCE)) {
						i++;
						const code = [];
						while (i < lines.length && !lines[i].trimStart().startsWith(FENCE)) { code.push(lines[i]); i++; }
						i++;
						const pre = document.createElement('pre');
						pre.className = 'code-block';
						const codeEl = document.createElement('code');
						codeEl.textContent = code.join(NL);
						pre.appendChild(codeEl);
						frag.appendChild(pre);
						continue;
					}
					if (t.startsWith('#')) {
						let level = 0;
						while (level < t.length && t[level] === '#') { level++; }
						if (level >= 1 && level <= 6 && t[level] === ' ') {
							const h = document.createElement('h' + level);
							renderInline(h, t.slice(level + 1));
							frag.appendChild(h);
							i++;
							continue;
						}
					}
					if (t.startsWith('>')) {
						const quote = [];
						while (i < lines.length && lines[i].trimStart().startsWith('>')) {
							let q = lines[i].trimStart().slice(1);
							if (q.startsWith(' ')) { q = q.slice(1); }
							quote.push(q);
							i++;
						}
						const bq = document.createElement('blockquote');
						bq.appendChild(renderMarkdown(quote.join(NL)));
						frag.appendChild(bq);
						continue;
					}
					if (unorderedItem(t) !== null || orderedItem(t) !== null) {
						const ordered = orderedItem(t) !== null;
						const listEl = document.createElement(ordered ? 'ol' : 'ul');
						while (i < lines.length) {
							const lt = lines[i].trimStart();
							const content = ordered ? orderedItem(lt) : unorderedItem(lt);
							if (content === null) { break; }
							const li = document.createElement('li');
							renderInline(li, content);
							listEl.appendChild(li);
							i++;
						}
						frag.appendChild(listEl);
						continue;
					}
					if (t === '') { i++; continue; }
					const para = [];
					while (i < lines.length) {
						const pt = lines[i].trimStart();
						if (pt === '' || pt.startsWith(FENCE) || pt.startsWith('>') || pt.startsWith('#')) { break; }
						if (unorderedItem(pt) !== null || orderedItem(pt) !== null) { break; }
						para.push(lines[i]);
						i++;
					}
					const p = document.createElement('p');
					renderInline(p, para.join(NL));
					frag.appendChild(p);
				}
				return frag;
			}

			function toolStatusLabel(status, block) {
				if (status === 'streaming') { return STRINGS.statusStreaming; }
				if (status === 'pending-confirmation') { return STRINGS.statusPending; }
				if (status === 'running' || status === 'pending-result-confirmation') { return STRINGS.statusRunning; }
				if (status === 'completed') { return block && block.success === false ? STRINGS.statusFailed : STRINGS.statusDone; }
				if (status === 'cancelled') { return STRINGS.cancelled; }
				return status;
			}

			function renderReasoning(text) {
				const d = document.createElement('details');
				d.className = 'thinking';
				const s = document.createElement('summary');
				s.textContent = STRINGS.thinking;
				d.appendChild(s);
				const body = document.createElement('div');
				body.className = 'thinking-body markdown';
				body.appendChild(renderMarkdown(text));
				d.appendChild(body);
				return d;
			}

			function renderPermission(block) {
				const wrap = document.createElement('div');
				wrap.className = 'tool-perm';
				const title = document.createElement('div');
				title.className = 'perm-title';
				title.textContent = block.confirmationTitle || STRINGS.permissionTitle;
				wrap.appendChild(title);
				const responded = !!respondedTools[block.id];
				let opts = block.options && block.options.length ? block.options : null;
				if (!opts) {
					opts = [{ id: '', label: STRINGS.allow, kind: 'approve' }, { id: '', label: STRINGS.deny, kind: 'deny' }];
				}
				for (let k = 0; k < opts.length; k++) {
					const o = opts[k];
					const btn = document.createElement('button');
					btn.type = 'button';
					btn.className = 'perm-btn ' + (o.kind === 'deny' ? 'perm-deny' : 'perm-allow');
					btn.textContent = o.label;
					btn.disabled = responded;
					btn.addEventListener('click', function () {
						if (respondedTools[block.id]) { return; }
						respondedTools[block.id] = true;
						vscode.postMessage({ type: 'toolConfirm', toolCallId: block.id, approved: o.kind === 'approve', optionId: o.id || undefined });
						const all = wrap.querySelectorAll('button');
						for (let j = 0; j < all.length; j++) { all[j].disabled = true; }
					});
					wrap.appendChild(btn);
				}
				return wrap;
			}

			function renderTool(block) {
				const card = document.createElement('div');
				card.className = 'tool-card status-' + block.status;
				const header = document.createElement('div');
				header.className = 'tool-header';
				const name = document.createElement('span');
				name.className = 'tool-name';
				name.textContent = block.name;
				header.appendChild(name);
				const badge = document.createElement('span');
				badge.className = 'tool-badge';
				badge.textContent = toolStatusLabel(block.status, block);
				header.appendChild(badge);
				card.appendChild(header);
				if (block.invocation) {
					const inv = document.createElement('div');
					inv.className = 'tool-invocation';
					inv.textContent = block.invocation;
					card.appendChild(inv);
				}
				if (block.pending) {
					card.appendChild(renderPermission(block));
				}
				if (block.status === 'completed') {
					if (block.result) {
						const r = document.createElement('div');
						r.className = 'tool-result';
						r.textContent = block.result;
						card.appendChild(r);
					}
					if (block.errorText) {
						const e = document.createElement('div');
						e.className = 'tool-error';
						e.textContent = block.errorText;
						card.appendChild(e);
					}
				}
				if (block.cancelled) {
					const c = document.createElement('div');
					c.className = 'tool-cancelled';
					c.textContent = STRINGS.cancelled;
					card.appendChild(c);
				}
				return card;
			}

			function setAssistantParts(id, blocks) {
				const bubble = ensureAssistant(id);
				const stick = isNearBottom();
				bubble.classList.remove('pending');
				bubble.classList.add('markdown');
				bubble.textContent = '';
				for (let k = 0; k < blocks.length; k++) {
					const b = blocks[k];
					if (b.kind === 'markdown') { bubble.appendChild(renderMarkdown(b.text)); }
					else if (b.kind === 'reasoning') { bubble.appendChild(renderReasoning(b.text)); }
					else if (b.kind === 'tool') { bubble.appendChild(renderTool(b)); }
				}
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

			// Markdown links cannot navigate the webview (strict CSP); route clicks to the host to open them.
			messages.addEventListener('click', function (e) {
				let el = e.target;
				while (el && el !== messages) {
					if (el.classList && el.classList.contains('md-link')) {
						e.preventDefault();
						const href = el.getAttribute('data-href');
						if (href) { vscode.postMessage({ type: 'openLink', href: href }); }
						return;
					}
					el = el.parentNode;
				}
			});

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
					case 'setAssistantParts':
						if (typeof m.id === 'string' && Array.isArray(m.blocks)) { setAssistantParts(m.id, m.blocks); }
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
