/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Control Center editor pane (Permissions tab, MVP)
// A native DOM editor pane (no webview => zero-egress) that turns the Permissions config from an inert index
// into an interactive control surface. Two parts:
//   - Default mode for new conversations: the SAME control as the status-bar permission pill - it reuses the
//     pill's mode list (labels/descriptions/icons/tones) and writes the SAME setting
//     (claudeCode.initialPermissionMode, plus the bypass gate), so changing it here updates the pill and vice
//     versa (both re-render on the config change). This is a global plugin setting, not scope-specific.
//   - Permission rules: the scoped allow/ask/deny lists in the chosen settings.json (Global / Project /
//     Project-local), edited via IJSONEditingService. Every rule action is race-safe: the user's INTENT is
//     resolved against a FRESH read at apply time (claudeControlCenterData.planPermissionIntent), never a
//     stale render-time snapshot.
// Visual language mirrors the Claude Code Usage dashboard (monospace base, clawd hero mark, "> SECTION" block
// titles, brand-orange accents). Tabs share one pane shell + one scope selector over the same settings.json;
// `this.tab` dispatches the body. All six tabs (Usage, Permissions, MCP, Skills, Plugins, Hooks) are built;
// some advanced editors (e.g. full hook add/edit forms) are still incremental. Per-tab parse/write logic lives in pure models (claudePermissionsModel,
// claudeControlTabsModel) so the pane only does file IO, IJSONEditingService.write, and DOM.

