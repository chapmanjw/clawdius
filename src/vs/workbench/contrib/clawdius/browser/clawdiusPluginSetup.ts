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
import { isNative, isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT, ExtensionManagementErrorCode } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';

/** Open VSX / marketplace id of the official Anthropic Claude Code extension. Module-level (not a static class
 *  field) so the EXTENSIONS list below can reference it without touching the class binding during its own static
 *  initialization - a self-reference there throws "Cannot access ... before initialization" at module load. */
const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

/** Install + configure the official Claude Code plugin on first run (Clawdius mode only). */
export class ClawdiusPluginSetupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusPluginSetup';

	/** Extensions Clawdius installs on first run from the configured gallery (Open VSX). `when` gates by
	 *  platform; `critical` ones (the Claude Code engine) fail the whole setup so it retries next launch,
	 *  while optional ones are best-effort. The two jeanp413 remotes need their publisher trusted (product.json). */
	private static readonly EXTENSIONS: ReadonlyArray<{ id: string; critical?: boolean; when?: () => boolean }> = [
		{ id: CLAUDE_CODE_EXTENSION_ID, critical: true },
		{ id: 'jeanp413.open-remote-ssh', when: () => isNative },        // Remote - SSH (desktop only)
		{ id: 'jeanp413.open-remote-wsl', when: () => isNative && isWindows }, // Remote - WSL (Windows desktop only)
	];

	/** Set once the first-run install + config has completed, so it never re-runs (bumped to re-run when the
	 *  default extension set changes - e.g. adding the jeanp413 remotes). */
	private static readonly DONE_KEY = 'clawdius.pluginSetup.done.v2';

	/** Install-error identifiers that mean "signature verification failed" (built builds only). Checked against
	 *  both `.code` and `.name`: across an IPC boundary the error is recreated as a plain Error that preserves
	 *  `.name` but drops the custom `.code`. */
	private static readonly SIGNATURE_FAILURE_IDS = new Set<string>([
		ExtensionManagementErrorCode.PackageNotSigned,
		ExtensionManagementErrorCode.SignatureVerificationInternal,
		ExtensionManagementErrorCode.SignatureVerificationFailed,
		ExtensionManagementErrorCode.DownloadSignature,
	]);

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

	/** Install each default extension from the configured gallery (Open VSX) unless already present. */
	private async _ensureInstalled(): Promise<void> {
		const installed = await this._extensionsWorkbenchService.queryLocal();
		const isInstalled = (id: string) => installed.some(extension => areSameExtensions(extension.identifier, { id }));
		for (const ext of ClawdiusPluginSetupContribution.EXTENSIONS) {
			if ((ext.when && !ext.when()) || isInstalled(ext.id)) {
				continue;
			}
			try {
				await this._installExtension(ext.id);
			} catch (err) {
				if (ext.critical) {
					throw err; // critical (the Claude Code engine): fail the setup so it retries next launch
				}
				this._logService.warn(`[clawdius] optional first-run install of ${ext.id} failed; skipping`, err);
			}
		}
	}

	private async _installExtension(id: string): Promise<void> {
		// Verify signatures normally (they ARE enforced in built builds). Open VSX does not sign extensions the
		// way the MS marketplace does, so a built build can reject the download on a signature-specific failure.
		// Only THEN retry once without verification: a known-id bootstrap from the gallery Clawdius already
		// trusts (Open VSX) for a trusted publisher, not arbitrary install, so the scoped fallback is acceptable.
		try {
			await this._install(id, false);
		} catch (err) {
			if (!this._isSignatureFailure(err)) {
				throw err;
			}
			this._logService.warn(`[clawdius] ${id} signature verification failed on Open VSX; retrying the install without verification`, err);
			await this._install(id, true);
		}
	}

	private _install(id: string, donotVerifySignature: boolean): Promise<unknown> {
		return this._extensionsWorkbenchService.install(
			id,
			{ context: { [EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT]: true }, enable: true, donotVerifySignature },
			ProgressLocation.Notification,
		);
	}

	private _isSignatureFailure(err: unknown): boolean {
		const candidate = err as { code?: unknown; name?: unknown } | undefined;
		const code = typeof candidate?.code === 'string' ? candidate.code : undefined;
		const name = typeof candidate?.name === 'string' ? candidate.name : undefined;
		const ids = ClawdiusPluginSetupContribution.SIGNATURE_FAILURE_IDS;
		return (code !== undefined && ids.has(code)) || (name !== undefined && ids.has(name));
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
