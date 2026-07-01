/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, buildSubagentSessionUri, type Message, type ResponsePart, type StringOrMarkdown, type ToolCallCompletedState, type ToolResultContent, type Turn } from '../../common/state/sessionState.js';

// =============================================================================
// History-record test fixtures
//
// Flat, declarative DSL used by mock agents and unit tests to build session
// history without manually constructing `Turn[]`. Records mirror the wire
// shape of an agent event stream — `message`, `tool_start`, `tool_complete`,
// `subagent_started` — so transcripts read like the protocol they're
// emulating.
//
// Production code does NOT depend on this module; it exists only so tests can
// seed mock session histories without hand-building `Turn[]`.
// =============================================================================

interface IHistoryRecordBase {
	readonly session: URI;
}

interface IHistoryMessageRecord extends IHistoryRecordBase {
	readonly type: 'message';
	readonly role: 'user' | 'assistant';
	readonly messageId: string;
	readonly content: string;
	readonly toolRequests?: readonly {
		readonly toolCallId: string;
		readonly name: string;
		readonly arguments?: string;
		readonly type?: 'function' | 'custom';
	}[];
	readonly reasoningOpaque?: string;
	readonly reasoningText?: string;
	readonly encryptedContent?: string;
	readonly parentToolCallId?: string;
}

export interface IHistoryToolStartRecord extends IHistoryRecordBase {
	readonly type: 'tool_start';
	readonly toolCallId: string;
	readonly toolName: string;
	readonly displayName: string;
	readonly invocationMessage: StringOrMarkdown;
	readonly toolInput?: string;
	readonly toolKind?: 'terminal' | 'subagent' | 'search';
	readonly language?: string;
	readonly toolArguments?: string;
	readonly subagentAgentName?: string;
	readonly subagentDescription?: string;
	readonly mcpServerName?: string;
	readonly mcpToolName?: string;
	readonly parentToolCallId?: string;
}

interface IHistoryToolCompleteRecord extends IHistoryRecordBase {
	readonly type: 'tool_complete';
	readonly toolCallId: string;
	readonly result: {
		readonly success: boolean;
		readonly pastTenseMessage: StringOrMarkdown;
		readonly content?: ToolResultContent[];
		readonly error?: { readonly message: string; readonly code?: string };
	};
	readonly isUserRequested?: boolean;
	readonly toolTelemetry?: string;
	readonly parentToolCallId?: string;
}

interface IHistorySubagentStartedRecord extends IHistoryRecordBase {
	readonly type: 'subagent_started';
	readonly toolCallId: string;
	readonly agentName: string;
	readonly agentDisplayName: string;
	readonly agentDescription?: string;
}

/** Test fixture record. Hand-constructed by tests to seed mock session histories. */
export type IHistoryRecord =
	| IHistoryMessageRecord
	| IHistoryToolStartRecord
	| IHistoryToolCompleteRecord
	| IHistorySubagentStartedRecord;

function extractSubagentMeta(start: IHistoryToolStartRecord | undefined): { subagentDescription?: string; subagentAgentName?: string } {
	if (!start) {
		return {};
	}
	return {
		subagentDescription: start.subagentDescription,
		subagentAgentName: start.subagentAgentName,
	};
}

/**
 * Builds a parent session's {@link Turn}s from a flat list of history
 * records.
 *
 * Each `user` message starts a new turn. Inner subagent records (those
 * carrying `parentToolCallId`) are skipped — see
 * {@link buildSubagentTurnsFromHistory}.
 */
export function buildTurnsFromHistory(messages: readonly IHistoryRecord[]): Turn[] {
	const turns: Turn[] = [];
	const subagentsByToolCallId = new Map<string, IHistorySubagentStartedRecord>();
	let currentTurn: {
		id: string;
		message: Message;
		responseParts: ResponsePart[];
		pendingTools: Map<string, IHistoryToolStartRecord>;
	} | undefined;

	const finalizeTurn = (turn: NonNullable<typeof currentTurn>, state: TurnState): void => {
		turns.push({
			id: turn.id,
			message: turn.message,
			responseParts: turn.responseParts,
			usage: undefined,
			state,
		});
	};

	const startTurn = (id: string, text: string): NonNullable<typeof currentTurn> => ({
		id,
		message: { text, origin: { kind: MessageKind.User } },
		responseParts: [],
		pendingTools: new Map(),
	});

	for (const msg of messages) {
		if (msg.type === 'message' && msg.role === 'user') {
			if (currentTurn) {
				finalizeTurn(currentTurn, TurnState.Cancelled);
			}
			currentTurn = startTurn(msg.messageId, msg.content);
		} else if (msg.type === 'message' && msg.role === 'assistant') {
			if (msg.parentToolCallId) {
				continue;
			}
			if (!currentTurn) {
				currentTurn = startTurn(msg.messageId, '');
			}
			if (msg.reasoningText) {
				currentTurn.responseParts.push({
					kind: ResponsePartKind.Reasoning,
					id: generateUuid(),
					content: msg.reasoningText,
				});
			}
			if (msg.content) {
				currentTurn.responseParts.push({
					kind: ResponsePartKind.Markdown,
					id: generateUuid(),
					content: msg.content,
				});
			}
			if (!msg.toolRequests || msg.toolRequests.length === 0) {
				finalizeTurn(currentTurn, TurnState.Complete);
				currentTurn = undefined;
			}
		} else if (msg.type === 'subagent_started') {
			subagentsByToolCallId.set(msg.toolCallId, msg);
		} else if (msg.type === 'tool_start') {
			if (msg.parentToolCallId) {
				continue;
			}
			currentTurn?.pendingTools.set(msg.toolCallId, msg);
		} else if (msg.type === 'tool_complete') {
			if (msg.parentToolCallId) {
				continue;
			}
			if (currentTurn) {
				const start = currentTurn.pendingTools.get(msg.toolCallId);
				currentTurn.pendingTools.delete(msg.toolCallId);

				const subagentEvent = subagentsByToolCallId.get(msg.toolCallId);
				const contentWithSubagent = msg.result.content ? [...msg.result.content] : [];
				if (subagentEvent) {
					const parentSessionStr = msg.session.toString();
					contentWithSubagent.push({
						type: ToolResultContentType.Subagent,
						resource: buildSubagentSessionUri(parentSessionStr, msg.toolCallId),
						title: subagentEvent.agentDisplayName,
						agentName: subagentEvent.agentName,
						description: subagentEvent.agentDescription,
					});
				}

				const tc: ToolCallCompletedState = {
					status: ToolCallStatus.Completed,
					toolCallId: msg.toolCallId,
					toolName: start?.toolName ?? 'unknown',
					displayName: start?.displayName ?? 'Unknown Tool',
					invocationMessage: start?.invocationMessage ?? 'Unknown tool',
					toolInput: start?.toolInput,
					success: msg.result.success,
					pastTenseMessage: msg.result.pastTenseMessage,
					content: contentWithSubagent.length > 0 ? contentWithSubagent : undefined,
					error: msg.result.error,
					confirmed: ToolCallConfirmationReason.NotNeeded,
					_meta: {
						toolKind: start?.toolKind,
						language: start?.language,
						...extractSubagentMeta(start),
					},
				};
				currentTurn.responseParts.push({
					kind: ResponsePartKind.ToolCall,
					toolCall: tc,
				});
			}
		}
	}

	if (currentTurn) {
		finalizeTurn(currentTurn, TurnState.Cancelled);
	}

	return turns;
}

