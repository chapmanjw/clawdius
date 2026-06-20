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

const PARTICIPANT_ID = 'vscode.clawdius-chat.default';
const MODEL_VENDOR = 'clawdius';
const MODEL_ID = 'claude-code';

// v1 is READ-ONLY/conversational. Under `claude -p` the CLI runs its OWN agent loop and can only use the
// tools we pre-approve here; everything else auto-denies. Read tools let Claude answer about the workspace
// without ever mutating it, running shell, or reaching the network. Agentic write mode + a permission
// bridge to the chat confirmation UI is a follow-up.
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

interface ClaudeStreamEvent {
	readonly type?: string;
	readonly subtype?: string;
	readonly session_id?: string;
	readonly is_error?: boolean;
	readonly result?: string;
	readonly message?: { readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }> };
}

interface ClaudeRunResult {
	readonly answered: boolean;
	readonly error?: string;
}

/**
 * Spawn the local Claude Code CLI with a single prompt and stream its assistant text. `claude -p` reads the
 * prompt from the arg and emits newline-delimited JSON; we forward every assistant text block to `onText`.
 */
function runClaude(prompt: string, cwd: string, token: vscode.CancellationToken, onText: (text: string) => void): Promise<ClaudeRunResult> {
	return new Promise<ClaudeRunResult>(resolve => {
		const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowed-tools', ...ALLOWED_TOOLS];

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(resolveClaudeBinary(), args, { cwd, windowsHide: true });
		} catch (err) {
			resolve({ answered: false, error: err instanceof Error ? err.message : String(err) });
			return;
		}

		const cancellation = token.onCancellationRequested(() => {
			try { child.kill(); } catch { /* already gone */ }
		});

		let answered = false;
		let sawError = false;
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
				return;
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
			if (event.type === 'assistant' && event.message?.content) {
				// Stream only assistant TEXT blocks; tool-use blocks and the final `result` echo are skipped.
				for (const part of event.message.content) {
					if (part.type === 'text' && part.text) {
						onText(part.text);
						answered = true;
					}
				}
			} else if (event.type === 'result' && event.is_error) {
				sawError = true;
			}
		});

		// Settle when BOTH the child exit (for the code) and the reader close (all NDJSON lines flushed) have
		// happened - but also settle immediately on a spawn 'error' (e.g. ENOENT), which does not reliably
		// emit 'close' and would otherwise hang forever.
		let exitCode = 0;
		let childClosed = false;
		let readerClosed = false;
		const settle = () => {
			if (childClosed && readerClosed) {
				cancellation.dispose();
				if (spawnError) {
					resolve({ answered, error: spawnError.message });
				} else if (sawError || exitCode !== 0 || !answered) {
					resolve({ answered, error: stderr.trim() || `Claude CLI exited with code ${exitCode}.` });
				} else {
					resolve({ answered, error: undefined });
				}
			}
		};
		child.on('close', code => { exitCode = code ?? 0; childClosed = true; settle(); });
		reader.on('close', () => { readerClosed = true; settle(); });
		child.on('error', () => { childClosed = true; readerClosed = true; settle(); });
	});
}

/** Extract plain text from a heterogeneous content array (text parts expose a string `value`). */
function partsToText(content: ReadonlyArray<unknown>): string {
	let text = '';
	for (const part of content) {
		const value = (part as { value?: unknown })?.value;
		if (typeof value === 'string') {
			text += value;
		} else if (typeof part === 'string') {
			text += part;
		}
	}
	return text;
}

/** Flatten a chat conversation into a single prompt for `claude -p` (it has no native multi-message input). */
function messagesToPrompt(messages: ReadonlyArray<vscode.LanguageModelChatRequestMessage>): string {
	const turns: string[] = [];
	for (const message of messages) {
		const text = partsToText(message.content as ReadonlyArray<unknown>).trim();
		if (!text) {
			continue;
		}
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'Assistant' : 'Human';
		turns.push(`${role}: ${text}`);
	}
	if (turns.length <= 1) {
		// Single user turn: hand Claude the raw prompt without role labels.
		return partsToText((messages[messages.length - 1]?.content ?? []) as ReadonlyArray<unknown>).trim();
	}
	return turns.join('\n\n');
}

/**
 * The Clawdius language model: Claude, served by the local Claude Code CLI. Registered through the standard
 * `lm.registerLanguageModelChatProvider` extension point, so it appears in the model picker alongside any
 * models other extensions contribute.
 */
class ClaudeLanguageModelProvider implements vscode.LanguageModelChatProvider {
	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		return [{
			id: MODEL_ID,
			name: 'Claude (Claude Code)',
			family: 'claude',
			version: '1.0.0',
			maxInputTokens: 200_000,
			maxOutputTokens: 64_000,
			// Claude runs its own agent loop in the CLI, so it does not expose VS Code-side tool calling yet.
			capabilities: { toolCalling: false, imageInput: false },
			isDefault: true,
			isUserSelectable: true,
		}];
	}

	async provideLanguageModelChatResponse(_model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], _options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart2>, token: vscode.CancellationToken): Promise<void> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const prompt = messagesToPrompt(messages);
		const result = await runClaude(prompt, cwd, token, text => progress.report(new vscode.LanguageModelTextPart(text)));
		if (result.error && !result.answered) {
			throw new Error(result.error);
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const str = typeof text === 'string' ? text : partsToText(text.content as ReadonlyArray<unknown>);
		// Rough heuristic (~4 chars/token); the Claude tokenizer is not exposed to the CLI.
		return Math.max(1, Math.ceil(str.length / 4));
	}
}

/** Convert chat history + the current prompt into language-model messages. */
function buildMessages(history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>, prompt: string): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	for (const turn of history) {
		const requestPrompt = (turn as vscode.ChatRequestTurn).prompt;
		if (typeof requestPrompt === 'string') {
			messages.push(vscode.LanguageModelChatMessage.User(requestPrompt));
			continue;
		}
		const response = (turn as vscode.ChatResponseTurn).response;
		if (Array.isArray(response)) {
			const text = partsToText(response.map(part => (part as { value?: unknown }).value));
			if (text.trim()) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(text));
			}
		}
	}
	messages.push(vscode.LanguageModelChatMessage.User(prompt));
	return messages;
}

export function activate(context: vscode.ExtensionContext): void {
	// Register Claude as a language model (the model picker + any model-using flow can now select it).
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(MODEL_VENDOR, new ClaudeLanguageModelProvider()));

	// The default panel participant is model-agnostic: it relays whatever model the user picked (Claude by
	// default, or any model another extension contributes) so the model picker is meaningful.
	const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token): Promise<vscode.ChatResult> => {
		if (!request.model) {
			response.markdown(vscode.l10n.t('No language model is available. Make sure the Claude Code CLI is installed and you are signed in (run `claude` in a terminal).'));
			return { errorDetails: { message: 'No language model available.' } };
		}
		try {
			const messages = buildMessages(chatContext.history, request.prompt);
			const chatResponse = await request.model.sendRequest(messages, {}, token);
			for await (const chunk of chatResponse.text) {
				response.markdown(chunk);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			response.markdown(vscode.l10n.t('Clawdius could not get a response from Claude: {0}', message));
			return { errorDetails: { message } };
		}
		return {};
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	context.subscriptions.push(participant);
}

export function deactivate(): void { }
