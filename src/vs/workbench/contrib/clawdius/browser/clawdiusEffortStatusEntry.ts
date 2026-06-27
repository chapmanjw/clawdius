/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN effort-level status-bar indicator (N3-3d)
// A bottom-right status-bar pill showing the DEFAULT effort level for new Claude conversations, with a 10-cell
// block-bar intensity meter (matching the usage bar's width) and the plugin's exact labels (Low / Medium /
// High / Extra high / Max). A sixth option, Ultracode, is the plugin's "Extra high + workflows" superset.
//
// Meter intensity: Low..Extra high fill 2/4/6/8 of 10; Max fills 9 (one short of full); only Ultracode fills
// all 10. Rendered via the native `text` API (icon + block-char meter + label) for stable layout and native
// click/hover/focus - a custom-DOM per-cell animated meter destabilised the status-bar layout, so the animation
// (the recovered CLI rainbow/ultracode specs) is parked for a future, less invasive approach. Ultracode keeps
// its filled purple pill; `animate` is retained on the display type for that future work.
//
// Source of truth: ~/.claude/settings.json (the CLI's own config). Effort is the top-level `effortLevel` key;
// Ultracode is the SEPARATE boolean `ultracode` (effortLevel:'xhigh' + ultracode:true). The official plugin
// reads both to seed its chat selector on a FRESH webview load, so this widget round-trips through the same
// file. Honesty: it sets the default for new chat PANES; an in-pane (+) chat in an already-open panel keeps the
// previous effort until that webview reloads (the plugin seeds effort only when its in-memory value is unset and
// reads a cached config snapshot, not a fresh disk read - confirmed in the bundle; there is no host message to
// push effort into a live webview).

import './media/claudeEffort.css';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import product from '../../../../platform/product/common/product.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { blockBar } from './usage/claudeUsageCharts.js';

/** The effort levels, ordered low -> high. Mirrors the plugin's effortLevel enum (max is model-gated like xhigh). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** A pickable selection: one of the five levels, or Ultracode (xhigh + the ultracode flag). */
export type EffortSelection = EffortLevel | 'ultracode';

export const EFFORT_LEVEL_KEY = 'effortLevel';
export const ULTRACODE_KEY = 'ultracode';
export const SET_EFFORT_COMMAND_ID = 'clawdius.setEffortLevel';

/** Meter width in cells - matches the usage bar (STATUS_BAR_CELLS = 10) so the two line up visually. */
const METER_CELLS = 10;

/** NUL sentinel that the label renderer (iconLabels.ts) recognises to emit per-cell animated meter spans. */
const NUL = String.fromCharCode(0);

/** Wrap the meter so each glyph is its own cell (animated for Max/Ultracode, static otherwise) - lets the CSS
 * size + vertically nudge every effort bar consistently. */
export function meterMarkup(display: IEffortDisplay): string {
	const state = display.animate === 'rainbow' ? 'state-max' : display.animate === 'ultra' ? 'state-ultra' : 'state-plain';
	return `${NUL}${state}${NUL}${display.meter}${NUL}`;
}

/** Ultracode pill highlight (kept darker than the animated lavender glyphs so they stay legible over it). */
const EFFORT_ULTRACODE_BACKGROUND = registerColor('clawdius.effortUltracodeBackground', {
	dark: '#6D28D9', light: '#6D28D9', hcDark: '#5B21B6', hcLight: '#5B21B6'
}, localize('clawdius.effort.ultracodeBg', "Background of the Clawdius effort status item when Ultracode is selected."));
const EFFORT_ULTRACODE_FOREGROUND = registerColor('clawdius.effortUltracodeForeground', {
	dark: '#FFFFFF', light: '#FFFFFF', hcDark: '#FFFFFF', hcLight: '#FFFFFF'
}, localize('clawdius.effort.ultracodeFg', "Foreground of the Clawdius effort status item when Ultracode is selected."));

/** Meter animation: rainbow for Max, purple-white sweep for Ultracode, none otherwise. */
type MeterAnimation = 'rainbow' | 'ultra' | 'none';

