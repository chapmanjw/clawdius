/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN install + configure the official Claude Code plugin (plugin-adoption pivot)
// On first launch in Clawdius mode, install Anthropic's official `anthropic.claude-code` extension from the
// configured gallery (Open VSX) if it is not already present, then point it at the secondary sidebar using
// its bundled engine + the user's existing `~/.claude` auth. The visible chat is the plugin's OWN webview
// pane -- Clawdius does not reimplement it. Runs once (storage-flagged); a failure does not block startup and
// is retried on the next launch.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';

/** Install + configure the official Claude Code plugin on first run (Clawdius mode only). */
export class ClawdiusPluginSetupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusPluginSetup';

	/** Open VSX / marketplace id of the official Anthropic Claude Code extension. */
	private static readonly EXTENSION_ID = 'anthropic.claude-code';

	/** Set once the first-run install + config has completed, so it never re-runs. */
	private static readonly DONE_KEY = 'clawdius.pluginSetup.done';

	constructor(
		@IExtensionsWorkbenchService private readonly _extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		if (this._storageService.getBoolean(ClawdiusPluginSetupContribution.DONE_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		void this._run();
	}

	private async _run(): Promise<void> {
		try {
			await this._ensureInstalled();
			await this._configure();
			this._storageService.store(ClawdiusPluginSetupContribution.DONE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this._notifyReady();
		} catch (err) {
			// Do NOT set the done flag: a transient failure (offline, gallery hiccup) is retried next launch.
			this._logService.warn('[clawdius] first-run Claude Code plugin setup failed; will retry next launch', err);
		}
	}

	/** One-time confirmation that the plugin is set up, with a shortcut to change the engine / provider. */
	private _notifyReady(): void {
		this._notificationService.prompt(
			Severity.Info,
			localize('clawdius.pluginReady', "Claude Code is ready, using its bundled engine and your existing ~/.claude login. You can change the engine or provider in Settings."),
			[{ label: localize('clawdius.configureEngine', "Configure engine"), run: () => this._commandService.executeCommand('workbench.action.openSettings', 'claudeCode') }],
		);
	}

	/** Install `anthropic.claude-code` from the configured gallery (Open VSX) unless it is already installed. */
	private async _ensureInstalled(): Promise<void> {
		const installed = await this._extensionsWorkbenchService.queryLocal();
		if (installed.some(extension => areSameExtensions(extension.identifier, { id: ClawdiusPluginSetupContribution.EXTENSION_ID }))) {
			return;
		}
		// NOTE: if a built (non-dev) build rejects the Open VSX download on signature verification, add
		// `donotVerifySignature: true` to these options -- Open VSX does not sign extensions the way the MS
		// marketplace does. Left off by default so signature verification still applies where it can; flip it
		// on (with this rationale) if a real build proves it necessary.
		await this._extensionsWorkbenchService.install(
			ClawdiusPluginSetupContribution.EXTENSION_ID,
			{ context: { [EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT]: true }, enable: true },
			ProgressLocation.Notification,
		);
	}

	/** Point the plugin at the secondary sidebar + its bundled engine, without clobbering user overrides. */
	private async _configure(): Promise<void> {
		await this._setIfUnset('claudeCode.preferredLocation', 'sidebar');
		await this._setIfUnset('claudeCode.useTerminal', false);
		await this._setIfUnset('claudeCode.hideOnboarding', true);
		// Engine = the plugin's bundled claude.exe (default): `claudeCode.claudeProcessWrapper` is left UNSET.
		// The user can set `claudeCode.claudeProcessWrapper` / `claudeCode.environmentVariables` later to point
		// at a custom engine / provider (an advanced wrapper, since the field wraps -- not replaces -- the CLI).
	}

	/** Write a plugin setting only when the user has not already set it, so we never override their choice. */
	private async _setIfUnset(key: string, value: unknown): Promise<void> {
		const inspected = this._configurationService.inspect(key);
		if (inspected.userValue === undefined && inspected.userLocalValue === undefined && inspected.userRemoteValue === undefined) {
			await this._configurationService.updateValue(key, value, ConfigurationTarget.USER);
		}
	}
}
// CLAWDIUS-END
