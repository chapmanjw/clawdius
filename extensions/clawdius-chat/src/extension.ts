/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { createInterface } from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const PARTICIPANT_ID = 'vscode.clawdius-chat.default';
const MODEL_VENDOR = 'clawdius';

// v1 is READ-ONLY/conversational. Under `claude -p` the CLI runs its OWN agent loop and can only use the
// tools we pre-approve here; everything else auto-denies. Read tools let Claude answer about the workspace
// without ever mutating it, running shell, or reaching the network. Agentic write mode (+ permission-mode
// selection and a permission bridge to the chat confirmation UI) is a follow-up.
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface ClaudeModelDef {
	readonly id: string; // the `claude --model` alias (always resolves to the latest of that family)
	readonly name: string;
	readonly detail: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly isDefault?: boolean;
}

// The Claude models offered in the picker, keyed by their `claude --model` alias.
const CLAUDE_MODELS: ReadonlyArray<ClaudeModelDef> = [
	{ id: 'opus', name: 'Claude Opus', detail: 'Most capable - deepest reasoning', maxInputTokens: 200_000, maxOutputTokens: 64_000, isDefault: true },
	{ id: 'sonnet', name: 'Claude Sonnet', detail: 'Balanced - fast and strong', maxInputTokens: 200_000, maxOutputTokens: 64_000 },
	{ id: 'haiku', name: 'Claude Haiku', detail: 'Fastest - lightweight', maxInputTokens: 200_000, maxOutputTokens: 32_000 },
];

/** The user's preferred effort, read from ~/.claude/settings.json so Clawdius mirrors the CLI's own setting. */
function defaultEffort(): string {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
		if (typeof settings.effortLevel === 'string' && (EFFORT_LEVELS as ReadonlyArray<string>).includes(settings.effortLevel)) {
			return settings.effortLevel;
		}
	} catch {
		// no settings / unreadable - fall back
	}
	return 'high';
}

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
interface ClaudeRunOptions {
	readonly model?: string;  // `claude --model` alias
	readonly effort?: string; // `claude --effort` level
}

function runClaude(prompt: string, cwd: string, token: vscode.CancellationToken, onText: (text: string) => void, opts: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
	return new Promise<ClaudeRunResult>(resolve => {
		// `--strict-mcp-config` with no `--mcp-config` skips the user's MCP servers, so a quick chat answer is
		// not delayed by (or noised up with) MCP server startup. Agentic mode can opt back in later.
		const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--allowed-tools', ...ALLOWED_TOOLS];
		if (opts.model) {
			args.push('--model', opts.model);
		}
		if (opts.effort) {
			args.push('--effort', opts.effort);
		}

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
	// Fire once after registration so the core eagerly RESOLVES our models into the renderer cache. Without a
	// change event, resolution is lazy (only on first request), so the panel model picker shows just the
	// synthetic "Auto" entry until the user sends a message. One fire is enough - the model list is static.
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this._onDidChange.event;
	notifyModelsChanged(): void { this._onDidChange.fire(); }
	dispose(): void { this._onDidChange.dispose(); }

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		// Per-model "effort" control (Claude Code's --effort), shown as a primary action in the model picker.
		const configurationSchema = {
			properties: {
				effort: {
					type: 'string',
					enum: [...EFFORT_LEVELS],
					enumItemLabels: ['Low', 'Medium', 'High', 'Extra High', 'Max'],
					default: defaultEffort(),
					description: 'Reasoning effort (Claude Code --effort).',
					group: 'navigation',
				},
			},
		};
		return CLAUDE_MODELS.map(model => ({
			id: model.id,
			name: model.name,
			detail: model.detail,
			family: 'claude',
			version: '1.0.0',
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			// Claude runs its own agent loop in the CLI, so it does not expose VS Code-side tool calling yet.
			capabilities: { toolCalling: false, imageInput: false },
			isDefault: model.isDefault ?? false,
			isUserSelectable: true,
			configurationSchema,
		}));
	}

	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart2>, token: vscode.CancellationToken): Promise<void> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const prompt = messagesToPrompt(messages);
		const configuredEffort = options.modelConfiguration?.effort;
		const effort = typeof configuredEffort === 'string' ? configuredEffort : defaultEffort();
		const result = await runClaude(prompt, cwd, token, text => progress.report(new vscode.LanguageModelTextPart(text)), { model: model.id, effort });
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

/**
 * Fetch the user's Claude rate-limit "capacity" (the /usage windows) and cache it to disk for the core
 * status-bar usage entry. The renderer can't reach api.anthropic.com (CORS); the extension host (node) can.
 * This is network egress to Claude's own API using the user's existing CLI OAuth token. It runs ON DEMAND
 * ONLY - the core usage status entry invokes the `clawdius.refreshUsageCapacity` command when the user opens
 * the usage UI. There is deliberately no startup fetch and no background timer, so a Clawdius install makes
 * zero uninitiated network egress (the zero-egress guarantee); the bars populate when the user looks at them.
 */
/**
 * Whether ~/.claude/settings.json points the engine at Anthropic's own API (vs Bedrock / Vertex / a custom base
 * URL). Only Anthropic exposes /api/oauth/usage, so the capacity fetch is skipped for any other provider - the IDE
 * never reaches api.anthropic.com when the user's engine is elsewhere. Mirrors detectProvider() in
 * claudeUsageData.ts. Defaults to Anthropic when settings are absent / unreadable.
 */
function engineIsAnthropic(): boolean {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
		const env = (settings && settings.env) || {};
		const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
		if (truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX)) {
			return false;
		}
		const baseUrl = env.ANTHROPIC_BASE_URL;
		if (typeof baseUrl === 'string' && baseUrl.length > 0 && !/api\.anthropic\.com/i.test(baseUrl)) {
			return false;
		}
		return true;
	} catch {
		return true;
	}
}

