/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN ultracode workflows view
import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, WindowEnablement } from '../../../../workbench/common/views.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { WORKFLOWS_VIEW_CONTAINER_ID, WORKFLOWS_VIEW_ID } from '../common/workflows.js';
import { WorkflowTranscriptContribution } from './workflowTranscript.js';
import { WorkflowsViewPane, WorkflowsViewPaneContainer } from './workflowsView.js';

const workflowsViewIcon = registerIcon('workflows-view-icon', Codicon.listTree, localize2('workflowsViewIcon', 'View icon for the Ultracode Workflows view.').value);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const workflowsViewContainer = viewContainersRegistry.registerViewContainer({
	id: WORKFLOWS_VIEW_CONTAINER_ID,
	title: localize2('workflows', 'Workflows'),
	icon: workflowsViewIcon,
	order: 11,
	ctorDescriptor: new SyncDescriptor(WorkflowsViewPaneContainer),
	storageId: WORKFLOWS_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	windowEnablement: WindowEnablement.Sessions
}, ViewContainerLocation.AuxiliaryBar);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: WORKFLOWS_VIEW_ID,
	name: localize2('workflows', 'Workflows'),
	containerIcon: workflowsViewIcon,
	ctorDescriptor: new SyncDescriptor(WorkflowsViewPane),
	canToggleVisibility: true,
	canMoveView: false,
	weight: 100,
	order: 1,
	when: IsPhoneLayoutContext.negate(),
	windowEnablement: WindowEnablement.Sessions,
}], workflowsViewContainer);

// Read-only Markdown renderer for sub-agent transcripts (drill-in from a workflow row).
registerWorkbenchContribution2(WorkflowTranscriptContribution.ID, WorkflowTranscriptContribution, WorkbenchPhase.BlockRestore);
// CLAWDIUS-END
