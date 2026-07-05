/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native main-IDE clawdius container (Phase 2a)
// Registers a native "Clawdius" sidebar view container in the MAIN workbench, plus an (empty for now)
// Workflows view, ONLY in Clawdius mode (empty entitlementUrl). This is the home that will absorb the
// Ultracode workflows board (ported from the sessions window) and, in later phases, native chat + config
// panes - replacing the separate Agents/Ultracode window. Activity-bar-backed containers use
// `ViewContainerLocation.Sidebar` in this fork (there is no `Activitybar` location).

import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IClawdiusConfigService } from '../common/clawdiusConfig.js';
import { CLAWDIUS_STATUS_BAR_ENABLED_SETTING } from '../common/clawdiusStatusBar.js';
import { ClawdiusConfigStore } from './clawdiusConfigStore.js';
import { ClawdiusEffectiveConfigService, IClawdiusEffectiveConfigService } from './control/clawdiusEffectiveConfigService.js';
import { registerClawdiusConfigActions } from './clawdiusConfigActions.js';
import { ClawdiusPluginSetupContribution, InstallClaudeCodePluginAction } from './clawdiusPluginSetup.js';
// CLAWDIUS-BEGIN load custom Claude Code icon registrations + their mask CSS (chat/session/terminal)
import './clawdiusCustomIcons.js';
import { registerClawdiusEditorTitleActions } from './clawdiusEditorTitleActions.js';
// CLAWDIUS-END
import { ClawdiusMissingPluginStatusEntry } from './clawdiusMissingPluginStatusEntry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { ClaudeUsageStatusEntry } from './usage/claudeUsageStatusEntry.js';
import { ClawdiusPermissionModeStatusEntry, SetPermissionModeAction } from './clawdiusPermissionModeStatusEntry.js';
import { ClawdiusEffortStatusEntry, SetEffortLevelAction } from './clawdiusEffortStatusEntry.js';
import { ClawdiusModelStatusEntry, SetModelAction } from './clawdiusModelStatusEntry.js';
import { ClaudeUsageDashboardEditor } from './usage/claudeUsageDashboardEditor.js';
import { ClaudeUsageDashboardInput } from './usage/claudeUsageDashboardInput.js';
import { OPEN_USAGE_DASHBOARD_COMMAND_ID } from './usage/claudeUsageData.js';
import { ClaudeUsageCapacityRefresh, IClaudeUsageCapacityRefresh } from './usage/claudeUsageCapacityRefresh.js';
import { ClaudeControlCenterEditor } from './control/claudeControlCenterEditor.js';
import { ClaudeControlCenterInput, ControlTab, OPEN_CONTROL_CENTER_COMMAND_ID } from './control/claudeControlCenterInput.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ClawdiusContextBudgetView, CONTEXT_BUDGET_VIEW_CONTAINER_ID, CONTEXT_BUDGET_VIEW_ID } from './clawdiusContextBudgetView.js';
import { ClawdiusContextBudgetStatusEntry, CONTEXT_BUDGET_WARN_TOKENS_SETTING, OpenContextBudgetAction } from './clawdiusContextBudgetStatusEntry.js';
import { LintContextAction } from './clawdiusContextBudgetLint.js';
import { DisableConfirmedLoadsAction, EnableConfirmedLoadsAction } from './clawdiusContextBudgetConfirm.js';
import { ConfigurationScope, Extensions as ConfigExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ClawdiusUpdateService, ClawdiusUpdateStartupContribution, IClawdiusUpdateService } from './update/clawdiusUpdateService.js';
import { CLAWDIUS_DISABLE_ANIMATIONS_SETTING, ClawdiusDisableAnimationsContribution } from './clawdiusDisableAnimations.js';
import { ClawdiusHiddenSettingsContribution } from './clawdiusHiddenSettings.js';

// Singleton dashboard input round-trips with no state (everything is read live from local files on open).
class ClaudeUsageDashboardInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(): EditorInput { return ClaudeUsageDashboardInput.instance; }
}

// Opens (or reveals) the standalone Claude Code usage dashboard editor. The primary usage entry points (the
// status-bar widget + the bottom-left Account button) now open the Control Center's Usage tab instead; this
// remains as a secondary command-palette action ("Open Claude Code Usage Dashboard") that opens the same view
// in its own editor.
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
		const capacityRefresh = accessor.get(IClaudeUsageCapacityRefresh);
		const editorService = accessor.get(IEditorService);
		// A user explicitly opened the dashboard: this is the (sole, allowed) moment to refresh live capacity,
		// so the limits are current before the pane reads the local cache. Restored editors never run this
		// action, so a workbench restore at startup performs no network egress. Best-effort: offline / the
		// extension not yet active just shows the last cached values. Routed by host (local command vs remote REH).
		try {
			await capacityRefresh.refresh(false);
		} catch { /* ignore - the dashboard still renders from cached + local data */ }
		await editorService.openEditor(ClaudeUsageDashboardInput.instance, { pinned: true, revealIfOpened: true });
	}
}

