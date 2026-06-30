/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IGithubRelease, isNewer, pickRelease } from '../../browser/update/clawdiusUpdateService.js';

function rel(tag: string, opts?: { prerelease?: boolean; draft?: boolean }): IGithubRelease {
	return {
		tag_name: tag,
		html_url: `https://example.test/${tag}`,
		prerelease: !!opts?.prerelease,
		draft: !!opts?.draft,
	};
}

suite('clawdiusUpdate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// --- pickRelease ------------------------------------------------------------------------------------------

	test('pickRelease: stable picks the newest non-prerelease and ignores prereleases', () => {
		const releases = [rel('v1.2.0'), rel('v1.3.0-beta1', { prerelease: true }), rel('v1.2.5')];
		assert.strictEqual(pickRelease(releases, 'stable')?.tag_name, 'v1.2.5');
	});

	test('pickRelease: prerelease picks the newest including prereleases', () => {
		const releases = [rel('v1.2.0'), rel('v1.3.0-beta1', { prerelease: true }), rel('v1.2.5')];
		assert.strictEqual(pickRelease(releases, 'prerelease')?.tag_name, 'v1.3.0-beta1');
	});

	test('pickRelease: drafts are always excluded on both channels', () => {
		const releases = [rel('v2.0.0', { draft: true }), rel('v2.1.0-rc1', { prerelease: true, draft: true }), rel('v1.9.0')];
		assert.strictEqual(pickRelease(releases, 'stable')?.tag_name, 'v1.9.0');
		assert.strictEqual(pickRelease(releases, 'prerelease')?.tag_name, 'v1.9.0');
	});

	test('pickRelease: empty list and no-match return undefined', () => {
		assert.strictEqual(pickRelease([], 'stable'), undefined);
		// On the stable channel a list of only prereleases yields no match.
		assert.strictEqual(pickRelease([rel('v1.0.0-rc1', { prerelease: true })], 'stable'), undefined);
	});

	test('pickRelease: tags with and without a leading v compare by semver, not lexically', () => {
		const releases = [rel('1.2.0'), rel('v1.10.0')];
		// 1.10.0 > 1.2.0 numerically (a lexical compare would wrongly pick "1.2.0").
		assert.strictEqual(pickRelease(releases, 'stable')?.tag_name, 'v1.10.0');
	});

	// --- isNewer ----------------------------------------------------------------------------------------------

	test('isNewer: prerelease ordering, stable over its prerelease, equal/older/invalid', () => {
		assert.deepStrictEqual(
			[
				isNewer('1.125.0-alpha4', '1.125.0-alpha3'),
				isNewer('1.125.0', '1.125.0-alpha3'),
				isNewer('v1.125.0', '1.125.0-alpha3'),
				isNewer('1.125.0', '1.125.0'),
				isNewer('1.124.0', '1.125.0'),
				isNewer('not-a-version', '1.125.0'),
				isNewer('1.125.0', 'not-a-version'),
			],
			[true, true, true, false, false, false, false],
		);
	});
});
