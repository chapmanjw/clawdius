/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildClawdiusEntry, existingInstructionsHooks, filterDisableHooks, hookCommand, instructionsLogUri,
	isClawdiusEntry, mergeEnableHooks, scriptContent, scriptUri,
} from '../../browser/clawdiusContextBudgetConfirm.js';

// The settings.json write path is the one module that mutates ~/.claude, so its pure helpers (script body,
// hook command, hook-array merge/filter, ownership match) get direct coverage. The platform is passed
// explicitly (win=true/false) so both Windows and POSIX output are exercised regardless of the test OS;
// expectations derive paths from the same exported URI helpers, so separator/casing differences don't matter.
suite('clawdiusContextBudgetConfirm', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const home = URI.file('/home/alice');
	// A POSIX single-quote escape sequence: '\'' (close-quote, escaped quote, reopen). Built from single-char
	// literals so the test source itself needs no double quotes (the repo lint forbids them outside nls).
	const escapedSingleQuote = '\'' + '\\' + '\'' + '\'';
	const homeWithQuote = URI.file('/home/o\'brien');

	test('scriptContent (POSIX) is a single atomic append of the payload line', () => {
		const log = instructionsLogUri(home).fsPath;
		assert.strictEqual(scriptContent(home, false), `printf '%s\\n' "$(cat)" >> '${log}'\n`);
	});

	test('scriptContent (Windows) serializes via a named mutex and adds no BOM encoding', () => {
		const log = instructionsLogUri(home).fsPath;
		const content = scriptContent(home, true);
		assert.ok(content.includes('System.Threading.Mutex'), content);
		assert.ok(content.includes('ClawdiusInstructionsLog'), content);
		assert.ok(content.includes(`Add-Content -LiteralPath '${log}'`), content);
		assert.ok(!content.includes('-Encoding'), 'must not set -Encoding (would inject a per-append BOM)');
		assert.ok(content.endsWith('\r\n'), 'CRLF-terminated');
	});

	test('scriptContent (POSIX) shell-escapes a single quote in the home path', () => {
		assert.ok(scriptContent(homeWithQuote, false).includes(escapedSingleQuote), 'quote in home path must be shell-escaped');
	});

	test('hookCommand quotes the script path: double on Windows, single (shLiteral) on POSIX', () => {
		assert.strictEqual(hookCommand(home, true), `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptUri(home, true).fsPath}"`);
		assert.strictEqual(hookCommand(home, false), `sh '${scriptUri(home, false).fsPath}'`);
	});

	test('hookCommand (POSIX) shell-escapes a special home path', () => {
		assert.ok(hookCommand(homeWithQuote, false).includes(escapedSingleQuote), 'quote in home path must be shell-escaped');
	});

	test('scriptUri picks .ps1 on Windows and .sh on POSIX', () => {
		assert.ok(scriptUri(home, true).path.endsWith('/.clawdius/log-instructions.ps1'));
		assert.ok(scriptUri(home, false).path.endsWith('/.clawdius/log-instructions.sh'));
	});

	test('existingInstructionsHooks parses the array and tolerates missing/garbage shapes', () => {
		const arr = [{ hooks: [{ type: 'command', command: 'x' }] }];
		assert.deepStrictEqual(
			[
				existingInstructionsHooks(undefined),
				existingInstructionsHooks('{}'),
				existingInstructionsHooks('{"hooks":{"InstructionsLoaded":"nope"}}'),
				existingInstructionsHooks(JSON.stringify({ hooks: { InstructionsLoaded: arr } })),
			],
			[[], [], [], arr],
		);
	});

	test('mergeEnableHooks preserves foreign hooks, appends exactly one Clawdius entry, idempotently', () => {
		const foreign = { hooks: [{ type: 'command', command: 'echo audit' }] };
		const ours = buildClawdiusEntry(home, true);
		const once = mergeEnableHooks([foreign], home, true);
		const twice = mergeEnableHooks(once, home, true);
		assert.deepStrictEqual([once, twice], [[foreign, ours], [foreign, ours]]);
	});

	test('filterDisableHooks removes only the Clawdius entry', () => {
		const foreign = { hooks: [{ type: 'command', command: 'echo audit' }] };
		const withOurs = mergeEnableHooks([foreign], home, true);
		assert.deepStrictEqual(filterDisableHooks(withOurs, home, true), [foreign]);
	});

	test('isClawdiusEntry matches our command or script path, but not a lookalike foreign hook', () => {
		const script = scriptUri(home, true).fsPath;
		assert.deepStrictEqual(
			[
				isClawdiusEntry(buildClawdiusEntry(home, true), home, true),
				isClawdiusEntry({ hooks: [{ type: 'command', command: `powershell -File "${script}"` }] }, home, true),
				isClawdiusEntry({ hooks: [{ type: 'command', command: 'pwsh -File /backups/log-instructions-old.ps1' }] }, home, true),
				isClawdiusEntry({ hooks: [{ type: 'command', command: 'echo unrelated' }] }, home, true),
			],
			[true, true, false, false],
		);
	});
});
