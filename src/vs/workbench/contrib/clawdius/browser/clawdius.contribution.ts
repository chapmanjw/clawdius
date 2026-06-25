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

import { localize, localize2 } from '../../../../nls.js';
import { FileAccess } from '../../../../base/common/network.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CLAWDIUS_VIEW_CONTAINER_ID } from '../common/clawdius.js';
import {
	ConfigSection, CONFIG_SECTIONS, IClawdiusConfigService, sectionCreateLabel, sectionDescription, sectionLabel, sectionViewId,
} from '../common/clawdiusConfig.js';
import { ClawdiusConfigSectionViewPane } from './clawdiusConfigViewPane.js';
import { ClawdiusConfigStore } from './clawdiusConfigStore.js';
import { configCreateCommandId, registerClawdiusConfigActions } from './clawdiusConfigActions.js';
import { ClawdiusPluginSetupContribution } from './clawdiusPluginSetup.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { ClaudeUsageStatusEntry } from './usage/claudeUsageStatusEntry.js';
import { ClawdiusPermissionModeStatusEntry, SetPermissionModeAction } from './clawdiusPermissionModeStatusEntry.js';
import { ClawdiusEffortStatusEntry, SetEffortLevelAction } from './clawdiusEffortStatusEntry.js';
import { ClaudeUsageDashboardEditor } from './usage/claudeUsageDashboardEditor.js';
import { ClaudeUsageDashboardInput } from './usage/claudeUsageDashboardInput.js';
import { OPEN_USAGE_DASHBOARD_COMMAND_ID, REFRESH_CAPACITY_COMMAND_ID } from './usage/claudeUsageData.js';

// Singleton dashboard input round-trips with no state (everything is read live from local files on open).
class ClaudeUsageDashboardInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(): EditorInput { return ClaudeUsageDashboardInput.instance; }
}

