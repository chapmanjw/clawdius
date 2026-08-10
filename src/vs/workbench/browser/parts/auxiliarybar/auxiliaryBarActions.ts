/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import product from '../../../../platform/product/common/product.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { AuxiliaryBarMaximizedContext, AuxiliaryBarVisibleContext, IsAuxiliaryWindowContext, SecondarySideBarVisibleContext } from '../../../common/contextkeys.js';
import { ViewContainerLocation, ViewContainerLocationToString } from '../../../common/views.js';
import { ActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { SwitchCompositeViewAction } from '../compositeBarActions.js';

const maximizeIcon = registerIcon('auxiliarybar-maximize', Codicon.screenFull, localize('maximizeIcon', 'Icon to maximize the secondary side bar.'));
const closeIcon = registerIcon('auxiliarybar-close', Codicon.close, localize('closeIcon', 'Icon to close the secondary side bar.'));

// CLAWDIUS-BEGIN Claude chat-bubble toggle icon
// In Clawdius the secondary side bar IS the native Claude chat, so its show/hide toggle reads as the Claude
// mark (a chat affordance, Kiro-style) rather than a generic right-pane layout glyph. Upstream (entitlementUrl
// present) keeps the layout icons unchanged.
const clawdiusChatToggle = !product.defaultChatAgent?.entitlementUrl;
// In Clawdius the toggle wears the bespoke Claude Code chat SVG (chat bubble + Claude mark), themed via a CSS
// mask so it follows the toolbar foreground in light + dark - instead of the flat Codicon.claude font glyph.
// registerIcon is idempotent, so this returns the SAME ThemeIcon the clawdius contrib registers; the id
// 'clawdius-claude-code-chat' is the cross-layer contract and its mask CSS ships with that contrib. Using a
// real ThemeIcon (not a {light,dark} URI) means the Customize Layout quick pick renders it via `$(id)` too.
export const clawdiusChatToggleIcon = registerIcon('clawdius-claude-code-chat', Codicon.commentDiscussion, localize('clawdiusAuxBarChatIcon', 'Claude Code chat icon.'));
const auxiliaryBarRightIcon = clawdiusChatToggle ? clawdiusChatToggleIcon : registerIcon('auxiliarybar-right-layout-icon', Codicon.layoutSidebarRight, localize('toggleAuxiliaryIconRight', 'Icon to toggle the secondary side bar off in its right position.'));
const auxiliaryBarRightOffIcon = clawdiusChatToggle ? clawdiusChatToggleIcon : registerIcon('auxiliarybar-right-off-layout-icon', Codicon.layoutSidebarRightOff, localize('toggleAuxiliaryIconRightOn', 'Icon to toggle the secondary side bar on in its right position.'));
const auxiliaryBarLeftIcon = clawdiusChatToggle ? clawdiusChatToggleIcon : registerIcon('auxiliarybar-left-layout-icon', Codicon.layoutSidebarLeft, localize('toggleAuxiliaryIconLeft', 'Icon to toggle the secondary side bar in its left position.'));
const auxiliaryBarLeftOffIcon = clawdiusChatToggle ? clawdiusChatToggleIcon : registerIcon('auxiliarybar-left-off-layout-icon', Codicon.layoutSidebarLeftOff, localize('toggleAuxiliaryIconLeftOn', 'Icon to toggle the secondary side bar on in its left position.'));
// In Clawdius the secondary side bar IS the native Claude chat, so its show/hide toggle reads "Claude Code
// Chat" everywhere it surfaces (top-bar tooltip, Customize Layout, command palette, pane title) rather than
// the generic "Secondary Side Bar". Both localize keys are static; only one is selected at runtime.
const auxBarToggleTitle = clawdiusChatToggle ? localize('toggleClaudeCodeChat', "Toggle Claude Code Chat") : localize('toggleSecondarySideBar', "Toggle Secondary Side Bar");
const auxBarHide = clawdiusChatToggle ? localize('hideClaudeCodeChat', "Hide Claude Code Chat") : localize('hideSecondarySideBar', "Hide Secondary Side Bar");
// CLAWDIUS-END

export class ToggleAuxiliaryBarAction extends Action2 {

	static readonly ID = 'workbench.action.toggleAuxiliaryBar';
	// CLAWDIUS-BEGIN Claude chat-bubble toggle label
	static readonly LABEL = clawdiusChatToggle ? localize2('toggleClaudeCodeChatCmd', "Toggle Claude Code Chat") : localize2('toggleAuxiliaryBar', "Toggle Secondary Side Bar Visibility");
	// CLAWDIUS-END

	constructor() {
		super({
			id: ToggleAuxiliaryBarAction.ID,
			title: ToggleAuxiliaryBarAction.LABEL,
			toggled: {
				condition: SecondarySideBarVisibleContext,
				// CLAWDIUS-BEGIN Claude chat-bubble toggle label
				title: auxBarHide,
				icon: closeIcon,
				mnemonicTitle: clawdiusChatToggle ? localize({ key: 'miClaudeCodeChat', comment: ['&& denotes a mnemonic'] }, "Claude Code &&Chat") : localize({ key: 'miCloseSecondarySideBar', comment: ['&& denotes a mnemonic'] }, "&&Secondary Side Bar"),
				// CLAWDIUS-END
			},
			icon: closeIcon,
			category: Categories.View,
			metadata: {
				description: localize('openAndCloseAuxiliaryBar', 'Open/Show and Close/Hide Secondary Side Bar'),
			},
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyB
			},
			menu: [
				{
					id: MenuId.LayoutControlMenuSubmenu,
					group: '0_workbench_layout',
					order: 1
				},
				{
					id: MenuId.MenubarAppearanceMenu,
					group: '2_workbench_layout',
					order: 2
				}
			]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// Delegate to the layout service: each workbench (classic, sessions, single-pane) decides which part
		// its secondary side bar maps to and announces the change itself. The Clawdius-specific screen-reader
		// wording lives with those implementations, not here.
		accessor.get(IWorkbenchLayoutService).toggleSecondarySideBar();
	}
}

registerAction2(ToggleAuxiliaryBarAction);

MenuRegistry.appendMenuItem(MenuId.AuxiliaryBarTitle, {
	command: {
		id: ToggleAuxiliaryBarAction.ID,
		// CLAWDIUS-BEGIN Claude chat-bubble toggle label
		title: auxBarHide,
		// CLAWDIUS-END
		icon: closeIcon
	},
	group: 'navigation',
	order: 2,
	when: ContextKeyExpr.equals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.DEFAULT)
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.closeAuxiliaryBar',
			title: localize2('closeSecondarySideBar', 'Hide Secondary Side Bar'),
			category: Categories.View,
			precondition: AuxiliaryBarVisibleContext,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor) {
		accessor.get(IWorkbenchLayoutService).setPartHidden(true, Parts.AUXILIARYBAR_PART);
	}
});

