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