/**
 * Builds the {@link Turn}s for a subagent child session by filtering the
 * parent's history for records carrying the matching `parentToolCallId`.
 * Returns a single turn containing all inner tool calls and assistant
 * messages.
 */
export function buildSubagentTurnsFromHistory(
	parentMessages: readonly IHistoryRecord[],
	parentToolCallId: string,
	childSessionUri: string,
): Turn[] {
	const innerToolCallIds = new Set<string>();
	for (const msg of parentMessages) {
		if ((msg.type === 'tool_start' || msg.type === 'tool_complete') && msg.parentToolCallId === parentToolCallId) {
			innerToolCallIds.add(msg.toolCallId);
		}
	}

	const subagentsByToolCallId = new Map<string, IHistorySubagentStartedRecord>();
	for (const msg of parentMessages) {
		if (msg.type === 'subagent_started' && innerToolCallIds.has(msg.toolCallId)) {
			subagentsByToolCallId.set(msg.toolCallId, msg);
		}
	}

	const innerMessages = parentMessages.filter(msg => {
		if (msg.type === 'tool_start' || msg.type === 'tool_complete') {
			return msg.parentToolCallId === parentToolCallId;
		}
		if (msg.type === 'message') {
			return msg.parentToolCallId === parentToolCallId;
		}
		return false;
	});

	if (innerMessages.length === 0) {
		return [];
	}

	const responseParts: ResponsePart[] = [];
	const pendingTools = new Map<string, IHistoryToolStartRecord>();

	for (const msg of innerMessages) {
		if (msg.type === 'tool_start') {
			pendingTools.set(msg.toolCallId, msg);
		} else if (msg.type === 'tool_complete') {
			const start = pendingTools.get(msg.toolCallId);
			pendingTools.delete(msg.toolCallId);

			const subagentEvent = subagentsByToolCallId.get(msg.toolCallId);
			const contentWithSubagent = msg.result.content ? [...msg.result.content] : [];
			if (subagentEvent) {
				contentWithSubagent.push({
					type: ToolResultContentType.Subagent,
					resource: buildSubagentSessionUri(childSessionUri, msg.toolCallId),
					title: subagentEvent.agentDisplayName,
					agentName: subagentEvent.agentName,
					description: subagentEvent.agentDescription,
				});
			}

			const tc: ToolCallCompletedState = {
				status: ToolCallStatus.Completed,
				toolCallId: msg.toolCallId,
				toolName: start?.toolName ?? 'unknown',
				displayName: start?.displayName ?? 'Unknown Tool',
				invocationMessage: start?.invocationMessage ?? 'Unknown tool',
				toolInput: start?.toolInput,
				success: msg.result.success,
				pastTenseMessage: msg.result.pastTenseMessage,
				content: contentWithSubagent.length > 0 ? contentWithSubagent : undefined,
				error: msg.result.error,
				confirmed: ToolCallConfirmationReason.NotNeeded,
				_meta: {
					toolKind: start?.toolKind,
					language: start?.language,
					...extractSubagentMeta(start),
				},
			};
			responseParts.push({
				kind: ResponsePartKind.ToolCall,
				toolCall: tc,
			});
		} else if (msg.type === 'message' && msg.role === 'assistant') {
			if (msg.reasoningText) {
				responseParts.push({
					kind: ResponsePartKind.Reasoning,
					id: generateUuid(),
					content: msg.reasoningText,
				});
			}
			if (msg.content) {
				responseParts.push({
					kind: ResponsePartKind.Markdown,
					id: generateUuid(),
					content: msg.content,
				});
			}
		}
	}

	if (responseParts.length === 0) {
		return [];
	}

	return [{
		id: generateUuid(),
		message: { text: '', origin: { kind: MessageKind.User } },
		responseParts,
		usage: undefined,
		state: TurnState.Complete,
	}];
}
