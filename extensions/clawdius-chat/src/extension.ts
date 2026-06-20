/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const PARTICIPANT_ID = 'chapmanjw.clawdius-chat.default';

// v1 is READ-ONLY/conversational. Under `claude -p` the CLI cannot raise interactive permission
// prompts, so any tool that is not pre-approved is auto-denied. We hand Claude only read tools, so it
// can answer about the workspace but can never mutate it, run shell, or reach the network. Agentic mode
// with a permission bridge to the chat confirmation UI is a follow-up.
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * Resolve the Claude Code CLI binary. The extension host PATH may not include the user's local bin, so
 * prefer an explicit override and the known install location before falling back to PATH resolution.
 */
function resolveClaudeBinary(): string {
	const override = process.env.CLAWDIUS_CLAUDE_PATH;
	if (override && fs.existsSync(override)) {
		return override;
	}
	const local = path.join(os.homedir(), '.local', 'bin', 'claude');
	for (const candidate of [local, `${local}.cmd`, `${local}.exe`]) {
		try {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		} catch {
			// ignore and keep looking
		}
	}
	return 'claude';
}

/** The session id of the most recent Clawdius response, recovered from chat history (survives reloads). */
function lastSessionId(history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>): string | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		// A request turn has no `.result`; the optional chain reads `undefined` for those, so casting every
		// turn to a response turn and guarding with `?.` discriminates without the banned `in` operator.
		const sessionId = (history[i] as vscode.ChatResponseTurn).result?.metadata?.sessionId;
		if (typeof sessionId === 'string' && sessionId.length > 0) {
			return sessionId;
		}
	}
	return undefined;
}

interface ClaudeStreamEvent {
	readonly type?: string;
	readonly subtype?: string;
	readonly session_id?: string;
	readonly is_error?: boolean;
	readonly message?: { readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }> };
}

export function activate(context: vscode.ExtensionContext): void {
	const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token): Promise<vscode.ChatResult> => {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const resumeId = lastSessionId(chatContext.history);

		const args = ['-p', request.prompt, '--output-format', 'stream-json', '--verbose', '--allowed-tools', ...ALLOWED_TOOLS];
		if (resumeId) {
			args.push('--resume', resumeId);
		}

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(resolveClaudeBinary(), args, { cwd, windowsHide: true });
		} catch (err) {
			response.markdown(vscode.l10n.t('Could not start the Claude Code CLI. Make sure `claude` is installed and on your PATH.'));
			return { errorDetails: { message: err instanceof Error ? err.message : String(err) } };
		}

		const cancellation = token.onCancellationRequested(() => {
			try { child.kill(); } catch { /* already gone */ }
		});

		let sessionId = resumeId;
		let sawError = false;
		let answered = false;
		let spawnError: Error | undefined;
		let stderr = '';

		child.on('error', err => { spawnError = err; });
		child.stderr.on('data', chunk => { stderr += chunk.toString(); });
		// The prompt is passed via `-p`; close stdin so the CLI sees EOF and does not block waiting on input
		// (an open stdin pipe makes `claude` hang and never exit, so the turn would spin forever).
		child.stdin.end();

		const reader = createInterface({ input: child.stdout });
		reader.on('line', line => {
			if (token.isCancellationRequested) {
				return; // stop streaming into a response the user already cancelled
			}
			const trimmed = line.trim();
			if (!trimmed) {
				return;
			}
			let event: ClaudeStreamEvent;
			try {
				event = JSON.parse(trimmed) as ClaudeStreamEvent;
			} catch {
				return; // non-JSON noise; ignore
			}
			if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
				sessionId = event.session_id;
			} else if (event.type === 'assistant' && event.message?.content) {
				// Stream only assistant TEXT blocks. Tool-use blocks and the final `result` echo are skipped
				// so the transcript is not duplicated.
				for (const part of event.message.content) {
					if (part.type === 'text' && part.text) {
						response.markdown(part.text);
						answered = true;
					}
				}
			} else if (event.type === 'result') {
				if (event.session_id) {
					sessionId = event.session_id;
				}
				if (event.is_error) {
					sawError = true;
				}
			}
		});

		// Settle when BOTH the child exit (for the code) and the reader close (all NDJSON lines flushed) have
		// happened, so the final assistant text and result session_id are never missed - but also settle
		// immediately on a spawn 'error' (e.g. ENOENT), which does not reliably emit 'close' and would
		// otherwise hang the turn forever.
		let exitCode = 0;
		await new Promise<void>(resolve => {
			let childClosed = false;
			let readerClosed = false;
			const settle = () => { if (childClosed && readerClosed) { resolve(); } };
			child.on('close', code => { exitCode = code ?? 0; childClosed = true; settle(); });
			reader.on('close', () => { readerClosed = true; settle(); });
			child.on('error', () => { childClosed = true; readerClosed = true; resolve(); });
		});
		cancellation.dispose();

		if (token.isCancellationRequested) {
			return { metadata: { sessionId } };
		}
		if (spawnError) {
			response.markdown(vscode.l10n.t('Could not start the Claude Code CLI. Make sure `claude` is installed and that you are signed in (run `claude` in a terminal).'));
			return { errorDetails: { message: spawnError.message } };
		}
		if (sawError || exitCode !== 0 || !answered) {
			if (!answered) {
				response.markdown(vscode.l10n.t('Clawdius could not get a response from the Claude Code CLI. Check that you are signed in by running `claude` in a terminal.'));
			}
			return { errorDetails: { message: stderr.trim() || vscode.l10n.t('Claude CLI exited with code {0}.', exitCode) } };
		}

		return { metadata: { sessionId } };
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	context.subscriptions.push(participant);
}

export function deactivate(): void { }
