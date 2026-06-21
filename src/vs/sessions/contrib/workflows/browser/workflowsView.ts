/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN ultracode workflows view
// The Ultracode window "Workflows" board: a tree of Claude-native multi-agent workflow runs (root) and
// their sub-agents (children), sourced from the durable WorkflowStore. v1 shows the past-runs lane; the
// live running-workflow lane and per-workflow controls land in follow-up increments.

import './media/workflows.css';
import * as dom from '../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkflowAgent, IWorkflowRun, WorkflowStore } from '../common/workflowStore.js';
import { WORKFLOWS_VIEW_CONTAINER_ID } from '../common/workflows.js';
import { transcriptDocUri } from './workflowTranscript.js';

const $ = dom.$;

type WorkflowNode = { readonly kind: 'run'; readonly run: IWorkflowRun } | { readonly kind: 'agent'; readonly agent: IWorkflowAgent; readonly id: string };

export class WorkflowsViewPaneContainer extends ViewPaneContainer {
	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExtensionService extensionService: IExtensionService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@ILogService logService: ILogService,
	) {
		super(WORKFLOWS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }, instantiationService, configurationService, layoutService, contextMenuService, telemetryService, extensionService, themeService, storageService, contextService, viewDescriptorService, logService);
	}
}

interface IRowTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
}

abstract class AbstractRowRenderer implements ITreeRenderer<WorkflowNode, void, IRowTemplate> {
	abstract readonly templateId: string;

	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = dom.append(container, $('.ultracode-workflow-row'));
		const icon = dom.append(row, $('span.ultracode-workflow-icon'));
		const label = dom.append(row, $('span.ultracode-workflow-label'));
		const detail = dom.append(row, $('span.ultracode-workflow-detail'));
		return { icon, label, detail };
	}

	protected setIcon(template: IRowTemplate, icon: ThemeIcon): void {
		template.icon.className = 'ultracode-workflow-icon ' + ThemeIcon.asClassName(icon);
	}

	abstract renderElement(node: ITreeNode<WorkflowNode, void>, index: number, template: IRowTemplate): void;

	disposeTemplate(template: IRowTemplate): void {
		template.icon.remove();
		template.label.remove();
		template.detail.remove();
	}
}

class RunRowRenderer extends AbstractRowRenderer {
	static readonly TEMPLATE_ID = 'run';
	readonly templateId = RunRowRenderer.TEMPLATE_ID;

	override renderElement(node: ITreeNode<WorkflowNode, void>, _index: number, template: IRowTemplate): void {
		if (node.element.kind !== 'run') {
			return;
		}
		const run = node.element.run;
		this.setIcon(template, statusIcon(run.status));
		template.label.textContent = run.workflowName;
		const bits: string[] = [`${run.agentCount} ${run.agentCount === 1 ? 'agent' : 'agents'}`];
		if (run.durationMs !== undefined) { bits.push(formatDuration(run.durationMs)); }
		if (run.totalTokens !== undefined) { bits.push(`${formatCount(run.totalTokens)} tok`); }
		if (run.defaultModel) { bits.push(run.defaultModel); }
		template.detail.textContent = bits.join(' · ');
	}
}

class AgentRowRenderer extends AbstractRowRenderer {
	static readonly TEMPLATE_ID = 'agent';
	readonly templateId = AgentRowRenderer.TEMPLATE_ID;

	override renderElement(node: ITreeNode<WorkflowNode, void>, _index: number, template: IRowTemplate): void {
		if (node.element.kind !== 'agent') {
			return;
		}
		const agent = node.element.agent;
		this.setIcon(template, agentStateIcon(agent.state));
		template.label.textContent = agent.label;
		const bits: string[] = [];
		if (agent.agentType) { bits.push(agent.agentType); }
		if (agent.tokens !== undefined) { bits.push(`${formatCount(agent.tokens)} tok`); }
		if (agent.toolCalls !== undefined) { bits.push(`${agent.toolCalls} tools`); }
		template.detail.textContent = bits.join(' · ');
	}
}

