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
// CLAWDIUS-END
