/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN permission-mode status-bar indicator (N3-3a)
// A bottom-right status-bar pill showing the DEFAULT Claude permission mode for new conversations. Titles,
// descriptions, and ordering mirror the official `anthropic.claude-code` chat selector (Plan mode / Ask before
// edits / Edit automatically / Bypass permissions) so the two surfaces read the same. Clicking it (or running
// "Clawdius: Set Default Permission Mode") opens a quick pick to change it.
//
// Honesty note on scope: the official plugin (2.1.187) does NOT expose the LIVE per-conversation permission mode
// to the host - it changes the mode over a private webview channel (`set_permission_mode`) and only persists a
// subset into its own `globalState`, never into observable configuration. So this widget reads/writes the
// documented `claudeCode.initialPermissionMode` setting (the "Initial permission mode for new conversations"),
// which `getInitialPermissionMode()` reads first - making our write authoritative for the NEXT conversation. It
// is a default control, not a live-session mirror. A live mirror needs an Anthropic API; tracked as a feature
// request. The plugin's chat selector also offers "Auto mode", which is NOT in the public config enum (it lives
// only in the plugin's private state), so it is intentionally omitted here.
//
// Bypass: selecting "Bypass permissions" also enables the plugin's gate
// (`claudeCode.allowDangerouslySkipPermissions=true`) so the choice actually takes effect; choosing any other
// mode never sets that gate back to false (a deliberate one-way enable - we don't silently disable a safety the
// user may rely on elsewhere).
//
// The display + picker + write logic is factored into pure exported functions (parsePermissionMode /
// permissionModeDisplay / permissionModePicks / permissionModeWrites) so titles, icons, colors, and the
// bypass-enable behavior are unit-testable without booting a workbench (see test/browser/...).

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import product from '../../../../platform/product/common/product.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { STATUS_BAR_ERROR_ITEM_BACKGROUND, STATUS_BAR_ERROR_ITEM_FOREGROUND, STATUS_BAR_WARNING_ITEM_BACKGROUND, STATUS_BAR_WARNING_ITEM_FOREGROUND } from '../../../common/theme.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/** The four documented permission modes (the `claudeCode.initialPermissionMode` enum). Auto mode is omitted - it is not in the public config enum. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** The plugin setting that backs the default mode for new conversations. */
export const INITIAL_PERMISSION_MODE_KEY = 'claudeCode.initialPermissionMode';
/** The plugin setting that gates whether Bypass Permissions takes effect. Selecting Bypass enables it. */
export const ALLOW_BYPASS_KEY = 'claudeCode.allowDangerouslySkipPermissions';
/** Command that opens the mode quick pick (also the status-bar entry's click command + a palette entry). */
export const SET_PERMISSION_MODE_COMMAND_ID = 'clawdius.setPermissionMode';

/** Plan mode (the safest mode) gets a filled green highlight to set it apart from the plain Default. */
const PERMISSION_PLAN_BACKGROUND = registerColor('clawdius.permissionPlanBackground', {
	dark: '#1F7A35', light: '#1A7F37', hcDark: '#176B30', hcLight: '#0E5223'
}, localize('clawdius.perm.planBackground', "Background of the Clawdius permission-mode status item when Plan mode (the safest mode) is the default."));
const PERMISSION_PLAN_FOREGROUND = registerColor('clawdius.permissionPlanForeground', {
	dark: '#FFFFFF', light: '#FFFFFF', hcDark: '#FFFFFF', hcLight: '#FFFFFF'
}, localize('clawdius.perm.planForeground', "Foreground of the Clawdius permission-mode status item when Plan mode is the default."));

/** Visual tone -> drives status-bar coloring. safe = green fill; none = plain; warn/danger = filled background. */
export type ModeTone = 'safe' | 'none' | 'warn' | 'danger';

export interface IPermissionModeInfo {
	readonly value: PermissionMode;
	/** Display label mirroring the plugin's chat selector. */
	readonly label: string;
	readonly detail: string;
	readonly icon: ThemeIcon;
	readonly tone: ModeTone;
}

/**
 * Ordered safest -> most permissive, mirroring the plugin's chat selector. Labels/descriptions are taken
 * verbatim from `anthropic.claude-code` 2.1.187 so the status pill and the chat read identically. Icons are the
 * closest stock codicons (the plugin's own glyphs are bespoke SVGs in its webview, not codicons; exact parity
 * would require adding them to an icon font).
 */
