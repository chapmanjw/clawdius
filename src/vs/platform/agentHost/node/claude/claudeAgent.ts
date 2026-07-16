/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelInfo, Options, SDKSessionInfo, SDKUserMessage, WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { raceTimeout, SequencerByKey } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IAgentPluginManager, ISyncedCustomization } from '../../common/agentPluginManager.js';
import { createSchema, platformSessionSchema, schemaProperty } from '../../common/agentHostSchema.js';
import { ClaudePermissionMode, ClaudeSessionConfigKey, narrowClaudePermissionMode } from '../../common/claudeSessionConfigKeys.js';
import { createClaudeThinkingLevelSchema } from '../../common/claudeModelConfig.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { AgentProvider, AgentSession, AgentSignal, IActiveClient, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentMaterializeSessionEvent, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata, IAgentSessionProjectInfo } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { ProtectedResourceMetadata, type AgentSelection, type ModelSelection, type ToolDefinition } from '../../common/state/protocol/state.js';
import { isSubagentSession, parseSubagentSessionUri, ChatInputResponseKind, type ClientPluginCustomization, type Customization, type MessageAttachment, type PendingMessage, type ChatInputAnswer, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { IAgentHostGitService } from '../../common/agentHostGitService.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { projectFromContext } from './claudeGitProject.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { mapSessionMessagesToTurns, resolveForkAnchorUuid } from './claudeReplayMapper.js';
import { getSubagentTranscript } from './claudeSubagentResolver.js';
import { ClaudeAgentSession } from './claudeAgentSession.js';
import { handleCanUseTool } from './claudeCanUseTool.js';
import type { IAgentServerToolHost } from '../../common/agentServerTools.js';
import { resolvePromptToContentBlocks } from './claudePromptResolver.js';
import { readClaudePermissionMode } from './claudeSessionPermissionMode.js';
import { ClaudeSessionMetadataStore, IClaudeSessionOverlay } from './claudeSessionMetadataStore.js';
// CLAWDIUS-BEGIN live model discovery
import { buildOptions } from './claudeSdkOptions.js';
import { IClawdiusCliConfigService } from '../../../clawdius/common/clawdiusCliConfig.js';
// CLAWDIUS-END

// CLAWDIUS-BEGIN static claude catalog
// Published by _refreshModels in Clawdius mode (empty entitlementUrl). Ids are family aliases that are valid
// `claude --model` values the SDK resolves to the latest of each family. `provider` is omitted here and
// stamped at publish so it matches ClaudeAgent.id. models[0] (Opus) is the de-facto picker default.
const CLAWDIUS_STATIC_CLAUDE_MODELS: readonly Omit<IAgentModelInfo, 'provider'>[] = [
	{ id: 'opus', name: 'Claude Opus', maxContextWindow: 1_000_000, supportsVision: true, configSchema: createClaudeThinkingLevelSchema(['low', 'medium', 'high', 'xhigh', 'max']) },
	{ id: 'sonnet', name: 'Claude Sonnet', maxContextWindow: 1_000_000, supportsVision: true, configSchema: createClaudeThinkingLevelSchema(['low', 'medium', 'high', 'xhigh', 'max']) },
	{ id: 'haiku', name: 'Claude Haiku', maxContextWindow: 200_000, supportsVision: true, configSchema: createClaudeThinkingLevelSchema(['low', 'medium', 'high', 'xhigh', 'max']) },
];
// CLAWDIUS-END

// CLAWDIUS-BEGIN live model discovery
// The static catalog above is only a FALLBACK shown instantly at construction. The real, versioned catalog
// (e.g. "Opus 4.8", "Sonnet 5", "Fable 5", "Haiku 4.5" + descriptions + effort levels) is fetched from the
// SDK via `Query.supportedModels()` - the SAME source the official Claude Code chat picker uses - and
// republished once it resolves. This is egress-free: the control request runs over the local subprocess
// stdio, never a network /models call.

/** Overall wall-clock budget for a model-discovery attempt (startup + supportedModels control request). */
const DISCOVERY_TIMEOUT_MS = 20_000;

/**
 * Project the SDK's {@link ModelInfo} onto the agent host's {@link IAgentModelInfo}. `displayName` carries
 * the versioned name; `description` is stashed in `_meta` for the renderer/pill; `supportedEffortLevels`
 * (when the model supports effort) builds the thinking-level config schema. `provider` is stamped by the
 * caller. `ModelInfo` has no context-window field, so `maxContextWindow` is omitted - the description
 * conveys capability where it matters, and we do not invent a number.
 */
function modelInfoToAgentModel(m: ModelInfo): Omit<IAgentModelInfo, 'provider'> {
	const effortLevels = m.supportsEffort && m.supportedEffortLevels && m.supportedEffortLevels.length > 0
		? m.supportedEffortLevels
		: undefined;
	return {
		id: m.value,
		name: m.displayName,
		supportsVision: true,
		...(effortLevels ? { configSchema: createClaudeThinkingLevelSchema(effortLevels) } : {}),
		_meta: { description: m.description },
	};
}

/**
 * A streaming input that yields NO user message: the discovery query only needs the control channel
 * (`supportedModels()`), never a prompt. It stays suspended (keeping the input stream open so the query
 * stays live) until `signal` aborts, then returns - ending the stream so the subprocess can close.
 */
async function* discoveryInput(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
	if (!signal.aborted) {
		await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
	}
}
// CLAWDIUS-END

// Single source of truth for narrowing an arbitrary runtime value to
// the closed `ClaudePermissionMode` union now lives in
// `../../common/claudeSessionConfigKeys.ts` so it can be shared by
// `ClaudeAgent`, `ClaudeSessionMetadataStore`, and any other consumer
// that needs the same narrowing semantics. The live per-session read
// helper lives in `./claudeSessionPermissionMode.ts` so the session
// and materializer can read directly without threading callbacks
// through the agent.

// Provisional session state is hosted directly on {@link ClaudeAgentSession}
// (pre-materialize fields: project, abortController, provisionalModel,
// provisionalConfig). The legacy `IClaudeProvisionalSession` map shape
// was retired.

/**
 * Claude active-client handle. Tools read/write through the live session's
 * {@link SessionClientToolsModel}; customization assignment kicks off the
 * agent's async sync (via the provided closure). The handle caches the last
 * assigned customization inputs so the getter reflects what the client most
 * recently published.
 */
class ClaudeActiveClientHandle implements IActiveClient {
	private _customizations: readonly ClientPluginCustomization[] = [];

	constructor(
		readonly clientId: string,
		readonly displayName: string | undefined,
		private readonly _getTools: () => readonly ToolDefinition[],
		private readonly _setTools: (tools: readonly ToolDefinition[]) => void,
		private readonly _syncCustomizations: (customizations: readonly ClientPluginCustomization[]) => void,
	) { }

	get tools(): readonly ToolDefinition[] {
		return this._getTools();
	}
	set tools(tools: readonly ToolDefinition[]) {
		this._setTools(tools);
	}

	get customizations(): readonly ClientPluginCustomization[] {
		return this._customizations;
	}
	set customizations(customizations: readonly ClientPluginCustomization[]) {
		this._customizations = customizations;
		this._syncCustomizations(customizations);
	}
}

/**
 * {@link IAgent} provider for the Claude Agent SDK.
 *
 * In Clawdius mode the agent talks directly to Anthropic: the SDK
 * subprocess authenticates via native `~/.claude` OAuth, so there is no
 * GitHub/Copilot account, no protected resource, and no CAPI proxy. The
 * {@link models} observable is published at construction from a static
 * Claude family catalog ({@link CLAWDIUS_STATIC_CLAUDE_MODELS}); model
 * ids flow raw into the SDK `Options.model` / `claude --model` arg.
 */
export class ClaudeAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = 'claude';

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _onDidCustomizationsChange = this._register(new Emitter<void>());
	readonly onDidCustomizationsChange = this._onDidCustomizationsChange.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	// CLAWDIUS-BEGIN live model discovery
	/** Aborts an in-flight model-discovery query when the agent disposes. */
	private readonly _discoveryAbort = new AbortController();
	// CLAWDIUS-END

	private _serverToolHost: IAgentServerToolHost | undefined;

	/**
	 * Memoized teardown promise. Set on the first call to {@link shutdown},
	 * returned by every subsequent call. Mirrors `CopilotAgent.shutdown`
	 * at copilotAgent.ts:1246. There is no async work yet so the race
	 * is benign, but the contract is locked now so the real
	 * async teardown (Query.interrupt(), in-flight metadata writes)
	 * cannot regress.
	 */
	private _shutdownPromise: Promise<void> | undefined;

	/**
	 * Live in-memory session entries, keyed by raw session id (not URI).
	 * Each {@link ClaudeSessionEntry} owns its {@link ClaudeAgentSession} plus
	 * any per-session disposables registered against it (e.g. the forward
	 * subscription to the session's `onDidSessionProgress` event). Disposing
	 * the map disposes every entry, which in turn disposes everything
	 * registered to it — no parallel maps, no implicit lockstep invariants.
	 * {@link createSession} is the only writer; {@link disposeSession} and
	 * {@link shutdown} remove via {@link DisposableMap.deleteAndDispose}, which
	 * is idempotent if the key has already been removed.
	 */
	private readonly _sessions = this._register(new DisposableMap<string, ClaudeSessionEntry>());

	/** Stable active-client handles, keyed by `${sessionId}\0${clientId}`. */
	private readonly _activeClientHandles = new Map<string, ClaudeActiveClientHandle>();

	/**
	 * Fired once per session when {@link _materializeProvisional}
	 * promotes a provisional record into a real {@link ClaudeAgentSession}.
	 * The {@link IAgentService} subscribes via the platform contract
	 * (`agentService.ts:412`) to dispatch the deferred `sessionAdded`
	 * notification — observers don't see the session in their list until
	 * persistence has settled.
	 */
	private readonly _onDidMaterializeSession = this._register(new Emitter<IAgentMaterializeSessionEvent>());
	readonly onDidMaterializeSession = this._onDidMaterializeSession.event;

	/**
	 * Per-session-id serializer shared by {@link disposeSession} and
	 * {@link shutdown}. Dispose work is synchronous today, so the queued
	 * tasks resolve immediately and the sequencer is mostly a no-op. The
	 * routing is locked in now so the real async teardown (`Query.interrupt()`,
	 * in-flight metadata writes) inherits per-session serialization for free
	 * once it lands — a concurrent
	 * `disposeSession(uri)` already in flight is awaited before
	 * `shutdown()` reuses the same key.
	 */
	private readonly _disposeSequencer = new SequencerByKey<string>();

	/**
	 * Per-session-id serializer for {@link sendMessage}. Held
	 * across both {@link _materializeProvisional} AND `entry.send()` so
	 * two concurrent first-message calls on the same session collapse
	 * into one materialize plus two ordered sends. Separate from
	 * {@link _disposeSequencer} so a `disposeSession` racing a first send
	 * still serializes against in-flight teardown without deadlocking
	 * inside the send sequencer (different key spaces, single
	 * race-resolution lattice via the underlying `AbortController`).
	 */
	private readonly _sessionSequencer = new SequencerByKey<string>();

	private readonly _metadataStore: ClaudeSessionMetadataStore;

	/**
	 * Unified per-session lookup. Returns the session whether it is
	 * still provisional or already materialized; callers branch on
	 * {@link ClaudeAgentSession.isPipelineReady} when behavior differs.
	 */
	private _findAnySession(sessionId: string): ClaudeAgentSession | undefined {
		return this._sessions.get(sessionId)?.session;
	}

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IClaudeAgentSdkService private readonly _sdkService: IClaudeAgentSdkService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentPluginManager private readonly _pluginManager: IAgentPluginManager,
		@IProductService private readonly _productService: IProductService,
		// CLAWDIUS-BEGIN live model discovery
		@IClawdiusCliConfigService private readonly _cliConfigService: IClawdiusCliConfigService,
		// CLAWDIUS-END
	) {
		super();
		this._metadataStore = _instantiationService.createInstance(ClaudeSessionMetadataStore, this.id);
		// CLAWDIUS-BEGIN static claude catalog
		// No CAPI /models in Clawdius mode (empty entitlementUrl), so publish the static Claude catalog at
		// construction so the picker is never empty, then asynchronously replace it with the SDK's real
		// versioned catalog (Query.supportedModels() - see _discoverModels). Discovery is best-effort: any
		// failure leaves the static family names in place.
		if (!this._productService.defaultChatAgent?.entitlementUrl) {
			void this._refreshModels();
			void this._discoverModels();
		}
		// CLAWDIUS-END
	}

	// #region Descriptor + auth

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('claudeAgent.displayName', "Claude"),
			description: localize('claudeAgent.description', "Claude agent backed by the Anthropic Claude Agent SDK"),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		// No Copilot/GitHub account in Clawdius; the SDK subprocess authenticates via native ~/.claude OAuth,
		// so advertise no protected resource (the host never prompts for or requires GitHub auth).
		return [];
	}

	async authenticate(_resource: string, _token: string): Promise<boolean> {
		// Required by IAgent, but Clawdius has no Copilot/GitHub auth: the SDK subprocess uses native
		// ~/.claude OAuth and getProtectedResources() is empty, so the host never drives this. Reject all
		// resources rather than recording a token.
		return false;
	}

	private _refreshModels(): void {
		// CLAWDIUS-BEGIN static claude catalog
		// No CAPI /models in Clawdius mode. Publish a static Claude catalog of family aliases; ids flow raw
		// into Options.model (claudeSdkOptions.ts) and double as the `claude --model` arg. models[0] (Opus)
		// is the de-facto picker default.
		this._models.set(CLAWDIUS_STATIC_CLAUDE_MODELS.map(m => ({ ...m, provider: this.id })), undefined);
		// CLAWDIUS-END
	}

	// CLAWDIUS-BEGIN live model discovery
	/**
	 * Fetch the REAL model catalog from the SDK - `Query.supportedModels()`, the exact source the official
	 * Claude Code chat picker uses - and republish {@link models} with versioned display names, descriptions,
	 * and per-model effort levels. Egress-free: the control request runs over the local subprocess stdio, not
	 * a network /models call.
	 *
	 * Best-effort and fully guarded. The static family catalog is already published, so any failure (not
	 * signed in, CLI missing, timeout, offline) simply leaves the plain names in place. The whole attempt is
	 * bounded by {@link DISCOVERY_TIMEOUT_MS} and every subprocess is torn down in `finally`; a racing
	 * {@link dispose} aborts through {@link _discoveryAbort}. Discovery never runs a tool - it only uses the
	 * control channel - and its input stream yields no prompt, so nothing is ever sent to the model.
	 */
	private async _discoverModels(): Promise<void> {
		if (this._discoveryAbort.signal.aborted) {
			return;
		}
		// A per-attempt controller chained to agent dispose, so shutdown mid-discovery unwinds startup()/query.
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		this._discoveryAbort.signal.addEventListener('abort', onAbort, { once: true });
		let warm: WarmQuery | undefined;
		try {
			const cliResolution = await this._cliConfigService.resolveCliBackend();
			if (controller.signal.aborted) {
				return;
			}
			const options = await buildOptions(
				{
					sessionId: generateUuid(),
					workingDirectory: URI.file(homedir()),
					model: undefined,
					abortController: controller,
					permissionMode: 'default',
					trusted: true, // discovery never runs a governed tool, so the trust clamp is moot here
					// Discovery never runs a tool; the deny-all stub satisfies the required `canUseTool` type but
					// is never invoked (no prompt is ever sent).
					canUseTool: async () => ({ behavior: 'deny', message: 'model discovery: tools disabled', interrupt: true }),
					isResume: false,
					mcpServers: undefined,
					allowedTools: undefined,
					plugins: undefined,
					agent: undefined,
					cliResolution,
				},
				() => { /* discovery stderr is not user-facing */ },
				() => { /* no elicitation during discovery */ },
			);
			warm = await this._sdkService.startup({ options, initializeTimeoutMs: DISCOVERY_TIMEOUT_MS });
			if (controller.signal.aborted) {
				return;
			}
			const query = warm.query(discoveryInput(controller.signal));
			// Drain the message stream in the background so the query's init progresses (mirrors the plugin's
			// readSdkMessages()). We never send a prompt, so nothing meaningful arrives; it ends when the warm
			// query is disposed in `finally`. Fire-and-forget - never awaited (it would block on an idle query).
			void (async () => { try { for await (const _m of query) { /* ignore */ } } catch { /* torn down */ } })();
			const models = await raceTimeout(query.supportedModels(), DISCOVERY_TIMEOUT_MS);
			if (!models || models.length === 0 || this._discoveryAbort.signal.aborted) {
				return;
			}
			this._models.set(models.map(m => ({ ...modelInfoToAgentModel(m), provider: this.id })), undefined);
			this._logService.info(`[Claude] model discovery published ${models.length} model(s) from the SDK catalog`);
		} catch (err) {
			this._logService.info(`[Claude] model discovery failed; keeping the static family catalog: ${err}`);
		} finally {
			controller.abort();
			if (warm) {
				try {
					await warm[Symbol.asyncDispose]();
				} catch {
					/* ignore dispose error */
				}
			}
			this._discoveryAbort.signal.removeEventListener('abort', onAbort);
		}
	}
	// CLAWDIUS-END

	// #endregion

	// #region Stubs — implemented in later phases

	async createSession(config: IAgentCreateSessionConfig = {}): Promise<IAgentCreateSessionResult> {
		if (config.fork) {
			return this._forkSession(config, config.fork);
		}
		const sessionId = config.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = AgentSession.uri(this.id, sessionId);

		const existing = this._findAnySession(sessionId);
		if (existing) {
			if (!existing.isPipelineReady) {
				return {
					session: existing.sessionUri,
					workingDirectory: existing.workingDirectory,
					provisional: true,
					...(existing.project ? { project: existing.project } : {}),
				};
			}
			return { session: sessionUri, workingDirectory: config.workingDirectory };
		}

		const project = config.workingDirectory
			? await projectFromContext({ cwd: config.workingDirectory.fsPath }, this._gitService)
			: undefined;

		const permissionMode = this._resolvePermissionMode(config.config);

		const session = ClaudeAgentSession.createProvisional(
			sessionId,
			sessionUri,
			config.workingDirectory,
			project,
			config.model,
			config.agent,
			config.config,
			new PendingRequestRegistry<CallToolResult>(),
			permissionMode,
			this._metadataStore,
			this._instantiationService,
		);
		const entry = new ClaudeSessionEntry(session);
		entry.addDisposable(session.onDidSessionProgress(signal => this._onDidSessionProgress.fire(signal)));
		entry.addDisposable(session.onDidCustomizationsChange(() => this._onDidCustomizationsChange.fire()));
		this._sessions.set(sessionId, entry);

		return {
			session: sessionUri,
			workingDirectory: config.workingDirectory,
			provisional: true,
			...(project ? { project } : {}),
		};
	}

	/**
	 * In-place "Restore Checkpoint" truncation. Keeps turns
	 * `[0..turnId]` INCLUSIVE (or removes all turns when `turnId` is
	 * omitted) on the **same** session id / URI — unlike fork, which mints a
	 * new id. The `turnId` path resolves the protocol turn to its SDK
	 * assistant-envelope uuid ({@link resolveForkAnchorUuid}) and stages it
	 * as a one-shot `resumeSessionAt` anchor that the next turn's rebuild
	 * applies (the truncation finalizes when the next turn writes the
	 * branch). Serialized on {@link _sessionSequencer} (same key as
	 * `sendMessage`) so the `ChatTruncated` → `ChatTurnStarted` dispatch pair
	 * stays ordered. Provisional sessions short-circuit.
	 */
	async truncateSession(session: URI, turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(session);
		await this._sessionSequencer.queue(sessionId, async () => {
			const existing = this._findAnySession(sessionId);
			if (existing && !existing.isPipelineReady) {
				this._logService.info(`[Claude:${sessionId}] truncateSession on a provisional session — nothing to truncate`);
				return;
			}

			if (turnId === undefined) {
				await this._removeAllTurns(session, sessionId, existing);
				return;
			}

			const messages = await this._sdkService.getSessionMessages(sessionId, { includeSystemMessages: true });
			const anchor = resolveForkAnchorUuid(messages, turnId);
			if (anchor === undefined) {
				throw new Error(`Cannot truncate session ${sessionId}: turn ${turnId} not found in transcript`);
			}

			// Operate on a live session; cold-resume an unloaded one first so
			// there is a single code path that sets the anchor on a live
			// pipeline (the next send applies it).
			const live = existing ?? await this._resumeSession(sessionId, session);
			await live.truncateToTurn(turnId, anchor);
			this._logService.info(`[Claude:${sessionId}] truncateSession kept [0..${turnId}] (anchor=${anchor})`);
		});
	}

	/**
	 * Remove-all ("start over") branch of {@link truncateSession}: there is no
	 * anchor to resume at, so tear down the live Query, delete the on-disk
	 * transcript via the SDK, then recreate a fresh provisional under the SAME
	 * id/URI so the next `sendMessage` materializes non-resume `{ sessionId }`
	 * on a clean transcript (keeps the id stable). `deleteSession` is eagerly
	 * durable (unlike the lazy `turnId` path), matching its "clear / start
	 * over" semantic. `existing` is the live session, or `undefined` on the
	 * cold path (unloaded session). Caller serializes on {@link _sessionSequencer}.
	 */
	private async _removeAllTurns(session: URI, sessionId: string, existing: ClaudeAgentSession | undefined): Promise<void> {
		const info = existing ? undefined : await this._sdkService.getSessionInfo(sessionId);
		const workingDirectory = existing?.workingDirectory ?? (info?.cwd ? URI.file(info.cwd) : undefined);
		if (!workingDirectory) {
			// Mirror `_resumeSession` / fork: fail fast rather than recreate a
			// provisional with no cwd that would only fail later at materialize.
			throw new Error(`Cannot clear session ${sessionId}: workingDirectory missing (SDK cwd absent and no live session)`);
		}
		let overlay: IClaudeSessionOverlay = {};
		try {
			overlay = await this._metadataStore.read(session);
		} catch (err) {
			this._logService.warn(`[Claude:${sessionId}] overlay read failed during remove-all; continuing with defaults`, err);
		}

		// `shutdownLiveQuery` awaits the subprocess's actual exit (and its final
		// transcript flush), so the on-disk `<id>.jsonl` is now stable and safe
		// to delete: no live writer can recreate it before the next turn
		// respawns a fresh `--session-id <id>`.
		await existing?.shutdownLiveQuery();
		this._sessions.deleteAndDispose(sessionId);
		await this._sdkService.deleteSession(sessionId);

		await this.createSession({
			session,
			workingDirectory,
			...(overlay.model ? { model: overlay.model } : {}),
			...(overlay.agent ? { agent: overlay.agent } : {}),
			...(overlay.permissionMode ? { config: { [ClaudeSessionConfigKey.PermissionMode]: overlay.permissionMode } } : {}),
		});
		// Re-fetch (not reuse `existing`): `existing` is the OLD session, already
		// torn down by `deleteAndDispose` above, and is `undefined` entirely on
		// the cold path. `createSession` registered a fresh instance under the
		// same id — prune through that live session so a single path covers both
		// warm and cold remove-all.
		await this._findAnySession(sessionId)?.pruneAllTurns();
		this._logService.info(`[Claude:${sessionId}] truncateSession removed all turns (deleteSession + fresh same-id)`);
	}

	/**
	 * Fork an existing session at a protocol `turnId` (keep `[0..N]`
	 * INCLUSIVE) into a new, non-provisional session. The SDK `Query` is
	 * NOT started here: `forkSession` writes the transcript to
	 * disk and we return; the `Query` materializes lazily on the first
	 * {@link sendMessage} via {@link _resumeSession}. `turnId` is translated
	 * to the SDK envelope `uuid` by {@link resolveForkAnchorUuid};
	 * `config.fork.turnIdMapping` is ignored (the SDK already remaps uuids).
	 */
	private async _forkSession(config: IAgentCreateSessionConfig, fork: NonNullable<IAgentCreateSessionConfig['fork']>): Promise<IAgentCreateSessionResult> {
		if (isSubagentSession(fork.session)) {
			throw new Error('Cannot fork a subagent session');
		}
		const sourceSessionId = AgentSession.id(fork.session);
		const existingSource = this._findAnySession(sourceSessionId);
		if (existingSource && !existingSource.isPipelineReady) {
			throw new Error('Cannot fork a provisional/never-sent session');
		}
		// Serialize against the SOURCE session so the transcript read + fork
		// can't race an in-flight `sendMessage` mutating that session.
		return this._sessionSequencer.queue(sourceSessionId, async () => {
			const messages = await this._sdkService.getSessionMessages(sourceSessionId, { includeSystemMessages: true });
			const upToMessageId = resolveForkAnchorUuid(messages, fork.turnId);
			if (upToMessageId === undefined) {
				throw new Error(`Cannot fork session ${sourceSessionId}: turn ${fork.turnId} not found in transcript`);
			}
			const { sessionId: newSessionId } = await this._sdkService.forkSession(sourceSessionId, { upToMessageId });
			const newSessionUri = AgentSession.uri(this.id, newSessionId);

			// Inherit the source's model / permissionMode / agent (create-config
			// overrides win) so the lazy `_resumeSession` seeds `Options` from
			// it. `customizationDirectory` is NOT inherited — it is the source's
			// per-session synced plugin dir; the fork re-syncs its own.
			let sourceOverlay: IClaudeSessionOverlay = {};
			try {
				sourceOverlay = await this._metadataStore.read(fork.session);
			} catch (err) {
				this._logService.warn(`[Claude] fork: source overlay read failed for ${sourceSessionId}; continuing with defaults`, err);
			}
			const model = config.model ?? sourceOverlay.model;
			const agent = config.agent ?? sourceOverlay.agent;
			const permissionMode = narrowClaudePermissionMode(config.config?.[ClaudeSessionConfigKey.PermissionMode]) ?? sourceOverlay.permissionMode;
			await this._metadataStore.write(newSessionUri, {
				...(model ? { model } : {}),
				...(permissionMode ? { permissionMode } : {}),
				...(agent ? { agent } : {}),
			});

			// Resolve the forked session's working directory now so we can fail
			// fast (rather than at the first `sendMessage` when `_resumeSession`
			// requires a cwd). The Query itself starts lazily — see the JSDoc.
			const sdkInfo = await this._sdkService.getSessionInfo(newSessionId);
			const workingDirectory = sdkInfo?.cwd ? URI.file(sdkInfo.cwd) : config.workingDirectory;
			if (!workingDirectory) {
				throw new Error(`Cannot fork session ${sourceSessionId}: forked session ${newSessionId} has no working directory (SDK cwd missing and none supplied)`);
			}
			let project: IAgentSessionProjectInfo | undefined;
			try {
				project = await projectFromContext({ cwd: workingDirectory.fsPath }, this._gitService);
			} catch (err) {
				this._logService.warn(`[Claude] fork: project resolution failed for ${newSessionId}; continuing without project`, err);
			}
			return {
				session: newSessionUri,
				workingDirectory,
				...(project ? { project } : {}),
			};
		});
	}

	/**
	 * Promote a provisional {@link ClaudeAgentSession} into a live one.
	 * Called from {@link sendMessage} inside the {@link _sessionSequencer.queue}
	 * block, so concurrent first sends serialize naturally — exactly
	 * one materialize per session.
	 *
	 * Failure modes:
	 * - Missing session entry → programmer error, throws.
	 * - Aborted before SDK init returns → {@link ClaudeAgentSession.materialize}
	 *   disposes the `WarmQuery` and throws {@link CancellationError}.
	 * - Customization-directory persistence failure → fatal: the session's
	 *   `materialize` throws, the agent drops the entry, and the error
	 *   propagates so the caller learns about it.
	 * - Aborted post-metadata-write but pre-commit → second abort gate
	 *   inside `materialize` throws so we never expose a live pipeline
	 *   for a session the caller has already torn down.
	 */
	private async _materializeProvisional(sessionId: string): Promise<ClaudeAgentSession> {
		const session = this._findAnySession(sessionId);
		if (!session) {
			throw new Error(`Cannot materialize unknown provisional session: ${sessionId}`);
		}

		const canUseTool: NonNullable<Options['canUseTool']> = (toolName, input, options) =>
			handleCanUseTool(
				{ getSession: id => this._findAnySession(id), configurationService: this._configurationService },
				sessionId, toolName, input, options,
			);

		try {
			await session.materialize({ canUseTool, isResume: false, serverToolHost: this._serverToolHost });
		} catch (err) {
			this._sessions.deleteAndDispose(sessionId);
			throw err;
		}

		this._onDidMaterializeSession.fire({
			session: session.sessionUri,
			workingDirectory: session.workingDirectory,
			project: session.project,
		});

		return session;
	}

	/**
	 * Bring up a session whose state exists only on disk — created in
	 * another window, or before an agent-host restart. Mirror of
	 * `CopilotAgent._resumeSession`. Reads `workingDirectory` from the
	 * SDK's session record and `model` / `permissionMode` from the
	 * metadata overlay, constructs a provisional {@link ClaudeAgentSession},
	 * and calls {@link ClaudeAgentSession.materialize} with `isResume: true`
	 * so the SDK reloads the existing transcript instead of minting a
	 * fresh one.
	 *
	 * Caller must hold the session sequencer so two concurrent
	 * `sendMessage` calls for a freshly-resumed session collapse into
	 * one resume + two ordered sends.
	 */
	private async _resumeSession(sessionId: string, sessionUri: URI): Promise<ClaudeAgentSession> {
		this._logService.info(`[Claude:${sessionId}] _resumeSession — no in-memory state, rebuilding from disk`);
		const sdkInfo = await this._sdkService.getSessionInfo(sessionId);
		if (!sdkInfo) {
			throw new Error(`Cannot resume unknown session: ${sessionId} (not present in SDK transcript store)`);
		}
		const workingDirectory = sdkInfo.cwd ? URI.file(sdkInfo.cwd) : undefined;
		if (!workingDirectory) {
			throw new Error(`Cannot resume session ${sessionId}: workingDirectory missing from SDK transcript`);
		}
		let overlay: IClaudeSessionOverlay = {};
		try {
			overlay = await this._metadataStore.read(sessionUri);
		} catch (err) {
			this._logService.warn(`[Claude:${sessionId}] overlay read failed during resume; continuing with defaults`, err);
		}
		const permissionMode = readClaudePermissionMode(this._configurationService, sessionUri)
			?? overlay.permissionMode
			?? 'default';
		let project: IAgentSessionProjectInfo | undefined;
		try {
			project = await projectFromContext({ cwd: workingDirectory.fsPath }, this._gitService);
		} catch (err) {
			this._logService.warn(`[Claude:${sessionId}] project resolution failed during resume; continuing without project`, err);
		}

		const session = ClaudeAgentSession.createProvisional(
			sessionId,
			sessionUri,
			workingDirectory,
			project,
			overlay.model,
			overlay.agent,
			undefined,
			new PendingRequestRegistry<CallToolResult>(),
			permissionMode,
			this._metadataStore,
			this._instantiationService,
		);
		const entry = new ClaudeSessionEntry(session);
		entry.addDisposable(session.onDidSessionProgress(signal => this._onDidSessionProgress.fire(signal)));
		entry.addDisposable(session.onDidCustomizationsChange(() => this._onDidCustomizationsChange.fire()));
		this._sessions.set(sessionId, entry);

		const canUseTool: NonNullable<Options['canUseTool']> = (toolName, input, options) =>
			handleCanUseTool(
				{ getSession: id => this._findAnySession(id), configurationService: this._configurationService },
				sessionId, toolName, input, options,
			);

		try {
			await session.materialize({ canUseTool, isResume: true, serverToolHost: this._serverToolHost });
		} catch (err) {
			this._sessions.deleteAndDispose(sessionId);
			throw err;
		}

		this._onDidMaterializeSession.fire({
			session: sessionUri,
			workingDirectory,
			project,
		});

		return session;
	}

	/**
	 * Pull `permissionMode` out of the post-validation `IAgentCreateSessionConfig.config`
	 * bag, narrowing the runtime `unknown` value to the SDK's `PermissionMode`
	 * union (5/6 values, excluding `dontAsk`; sdk.d.ts:1560). Falls back to
	 * `'default'` when the bag is absent or carries something the schema
	 * validator shouldn't have accepted (defense-in-depth).
	 */
	private _resolvePermissionMode(config: Record<string, unknown> | undefined): ClaudePermissionMode {
		return narrowClaudePermissionMode(config?.[ClaudeSessionConfigKey.PermissionMode]) ?? 'default';
	}

	disposeSession(session: URI): Promise<void> {
		// Routed through {@link _disposeSequencer} so a concurrent
		// {@link shutdown} already serializing teardown for this same
		// session id awaits this work first (and vice versa). This
		// adds a provisional branch: when the session has not yet been
		// materialized, abort the controller (unblocks any racing
		// `await sdk.startup()`) and drop the record. No SDK contact,
		// no DB write — symmetric with `createSession`.
		const sessionId = AgentSession.id(session);
		return this._disposeSequencer.queue(sessionId, async () => {
			const sess = this._findAnySession(sessionId);
			if (sess && !sess.isPipelineReady) {
				sess.abortController.abort();
			}
			this._sessions.deleteAndDispose(sessionId);
			this._pruneActiveClientHandles(sessionId);
		});
	}

	/**
	 * Test-only accessor for the materialized {@link ClaudeAgentSession}.
	 * This needs to inspect `_isResumed` directly because there is no
	 * teardown+recreate flow yet to observe its effect
	 * (the flag drives `Options.resume = sessionId`). Marked
	 * `ForTesting` so the production surface stays unaware of its
	 * existence; the protocol surface (`IAgent`) does not include it.
	 */
	getSessionForTesting(session: URI): ClaudeAgentSession | undefined {
		const sess = this._sessions.get(AgentSession.id(session))?.session;
		return sess?.isPipelineReady ? sess : undefined;
	}

	/**
	 * Reconstruct the full turn history from the SDK's on-disk
	 * JSONL transcript. Out-of-process: no live `Query` required. Subagent
	 * URIs (`<parent>/subagent/<toolCallId>`) throw `TODO: not yet implemented`
	 * until `getSubagentMessages` is wired. Provisional sessions return `[]`.
	 * Resilient: any failure (transcript fetch, mapping, backfill) warn-logs
	 * and returns `[]` rather than propagating — mirrors `listSessions`.
	 */
	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const sessionId = AgentSession.id(session);
		const sess = this._findAnySession(sessionId);
		if (sess && !sess.isPipelineReady) {
			return [];
		}
		if (isSubagentSession(session)) {
			const parsed = parseSubagentSessionUri(session);
			const parentSession = parsed ? this._sessions.get(AgentSession.id(parsed.parentSession))?.session : undefined;
			if (!parentSession) {
				// Parent session is gone (disposed or never materialized).
				// The registry that holds the agentId cache lives on the
				// parent session, so we cannot resolve the subagent.
				this._logService.warn(`[Claude] getSessionMessages: parent session not found for subagent ${session.toString()} (registry unavailable)`);
				return [];
			}
			try {
				return await getSubagentTranscript(session, parentSession.subagents, this._sdkService, this._logService, CancellationToken.None);
			} catch (err) {
				this._logService.warn(`[Claude] getSubagentTranscript threw for ${session.toString()}`, err);
				return [];
			}
		}
		const parentSession = this._sessions.get(sessionId)?.session;
		let messages;
		try {
			messages = await this._sdkService.getSessionMessages(sessionId, { includeSystemMessages: true });
		} catch (err) {
			this._logService.warn(`[Claude] getSessionMessages SDK fetch failed for ${sessionId}`, err);
			return [];
		}
		let turns: readonly Turn[];
		try {
			turns = mapSessionMessagesToTurns(messages, session, this._logService);
		} catch (err) {
			// Defensive boundary: a single malformed SDK message must not
			// blow up the entire transcript read.
			this._logService.warn(`[Claude] replay mapper threw for ${sessionId}`, err);
			return [];
		}
		// If the parent session is materialized, prime its registry from
		// any agentId suffixes the SDK encoded in Task tool_result text
		// blocks so subsequent subagent transcript reads can short-circuit
		// the strategy chain. A bug in `primeFromTranscript` MUST NOT
		// break an otherwise-successful parent transcript read.
		try {
			parentSession?.subagents.primeFromTranscript(turns);
		} catch (err) {
			this._logService.warn(`[Claude] primeFromTranscript threw for ${sessionId}`, err);
		}
		return turns;
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		// SDK is the source of truth; the per-session DB
		// is a pure overlay/cache for Claude-namespaced fields like
		// `customizationDirectory`. We deliberately do NOT filter
		// entries that lack a DB — external Claude Code CLI sessions
		// have no DB and must still surface.
		//
		// Each per-session overlay read is independently try/caught so a
		// single corrupt DB cannot poison the wider listing. CopilotAgent's
		// `Promise.all`-with-throwing-mapper pattern at copilotAgent.ts:519
		// has a latent bug; we follow AgentService.listSessions's resilient
		// pattern (`agentService.ts:188-204`) instead.
		//
		// `AgentService.listSessions` fans out across all providers via
		// `Promise.all` (agentService.ts:202-204). If our SDK dynamic
		// import fails (corrupt install, missing optional dep) and we let
		// it reject, *every* provider's session list disappears — the
		// sibling Copilot provider gets nuked too. Catch and log instead.
		let sdkEntries: readonly SDKSessionInfo[];
		try {
			sdkEntries = await this._sdkService.listSessions();
		} catch (err) {
			this._logService.warn('[Claude] SDK listSessions failed; surfacing empty list', err);
			return [];
		}
		return Promise.all(sdkEntries.map(async entry => {
			try {
				const sessionUri = AgentSession.uri(this.id, entry.sessionId);
				const overlay = await this._metadataStore.read(sessionUri);
				return this._metadataStore.project(entry, overlay);
			} catch (err) {
				this._logService.warn(`[Claude] Overlay read failed for session ${entry.sessionId}`, err);
			}
			// External session, or DB read failed: surface what the SDK gave us.
			return this._metadataStore.project(entry, {});
		}));
	}

	/**
	 * Per-session lookup. Mirrors
	 * {@link CopilotAgent.getSessionMetadata} but accepts the
	 * external-CLI case: a session that exists on disk via the raw
	 * Anthropic CLI has no per-session DB, so we MUST NOT gate on the
	 * sidecar (the way Copilot's variant does). The SDK is the source
	 * of truth for existence; the overlay merely decorates.
	 *
	 * Failures in the overlay read are swallowed — a corrupt DB on one
	 * session must not lose the SDK-supplied summary/cwd. Failures in
	 * the SDK lookup propagate (the caller is doing a single targeted
	 * fetch and should learn that the SDK module is broken).
	 */
	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const sessionId = AgentSession.id(session);
		const sdkInfo = await this._sdkService.getSessionInfo(sessionId);
		if (!sdkInfo) {
			return undefined;
		}
		let overlay: IClaudeSessionOverlay = {};
		try {
			overlay = await this._metadataStore.read(session);
		} catch (err) {
			this._logService.warn(`[Claude] Overlay read failed for session ${sessionId}`, err);
		}
		return this._metadataStore.project(sdkInfo, overlay);
	}

	resolveSessionConfig(_params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		// Decision B5 (plan section 3.3.5): Claude collapses the platform's
		// `autoApprove` × `mode` two-axis approval surface onto a single
		// `permissionMode` axis matching the SDK's native enum. The
		// platform `Permissions` key is reused unchanged because the
		// Claude SDK accepts `allowedTools` / `disallowedTools`
		// natively. Skipped: AutoApprove, Mode, Isolation, Branch,
		// BranchNameHint — workbench pickers key off the property names
		// to decide what to render, so omitting these intentionally
		// suppresses the default mode/branch UI for Claude sessions.
		const sessionSchema = createSchema({
			[ClaudeSessionConfigKey.PermissionMode]: schemaProperty<ClaudePermissionMode>({
				type: 'string',
				title: localize('claude.sessionConfig.permissionMode', "Approvals"),
				description: localize('claude.sessionConfig.permissionModeDescription', "How Claude handles tool approvals."),
				enum: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
				enumLabels: [
					localize('claude.sessionConfig.permissionMode.default', "Ask Before Edits"),
					localize('claude.sessionConfig.permissionMode.acceptEdits', "Edit Automatically"),
					localize('claude.sessionConfig.permissionMode.plan', "Plan Mode"),
					localize('claude.sessionConfig.permissionMode.auto', "Auto Mode"),
					localize('claude.sessionConfig.permissionMode.bypassPermissions', "Bypass Permissions"),
				],
				enumDescriptions: [
					localize('claude.sessionConfig.permissionMode.defaultDescription', "Claude asks before editing files."),
					localize('claude.sessionConfig.permissionMode.acceptEditsDescription', "Claude edits files without asking, and asks before using other tools."),
					localize('claude.sessionConfig.permissionMode.planDescription', "Claude creates a plan before making changes."),
					localize('claude.sessionConfig.permissionMode.autoDescription', "Claude decides whether to ask for each tool operation."),
					localize('claude.sessionConfig.permissionMode.bypassPermissionsDescription', "Claude runs all tools without asking."),
				],
				default: 'default',
				sessionMutable: true,
			}),
			[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
		});

		const values = sessionSchema.validateOrDefault(_params.config, {
			[ClaudeSessionConfigKey.PermissionMode]: 'default' satisfies ClaudePermissionMode,
			// Permissions intentionally omitted from defaults — leave
			// unset so auto-approval falls through to the host-level
			// default, materializing on the session only once the user
			// approves a tool "in this Session".
		});

		return Promise.resolve({
			schema: sessionSchema.toProtocol(),
			values,
		});
	}

	sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		// Claude's only schema property is the
		// `permissionMode` static enum, so dynamic completion is
		// definitionally empty today. Branch completion lands once
		// worktree extraction is settled.
		return Promise.resolve({ items: [] });
	}

	shutdown(): Promise<void> {
		// Drain provisional sessions FIRST so any in-flight
		// `await sdk.startup()` (kicked off by a racing `sendMessage`)
		// observes the abort and unwinds. Each provisional record's
		// AbortController is wired into Options.abortController at
		// materialize time, so aborting here flips the same signal the
		// SDK is racing on.
		//
		// Then drain the materialized sessions through the existing
		// per-session {@link _disposeSequencer} routing — that path
		// inherits the real async teardown (`Query.interrupt()`,
		// in-flight metadata writes) once those land.
		//
		// The promise is memoized so concurrent callers share a single
		// drain pass — see `_shutdownPromise` JSDoc.
		// NOTE: declared sync (returns Promise<void>) rather than async
		// so that re-entrant calls return the cached promise *identity*,
		// not a fresh outer-async wrapper around it.
		return this._shutdownPromise ??= (async () => {
			for (const entry of this._sessions.values()) {
				if (!entry.session.isPipelineReady) {
					entry.session.abortController.abort();
				}
			}

			const sessionIds = [...this._sessions.keys()];
			await Promise.all(sessionIds.map(sessionId =>
				this._disposeSequencer.queue(sessionId, async () => {
					this._sessions.deleteAndDispose(sessionId);
					this._pruneActiveClientHandles(sessionId);
				})
			));
		})();
	}

	async sendMessage(sessionUri: URI, _chat: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		// Plan section 3.8. The sequencer scope holds across BOTH materialize
		// and `session.send` so two concurrent first-message calls on the
		// same session collapse into one materialize plus two ordered
		// sends. A `disposeSession` racing a first send reaches its own
		// dispose-sequencer eventually but the in-flight materialize
		// completes first.
		const sessionId = AgentSession.id(sessionUri);
		// `IAgent.sendMessage` declares `turnId?` (agentService.ts:424) but
		// every production caller in `AgentSideEffects` supplies one. Generate
		// a fallback so the session-side `QueuedRequest.turnId: string`
		// invariant holds even if a hypothetical caller forgets it.
		const effectiveTurnId = turnId ?? generateUuid();
		return this._sessionSequencer.queue(sessionId, async () => {
			const existing = this._findAnySession(sessionId);
			let session: ClaudeAgentSession;
			if (existing?.isPipelineReady) {
				session = existing;
			} else if (existing) {
				session = await this._materializeProvisional(sessionId);
			} else {
				session = await this._resumeSession(sessionId, sessionUri);
			}

			const contentBlocks = resolvePromptToContentBlocks(prompt, attachments);
			const sdkPrompt: SDKUserMessage = {
				type: 'user',
				message: { role: 'user', content: contentBlocks },
				session_id: sessionId,
				parent_tool_use_id: null,
				// Protocol invariant: `Turn.id ↔ SDKUserMessage.uuid`. The SDK
				// types this as a branded `${string}-…` template-literal
				// alias of Node's `crypto.UUID`; cast at the boundary
				// rather than threading the brand up to every caller.
				// Mirrors the reference extension at
				// `extensions/copilot/src/extension/chatSessions/claude/node/claudeCodeAgent.ts:585`.
				uuid: effectiveTurnId as `${string}-${string}-${string}-${string}-${string}`,
			};

			await session.send(sdkPrompt, effectiveTurnId);
		});
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		// `requestId` is the SDK's `tool_use_id` — globally unique, so a
		// single matching session is all we need. Silent on miss
		// (workbench may have raced a session dispose).
		for (const entry of this._sessions.values()) {
			if (entry.session.respondToPermissionRequest(requestId, approved)) {
				return;
			}
		}
	}

	respondToUserInputRequest(requestId: string, response: ChatInputResponseKind, answers?: Record<string, ChatInputAnswer>): void {
		// `requestId` is the SDK's `tool_use_id` (interactive tools
		// reuse it as the {@link ChatInputRequest.id}); globally
		// unique, so a single matching session is all we need. Silent
		// on miss for the same reasons as `respondToPermissionRequest`.
		for (const entry of this._sessions.values()) {
			if (entry.session.respondToUserInputRequest(requestId, response, answers)) {
				return;
			}
		}
	}

	async abortSession(session: URI): Promise<void> {
		// Cancel via the abort controller, NOT `Query.interrupt()`.
		// Abort is a control-plane operation — it must NOT serialize
		// through `_sessionSequencer` because an in-flight `sendMessage`
		// task is parked on its turn deferred and would deadlock the abort
		// behind the very turn it's trying to cancel. Calling
		// `entry.session.abort()` directly rejects the in-flight deferred,
		// which lets the queued sendMessage task complete and frees the
		// sequencer for the next caller.
		const sessionId = AgentSession.id(session);
		const sess = this._findAnySession(sessionId);
		if (!sess) {
			return;
		}
		if (!sess.isPipelineReady) {
			sess.abortController.abort();
			return;
		}
		sess.abort();
	}

	setPendingMessages(session: URI, steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
		// Queued messages are intentionally a no-op. AgentSideEffects
		// confirm queued messages are consumed
		// server-side; the agent boundary always receives an empty queue.
		const sessionId = AgentSession.id(session);
		this._logService.info(`[Claude:${sessionId}] setPendingMessages called: steering=${steeringMessage?.id ?? 'none'} queued=${_queuedMessages.length}`);
		const entry = this._sessions.get(sessionId);
		if (!entry) {
			this._logService.warn(`[Claude:${sessionId}] setPendingMessages: session not found`);
			return;
		}
		if (steeringMessage) {
			entry.session.injectSteering(steeringMessage);
		}
	}

	async changeModel(session: URI, model: ModelSelection): Promise<void> {
		// Session owns its own provisional/runtime branching and metadata
		// write (see {@link ClaudeAgentSession.setModel}). The agent only
		// covers the "external-only session" case where there is no
		// in-memory record to delegate to.
		const sessionId = AgentSession.id(session);
		await this._sessionSequencer.queue(sessionId, async () => {
			const sess = this._findAnySession(sessionId);
			if (sess) {
				await sess.setModel(model);
			} else {
				await this._metadataStore.write(session, { model });
			}
		});
	}

	/**
	 * Switch (or clear with `undefined`) the selected custom agent for an
	 * existing session. Mirrors {@link changeModel}: session owns its
	 * provisional/runtime branching and metadata write
	 * (see {@link ClaudeAgentSession.setAgent}). For external-only
	 * sessions (no in-memory record), the agent is persisted directly to
	 * the overlay so a later resume picks it up.
	 */
	async changeAgent(session: URI, agent: AgentSelection | undefined): Promise<void> {
		const sessionId = AgentSession.id(session);
		await this._sessionSequencer.queue(sessionId, async () => {
			const sess = this._findAnySession(sessionId);
			if (sess) {
				await sess.setAgent(agent);
			} else {
				await this._metadataStore.write(session, { agent: agent ?? null });
			}
		});
	}

	setServerToolHost(host: IAgentServerToolHost): void {
		this._serverToolHost = host;
	}

	getOrCreateActiveClient(session: URI, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const sessionId = AgentSession.id(session);
		const key = `${sessionId}\u0000${client.clientId}`;
		let handle = this._activeClientHandles.get(key);
		if (!handle) {
			handle = new ClaudeActiveClientHandle(
				client.clientId,
				client.displayName,
				() => this._findAnySession(sessionId)?.getClientTools(client.clientId) ?? [],
				tools => {
					this._logService.info(`[Claude:${sessionId}] active client ${client.clientId} tools=[${tools.map(t => t.name).join(', ') || '(none)'}]`);
					this._findAnySession(sessionId)?.setClientTools(client.clientId, tools);
				},
				customizations => { void this.syncClientCustomizations(session, client.clientId, [...customizations]); },
			);
			this._activeClientHandles.set(key, handle);
		}
		return handle;
	}

	removeActiveClient(session: URI, clientId: string): void {
		const sessionId = AgentSession.id(session);
		this._activeClientHandles.delete(`${sessionId}\u0000${clientId}`);
		// Tools are written synchronously, so remove them immediately. The
		// customization sync runs inside the session sequencer, so serialize
		// its removal there too — otherwise a late in-flight sync could
		// resurrect the removed client's customizations after it has left.
		this._findAnySession(sessionId)?.removeClientTools(clientId);
		void this._sessionSequencer.queue(sessionId, async () => {
			this._findAnySession(sessionId)?.removeClientCustomizations(clientId);
		}).catch(() => { /* session torn down */ });
	}

	/** Drop cached active-client handles belonging to a session being torn down. */
	private _pruneActiveClientHandles(sessionId: string): void {
		const prefix = `${sessionId}\u0000`;
		for (const key of [...this._activeClientHandles.keys()]) {
			if (key.startsWith(prefix)) {
				this._activeClientHandles.delete(key);
			}
		}
	}

	onClientToolCallComplete(session: URI, _chat: URI, toolCallId: string, result: ToolCallResult): void {
		let target = session;
		let parsed;
		while ((parsed = parseSubagentSessionUri(target))) {
			target = parsed.parentSession;
		}
		const sessionId = AgentSession.id(target);
		const entry = this._sessions.get(sessionId);
		// `AgentSideEffects` forwards every `ChatToolCallComplete` envelope
		// (including SDK-owned tools); silent on miss is the expected path.
		entry?.session.completeClientToolCall(toolCallId, result);
	}

	async syncClientCustomizations(session: URI, clientId: string, customizations: ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		const sessionId = AgentSession.id(session);
		const sess = this._findAnySession(sessionId);
		if (!sess) {
			this._logService.warn(`[Claude:${sessionId}] syncClientCustomizations: session not found`);
			return [];
		}
		// Run inside the session sequencer so that a fire-and-forget
		// customization sync cannot race ahead of a first `sendMessage`: if
		// `sendMessage` is already queued, the sync runs first or queues
		// behind it; either way the materialize call reads the most recently
		// adopted plugin set, never an empty one mid-sync.
		return this._sessionSequencer.queue(sessionId, async () => {
			const synced = await this._pluginManager.syncCustomizations(
				clientId,
				customizations,
				status => this._fireCustomizationUpdated(session, { customization: status }),
			);
			sess.adoptClientCustomizations(clientId, synced);
			return synced;
		});
	}

	/**
	 * Project a per-item sync result onto a `SessionCustomizationUpdated`
	 * action and emit it on {@link onDidSessionProgress}. Lets the workbench
	 * flip each row to `Loaded` / `Error` as the underlying
	 * {@link IAgentPluginManager.syncCustomizations} resolves it.
	 */
	private _fireCustomizationUpdated(session: URI, item: ISyncedCustomization): void {
		this._onDidSessionProgress.fire({
			kind: 'action',
			resource: session,
			action: {
				type: ActionType.SessionCustomizationUpdated,
				customization: item.customization,
			},
		});
	}

	setCustomizationEnabled(id: string, enabled: boolean): void {
		for (const entry of this._sessions.values()) {
			entry.session.setClientCustomizationEnabled(id, enabled);
		}
	}

	getCustomizations(): readonly Customization[] {
		// Provider-level customization catalogue — feeds `AgentInfo.customizations`
		// on `RootAgentsChanged`. Should advertise host-configured plugin refs
		// (the equivalent of Copilot's `agentHost.customizations` setting).
		// Claude has no such surface today; returning `[]` is correct rather
		// than aggregating client-pushed refs (those live on
		// `activeClient.customizations` per session).
		//
		// TODO: when host-level customizations become a real concept for the
		// agent host, lift `PluginController` out of `copilot/copilotAgent.ts`
		// into a shared service so both providers consume the same configured
		// host customization list rather than each maintaining their own.
		return [];
	}

	async getSessionCustomizations(session: URI): Promise<readonly Customization[]> {
		const sess = this._findAnySession(AgentSession.id(session));
		return sess ? await sess.getSessionCustomizations() : [];
	}

	// #endregion

	override dispose(): void {
		// Step 1: abort every provisional AbortController. These are
		// the same controllers wired into `Options.abortController` at
		// materialize time (sdk.d.ts:982), so any in-flight
		// `await sdk.startup()` will reject and any sequencer-queued
		// `_materializeProvisional` continuation will trip its
		// post-startup or post-customization-write abort gates,
		// disposing the WarmQuery without ever reaching
		// `_sessions.set(...)`. Without this step, dispose during a
		// concurrent first `sendMessage` could orphan a WarmQuery
		// subprocess. (Copilot reviewer: dispose lifecycle.)
		//
		// Step 2: `super.dispose()` synchronously disposes the
		// `_sessions` DisposableMap, firing each session wrapper's
		// `dispose()` (which interrupts/asyncDisposes its WarmQuery).
		for (const entry of this._sessions.values()) {
			if (!entry.session.isPipelineReady) {
				entry.session.abortController.abort();
			}
		}
		super.dispose();
		this._models.set([], undefined);
	}
}

/**
 * Bundle of a {@link ClaudeAgentSession} and any per-session disposables
 * registered against it (e.g. the agent's forward subscription to the
 * session's `onDidSessionProgress` event). One entry per materialized
 * session in {@link ClaudeAgent._sessions}; disposing the entry disposes
 * the session AND every extra registered via {@link addDisposable}.
 *
 * Lets new per-session lifecycle bindings (future config listeners,
 * abort wirings, etc.) attach to the session's lifetime without growing
 * a new parallel `DisposableMap` on the agent.
 */
class ClaudeSessionEntry extends Disposable {
	readonly session: ClaudeAgentSession;

	constructor(session: ClaudeAgentSession) {
		super();
		this.session = this._register(session);
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}
