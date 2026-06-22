/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native webview Claude chat (Phase 3 INC-0: container)
// Registers the native Claude chat as its own container in the RIGHT (auxiliary-bar) sidebar, ONLY in
// Clawdius mode (empty entitlementUrl). This is the faithful replica of the official Claude Code plugin's
// right-hand webview chat. INC-0 registers it as a NON-default container (isDefault:false) so the existing
// (working) right-pane chat stays the default while the shell is built; INC-1 round-trips the agent-host
// bridge and only then flips this to the default + suppresses the workbench chat container. This keeps a
// working chat at every step (no regression window).

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import product from '../../../../../platform/product/common/product.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { CLAWDIUS_CHAT_VIEW_CONTAINER_ID, CLAWDIUS_CHAT_VIEW_ID } from '../../common/clawdius.js';
import { ClawdiusChatViewPane } from './clawdiusChatViewPane.js';

if (!product.defaultChatAgent?.entitlementUrl) {

	const clawdiusChatIcon = registerIcon('clawdius-chat-view-icon', Codicon.claude, localize('clawdiusChatViewIcon', "Icon for the native Claude chat container."));

	const chatViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
		id: CLAWDIUS_CHAT_VIEW_CONTAINER_ID,
		title: localize2('clawdius.chat.container', "Claude Code Chat"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CLAWDIUS_CHAT_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: clawdiusChatIcon,
		order: 1,
	}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });

	const chatView: IViewDescriptor = {
		id: CLAWDIUS_CHAT_VIEW_ID,
		containerIcon: clawdiusChatIcon,
		name: localize2('clawdius.chat.view', "Claude"),
		ctorDescriptor: new SyncDescriptor(ClawdiusChatViewPane),
		// The container uses doNotRegisterOpenCommand, so provide an explicit open command (like the workbench
		// chat does) - otherwise, since this is a NON-default aux-bar container, there is no command to reopen
		// it once hidden. No keybinding yet (would collide with the still-default workbench chat); INC-1 takes
		// over the chat keybinding when this becomes the default and the workbench chat is suppressed.
		openCommandActionDescriptor: {
			id: CLAWDIUS_CHAT_VIEW_CONTAINER_ID,
			title: localize2('clawdius.chat.open', "Open Claude Code Chat"),
			order: 1,
		},
		canToggleVisibility: true,
		canMoveView: true,
		order: 1,
	};

	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([chatView], chatViewContainer);
}
// CLAWDIUS-END
