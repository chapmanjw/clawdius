/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN claude usage dashboard editor input
// A read-only singleton EditorInput for the Claude Code usage dashboard. Opened from the status-bar usage
// indicator and from the bottom-left Account button.

import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

const ClaudeUsageDashboardIcon = registerIcon('clawdius-usage-dashboard-icon', Codicon.claude, localize('clawdius.usage.dashboardIcon', "Icon of the Claude Code usage dashboard."));

export class ClaudeUsageDashboardInput extends EditorInput {

	static readonly ID = 'workbench.input.clawdiusUsageDashboard';

	override get typeId(): string {
		return ClaudeUsageDashboardInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	private static _instance: ClaudeUsageDashboardInput | undefined;
	static get instance(): ClaudeUsageDashboardInput {
		if (!ClaudeUsageDashboardInput._instance || ClaudeUsageDashboardInput._instance.isDisposed()) {
			ClaudeUsageDashboardInput._instance = new ClaudeUsageDashboardInput();
		}
		return ClaudeUsageDashboardInput._instance;
	}

	readonly resource = URI.from({ scheme: 'clawdius-usage-dashboard', path: 'default' });

	override getName(): string {
		return localize('clawdius.usage.dashboardName', "Claude Code Usage");
	}

	override getIcon(): ThemeIcon {
		return ClaudeUsageDashboardIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ClaudeUsageDashboardInput;
	}
}
// CLAWDIUS-END
