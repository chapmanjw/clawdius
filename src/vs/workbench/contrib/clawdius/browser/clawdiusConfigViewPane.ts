/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Config section view pane
// One collapsible view per config section (memories, commands, skills, sub-agents, hooks, permissions, MCP,
// plugins). Each pane renders only its own section, grouped by scope: Global first, then one group per project
// workspace folder. Activating a leaf opens the underlying local file (read from disk; no network). The shared
// IClawdiusConfigService does the scanning + watching; every pane subscribes to its onDidChange.

import './media/clawdiusConfig.css';
import { $, append } from '../../../../base/browser/dom.js';
import { IAction, toAction } from '../../../../base/common/actions.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { ITreeContextMenuEvent, ITreeElement, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CONFIG_DELETE_COMMAND_ID } from './clawdiusConfigActions.js';
import {
	ConfigScope, ConfigSection, IClawdiusConfigService, IConfigItem, IConfigScopeGroup, sectionFromViewId,
} from '../common/clawdiusConfig.js';

type ConfigNode =
	| { readonly kind: 'scope'; readonly group: IConfigScopeGroup; readonly count: number }
	| { readonly kind: 'item'; readonly item: IConfigItem };

/** Codicon id used for an item row in a given section. */
function itemIconId(item: IConfigItem): string {
	switch (item.section) {
		case ConfigSection.Agents: return 'account';
		case ConfigSection.Skills: return 'lightbulb';
		case ConfigSection.Commands: return 'terminal';
		case ConfigSection.Plugins: return 'plug';
		case ConfigSection.Mcp: return 'server-process';
		case ConfigSection.Hooks: return 'symbol-event';
		case ConfigSection.Permissions: return 'circle-small-filled';
		case ConfigSection.Memories: return item.children ? 'book' : 'symbol-string';
	}
}

interface IRowTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly description: HTMLElement;
}

class ConfigDelegate implements IListVirtualDelegate<ConfigNode> {
	getHeight(): number { return 22; }
	getTemplateId(): string { return 'clawdius-config-row'; }
}

class ConfigRenderer implements ITreeRenderer<ConfigNode, void, IRowTemplate> {
	readonly templateId = 'clawdius-config-row';

	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = append(container, $('.clawdius-config-row'));
		const icon = append(row, $('span.clawdius-config-icon.codicon'));
		const label = append(row, $('span.clawdius-config-label'));
		const description = append(row, $('span.clawdius-config-desc'));
		return { icon, label, description };
	}

	renderElement(node: ITreeNode<ConfigNode, void>, _index: number, tpl: IRowTemplate): void {
		const el = node.element;
		tpl.icon.className = 'clawdius-config-icon codicon';
		tpl.icon.style.color = '';
		tpl.description.classList.remove('muted');

		let iconId: string;
		let label: string;
		let description = '';
		if (el.kind === 'scope') {
			iconId = el.group.scope === ConfigScope.Global ? 'globe' : 'folder';
			label = el.group.scope === ConfigScope.Global
				? localize('clawdius.config.global', "Global")
				: (el.group.folderName ?? localize('clawdius.config.project', "Project"));
			description = String(el.count);
			tpl.description.classList.add('muted');
		} else {
			iconId = itemIconId(el.item);
			label = el.item.label;
			description = el.item.description ?? '';
			tpl.description.classList.add('muted');
			if (el.item.color) { tpl.icon.style.color = el.item.color; }
		}
		tpl.icon.classList.add(`codicon-${iconId}`);
		tpl.label.textContent = label;
		tpl.label.title = label;
		tpl.description.textContent = description;
	}

	disposeTemplate(): void { /* nothing to dispose */ }
}

class ConfigAccessibilityProvider implements IListAccessibilityProvider<ConfigNode> {
	getWidgetAriaLabel(): string { return localize('clawdius.config.tree', "Claude Code Config"); }
	getAriaLabel(el: ConfigNode): string {
		if (el.kind === 'scope') {
			const name = el.group.scope === ConfigScope.Global
				? localize('clawdius.config.global', "Global")
				: (el.group.folderName ?? localize('clawdius.config.project', "Project"));
			return `${name}, ${el.count}`;
		}
		return el.item.label;
	}
}

