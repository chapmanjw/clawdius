/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN missing-plugin status-bar safety net
// A bottom-right status-bar warning that appears ONLY when the critical `anthropic.claude-code` plugin is absent
// while in Clawdius mode (the plugin owns the chat pane + sessions, so its absence means Clawdius is degraded).
// Clicking it runs `clawdius.installClaudeCodePlugin` to (re)install from the gallery. It is shown/hidden live as
// extensions are installed or removed; in non-Clawdius mode it never registers. Presence is read from the
// authoritative installed-on-disk list (IExtensionsWorkbenchService.local), not the host-registered list, so a
// plugin that is installed but fails to load is not falsely reported as missing.

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { INSTALL_CLAUDE_CODE_PLUGIN_COMMAND_ID, isClaudeCodePluginInstalled } from './clawdiusPluginSetup.js';

/** Shows a warning status-bar entry while the Claude Code plugin is missing, driving the user to reinstall it. */
export class ClawdiusMissingPluginStatusEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusMissingPluginStatusEntry';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IProductService productService: IProductService,
	) {
		super();

		// Only in Clawdius mode (defaultChatAgent has no entitlementUrl); elsewhere the plugin is irrelevant.
		if (productService.defaultChatAgent?.entitlementUrl) {
			return;
		}

		void this._init();
	}

	/** Populate the installed-on-disk list before the first render, then track changes. `.local` is filled
	 *  lazily, so reading it synchronously at construction would briefly look like the plugin is absent and
	 *  flash a "missing" pill on a clean startup; awaiting `queryLocal()` first avoids that false negative. */
	private async _init(): Promise<void> {
		await this.extensionsWorkbenchService.queryLocal();
		this.update();
		// Appear / disappear as the plugin is installed or removed.
		this._register(this.extensionsWorkbenchService.onChange(() => this.update()));
	}

	private update(): void {
		// Show only when the plugin is missing; otherwise clear the entry entirely.
		if (isClaudeCodePluginInstalled(this.extensionsWorkbenchService)) {
			this.entry.clear();
			return;
		}
		const props = this.getProps();
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			// Absolute priority sitting just to the left of the other Claude status items (effort 100.07,
			// permission 100.06) so the warning leads the cluster when it is present.
			this.entry.value = this.statusbarService.addEntry(props, 'clawdius.missingPlugin', StatusbarAlignment.RIGHT, 100.08);
		}
	}

	private getProps(): IStatusbarEntry {
		return {
			name: localize('clawdius.missingPlugin.name', "Claude Code Plugin"),
			text: `$(warning) ${localize('clawdius.missingPlugin.text', "Claude Code plugin missing")}`,
			ariaLabel: localize('clawdius.missingPlugin.aria', "Claude Code plugin missing"),
			tooltip: localize('clawdius.missingPlugin.tooltip', "The Claude Code plugin is not installed - click to install."),
			command: INSTALL_CLAUDE_CODE_PLUGIN_COMMAND_ID,
			kind: 'warning',
		};
	}
}
// CLAWDIUS-END
