/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN model-selection status-bar indicator
// A bottom-right status-bar pill (just LEFT of the effort pill) showing the DEFAULT Claude model for new
// conversations, with a click-through picker. It sits at priority 100.075, between the effort pill (100.07)
// and the transient missing-plugin warning (100.08). No colour coding - just the model name.
//
// DYNAMIC, EGRESS-FREE model list. Models change often and a user may be proxying non-standard models
// (Bedrock, Vertex, a local LLM). We NEVER hit a /models network endpoint (that is the one egress the
// platform makes, for usage, and is the anti-pattern here). Instead the list is the UNION of local sources:
//   1. The live agent-host catalog published to the renderer via ILanguageModelsService (the built-in
//      Claude vendor 'clawdius') - the same source the chat picker reads, so the pill tracks whatever
//      the agent host advertises rather than a second hard-coded list.
//   2. The user's configured default `model` in ~/.claude/settings.json (may be a full id like
//      `claude-opus-4.7`, or a proxied/Bedrock/local id the catalog does not contain).
//   3. `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` from the `clawdius.cli.environmentVariables` setting
//      and from the `env` map inside ~/.claude/settings.json - where proxied model ids live.
// If the catalog has not resolved yet, a small authored known-families table (opus/sonnet/haiku) is the
// fallback base. Blurbs are authored for the KNOWN Anthropic families ONLY; any unrecognised id (a Bedrock
// ARN, a Vertex id, a local model name, `default`, `opusplan`, an unknown `claude-*`) renders NAME/ID ONLY -
// we never fabricate a description for a model we do not recognise.
//
// Source of truth for the SELECTION: ~/.claude/settings.json top-level `model` key (the CLI's own config),
// round-tripped exactly like the effort pill round-trips `effortLevel`. Honesty: this sets the default model
// for NEW conversations; it does not switch a chat already in progress (the official plugin owns the live
// chat and exposes no host->webview model switch), so after a write we restart the ext host to re-seed.

import { Disposable, DisposableStore, MutableDisposable, markAsSingleton } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import product from '../../../../platform/product/common/product.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CLAWDIUS_STATUS_BAR_ENABLED_SETTING, isClawdiusStatusBarEnabled } from '../common/clawdiusStatusBar.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';

/** ~/.claude/settings.json top-level key that the CLI reads for the default model. */
export const MODEL_KEY = 'model';
/** VS Code setting holding the Claude subprocess env overlay (where a proxied ANTHROPIC_MODEL may live). */
export const CLI_ENV_VARS_KEY = 'clawdius.cli.environmentVariables';
export const CLI_PROVIDER_PRESET_KEY = 'clawdius.cli.providerPreset';
export const SET_MODEL_COMMAND_ID = 'clawdius.setModel';

/** Sentinel selection meaning "no explicit default - let Claude Code decide" (the `model` key is absent). */
export const DEFAULT_MODEL = '';

/**
 * Fired by {@link SetModelAction} right after it writes the default model to ~/.claude/settings.json, so the
 * status pill refreshes immediately. The pill cannot rely on the settings-file watch (a home-directory file the
 * renderer's watcher misses) nor on the ext-host-restart catalog event (does not reliably re-fire here), so the
 * action that changes the value notifies the display directly - both live in this module.
 */
const _onDidWriteModelDefault = markAsSingleton(new Emitter<void>());
/** Subscribe to learn the default model was just written to settings.json (module-local: only the pill listens). */
const onDidWriteModelDefault: Event<void> = _onDidWriteModelDefault.event;
/** Called by SetModelAction after a successful write to nudge the pill to re-read settings.json now. */
export function signalModelDefaultWritten(): void { _onDidWriteModelDefault.fire(); }

/** U+2026 HORIZONTAL ELLIPSIS, referenced by code point to keep this source ASCII-only. */
const ELLIPSIS = String.fromCharCode(0x2026);

