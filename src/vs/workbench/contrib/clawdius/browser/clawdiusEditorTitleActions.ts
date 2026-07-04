/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN editor-title Claude Code cluster: Open Chat + New Session + New Terminal Session
// A CONTIGUOUS three-button cluster on every editor title bar, replacing the anthropic.claude-code extension's
// single "Open" button (which is suppressed for Clawdius in menusExtensionPoint.ts). Registering all three as
// fork Action2s in one adjacent order block (-102, -101, -100) keeps them grouped so nothing - markdown's "Open
// Preview" (navigation@1/@2), core split (order 100000), core debug's editor-title item (order -1) - can
// interleave between them (the earlier bug where the trio scattered on a .md file). The block sits well left of
// all of those and shares an order with none of them. They render left-to-right: Open Chat | New Session | New Terminal.
//
// Each is bound to a STABLE command so it actually works (the earlier New Session bug was targeting the fork's
// dynamic `openNewSessionEditor.agent-host-claude`, which is only registered if the agent-host chat-session
// provider is up - it is NOT in a plain extension-chat setup, so the button no-op'd):
//   - Open Chat    -> workbench.action.focusAuxiliaryBar - reveal + focus the SECONDARY side bar on the right,
//                     which in Clawdius IS the Claude chat pane (the "CLAUDE CODE" webview); NOT an editor tab
//                     (that is New Session). This workbench command unhides the aux bar if hidden, then focuses
//                     its active composite - robust and independent of the extension's internal view ids (the
//                     extension's own sidebar.open targets the PRIMARY-sidebar view, which does not exist in our
//                     secondary-sidebar setup, and a `<viewId>.focus` id flips on claude-code:doesNotSupport...).
//   - New Session  -> claude-vscode.editor.open      ("Claude Code: Open in New Tab") - new chat as an editor tab
//   - New Terminal -> a NEW terminal in the EDITOR area (a tab, not the bottom panel) running `claude`
//
// Visibility gate: `config.claudeCode.useTerminal == false`. Using EQUALS (not `!config...`) means the buttons
// show only when that config key is registered AND false - i.e. the claude-code extension is installed and not
// in terminal mode - so the extension commands the first two invoke are guaranteed to exist (executeCommand on
// a declared extension command also activates the extension). Registered only from clawdius.contribution.ts's
// entitlementUrl block, so this is Clawdius-only. Icons are the bespoke masked SVGs (chat/window/terminal +
// Claude mark) from clawdiusCustomIcons.ts.

import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { ACTIVE_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommandsContext.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { clawdiusChatIcon, clawdiusSessionIcon, clawdiusTerminalIcon } from './clawdiusCustomIcons.js';
import { CLAUDE_CODE_PLUGIN_INSTALLED_CONTEXT } from './clawdiusPluginSetup.js';

// The editor-title button was clicked on a specific editor group's toolbar. Resolve THAT group from the menu
// action args (how core editor-title actions do it) and make it active, so New Session / New Terminal open in
// the group they were clicked for - not a new group, and not the opposite one.
function activateClickedGroup(accessor: ServicesAccessor, args: unknown[]): void {
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const ctx = resolveCommandsContext(args, accessor.get(IEditorService), editorGroupsService, accessor.get(IListService));
	const group = ctx.groupedEditors[0]?.group ?? editorGroupsService.activeGroup;
	editorGroupsService.activateGroup(group);
}

// Show only when the claude-code extension is actually INSTALLED (so the extension commands below exist) AND it
// is not in terminal mode (matching the extension's own "Open" button, which is `!config.claudeCode.useTerminal`).
// The install-presence context key is the robust signal: gating on `config.claudeCode.useTerminal == false`
// alone is NOT sufficient - Clawdius writes that setting to false during setup, so it can linger false after the
// plugin is later removed, which would leave the cluster showing dead buttons. AND-ing the presence key fixes that.
const CLUSTER_WHEN = ContextKeyExpr.and(
	CLAUDE_CODE_PLUGIN_INSTALLED_CONTEXT.isEqualTo(true),
	ContextKeyExpr.not('config.claudeCode.useTerminal'),
);
const GROUP = 'navigation';

class ClawdiusOpenChatEditorTitleAction extends Action2 {
	static readonly ID = 'clawdius.chat.openChatEditorTitle';
	constructor() {
		super({
			id: ClawdiusOpenChatEditorTitleAction.ID,
			title: localize2('clawdius.openChatEditorTitle', "Claude Code: Open Chat"),
			icon: clawdiusChatIcon,
			f1: false,
			menu: [{ id: MenuId.EditorTitle, group: GROUP, order: -102, when: CLUSTER_WHEN }]
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		// Reveal + focus the SECONDARY side bar on the right - in Clawdius that IS the Claude chat pane. NOT a new
		// editor tab (that is New Session). This workbench command unhides the aux bar (if hidden) then focuses it.
		return accessor.get(ICommandService).executeCommand('workbench.action.focusAuxiliaryBar');
	}
}

class ClawdiusNewSessionEditorTitleAction extends Action2 {
	static readonly ID = 'clawdius.chat.newSessionEditorTitle';
	constructor() {
		super({
			id: ClawdiusNewSessionEditorTitleAction.ID,
			title: localize2('clawdius.newSessionEditorTitle', "Claude Code: New Session"),
			icon: clawdiusSessionIcon,
			f1: false,
			menu: [{ id: MenuId.EditorTitle, group: GROUP, order: -101, when: CLUSTER_WHEN }]
		});
	}
	run(accessor: ServicesAccessor, ...args: unknown[]): Promise<unknown> {
		// Open the new chat as a tab in the SAME group the button was clicked on (not a new/opposite group).
		activateClickedGroup(accessor, args);
		// "Open in New Tab" = a new Claude chat as an editor tab, the same as the activity-pane New Session.
		return accessor.get(ICommandService).executeCommand('claude-vscode.editor.open');
	}
}

class ClawdiusNewTerminalSessionEditorTitleAction extends Action2 {
	static readonly ID = 'clawdius.chat.newTerminalSessionEditorTitle';
	constructor() {
		super({
			id: ClawdiusNewTerminalSessionEditorTitleAction.ID,
			title: localize2('clawdius.newTerminalSessionEditorTitle', "Claude Code: New Terminal Session"),
			icon: clawdiusTerminalIcon,
			f1: false,
			menu: [{ id: MenuId.EditorTitle, group: GROUP, order: -100, when: CLUSTER_WHEN }]
		});
	}
	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// Open the terminal in the SAME group the button was clicked on (activate it, then ACTIVE_GROUP resolves
		// to it) - not a new/opposite group. A NEW terminal in the EDITOR area running `claude` - the user's shell
		// PATH-resolves the binary. Unlike the extension's "Open in Terminal" (bottom panel), this is an editor tab.
		activateClickedGroup(accessor, args);
		const terminalService = accessor.get(ITerminalService);
		const instance = await terminalService.createTerminal({ location: { viewColumn: ACTIVE_GROUP } });
		await instance.sendText('claude', true);
		await instance.focusWhenReady();
	}
}

export function registerClawdiusEditorTitleActions(): void {
	registerAction2(ClawdiusOpenChatEditorTitleAction);
	registerAction2(ClawdiusNewSessionEditorTitleAction);
	registerAction2(ClawdiusNewTerminalSessionEditorTitleAction);
}
// CLAWDIUS-END
