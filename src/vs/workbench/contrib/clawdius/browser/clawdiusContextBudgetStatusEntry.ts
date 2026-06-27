/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IClawdiusConfigService } from '../common/clawdiusConfig.js';
import { formatApproxTokens, IBudgetSource, IContextBudget, resolveContextBudget } from '../common/clawdiusContextBudget.js';
import { CONTEXT_BUDGET_VIEW_ID } from './clawdiusContextBudgetView.js';

export const OPEN_CONTEXT_BUDGET_COMMAND_ID = 'clawdius.openContextBudget';

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

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IEditorService private readonly editorService: IEditorService,
		@IClawdiusConfigService private readonly configService: IClawdiusConfigService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();

		// Only in Clawdius mode (defaultChatAgent has no entitlementUrl); elsewhere this surface is meaningless.
		if (product.defaultChatAgent?.entitlementUrl) {
			return;
		}

		// Re-resolve when the active file changes (different glob rules apply) or config is edited.
		this._register(this.editorService.onDidActiveEditorChange(() => this.update()));
		this._register(this.configService.onDidChange(() => this.update()));
		this.update();
		// The snapshot is empty until the first refresh (coalesced in the store).
		void this.configService.refresh();
	}

	private activeFile(): URI | undefined {
		return EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
			filterByScheme: [Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData],
		});
	}

	private update(): void {
		const folders = this.workspaceService.getWorkspace().folders.map(f => f.uri);
		const budget = resolveContextBudget(this.configService.snapshot, this.activeFile(), folders);
		const props = this.getProps(budget);
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			// Absolute priority just left of the permission pill (100.06) / effort pill (100.07) cluster.
			this.entry.value = this.statusbarService.addEntry(props, 'clawdius.contextBudget', StatusbarAlignment.RIGHT, 100.05);
		}
	}

	private getProps(budget: IContextBudget): IStatusbarEntry {
		const label = formatApproxTokens(budget.alwaysOnTokens);
		return {
			name: localize('clawdius.ctxb.statusName', "Claude Context Budget"),
			text: `$(book) ${label}`,
			ariaLabel: localize('clawdius.ctxb.statusAria', "Claude context budget: {0} tokens always-on (estimated)", label),
			tooltip: new MarkdownString(this.tooltip(budget)),
			command: OPEN_CONTEXT_BUDGET_COMMAND_ID,
		};
	}

	private tooltip(budget: IContextBudget): string {
		const lines: string[] = [];
		lines.push(localize('clawdius.ctxb.tipTitle', "**Context budget** — what Claude loads for the active file"));
		lines.push('');
		lines.push(localize('clawdius.ctxb.tipAlways', "Always-on (~every turn): **{0} tokens**", formatApproxTokens(budget.alwaysOnTokens).replace('~', '')));
		for (const s of budget.alwaysOn) {
			lines.push(this.tipRow(s));
		}
		if (budget.onInvoke.length) {
			lines.push('');
			lines.push(localize('clawdius.ctxb.tipOnInvoke', "On-invoke (skills)"));
			for (const s of budget.onInvoke) {
				lines.push(this.tipRow(s));
			}
		}
		lines.push('');
		lines.push(localize('clawdius.ctxb.tipFoot', "_Estimated (chars/4). Click to open the full panel._"));
		return lines.join('\n');
	}

	private tipRow(s: IBudgetSource): string {
		const tok = s.kind === 'skill' ? localize('clawdius.ctxb.onUse', "on use") : formatApproxTokens(s.approxTokens);
		return localize('clawdius.ctxb.tipItem', "- `{0}` {1} — {2}", s.tier, s.label, tok);
	}
}
// CLAWDIUS-END
