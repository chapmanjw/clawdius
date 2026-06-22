/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native main-IDE clawdius container (Phase 2a)
// Registers a native "Clawdius" sidebar view container in the MAIN workbench, plus an (empty for now)
// Workflows view, ONLY in Clawdius mode (empty entitlementUrl). This is the home that will absorb the
// Ultracode workflows board (ported from the sessions window) and, in later phases, native chat + config
// panes - replacing the separate Agents/Ultracode window. Activity-bar-backed containers use
// `ViewContainerLocation.Sidebar` in this fork (there is no `Activitybar` location).

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CLAWDIUS_CHAT_VIEW_ID, CLAWDIUS_VIEW_CONTAINER_ID, CLAWDIUS_WORKFLOWS_VIEW_ID } from '../common/clawdius.js';
import { ClawdiusChatViewPane } from './clawdiusChatViewPane.js';
import { ClawdiusWorkflowsViewPane } from './workflowsViewPane.js';
import { WorkflowTranscriptContribution } from './workflowTranscript.js';

if (!product.defaultChatAgent?.entitlementUrl) {

	const clawdiusViewIcon = registerIcon('clawdius-view-icon', Codicon.claude, localize('clawdiusViewIcon', "Icon for the Clawdius view container."));

	const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
		id: CLAWDIUS_VIEW_CONTAINER_ID,
		title: localize2('clawdius', "Clawdius"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CLAWDIUS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: clawdiusViewIcon,
		order: 6,
	}, ViewContainerLocation.Sidebar);

	// Chat is the container's primary view: pinned (a user can't hide the main surface). The Phase 3a
	// placeholder body is harmless until Phase 3b embeds the interactive ChatWidget.
	const chatView: IViewDescriptor = {
		id: CLAWDIUS_CHAT_VIEW_ID,
		containerIcon: clawdiusViewIcon,
		name: localize2('clawdius.chat', "Chat"),
		ctorDescriptor: new SyncDescriptor(ClawdiusChatViewPane),
		canToggleVisibility: false,
		canMoveView: false,
		order: 0,
	};

	// Now that the container has a second view, Workflows is a normal toggleable view (kept in-container).
	const workflowsView: IViewDescriptor = {
		id: CLAWDIUS_WORKFLOWS_VIEW_ID,
		containerIcon: clawdiusViewIcon,
		name: localize2('clawdius.workflows', "Workflows"),
		ctorDescriptor: new SyncDescriptor(ClawdiusWorkflowsViewPane),
		canToggleVisibility: true,
		canMoveView: false,
		order: 1,
	};

	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([chatView, workflowsView], viewContainer);

	// The read-only Markdown transcript drill-in for a workflow sub-agent (clawdius-workflow-transcript: scheme).
	registerWorkbenchContribution2(WorkflowTranscriptContribution.ID, WorkflowTranscriptContribution, WorkbenchPhase.BlockRestore);
}
// CLAWDIUS-END
