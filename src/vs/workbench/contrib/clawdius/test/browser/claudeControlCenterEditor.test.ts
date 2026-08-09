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
	PLUGIN_ID_RE, ScrollAnchor, canDeleteSkillFile, isSafeMarketplaceSource, isSafeMcpServerName, validateNewSkillFileName,
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

// The Control Center rebuilds its whole tab on a config change, and the pane it rebuilds is a scrolling box. The
// state machine that keeps the user's place across that rebuild is driven purely by offsets, so these tests model
// the scroller as numbers: `beginRebuild(live)` -> restore that value -> `endRebuild(what the browser landed on)`.
// The case worth testing is the one that made the naive save/restore useless - a rebuild whose content is
// momentarily too short to honour the offset, where the browser clamps the restore and the target has to survive.
suite('claudeControlCenterEditor scroll preservation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a clamped restore keeps the target and re-applies it on the next content-bearing rebuild', () => {
		const anchor = new ScrollAnchor();
		// Rebuild 1: the pane is scrolled to 480 and rebuilds into content too short to hold that offset.
		const firstTarget = anchor.beginRebuild(480);
		anchor.endRebuild(0); // the browser clamped the restore to the top
		const pendingAfterClamp = anchor.pendingTarget;
		// Rebuild 2: the real content lands, and the offset asked for is still the ORIGINAL one - not the 0 a
		// save/restore would have memorialized. It is honoured this time, so the target retires.
		const secondTarget = anchor.beginRebuild(0);
		anchor.endRebuild(480);
		const pendingAfterHonoured = anchor.pendingTarget;
		// Rebuild 3: nothing pending, so the pane simply follows its live offset.
		const thirdTarget = anchor.beginRebuild(480);
		assert.deepStrictEqual(
			[firstTarget, pendingAfterClamp, secondTarget, pendingAfterHonoured, thirdTarget],
			[480, 480, 480, undefined, 480],
		);
	});

	test('a user scroll abandons a pending target, the restore that caused one does not', () => {
		const anchor = new ScrollAnchor();
		anchor.beginRebuild(480);
		anchor.endRebuild(0);                    // clamped: 480 is still pending, and 0 is where we landed
		anchor.handleScroll(0);                  // the scroll event the restore itself queued - must be ignored
		const stillPending = anchor.pendingTarget;
		anchor.handleScroll(120);                // the user moves the pane: the pending target is abandoned
		const afterUserScroll = anchor.pendingTarget;
		const nextTarget = anchor.beginRebuild(120);
		assert.deepStrictEqual([stillPending, afterUserScroll, nextTarget], [480, undefined, 120]);
	});

	test('pin overrides the live offset so a tab switch starts at the top', () => {
		const anchor = new ScrollAnchor();
		anchor.beginRebuild(300);
		anchor.endRebuild(300);                  // following the user at 300
		anchor.pin(0);
		const target = anchor.beginRebuild(300); // the offset of the tab being LEFT must not win
		anchor.endRebuild(0);
		assert.deepStrictEqual([target, anchor.pendingTarget], [0, undefined]);
	});

	test('a user scroll the scroll event has not reported yet still abandons the target', () => {
		const anchor = new ScrollAnchor();
		anchor.beginRebuild(600);
		anchor.endRebuild(100);                  // clamped: 600 pending, the pane is sitting at 100
		// The user flicks to the top and a rebuild runs before the compositor dispatches the scroll event, so the
		// only evidence of the scroll is the live offset beginRebuild is handed. It must win over the target.
		const target = anchor.beginRebuild(0);
		assert.deepStrictEqual([target, anchor.pendingTarget], [0, 0]);
	});

	test('pin wins over a user scroll that preceded the tab switch', () => {
		const anchor = new ScrollAnchor();
		anchor.beginRebuild(0);
		anchor.endRebuild(0);
		anchor.handleScroll(800);                // the user reads down the tab they are about to leave
		anchor.pin(0);                           // then clicks another tab
		const target = anchor.beginRebuild(800);
		assert.deepStrictEqual([target, anchor.pendingTarget], [0, 0]);
	});

	test('a user interaction retires a target the pane can no longer reach on its own', () => {
		const anchor = new ScrollAnchor();
		anchor.handleScroll(1500);               // the user reads to the bottom of an expanded skill
		anchor.beginRebuild(1500);               // "Hide files": the collapsed pane is shorter than the viewport
		anchor.endRebuild(0);                    // clamped to the top, and no scroll range is left to escape by
		anchor.handleScroll(0);                  // the scroll event the clamp queued - it landed on `applied`, so it is ignored
		const stranded = anchor.pendingTarget;
		anchor.abandonTarget();                  // the pointerdown of the user's next click, before its handler acts
		const afterInteraction = anchor.pendingTarget;
		const nextTarget = anchor.beginRebuild(0); // "Show files" on another row: the taller rebuild stays put
		assert.deepStrictEqual([stranded, afterInteraction, nextTarget], [1500, undefined, 0]);
	});

	test('an interaction retires only what was armed before it, so a click that reloads keeps its offset', () => {
		const anchor = new ScrollAnchor();
		anchor.handleScroll(400);
		anchor.abandonTarget();                  // pointerdown on Refresh
		const loadingTarget = anchor.beginRebuild(400); // the click's own rebuild paints "Resolving..." - too short to hold 400
		anchor.endRebuild(0);
		const restored = anchor.beginRebuild(0); // the resolved table lands and the offset is honoured after all
		anchor.endRebuild(400);
		assert.deepStrictEqual([loadingTarget, restored, anchor.pendingTarget], [400, 400, undefined]);
	});

	test('a sub-pixel landing counts as reaching the target', () => {
		const anchor = new ScrollAnchor();
		anchor.beginRebuild(480);
		anchor.endRebuild(479.5);
		assert.strictEqual(anchor.pendingTarget, undefined);
	});
});
// CLAWDIUS-END
