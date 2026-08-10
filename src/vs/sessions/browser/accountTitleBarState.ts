/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { localize } from '../../nls.js';
import { IDefaultAccountService } from '../../platform/defaultAccount/common/defaultAccount.js';
import { IAuthenticationService } from '../../workbench/services/authentication/common/authentication.js';

export interface IResolvedAccountInfo {
	readonly accountName: string;
	readonly accountProviderId: string;
	readonly accountProviderLabel: string;
}

/**
 * Resolves the current account info by trying the default account service
 * first, then falling back to raw GitHub sessions from the authentication
 * service. The fallback covers the window between session creation and
 * {@link IDefaultAccountService} initialization.
 */
export async function resolveAccountInfo(
	defaultAccountService: IDefaultAccountService,
	authenticationService: IAuthenticationService,
): Promise<IResolvedAccountInfo | undefined> {
	const account = await defaultAccountService.getDefaultAccount();
	if (account) {
		return {
			accountName: account.accountName,
			accountProviderId: account.authenticationProvider.id,
			accountProviderLabel: account.authenticationProvider.name,
		};
	}

	try {
		const sessions = await authenticationService.getSessions('github');
		if (sessions.length > 0) {
			return {
				accountName: sessions[0].account.label,
				accountProviderId: 'github',
				accountProviderLabel: 'GitHub',
			};
		}
	} catch {
		// Provider not available yet
	}

	return undefined;
}

export type AccountTitleBarStateSource = 'account';
export type AccountTitleBarStateKind = 'default' | 'accent' | 'warning' | 'prominent';

export interface IAccountTitleBarStateContext {
	readonly isAccountLoading: boolean;
	readonly accountName?: string;
	readonly accountProviderLabel?: string;
}

export interface IAccountTitleBarState {
	readonly source: AccountTitleBarStateSource;
	readonly kind: AccountTitleBarStateKind;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly ariaLabel: string;
	readonly badge?: string;
	readonly dotBadge?: 'warning' | 'error';
	readonly revealLabelOnHover?: boolean;
}

export function getAccountProfileImageUrl(accountProviderId: string | undefined, accountName: string | undefined): string | undefined {
	if (accountProviderId !== 'github' || !accountName?.trim()) {
		return undefined;
	}

	return `https://github.com/${encodeURIComponent(accountName.trim())}.png?size=64`;
}

export function getAccountTitleBarBadgeKey(state: IAccountTitleBarState): string | undefined {
	if (!state.dotBadge) {
		return undefined;
	}

	return `${state.source}:${state.dotBadge}:${state.badge ?? ''}`;
}

export function getAccountTitleBarState(context: IAccountTitleBarStateContext): IAccountTitleBarState {
	if (context.isAccountLoading) {
		return {
			source: 'account',
			kind: 'default',
			icon: ThemeIcon.modify(Codicon.loading, 'spin'),
			label: localize('loadingAccount', "Loading Account..."),
			ariaLabel: localize('loadingAccountAria', "Loading account"),
			revealLabelOnHover: true,
		};
	}

	if (context.accountName) {
		return {
			source: 'account',
			kind: 'default',
			icon: Codicon.account,
			label: context.accountName,
			revealLabelOnHover: true,
			ariaLabel: context.accountProviderLabel
				? localize('accountSignedInAria', "Signed in as {0} with {1}", context.accountName, context.accountProviderLabel)
				: localize('accountSignedInAriaNameOnly', "Signed in as {0}", context.accountName),
		};
	}

	return {
		source: 'account',
		kind: 'prominent',
		icon: Codicon.account,
		label: localize('signInLabel', "Sign In"),
		ariaLabel: localize('signInAria', "Sign in to your account"),
	};
}
