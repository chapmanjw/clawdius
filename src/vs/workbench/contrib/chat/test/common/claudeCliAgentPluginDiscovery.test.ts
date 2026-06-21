/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude cli plugin discovery tests
import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ClaudeCliAgentPluginDiscovery } from '../../common/plugins/agentPluginServiceImpl.js';

const HOME = URI.file('/claude-home');

suite('ClaudeCliAgentPluginDiscovery', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let fileService: IFileService;

	/** Exposes the protected discovery and re-declares the DI constructor so injection actually happens. */
	class TestableDiscovery extends ClaudeCliAgentPluginDiscovery {
		constructor(
			@IFileService fileService: IFileService,
			@IPathService pathService: IPathService,
			@ILogService logService: ILogService,
			@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		) {
			super(fileService, pathService, logService, workspaceContextService);
		}
		discover() {
			return this._discoverPluginSources();
		}
	}

	async function write(relativeToHome: string, content: string): Promise<void> {
		await fileService.writeFile(joinPath(HOME, ...relativeToHome.split('/')), VSBuffer.fromString(content));
	}

	/** Place a plugin's active version dir on disk (so the install-path existence check passes). */
	async function installPluginDir(absInstallPath: string): Promise<void> {
		await fileService.writeFile(joinPath(URI.file(absInstallPath), '.clawdius-plugin'), VSBuffer.fromString('x'));
	}

	function discovery(): TestableDiscovery {
		return disposables.add(instantiationService.createInstance(TestableDiscovery));
	}

	setup(() => {
		instantiationService = disposables.add(new TestInstantiationService());
		fileService = disposables.add(new FileService(new NullLogService()));
		// Register the in-memory provider for the `file` scheme so URI.file(installPath) resolves.
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));

		instantiationService.stub(IFileService, fileService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IPathService, { userHome: async () => HOME } as unknown as IPathService);
		instantiationService.stub(IWorkspaceContextService, {} as unknown as IWorkspaceContextService);
	});

	test('discovers an installed + enabled plugin whose active version dir exists', async () => {
		const installPath = '/claude-home/.claude/plugins/cache/market/rutherford/0.2.3';
		await installPluginDir(installPath);
		await write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'rutherford@market': true } }));
		await write('.claude/plugins/installed_plugins.json', JSON.stringify({
			version: 1,
			plugins: { 'rutherford@market': [{ installPath, version: '0.2.3', scope: 'user' }] },
		}));

		const sources = await discovery().discover();
		assert.strictEqual(sources.length, 1);
		assert.strictEqual(sources[0].uri.toString(), URI.file(installPath).toString());
		assert.strictEqual(sources[0].fromMarketplace, undefined, 'CLI plugins are not marketplace-sourced');
	});

	test('a plugin present but not listed in enabledPlugins is still discovered (only explicit false skips)', async () => {
		const installPath = '/claude-home/.claude/plugins/cache/market/p/1.0.0';
		await installPluginDir(installPath);
		await write('.claude/settings.json', JSON.stringify({ enabledPlugins: {} }));
		await write('.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'p@market': [{ installPath, scope: 'user' }] } }));

		const sources = await discovery().discover();
		assert.strictEqual(sources.length, 1);
	});

	test('skips a plugin explicitly disabled in settings.json', async () => {
		const installPath = '/claude-home/.claude/plugins/cache/market/p/1.0.0';
		await installPluginDir(installPath);
		await write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'p@market': false } }));
		await write('.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'p@market': [{ installPath, scope: 'user' }] } }));

		const sources = await discovery().discover();
		assert.strictEqual(sources.length, 0);
	});

	test('skips a plugin whose active version dir does not exist on disk', async () => {
		// No installPluginDir() call -> the directory is absent.
		await write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'p@market': true } }));
		await write('.claude/plugins/installed_plugins.json', JSON.stringify({
			plugins: { 'p@market': [{ installPath: '/claude-home/.claude/plugins/cache/market/p/9.9.9', scope: 'user' }] },
		}));

		const sources = await discovery().discover();
		assert.strictEqual(sources.length, 0);
	});

	test('prefers the user-scope record when multiple version records coexist', async () => {
		const userPath = '/claude-home/.claude/plugins/cache/market/p/2.0.0';
		const projectPath = '/claude-home/.claude/plugins/cache/market/p/1.0.0';
		await installPluginDir(userPath);
		await installPluginDir(projectPath);
		await write('.claude/settings.json', JSON.stringify({ enabledPlugins: {} }));
		await write('.claude/plugins/installed_plugins.json', JSON.stringify({
			plugins: { 'p@market': [{ installPath: projectPath, scope: 'project' }, { installPath: userPath, scope: 'user' }] },
		}));

		const sources = await discovery().discover();
		assert.strictEqual(sources.length, 1);
		assert.strictEqual(sources[0].uri.toString(), URI.file(userPath).toString(), 'picked the user-scope installPath');
	});

	test('returns nothing when installed_plugins.json is missing', async () => {
		const sources = await discovery().discover();
		assert.strictEqual(sources.length, 0);
	});

	test('returns nothing when installed_plugins.json has no plugins object', async () => {
		await write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 1 }));
		const sources = await discovery().discover();
		assert.strictEqual(sources.length, 0);
	});
});
// CLAWDIUS-END
