/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN ultracode workflow store tests
import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentSession, IAgentHostService, IAgentSessionMetadata } from '../../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import { MessageKind, PendingMessageKind, SessionState } from '../../../../../platform/agentHost/common/state/protocol/channels-session/state.js';
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { encodeClaudeProjectDir, WorkflowStore } from '../../common/workflowStore.js';

const ROOT = URI.file('claude-home').with({ scheme: 'vscode-tests' });

suite('WorkflowStore', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let fileService: IFileService;
	let agentHost: TestAgentHostService;

	/** Minimal IAgentHostService stub: ownership (listSessions), live state (getSubscription), and dispatch. */
	interface CapturedAction {
		type: ActionType;
		turnId?: string;
		kind?: PendingMessageKind;
		id?: string;
		message?: { text: string; origin: { kind: MessageKind } };
	}

	class TestAgentHostService {
		sessions: IAgentSessionMetadata[] = [];
		sessionState: SessionState | undefined = undefined;
		readonly dispatched: { channel: string; action: CapturedAction }[] = [];

		async listSessions(): Promise<IAgentSessionMetadata[]> {
			return this.sessions;
		}

		getSubscription(_kind: unknown, _resource: URI, _owner: string) {
			const sub = { value: this.sessionState, onDidChange: Event.None };
			return { object: sub, dispose: () => { } };
		}

		dispatch(channel: string, action: CapturedAction): void {
			this.dispatched.push({ channel, action });
		}
	}

	/** Build an agent-host session whose decoded id matches a given on-disk sessionId. */
	function sessionMeta(sessionId: string): IAgentSessionMetadata {
		return { session: AgentSession.uri('claude', sessionId), startTime: 0, modifiedTime: 0 };
	}

	async function write(relativePath: string, content: string): Promise<void> {
		await fileService.writeFile(joinPath(ROOT, ...relativePath.split('/')), VSBuffer.fromString(content));
	}

	/** Seed a completed run summary under <proj>/<session>/workflows/<runId>.json. */
	function writeCompleted(proj: string, session: string, runId: string, summary: object): Promise<void> {
		return write(`.claude/projects/${proj}/${session}/workflows/${runId}.json`, JSON.stringify(summary));
	}

	/** Seed a running run journal under <proj>/<session>/subagents/workflows/<runId>/journal.jsonl. */
	function writeRunningJournal(proj: string, session: string, runId: string, agentIds: string[]): Promise<void> {
		const journal = agentIds.map(id => JSON.stringify({ type: 'started', agentId: id })).join('\n');
		return write(`.claude/projects/${proj}/${session}/subagents/workflows/${runId}/journal.jsonl`, journal);
	}

	function newStore(): WorkflowStore {
		return disposables.add(instantiationService.createInstance(WorkflowStore));
	}

	setup(() => {
		instantiationService = disposables.add(new TestInstantiationService());
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(ROOT.scheme, disposables.add(new InMemoryFileSystemProvider())));
		agentHost = new TestAgentHostService();

		instantiationService.stub(IFileService, fileService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IPathService, { userHome: async () => ROOT } as unknown as IPathService);
		instantiationService.stub(IAgentHostService, agentHost as unknown as IAgentHostService);
	});

	test('encodeClaudeProjectDir replaces separators and the drive colon', () => {
		assert.strictEqual(encodeClaudeProjectDir('C:\\Users\\me\\Projects\\App'), 'C--Users-me-Projects-App');
		assert.strictEqual(encodeClaudeProjectDir('/home/me/app'), '-home-me-app');
	});

	test('reads a completed run from its wf_*.json summary', async () => {
		await writeCompleted('proj', 'sess', 'wf_done', {
			runId: 'wf_done', workflowName: 'My Run', status: 'completed', agentCount: 2, totalTokens: 1234,
			workflowProgress: [
				{ type: 'workflow_agent', agentId: 'a1', label: 'reviewer', state: 'done' },
				{ type: 'workflow_agent', agentId: 'a2', label: 'fixer', state: 'done' },
			],
		});
		const store = newStore();
		await store.refresh();

		assert.strictEqual(store.runs.length, 1);
		const run = store.runs[0];
		assert.strictEqual(run.workflowName, 'My Run');
		assert.strictEqual(run.status, 'completed');
		assert.strictEqual(run.agents.length, 2);
		assert.strictEqual(run.totalTokens, 1234);
		// Completed runs carry no live-control info.
		assert.strictEqual(store.controlFor(run), undefined);
	});

	test('detects an in-progress run from its journal when no summary exists', async () => {
		await writeRunningJournal('proj', 'sess', 'wf_live', ['a1', 'a2']);
		const store = newStore();
		await store.refresh();

		assert.strictEqual(store.runs.length, 1);
		const run = store.runs[0];
		assert.strictEqual(run.status, 'running');
		assert.strictEqual(run.sessionId, 'sess');
		assert.strictEqual(run.agents.length, 2);
	});

	test('a running run with no live agent-host session is external (view-only)', async () => {
		await writeRunningJournal('proj', 'sess', 'wf_live', ['a1']);
		agentHost.sessions = []; // window owns nothing
		const store = newStore();
		await store.refresh();

		const control = store.controlFor(store.runs[0]);
		assert.strictEqual(control?.controllable, false, 'not controllable');
		assert.strictEqual(store.cancelWorkflow(store.runs[0]), false, 'cancel is a no-op');
		assert.strictEqual(agentHost.dispatched.length, 0, 'no dispatch for an external run');
	});

	test('a window-owned session with no active turn is not yet controllable', async () => {
		await writeRunningJournal('proj', 'sess', 'wf_live', ['a1']);
		agentHost.sessions = [sessionMeta('sess')]; // matches the run, but...
		agentHost.sessionState = { activeTurn: undefined } as unknown as SessionState; // ...no turn in flight
		const store = newStore();
		await store.refresh();

		const control = store.controlFor(store.runs[0]);
		assert.strictEqual(control?.controllable, false);
		assert.strictEqual(store.cancelWorkflow(store.runs[0]), false);
		assert.strictEqual(agentHost.dispatched.length, 0);
	});

	test('a window-driven running workflow is controllable and cancels its active turn', async () => {
		await writeRunningJournal('proj', 'sess', 'wf_live', ['a1', 'a2']);
		agentHost.sessions = [sessionMeta('sess')];
		agentHost.sessionState = { activeTurn: { id: 'turn-7' } } as unknown as SessionState;
		const store = newStore();
		await store.refresh();

		const run = store.runs[0];
		const control = store.controlFor(run);
		assert.strictEqual(control?.controllable, true, 'controllable while the window drives the turn');

		assert.strictEqual(store.cancelWorkflow(run), true);
		assert.strictEqual(agentHost.dispatched.length, 1, 'dispatched exactly one cancel');
		const { channel, action } = agentHost.dispatched[0];
		assert.strictEqual(channel, AgentSession.uri('claude', 'sess').toString());
		assert.strictEqual(action.type, ActionType.SessionTurnCancelled);
		assert.strictEqual(action.turnId, 'turn-7');
	});

	test('steering a window-driven workflow injects a Steering pending message', async () => {
		await writeRunningJournal('proj', 'sess', 'wf_live', ['a1']);
		agentHost.sessions = [sessionMeta('sess')];
		agentHost.sessionState = { activeTurn: { id: 'turn-7' } } as unknown as SessionState;
		const store = newStore();
		await store.refresh();

		assert.strictEqual(store.steerWorkflow(store.runs[0], '  also check error handling  '), true);
		assert.strictEqual(agentHost.dispatched.length, 1);
		const { channel, action } = agentHost.dispatched[0];
		assert.strictEqual(channel, AgentSession.uri('claude', 'sess').toString());
		assert.strictEqual(action.type, ActionType.SessionPendingMessageSet);
		assert.strictEqual(action.kind, PendingMessageKind.Steering);
		assert.strictEqual(action.message?.text, 'also check error handling', 'trimmed message text');
		assert.strictEqual(action.message?.origin.kind, MessageKind.User);
		assert.ok(action.id, 'carries a generated id');
	});

	test('steering is a no-op for external runs, idle sessions, and empty text', async () => {
		await writeRunningJournal('proj', 'sess', 'wf_live', ['a1']);
		const store = newStore();

		// External (no matching session).
		agentHost.sessions = [];
		await store.refresh();
		assert.strictEqual(store.steerWorkflow(store.runs[0], 'hi'), false, 'external run');

		// Window-owned but no active turn.
		agentHost.sessions = [sessionMeta('sess')];
		agentHost.sessionState = { activeTurn: undefined } as unknown as SessionState;
		await store.refresh();
		assert.strictEqual(store.steerWorkflow(store.runs[0], 'hi'), false, 'no active turn');

		// Window-driven but empty message.
		agentHost.sessionState = { activeTurn: { id: 't1' } } as unknown as SessionState;
		await store.refresh();
		assert.strictEqual(store.steerWorkflow(store.runs[0], '   '), false, 'empty text');

		assert.strictEqual(agentHost.dispatched.length, 0, 'never dispatched');
	});

	test('a run with both a summary and a journal dir is listed once (completed wins)', async () => {
		await writeCompleted('proj', 'sess', 'wf_x', { runId: 'wf_x', workflowName: 'Done', status: 'completed', agentCount: 1, workflowProgress: [] });
		await writeRunningJournal('proj', 'sess', 'wf_x', ['a1']);
		const store = newStore();
		await store.refresh();

		assert.strictEqual(store.runs.length, 1, 'not double-listed');
		assert.strictEqual(store.runs[0].status, 'completed');
	});

	test('running runs sort ahead of completed ones', async () => {
		await writeCompleted('proj', 'sess', 'wf_done', { runId: 'wf_done', workflowName: 'Done', status: 'completed', agentCount: 0, workflowProgress: [] });
		await writeRunningJournal('proj', 'sess', 'wf_live', ['a1']);
		const store = newStore();
		await store.refresh();

		assert.strictEqual(store.runs.length, 2);
		assert.strictEqual(store.runs[0].status, 'running', 'running first');
		assert.strictEqual(store.runs[1].status, 'completed');
	});

	test('skips a run whose summary JSON is unparseable', async () => {
		await write('.claude/projects/proj/sess/workflows/wf_bad.json', '{ not valid json');
		await writeCompleted('proj', 'sess', 'wf_ok', { runId: 'wf_ok', workflowName: 'Ok', status: 'completed', agentCount: 0, workflowProgress: [] });
		const store = newStore();
		await store.refresh();

		assert.strictEqual(store.runs.length, 1);
		assert.strictEqual(store.runs[0].workflowName, 'Ok');
	});

	test('strips a UTF-8 BOM before parsing a summary', async () => {
		await write('.claude/projects/proj/sess/workflows/wf_bom.json', '﻿' + JSON.stringify({ runId: 'wf_bom', workflowName: 'Bom', status: 'completed', agentCount: 0, workflowProgress: [] }));
		const store = newStore();
		await store.refresh();

		assert.strictEqual(store.runs.length, 1);
		assert.strictEqual(store.runs[0].workflowName, 'Bom');
	});

	test('no Claude projects directory yields an empty board without throwing', async () => {
		const store = newStore();
		await store.refresh(); // ROOT/.claude/projects does not exist
		assert.strictEqual(store.runs.length, 0);
	});

	test('disposing releases held session subscriptions', async () => {
		await writeRunningJournal('proj', 'sess', 'wf_live', ['a1']);
		agentHost.sessions = [sessionMeta('sess')];
		agentHost.sessionState = { activeTurn: { id: 't1' } } as unknown as SessionState;

		let disposed = false;
		const original = agentHost.getSubscription.bind(agentHost);
		agentHost.getSubscription = (kind: unknown, resource: URI, owner: string) => {
			const ref = original(kind, resource, owner);
			return { object: ref.object, dispose: () => { disposed = true; } };
		};

		const store = disposables.add(instantiationService.createInstance(WorkflowStore));
		await store.refresh();
		assert.strictEqual(store.controlFor(store.runs[0])?.controllable, true);

		store.dispose();
		assert.strictEqual(disposed, true, 'the held subscription is released on dispose');
	});
});
// CLAWDIUS-END