/**
 * The vendor id the agent-host chat contribution registers the LIVE Claude model catalog under -
 * `agent-host-${provider}` for provider 'claude' (agentHostChatContribution: `const vendor = sessionType`).
 * This provider receives the SDK-discovered catalog (real display names, versions, the 1M-context variants,
 * Fable). The default `clawdius` vendor carries only a stale static fallback list, so we deliberately read
 * the agent-host vendor to mirror exactly what the plugin's chat picker shows.
 */
const CLAWDIUS_MODEL_VENDOR = 'agent-host-claude';

/**
 * Strip only genuine C0 control characters (e.g. a stray ESC byte) from a model id, then trim. Done with a
 * loop rather than a regex literal to avoid a control-character regex (no-control-regex).
 *
 * IMPORTANT: a trailing "[1m]" is NOT junk - it is a REAL model-id suffix for the 1-million-context variant
 * (the CLI's own catalog lists `opus[1m]` -> "Opus (1M context)", `sonnet[1m]` -> "Sonnet (1M context)"). So
 * we must NOT strip "[<digits>m]"; doing so would corrupt a legitimately-selected 1M model into the wrong
 * (or a non-existent) id. Only unprintable control bytes are removed.
 */
export function sanitizeModelId(raw: string): string {
	let s = '';
	for (const ch of raw) {
		if (ch.charCodeAt(0) >= 0x20) {
			s += ch;
		}
	}
	return s.trim();
}

/** Coerce an arbitrary settings value to a cleaned model id, or undefined when absent/blank/junk-only. */
export function cleanModelId(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const cleaned = sanitizeModelId(value);
	return cleaned === '' ? undefined : cleaned;
}

/** A model row offered in the pill/picker. `detail` is a blurb (known families only); undefined otherwise. */
export interface IModelInfo {
	/** The value written to `model` and passed as `claude --model` (an alias like `opus`, a full id, or a proxied id). */
	readonly id: string;
	/** Display name (catalog name for known families; the raw id for unknown/proxied models). */
	readonly label: string;
	/** One-line capability blurb - ONLY for recognised Anthropic families; undefined for everything else. */
	readonly detail: string | undefined;
	/** Context window in tokens when known (from the catalog), else undefined. */
	readonly maxContextWindow: number | undefined;
	/** True for the "Default" row (clears the `model` key). */
	readonly isDefault?: boolean;
}

/** Authored blurbs for the KNOWN Anthropic families. Keyed by normalized family. Clawdius-authored copy. */
function familyBlurb(family: KnownFamily): string {
	switch (family) {
		case 'opus': return localize('clawdius.model.opus.detail', "Most capable. Best for hard reasoning, architecture, and complex agentic work.");
		case 'sonnet': return localize('clawdius.model.sonnet.detail', "Balanced capability and speed for everyday coding.");
		case 'haiku': return localize('clawdius.model.haiku.detail', "Fastest and most economical. Best for simple, high-volume tasks.");
	}
}

/** Authored display names for the known families, used only when the catalog is unavailable (fallback base). */
function familyLabel(family: KnownFamily): string {
	switch (family) {
		case 'opus': return localize('clawdius.model.opus', "Claude Opus");
		case 'sonnet': return localize('clawdius.model.sonnet', "Claude Sonnet");
		case 'haiku': return localize('clawdius.model.haiku', "Claude Haiku");
	}
}

export type KnownFamily = 'opus' | 'sonnet' | 'haiku';
const KNOWN_FAMILIES: readonly KnownFamily[] = ['opus', 'sonnet', 'haiku'];

/**
 * Map a raw model id to a known Anthropic family, or undefined. Matches the family alias exactly or as a
 * substring of a fuller id (`claude-opus-4.7` -> opus). Case-insensitive. Deliberately conservative: a
 * proxied id that merely mentions a family word (e.g. a Bedrock ARN) still resolves to that family ONLY if
 * the word appears, which is the intended, honest behaviour for blurb selection; anything with no family
 * word is "unknown" and gets no blurb.
 */