// Singleton Control Center input round-trips with no state (scope + tab are in-pane; data is read live on open).
class ClaudeControlCenterInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(): EditorInput { return ClaudeControlCenterInput.instance; }
}

// Opens (or reveals) the interactive Control Center. An optional first argument selects which tab to land on;
// with none it stays on the editor's default (Usage). The account button + usage status-bar widget pass
// 'usage'; the command palette passes nothing. Other tabs (Permissions, MCP, Skills, ...) are reached from
// the editor's own tab bar once open.
class OpenClaudeControlCenterAction extends Action2 {
	constructor() {
		super({
			id: OPEN_CONTROL_CENTER_COMMAND_ID,
			title: localize2('clawdius.control.openCmd', "Open Claude Code Control Center"),
			category: localize2('clawdius.category', "Clawdius"),
			icon: Codicon.settingsGear,
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor, tab?: ControlTab): Promise<void> {
		// IMPORTANT: resolve services BEFORE the first await (a ServicesAccessor is only valid synchronously).
		const editorService = accessor.get(IEditorService);
		const capacityRefresh = accessor.get(IClaudeUsageCapacityRefresh);
		// Guard the arg: a menu invocation can pass its own context object as the first arg, which must never be
		// mistaken for a tab.
		const target: ControlTab | undefined = typeof tab === 'string' ? tab : undefined;
		// Opening on the Usage tab is a user-initiated moment to refresh live capacity (the sole allowed egress
		// for the usage surface), so the bars are current before the view reads the local cache. This runs only on
		// explicit open - a workbench restore never invokes this action - so startup stays zero-egress.
		if (target === 'usage') {
			try { await capacityRefresh.refresh(false); } catch { /* offline / extension inactive - show cached */ }
		}
		const pane = await editorService.openEditor(ClaudeControlCenterInput.instance, { pinned: true, revealIfOpened: true });
		// Land on the requested tab. Done after open (not via input state) so it also switches an already-open pane.
		if (target && pane instanceof ClaudeControlCenterEditor) { pane.showTab(target); }
	}
}

// "Check for Updates": a NOTIFY-AND-LINK check powered by the GitHub Releases API (IClawdiusUpdateService).
// Clawdius has no auto-update server (product.json sets no updateUrl, so the built-in updater is
// Disabled/MissingConfiguration), so this never downloads or installs: it compares the running version against
// the latest release on the configured channel and, when newer, shows a notification linking to the release.
// The single GitHub request is user-initiated here; the only other trigger is the opt-in startup check
// (`clawdius.update.checkOnStartup`, default false). It lives in the Manage (gear) menu's `7_update` group -
// where the native update item would sit - so the slot is not empty. CLAWDIUS_RELEASES_URL stays exported as
// the release-page link (the service falls back to it if a release object carries no html_url).
export const CLAWDIUS_RELEASES_URL = 'https://github.com/chapmanjw/clawdius/releases';
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
		await accessor.get(IClawdiusUpdateService).checkForUpdates('user');
	}
}