interface IEffortLevelInfo {
	readonly value: EffortLevel;
	readonly label: string;
	readonly detail: string;
	/** Filled cells out of METER_CELLS. Monotonic; Max = 9 (one short of full). */
	readonly level: number;
}

/** Level metadata; labels are verbatim from the plugin's effort label map. Descriptions are Clawdius-authored. */
function effortLevels(): IEffortLevelInfo[] {
	return [
		{ value: 'low', label: localize('clawdius.effort.low', "Low"), detail: localize('clawdius.effort.low.detail', "Minimal reasoning. Fastest and cheapest."), level: 2 },
		{ value: 'medium', label: localize('clawdius.effort.medium', "Medium"), detail: localize('clawdius.effort.medium.detail', "Balanced reasoning for everyday tasks."), level: 4 },
		{ value: 'high', label: localize('clawdius.effort.high', "High"), detail: localize('clawdius.effort.high.detail', "More reasoning for harder problems."), level: 6 },
		{ value: 'xhigh', label: localize('clawdius.effort.xhigh', "Extra high"), detail: localize('clawdius.effort.xhigh.detail', "Maximum standard reasoning (model-gated)."), level: 8 },
		{ value: 'max', label: localize('clawdius.effort.max', "Max"), detail: localize('clawdius.effort.max.detail', "The highest reasoning the model supports (model-gated)."), level: 9 },
	];
}

function ultracodeLabel(): string {
	return localize('clawdius.effort.ultracode', "Ultracode");
}

function ultracodeDetail(): string {
	return localize('clawdius.effort.ultracode.detail', "Extra high effort plus standing dynamic-workflow orchestration (xhigh + workflows).");
}