export function normalizeFamily(id: string | undefined): KnownFamily | undefined {
	if (!id) {
		return undefined;
	}
	const s = id.toLowerCase();
	return KNOWN_FAMILIES.find(f => s === f || s.includes(f));
}

/** A model as read from the live SDK catalog: id (value), display name, description, and context window. */
export interface ICatalogModel {
	readonly id: string;
	readonly name: string;
	readonly maxContextWindow: number | undefined;
	/** The SDK's own capability description (e.g. "Opus 4.8 with 1M context - Best for ..."), when present. */
	readonly description: string | undefined;
}

/** Authored blurb fallback for a known family id - used ONLY when the live catalog gave no description. */
function blurbFor(id: string): string | undefined {
	const fam = normalizeFamily(id);
	return fam ? familyBlurb(fam) : undefined;
}

/**
 * Build the model list. Pure + testable.
 *  - `catalog`     : the LIVE SDK catalog (real display names, descriptions, 1M variants, Fable), or [] if the
 *                    agent host has not resolved it yet.
 *  - `configured`  : the settings.json `model` value ('' if unset).
 *  - `extraEnvIds` : proxied ids from env (ANTHROPIC_MODEL etc.); may be empty.
 *
 * When the live catalog is present we render EXACTLY what it reported, in its own order, with its own
 * descriptions - so the pill mirrors the plugin's chat picker (which reads the same SDK catalog). The catalog
 * already includes a "Default (recommended)" entry, so no synthetic Default row is added. Only when the
 * catalog is empty (agent host still starting) do we fall back to the authored family names + a synthetic
 * Default. Any configured/env id the catalog did not list is appended name-only (a live blurb if it is a
 * recognised family, else none - we never invent a description for an unknown/proxied id).
 */
export function buildModelList(catalog: readonly ICatalogModel[], configured: string, extraEnvIds: readonly string[]): IModelInfo[] {
	const out: IModelInfo[] = [];
	const seen = new Set<string>();

	if (catalog.length) {
		for (const m of catalog) {
			if (seen.has(m.id)) {
				continue;
			}
			seen.add(m.id);
			out.push({ id: m.id, label: m.name, detail: m.description ?? blurbFor(m.id), maxContextWindow: m.maxContextWindow });
		}
	} else {
		out.push({ id: DEFAULT_MODEL, label: localize('clawdius.model.default', "Default"), detail: localize('clawdius.model.default.detail', "Let Claude Code pick the model (no explicit default set)."), maxContextWindow: undefined, isDefault: true });
		seen.add(DEFAULT_MODEL);
		for (const f of KNOWN_FAMILIES) {
			seen.add(f);
			out.push({ id: f, label: familyLabel(f), detail: familyBlurb(f), maxContextWindow: undefined });
		}
	}

	for (const id of [configured, ...extraEnvIds]) {
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		out.push({ id, label: id, detail: blurbFor(id), maxContextWindow: undefined });
	}
	return out;
}

/**
 * Resolve the effective current selection for marking. An unset `model` key ('') means the CLI uses its
 * recommended default, so mark the catalog's "default" row (which the plugin labels "Default (recommended)")
 * when present. Otherwise the raw configured id is the selection.
 */
export function resolveCurrent(current: string, models: readonly IModelInfo[]): string {
	if (current) {
		return current;
	}
	return models.some(m => m.id === 'default') ? 'default' : current;
}

/** A short, status-bar-safe label for an id (proxied ARNs/paths can be very long). Full id stays in the tooltip. */
export function shortModelLabel(info: IModelInfo): string {
	if (info.isDefault) {
		return localize('clawdius.model.defaultShort', "Default");
	}
	// A clean, short id (a family alias like `opus`, or a version like `claude-opus-4.7`) has no path/ARN
	// separator and fits the status bar: show the catalog name minus a leading "Claude ". A long or
	// path/ARN-shaped id (a Bedrock ARN, a Vertex `projects/.../models/x` id) - even one that mentions a
	// family word - is compacted to its last path segment and capped; the full id stays in the tooltip and
	// the picker description. (We key on shape, not on family match, so a long ARN containing "sonnet" is
	// still truncated rather than shown whole.)
	const looksProxiedPath = info.id.includes('/') || info.id.length > 24;
	if (!looksProxiedPath) {
		return info.label.replace(/^Claude\s+/i, '');
	}
	const tail = info.id.split('/').filter(Boolean).pop() ?? info.id;
	return tail.length > 22 ? `${tail.slice(0, 21)}${ELLIPSIS}` : tail;
}

