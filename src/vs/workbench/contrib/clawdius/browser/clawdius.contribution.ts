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
import { CLAWDIUS_VIEW_CONTAINER_ID, CLAWDIUS_WORKFLOWS_VIEW_ID } from '../common/clawdius.js';
import { ClawdiusWorkflowsViewPane } from './workflowsViewPane.js';
import { WorkflowTranscriptContribution } from './workflowTranscript.js';
import { ClawdiusPluginSetupContribution } from './clawdiusPluginSetup.js';

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

	// The LEFT Clawdius container hosts workflows / agents / config only - the native Claude chat is the
	// RIGHT-hand (auxiliary-bar) pane, replacing the Copilot chat panel; there is no chat view on the left.
	// Workflows is the sole view for now, pinned so the container is never empty.
	const workflowsView: IViewDescriptor = {
		id: CLAWDIUS_WORKFLOWS_VIEW_ID,
		containerIcon: clawdiusViewIcon,
		name: localize2('clawdius.workflows', "Workflows"),
		ctorDescriptor: new SyncDescriptor(ClawdiusWorkflowsViewPane),
		canToggleVisibility: false,
		canMoveView: false,
		order: 1,
	};

	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([workflowsView], viewContainer);

	// The read-only Markdown transcript drill-in for a workflow sub-agent (clawdius-workflow-transcript: scheme).
	registerWorkbenchContribution2(WorkflowTranscriptContribution.ID, WorkflowTranscriptContribution, WorkbenchPhase.BlockRestore);

	// First run: install + configure the official Claude Code plugin (it owns the visible chat pane).
	registerWorkbenchContribution2(ClawdiusPluginSetupContribution.ID, ClawdiusPluginSetupContribution, WorkbenchPhase.AfterRestored);
}
// CLAWDIUS-END