class WorkflowsDelegate implements IListVirtualDelegate<WorkflowNode> {
	getHeight(): number { return 22; }
	getTemplateId(element: WorkflowNode): string {
		return element.kind === 'run' ? RunRowRenderer.TEMPLATE_ID : AgentRowRenderer.TEMPLATE_ID;
	}
}

class WorkflowsAccessibilityProvider implements IListAccessibilityProvider<WorkflowNode> {
	getWidgetAriaLabel(): string { return localize('ultracode.workflows', "Workflows"); }
	getAriaLabel(element: WorkflowNode): string {
		return element.kind === 'run'
			? localize('ultracode.workflows.runAria', "Workflow {0}, {1}, {2} agents", element.run.workflowName, element.run.status, element.run.agentCount)
			: localize('ultracode.workflows.agentAria', "Agent {0}, {1}", element.agent.label, element.agent.state ?? 'unknown');
	}
}

export class WorkflowsViewPane extends ViewPane {

	private _tree: WorkbenchObjectTree<WorkflowNode, void> | undefined;
	private readonly _workflowStore: WorkflowStore;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ILogService private readonly _logService: ILogService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._workflowStore = this._register(this.instantiationService.createInstance(WorkflowStore));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('ultracode-workflows-view');

		this._tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<WorkflowNode, void>,
			'UltracodeWorkflows',
			container,
			new WorkflowsDelegate(),
			[new RunRowRenderer(), new AgentRowRenderer()],
			{
				horizontalScrolling: false,
				accessibilityProvider: new WorkflowsAccessibilityProvider(),
				identityProvider: { getId: (e: WorkflowNode) => e.kind === 'run' ? `run:${e.run.runId}` : `agent:${e.id}` },
				collapseByDefault: true,
			}
		)) as WorkbenchObjectTree<WorkflowNode, void>;

		this._register(this._tree.onDidOpen(e => {
			if (e.element?.kind === 'agent') {
				this._openTranscript(e.element.agent);
			}
		}));

		this._register(this._workflowStore.onDidChange(() => this._refreshTree()));
		this._workflowStore.refresh().catch(err => this._logService.warn('[Ultracode] workflow refresh failed', err));
	}

	/** Drill into a sub-agent: open its transcript as a read-only, Markdown-rendered document. */
	private _openTranscript(agent: IWorkflowAgent): void {
		if (!agent.transcriptUri) {
			return;
		}
		const shortId = agent.agentId ? agent.agentId.slice(0, 6) : '';
		const label = shortId ? `${agent.label} (${shortId})` : agent.label;
		this._editorService.openEditor({ resource: transcriptDocUri(agent.transcriptUri, label), options: { pinned: false } })
			.catch(err => this._logService.warn('[Ultracode] open transcript failed', err));
	}

	private _refreshTree(): void {
		this._tree?.setChildren(null, this._workflowStore.runs.map(run => ({
			element: { kind: 'run', run } as const,
			collapsed: true,
			children: run.agents.map((agent, i) => ({ element: { kind: 'agent', agent, id: `${run.runId}:${i}:${agent.agentId}` } as const })),
		})));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._tree?.layout(height, width);
	}
}
// CLAWDIUS-END

function statusIcon(status: string): ThemeIcon {
	switch (status) {
		case 'completed': return Codicon.pass;
		case 'failed': case 'error': return Codicon.error;
		case 'running': return ThemeIcon.modify(Codicon.loading, 'spin');
		default: return Codicon.circleOutline;
	}
}

function agentStateIcon(state: string | undefined): ThemeIcon {
	switch (state) {
		case 'done': case 'completed': return Codicon.pass;
		case 'error': case 'failed': return Codicon.error;
		case 'running': return ThemeIcon.modify(Codicon.loading, 'spin');
		case 'queued': return Codicon.circleOutline;
		default: return Codicon.circleSmall;
	}
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) { return `${s}s`; }
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem ? `${m}m ${rem}s` : `${m}m`;
}

function formatCount(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}m`; }
	if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}k`; }
	return `${n}`;
}
