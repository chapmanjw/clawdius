/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Context Budget - confirmed-loaded (opt-in)
// The ONLY ground truth for "which instruction files Claude actually loaded" is Claude Code's InstructionsLoaded
// hook. Capturing it means writing a hook into ~/.claude/settings.json that logs each loaded file's path - a
// config mutation, so it is strictly OPT-IN behind an explicit consent dialog, and fully reversible. The hook
// command appends the hook payload (one JSON object per loaded file, on stdin) to a local log; nothing leaves
// the machine. The Context Budget panel reads that log and badges sources it confirms actually loaded.

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

/** Marker substring in the hook command, so the disable action can find + remove only our entry. */
const LOG_FILE_NAME = '.clawdius-instructions.jsonl';

export function instructionsLogUri(home: URI): URI {
	return URI.joinPath(home, '.claude', LOG_FILE_NAME);
}

/** A platform-appropriate shell command that appends the hook's stdin JSON (one object per loaded file) + a
 *  newline to the log, producing JSONL. */
function hookCommand(home: URI): string {
	const log = instructionsLogUri(home).fsPath;
	return isWindows
		? `powershell -NoProfile -Command "$input | Add-Content -LiteralPath '${log}'"`
		: `sh -c 'cat >> "${log}"; echo "" >> "${log}"'`;
}

/** Read settings.json; returns its raw text, or undefined when missing/empty. Throws on invalid JSON. */
async function readSettings(fileService: IFileService, uri: URI): Promise<string | undefined> {
	let raw: string | undefined;
	try { raw = (await fileService.readFile(uri)).value.toString(); } catch { return undefined; }
	if (raw.trim() === '') { return undefined; }
	JSON.parse(raw); // throws if invalid - callers must not clobber a hand-edited broken file
	return raw;
}

/** Installs the InstructionsLoaded logging hook after an explicit consent dialog. */
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
			detail: localize('clawdius.confirm.detail', "This adds an InstructionsLoaded hook to ~/.claude/settings.json. Claude Code will then run a small command each turn that appends the paths of the instruction files it loads to ~/.claude/{0} (local only - nothing leaves your machine). Turn it off any time with \"Clawdius: Disable Confirmed Context Loads\".", LOG_FILE_NAME),
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
		const entry = { hooks: [{ type: 'command', command: hookCommand(home) }] };
		await jsonEditing.write(settingsUri, [{ path: ['hooks', 'InstructionsLoaded'], value: [entry] }], true);
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
		const arr = raw !== undefined ? (JSON.parse(raw) as { hooks?: { InstructionsLoaded?: unknown[] } })?.hooks?.InstructionsLoaded : undefined;
		if (!Array.isArray(arr)) {
			notificationService.info(localize('clawdius.confirm.notEnabled', "Confirmed context-load tracking is not enabled."));
			return;
		}
		// Drop only the entries that reference our log file; keep any unrelated InstructionsLoaded hooks.
		const kept = arr.filter(e => !JSON.stringify(e).includes(LOG_FILE_NAME));
		await jsonEditing.write(settingsUri, [{ path: ['hooks', 'InstructionsLoaded'], value: kept.length ? kept : undefined }], true);
		notificationService.info(localize('clawdius.confirm.disabled', "Confirmed context-load tracking disabled."));
	}
}
// CLAWDIUS-END
