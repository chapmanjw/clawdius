/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IMcpServerForm, buildMcpDef, emptyMcpForm, enableAllProjectMcpServersWrite, mcpApproval, mcpApprovalWrites, mcpDeleteWrite,
	mcpEffectiveApproval, mergeMcpDefForSave, parseMcpDefForEdit, parseMcpSettings, sameMcpDefSummary, summarizeMcpDef,
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

	test('summarizeMcpDef surfaces non-secret ws / headersHelper / oauth / timeout / alwaysLoad (never secret values)', () => {
		const ws = summarizeMcpDef({ type: 'ws', url: 'wss://host/mcp' });
		assert.strictEqual(ws.transport, 'ws');

		const full = summarizeMcpDef({
			type: 'http', url: 'https://host/mcp', timeout: 5000, alwaysLoad: true,
			headers: { Authorization: 'Bearer secret-xyz' }, headersHelper: 'get-token --secret abc',
			oauth: { clientId: 'cid', clientSecret: 'shhh', callbackPort: 9000 },
		});
		assert.deepStrictEqual(
			{ transport: full.transport, hasHeadersHelper: full.hasHeadersHelper, hasOauth: full.hasOauth, timeout: full.timeout, alwaysLoad: full.alwaysLoad, headerKeys: full.headerKeys },
			{ transport: 'http', hasHeadersHelper: true, hasOauth: true, timeout: 5000, alwaysLoad: true, headerKeys: ['Authorization'] });
		assert.ok(!JSON.stringify(full).includes('secret-xyz') && !JSON.stringify(full).includes('shhh') && !JSON.stringify(full).includes('get-token'),
			'secret header / clientSecret / helper command values are never surfaced');
	});

	test('buildMcpDef stdio: always emits type, all fields, omits empties, never leaks env values in the add path', () => {
		const form: IMcpServerForm = {
			...emptyMcpForm('stdio'), command: 'uvx', args: ['srv', ''], env: [{ key: 'TOKEN', value: 'secret-xyz' }, { key: '', value: 'dropped' }],
			timeout: '3000', alwaysLoad: true,
		};
		assert.deepStrictEqual(buildMcpDef(form), { type: 'stdio', command: 'uvx', args: ['srv'], env: { TOKEN: 'secret-xyz' }, timeout: 3000, alwaysLoad: true });
		// minimal stdio still emits type + command and omits empty args / env.
		assert.deepStrictEqual(buildMcpDef({ ...emptyMcpForm('stdio'), command: 'uvx' }), { type: 'stdio', command: 'uvx' });
	});

	test('buildMcpDef remote: http with headers + oauth (no clientSecret) + headersHelper; ws has no oauth', () => {
		const http: IMcpServerForm = {
			...emptyMcpForm('http'), url: 'https://host/mcp', headers: [{ key: 'Authorization', value: 'Bearer abc' }], headersHelper: 'get-token',
			oauth: { clientId: 'cid', callbackPort: '9000', scopes: 'a b', authServerMetadataUrl: 'https://auth/.well-known' },
		};
		assert.deepStrictEqual(buildMcpDef(http), {
			type: 'http', url: 'https://host/mcp', headers: { Authorization: 'Bearer abc' }, headersHelper: 'get-token',
			oauth: { clientId: 'cid', callbackPort: 9000, scopes: 'a b', authServerMetadataUrl: 'https://auth/.well-known' },
		});
		// ws is remote but never carries an oauth block even when oauth sub-fields are filled in.
		const ws: IMcpServerForm = { ...emptyMcpForm('ws'), url: 'wss://host/mcp', oauth: { clientId: 'cid', callbackPort: '1', scopes: 's', authServerMetadataUrl: 'u' } };
		assert.deepStrictEqual(buildMcpDef(ws), { type: 'ws', url: 'wss://host/mcp' });
	});

	test('parseMcpDefForEdit strips secret values but keeps keys + non-secret fields', () => {
		const form = parseMcpDefForEdit({
			type: 'http', url: 'https://host/mcp', timeout: 4000, alwaysLoad: true,
			headers: { Authorization: 'Bearer secret-xyz', 'X-Trace': 'on' }, headersHelper: 'helper',
			oauth: { clientId: 'cid', clientSecret: 'shhh', callbackPort: 9000, scopes: 'a', authServerMetadataUrl: 'u' },
		});
		assert.deepStrictEqual(form, {
			transport: 'http', command: '', args: [], env: [], url: 'https://host/mcp',
			headers: [{ key: 'Authorization', value: '' }, { key: 'X-Trace', value: '' }], headersHelper: 'helper',
			oauth: { clientId: 'cid', callbackPort: '9000', scopes: 'a', authServerMetadataUrl: 'u' },
			timeout: '4000', alwaysLoad: true,
		});
	});

	test('mergeMcpDefForSave keeps untouched secret values, overwrites typed, drops removed; never touches clientSecret', () => {
		const fresh = { type: 'stdio', command: 'old', env: { KEPT: 'stored-secret', GONE: 'stored-gone', CHANGED: 'stored-old' } };
		const form: IMcpServerForm = {
			...emptyMcpForm('stdio'), command: 'uvx',
			env: [{ key: 'KEPT', value: '' }, { key: 'CHANGED', value: 'new-value' }, { key: 'ADDED', value: 'fresh' }],
		};
		// KEPT blank -> stored value restored; CHANGED typed -> overwritten; GONE absent -> dropped; ADDED -> added.
		assert.deepStrictEqual(mergeMcpDefForSave(fresh, form), { type: 'stdio', command: 'uvx', env: { KEPT: 'stored-secret', CHANGED: 'new-value', ADDED: 'fresh' } });
	});

	test('mcpDeleteWrite removes the server entry', () => {
		assert.deepStrictEqual(mcpDeleteWrite('my-server'), { path: ['mcpServers', 'my-server'], value: undefined });
	});

	test('sameMcpDefSummary: equal defs match; any meaningful change differs (gates the discovered-tools cache)', () => {
		const def = { type: 'stdio', command: 'uvx', args: ['srv'], env: { TOKEN: 'x' }, timeout: 5000, alwaysLoad: true };
		// A benign refresh re-reads an identical def: the cache must survive.
		assert.strictEqual(sameMcpDefSummary(summarizeMcpDef(def), summarizeMcpDef({ ...def })), true);
		// Each field that affects how a server connects flips equality (so its loaded tools get dropped).
		assert.strictEqual(sameMcpDefSummary(summarizeMcpDef(def), summarizeMcpDef({ ...def, command: 'npx' })), false);
		assert.strictEqual(sameMcpDefSummary(summarizeMcpDef(def), summarizeMcpDef({ ...def, env: { TOKEN: 'x', EXTRA: 'y' } })), false);
		assert.strictEqual(sameMcpDefSummary(summarizeMcpDef(def), summarizeMcpDef({ ...def, timeout: 6000 })), false);
		assert.strictEqual(sameMcpDefSummary(summarizeMcpDef({ type: 'http', url: 'https://host/a' }), summarizeMcpDef({ type: 'http', url: 'https://host/b' })), false);
	});

	test('toFiniteInt via buildMcpDef: non-numeric omitted, decimals truncated, negatives kept; oauth callbackPort too', () => {
		const stdio = (timeout: string) => buildMcpDef({ ...emptyMcpForm('stdio'), command: 'x', timeout });
		assert.deepStrictEqual([stdio('abc'), stdio('3.9'), stdio('-5')], [
			{ type: 'stdio', command: 'x' },             // 'abc' -> NaN -> omitted
			{ type: 'stdio', command: 'x', timeout: 3 },  // '3.9' -> truncated
			{ type: 'stdio', command: 'x', timeout: -5 }, // '-5' -> kept (not clamped)
		]);
		assert.deepStrictEqual(
			buildMcpDef({ ...emptyMcpForm('http'), url: 'https://h/mcp', oauth: { clientId: '', callbackPort: '80.5', scopes: '', authServerMetadataUrl: '' } }),
			{ type: 'http', url: 'https://h/mcp', oauth: { callbackPort: 80 } });
	});

	test('summarizeMcpDef of {} / null is unknown transport; parseMcpDefForEdit({}) round-trips to an empty stdio form', () => {
		assert.deepStrictEqual([summarizeMcpDef({}).transport, summarizeMcpDef(null).transport], ['unknown', 'unknown']);
		assert.deepStrictEqual(parseMcpDefForEdit({}), emptyMcpForm('stdio'));
	});

	test('summarizeMcpDef falls back to the raw string when the url cannot be parsed (redactUrl catch)', () => {
		assert.deepStrictEqual(summarizeMcpDef({ url: 'not a url' }), {
			transport: 'http', detail: 'not a url', envKeys: [], headerKeys: [],
			hasHeadersHelper: false, hasOauth: false, timeout: undefined, alwaysLoad: undefined,
		});
	});

	test('mcpApprovalWrites approving an already-enabled server: no-op when last, reorder when not', () => {
		// Already enabled and last in the array: filter-then-push leaves the order unchanged -> no write at all.
		assert.deepStrictEqual(mcpApprovalWrites(parseMcpSettings({ enabledMcpjsonServers: ['srv'] }), 'srv', 'approved'), []);
		// Enabled but not last: it is pulled and re-appended, so the array reorders -> a whole-array write.
		assert.deepStrictEqual(
			mcpApprovalWrites(parseMcpSettings({ enabledMcpjsonServers: ['a', 'srv', 'b'] }), 'srv', 'approved'),
			[{ path: ['enabledMcpjsonServers'], value: ['a', 'b', 'srv'] }]);
	});
});
