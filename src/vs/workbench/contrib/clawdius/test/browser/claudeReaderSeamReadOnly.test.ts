/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Reader-seam read-only / no-write guard (SC-002)
// The seam is read-only and index-only. This exercises every transcript read path over a fixture tree through
// an instrumented file service (a Proxy that records any mutating call and otherwise delegates to a real
// FileService) and asserts ZERO write/create/delete/rename occurs under the config root. It also asserts the
// seam class exposes only read() - never a session-store write surface - so it can never be the SDK sessionStore.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import { ClawdiusReaderSeamService, TranscriptJsonlAdapter } from '../../browser/reader/claudeReaderSeamService.js';

declare const __readFileInTests: (path: string) => Promise<string>;
const FIXTURE_DIR = 'vs/workbench/contrib/clawdius/test/fixtures/reader-seam/transcript';

async function loadFixture(name: string): Promise<string> {
	const src = URI.joinPath(FileAccess.asFileUri(''), '../src');
	return await __readFileInTests(URI.joinPath(src, FIXTURE_DIR, name).fsPath);
}

/** Every mutating method on IFileService - a call to any of these under a seam read is a read-only violation. */
const MUTATORS: ReadonlySet<string> = new Set([
	'writeFile', 'createFile', 'createFolder', 'del', 'move', 'copy', 'cloneFile', 'mkdir', 'write', 'writeFileStream',
]);

/** Wrap a real IFileService so any mutating call is recorded (then still delegated). A faithful pass-through, not
 *  a stub: reads behave exactly as the underlying service, so this only instruments, never fakes behavior. */
function instrument(inner: IFileService, calls: string[]): IFileService {
	return new Proxy(inner, {
		get(target, prop, _receiver) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== 'function') { return value; }
			const name = String(prop);
			return (...args: unknown[]) => {
				if (MUTATORS.has(name)) { calls.push(name); }
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}

suite('Clawdius reader seam - read-only / no-write guard (SC-002)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const ROOT = URI.file('/home/tester/.claude');
	const FOLDER = URI.file('/work/fixture-proj');

	function makeFs(): FileService {
		const fs = store.add(new FileService(new NullLogService()));
		store.add(fs.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		return fs;
	}

	async function stageRaw(fs: FileService, name: string): Promise<void> {
		const text = await loadFixture(name);
		const dir = URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER));
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, name), VSBuffer.fromString(text));
	}

	test('every read path performs zero writes/creates/deletes/renames under the root', async () => {
		const calls: string[] = [];
		// Cover the recognized, foreign, out-of-band-probe, canary, truncated, and empty paths.
		for (const name of ['present.jsonl', 'foreign.jsonl', 'present-missing-oob.jsonl', 'malformed.jsonl', 'truncated-tail.jsonl', 'absent.jsonl']) {
			const fs = makeFs();
			await stageRaw(fs, name); // staging uses the real service, NOT the instrumented one
			const adapter = new TranscriptJsonlAdapter(instrument(fs, calls));
			const before = calls.length;
			for (const kind of ['runs', 'session', 'subagent', 'transcript-slice'] as const) {
				await adapter.read(ROOT, FOLDER, kind);
			}
			assert.deepStrictEqual(calls.slice(before), [], `a read of ${name} performed a write`);
		}
		// The missing-tree path (no projects dir) must also stay read-only.
		const emptyFs = makeFs();
		const before = calls.length;
		await new TranscriptJsonlAdapter(instrument(emptyFs, calls)).read(ROOT, FOLDER, 'session');
		assert.deepStrictEqual(calls.slice(before), []);
	});

	test('the seam exposes only read() - never a session-store write surface', () => {
		const names = Object.getOwnPropertyNames(ClawdiusReaderSeamService.prototype);
		assert.ok(names.includes('read'), 'the seam must expose read()');
		for (const forbidden of ['set', 'save', 'append', 'persist', 'store', 'write', 'delete', 'remove', 'sessionStore']) {
			assert.ok(!names.includes(forbidden), `the reader seam must not expose a store-writer method: ${forbidden}`);
		}
	});
});
// CLAWDIUS-END
