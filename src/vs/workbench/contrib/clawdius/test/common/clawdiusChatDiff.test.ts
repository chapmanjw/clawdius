/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native webview Claude chat: line-diff tests
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeLineDiff } from '../../common/clawdiusChatDiff.js';

suite('Clawdius chat - computeLineDiff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders a single-line edit with surrounding context', () => {
		assert.deepStrictEqual(computeLineDiff('a\nb\nc', 'a\nB\nc', 1000), [
			{ t: ' ', s: 'a' },
			{ t: '-', s: 'b' },
			{ t: '+', s: 'B' },
			{ t: ' ', s: 'c' },
		]);
	});

	test('a pure creation is all-added', () => {
		assert.deepStrictEqual(computeLineDiff('', 'x\ny', 1000), [
			{ t: '+', s: 'x' },
			{ t: '+', s: 'y' },
		]);
	});

	test('a pure deletion is all-removed', () => {
		assert.deepStrictEqual(computeLineDiff('x\ny', '', 1000), [
			{ t: '-', s: 'x' },
			{ t: '-', s: 'y' },
		]);
	});

	test('identical content yields no diff lines', () => {
		assert.deepStrictEqual(computeLineDiff('a\nb', 'a\nb', 1000), []);
	});

	test('caps output at maxLines with a truncation marker', () => {
		const before = '';
		const after = Array.from({ length: 50 }, (_, i) => 'line' + i).join('\n');
		const out = computeLineDiff(before, after, 10);
		assert.strictEqual(out.length, 11);
		assert.deepStrictEqual(out[10], { t: ' ', s: '...' });
	});
});
// CLAWDIUS-END
