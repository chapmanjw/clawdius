/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
// `this.tab` dispatches the body. Permissions + Skills are built; MCP/Plugins/Hooks are "soon" stubs that land
// in later increments. Per-tab parse/write logic lives in pure models (claudePermissionsModel,
// claudeControlTabsModel) so the pane only does file IO, IJSONEditingService.write, and DOM.

import './media/claudeControlCenter.css';
import { $ as h, addDisposableListener, append, clearNode, Dimension, EventType, size } from '../../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
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
import { CONFIG_DELETE_COMMAND_ID, configCreateCommandId } from '../clawdiusConfigActions.js';
import {
	ALLOW_BYPASS_KEY, INITIAL_PERMISSION_MODE_KEY, PermissionMode, parsePermissionMode, permissionModeWrites, permissionModes,
} from '../clawdiusPermissionModeStatusEntry.js';
import { ClaudeControlCenterInput, ControlTab } from './claudeControlCenterInput.js';
import { ClaudeUsageDashboardView } from '../usage/claudeUsageDashboardView.js';
import { BUILTIN_TOOLS, IJsonWrite, IPermissionsState, PERMISSION_BUCKETS, PermissionBucket, builtinRule, mcpToolRule, parsePermissions, parseRule } from './claudePermissionsModel.js';
import {
	ControlScope, PermissionIntent, classifySettings, invertIntent, planPermissionIntent, resolvePermissionsSettingsUri,
} from './claudeControlCenterData.js';
import {
	ISkillsState, PluginState, SkillOverride, disableAllHooksWrite, disableBundledSkillsWrite, parseDisableAllHooks, parseSkills, pluginEnabledWrite, skillOverrideWrite,
} from './claudeControlTabsModel.js';
import { ISkillIssue, ISkillValidation, validateSkillPackage } from './claudeSkillValidationModel.js';
import {
	IMcpDefSummary, McpApproval, McpTransport, enableAllProjectMcpServersWrite, mcpApproval, mcpApprovalWrites, mcpEffectiveApproval, parseMcpSettings, summarizeMcpDef,
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
const PLUGIN_ID_RE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/;
type BtnVariant = 'primary' | 'ghost' | 'link' | 'danger' | 'add';

export class ClaudeControlCenterEditor extends EditorPane {

	static readonly ID = 'workbench.editor.clawdiusControlCenter';

	private container!: HTMLElement;
	private content: HTMLElement | undefined;
	private toastEl: HTMLElement | undefined;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly toastStore = this._register(new DisposableStore());
	private readonly toastTimer = this._register(new MutableDisposable());

	private scope: ControlScope = 'global';
	private tab: ControlTab = 'usage';
	private snapshot: Snapshot | undefined;
	/** The Usage tab hosts the shared usage dashboard view; kept alive only while that tab is showing. */
	private readonly usageView = this._register(new MutableDisposable<ClaudeUsageDashboardView>());

	// Skills tab package state (keyed by the skill folder fsPath). Caches are cleared on a config change; the
	// generation counter bumps on every clear so a slower in-flight read never writes a stale result back.
	private expandedSkill: string | undefined;
	private cacheGeneration = 0;
	private isPaneDisposed = false;
	private readonly skillValidations = new Map<string, ISkillValidation>();
	private readonly skillValidating = new Set<string>();
	private readonly skillFiles = new Map<string, readonly ISkillFileEntry[]>();
	private readonly skillFilesLoading = new Set<string>();
	/** Expanded subdirectories in an expanded skill's file tree, keyed by directory fsPath. Default: collapsed. */
	private readonly expandedSkillDirs = new Set<string>();
	private skillFileForm: { folderPath: string; target: string; name: string } | undefined;

	// MCP tab state. Defs (read from the backing JSON) are keyed by row id (scope::name); discovered tools are
	// keyed by server name (discovery targets Claude's effective runtime server). Caches share cacheGeneration.
	private expandedMcpServer: string | undefined;
	private readonly mcpDefs = new Map<string, IMcpDefSummary>();
	private mcpDefsLoaded = false;
	private readonly mcpTabTools = new Map<string, { loading: boolean; tools: readonly IClaudeMcpTool[]; message: string }>();
	/** An open "add MCP server" form (per section). transport drives which fields apply. */
	private mcpAddForm: { scope: 'global' | 'project'; name: string; transport: McpTransport; command: string; args: string; url: string } | undefined;
	/** An open "add plugin" form on the Plugins tab. */
	private pluginAddForm: { id: string } | undefined;
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
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IJSONEditingService private readonly jsonEditing: IJSONEditingService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IClawdiusConfigService private readonly configService: IClawdiusConfigService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
	) {
		super(ClaudeControlCenterEditor.ID, group, telemetryService, themeService, storageService);
		// Re-render when the default-mode setting changes anywhere (e.g. the status-bar pill), so the two stay
		// in lockstep. Cheap: only the mode segment reads from config; the buckets come from the snapshot.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(INITIAL_PERMISSION_MODE_KEY) || e.affectsConfiguration(ALLOW_BYPASS_KEY)) {
				this.render();
			}
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
			this.mcpTabTools.clear();
			if (this.adding?.mode === 'mcp' || this.tab === 'skills' || this.tab === 'plugins' || this.tab === 'mcp' || this.tab === 'hooks') { this.render(); }
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

	/** Set the default mode (claudeCode.initialPermissionMode + bypass gate) - the same write the pill makes. */
	private async applyMode(mode: PermissionMode): Promise<void> {
		const prev = parsePermissionMode(this.configurationService.getValue<string>(INITIAL_PERMISSION_MODE_KEY));
		if (prev === mode) { return; }
		try {
			for (const w of permissionModeWrites(mode)) {
				await this.configurationService.updateValue(w.key, w.value, ConfigurationTarget.USER);
			}
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.modeFailed', "Could not set the default mode: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		// The config listener re-renders both this pane and the pill. Undo restores the previous mode (mode key
		// only - we never un-set the bypass gate, matching the pill's one-way-enable rule).
		this.toast(localize('clawdius.control.toast.mode', "Default mode set to {0}", this.modeLabel(mode)), () => {
			void this.configurationService.updateValue(INITIAL_PERMISSION_MODE_KEY, prev, ConfigurationTarget.USER);
		});
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

	/** Drop any open inline add/edit forms (permission add box, MCP add server, plugin add) on navigation. */
	private clearTransientForms(): void {
		this.adding = undefined;
		this.mcpAddForm = undefined;
		this.pluginAddForm = undefined;
		this.skillFileForm = undefined;
	}

	private renderTabs(parent: HTMLElement): void {
		const strip = append(parent, h('.clawdius-control-tabs'));
		strip.setAttribute('role', 'tablist');
		const tabs: { readonly tab: ControlTab; readonly label: string; readonly ready: boolean }[] = [
			{ tab: 'usage', label: localize('clawdius.control.tab.usage', "Usage"), ready: true },
			{ tab: 'permissions', label: localize('clawdius.control.tab.permissions', "Permissions"), ready: true },
			{ tab: 'mcp', label: localize('clawdius.control.tab.mcp', "MCP"), ready: true },
			{ tab: 'skills', label: localize('clawdius.control.tab.skills', "Skills"), ready: true },
			{ tab: 'plugins', label: localize('clawdius.control.tab.plugins', "Plugins"), ready: true },
			{ tab: 'hooks', label: localize('clawdius.control.tab.hooks', "Hooks"), ready: true },
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
	}

	private renderHero(parent: HTMLElement, title: string, sub: string): void {
		const hero = append(parent, h('.clawdius-control-hero'));
		append(hero, h('.clawdius-control-hero-mark'));
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
		const view = new ClaudeUsageDashboardView(host, this.fileService, this.pathService, this.commandService, this.agentHostService);
		this.usageView.value = view;
		void view.load(CancellationToken.None);
	}

	// --- Permissions tab ---

	private renderPermissionsTab(parent: HTMLElement): void {
		this.renderHero(parent,
			localize('clawdius.control.heroTitle', "Permissions"),
			localize('clawdius.control.heroSub', "Set how Claude starts new conversations and which actions it may take. Edits your own ~/.claude configuration."));
		this.renderModeBlock(parent);
		this.renderRulesBlock(parent);
	}

	private renderModeBlock(parent: HTMLElement): void {
		const block = this.block(parent, localize('clawdius.control.defaultMode', "Default mode for new conversations"));
		const current = parsePermissionMode(this.configurationService.getValue<string>(INITIAL_PERMISSION_MODE_KEY));
		const seg = append(block, h('.clawdius-control-seg'));
		for (const info of permissionModes()) {
			const m = append(seg, h('button.clawdius-control-mode')) as HTMLButtonElement;
			m.classList.add(`tone-${info.tone}`);
			const active = info.value === current;
			if (active) { m.classList.add('active'); }
			const ico = append(m, h('span.clawdius-control-mode-ico'));
			ico.classList.add(...ThemeIcon.asClassNameArray(info.icon));
			append(m, h('span.clawdius-control-mode-name')).textContent = info.label;
			// Description is a tooltip (+ aria) instead of inline text, to keep the row compact.
			m.title = info.detail;
			m.setAttribute('aria-label', `${info.label}: ${info.detail}`);
			m.setAttribute('aria-pressed', active ? 'true' : 'false');
			this.renderStore.add(addDisposableListener(m, EventType.CLICK, () => void this.applyMode(info.value)));
		}
	}

	private renderRulesBlock(parent: HTMLElement): void {
		const block = this.block(parent, localize('clawdius.control.rules', "Permission rules"));
		this.renderScopeBar(block);
		if (this.snapshot?.kind === 'unavailable') {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.noFolder', "Open a folder to edit project permissions. Global permissions are always available.");
			return;
		}
		if (this.snapshot?.kind === 'malformed') {
			this.renderMalformed(block);
			return;
		}
		if (this.snapshot?.kind === 'ok') {
			const state = parsePermissions(this.snapshot.settings);
			for (const meta of this.bucketMetas()) {
				this.renderBucket(block, state, meta);
			}
		}
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
				if (this.scope !== meta.scope) { this.scope = meta.scope; this.adding = undefined; void this.load(); }
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

	private renderBucket(parent: HTMLElement, state: IPermissionsState, meta: IBucketMeta): void {
		const rules = state[meta.bucket];
		const bucket = append(parent, h(`.clawdius-control-bucket.bk-${meta.bucket}`));
		const head = append(bucket, h('.clawdius-control-bk-hd'));
		const name = append(head, h('span.clawdius-control-bk-name'));
		append(name, h('span.clawdius-control-bk-ico')).classList.add(...ThemeIcon.asClassNameArray(this.bucketIcon(meta.bucket)));
		append(name, h('span')).textContent = meta.label;
		append(head, h('span.clawdius-control-bk-cnt')).textContent = String(rules.length);
		append(head, h('.clawdius-control-spacer'));
		this.button(head, localize('clawdius.control.addRule', "Add rule"), () => {
			this.adding = { bucket: meta.bucket, mode: 'builtin', builtinTool: '', builtinSpec: '', server: '', mcpSelect: '', mcpTool: '', mcpLoading: false, mcpLoadedServer: '', mcpLoadedTools: [], mcpLoadMessage: '', text: '' };
			this.render();
		}, 'add', Codicon.add);

		if (rules.length === 0 && this.adding?.bucket !== meta.bucket) {
			append(bucket, h('.clawdius-control-emptyrule')).textContent = localize('clawdius.control.noRules', "No rules here yet.");
		}
		for (const rule of rules) {
			this.renderRule(bucket, meta.bucket, rule);
		}
		if (this.adding?.bucket === meta.bucket) {
			this.renderAddRow(bucket, meta.bucket);
		}
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
		// Validate every on-disk skill's SKILL.md off the paint path; the batch re-renders once for the badges.
		const folders = skills.map(s => this.representativeSkillItem(s)?.targetResource).filter((u): u is URI => !!u);
		void this.ensureSkillValidations(folders);
		for (const skill of skills) {
			this.renderSkillRow(block, skill, state.overrides[skill.name] ?? 'on');
		}
	}

	/** Discovered skills (from the scanned config, deduped by name across scopes) plus any override-only names.
	 *  Each row keeps the backing config item(s) so Open / Delete can act on the file on disk. */
	private collectSkills(state: ISkillsState): ISkillRow[] {
		const map = new Map<string, { name: string; description?: string; origins: Set<string>; items: IConfigItem[] }>();
		for (const scope of this.configService.snapshot.scopes) {
			const origin = scope.scope === ConfigScope.Global
				? localize('clawdius.control.scope.global', "Global")
				: (scope.folderName ?? localize('clawdius.control.scope.project', "Project (shared)"));
			for (const sec of scope.sections) {
				if (sec.section !== ConfigSection.Skills) { continue; }
				for (const item of sec.items) {
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
		this.renderSkillStateControl(row, skill.name, current);
		const acts = append(row, h('.clawdius-control-cap-acts'));
		if (item) {
			this.iconButton(acts, Codicon.edit, localize('clawdius.control.skills.open', "Open SKILL.md"), () => void this.openSkill(item));
			this.iconButton(acts, Codicon.trash, localize('clawdius.control.skills.delete', "Delete skill"), () => void this.deleteSkill(item), true);
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
		this.button(fhd, localize('clawdius.control.skills.newFile', "New file"), () => {
			this.skillFileForm = { folderPath: folder.fsPath, target: '', name: '' };
			this.render();
		}, 'add', Codicon.add);

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
		// Guardrails: a simple name only - no separators, no traversal, not the manifest.
		if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name === '.') {
			this.toast(localize('clawdius.control.skills.badFileName', "Enter a simple file name (no slashes or '..')."));
			return;
		}
		if (form.target === '' && name.toLowerCase() === 'skill.md') {
			this.toast(localize('clawdius.control.skills.skillMdReserved', "SKILL.md already exists - open it from the file list."));
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
		if (file.isDirectory || file.isSkillMd || !isEqualOrParent(file.resource, folder) || isEqual(file.resource, folder)) { return; }
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
		const toggle = append(row, h('button.clawdius-control-toggle')) as HTMLButtonElement;
		if (value) { toggle.classList.add('on'); }
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', value ? 'true' : 'false');
		toggle.setAttribute('aria-label', label);
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
		for (const item of hooks) { this.renderHookRow(block, item); }
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

		const scopeBlock = this.block(parent, localize('clawdius.control.mcp.scopeTitle', "Where approvals + permissions apply"));
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

		const gblock = append(parent, h('.clawdius-control-block'));
		const ghd = append(gblock, h('.clawdius-control-bar'));
		append(ghd, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.mcp.globalTitle', "Global MCP servers");
		append(ghd, h('.clawdius-control-spacer'));
		this.button(ghd, localize('clawdius.control.mcp.newServer', "New server"), () => this.openMcpAddForm('global'), 'add', Codicon.add);
		append(gblock, h('.clawdius-control-scope-hint')).textContent = localize('clawdius.control.mcp.globalNote', "Defined in ~/.claude.json. Always available - inspect them and set per-tool permissions.");
		if (this.mcpAddForm?.scope === 'global') { this.renderMcpAddForm(gblock); }
		if (globalServers.length === 0) {
			append(gblock, h('.clawdius-control-empty')).textContent = localize('clawdius.control.mcp.noGlobal', "No global MCP servers configured.");
		} else {
			for (const server of globalServers) { this.renderMcpServerRow(gblock, server, false, mcpState); }
		}

		const hasWorkspace = this.workspaceService.getWorkspace().folders.length > 0;
		if (hasWorkspace || projectServers.length > 0) {
			const pblock = append(parent, h('.clawdius-control-block'));
			const phd = append(pblock, h('.clawdius-control-bar'));
			append(phd, h('.clawdius-control-block-title')).textContent = localize('clawdius.control.mcp.projectTitle', "Project MCP servers");
			append(phd, h('.clawdius-control-spacer'));
			if (hasWorkspace) { this.button(phd, localize('clawdius.control.mcp.newServer', "New server"), () => this.openMcpAddForm('project'), 'add', Codicon.add); }
			append(pblock, h('.clawdius-control-scope-hint')).textContent = localize('clawdius.control.mcp.projectNote', "Defined in this project's .mcp.json. Approve or reject which ones Claude may use.");
			this.renderToggleRow(pblock,
				localize('clawdius.control.mcp.enableAll', "Approve all project MCP servers"),
				localize('clawdius.control.mcp.enableAllHint', "Auto-approves every server in .mcp.json (enableAllProjectMcpServers); individual Reject still wins."),
				mcpState.enableAllProjectServers,
				next => void this.setEnableAllMcp(next));
			if (this.mcpAddForm?.scope === 'project') { this.renderMcpAddForm(pblock); }
			if (projectServers.length === 0) {
				append(pblock, h('.clawdius-control-empty')).textContent = localize('clawdius.control.mcp.noProject', "No project MCP servers in .mcp.json.");
			} else {
				for (const server of projectServers) { this.renderMcpServerRow(pblock, server, true, mcpState); }
			}
		}
	}

	private openMcpAddForm(scope: 'global' | 'project'): void {
		this.mcpAddForm = { scope, name: '', transport: 'stdio', command: '', args: '', url: '' };
		this.render();
	}

	/** The backing JSON for new MCP servers: ~/.claude.json (global) or <first folder>/.mcp.json (project). */
	private async mcpBackingFile(scope: 'global' | 'project'): Promise<URI | undefined> {
		if (scope === 'global') { return URI.joinPath(await this.pathService.userHome(), '.claude.json'); }
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		return folder ? URI.joinPath(folder, '.mcp.json') : undefined;
	}

	private renderMcpAddForm(parent: HTMLElement): void {
		const form = this.mcpAddForm;
		if (!form) { return; }
		const wrap = append(parent, h('.clawdius-control-mcp-addform'));

		const nameRow = append(wrap, h('.clawdius-control-addrow'));
		const name = append(nameRow, h('input.clawdius-control-input')) as HTMLInputElement;
		name.type = 'text'; name.value = form.name;
		name.placeholder = localize('clawdius.control.mcp.namePh', "server name, e.g. my-server");
		name.setAttribute('aria-label', localize('clawdius.control.mcp.nameLabel', "Server name"));
		this.renderStore.add(addDisposableListener(name, EventType.INPUT, () => { form.name = name.value; }));
		const transport = append(nameRow, h('select.clawdius-control-select')) as HTMLSelectElement;
		transport.setAttribute('aria-label', localize('clawdius.control.mcp.transportLabel', "Transport"));
		for (const t of ['stdio', 'http', 'sse'] as const) {
			const o = append(transport, h('option')) as HTMLOptionElement;
			o.value = t; o.textContent = t;
			if (t === form.transport) { o.selected = true; }
		}
		this.renderStore.add(addDisposableListener(transport, EventType.CHANGE, () => { form.transport = transport.value as McpTransport; this.render(); }));

		const detailRow = append(wrap, h('.clawdius-control-addrow'));
		if (form.transport === 'stdio') {
			const command = append(detailRow, h('input.clawdius-control-input')) as HTMLInputElement;
			command.type = 'text'; command.value = form.command;
			command.placeholder = localize('clawdius.control.mcp.commandPh', "command, e.g. uvx or npx");
			command.setAttribute('aria-label', localize('clawdius.control.mcp.commandLabel', "Command"));
			this.renderStore.add(addDisposableListener(command, EventType.INPUT, () => { form.command = command.value; }));
			const args = append(detailRow, h('input.clawdius-control-input')) as HTMLInputElement;
			args.type = 'text'; args.value = form.args;
			args.placeholder = localize('clawdius.control.mcp.argsPh', "args (space-separated)");
			args.setAttribute('aria-label', localize('clawdius.control.mcp.argsLabel', "Arguments"));
			this.renderStore.add(addDisposableListener(args, EventType.INPUT, () => { form.args = args.value; }));
		} else {
			const url = append(detailRow, h('input.clawdius-control-input')) as HTMLInputElement;
			url.type = 'text'; url.value = form.url;
			url.placeholder = localize('clawdius.control.mcp.urlPh', "https://host/mcp");
			url.setAttribute('aria-label', localize('clawdius.control.mcp.urlLabel', "Server URL"));
			this.renderStore.add(addDisposableListener(url, EventType.INPUT, () => { form.url = url.value; }));
		}

		const actions = append(wrap, h('.clawdius-control-addrow'));
		this.button(actions, localize('clawdius.control.mcp.create', "Create"), () => void this.createMcpServer(), 'primary');
		this.button(actions, localize('clawdius.control.cancel', "Cancel"), () => { this.mcpAddForm = undefined; this.render(); }, 'ghost');
		append(wrap, h('.clawdius-control-addnote')).textContent = localize('clawdius.control.mcp.addNote', "Writes the server to the backing JSON and opens it - add env / headers there (they hold secrets).");
	}

	private async createMcpServer(): Promise<void> {
		const form = this.mcpAddForm;
		if (!form) { return; }
		const name = form.name.trim();
		if (!name || /[^a-zA-Z0-9_.-]/.test(name)) {
			this.toast(localize('clawdius.control.mcp.badName', "Enter a simple server name (letters, numbers, '-', '_', '.')."));
			return;
		}
		const uri = await this.mcpBackingFile(form.scope);
		if (!uri) { return; }
		let def: Record<string, unknown>;
		if (form.transport === 'stdio') {
			const command = form.command.trim();
			if (!command) { this.toast(localize('clawdius.control.mcp.needCommand', "Enter a command.")); return; }
			def = { command, args: form.args.trim() ? form.args.trim().split(/\s+/) : [] };
		} else {
			const url = form.url.trim();
			if (!url) { this.toast(localize('clawdius.control.mcp.needUrl', "Enter a URL.")); return; }
			def = { type: form.transport, url };
		}
		// Refuse to clobber an existing server.
		const raw = await this.readRaw(uri);
		if (raw !== undefined) {
			try {
				const parsed = parseJsonc<{ mcpServers?: Record<string, unknown> }>(raw);
				if (parsed?.mcpServers && typeof parsed.mcpServers === 'object' && Object.hasOwn(parsed.mcpServers, name)) {
					this.toast(localize('clawdius.control.mcp.exists', "A server named \"{0}\" already exists here.", name));
					return;
				}
			} catch { /* malformed file - the write below would surface the error */ }
		}
		try {
			if (raw === undefined || raw.trim().length === 0) { await this.fileService.writeFile(uri, VSBuffer.fromString('{}\n')); }
			await this.jsonEditing.write(uri, [{ path: ['mcpServers', name], value: def }], true);
		} catch (err) {
			this.notificationService.error(localize('clawdius.control.mcp.createFailed', "Could not add the server: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		this.mcpAddForm = undefined;
		void this.configService.refresh(true);
		await this.editorService.openEditor({ resource: uri, options: { pinned: true } });
		this.render();
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

	/** Read each distinct backing JSON file once and summarize every server's def (transport, redacted detail). */
	private async ensureMcpDefs(): Promise<void> {
		if (this.mcpDefsLoaded) { return; }
		this.mcpDefsLoaded = true;
		const gen = this.cacheGeneration;
		const byFile = new Map<string, { resource: URI; items: { id: string; name: string }[] }>();
		for (const s of this.collectMcpServers()) {
			const key = s.resource.toString();
			const entry = byFile.get(key) ?? { resource: s.resource, items: [] };
			entry.items.push({ id: s.id, name: s.name });
			byFile.set(key, entry);
		}
		const defs = new Map<string, IMcpDefSummary>();
		await Promise.all([...byFile.values()].map(async file => {
			const raw = await this.readRaw(file.resource);
			let servers: Record<string, unknown> = {};
			if (raw !== undefined) {
				try {
					const parsed = parseJsonc<{ mcpServers?: Record<string, unknown> }>(raw);
					servers = (parsed?.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers : {};
				} catch { servers = {}; }
			}
			for (const it of file.items) { defs.set(it.id, summarizeMcpDef(servers[it.name])); }
		}));
		if (this.isPaneDisposed || gen !== this.cacheGeneration) { return; }
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
			localize('clawdius.control.plugins.sub', "Enable or disable installed Claude Code plugins. Plugins apply globally - writes enabledPlugins to ~/.claude/settings.json."));

		const addBlock = this.block(parent, localize('clawdius.control.plugins.addTitle', "Add a plugin"));
		this.renderPluginAdd(addBlock);

		const block = this.block(parent, localize('clawdius.control.plugins.listTitle', "Installed plugins"));
		const plugins = this.collectPlugins();
		if (plugins.length === 0) {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.plugins.none', "No plugins installed yet. Add one above, or install via the Claude Code CLI.");
			return;
		}
		for (const plugin of plugins) { this.renderPluginRow(block, plugin); }
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
		const cwd = this.workspaceService.getWorkspace().folders[0]?.uri ?? await this.pathService.userHome();
		const instance = await this.terminalService.createTerminal({ cwd });
		this.terminalService.setActiveInstance(instance);
		this.terminalGroupService.showPanel(true);
		// Pre-fill the install command (not auto-run) so the user reviews + handles any marketplace prompts.
		instance.sendText(id ? `claude plugin install ${id}` : 'claude plugin install ', false);
	}

	/** Installed + configured plugins from the scanned config (global; the CLI scopes plugins globally). */
	private collectPlugins(): { id: string; status: string }[] {
		const map = new Map<string, string>();
		for (const scope of this.configService.snapshot.scopes) {
			for (const sec of scope.sections) {
				if (sec.section !== ConfigSection.Plugins) { continue; }
				for (const item of sec.items) { map.set(item.label, item.description ?? 'installed'); }
			}
		}
		return [...map.entries()].map(([id, status]) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id));
	}

	private renderPluginRow(parent: HTMLElement, plugin: { id: string; status: string }): void {
		// Plugin ids are `plugin-id@marketplace-id`; show the plugin name with the marketplace + status as the hint.
		const at = plugin.id.indexOf('@');
		const name = at > 0 ? plugin.id.slice(0, at) : plugin.id;
		const marketplace = at > 0 ? plugin.id.slice(at + 1) : undefined;
		const statusLabel = this.pluginStatusLabel(plugin.status);
		const hint = marketplace ? localize('clawdius.control.plugins.fromStatus', "{0} - {1}", marketplace, statusLabel) : statusLabel;
		// 'installed' (no explicit enabledPlugins entry) and 'enabled' both read as on; only 'disabled' is off.
		this.renderToggleRow(parent, name, hint, plugin.status !== 'disabled', next => void this.setPluginEnabled(plugin.id, next));
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
		this.toastStore.clear();
		this.toastEl?.remove();
		const toast = append(this.container, h('.clawdius-control-toast'));
		this.toastEl = toast;
		append(toast, h('span')).textContent = message;
		if (onUndo) {
			const undoBtn = append(toast, h('button.clawdius-control-undo')) as HTMLButtonElement;
			undoBtn.textContent = localize('clawdius.control.undo', "Undo");
			this.toastStore.add(addDisposableListener(undoBtn, EventType.CLICK, () => { toast.remove(); onUndo(); }));
		}
		this.toastTimer.value = disposableTimeout(() => toast.remove(), 5000);
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

	private button(parent: HTMLElement, label: string, onClick: () => void, variant?: BtnVariant, icon?: ThemeIcon): HTMLButtonElement {
		const btn = append(parent, h(`button.clawdius-control-btn${variant ? '.' + variant : ''}`)) as HTMLButtonElement;
		if (icon) { append(btn, h('span.clawdius-control-btn-ico')).classList.add(...ThemeIcon.asClassNameArray(icon)); }
		append(btn, h('span')).textContent = label;
		this.renderStore.add(addDisposableListener(btn, EventType.CLICK, () => onClick()));
		return btn;
	}

	/** A compact icon-only button; aria-label + tooltip carry the meaning. */
	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, onClick: () => void, danger?: boolean): HTMLButtonElement {
		const btn = append(parent, h(`button.clawdius-control-iconbtn${danger ? '.danger' : ''}`)) as HTMLButtonElement;
		append(btn, h('span')).classList.add(...ThemeIcon.asClassNameArray(icon));
		btn.title = label;
		btn.setAttribute('aria-label', label);
		this.renderStore.add(addDisposableListener(btn, EventType.CLICK, () => onClick()));
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

	private modeLabel(mode: PermissionMode): string {
		return permissionModes().find(m => m.value === mode)?.label ?? mode;
	}
}
// CLAWDIUS-END
