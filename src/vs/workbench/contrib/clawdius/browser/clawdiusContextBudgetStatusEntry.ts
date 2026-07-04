/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Context Budget Inspector - status-bar pill (N2 2a)
// An at-a-glance status-bar item showing the estimated ALWAYS-ON token total Claude loads for the active file
// ($(book) ~695). Hovering shows the per-source breakdown; clicking opens the full Context Budget panel
// (clawdius.openContextBudget). Reacts to the active file changing (different glob rules apply) and to config
// edits. Reads the shared snapshot through the pure resolveContextBudget() - no I/O. Clawdius mode only.

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import product from '../../../../platform/product/common/product.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CLAWDIUS_STATUS_BAR_ENABLED_SETTING, isClawdiusStatusBarEnabled } from '../common/clawdiusStatusBar.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IClawdiusConfigService, IConfigItem } from '../common/clawdiusConfig.js';
import { formatApproxTokens, IBudgetSource, IContextBudget, resolveContextBudget } from '../common/clawdiusContextBudget.js';
import { CONTEXT_BUDGET_VIEW_ID } from './clawdiusContextBudgetView.js';

export const OPEN_CONTEXT_BUDGET_COMMAND_ID = 'clawdius.openContextBudget';

/** Setting: the always-on token total above which the pill turns a warning color (0 disables). */
export const CONTEXT_BUDGET_WARN_TOKENS_SETTING = 'clawdius.contextBudget.warnTokens';
const DEFAULT_WARN_TOKENS = 8000;

// Self-contained over-budget warn colors. We do NOT use the upstream statusBarItem.warning* tokens: their
// foreground defaults to white and third-party themes often override only the background (e.g. a pale yellow),
// making white-on-yellow text unreadable. Amber needs a DARK foreground for contrast, so this pair pins one.
const CONTEXT_BUDGET_WARN_BACKGROUND = registerColor('clawdius.contextBudgetWarnBackground', {
	dark: '#D29200', light: '#C98A00', hcDark: '#E0A500', hcLight: '#9A6A00'
}, localize('clawdius.ctxb.warnBackground', "Background of the Clawdius context-budget status item when the always-on token estimate is over budget."));
const CONTEXT_BUDGET_WARN_FOREGROUND = registerColor('clawdius.contextBudgetWarnForeground', {
	dark: '#1F1810', light: '#1F1810', hcDark: '#000000', hcLight: '#FFFFFF'
}, localize('clawdius.ctxb.warnForeground', "Foreground of the Clawdius context-budget status item when over budget."));

/** Opens (and focuses) the Context Budget Inspector panel. Wired to the status pill and the command palette. */
export class OpenContextBudgetAction extends Action2 {

	static readonly ID = OPEN_CONTEXT_BUDGET_COMMAND_ID;

