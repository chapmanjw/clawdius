/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN ultracode workflow transcript tests
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatWorkflowTranscript } from '../../browser/workflowTranscript.js';

suite('formatWorkflowTranscript', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** One Claude-transcript JSON event per line. */
	function jsonl(...events: object[]): string {
		return events.map(e => JSON.stringify(e)).join('\n');
	}

	function user(content: unknown): object {
		return { type: 'user', message: { role: 'user', content } };
	}

	function assistant(content: unknown): object {
		return { type: 'assistant', message: { role: 'assistant', content } };
	}

	test('empty / whitespace-only input renders the empty-state note', () => {
		for (const input of ['', '   ', '\n\n', '  \r\n  ']) {
			const out = formatWorkflowTranscript(input);
			assert.ok(out.includes('No transcript has been recorded'), `expected empty-state for ${JSON.stringify(input)}`);
		}
	});

	test('renders a user turn with string content', () => {
		const out = formatWorkflowTranscript(jsonl(user('Please review the file.')));
		assert.ok(out.includes('User'), 'has a User heading');
		assert.ok(out.includes('Please review the file.'), 'has the user text');
		assert.ok(!out.includes('No transcript has been recorded'), 'not the empty state');
	});

	test('renders an assistant turn with a text block', () => {
		const out = formatWorkflowTranscript(jsonl(assistant([{ type: 'text', text: 'Here is the review.' }])));
		assert.ok(out.includes('Assistant'), 'has an Assistant heading');
		assert.ok(out.includes('Here is the review.'), 'has the assistant text');
	});

	test('renders a tool_use block with its name and JSON input fence', () => {
		const out = formatWorkflowTranscript(jsonl(assistant([
			{ type: 'tool_use', name: 'Read', input: { file_path: '/src/a.ts' } },
		])));
		assert.ok(out.includes('Read'), 'has the tool name');
		assert.ok(out.includes('```json'), 'opens a json fence for the input');
		assert.ok(out.includes('"file_path"'), 'serializes the input keys');
		assert.ok(out.includes('/src/a.ts'), 'serializes the input values');
	});

	test('renders a tool_result with string content', () => {
		const out = formatWorkflowTranscript(jsonl(user([
			{ type: 'tool_result', content: 'the file contents' },
		])));
		assert.ok(out.includes('result'), 'labels the result');
		assert.ok(out.includes('the file contents'), 'includes the result body');
	});

	test('renders a tool_result whose content is an array of text blocks', () => {
		const out = formatWorkflowTranscript(jsonl(user([
			{ type: 'tool_result', content: [{ type: 'text', text: 'first line' }, { type: 'text', text: 'second line' }] },
		])));
		assert.ok(out.includes('first line'), 'includes the first text block');
		assert.ok(out.includes('second line'), 'includes the second text block');
	});

	test('renders a thinking block as a blockquote', () => {
		const out = formatWorkflowTranscript(jsonl(assistant([
			{ type: 'thinking', thinking: 'weighing the options' },
		])));
		assert.ok(out.includes('weighing the options'), 'includes the thinking text');
		assert.ok(out.split('\n').some(l => l.startsWith('> ')), 'rendered as a blockquote line');
	});

	test('caps a very long block and notes the truncation', () => {
		const big = 'x'.repeat(5000);
		const out = formatWorkflowTranscript(jsonl(assistant([{ type: 'text', text: big }])));
		assert.ok(out.includes('truncated'), 'notes the truncation');
		assert.ok(out.includes('more characters'), 'reports how much was dropped');
		// The full 5000-char block must not survive verbatim.
		assert.ok(!out.includes(big), 'does not include the full oversized text');
	});

	test('sizes the fence longer than any backtick run inside the content', () => {
		// A tool result that itself contains a triple-backtick fence must be wrapped in >=4 backticks.
		const out = formatWorkflowTranscript(jsonl(user([
			{ type: 'tool_result', content: 'before ``` after' },
		])));
		assert.ok(out.includes('````'), 'uses a 4-backtick fence to safely wrap inner triple backticks');
	});

	test('skips attachments, unknown types, and malformed lines', () => {
		const input = [
			JSON.stringify({ type: 'attachment', attachment: { foo: 'bar' } }),
			'this is not json {',
			JSON.stringify(user('real user message')),
			'',
			JSON.stringify({ type: 'system', message: { role: 'system', content: 'ignored' } }),
		].join('\n');
		const out = formatWorkflowTranscript(input);
		assert.ok(out.includes('real user message'), 'renders the one valid user turn');
		assert.ok(!out.includes('ignored'), 'does not render the system event');
		assert.ok(!out.includes('foo'), 'does not render the attachment payload');
	});

	test('tolerates a partially-flushed final line (live run)', () => {
		const input = JSON.stringify(assistant([{ type: 'text', text: 'complete turn' }])) + '\n{"type":"assistant","mess';
		const out = formatWorkflowTranscript(input);
		assert.ok(out.includes('complete turn'), 'renders the complete line');
		assert.ok(!out.includes('No transcript has been recorded'), 'not treated as empty');
	});

	test('includes the title heading when provided', () => {
		const out = formatWorkflowTranscript(jsonl(user('hi')), 'review-aspect-1');
		assert.ok(out.includes('# review-aspect-1'), 'renders the title as an h1');
	});

	test('drops turns whose content renders to nothing', () => {
		// An assistant turn with only an empty text block should not produce a heading-only stub.
		const out = formatWorkflowTranscript(jsonl(assistant([{ type: 'text', text: '   ' }])));
		assert.ok(out.includes('No transcript has been recorded'), 'empty-bodied turn yields the empty state');
	});
});
// CLAWDIUS-END
