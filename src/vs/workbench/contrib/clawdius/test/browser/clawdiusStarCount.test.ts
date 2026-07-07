/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatStarCount } from '../../browser/control/clawdiusStarCountService.js';

suite('Clawdius star-count formatting', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats counts GitHub-style across the ranges', () => {
		const cases: [number, string][] = [
			[0, '0'],
			[2, '2'],
			[942, '942'],
			[999, '999'],
			[1000, '1k'],       // exact thousand drops the .0
			[1234, '1.2k'],
			[1950, '1.9k'],     // one-decimal band (1.95k -> "1.9" via toFixed, as GitHub shows)
			[9999, '10k'],
			[12000, '12k'],     // >= 10k drops the decimal
			[123456, '123k'],
			[1_000_000, '1m'],
			[2_500_000, '2.5m'],
			[15_000_000, '15m'],
		];
		const actual = cases.map(([n]) => formatStarCount(n));
		assert.deepStrictEqual(actual, cases.map(([, s]) => s));
	});
});
