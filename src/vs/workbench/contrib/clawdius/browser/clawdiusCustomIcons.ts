/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN custom Claude Code chat / session / terminal icons
// Three bespoke monochrome SVGs (a chat bubble, an editor window, a terminal - each carrying the Claude
// mark in the bottom-right, knocked out of the base shape) registered as ThemeIcons and themed via a CSS
// mask-image so they follow the toolbar foreground in light + dark (see media/clawdiusCustomIcons.css).
//
// registerIcon is idempotent (returns the existing contribution if the id is already registered), which is
// what lets the top-bar toggle (browser/parts/auxiliaryBarActions.ts) and the editor-title "Open Chat"
// override (services/actions/common/menusExtensionPoint.ts) - both in lower layers that cannot import this
// contrib module - safely re-register the SAME ids locally and get the same ThemeIcon. The id STRINGS below
// are therefore a cross-layer contract: keep them identical to the ids used in those two files and to the
// class names in the CSS. The CSS is imported here (loaded once with the clawdius contrib) and styles the
// classes regardless of which layer's registerIcon call ran first.

import './media/clawdiusCustomIcons.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const CLAWDIUS_CHAT_ICON_ID = 'clawdius-claude-code-chat';
export const CLAWDIUS_SESSION_ICON_ID = 'clawdius-claude-code-session';
export const CLAWDIUS_TERMINAL_ICON_ID = 'clawdius-claude-code-terminal';
export const CLAWDIUS_WORKFLOWS_ICON_ID = 'clawdius-claude-code-workflows';

// Fallbacks (shown only if the mask CSS ever fails to load) mirror the base shapes of each SVG.
export const clawdiusChatIcon = registerIcon(CLAWDIUS_CHAT_ICON_ID, Codicon.commentDiscussion, localize('clawdius.icon.chat', "Claude Code chat icon."));
export const clawdiusSessionIcon = registerIcon(CLAWDIUS_SESSION_ICON_ID, Codicon.window, localize('clawdius.icon.session', "Claude Code new-session icon."));
export const clawdiusTerminalIcon = registerIcon(CLAWDIUS_TERMINAL_ICON_ID, Codicon.terminal, localize('clawdius.icon.terminal', "Claude Code terminal-session icon."));
// The Claude Code Ultracode Workflows view: the `layers` codicon (stacked, parallel work) carrying the Claude mark
// knocked into its bottom-right corner - the same composite family as the chat/session/terminal icons above. The
// `layers` fallback also reads as the fan-out of a workflow if the mask CSS ever fails to load.
export const clawdiusWorkflowsIcon = registerIcon(CLAWDIUS_WORKFLOWS_ICON_ID, Codicon.layers, localize('clawdius.icon.workflows', "Claude Code Ultracode Workflows icon."));
// CLAWDIUS-END
