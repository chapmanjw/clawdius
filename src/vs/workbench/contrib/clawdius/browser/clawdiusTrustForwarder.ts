/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Workspace-trust forwarder
// Projects VS Code's workspace-trust state (IWorkspaceTrustManagementService) into every connected agent host's
// root config as a `trust` object, so the agent-host tool gate can enforce deny-by-default in an untrusted
// workspace. This is the trust SOURCE that takes the node gate out of its dormant (default-trusted) state:
//   - untrusted workspace -> { trusted: false } (gate hard-denies writes / shell / MCP / URL; reads still proceed)
//   - trusted workspace    -> { trusted: true }  (full access, matching VS Code's binary workspace trust)
// Mirrors AgentHostSandboxForwarder: one-directional, schema-guarded, pushes on connect + on trust change.

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { IAgentHostConnectionsService } from '../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { ActionType } from '../../../../platform/agentHost/common/state/protocol/actions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import { AgentHostTrustConfigKey, AgentHostTrustKey, ITrustConfigValue } from '../../../../platform/agentHost/common/trustConfigSchema.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

export class ClawdiusTrustForwarder extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.clawdiusTrustForwarder';

	/** Connections whose initial push has been attempted (directly or via a pending schema listener). */
	private readonly _scheduled = new Map<IAgentConnection, IDisposable>();
	private _desired: ITrustConfigValue | undefined;

	constructor(
		@IAgentHostConnectionsService private readonly _connectionsService: IAgentHostConnectionsService,
		@IWorkspaceTrustManagementService private readonly _trustService: IWorkspaceTrustManagementService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Re-push whenever the workspace trust decision OR the set of trusted folders changes (either can flip the
		// workspace-wide isWorkspaceTrusted() result).
		this._register(this._trustService.onDidChangeTrust(() => { this._desired = undefined; this._pushToAllConnections(); }));
		this._register(this._trustService.onDidChangeTrustedFolders(() => { this._desired = undefined; this._pushToAllConnections(); }));

		this._register(this._connectionsService.onDidChangeConnections(() => this._syncConnectionListeners()));
		this._syncConnectionListeners();
	}

	private _syncConnectionListeners(): void {
		const live = new Set<IAgentConnection>();
		for (const info of this._connectionsService.connections) {
			if (!info.connection) {
				continue;
			}
			live.add(info.connection);
			if (!this._scheduled.has(info.connection)) {
				this._scheduleInitialPush(info.connection);
			}
		}
		for (const [connection, listener] of this._scheduled) {
			if (!live.has(connection)) {
				listener.dispose();
				this._scheduled.delete(connection);
			}
		}
	}

	/** Push now if the host already advertises the trust schema; else wait for it via rootState.onDidChange, once. */
	private _scheduleInitialPush(connection: IAgentConnection): void {
		if (this._tryPush(connection)) {
			this._scheduled.set(connection, Disposable.None);
			return;
		}
		const listener = connection.rootState.onDidChange(() => {
			if (this._tryPush(connection)) {
				this._scheduled.get(connection)?.dispose();
				this._scheduled.set(connection, Disposable.None);
			}
		});
		this._scheduled.set(connection, listener);
	}

	private _pushToAllConnections(): void {
		for (const info of this._connectionsService.connections) {
			if (info.connection) {
				this._tryPush(info.connection);
			}
		}
	}

	/**
	 * Dispatch the desired trust config to `connection` if it differs from what the host already holds. Returns
	 * true once the host advertises the trust schema (whether or not a dispatch was needed); false while waiting.
	 */
	private _tryPush(connection: IAgentConnection): boolean {
		const rootState = connection.rootState.value;
		if (!rootState || rootState instanceof Error) {
			return false;
		}
		const schemaProperties = rootState.config?.schema.properties;
		if (!schemaProperties?.[AgentHostTrustConfigKey.Trust]) {
			return false;
		}
		const desired = this._getDesired();
		const current = (rootState.config?.values?.[AgentHostTrustConfigKey.Trust] as Record<string, unknown> | undefined) ?? {};
		if (!equals(current, desired as Record<string, unknown>)) {
			this._logService.trace(`[clawdius-trust] forwarding trusted=${desired[AgentHostTrustKey.Trusted]}`);
			connection.dispatch(ROOT_STATE_URI, {
				type: ActionType.RootConfigChanged,
				config: { [AgentHostTrustConfigKey.Trust]: desired },
			});
		}
		return true;
	}

	private _getDesired(): ITrustConfigValue {
		if (this._desired === undefined) {
			this._desired = this._computeDesired();
		}
		return this._desired;
	}

	/** The trust config to forward: the workspace-wide trusted flag. A trusted workspace grants full access; an
	 *  untrusted one denies writes / shell / MCP / URL at the gate. */
	private _computeDesired(): ITrustConfigValue {
		return { [AgentHostTrustKey.Trusted]: this._trustService.isWorkspaceTrusted() };
	}

	override dispose(): void {
		for (const listener of this._scheduled.values()) {
			listener.dispose();
		}
		this._scheduled.clear();
		super.dispose();
	}
}
// CLAWDIUS-END
