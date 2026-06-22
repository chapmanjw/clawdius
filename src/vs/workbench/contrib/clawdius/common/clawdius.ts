/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native main-IDE clawdius container (Phase 2)
// Stable identifiers for the native "Clawdius" view container and its views in the MAIN workbench. These
// are deliberately NEW ids (NOT the sessions-window `workflows.*` ids) so the main-IDE container and the
// legacy sessions pane never collide while the redesign is mid-flight.

/** The Clawdius activity-bar / sidebar view container in the main workbench. */
export const CLAWDIUS_VIEW_CONTAINER_ID = 'workbench.view.clawdius';

/** The native Workflows view (Ultracode multi-agent runs) inside the Clawdius container. */
export const CLAWDIUS_WORKFLOWS_VIEW_ID = 'workbench.view.clawdius.workflows';
// CLAWDIUS-END

// CLAWDIUS-BEGIN native webview Claude chat (Phase 3)
// The native Claude chat lives in the RIGHT (auxiliary-bar) sidebar - its own container, NOT the left
// Clawdius container (which holds workflows/agents/config). It is a faithful native replica of the official
// Claude Code plugin's webview chat, driven by the agent-host Claude session. New ids, distinct from the
// workbench chat panel ('workbench.panel.chat') so the two never collide while the redesign is mid-flight.

// `clawdiusChat` (one token), NOT `clawdius.chat`, so the right-hand chat container id does not read like
// a child VIEW of the left `workbench.view.clawdius` container (whose views are `workbench.view.clawdius.*`).
/** The right-hand (auxiliary-bar) Clawdius chat view container in the main workbench. */
export const CLAWDIUS_CHAT_VIEW_CONTAINER_ID = 'workbench.view.clawdiusChat';

/** The native Claude chat view (webview SPA) inside the right-hand Clawdius chat container. */
export const CLAWDIUS_CHAT_VIEW_ID = 'workbench.view.clawdiusChat.main';
// CLAWDIUS-END
