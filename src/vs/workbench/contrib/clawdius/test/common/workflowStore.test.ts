/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native main-IDE clawdius container (Phase 2b: read-only workflow store tests)
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
import { IPathService } from '../../../../services/path/common/pathService.js';
import { encodeClaudeProjectDir, WorkflowStore } from '../../common/workflowStore.js';

const ROOT = URI.file('claude-home').with({ scheme: 'vscode-tests' });

suite('Clawdius WorkflowStore (read-only)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let fileService: IFileService;

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
		instantiationService.stub(IFileService, fileService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IPathService, { userHome: async () => ROOT } as unknown as IPathService);
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
		assert.strictEqual(run.agentCount, 2);
		assert.strictEqual(run.totalTokens, 1234);
		assert.deepStrictEqual(run.agents.map(a => a.label), ['reviewer', 'fixer']);
	});

	test('no ~/.claude/projects dir yields an empty run list', async () => {
		const store = newStore();
		await store.refresh();
		assert.deepStrictEqual(store.runs, []);
	});

	test('reads a live running run from its journal (status running, agents from journal)', async () => {
		await writeRunningJournal('proj', 'sess', 'wf_live', ['x1', 'x2']);
		const store = newStore();
		await store.refresh();
		assert.strictEqual(store.runs.length, 1);
		const run = store.runs[0];
		assert.strictEqual(run.runId, 'wf_live');
		assert.strictEqual(run.status, 'running');
		assert.deepStrictEqual(run.agents.map(a => a.agentId).sort(), ['x1', 'x2']);
	});

	test('running runs sort before completed runs', async () => {
		await writeCompleted('proj', 'sess', 'wf_old', { runId: 'wf_old', workflowName: 'Old', status: 'completed', startTime: 1 });
		await writeRunningJournal('proj', 'sess', 'wf_new', ['a']);
		const store = newStore();
		await store.refresh();
		assert.deepStrictEqual(store.runs.map(r => r.status), ['running', 'completed']);
	});

	test('a run with a completion summary is not double-listed as running', async () => {
		await writeCompleted('proj', 'sess', 'wf_same', { runId: 'wf_same', workflowName: 'Same', status: 'completed' });
		await writeRunningJournal('proj', 'sess', 'wf_same', ['a']);
		const store = newStore();
		await store.refresh();
		assert.strictEqual(store.runs.length, 1);
		assert.strictEqual(store.runs[0].status, 'completed');
	});

	test('skips non-wf and unreadable summary files', async () => {
		await write('.claude/projects/proj/sess/workflows/not-a-run.json', '{}');
		await write('.claude/projects/proj/sess/workflows/wf_bad.json', 'not json {{{');
		await writeCompleted('proj', 'sess', 'wf_ok', { runId: 'wf_ok', workflowName: 'Ok', status: 'completed' });
		const store = newStore();
		await store.refresh();
		assert.deepStrictEqual(store.runs.map(r => r.runId), ['wf_ok']);
	});

	test('a phantom (empty) subagent dir is not surfaced as a running run', async () => {
		// A leftover wf_ dir with no journal and no agent metas must not become a phantom run.
		await write('.claude/projects/proj/sess/subagents/workflows/wf_empty/placeholder.txt', 'x');
		const store = newStore();
		await store.refresh();
		assert.deepStrictEqual(store.runs, []);
	});

	test('fires onDidChange on refresh', async () => {
		await writeCompleted('proj', 'sess', 'wf_e', { runId: 'wf_e', workflowName: 'E', status: 'completed' });
		const store = newStore();
		const changed = Event.toPromise(store.onDidChange);
		await store.refresh();
		await changed;
		assert.strictEqual(store.runs.length, 1);
	});

	test('strips a UTF-8 BOM from a completed run summary', async () => {
		await write('.claude/projects/proj/sess/workflows/wf_bom.json', String.fromCharCode(0xFEFF) + JSON.stringify({ runId: 'wf_bom', workflowName: 'BOM', status: 'completed' }));
		const store = newStore();
		await store.refresh();
		assert.deepStrictEqual(store.runs.map(r => r.runId), ['wf_bom']);
	});

	test('a result-only journal line still surfaces its agent (as done)', async () => {
		await write('.claude/projects/proj/sess/subagents/workflows/wf_res/journal.jsonl', JSON.stringify({ type: 'result', agentId: 'r1' }));
		const store = newStore();
		await store.refresh();
		assert.strictEqual(store.runs.length, 1);
		const agent = store.runs[0].agents.find(a => a.agentId === 'r1');
		assert.strictEqual(agent?.state, 'done');
	});
});
// CLAWDIUS-END