/** Coerce a raw effortLevel setting value to a known level, or undefined (unset = Auto). */
export function parseEffortLevel(value: string | undefined): EffortLevel | undefined {
	return (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') ? value : undefined;
}

/** The resolved presentation of the effort pill. Pure + testable. */
export interface IEffortDisplay {
	readonly selection: EffortSelection | 'auto';
	readonly label: string;
	/** The block-char meter string (10 cells). */
	readonly meter: string;
	readonly ariaLabel: string;
	readonly tooltip: string;
	/** 'ultra' = filled purple pill; 'none' = plain. */
	readonly tone: 'ultra' | 'none';
	/** Which (if any) animation the meter glyphs run. */
	readonly animate: MeterAnimation;
	/** 0..10 filled cells. */
	readonly level: number;
}

/** Tooltip footnote (localized) on the scope of the effort default; passed as a placeholder into the tooltips. */
function appliesNote(): string {
	return localize('clawdius.effort.appliesNote', "Applies to new chat panes (or after reloading the chat); an in-pane + chat in an already-open panel may keep the previous effort until reload.");
}

/** Resolve what the pill shows for the persisted effortLevel + ultracode flag. Ultracode wins over the level. */
export function effortDisplay(effortLevel: string | undefined, ultracode: boolean): IEffortDisplay {
	if (ultracode) {
		const label = ultracodeLabel();
		return {
			selection: 'ultracode',
			label,
			meter: blockBar(1, METER_CELLS),
			ariaLabel: localize('clawdius.effort.aria', "Claude default effort: {0}", label),
			tooltip: localize('clawdius.effort.tooltip.ultra', "**Ultracode** effort for new Claude conversations: Extra high plus standing dynamic-workflow orchestration.\n\nClick to change. {0}", appliesNote()),
			tone: 'ultra',
			animate: 'ultra',
			level: METER_CELLS,
		};
	}
	const info = effortLevels().find(i => i.value === parseEffortLevel(effortLevel));
	if (!info) {
		const label = localize('clawdius.effort.auto', "Auto");
		return {
			selection: 'auto',
			label,
			meter: blockBar(0, METER_CELLS),
			ariaLabel: localize('clawdius.effort.aria', "Claude default effort: {0}", label),
			tooltip: localize('clawdius.effort.tooltip.auto', "Effort is unset - Claude picks per task.\n\nClick to set a default effort for new conversations."),
			tone: 'none',
			animate: 'none',
			level: 0,
		};
	}
	return {
		selection: info.value,
		label: info.label,
		meter: blockBar(info.level / METER_CELLS, METER_CELLS),
		ariaLabel: localize('clawdius.effort.aria', "Claude default effort: {0}", info.label),
		tooltip: localize('clawdius.effort.tooltip', "**{0}** effort for new Claude conversations.\n\n{1}\n\nClick to change. {2}", info.label, info.detail, appliesNote()),
		tone: 'none',
		animate: info.value === 'max' ? 'rainbow' : 'none',
		level: info.level,
	};
}

export interface IEffortPick extends IQuickPickItem {
	readonly selection: EffortSelection;
}

/** The quick-pick items: the five levels plus Ultracode. The current selection is marked. */
export function effortPicks(current: EffortSelection | 'auto'): IEffortPick[] {
	const picks: IEffortPick[] = effortLevels().map(i => ({
		label: i.label,
		detail: i.detail,
		description: i.value === current ? localize('clawdius.effort.current', "Current") : undefined,
		selection: i.value,
	}));
	picks.push({
		label: ultracodeLabel(),
		detail: ultracodeDetail(),
		description: current === 'ultracode' ? localize('clawdius.effort.current', "Current") : undefined,
		selection: 'ultracode',
	});
	return picks;
}

/** A single settings.json edit (path + value; value undefined deletes the key). */
export interface IEffortWrite {
	readonly path: ReadonlyArray<string>;
	readonly value: string | boolean | undefined;
}

/**
 * The ~/.claude/settings.json edits for a selection. A normal level writes effortLevel and CLEARS ultracode
 * (mirrors the plugin's setEffortLevel). Ultracode writes effortLevel:'xhigh' + ultracode:true (mirrors
 * enableUltracode). We never write ultracode:false - clearing means deleting the key.
 */
export function effortWrites(selection: EffortSelection): IEffortWrite[] {
	if (selection === 'ultracode') {
		return [{ path: [EFFORT_LEVEL_KEY], value: 'xhigh' }, { path: [ULTRACODE_KEY], value: true }];
	}
	return [{ path: [EFFORT_LEVEL_KEY], value: selection }, { path: [ULTRACODE_KEY], value: undefined }];
}

interface IEffortSettings {
	readonly effortLevel?: string;
	readonly ultracode?: boolean;
}

/**
 * A classified read of ~/.claude/settings.json: `ok` carries the parsed effort settings plus `needsSeed` (the
 * file is missing or empty and must be created as `{}` before a JSON edit); `invalid` means the file exists but
 * is not parseable JSON - we must NOT write it (IJSONEditingService would reject it, and clobbering a
 * hand-edited file is unacceptable).
 */
export type SettingsReadState =
	| { readonly kind: 'ok'; readonly settings: IEffortSettings; readonly needsSeed: boolean }
	| { readonly kind: 'invalid' };

/** Pure: classify raw settings.json content. `undefined` = the file does not exist (treated as a seed case). */
export function parseSettingsState(raw: string | undefined): SettingsReadState {
	if (raw === undefined || raw.trim() === '') {
		return { kind: 'ok', settings: {}, needsSeed: true };
	}
	try {
		const obj = JSON.parse(raw);
		return {
			kind: 'ok',
			settings: {
				effortLevel: typeof obj?.effortLevel === 'string' ? obj.effortLevel : undefined,
				ultracode: obj?.ultracode === true,
			},
			needsSeed: false,
		};
	} catch {
		return { kind: 'invalid' };
	}
}

/** Read + classify settings.json. A read failure (missing/unreadable) is treated as a seed case. */
async function readSettingsState(fileService: IFileService, settingsUri: URI): Promise<SettingsReadState> {
	let raw: string | undefined;
	try {
		raw = (await fileService.readFile(settingsUri)).value.toString();
	} catch {
		raw = undefined;
	}
	return parseSettingsState(raw);
}

/** Best-effort settings for the status pill (missing/invalid -> empty; the pill only reads, never writes). */
async function readEffortSettings(fileService: IFileService, settingsUri: URI): Promise<IEffortSettings> {
	const state = await readSettingsState(fileService, settingsUri);
	return state.kind === 'ok' ? state.settings : {};
}

function currentSelection(settings: IEffortSettings): EffortSelection | 'auto' {
	if (settings.ultracode) {
		return 'ultracode';
	}
	return parseEffortLevel(settings.effortLevel) ?? 'auto';
}

/** The action SetEffortLevelAction.run() should take, plus whether to seed the file and the settings.json edits. */
export interface IEffortEditPlan {
	readonly action: 'invalid' | 'noop' | 'write';
	/** True when the (re-read) settings file is missing/empty and must be seeded as `{}` before the JSON edit. */
	readonly seed: boolean;
	readonly writes: readonly IEffortWrite[];
}

/**
 * Decide what SetEffortLevelAction.run() should do, mirroring its exact branch order:
 *  1. initial read invalid               -> 'invalid' (never write a file that is not parseable JSON)
 *  2. nothing chosen / chose the current -> 'noop'
 *  3. re-read invalid (changed mid-pick) -> 'invalid'
 *  4. otherwise                          -> 'write' (seed when the re-read needs it)
 * `writeState` is the re-read classification, supplied only when a real change was chosen (undefined for a noop,
 * so it is never consulted in that case). Pure + testable; run() keeps the notify / dialog / IO and acts on this.
 */
export function planEffortEdit(
	initialState: SettingsReadState,
	chosen: { readonly selection: EffortSelection } | undefined,
	current: EffortSelection | 'auto',
	writeState: SettingsReadState | undefined,
): IEffortEditPlan {
	if (initialState.kind === 'invalid') {
		return { action: 'invalid', seed: false, writes: [] };
	}
	if (!chosen || chosen.selection === current) {
		return { action: 'noop', seed: false, writes: [] };
	}
	if (!writeState || writeState.kind === 'invalid') {
		return { action: 'invalid', seed: false, writes: [] };
	}
	return { action: 'write', seed: writeState.needsSeed, writes: effortWrites(chosen.selection) };
}

/**
 * Opens a quick pick to set the default effort for new Claude conversations and writes it to
 * ~/.claude/settings.json (creating the file if absent).
 */
export class SetEffortLevelAction extends Action2 {

	static readonly ID = SET_EFFORT_COMMAND_ID;

	constructor() {
		super({
			id: SET_EFFORT_COMMAND_ID,
			title: localize2('clawdius.setEffortLevel', "Set Default Effort Level"),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// Resolve all services synchronously before the first await (the accessor is only valid until then).
		const quickInputService = accessor.get(IQuickInputService);
		const pathService = accessor.get(IPathService);
		const fileService = accessor.get(IFileService);
		const jsonEditing = accessor.get(IJSONEditingService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		const settingsUri = URI.joinPath(await pathService.userHome(), '.claude', 'settings.json');
		const notifyInvalid = () => notificationService.error(localize('clawdius.effort.invalidSettings', "Can't update the default effort: {0} is not valid JSON. Fix the file and try again.", settingsUri.fsPath));

		const state = await readSettingsState(fileService, settingsUri);
		// A malformed settings.json reads as empty but IJSONEditingService refuses to edit it. Don't offer to
		// change a file we cannot safely write, and never clobber a hand-edited file - tell the user to fix it.
		// (This mirrors planEffortEdit's initial-invalid branch, but must short-circuit BEFORE the pick so we never
		// prompt to change a file we cannot write.)
		if (state.kind === 'invalid') {
			notifyInvalid();
			return;
		}
		const current = currentSelection(state.settings);

		const basePicks = effortPicks(current);
		const activeItem = basePicks.find(p => p.selection === current);
		// A trailing separator pins a note at the BOTTOM of the list (no native "footer message" exists).
		const picks: QuickPickInput<IEffortPick>[] = [
			...basePicks,
			{ type: 'separator', label: localize('clawdius.effort.reloadNote', "Changing the default effort reloads the open Claude chat to apply it.") },
		];
		const chosen = await quickInputService.pick(picks, {
			title: localize('clawdius.effort.reloadTitle', "Changing the default effort reloads the open Claude chat"),
			placeHolder: localize('clawdius.effort.placeholder', "Select the default effort for new Claude conversations"),
			matchOnDetail: true,
			activeItem,
		});
		// Re-classify right before writing: the file may have appeared or changed during the pick. Only re-read
		// when a real change was chosen - an unchanged pick is a no-op and must not trigger extra IO or a restart.
		const writeState = (chosen && chosen.selection !== current) ? await readSettingsState(fileService, settingsUri) : undefined;
		const plan = planEffortEdit(state, chosen, current, writeState);
		switch (plan.action) {
			case 'invalid':
				// The file changed mid-pick to something not parseable - never feed a malformed file to the editor.
				notifyInvalid();
				return;
			case 'noop':
				return;
			case 'write':
				if (plan.seed) {
					await fileService.writeFile(settingsUri, VSBuffer.fromString('{}\n'));
				}
				await jsonEditing.write(settingsUri, plan.writes.map(w => ({ path: [...w.path], value: w.value })), true);
				// Restart the extension host so the Claude plugin re-activates and its CLI re-reads
				// ~/.claude/settings.json fresh - the only reliable way to apply the new effort to open chats. A
				// plain webview reload is page-only and reads the plugin's STALE cached config (it lands one
				// selection behind), so it cannot be used here. Note: this restarts ALL extensions, not just Claude.
				await commandService.executeCommand('workbench.action.restartExtensionHost');
				return;
		}
	}
}

/** Renders the default effort level as a native status-bar meter pill, synced to ~/.claude/settings.json. */
export class ClawdiusEffortStatusEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusEffortStatusEntry';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly watch = this._register(new DisposableStore());
	private settingsUri: URI | undefined;
	private settings: IEffortSettings = {};

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();

		// Only in Clawdius mode (defaultChatAgent has no entitlementUrl); elsewhere this surface is meaningless.
		if (product.defaultChatAgent?.entitlementUrl) {
			return;
		}
		void this.init();
	}

	private async init(): Promise<void> {
		this.settingsUri = URI.joinPath(await this.pathService.userHome(), '.claude', 'settings.json');
		// Reflect external edits and the plugin's own effort write-backs.
		this.watch.add(this.fileService.watch(this.settingsUri));
		this.watch.add(this.fileService.onDidFilesChange(e => {
			if (this.settingsUri && e.contains(this.settingsUri)) {
				void this.refresh();
			}
		}));
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		if (!this.settingsUri) {
			return;
		}
		this.settings = await readEffortSettings(this.fileService, this.settingsUri);
		this.update();
	}

	private update(): void {
		const display = effortDisplay(this.settings.effortLevel, this.settings.ultracode === true);
		const props = this.getProps(display);
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			// Absolute priority (not a relative anchor): relative-to-relative anchoring lands in the status bar's
			// "append to end" bucket and oscillates. A fixed number keeps it put. Effort sits just left of the
			// permission pill (100.06) which sits just left of the usage meter.
			this.entry.value = this.statusbarService.addEntry(props, 'clawdius.effort', StatusbarAlignment.RIGHT, 100.07);
		}
	}

	private getProps(display: IEffortDisplay): IStatusbarEntry {
		// Native text rendering: stable layout + native click/hover/focus. The meter glyphs are wrapped in a NUL
		// sentinel so the label renderer emits per-cell spans the CSS animates. Ultracode keeps its purple pill.
		return {
			name: localize('clawdius.effort.name', "Claude Effort Level"),
			text: `$(dashboard) ${meterMarkup(display)} ${display.label}`,
			ariaLabel: display.ariaLabel,
			tooltip: new MarkdownString(display.tooltip),
			command: SET_EFFORT_COMMAND_ID,
			backgroundColor: display.tone === 'ultra' ? themeColorFromId(EFFORT_ULTRACODE_BACKGROUND) : undefined,
			color: display.tone === 'ultra' ? themeColorFromId(EFFORT_ULTRACODE_FOREGROUND) : undefined,
		};
	}
}
// CLAWDIUS-END