/** Minimum age of the cached limits before an automatic (non-forced) refresh re-hits the network. */
const USAGE_CAPACITY_TTL_MS = 60_000;

// --- Claude Code credential resolution (DELIBERATE HAND-MIRROR) ---
// A hand-mirror of src/vs/platform/clawdius/node/claudeCredentials.ts (extensions cannot import src/vs);
// branding-guard.ts pins both copies so they can't drift. This copy serves LOCAL windows.
//
// The CLI's secure-storage backend is "keychain-with-plaintext-fallback": on macOS the credentials live in the
// LOGIN KEYCHAIN as a generic-password item, and ~/.claude/.credentials.json is written ONLY when the Keychain
// write fails; on Windows/Linux there is no secret store, so the file is the only place they ever land. Reading
// the file alone is therefore a TOTAL MISS on macOS - the bug that reported signed-in mac users as "Signed out".
//
// We read the Keychain by SPAWNING /usr/bin/security, never a native binding (Electron safeStorage / keytar /
// node-keychain / @napi-rs/keyring): macOS evaluates the item's ACL against the process that CALLS the Keychain
// API. The item's trusted-application list contains /usr/bin/security and nothing else, so spawning it reads
// silently, whereas a native binding would make Clawdius.app the caller and pop a blocking "wants to use your
// confidential information" dialog at every launch. No network calls here. The token is NEVER logged.

/** The macOS login-Keychain generic-password service the CLI stores its OAuth credentials under. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** The CLI's fallback Keychain account when the unix username is not a safe attribute value. */
const KEYCHAIN_FALLBACK_ACCOUNT = 'claude-code-user';
/** Apple's keychain CLI, by ABSOLUTE path: no PATH lookup (no hijack, no GUI-launch PATH ambiguity). */
const SECURITY_BIN = '/usr/bin/security';
/** Bound the Keychain read - a locked keychain awaiting UI could otherwise stall the awaiting status bar. */
const KEYCHAIN_TIMEOUT_MS = 3_000;
/** errSecItemNotFound: the item genuinely does not exist (a definitive "signed out"). */
const ERR_SEC_ITEM_NOT_FOUND = 44;

interface ClaudeCredentials {
	readonly claudeAiOauth?: { readonly accessToken?: string };
}

/**
 * The Keychain SERVICE name, derived exactly as the CLI derives it: plain "Claude Code-credentials", except that a
 * CLAUDE_CONFIG_DIR / CLAUDE_SECURESTORAGE_CONFIG_DIR override appends `-<first 8 hex of sha256(NFC(dir))>`.
 * Hardcoding the base name would silently miss those users.
 */
