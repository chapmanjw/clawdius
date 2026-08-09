/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, timeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IReference } from '../../../base/common/lifecycle.js';
import { autorun, constObservable, IObservable, ISettableObservable, observableValue } from '../../../base/common/observable.js';
import { mark } from '../../../base/common/performance.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { getDelayedChannel, IChannelServer, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Client as MessagePortClient } from '../../../base/parts/ipc/common/ipc.mp.js';
import { acquirePort } from '../../../base/parts/ipc/electron-browser/ipc.mp.js';
import { ipcRenderer } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { AgentHostIpcChannelTransport } from '../browser/agentHostIpcChannelTransport.js';
import { RemoteAgentHostProtocolClient } from '../browser/remoteAgentHostProtocolClient.js';
import { AhpJsonlLogger } from '../common/ahpJsonlLogger.js';
import { AGENT_HOST_CLIENT_BYOK_LM_CHANNEL, AgentHostClientByokLmChannel } from '../common/agentHostClientByokLmChannel.js';
import { AGENT_HOST_CLIENT_PROXY_CHANNEL, AgentHostClientProxyChannel } from '../common/agentHostClientProxyChannel.js';
import { IAgentHostEnablementService } from '../common/agentHostEnablementService.js';
// CLAWDIUS-BEGIN agent-host side channels (MCP tool discovery, usage contribution, usage stats)
import { ClaudeMcpToolDiscoveryChannelName, IClaudeMcpToolDiscoveryResult, IClaudeMcpToolDiscoveryService } from '../common/claudeMcpToolDiscovery.js';
import { ClaudeUsageContributionChannelName, IClaudeUsageContributionResult, IClaudeUsageContributionService } from '../common/claudeUsageContribution.js';
import { ClaudeUsageStatsChannelName, IClaudeUsageStatsResult, IClaudeUsageStatsService } from '../../clawdius/common/claudeUsageStats.js';
// CLAWDIUS-END
import { LOCAL_AGENT_HOST_RESOURCE_IDENTITY } from '../common/agentHostResourceService.js';
import {
	AgentHostAhpJsonlLoggingSettingId,
	AgentHostByokModelsEnabledSettingId,
	AgentHostIpcChannels,
	AgentHostOTelPolicyIpcChannel,
	AgentSession,
	IAgentCreateChatOptions,
	IAgentCreateSessionConfig,
	IAgentHostInspectInfo,
	IAgentHostManagementService,
	IAgentHostManagedSettingsDiagnostics,
	IAgentHostNetworkDiagnosticsInfo,
	IAgentHostNetworkFetchResult,
	IAgentHostService,
	IAgentHostSocketInfo,
	IAgentResolveSessionConfigParams,
	IAgentSessionConfigCompletionsParams,
	IAgentSessionMetadata,
	AuthenticateParams,
	AuthenticateResult,
	IMcpNotification,
	readAgentHostOTelPolicySettings,
} from '../common/agentService.js';
import type { IRemoteWatchHandle } from '../common/agentHostFileSystemProvider.js';
import type { IActiveSubscriptionInfo, IAgentSubscription } from '../common/state/agentSubscription.js';
import type { CompletionsParams, CompletionsResult, CreateTerminalParams, ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../common/state/protocol/commands.js';
import type { Implementation, InitializeResult } from '../common/state/protocol/common/commands.js';
import type { InvokeChangesetOperationParams, InvokeChangesetOperationResult } from '../common/state/protocol/channels-changeset/commands.js';
import type { CreateResourceWatchParams, CreateResourceWatchResult, ResourceCopyParams, ResourceCopyResult, ResourceDeleteParams, ResourceDeleteResult, ResourceListResult, ResourceMkdirParams, ResourceMkdirResult, ResourceMoveParams, ResourceMoveResult, ResourceReadResult, ResourceResolveParams, ResourceResolveResult, ResourceWriteParams, ResourceWriteResult } from '../common/state/sessionProtocol.js';
import type { ActionEnvelope, ChatAction, ClientAnnotationsAction, ClientChangesetAction, INotification, IRootConfigChangedAction, SessionAction, TerminalAction } from '../common/state/sessionActions.js';
import type { ComponentToState, RootState, StateComponents } from '../common/state/sessionState.js';

const LOG_PREFIX = '[AgentHost:renderer]';

/**
 * Renderer-side implementation of {@link IAgentHostService} for the local
 * agent host. State and request traffic use AHP over the Protocol channel;
 * management remains on the narrow Management IPC channel.
 */
export class LocalAgentHostServiceClient extends Disposable implements IAgentHostService {
	declare readonly _serviceBrand: undefined;

	readonly clientId = generateUuid();

	private readonly _clientEventually = new DeferredPromise<MessagePortClient>();
	private readonly _management: IAgentHostManagementService;
	// CLAWDIUS-BEGIN agent-host side channels
	private readonly _mcpDiscoveryProxy: IClaudeMcpToolDiscoveryService;
	private readonly _usageContributionProxy: IClaudeUsageContributionService;
	private readonly _usageStatsProxy: IClaudeUsageStatsService;
	private readonly _agentHostEnablementService: IAgentHostEnablementService;
	// CLAWDIUS-END
	private readonly _ahpLogger: AhpJsonlLogger | undefined;
	private _protocolClient: RemoteAgentHostProtocolClient | undefined;
	private _connectStarted = false;
	private _didStartInitialSessionList = false;
	private _didCompleteInitialSessionList = false;

	private readonly _onAgentHostExit = this._register(new Emitter<number>());
	readonly onAgentHostExit = this._onAgentHostExit.event;
	private readonly _onAgentHostStart = this._register(new Emitter<void>());
	readonly onAgentHostStart = this._onAgentHostStart.event;

	private readonly _authenticationPending: ISettableObservable<boolean> = observableValue('authenticationPending', true);
	readonly authenticationPending: IObservable<boolean> = this._authenticationPending;
	private _authenticationSettled = false;
	private readonly _noopRootState: IAgentSubscription<RootState> = {
		value: undefined,
		verifiedValue: undefined,
		onDidChange: Event.None,
		onWillApplyAction: Event.None,
		onDidApplyAction: Event.None,
	};

	constructor(
		private readonly _clientInfo: Implementation,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentHostEnablementService agentHostEnablementService: IAgentHostEnablementService,
	) {
		super();
		// CLAWDIUS-BEGIN agent-host side channels: delayed-channel proxies to the three Clawdius services
		// the agent host exposes alongside the AHP protocol channel. They are plain IPC channels, not AHP,
		// so they survive the protocol-client refactor unchanged.
		this._agentHostEnablementService = agentHostEnablementService;
		this._mcpDiscoveryProxy = ProxyChannel.toService<IClaudeMcpToolDiscoveryService>(
			getDelayedChannel(this._clientEventually.p.then(client => client.getChannel(ClaudeMcpToolDiscoveryChannelName)))
		);
		this._usageContributionProxy = ProxyChannel.toService<IClaudeUsageContributionService>(
			getDelayedChannel(this._clientEventually.p.then(client => client.getChannel(ClaudeUsageContributionChannelName)))
		);
		this._usageStatsProxy = ProxyChannel.toService<IClaudeUsageStatsService>(
			getDelayedChannel(this._clientEventually.p.then(client => client.getChannel(ClaudeUsageStatsChannelName)))
		);
		// CLAWDIUS-END
		this._management = ProxyChannel.toService<IAgentHostManagementService>(
			getDelayedChannel(this._clientEventually.p.then(client => client.getChannel(AgentHostIpcChannels.Management)))
		);
		this._ahpLogger = this._configurationService.getValue<boolean>(AgentHostAhpJsonlLoggingSettingId)
			? this._register(this._instantiationService.createInstance(AhpJsonlLogger, {
				logsHome: environmentService.logsHome,
				connectionId: this.clientId,
				transport: 'local',
			}))
			: undefined;

		this._register(autorun(reader => {
			if (agentHostEnablementService.enabled.read(reader)) {
				this.startAgentHost();
			}
		}));
	}

	startAgentHost(): void {
		if (!this._protocolClient) {
			const transport = new AgentHostIpcChannelTransport(
				getDelayedChannel(this._clientEventually.p.then(client => client.getChannel(AgentHostIpcChannels.Protocol))),
				this._ahpLogger,
			);
			this._protocolClient = this._register(this._instantiationService.createInstance(
				RemoteAgentHostProtocolClient,
				LOCAL_AGENT_HOST_RESOURCE_IDENTITY,
				transport,
				undefined,
				this.clientId,
				this._clientInfo,
			));
			this._register(this._protocolClient.onDidClose(() => this._onAgentHostExit.fire(0)));
		}

		void this._connect().catch(error => {
			this._protocolClient?.notifyTransportClosed();
			this._logService.error(`${LOG_PREFIX} Protocol connection failed`, error);
		});
	}

	private async _connect(): Promise<void> {
		if (this._connectStarted) {
			return;
		}
		this._connectStarted = true;
		mark('code/agentHost/willStart');

		this._logService.info(`${LOG_PREFIX} Acquiring MessagePort to agent host...`);
		ipcRenderer.send(AgentHostOTelPolicyIpcChannel, readAgentHostOTelPolicySettings(this._configurationService));
		const port = await acquirePort('vscode:createAgentHostMessageChannel', 'vscode:createAgentHostMessageChannelResult');
		mark('code/agentHost/didAcquireMessagePort');
		this._logService.info(`${LOG_PREFIX} MessagePort acquired, creating client...`);

		const store = this._register(new DisposableStore());
		const client = store.add(new MessagePortClient(port, this.clientId));
		registerAgentHostClientChannels(
			client,
			this._instantiationService,
			this._logService,
			this._configurationService.getValue<boolean>(AgentHostByokModelsEnabledSettingId) === true,
		);
		this._clientEventually.complete(client);

		const protocolClient = this._requireClient();
		await protocolClient.connect();
		mark('code/agentHost/didConnect');
		this._logService.info(`${LOG_PREFIX} Protocol connection established; clientId=${protocolClient.clientId}`);
		this._onAgentHostStart.fire();
	}

	private _requireClient(): RemoteAgentHostProtocolClient {
		if (!this._protocolClient) {
			throw new Error('Local agent host is not connected.');
		}
		return this._protocolClient;
	}

	setAuthenticationPending(pending: boolean): void {
		if (this._authenticationSettled) {
			return;
		}
		if (!pending) {
			this._authenticationSettled = true;
		}
		this._authenticationPending.set(pending, undefined);
	}

	get initializeResult(): IObservable<InitializeResult | undefined> {
		return this._protocolClient?.initializeResult ?? constObservable(undefined);
	}

	get rootState(): IAgentSubscription<RootState> {
		return this._protocolClient?.rootState ?? this._noopRootState;
	}

	get onDidAction(): Event<ActionEnvelope> {
		return this._protocolClient?.onDidAction ?? Event.None;
	}

	get onDidNotification(): Event<INotification> {
		return this._protocolClient?.onDidNotification ?? Event.None;
	}

	get onMcpNotification(): Event<IMcpNotification> {
		return this._protocolClient?.onMcpNotification ?? Event.None;
	}

	getSubscription<T extends StateComponents>(kind: T, resource: URI, owner: string): IReference<IAgentSubscription<ComponentToState[T]>> {
		return this._requireClient().getSubscription<ComponentToState[T]>(kind, resource, owner);
	}

	getSubscriptionUnmanaged<T extends StateComponents>(kind: T, resource: URI): IAgentSubscription<ComponentToState[T]> | undefined {
		return this._protocolClient?.getSubscriptionUnmanaged<ComponentToState[T]>(kind, resource);
	}

	getInflightSessionCreate(resource: URI): Promise<unknown> | undefined {
		return this._protocolClient?.getInflightSessionCreate(resource);
	}

	getActiveSubscriptions(): readonly IActiveSubscriptionInfo[] {
		return this._protocolClient?.getActiveSubscriptions() ?? [];
	}

	dispatch(channel: string, action: SessionAction | ChatAction | TerminalAction | ClientChangesetAction | ClientAnnotationsAction | IRootConfigChangedAction): void {
		this._requireClient().dispatch(channel, action);
	}

	authenticate(params: AuthenticateParams): Promise<AuthenticateResult> {
		return this._requireClient().authenticate(params);
	}

	listSessions(): Promise<IAgentSessionMetadata[]> {
		if (!this._didStartInitialSessionList) {
			this._didStartInitialSessionList = true;
			mark('code/agentHost/willListSessions');
		}
		return this._requireClient().listSessions().then(sessions => {
			if (!this._didCompleteInitialSessionList) {
				this._didCompleteInitialSessionList = true;
				mark('code/agentHost/didListSessions');
			}
			return sessions;
		});
	}

	createSession(config?: IAgentCreateSessionConfig): Promise<URI> {
		if (config && hasSessionExtensions(config)) {
			if (!config.provider) {
				throw new Error('Cannot create local agent host session without a provider.');
			}
			const session = config.session ?? AgentSession.uri(config.provider, generateUuid());
			const promise = this._management.createSessionWithExtensions({ ...config, session });
			this._requireClient().trackSessionCreate(session, promise);
			return promise;
		}
		return this._requireClient().createSession(config);
	}

	resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return this._requireClient().resolveSessionConfig(params);
	}

	sessionConfigCompletions(params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return this._requireClient().sessionConfigCompletions(params);
	}

	completions(params: CompletionsParams): Promise<CompletionsResult> {
		return this._requireClient().completions(params);
	}

	getCompletionTriggerCharacters(): Promise<readonly string[]> {
		return this._requireClient().getCompletionTriggerCharacters();
	}

	disposeSession(session: URI): Promise<void> {
		return this._requireClient().disposeSession(session);
	}

	createChat(session: URI, chat: URI, options?: IAgentCreateChatOptions): Promise<void> {
		if (options && hasChatExtensions(options)) {
			return this._management.createChatWithExtensions(session, chat, options);
		}
		return this._requireClient().createChat(session, chat, options);
	}

	disposeChat(chat: URI): Promise<void> {
		return this._requireClient().disposeChat(chat);
	}

	createTerminal(params: CreateTerminalParams): Promise<void> {
		return this._requireClient().createTerminal(params);
	}

	disposeTerminal(terminal: URI): Promise<void> {
		return this._requireClient().disposeTerminal(terminal);
	}

	invokeChangesetOperation(params: InvokeChangesetOperationParams): Promise<InvokeChangesetOperationResult> {
		return this._requireClient().invokeChangesetOperation(params);
	}

	handleMcpRequest(channel: string, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
		return this._requireClient().handleMcpRequest(channel, method, params);
	}

	resourceList(uri: URI): Promise<ResourceListResult> {
		return this._requireClient().resourceList(uri);
	}

	resourceRead(uri: URI): Promise<ResourceReadResult> {
		return this._requireClient().resourceRead(uri);
	}

	resourceWrite(params: ResourceWriteParams): Promise<ResourceWriteResult> {
		return this._requireClient().resourceWrite(params);
	}

	resourceCopy(params: ResourceCopyParams): Promise<ResourceCopyResult> {
		return this._requireClient().resourceCopy(params);
	}

	resourceDelete(params: ResourceDeleteParams): Promise<ResourceDeleteResult> {
		return this._requireClient().resourceDelete(params);
	}

	resourceMove(params: ResourceMoveParams): Promise<ResourceMoveResult> {
		return this._requireClient().resourceMove(params);
	}

	resourceResolve(params: ResourceResolveParams): Promise<ResourceResolveResult> {
		return this._requireClient().resourceResolve(params);
	}

	resourceMkdir(params: ResourceMkdirParams): Promise<ResourceMkdirResult> {
		return this._requireClient().resourceMkdir(params);
	}

	createResourceWatch(params: CreateResourceWatchParams): Promise<CreateResourceWatchResult> {
		return this._requireClient().createResourceWatch(params);
	}

	watchResource(params: CreateResourceWatchParams): Promise<IRemoteWatchHandle> {
		return this._requireClient().watchResource(params);
	}

	shutdown(): Promise<void> {
		return this._management.shutdown();
	}

	getNetworkDiagnosticsInfo(): Promise<IAgentHostNetworkDiagnosticsInfo> {
		return this._management.getNetworkDiagnosticsInfo();
	}

	getManagedSettingsDiagnostics(): Promise<readonly IAgentHostManagedSettingsDiagnostics[]> {
		return this._management.getManagedSettingsDiagnostics();
	}

	diagnosticsFetch(url: string): Promise<IAgentHostNetworkFetchResult> {
		return this._management.diagnosticsFetch(url);
	}

	async restartAgentHost(): Promise<void> {
		// Restart is managed by the main process lifecycle owner.
	}

	startWebSocketServer(): Promise<IAgentHostSocketInfo> {
		return this._management.startWebSocketServer();
	}

	getInspectInfo(tryEnable: boolean): Promise<IAgentHostInspectInfo | undefined> {
		return this._management.getInspectInfo(tryEnable);
	}

	/**
	 * Wait for the MessagePort client before issuing a side-channel RPC. The proxies above sit on delayed
	 * channels, so a call made while the host is down would queue and fire later - after the UI already
	 * reported a timeout. Racing READINESS (not the call) keeps the click-only egress contract: if the host
	 * is not up within the cap, no RPC is ever issued.
	 */
	private _whenClientReady(): Promise<boolean> {
		return Promise.race([
			this._clientEventually.p.then(() => true),
			timeout(30_000).then(() => false),
		]);
	}

	// CLAWDIUS-BEGIN live MCP tool discovery
	async discoverMcpServerTools(serverName: string, workingDirectoryPath: string, trusted: boolean): Promise<IClaudeMcpToolDiscoveryResult> {
		// Readiness guard: when the agent host is disabled the delayed channel would queue forever; report it
		// instead of hanging. We never auto-connect from a config dropdown.
		if (!this._agentHostEnablementService.enabled.get()) {
			return { status: 'disabled', tools: [], message: 'The Agent Host is disabled; enable it to load MCP tools.' };
		}
		if (!await this._whenClientReady()) {
			return { status: 'timeout', tools: [], message: 'Timed out reaching the Agent Host.' };
		}
		return this._mcpDiscoveryProxy.discoverServerTools(serverName, workingDirectoryPath, trusted);
	}
	// CLAWDIUS-END

	// CLAWDIUS-BEGIN usage-contribution fetch
	async fetchUsageContribution(workingDirectoryPath: string): Promise<IClaudeUsageContributionResult> {
		if (!this._agentHostEnablementService.enabled.get()) {
			return { text: undefined, status: 'disabled' };
		}
		if (!await this._whenClientReady()) {
			return { text: undefined, status: 'timeout' };
		}
		return this._usageContributionProxy.fetchUsageContribution(workingDirectoryPath);
	}
	// CLAWDIUS-END

	// CLAWDIUS-BEGIN transcript-derived usage stats
	async getUsageStats(homeDirPath: string): Promise<IClaudeUsageStatsResult> {
		if (!this._agentHostEnablementService.enabled.get()) {
			return { status: 'unavailable', message: 'The Agent Host is disabled; usage stats come from the CLI cache.' };
		}
		// Local file reads only - zero egress - so the readiness wait is purely about not hanging.
		if (!await this._whenClientReady()) {
			return { status: 'unavailable', message: 'Timed out reaching the Agent Host.' };
		}
		return this._usageStatsProxy.getUsageStats(homeDirPath);
	}
	// CLAWDIUS-END
}

function hasSessionExtensions(config: IAgentCreateSessionConfig): boolean {
	return config.model !== undefined || config.agent !== undefined || config.importConversation !== undefined;
}

function hasChatExtensions(options: IAgentCreateChatOptions): boolean {
	return options.title !== undefined || options.model !== undefined;
}

/**
 * Registers local-only IPC reverse channels for one renderer connection.
 */
export function registerAgentHostClientChannels(
	client: IChannelServer,
	instantiationService: IInstantiationService,
	logService: ILogService,
	byokEnabled: boolean,
): void {
	client.registerChannel(AGENT_HOST_CLIENT_PROXY_CHANNEL, instantiationService.createInstance(AgentHostClientProxyChannel));

	if (byokEnabled) {
		try {
			client.registerChannel(AGENT_HOST_CLIENT_BYOK_LM_CHANNEL, instantiationService.createInstance(AgentHostClientByokLmChannel));
		} catch (error) {
			logService.warn(`${LOG_PREFIX} BYOK language-model bridge not registered for this window. ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
