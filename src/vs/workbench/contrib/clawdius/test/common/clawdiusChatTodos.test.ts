/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native webview Claude chat: TodoWrite parse tests
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseTodoInput } from '../../common/clawdiusChatTodos.js';

suite('Clawdius chat - parseTodoInput', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a well-formed todo list, dropping unknown fields', () => {
		const out = parseTodoInput(JSON.stringify({
			todos: [
				{ content: 'Build the thing', status: 'in_progress', activeForm: 'Building the thing' },
				{ content: 'Test it', status: 'pending' },
				{ content: 'Ship it', status: 'completed' },
			]
		}));
		assert.deepStrictEqual(out, [
			{ content: 'Build the thing', status: 'in_progress' },
			{ content: 'Test it', status: 'pending' },
			{ content: 'Ship it', status: 'completed' },
		]);
	});

	test('defaults a missing or non-string status to pending', () => {
		const out = parseTodoInput(JSON.stringify({ todos: [{ content: 'No status' }, { content: 'Numeric status', status: 3 }] }));
		assert.deepStrictEqual(out, [
			{ content: 'No status', status: 'pending' },
			{ content: 'Numeric status', status: 'pending' },
		]);
	});

	test('skips entries lacking a string content but keeps the valid ones', () => {
		const out = parseTodoInput(JSON.stringify({ todos: [{ status: 'pending' }, { content: 42 }, null, 'str', { content: 'Keep', status: 'pending' }] }));
		assert.deepStrictEqual(out, [{ content: 'Keep', status: 'pending' }]);
	});

	test('returns undefined for absent, empty, or malformed input', () => {
		assert.strictEqual(parseTodoInput(undefined), undefined);
		assert.strictEqual(parseTodoInput(''), undefined);
		assert.strictEqual(parseTodoInput('{ not json'), undefined);
		assert.strictEqual(parseTodoInput('null'), undefined);
		assert.strictEqual(parseTodoInput('"a string"'), undefined);
	});

	test('returns undefined when todos is absent or not an array', () => {
		assert.strictEqual(parseTodoInput(JSON.stringify({})), undefined);
		assert.strictEqual(parseTodoInput(JSON.stringify({ todos: 'nope' })), undefined);
		assert.strictEqual(parseTodoInput(JSON.stringify({ todos: {} })), undefined);
	});

	test('returns undefined when no entry yields usable content', () => {
		assert.strictEqual(parseTodoInput(JSON.stringify({ todos: [] })), undefined);
		assert.strictEqual(parseTodoInput(JSON.stringify({ todos: [{ status: 'pending' }, {}] })), undefined);
	});
});
// CLAWDIUS-END
