/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Control Center editor input
// A singleton EditorInput for the interactive Control Center (Permissions tab in the MVP; MCP/Skills/Plugins/
// Hooks tabs land later). The selected tab + scope are in-pane state, so a single input suffices. NOT readonly:
// the pane writes the user's ~/.claude settings.json. Opened from the config sidebar + command palette.

import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

const ClaudeControlCenterIcon = registerIcon('clawdius-control-center-icon', Codicon.claude, localize('clawdius.control.icon', "Icon of the Claude Code Control Center."));

export class ClaudeControlCenterInput extends EditorInput {

	static readonly ID = 'workbench.input.clawdiusControlCenter';

	override get typeId(): string {
		return ClaudeControlCenterInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// Singleton (scope/tab is in-pane state). Not Readonly - the pane edits settings.json.
		return EditorInputCapabilities.Singleton;
	}

	private static _instance: ClaudeControlCenterInput | undefined;
	static get instance(): ClaudeControlCenterInput {
		if (!ClaudeControlCenterInput._instance || ClaudeControlCenterInput._instance.isDisposed()) {
			ClaudeControlCenterInput._instance = new ClaudeControlCenterInput();
		}
		return ClaudeControlCenterInput._instance;
	}

	readonly resource = URI.from({ scheme: 'clawdius-control-center', path: 'default' });

	override getName(): string {
		return localize('clawdius.control.name', "Claude Code Control Center");
	}

	override getIcon(): ThemeIcon {
		return ClaudeControlCenterIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ClaudeControlCenterInput;
	}
}
// CLAWDIUS-END
