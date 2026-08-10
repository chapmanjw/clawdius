/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getAccountProfileImageUrl, getAccountTitleBarState, IAccountTitleBarStateContext } from '../../../../browser/accountTitleBarState.js';

suite('Sessions - Account Title Bar State', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function createState(overrides: Partial<IAccountTitleBarStateContext> = {}): IAccountTitleBarStateContext {
		return {
			isAccountLoading: false,
			accountName: 'lee@example.com',
			accountProviderLabel: 'GitHub',
			...overrides,
		};
	}

	test('falls back to signed-in account label when no higher-priority state exists', () => {
		const state = getAccountTitleBarState(createState());

		assert.deepStrictEqual({
			source: state.source,
			label: state.label,
			kind: state.kind,
			revealLabelOnHover: state.revealLabelOnHover,
		}, {
			source: 'account',
			label: 'lee@example.com',
			kind: 'default',
			revealLabelOnHover: true,
		});
	});

	test('reveals loading account label only on hover', () => {
		const state = getAccountTitleBarState(createState({
			isAccountLoading: true,
			accountName: undefined,
			accountProviderLabel: undefined,
		}));

		assert.deepStrictEqual({
			source: state.source,
			label: state.label,
			kind: state.kind,
			revealLabelOnHover: state.revealLabelOnHover,
		}, {
			source: 'account',
			label: 'Loading Account...',
			kind: 'default',
			revealLabelOnHover: true,
		});
	});

	test('shows sign in state when no account is available', () => {
		const state = getAccountTitleBarState(createState({
			accountName: undefined,
			accountProviderLabel: undefined,
		}));

		assert.deepStrictEqual({
			source: state.source,
			label: state.label,
			kind: state.kind,
		}, {
			source: 'account',
			label: 'Sign In',
			kind: 'prominent',
		});
	});

	test('returns a GitHub profile image URL for GitHub accounts', () => {
		assert.strictEqual(
			getAccountProfileImageUrl('github', 'mona lisa'),
			'https://github.com/mona%20lisa.png?size=64'
		);
	});

	test('falls back to the codicon when no GitHub profile image URL is available', () => {
		assert.strictEqual(getAccountProfileImageUrl(undefined, 'octocat'), undefined);
		assert.strictEqual(getAccountProfileImageUrl('github-enterprise', 'octocat'), undefined);
		assert.strictEqual(getAccountProfileImageUrl('github', undefined), undefined);
	});
});
