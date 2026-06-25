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
// titles, brand-orange accents). MCP/Skills/Plugins/Hooks tabs are stubs here; they land in later increments.

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
import { ConfigSection, IClawdiusConfigService } from '../../common/clawdiusConfig.js';
import {
	ALLOW_BYPASS_KEY, INITIAL_PERMISSION_MODE_KEY, PermissionMode, parsePermissionMode, permissionModeWrites, permissionModes,
} from '../clawdiusPermissionModeStatusEntry.js';
import { ClaudeControlCenterInput } from './claudeControlCenterInput.js';
import { BUILTIN_TOOLS, IPermissionsState, PERMISSION_BUCKETS, PermissionBucket, builtinRule, mcpToolRule, parsePermissions, parseRule } from './claudePermissionsModel.js';
import {
	ControlScope, PermissionIntent, classifySettings, invertIntent, planPermissionIntent, resolvePermissionsSettingsUri,
} from './claudeControlCenterData.js';

type Snapshot =
	| { readonly kind: 'ok'; readonly uri: URI; readonly state: IPermissionsState }
	| { readonly kind: 'malformed'; readonly uri: URI }
	| { readonly kind: 'unavailable' };

interface IScopeMeta { readonly scope: ControlScope; readonly label: string; readonly hint: string; readonly file: string }
interface IBucketMeta { readonly bucket: PermissionBucket; readonly label: string }
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
	private snapshot: Snapshot | undefined;
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
	) {
		super(ClaudeControlCenterEditor.ID, group, telemetryService, themeService, storageService);
		// Re-render when the default-mode setting changes anywhere (e.g. the status-bar pill), so the two stay
		// in lockstep. Cheap: only the mode segment reads from config; the buckets come from the snapshot.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(INITIAL_PERMISSION_MODE_KEY) || e.affectsConfiguration(ALLOW_BYPASS_KEY)) {
				this.render();
			}
		}));
		// Refresh the MCP add box's server dropdown when the scanned config changes.
		this._register(this.configService.onDidChange(() => {
			if (this.adding?.mode === 'mcp') { this.render(); }
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
			: { kind: 'ok', uri, state: parsePermissions(cls.settings) };
		this.render();
	}

	/** Resolve a captured rule intent against a FRESH read, then write. Race-safe by construction. */
	private async apply(intent: PermissionIntent): Promise<void> {
		const uri = await this.scopeUri(this.scope);
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
		this.toast(this.describeRule(intent), undo ? () => void this.apply(undo) : undefined);
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
		if (!this.container) { return; }
		this.renderStore.clear();
		if (!this.content) {
			this.content = append(this.container, h('.clawdius-control-inner'));
		} else {
			clearNode(this.content);
		}
		const inner = this.content;

		this.renderTabs(inner);
		this.renderHero(inner);
		this.renderModeBlock(inner);
		this.renderRulesBlock(inner);
	}

	private renderTabs(parent: HTMLElement): void {
		const strip = append(parent, h('.clawdius-control-tabs'));
		const active = append(strip, h('button.clawdius-control-tab.active')) as HTMLButtonElement;
		active.textContent = localize('clawdius.control.tab.permissions', "Permissions");
		active.setAttribute('aria-selected', 'true');
		for (const label of [localize('clawdius.control.tab.mcp', "MCP"), localize('clawdius.control.tab.skills', "Skills"), localize('clawdius.control.tab.plugins', "Plugins"), localize('clawdius.control.tab.hooks', "Hooks")]) {
			const t = append(strip, h('button.clawdius-control-tab.soon')) as HTMLButtonElement;
			t.textContent = label;
			t.disabled = true;
			t.title = localize('clawdius.control.tab.soonTip', "{0} controls arrive in a later update", label);
			append(t, h('span.clawdius-control-soon')).textContent = localize('clawdius.control.soon', "soon");
		}
	}

	private renderHero(parent: HTMLElement): void {
		const hero = append(parent, h('.clawdius-control-hero'));
		append(hero, h('.clawdius-control-hero-mark'));
		const text = append(hero, h('.clawdius-control-hero-text'));
		append(text, h('.clawdius-control-hero-title')).textContent = localize('clawdius.control.heroTitle', "Permissions");
		append(text, h('.clawdius-control-hero-sub')).textContent = localize('clawdius.control.heroSub', "Set how Claude starts new conversations and which actions it may take. Edits your own ~/.claude configuration.");
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
		const metas = this.scopeMetas();
		const bar = append(block, h('.clawdius-control-bar'));
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
			const cap = append(block, h('.clawdius-control-scope-hint'));
			append(cap, h('span')).textContent = active.hint;
			append(cap, h('span.clawdius-control-scope-file')).textContent = active.file;
		}

		if (this.snapshot?.kind === 'unavailable') {
			append(block, h('.clawdius-control-empty')).textContent = localize('clawdius.control.noFolder', "Open a folder to edit project permissions. Global permissions are always available.");
			return;
		}
		if (this.snapshot?.kind === 'malformed') {
			const box = append(block, h('.clawdius-control-error'));
			append(box, h('.clawdius-control-error-head')).textContent = localize('clawdius.control.malformedHead', "This settings.json is not valid JSON");
			append(box, h('.clawdius-control-error-body')).textContent = localize('clawdius.control.malformedBody', "Editing is disabled so the file is never clobbered. Open it, fix the JSON, then come back.");
			return;
		}
		if (this.snapshot?.kind === 'ok') {
			for (const meta of this.bucketMetas()) {
				this.renderBucket(block, this.snapshot.state, meta);
			}
		}
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
