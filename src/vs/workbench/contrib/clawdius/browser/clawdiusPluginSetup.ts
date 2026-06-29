/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN install + configure the official Claude Code plugin (plugin-adoption pivot)
// On first launch in Clawdius mode, install Anthropic's official `anthropic.claude-code` extension from the
// configured gallery (Open VSX) if it is not already present, then point it at the secondary sidebar using
// its bundled engine + the user's existing `~/.claude` auth. The visible chat is the plugin's OWN webview
// pane -- Clawdius does not reimplement it. The first-run flow is storage-flagged so its one-time pieces (the
// optional jeanp413 remotes, the plugin config, the ready notification) run once; a failure does not block
// startup and is retried on the next launch.
//
// Presence safety net: the critical `anthropic.claude-code` plugin is what makes Clawdius work, and it is now
// uninstall-protected -- but a FAILED first-run install (offline, gallery error) leaves it absent and Clawdius
// degraded. So presence is tracked in a context key + the install is RE-OFFERED on a later launch whenever the
// critical plugin is missing, regardless of the one-time done flag. Other surfaces (status bar, Control Center
// banner, welcome page) read presence via `isClaudeCodePluginInstalled` and the `clawdius.installClaudeCodePlugin`
// command registered here.
//
// Presence is read from IExtensionsWorkbenchService.local (the authoritative INSTALLED-on-disk list), NOT from
// IExtensionService.extensions (which only reflects what the extension host has REGISTERED). A plugin that is
// installed but fails to register in the host (e.g. an engine-version mismatch in a dev build) is present on disk
// and must NOT be treated as missing - reinstalling would not fix a load failure.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { isNative, isWindows } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT, ExtensionManagementErrorCode } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { IExtensionManagementServerService } from '../../../services/extensionManagement/common/extensionManagement.js';

/** Open VSX / marketplace id of the official Anthropic Claude Code extension. Module-level (not a static class
 *  field) so the EXTENSIONS list below can reference it without touching the class binding during its own static
 *  initialization - a self-reference there throws "Cannot access ... before initialization" at module load. */
export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

/** Context key reflecting whether the official Claude Code plugin is currently installed. Only meaningful in
 *  Clawdius mode; other surfaces use it (or `isClaudeCodePluginInstalled`) to drive the absence safety net. */
export const CLAUDE_CODE_PLUGIN_INSTALLED_CONTEXT = new RawContextKey<boolean>('clawdius.claudeCodePluginInstalled', false, {
	type: 'boolean',
	description: localize('clawdius.claudeCodePluginInstalledKey', "Whether the official Claude Code plugin is installed. Only meaningful in Clawdius mode."),
});

/** Command that (re)installs the official Claude Code plugin from the gallery. Wired to the status-bar entry and
 *  the Control Center absence banner; also a "Clawdius: Install Claude Code Plugin" palette entry. */
export const INSTALL_CLAUDE_CODE_PLUGIN_COMMAND_ID = 'clawdius.installClaudeCodePlugin';

/** Install-error identifiers that mean "signature verification failed" (built builds only). Checked against
 *  both `.code` and `.name`: across an IPC boundary the error is recreated as a plain Error that preserves
 *  `.name` but drops the custom `.code`. */
const SIGNATURE_FAILURE_IDS = new Set<string>([
	ExtensionManagementErrorCode.PackageNotSigned,
	ExtensionManagementErrorCode.SignatureVerificationInternal,
	ExtensionManagementErrorCode.SignatureVerificationFailed,
	ExtensionManagementErrorCode.DownloadSignature,
]);

/** True when an install error means "signature verification failed", so the install is worth retrying without
 *  verification. Checks both `.code` and `.name` because across an IPC boundary the error is recreated as a plain
 *  Error that preserves `.name` but drops the custom `.code`. Pure: a function of the error shape only. */
export function isSignatureFailure(err: unknown): boolean {
	const candidate = err as { code?: unknown; name?: unknown } | undefined;
	const code = typeof candidate?.code === 'string' ? candidate.code : undefined;
	const name = typeof candidate?.name === 'string' ? candidate.name : undefined;
	return (code !== undefined && SIGNATURE_FAILURE_IDS.has(code)) || (name !== undefined && SIGNATURE_FAILURE_IDS.has(name));
}

function installFromGallery(extensionsWorkbenchService: IExtensionsWorkbenchService, id: string, donotVerifySignature: boolean): Promise<unknown> {
	return extensionsWorkbenchService.install(
		id,
		// installEverywhere: when a remote is connected, route a workspace-kind extension into the remote
		// server (local already has it); on a plain desktop window it resolves to the local server.
		{ context: { [EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT]: true }, enable: true, installEverywhere: true, donotVerifySignature },
		ProgressLocation.Notification,
	);
}

/** Installs in flight keyed by extension id, so concurrent callers (the first-run setup flow and the manual
 *  install command behind the status pill / Control Center banner / palette) coalesce onto a single gallery
 *  request instead of racing two parallel downloads of the same extension. Cleared when the install settles. */