	constructor() {
		super({
			id: OPEN_CONTEXT_BUDGET_COMMAND_ID,
			title: localize2('clawdius.openContextBudget', "Open Claude Code Context Budget"),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(CONTEXT_BUDGET_VIEW_ID, true);
	}
}

/** Status-bar pill: the estimated always-on token total for the active file; click opens the full panel. */
export class ClawdiusContextBudgetStatusEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusContextBudgetStatusEntry';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	/** Nested/subtree CLAUDE.md per active file (async disk walk, cached) so the pill total matches the panel. */
	private readonly nestedCache = new Map<string, IConfigItem[]>();
	private readonly nestedPending = new Set<string>();
	private disposed = false;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IEditorService private readonly editorService: IEditorService,
		@IClawdiusConfigService private readonly configService: IClawdiusConfigService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// Only in Clawdius mode (defaultChatAgent has no entitlementUrl); elsewhere this surface is meaningless.
		if (product.defaultChatAgent?.entitlementUrl) {
			return;
		}

		// Re-resolve when the active file changes (different rules apply), config is edited, or the warn
		// threshold setting changes.
		this._register(this.editorService.onDidActiveEditorChange(() => this.update()));
		this._register(this.configService.onDidChange(() => { this.nestedCache.clear(); this.update(); }));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONTEXT_BUDGET_WARN_TOKENS_SETTING) || e.affectsConfiguration(CLAWDIUS_STATUS_BAR_ENABLED_SETTING)) { this.update(); }
		}));
		this.update();
		// The snapshot is empty until the first refresh (coalesced in the store).
		void this.configService.refresh();
	}

	private warnThreshold(): number {
		const v = this.configurationService.getValue(CONTEXT_BUDGET_WARN_TOKENS_SETTING);
		// A configured 0 (or negative) disables the warning; only an unset / non-number falls back to the default.
		if (typeof v === 'number') { return v <= 0 ? Number.POSITIVE_INFINITY : v; }
		return DEFAULT_WARN_TOKENS;
	}

	private activeFile(): URI | undefined {
		return EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
			filterByScheme: [Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData],
		});
	}

	/** Cached nested/subtree CLAUDE.md for the active file; kicks the async walk on a miss, then re-renders. */
	private nestedFor(activeFile: URI | undefined, folders: readonly URI[]): IConfigItem[] {
		if (!activeFile) { return []; }
		const key = activeFile.toString();
		const cached = this.nestedCache.get(key);
		if (cached) { return cached; }
		if (!this.nestedPending.has(key)) {
			this.nestedPending.add(key);
			this.configService.nestedMemoriesFor(activeFile, folders).then(items => {
				this.nestedPending.delete(key);
				if (this.disposed) { return; }
				this.nestedCache.set(key, items);
				if (items.length) { this.update(); }
			}, () => this.nestedPending.delete(key));
		}
		return [];
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	private update(): void {
		// Master toggle: when off, drop the entry entirely (kept orthogonal to VS Code's own right-click hide).
		if (!isClawdiusStatusBarEnabled(this.configurationService)) {
			this.entry.clear();
			return;
		}
		// Until the first scan resolves, show a neutral "scanning" pill rather than a definitive ~0.
		if (!this.configService.hasResolved) {
			this.set({
				name: localize('clawdius.ctxb.statusName', "Claude Context Budget"),
				text: '$(book) $(loading~spin)',
				ariaLabel: localize('clawdius.ctxb.statusScanning', "Scanning Claude memory & rules"),
				tooltip: localize('clawdius.ctxb.scanning', "Scanning Claude memory & rules…"),
				command: OPEN_CONTEXT_BUDGET_COMMAND_ID,
			});
			return;
		}
		const activeFile = this.activeFile();
		const folders = this.workspaceService.getWorkspace().folders.map(f => f.uri);
		const budget = resolveContextBudget(this.configService.snapshot, activeFile, folders, this.nestedFor(activeFile, folders));
		// Distinguish "no Claude config at all" (em-dash) from a real ~0 budget, so an empty repo's pill does not
		// read as a confident zero.
		if (budget.alwaysOn.length === 0 && budget.onInvoke.length === 0 && budget.notApplied.length === 0) {
			this.set({
				name: localize('clawdius.ctxb.statusName', "Claude Context Budget"),
				text: '$(book) —',
				ariaLabel: localize('clawdius.ctxb.statusEmpty', "No Claude memory or rules found"),
				tooltip: localize('clawdius.ctxb.emptyTip', "No Claude memory or rules found in this workspace or ~/.claude. Click to open the Context Budget panel."),
				command: OPEN_CONTEXT_BUDGET_COMMAND_ID,
			});
			return;
		}
		this.set(this.getProps(budget));
	}

	private set(props: IStatusbarEntry): void {
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			// Absolute priority just left of the permission pill (100.06) / effort pill (100.07) cluster.
			this.entry.value = this.statusbarService.addEntry(props, 'clawdius.contextBudget', StatusbarAlignment.RIGHT, 100.05);
		}
	}

	private getProps(budget: IContextBudget): IStatusbarEntry {
		const label = formatApproxTokens(budget.alwaysOnTokens);
		const over = budget.alwaysOnTokens >= this.warnThreshold();
		return {
			name: localize('clawdius.ctxb.statusName', "Claude Context Budget"),
			text: `$(book) ${label}`,
			ariaLabel: localize('clawdius.ctxb.statusAria', "Claude memory & rules budget: {0} tokens always-on (estimated)", label),
			tooltip: new MarkdownString(this.tooltip(budget)),
			command: OPEN_CONTEXT_BUDGET_COMMAND_ID,
			// Warn color once the always-on estimate crosses the configurable budget.
			backgroundColor: over ? themeColorFromId(CONTEXT_BUDGET_WARN_BACKGROUND) : undefined,
			color: over ? themeColorFromId(CONTEXT_BUDGET_WARN_FOREGROUND) : undefined,
		};
	}

	private tooltip(budget: IContextBudget): string {
		const lines: string[] = [];
		lines.push(localize('clawdius.ctxb.tipTitle', "**Claude memory & rules** for the active file"));
		lines.push('');
		lines.push(localize('clawdius.ctxb.tipAlways', "Always-on (~every turn): **{0} tokens**", formatApproxTokens(budget.alwaysOnTokens).replace('~', '')));
		lines.push(...this.tipList(budget.alwaysOn));
		if (budget.onInvoke.length) {
			lines.push('');
			lines.push(localize('clawdius.ctxb.tipOnInvoke', "On-invoke (skills)"));
			lines.push(...this.tipList(budget.onInvoke));
		}
		lines.push('');
		lines.push(localize('clawdius.ctxb.tipExcludes', "_Memory, rules + skill menu. Excludes the system prompt, MCP schemas, and agent/command menus._"));
		lines.push(localize('clawdius.ctxb.tipFoot', "_Estimated. Click to open the full panel._"));
		return lines.join('\n');
	}

	/** Render up to 12 rows, then a "+N more" line, so a large skills/rules set can't make an unusable tooltip. */
	private tipList(sources: readonly IBudgetSource[]): string[] {
		const CAP = 12;
		const rows = sources.slice(0, CAP).map(s => this.tipRow(s));
		if (sources.length > CAP) {
			rows.push(localize('clawdius.ctxb.tipMore', "- _+{0} more_", sources.length - CAP));
		}
		return rows;
	}

	private tipRow(s: IBudgetSource): string {
		const tok = s.kind === 'skill' ? localize('clawdius.ctxb.onUse', "on use") : formatApproxTokens(s.approxTokens);
		return localize('clawdius.ctxb.tipItem', "- `{0}` {1} — {2}", s.tier, s.label, tok);
	}
}
// CLAWDIUS-END
