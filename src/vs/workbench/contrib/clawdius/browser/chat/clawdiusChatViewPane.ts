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
import { ActionType, SessionModelChangedAction, SessionToolCallApprovedAction, SessionToolCallDeniedAction, SessionTurnStartedAction } from '../../../../../platform/agentHost/common/state/sessionActions.js';
import { getToolFileEdits, MessageKind, ResponsePartKind, StateComponents, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ISessionFileDiff, type ResponsePart, type SessionState, type ToolCallState, type ToolResultContent, type UsageInfo } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../webview/browser/webview.js';
import { IClawdiusChatSessionService } from './clawdiusChatSessionService.js';
import { ClawdiusTodoCall, ClawdiusTodoItem, classifyTodoCall, parseTodoInput, selectLiveTodoCallId } from '../../common/clawdiusChatTodos.js';

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
	| { kind: 'todos'; id: string; todos: { content: string; status: string }[] }
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
		output?: string;
		edits?: { path: string; added: number; removed: number; change: string }[];
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

	// The Claude session lives in the window-scoped IClawdiusChatSessionService and OUTLIVES this pane; the pane
	// subscribes/dispatches against it and re-derives the full conversation from SessionState on each attach.
	private readonly _sessionDisposables = this._register(new DisposableStore());
	private _sessionUri: URI | undefined;
	private _subscription: IAgentSubscription<SessionState> | undefined;
	private _activeTurnId: string | undefined;
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
		@IClawdiusChatSessionService private readonly _chatSessionService: IClawdiusChatSessionService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		// Claim the overlay when the body becomes visible, release it when hidden (e.g. another auxiliary-bar
		// container is selected). This is what lets the chat survive container switches without going blank.
		this._register(this.onDidChangeBodyVisibility(() => this._updateVisibility()));
		// Keep the header model picker in sync as the agent host advertises models (they can arrive after the
		// pane is built). The current selection is derived from session state and pushed in _renderConversation.
		this._register(this._agentHostService.rootState.onDidChange(() => this._postModels()));
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
			// Reattach to the window's persistent session (if one exists) and repaint, so reopening the chat
			// restores the conversation instead of looking empty.
			const existing = this._chatSessionService.getSession();
			if (existing) {
				this._attachToSession(existing);
			}
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
		const msg = message as { type?: string; text?: string; href?: string; toolCallId?: string; approved?: boolean; optionId?: string; modelId?: string };
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
			case 'ready': {
				// The SPA finished loading: attach to the window's existing session (if any) and paint it, then
				// fill the header model picker (models come from the agent-host root state, not the session, so
				// they show even before the first turn).
				const existing = this._chatSessionService.getSession();
				if (existing) {
					this._attachToSession(existing);
				}
				this._postModels();
				break;
			}
			case 'setModel': {
				this._setModel(typeof msg.modelId === 'string' ? msg.modelId : undefined);
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

	/** Push the available Claude models (from the agent-host root state) plus the session's current selection
	 *  to the SPA, which paints the header picker. Safe to call before a session exists. */
	private _postModels(): void {
		if (this._disposed || !this._webview.value) {
			return;
		}
		const root = this._agentHostService.rootState.value;
		let models: { id: string; name: string }[] = [];
		if (root && !(root instanceof Error)) {
			const claude = root.agents.find(agent => agent.provider === 'claude');
			if (claude) {
				models = claude.models.map(model => ({ id: model.id, name: model.name }));
			}
		}
		const state = this._subscription?.value;
		const current = state && !(state instanceof Error) ? state.summary.model?.id : undefined;
		this._post({ type: 'setModels', models, current });
	}

	/** Switch the session's model by dispatching a model-changed action. Per the protocol the server defers the
	 *  change to the next turn when one is active, so this is safe to call at any time. */
	private _setModel(modelId: string | undefined): void {
		if (!this._sessionUri || typeof modelId !== 'string' || !modelId) {
			return;
		}
		// Preserve the existing model config when switching ids. SessionModelChanged replaces summary.model
		// VERBATIM, so dispatching { id } alone would erase a configured thinkingLevel (which drives reasoning
		// effort via resolveClaudeEffort) and persist that loss for resume. thinkingLevel is a cross-model effort
		// scale, so carrying it forward keeps the user's chosen effort across the switch. NOTE: this does not
		// validate the carried config against the TARGET model's configSchema, so an effort the target does not
		// advertise is still applied as-is; an explicit thinking-level control (a later increment) will validate
		// against configSchema and dispatch the full ModelSelection.
		const state = this._subscription?.value;
		const config = state && !(state instanceof Error) ? state.summary.model?.config : undefined;
		const action: SessionModelChangedAction = {
			type: ActionType.SessionModelChanged,
			model: config ? { id: modelId, config } : { id: modelId },
		};
		try {
			this._agentHostService.dispatch(this._sessionUri.toString(), action);
		} catch (err) {
			this._logService.error('[clawdius-chat] failed to set model', err);
		}
	}

	/** Subscribe to the (already-created) session once and repaint. Re-acquires the refcounted subscription if
	 *  this is a freshly-created pane attaching to a session that is still running in the window service. */
	private _attachToSession(uri: URI): void {
		this._sessionUri = uri;
		if (!this._subscription) {
			const ref = this._agentHostService.getSubscription(StateComponents.Session, uri, 'ClawdiusChatViewPane');
			this._sessionDisposables.add(ref);
			this._subscription = ref.object;
			this._sessionDisposables.add(ref.object.onDidChange(() => this._renderConversation()));
		}
		this._renderConversation();
	}

	/** Send the user's prompt as a new turn. The session is owned by the window-scoped service and outlives
	 *  this pane, so closing/reopening the chat keeps the conversation; the response streams back via state. */
	private async _startTurn(text: string): Promise<void> {
		// One turn at a time (belt-and-suspenders with the SPA's busy flag, which is derived from state).
		if (this._isTurning) {
			return;
		}
		this._isTurning = true;

		let uri: URI;
		try {
			uri = await this._chatSessionService.getOrCreateSession();
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
		this._attachToSession(uri);

		const turnId = generateUuid();
		this._activeTurnId = turnId;
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
			this._post({ type: 'chatError', text: localize('clawdius.chat.dispatchError', "Could not send your message to Claude.") });
		}
	}

	/**
	 * Re-derive the ENTIRE conversation (every turn, in stream order) from the authoritative SessionState and
	 * push it to the SPA, which rebuilds the transcript. One source of truth: this is why the chat survives the
	 * pane being disposed/recreated - on reattach the first render repaints the full history from state.
	 */
	private _renderConversation(): void {
		if (this._disposed) {
			return;
		}
		const subscription = this._subscription;
		if (!subscription || !this._webview.value) {
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

		this._activeTurnId = state.activeTurn?.id;
		this._isTurning = !!state.activeTurn;

		// Completed turns carry a terminal `state`/`error`; the active turn (if any) is still streaming.
		const turns = state.turns.map(turn => {
			const lastTodoId = this._todoIdForTurn(turn.responseParts);
			return {
				id: turn.id,
				user: turn.message.text,
				blocks: turn.responseParts.flatMap(part => this._partBlocks(part, lastTodoId)),
				error: turn.state === TurnState.Error ? (turn.error?.message || localize('clawdius.chat.turnError', "Claude could not complete the response.")) : undefined,
			};
		});
		if (state.activeTurn) {
			const lastTodoId = this._todoIdForTurn(state.activeTurn.responseParts);
			turns.push({
				id: state.activeTurn.id,
				user: state.activeTurn.message.text,
				blocks: state.activeTurn.responseParts.flatMap(part => this._partBlocks(part, lastTodoId)),
				error: undefined,
			});
		}

		this._post({ type: 'setConversation', turns, busy: this._isTurning });
		this._postModels();
		const usage = this._latestUsage(state);
		this._post({ type: 'setUsage', text: usage ? this._usageText(usage) : undefined });
	}

	/** The current turn's token usage: while a turn is active, its own usage (undefined until the report
	 *  arrives, which hides the strip rather than showing the prior turn's stale numbers); when idle, the last
	 *  completed turn that carries usage. */
	private _latestUsage(state: SessionState): UsageInfo | undefined {
		if (state.activeTurn) {
			return state.activeTurn.usage;
		}
		for (let i = state.turns.length - 1; i >= 0; i--) {
			const usage = state.turns[i].usage;
			if (usage) {
				return usage;
			}
		}
		return undefined;
	}

	/** A short, localized token-usage line for the meter (input / output, plus cache reads when present). */
	private _usageText(usage: UsageInfo): string {
		const input = (usage.inputTokens ?? 0).toLocaleString();
		const output = (usage.outputTokens ?? 0).toLocaleString();
		const cache = usage.cacheReadTokens ?? 0;
		return cache > 0
			? localize('clawdius.chat.usageCached', "{0} tokens in / {1} out (+{2} cached)", input, output, cache.toLocaleString())
			: localize('clawdius.chat.usage', "{0} tokens in / {1} out", input, output);
	}

	/** Project a single response part into zero or more serializable blocks for the SPA. `lastTodoId` is the
	 *  tool-call id of the turn's most recent TodoWrite (see {@link _todoIdForTurn}): only that one renders as a
	 *  checklist so the repeated in-place updates collapse into a single live list. */
	private _partBlocks(part: ResponsePart, lastTodoId: string | undefined): AssistantBlock[] {
		if (part.kind === ResponsePartKind.Markdown) {
			return part.content ? [{ kind: 'markdown', text: part.content }] : [];
		}
		if (part.kind === ResponsePartKind.Reasoning) {
			return part.content ? [{ kind: 'reasoning', text: part.content }] : [];
		}
		if (part.kind === ResponsePartKind.ToolCall) {
			const tc = part.toolCall;
			// Collapse a turn's repeated committed TodoWrite updates into one live checklist. `classifyTodoCall`
			// returns 'tool' for any non-committed state (esp. PendingConfirmation, so its Approve/Deny survives)
			// AND whenever no live checklist exists (so an empty/malformed TodoWrite is never swallowed).
			if (tc.toolName === 'TodoWrite') {
				const mode = classifyTodoCall(this._isCommittedTodo(tc), tc.toolCallId === lastTodoId, lastTodoId !== undefined);
				if (mode === 'suppress') {
					return [];
				}
				if (mode === 'todos') {
					const todos = this._parseTodos(tc);
					if (todos) {
						return [{ kind: 'todos', id: tc.toolCallId, todos }];
					}
				}
				return [this._toolBlock(tc)];
			}
			return [this._toolBlock(tc)];
		}
		return [];
	}

	/** A TodoWrite whose list is committed (running or completed) and thus safe to render as a checklist rather
	 *  than a tool card. Pending-confirmation / streaming / cancelled TodoWrites keep their normal card so any
	 *  approval or cancel UI survives. */
	private _isCommittedTodo(tc: ToolCallState): boolean {
		return tc.status === ToolCallStatus.Running || tc.status === ToolCallStatus.Completed;
	}

	/** The tool-call id of the LAST committed TodoWrite in a turn whose input parses to a non-empty todo list,
	 *  else undefined. Used to collapse the repeated TodoWrite updates into a single live checklist. */
	private _todoIdForTurn(parts: readonly ResponsePart[]): string | undefined {
		const calls: ClawdiusTodoCall[] = [];
		for (const part of parts) {
			if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolName === 'TodoWrite') {
				const tc = part.toolCall;
				calls.push({ toolCallId: tc.toolCallId, committed: this._isCommittedTodo(tc), hasList: this._parseTodos(tc) !== undefined });
			}
		}
		return selectLiveTodoCallId(calls);
	}

	/** Parse a TodoWrite tool call's raw JSON input into a todo list, defensively. Returns undefined when the
	 *  input is absent (still streaming) or malformed. The pure parse lives in {@link parseTodoInput} so it can
	 *  be unit-tested without a webview. */
	private _parseTodos(tc: ToolCallState): ClawdiusTodoItem[] | undefined {
		if (tc.status === ToolCallStatus.Streaming) {
			return undefined;
		}
		return parseTodoInput(tc.toolInput);
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
			case ToolCallStatus.PendingConfirmation: {
				block.pending = true;
				block.confirmationTitle = flattenStringOrMarkdown(tc.confirmationTitle);
				block.options = (tc.options ?? []).map(option => ({ id: option.id, label: option.label, kind: option.kind }));
				// Preview the files this tool will change so the user can see what they are approving.
				const edits = this._fileEdits(tc.edits?.items ?? []);
				if (edits.length) {
					block.edits = edits;
				}
				break;
			}
			case ToolCallStatus.Running:
				// Live output streamed while the tool runs (e.g. terminal text).
				block.output = this._outputText(tc.content);
				break;
			case ToolCallStatus.PendingResultConfirmation: {
				block.success = tc.success;
				block.result = flattenStringOrMarkdown(tc.pastTenseMessage);
				block.output = this._outputText(tc.content);
				const edits = this._fileEdits(getToolFileEdits(tc));
				if (edits.length) {
					block.edits = edits;
				}
				if (tc.error) {
					block.errorText = tc.error.message;
				}
				break;
			}
			case ToolCallStatus.Completed: {
				block.success = tc.success;
				block.result = flattenStringOrMarkdown(tc.pastTenseMessage);
				block.output = this._outputText(tc.content);
				const edits = this._fileEdits(getToolFileEdits(tc));
				if (edits.length) {
					block.edits = edits;
				}
				if (tc.error) {
					block.errorText = tc.error.message;
				}
				break;
			}
			case ToolCallStatus.Cancelled:
				block.cancelled = true;
				break;
			default:
				break;
		}
		return block;
	}

	/** Join a tool result's text-content parts into a single output string, capped so a huge result (a large
	 *  file read or terminal dump) cannot bloat the webview DOM. Content-only by design: it never consults
	 *  result status/success, so it is safe for the live Running `content` as well as completed results. Returns
	 *  undefined when there is no text content. */
	private _outputText(content: readonly ToolResultContent[] | undefined): string | undefined {
		if (!content || content.length === 0) {
			return undefined;
		}
		const parts: string[] = [];
		for (const part of content) {
			if (part.type === ToolResultContentType.Text) {
				parts.push(part.text);
			}
		}
		if (parts.length === 0) {
			return undefined;
		}
		const text = parts.join('\n');
		const limit = 10000;
		return text.length > limit ? text.slice(0, limit) + '\n' + localize('clawdius.chat.outputTruncated', "... (output truncated)") : text;
	}

	/** Project file edits (from a pending-confirmation preview or a completed result) into compact summaries:
	 *  file name, added/removed line counts, and whether the file is deleted -- the only change kind the
	 *  contract lets us assert from before/after presence; creations and in-place edits are both reported as
	 *  'edit'. The diff text itself lives behind ContentRefs that are not resolved here (at-a-glance footprint). */
	private _fileEdits(items: readonly ISessionFileDiff[]): { path: string; added: number; removed: number; change: string }[] {
		const out: { path: string; added: number; removed: number; change: string }[] = [];
		for (const item of items) {
			const uri = item.after?.uri ?? item.before?.uri;
			if (!uri) {
				continue;
			}
			// `after` absent reliably means deletion. `before` absence is ambiguous per the contract (creation
			// OR in-place edit) -- and the Claude mapper emits both snapshots even for creates -- so creates and
			// edits are both reported as 'edit'; only deletion is asserted.
			const change = !item.after ? 'delete' : 'edit';
			out.push({ path: this._basename(uri), added: item.diff?.added ?? 0, removed: item.diff?.removed ?? 0, change });
		}
		return out;
	}

	/** Last path segment of a URI string (e.g. `file:///c:/a/b.ts` -> `b.ts`), for compact edit labels. The
	 *  agent-host protocol carries URIs as strings, so this parses rather than using the URI class. */
	private _basename(uri: string): string {
		let s = uri;
		const hash = s.indexOf('#');
		if (hash >= 0) {
			s = s.slice(0, hash);
		}
		const query = s.indexOf('?');
		if (query >= 0) {
			s = s.slice(0, query);
		}
		while (s.length > 1 && s.endsWith('/')) {
			s = s.slice(0, -1);
		}
		const slash = s.lastIndexOf('/');
		const name = slash >= 0 ? s.slice(slash + 1) : s;
		if (!name) {
			return uri;
		}
		try {
			return decodeURIComponent(name);
		} catch {
			return name;
		}
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
		// Release ONLY this pane's subscription + listener. The session itself is owned by the window-scoped
		// IClawdiusChatSessionService and is NOT disposed here, nor is the in-flight turn cancelled - so closing
		// and reopening the chat preserves the conversation (and a running turn keeps streaming).
		this._sessionDisposables.dispose();
		this._subscription = undefined;
		this._sessionUri = undefined;
		this._activeTurnId = undefined;
		super.dispose();
	}

	private _renderHtml(): string {
		const nonce = generateUuid();

		const claudeLabel = localize('clawdius.chat.claude', "Claude");
		const headerTitle = localize('clawdius.chat.headerTitle', "Claude Code");
		const modelPickerLabel = localize('clawdius.chat.modelPicker', "Model");
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
			noText: localize('clawdius.chat.noText', "Claude finished this turn without text output."),
			todos: localize('clawdius.chat.todos', "To-dos"),
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
		.header .header-title { flex: 1 1 auto; }
		.header .model-picker {
			flex: 0 0 auto;
			max-width: 55%;
			font-family: inherit;
			font-size: 11px;
			font-weight: 400;
			padding: 2px 4px;
			border-radius: 5px;
			border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			cursor: pointer;
			outline: none;
		}
		.header .model-picker:focus-visible { outline: 1px solid var(--clawdius-orange); outline-offset: 1px; }
		.header .model-picker[hidden] { display: none; }
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
		.tool-output { margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto; font-family: var(--monaco-monospace-font, ui-monospace, monospace); font-size: 0.82em; line-height: 1.4; white-space: pre-wrap; word-break: break-word; color: var(--vscode-foreground); border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.06)); }
		.tool-edits { padding: 4px 10px 8px; display: flex; flex-direction: column; gap: 2px; }
		.tool-edit { display: flex; align-items: center; gap: 8px; font-size: 0.84em; }
		.tool-edit .edit-path { font-family: var(--monaco-monospace-font, ui-monospace, monospace); color: var(--vscode-foreground); word-break: break-all; }
		.tool-edit .edit-add { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); font-variant-numeric: tabular-nums; }
		.tool-edit .edit-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #e05252); font-variant-numeric: tabular-nums; }
		.tool-edit.change-delete .edit-path { text-decoration: line-through; opacity: 0.8; }
		.todos-card { margin: 6px 0; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.06)); padding: 8px 10px; }
		.todos-header { font-size: 0.82em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
		.todos-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
		.todo { display: flex; align-items: flex-start; gap: 8px; font-size: 0.9em; line-height: 1.35; }
		.todo-mark { flex: 0 0 auto; width: 13px; height: 13px; margin-top: 2px; border-radius: 50%; border: 1.5px solid var(--vscode-descriptionForeground); box-sizing: border-box; position: relative; }
		.todo-in_progress .todo-mark { border-color: var(--clawdius-orange); box-shadow: inset 0 0 0 3px var(--clawdius-orange); }
		.todo-completed .todo-mark { border-color: var(--clawdius-button-bg); background: var(--clawdius-button-bg); }
		.todo-completed .todo-mark::after { content: ''; position: absolute; left: 4px; top: 1px; width: 3px; height: 6px; border: solid var(--clawdius-ivory); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); }
		.todo-text { flex: 1 1 auto; word-break: break-word; }
		.todo-completed .todo-text { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
		.todo-in_progress .todo-text { color: var(--vscode-foreground); font-weight: 500; }
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
		.usage { flex: 0 0 auto; padding: 3px 12px; font-size: 0.76em; color: var(--vscode-descriptionForeground); text-align: right; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
		.usage[hidden] { display: none; }
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
	<div class="header"><span class="dot"></span><span class="header-title">${escapeHtml(headerTitle)}</span><select id="model-picker" class="model-picker" aria-label="${escapeHtml(modelPickerLabel)}" hidden></select></div>
	<div class="messages" id="messages" role="log">
		<div class="welcome" id="welcome">
			<div class="mark" aria-hidden="true">C</div>
			<h1>${escapeHtml(welcomeHeading)}</h1>
			<p>${escapeHtml(welcomeSubtext)}</p>
		</div>
	</div>
	<div class="usage" id="usage" hidden></div>
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
			const modelPicker = document.getElementById('model-picker');
			const usageEl = document.getElementById('usage');
			function setUsage(text) {
				if (!usageEl) { return; }
				if (text) { usageEl.textContent = text; usageEl.hidden = false; }
				else { usageEl.textContent = ''; usageEl.hidden = true; }
			}
			if (modelPicker) {
				modelPicker.addEventListener('change', function () {
					if (modelPicker.value) { vscode.postMessage({ type: 'setModel', modelId: modelPicker.value }); }
				});
			}
			// Rebuild the picker only when the model set or current selection actually changes, so the frequent
			// full-state pushes during streaming never clobber an open dropdown or reset the selection.
			function setModels(models, current) {
				if (!modelPicker) { return; }
				if (!models || !models.length) { modelPicker.hidden = true; modelPicker.setAttribute('data-sig', ''); return; }
				const sig = models.map(function (m) { return m.id; }).join(String.fromCharCode(10)) + '::' + (current || '');
				if (modelPicker.getAttribute('data-sig') === sig) { return; }
				modelPicker.setAttribute('data-sig', sig);
				while (modelPicker.firstChild) { modelPicker.removeChild(modelPicker.firstChild); }
				for (let i = 0; i < models.length; i++) {
					const opt = document.createElement('option');
					opt.value = models[i].id;
					opt.textContent = models[i].name;
					if (current && models[i].id === current) { opt.selected = true; }
					modelPicker.appendChild(opt);
				}
				modelPicker.hidden = false;
			}
			const assistantBubbles = Object.create(null);
			// Tool calls the user has already approved/denied. Persisted across the frequent full-rebuilds so a
			// re-rendered permission card cannot re-enable its buttons and allow a double-approval.
			const respondedTools = Object.create(null);
			// While a turn is streaming we are 'busy': the composer is disabled so INC-1 serializes turns
			// (one in flight at a time) rather than orphaning the active turn with a concurrent dispatch.
			let busy = false;

			function clearWelcome() {
				if (welcome) { welcome.style.display = 'none'; }
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
				if (block.edits && block.edits.length) {
					const list = document.createElement('div');
					list.className = 'tool-edits';
					for (let i = 0; i < block.edits.length; i++) {
						const e = block.edits[i];
						const row = document.createElement('div');
						row.className = 'tool-edit change-' + (e.change || 'edit');
						const p = document.createElement('span');
						p.className = 'edit-path';
						p.textContent = e.path;
						row.appendChild(p);
						if (e.added) {
							const a = document.createElement('span');
							a.className = 'edit-add';
							a.textContent = '+' + e.added;
							row.appendChild(a);
						}
						if (e.removed) {
							const d = document.createElement('span');
							d.className = 'edit-del';
							d.textContent = '-' + e.removed;
							row.appendChild(d);
						}
						list.appendChild(row);
					}
					card.appendChild(list);
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
				if (block.output) {
					const out = document.createElement('pre');
					out.className = 'tool-output';
					out.textContent = block.output;
					card.appendChild(out);
				}
				if (block.cancelled) {
					const c = document.createElement('div');
					c.className = 'tool-cancelled';
					c.textContent = STRINGS.cancelled;
					card.appendChild(c);
				}
				return card;
			}

			function renderTodos(block) {
				const card = document.createElement('div');
				card.className = 'todos-card';
				const todos = block.todos || [];
				let done = 0;
				for (let i = 0; i < todos.length; i++) { if (todos[i].status === 'completed') { done++; } }
				const header = document.createElement('div');
				header.className = 'todos-header';
				header.textContent = STRINGS.todos + ' (' + done + '/' + todos.length + ')';
				card.appendChild(header);
				const list = document.createElement('ul');
				list.className = 'todos-list';
				for (let i = 0; i < todos.length; i++) {
					const t = todos[i];
					const li = document.createElement('li');
					li.className = 'todo todo-' + (t.status || 'pending');
					const mark = document.createElement('span');
					mark.className = 'todo-mark';
					mark.setAttribute('aria-hidden', 'true');
					li.appendChild(mark);
					const txt = document.createElement('span');
					txt.className = 'todo-text';
					txt.textContent = t.content;
					li.appendChild(txt);
					list.appendChild(li);
				}
				card.appendChild(list);
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
					else if (b.kind === 'todos') { bubble.appendChild(renderTodos(b)); }
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
				busy = true; // optimistic; the next setConversation confirms the turn is active
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

			// Rebuild the whole transcript from the authoritative conversation state. One source of truth, so
			// reopening the chat (which recreates the pane + webview) repaints the existing conversation rather
			// than starting over.
			function setConversation(turns, isBusy) {
				const stick = isNearBottom();
				const existingMsgs = messages.querySelectorAll('.msg');
				for (let i = 0; i < existingMsgs.length; i++) { existingMsgs[i].remove(); }
				for (const k in assistantBubbles) { delete assistantBubbles[k]; }
				if (!turns || !turns.length) {
					if (welcome) { welcome.style.display = ''; }
				} else {
					if (welcome) { welcome.style.display = 'none'; }
					for (let i = 0; i < turns.length; i++) {
						const t = turns[i];
						if (typeof t.user === 'string' && t.user.length) { addUser(t.user); }
						const isActiveLast = isBusy && i === turns.length - 1;
						if (t.blocks && t.blocks.length) {
							setAssistantParts(t.id, t.blocks);
						} else if (isActiveLast) {
							ensureAssistant(t.id);
						} else if (!t.error) {
							// Completed turn with no response blocks and no error: show the no-text fallback so a
							// valid-but-empty successful turn does not look like a dropped request after reopen.
							setAssistantParts(t.id, [{ kind: 'markdown', text: STRINGS.noText }]);
						}
						if (typeof t.error === 'string' && t.error) { showError(t.error); }
					}
				}
				const wasBusy = busy;
				busy = isBusy;
				updateSendState();
				if (wasBusy && !busy) { input.focus(); }
				if (stick) { toBottom(); }
			}

			window.addEventListener('message', function (event) {
				const m = event.data;
				if (!m || typeof m.type !== 'string') { return; }
				switch (m.type) {
					case 'setConversation':
						if (Array.isArray(m.turns)) { setConversation(m.turns, !!m.busy); }
						break;
					case 'chatError':
						if (typeof m.text === 'string') { showError(m.text); }
						busy = false; updateSendState(); input.focus();
						break;
					case 'setModels':
						setModels(m.models, m.current);
						break;
					case 'setUsage':
						setUsage(m.text);
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
