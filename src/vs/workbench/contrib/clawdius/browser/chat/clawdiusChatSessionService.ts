/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native webview Claude chat (Phase 3 INC-3: persistent session)
// Owns the native Claude chat's agent-host session for the lifetime of the WINDOW, so the conversation
// survives the chat ViewPane being disposed and re-created (e.g. closing/reopening the secondary side bar,
// or switching auxiliary-bar containers). The ViewPane subscribes to and dispatches against this session
// but no longer creates or disposes it; the session is created lazily on first use and disposed only when
// this singleton is torn down (window close). The ViewPane re-derives the full conversation from the
// authoritative SessionState on each (re)attach, so re-opening the pane re-paints the existing chat.

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';

export const IClawdiusChatSessionService = createDecorator<IClawdiusChatSessionService>('clawdiusChatSessionService');

export interface IClawdiusChatSessionService {
	readonly _serviceBrand: undefined;
	/** The window's persistent Claude chat session if one has been created, else undefined (no eager create). */
	getSession(): URI | undefined;
	/** The window's persistent Claude chat session, created lazily on first call. */
	getOrCreateSession(): Promise<URI>;
}

class ClawdiusChatSessionService extends Disposable implements IClawdiusChatSessionService {
	declare readonly _serviceBrand: undefined;

	private _sessionUri: URI | undefined;
	private _sessionInit: Promise<URI> | undefined;

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	getSession(): URI | undefined {
		return this._sessionUri;
	}

	getOrCreateSession(): Promise<URI> {
		if (!this._sessionInit) {
			this._sessionInit = (async () => {
				const workingDirectory = this._workspaceContextService.getWorkspace().folders[0]?.uri;
				const uri = await this._agentHostService.createSession({ provider: 'claude', workingDirectory });
				this._sessionUri = uri;
				return uri;
			})();
			this._sessionInit.catch(() => { this._sessionInit = undefined; });
		}
		return this._sessionInit;
	}

	override dispose(): void {
		if (this._sessionUri) {
			this._agentHostService.disposeSession(this._sessionUri).catch(err => this._logService.error('[clawdius-chat] disposeSession failed', err));
			this._sessionUri = undefined;
		}
		super.dispose();
	}
}

registerSingleton(IClawdiusChatSessionService, ClawdiusChatSessionService, InstantiationType.Delayed);
// CLAWDIUS-END
