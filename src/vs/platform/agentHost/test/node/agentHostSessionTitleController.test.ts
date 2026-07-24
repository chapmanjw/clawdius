/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import { AgentHostSessionTitleController } from '../../node/agentHostSessionTitleController.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { SessionStatus, type SessionSummary } from '../../common/state/sessionState.js';
import { createSessionDataService } from '../common/sessionTestHelpers.js';

suite('AgentHostSessionTitleController', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createSummary(session: URI, title = ''): SessionSummary {
		return {
			resource: session.toString(),
			provider: 'claude',
			title,
			status: SessionStatus.Idle,
			createdAt: new Date(1).toISOString(),
			modifiedAt: new Date(1).toISOString(),
		};
	}

	function setup(title = ''): {
		controller: AgentHostSessionTitleController;
		stateManager: AgentHostStateManager;
		session: URI;
		titleActions: string[];
	} {
		const stateManager = disposables.add(new AgentHostStateManager(new NullLogService()));
		const session = URI.parse('agenthost-session://claude/session-title-test');
		stateManager.createSession(createSummary(session, title));
		const titleActions: string[] = [];
		disposables.add(stateManager.onDidEmitEnvelope(e => {
			if (e.action.type === ActionType.SessionTitleChanged) {
				titleActions.push(e.action.title);
			}
		}));
		const controller = disposables.add(new AgentHostSessionTitleController(stateManager, { sessionDataService: createSessionDataService() }, new NullLogService()));
		return { controller, stateManager, session, titleActions };
	}

	test('seedTitleFromFirstMessage applies the truncated fallback title', () => {
		const { controller, stateManager, session, titleActions } = setup();

		controller.seedTitleFromFirstMessage(session.toString(), '  Please   explain title generation  ');

		assert.deepStrictEqual({
			titles: titleActions,
			title: stateManager.getSessionState(session.toString())?.title,
		}, {
			titles: ['Please explain title generation'],
			title: 'Please explain title generation',
		});
	});

	test('seedTitleFromFirstMessage skips sessions with an existing title', () => {
		const { controller, stateManager, session, titleActions } = setup('Forked: Source title');

		controller.seedTitleFromFirstMessage(session.toString(), 'Continue forked session');

		assert.deepStrictEqual({
			titles: titleActions,
			title: stateManager.getSessionState(session.toString())?.title,
		}, {
			titles: [],
			title: 'Forked: Source title',
		});
	});

	test('cancelTitleGeneration is a no-op and does not throw', () => {
		const { controller, session } = setup();
		controller.cancelTitleGeneration(session.toString());
	});
});
