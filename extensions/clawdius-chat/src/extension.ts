/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const PARTICIPANT_ID = 'chapmanjw.clawdius-chat.default';

export function activate(context: vscode.ExtensionContext): void {
	// Phase 2 stub. Registering Clawdius as the DEFAULT panel chat participant is what flips the
	// `chatPanelParticipantRegistered` context key, so the chat view renders the Clawdius agent
	// instead of the GitHub Copilot sign-in / setup screen. Wiring this handler to the Claude Code
	// backend (a real language model) is the next milestone (M2); for now it is a placeholder.
	const handler: vscode.ChatRequestHandler = (_request, _context, response, _token) => {
		response.markdown('Clawdius chat is set up, but it is not connected to a language model yet — that lands in the next milestone.');
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	context.subscriptions.push(participant);
}

export function deactivate(): void { }
