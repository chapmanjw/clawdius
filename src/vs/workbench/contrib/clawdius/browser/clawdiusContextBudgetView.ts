/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Context Budget Inspector - Panel view (N2 2a)
// "What does Claude see for THIS file?" A panel (bottom Panel, beside Problems/Output) that, for the active
// editor, lists the memory / rule / skill sources Claude loads, split into ALWAYS-ON (every turn), ON-INVOKE
// (skills), and NOT-APPLIED (glob rules the file does not match), each with an estimated token cost. Reads the
// shared IClawdiusConfigService snapshot through the pure resolveContextBudget() - no I/O of its own. Reacts to
// the active editor changing and to config edits. Token numbers are estimates (chars/4) and "loaded" is
// PREDICTED (there is no hook that confirms what entered the model's context), both labeled honestly.

import './media/clawdiusContextBudget.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, extUriIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IClawdiusConfigService } from '../common/clawdiusConfig.js';
import { BudgetTier, formatApproxTokens, IBudgetSource, IContextBudget, resolveContextBudget } from '../common/clawdiusContextBudget.js';

export const CONTEXT_BUDGET_VIEW_CONTAINER_ID = 'workbench.view.clawdiusContextBudget';
export const CONTEXT_BUDGET_VIEW_ID = 'clawdius.contextBudget';

/** Short letter shown in the scope badge for a precedence tier. */
function tierBadge(tier: BudgetTier): { letter: string; cls: string } {
	switch (tier) {
		case BudgetTier.Managed: return { letter: 'm', cls: 'm' };
		case BudgetTier.User: return { letter: 'u', cls: 'u' };
		case BudgetTier.Project: return { letter: 'p', cls: 'p' };
		case BudgetTier.Local: return { letter: 'l', cls: 'l' };
	}
}

/** The Context Budget Inspector panel: a native-DOM, active-file-reactive read-only view. */
export class ClawdiusContextBudgetView extends ViewPane {

	static readonly ID = CONTEXT_BUDGET_VIEW_ID;

	private bodyEl!: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly renderScheduler = this._register(new RunOnceScheduler(() => this.renderBudget(), 60));
	private didRefresh = false;

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
		@IClawdiusConfigService private readonly configService: IClawdiusConfigService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.bodyEl = append(container, $('.clawdius-ctxbudget'));
		// Re-resolve when the active file changes (different rules apply) or config is edited - debounced so rapid
		// Ctrl+Tab does not thrash the DOM rebuild.
		this._register(this.editorService.onDidActiveEditorChange(() => this.renderScheduler.schedule()));
		this._register(this.configService.onDidChange(() => this.renderScheduler.schedule()));
		this.renderBudget();
		// The snapshot is empty until the first refresh; trigger one (idempotent / coalesced in the store).
		if (!this.didRefresh) {
			this.didRefresh = true;
			void this.configService.refresh();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.bodyEl.style.height = `${height}px`;
	}

