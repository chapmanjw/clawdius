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

function scriptUri(home: URI): URI {
	return URI.joinPath(home, '.claude', '.clawdius', isWindows ? 'log-instructions.ps1' : 'log-instructions.sh');
}

const SQ = String.fromCharCode(39); // single quote, built from its code point to keep the lint happy

/** PowerShell single-quoted literal (escape an embedded `'` as `''`). */
function psLiteral(s: string): string { return SQ + s.split(SQ).join(SQ + SQ) + SQ; }
/** POSIX single-quoted literal (escape an embedded `'` as `'\''`). */
function shLiteral(s: string): string { return SQ + s.split(SQ).join(SQ + '\\' + SQ + SQ) + SQ; }

/** The script body that appends stdin + a newline to the log, in the platform's native interpreter. */
function scriptContent(home: URI): string {
	const log = instructionsLogUri(home).fsPath;
	// Add-Content appends a trailing newline and (with no -Encoding) avoids the per-append UTF-8 BOM that
	// Windows PowerShell 5.1 would otherwise inject mid-file and corrupt the JSONL.
	return isWindows
		? `$input | Add-Content -LiteralPath ${psLiteral(log)}\r\n`
		: `cat >> ${shLiteral(log)}\nprintf '\\n' >> ${shLiteral(log)}\n`;
}

/** The hook command: just invoke the script. Only the script path is on the command line, double-quoted. */
function hookCommand(home: URI): string {
	const script = scriptUri(home).fsPath;
	return isWindows
		? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`
		: `sh "${script}"`;
}

interface IHookEntry {
	readonly hooks?: ReadonlyArray<{ readonly command?: string }>;
}

/** Read settings.json; returns raw text, or undefined when missing/empty. Throws on invalid JSON. */
async function readSettings(fileService: IFileService, uri: URI): Promise<string | undefined> {
	let raw: string | undefined;
	try { raw = (await fileService.readFile(uri)).value.toString(); } catch { return undefined; }
	if (raw.trim() === '') { return undefined; }
	JSON.parse(raw); // throws on invalid - callers must not clobber a hand-edited broken file
	return raw;
}

function existingInstructionsHooks(raw: string | undefined): IHookEntry[] {
	if (raw === undefined) { return []; }
	const arr = (JSON.parse(raw) as { hooks?: { InstructionsLoaded?: unknown } })?.hooks?.InstructionsLoaded;
	return Array.isArray(arr) ? arr as IHookEntry[] : [];
}

/** True if a hook entry is the Clawdius logging hook (any of its commands invokes our log script). */
function isClawdiusEntry(entry: IHookEntry, home: URI): boolean {
	const cmd = hookCommand(home);
	return (entry.hooks ?? []).some(h => h.command === cmd || (h.command?.includes(LOG_FILE_NAME) ?? false) || (h.command?.includes('log-instructions') ?? false));
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
		const merged = [
			...existingInstructionsHooks(raw).filter(e => !isClawdiusEntry(e, home)),
			{ hooks: [{ type: 'command', command: hookCommand(home) }] },
		];
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
		const kept = all.filter(e => !isClawdiusEntry(e, home));
		if (kept.length === all.length) {
			notificationService.info(localize('clawdius.confirm.notEnabled', "Confirmed context-load tracking is not enabled."));
			return;
		}
		await jsonEditing.write(settingsUri, [{ path: ['hooks', 'InstructionsLoaded'], value: kept.length ? kept : undefined }], true);
		notificationService.info(localize('clawdius.confirm.disabled', "Confirmed context-load tracking disabled."));
	}
}
// CLAWDIUS-END
