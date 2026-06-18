/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Clawdius regression test (new file): the no-default-account egress guard must leave the account
// service in a settled "no account" state, not a permanently-pending one.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { DefaultAccountService } from '../../browser/defaultAccount.js';

suite('Clawdius DefaultAccountService (no default-account egress)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function productWith(entitlementUrl: string): IProductService {
		return {
			_serviceBrand: undefined,
			defaultChatAgent: {
				extensionId: '',
				chatExtensionId: '',
				provider: {
					default: { id: 'github', name: 'GitHub' },
					enterprise: { id: 'github-enterprise', name: 'GitHub Enterprise' }
				},
				providerScopes: [],
				entitlementUrl
			}
		} as unknown as IProductService;
	}

	// CLAWDIUS-BEGIN no default-account egress regression
	test('getDefaultAccount resolves to null when no entitlement endpoint is configured', async () => {
		// With entitlementUrl empty, DefaultAccountProviderContribution declines to register a provider,
		// so setDefaultAccountProvider() — the only caller of initBarrier.open() — never runs. The service
		// must still open the barrier so account queries settle to "no account" rather than hanging forever.
		// Before the fix this test never settles (the await below hangs) and the runner times it out.
		const service = disposables.add(new DefaultAccountService(productWith('')));
		const account = await service.getDefaultAccount();
		assert.strictEqual(account, null);
	});
	// CLAWDIUS-END
});
