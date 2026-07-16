/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN readAccount "signed in" derivation unit tests
// The renderer stats ~/.claude/.credentials.json as a zero-IPC FAST PATH (its presence is sufficient, and on
// Windows/Linux it is the only credential store). On a MISS it must consult the probe, because on macOS the Claude
// Code CLI keeps its credentials in the login Keychain and the file is only a failed-write fallback - so treating
// absence as "signed out" is exactly the bug that reported every signed-in mac user as signed out.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { CREDENTIALS_FILE, IClaudeCredentialsProbe, readAccount } from '../../browser/usage/claudeUsageData.js';

suite('claudeUsageAccount (readAccount signedIn)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const claudeDir = URI.file('/home/jdoe/.claude');

	function makeFileService(): FileService {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		return fileService;
	}

	/** A probe double that records how many times it was consulted (the fast path must not consult it at all). */
	function makeProbe(answer: boolean | undefined): IClaudeCredentialsProbe & { readonly calls: () => number } {
		let calls = 0;
		return {
			calls: () => calls,
			hasCredentials: async () => { calls++; return answer; },
		};
	}

	test('file present: signed in via the fast path, and the probe is NEVER consulted', async () => {
		const fileService = makeFileService();
		await fileService.createFolder(claudeDir);
		await fileService.writeFile(URI.joinPath(claudeDir, CREDENTIALS_FILE), VSBuffer.fromString('{}'));
		const probe = makeProbe(false);

		const account = await readAccount(fileService, claudeDir, undefined, probe);

		assert.deepStrictEqual([account.signedIn, probe.calls()], [true, 0]);
	});

	test('file absent + probe true: SIGNED IN (the macOS Keychain case - the bug this fixes)', async () => {
		const fileService = makeFileService();
		const probe = makeProbe(true);

		const account = await readAccount(fileService, claudeDir, undefined, probe);

		assert.deepStrictEqual([account.signedIn, probe.calls()], [true, 1]);
	});

	test('file absent + probe false: signed out', async () => {
		const fileService = makeFileService();
		const probe = makeProbe(false);

		const account = await readAccount(fileService, claudeDir, undefined, probe);

		assert.deepStrictEqual([account.signedIn, probe.calls()], [false, 1]);
	});

	test('file absent + INDETERMINATE probe: UNKNOWN, never "signed out" (the locked-keychain lie)', async () => {
		const fileService = makeFileService();
		const probe = makeProbe(undefined);

		const account = await readAccount(fileService, claudeDir, undefined, probe);

		// A locked macOS login keychain (exit 36) must not be reported as a signed-out user. `false` here would
		// reintroduce the exact bug this whole change exists to fix, on the very platform it targets.
		assert.deepStrictEqual([account.signedIn, probe.calls()], [undefined, 1]);
	});

	test('file absent + no probe: signed out (the pre-probe caller contract is unchanged)', async () => {
		const fileService = makeFileService();

		const account = await readAccount(fileService, claudeDir, undefined);

		assert.strictEqual(account.signedIn, false);
	});
});
// CLAWDIUS-END
