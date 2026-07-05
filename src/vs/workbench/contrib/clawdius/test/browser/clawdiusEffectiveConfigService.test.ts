/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN effective-config assembly service tests
// Assembly over a real FileService + InMemoryFileSystemProvider: tier precedence end to end, missing = absent,
// malformed = diagnostic, the managed drop-in fold, the policyHelper-opaque derivation, and the remote-window
// skip (managed read only when the home is on the file scheme).

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { dirname, joinPath } from '../../../../../base/common/resources.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { SettingsTier } from '../../common/clawdiusEffectiveConfig.js';
import { CLAUDE_DIR, MANAGED_SETTINGS_JSON, SETTINGS_JSON, SETTINGS_LOCAL_JSON } from '../../common/clawdiusTierPaths.js';
import { ClawdiusEffectiveConfigService } from '../../browser/control/clawdiusEffectiveConfigService.js';

/** Overrides the managed system root with a fake-filesystem-friendly POSIX path so the managed fold can be
 *  exercised without a real drive-letter system path (which the in-memory provider cannot host). */
class TestEffectiveConfigService extends ClawdiusEffectiveConfigService {
	constructor(private readonly managedRoot: URI, fileService: IFileService, pathService: IPathService) {
		super(fileService, pathService, new NullLogService());
	}
	protected override managedRootUri(): URI { return this.managedRoot; }
}

suite('Clawdius effective-config service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function write(fileService: IFileService, uri: URI, content: string): Promise<void> {
		await fileService.createFolder(dirname(uri));
		await fileService.writeFile(uri, VSBuffer.fromString(content));
	}

	function makeFileService(): FileService {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		store.add(fileService.registerProvider(Schemas.vscodeRemote, store.add(new InMemoryFileSystemProvider())));
		return fileService;
	}

	function makeService(fileService: FileService, home: URI, managedRoot?: URI): ClawdiusEffectiveConfigService {
		const pathService = new TestPathService(home, home.scheme);
		return managedRoot
			? new TestEffectiveConfigService(managedRoot, fileService, pathService)
			: new ClawdiusEffectiveConfigService(fileService, pathService, new NullLogService());
	}

	test('assembles tiers with local > project > user precedence', async () => {
		const fs = makeFileService();
		const home = URI.file('/home/t');
		const folder = URI.file('/home/t/proj');
		await write(fs, joinPath(home, CLAUDE_DIR, SETTINGS_JSON), JSON.stringify({ model: 'sonnet', env: { A: 'user' } }));
		await write(fs, joinPath(folder, CLAUDE_DIR, SETTINGS_JSON), JSON.stringify({ model: 'opus' }));
		await write(fs, joinPath(folder, CLAUDE_DIR, SETTINGS_LOCAL_JSON), JSON.stringify({ model: 'haiku' }));

		const { config } = await makeService(fs, home).resolve(folder);
		const model = config.settings.find(s => s.path === 'model');
		assert.strictEqual(model?.effective, 'haiku');
		assert.strictEqual(model?.winner, SettingsTier.ProjectLocal);
		assert.strictEqual(config.settings.find(s => s.path === 'env.A')?.effective, 'user');
	});

	test('missing files are absent (no diagnostic); malformed JSON is a diagnostic', async () => {
		const fs = makeFileService();
		const home = URI.file('/home/t');
		await write(fs, joinPath(home, CLAUDE_DIR, SETTINGS_JSON), '{ this is not json');
		const { diagnostics, config } = await makeService(fs, home).resolve(undefined);
		assert.strictEqual(config.settings.length, 0); // nothing parsed
		const malformed = diagnostics.filter(d => d.kind === 'malformed');
		assert.strictEqual(malformed.length, 1);
		assert.strictEqual(malformed[0].tier, SettingsTier.User);
	});

	test('a present-but-unreadable source is reported unevaluated, not silently absent', async () => {
		const fs = makeFileService();
		const home = URI.file('/home/t');
		// A directory where a settings FILE is expected: readFile fails with FILE_IS_DIRECTORY, not FILE_NOT_FOUND.
		await fs.createFolder(joinPath(home, CLAUDE_DIR, SETTINGS_JSON));
		const { diagnostics } = await makeService(fs, home).resolve(undefined);
		assert.ok(diagnostics.some(d => d.tier === SettingsTier.User && d.kind === 'unevaluated'),
			'a non-missing read failure on a policy/settings source must surface a diagnostic');
	});

	test('managed drop-ins fold onto managed-settings.json and a declared policyHelper is opaque', async () => {
		const fs = makeFileService();
		const home = URI.file('/home/t');
		const managedRoot = URI.file('/sys/ClaudeCode');
		await write(fs, joinPath(managedRoot, MANAGED_SETTINGS_JSON), JSON.stringify({ model: 'base', policyHelper: { path: '/opt/policy' } }));
		await write(fs, joinPath(managedRoot, 'managed-settings.d', '10-a.json'), JSON.stringify({ model: 'dropin' }));
		await write(fs, joinPath(home, CLAUDE_DIR, SETTINGS_JSON), JSON.stringify({ model: 'user' }));

		const { config, tiers } = await makeService(fs, home, managedRoot).resolve(undefined);
		// A policyHelper was declared -> an opaque PolicyHelper tier wins the band with a hidden body.
		assert.ok(tiers.some(t => t.tier === SettingsTier.PolicyHelper && t.opaque));
		assert.deepStrictEqual(config.opaqueTiers, [SettingsTier.PolicyHelper]);
		assert.strictEqual(config.managedWinner, SettingsTier.PolicyHelper);
		// The managed body is hidden (opaque): the band is opaque and lower values are PROVISIONAL - the user's
		// value shows best-effort but flagged, so the UI cannot present it as a definitive effective value.
		assert.strictEqual(config.managedOpaque, true);
		const model = config.settings.find(s => s.path === 'model');
		assert.strictEqual(model?.effective, 'user');
		assert.strictEqual(model?.provisional, true);
	});

	test('remote window: managed settings are not evaluated (no local-host read)', async () => {
		const fs = makeFileService();
		const home = URI.from({ scheme: Schemas.vscodeRemote, authority: 'wsl', path: '/home/t' });
		await write(fs, joinPath(home, CLAUDE_DIR, SETTINGS_JSON), JSON.stringify({ model: 'remote-user' }));

		const { config, diagnostics } = await makeService(fs, home).resolve(undefined);
		// The user tier is read from the REMOTE fs...
		assert.strictEqual(config.settings.find(s => s.path === 'model')?.effective, 'remote-user');
		// ...but the managed system path is reported unevaluated rather than read off the local host.
		assert.ok(diagnostics.some(d => d.tier === SettingsTier.ManagedFile && d.kind === 'unevaluated'));
	});
});
// CLAWDIUS-END