export function permissionModes(): IPermissionModeInfo[] {
	return [
		{ value: 'plan', label: localize('clawdius.perm.plan', "Plan mode"), detail: localize('clawdius.perm.plan.detail', "Claude will explore the code and present a plan before editing"), icon: Codicon.eye, tone: 'safe' },
		{ value: 'default', label: localize('clawdius.perm.default', "Ask before edits"), detail: localize('clawdius.perm.default.detail', "Claude will ask for approval before making each edit"), icon: Codicon.shield, tone: 'none' },
		{ value: 'acceptEdits', label: localize('clawdius.perm.acceptEdits', "Edit automatically"), detail: localize('clawdius.perm.acceptEdits.detail', "Claude will edit your selected text or the whole file"), icon: Codicon.edit, tone: 'warn' },
		{ value: 'bypassPermissions', label: localize('clawdius.perm.bypass', "Bypass permissions"), detail: localize('clawdius.perm.bypass.detail', "Claude will not ask for approval before running potentially dangerous commands"), icon: Codicon.zap, tone: 'danger' },
	];
}

function modeInfo(value: PermissionMode): IPermissionModeInfo {
	return permissionModes().find(m => m.value === value) ?? permissionModes()[1];
}

/** Coerce a raw setting value (possibly unset / unknown) to a valid mode, defaulting to `default`. */
export function parsePermissionMode(value: string | undefined): PermissionMode {
	return (value === 'plan' || value === 'acceptEdits' || value === 'bypassPermissions') ? value : 'default';
}

function readMode(configurationService: IConfigurationService): PermissionMode {
	return parsePermissionMode(configurationService.getValue<string>(INITIAL_PERMISSION_MODE_KEY));
}

function bypassAllowed(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<boolean>(ALLOW_BYPASS_KEY) === true;
}

/** The resolved presentation of the status-bar pill for a configured mode + bypass gate. Pure + testable. */
export interface IPermissionModeDisplay {
	/** The EFFECTIVE mode shown (bypass clamps to default when its gate is off). */
	readonly mode: PermissionMode;
	readonly label: string;
	/** Status-bar entry text, e.g. `$(eye) Plan mode`. */
	readonly text: string;
	readonly ariaLabel: string;
	readonly tone: ModeTone;
	/** Markdown source for the hover tooltip. */
	readonly tooltip: string;
	/** True when Bypass is configured but disabled by its gate (so the pill shows the Default fallback). */
	readonly bypassGatedOff: boolean;
}

/**
 * Resolve what the pill should show. If Bypass permissions is configured but its gate
 * (`claudeCode.allowDangerouslySkipPermissions`) is off, the plugin clamps new conversations back to the Default
 * ("Ask before edits") mode, so the pill must show that - not claim a bypass that will not happen.
 */
export function permissionModeDisplay(configured: PermissionMode, allowBypass: boolean): IPermissionModeDisplay {
	const bypassGatedOff = configured === 'bypassPermissions' && !allowBypass;
	const info = modeInfo(bypassGatedOff ? 'default' : configured);
	const tooltip = bypassGatedOff
		? localize(
			'clawdius.perm.tooltip.gated',
			"**Bypass permissions** is configured but disabled by the `claudeCode.allowDangerouslySkipPermissions` setting, so new Claude conversations fall back to **Ask before edits**.\n\nClick to change. This sets the default for new conversations; it does not change a chat already in progress.",
		)
		: localize(
			'clawdius.perm.tooltip',
			"**Default permission mode** for new Claude conversations: **{0}**\n\n{1}\n\nClick to change. This sets the default for new conversations; it does not change a chat already in progress.",
			info.label, info.detail,
		);
	return {
		mode: info.value,
		label: info.label,
		text: `$(${info.icon.id}) ${info.label}`,
		ariaLabel: localize('clawdius.perm.aria', "Claude default permission mode: {0}", info.label),
		tone: info.tone,
		tooltip,
		bypassGatedOff,
	};
}

export interface IModePick extends IQuickPickItem {
	readonly mode: PermissionMode;
}

/**
 * The quick-pick items for choosing a mode - all four, always (selecting Bypass enables its gate, so it is never
 * hidden). The current mode is marked.
 */
export function permissionModePicks(current: PermissionMode): IModePick[] {
	return permissionModes().map(m => ({
		label: m.label,
		detail: m.detail,
		description: m.value === current ? localize('clawdius.perm.current', "Current") : undefined,
		iconClass: ThemeIcon.asClassName(m.icon),
		mode: m.value,
	}));
}

/** A single configuration write (key + value + USER target is implied by the caller). */
export interface IPermissionModeWrite {
	readonly key: string;
	readonly value: string | boolean;
}

/**
 * The configuration writes for selecting a mode. Choosing Bypass also enables its gate so the choice takes
 * effect; no other mode touches the gate (we never set it back to false - a one-way enable).
 */
export function permissionModeWrites(mode: PermissionMode): IPermissionModeWrite[] {
	const writes: IPermissionModeWrite[] = [{ key: INITIAL_PERMISSION_MODE_KEY, value: mode }];
	if (mode === 'bypassPermissions') {
		writes.push({ key: ALLOW_BYPASS_KEY, value: true });
	}
	return writes;
}