const inFlightGalleryInstalls = new Map<string, Promise<void>>();

/**
 * Install one extension from the configured gallery (Open VSX). Verify signatures normally (they ARE enforced in
 * built builds); only on a signature-specific failure retry once without verification - a known-id bootstrap from
 * a gallery Clawdius already trusts (Open VSX), which does not sign extensions the MS-marketplace way, not an
 * arbitrary install, so the scoped fallback is acceptable. Shared by the first-run flow and the install command;
 * concurrent callers for the same id share one in-flight install (no double download).
 */
export function installClaudeGalleryExtension(extensionsWorkbenchService: IExtensionsWorkbenchService, logService: ILogService, id: string): Promise<void> {
	const existing = inFlightGalleryInstalls.get(id);
	if (existing) {
		return existing;
	}
	const install = doInstallClaudeGalleryExtension(extensionsWorkbenchService, logService, id)
		.finally(() => inFlightGalleryInstalls.delete(id));
	inFlightGalleryInstalls.set(id, install);
	return install;
}

async function doInstallClaudeGalleryExtension(extensionsWorkbenchService: IExtensionsWorkbenchService, logService: ILogService, id: string): Promise<void> {
	try {
		await installFromGallery(extensionsWorkbenchService, id, false);
	} catch (err) {
		if (!isSignatureFailure(err)) {
			throw err;
		}
		logService.warn(`[clawdius] ${id} signature verification failed on Open VSX; retrying the install without verification`, err);
		await installFromGallery(extensionsWorkbenchService, id, true);
	}
}

/** True when an extension with `id` appears in the installed-on-disk list. Membership uses `areSameExtensions`
 *  (id match is case-insensitive), so this is a pure function of the list + id - no service needed. */
export function isExtensionInstalled(local: readonly { identifier: { id: string } }[], id: string): boolean {
	return local.some(e => areSameExtensions(e.identifier, { id }));
}

/** True when the official Claude Code plugin is INSTALLED on disk right now (regardless of whether the extension
 *  host managed to register it - a load failure must not read as "missing", which would prompt a useless reinstall).
 *  Takes the authoritative installed list (`IExtensionsWorkbenchService.local`) so the predicate is testable without
 *  the service. */
export function isClaudeCodePluginInstalled(local: readonly { identifier: { id: string } }[]): boolean {
	return isExtensionInstalled(local, CLAUDE_CODE_EXTENSION_ID);
}

/** Decide whether a default extension should be installed on this launch. Pure decision over the extension's
 *  gating (`when`), whether it is already installed, and whether first-run is already done (a later re-offer only
 *  heals the `critical` plugin, never the optional first-run-only ones). */
export function shouldInstallExtension(ext: { critical?: boolean; when?: () => boolean }, done: boolean, isInstalled: boolean): boolean {
	if ((ext.when && !ext.when()) || isInstalled) {
		return false;
	}
	if (done && !ext.critical) {
		return false;
	}
	return true;
}

/** Installs (or reinstalls) the official Claude Code plugin from the gallery, surfacing a failure to the user.
 *  Backs the status-bar entry, the Control Center absence banner, and the command palette. */
export class InstallClaudeCodePluginAction extends Action2 {

	static readonly ID = INSTALL_CLAUDE_CODE_PLUGIN_COMMAND_ID;

