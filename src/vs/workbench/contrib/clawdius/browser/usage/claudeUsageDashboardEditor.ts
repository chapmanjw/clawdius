/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude usage dashboard editor pane
// A thin native DOM editor pane (no webview => trivially zero-egress) that hosts the shared
// ClaudeUsageDashboardView. The same view also powers the Control Center's Usage tab. `setInput` only READS
// local files (a restored editor never egresses at startup); the live /api/oauth/usage refresh is driven by
// the view's Refresh button. All rendering lives in claudeUsageDashboardView.ts.

import './media/claudeUsage.css';
import { $ as h, append, Dimension, size } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ClaudeUsageDashboardInput } from './claudeUsageDashboardInput.js';
import { ClaudeUsageDashboardView } from './claudeUsageDashboardView.js';

export class ClaudeUsageDashboardEditor extends EditorPane {

	static readonly ID = 'workbench.editor.clawdiusUsageDashboard';

	private container!: HTMLElement;
	private readonly view = this._register(new MutableDisposable<ClaudeUsageDashboardView>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(ClaudeUsageDashboardEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, h('.clawdius-usage-dashboard'));
		this.container.tabIndex = -1; // focusable via focus() but not in the tab order (no focus ring; see CSS)
	}

	override async setInput(input: ClaudeUsageDashboardInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const view = new ClaudeUsageDashboardView(this.container, this.fileService, this.pathService, this.commandService);
		this.view.value = view;
		await view.load(token);
	}

	override focus(): void {
		this.container?.focus();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			size(this.container, dimension.width, dimension.height);
		}
	}
}
// CLAWDIUS-END