function keychainServiceName(): string {
	const secureDir = process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'];
	const configDir = process.env['CLAUDE_CONFIG_DIR'];
	const noSuffix = secureDir !== undefined ? !secureDir : !configDir;
	if (noSuffix) {
		return KEYCHAIN_SERVICE;
	}
	const dir = (secureDir !== undefined ? secureDir : configDir!).normalize('NFC');
	return `${KEYCHAIN_SERVICE}-${createHash('sha256').update(dir).digest('hex').substring(0, 8)}`;
}

/** The Keychain ACCOUNT name, derived exactly as the CLI derives it: $USER (or the unix username), else a constant. */
function keychainAccountName(): string {
	let username: string | undefined;
	try {
		username = os.userInfo().username;
	} catch {
		username = undefined;
	}
	const account = process.env['USER'] || username;
	return account && /^[a-zA-Z0-9._-]+$/.test(account) ? account : KEYCHAIN_FALLBACK_ACCOUNT;
}

/**
 * One `security` invocation. RESOLVES, never rejects: `-w` prints the raw secret on stdout, so this must never be
 * able to smuggle the token into a rejected Error that an outer catch logs. A non-zero exit is reported as a CODE.
 */
function runSecurity(args: readonly string[]): Promise<{ code: number; stdout: string }> {
	return new Promise(resolve => {
		execFile(SECURITY_BIN, [...args], { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
			resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
		});
	});
}

/** Parse a credential document, keeping it only when it actually carries an OAuth access token. */
function parseCredentials(raw: string): ClaudeCredentials | undefined {
	try {
		const parsed = JSON.parse(raw.trim());
		const token = parsed?.claudeAiOauth?.accessToken;
		return typeof token === 'string' && token.length > 0 ? parsed as ClaudeCredentials : undefined;
	} catch {
		return undefined;
	}
}

type KeychainRead =
	| { readonly kind: 'found'; readonly creds: ClaudeCredentials }
	| { readonly kind: 'absent' }
	| { readonly kind: 'transient' };

async function readKeychainCredentials(): Promise<KeychainRead> {
	const service = keychainServiceName();
	const account = keychainAccountName();
	let res = await runSecurity(['find-generic-password', '-a', account, '-w', '-s', service]);
	if (res.code === ERR_SEC_ITEM_NOT_FOUND) {
		// `security` matches on whichever attributes you supply. Retry once WITHOUT -a before concluding the user is
		// signed out: the item may carry a different `acct` (e.g. the CLI last ran under another unix account).
		res = await runSecurity(['find-generic-password', '-w', '-s', service]);
	}
	if (res.code === 0) {
		const creds = parseCredentials(res.stdout);
		return creds ? { kind: 'found', creds } : { kind: 'absent' };
	}
	if (res.code === ERR_SEC_ITEM_NOT_FOUND) {
		return { kind: 'absent' };
	}
	// 36 (errSecInteractionNotAllowed - a locked keychain / headless SSH / launchd session), a timeout, or a spawn
	// failure. INDETERMINATE, NOT "signed out": rendering "Signed out" here would lie to a signed-in user.
	return { kind: 'transient' };
}

