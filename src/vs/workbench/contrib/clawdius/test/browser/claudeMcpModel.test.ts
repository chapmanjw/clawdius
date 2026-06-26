/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	enableAllProjectMcpServersWrite, mcpApproval, mcpApprovalWrites, mcpEffectiveApproval, parseMcpSettings, summarizeMcpDef,
} from '../../browser/control/claudeMcpModel.js';

suite('claudeMcpModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parse + approval + effective approval', () => {
		const state = parseMcpSettings({ enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['b'], enableAllProjectMcpServers: true });
		assert.strictEqual(mcpApproval(state, 'a'), 'approved');
		assert.strictEqual(mcpApproval(state, 'b'), 'rejected');
		assert.strictEqual(mcpApproval(state, 'c'), 'default');
		// effective: explicit reject/approve win over enable-all; an unlisted server is approved-by-enable-all
		assert.strictEqual(mcpEffectiveApproval(state, 'b'), 'rejected');
		assert.strictEqual(mcpEffectiveApproval(state, 'a'), 'approved');
		assert.strictEqual(mcpEffectiveApproval(state, 'c'), 'approved-by-enable-all');
		assert.strictEqual(mcpEffectiveApproval(parseMcpSettings({}), 'c'), 'default');
	});

	test('approval writes are relative array mutations and de-dupe across lists', () => {
		// Approve a server currently rejected: it moves from disabled -> enabled.
		const latest = parseMcpSettings({ disabledMcpjsonServers: ['srv'], enabledMcpjsonServers: ['other'] });
		const w = mcpApprovalWrites(latest, 'srv', 'approved');
		const byKey = Object.fromEntries(w.map(x => [x.path[0], x.value]));
		assert.deepStrictEqual(byKey['enabledMcpjsonServers'], ['other', 'srv']);
		assert.deepStrictEqual(byKey['disabledMcpjsonServers'], undefined, 'emptied disabled array is deleted');
	});

	test('approval default removes from both; emptying writes a delete', () => {
		const latest = parseMcpSettings({ enabledMcpjsonServers: ['srv'] });
		const w = mcpApprovalWrites(latest, 'srv', 'default');
		assert.deepStrictEqual(w, [{ path: ['enabledMcpjsonServers'], value: undefined }]);
		// no-op when already in the target state
		assert.deepStrictEqual(mcpApprovalWrites(parseMcpSettings({}), 'srv', 'default'), []);
	});

	test('enableAll write toggles / deletes the key', () => {
		assert.deepStrictEqual(enableAllProjectMcpServersWrite(true), { path: ['enableAllProjectMcpServers'], value: true });
		assert.deepStrictEqual(enableAllProjectMcpServersWrite(false), { path: ['enableAllProjectMcpServers'], value: undefined });
	});

	test('summarizeMcpDef reports transport + redacted detail (never env/header values)', () => {
		const stdio = summarizeMcpDef({ command: 'uvx', args: ['rutherford-mcp-server'], env: { TOKEN: 'secret-xyz' } });
		assert.strictEqual(stdio.transport, 'stdio');
		assert.strictEqual(stdio.detail, 'uvx rutherford-mcp-server');
		assert.deepStrictEqual(stdio.envKeys, ['TOKEN']);
		assert.ok(!JSON.stringify(stdio).includes('secret-xyz'), 'env values are never surfaced');

		const remote = summarizeMcpDef({ type: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer abc' } });
		assert.strictEqual(remote.transport, 'sse');
		assert.strictEqual(remote.detail, 'https://mcp.example.com/sse');
		assert.deepStrictEqual(remote.headerKeys, ['Authorization']);
		assert.ok(!JSON.stringify(remote).includes('Bearer abc'), 'header values are never surfaced');

		const http = summarizeMcpDef({ url: 'https://mcp.example.com/mcp' });
		assert.strictEqual(http.transport, 'http');

		// URL userinfo + query can carry credentials - they must be redacted in the display detail.
		const creds = summarizeMcpDef({ url: 'https://user:pass@host.example.com/mcp?token=abc123' });
		assert.ok(!creds.detail.includes('pass'), 'userinfo redacted');
		assert.ok(!creds.detail.includes('abc123'), 'query token redacted');
		assert.ok(creds.detail.startsWith('https://host.example.com/mcp'), `kept scheme/host/path: ${creds.detail}`);
	});
});
