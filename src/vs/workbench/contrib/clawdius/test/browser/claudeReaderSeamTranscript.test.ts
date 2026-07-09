/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Reader-seam transcript adapter tests (Slice 2)
// Drives the transcript JSONL adapter over the sanitized fixtures staged into an in-memory filesystem: the
// four-way matrix (present->complete, empty/missing->absent, extra-field->forward-compatible, malformed->canary
// unknown-shape + stamp), the missing out-of-band case (->partial, SC-006), a foreign run (->coverage=foreign,
// US1), and the truncated-tail edge (only whole records, never a half-parsed one). freshness=live is deferred
// (the live-event source is out of scope), so fixture reads assert freshness=polled.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Session, Subagent } from '../../common/claudeReaderSeam.js';
import { encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import { parseTranscriptRecords, TranscriptJsonlAdapter } from '../../browser/reader/claudeReaderSeamService.js';

// Reads a fixture file from the source tree via the browser harness's file bridge (the same mechanism the
// snapshot tests use), so the committed .jsonl skeletons are the single source of truth - no inline duplicate.
declare const __readFileInTests: (path: string) => Promise<string>;
const FIXTURE_DIR = 'vs/workbench/contrib/clawdius/test/fixtures/reader-seam/transcript';

async function loadFixture(name: string): Promise<string> {
	const src = URI.joinPath(FileAccess.asFileUri(''), '../src');
	return await __readFileInTests(URI.joinPath(src, FIXTURE_DIR, name).fsPath);
}

suite('Clawdius reader seam - transcript adapter (Slice 2)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The resolved config root (as resolveConfigRoot would return) and the active workspace folder. The in-scope
	// fixtures declare cwd=/work/fixture-proj so they match this folder; foreign.jsonl declares a different cwd.
	const ROOT = URI.file('/home/tester/.claude');
	const FOLDER = URI.file('/work/fixture-proj');

	function makeFs(): FileService {
		const fs = store.add(new FileService(new NullLogService()));
		store.add(fs.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		return fs;
	}

	async function stage(name: string, fs: FileService = makeFs()): Promise<TranscriptJsonlAdapter> {
		const text = await loadFixture(name);
		const dir = URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER));
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, name), VSBuffer.fromString(text));
		return new TranscriptJsonlAdapter(fs);
	}

	test('present -> complete, in-scope, freshness=polled, all four labels (SC-001)', async () => {
		const r = await (await stage('present.jsonl')).read(ROOT, FOLDER, 'transcript-slice');
		assert.deepStrictEqual(Object.keys(r).sort(), ['adapterVersion', 'completeness', 'coverage', 'entity', 'freshness']);
		assert.strictEqual(r.completeness, 'complete');
		assert.strictEqual(r.coverage, 'in-scope');
		assert.strictEqual(r.freshness, 'polled');
		assert.deepStrictEqual(r.adapterVersion, { format: 'transcript-jsonl', versionKey: 'v1' });
	});

	test('empty session file -> absent (fresh-install edge)', async () => {
		const r = await (await stage('absent.jsonl')).read(ROOT, FOLDER, 'session');
		assert.strictEqual(r.completeness, 'absent');
		assert.strictEqual(r.coverage, 'in-scope');
	});

	test('missing projects dir -> absent, not an error', async () => {
		const r = await new TranscriptJsonlAdapter(makeFs()).read(ROOT, FOLDER, 'session');
		assert.strictEqual(r.completeness, 'absent');
	});

	test('extra-field -> forward-compatible parse, complete (SC-004)', async () => {
		const r = await (await stage('extra-field.jsonl')).read(ROOT, FOLDER, 'transcript-slice');
		assert.strictEqual(r.completeness, 'complete');
		assert.strictEqual(r.adapterVersion.versionKey, 'v1');
	});

	test('malformed (unrecognized shape) -> canary unknown-shape + stamp (SC-004/SC-005)', async () => {
		const r = await (await stage('malformed.jsonl')).read(ROOT, FOLDER, 'transcript-slice');
		assert.strictEqual(r.completeness, 'unknown-shape');
		assert.deepStrictEqual(r.adapterVersion, { format: 'transcript-jsonl', versionKey: 'unknown-shape' });
	});

	test('missing out-of-band tool-result file -> partial (SC-006)', async () => {
		const r = await (await stage('present-missing-oob.jsonl')).read(ROOT, FOLDER, 'transcript-slice');
		assert.strictEqual(r.completeness, 'partial');
	});

	test('foreign (other-workspace) run -> coverage=foreign, surfaced not dropped (US1)', async () => {
		const r = await (await stage('foreign.jsonl')).read(ROOT, FOLDER, 'runs');
		assert.strictEqual(r.coverage, 'foreign');
		assert.strictEqual(r.completeness, 'complete');
	});

	test('truncated tail -> only whole records, never a half-parsed record', () => {
		// The pure parser is the guarantee: the half-written final line fails JSON.parse and is skipped.
		return loadFixture('truncated-tail.jsonl').then(text => {
			const parsed = parseTranscriptRecords(text);
			assert.strictEqual(parsed.records.length, 2);
			assert.ok(parsed.records.every(r => r.uuid !== 'rec-0003-TRUNCATED'));
			assert.strictEqual(parsed.recognized, true);
		});
	});

	test('truncated tail via the adapter -> complete over the whole records', async () => {
		const r = await (await stage('truncated-tail.jsonl')).read(ROOT, FOLDER, 'session');
		assert.strictEqual(r.completeness, 'complete');
		assert.strictEqual(r.coverage, 'in-scope');
	});

	test('a valid but newline-unterminated final record is the actively-appended tail, never emitted', async () => {
		// The final line is COMPLETE valid JSON but not newline-terminated; the newline is the durable JSONL
		// boundary, so it must be treated as mid-append and excluded (a stronger guarantee than invalid-JSON skip).
		const parsed = parseTranscriptRecords(await loadFixture('valid-unterminated-tail.jsonl'));
		assert.strictEqual(parsed.records.length, 2);
		assert.ok(parsed.records.every(r => r.uuid !== 'rec-0003-UNTERMINATED'));
	});

	test('recognized records mixed with an unreadable future shape -> partial, not a false complete', async () => {
		// An additive schema drift (a new record type alongside known ones) is an honest GAP, never dropped
		// silently under a `complete` claim.
		const r = await (await stage('mixed-unknown.jsonl')).read(ROOT, FOLDER, 'transcript-slice');
		assert.strictEqual(r.completeness, 'partial');
		assert.strictEqual(r.coverage, 'in-scope');
	});

	test('byteOffset is a file-absolute UTF-8 byte position (base threaded, multi-byte aware)', () => {
		// A UTF-16 length would diverge from bytes on the multi-byte chars in line0; assert bytes + base.
		const line0 = '{"type":"user","sessionId":"s","note":"ééé"}';
		const line1 = '{"type":"assistant","sessionId":"s"}';
		const parsed = parseTranscriptRecords(`${line0}\n${line1}\n`, 1000);
		assert.strictEqual(parsed.records.length, 2);
		assert.strictEqual(parsed.records[0].byteOffset, 1000);
		assert.strictEqual(parsed.records[1].byteOffset, 1000 + VSBuffer.fromString(line0).byteLength + 1);
	});

	test('tail window starting inside a multi-byte char keeps records intact and byte-absolute offsets', async () => {
		// Force the start>0 path with a tiny cap whose window boundary lands mid-UTF-8: decoding the raw window
		// first would inject U+FFFD and corrupt the byte count, so the newline must be found in the raw bytes.
		const fs = makeFs();
		const head = '{"type":"user","sessionId":"s","uuid":"A","p":"';
		const lineA = `${head}😀"}`; // the emoji is a 4-byte UTF-8 sequence
		const lineB = '{"type":"assistant","sessionId":"s","uuid":"B"}';
		const content = `${lineA}\n${lineB}\n`;
		const dir = URI.joinPath(ROOT, 'projects', encodeProjectDir(FOLDER));
		await fs.createFolder(dir);
		await fs.writeFile(URI.joinPath(dir, 'big.jsonl'), VSBuffer.fromString(content));
		// Start two bytes into the emoji (mid-sequence); lineA is dropped as the partial leading line.
		const start = VSBuffer.fromString(head).byteLength + 2;
		const cap = VSBuffer.fromString(content).byteLength - start;
		const r = await new TranscriptJsonlAdapter(fs, cap).read(ROOT, FOLDER, 'session');
		// The tail window started mid-file, so older records are out of view -> a known gap (partial), and lineB
		// still parsed intact (no U+FFFD corruption) with a file-absolute byteOffset.
		assert.strictEqual(r.completeness, 'partial');
		const session = r.entity as Session;
		assert.strictEqual(session.sessionId, 's');
		assert.strictEqual(session.index.byteOffset, VSBuffer.fromString(lineA).byteLength + 1);
	});

	test('every transcript request kind returns a fully labeled result (SC-001)', async () => {
		const adapter = await stage('present.jsonl');
		for (const kind of ['runs', 'session', 'subagent', 'transcript-slice'] as const) {
			const r = await adapter.read(ROOT, FOLDER, kind);
			assert.deepStrictEqual(Object.keys(r).sort(), ['adapterVersion', 'completeness', 'coverage', 'entity', 'freshness']);
			assert.ok(r.adapterVersion.format.length > 0 && r.adapterVersion.versionKey.length > 0);
		}
	});

	test('subagent kind derives a subagent from a sidechain record', async () => {
		const r = await (await stage('present.jsonl')).read(ROOT, FOLDER, 'subagent');
		const sub = r.entity as Subagent;
		assert.strictEqual(sub.subagentId, 'rec-0003');
		assert.strictEqual(sub.parentRunId, 'sess-fixture-0001');
	});
});
// CLAWDIUS-END
