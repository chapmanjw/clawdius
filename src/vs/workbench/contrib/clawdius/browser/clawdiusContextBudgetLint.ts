/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Context Budget - Lint command
// `Claude: Lint Claude Context` walks the always-on memory / rules for the active file and emits Problems-panel
// markers (Info / Hint ONLY - the document is not broken) for files and sections that cost a lot of context
// every turn, suggesting a trim or a move to a path-scoped rule. On-demand (not a nagging live linter), zero new
// I/O (reads the shared config snapshot through the pure resolver).

import { Schemas } from '../../../../base/common/network.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerData, IMarkerService, IResourceMarker, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IClawdiusConfigService } from '../common/clawdiusConfig.js';
import { formatApproxTokens, resolveContextBudget } from '../common/clawdiusContextBudget.js';

export const LINT_CONTEXT_COMMAND_ID = 'clawdius.lintContext';
const MARKER_OWNER = 'clawdius.contextBudget';
/** A memory/rule file over this many always-on tokens gets a trim suggestion (Anthropic recommends CLAUDE.md
 *  stay under ~200 lines). */
const FILE_WARN_TOKENS = 1500;
/** A single heading section over this many always-on tokens gets a hint. */
const SECTION_WARN_TOKENS = 600;

/** Reports always-on context bloat into the Problems panel. On-demand; re-run to refresh, owner-scoped markers. */
export class LintContextAction extends Action2 {

	static readonly ID = LINT_CONTEXT_COMMAND_ID;

	constructor() {
		super({
			id: LINT_CONTEXT_COMMAND_ID,
			title: localize2('clawdius.lintContext', "Lint Claude Context"),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configService = accessor.get(IClawdiusConfigService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const markerService = accessor.get(IMarkerService);
		const notificationService = accessor.get(INotificationService);
		const editorService = accessor.get(IEditorService);

		await configService.refresh();
		const folders = workspaceService.getWorkspace().folders.map(f => f.uri);
		// Resolve for the active file so a matching path-scoped rule is linted too, not just the baseline memory.
		const activeFile = EditorResourceAccessor.getOriginalUri(editorService.activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
			filterByScheme: [Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData],
		});
		// Include nested/subtree CLAUDE.md for the active file so the lint covers what the panel shows.
		const nested = activeFile ? await configService.nestedMemoriesFor(activeFile, folders) : [];
		const budget = resolveContextBudget(configService.snapshot, activeFile, folders, nested);

		const byResource = new ResourceMap<IMarkerData[]>();
		const add = (uri: URI, marker: IMarkerData) => {
			const arr = byResource.get(uri) ?? [];
			arr.push(marker);
			byResource.set(uri, arr);
		};

		for (const src of budget.alwaysOn) {
			if (!src.resource || (src.kind !== 'memory' && src.kind !== 'rule' && src.kind !== 'automem' && src.kind !== 'import')) {
				continue;
			}
			if (src.approxTokens >= FILE_WARN_TOKENS) {
				add(src.resource, {
					severity: MarkerSeverity.Info, source: 'Claude',
					message: localize('clawdius.lint.bigFile', "Loads {0} tokens into Claude every turn (estimated). Consider trimming, or moving file-specific sections into a path-scoped rule (.claude/rules with a `paths:` frontmatter) so they load only when relevant.", formatApproxTokens(src.approxTokens)),
					startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1,
				});
			}
			for (const h of src.headings ?? []) {
				if (h.approxTokens >= SECTION_WARN_TOKENS) {
					add(src.resource, {
						severity: MarkerSeverity.Hint, source: 'Claude',
						message: localize('clawdius.lint.bigSection', "This section is {0} of Claude's always-on tokens (estimated).", formatApproxTokens(h.approxTokens)),
						startLineNumber: h.lineNumber, startColumn: 1, endLineNumber: h.lineNumber, endColumn: 1,
					});
				}
			}
		}

		const data: IResourceMarker[] = [];
		for (const [resource, markers] of byResource) {
			for (const marker of markers) { data.push({ resource, marker }); }
		}
		markerService.changeAll(MARKER_OWNER, data);
		notificationService.info(data.length
			? localize('clawdius.lint.found', "Claude context lint: {0} suggestion(s) added to the Problems panel.", data.length)
			: localize('clawdius.lint.clean', "Claude context lint: no oversized always-on memory or rules found."));
	}
}
// CLAWDIUS-END