	private activeFile(): URI | undefined {
		return EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
			filterByScheme: [Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData],
		});
	}

	/** The active editor's resource regardless of scheme - to tell "no file open" from "a file in an editor we
	 *  cannot evaluate path rules against" (notebook cells, github.dev virtual FS, the Control Center pane). */
	private activeEditorHasFile(): boolean {
		return !!EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
	}

	private renderBudget(): void {
		if (!this.bodyEl) {
			return;
		}
		this.renderStore.clear();
		clearNode(this.bodyEl);

		// Until the first scan resolves, the snapshot is empty - show "scanning" rather than a definitive ~0.
		if (!this.configService.hasResolved) {
			append(this.bodyEl, $('.ctxb-empty', undefined, localize('clawdius.ctxb.scanning', "Scanning Claude memory & rules…")));
			return;
		}

		const activeFile = this.activeFile();
		const folders = this.workspaceService.getWorkspace().folders.map(f => f.uri);
		const budget = resolveContextBudget(this.configService.snapshot, activeFile, folders);

		this.renderHead(activeFile, budget);

		if (budget.alwaysOn.length === 0 && budget.onInvoke.length === 0 && budget.notApplied.length === 0) {
			append(this.bodyEl, $('.ctxb-empty', undefined, localize('clawdius.ctxb.none', "No Claude memory, rules, or skills found in this workspace or ~/.claude.")));
			return;
		}

		this.renderSection(localize('clawdius.ctxb.alwaysOn', "Always-on · every turn"), budget.alwaysOn, false);
		this.renderSection(localize('clawdius.ctxb.onInvoke', "On-invoke · when triggered"), budget.onInvoke, true);
		if (activeFile) {
			this.renderSection(localize('clawdius.ctxb.notApplied', "Not applied to this file"), budget.notApplied, true);
		}

		const foot = append(this.bodyEl, $('.ctxb-foot'));
		foot.textContent = localize('clawdius.ctxb.foot', "Estimated; counts memory, rules + the skill menu. Excludes the system prompt, MCP tool schemas, and agent/command menus that also load every turn. \"Loaded\" is predicted from your config, not confirmed.");
	}

	private renderHead(activeFile: URI | undefined, budget: IContextBudget): void {
		const head = append(this.bodyEl, $('.ctxb-head'));
		const fileEl = append(head, $('.ctxb-file'));
		fileEl.textContent = activeFile
			? localize('clawdius.ctxb.for', "Context for: {0}", this.displayPath(activeFile))
			: this.activeEditorHasFile()
				? localize('clawdius.ctxb.unsupported', "Path-scoped rules can't be evaluated for this editor — showing always-on memory")
				: localize('clawdius.ctxb.noFile', "No file open — showing always-on memory");
		const total = append(head, $('.ctxb-total'));
		total.textContent = localize('clawdius.ctxb.total', "memory & rules: {0} (estimated)", formatApproxTokens(budget.alwaysOnTokens));
	}

	private displayPath(uri: URI): string {
		for (const folder of this.workspaceService.getWorkspace().folders) {
			if (extUriIgnorePathCase.isEqualOrParent(uri, folder.uri)) {
				return extUriIgnorePathCase.relativePath(folder.uri, uri) ?? basename(uri);
			}
		}
		return basename(uri);
	}

	private renderSection(title: string, sources: readonly IBudgetSource[], onInvokeOrNotApplied: boolean): void {
		if (sources.length === 0) {
			return;
		}
		append(this.bodyEl, $('.ctxb-sec', undefined, title));
		for (const src of sources) {
			this.renderRow(src, onInvokeOrNotApplied);
		}
	}

	private renderRow(src: IBudgetSource, softTokens: boolean): void {
		const clickable = !!src.resource;
		const row = append(this.bodyEl, $(`.ctxb-row${clickable ? '.clickable' : ''}`));

		const badge = tierBadge(src.tier);
		append(row, $(`.ctxb-scope.${badge.cls}`, undefined, badge.letter));

		const name = append(row, $('.ctxb-name'));
		name.textContent = src.label;
		name.title = src.label;

		if (src.kind === 'import') {
			append(row, $('.ctxb-glob', undefined, localize('clawdius.ctxb.viaImport', "via @import")));
		} else if (src.kind === 'automem') {
			append(row, $('.ctxb-glob', undefined, localize('clawdius.ctxb.autoMem', "auto memory")));
		}

		if (src.paths && src.paths.length) {
			const glob = append(row, $('.ctxb-glob'));
			glob.textContent = localize('clawdius.ctxb.paths', "paths {0}", src.paths.join(', '));
			if (src.matched !== undefined) {
				append(row, $(src.matched ? '.ctxb-match' : '.ctxb-nomatch', undefined, src.matched ? localize('clawdius.ctxb.match', "match") : localize('clawdius.ctxb.nomatch', "no match")));
			}
		}

		const tok = append(row, $(`.ctxb-tok${softTokens ? '.dim' : ''}`));
		tok.textContent = src.kind === 'skill'
			? localize('clawdius.ctxb.onUse', "on use")
			: (src.matched === false ? '—' : formatApproxTokens(src.approxTokens));

		if (clickable && src.resource) {
			const resource = src.resource;
			this.renderStore.add(addDisposableListener(row, EventType.CLICK, () => {
				void this.editorService.openEditor({ resource, options: { pinned: false } });
			}));
		}
	}
}
// CLAWDIUS-END