/** The provider preset annotation for the tooltip. `oauth` (the default) is treated as "no annotation". */
function providerNote(preset: string | undefined): string | undefined {
	switch (preset) {
		case 'bedrock': return localize('clawdius.model.provider.bedrock', "Provider: Amazon Bedrock - model ids are provider-specific.");
		case 'vertex': return localize('clawdius.model.provider.vertex', "Provider: Google Vertex AI - model ids are provider-specific.");
		case 'foundry': return localize('clawdius.model.provider.foundry', "Provider: Azure AI Foundry - model ids are provider-specific.");
		case 'custom': return localize('clawdius.model.provider.custom', "Provider: custom endpoint - model ids are provider-specific.");
		default: return undefined;
	}
}

/** The resolved presentation of the model pill. Pure + testable. No colour/tone (per spec: name only). */
export interface IModelDisplay {
	readonly current: string;
	readonly text: string;
	readonly ariaLabel: string;
	readonly tooltip: string;
}

/** Tooltip footnote on the scope of the model default. */
function appliesNote(): string {
	return localize('clawdius.model.appliesNote', "This sets the default model for new conversations; it does not change a chat already in progress (it reloads open Claude chats to apply).");
}

/** Resolve what the pill shows for the persisted `model` value, given the current known list + provider note. */
export function modelDisplay(current: string, models: readonly IModelInfo[], providerPreset: string | undefined): IModelDisplay {
	const eff = resolveCurrent(current, models);
	const info = models.find(m => m.id === eff) ?? models[0];
	const shortLabel = info ? shortModelLabel(info) : localize('clawdius.model.defaultShort', "Default");
	const fullName = info ? info.label : localize('clawdius.model.defaultName', "Default");
	const provider = providerNote(providerPreset);
	const ctx = info?.maxContextWindow ? localize('clawdius.model.ctx', "Context window: {0} tokens.", info.maxContextWindow.toLocaleString()) : undefined;
	const parts = [
		localize('clawdius.model.tooltip.head', "**Default model** for new Claude conversations: **{0}**", fullName),
		info?.detail,
		ctx,
		provider,
		appliesNote(),
		localize('clawdius.model.tooltip.click', "Click to change."),
	].filter((p): p is string => !!p);
	return {
		current: eff,
		text: `$(sparkle) ${shortLabel}`,
		ariaLabel: localize('clawdius.model.aria', "Claude default model: {0}", fullName),
		tooltip: parts.join('\n\n'),
	};
}

export interface IModelPick extends IQuickPickItem {
	readonly id: string;
}

/** The quick-pick items. The current selection is marked. `description` carries the id for non-default rows. */
export function modelPicks(models: readonly IModelInfo[], current: string): IModelPick[] {
	const eff = resolveCurrent(current, models);
	return models.map(m => ({
		label: m.isDefault ? m.label : shortModelLabel(m),
		detail: m.detail,
		// description carries the raw id (load-bearing for proxied models) + "Current" marker when selected.
		description: m.id === eff
			? (m.isDefault ? localize('clawdius.model.current', "Current") : localize('clawdius.model.currentId', "{0} - Current", m.id))
			: (m.isDefault ? undefined : m.id),
		id: m.id,
	}));
}

/** A single settings.json edit (path + value; value undefined deletes the key). */
export interface IModelWrite {
	readonly path: ReadonlyArray<string>;
	readonly value: string | undefined;
}

