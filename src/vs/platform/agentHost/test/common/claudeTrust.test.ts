/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN workspace-trust decision unit tests
// The pure deny-by-default matrix: tool-name -> surface mapping, and the (state x surface) decision - untrusted
// denies writes / shell / mcp / url / other while reads proceed; a trusted workspace grants full access. The
// UNTRUSTED default is fail-closed + frozen.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ITrustState, UNTRUSTED, evaluateTrust, surfaceForToolCall } from '../../common/claudeTrust.js';

const TRUSTED: ITrustState = { trusted: true };

suite('Clawdius workspace-trust decision', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('surfaceForToolCall maps tool names to surfaces (unknown -> tool, fails closed)', () => {
		assert.deepStrictEqual(surfaceForToolCall('Read'), { kind: 'read' });
		assert.deepStrictEqual(surfaceForToolCall('Grep'), { kind: 'read' });
		assert.deepStrictEqual(surfaceForToolCall('TodoWrite'), { kind: 'read' }); // in-memory, safe
		assert.deepStrictEqual(surfaceForToolCall('Write'), { kind: 'write' });
		assert.deepStrictEqual(surfaceForToolCall('Edit'), { kind: 'write' });
		assert.deepStrictEqual(surfaceForToolCall('Bash'), { kind: 'shell' });
		assert.deepStrictEqual(surfaceForToolCall('WebFetch'), { kind: 'url' });
		assert.deepStrictEqual(surfaceForToolCall('mcp__github__list'), { kind: 'mcp', server: 'github' });
		assert.deepStrictEqual(surfaceForToolCall('SomeNewTool'), { kind: 'tool', name: 'SomeNewTool' });
	});

	test('untrusted: reads proceed; writes/shell/mcp/url/other hard-deny with a reason', () => {
		assert.strictEqual(evaluateTrust(UNTRUSTED, { kind: 'read' }).cls, 'proceed');
		assert.deepStrictEqual(evaluateTrust(UNTRUSTED, { kind: 'write' }), { cls: 'deny', reason: 'untrusted-write' });
		assert.deepStrictEqual(evaluateTrust(UNTRUSTED, { kind: 'shell' }), { cls: 'deny', reason: 'untrusted-shell' });
		assert.deepStrictEqual(evaluateTrust(UNTRUSTED, { kind: 'mcp', server: 'g' }), { cls: 'deny', reason: 'untrusted-mcp' });
		assert.deepStrictEqual(evaluateTrust(UNTRUSTED, { kind: 'url' }), { cls: 'deny', reason: 'untrusted-url' });
		assert.deepStrictEqual(evaluateTrust(UNTRUSTED, { kind: 'tool', name: 'X' }), { cls: 'deny', reason: 'untrusted-tool' });
	});

	test('trusted: every surface proceeds (full access)', () => {
		assert.strictEqual(evaluateTrust(TRUSTED, { kind: 'read' }).cls, 'proceed');
		assert.strictEqual(evaluateTrust(TRUSTED, { kind: 'write' }).cls, 'proceed');
		assert.strictEqual(evaluateTrust(TRUSTED, { kind: 'shell' }).cls, 'proceed');
		assert.strictEqual(evaluateTrust(TRUSTED, { kind: 'mcp', server: 'g' }).cls, 'proceed');
		assert.strictEqual(evaluateTrust(TRUSTED, { kind: 'url' }).cls, 'proceed');
		assert.strictEqual(evaluateTrust(TRUSTED, { kind: 'tool', name: 'X' }).cls, 'proceed');
	});

	test('UNTRUSTED is the fail-closed default and is frozen', () => {
		assert.strictEqual(UNTRUSTED.trusted, false);
		assert.throws(() => { (UNTRUSTED as { trusted: boolean }).trusted = true; });
	});
});
// CLAWDIUS-END