/** Resolution order, mirroring the CLI exactly: env token, then the macOS Keychain, then the plaintext file. */
async function resolveCredentials(claudeDir: string): Promise<{ creds?: ClaudeCredentials; indeterminate: boolean }> {
	// An explicit CLAUDE_CODE_OAUTH_TOKEN short-circuits every store in the CLI - such a user is signed in with
	// NEITHER a Keychain item NOR a file, so honour it first or we would call them signed out.
	const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
	if (typeof envToken === 'string' && envToken.length > 0) {
		return { creds: { claudeAiOauth: { accessToken: envToken } }, indeterminate: false };
	}
	let indeterminate = false;
	if (process.platform === 'darwin') {
		// Keychain FIRST (the CLI's primary store). Reading the file first would let a stale plaintext fallback, left
		// behind by an old failed write, shadow the live token - and every capacity fetch would then 401 forever.
		const read = await readKeychainCredentials();
		if (read.kind === 'found') {
			return { creds: read.creds, indeterminate: false };
		}
		indeterminate = read.kind === 'transient';
	}
	try {
		const fromFile = parseCredentials(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8'));
		if (fromFile) {
			return { creds: fromFile, indeterminate: false };
		}
	} catch {
		// absent / unreadable - fall through
	}
	return { creds: undefined, indeterminate };
}

/**
 * The "signed in" gate for a LOCAL window, invoked by the renderer over the `clawdius.hasClaudeCredentials` command
 * (the renderer has no child_process, so it cannot read the Keychain itself). `true` = a token exists; `false` =
 * definitively absent; `undefined` = INDETERMINATE (locked keychain / spawn failure) - the caller must then keep its
 * last known value rather than flipping the UI to "Signed out".
 */
async function hasCredentials(): Promise<boolean | undefined> {
	const { creds, indeterminate } = await resolveCredentials(path.join(os.homedir(), '.claude'));
	if (creds) {
		return true;
	}
	return indeterminate ? undefined : false;
}

async function fetchUsageCapacity(force = false): Promise<void> {
	// DELIBERATE MIRROR of ClaudeUsageCapacityService.refreshCapacity in src/vs/platform/clawdius/node (which
	// serves WSL/SSH remote windows against the remote ~/.claude); this copy serves LOCAL windows. Extensions
	// can't import src/vs, so the two must be kept in sync by hand. Both stay ON DEMAND ONLY (no timer/startup).
	try {
		const claudeDir = path.join(os.homedir(), '.claude');
		// Provider gate: only Anthropic's own API exposes /api/oauth/usage. If the engine is pointed at Bedrock /
		// Vertex / a custom base URL, do NOT reach api.anthropic.com - the subscription limits don't apply there.
		if (!engineIsAnthropic()) {
			return;
		}
		const cachePath = path.join(claudeDir, '.clawdius-usage-cache.json');
		// Freshness guard: an automatic refresh (opening a usage surface / hovering the status bar) reuses a cache
		// younger than the TTL instead of re-hitting the network on every glance. The explicit Refresh button
		// passes force=true to bypass this and always pull the latest subscription limits.
		if (!force) {
			try {
				const ageMs = Date.now() - fs.statSync(cachePath).mtimeMs;
				if (ageMs >= 0 && ageMs < USAGE_CAPACITY_TTL_MS) {
					return;
				}
			} catch {
				// no cache yet - fetch
			}
		}
		// The macOS login Keychain first (the CLI's primary store), then the plaintext file (the only store on
		// Windows/Linux). A file-only read here would 401-forever for a mac user with a stale plaintext fallback.
		const token = (await resolveCredentials(claudeDir)).creds?.claudeAiOauth?.accessToken;
		if (!token) {
			return;
		}
		const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
			headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
			// Bound the outbound call so a stalled api.anthropic.com connection can't hang the awaiting UI
			// (mirrors ClaudeUsageCapacityService).
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			return;
		}
		fs.writeFileSync(cachePath, await res.text());
	} catch {
		// offline / expired token - leave any existing cache in place
	}
}

export function activate(context: vscode.ExtensionContext): void {
	// Refresh the Claude capacity cache ON DEMAND only: the core usage status entry executes this command
	// when the user opens/hovers the usage UI. No startup fetch, no background poll - the zero-uninitiated-
	// network-egress guarantee (the fetch is api.anthropic.com egress with the user's CLI OAuth token).
	context.subscriptions.push(vscode.commands.registerCommand('clawdius.refreshUsageCapacity', (force?: unknown) => fetchUsageCapacity(force === true)));

	// The "signed in" probe for a LOCAL window. The renderer's usage surfaces stat ~/.claude/.credentials.json as a
	// zero-IPC fast path and fall back to this command on a miss, because on macOS the credentials live in the login
	// Keychain and only a node-side host can spawn /usr/bin/security to read them. Pull-only (the status-bar poll /
	// a view load drives it): no timer, and NO network egress - this reads the user's own local credentials.
	// NOTE: package.json must carry an `onCommand:clawdius.hasClaudeCredentials` activation event, or the renderer's
	// FIRST probe races extension-host activation, rejects, and the status bar paints "Signed out" until the 15s poll.
	context.subscriptions.push(vscode.commands.registerCommand('clawdius.hasClaudeCredentials', () => hasCredentials()));

	// Register Claude as a language model (the model picker + any model-using flow can now select it).
	const claudeProvider = new ClaudeLanguageModelProvider();
	context.subscriptions.push(claudeProvider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(MODEL_VENDOR, claudeProvider));
	// Fire the model-change event once so the core eagerly resolves our static models into the renderer
	// cache; otherwise the panel model picker shows only the synthetic "Auto" entry until the first request.
	queueMicrotask(() => claudeProvider.notifyModelsChanged());

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