// "Sponsor Clawdius" -> the GitHub Sponsors page. Shown in the Help menu (just above About) and reused by
// the onboarding screens + the title-bar heart link.
export const CLAWDIUS_SPONSOR_URL = 'https://github.com/sponsors/chapmanjw';
class SponsorClawdiusAction extends Action2 {
	constructor() {
		super({
			id: 'clawdius.sponsor',
			title: localize2('clawdius.sponsor', "Sponsor Clawdius"),
			category: localize2('clawdius.category', "Clawdius"),
			icon: Codicon.heart,
			f1: true,
			menu: { id: MenuId.MenubarHelpMenu, group: 'z_about', order: 0 },
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IOpenerService).open(URI.parse(CLAWDIUS_SPONSOR_URL));
	}
}

if (!product.defaultChatAgent?.entitlementUrl) {

	// The shared config service: ONE scan + watcher set produces the typed snapshot the Control Center reads
	// (configService.snapshot) for its Skills / MCP / Hooks / Plugins tabs, and re-renders on its onDidChange.
	registerSingleton(IClawdiusConfigService, ClawdiusConfigStore, InstantiationType.Delayed);

	// The effective-config assembly service: reads every local settings tier for a folder and runs the precedence
	// resolver, for the Control Center's merged EFFECTIVE view.
	registerSingleton(IClawdiusEffectiveConfigService, ClawdiusEffectiveConfigService, InstantiationType.Delayed);

	// Usage-capacity refresh router: sends the single on-demand /api/oauth/usage refresh to the host that owns
	// ~/.claude - the local clawdius-chat command in a local window, the REH server's capacity service in a
	// WSL/SSH remote window - so the usage surfaces' "Refresh" works in remote windows too.
	registerSingleton(IClaudeUsageCapacityRefresh, ClaudeUsageCapacityRefresh, InstantiationType.Delayed);

	// Config-mutation commands (per-section create + delete) the Control Center invokes to scaffold a new skill
	// or hook and to delete a skill. These are programmatic commands (no menu/view surface of their own).
	registerClawdiusConfigActions();

	// Editor-title toolbar cluster next to the Claude Code extension's "Open Chat" button: "New Session" (opens
	// a new Claude chat as an editor tab) and "New Terminal Session" (runs claude in a new editor-area terminal).
	registerClawdiusEditorTitleActions();

	// First run: install + configure the official Claude Code plugin (it owns the visible chat pane). Runs at
	// `Eventually` (idle, a few seconds after restore) so the ~225 MB first-run extension download does not
	// compete with startup.
	registerWorkbenchContribution2(ClawdiusPluginSetupContribution.ID, ClawdiusPluginSetupContribution, WorkbenchPhase.Eventually);

	// Presence safety net: a warning status-bar entry + a command that (re)installs the critical Claude Code
	// plugin when it is missing (a failed first-run install, or a later removal), so a degraded Clawdius is
	// visible and one click from recovery. The Control Center Plugins tab + welcome page read the same presence.
	registerWorkbenchContribution2(ClawdiusMissingPluginStatusEntry.ID, ClawdiusMissingPluginStatusEntry, WorkbenchPhase.BlockRestore);
	registerAction2(InstallClaudeCodePluginAction);

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

	// Model status pill: shows + sets the DEFAULT model for new Claude conversations, backed by the
	// ~/.claude/settings.json `model` key. The list is a union of local, egress-free sources (the live
	// agent-host catalog via ILanguageModelsService + the configured/proxied ids in settings.json/env), so a
	// Bedrock/Vertex/local model shows up; unrecognised ids render name-only. Sits just left of the effort pill.
	registerWorkbenchContribution2(ClawdiusModelStatusEntry.ID, ClawdiusModelStatusEntry, WorkbenchPhase.BlockRestore);
	registerAction2(SetModelAction);

	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ClaudeUsageDashboardEditor, ClaudeUsageDashboardEditor.ID, localize('clawdius.usage.dashboardPane', "Claude Code Usage")),
		[new SyncDescriptor(ClaudeUsageDashboardInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ClaudeUsageDashboardInput.ID, ClaudeUsageDashboardInputSerializer);
	registerAction2(OpenClaudeUsageDashboardAction);

	// Config Control Center - a native DOM editor pane with the Usage / Permissions / MCP / Skills / Plugins /
	// Hooks tabs that edits the selected scope's local config. Opened from the command palette, the account
	// button, and the usage status-bar widget (all via OpenClaudeControlCenterAction).
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ClaudeControlCenterEditor, ClaudeControlCenterEditor.ID, localize('clawdius.control.pane', "Claude Code Control Center")),
		[new SyncDescriptor(ClaudeControlCenterInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ClaudeControlCenterInput.ID, ClaudeControlCenterInputSerializer);
	registerAction2(OpenClaudeControlCenterAction);

	// Context Budget Inspector (N2 2a): a bottom-Panel view answering "what does Claude see for THIS file?"
	// (memories + path-scoped rules + skills, split always-on / on-invoke / not-applied, each with an estimated
	// token cost), plus a status-bar pill showing the always-on total that opens the panel. Reads the shared
	// config snapshot through a pure resolver; no I/O of its own. Token numbers are estimates (chars/4).
	const contextBudgetContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
		id: CONTEXT_BUDGET_VIEW_CONTAINER_ID,
		title: localize2('clawdius.ctxb.container', "Claude Code Context Budget"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CONTEXT_BUDGET_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: Codicon.book,
		order: 6,
	}, ViewContainerLocation.Panel);
	const contextBudgetViews: IViewDescriptor[] = [{
		id: CONTEXT_BUDGET_VIEW_ID,
		name: localize2('clawdius.ctxb.view', "Claude Code Context Budget"),
		ctorDescriptor: new SyncDescriptor(ClawdiusContextBudgetView),
		containerIcon: Codicon.book,
		canToggleVisibility: true,
		canMoveView: true,
	}];
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(contextBudgetViews, contextBudgetContainer);
	registerWorkbenchContribution2(ClawdiusContextBudgetStatusEntry.ID, ClawdiusContextBudgetStatusEntry, WorkbenchPhase.BlockRestore);
	registerAction2(OpenContextBudgetAction);
	registerAction2(LintContextAction);
	registerAction2(EnableConfirmedLoadsAction);
	registerAction2(DisableConfirmedLoadsAction);
	// Default update channel is derived from THIS build: a prerelease build (version tagged -alpha/-beta/-rc)
	// defaults to the prerelease channel so testers keep getting prereleases; a stable build defaults to stable.
	const isPrereleaseBuild = /-(alpha|beta|rc)/i.test(product.version || '');
	Registry.as<IConfigurationRegistry>(ConfigExtensions.Configuration).registerConfiguration({
		id: 'clawdius',
		order: 100,
		title: localize('clawdius.configTitle', "Clawdius"),
		type: 'object',
		properties: {
			[CONTEXT_BUDGET_WARN_TOKENS_SETTING]: {
				type: 'number',
				default: 8000,
				minimum: 0,
				scope: ConfigurationScope.RESOURCE,
				description: localize('clawdius.warnTokens.desc', "The estimated always-on token total (memory + rules + skill menu) above which the Claude Context Budget status item turns a warning color. Set to 0 to disable."),
			},
			'clawdius.update.channel': {
				type: 'string',
				enum: ['stable', 'prerelease'],
				default: isPrereleaseBuild ? 'prerelease' : 'stable',
				scope: ConfigurationScope.APPLICATION,
				enumDescriptions: [
					localize('clawdius.update.channel.stable', "Only stable releases."),
					localize('clawdius.update.channel.prerelease', "Pre-release and stable releases."),
				],
				description: localize('clawdius.update.channel.desc', "Which Clawdius release channel to check for updates."),
			},
			'clawdius.update.checkOnStartup': {
				type: 'boolean',
				default: false,
				scope: ConfigurationScope.APPLICATION,
				description: localize('clawdius.update.checkOnStartup.desc', "Automatically check for Clawdius updates on startup. Off by default; when on, Clawdius makes a single GitHub request at launch to compare your version against the latest release."),
			},
			[CLAWDIUS_DISABLE_ANIMATIONS_SETTING]: {
				type: 'boolean',
				default: false,
				scope: ConfigurationScope.APPLICATION,
				title: localize('clawdius.disableAnimations.title', "Disable Animations"),
				description: localize('clawdius.disableAnimations.desc', "Turn off Clawdius's animated brand art. When on, the empty-editor welcome art and the Control Center tab-header mark show the static Clawd artwork (the same stills used for high-contrast themes) instead of the animated versions."),
			},
			[CLAWDIUS_STATUS_BAR_ENABLED_SETTING]: {
				type: 'boolean',
				default: true,
				scope: ConfigurationScope.APPLICATION,
				title: localize('clawdius.statusBar.enabled.title', "Status Bar Widgets"),
				description: localize('clawdius.statusBar.enabled.desc', "Show Clawdius's Claude Code status-bar widgets (effort level, model, permission mode, context budget, and usage). Turn this off to hide them all. The prompt to install the Claude Code plugin is always shown regardless of this setting."),
			},
		},
	});