/** A single config section rendered as its own collapsible view, grouped by scope. */
export class ClawdiusConfigSectionViewPane extends ViewPane {

	private readonly section: ConfigSection;
	private tree: WorkbenchObjectTree<ConfigNode, void> | undefined;

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
		@ILogService private readonly logService: ILogService,
		@IEditorService private readonly editorService: IEditorService,
		@IClawdiusConfigService private readonly configService: IClawdiusConfigService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.section = sectionFromViewId(options.id) ?? ConfigSection.Memories;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('clawdius-config-view');

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<ConfigNode, void>,
			'ClawdiusConfigSection',
			container,
			new ConfigDelegate(),
			[new ConfigRenderer()],
			{
				horizontalScrolling: false,
				accessibilityProvider: new ConfigAccessibilityProvider(),
				identityProvider: { getId: (e: ConfigNode) => e.kind === 'scope' ? `scope:${e.group.key}` : `item:${e.item.id}` },
				collapseByDefault: false,
			},
		)) as WorkbenchObjectTree<ConfigNode, void>;

		this._register(this.tree.onDidOpen(e => {
			if (e.element?.kind === 'item' && e.element.item.resource) {
				this.openItem(e.element.item);
			}
		}));
		this._register(this.tree.onContextMenu(e => this.onContextMenu(e)));

		this._register(this.configService.onDidChange(() => this.refreshTree()));
		this.refreshTree();
		this.configService.refresh().catch(err => this.logService.warn('[Clawdius] config refresh failed', err));
	}

	private onContextMenu(e: ITreeContextMenuEvent<ConfigNode | null>): void {
		const node = e.element;
		if (!node || node.kind !== 'item') { return; }
		const item = node.item;
		const actions: IAction[] = [];
		if (item.resource) {
			actions.push(toAction({ id: 'clawdius.config.open', label: localize('clawdius.config.open', "Open"), run: () => this.openItem(item) }));
		}
		if (item.canDelete) {
			actions.push(toAction({ id: CONFIG_DELETE_COMMAND_ID, label: localize('clawdius.config.delete', "Delete"), run: () => void this.commandService.executeCommand(CONFIG_DELETE_COMMAND_ID, item) }));
		}
		if (actions.length === 0) { return; }
		this.contextMenuService.showContextMenu({ getAnchor: () => e.anchor, getActions: () => actions });
	}

	private openItem(item: IConfigItem): void {
		const selection = item.reveal ? { startLineNumber: item.reveal.lineNumber, startColumn: item.reveal.column ?? 1, endLineNumber: item.reveal.lineNumber, endColumn: item.reveal.column ?? 1 } : undefined;
		this.editorService.openEditor({ resource: item.resource, options: { pinned: false, selection, revealIfOpened: true } })
			.catch(err => this.logService.warn('[Clawdius] open config item failed', err));
	}

	private refreshTree(): void {
		if (!this.tree) { return; }
		// One group per scope that has at least one item in THIS section. Empty section -> empty tree -> the
		// registered view-welcome (the "Create" button) takes over. When only one group is present (e.g. Global
		// with no workspace open), flatten it so items show directly without a redundant scope header.
		const groups = this.configService.snapshot.scopes
			.map(group => ({ group, items: group.sections.find(s => s.section === this.section)?.items ?? [] }))
			.filter(g => g.items.length > 0);

		let elements: ITreeElement<ConfigNode>[];
		if (groups.length <= 1) {
			elements = (groups[0]?.items ?? []).map(item => this.toElement(item));
		} else {
			elements = groups.map(({ group, items }) => ({
				element: { kind: 'scope', group, count: items.length },
				collapsed: false,
				children: items.map(item => this.toElement(item)),
			}));
		}
		this.tree.setChildren(null, elements);
	}

	private toElement(item: IConfigItem): ITreeElement<ConfigNode> {
		return {
			element: { kind: 'item', item },
			collapsed: true,
			children: (item.children ?? []).map(child => this.toElement(child)),
		};
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}
}
// CLAWDIUS-END
