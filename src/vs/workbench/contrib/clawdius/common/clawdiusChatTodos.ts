/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native webview Claude chat: pure TodoWrite input parsing (extracted for unit testing)
// The Claude Code TodoWrite tool is not a first-class agent-host concept; it arrives as a normal tool call
// whose raw input is a JSON string of the form `{ todos: [{ content, status, ... }] }`. This module isolates
// the defensive parse so the chat ViewPane projection stays testable without a webview/DOM.

/** A single TodoWrite entry projected for the chat checklist. */
export interface ClawdiusTodoItem {
	/** The task description. */
	readonly content: string;
	/** Lifecycle status as reported by TodoWrite: typically `pending` | `in_progress` | `completed`. */
	readonly status: string;
}

/**
 * Parse a TodoWrite tool call's raw JSON `toolInput` into a todo list, defensively. Returns `undefined` when
 * the input is absent, malformed, not an object, carries a non-array `todos`, or yields no usable entries
 * (each entry MUST have a string `content`). A missing or non-string `status` defaults to `pending`.
 */
export function parseTodoInput(toolInput: string | undefined): ClawdiusTodoItem[] | undefined {
	if (!toolInput) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(toolInput);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const todosRaw = (parsed as { todos?: unknown }).todos;
	if (!Array.isArray(todosRaw)) {
		return undefined;
	}
	const todos: ClawdiusTodoItem[] = [];
	for (const item of todosRaw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const obj = item as { content?: unknown; status?: unknown };
		const content = typeof obj.content === 'string' ? obj.content : undefined;
		if (!content) {
			continue;
		}
		const status = typeof obj.status === 'string' ? obj.status : 'pending';
		todos.push({ content, status });
	}
	return todos.length ? todos : undefined;
}

/** One TodoWrite call's projection inputs: whether it is committed (running/completed) and whether its input
 *  parses to a non-empty list. */
export interface ClawdiusTodoCall {
	readonly toolCallId: string;
	/** Running or Completed -- a committed list safe to render as a checklist (vs streaming/pending/cancelled). */
	readonly committed: boolean;
	/** Whether {@link parseTodoInput} yields a non-empty list for this call. */
	readonly hasList: boolean;
}

/**
 * Identify a turn's "live" TodoWrite -- the LAST committed call that carries a non-empty parseable list -- so
 * the repeated in-place updates collapse to a single checklist. Returns `undefined` when none qualifies (every
 * committed call is empty/malformed, or there are no committed calls), in which case the caller must keep the
 * normal tool card rather than suppressing it.
 */
export function selectLiveTodoCallId(calls: readonly ClawdiusTodoCall[]): string | undefined {
	let id: string | undefined;
	for (const call of calls) {
		if (call.committed && call.hasList) {
			id = call.toolCallId;
		}
	}
	return id;
}

/**
 * Decide how a single TodoWrite call renders:
 * - `'todos'`  -- it is the turn's live checklist call (render the checklist),
 * - `'suppress'` -- it is an earlier committed update superseded by the live one (drop it),
 * - `'tool'`   -- render the normal tool card (it is not committed -- so its Approve/Deny or cancel UI must
 *                 survive -- OR no live checklist exists at all, so nothing should be swallowed).
 */
export function classifyTodoCall(committed: boolean, isLive: boolean, hasLiveChecklist: boolean): 'todos' | 'suppress' | 'tool' {
	if (!committed || !hasLiveChecklist) {
		return 'tool';
	}
	return isLive ? 'todos' : 'suppress';
}
// CLAWDIUS-END