/** The ~/.claude/settings.json edits for a selection. The Default row CLEARS the key (delete = let CLI decide). */
export function modelWrites(id: string): IModelWrite[] {
	return [{ path: [MODEL_KEY], value: id === DEFAULT_MODEL ? undefined : id }];
}

interface IModelSettings {
	/** The top-level `model` string, or undefined when unset. */
	readonly model?: string;
	/** A proxied model id declared inside the settings.json `env` map (env.ANTHROPIC_MODEL / small-fast). */
	readonly envModelIds: readonly string[];
}

/**
 * A classified read of ~/.claude/settings.json: `ok` carries the parsed model settings plus `needsSeed` (the
 * file is missing/empty and must be created as `{}` before a JSON edit); `invalid` means the file exists but
 * is not parseable JSON - we must NOT write it.
 */
export type SettingsReadState =
	| { readonly kind: 'ok'; readonly settings: IModelSettings; readonly needsSeed: boolean }
	| { readonly kind: 'invalid' };

/** Pull ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL string values out of an arbitrary env-like record. */
export function envModelIdsFrom(env: unknown): string[] {
	if (!env || typeof env !== 'object') {
		return [];
	}
	const rec = env as Record<string, unknown>;
	const out: string[] = [];
	for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
		const cleaned = cleanModelId(rec[key]);
		if (cleaned) {
			out.push(cleaned);
		}
	}
	return out;
}

/** Pure: classify raw settings.json content. `undefined` = the file does not exist (a seed case). */
export function parseSettingsState(raw: string | undefined): SettingsReadState {
	if (raw === undefined || raw.trim() === '') {
		return { kind: 'ok', settings: { envModelIds: [] }, needsSeed: true };
	}
	try {
		const obj = JSON.parse(raw);
		return {
			kind: 'ok',
			settings: {
				model: cleanModelId(obj?.model),
				envModelIds: envModelIdsFrom(obj?.env),
			},
			needsSeed: false,
		};
	} catch {
		return { kind: 'invalid' };
	}
}

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
async function readModelSettings(fileService: IFileService, settingsUri: URI): Promise<IModelSettings> {
	const state = await readSettingsState(fileService, settingsUri);
	return state.kind === 'ok' ? state.settings : { envModelIds: [] };
}

/** The action SetModelAction.run() should take, plus whether to seed the file and the settings.json edits. */
export interface IModelEditPlan {
	readonly action: 'invalid' | 'noop' | 'write';
	readonly seed: boolean;
	readonly writes: readonly IModelWrite[];
}

/**
 * Decide what SetModelAction.run() should do, mirroring the effort action's exact branch order:
 *  1. initial read invalid               -> 'invalid'
 *  2. nothing chosen / chose the current -> 'noop'
 *  3. re-read invalid (changed mid-pick) -> 'invalid'
 *  4. otherwise                          -> 'write' (seed when the re-read needs it)
 */
export function planModelEdit(
	initialState: SettingsReadState,
	chosen: { readonly id: string } | undefined,
	current: string,
	writeState: SettingsReadState | undefined,
): IModelEditPlan {
	if (initialState.kind === 'invalid') {
		return { action: 'invalid', seed: false, writes: [] };
	}
	if (!chosen || chosen.id === current) {
		return { action: 'noop', seed: false, writes: [] };
	}
	if (!writeState || writeState.kind === 'invalid') {
		return { action: 'invalid', seed: false, writes: [] };
	}
	return { action: 'write', seed: writeState.needsSeed, writes: modelWrites(chosen.id) };
}

/** Read the LIVE agent-host model catalog (vendor {@link CLAWDIUS_MODEL_VENDOR}) from the renderer LM service.
 * Carries the SDK display name, description (metadata.detail), and context window. De-duped by id. */
