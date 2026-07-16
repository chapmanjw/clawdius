/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Reader-seam unit tests
// Pins the seam's pure vocabulary + resolver: the resolver's four cases (env-set, unset+home, neither, and a
// REMOTE-authority home that must keep its scheme/authority), the three label enums equal the
// contract's exact value sets, and the result wrapper carries all four honesty labels.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AdapterVersionStamp,
	CompletenessState,
	CoverageLabel,
	FreshnessLabel,
	IReaderResult,
	Run,
	resolveConfigRoot,
} from '../../common/claudeReaderSeam.js';

suite('Clawdius reader seam', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveConfigRoot', () => {
		test('env set -> that directory', () => {
			const r = resolveConfigRoot('/custom/claude-config', URI.file('/home/user'));
			assert.strictEqual(r.kind, 'resolved');
			assert.ok(r.kind === 'resolved');
			assert.strictEqual(r.root.scheme, 'file');
			assert.strictEqual(r.root.fsPath, URI.file('/custom/claude-config').fsPath);
		});

		test('env unset + home -> home/.claude', () => {
			const r = resolveConfigRoot(undefined, URI.file('/home/user'));
			assert.ok(r.kind === 'resolved');
			assert.strictEqual(r.root.fsPath, URI.file('/home/user/.claude').fsPath);
		});

		test('empty-string env is treated as unset -> home/.claude', () => {
			const r = resolveConfigRoot('', URI.file('/home/user'));
			assert.ok(r.kind === 'resolved');
			assert.strictEqual(r.root.fsPath, URI.file('/home/user/.claude').fsPath);
		});

		test('neither env nor home -> no-config', () => {
			const r = resolveConfigRoot(undefined, undefined);
			assert.strictEqual(r.kind, 'no-config');
		});

		test('remote-authority home -> resolved root preserves scheme + authority', () => {
			const remoteHome = URI.from({ scheme: 'vscode-remote', authority: 'wsl+ubuntu', path: '/home/user' });
			const r = resolveConfigRoot(undefined, remoteHome);
			assert.ok(r.kind === 'resolved');
			assert.strictEqual(r.root.scheme, 'vscode-remote');
			assert.strictEqual(r.root.authority, 'wsl+ubuntu');
			assert.strictEqual(r.root.path, '/home/user/.claude');
		});

		test('env set inside a remote window -> the env path is rebased onto the remote host', () => {
			// A CLAUDE_CONFIG_DIR read from the remote host must resolve on that host, not fall back to a local
			// `file:` URI - otherwise a WSL/SSH window would read the wrong machine's config.
			const remoteHome = URI.from({ scheme: 'vscode-remote', authority: 'wsl+ubuntu', path: '/home/user' });
			const r = resolveConfigRoot('/opt/claude-config', remoteHome);
			assert.ok(r.kind === 'resolved');
			assert.strictEqual(r.root.scheme, 'vscode-remote');
			assert.strictEqual(r.root.authority, 'wsl+ubuntu');
			assert.strictEqual(r.root.path, '/opt/claude-config');
		});
	});

	suite('label enums equal the contract value sets', () => {
		test('coverage / freshness / completeness', () => {
			assert.deepStrictEqual(Object.values(CoverageLabel).sort(), ['foreign', 'in-scope', 'out-of-scope']);
			assert.deepStrictEqual(Object.values(FreshnessLabel).sort(), ['live', 'polled', 'stale']);
			assert.deepStrictEqual(
				Object.values(CompletenessState).sort(),
				['absent', 'complete', 'partial', 'suppressed', 'unknown-shape'],
			);
		});
	});

	suite('IReaderResult carries all four labels', () => {
		test('a well-formed result exposes coverage, freshness, completeness, adapterVersion', () => {
			const stamp: AdapterVersionStamp = { format: 'transcript-jsonl', versionKey: 'v1' };
			const result: IReaderResult<Run> = {
				entity: { runId: 'r1', sessionId: 's1', index: { fileIdentity: 'f1', byteOffset: 0 } },
				coverage: CoverageLabel.InScope,
				freshness: FreshnessLabel.Polled,
				completeness: CompletenessState.Complete,
				adapterVersion: stamp,
			};
			assert.deepStrictEqual(Object.keys(result).sort(), [
				'adapterVersion',
				'completeness',
				'coverage',
				'entity',
				'freshness',
			]);
			assert.strictEqual(result.coverage, CoverageLabel.InScope);
			assert.strictEqual(result.freshness, FreshnessLabel.Polled);
			assert.strictEqual(result.completeness, CompletenessState.Complete);
			assert.deepStrictEqual(result.adapterVersion, { format: 'transcript-jsonl', versionKey: 'v1' });
		});
	});
});
// CLAWDIUS-END
