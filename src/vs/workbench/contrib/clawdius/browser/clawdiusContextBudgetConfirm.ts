/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Context Budget - confirmed-loaded (opt-in)
// The ONLY ground truth for "which instruction files Claude actually loaded" is Claude Code's InstructionsLoaded
// hook. Capturing it means writing a hook into ~/.claude/settings.json that logs each loaded file's path - a
// config mutation, so it is strictly OPT-IN behind an explicit consent dialog, and fully reversible.
//
// The hook command only INVOKES a small script that Clawdius writes (a .ps1 on Windows, a .sh on POSIX); the
// stdin capture and the (single-quoted) log path live INSIDE that script, not on the shell command line - so the
// outer shell (Git Bash on Windows by default) cannot mangle `$input` or the path, and there is no command-line
// escaping hazard. The script appends the hook payload (one JSON object per loaded file) + a newline to a local
// JSONL log. Nothing leaves the machine. The Context Budget panel reads that log and badges sources it confirms.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';
import { IPathService } from '../../../services/path/common/pathService.js';

export const ENABLE_CONFIRMED_LOADS_COMMAND_ID = 'clawdius.enableConfirmedLoads';
export const DISABLE_CONFIRMED_LOADS_COMMAND_ID = 'clawdius.disableConfirmedLoads';

const LOG_FILE_NAME = '.clawdius-instructions.jsonl';

export function instructionsLogUri(home: URI): URI {
	return URI.joinPath(home, '.claude', LOG_FILE_NAME);
}

// The platform is an optional param (defaulting to the real value) so the script/command builders can be
// unit-tested for both Windows and POSIX without stubbing the global - per the repo's testability guideline.
export function scriptUri(home: URI, win: boolean = isWindows): URI {
	return URI.joinPath(home, '.claude', '.clawdius', win ? 'log-instructions.ps1' : 'log-instructions.sh');
}

const SQ = String.fromCharCode(39); // single quote, built from its code point to keep the lint happy

/** PowerShell single-quoted literal (escape an embedded `'` as `''`). */
function psLiteral(s: string): string { return SQ + s.split(SQ).join(SQ + SQ) + SQ; }
/** POSIX single-quoted literal (escape an embedded `'` as `'\''`). */
function shLiteral(s: string): string { return SQ + s.split(SQ).join(SQ + '\\' + SQ + SQ) + SQ; }

/** The script body that appends the hook payload as one JSONL line, in the platform's native interpreter. */
export function scriptContent(home: URI, win: boolean = isWindows): string {
	const log = instructionsLogUri(home).fsPath;
	// Claude Code can fire InstructionsLoaded for several files near-simultaneously, each invoking this script
	// as its own process. Serialize the append so concurrent invocations neither drop nor interleave lines:
	// a named mutex on Windows, and a single atomic write (one append, <= PIPE_BUF) on POSIX. On Windows,
	// Add-Content with no -Encoding also avoids the per-append UTF-8 BOM that PowerShell 5.1 would inject.
	if (win) {
		return [
			`$m = New-Object System.Threading.Mutex($false, 'ClawdiusInstructionsLog')`,
			`try { [void]$m.WaitOne(5000) } catch { }`,
			`try { $input | Add-Content -LiteralPath ${psLiteral(log)} } finally { try { $m.ReleaseMutex() } catch { } }`,
			``,
		].join('\r\n');
	}
	// $(cat) strips trailing newlines; printf '%s\n' then does one atomic write of the line + a single newline.
	return `printf '%s\\n' "$(cat)" >> ${shLiteral(log)}\n`;
}

/**
 * The hook command: just invoke the script. On POSIX the script path is single-quoted with shLiteral so a
 * `$`, backtick, or quote in the home path can't be interpreted by the shell. On Windows it is double-quoted;
 * Windows path syntax forbids the shell-dangerous characters, so only spaces need handling there.
 */