registerAction2(class FocusAuxiliaryBarAction extends Action2 {

	static readonly ID = 'workbench.action.focusAuxiliaryBar';
	static readonly LABEL = localize2('focusAuxiliaryBar', "Focus into Secondary Side Bar");

	constructor() {
		super({
			id: FocusAuxiliaryBarAction.ID,
			title: FocusAuxiliaryBarAction.LABEL,
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const paneCompositeService = accessor.get(IPaneCompositePartService);
		const layoutService = accessor.get(IWorkbenchLayoutService);

		// Show auxiliary bar
		if (!layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		}

		// Focus into active composite
		const composite = paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		composite?.focus();
	}
});

MenuRegistry.appendMenuItems([
	{
		id: MenuId.LayoutControlMenu,
		item: {
			group: 'navigation',
			command: {
				id: ToggleAuxiliaryBarAction.ID,
				title: auxBarToggleTitle,
				toggled: { condition: AuxiliaryBarVisibleContext, icon: auxiliaryBarLeftIcon },
				icon: auxiliaryBarLeftOffIcon,
			},
			when: ContextKeyExpr.and(
				IsAuxiliaryWindowContext.negate(),
				ContextKeyExpr.or(
					ContextKeyExpr.equals('config.workbench.layoutControl.type', 'toggles'),
					ContextKeyExpr.equals('config.workbench.layoutControl.type', 'both')),
				ContextKeyExpr.equals('config.workbench.sideBar.location', 'right')
			),
			order: 0
		}
	}, {
		id: MenuId.LayoutControlMenu,
		item: {
			group: 'navigation',
			command: {
				id: ToggleAuxiliaryBarAction.ID,
				title: auxBarToggleTitle,
				toggled: { condition: AuxiliaryBarVisibleContext, icon: auxiliaryBarRightIcon },
				icon: auxiliaryBarRightOffIcon,
			},
			when: ContextKeyExpr.and(
				IsAuxiliaryWindowContext.negate(),
				ContextKeyExpr.or(
					ContextKeyExpr.equals('config.workbench.layoutControl.type', 'toggles'),
					ContextKeyExpr.equals('config.workbench.layoutControl.type', 'both')),
				ContextKeyExpr.equals('config.workbench.sideBar.location', 'left')
			),
			order: 2
		}
	}, {
		id: MenuId.ViewContainerTitleContext,
		item: {
			group: '3_workbench_layout_move',
			command: {
				id: ToggleAuxiliaryBarAction.ID,
				title: localize2('hideAuxiliaryBar', 'Hide Secondary Side Bar'),
			},
			when: ContextKeyExpr.and(AuxiliaryBarVisibleContext, ContextKeyExpr.equals('viewContainerLocation', ViewContainerLocationToString(ViewContainerLocation.AuxiliaryBar))),
			order: 2
		}
	}
]);

registerAction2(class extends SwitchCompositeViewAction {
	constructor() {
		super({
			id: 'workbench.action.previousAuxiliaryBarView',
			title: localize2('previousAuxiliaryBarView', 'Previous Secondary Side Bar View'),
			category: Categories.View,
			f1: true
		}, ViewContainerLocation.AuxiliaryBar, -1);
	}
});

registerAction2(class extends SwitchCompositeViewAction {
	constructor() {
		super({
			id: 'workbench.action.nextAuxiliaryBarView',
			title: localize2('nextAuxiliaryBarView', 'Next Secondary Side Bar View'),
			category: Categories.View,
			f1: true
		}, ViewContainerLocation.AuxiliaryBar, 1);
	}
});

// --- Maximized Mode

class MaximizeAuxiliaryBar extends Action2 {

	static readonly ID = 'workbench.action.maximizeAuxiliaryBar';

	constructor() {
		super({
			id: MaximizeAuxiliaryBar.ID,
			title: localize2('maximizeAuxiliaryBar', 'Maximize Secondary Side Bar'),
			tooltip: localize('maximizeAuxiliaryBarTooltip', "Maximize Secondary Side Bar"),
			category: Categories.View,
			f1: true,
			precondition: AuxiliaryBarMaximizedContext.negate(),
		});
	}

	run(accessor: ServicesAccessor) {
		const layoutService = accessor.get(IWorkbenchLayoutService);

		layoutService.setAuxiliaryBarMaximized(true);
	}
}
registerAction2(MaximizeAuxiliaryBar);

class RestoreAuxiliaryBar extends Action2 {

	static readonly ID = 'workbench.action.restoreAuxiliaryBar';

	constructor() {
		super({
			id: RestoreAuxiliaryBar.ID,
			title: localize2('restoreAuxiliaryBar', 'Restore Secondary Side Bar'),
			tooltip: localize('restoreAuxiliaryBar', 'Restore Secondary Side Bar'),
			category: Categories.View,
			f1: true,
			precondition: AuxiliaryBarMaximizedContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyW,
				win: { primary: KeyMod.CtrlCmd | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyCode.KeyW] },
			}
		});
	}

	run(accessor: ServicesAccessor) {
		const layoutService = accessor.get(IWorkbenchLayoutService);

		layoutService.setAuxiliaryBarMaximized(false);
	}
}
registerAction2(RestoreAuxiliaryBar);

class ToggleMaximizedAuxiliaryBar extends Action2 {

	static readonly ID = 'workbench.action.toggleMaximizedAuxiliaryBar';

	constructor() {
		super({
			id: ToggleMaximizedAuxiliaryBar.ID,
			title: localize2('toggleMaximizedAuxiliaryBar', 'Toggle Maximized Secondary Side Bar'),
			tooltip: localize('maximizeAuxiliaryBarTooltip2', "Maximize Secondary Side Bar"),
			f1: true,
			category: Categories.View,
			icon: maximizeIcon,
			toggled: {
				condition: AuxiliaryBarMaximizedContext,
				tooltip: localize('restoreAuxiliaryBar', 'Restore Secondary Side Bar'),
			},
			menu: {
				id: MenuId.AuxiliaryBarTitle,
				group: 'navigation',
				order: 1,
			}
		});
	}

	run(accessor: ServicesAccessor) {
		const layoutService = accessor.get(IWorkbenchLayoutService);

		layoutService.toggleMaximizedAuxiliaryBar();
	}
}
registerAction2(ToggleMaximizedAuxiliaryBar);
