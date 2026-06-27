/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	MARKETPLACE_NAME_RE, parseInstalledPlugins, parseKnownMarketplaces, parseMarketplaceCatalog,
} from '../../browser/control/claudePluginsModel.js';

suite('claudePluginsModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseKnownMarketplaces: source label precedence, autoUpdate, sort, junk skipped', () => {
		const result = parseKnownMarketplaces({
			zeta: { source: { source: 'github', repo: 'owner/zeta' }, installLocation: '/z', lastUpdated: '2026-06-01T10:20:30Z', autoUpdate: true },
			alpha: { source: { source: 'git', url: 'https://example.com/a.git' } },
			local: { source: { source: 'local', path: '/home/me/mp' }, autoUpdate: false },
			typeonly: { source: { source: 'github' } },
			junk: 42,
		});
		assert.deepStrictEqual(result, [
			{ name: 'alpha', sourceLabel: 'https://example.com/a.git', lastUpdated: undefined, autoUpdate: false },
			{ name: 'local', sourceLabel: '/home/me/mp', lastUpdated: undefined, autoUpdate: false },
			{ name: 'typeonly', sourceLabel: 'github', lastUpdated: undefined, autoUpdate: false },
			{ name: 'zeta', sourceLabel: 'owner/zeta', lastUpdated: '2026-06-01T10:20:30Z', autoUpdate: true },
		]);
		// tolerant of non-object / missing input
		assert.deepStrictEqual(parseKnownMarketplaces(undefined), []);
		assert.deepStrictEqual(parseKnownMarketplaces([1, 2]), []);
	});

	test('parseMarketplaceCatalog: id composition, author object vs string, homepage http(s)-only, dedup by name, skip nameless + junk', () => {
		const result = parseMarketplaceCatalog({
			name: 'mp', plugins: [
				{ name: 'fmt', description: 'Formatter', author: { name: 'Ada' }, category: 'tools', homepage: 'https://fmt.example' },
				{ name: 'lint', author: 'Grace', homepage: 'ftp://nope' },
				{ name: 'fmt', description: 'duplicate - skipped' },
				{ description: 'no name - skipped' },
				'not-an-object',
			],
		}, 'mp');
		assert.deepStrictEqual(result, [
			{ id: 'fmt@mp', name: 'fmt', marketplace: 'mp', description: 'Formatter', author: 'Ada', category: 'tools', homepage: 'https://fmt.example' },
			{ id: 'lint@mp', name: 'lint', marketplace: 'mp', description: undefined, author: 'Grace', category: undefined, homepage: undefined },
		]);
		assert.deepStrictEqual(parseMarketplaceCatalog({ plugins: 'nope' }, 'mp'), []);
		assert.deepStrictEqual(parseMarketplaceCatalog(undefined, 'mp'), []);
	});

	test('parseInstalledPlugins: keys + first-record version, missing/empty tolerated', () => {
		const result = parseInstalledPlugins({
			version: 1, plugins: {
				'fmt@mp': [{ scope: 'user', version: '1.2.0' }, { scope: 'project', version: '9.9.9' }],
				'lint@mp': [{ scope: 'user' }],
				'bare@mp': [],
			},
		});
		assert.deepStrictEqual(result, [
			{ id: 'fmt@mp', version: '1.2.0' },
			{ id: 'lint@mp', version: undefined },
			{ id: 'bare@mp', version: undefined },
		]);
		assert.deepStrictEqual(parseInstalledPlugins({}), []);
		assert.deepStrictEqual(parseInstalledPlugins(undefined), []);
	});

	test('MARKETPLACE_NAME_RE accepts safe names and rejects shell metacharacters', () => {
		assert.ok(MARKETPLACE_NAME_RE.test('anthropic-marketplace'));
		assert.ok(MARKETPLACE_NAME_RE.test('my.mp_2'));
		assert.ok(!MARKETPLACE_NAME_RE.test('bad name'));
		assert.ok(!MARKETPLACE_NAME_RE.test('rm -rf;'));
		assert.ok(!MARKETPLACE_NAME_RE.test('a/b'));
		assert.ok(!MARKETPLACE_NAME_RE.test(''));
	});
});
