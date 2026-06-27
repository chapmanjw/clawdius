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
import { IClawdiusConfigService, IConfigItem, IMeasuredPrefix } from '../common/clawdiusConfig.js';
import { BudgetTier, containingFolderOf, formatApproxTokens, IBudgetHeading, IBudgetSource, IContextBudget, normalizeConfirmedPath, resolveContextBudget } from '../common/clawdiusContextBudget.js';

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
	/** Measured prefix per workspace folder (null = fetched, none found), so the async read happens once. */
	private readonly measuredCache = new Map<string, IMeasuredPrefix | null>();
	private readonly measuredPending = new Set<string>();
	/** Confirmed-loaded fs paths (lower-cased) from the opt-in hook log; undefined until fetched once. */
	private confirmedLoads: ReadonlySet<string> | undefined;
	private confirmedPending = false;
	/** Nested/subtree CLAUDE.md files along the active file's path, fetched once per active file (async disk walk). */
	private readonly nestedCache = new Map<string, IConfigItem[]>();
	private readonly nestedPending = new Set<string>();
	/** Guards the async measured/confirmed/nested fetches so they don't touch state or schedule after disposal. */
	private disposed = false;

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

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.bodyEl = append(container, $('.clawdius-ctxbudget'));
		// Re-resolve when the active file changes (different rules apply) or config is edited - debounced so rapid
		// Ctrl+Tab does not thrash the DOM rebuild.
		this._register(this.editorService.onDidActiveEditorChange(() => this.renderScheduler.schedule()));
		// A config change can alter nested CLAUDE.md content or what claudeMdExcludes suppresses, so drop the
		// per-file nested cache and re-walk on the next render.
		this._register(this.configService.onDidChange(() => { this.nestedCache.clear(); this.renderScheduler.schedule(); }));
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

		// Nested/subtree CLAUDE.md along the active file's path - a targeted async disk walk, cached per file.
		const nestedKey = activeFile?.toString();
		const nested = nestedKey ? this.nestedCache.get(nestedKey) ?? [] : [];
		if (activeFile && nestedKey && !this.nestedCache.has(nestedKey) && !this.nestedPending.has(nestedKey)) {
			this.nestedPending.add(nestedKey);
			this.configService.nestedMemoriesFor(activeFile, folders).then(items => {
				this.nestedPending.delete(nestedKey);
				if (this.disposed) { return; }
				this.nestedCache.set(nestedKey, items);
				if (items.length) { this.renderScheduler.schedule(); }
			}, () => this.nestedPending.delete(nestedKey));
		}

		const budget = resolveContextBudget(this.configService.snapshot, activeFile, folders, nested);

		// One-time fetch of the opt-in confirmed-loaded set; rows get a badge once it resolves.
		if (this.confirmedLoads === undefined && !this.confirmedPending) {
			this.confirmedPending = true;
			this.configService.readConfirmedLoads(folders).then(set => {
				this.confirmedPending = false;
				if (this.disposed) { return; }
				this.confirmedLoads = set;
				if (set.size) { this.renderScheduler.schedule(); }
			}, () => { this.confirmedPending = false; });
		}

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

		this.renderMeasured(folders, activeFile);
	}

	/** The measured cached-prefix from the project's most recent session transcript (system + tools + MCP +
	 *  memory) - real ground truth next to the estimate. Fetched once per folder, async, zero-egress. Uses the
	 *  folder that contains the active file, so a multi-root workspace shows THIS file's project, not folder[0]. */
	private renderMeasured(folders: readonly URI[], activeFile: URI | undefined): void {
		const folder = containingFolderOf(activeFile, folders) ?? folders[0];
		if (!folder) {
			return;
		}
		const key = folder.toString();
		const cached = this.measuredCache.get(key);
		if (cached === undefined) {
			if (!this.measuredPending.has(key)) {
				this.measuredPending.add(key);
				this.configService.readMeasuredPrefix(folder).then(res => {
					this.measuredPending.delete(key);
					if (this.disposed) { return; }
					this.measuredCache.set(key, res ?? null);
					this.renderScheduler.schedule();
				}, () => this.measuredPending.delete(key));
			}
			return;
		}
		if (cached) {
			const el = append(this.bodyEl, $('.ctxb-measured'));
			el.textContent = localize('clawdius.ctxb.measured', "Measured last session: {0} cached prefix (system + tools + MCP + memory) — your estimate above is the memory & rules slice of it.", formatApproxTokens(cached.tokens));
		}
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
		const wrap = append(this.bodyEl, $('.ctxb-rowwrap'));
		const row = append(wrap, $(`.ctxb-row${clickable ? '.clickable' : ''}`));

		// A file with multiple headings gets an expand chevron showing its per-section token breakdown.
		const expandable = !!(src.resource && src.headings && src.headings.length > 1);
		const toggle = append(row, $(expandable ? '.ctxb-expand.codicon.codicon-chevron-right' : '.ctxb-expand'));

		const badge = tierBadge(src.tier);
		append(row, $(`.ctxb-scope.${badge.cls}`, undefined, badge.letter));

		const name = append(row, $('.ctxb-name'));
		name.textContent = src.label;
		name.title = src.label;

		if (src.resource && this.confirmedLoads?.has(normalizeConfirmedPath(src.resource.fsPath))) {
			const c = append(row, $('.ctxb-confirmed.codicon.codicon-pass'));
			c.title = localize('clawdius.ctxb.confirmedTip', "Confirmed loaded in a recent Claude session");
		}

		if (src.kind === 'import') {
			append(row, $('.ctxb-glob', undefined, localize('clawdius.ctxb.viaImport', "via @import")));
		} else if (src.kind === 'automem') {
			append(row, $('.ctxb-glob', undefined, localize('clawdius.ctxb.autoMem', "auto memory")));
		} else if (src.kind === 'skill' && src.description) {
			// The skill's description is the "when" the model uses to decide to invoke it.
			const d = append(row, $('.ctxb-glob'));
			d.textContent = src.description.length > 64 ? src.description.slice(0, 61) + '…' : src.description;
			d.title = src.description;
		}

		if (src.nested) {
			const n = append(row, $('.ctxb-glob'));
			n.textContent = localize('clawdius.ctxb.nested', "nested · loads on read");
			n.title = localize('clawdius.ctxb.nestedTip', "A subdirectory CLAUDE.md - Claude loads it on demand when it reads files in that folder.");
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

		if (expandable && src.resource && src.headings) {
			const resource = src.resource;
			const headings = src.headings;
			const sub = append(wrap, $('.ctxb-sub'));
			sub.style.display = 'none';
			this.renderStore.add(addDisposableListener(toggle, EventType.CLICK, e => {
				e.stopPropagation(); // don't also open the file
				const show = sub.style.display === 'none';
				sub.style.display = show ? 'block' : 'none';
				toggle.classList.toggle('codicon-chevron-right', !show);
				toggle.classList.toggle('codicon-chevron-down', show);
				if (show && !sub.hasChildNodes()) { this.renderHeadings(sub, resource, headings); }
			}));
		}
	}

	/** Render a file's per-heading breakdown, heaviest section first; each row jumps to that heading's line. */
	private renderHeadings(container: HTMLElement, resource: URI, headings: readonly IBudgetHeading[]): void {
		for (const h of [...headings].sort((a, b) => b.approxTokens - a.approxTokens)) {
			const hr = append(container, $('.ctxb-subrow.clickable'));
			const nm = append(hr, $('.ctxb-name'));
			nm.textContent = h.label;
			nm.title = h.label;
			append(hr, $('.ctxb-tok.dim', undefined, formatApproxTokens(h.approxTokens)));
			const line = h.lineNumber;
			this.renderStore.add(addDisposableListener(hr, EventType.CLICK, () => {
				void this.editorService.openEditor({ resource, options: { selection: { startLineNumber: line, startColumn: 1 } } });
			}));
		}
	}
}
// CLAWDIUS-END