export function readClawdiusCatalog(languageModelsService: ILanguageModelsService): ICatalogModel[] {
	const out: ICatalogModel[] = [];
	const seen = new Set<string>();
	for (const identifier of languageModelsService.getLanguageModelIds()) {
		const md = languageModelsService.lookupLanguageModel(identifier);
		const id = md ? sanitizeModelId(md.id || '') : '';
		if (!md || md.vendor !== CLAWDIUS_MODEL_VENDOR || !id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		out.push({
			id,
			name: md.name || id,
			maxContextWindow: md.maxInputTokens || undefined,
			description: typeof md.detail === 'string' && md.detail.trim() !== '' ? md.detail : undefined,
		});
	}
	return out;
}

/** Proxied model ids declared via the `clawdius.cli.environmentVariables` setting (ANTHROPIC_MODEL etc.). */
function configEnvModelIds(configurationService: IConfigurationService): string[] {
	return envModelIdsFrom(configurationService.getValue(CLI_ENV_VARS_KEY));
}

/**
 * Opens a quick pick to set the default model for new Claude conversations and writes it to
 * ~/.claude/settings.json (creating the file if absent).
 */
export class SetModelAction extends Action2 {

	static readonly ID = SET_MODEL_COMMAND_ID;

	constructor() {
		super({
			id: SET_MODEL_COMMAND_ID,
			title: localize2('clawdius.setModel', "Set Default Model"),
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
		const extensionService = accessor.get(IExtensionService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const languageModelsService = accessor.get(ILanguageModelsService);
		const configurationService = accessor.get(IConfigurationService);

		const settingsUri = URI.joinPath(await pathService.userHome(), '.claude', 'settings.json');
		const notifyInvalid = () => notificationService.error(localize('clawdius.model.invalidSettings', "Can't update the default model: {0} is not valid JSON. Fix the file and try again.", settingsUri.fsPath));

		const state = await readSettingsState(fileService, settingsUri);
		// A malformed settings.json reads as empty but IJSONEditingService refuses to edit it: don't offer to
		// change a file we cannot safely write, and never clobber a hand-edited file.
		if (state.kind === 'invalid') {
			notifyInvalid();
			return;
		}
		const current = state.settings.model ?? DEFAULT_MODEL;
		const catalog = readClawdiusCatalog(languageModelsService);
		const extraEnvIds = [...configEnvModelIds(configurationService), ...state.settings.envModelIds];
		const models = buildModelList(catalog, current, extraEnvIds);
		// An unset `model` resolves to the catalog's "default" row; highlight + no-op against that effective id.
		const eff = resolveCurrent(current, models);

		const basePicks = modelPicks(models, current);
		const activeItem = basePicks.find(p => p.id === eff);
		const picks: QuickPickInput<IModelPick>[] = [
			...basePicks,
			{ type: 'separator', label: localize('clawdius.model.reloadNote', "Changing the default model reloads the open Claude chat to apply it.") },
		];
		const chosen = await quickInputService.pick(picks, {
			title: localize('clawdius.model.reloadTitle', "Changing the default model reloads the open Claude chat"),
			placeHolder: localize('clawdius.model.placeholder', "Select the default model for new Claude conversations"),
			matchOnDetail: true,
			matchOnDescription: true,
			activeItem,
		});
		// Re-classify right before writing: the file may have appeared or changed during the pick.
		const writeState = (chosen && chosen.id !== eff) ? await readSettingsState(fileService, settingsUri) : undefined;
		const plan = planModelEdit(state, chosen, eff, writeState);
		switch (plan.action) {
			case 'invalid':
				notifyInvalid();
				return;
			case 'noop':
				return;
			case 'write':
				if (plan.seed) {
					await fileService.writeFile(settingsUri, VSBuffer.fromString('{}\n'));
				}
				await jsonEditing.write(settingsUri, plan.writes.map(w => ({ path: [...w.path], value: w.value })), true);
				// Notify the pill to re-read settings.json immediately (the home-dir file-watch and the catalog event
				// are both unreliable triggers for this write, so the action signals the display directly).
				signalModelDefaultWritten();
				// Re-activate the Claude plugin so its CLI re-reads ~/.claude/settings.json fresh (a plain webview
				// reload reads the plugin's STALE cached config). On a LOCAL window restart the local ext host; on a
				// REMOTE window restart ONLY the remote host (a full restart would drop the remote connection).
				if (environmentService.remoteAuthority) {
					await extensionService.restartRemoteExtensionHosts();
				} else {
					await commandService.executeCommand('workbench.action.restartExtensionHost');
				}
				return;
		}
	}
}

/** Renders the default Claude model as a native status-bar pill, synced to ~/.claude/settings.json. */
export class ClawdiusModelStatusEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusModelStatusEntry';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly watch = this._register(new DisposableStore());
	private settingsUri: URI | undefined;
	private settings: IModelSettings = { envModelIds: [] };

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
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
		// Reflect external edits and the plugin's own model write-backs.
		this.watch.add(this.fileService.watch(this.settingsUri));
		this.watch.add(this.fileService.onDidFilesChange(e => {
			if (this.settingsUri && e.contains(this.settingsUri)) {
				void this.refresh();
			}
		}));
		// Track the live catalog: models resolve/change asynchronously after the agent host connects. Setting a
		// model restarts the ext host, which re-fires this event - so we RE-READ settings.json here (refresh, not
		// update) to reflect the just-written selection even when the home-dir settings.json watch above misses it.
		this.watch.add(this.languageModelsService.onDidChangeLanguageModels(() => void this.refresh()));
		// Track proxied-model config edits (clawdius.cli.environmentVariables / providerPreset). Re-read settings
		// too, so an env/provider change reflects the current on-disk model without relying on the file watch.
		this.watch.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CLI_ENV_VARS_KEY) || e.affectsConfiguration(CLI_PROVIDER_PRESET_KEY) || e.affectsConfiguration(CLAWDIUS_STATUS_BAR_ENABLED_SETTING)) {
				void this.refresh();
			}
		}));
		// The pick action writes settings.json then restarts the ext host; since neither the home-dir file-watch
		// nor the catalog event reliably fires here, refresh directly off SetModelAction's own write signal.
		this.watch.add(onDidWriteModelDefault(() => void this.refresh()));
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		if (!this.settingsUri) {
			return;
		}
		this.settings = await readModelSettings(this.fileService, this.settingsUri);
		this.update();
	}

	private update(): void {
		// Master toggle: when off, drop the entry entirely (kept orthogonal to VS Code's own right-click hide).
		if (!isClawdiusStatusBarEnabled(this.configurationService)) {
			this.entry.clear();
			return;
		}
		const current = this.settings.model ?? DEFAULT_MODEL;
		const catalog = readClawdiusCatalog(this.languageModelsService);
		const extraEnvIds = [...configEnvModelIds(this.configurationService), ...this.settings.envModelIds];
		const models = buildModelList(catalog, current, extraEnvIds);
		const providerPreset = this.configurationService.getValue<string | undefined>(CLI_PROVIDER_PRESET_KEY);
		const display = modelDisplay(current, models, providerPreset);
		const props = this.getProps(display);
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			// Absolute priority: 100.075 lands the model pill JUST LEFT of the effort pill (100.07) and right of
			// the transient missing-plugin warning (100.08). Fixed numbers keep it put (relative anchors oscillate).
			this.entry.value = this.statusbarService.addEntry(props, 'clawdius.model', StatusbarAlignment.RIGHT, 100.075);
		}
	}

	private getProps(display: IModelDisplay): IStatusbarEntry {
		// Native text rendering: stable layout + native click/hover/focus. No colour coding (per spec) - just the
		// model name after a sparkle glyph.
		return {
			name: localize('clawdius.model.name', "Claude Model"),
			text: display.text,
			ariaLabel: display.ariaLabel,
			tooltip: new MarkdownString(display.tooltip),
			command: SET_MODEL_COMMAND_ID,
		};
	}
}
// CLAWDIUS-END