export function hookCommand(home: URI, win: boolean = isWindows): string {
	const script = scriptUri(home, win).fsPath;
	return win
		? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`
		: `sh ${shLiteral(script)}`;
}

interface IHookEntry {
	readonly hooks?: ReadonlyArray<{ readonly type?: string; readonly command?: string }>;
}

/** Read settings.json; returns raw text, or undefined when missing/empty. Throws on invalid JSON. */
async function readSettings(fileService: IFileService, uri: URI): Promise<string | undefined> {
	let raw: string | undefined;
	try { raw = (await fileService.readFile(uri)).value.toString(); } catch { return undefined; }
	if (raw.trim() === '') { return undefined; }
	JSON.parse(raw); // throws on invalid - callers must not clobber a hand-edited broken file
	return raw;
}

export function existingInstructionsHooks(raw: string | undefined): IHookEntry[] {
	if (raw === undefined) { return []; }
	const arr = (JSON.parse(raw) as { hooks?: { InstructionsLoaded?: unknown } })?.hooks?.InstructionsLoaded;
	return Array.isArray(arr) ? arr as IHookEntry[] : [];
}

/**
 * True only if a hook entry is OUR logging hook: a command that exactly equals the current hookCommand, or
 * that references our specific script path (`<home>/.claude/.clawdius/log-instructions.*`). That path is
 * unique to Clawdius, so this can't match an unrelated user hook the way a generic filename substring would.
 */
export function isClawdiusEntry(entry: IHookEntry, home: URI, win: boolean = isWindows): boolean {
	const cmd = hookCommand(home, win);
	const script = scriptUri(home, win).fsPath;
	return (entry.hooks ?? []).some(h => h.command === cmd || (h.command?.includes(script) ?? false));
}

/** The Clawdius InstructionsLoaded hook entry. */
export function buildClawdiusEntry(home: URI, win: boolean = isWindows): IHookEntry {
	return { hooks: [{ type: 'command', command: hookCommand(home, win) }] };
}

/** Enable: preserve every non-Clawdius InstructionsLoaded hook, replace/append exactly our entry (idempotent). */
export function mergeEnableHooks(existing: readonly IHookEntry[], home: URI, win: boolean = isWindows): IHookEntry[] {
	return [...existing.filter(e => !isClawdiusEntry(e, home, win)), buildClawdiusEntry(home, win)];
}

/** Disable: drop only our entry, keep every other InstructionsLoaded hook untouched. */
export function filterDisableHooks(existing: readonly IHookEntry[], home: URI, win: boolean = isWindows): IHookEntry[] {
	return existing.filter(e => !isClawdiusEntry(e, home, win));
}

/** Installs the InstructionsLoaded logging hook after an explicit consent dialog (preserving existing hooks). */
export class EnableConfirmedLoadsAction extends Action2 {

	static readonly ID = ENABLE_CONFIRMED_LOADS_COMMAND_ID;

	constructor() {
		super({
			id: ENABLE_CONFIRMED_LOADS_COMMAND_ID,
			title: localize2('clawdius.enableConfirmedLoads', "Enable Confirmed Context Loads"),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IDialogService);
		const fileService = accessor.get(IFileService);
		const pathService = accessor.get(IPathService);
		const jsonEditing = accessor.get(IJSONEditingService);
		const notificationService = accessor.get(INotificationService);

		const home = await pathService.userHome();
		const settingsUri = URI.joinPath(home, '.claude', 'settings.json');

		const { confirmed } = await dialogService.confirm({
			message: localize('clawdius.confirm.title', "Enable confirmed context-load tracking?"),
			detail: localize('clawdius.confirm.detail', "This adds an InstructionsLoaded hook to ~/.claude/settings.json and a small logging script under ~/.claude/.clawdius/. Claude Code then runs that script each turn to append the paths of the instruction files it loads to ~/.claude/{0} (local only - nothing leaves your machine). Turn it off any time with \"Clawdius: Disable Confirmed Context Loads\".", LOG_FILE_NAME),
			primaryButton: localize('clawdius.confirm.enable', "Enable"),
		});
		if (!confirmed) {
			return;
		}

		let raw: string | undefined;
		try {
			raw = await readSettings(fileService, settingsUri);
		} catch {
			notificationService.error(localize('clawdius.confirm.invalid', "Can't update settings: {0} is not valid JSON. Fix it and try again.", settingsUri.fsPath));
			return;
		}
		if (raw === undefined) {
			await fileService.writeFile(settingsUri, VSBuffer.fromString('{}\n'));
		}
		// Write the logging script (creates the parent dir).
		await fileService.writeFile(scriptUri(home), VSBuffer.fromString(scriptContent(home)));
		// Preserve any existing InstructionsLoaded hooks; replace only our entry.
		const merged = mergeEnableHooks(existingInstructionsHooks(raw), home);
		await jsonEditing.write(settingsUri, [{ path: ['hooks', 'InstructionsLoaded'], value: merged }], true);
		notificationService.info(localize('clawdius.confirm.enabled', "Confirmed context-load tracking enabled. After your next Claude turn, open the Context Budget panel to see which sources actually loaded."));
	}
}

/** Removes the Clawdius InstructionsLoaded logging hook (leaves any other InstructionsLoaded hooks intact). */
export class DisableConfirmedLoadsAction extends Action2 {

	static readonly ID = DISABLE_CONFIRMED_LOADS_COMMAND_ID;

	constructor() {
		super({
			id: DISABLE_CONFIRMED_LOADS_COMMAND_ID,
			title: localize2('clawdius.disableConfirmedLoads', "Disable Confirmed Context Loads"),
			category: localize2('clawdius.category', "Clawdius"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const pathService = accessor.get(IPathService);
		const jsonEditing = accessor.get(IJSONEditingService);
		const notificationService = accessor.get(INotificationService);

		const home = await pathService.userHome();
		const settingsUri = URI.joinPath(home, '.claude', 'settings.json');

		let raw: string | undefined;
		try {
			raw = await readSettings(fileService, settingsUri);
		} catch {
			notificationService.error(localize('clawdius.confirm.invalid', "Can't update settings: {0} is not valid JSON. Fix it and try again.", settingsUri.fsPath));
			return;
		}
		const all = existingInstructionsHooks(raw);
		const kept = filterDisableHooks(all, home);
		if (kept.length === all.length) {
			notificationService.info(localize('clawdius.confirm.notEnabled', "Confirmed context-load tracking is not enabled."));
			return;
		}
		await jsonEditing.write(settingsUri, [{ path: ['hooks', 'InstructionsLoaded'], value: kept.length ? kept : undefined }], true);
		notificationService.info(localize('clawdius.confirm.disabled', "Confirmed context-load tracking disabled."));
	}
}
// CLAWDIUS-END