	constructor() {
		super({
			id: INSTALL_CLAUDE_CODE_PLUGIN_COMMAND_ID,
			title: localize2('clawdius.installClaudeCodePlugin', "Install Claude Code Plugin"),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const extensionsWorkbenchService = accessor.get(IExtensionsWorkbenchService);
		const logService = accessor.get(ILogService);
		const notificationService = accessor.get(INotificationService);
		try {
			await installClaudeGalleryExtension(extensionsWorkbenchService, logService, CLAUDE_CODE_EXTENSION_ID);
		} catch (err) {
			notificationService.error(localize('clawdius.installFailed', "Could not install the Claude Code plugin: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
}

/** Install + configure the official Claude Code plugin on first run, and re-offer it later if it goes missing
 *  (Clawdius mode only - the contribution is registered only there). */
export class ClawdiusPluginSetupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusPluginSetup';

	/** Extensions Clawdius installs on first run from the configured gallery (Open VSX). `when` gates by
	 *  platform; `critical` ones (the Claude Code engine) fail the whole setup so it retries next launch, and are
	 *  also the only ones re-offered after first run; optional ones are best-effort, first-run-only. The two
	 *  jeanp413 remotes need their publisher trusted (product.json). */
	private static readonly EXTENSIONS: ReadonlyArray<{ id: string; critical?: boolean; when?: () => boolean }> = [
		{ id: CLAUDE_CODE_EXTENSION_ID, critical: true },
		{ id: 'jeanp413.open-remote-ssh', when: () => isNative },        // Remote - SSH (desktop only)
		{ id: 'jeanp413.open-remote-wsl', when: () => isNative && isWindows }, // Remote - WSL (Windows desktop only)
	];

	/** Set once the first-run install + config has completed, so its one-time pieces never re-run (bumped to
	 *  re-run when the default extension set changes - e.g. adding the jeanp413 remotes). The critical-plugin
	 *  install is re-offered independently of this flag (the absence safety net). */
	private static readonly DONE_KEY = 'clawdius.pluginSetup.done.v2';

	private readonly _installedContext: IContextKey<boolean>;

	constructor(
		@IExtensionsWorkbenchService private readonly _extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IExtensionManagementServerService private readonly _serverService: IExtensionManagementServerService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// Track the plugin's presence (installed-on-disk) in a context key so other surfaces (welcome page,
		// when-clauses) can react, and keep it current as extensions are installed / removed.
		this._installedContext = CLAUDE_CODE_PLUGIN_INSTALLED_CONTEXT.bindTo(contextKeyService);
		this._syncInstalledContext();
		this._register(this._extensionsWorkbenchService.onChange(() => this._syncInstalledContext()));

		void this._init();
	}

	/** Ensure the installed list is populated, sync the context key, then run/re-offer setup as needed. */
	private async _init(): Promise<void> {
		// `.local` is populated lazily; query once so the presence read below (and the context key) is authoritative
		// rather than reading an empty list at startup. The onChange listener keeps the context key current after.
		await this._extensionsWorkbenchService.queryLocal();
		this._syncInstalledContext();

		const done = this._storageService.getBoolean(ClawdiusPluginSetupContribution.DONE_KEY, StorageScope.APPLICATION, false);
		// If the first run already completed AND the critical plugin is installed, there is nothing to do. Otherwise
		// run: a never-completed first run does the full flow; a completed run whose critical plugin is now absent
		// (a failed/offline install, or a later removal) re-offers just the install - the safety net that heals a
		// degraded Clawdius. Failures stay non-fatal and retry next launch.
		if (done && this._isClaudeCodePresentEverywhere()) {
			return;
		}
		void this._run(done);
	}

	private _syncInstalledContext(): void {
		this._installedContext.set(isClaudeCodePluginInstalled(this._extensionsWorkbenchService.local));
	}

	/** True only when the critical plugin is present everywhere it must run: locally, and - when a remote is
	 *  connected - on the remote server specifically. `.local` collapses per-server installs by id, so a
	 *  local-only install reads as present; the remote check uses the un-collapsed `.installed` + `.server`.
	 *  This is why a workspace-kind plugin installed only locally must still be installed into the remote. */
	private _isClaudeCodePresentEverywhere(): boolean {
		const localPresent = isClaudeCodePluginInstalled(this._extensionsWorkbenchService.local);
		const remote = this._serverService.remoteExtensionManagementServer;
		if (!remote) {
			return localPresent;
		}
		const onRemote = this._extensionsWorkbenchService.installed.some(e =>
			e.server === remote && areSameExtensions(e.identifier, { id: CLAUDE_CODE_EXTENSION_ID }));
		return localPresent && onRemote;
	}

	private async _run(done: boolean): Promise<void> {
		try {
			await this._ensureInstalled(done);
			// The optional remotes + the plugin config + the ready notification are first-run-only; a later
			// re-offer (done === true) only heals the critical plugin and does not re-run them.
			if (!done) {
				await this._configure();
				this._storageService.store(ClawdiusPluginSetupContribution.DONE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
				this._notifyReady();
			}
		} catch (err) {
			// Do NOT set the done flag: a transient failure (offline, gallery hiccup) is retried next launch.
			this._logService.warn('[clawdius] Claude Code plugin setup failed; will retry next launch', err);
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

	/** Install each default extension from the configured gallery (Open VSX) unless already present. On a re-offer
	 *  (first run already done) only the critical plugin is retried - the optional remotes are a first-run-only
	 *  convenience and are never reinstalled after the user may have removed them on purpose. */
	private async _ensureInstalled(done: boolean): Promise<void> {
		const installed = await this._extensionsWorkbenchService.queryLocal();
		for (const ext of ClawdiusPluginSetupContribution.EXTENSIONS) {
			// The critical plugin must be present on the remote too (a workspace extension), so use the
			// everywhere-aware check; the optional remotes are local-only first-run conveniences.
			const isInstalled = ext.id === CLAUDE_CODE_EXTENSION_ID
				? this._isClaudeCodePresentEverywhere()
				: isExtensionInstalled(installed, ext.id);
			if (!shouldInstallExtension(ext, done, isInstalled)) {
				continue;
			}
			try {
				await installClaudeGalleryExtension(this._extensionsWorkbenchService, this._logService, ext.id);
			} catch (err) {
				if (ext.critical) {
					throw err; // critical (the Claude Code engine): fail the setup so it retries next launch
				}
				this._logService.warn(`[clawdius] optional first-run install of ${ext.id} failed; skipping`, err);
			}
		}
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