// Opens (or reveals) the Claude Code usage dashboard. Invoked from the status-bar usage indicator, the
// bottom-left Account button, and the command palette.
class OpenClaudeUsageDashboardAction extends Action2 {
	constructor() {
		super({
			id: OPEN_USAGE_DASHBOARD_COMMAND_ID,
			title: localize2('clawdius.usage.openDashboardCmd', "Open Claude Code Usage Dashboard"),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		// IMPORTANT: a ServicesAccessor is only valid synchronously during this call; resolve every service
		// BEFORE the first await (after an await, accessor.get throws "service accessor is only valid...").
		const commandService = accessor.get(ICommandService);
		const editorService = accessor.get(IEditorService);
		// A user explicitly opened the dashboard: this is the (sole, allowed) moment to refresh live capacity,
		// so the limits are current before the pane reads the local cache. Restored editors never run this
		// action, so a workbench restore at startup performs no network egress. Best-effort: offline / the
		// extension not yet active just shows the last cached values.
		try {
			await commandService.executeCommand(REFRESH_CAPACITY_COMMAND_ID);
		} catch { /* ignore - the dashboard still renders from cached + local data */ }
		await editorService.openEditor(ClaudeUsageDashboardInput.instance, { pinned: true, revealIfOpened: true });
	}
}

// Lightweight "Check for Updates": Clawdius has no auto-update server yet (product.json sets no updateUrl, so
// the built-in updater is Disabled/MissingConfiguration), so this opens the GitHub releases page where testers
// download the latest build. It lives in the Manage (gear) menu's `7_update` group - where the native update
// item would sit - so the slot is not empty. Replace with the real IUpdateService flow once an update server +
// signed release pipeline exist (see clawdius-private-docs release plan).
const CLAWDIUS_RELEASES_URL = 'https://github.com/chapmanjw/clawdius/releases';
class ClawdiusCheckForUpdatesAction extends Action2 {
	constructor() {
		super({
			id: 'clawdius.checkForUpdates',
			title: localize2('clawdius.checkForUpdates', "Check for Updates..."),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
			menu: { id: MenuId.GlobalActivity, group: '7_update', order: 1 },
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IOpenerService).open(URI.parse(CLAWDIUS_RELEASES_URL));
	}
}

if (!product.defaultChatAgent?.entitlementUrl) {

	// The left-side "Claude Code Config" activity-bar container: a tree manager for the user's Claude Code
	// configuration (memories, agents, skills, commands, plugins, MCP, hooks, permissions) across the Global
	// (~/.claude) and Project (.claude) scopes. The activity-bar icon is the Clawdius logo (a URI, masked by
	// the activity bar) so it is visually distinct from the official Claude Code plugin's pane (Claude mark).
	const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
		id: CLAWDIUS_VIEW_CONTAINER_ID,
		title: localize2('clawdiusConfig', "Claude Code Config"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CLAWDIUS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: FileAccess.asBrowserUri('vs/workbench/contrib/clawdius/browser/media/clawdius-logo.svg'),
		order: 6,
	}, ViewContainerLocation.Sidebar);

	// The shared config service: ONE scan + watcher set feeds all eight section views.
	registerSingleton(IClawdiusConfigService, ClawdiusConfigStore, InstantiationType.Delayed);

	// One collapsible view per section (the Kiro-style grouped manager). The settings-backed sections
	// (hooks / permissions / MCP / plugins) start collapsed to keep the activity pane compact.
	const collapsedByDefault = new Set<ConfigSection>([ConfigSection.Hooks, ConfigSection.Permissions, ConfigSection.Mcp, ConfigSection.Plugins]);
	const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
	const sectionViews: IViewDescriptor[] = CONFIG_SECTIONS.map((section, index) => ({
		id: sectionViewId(section),
		name: { value: sectionLabel(section), original: sectionLabel(section) },
		ctorDescriptor: new SyncDescriptor(ClawdiusConfigSectionViewPane),
		canToggleVisibility: true,
		canMoveView: false,
		collapsed: collapsedByDefault.has(section),
		order: index + 1,
	}));
	viewsRegistry.registerViews(sectionViews, viewContainer);

	// Empty-state welcome for each section: a one-line description + a primary "Create" button.
	for (const section of CONFIG_SECTIONS) {
		viewsRegistry.registerViewWelcomeContent(sectionViewId(section), {
			content: `${sectionDescription(section)}\n[${sectionCreateLabel(section)}](command:${configCreateCommandId(section)})`,
		});
	}

	// Create (per section) + delete + refresh commands, surfaced in each view title + welcome + context menu.
	registerClawdiusConfigActions();

	// First run: install + configure the official Claude Code plugin (it owns the visible chat pane). Runs at
	// `Eventually` (idle, a few seconds after restore) so the ~225 MB first-run extension download does not
	// compete with startup.
	registerWorkbenchContribution2(ClawdiusPluginSetupContribution.ID, ClawdiusPluginSetupContribution, WorkbenchPhase.Eventually);

	// Claude Code usage: the status-bar indicator (logo + inline session bar) + hover popup, and the full
	// usage dashboard editor it opens (also reachable from the bottom-left Account button). All data is the
	// user's own local files; the only network egress is the user-initiated /api/oauth/usage refresh.
	registerWorkbenchContribution2(ClaudeUsageStatusEntry.ID, ClaudeUsageStatusEntry, WorkbenchPhase.BlockRestore);

	// Permission-mode status pill (N3-3a): shows + sets the DEFAULT permission mode for new Claude
	// conversations (claudeCode.initialPermissionMode), named exactly as the CLI and color-coded by risk.
	// It is a default control, not a live-session mirror - the plugin does not expose the live mode (see file).
	registerWorkbenchContribution2(ClawdiusPermissionModeStatusEntry.ID, ClawdiusPermissionModeStatusEntry, WorkbenchPhase.BlockRestore);
	registerAction2(SetPermissionModeAction);

	// Effort-level status pill (N3-3d): shows + sets the DEFAULT effort for new Claude conversations, backed by
	// ~/.claude/settings.json (effortLevel + the ultracode flag) - the same file the plugin's chat selector uses.
	registerWorkbenchContribution2(ClawdiusEffortStatusEntry.ID, ClawdiusEffortStatusEntry, WorkbenchPhase.BlockRestore);
	registerAction2(SetEffortLevelAction);

	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ClaudeUsageDashboardEditor, ClaudeUsageDashboardEditor.ID, localize('clawdius.usage.dashboardPane', "Claude Code Usage")),
		[new SyncDescriptor(ClaudeUsageDashboardInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ClaudeUsageDashboardInput.ID, ClaudeUsageDashboardInputSerializer);
	registerAction2(OpenClaudeUsageDashboardAction);

	// Manage-gear "Check for Updates..." -> opens the Clawdius releases page (no auto-update server yet).
	registerAction2(ClawdiusCheckForUpdatesAction);
}
// CLAWDIUS-END
