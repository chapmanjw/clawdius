/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN control center editor security-guard unit tests
// The Control Center stages `claude ...` commands into the user's terminal and writes keys into ~/.claude
// settings.json. The pure guards extracted from the editor pane are the gates on those paths: they reject shell
// metacharacters (command injection) and path traversal / sibling-prefix escapes before any value reaches a
// terminal or a settings key. These cover accept + reject for each guard.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PLUGIN_ID_RE, canDeleteSkillFile, isSafeMarketplaceSource, isSafeMcpServerName, validateNewSkillFileName,
} from '../../browser/control/claudeControlCenterEditor.js';

// A single quote and a backslash, built without a double-quoted literal (lint forbids those outside nls).
const SQUOTE = String.fromCharCode(39);

suite('claudeControlCenterEditor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('isSafeMarketplaceSource accepts repo/URL/path, rejects empty + shell metacharacters', () => {
		assert.deepStrictEqual(
			[
				isSafeMarketplaceSource('owner/repo'),
				isSafeMarketplaceSource('https://example.com/x/y.git'),
				isSafeMarketplaceSource('C:\\Users\\me\\my plugin'), // Windows path with spaces + backslashes
				isSafeMarketplaceSource(''),
				isSafeMarketplaceSource('   '),
				isSafeMarketplaceSource('a; rm -rf ~'),
				isSafeMarketplaceSource('a$(x)'),
				isSafeMarketplaceSource('a`x`'),
				isSafeMarketplaceSource('a|b'),
				isSafeMarketplaceSource('a"b'),            // double-quote metachar
				isSafeMarketplaceSource('a' + SQUOTE + 'b'), // single-quote metachar
				isSafeMarketplaceSource('a\nb'),           // newline
			],
			[true, true, true, false, false, false, false, false, false, false, false, false],
		);
	});

	test('PLUGIN_ID_RE matches plugin-id@marketplace-id and rejects malformed ids', () => {
		assert.deepStrictEqual(
			['fmt@anthropic', 'a.b-c_d@mp.1', 'no-at', 'a@b@c', 'a@', '@b', 'a b@c', 'a;@c'].map(id => PLUGIN_ID_RE.test(id)),
			[true, true, false, false, false, false, false, false],
		);
	});

	test('validateNewSkillFileName rejects traversal/separators/manifest, allows skill.md under a subdir', () => {
		assert.deepStrictEqual(
			[
				validateNewSkillFileName('../x', ''),
				validateNewSkillFileName('a/b', ''),
				validateNewSkillFileName('a\\b', ''),
				validateNewSkillFileName('..', ''),
				validateNewSkillFileName('.', ''),
				validateNewSkillFileName('', ''),
				validateNewSkillFileName('SKILL.md', ''),           // case-insensitive root collision with the manifest
				validateNewSkillFileName('SKILL.md', 'references'), // allowed once it is inside a subdirectory
				validateNewSkillFileName('REFERENCE.md', ''),       // an ordinary supporting file
			],
			[
				{ ok: false, reason: 'badName' },
				{ ok: false, reason: 'badName' },
				{ ok: false, reason: 'badName' },
				{ ok: false, reason: 'badName' },
				{ ok: false, reason: 'badName' },
				{ ok: false, reason: 'badName' },
				{ ok: false, reason: 'skillMdReserved' },
				{ ok: true },
				{ ok: true },
			],
		);
	});

	test('isSafeMcpServerName accepts a simple key, rejects empty + key-unsafe characters', () => {
		assert.deepStrictEqual(
			['my-server', 'a.b_c', '', 'a b', 'a/b', 'a;b', 'a@b'].map(isSafeMcpServerName),
			[true, true, false, false, false, false, false],
		);
	});

	test('canDeleteSkillFile allows a nested file, rejects the folder/manifest/dir and a sibling-prefix path', () => {
		const folder = URI.file('/home/u/.claude/skills/foo');
		assert.deepStrictEqual(
			[
				canDeleteSkillFile(folder, folder, false, false),                                          // the folder itself
				canDeleteSkillFile(URI.file('/home/u/.claude/skills/foo/SKILL.md'), folder, false, true),  // the manifest
				canDeleteSkillFile(URI.file('/home/u/.claude/skills/foo/refs'), folder, true, false),      // a directory
				canDeleteSkillFile(URI.file('/home/u/.claude/skills/foo-bar/x.md'), folder, false, false), // sibling-prefix, NOT inside foo
				canDeleteSkillFile(URI.file('/home/u/.claude/skills/foo/refs/x.md'), folder, false, false),// a real nested file
			],
			[false, false, false, false, true],
		);
	});
});
// CLAWDIUS-END