import './media/claudeControlCenter.css';
import { $ as h, addDisposableListener, append, clearNode, Dimension, EventType, size } from '../../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IJSONEditingService } from '../../../../services/configuration/common/jsonEditing.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IClaudeMcpTool, IClaudeMcpToolDiscoveryResult } from '../../../../../platform/agentHost/common/claudeMcpToolDiscovery.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ITerminalService, ITerminalGroupService } from '../../../terminal/browser/terminal.js';
import { ConfigScope, ConfigSection, IClawdiusConfigService, IConfigItem } from '../../common/clawdiusConfig.js';
import { IClawdiusEffectiveConfigService, IEffectiveConfigResult } from './clawdiusEffectiveConfigService.js';
import { IResolvedSetting, JsonValue, SettingsTier, isManagedTier } from '../../common/clawdiusEffectiveConfig.js';
import { previewWrite } from '../../common/clawdiusPreflight.js';
import { ISandboxConfig, SandboxNetworkVerdict, SandboxWriteVerdict, checkDomain, checkWrite, parseSandboxConfig } from '../../common/claudeSandbox.js';
import { CONFIG_DELETE_COMMAND_ID, configCreateCommandId } from '../clawdiusConfigActions.js';
import { IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import {
	ALLOW_BYPASS_KEY, INITIAL_PERMISSION_MODE_KEY,
} from '../clawdiusPermissionModeStatusEntry.js';
import { INSTALL_CLAUDE_CODE_PLUGIN_COMMAND_ID, isClaudeCodePluginInstalled } from '../clawdiusPluginSetup.js';
import { CLAWDIUS_DISABLE_ANIMATIONS_SETTING } from '../clawdiusDisableAnimations.js';
import { ClaudeControlCenterInput, ControlTab } from './claudeControlCenterInput.js';
import { ClaudeUsageDashboardView } from '../usage/claudeUsageDashboardView.js';
import { IClaudeUsageCapacityRefresh } from '../usage/claudeUsageCapacityRefresh.js';
import { BUILTIN_TOOLS, IJsonWrite, IPermissionsState, PERMISSION_BUCKETS, PermissionBucket, PermissionDefaultMode, additionalDirectoriesWrite, builtinRule, defaultModeWrite, mcpToolRule, parsePermissions, parseRule } from './claudePermissionsModel.js';
import {
	ControlScope, PermissionIntent, classifySettings, invertIntent, planPermissionIntent, resolvePermissionsSettingsUri,
} from './claudeControlCenterData.js';
import {
	ISkillsState, PluginState, SkillOverride, disableAllHooksWrite, disableBundledSkillsWrite, parseDisableAllHooks, parseSkills, pluginEnabledWrite, skillOverrideWrite,
} from './claudeControlTabsModel.js';
import {
	ICatalogPlugin, IInstalledPlugin, IMarketplace, MARKETPLACE_NAME_RE, parseInstalledPlugins, parseKnownMarketplaces, parseMarketplaceCatalog,
} from './claudePluginsModel.js';
import { ISkillIssue, ISkillValidation, validateSkillPackage } from './claudeSkillValidationModel.js';
import {
	IMcpDefSummary, IMcpServerForm, MCP_TRANSPORTS, McpApproval, McpTransport, buildMcpDef, emptyMcpForm, enableAllProjectMcpServersWrite, mcpApproval,
	mcpApprovalWrites, mcpDeleteWrite, mcpEffectiveApproval, mergeMcpDefForSave, parseMcpDefForEdit, parseMcpSettings, sameMcpDefSummary, summarizeMcpDef, transportSupportsOauth,
} from './claudeMcpModel.js';
import { basename, isEqual, isEqualOrParent } from '../../../../../base/common/resources.js';
import { parse as parseJsonc } from '../../../../../base/common/jsonc.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

type Snapshot =
	| { readonly kind: 'ok'; readonly uri: URI; readonly settings: Record<string, unknown> }
	| { readonly kind: 'malformed'; readonly uri: URI }
	| { readonly kind: 'unavailable' };

interface IScopeMeta { readonly scope: ControlScope; readonly label: string; readonly hint: string; readonly file: string }
interface IBucketMeta { readonly bucket: PermissionBucket; readonly label: string }
/** One row in the Skills tab: a skill name, its origins, and the backing config item(s) for Open / Delete. */
interface ISkillRow { readonly name: string; readonly description?: string; readonly origins: string[]; readonly items: IConfigItem[] }
/** A file inside an expanded skill package (the skill folder + one level into its subdirectories). */
interface ISkillFileEntry { readonly name: string; readonly resource: URI; readonly isDirectory: boolean; readonly relPath: string; readonly isSkillMd: boolean }
/** A valid `plugin-id@marketplace-id` (no shell metacharacters, so it is safe to put in a terminal command). */
export const PLUGIN_ID_RE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/;
type BtnVariant = 'primary' | 'ghost' | 'link' | 'danger' | 'add';

/** True when every OAuth sub-field on the form is blank (so the OAuth section starts collapsed on edit). */
function isOauthFormBlank(oauth: IMcpServerForm['oauth']): boolean {
	return oauth.clientId.trim().length === 0 && oauth.callbackPort.trim().length === 0
		&& oauth.scopes.trim().length === 0 && oauth.authServerMetadataUrl.trim().length === 0;
}

// CLAWDIUS-BEGIN extracted security guards (pure, exported for unit tests)
// These guards sit on the path to the user's terminal and to ~/.claude settings.json, so they are lifted out of
// their async call sites into pure, exported functions: same checks, no IO, independently testable. The methods
// below call these and behave identically.

/** Shell metacharacters that must never reach a staged `claude ...` terminal command: command chaining (; & |),
 *  substitution (` $ ( )), redirection (< >), quotes, and newlines. A github owner/repo, an https/git URL, or a
 *  filesystem path (incl. Windows backslashes + spaces) uses none of these. */
const MARKETPLACE_SOURCE_UNSAFE_RE = /[;&|`$()<>"'\r\n]/;

/** True when `source` is safe to interpolate into `claude plugin marketplace add <source>`: non-empty once
 *  trimmed, and free of shell metacharacters. */
export function isSafeMarketplaceSource(source: string): boolean {
	const trimmed = source.trim();
	return trimmed.length > 0 && !MARKETPLACE_SOURCE_UNSAFE_RE.test(trimmed);
}

/** Characters that are NOT allowed in an `mcpServers[<name>]` key (anything outside letters, digits, '_', '.', '-'). */
const MCP_SERVER_NAME_UNSAFE_RE = /[^a-zA-Z0-9_.-]/;

/** True when `name` is a safe `mcpServers` key: non-empty and only letters, digits, '_', '.', '-'. */
export function isSafeMcpServerName(name: string): boolean {
	return name.length > 0 && !MCP_SERVER_NAME_UNSAFE_RE.test(name);
}

/** Why a proposed new skill-package file name was rejected (selects the matching toast). */
export type NewSkillFileNameError = 'badName' | 'skillMdReserved';

/** Validate a new supporting-file name for a skill package. Rejects empty, path separators, traversal (`..`), a
 *  bare `.`, and (only at the package root, `target === ''`) a case-insensitive `skill.md` collision with the
 *  manifest. `name` is expected already trimmed (as the form provides it). */
export function validateNewSkillFileName(name: string, target: string): { readonly ok: boolean; readonly reason?: NewSkillFileNameError } {
	if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name === '.') {
		return { ok: false, reason: 'badName' };
	}
	if (target === '' && name.toLowerCase() === 'skill.md') {
		return { ok: false, reason: 'skillMdReserved' };
	}
	return { ok: true };
}

/** True when a skill-package file may be deleted: a real file (not a directory, not the SKILL.md manifest) that
 *  lives strictly inside the skill folder. URI-aware containment so a sibling-prefix path like `skills/foo-bar`
 *  is never treated as inside `skills/foo`. */
export function canDeleteSkillFile(file: URI, folder: URI, isDirectory: boolean, isSkillMd: boolean): boolean {
	return !isDirectory && !isSkillMd && isEqualOrParent(file, folder) && !isEqual(file, folder);
}
// CLAWDIUS-END

/** The six documented `permissions.defaultMode` values, with a label/icon/tone for the scope-aware default-mode
 *  control. Deliberately distinct from the FOUR-value global session-start pill (clawdiusPermissionModeStatusEntry):
 *  same words, different key - which is the conflation this control exists to defuse. */
const DEFAULT_MODE_INFOS: readonly { value: PermissionDefaultMode; label: string; detail: string; icon: ThemeIcon; tone: 'none' | 'safe' | 'warn' | 'danger' }[] = [
	{ value: 'default', label: localize('clawdius.control.dm.default', "Default"), detail: localize('clawdius.control.dm.default.d', "Ask for approval before each edit or command."), icon: Codicon.shield, tone: 'none' },
	{ value: 'acceptEdits', label: localize('clawdius.control.dm.accept', "Accept edits"), detail: localize('clawdius.control.dm.accept.d', "Apply file edits without asking; still ask before running commands."), icon: Codicon.edit, tone: 'warn' },
	{ value: 'plan', label: localize('clawdius.control.dm.plan', "Plan"), detail: localize('clawdius.control.dm.plan.d', "Explore and present a plan before making any changes."), icon: Codicon.eye, tone: 'safe' },
	{ value: 'auto', label: localize('clawdius.control.dm.auto', "Auto"), detail: localize('clawdius.control.dm.auto.d', "Proceed automatically wherever the permission rules already allow it."), icon: Codicon.play, tone: 'warn' },
	{ value: 'dontAsk', label: localize('clawdius.control.dm.dontAsk', "Don't ask"), detail: localize('clawdius.control.dm.dontAsk.d', "Do not prompt for approvals in this scope."), icon: Codicon.circleSlash, tone: 'danger' },
	{ value: 'bypassPermissions', label: localize('clawdius.control.dm.bypass', "Bypass"), detail: localize('clawdius.control.dm.bypass.d', "Skip all approval prompts, including for potentially dangerous commands."), icon: Codicon.zap, tone: 'danger' },
];

/** A short label for a sandbox preflight verdict. */
function sandboxVerdictLabel(v: SandboxNetworkVerdict | SandboxWriteVerdict): string {
	switch (v) {
		case 'allowed': return localize('clawdius.sbx.v.allowed', "Allowed");
		case 'denied': return localize('clawdius.sbx.v.denied', "Denied");
		case 'prompt': return localize('clawdius.sbx.v.prompt', "Would prompt");
		case 'sandbox-off': return localize('clawdius.sbx.v.off', "Sandbox off");
	}
}

/** The CSS tone class for a sandbox preflight verdict badge. */
function sandboxVerdictTone(v: SandboxNetworkVerdict | SandboxWriteVerdict): string {
	switch (v) {
		case 'allowed': return 'sbx-allowed';
		case 'denied': return 'sbx-denied';
		case 'prompt': return 'sbx-prompt';
		case 'sandbox-off': return 'muted';
	}
}

/** Map a Control Center scope to the effective-config source tier it writes (for preflighting a scoped write). */
function scopeToTier(scope: ControlScope): SettingsTier {
	switch (scope) {
		case 'global': return SettingsTier.User;
		case 'project': return SettingsTier.Project;
		case 'projectLocal': return SettingsTier.ProjectLocal;
	}
}

/** A short display label for each effective-config source tier (highest precedence first). */
function effectiveTierLabel(tier: SettingsTier): string {
	switch (tier) {
		case SettingsTier.PolicyHelper: return localize('clawdius.eff.tier.policy', "Policy helper");
		case SettingsTier.ServerManaged: return localize('clawdius.eff.tier.server', "Server-managed");
		case SettingsTier.MdmRegistry: return localize('clawdius.eff.tier.mdm', "MDM registry");
		case SettingsTier.ManagedFile: return localize('clawdius.eff.tier.managed', "Managed file");
		case SettingsTier.HkcuRegistry: return localize('clawdius.eff.tier.hkcu', "User registry");
		case SettingsTier.ProjectLocal: return localize('clawdius.eff.tier.local', "Project-local");
		case SettingsTier.Project: return localize('clawdius.eff.tier.project', "Project");
		case SettingsTier.User: return localize('clawdius.eff.tier.user', "User");
	}
}

export class ClaudeControlCenterEditor extends EditorPane {

	static readonly ID = 'workbench.editor.clawdiusControlCenter';

	private container!: HTMLElement;
	private content: HTMLElement | undefined;
	private readonly renderStore = this._register(new DisposableStore());
	/** Active toasts, oldest first. Each is its OWN store so a rapid second action never eats a prior toast's
	 *  Undo (the self-clobber bug); each dismisses on its own 5s timer or when its Undo is clicked. Capped so a
	 *  burst of quick actions (commitAdd is optimised for rapid multi-add) can't pile up unbounded. */
	private static readonly MAX_TOASTS = 3;
	private readonly toasts: DisposableStore[] = [];
	/** Active search text for the current scope-aware tab (Permissions rules, Skills, MCP tools, Hooks); reset on
	 *  tab switch. `filterInput` is the live input, re-set each render so the input handler can restore focus + caret. */
	private filter = '';
	private filterInput: HTMLInputElement | undefined;
	/** The resolved effective configuration for the current folder + a monotonic token so a stale async resolve
	 *  never overwrites a newer one. Loaded lazily when the Effective tab is first shown. */
	private effectiveResult: IEffectiveConfigResult | undefined;
	private effectiveToken = 0;
	private effectiveLoading = false;
	/** A TERMINAL error state for the Effective resolve: while set, the tab shows the error + a Retry button and
	 *  does NOT auto-reload, so a persistent failure can never loop into a render->load->fail->render storm. */
	private effectiveError: string | undefined;

	private scope: ControlScope = 'global';
	private tab: ControlTab = 'usage';
	private snapshot: Snapshot | undefined;
	/** The Usage tab hosts the shared usage dashboard view; kept alive only while that tab is showing. */
	private readonly usageView = this._register(new MutableDisposable<ClaudeUsageDashboardView>());

	// Skills tab package state (keyed by the skill folder fsPath). Caches are cleared on a config change; the
	// generation counter bumps on every clear so a slower in-flight read never writes a stale result back.
	private expandedSkill: string | undefined;
	/** Plugin names whose skill group is collapsed on the Skills tab (default: expanded). */
	private readonly collapsedSkillPlugins = new Set<string>();
	private cacheGeneration = 0;
	private isPaneDisposed = false;
	private readonly skillValidations = new Map<string, ISkillValidation>();
	private readonly skillValidating = new Set<string>();
	private readonly skillFiles = new Map<string, readonly ISkillFileEntry[]>();
	private readonly skillFilesLoading = new Set<string>();
	/** Expanded subdirectories in an expanded skill's file tree, keyed by directory fsPath. Default: collapsed. */
	private readonly expandedSkillDirs = new Set<string>();
	/** Marketplaces the user has expanded in the Browse list (collapsed by default; a search auto-expands matches). */
	private readonly expandedMarketplaces = new Set<string>();
	private skillFileForm: { folderPath: string; target: string; name: string } | undefined;

	// MCP tab state. Defs (read from the backing JSON) are keyed by row id (scope::name); discovered tools are
	// keyed by server name (discovery targets Claude's effective runtime server). Caches share cacheGeneration.
	private expandedMcpServer: string | undefined;
	private readonly mcpDefs = new Map<string, IMcpDefSummary>();
	private mcpDefsLoaded = false;
	private readonly mcpTabTools = new Map<string, { loading: boolean; tools: readonly IClaudeMcpTool[]; message: string }>();
	/** An open add / edit MCP server form. `mode` is 'add' (new server, name editable) or 'edit' (existing server,
	 *  name locked). `form` holds every applicable def field; `transport` inside it drives which fields apply.
	 *  `oauthOpen` controls the collapsible OAuth subsection. Secret env / header VALUES are never prefilled. */
	private mcpForm: { scope: 'global' | 'project'; mode: 'add' | 'edit'; name: string; form: IMcpServerForm; oauthOpen: boolean } | undefined;
	/** The DOM root of the open add / edit MCP form, and a store for ONLY its listeners. The form re-renders its own
	 *  subtree in place for routine edits (transport change, add / remove a repeater row, OAuth toggle) instead of
	 *  re-rendering the whole pane, which would re-scan settings.json and rebuild every tab just to add one input row.
	 *  The store is cleared on each subtree rebuild (and by the full render, which rebuilds the form too), so its
	 *  listeners never leak or double-bind. */
	private mcpFormContainer: HTMLElement | undefined;
	private readonly mcpFormStore = this._register(new DisposableStore());
	/** The resolved writable backing JSON for each scope (global = ~/.claude.json, project = <folder>/.mcp.json).
	 *  Edit / delete are offered only for servers whose backing resource matches the writable file for its scope. */
	private mcpWritableGlobal: URI | undefined;
	private mcpWritableProject: URI | undefined;
	/** An open "add plugin" form on the Plugins tab. */
	private pluginAddForm: { id: string } | undefined;
	/** The installed-plugin row whose bundled-contents panel is expanded (keyed by plugin id; default collapsed). */
	private expandedPlugin: string | undefined;
	/** Plugins-tab local data (marketplaces + merged catalog + installed list), loaded lazily from
	 *  ~/.claude/plugins. Cleared on a config change; reloads on the next render. */
	private pluginsData: { marketplaces: IMarketplace[]; catalog: ICatalogPlugin[]; installed: IInstalledPlugin[] } | undefined;
	private pluginsLoaded = false;
	/** The Browse-plugins search box (case-insensitive substring over name / description / marketplace). */
	private pluginFilter = '';
	/** Live reference to the current Browse search input, re-set on each render so the filter handler can restore
	 *  focus + caret after the synchronous re-render replaces the element (avoids a fragile querySelector). */
	private pluginSearchInput: HTMLInputElement | undefined;
	/** The Add-marketplace input value (a github owner/repo, URL, or local path; not shape-restricted). */
	private addMarketplaceValue = '';
	/** Whether the Installed-plugins "Add plugin" panel (add by id + browse marketplaces) is revealed. */
	private pluginAddOpen = false;
	/** Whether the Marketplaces "Add marketplace" input is revealed. */
	private marketplaceAddOpen = false;
	/**
	 * An open inline add-rule editor. Three modes (codex classification): 'builtin' = a Claude built-in tool
	 * (dropdown + optional specifier); 'mcp' = an MCP server tool (server dropdown + (All tools) / specific
	 * tool); 'raw' = a free-text rule (escape hatch).
	 */
	private adding: {
		bucket: PermissionBucket;
		mode: 'builtin' | 'mcp' | 'raw';
		builtinTool: string;
		builtinSpec: string;
		server: string;
		mcpSelect: string; // '' = (All tools); '__other' = type a name; '__load' = run discovery; or a real tool name
		mcpTool: string;
		mcpLoading: boolean;
		mcpLoadedServer: string;            // server the loaded tools belong to ('' = none loaded)
		mcpLoadedTools: readonly IClaudeMcpTool[];
		mcpLoadMessage: string;             // status/error from the last load ('' = none)
		text: string;
	} | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IJSONEditingService private readonly jsonEditing: IJSONEditingService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IClawdiusConfigService private readonly configService: IClawdiusConfigService,
		@IClawdiusEffectiveConfigService private readonly effectiveConfigService: IClawdiusEffectiveConfigService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
		@ICommandService private readonly commandService: ICommandService,
		@IClaudeUsageCapacityRefresh private readonly capacityRefresh: IClaudeUsageCapacityRefresh,
		@IDialogService private readonly dialogService: IDialogService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(ClaudeControlCenterEditor.ID, group, telemetryService, themeService, storageService);
		// Dispose any toasts still on screen when the pane closes (each toast owns its DOM + timer + Undo listener).
		this._register(toDisposable(() => { for (const s of this.toasts.splice(0)) { s.dispose(); } }));
		// Re-render when the default-mode setting changes anywhere (e.g. the status-bar pill), so the two stay
		// in lockstep. Cheap: only the mode segment reads from config; the buckets come from the snapshot.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(INITIAL_PERMISSION_MODE_KEY) || e.affectsConfiguration(ALLOW_BYPASS_KEY)) {
				this.render();
			}
			// The tab-header mark swaps between the animated and static Clawd art on this setting; re-render so
			// every tab's hero picks up the change live.
			if (e.affectsConfiguration(CLAWDIUS_DISABLE_ANIMATIONS_SETTING)) {
				this.render();
			}
		}));
		// The Trust tab mirrors VS Code workspace trust; re-render it live when the trust decision flips.
		this._register(this.trustService.onDidChangeTrust(() => {
			if (this.tab === 'trust') { this.render(); }
		}));
		// Refresh when the scanned config changes: the MCP add box's server dropdown, or the Skills list. A skill
		// folder may have changed on disk, so drop the per-skill validation + file caches (they re-read lazily).
		this._register(this.configService.onDidChange(() => {
			// Any scanned-config change can affect the lazy per-row caches (skills SKILL.md + files, MCP defs +
			// discovered tools), and we can't tell from the event which files changed - so drop them all
			// unconditionally and bump the generation so an in-flight read can't write a stale result back. This
			// runs regardless of the active tab (e.g. editing .mcp.json while on another tab must not leave stale
			// MCP defs behind).
			this.cacheGeneration++;
			this.skillValidations.clear();
			this.skillValidating.clear();
			this.skillFiles.clear();
			this.skillFilesLoading.clear();
			this.expandedSkillDirs.clear();
			this.mcpDefs.clear();
			this.mcpDefsLoaded = false;
			// A marketplace add / update / remove or a plugin install lands as new files under ~/.claude/plugins;
			// drop the cached plugins data so the next render re-reads it.
			this.pluginsData = undefined;
			this.pluginsLoaded = false;
			// The merged EFFECTIVE view caches its resolved result; drop it (+ any error) so a settings edit anywhere
			// re-resolves fresh - a stale "truth" view is worse than a brief reload.
			this.effectiveResult = undefined;
			this.effectiveError = undefined;
			// Do NOT clear discovered tools here. Discovery RUNS the server (the spawn touches ~/.claude), which the
			// config watcher catches and turns into a benign onDidChange - clearing here would make a freshly loaded
			// tool list vanish a moment after it appears. The cached tools for a server are dropped only when that
			// server's def actually changes (see ensureMcpDefs, which re-reads defs and prunes the matching tools).
			if (this.adding?.mode === 'mcp' || this.tab === 'skills' || this.tab === 'plugins' || this.tab === 'mcp' || this.tab === 'hooks' || this.tab === 'effective') { this.render(); }
		}));
		// The Plugins tab leads with a "plugin missing" banner; re-render it when the critical plugin is installed
		// or removed so the banner appears / disappears live. Presence is read from the installed-on-disk list.
		this._register(this.extensionsWorkbenchService.onChange(() => {
			if (this.tab === 'plugins') { this.render(); }
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, h('.clawdius-control'));
		this.container.tabIndex = -1;
	}

	override async setInput(input: ClaudeControlCenterInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.load();
		// Populate the scanned-config snapshot (MCP server names for the add box). Fire-and-forget: onDidChange
		// re-renders the add box if it is open. No network - a local ~/.claude scan.
		void this.configService.refresh();
		void this.resolveMcpWritableUris();
	}

	/** Resolve the writable MCP backing files once (they do not change) so rows can gate Edit / Delete on whether a
	 *  server lives in the writable file for its scope. Re-renders the MCP tab when resolved. */
	private async resolveMcpWritableUris(): Promise<void> {
		const [global, project] = await Promise.all([this.mcpBackingFile('global'), this.mcpBackingFile('project')]);
		if (this.isPaneDisposed) { return; }
		this.mcpWritableGlobal = global;
		this.mcpWritableProject = project;
		if (this.tab === 'mcp') { this.render(); }
	}

	override focus(): void {
		this.container?.focus();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			size(this.container, dimension.width, dimension.height);
		}
	}

	override dispose(): void {
		// Stops late async Skills reads (validation / file lists) from rendering into the torn-down pane.
		this.isPaneDisposed = true;
		super.dispose();
	}

	// --- scope + IO ---

	private async scopeUri(scope: ControlScope): Promise<URI | undefined> {
		const home = await this.pathService.userHome();
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		return resolvePermissionsSettingsUri(scope, home, folder);
	}

	private async readRaw(uri: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(uri)).value.toString();
		} catch {
			return undefined;
		}
	}

	private async load(): Promise<void> {
		const uri = await this.scopeUri(this.scope);
		if (!uri) {
			this.snapshot = { kind: 'unavailable' };
			this.render();
			return;
		}
		const cls = classifySettings(await this.readRaw(uri));
		this.snapshot = cls.kind === 'malformed'
			? { kind: 'malformed', uri }
			: { kind: 'ok', uri, settings: cls.settings };
		this.render();
	}

	/** Resolve a captured rule intent against a FRESH read, then write. Race-safe by construction. `targetUri`
	 *  pins the write to a scope captured at action time, so an Undo issued after a scope switch still lands in
	 *  the original file (it defaults to the current scope for the initial action). */
	private async apply(intent: PermissionIntent, targetUri?: URI): Promise<void> {
		const uri = targetUri ?? await this.scopeUri(this.scope);
		if (!uri) { return; }
		const cls = classifySettings(await this.readRaw(uri));
		if (cls.kind === 'malformed') {
			this.notificationService.error(localize('clawdius.control.malformedWrite', "Can't update permissions: {0} is not valid JSON. Fix the file and try again.", uri.fsPath));
			await this.load();
			return;
		}
		const latest = parsePermissions(cls.settings);
		const plan = planPermissionIntent(latest, intent);
		if (!plan.ok) {
			if (plan.abort === 'stale') {
				this.toast(localize('clawdius.control.stale', "Permissions changed on disk - reloaded. Try again."));
				await this.load();
			} else if (plan.abort === 'invalid') {
				this.toast(localize('clawdius.control.invalid', "Enter a rule first."));
			}
			return;
		}
		try {
			if (cls.needsSeed) {
				await this.fileService.writeFile(uri, VSBuffer.fromString('{}\n'));
			}
			await this.jsonEditing.write(uri, plan.writes.map(w => ({ path: [...w.path], value: w.value })), true);
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.writeFailed', "Could not update permissions: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		const undo = invertIntent(intent, latest);
		void this.configService.refresh(true);
		await this.load();
		this.toast(this.describeRule(intent), undo ? () => void this.apply(undo, uri) : undefined);
		if (intent.type === 'addRule') { void this.warnIfRulesLocked(); }
	}

	/**
	 * Write absolute settings.json keys to a SPECIFIC file (Skills / Plugins / Hooks toggles). Unlike a
	 * permission rule (a relative array mutation that must re-plan against the latest state), these are absolute
	 * key SETS - the user picks a concrete value - so a re-read-then-write is race-safe: we never clobber an
	 * array we computed from a stale render. We still re-read to honour the malformed-file refusal + seed gate.
	 * The uri is captured at the moment of the user action (callers resolve `scopeUri` first), so an Undo - whose
	 * toast can outlive a scope switch - always targets the file it was meant for, not whatever scope the pane
	 * happens to show later.
	 */
	private async writeSettingsAtUri(uri: URI, writes: readonly IJsonWrite[], toastMessage: string, onUndo?: () => void): Promise<void> {
		const cls = classifySettings(await this.readRaw(uri));
		if (cls.kind === 'malformed') {
			this.notificationService.error(localize('clawdius.control.malformedSettings', "Can't save changes: {0} is not valid JSON. Fix the file and try again.", uri.fsPath));
			await this.load();
			return;
		}
		try {
			if (cls.needsSeed) {
				await this.fileService.writeFile(uri, VSBuffer.fromString('{}\n'));
			}
			await this.jsonEditing.write(uri, writes.map(w => ({ path: [...w.path], value: w.value })), true);
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.saveFailed', "Could not save changes: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		void this.configService.refresh(true);
		await this.load();
		this.toast(toastMessage, onUndo);
	}

	private describeRule(intent: PermissionIntent): string {
		switch (intent.type) {
			case 'addRule': return localize('clawdius.control.toast.added', "Added to {0}", intent.bucket);
			case 'removeRule': return localize('clawdius.control.toast.removed', "Removed from {0}", intent.bucket);
			case 'moveRule': return localize('clawdius.control.toast.moved', "Moved to {0}", intent.to);
			case 'setDefaultMode': return localize('clawdius.control.toast.modeGeneric', "Default mode updated");
		}
	}

	// --- rendering ---

	private render(): void {
		if (!this.container || this.isPaneDisposed) { return; }
		this.renderStore.clear();
		// The MCP form owns a separate subtree + listener store for in-place rebuilds. A full render detaches that
		// subtree, so drop its listeners and the stale container here; renderMcpForm rebuilds both if the form is
		// still open (otherwise they stay cleared until the next form opens).
		this.mcpFormStore.clear();
		this.mcpFormContainer = undefined;
		if (!this.content) {
			this.content = append(this.container, h('.clawdius-control-inner'));
		} else {
			clearNode(this.content);
		}
		const inner = this.content;

		this.renderTabs(inner);
		// The Usage tab owns a live dashboard view; free it whenever another tab is showing.
		if (this.tab !== 'usage') { this.usageView.clear(); }
		switch (this.tab) {
			case 'usage': this.renderUsageTab(inner); break;
			case 'permissions': this.renderPermissionsTab(inner); break;
			case 'effective': this.renderEffectiveTab(inner); break;
			case 'sandbox': this.renderSandboxTab(inner); break;
			case 'trust': this.renderTrustTab(inner); break;
			case 'skills': this.renderSkillsTab(inner); break;
			case 'plugins': this.renderPluginsTab(inner); break;
			case 'mcp': this.renderMcpTab(inner); break;
			case 'hooks': this.renderHooksTab(inner); break;
			default: this.renderPermissionsTab(inner); break;
		}
	}

	/** Switch to a tab (used by the open command so account/usage entry points can land on Usage). Usage always
	 *  re-renders - it reloads from the capacity cache, which the open action may have just refreshed - so an
	 *  already-open Usage tab still picks up fresh limits; other tabs only re-render on an actual change. */
	showTab(tab: ControlTab): void {
		if (this.tab !== tab || tab === 'usage') {
			this.tab = tab;
			this.clearTransientForms();
			this.render();
		}
	}

	/** Drop any open inline add/edit forms (permission add box, MCP add/edit server, plugin add) on navigation. */
	private clearTransientForms(): void {
		this.adding = undefined;
		this.mcpForm = undefined;
		this.pluginAddForm = undefined;
		this.pluginAddOpen = false;
		this.marketplaceAddOpen = false;
		this.skillFileForm = undefined;
		this.filter = '';
	}

	private renderTabs(parent: HTMLElement): void {
		// The tablist strip and the Sponsor action share one row, but the sponsor sits OUTSIDE the tablist (a11y:
		// a tablist must contain only tabs). The row carries the underline border so it spans the full width.
		const row = append(parent, h('.clawdius-control-tabs-row'));
		const strip = append(row, h('.clawdius-control-tabs'));
		strip.setAttribute('role', 'tablist');
		const tabs: { readonly tab: ControlTab; readonly label: string; readonly ready: boolean }[] = [
			{ tab: 'usage', label: localize('clawdius.control.tab.usage', "Usage"), ready: true },
			{ tab: 'permissions', label: localize('clawdius.control.tab.permissions', "Permissions"), ready: true },
			{ tab: 'mcp', label: localize('clawdius.control.tab.mcp', "MCP"), ready: true },
			{ tab: 'skills', label: localize('clawdius.control.tab.skills', "Skills"), ready: true },
			{ tab: 'plugins', label: localize('clawdius.control.tab.plugins', "Plugins"), ready: true },
			{ tab: 'hooks', label: localize('clawdius.control.tab.hooks', "Hooks"), ready: true },
			{ tab: 'effective', label: localize('clawdius.control.tab.effective', "Claude Code Settings"), ready: true },
			{ tab: 'sandbox', label: localize('clawdius.control.tab.sandbox', "Sandbox"), ready: true },
			{ tab: 'trust', label: localize('clawdius.control.tab.trust', "Trust"), ready: true },
		];
		for (const def of tabs) {
			if (!def.ready) {
				const t = append(strip, h('button.clawdius-control-tab.soon')) as HTMLButtonElement;
				t.textContent = def.label;
				t.disabled = true;
				t.title = localize('clawdius.control.tab.soonTip', "{0} controls arrive in a later update", def.label);
				append(t, h('span.clawdius-control-soon')).textContent = localize('clawdius.control.soon', "soon");
				continue;
			}
			const btn = append(strip, h('button.clawdius-control-tab')) as HTMLButtonElement;
			btn.textContent = def.label;
			btn.setAttribute('role', 'tab');
			const active = def.tab === this.tab;
			if (active) { btn.classList.add('active'); }
			btn.setAttribute('aria-selected', active ? 'true' : 'false');
			this.renderStore.add(addDisposableListener(btn, EventType.CLICK, () => {
				if (this.tab !== def.tab) { this.tab = def.tab; this.clearTransientForms(); this.render(); }
			}));
		}

		// CLAWDIUS: a right-justified "Sponsor Clawdius" action - a real <button> (keyboard-focusable, Enter/Space
		// activate) OUTSIDE the tablist. Styles live in claudeControlCenter.css.
		const sponsor = append(row, h('button.clawdius-control-sponsor')) as HTMLButtonElement;
		sponsor.title = localize('clawdius.control.sponsorTip', "Sponsor Clawdius (opens in browser)");
		append(sponsor, h('span.codicon.codicon-heart.clawdius-control-sponsor-heart')).setAttribute('aria-hidden', 'true');
		append(sponsor, h('span')).textContent = localize('clawdius.control.sponsor', "Sponsor Clawdius");
		append(sponsor, h('span.codicon.codicon-link-external')).setAttribute('aria-hidden', 'true');
		this.renderStore.add(addDisposableListener(sponsor, EventType.CLICK, () => {
			this.openerService.open(URI.parse('https://github.com/sponsors/chapmanjw'));
		}));
	}

	private renderHero(parent: HTMLElement, title: string, sub: string): void {
		const hero = append(parent, h('.clawdius-control-hero'));
		const mark = append(hero, h('.clawdius-control-hero-mark'));
		// "Disable animations" swaps the animated dance mark for the static Clawd Crab (see the .static CSS rule).
		if (this.configurationService.getValue<boolean>(CLAWDIUS_DISABLE_ANIMATIONS_SETTING) === true) {
			mark.classList.add('static');
		}
		const text = append(hero, h('.clawdius-control-hero-text'));
		append(text, h('.clawdius-control-hero-title')).textContent = title;
		append(text, h('.clawdius-control-hero-sub')).textContent = sub;
	}

	// --- Usage tab ---

	private renderUsageTab(parent: HTMLElement): void {
		// Host the shared usage dashboard view (the same one the standalone Usage editor renders). It draws
		// .clawdius-usage-dashboard-inner into this host and owns its own range tabs + Refresh; we keep it alive
		// while this tab shows and dispose it on tab switch. load() reads only local files (no startup egress).
		const host = append(parent, h('.clawdius-control-usage'));
		const view = new ClaudeUsageDashboardView(host, this.fileService, this.pathService, this.capacityRefresh, this.agentHostService, this.jsonEditing, this.dialogService, this.notificationService, this.quickInputService, this.hoverService);
		this.usageView.value = view;
		void view.load(CancellationToken.None);
	}

	// --- Permissions tab ---

	private renderPermissionsTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.control.heroTitle', "Permissions"),
			localize('clawdius.control.heroSub', "Set how Claude starts new conversations and which actions it may take. Edits your own ~/.claude configuration."));
		this.renderScopedPermissions(parent);
	}

	/** The scope bar plus every section it governs - the scope-aware default mode, the permission rules, and the
	 *  additional working directories - all reading and writing the ONE settings.json the active scope selects. The
	 *  scope bar leads so it visibly owns everything below (defusing the old global-mode-above-scoped-rules trap). */
	private renderScopedPermissions(parent: HTMLElement): void {
		const bar = append(parent, h('.clawdius-control-block'));
		this.renderScopeBar(bar);
		if (this.snapshot?.kind === 'unavailable') {
			append(bar, h('.clawdius-control-empty')).textContent = localize('clawdius.control.noFolder', "Open a folder to edit project permissions. Global permissions are always available.");
			return;
		}
		if (this.snapshot?.kind === 'malformed') {
			this.renderMalformed(bar);
			return;
		}
		if (this.snapshot?.kind === 'ok') {
			const state = parsePermissions(this.snapshot.settings);
			this.renderScopedDefaultMode(parent, state);
			const rules = this.block(parent, localize('clawdius.control.rules', "Permission rules"));
			const setCount = this.renderSearchBox(rules, localize('clawdius.control.rules.search', "Search rules..."));
			let total = 0;
			let shown = 0;
			for (const meta of this.bucketMetas()) {
				total += state[meta.bucket].length;
				shown += this.renderBucket(rules, state, meta);
			}
			setCount(shown, total);
			this.renderAdditionalDirectories(parent, state);
		}
	}

	/** The scope-aware default mode: writes `permissions.defaultMode` into the ACTIVE scope's settings.json - NOT
	 *  the global session-start pill (`claudeCode.initialPermissionMode`), which is a separate setting. Defusing
	 *  that conflation (same words, two keys) is the point; the caption spells it out. */
	private renderScopedDefaultMode(parent: HTMLElement, state: IPermissionsState): void {
		const block = this.block(parent, localize('clawdius.control.defaultMode', "Default mode for new conversations"));
		const seg = append(block, h('.clawdius-control-seg'));
		for (const info of DEFAULT_MODE_INFOS) {
			const m = append(seg, h('button.clawdius-control-mode')) as HTMLButtonElement;
			m.classList.add(`tone-${info.tone}`);
			const active = info.value === state.defaultMode;
			if (active) { m.classList.add('active'); }
			const ico = append(m, h('span.clawdius-control-mode-ico'));
			ico.classList.add(...ThemeIcon.asClassNameArray(info.icon));
			append(m, h('span.clawdius-control-mode-name')).textContent = info.label;
			m.title = info.detail;
			m.setAttribute('aria-label', `${info.label}: ${info.detail}`);
			m.setAttribute('aria-pressed', active ? 'true' : 'false');
			this.renderStore.add(addDisposableListener(m, EventType.CLICK, () => void this.applyScopedDefaultMode(state, info.value)));
		}
		append(block, h('span.clawdius-control-scope-hint')).textContent = localize('clawdius.control.defaultMode.caption',
			"Writes permissions.defaultMode into this scope's settings.json. The session-start default (the status-bar mode pill) is a separate, global setting.");
	}

	private async applyScopedDefaultMode(state: IPermissionsState, mode: PermissionDefaultMode): Promise<void> {
		if (state.defaultMode === mode) { return; }
		const uri = await this.scopeUri(this.scope);
		if (!uri) { return; }
		const prev = state.defaultMode;
		const label = DEFAULT_MODE_INFOS.find(i => i.value === mode)?.label ?? mode;
		await this.writeSettingsAtUri(uri, [defaultModeWrite(mode)],
			localize('clawdius.control.toast.scopedMode', "Default mode set to {0} for this scope", label),
			() => void this.writeSettingsAtUri(uri, [defaultModeWrite(prev)], localize('clawdius.control.toast.modeReverted', "Reverted default mode")));
		void this.warnIfOverridden('permissions.defaultMode', mode);
	}

	/** Preflight a scoped write against the FULL precedence stack and warn if a higher-precedence source (a managed
	 *  policy, a lock, or a higher scope) means the edit will NOT change the value in effect. Advisory + non-blocking:
	 *  the write already happened; this only tells the user their change is being shadowed. */
	private async warnIfOverridden(path: string, value: JsonValue): Promise<void> {
		const targetTier = scopeToTier(this.scope);
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		let result: IEffectiveConfigResult;
		try {
			result = await this.effectiveConfigService.resolve(folder);
		} catch {
			return; // preflight is advisory; never let it surface as a failure
		}
		const preview = previewWrite(result.tiers, targetTier, path, value);
		if (preview.takesEffect) { return; }
		if (preview.provisional) {
			this.notificationService.warn(localize('clawdius.pf.provisional', "A managed policy may override {0}; open the Effective tab to confirm the value in effect.", path));
			return;
		}
		const by = preview.overriddenBy !== undefined ? effectiveTierLabel(preview.overriddenBy) : localize('clawdius.pf.managed', "a higher-precedence source");
		this.notificationService.warn(localize('clawdius.pf.overridden', "{0} is overridden by {1}, so your change does not affect the value in effect. See the Effective tab.", path, by));
	}

	/** After adding a permission rule, warn if a managed lock (allowManagedPermissionRulesOnly) restricts rules to
	 *  the managed allowlist - a rule added in any user-editable scope will not take effect. */
	private async warnIfRulesLocked(): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		let result: IEffectiveConfigResult;
		try {
			result = await this.effectiveConfigService.resolve(folder);
		} catch {
			return;
		}
		if (result.config.activeLocks.includes('allowManagedPermissionRulesOnly')) {
			this.notificationService.warn(localize('clawdius.pf.rulesLocked', "A managed policy restricts permission rules to its own allowlist, so this rule will not take effect. See the Effective tab."));
		}
	}

	/** Additional working directories - the previously DEAD `additionalDirectories` writer, now with a UI: a
	 *  removable row per directory plus an add input, writing `permissions.additionalDirectories` for the scope. */
	private renderAdditionalDirectories(parent: HTMLElement, state: IPermissionsState): void {
		const block = this.block(parent, localize('clawdius.control.dirs', "Additional working directories"));
		const dirs = state.additionalDirectories;
		if (dirs.length === 0) {
			append(block, h('.clawdius-control-emptyrule')).textContent = localize('clawdius.control.dirs.empty', "Claude works in the workspace only. Add a folder to grant access beyond it.");
		}
		for (const dir of dirs) {
			const row = append(block, h('.clawdius-control-rule'));
			row.title = dir;
			append(append(row, h('.clawdius-control-rule-label')), h('span.clawdius-control-chip')).textContent = dir;
			append(row, h('.clawdius-control-spacer'));
			const acts = append(row, h('.clawdius-control-rule-acts'));
			this.iconButton(acts, Codicon.trash, localize('clawdius.control.remove', "Remove"),
				() => void this.applyDirectories(dirs, dirs.filter(d => d !== dir), localize('clawdius.control.dirs.removed', "Removed {0}", dir)), true);
		}
		const addRow = append(block, h('.clawdius-control-addrow'));
		const input = append(addRow, h('input.clawdius-control-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('clawdius.control.dirs.placeholder', "../shared-libs or ~/scratch");
		input.setAttribute('aria-label', localize('clawdius.control.dirs.add', "Add directory"));
		const commit = () => {
			const value = input.value.trim();
			if (!value) { return; }
			if (dirs.includes(value)) { this.toast(localize('clawdius.control.dirs.exists', "That directory is already listed.")); return; }
			void this.applyDirectories(dirs, [...dirs, value], localize('clawdius.control.dirs.added', "Added {0}", value));
		};
		this.renderStore.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.preventDefault(); commit(); }
		}));
		this.button(addRow, localize('clawdius.control.dirs.addBtn', "Add directory"), commit, 'add', Codicon.add);
	}

	private async applyDirectories(prev: ReadonlyArray<string>, next: ReadonlyArray<string>, toastMsg: string): Promise<void> {
		const uri = await this.scopeUri(this.scope);
		if (!uri) { return; }
		await this.writeSettingsAtUri(uri, [additionalDirectoriesWrite(next)], toastMsg,
			() => void this.writeSettingsAtUri(uri, [additionalDirectoriesWrite(prev)], localize('clawdius.control.dirs.reverted', "Reverted directories")));
	}

	/** A shared, case-insensitive search box bound to `this.filter`. Re-renders the tab on input (matching the
	 *  Plugins Browse search) and restores focus + caret from the live `filterInput` ref so typing is uninterrupted.
	 *  Returns a setter for the "N of M shown" count the caller updates after filtering its own list. */
	private renderSearchBox(parent: HTMLElement, placeholder: string): (shown: number, total: number) => void {
		const row = append(parent, h('.clawdius-control-addrow'));
		const input = append(row, h('input.clawdius-control-input.clawdius-control-search')) as HTMLInputElement;
		input.type = 'text';
		input.value = this.filter;
		input.placeholder = placeholder;
		input.setAttribute('aria-label', placeholder);
		this.filterInput = input;
		const count = append(row, h('span.clawdius-control-filter-count'));
		this.renderStore.add(addDisposableListener(input, EventType.INPUT, () => {
			this.filter = input.value;
			const caret = input.selectionStart ?? input.value.length;
			this.render();
			this.filterInput?.focus();
			this.filterInput?.setSelectionRange(caret, caret);
		}));
		return (shown, total) => {
			count.textContent = this.filter.trim() ? localize('clawdius.control.filter.shown', "{0} of {1} shown", shown, total) : '';
		};
	}

	/** True when `text` matches the active search filter (case-insensitive substring; an empty filter matches all). */
	private matchesFilter(text: string): boolean {
		const q = this.filter.trim().toLowerCase();
		return q.length === 0 || text.toLowerCase().includes(q);
	}

	// --- Effective configuration tab (the merged, precedence-resolved view of every setting) ---

	private async loadEffective(): Promise<void> {
		const token = ++this.effectiveToken;
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		try {
			const result = await this.effectiveConfigService.resolve(folder);
			if (token !== this.effectiveToken) { return; }
			this.effectiveResult = result;
			this.effectiveError = undefined;
		} catch (err) {
			if (token !== this.effectiveToken) { return; }
			this.effectiveError = err instanceof Error ? err.message : String(err);
		} finally {
			this.effectiveLoading = false;
			if (this.tab === 'effective') { this.render(); }
		}
	}

	private renderEffectiveTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.eff.heroTitle', "Effective Claude Code Settings"),
			localize('clawdius.eff.heroSub', "The resolved value of every setting across all sources - highest precedence wins. Read-only; edit a value from its own tab or settings.json."));

		// Terminal error state: show the failure + a manual Retry, and do NOT auto-reload (breaks the retry loop).
		if (this.effectiveError !== undefined) {
			const bar = append(parent, h('.clawdius-control-bar'));
			append(bar, h('.clawdius-control-spacer'));
			this.button(bar, localize('clawdius.eff.retry', "Retry"), () => { this.effectiveError = undefined; this.effectiveResult = undefined; this.render(); }, 'ghost', Codicon.refresh);
			append(parent, h('.clawdius-control-empty')).textContent = localize('clawdius.eff.failed', "Could not resolve the effective configuration: {0}", this.effectiveError);
			return;
		}

		const result = this.effectiveResult;
		if (!result) {
			append(parent, h('.clawdius-control-empty')).textContent = localize('clawdius.eff.resolving', "Resolving effective configuration...");
			if (!this.effectiveLoading) { this.effectiveLoading = true; void this.loadEffective(); }
			return;
		}

		const bar = append(parent, h('.clawdius-control-bar'));
		append(bar, h('.clawdius-control-spacer'));
		this.button(bar, localize('clawdius.eff.refresh', "Refresh"), () => { this.effectiveResult = undefined; this.render(); }, 'ghost', Codicon.refresh);

		this.renderEffectiveDiagnostics(parent, result);

		const block = this.block(parent, localize('clawdius.eff.resolved', "Resolved settings"));
		const setCount = this.renderSearchBox(block, localize('clawdius.eff.search', "Search settings..."));
		const all = result.config.settings;
		if (all.length === 0) {
			append(block, h('.clawdius-control-emptyrule')).textContent = localize('clawdius.eff.none', "No settings are configured in any source.");
			setCount(0, 0);
			return;
		}
		let shown = 0;
		for (const s of all) {
			if (!this.matchesFilter(`${s.path} ${this.formatEffectiveValue(s.effective)}`)) { continue; }
			this.renderEffectiveRow(block, s);
			shown++;
		}
		setCount(shown, all.length);
	}

	/** The "not evaluated / malformed / opaque managed" banner, so the resolved values below are never read as a
	 *  complete, definitive picture when a source could not be read. */
	private renderEffectiveDiagnostics(parent: HTMLElement, result: IEffectiveConfigResult): void {
		if (!result.config.managedOpaque && result.diagnostics.length === 0) { return; }
		const block = this.block(parent, localize('clawdius.eff.notes', "Notes"));
		if (result.config.managedOpaque) {
			append(block, h('.clawdius-control-scope-hint')).textContent = localize('clawdius.eff.opaque', "A managed policy is active but its values are hidden (a policyHelper program computes them). The values below are best-effort and marked provisional - the policy may override them.");
		}
		for (const d of result.diagnostics) {
			append(block, h('.clawdius-control-scope-hint')).textContent = d.detail;
		}
	}

	private renderEffectiveRow(parent: HTMLElement, s: IResolvedSetting): void {
		const row = append(parent, h('.clawdius-control-eff-row'));
		const head = append(row, h('.clawdius-control-eff-head'));
		append(head, h('span.clawdius-control-eff-path')).textContent = s.path;
		append(head, h('span.clawdius-control-eff-value')).textContent = this.formatEffectiveValue(s.effective);
		append(head, h('.clawdius-control-spacer'));
		// Winning source (or "Merged" for a deny-first array union that draws from several tiers).
		const tierBadge = append(head, h('span.clawdius-control-eff-tier'));
		if (s.winner !== undefined) {
			tierBadge.textContent = effectiveTierLabel(s.winner);
			if (isManagedTier(s.winner)) { tierBadge.classList.add('managed'); }
		} else {
			tierBadge.textContent = localize('clawdius.eff.merged', "Merged");
		}
		if (s.provisional) {
			const flag = append(head, h('span.clawdius-control-eff-flag.warn'));
			flag.textContent = localize('clawdius.eff.provisional', "Provisional");
			flag.title = localize('clawdius.eff.provisionalTip', "A managed policy is active but unreadable; this value may be overridden.");
		}
		if (s.locked) {
			const flag = append(head, h('span.clawdius-control-eff-flag'));
			flag.textContent = localize('clawdius.eff.locked', "Locked");
			flag.title = localize('clawdius.eff.lockedTip', "A managed lock restricts this key to the managed allowlist.");
		}
		// Shadowed contributions (the non-winning tiers) so "why is it this value" is visible.
		for (const c of s.contributions) {
			if (c.winning) { continue; }
			const line = append(row, h('.clawdius-control-eff-shadow'));
			append(line, h('span.clawdius-control-eff-tier.muted')).textContent = effectiveTierLabel(c.tier);
			append(line, h('span.clawdius-control-eff-shadowval')).textContent = this.formatEffectiveValue(c.value);
		}
	}

	private formatEffectiveValue(value: JsonValue): string {
		return typeof value === 'string' ? value : JSON.stringify(value);
	}

	// --- Sandbox tab (the sandbox.* control surface + a dry-run preflight) ---

	private renderTrustTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.trust.heroTitle', "Workspace Trust"),
			localize('clawdius.trust.heroSub', "Whether Claude can act in this workspace. When it is not trusted the agent is read-only - it can read files, but editing, terminal commands, MCP tools, and web access are blocked. Trusting the workspace grants full access. Backed by VS Code Workspace Trust."));

		const trusted = this.trustService.isWorkspaceTrusted();

		const status = this.block(parent, localize('clawdius.trust.statusTitle', "Status"));
		append(status, h('span.clawdius-control-scope-hint')).textContent = trusted
			? localize('clawdius.trust.isTrusted', "This workspace is trusted - Claude has full access.")
			: localize('clawdius.trust.isUntrusted', "This workspace is not trusted - Claude is read-only. Editing, terminal, MCP, and web tools are blocked until you trust it.");

		const policy = this.block(parent, localize('clawdius.trust.policyTitle', "What trust controls"));
		const yes = localize('clawdius.trust.allowed', "Allowed");
		const no = localize('clawdius.trust.blocked', "Blocked");
		const rows: readonly [string, string][] = [
			[localize('clawdius.trust.reads', "Read files (Read, Grep, Glob)"), localize('clawdius.trust.always', "Always allowed")],
			[localize('clawdius.trust.writes', "Edit files (Write, Edit)"), trusted ? yes : no],
			[localize('clawdius.trust.shell', "Run terminal commands (Bash)"), trusted ? yes : no],
			[localize('clawdius.trust.mcp', "MCP server tools"), trusted ? yes : no],
			[localize('clawdius.trust.web', "Web fetch and search"), trusted ? yes : no],
		];
		for (const [what, verdict] of rows) {
			append(policy, h('span.clawdius-control-scope-hint')).textContent = localize('clawdius.trust.row', "{0}: {1}", what, verdict);
		}

		const actions = this.block(parent, localize('clawdius.trust.manageTitle', "Manage"));
		this.button(actions, localize('clawdius.trust.manageBtn', "Manage Workspace Trust"),
			() => void this.commandService.executeCommand('workbench.trust.manage'));
	}

	private renderSandboxTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.sbx.heroTitle', "Sandbox"),
			localize('clawdius.sbx.heroSub', "The Claude Code sandbox's network allowlist, write scopes, and a dry-run preflight. The kernel enforces the sandbox; this is its control surface. Edits your own ~/.claude configuration."));

		const bar = append(parent, h('.clawdius-control-block'));
		this.renderScopeBar(bar);
		if (this.snapshot?.kind === 'unavailable') {
			append(bar, h('.clawdius-control-empty')).textContent = localize('clawdius.sbx.noFolder', "Open a folder to edit project sandbox config. Global sandbox config is always available.");
			return;
		}
		if (this.snapshot?.kind === 'malformed') { this.renderMalformed(bar); return; }
		if (this.snapshot?.kind !== 'ok') { return; }

		const cfg = parseSandboxConfig(this.snapshot.settings);

		const status = this.block(parent, localize('clawdius.sbx.statusTitle', "Status"));
		const enabledText = cfg.enabled === true ? localize('clawdius.sbx.on', "enabled")
			: cfg.enabled === false ? localize('clawdius.sbx.off', "disabled")
				: localize('clawdius.sbx.default', "not set (platform default)");
		append(status, h('span.clawdius-control-scope-hint')).textContent = localize('clawdius.sbx.enabledIs', "Sandbox: {0} at this scope.", enabledText);
		const flags: string[] = [];
		if (cfg.allowManagedDomainsOnly) { flags.push(localize('clawdius.sbx.netLock', "network: managed allowlist only")); }
		if (cfg.allowManagedReadPathsOnly) { flags.push(localize('clawdius.sbx.readLock', "reads: managed paths only")); }
		if (cfg.allowUnsandboxedCommands === true) { flags.push(localize('clawdius.sbx.escape', "unsandboxed commands allowed")); }
		if (flags.length > 0) { append(status, h('span.clawdius-control-scope-hint')).textContent = flags.join('  ·  '); }

		const domainPh = localize('clawdius.sbx.domainPh', "example.com or *.example.com");
		const pathPh = localize('clawdius.sbx.pathPh', "/absolute/path");
		this.renderSandboxList(parent, localize('clawdius.sbx.allowedDomains', "Allowed domains"), ['sandbox', 'network', 'allowedDomains'], cfg.allowedDomains, localize('clawdius.sbx.noAllowed', "No allowed domains - every destination triggers a first-use prompt."), domainPh);
		this.renderSandboxList(parent, localize('clawdius.sbx.deniedDomains', "Denied domains"), ['sandbox', 'network', 'deniedDomains'], cfg.deniedDomains, localize('clawdius.sbx.noDenied', "No denied domains."), domainPh);
		this.renderSandboxList(parent, localize('clawdius.sbx.allowWrite', "Writable paths"), ['sandbox', 'filesystem', 'allowWrite'], cfg.allowWrite, localize('clawdius.sbx.noWrite', "No extra writable paths - writes are limited to the working directory."), pathPh);
		this.renderSandboxList(parent, localize('clawdius.sbx.denyWrite', "Denied write paths"), ['sandbox', 'filesystem', 'denyWrite'], cfg.denyWrite, localize('clawdius.sbx.noDenyWrite', "No denied write paths."), pathPh);

		this.renderSandboxPreflight(parent, cfg);
	}

	private renderSandboxList(parent: HTMLElement, title: string, path: readonly string[], items: readonly string[], emptyText: string, placeholder: string): void {
		const block = this.block(parent, title);
		if (items.length === 0) {
			append(block, h('.clawdius-control-emptyrule')).textContent = emptyText;
		}
		for (const item of items) {
			const row = append(block, h('.clawdius-control-rule'));
			row.title = item;
			append(append(row, h('.clawdius-control-rule-label')), h('span.clawdius-control-chip')).textContent = item;
			append(row, h('.clawdius-control-spacer'));
			const acts = append(row, h('.clawdius-control-rule-acts'));
			this.iconButton(acts, Codicon.trash, localize('clawdius.control.remove', "Remove"),
				() => void this.applySandboxList(path, items, items.filter(i => i !== item), localize('clawdius.sbx.removed', "Removed {0}", item)), true);
		}
		const addRow = append(block, h('.clawdius-control-addrow'));
		const input = append(addRow, h('input.clawdius-control-input.clawdius-control-search')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = placeholder;
		input.setAttribute('aria-label', localize('clawdius.sbx.addLabel', "Add to {0}", title));
		const commit = () => {
			const value = input.value.trim();
			if (value.length === 0) { return; }
			if (items.includes(value)) { this.toast(localize('clawdius.sbx.exists', "That entry is already listed.")); return; }
			void this.applySandboxList(path, items, [...items, value], localize('clawdius.sbx.added', "Added {0}", value));
		};
		this.renderStore.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }));
		this.button(addRow, localize('clawdius.sbx.add', "Add"), commit, 'add', Codicon.add);
	}

	/** Write a sandbox list (domains / paths) to the active scope, then preflight it: an array write is usually a
	 *  union, but a managed lock (allowManagedDomainsOnly / allowManagedReadPathsOnly) can drop it - reuse the
	 *  effective-config override warning so the user learns the edit is shadowed. */
	private async applySandboxList(path: readonly string[], prev: readonly string[], next: readonly string[], toastMsg: string): Promise<void> {
		const uri = await this.scopeUri(this.scope);
		if (!uri) { return; }
		await this.writeSettingsAtUri(uri, [{ path: [...path], value: [...next] }], toastMsg,
			() => void this.writeSettingsAtUri(uri, [{ path: [...path], value: [...prev] }], localize('clawdius.sbx.reverted', "Reverted")));
		void this.warnIfOverridden(path.join('.'), [...next]);
	}

	/** A live dry-run lane: type a domain or a write path, get the sandbox verdict the kernel would give. */
	private renderSandboxPreflight(parent: HTMLElement, cfg: ISandboxConfig): void {
		const block = this.block(parent, localize('clawdius.sbx.preflightTitle', "Preflight"));
		append(block, h('span.clawdius-control-scope-hint')).textContent = localize('clawdius.sbx.preflightSub', "Dry-run a domain or a write path against the config above - the same check the sandbox makes.");
		const row = append(block, h('.clawdius-control-addrow'));
		const input = append(row, h('input.clawdius-control-input.clawdius-control-search')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('clawdius.sbx.preflightPh', "registry.npmjs.org or /repo/dist");
		input.setAttribute('aria-label', localize('clawdius.sbx.preflightLabel', "Domain or path to check"));
		const verdict = append(row, h('span.clawdius-control-eff-tier'));
		const check = () => {
			const value = input.value.trim();
			if (value.length === 0) { verdict.textContent = ''; verdict.className = 'clawdius-control-eff-tier'; return; }
			const isPath = value.includes('/') || value.includes('\\') || /^[a-zA-Z]:/.test(value);
			const result: SandboxNetworkVerdict | SandboxWriteVerdict = isPath ? checkWrite(cfg, value) : checkDomain(cfg, value);
			verdict.textContent = sandboxVerdictLabel(result);
			verdict.className = `clawdius-control-eff-tier ${sandboxVerdictTone(result)}`;
		};
		this.renderStore.add(addDisposableListener(input, EventType.INPUT, check));
		check();
	}

	/** The shared scope selector (Global / Project / Project-local) + "Open settings.json" + active-file caption.
	 *  Used by every scope-aware tab; switching scope reloads the settings.json the whole pane reads. */
	private renderScopeBar(parent: HTMLElement): void {
		const metas = this.scopeMetas();
		const bar = append(parent, h('.clawdius-control-bar'));
		const scopes = append(bar, h('.clawdius-control-scopes'));
		scopes.setAttribute('role', 'tablist');
		for (const meta of metas) {
			const btn = append(scopes, h('button.clawdius-control-scope')) as HTMLButtonElement;
			btn.textContent = meta.label;
			btn.title = `${meta.hint} (${meta.file})`;
			if (meta.scope === this.scope) { btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); }
			this.renderStore.add(addDisposableListener(btn, EventType.CLICK, () => {
				if (this.scope !== meta.scope) { this.scope = meta.scope; this.adding = undefined; this.filter = ''; void this.load(); }
			}));
		}
		append(bar, h('.clawdius-control-spacer'));
		this.button(bar, localize('clawdius.control.openFile', "Open settings.json"), () => this.openSettings(), 'link');

		// Caption clarifying the active scope (global vs shared vs personal) and the exact file it writes.
		const active = metas.find(m => m.scope === this.scope);
		if (active) {
			const cap = append(parent, h('.clawdius-control-scope-hint'));
			append(cap, h('span')).textContent = active.hint;
			append(cap, h('span.clawdius-control-scope-file')).textContent = active.file;
		}
	}

	/** The shared "this settings.json is not valid JSON - editing disabled" panel. */
	private renderMalformed(parent: HTMLElement): void {
		const box = append(parent, h('.clawdius-control-error'));
		append(box, h('.clawdius-control-error-head')).textContent = localize('clawdius.control.malformedHead', "This settings.json is not valid JSON");
		append(box, h('.clawdius-control-error-body')).textContent = localize('clawdius.control.malformedBody', "Editing is disabled so the file is never clobbered. Open it, fix the JSON, then come back.");
	}

	private renderBucket(parent: HTMLElement, state: IPermissionsState, meta: IBucketMeta): number {
		const rules = state[meta.bucket];
		const bucket = append(parent, h(`.clawdius-control-bucket.bk-${meta.bucket}`));
		const head = append(bucket, h('.clawdius-control-bk-hd'));
		const name = append(head, h('span.clawdius-control-bk-name'));
		append(name, h('span.clawdius-control-bk-ico')).classList.add(...ThemeIcon.asClassNameArray(this.bucketIcon(meta.bucket)));
		append(name, h('span')).textContent = meta.label;
		append(head, h('span.clawdius-control-bk-cnt')).textContent = String(rules.length);
		append(head, h('.clawdius-control-spacer'));
		const addRuleOpen = this.adding?.bucket === meta.bucket;
		this.button(head,
			addRuleOpen ? localize('clawdius.control.cancel', "Cancel") : localize('clawdius.control.addRule', "Add rule"),
			() => {
				this.adding = addRuleOpen ? undefined : { bucket: meta.bucket, mode: 'builtin', builtinTool: '', builtinSpec: '', server: '', mcpSelect: '', mcpTool: '', mcpLoading: false, mcpLoadedServer: '', mcpLoadedTools: [], mcpLoadMessage: '', text: '' };
				this.render();
			},
			addRuleOpen ? 'ghost' : 'add',
			addRuleOpen ? Codicon.close : Codicon.add);

		const matching = rules.filter(r => this.matchesFilter(r));
		if (matching.length === 0 && this.adding?.bucket !== meta.bucket) {
			append(bucket, h('.clawdius-control-emptyrule')).textContent = this.filter.trim()
				? localize('clawdius.control.noMatch', "No matches for \"{0}\".", this.filter.trim())
				: localize('clawdius.control.noRules', "No rules here yet.");
		}
		for (const rule of matching) {
			this.renderRule(bucket, meta.bucket, rule);
		}
		if (this.adding?.bucket === meta.bucket) {
			this.renderAddRow(bucket, meta.bucket);
		}
		return matching.length;
	}

	private renderRule(parent: HTMLElement, bucket: PermissionBucket, rule: string): void {
		const row = append(parent, h('.clawdius-control-rule'));
		row.title = rule; // the exact raw value, for power users
		this.renderRuleChips(append(row, h('.clawdius-control-rule-label')), rule);
		append(row, h('.clawdius-control-spacer'));
		const acts = append(row, h('.clawdius-control-rule-acts'));
		for (const other of PERMISSION_BUCKETS) {
			if (other === bucket) { continue; }
			this.iconButton(acts, this.bucketIcon(other), localize('clawdius.control.moveTo', "Move to {0}", this.bucketLabel(other)), () => this.apply({ type: 'moveRule', from: bucket, to: other, rule }));
		}
		this.iconButton(acts, Codicon.trash, localize('clawdius.control.remove', "Remove"), () => this.apply({ type: 'removeRule', bucket, rule }), true);
	}

	/** Render a rule as friendly chips: MCP server/tool, Tool + pattern, or a bare tool name. */
	private renderRuleChips(parent: HTMLElement, rule: string): void {
		const view = parseRule(rule);
		if (view.kind === 'mcp') {
			append(parent, h('span.clawdius-control-chip.mcp')).textContent = localize('clawdius.control.mcpBadge', "MCP");
			append(parent, h('span.clawdius-control-chip')).textContent = view.primary || '?';
			append(parent, h('span.clawdius-control-rule-detail')).textContent = view.secondary ?? localize('clawdius.control.allTools', "all tools");
		} else if (view.kind === 'tool') {
			append(parent, h('span.clawdius-control-chip')).textContent = view.primary;
			if (view.secondary) { append(parent, h('span.clawdius-control-rule-detail')).textContent = view.secondary; }
		} else {
			append(parent, h('span.clawdius-control-chip')).textContent = view.primary;
		}
	}

	private renderAddRow(parent: HTMLElement, bucket: PermissionBucket): void {
		const a = this.adding;
		if (!a || a.bucket !== bucket) { return; }
		const wrap = append(parent, h('.clawdius-control-addwrap'));

		// Mode selector (codex classification): Claude Tools | MCP Tools | Raw Rule.
		const modes = append(wrap, h('.clawdius-control-addmodes'));
		const modeBtn = (mode: 'builtin' | 'mcp' | 'raw', label: string) => {
			const b = append(modes, h('button.clawdius-control-addmode')) as HTMLButtonElement;
			b.textContent = label;
			if (a.mode === mode) { b.classList.add('active'); }
			this.renderStore.add(addDisposableListener(b, EventType.CLICK, () => { a.mode = mode; this.render(); }));
		};
		modeBtn('builtin', localize('clawdius.control.mode.builtin', "Claude Tools"));
		modeBtn('mcp', localize('clawdius.control.mode.mcp', "MCP Tools"));
		modeBtn('raw', localize('clawdius.control.mode.raw', "Raw Rule"));

		// Live, contextualized preview of the resulting rule (chips, same as a saved rule).
		const preview = append(wrap, h('.clawdius-control-addpreview'));
		const refreshPreview = () => {
			clearNode(preview);
			const v = this.addPreviewRule();
			if (!v) { preview.style.display = 'none'; return; }
			preview.style.display = '';
			append(preview, h('span.clawdius-control-addpreview-label')).textContent = localize('clawdius.control.preview', "Preview");
			this.renderRuleChips(preview, v);
		};

		const row = append(wrap, h('.clawdius-control-addrow'));
		let focusEl: HTMLElement | undefined;
		const commitKeys = (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.preventDefault(); this.commitAdd(); }
			else if (e.key === 'Escape') { e.preventDefault(); this.adding = undefined; this.render(); }
		};

		if (a.mode === 'builtin') {
			const select = append(row, h('select.clawdius-control-select')) as HTMLSelectElement;
			select.setAttribute('aria-label', localize('clawdius.control.builtinTool', "Claude tool"));
			const ph = append(select, h('option')) as HTMLOptionElement;
			ph.value = '';
			ph.textContent = localize('clawdius.control.pickToolOpt', "Select a tool...");
			for (const name of BUILTIN_TOOLS) {
				const opt = append(select, h('option')) as HTMLOptionElement;
				opt.value = name;
				opt.textContent = name;
				if (name === a.builtinTool) { opt.selected = true; }
			}
			this.renderStore.add(addDisposableListener(select, EventType.CHANGE, () => { a.builtinTool = select.value; this.render(); }));

			const spec = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
			spec.type = 'text';
			spec.value = a.builtinSpec;
			spec.placeholder = this.builtinHint(a.builtinTool);
			spec.setAttribute('aria-label', localize('clawdius.control.specifier', "Specifier (optional)"));
			this.renderStore.add(addDisposableListener(spec, EventType.INPUT, () => { a.builtinSpec = spec.value; refreshPreview(); }));
			this.renderStore.add(addDisposableListener(spec, EventType.KEY_DOWN, commitKeys));
			focusEl = a.builtinTool ? spec : select;
		} else if (a.mode === 'mcp') {
			const servers = this.mcpServerNames();
			const serverSel = append(row, h('select.clawdius-control-select')) as HTMLSelectElement;
			serverSel.setAttribute('aria-label', localize('clawdius.control.mcpServer', "MCP server"));
			const sph = append(serverSel, h('option')) as HTMLOptionElement;
			sph.value = '';
			sph.textContent = servers.length > 0 ? localize('clawdius.control.pickServerOpt', "Select a server...") : localize('clawdius.control.noServers', "No MCP servers configured");
			for (const name of servers) {
				const opt = append(serverSel, h('option')) as HTMLOptionElement;
				opt.value = name;
				opt.textContent = name;
				if (name === a.server) { opt.selected = true; }
			}
			serverSel.disabled = servers.length === 0 || a.mcpLoading;
			this.renderStore.add(addDisposableListener(serverSel, EventType.CHANGE, () => {
				a.server = serverSel.value;
				if (a.mcpSelect !== '__other') { a.mcpSelect = ''; } // a loaded-tool selection is server-specific
				this.render();
			}));

			// Tool selector: (All tools), each discovered tool (for THIS server), Specific tool by name..., and
			// Load tool names... (the live discovery action).
			const toolSel = append(row, h('select.clawdius-control-select')) as HTMLSelectElement;
			toolSel.setAttribute('aria-label', localize('clawdius.control.mcpToolSel', "MCP tool"));
			toolSel.disabled = a.mcpLoading;
			const optAll = append(toolSel, h('option')) as HTMLOptionElement;
			optAll.value = '';
			optAll.textContent = localize('clawdius.control.allToolsOpt', "(All tools)");
			const loaded = a.mcpLoadedServer === a.server ? a.mcpLoadedTools : [];
			const optOther = append(toolSel, h('option')) as HTMLOptionElement;
			optOther.value = '__other';
			optOther.textContent = localize('clawdius.control.specificTool', "Specific tool by name...");
			const optLoad = append(toolSel, h('option')) as HTMLOptionElement;
			optLoad.value = '__load';
			optLoad.textContent = loaded.length > 0 ? localize('clawdius.control.reloadTools', "Reload tool names...") : localize('clawdius.control.loadTools', "Load tool names...");
			// The actual tool names list BELOW the action options (under a disabled separator).
			if (loaded.length > 0) {
				const sep = append(toolSel, h('option')) as HTMLOptionElement;
				sep.value = '__sep';
				sep.disabled = true;
				sep.textContent = localize('clawdius.control.toolsHeader', "--- tools ---");
			}
			for (const tool of loaded) {
				const opt = append(toolSel, h('option')) as HTMLOptionElement;
				opt.value = tool.name;
				opt.textContent = tool.name;
			}
			toolSel.value = a.mcpSelect === '__other' ? '__other'
				: (a.mcpSelect && loaded.some(t => t.name === a.mcpSelect)) ? a.mcpSelect
					: '';
			this.renderStore.add(addDisposableListener(toolSel, EventType.CHANGE, () => {
				if (toolSel.value === '__load') {
					void this.loadMcpTools(a.server);
				} else {
					a.mcpSelect = toolSel.value;
					this.render();
				}
			}));

			if (a.mcpSelect === '__other') {
				const toolInput = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
				toolInput.type = 'text';
				toolInput.value = a.mcpTool;
				toolInput.placeholder = localize('clawdius.control.toolNamePlaceholder', "tool name");
				toolInput.setAttribute('aria-label', localize('clawdius.control.mcpTool', "MCP tool"));
				this.renderStore.add(addDisposableListener(toolInput, EventType.INPUT, () => { a.mcpTool = toolInput.value; refreshPreview(); }));
				this.renderStore.add(addDisposableListener(toolInput, EventType.KEY_DOWN, commitKeys));
				focusEl = toolInput;
			} else {
				focusEl = servers.length > 0 ? serverSel : undefined;
			}
		} else {
			const input = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
			input.type = 'text';
			input.value = a.text;
			input.placeholder = localize('clawdius.control.rawPlaceholder', "e.g. Bash(git push:*) or mcp__github__create_issue");
			input.setAttribute('aria-label', localize('clawdius.control.ruleInput', "New {0} rule", bucket));
			this.renderStore.add(addDisposableListener(input, EventType.INPUT, () => { a.text = input.value; refreshPreview(); }));
			this.renderStore.add(addDisposableListener(input, EventType.KEY_DOWN, commitKeys));
			focusEl = input;
		}

		this.button(row, localize('clawdius.control.add', "Add"), () => this.commitAdd(), 'primary');
		this.button(row, localize('clawdius.control.cancel', "Cancel"), () => { this.adding = undefined; this.render(); }, 'ghost');

		if (a.mode === 'mcp') {
			const note = append(wrap, h('.clawdius-control-addnote'));
			if (a.mcpLoading) {
				note.textContent = localize('clawdius.control.mcpLoading', "Connecting to \"{0}\" to load its tools...", a.server);
			} else if (a.mcpLoadMessage) {
				note.textContent = a.mcpLoadMessage;
			} else {
				note.textContent = localize('clawdius.control.mcpToolNote', "Pick (All tools) or a tool by name. \"Load tool names...\" briefly connects to the server (may contact a remote service) to list its tools.");
			}
		}

		refreshPreview();
		const fe = focusEl;
		if (fe) { this.renderStore.add(disposableTimeout(() => fe.focus(), 0)); }
	}

	/** The rule string the open add box would produce right now (for the live preview). */
	private addPreviewRule(): string {
		const a = this.adding;
		if (!a) { return ''; }
		if (a.mode === 'builtin') { return builtinRule(a.builtinTool, a.builtinSpec) ?? ''; }
		if (a.mode === 'mcp') { return mcpToolRule(a.server, this.mcpResolvedTool(a)) ?? ''; }
		return a.text.trim();
	}

	/** Resolve the MCP tool the selector currently targets ('' = all tools on the server). */
	private mcpResolvedTool(a: { mcpSelect: string; mcpTool: string }): string {
		if (a.mcpSelect === '' || a.mcpSelect === '__load') { return ''; }
		return a.mcpSelect === '__other' ? a.mcpTool : a.mcpSelect;
	}

	/** Run live tool discovery for the chosen MCP server (user-initiated; connects to the server). */
	private async loadMcpTools(server: string): Promise<void> {
		const a = this.adding;
		if (!a) { return; }
		if (!server) { this.toast(localize('clawdius.control.pickServerFirst', "Pick an MCP server first.")); a.mcpSelect = ''; this.render(); return; }
		a.mcpLoading = true;
		a.mcpLoadMessage = '';
		a.mcpSelect = '';
		this.render();
		const cwd = (this.workspaceService.getWorkspace().folders[0]?.uri ?? await this.pathService.userHome()).fsPath;
		let result: IClaudeMcpToolDiscoveryResult;
		try {
			result = await this.agentHostService.discoverMcpServerTools(server, cwd);
		} catch (err) {
			result = { status: 'error', tools: [], message: err instanceof Error ? err.message : String(err) };
		}
		// Bail if the add box was closed / replaced (e.g. a rule was committed) while loading.
		if (this.adding !== a) { return; }
		a.mcpLoading = false;
		if (result.status === 'connected') {
			a.mcpLoadedServer = server;
			a.mcpLoadedTools = result.tools;
			a.mcpLoadMessage = result.tools.length > 0
				? localize('clawdius.control.loadedN', "Loaded {0} tool(s) from \"{1}\".", result.tools.length, server)
				: localize('clawdius.control.loadedNone', "\"{0}\" connected but reported no tools.", server);
		} else {
			a.mcpLoadedServer = '';
			a.mcpLoadedTools = [];
			a.mcpLoadMessage = result.message ?? localize('clawdius.control.loadFailed', "Could not load tools ({0}).", result.status);
		}
		this.render();
	}

	private commitAdd(): void {
		const a = this.adding;
		if (!a) { return; }
		let rule: string | undefined;
		if (a.mode === 'builtin') {
			rule = builtinRule(a.builtinTool, a.builtinSpec);
			if (!rule) { this.toast(localize('clawdius.control.pickTool', "Pick a tool first.")); return; }
		} else if (a.mode === 'mcp') {
			rule = mcpToolRule(a.server, this.mcpResolvedTool(a));
			if (!rule) { this.toast(localize('clawdius.control.pickServer', "Pick an MCP server first.")); return; }
		} else {
			rule = a.text.trim();
			if (!rule) { this.toast(localize('clawdius.control.invalid', "Enter a rule first.")); return; }
		}
		// Keep the add box open + reset value fields, preserving the mode + chosen tool/server context (and any
		// loaded MCP tool list) for rapid multi-add.
		this.adding = { bucket: a.bucket, mode: a.mode, builtinTool: a.builtinTool, builtinSpec: '', server: a.server, mcpSelect: a.mcpSelect === '__other' ? '__other' : '', mcpTool: '', mcpLoading: false, mcpLoadedServer: a.mcpLoadedServer, mcpLoadedTools: a.mcpLoadedTools, mcpLoadMessage: a.mcpLoadMessage, text: '' };
		void this.apply({ type: 'addRule', bucket: a.bucket, rule });
	}

	/** A per-tool specifier placeholder for the Claude Tools mode (a hint, not a strict schema). */
	private builtinHint(tool: string): string {
		switch (tool) {
			case 'Bash': return localize('clawdius.control.hint.bash', "git push:*   (blank = any command)");
			case 'Read': case 'Edit': case 'MultiEdit': case 'Write': return localize('clawdius.control.hint.path', "./src/** or ~/.config   (blank = anywhere)");
			case 'WebFetch': return localize('clawdius.control.hint.webfetch', "domain:example.com   (blank = any URL)");
			case 'Glob': case 'Grep': case 'LS': return localize('clawdius.control.hint.pattern', "a path or pattern   (blank = any)");
			case 'Task': return localize('clawdius.control.hint.task', "agent name   (blank = any)");
			case '': return localize('clawdius.control.hint.pickFirst', "specifier (pick a tool first)");
			default: return localize('clawdius.control.hint.generic', "specifier   (blank = all uses)");
		}
	}

	/** Configured MCP server names across all scopes (from the scanned config snapshot), de-duped + sorted. */
	private mcpServerNames(): string[] {
		const names = new Set<string>();
		for (const scope of this.configService.snapshot.scopes) {
			for (const sec of scope.sections) {
				if (sec.section === ConfigSection.Mcp) {
					for (const item of sec.items) { names.add(item.label); }
				}
			}
		}
		return [...names].sort((x, y) => x.localeCompare(y));
	}

	// --- Skills tab ---

	private renderSkillsTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.control.skills.title', "Skills"),
			localize('clawdius.control.skills.sub', "Create skills, open them to edit, and control how each is offered to Claude. Edits your own ~/.claude configuration."));

		const scopeBlock = this.block(parent, localize('clawdius.control.skills.scopeTitle', "Where these changes apply"));
		this.renderScopeBar(scopeBlock);
		if (this.snapshot?.kind === 'malformed') { this.renderMalformed(scopeBlock); return; }

		const settings = this.snapshot?.kind === 'ok' ? this.snapshot.settings : {};
		const state = parseSkills(settings);

		// Bundled-skills kill switch (a global concept, but written per-scope like everything else here).
		const bundled = this.block(parent, localize('clawdius.control.skills.bundledTitle', "Bundled skills & workflows"));
		this.renderToggleRow(bundled,
			localize('clawdius.control.skills.bundledLabel', "Disable bundled skills & workflows"),
			localize('clawdius.control.skills.bundledHint', "Removes the skills and workflows that ship with Claude Code. Your own skills, plugins, and project skills are unaffected."),
			state.disableBundled,
			next => void this.setDisableBundled(next));

		// Your skills: create / open / delete, plus the per-skill access control.
		const block = append(parent, h('.clawdius-control-block'));
		const hd = append(block, h('.clawdius-control-bar'));
		append(hd, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.skills.listTitle', "Your skills");
		append(hd, h('.clawdius-control-spacer'));
		this.button(hd, localize('clawdius.control.skills.new', "New Skill"), () => void this.createSkill(), 'add', Codicon.add);
		const note = append(block, h('.clawdius-control-scope-hint'));
		append(note, h('span')).textContent = localize('clawdius.control.skills.listNote', "Each skill is a folder with a SKILL.md. The control sets how the skill is offered to Claude - it stays on disk either way.");

		const skills = this.collectSkills(state);
		if (skills.length === 0) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.skills.none', "No skills yet. Click New Skill to scaffold one, or add a folder under ~/.claude/skills.");
			return;
		}
		const setCount = this.renderSearchBox(block, localize('clawdius.control.skills.search', "Search skills..."));
		const filtered = skills.filter(s => this.matchesFilter(`${s.name} ${s.description ?? ''}`));
		setCount(filtered.length, skills.length);
		if (filtered.length === 0) {
			append(block, h('.clawdius-control-emptyrule')).textContent = localize('clawdius.control.noMatch', "No matches for \"{0}\".", this.filter.trim());
			return;
		}
		// Validate every on-disk skill's SKILL.md off the paint path; the batch re-renders once for the badges.
		const folders = filtered.map(s => this.representativeSkillItem(s)?.targetResource).filter((u): u is URI => !!u);
		void this.ensureSkillValidations(folders);
		// Standalone skills render flat; plugin-bundled skills are grouped under a collapsible header per plugin.
		const standalone: ISkillRow[] = [];
		const byPlugin = new Map<string, ISkillRow[]>();
		for (const skill of filtered) {
			const pluginOnly = skill.items.length > 0 && skill.items.every(i => !!i.sourcePlugin);
			if (pluginOnly) {
				const plugin = this.representativeSkillItem(skill)?.sourcePlugin ?? skill.items[0].sourcePlugin!;
				const arr = byPlugin.get(plugin);
				if (arr) { arr.push(skill); } else { byPlugin.set(plugin, [skill]); }
			} else {
				standalone.push(skill);
			}
		}
		for (const skill of standalone) {
			this.renderSkillRow(block, skill, state.overrides[skill.name] ?? 'on');
		}
		for (const plugin of [...byPlugin.keys()].sort((a, b) => a.localeCompare(b))) {
			const group = byPlugin.get(plugin)!;
			const collapsed = this.collapsedSkillPlugins.has(plugin);
			const header = append(block, h('.clawdius-control-caprow.clawdius-control-skill-group'));
			const chevron = this.iconButton(header,
				collapsed ? Codicon.chevronRight : Codicon.chevronDown,
				collapsed ? localize('clawdius.control.skills.groupExpand', "Show skills from {0}", plugin) : localize('clawdius.control.skills.groupCollapse', "Hide skills from {0}", plugin),
				() => this.toggleSkillPluginCollapse(plugin));
			chevron.classList.add('clawdius-control-skill-chevron');
			const info = append(header, h('.clawdius-control-cap-info'));
			const nameEl = append(info, h('.clawdius-control-cap-name'));
			append(nameEl, h('span')).textContent = plugin;
			const count = append(nameEl, h('span.clawdius-control-cap-origin'));
			count.classList.add('muted');
			count.textContent = group.length === 1
				? localize('clawdius.control.skills.groupOne', "1 skill")
				: localize('clawdius.control.skills.groupN', "{0} skills", group.length);
			if (!collapsed) {
				const body = append(block, h('.clawdius-control-skill-group-body'));
				for (const skill of group) {
					this.renderSkillRow(body, skill, state.overrides[skill.name] ?? 'on');
				}
			}
		}
	}

	/** Discovered skills (from the scanned config, deduped by name across scopes) plus any override-only names.
	 *  Each row keeps the backing config item(s) so Open / Delete can act on the file on disk. */
	private collectSkills(state: ISkillsState): ISkillRow[] {
		const map = new Map<string, { name: string; description?: string; origins: Set<string>; items: IConfigItem[] }>();
		for (const scope of this.configService.snapshot.scopes) {
			const scopeOrigin = scope.scope === ConfigScope.Global
				? localize('clawdius.control.scope.global', "Global")
				: (scope.folderName ?? localize('clawdius.control.scope.project', "Project (shared)"));
			for (const sec of scope.sections) {
				if (sec.section !== ConfigSection.Skills) { continue; }
				for (const item of sec.items) {
					// Provenance: a plugin-bundled skill shows its source plugin; a standalone skill shows its scope.
					const origin = item.sourcePlugin ?? scopeOrigin;
					const existing = map.get(item.label);
					if (existing) {
						existing.origins.add(origin);
						existing.items.push(item);
						if (!existing.description && item.description) { existing.description = item.description; }
					} else {
						map.set(item.label, { name: item.label, description: item.description, origins: new Set([origin]), items: [item] });
					}
				}
			}
		}
		// Surface override-only keys (e.g. a bundled or plugin skill overridden by name, not present on disk),
		// so an existing override is never hidden from the user. These have no backing item -> no Open / Delete.
		for (const name of Object.keys(state.overrides)) {
			if (!map.has(name)) { map.set(name, { name, description: undefined, origins: new Set(), items: [] }); }
		}
		return [...map.values()]
			.map(s => ({ name: s.name, description: s.description, origins: [...s.origins], items: s.items }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** The skill file to Open / Delete for a row: prefer one in the currently-selected scope, else the first. */
	private representativeSkillItem(skill: ISkillRow): IConfigItem | undefined {
		const wantScope = this.scope === 'global' ? ConfigScope.Global : ConfigScope.Project;
		return skill.items.find(i => i.scope === wantScope) ?? skill.items[0];
	}

	private renderSkillRow(parent: HTMLElement, skill: ISkillRow, current: SkillOverride): void {
		const item = this.representativeSkillItem(skill);
		const folder = item?.targetResource;
		const expanded = !!folder && this.expandedSkill === folder.fsPath;

		const row = append(parent, h('.clawdius-control-caprow'));
		// Expand chevron (on-disk skills only - override-only rows have no package to inspect).
		if (folder) {
			const chevron = this.iconButton(row,
				expanded ? Codicon.chevronDown : Codicon.chevronRight,
				expanded ? localize('clawdius.control.skills.collapse', "Hide files") : localize('clawdius.control.skills.expand', "Show files"),
				() => this.toggleSkillExpand(folder));
			chevron.classList.add('clawdius-control-skill-chevron');
		} else {
			append(row, h('.clawdius-control-skill-chevron-spacer'));
		}

		const info = append(row, h('.clawdius-control-cap-info'));
		const nameEl = append(info, h('.clawdius-control-cap-name'));
		append(nameEl, h('span')).textContent = skill.name;
		const origin = append(nameEl, h('span.clawdius-control-cap-origin'));
		if (skill.origins.length > 0) {
			origin.textContent = skill.origins.join(', ');
		} else {
			origin.classList.add('muted');
			origin.textContent = localize('clawdius.control.skills.overrideOnly', "override only");
		}
		if (folder) { this.renderSkillBadge(nameEl, folder.fsPath); }
		if (skill.description) {
			append(info, h('.clawdius-control-cap-desc')).textContent = skill.description;
		}
		append(row, h('.clawdius-control-spacer'));
		// A plugin-only skill is read-only: the plugin owns it, and the on/off override is keyed by bare name
		// (which does not reliably apply to plugin skills), so it is display-only - no toggle. A name that also
		// has a standalone/user skill, or an override-only key with no backing item, keeps its working toggle.
		const isPluginOnlySkill = skill.items.length > 0 && skill.items.every(i => !!i.sourcePlugin);
		if (!isPluginOnlySkill) {
			this.renderSkillStateControl(row, skill.name, current);
		}
		const acts = append(row, h('.clawdius-control-cap-acts'));
		if (item) {
			this.iconButton(acts, Codicon.edit, localize('clawdius.control.skills.open', "Open SKILL.md"), () => void this.openSkill(item));
			// A plugin-bundled skill is read-only (canDelete === false): the plugin owns it, so offer Open but not Delete.
			if (item.canDelete !== false) {
				this.iconButton(acts, Codicon.trash, localize('clawdius.control.skills.delete', "Delete skill"), () => void this.deleteSkill(item), true);
			}
		}

		if (expanded && folder) { this.renderSkillPanel(parent, folder); }
	}

	/** A compact spec-validation badge for a skill row (from the cache, or 'checking' until the read lands). */
	private renderSkillBadge(parent: HTMLElement, folderPath: string): void {
		const v = this.skillValidations.get(folderPath);
		const badge = append(parent, h('span.clawdius-control-skill-badge'));
		if (!v) {
			badge.classList.add('checking');
			append(badge, h('span')).textContent = localize('clawdius.control.skills.checking', "checking");
			return;
		}
		const icon = (codicon: ThemeIcon) => append(badge, h('span.clawdius-control-skill-badge-ico')).classList.add(...ThemeIcon.asClassNameArray(codicon));
		if (v.errors.length > 0) {
			badge.classList.add('err'); icon(Codicon.error);
			append(badge, h('span')).textContent = v.errors.length === 1 ? localize('clawdius.control.skills.oneError', "1 error") : localize('clawdius.control.skills.nErrors', "{0} errors", v.errors.length);
		} else if (v.warnings.length > 0) {
			badge.classList.add('warn'); icon(Codicon.warning);
			append(badge, h('span')).textContent = v.warnings.length === 1 ? localize('clawdius.control.skills.oneWarning', "1 warning") : localize('clawdius.control.skills.nWarnings', "{0} warnings", v.warnings.length);
		} else {
			badge.classList.add('ok'); icon(Codicon.pass);
			append(badge, h('span')).textContent = localize('clawdius.control.skills.valid', "valid");
		}
	}

	/** Validate every on-disk skill's SKILL.md (off the paint path); re-render once when the batch lands. The
	 *  generation guard drops results if the caches were cleared (a config change) or the pane was disposed mid
	 *  read, so a slow read never writes a stale badge back into a now-empty cache. */
	private async ensureSkillValidations(folders: readonly URI[]): Promise<void> {
		const todo = folders.filter(f => !this.skillValidations.has(f.fsPath) && !this.skillValidating.has(f.fsPath));
		if (todo.length === 0) { return; }
		const gen = this.cacheGeneration;
		for (const f of todo) { this.skillValidating.add(f.fsPath); }
		const results = await Promise.all(todo.map(async folder => {
			let content: string | undefined;
			try { content = (await this.fileService.readFile(URI.joinPath(folder, 'SKILL.md'))).value.toString(); } catch { content = undefined; }
			return { key: folder.fsPath, validation: validateSkillPackage({ directoryName: basename(folder), skillMdContent: content }) };
		}));
		if (this.isPaneDisposed || gen !== this.cacheGeneration) { return; } // stale: caches were cleared / pane gone
		for (const r of results) { this.skillValidations.set(r.key, r.validation); }
		for (const f of todo) { this.skillValidating.delete(f.fsPath); }
		if (this.tab === 'skills') { this.render(); }
	}

	private toggleSkillExpand(folder: URI): void {
		const fp = folder.fsPath;
		this.expandedSkill = this.expandedSkill === fp ? undefined : fp;
		this.skillFileForm = undefined;
		if (this.expandedSkill === fp) { void this.ensureSkillFiles(folder); }
		this.render();
	}

	/** Collapse or expand a plugin's skill group on the Skills tab. */
	private toggleSkillPluginCollapse(plugin: string): void {
		if (this.collapsedSkillPlugins.has(plugin)) { this.collapsedSkillPlugins.delete(plugin); }
		else { this.collapsedSkillPlugins.add(plugin); }
		this.render();
	}

	/** The expanded skill package: validation issues, the file list (open/delete), and a new-file form. */
	private renderSkillPanel(parent: HTMLElement, folder: URI): void {
		const panel = append(parent, h('.clawdius-control-skill-panel'));
		const v = this.skillValidations.get(folder.fsPath);
		if (v && (v.errors.length > 0 || v.warnings.length > 0)) {
			const issues = append(panel, h('.clawdius-control-skill-issues'));
			for (const e of v.errors) { this.renderSkillIssue(issues, e); }
			for (const w of v.warnings) { this.renderSkillIssue(issues, w); }
		} else if (v) {
			append(panel, h('.clawdius-control-skill-allgood')).textContent = localize('clawdius.control.skills.allValid', "SKILL.md is valid against the Agent Skills spec.");
		}

		const fhd = append(panel, h('.clawdius-control-bar'));
		append(fhd, h('.clawdius-control-skill-files-title')).textContent = localize('clawdius.control.skills.files', "Files");
		append(fhd, h('.clawdius-control-spacer'));
		const newFileOpen = this.skillFileForm?.folderPath === folder.fsPath;
		this.button(fhd,
			newFileOpen ? localize('clawdius.control.cancel', "Cancel") : localize('clawdius.control.skills.newFile', "New file"),
			() => {
				this.skillFileForm = newFileOpen ? undefined : { folderPath: folder.fsPath, target: '', name: '' };
				this.render();
			},
			newFileOpen ? 'ghost' : 'add',
			newFileOpen ? Codicon.close : Codicon.add);

		const files = this.skillFiles.get(folder.fsPath);
		if (!files) {
			append(panel, h('.clawdius-control-skill-loading')).textContent = localize('clawdius.control.skills.loadingFiles', "Loading files...");
			void this.ensureSkillFiles(folder); // (re)start the load if the cache was cleared while expanded
		} else {
			this.renderSkillFileList(panel, folder, files);
		}
		if (this.skillFileForm?.folderPath === folder.fsPath) { this.renderNewFileForm(panel, folder); }
	}

	private renderSkillIssue(parent: HTMLElement, issue: ISkillIssue): void {
		const row = append(parent, h(`.clawdius-control-skill-issue.${issue.severity}`));
		append(row, h('span.clawdius-control-skill-issue-ico')).classList.add(...ThemeIcon.asClassNameArray(issue.severity === 'error' ? Codicon.error : Codicon.warning));
		append(row, h('span')).textContent = this.skillIssueMessage(issue);
	}

	/** Map a (localization-free) validation issue code to a localized, user-facing message. */
	private skillIssueMessage(issue: ISkillIssue): string {
		switch (issue.code) {
			case 'missing-skill-md': return localize('clawdius.control.skills.v.missingMd', "Missing or empty SKILL.md.");
			case 'no-frontmatter': return localize('clawdius.control.skills.v.noFrontmatter', "SKILL.md has no YAML frontmatter (--- ... ---).");
			case 'name-missing': return localize('clawdius.control.skills.v.nameMissing', "Missing required 'name'.");
			case 'name-too-long': return localize('clawdius.control.skills.v.nameLong', "'name' exceeds {0} characters.", issue.arg);
			case 'name-format': return localize('clawdius.control.skills.v.nameFormat', "'name' must be lowercase letters, numbers, and single hyphens (no leading, trailing, or double hyphens).");
			case 'name-folder-mismatch': return localize('clawdius.control.skills.v.nameDir', "'name' must match the skill folder name '{0}'.", issue.arg);
			case 'description-missing': return localize('clawdius.control.skills.v.descMissing', "Missing required 'description'.");
			case 'description-too-long': return localize('clawdius.control.skills.v.descLong', "'description' exceeds {0} characters.", issue.arg);
			case 'description-short': return localize('clawdius.control.skills.v.descShort', "'description' is very short; describe what the skill does and when to use it.");
			case 'compatibility-too-long': return localize('clawdius.control.skills.v.compatLong', "'compatibility' exceeds {0} characters.", issue.arg);
			case 'body-too-long': return localize('clawdius.control.skills.v.bodyLong', "SKILL.md is over {0} lines; consider moving detail into references/.", issue.arg);
		}
	}

	/** Render the package files as a collapsible tree: root files, then each subdirectory as a foldable node. */
	private renderSkillFileList(parent: HTMLElement, folder: URI, files: readonly ISkillFileEntry[]): void {
		if (files.length === 0) {
			append(parent, h('.clawdius-control-skill-emptyfiles')).textContent = localize('clawdius.control.skills.noFiles', "No files.");
			return;
		}
		const list = append(parent, h('.clawdius-control-skill-filelist'));
		// Root files (no '/' in the path), in their existing order (SKILL.md first).
		for (const f of files) {
			if (!f.isDirectory && !f.relPath.includes('/')) { this.renderSkillFileEntry(list, folder, f, 0); }
		}
		// Each top-level subdirectory as a collapsible node, with its files nested one level under it.
		for (const dir of files) {
			if (!dir.isDirectory || dir.relPath.includes('/')) { continue; }
			const dirKey = dir.resource.fsPath;
			const expanded = this.expandedSkillDirs.has(dirKey);
			const childCount = files.filter(f => !f.isDirectory && f.relPath.startsWith(`${dir.relPath}/`)).length;
			const row = append(list, h('.clawdius-control-skill-file.dir'));
			const chevron = this.iconButton(row,
				expanded ? Codicon.chevronDown : Codicon.chevronRight,
				expanded ? localize('clawdius.control.skills.collapseDir', "Collapse folder") : localize('clawdius.control.skills.expandDir', "Expand folder"),
				() => {
					if (expanded) { this.expandedSkillDirs.delete(dirKey); } else { this.expandedSkillDirs.add(dirKey); }
					this.render();
				});
			chevron.classList.add('clawdius-control-skill-tree-chevron');
			append(row, h('span.clawdius-control-skill-file-ico')).classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));
			append(row, h('span.clawdius-control-skill-file-name')).textContent = `${dir.name}/`;
			append(row, h('span.clawdius-control-skill-file-count')).textContent = childCount === 1 ? localize('clawdius.control.skills.oneItem', "1 item") : localize('clawdius.control.skills.nItems', "{0} items", childCount);
			if (expanded) {
				const prefix = `${dir.relPath}/`;
				for (const f of files) {
					if (!f.isDirectory && f.relPath.startsWith(prefix)) { this.renderSkillFileEntry(list, folder, f, 1); }
				}
			}
		}
	}

	/** A single file row in the tree, indented by depth; shows the file name (not the full relative path). */
	private renderSkillFileEntry(list: HTMLElement, folder: URI, file: ISkillFileEntry, depth: number): void {
		const row = append(list, h('.clawdius-control-skill-file'));
		row.style.paddingLeft = `${4 + depth * 20}px`;
		append(row, h('.clawdius-control-skill-tree-twistyspace')); // align the file icon under sibling folder icons
		append(row, h('span.clawdius-control-skill-file-ico')).classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
		append(row, h('span.clawdius-control-skill-file-name')).textContent = file.name;
		append(row, h('.clawdius-control-spacer'));
		const acts = append(row, h('.clawdius-control-cap-acts'));
		this.iconButton(acts, Codicon.goToFile, localize('clawdius.control.skills.openFile', "Open"), () => void this.editorService.openEditor({ resource: file.resource, options: { pinned: true } }));
		if (!file.isSkillMd) {
			this.iconButton(acts, Codicon.trash, localize('clawdius.control.skills.deleteFile', "Delete file"), () => void this.deleteSkillFile(folder, file), true);
		}
	}

	private renderNewFileForm(parent: HTMLElement, folder: URI): void {
		const form = this.skillFileForm;
		if (!form || form.folderPath !== folder.fsPath) { return; }
		const wrap = append(parent, h('.clawdius-control-skill-newfile'));
		const row = append(wrap, h('.clawdius-control-addrow'));

		const targetSel = append(row, h('select.clawdius-control-select')) as HTMLSelectElement;
		targetSel.setAttribute('aria-label', localize('clawdius.control.skills.targetDir', "Target folder"));
		for (const t of [
			{ value: '', label: localize('clawdius.control.skills.targetRoot', "(skill root)") },
			{ value: 'scripts', label: 'scripts/' },
			{ value: 'references', label: 'references/' },
			{ value: 'assets', label: 'assets/' },
		]) {
			const o = append(targetSel, h('option')) as HTMLOptionElement;
			o.value = t.value; o.textContent = t.label;
			if (t.value === form.target) { o.selected = true; }
		}
		this.renderStore.add(addDisposableListener(targetSel, EventType.CHANGE, () => { form.target = targetSel.value; }));

		const input = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
		input.type = 'text';
		input.value = form.name;
		input.placeholder = localize('clawdius.control.skills.fileNamePh', "filename, e.g. REFERENCE.md");
		input.setAttribute('aria-label', localize('clawdius.control.skills.fileName', "New file name"));
		this.renderStore.add(addDisposableListener(input, EventType.INPUT, () => { form.name = input.value; }));
		this.renderStore.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.preventDefault(); void this.createSkillFile(folder); }
			else if (e.key === 'Escape') { e.preventDefault(); this.skillFileForm = undefined; this.render(); }
		}));

		this.button(row, localize('clawdius.control.skills.createFile', "Create"), () => void this.createSkillFile(folder), 'primary');
		this.button(row, localize('clawdius.control.cancel', "Cancel"), () => { this.skillFileForm = undefined; this.render(); }, 'ghost');
		this.renderStore.add(disposableTimeout(() => input.focus(), 0));
	}

	/** A minimal starter body for a new supporting file (a heading for markdown, else empty). */
	private newSkillFileTemplate(name: string): string {
		return /\.md$/i.test(name) ? `# ${name.replace(/\.md$/i, '')}\n\n` : '';
	}

	private async createSkillFile(folder: URI): Promise<void> {
		const form = this.skillFileForm;
		if (!form) { return; }
		const name = form.name.trim();
		// Guardrails: a simple name only - no separators, no traversal, not the manifest (see validateNewSkillFileName).
		const nameCheck = validateNewSkillFileName(name, form.target);
		if (!nameCheck.ok) {
			this.toast(nameCheck.reason === 'skillMdReserved'
				? localize('clawdius.control.skills.skillMdReserved', "SKILL.md already exists - open it from the file list.")
				: localize('clawdius.control.skills.badFileName', "Enter a simple file name (no slashes or '..')."));
			return;
		}
		const targetDir = form.target ? URI.joinPath(folder, form.target) : folder;
		const resource = URI.joinPath(targetDir, name);
		if (await this.fileService.exists(resource)) {
			this.toast(localize('clawdius.control.skills.fileExists', "That file already exists."));
			return;
		}
		try {
			await this.fileService.createFile(resource, VSBuffer.fromString(this.newSkillFileTemplate(name)), { overwrite: false });
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.skills.createFileFailed', "Could not create the file: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		this.skillFileForm = undefined;
		this.skillFiles.delete(folder.fsPath);
		void this.configService.refresh(true);
		await this.editorService.openEditor({ resource, options: { pinned: true } });
		void this.ensureSkillFiles(folder);
		this.render();
	}

	private async deleteSkillFile(folder: URI, file: ISkillFileEntry): Promise<void> {
		// Guardrails: files only, never the manifest, and the file must live strictly under the skill folder
		// (URI-aware containment so a sibling-prefix path like `skills/foo-bar` is never treated as inside `foo`).
		if (!canDeleteSkillFile(file.resource, folder, file.isDirectory, file.isSkillMd)) { return; }
		const confirmed = await this.dialogService.confirm({
			type: 'warning',
			message: localize('clawdius.control.skills.confirmDeleteFile', "Delete '{0}'?", file.relPath),
			detail: localize('clawdius.control.skills.confirmDeleteFileDetail', "The file is moved to the trash."),
			primaryButton: localize('clawdius.control.skills.deleteFileBtn', "Delete"),
		});
		if (!confirmed.confirmed) { return; }
		try {
			await this.fileService.del(file.resource, { useTrash: true, recursive: false });
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.skills.deleteFileFailed', "Could not delete the file: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		this.skillFiles.delete(folder.fsPath);
		void this.configService.refresh(true);
		void this.ensureSkillFiles(folder);
		this.render();
	}

	/** List a skill package's files: SKILL.md first, then other root files, then one level into each subdir. The
	 *  loading-set guard prevents duplicate loads across re-renders; the generation guard drops stale results. */
	private async ensureSkillFiles(folder: URI): Promise<void> {
		const key = folder.fsPath;
		if (this.skillFiles.has(key) || this.skillFilesLoading.has(key)) { return; }
		const gen = this.cacheGeneration;
		this.skillFilesLoading.add(key);
		const files = await this.loadSkillFiles(folder);
		this.skillFilesLoading.delete(key);
		if (this.isPaneDisposed || gen !== this.cacheGeneration) { return; }
		this.skillFiles.set(key, files);
		if (this.tab === 'skills' && this.expandedSkill === key) { this.render(); }
	}

	private async loadSkillFiles(folder: URI): Promise<ISkillFileEntry[]> {
		const out: ISkillFileEntry[] = [];
		let root;
		try { root = await this.fileService.resolve(folder); } catch { return out; }
		const children = root.children ?? [];
		const skillMd = children.find(c => !c.isDirectory && c.name === 'SKILL.md');
		if (skillMd) { out.push({ name: 'SKILL.md', resource: skillMd.resource, isDirectory: false, relPath: 'SKILL.md', isSkillMd: true }); }
		for (const c of children) {
			if (!c.isDirectory && c.name !== 'SKILL.md') { out.push({ name: c.name, resource: c.resource, isDirectory: false, relPath: c.name, isSkillMd: false }); }
		}
		for (const c of children) {
			if (!c.isDirectory) { continue; }
			out.push({ name: c.name, resource: c.resource, isDirectory: true, relPath: c.name, isSkillMd: false });
			let sub;
			try { sub = await this.fileService.resolve(c.resource); } catch { continue; }
			for (const f of (sub.children ?? [])) {
				if (!f.isDirectory) { out.push({ name: f.name, resource: f.resource, isDirectory: false, relPath: `${c.name}/${f.name}`, isSkillMd: false }); }
			}
		}
		return out;
	}

	/** Scaffold a new skill (reuses the Config tree's create command: prompts scope + name, opens SKILL.md). */
	private async createSkill(): Promise<void> {
		await this.commandService.executeCommand(configCreateCommandId(ConfigSection.Skills));
		// The create command refreshes the scanned config; our onDidChange listener re-renders the Skills tab.
	}

	private async openSkill(item: IConfigItem): Promise<void> {
		if (item.resource) { await this.editorService.openEditor({ resource: item.resource, options: { pinned: true } }); }
	}

	/** Delete a skill (reuses the Config tree's delete command: confirms, moves the folder to the trash). */
	private async deleteSkill(item: IConfigItem): Promise<void> {
		await this.commandService.executeCommand(CONFIG_DELETE_COMMAND_ID, item);
	}

	private renderSkillStateControl(parent: HTMLElement, name: string, current: SkillOverride): void {
		const seg = append(parent, h('.clawdius-control-seg.clawdius-control-seg-sm'));
		for (const opt of this.skillStateOptions()) {
			const b = append(seg, h('button.clawdius-control-mode')) as HTMLButtonElement;
			const active = opt.value === current;
			if (active) { b.classList.add('active'); }
			append(b, h('span.clawdius-control-mode-name')).textContent = opt.label;
			b.title = opt.detail;
			b.setAttribute('aria-label', `${name}: ${opt.label} - ${opt.detail}`);
			b.setAttribute('aria-pressed', active ? 'true' : 'false');
			this.renderStore.add(addDisposableListener(b, EventType.CLICK, () => void this.setSkillOverride(name, current, opt.value)));
		}
	}

	private skillStateOptions(): { value: SkillOverride; label: string; detail: string }[] {
		return [
			{ value: 'on', label: localize('clawdius.control.skills.on', "On"), detail: localize('clawdius.control.skills.onHint', "Listed with its description. The model can use it and you can run /name.") },
			{ value: 'name-only', label: localize('clawdius.control.skills.nameOnly', "Name Only"), detail: localize('clawdius.control.skills.nameOnlyHint', "Listed without its description (saves context). Still fully usable.") },
			{ value: 'user-invocable-only', label: localize('clawdius.control.skills.manual', "Manual Only"), detail: localize('clawdius.control.skills.manualHint', "Hidden from the model. You can still run it with /name.") },
			{ value: 'off', label: localize('clawdius.control.skills.off', "Off"), detail: localize('clawdius.control.skills.offHint', "Hidden from both the model and you.") },
		];
	}

	private async setSkillOverride(name: string, prev: SkillOverride, next: SkillOverride): Promise<void> {
		if (prev === next) { return; }
		const uri = await this.scopeUri(this.scope);
		if (!uri) { return; }
		const label = this.skillStateOptions().find(o => o.value === next)?.label ?? next;
		await this.writeSettingsAtUri(uri, [skillOverrideWrite(name, next)],
			localize('clawdius.control.skills.toast', "Set \"{0}\" to {1}", name, label),
			() => void this.writeSettingsAtUri(uri, [skillOverrideWrite(name, prev)], localize('clawdius.control.skills.undoToast', "Reverted \"{0}\"", name)));
	}

	private async setDisableBundled(value: boolean): Promise<void> {
		const uri = await this.scopeUri(this.scope);
		if (!uri) { return; }
		await this.writeSettingsAtUri(uri, [disableBundledSkillsWrite(value)],
			value ? localize('clawdius.control.skills.bundledToastOff', "Bundled skills disabled") : localize('clawdius.control.skills.bundledToastOn', "Bundled skills enabled"),
			() => void this.writeSettingsAtUri(uri, [disableBundledSkillsWrite(!value)], localize('clawdius.control.skills.bundledUndo', "Reverted bundled skills")));
	}

	/** A reusable label + description + on/off switch row (Skills bundled toggle, later Plugins / Hooks). */
	private renderToggleRow(parent: HTMLElement, label: string, hint: string, value: boolean, onChange: (next: boolean) => void): void {
		const row = append(parent, h('.clawdius-control-caprow'));
		const info = append(row, h('.clawdius-control-cap-info'));
		append(info, h('.clawdius-control-cap-name')).textContent = label;
		append(info, h('.clawdius-control-cap-desc')).textContent = hint;
		append(row, h('.clawdius-control-spacer'));
		this.appendToggle(row, value, label, onChange);
	}

	/** Append an On/Off switch control to a row. Shared by renderToggleRow and the catalog rows (which carry extra
	 *  actions next to the switch). */
	private appendToggle(parent: HTMLElement, value: boolean, ariaLabel: string, onChange: (next: boolean) => void): void {
		const toggle = append(parent, h('button.clawdius-control-toggle')) as HTMLButtonElement;
		if (value) { toggle.classList.add('on'); }
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', value ? 'true' : 'false');
		toggle.setAttribute('aria-label', ariaLabel);
		const track = append(toggle, h('span.clawdius-control-toggle-track'));
		append(track, h('span.clawdius-control-toggle-thumb'));
		append(toggle, h('span.clawdius-control-toggle-text')).textContent = value ? localize('clawdius.control.toggleOn', "On") : localize('clawdius.control.toggleOff', "Off");
		this.renderStore.add(addDisposableListener(toggle, EventType.CLICK, () => onChange(!value)));
	}

	// --- Hooks tab ---

	private renderHooksTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.control.hooks.title', "Hooks"),
			localize('clawdius.control.hooks.sub', "Shell commands Claude runs on events (PreToolUse, SessionStart, ...). Edits your own ~/.claude configuration."));

		const scopeBlock = this.block(parent, localize('clawdius.control.hooks.scopeTitle', "Where these changes apply"));
		this.renderScopeBar(scopeBlock);
		if (this.snapshot?.kind === 'malformed') { this.renderMalformed(scopeBlock); return; }

		const settings = this.snapshot?.kind === 'ok' ? this.snapshot.settings : {};
		const allOff = parseDisableAllHooks(settings);

		const master = this.block(parent, localize('clawdius.control.hooks.masterTitle', "All hooks"));
		this.renderToggleRow(master,
			localize('clawdius.control.hooks.disableLabel', "Disable all hooks"),
			localize('clawdius.control.hooks.disableHint', "Turns off every hook and statusLine execution (disableAllHooks). Individual hooks stay configured."),
			allOff,
			next => void this.setDisableAllHooks(next));

		// Per-event display. Editing a hook entry opens the settings file; full add/edit forms land later.
		const block = append(parent, h('.clawdius-control-block'));
		const hd = append(block, h('.clawdius-control-bar'));
		append(hd, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.hooks.listTitle', "Hooks by event");
		append(hd, h('.clawdius-control-spacer'));
		this.button(hd, localize('clawdius.control.hooks.new', "New hook"), () => void this.createHook(), 'add', Codicon.add);
		if (allOff) {
			append(block, h('.clawdius-control-scope-hint')).textContent = localize('clawdius.control.hooks.allOffNote', "All hooks are currently disabled by the switch above.");
		}

		const hooks = this.collectHooks();
		if (hooks.length === 0) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.hooks.none', "No hooks configured. Click New hook to add one for an event.");
			return;
		}
		const setCount = this.renderSearchBox(block, localize('clawdius.control.hooks.search', "Search hooks..."));
		const matching = hooks.filter(item => this.matchesFilter(`${item.label} ${item.description ?? ''}`));
		if (matching.length === 0) {
			append(block, h('.clawdius-control-emptyrule')).textContent = localize('clawdius.control.noMatch', "No matches for \"{0}\".", this.filter.trim());
		}
		for (const item of matching) { this.renderHookRow(block, item); }
		setCount(matching.length, hooks.length);
	}

	/** Hook events from the scanned config (each event with its hook count + backing settings file). */
	private collectHooks(): IConfigItem[] {
		const out: IConfigItem[] = [];
		for (const scope of this.configService.snapshot.scopes) {
			for (const sec of scope.sections) {
				if (sec.section === ConfigSection.Hooks) { out.push(...sec.items); }
			}
		}
		return out;
	}

	private renderHookRow(parent: HTMLElement, item: IConfigItem): void {
		const origin = item.scope === ConfigScope.Global
			? localize('clawdius.control.scope.global', "Global")
			: localize('clawdius.control.scope.project', "Project (shared)");
		const row = append(parent, h('.clawdius-control-caprow'));
		const info = append(row, h('.clawdius-control-cap-info'));
		const nameEl = append(info, h('.clawdius-control-cap-name'));
		append(nameEl, h('span')).textContent = item.label;
		append(nameEl, h('span.clawdius-control-cap-origin')).textContent = origin;
		if (item.description) { append(info, h('.clawdius-control-cap-desc')).textContent = item.description; }
		append(row, h('.clawdius-control-spacer'));
		const acts = append(row, h('.clawdius-control-cap-acts'));
		if (item.resource) {
			this.iconButton(acts, Codicon.edit, localize('clawdius.control.hooks.open', "Open in settings.json"),
				() => void this.editorService.openEditor({ resource: item.resource!, options: { pinned: true } }));
		}
	}

	private async createHook(): Promise<void> {
		// Reuses the Config tree's create command: prompts the event + appends a template hook entry, then opens.
		await this.commandService.executeCommand(configCreateCommandId(ConfigSection.Hooks));
	}

	private async setDisableAllHooks(value: boolean): Promise<void> {
		const uri = await this.scopeUri(this.scope);
		if (!uri) { return; }
		await this.writeSettingsAtUri(uri, [disableAllHooksWrite(value)],
			value ? localize('clawdius.control.hooks.toastOff', "All hooks disabled") : localize('clawdius.control.hooks.toastOn', "All hooks enabled"),
			() => void this.writeSettingsAtUri(uri, [disableAllHooksWrite(!value)], localize('clawdius.control.hooks.undo', "Reverted")));
	}

	// --- MCP tab ---

	private renderMcpTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.control.mcp.title', "MCP Servers"),
			localize('clawdius.control.mcp.sub', "Inspect MCP servers, approve project servers, and set per-tool permissions. Edits your own ~/.claude configuration."));

		const scopeBlock = this.block(parent, localize('clawdius.control.mcp.scopeTitle', "Where these changes apply"));
		this.renderScopeBar(scopeBlock);
		if (this.snapshot?.kind === 'malformed') { this.renderMalformed(scopeBlock); return; }

		const settings = this.snapshot?.kind === 'ok' ? this.snapshot.settings : {};
		const mcpState = parseMcpSettings(settings);
		void this.ensureMcpDefs();

		const servers = this.collectMcpServers();
		const globalServers = servers.filter(s => s.scope === ConfigScope.Global);
		// Approvals write to scopeUri('project')/('projectLocal'), which resolve through the FIRST workspace
		// folder. Limit the project list to that folder's .mcp.json so a multi-root approval never targets the
		// wrong project's settings (carrying per-row project-settings URIs is a later refinement).
		const firstFolder = this.workspaceService.getWorkspace().folders[0]?.uri;
		const projectServers = servers.filter(s => s.scope === ConfigScope.Project && (!firstFolder || isEqualOrParent(s.resource, firstFolder)));

		// Search filters BOTH server lists by name; the box only appears when there is something to filter.
		const totalServers = globalServers.length + projectServers.length;
		let setMcpCount: (shown: number, total: number) => void = () => { };
		if (totalServers > 0) {
			setMcpCount = this.renderSearchBox(append(parent, h('.clawdius-control-block')), localize('clawdius.control.mcp.search', "Search servers..."));
		}
		const globalMatching = globalServers.filter(s => this.matchesFilter(s.name));
		const projectMatching = projectServers.filter(s => this.matchesFilter(s.name));
		setMcpCount(globalMatching.length + projectMatching.length, totalServers);

		const gblock = append(parent, h('.clawdius-control-block'));
		const ghd = append(gblock, h('.clawdius-control-bar'));
		append(ghd, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.mcp.globalTitle', "Global MCP servers");
		append(ghd, h('.clawdius-control-spacer'));
		const gAddOpen = this.mcpForm?.scope === 'global' && this.mcpForm.mode === 'add';
		this.button(ghd,
			gAddOpen ? localize('clawdius.control.cancel', "Cancel") : localize('clawdius.control.mcp.newServer', "New server"),
			() => { if (gAddOpen) { this.mcpForm = undefined; this.render(); } else { this.openMcpAddForm('global'); } },
			gAddOpen ? 'ghost' : 'add',
			gAddOpen ? Codicon.close : Codicon.add);
		append(gblock, h('.clawdius-control-scope-hint')).textContent = localize('clawdius.control.mcp.globalNote', "Defined in ~/.claude.json. Always available - inspect them and set per-tool permissions.");
		if (this.mcpForm?.scope === 'global' && this.mcpForm.mode === 'add') { this.renderMcpForm(gblock); }
		if (globalServers.length === 0) {
			append(gblock, h('.clawdius-control-empty')).textContent = localize('clawdius.control.mcp.noGlobal', "No global MCP servers configured.");
		} else {
			for (const server of globalMatching) { this.renderMcpServerRow(gblock, server, false, mcpState); }
		}

		const hasWorkspace = this.workspaceService.getWorkspace().folders.length > 0;
		if (hasWorkspace || projectServers.length > 0) {
			const pblock = append(parent, h('.clawdius-control-block'));
			const phd = append(pblock, h('.clawdius-control-bar'));
			append(phd, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.mcp.projectTitle', "Project MCP servers");
			append(phd, h('.clawdius-control-spacer'));
			if (hasWorkspace) {
				const pAddOpen = this.mcpForm?.scope === 'project' && this.mcpForm.mode === 'add';
				this.button(phd,
					pAddOpen ? localize('clawdius.control.cancel', "Cancel") : localize('clawdius.control.mcp.newServer', "New server"),
					() => { if (pAddOpen) { this.mcpForm = undefined; this.render(); } else { this.openMcpAddForm('project'); } },
					pAddOpen ? 'ghost' : 'add',
					pAddOpen ? Codicon.close : Codicon.add);
			}
			append(pblock, h('.clawdius-control-scope-hint')).textContent = localize('clawdius.control.mcp.projectNote', "Defined in this project's .mcp.json. Approve or reject which ones Claude may use.");
			this.renderToggleRow(pblock,
				localize('clawdius.control.mcp.enableAll', "Approve all project MCP servers"),
				localize('clawdius.control.mcp.enableAllHint', "Auto-approves every server in .mcp.json (enableAllProjectMcpServers); individual Reject still wins."),
				mcpState.enableAllProjectServers,
				next => void this.setEnableAllMcp(next));
			if (this.mcpForm?.scope === 'project' && this.mcpForm.mode === 'add') { this.renderMcpForm(pblock); }
			if (projectServers.length === 0) {
				append(pblock, h('.clawdius-control-empty')).textContent = localize('clawdius.control.mcp.noProject', "No project MCP servers in .mcp.json.");
			} else {
				for (const server of projectMatching) { this.renderMcpServerRow(pblock, server, true, mcpState); }
			}
		}
	}

	private openMcpAddForm(scope: 'global' | 'project'): void {
		this.mcpForm = { scope, mode: 'add', name: '', form: emptyMcpForm('stdio'), oauthOpen: false };
		this.render();
	}

	/** Open the edit form for an existing server. Reads the def FRESH from the backing JSON so the prefill matches
	 *  what is on disk; secret env / header VALUES are stripped (only keys are prefilled, with blank values). */
	private async openMcpEditForm(scope: 'global' | 'project', name: string): Promise<void> {
		const uri = await this.mcpBackingFile(scope);
		if (!uri) { return; }
		const def = await this.readMcpServerDef(uri, name);
		const form = parseMcpDefForEdit(def);
		this.mcpForm = { scope, mode: 'edit', name, form, oauthOpen: !isOauthFormBlank(form.oauth) };
		this.render();
	}

	/** The backing JSON for MCP servers: ~/.claude.json (global) or <first folder>/.mcp.json (project). */
	private async mcpBackingFile(scope: 'global' | 'project'): Promise<URI | undefined> {
		if (scope === 'global') { return URI.joinPath(await this.pathService.userHome(), '.claude.json'); }
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		return folder ? URI.joinPath(folder, '.mcp.json') : undefined;
	}

	/** Read the raw `mcpServers[name]` def from a backing JSON file, or undefined if absent / malformed. */
	private async readMcpServerDef(uri: URI, name: string): Promise<unknown> {
		const raw = await this.readRaw(uri);
		if (raw === undefined) { return undefined; }
		try {
			const parsed = parseJsonc<{ mcpServers?: Record<string, unknown> }>(raw);
			return (parsed?.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers[name] : undefined;
		} catch {
			return undefined;
		}
	}

	/** Render the add / edit MCP form into `parent`. Creates the form's own DOM root + listener store, then builds
	 *  the rows. Routine edits inside the form rebuild only this subtree (rerenderMcpForm), never the whole pane. */
	private renderMcpForm(parent: HTMLElement): void {
		if (!this.mcpForm) { return; }
		this.mcpFormContainer = append(parent, h('.clawdius-control-mcp-addform'));
		this.buildMcpForm();
	}

	/** Rebuild only the open form's subtree in place (no full pane render). Used by every routine form interaction
	 *  that changes which rows are shown - transport change, add / remove a repeater row, OAuth toggle. */
	private rerenderMcpForm(): void {
		if (this.mcpFormContainer && this.mcpForm) { this.buildMcpForm(); }
	}

	/** Build the form rows into the form container, registering every listener to mcpFormStore (cleared first so a
	 *  rebuild never double-binds or leaks). Called both by the initial render and by each in-place subtree rebuild;
	 *  a full pane render goes through renderMcpForm, which makes a fresh container and calls this too. */
	private buildMcpForm(): void {
		const state = this.mcpForm;
		const wrap = this.mcpFormContainer;
		if (!state || !wrap) { return; }
		this.mcpFormStore.clear();
		clearNode(wrap);
		const form = state.form;

		// Name (locked on edit) + transport.
		const nameRow = append(wrap, h('.clawdius-control-addrow'));
		const name = append(nameRow, h('input.clawdius-control-input')) as HTMLInputElement;
		name.type = 'text'; name.value = state.name;
		name.placeholder = localize('clawdius.control.mcp.namePh', "server name, e.g. my-server");
		name.setAttribute('aria-label', localize('clawdius.control.mcp.nameLabel', "Server name"));
		if (state.mode === 'edit') {
			name.readOnly = true;
			name.classList.add('readonly');
		} else {
			this.mcpFormStore.add(addDisposableListener(name, EventType.INPUT, () => { state.name = name.value; }));
		}
		const transport = append(nameRow, h('select.clawdius-control-select')) as HTMLSelectElement;
		transport.setAttribute('aria-label', localize('clawdius.control.mcp.transportLabel', "Transport"));
		for (const t of MCP_TRANSPORTS) {
			const o = append(transport, h('option')) as HTMLOptionElement;
			o.value = t; o.textContent = t;
			if (t === form.transport) { o.selected = true; }
		}
		this.mcpFormStore.add(addDisposableListener(transport, EventType.CHANGE, () => {
			state.form = { ...state.form, transport: transport.value as McpTransport };
			this.rerenderMcpForm();
		}));

		if (form.transport === 'stdio') {
			this.renderMcpStdioFields(wrap, state);
		} else {
			this.renderMcpRemoteFields(wrap, state);
		}

		this.renderMcpCommonFields(wrap, state);

		const actions = append(wrap, h('.clawdius-control-addrow'));
		const saveLabel = state.mode === 'edit' ? localize('clawdius.control.mcp.save', "Save") : localize('clawdius.control.mcp.create', "Create");
		this.button(actions, saveLabel, () => void this.saveMcpServer(), 'primary', undefined, this.mcpFormStore);
		this.button(actions, localize('clawdius.control.cancel', "Cancel"), () => { this.mcpForm = undefined; this.render(); }, 'ghost', undefined, this.mcpFormStore);
		if (state.mode === 'edit') {
			append(wrap, h('.clawdius-control-addnote')).textContent = localize('clawdius.control.mcp.editNote', "Secret env / header values are hidden. Leave a value blank to keep the stored secret; type a new value to replace it.");
		} else {
			append(wrap, h('.clawdius-control-addnote')).textContent = localize('clawdius.control.mcp.addNote', "Writes the server to the backing JSON. Secret env / header values are stored as you type them.");
		}
	}

	/** stdio fields: command, an args repeater, and an env key/value (secret) repeater. */
	private renderMcpStdioFields(wrap: HTMLElement, state: { form: IMcpServerForm }): void {
		const form = state.form;
		const cmdRow = append(wrap, h('.clawdius-control-addrow'));
		const command = append(cmdRow, h('input.clawdius-control-input')) as HTMLInputElement;
		command.type = 'text'; command.value = form.command;
		command.placeholder = localize('clawdius.control.mcp.commandPh', "command, e.g. uvx or npx");
		command.setAttribute('aria-label', localize('clawdius.control.mcp.commandLabel', "Command"));
		this.mcpFormStore.add(addDisposableListener(command, EventType.INPUT, () => { state.form = { ...state.form, command: command.value }; }));

		this.renderMcpListRepeater(wrap,
			localize('clawdius.control.mcp.argsTitle', "Arguments"),
			localize('clawdius.control.mcp.argPh', "argument"),
			localize('clawdius.control.mcp.argLabel', "Argument"),
			localize('clawdius.control.mcp.addArg', "Add argument"),
			form.args,
			next => { state.form = { ...state.form, args: next }; });

		this.renderMcpKeyValueRepeater(wrap,
			localize('clawdius.control.mcp.envTitle', "Environment variables"),
			localize('clawdius.control.mcp.envKeyLabel', "Variable name"),
			localize('clawdius.control.mcp.envValueLabel', "Variable value"),
			localize('clawdius.control.mcp.addEnv', "Add variable"),
			form.env,
			next => { state.form = { ...state.form, env: next }; });
	}

	/** Remote (http / sse / ws) fields: url, a headers key/value (secret) repeater, headersHelper, and (http / sse
	 *  only) a collapsible OAuth subsection. */
	private renderMcpRemoteFields(wrap: HTMLElement, state: { form: IMcpServerForm; oauthOpen: boolean }): void {
		const form = state.form;
		const urlRow = append(wrap, h('.clawdius-control-addrow'));
		const url = append(urlRow, h('input.clawdius-control-input')) as HTMLInputElement;
		url.type = 'text'; url.value = form.url;
		url.placeholder = localize('clawdius.control.mcp.urlPh', "https://host/mcp");
		url.setAttribute('aria-label', localize('clawdius.control.mcp.urlLabel', "Server URL"));
		this.mcpFormStore.add(addDisposableListener(url, EventType.INPUT, () => { state.form = { ...state.form, url: url.value }; }));

		this.renderMcpKeyValueRepeater(wrap,
			localize('clawdius.control.mcp.headersTitle', "Headers"),
			localize('clawdius.control.mcp.headerKeyLabel', "Header name"),
			localize('clawdius.control.mcp.headerValueLabel', "Header value"),
			localize('clawdius.control.mcp.addHeader', "Add header"),
			form.headers,
			next => { state.form = { ...state.form, headers: next }; });

		const helperRow = append(wrap, h('.clawdius-control-addrow'));
		const helper = append(helperRow, h('input.clawdius-control-input')) as HTMLInputElement;
		helper.type = 'text'; helper.value = form.headersHelper;
		helper.placeholder = localize('clawdius.control.mcp.headersHelperPh', "headers helper command (optional)");
		helper.setAttribute('aria-label', localize('clawdius.control.mcp.headersHelperLabel', "Headers helper command"));
		this.mcpFormStore.add(addDisposableListener(helper, EventType.INPUT, () => { state.form = { ...state.form, headersHelper: helper.value }; }));

		if (transportSupportsOauth(form.transport)) {
			this.renderMcpOauthSection(wrap, state);
		}
	}

	/** The common row shared by all transports: a timeout (ms) number input and an alwaysLoad checkbox. */
	private renderMcpCommonFields(wrap: HTMLElement, state: { form: IMcpServerForm }): void {
		const form = state.form;
		const row = append(wrap, h('.clawdius-control-addrow'));
		const timeout = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
		timeout.type = 'number'; timeout.min = '0'; timeout.value = form.timeout;
		timeout.placeholder = localize('clawdius.control.mcp.timeoutPh', "timeout in ms (optional)");
		timeout.setAttribute('aria-label', localize('clawdius.control.mcp.timeoutLabel', "Timeout in milliseconds"));
		this.mcpFormStore.add(addDisposableListener(timeout, EventType.INPUT, () => { state.form = { ...state.form, timeout: timeout.value }; }));

		const checkLabel = append(row, h('label.clawdius-control-mcp-check')) as HTMLLabelElement;
		const check = append(checkLabel, h('input')) as HTMLInputElement;
		check.type = 'checkbox'; check.checked = form.alwaysLoad;
		check.setAttribute('aria-label', localize('clawdius.control.mcp.alwaysLoadLabel', "Always load"));
		this.mcpFormStore.add(addDisposableListener(check, EventType.CHANGE, () => { state.form = { ...state.form, alwaysLoad: check.checked }; }));
		append(checkLabel, h('span')).textContent = localize('clawdius.control.mcp.alwaysLoad', "Always load");
	}

	/** The collapsible OAuth subsection (http / sse only). clientId, callbackPort, scopes, authServerMetadataUrl,
	 *  plus a note that the client secret is set via the CLI (never written to the JSON file). */
	private renderMcpOauthSection(wrap: HTMLElement, state: { form: IMcpServerForm; oauthOpen: boolean }): void {
		const section = append(wrap, h('.clawdius-control-mcp-oauth'));
		const header = append(section, h('button.clawdius-control-mcp-oauth-toggle')) as HTMLButtonElement;
		header.setAttribute('aria-expanded', state.oauthOpen ? 'true' : 'false');
		append(header, h('span')).classList.add(...ThemeIcon.asClassNameArray(state.oauthOpen ? Codicon.chevronDown : Codicon.chevronRight));
		append(header, h('span')).textContent = localize('clawdius.control.mcp.oauthTitle', "OAuth (optional)");
		this.mcpFormStore.add(addDisposableListener(header, EventType.CLICK, () => { state.oauthOpen = !state.oauthOpen; this.rerenderMcpForm(); }));
		if (!state.oauthOpen) { return; }

		const oauth = state.form.oauth;
		const body = append(section, h('.clawdius-control-mcp-oauth-body'));
		const set = (patch: Partial<IMcpServerForm['oauth']>): void => { state.form = { ...state.form, oauth: { ...state.form.oauth, ...patch } }; };

		const clientIdRow = append(body, h('.clawdius-control-addrow'));
		const clientId = append(clientIdRow, h('input.clawdius-control-input')) as HTMLInputElement;
		clientId.type = 'text'; clientId.value = oauth.clientId;
		clientId.placeholder = localize('clawdius.control.mcp.clientIdPh', "client id");
		clientId.setAttribute('aria-label', localize('clawdius.control.mcp.clientIdLabel', "OAuth client id"));
		this.mcpFormStore.add(addDisposableListener(clientId, EventType.INPUT, () => set({ clientId: clientId.value })));
		const callbackPort = append(clientIdRow, h('input.clawdius-control-input')) as HTMLInputElement;
		callbackPort.type = 'number'; callbackPort.min = '0'; callbackPort.value = oauth.callbackPort;
		callbackPort.placeholder = localize('clawdius.control.mcp.callbackPortPh', "callback port");
		callbackPort.setAttribute('aria-label', localize('clawdius.control.mcp.callbackPortLabel', "OAuth callback port"));
		this.mcpFormStore.add(addDisposableListener(callbackPort, EventType.INPUT, () => set({ callbackPort: callbackPort.value })));

		const scopesRow = append(body, h('.clawdius-control-addrow'));
		const scopes = append(scopesRow, h('input.clawdius-control-input')) as HTMLInputElement;
		scopes.type = 'text'; scopes.value = oauth.scopes;
		scopes.placeholder = localize('clawdius.control.mcp.scopesPh', "scopes (space-separated)");
		scopes.setAttribute('aria-label', localize('clawdius.control.mcp.scopesLabel', "OAuth scopes"));
		this.mcpFormStore.add(addDisposableListener(scopes, EventType.INPUT, () => set({ scopes: scopes.value })));

		const metadataRow = append(body, h('.clawdius-control-addrow'));
		const metadata = append(metadataRow, h('input.clawdius-control-input')) as HTMLInputElement;
		metadata.type = 'text'; metadata.value = oauth.authServerMetadataUrl;
		metadata.placeholder = localize('clawdius.control.mcp.metadataUrlPh', "authorization server metadata URL");
		metadata.setAttribute('aria-label', localize('clawdius.control.mcp.metadataUrlLabel', "Authorization server metadata URL"));
		this.mcpFormStore.add(addDisposableListener(metadata, EventType.INPUT, () => set({ authServerMetadataUrl: metadata.value })));

		append(body, h('.clawdius-control-addnote')).textContent = localize('clawdius.control.mcp.clientSecretNote', "The client secret is never stored in this file. Set it via the CLI: claude mcp add-json <name> ... --client-secret.");
	}

	/** A repeater of single free-text values (e.g. command args): rows of [value][remove] + an Add button. Editing a
	 *  field mutates the form in place (no rebuild). Add / remove a row rebuilds only the form subtree (rerenderMcpForm),
	 *  never the whole pane. Listeners register to mcpFormStore so the rebuild disposes them cleanly. */
	private renderMcpListRepeater(wrap: HTMLElement, title: string, valuePh: string, valueLabel: string, addLabel: string, values: readonly string[], onChange: (next: string[]) => void): void {
		const section = append(wrap, h('.clawdius-control-mcp-kv'));
		append(section, h('.clawdius-control-mcp-kv-title')).textContent = title;
		values.forEach((value, index) => {
			const row = append(section, h('.clawdius-control-addrow'));
			const input = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
			input.type = 'text'; input.value = value;
			input.placeholder = valuePh;
			input.setAttribute('aria-label', localize('clawdius.control.mcp.repeaterValue', "{0} {1}", valueLabel, index + 1));
			this.mcpFormStore.add(addDisposableListener(input, EventType.INPUT, () => {
				const next = [...values];
				next[index] = input.value;
				onChange(next);
			}));
			this.iconButton(row, Codicon.trash, localize('clawdius.control.mcp.remove', "Remove"), () => { onChange(values.filter((_, i) => i !== index)); this.rerenderMcpForm(); }, true, this.mcpFormStore);
		});
		this.button(section, addLabel, () => { onChange([...values, '']); this.rerenderMcpForm(); }, 'add', Codicon.add, this.mcpFormStore);
	}

	/** A repeater of key/value pairs (env / headers). Values are secrets, so the value input is type=password and
	 *  is never prefilled with a stored secret (the form carries blank values; the merger keeps the stored secret).
	 *  Rows of [key][value][remove] + an Add button. Editing a field mutates the form in place; add / remove a row
	 *  rebuilds only the form subtree (rerenderMcpForm), never the whole pane. Listeners register to mcpFormStore so
	 *  the rebuild disposes them cleanly. */
	private renderMcpKeyValueRepeater(wrap: HTMLElement, title: string, keyLabel: string, valueLabel: string, addLabel: string, pairs: readonly IMcpServerForm['env'][number][], onChange: (next: IMcpServerForm['env'][number][]) => void): void {
		const section = append(wrap, h('.clawdius-control-mcp-kv'));
		append(section, h('.clawdius-control-mcp-kv-title')).textContent = title;
		pairs.forEach((pair, index) => {
			const row = append(section, h('.clawdius-control-addrow'));
			const key = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
			key.type = 'text'; key.value = pair.key;
			key.placeholder = keyLabel;
			key.setAttribute('aria-label', localize('clawdius.control.mcp.repeaterKey', "{0} {1}", keyLabel, index + 1));
			this.mcpFormStore.add(addDisposableListener(key, EventType.INPUT, () => {
				const next = [...pairs];
				next[index] = { key: key.value, value: next[index].value };
				onChange(next);
			}));
			// Secret value: type=password, never prefilled with a stored value (blank => keep on save).
			const value = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
			value.type = 'password'; value.value = pair.value;
			value.placeholder = localize('clawdius.control.mcp.keepBlank', "leave blank to keep");
			value.setAttribute('aria-label', localize('clawdius.control.mcp.repeaterValue', "{0} {1}", valueLabel, index + 1));
			value.autocomplete = 'off';
			this.mcpFormStore.add(addDisposableListener(value, EventType.INPUT, () => {
				const next = [...pairs];
				next[index] = { key: next[index].key, value: value.value };
				onChange(next);
			}));
			this.iconButton(row, Codicon.trash, localize('clawdius.control.mcp.remove', "Remove"), () => { onChange(pairs.filter((_, i) => i !== index)); this.rerenderMcpForm(); }, true, this.mcpFormStore);
		});
		this.button(section, addLabel, () => { onChange([...pairs, { key: '', value: '' }]); this.rerenderMcpForm(); }, 'add', Codicon.add, this.mcpFormStore);
	}

	/** Save the open add / edit form. Add: refuse to clobber an existing name, build the def, write it. Edit: read
	 *  the def FRESH, merge (blank secret values keep the stored ones), write it. Both run race-safe against a read
	 *  at write time and offer an undo. */
	private async saveMcpServer(): Promise<void> {
		const state = this.mcpForm;
		if (!state) { return; }
		const name = state.name.trim();
		if (!isSafeMcpServerName(name)) {
			this.toast(localize('clawdius.control.mcp.badName', "Enter a simple server name (letters, numbers, '-', '_', '.')."));
			return;
		}
		const form = state.form;
		if (form.transport === 'stdio' && form.command.trim().length === 0) {
			this.toast(localize('clawdius.control.mcp.needCommand', "Enter a command."));
			return;
		}
		if (form.transport !== 'stdio' && form.url.trim().length === 0) {
			this.toast(localize('clawdius.control.mcp.needUrl', "Enter a URL."));
			return;
		}
		const uri = await this.mcpBackingFile(state.scope);
		if (!uri) { return; }

		// Read the backing file FRESH at write time (clobber check on add; secret merge on edit).
		const raw = await this.readRaw(uri);
		let servers: Record<string, unknown> = {};
		if (raw !== undefined) {
			try {
				const parsed = parseJsonc<{ mcpServers?: Record<string, unknown> }>(raw);
				servers = (parsed?.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers : {};
			} catch { /* malformed file - the write below surfaces the error */ }
		}
		const exists = Object.hasOwn(servers, name);
		if (state.mode === 'add' && exists) {
			this.toast(localize('clawdius.control.mcp.exists', "A server named \"{0}\" already exists here.", name));
			return;
		}
		const def = state.mode === 'edit' ? mergeMcpDefForSave(servers[name], form) : buildMcpDef(form);
		try {
			if (raw === undefined || raw.trim().length === 0) { await this.fileService.writeFile(uri, VSBuffer.fromString('{}\n')); }
			await this.jsonEditing.write(uri, [{ path: ['mcpServers', name], value: def }], true);
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.mcp.createFailed', "Could not save the server: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		this.mcpForm = undefined;
		void this.configService.refresh(true);
		this.render();
		this.toast(state.mode === 'edit'
			? localize('clawdius.control.mcp.savedToast', "Saved \"{0}\"", name)
			: localize('clawdius.control.mcp.createdToast', "Added \"{0}\"", name));
	}

	/** Delete an MCP server from its backing JSON after confirmation, then refresh + offer undo (re-adds the def
	 *  captured before the delete). */
	private async deleteMcpServer(scope: 'global' | 'project', name: string): Promise<void> {
		const uri = await this.mcpBackingFile(scope);
		if (!uri) { return; }
		const confirmed = await this.dialogService.confirm({
			type: 'warning',
			message: localize('clawdius.control.mcp.confirmDelete', "Delete the MCP server '{0}'?", name),
			detail: localize('clawdius.control.mcp.confirmDeleteDetail', "Removes it from {0}. You can undo right after.", uri.fsPath),
			primaryButton: localize('clawdius.control.mcp.deleteBtn', "Delete"),
		});
		if (!confirmed.confirmed) { return; }
		// Capture the def FRESH so Undo can restore exactly what was removed (secrets included - never shown in UI).
		const prevDef = await this.readMcpServerDef(uri, name);
		try {
			await this.jsonEditing.write(uri, [{ path: ['mcpServers', name], value: mcpDeleteWrite(name).value }], true);
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.mcp.deleteFailed', "Could not delete the server: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		if (this.mcpForm?.name === name && this.mcpForm.scope === scope) { this.mcpForm = undefined; }
		void this.configService.refresh(true);
		this.render();
		this.toast(localize('clawdius.control.mcp.deletedToast', "Deleted \"{0}\"", name),
			prevDef === undefined ? undefined : () => void this.restoreMcpServer(uri, name, prevDef));
	}

	/** Undo a delete: re-write the captured def back to the backing JSON. */
	private async restoreMcpServer(uri: URI, name: string, def: unknown): Promise<void> {
		try {
			await this.jsonEditing.write(uri, [{ path: ['mcpServers', name], value: def }], true);
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.mcp.restoreFailed', "Could not restore the server: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		void this.configService.refresh(true);
		this.render();
		this.toast(localize('clawdius.control.mcp.restoredToast', "Restored \"{0}\"", name));
	}

	// --- MCP tab ---

	/** MCP servers from the scanned config (per scope), with the backing JSON file for the def + reveal. */
	private collectMcpServers(): { id: string; name: string; scope: ConfigScope; resource: URI }[] {
		const out: { id: string; name: string; scope: ConfigScope; resource: URI }[] = [];
		for (const scope of this.configService.snapshot.scopes) {
			for (const sec of scope.sections) {
				if (sec.section !== ConfigSection.Mcp) { continue; }
				for (const item of sec.items) {
					if (item.resource) { out.push({ id: item.id, name: item.label, scope: scope.scope, resource: item.resource }); }
				}
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Read each distinct backing JSON file once and summarize every server's def (transport, redacted detail).
	 *  After the fresh read, drop the discovered-tools cache only for servers whose def actually CHANGED (or that
	 *  vanished) - a benign config refresh (e.g. the discovery spawn touching ~/.claude) leaves an unchanged
	 *  server's loaded tools in place, so the tool list does not flash and disappear. */
	private async ensureMcpDefs(): Promise<void> {
		if (this.mcpDefsLoaded) { return; }
		this.mcpDefsLoaded = true;
		const gen = this.cacheGeneration;
		const servers = this.collectMcpServers();
		const byFile = new Map<string, { resource: URI; items: { id: string; name: string }[] }>();
		for (const s of servers) {
			const key = s.resource.toString();
			const entry = byFile.get(key) ?? { resource: s.resource, items: [] };
			entry.items.push({ id: s.id, name: s.name });
			byFile.set(key, entry);
		}
		const defs = new Map<string, IMcpDefSummary>();
		await Promise.all([...byFile.values()].map(async file => {
			const raw = await this.readRaw(file.resource);
			let mcpServers: Record<string, unknown> = {};
			if (raw !== undefined) {
				try {
					const parsed = parseJsonc<{ mcpServers?: Record<string, unknown> }>(raw);
					mcpServers = (parsed?.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers : {};
				} catch { mcpServers = {}; }
			}
			for (const it of file.items) { defs.set(it.id, summarizeMcpDef(mcpServers[it.name])); }
		}));
		if (this.isPaneDisposed || gen !== this.cacheGeneration) { return; }
		// Discovered tools are keyed by server NAME (defs by row id). Prune a server's tools when its def changed.
		const prevDefs = this.mcpDefs;
		const changedNames = new Set<string>();
		for (const s of servers) {
			const prev = prevDefs.get(s.id);
			const next = defs.get(s.id);
			if (prev && next && !sameMcpDefSummary(prev, next)) { changedNames.add(s.name); }
		}
		const liveNames = new Set(servers.map(s => s.name));
		for (const name of [...this.mcpTabTools.keys()]) {
			if (changedNames.has(name) || !liveNames.has(name)) { this.mcpTabTools.delete(name); }
		}
		this.mcpDefs.clear();
		for (const [k, v] of defs) { this.mcpDefs.set(k, v); }
		if (this.tab === 'mcp') { this.render(); }
	}

	private toggleMcpExpand(id: string): void {
		this.expandedMcpServer = this.expandedMcpServer === id ? undefined : id;
		this.render();
	}

	private renderMcpServerRow(parent: HTMLElement, server: { id: string; name: string; scope: ConfigScope; resource: URI }, isProject: boolean, mcpState: ReturnType<typeof parseMcpSettings>): void {
		const expanded = this.expandedMcpServer === server.id;
		const def = this.mcpDefs.get(server.id);

		const row = append(parent, h('.clawdius-control-caprow'));
		const chevron = this.iconButton(row, expanded ? Codicon.chevronDown : Codicon.chevronRight,
			expanded ? localize('clawdius.control.mcp.hide', "Hide details") : localize('clawdius.control.mcp.show', "Show details"),
			() => this.toggleMcpExpand(server.id));
		chevron.classList.add('clawdius-control-skill-chevron');

		const info = append(row, h('.clawdius-control-cap-info'));
		const nameEl = append(info, h('.clawdius-control-cap-name'));
		append(nameEl, h('span')).textContent = server.name;
		if (def && def.transport !== 'unknown') {
			append(nameEl, h('span.clawdius-control-cap-origin.muted')).textContent = def.transport;
		}
		if (def?.detail) { append(info, h('.clawdius-control-cap-desc')).textContent = def.detail; }

		append(row, h('.clawdius-control-spacer'));
		if (isProject) {
			this.renderMcpApprovalControl(row, server.name, mcpState);
		} else {
			append(row, h('span.clawdius-control-skill-badge.checking')).textContent = localize('clawdius.control.mcp.configured', "configured");
		}

		// Edit / delete only when this server lives in the writable backing file for its scope. The global tab
		// also surfaces servers from non-writable files (e.g. enterprise-managed); those get no edit / delete.
		const formScope: 'global' | 'project' = isProject ? 'project' : 'global';
		const writable = isProject ? this.mcpWritableProject : this.mcpWritableGlobal;
		if (writable && isEqual(server.resource, writable)) {
			this.iconButton(row, Codicon.edit, localize('clawdius.control.mcp.editServer', "Edit server"), () => void this.openMcpEditForm(formScope, server.name));
			this.iconButton(row, Codicon.trash, localize('clawdius.control.mcp.deleteServer', "Delete server"), () => void this.deleteMcpServer(formScope, server.name), true);
		}

		// Inline edit form opens directly under the row it edits.
		if (this.mcpForm?.mode === 'edit' && this.mcpForm.scope === formScope && this.mcpForm.name === server.name) {
			this.renderMcpForm(parent);
		}
		if (expanded) { this.renderMcpServerPanel(parent, server, def); }
	}

	/** The 3-state Approved / Rejected / Default control for a project server (+ an effective-state hint). */
	private renderMcpApprovalControl(parent: HTMLElement, name: string, mcpState: ReturnType<typeof parseMcpSettings>): void {
		const wrap = append(parent, h('.clawdius-control-mcp-approval'));
		const current = mcpApproval(mcpState, name);
		const seg = append(wrap, h('.clawdius-control-seg.clawdius-control-seg-sm'));
		const opts: { value: McpApproval; label: string }[] = [
			{ value: 'approved', label: localize('clawdius.control.mcp.approved', "Approved") },
			{ value: 'rejected', label: localize('clawdius.control.mcp.rejected', "Rejected") },
			{ value: 'default', label: localize('clawdius.control.mcp.default', "Default") },
		];
		for (const opt of opts) {
			const b = append(seg, h('button.clawdius-control-mode')) as HTMLButtonElement;
			if (opt.value === current) { b.classList.add('active'); }
			append(b, h('span.clawdius-control-mode-name')).textContent = opt.label;
			b.setAttribute('aria-pressed', opt.value === current ? 'true' : 'false');
			this.renderStore.add(addDisposableListener(b, EventType.CLICK, () => void this.applyMcpApproval(name, opt.value)));
		}
		if (current === 'default' && mcpEffectiveApproval(mcpState, name) === 'approved-by-enable-all') {
			append(wrap, h('span.clawdius-control-mcp-eff')).textContent = localize('clawdius.control.mcp.effApproved', "approved by default");
		}
	}

	private renderMcpServerPanel(parent: HTMLElement, server: { id: string; name: string; scope: ConfigScope; resource: URI }, def: IMcpDefSummary | undefined): void {
		const panel = append(parent, h('.clawdius-control-skill-panel'));

		const defBlock = append(panel, h('.clawdius-control-mcp-def'));
		if (def && def.detail) {
			const line = append(defBlock, h('.clawdius-control-mcp-defline'));
			append(line, h('span.clawdius-control-skill-files-title')).textContent = def.transport;
			append(line, h('span.clawdius-control-mcp-detail')).textContent = def.detail;
		}
		if (def && def.envKeys.length > 0) {
			append(defBlock, h('.clawdius-control-mcp-secret')).textContent = localize('clawdius.control.mcp.env', "env: {0} (values hidden)", def.envKeys.join(', '));
		}
		if (def && def.headerKeys.length > 0) {
			append(defBlock, h('.clawdius-control-mcp-secret')).textContent = localize('clawdius.control.mcp.headers', "headers: {0} (values hidden)", def.headerKeys.join(', '));
		}
		this.button(defBlock, localize('clawdius.control.mcp.openDef', "Open definition"), () => void this.editorService.openEditor({ resource: server.resource, options: { pinned: true } }), 'link');

		// Tools + per-tool permissions.
		const hd = append(panel, h('.clawdius-control-bar'));
		append(hd, h('.clawdius-control-skill-files-title')).textContent = localize('clawdius.control.mcp.tools', "Tools + permissions");
		append(hd, h('.clawdius-control-spacer'));
		const tools = this.mcpTabTools.get(server.name);
		this.button(hd, tools && tools.tools.length > 0 ? localize('clawdius.control.mcp.reloadTools', "Reload tools") : localize('clawdius.control.mcp.loadTools', "Load tools"),
			() => void this.loadMcpToolsForServer(server.name), 'add', Codicon.refresh);

		// Server-level rule (all tools) is always available.
		this.renderMcpToolPermRow(panel, server.name, undefined);
		if (tools?.loading) {
			append(panel, h('.clawdius-control-skill-loading')).textContent = localize('clawdius.control.mcp.connecting', "Connecting to \"{0}\" to load its tools...", server.name);
		} else if (tools && tools.tools.length > 0) {
			for (const tool of tools.tools) { this.renderMcpToolPermRow(panel, server.name, tool.name); }
		} else if (tools && tools.message) {
			append(panel, h('.clawdius-control-skill-loading')).textContent = tools.message;
		} else {
			append(panel, h('.clawdius-control-addnote')).textContent = localize('clawdius.control.mcp.loadNote', "Load this server's tools to set per-tool rules. Connecting briefly runs the server (may execute a command or contact a remote service).");
		}
	}

	/** A permission row for an MCP rule (all tools = mcp__server, or a specific tool = mcp__server__tool). */
	private renderMcpToolPermRow(parent: HTMLElement, server: string, tool: string | undefined): void {
		const rule = mcpToolRule(server, tool ?? '');
		if (!rule) { return; }
		const state = this.snapshot?.kind === 'ok' ? parsePermissions(this.snapshot.settings) : undefined;
		const bucket: PermissionBucket | undefined = state?.allow.includes(rule) ? 'allow' : state?.ask.includes(rule) ? 'ask' : state?.deny.includes(rule) ? 'deny' : undefined;

		const row = append(parent, h('.clawdius-control-mcp-tool'));
		append(row, h('span.clawdius-control-skill-file-ico')).classList.add(...ThemeIcon.asClassNameArray(tool ? Codicon.tools : Codicon.server));
		append(row, h('span.clawdius-control-skill-file-name')).textContent = tool ?? localize('clawdius.control.mcp.allTools', "All tools");
		append(row, h('.clawdius-control-spacer'));
		const acts = append(row, h('.clawdius-control-mcp-permacts'));
		for (const meta of this.bucketMetas()) {
			const b = append(acts, h('button.clawdius-control-addmode')) as HTMLButtonElement;
			b.textContent = meta.label;
			if (bucket === meta.bucket) { b.classList.add('active'); }
			this.renderStore.add(addDisposableListener(b, EventType.CLICK, () => void this.apply({ type: 'addRule', bucket: meta.bucket, rule })));
		}
		if (bucket) {
			this.iconButton(acts, Codicon.clearAll, localize('clawdius.control.mcp.clearRule', "Clear rule"), () => void this.apply({ type: 'removeRule', bucket, rule }));
		}
	}

	private async loadMcpToolsForServer(server: string): Promise<void> {
		if (this.mcpTabTools.get(server)?.loading) { return; }
		this.mcpTabTools.set(server, { loading: true, tools: [], message: '' });
		this.render();
		const cwd = (this.workspaceService.getWorkspace().folders[0]?.uri ?? await this.pathService.userHome()).fsPath;
		let result: IClaudeMcpToolDiscoveryResult;
		try {
			result = await this.agentHostService.discoverMcpServerTools(server, cwd);
		} catch (err) {
			result = { status: 'error', tools: [], message: err instanceof Error ? err.message : String(err) };
		}
		if (this.isPaneDisposed) { return; }
		if (result.status === 'connected') {
			this.mcpTabTools.set(server, { loading: false, tools: result.tools, message: result.tools.length > 0 ? '' : localize('clawdius.control.mcp.noTools', "\"{0}\" connected but reported no tools.", server) });
		} else {
			this.mcpTabTools.set(server, { loading: false, tools: [], message: result.message ?? localize('clawdius.control.mcp.loadFailed', "Could not load tools ({0}).", result.status) });
		}
		this.render();
	}

	/** Approve / reject / reset a project server. Race-safe: recompute the array writes from a FRESH read.
	 *  `targetUri` pins the write (and its Undo) to the scope captured at action time, so an Undo after a scope
	 *  switch still lands in the original settings file. */
	private async applyMcpApproval(name: string, next: McpApproval, targetUri?: URI): Promise<void> {
		const uri = targetUri ?? await this.scopeUri(this.scope);
		if (!uri) { return; }
		const cls = classifySettings(await this.readRaw(uri));
		if (cls.kind === 'malformed') {
			this.notificationService.error(localize('clawdius.control.malformedSettings', "Can't save changes: {0} is not valid JSON. Fix the file and try again.", uri.fsPath));
			await this.load();
			return;
		}
		const latest = parseMcpSettings(cls.settings);
		const prev = mcpApproval(latest, name);
		if (prev === next) { return; }
		const writes = mcpApprovalWrites(latest, name, next);
		if (writes.length === 0) { return; }
		try {
			if (cls.needsSeed) { await this.fileService.writeFile(uri, VSBuffer.fromString('{}\n')); }
			await this.jsonEditing.write(uri, writes.map(w => ({ path: [...w.path], value: w.value })), true);
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.saveFailed', "Could not save changes: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		void this.configService.refresh(true);
		await this.load();
		const label = next === 'approved' ? localize('clawdius.control.mcp.toastApproved', "Approved \"{0}\"", name)
			: next === 'rejected' ? localize('clawdius.control.mcp.toastRejected', "Rejected \"{0}\"", name)
				: localize('clawdius.control.mcp.toastDefault', "Reset \"{0}\" to default", name);
		this.toast(label, () => void this.applyMcpApproval(name, prev, uri));
	}

	private async setEnableAllMcp(value: boolean): Promise<void> {
		const uri = await this.scopeUri(this.scope);
		if (!uri) { return; }
		await this.writeSettingsAtUri(uri, [enableAllProjectMcpServersWrite(value)],
			value ? localize('clawdius.control.mcp.allOn', "Approving all project MCP servers") : localize('clawdius.control.mcp.allOff', "No longer auto-approving project MCP servers"),
			() => void this.writeSettingsAtUri(uri, [enableAllProjectMcpServersWrite(!value)], localize('clawdius.control.mcp.allUndo', "Reverted")));
	}

	// --- Plugins tab ---

	private renderPluginsTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.control.plugins.title', "Plugins"),
			localize('clawdius.control.plugins.sub', "Browse marketplaces, install plugins, and enable or disable what's installed. Network actions run visibly in a terminal via the Claude Code CLI - the IDE makes no network calls."));

		// The marketplaces + catalog + installed list come from local files under ~/.claude/plugins. Kick the read
		// off lazily; the sections show a loading note until it lands (loadPluginsData then re-renders).
		if (!this.pluginsLoaded) { void this.loadPluginsData(); }

		// Installed plugins first, then Marketplaces. Each section's header carries an "Add" button that reveals
		// its add flow inline (plugins: add by id or browse marketplaces; marketplaces: add by source).
		this.renderInstalledSection(parent);
		this.renderMarketplacesSection(parent);
	}

	/** "Installed plugins" section: the enable/disable list, with an "Add plugin" header button that reveals an
	 *  inline panel offering add-by-id and browse-the-marketplaces. */
	private renderInstalledSection(parent: HTMLElement): void {
		// CLAWDIUS-BEGIN absence safety net: lead with a prominent banner when the critical Claude Code plugin is
		// missing (Clawdius needs it for the chat pane + sessions). Disappears after install (the extension-change
		// listener re-renders this tab).
		if (!isClaudeCodePluginInstalled(this.extensionsWorkbenchService.local)) {
			const banner = append(parent, h('.clawdius-control-block.clawdius-control-missing-plugin'));
			append(banner, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.plugins.missingTitle', "Claude Code plugin not installed");
			append(banner, h('.clawdius-control-missing-plugin-body')).textContent = localize('clawdius.control.plugins.missingBody', "The Claude Code plugin is not installed. Clawdius needs it for the chat pane and sessions.");
			const acts = append(banner, h('.clawdius-control-bar'));
			this.button(acts, localize('clawdius.control.plugins.installNow', "Install"), () => void this.commandService.executeCommand(INSTALL_CLAUDE_CODE_PLUGIN_COMMAND_ID), 'primary');
		}
		// CLAWDIUS-END
		const block = append(parent, h('.clawdius-control-block'));
		const hd = append(block, h('.clawdius-control-bar'));
		append(hd, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.plugins.listTitle', "Installed plugins");
		append(hd, h('.clawdius-control-spacer'));
		this.button(hd,
			this.pluginAddOpen ? localize('clawdius.control.plugins.addCancel', "Cancel") : localize('clawdius.control.plugins.addBtn', "Add plugin"),
			() => { this.pluginAddOpen = !this.pluginAddOpen; this.render(); },
			this.pluginAddOpen ? 'ghost' : 'add',
			this.pluginAddOpen ? Codicon.close : Codicon.add);

		if (this.pluginAddOpen) { this.renderPluginAddPanel(block); }

		const plugins = this.collectPlugins();
		if (plugins.length === 0) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.plugins.none', "No plugins installed yet. Use Add plugin to install one.");
			return;
		}
		for (const plugin of plugins) { this.renderPluginRow(block, plugin); }
	}

	/** The revealed "Add plugin" panel: add by id (Enable / Install in terminal) above browse-the-marketplaces. */
	private renderPluginAddPanel(parent: HTMLElement): void {
		const panel = append(parent, h('.clawdius-control-skill-panel'));
		append(panel, h('.clawdius-control-skill-files-title')).textContent = localize('clawdius.control.plugins.byId', "Add by id");
		this.renderPluginAdd(panel);
		append(panel, h('.clawdius-control-skill-files-title')).textContent = localize('clawdius.control.plugins.browseTitle', "Browse marketplaces");
		this.renderBrowseInline(panel);
	}

	/** Read the local plugin sources under ~/.claude/plugins (known marketplaces, every marketplace catalog, and the
	 *  installed list) and merge them into pluginsData, then re-render. All reads are local files - no network. A
	 *  missing / malformed file reads as empty. Guarded by isPaneDisposed + cacheGeneration so a slow read never
	 *  writes a stale result back over a cache that was cleared meanwhile. */
	private async loadPluginsData(): Promise<void> {
		if (this.pluginsLoaded) { return; }
		this.pluginsLoaded = true;
		const gen = this.cacheGeneration;
		const pluginsDir = URI.joinPath(await this.pathService.userHome(), '.claude', 'plugins');
		// Only keep marketplaces whose name is shell/path-safe: the name is used both in the catalog file path
		// below and in the Update/Remove terminal commands, so an unsafe name would read an unintended path or
		// render rows whose actions can never run. Real `claude plugin marketplace add` names are slugs.
		const marketplaces = parseKnownMarketplaces(await this.readJson(URI.joinPath(pluginsDir, 'known_marketplaces.json')))
			.filter(m => MARKETPLACE_NAME_RE.test(m.name));
		const installed = parseInstalledPlugins(await this.readJson(URI.joinPath(pluginsDir, 'installed_plugins.json')));
		const catalog: ICatalogPlugin[] = [];
		await Promise.all(marketplaces.map(async m => {
			const catalogUri = URI.joinPath(pluginsDir, 'marketplaces', m.name, '.claude-plugin', 'marketplace.json');
			catalog.push(...parseMarketplaceCatalog(await this.readJson(catalogUri), m.name));
		}));
		if (this.isPaneDisposed || gen !== this.cacheGeneration) { return; }
		catalog.sort((a, b) => a.name.localeCompare(b.name));
		this.pluginsData = { marketplaces, catalog, installed };
		if (this.tab === 'plugins') { this.render(); }
	}

	/** Re-read the local plugin sources (e.g. after a `claude plugin marketplace update` in the terminal). Keeps the
	 *  current data visible until the fresh read lands (no Loading flash). */
	private refreshPluginsData(): void {
		// Bump the generation so any load still in flight (e.g. from a config-change refresh) is invalidated and
		// cannot finish out of order and overwrite this fresh read with stale data.
		this.cacheGeneration++;
		this.pluginsLoaded = false;
		void this.loadPluginsData();
	}

	/** Read + JSON.parse a local file, or undefined if it is missing / unreadable / not valid JSON. */
	private async readJson(uri: URI): Promise<unknown> {
		const raw = await this.readRaw(uri);
		if (raw === undefined) { return undefined; }
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	/** "Marketplaces" section: an add-marketplace row plus one row per known marketplace (Update / Remove). */
	private renderMarketplacesSection(parent: HTMLElement): void {
		const block = append(parent, h('.clawdius-control-block'));
		const hd = append(block, h('.clawdius-control-bar'));
		append(hd, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.plugins.marketplacesTitle', "Marketplaces");
		append(hd, h('.clawdius-control-spacer'));
		this.button(hd, localize('clawdius.control.plugins.refresh', "Refresh"), () => this.refreshPluginsData(), 'ghost', Codicon.refresh);
		this.button(hd,
			this.marketplaceAddOpen ? localize('clawdius.control.plugins.marketplaceAddCancel', "Cancel") : localize('clawdius.control.plugins.marketplaceAddBtn', "Add marketplace"),
			() => { this.marketplaceAddOpen = !this.marketplaceAddOpen; this.render(); },
			this.marketplaceAddOpen ? 'ghost' : 'add',
			this.marketplaceAddOpen ? Codicon.close : Codicon.add);

		if (this.marketplaceAddOpen) {
			const wrap = append(block, h('.clawdius-control-mcp-addform'));
			const row = append(wrap, h('.clawdius-control-addrow'));
			const input = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
			input.type = 'text';
			input.value = this.addMarketplaceValue;
			input.placeholder = localize('clawdius.control.plugins.marketplacePh', "github-owner/repo, URL, or path");
			input.setAttribute('aria-label', localize('clawdius.control.plugins.marketplaceLabel', "Marketplace source"));
			this.renderStore.add(addDisposableListener(input, EventType.INPUT, () => { this.addMarketplaceValue = input.value; }));
			this.button(row, localize('clawdius.control.plugins.marketplaceAdd', "Add"), () => void this.marketplaceAddInTerminal(this.addMarketplaceValue), 'add', Codicon.add);
			append(wrap, h('.clawdius-control-addnote')).textContent = localize('clawdius.control.plugins.marketplaceAddNote', "Opens a terminal with `claude plugin marketplace add` ready to run. The IDE makes no network calls.");
		}

		if (!this.pluginsData) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.plugins.loading', "Loading...");
			return;
		}
		if (this.pluginsData.marketplaces.length === 0) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.plugins.noMarketplaces', "No marketplaces yet. Use Add marketplace to add one.");
			return;
		}
		for (const marketplace of this.pluginsData.marketplaces) { this.renderMarketplaceRow(block, marketplace); }
	}

	private renderMarketplaceRow(parent: HTMLElement, marketplace: IMarketplace): void {
		const row = append(parent, h('.clawdius-control-caprow'));
		const info = append(row, h('.clawdius-control-cap-info'));
		const nameEl = append(info, h('.clawdius-control-cap-name'));
		append(nameEl, h('span')).textContent = marketplace.name;
		if (marketplace.autoUpdate) {
			append(nameEl, h('span.clawdius-control-cap-origin.muted')).textContent = localize('clawdius.control.plugins.autoUpdate', "auto-update");
		}
		// Date is shown as a raw YYYY-MM-DD slice (no locale formatting) to stay stable + ASCII.
		const updated = marketplace.lastUpdated ? marketplace.lastUpdated.slice(0, 10) : undefined;
		let desc: string | undefined;
		if (marketplace.sourceLabel && updated) {
			desc = localize('clawdius.control.plugins.sourceUpdated', "{0} - updated {1}", marketplace.sourceLabel, updated);
		} else if (marketplace.sourceLabel) {
			desc = marketplace.sourceLabel;
		} else if (updated) {
			desc = localize('clawdius.control.plugins.updatedOnly', "updated {0}", updated);
		}
		if (desc) { append(info, h('.clawdius-control-cap-desc')).textContent = desc; }
		append(row, h('.clawdius-control-spacer'));
		this.button(row, localize('clawdius.control.plugins.update', "Update"), () => void this.marketplaceCmdInTerminal('update', marketplace.name), 'ghost');
		this.button(row, localize('clawdius.control.plugins.remove', "Remove"), () => void this.marketplaceCmdInTerminal('remove', marketplace.name), 'danger');
	}

	/** Browse-the-marketplaces list (rendered inline inside the Add-plugin panel): a search box over every marketplace
	 *  catalog, with Install (or an enable/disable toggle when already installed). The catalog can be large, so the
	 *  unfiltered view is capped. */
	private renderBrowseInline(parent: HTMLElement): void {
		const block = parent;

		if (!this.pluginsData) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.plugins.loading', "Loading...");
			return;
		}
		const data = this.pluginsData;
		if (data.catalog.length === 0) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.plugins.noCatalog', "No plugins to browse yet. Add a marketplace above, then run Update on it.");
			return;
		}

		const searchRow = append(block, h('.clawdius-control-addrow'));
		const input = append(searchRow, h('input.clawdius-control-input.clawdius-control-plugin-search')) as HTMLInputElement;
		input.type = 'text';
		input.value = this.pluginFilter;
		input.placeholder = localize('clawdius.control.plugins.searchPh', "Search plugins...");
		input.setAttribute('aria-label', localize('clawdius.control.plugins.searchLabel', "Search plugins"));
		this.pluginSearchInput = input;
		// Filtering re-renders the whole tab, which replaces this input element. render() is synchronous and re-runs
		// this method, re-setting pluginSearchInput to the fresh input - re-focus it and restore the caret so typing
		// is not interrupted.
		this.renderStore.add(addDisposableListener(input, EventType.INPUT, () => {
			this.pluginFilter = input.value;
			const caret = input.selectionStart ?? input.value.length;
			this.render();
			this.pluginSearchInput?.focus();
			this.pluginSearchInput?.setSelectionRange(caret, caret);
		}));

		const installedIds = new Set(data.installed.map(p => p.id));
		const statusById = new Map<string, string>(this.collectPlugins().map(p => [p.id, p.status] as const));
		const filter = this.pluginFilter.trim().toLowerCase();
		const matchesFilter = (p: ICatalogPlugin): boolean => filter.length === 0
			|| p.name.toLowerCase().includes(filter)
			|| (p.description ? p.description.toLowerCase().includes(filter) : false)
			|| (p.author ? p.author.toLowerCase().includes(filter) : false)
			|| p.marketplace.toLowerCase().includes(filter);

		// Group the catalog under collapsible marketplace headers. The official catalog is large, so groups are
		// collapsed by default and capped when open; a search auto-expands every group that still has a match.
		const perGroupCap = 60;
		let shownAnything = false;
		for (const marketplace of data.marketplaces) {
			const all = data.catalog.filter(p => p.marketplace === marketplace.name);
			if (all.length === 0) { continue; }
			const matched = all.filter(matchesFilter);
			if (filter.length > 0 && matched.length === 0) { continue; }
			shownAnything = true;
			const installedHere = all.filter(p => installedIds.has(p.id)).length;
			const expanded = filter.length > 0 || this.expandedMarketplaces.has(marketplace.name);

			const header = append(block, h('.clawdius-control-skill-file.dir'));
			const chevron = this.iconButton(header,
				expanded ? Codicon.chevronDown : Codicon.chevronRight,
				expanded ? localize('clawdius.control.plugins.collapseGroup', "Collapse") : localize('clawdius.control.plugins.expandGroup', "Expand"),
				() => {
					if (this.expandedMarketplaces.has(marketplace.name)) { this.expandedMarketplaces.delete(marketplace.name); } else { this.expandedMarketplaces.add(marketplace.name); }
					this.render();
				});
			chevron.classList.add('clawdius-control-skill-tree-chevron');
			append(header, h('span.clawdius-control-skill-file-name')).textContent = marketplace.name;
			const count = filter.length > 0
				? localize('clawdius.control.plugins.groupCountFiltered', "{0} of {1}", matched.length, all.length)
				: all.length === 1
					? localize('clawdius.control.plugins.groupCountOne', "1 plugin")
					: localize('clawdius.control.plugins.groupCount', "{0} plugins", all.length);
			append(header, h('span.clawdius-control-skill-file-count')).textContent = installedHere > 0
				? localize('clawdius.control.plugins.groupCountInstalled', "{0}, {1} installed", count, installedHere)
				: count;

			if (!expanded) { continue; }
			const capped = filter.length === 0 && matched.length > perGroupCap;
			const shown = capped ? matched.slice(0, perGroupCap) : matched;
			for (const plugin of shown) {
				this.renderCatalogRow(block, plugin, installedIds.has(plugin.id), statusById.get(plugin.id));
			}
			if (capped) {
				append(block, h('.clawdius-control-addnote')).textContent = localize('clawdius.control.plugins.capped', "Showing first {0} of {1} - search to narrow.", perGroupCap, matched.length);
			}
		}
		if (!shownAnything) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.plugins.noMatches', "No plugins match \"{0}\".", this.pluginFilter.trim());
		}
	}

	/** A single catalog plugin: name + category + author + description, then actions - an optional Homepage link, a
	 *  Details hand-off, and either the enable/disable toggle (installed) or an Install hand-off (not installed). */
	private renderCatalogRow(parent: HTMLElement, plugin: ICatalogPlugin, installed: boolean, status: string | undefined): void {
		const row = append(parent, h('.clawdius-control-caprow'));
		const info = append(row, h('.clawdius-control-cap-info'));
		const nameEl = append(info, h('.clawdius-control-cap-name'));
		append(nameEl, h('span')).textContent = plugin.name;
		if (plugin.category) { append(nameEl, h('span.clawdius-control-cap-origin')).textContent = plugin.category; }
		if (plugin.author) { append(nameEl, h('span.clawdius-control-cap-origin.muted')).textContent = localize('clawdius.control.plugins.byAuthor', "by {0}", plugin.author); }
		const desc = this.truncate(plugin.description, 160);
		if (desc) { append(info, h('.clawdius-control-cap-desc')).textContent = desc; }
		append(row, h('.clawdius-control-spacer'));
		if (plugin.homepage) {
			const homepage = plugin.homepage;
			this.button(row, localize('clawdius.control.plugins.homepage', "Homepage"), () => void this.openPluginHomepage(homepage), 'link', Codicon.linkExternal);
		}
		this.button(row, localize('clawdius.control.plugins.details', "Details"), () => void this.pluginDetailsInTerminal(plugin.id), 'link', Codicon.info);
		if (installed) {
			this.appendToggle(row, status !== 'disabled', plugin.name, next => void this.setPluginEnabled(plugin.id, next));
		} else {
			this.button(row, localize('clawdius.control.plugins.installBtn', "Install"), () => void this.installCatalogPlugin(plugin.id), 'primary', Codicon.cloudDownload);
		}
	}

	/** Open a plugin's homepage in the external browser. Only http(s) URLs reach here (the catalog parser drops the
	 *  rest), but re-check the scheme before handing it to the opener. */
	private async openPluginHomepage(url: string): Promise<void> {
		let uri: URI;
		try { uri = URI.parse(url, true); } catch { return; }
		if (uri.scheme !== 'http' && uri.scheme !== 'https') {
			this.toast(localize('clawdius.control.plugins.badHomepage', "That plugin's homepage isn't a web link."));
			return;
		}
		await this.openerService.open(uri, { openExternal: true });
	}

	/** Show a plugin's component inventory + projected token cost via the CLI in a terminal (gated on PLUGIN_ID_RE). */
	private async pluginDetailsInTerminal(id: string): Promise<void> {
		if (!PLUGIN_ID_RE.test(id)) { this.toast(localize('clawdius.control.plugins.badId', "Enter a plugin id as plugin-id@marketplace-id.")); return; }
		await this.sendClaudeCommandToTerminal(`claude plugin details ${id}`);
	}

	/** Trim + cap free text for display, appending an ellipsis when cut. Empty / missing text returns undefined. */
	private truncate(text: string | undefined, max: number): string | undefined {
		const trimmed = (text ?? '').trim();
		if (trimmed.length === 0) { return undefined; }
		return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}...` : trimmed;
	}

	/** Enable a plugin by id (writes enabledPlugins) and/or install it via the CLI in an integrated terminal. */
	private renderPluginAdd(parent: HTMLElement): void {
		const wrap = append(parent, h('.clawdius-control-mcp-addform'));
		const row = append(wrap, h('.clawdius-control-addrow'));
		const input = append(row, h('input.clawdius-control-input')) as HTMLInputElement;
		input.type = 'text';
		input.value = this.pluginAddForm?.id ?? '';
		input.placeholder = localize('clawdius.control.plugins.idPh', "plugin-id@marketplace-id");
		input.setAttribute('aria-label', localize('clawdius.control.plugins.idLabel', "Plugin id"));
		this.renderStore.add(addDisposableListener(input, EventType.INPUT, () => { this.pluginAddForm = { id: input.value }; }));
		this.button(row, localize('clawdius.control.plugins.enable', "Enable"), () => void this.enablePluginById(), 'primary');
		this.button(row, localize('clawdius.control.plugins.install', "Install in terminal"), () => void this.installPluginInTerminal(), 'link');
		append(wrap, h('.clawdius-control-addnote')).textContent = localize('clawdius.control.plugins.addNote', "Enable writes enabledPlugins (the plugin must already be installed). Install in terminal opens a terminal with `claude plugin install` ready to run.");
	}

	private async enablePluginById(): Promise<void> {
		const id = (this.pluginAddForm?.id ?? '').trim();
		if (!PLUGIN_ID_RE.test(id)) {
			this.toast(localize('clawdius.control.plugins.badId', "Enter a plugin id as plugin-id@marketplace-id."));
			return;
		}
		const uri = await this.scopeUri('global');
		if (!uri) { return; }
		this.pluginAddForm = undefined;
		await this.writeSettingsAtUri(uri, [pluginEnabledWrite(id, 'on')],
			localize('clawdius.control.plugins.enabledToast', "Enabled \"{0}\"", id),
			() => void this.writeSettingsAtUri(uri, [pluginEnabledWrite(id, 'unset')], localize('clawdius.control.plugins.undo', "Reverted \"{0}\"", id)));
	}

	private async installPluginInTerminal(): Promise<void> {
		const id = (this.pluginAddForm?.id ?? '').trim();
		// An id is optional (you can complete the command in the terminal), but if given it must be the strict
		// plugin-id shape - never let arbitrary text reach a shell command.
		if (id && !PLUGIN_ID_RE.test(id)) {
			this.toast(localize('clawdius.control.plugins.badIdInstall', "That isn't a valid plugin-id@marketplace-id."));
			return;
		}
		// Pre-fill the install command (not auto-run) so the user reviews + handles any marketplace prompts.
		await this.sendClaudeCommandToTerminal(id ? `claude plugin install ${id}` : 'claude plugin install ');
	}

	/** Hand a `claude ...` command to a fresh integrated terminal WITHOUT auto-running it (sendText `false`), so the
	 *  user reviews + runs it themselves. This is the ONLY way the Plugins tab touches the network: the IDE never
	 *  makes the call - the user's `claude` CLI does, visibly. cwd is the first workspace folder, else the home dir. */
	private async sendClaudeCommandToTerminal(command: string): Promise<void> {
		const cwd = this.workspaceService.getWorkspace().folders[0]?.uri ?? await this.pathService.userHome();
		const instance = await this.terminalService.createTerminal({ cwd });
		this.terminalService.setActiveInstance(instance);
		this.terminalGroupService.showPanel(true);
		instance.sendText(command, false);
	}

	/** Add a marketplace via the CLI in a terminal. The source can be a github owner/repo, a URL, or a local path,
	 *  so it is NOT shape-restricted; we reject only an empty value or one with a newline, and never auto-run it
	 *  (sendText `false`) so the user reviews the command. */
	private async marketplaceAddInTerminal(source: string): Promise<void> {
		const trimmed = source.trim();
		// The source is interpolated into a terminal command staged via sendText(.., false) - one Enter from
		// running. Reject command-injection metacharacters (see isSafeMarketplaceSource) so a pasted/odd value
		// can't stage an injection. A github owner/repo, an https/git URL, or a filesystem path (incl. Windows
		// backslashes + spaces) uses none of these.
		if (!isSafeMarketplaceSource(source)) {
			this.toast(localize('clawdius.control.plugins.badMarketplace', "Enter a marketplace as a github owner/repo, URL, or local path (no shell metacharacters)."));
			return;
		}
		this.addMarketplaceValue = '';
		await this.sendClaudeCommandToTerminal(`claude plugin marketplace add ${trimmed}`);
	}

	/** Update or remove a known marketplace by name. The name comes from a parsed local file, but it is still gated
	 *  on MARKETPLACE_NAME_RE so nothing shell-unsafe can reach the command. */
	private async marketplaceCmdInTerminal(sub: 'update' | 'remove', name: string): Promise<void> {
		if (!MARKETPLACE_NAME_RE.test(name)) {
			this.toast(localize('clawdius.control.plugins.badMarketplaceName', "That marketplace name isn't valid."));
			return;
		}
		await this.sendClaudeCommandToTerminal(`claude plugin marketplace ${sub} ${name}`);
	}

	/** Install a catalog plugin by `plugin-id@marketplace-id` via the CLI in a terminal (gated on PLUGIN_ID_RE). */
	private async installCatalogPlugin(id: string): Promise<void> {
		if (!PLUGIN_ID_RE.test(id)) {
			this.toast(localize('clawdius.control.plugins.badId', "Enter a plugin id as plugin-id@marketplace-id."));
			return;
		}
		await this.sendClaudeCommandToTerminal(`claude plugin install ${id}`);
	}

	/** Installed + configured plugins from the scanned config (global; the CLI scopes plugins globally). Each row
	 *  carries the plugin's bundled contents (skills / agents / commands / hooks) for the expandable contents view. */
	private collectPlugins(): { id: string; status: string; contents: readonly IConfigItem[] }[] {
		const map = new Map<string, { status: string; contents: readonly IConfigItem[] }>();
		for (const scope of this.configService.snapshot.scopes) {
			for (const sec of scope.sections) {
				if (sec.section !== ConfigSection.Plugins) { continue; }
				for (const item of sec.items) { map.set(item.label, { status: item.description ?? 'installed', contents: item.children ?? [] }); }
			}
		}
		return [...map.entries()].map(([id, v]) => ({ id, status: v.status, contents: v.contents })).sort((a, b) => a.id.localeCompare(b.id));
	}

	private renderPluginRow(parent: HTMLElement, plugin: { id: string; status: string; contents: readonly IConfigItem[] }): void {
		// Plugin ids are `plugin-id@marketplace-id`; show the plugin name, its marketplace as a muted origin, and the
		// status + a contents summary as the description.
		const at = plugin.id.indexOf('@');
		const name = at > 0 ? plugin.id.slice(0, at) : plugin.id;
		const marketplace = at > 0 ? plugin.id.slice(at + 1) : undefined;
		const statusLabel = this.pluginStatusLabel(plugin.status);
		const hasContents = plugin.contents.length > 0;
		const expanded = hasContents && this.expandedPlugin === plugin.id;

		const row = append(parent, h('.clawdius-control-caprow'));
		// Expand chevron reveals the bundled contents; plugins with no scanned contents get an aligning spacer.
		if (hasContents) {
			const chevron = this.iconButton(row,
				expanded ? Codicon.chevronDown : Codicon.chevronRight,
				expanded ? localize('clawdius.control.plugins.hideContents', "Hide contents") : localize('clawdius.control.plugins.showContents', "Show contents"),
				() => this.togglePluginExpand(plugin.id));
			chevron.classList.add('clawdius-control-skill-chevron');
		} else {
			append(row, h('.clawdius-control-skill-chevron-spacer'));
		}

		const info = append(row, h('.clawdius-control-cap-info'));
		const nameEl = append(info, h('.clawdius-control-cap-name'));
		append(nameEl, h('span')).textContent = name;
		if (marketplace) { append(nameEl, h('span.clawdius-control-cap-origin.muted')).textContent = marketplace; }
		const summary = this.pluginContentsSummary(plugin.contents);
		append(info, h('.clawdius-control-cap-desc')).textContent = summary
			? localize('clawdius.control.plugins.statusContents', "{0} - {1}", statusLabel, summary)
			: statusLabel;

		append(row, h('.clawdius-control-spacer'));
		// 'installed' (no explicit enabledPlugins entry) and 'enabled' both read as on; only 'disabled' is off.
		this.appendToggle(row, plugin.status !== 'disabled', name, next => void this.setPluginEnabled(plugin.id, next));

		if (expanded) { this.renderPluginContentsPanel(parent, plugin.contents); }
	}

	private togglePluginExpand(id: string): void {
		this.expandedPlugin = this.expandedPlugin === id ? undefined : id;
		this.render();
	}

	/** A short "13 skills - 1 agent - 7 commands" summary of a plugin's bundled contents (omits empty sections). */
	private pluginContentsSummary(contents: readonly IConfigItem[]): string {
		const n = (section: ConfigSection) => contents.filter(c => c.section === section).length;
		const parts: string[] = [];
		const nSkills = n(ConfigSection.Skills);
		const nAgents = n(ConfigSection.Agents);
		const nCommands = n(ConfigSection.Commands);
		const nHooks = n(ConfigSection.Hooks);
		if (nSkills > 0) { parts.push(nSkills === 1 ? localize('clawdius.control.plugins.oneSkill', "1 skill") : localize('clawdius.control.plugins.nSkills', "{0} skills", nSkills)); }
		if (nAgents > 0) { parts.push(nAgents === 1 ? localize('clawdius.control.plugins.oneAgent', "1 agent") : localize('clawdius.control.plugins.nAgents', "{0} agents", nAgents)); }
		if (nCommands > 0) { parts.push(nCommands === 1 ? localize('clawdius.control.plugins.oneCommand', "1 command") : localize('clawdius.control.plugins.nCommands', "{0} commands", nCommands)); }
		if (nHooks > 0) { parts.push(nHooks === 1 ? localize('clawdius.control.plugins.oneHook', "1 hook") : localize('clawdius.control.plugins.nHooks', "{0} hooks", nHooks)); }
		return parts.join(' - ');
	}

	/** The expanded plugin's bundled contents, grouped by kind (Skills / Agents / Commands / Hooks). Each entry opens
	 *  its own file. Mirrors the skill-package file panel's look. */
	private renderPluginContentsPanel(parent: HTMLElement, contents: readonly IConfigItem[]): void {
		const panel = append(parent, h('.clawdius-control-skill-panel'));
		const groups: { section: ConfigSection; title: string }[] = [
			{ section: ConfigSection.Skills, title: localize('clawdius.control.plugins.contents.skills', "Skills") },
			{ section: ConfigSection.Agents, title: localize('clawdius.control.plugins.contents.agents', "Agents") },
			{ section: ConfigSection.Commands, title: localize('clawdius.control.plugins.contents.commands', "Commands") },
			{ section: ConfigSection.Hooks, title: localize('clawdius.control.plugins.contents.hooks', "Hooks") },
		];
		let any = false;
		for (const g of groups) {
			const items = contents.filter(c => c.section === g.section);
			if (items.length === 0) { continue; }
			any = true;
			append(panel, h('.clawdius-control-skill-files-title')).textContent = g.title;
			const list = append(panel, h('.clawdius-control-skill-filelist'));
			for (const item of items) { this.renderPluginContentRow(list, item); }
		}
		if (!any) {
			append(panel, h('.clawdius-control-skill-emptyfiles')).textContent = localize('clawdius.control.plugins.contents.none', "This plugin bundles no skills, agents, commands, or hooks.");
		}
	}

	private renderPluginContentRow(list: HTMLElement, item: IConfigItem): void {
		const row = append(list, h('.clawdius-control-skill-file'));
		append(row, h('.clawdius-control-skill-tree-twistyspace')); // align under the skill-panel folder icons
		append(row, h('span.clawdius-control-skill-file-ico')).classList.add(...ThemeIcon.asClassNameArray(this.pluginContentIcon(item.section)));
		append(row, h('span.clawdius-control-skill-file-name')).textContent = item.label;
		if (item.section === ConfigSection.Hooks && item.description) {
			append(row, h('span.clawdius-control-skill-file-count')).textContent = item.description;
		}
		append(row, h('.clawdius-control-spacer'));
		if (item.resource) {
			const resource = item.resource;
			const acts = append(row, h('.clawdius-control-cap-acts'));
			this.iconButton(acts, Codicon.goToFile, localize('clawdius.control.plugins.contents.open', "Open"), () => void this.editorService.openEditor({ resource, options: { pinned: true } }));
		}
	}

	private pluginContentIcon(section: ConfigSection): ThemeIcon {
		switch (section) {
			case ConfigSection.Skills: return Codicon.lightbulb;
			case ConfigSection.Agents: return Codicon.organization;
			case ConfigSection.Commands: return Codicon.terminal;
			case ConfigSection.Hooks: return Codicon.symbolEvent;
			default: return Codicon.file;
		}
	}

	private pluginStatusLabel(status: string): string {
		switch (status) {
			case 'enabled': return localize('clawdius.control.plugins.statusEnabled', "enabled");
			case 'disabled': return localize('clawdius.control.plugins.statusDisabled', "disabled");
			default: return localize('clawdius.control.plugins.statusInstalled', "installed");
		}
	}

	private async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
		const uri = await this.scopeUri('global'); // plugins are a global concept in the CLI
		if (!uri) { return; }
		const next: PluginState = enabled ? 'on' : 'off';
		const prev: PluginState = enabled ? 'off' : 'on';
		await this.writeSettingsAtUri(uri, [pluginEnabledWrite(id, next)],
			enabled ? localize('clawdius.control.plugins.toastOn', "Enabled \"{0}\"", id) : localize('clawdius.control.plugins.toastOff', "Disabled \"{0}\"", id),
			() => void this.writeSettingsAtUri(uri, [pluginEnabledWrite(id, prev)], localize('clawdius.control.plugins.undo', "Reverted \"{0}\"", id)));
	}

	private toast(message: string, onUndo?: () => void): void {
		// Stack, don't clobber: a rapid second action must not erase the first action's Undo before the user can
		// reach it. Cap the stack so a burst can't pile up unbounded - drop the oldest to make room.
		while (this.toasts.length >= ClaudeControlCenterEditor.MAX_TOASTS) {
			this.dismissToast(this.toasts[0]);
		}
		const store = new DisposableStore();
		this.toasts.push(store);
		const el = append(this.container, h('.clawdius-control-toast'));
		store.add(toDisposable(() => el.remove()));
		append(el, h('span')).textContent = message;
		if (onUndo) {
			const undoBtn = append(el, h('button.clawdius-control-undo')) as HTMLButtonElement;
			undoBtn.textContent = localize('clawdius.control.undo', "Undo");
			store.add(addDisposableListener(undoBtn, EventType.CLICK, () => { this.dismissToast(store); onUndo(); }));
		}
		store.add(disposableTimeout(() => this.dismissToast(store), 5000));
	}

	/** Remove a single toast (its DOM, Undo listener, and timer) without touching the others in the stack. */
	private dismissToast(store: DisposableStore): void {
		const i = this.toasts.indexOf(store);
		if (i < 0) { return; }
		this.toasts.splice(i, 1);
		store.dispose();
	}

	private async openSettings(): Promise<void> {
		const uri = await this.scopeUri(this.scope);
		if (uri) { await this.editorService.openEditor({ resource: uri, options: { pinned: true } }); }
	}

	private block(parent: HTMLElement, title: string): HTMLElement {
		const block = append(parent, h('.clawdius-control-block'));
		append(block, h('.clawdius-control-block-title')).textContent = title;
		return block;
	}

	/** `store` defaults to the pane-wide renderStore; the MCP form passes its own mcpFormStore so a subtree rebuild
	 *  disposes the form's button listeners without touching the rest of the pane. */
	private button(parent: HTMLElement, label: string, onClick: () => void, variant?: BtnVariant, icon?: ThemeIcon, store: DisposableStore = this.renderStore): HTMLButtonElement {
		const btn = append(parent, h(`button.clawdius-control-btn${variant ? '.' + variant : ''}`)) as HTMLButtonElement;
		if (icon) { append(btn, h('span.clawdius-control-btn-ico')).classList.add(...ThemeIcon.asClassNameArray(icon)); }
		append(btn, h('span')).textContent = label;
		store.add(addDisposableListener(btn, EventType.CLICK, () => onClick()));
		return btn;
	}

	/** A compact icon-only button; aria-label + tooltip carry the meaning. `store` defaults to the pane-wide
	 *  renderStore; the MCP form passes its own mcpFormStore (see `button`). */
	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, onClick: () => void, danger?: boolean, store: DisposableStore = this.renderStore): HTMLButtonElement {
		const btn = append(parent, h(`button.clawdius-control-iconbtn${danger ? '.danger' : ''}`)) as HTMLButtonElement;
		append(btn, h('span')).classList.add(...ThemeIcon.asClassNameArray(icon));
		btn.title = label;
		btn.setAttribute('aria-label', label);
		store.add(addDisposableListener(btn, EventType.CLICK, () => onClick()));
		return btn;
	}

	private bucketIcon(bucket: PermissionBucket): ThemeIcon {
		switch (bucket) {
			case 'allow': return Codicon.check;
			case 'ask': return Codicon.question;
			case 'deny': return Codicon.circleSlash;
		}
	}

	// --- metadata ---

	private scopeMetas(): IScopeMeta[] {
		const hasFolder = this.workspaceService.getWorkspace().folders.length > 0;
		const metas: IScopeMeta[] = [{
			scope: 'global',
			label: localize('clawdius.control.scope.global', "Global"),
			hint: localize('clawdius.control.scope.global.hint', "Defaults for every project on this machine."),
			file: '~/.claude/settings.json',
		}];
		if (hasFolder) {
			metas.push({
				scope: 'project',
				label: localize('clawdius.control.scope.project', "Project (shared)"),
				hint: localize('clawdius.control.scope.project.hint', "Committed to the repo - applies for everyone working on this project."),
				file: '.claude/settings.json',
			});
			metas.push({
				scope: 'projectLocal',
				label: localize('clawdius.control.scope.local', "Project (personal)"),
				hint: localize('clawdius.control.scope.local.hint', "Your own overrides for this project - git-ignored, not shared."),
				file: '.claude/settings.local.json',
			});
		}
		return metas;
	}

	private bucketMetas(): IBucketMeta[] {
		return [
			{ bucket: 'allow', label: localize('clawdius.control.allow', "Allow") },
			{ bucket: 'ask', label: localize('clawdius.control.ask', "Ask") },
			{ bucket: 'deny', label: localize('clawdius.control.deny', "Deny") },
		];
	}

	private bucketLabel(bucket: PermissionBucket): string {
		return this.bucketMetas().find(m => m.bucket === bucket)!.label;
	}

}
// CLAWDIUS-END