	// Keeps the `clawdius-disable-animations` class on the workbench container(s) in sync with the setting, so the
	// empty-editor letterpress swaps to its static high-contrast art (see clawdiusDisableAnimations.css). Registered
	// at BlockRestore so the class is present before the empty editor first paints.
	registerWorkbenchContribution2(ClawdiusDisableAnimationsContribution.ID, ClawdiusDisableAnimationsContribution, WorkbenchPhase.BlockRestore);

	// Hide the handful of upstream chat settings whose only UI surface Clawdius suppresses (the built-in
	// chat sign-in / setup chrome + the CLI entries in the session pickers), so the Settings editor
	// lists only settings that can actually do something in Clawdius mode. They still work if set in settings.json -
	// included:false removes them from the Settings UI + schema, not the value. Gated on Clawdius mode by this block,
	// so a non-Clawdius (entitlementUrl present) build leaves every one of them visible.
	registerWorkbenchContribution2(ClawdiusHiddenSettingsContribution.ID, ClawdiusHiddenSettingsContribution, WorkbenchPhase.BlockRestore);

	// "Check for Updates" via the GitHub Releases API (notify-and-link only - no auto-download/install). The
	// service holds the single on-demand GitHub request; the startup contribution is the ONLY automatic trigger
	// and fires solely when `clawdius.update.checkOnStartup` is enabled (default false), so launch stays
	// zero-egress out of the box. Registered at Eventually so the opt-in check never competes with startup.
	registerSingleton(IClawdiusUpdateService, ClawdiusUpdateService, InstantiationType.Delayed);
	registerWorkbenchContribution2(ClawdiusUpdateStartupContribution.ID, ClawdiusUpdateStartupContribution, WorkbenchPhase.Eventually);
	// Manage-gear "Check for Updates..." -> runs the GitHub-releases check (user-initiated).
	registerAction2(ClawdiusCheckForUpdatesAction);

	// "Sponsor Clawdius" in the Help menu, just above About.
	registerAction2(SponsorClawdiusAction);
}
// CLAWDIUS-END