/**
 * Opens a quick pick to set the default permission mode for new Claude conversations, then writes the choice to
 * `claudeCode.initialPermissionMode` (USER scope), enabling the bypass gate when Bypass is chosen.
 */
export class SetPermissionModeAction extends Action2 {

	static readonly ID = SET_PERMISSION_MODE_COMMAND_ID;

	constructor() {
		super({
			id: SET_PERMISSION_MODE_COMMAND_ID,
			title: localize2('clawdius.setPermissionMode', "Set Default Permission Mode"),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const commandService = accessor.get(ICommandService);

		const current = readMode(configurationService);
		const wasBypassAllowed = bypassAllowed(configurationService);
		const basePicks = permissionModePicks(current);
		const activeItem = basePicks.find(p => p.mode === current);
		// A trailing separator pins a note at the BOTTOM of the list (consistent with the effort widget).
		const picks: QuickPickInput<IModePick>[] = [
			...basePicks,
			{ type: 'separator', label: localize('clawdius.perm.reloadNote', "Changing the default permission mode reloads the open Claude chat to apply it.") },
		];

		const chosen = await quickInputService.pick(picks, {
			title: localize('clawdius.perm.reloadTitle', "Changing the default permission mode reloads the open Claude chat"),
			placeHolder: localize('clawdius.perm.placeholder', "Select the default permission mode for new Claude conversations"),
			matchOnDetail: true,
			activeItem,
		});
		if (!chosen) {
			return;
		}
		// Always apply the writes (idempotent): picking Bypass enables its gate even if Bypass was already the
		// configured-but-gated-off value.
		for (const write of permissionModeWrites(chosen.mode)) {
			await configurationService.updateValue(write.key, write.value, ConfigurationTarget.USER);
		}
		// Reload the open Claude chat so the new default applies (consistent with the effort widget) - but only
		// when the EFFECTIVE configuration changed, since restartExtensionHost restarts all extensions. That is
		// either a mode change OR newly enabling the bypass gate (picking Bypass when it was configured-but-gated-
		// off flips the gate to true without changing the mode string, yet the behavior does change).
		const modeChanged = chosen.mode !== current;
		const bypassGateEnabled = chosen.mode === 'bypassPermissions' && !wasBypassAllowed;
		if (modeChanged || bypassGateEnabled) {
			await commandService.executeCommand('workbench.action.restartExtensionHost');
		}
	}
}

/** Renders the default permission mode as a tone-colored status-bar pill and keeps it in sync with settings. */
export class ClawdiusPermissionModeStatusEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusPermissionModeStatusEntry';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// Only in Clawdius mode (defaultChatAgent has no entitlementUrl); elsewhere this surface is meaningless.
		if (product.defaultChatAgent?.entitlementUrl) {
			return;
		}

		this.update();
		// Re-render when the configured default changes (Settings editor, or our own write), and re-evaluate the
		// Bypass gate when the allow-bypass setting flips.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(INITIAL_PERMISSION_MODE_KEY) || e.affectsConfiguration(ALLOW_BYPASS_KEY)) {
				this.update();
			}
		}));
	}

	private update(): void {
		const props = this.getProps();
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			// Absolute priority (not a relative anchor) so the Claude status items keep a stable, deterministic
			// position: effort (100.07), permission (100.06), then the usage meter to their right.
			this.entry.value = this.statusbarService.addEntry(props, 'clawdius.permissionMode', StatusbarAlignment.RIGHT, 100.06);
		}
	}

	private getProps(): IStatusbarEntry {
		const display = permissionModeDisplay(readMode(this.configurationService), bypassAllowed(this.configurationService));

		let backgroundColor: IStatusbarEntry['backgroundColor'];
		let color: IStatusbarEntry['color'];
		switch (display.tone) {
			case 'danger':
				backgroundColor = themeColorFromId(STATUS_BAR_ERROR_ITEM_BACKGROUND);
				color = themeColorFromId(STATUS_BAR_ERROR_ITEM_FOREGROUND);
				break;
			case 'warn':
				backgroundColor = themeColorFromId(STATUS_BAR_WARNING_ITEM_BACKGROUND);
				color = themeColorFromId(STATUS_BAR_WARNING_ITEM_FOREGROUND);
				break;
			case 'safe':
				// Plan mode: filled green highlight (the safest mode stands out positively).
				backgroundColor = themeColorFromId(PERMISSION_PLAN_BACKGROUND);
				color = themeColorFromId(PERMISSION_PLAN_FOREGROUND);
				break;
			case 'none':
				break;
		}

		return {
			name: localize('clawdius.perm.name', "Claude Permission Mode"),
			text: display.text,
			ariaLabel: display.ariaLabel,
			tooltip: new MarkdownString(display.tooltip),
			command: SET_PERMISSION_MODE_COMMAND_ID,
			backgroundColor,
			color,
		};
	}
}
// CLAWDIUS-END
