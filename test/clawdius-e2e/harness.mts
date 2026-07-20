/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Clawdius local E2E harness.
//
// Launches the compiled dev build of Clawdius (.build/electron/Clawdius.exe) with an ISOLATED
// user-data/extensions dir (never touches your real ~/.clawdius) and drives each Clawdius feature
// with Playwright, screenshotting + asserting each step. Produces a pass/fail report and a
// screenshot per scenario so a run is reviewable and re-playable.
//
// Prereqs (once): `node build/lib/preLaunch.ts` (gets electron + compiles + built-in extensions).
// Run:            `node test/clawdius-e2e/harness.mts`   (from the repo root; needs a display)
//                 (.mts, not .ts: test/package.json is `type: commonjs`, so a .ts here would be treated as
//                  CommonJS and reject this file's ESM `import`s; the .mts extension forces ESM + type-strip.)
// Options:        `--out <dir>` (screenshot dir, default .build/clawdius-e2e)
//                 `--keep-open` (leave the window open at the end for manual poking)
//                 `--grep <substr>` (run only scenarios whose name contains <substr>)
//
// Exit code is non-zero if any scenario marked `critical` fails. See README.md for the full
// replay-step catalogue.

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const OUT = opt('--out', join(REPO, '.build', 'clawdius-e2e'));
const KEEP_OPEN = args.includes('--keep-open');
const GREP = opt('--grep', '');
mkdirSync(OUT, { recursive: true });

const results = [];
let win;

async function shot(name) {
	const path = join(OUT, `${String(results.length + 1).padStart(2, '0')}-${name}.png`);
	try { await win.screenshot({ path }); } catch { /* ignore */ }
	return path;
}

// Run one scenario: record pass/fail + a screenshot. `critical` scenarios fail the run.
async function scenario(name, critical, fn) {
	if (GREP && !name.includes(GREP)) { return; }
	const rec = { name, critical, ok: false, skipped: false, detail: '', screenshot: '' };
	try {
		rec.detail = (await fn()) || 'ok';
		rec.ok = true;
		if (/^SKIPPED\b/i.test(rec.detail)) { rec.skipped = true; } // a skip is not a pass
	} catch (err) {
		rec.detail = (err && err.message) || String(err);
	}
	rec.screenshot = await shot(name);
	results.push(rec);
	console.log(`${rec.skipped ? 'SKIP' : (rec.ok ? 'PASS' : (critical ? 'FAIL' : 'WARN'))}  ${name}  -  ${rec.detail}`);
}

// --- driving helpers -------------------------------------------------------------------------

async function closeQuickInput() {
	await win.keyboard.press('Escape');
	await win.waitForTimeout(200);
}

// Run a command by its palette title (category is "Clawdius", so pass e.g. "Open Claude Code Control Center").
async function runCommand(title) {
	await win.keyboard.press('Control+Shift+P');
	await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
	await win.waitForTimeout(300);
	await win.keyboard.type(title, { delay: 8 });
	await win.waitForTimeout(600);
	await win.keyboard.press('Enter');
	await win.waitForTimeout(1200);
}

async function setTheme(themeLabel) {
	await win.keyboard.press('Control+Shift+P');
	await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
	await win.keyboard.type('Preferences: Color Theme', { delay: 8 });
	await win.waitForTimeout(500);
	await win.keyboard.press('Enter');
	await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
	await win.waitForTimeout(400);
	await win.keyboard.type(themeLabel, { delay: 8 });
	await win.waitForTimeout(500);
	await win.keyboard.press('Enter');
	await win.waitForTimeout(800);
}

// The workbench root's theme-TYPE class (vs / vs-dark / hc-black / hc-light - ThemeTypeSelector,
// src/vs/platform/theme/common/theme.ts), applied to `layoutService.mainContainer` (`.monaco-workbench`) by
// `WorkbenchThemeService` on every theme change. Reading this back is an INDEPENDENT, DOM-level proof of which
// theme actually took effect - it does not trust the quick-pick's own selection.
async function themeTypeClass() {
	return await win.$eval('.monaco-workbench', el => {
		const types = ['vs-dark', 'hc-black', 'hc-light', 'vs'];
		return types.find(t => el.classList.contains(t));
	});
}

const EXPECTED_THEME_TYPE = {
	'Clawdius Dark': 'vs-dark',
	'Clawdius Light': 'vs',
	'Clawdius High Contrast': 'hc-black',
	'Clawdius High Contrast Light': 'hc-light',
};

// Select `themeLabel` by opening the Color Theme picker, typing an exact filter, and CLICKING the one
// matching row - never a blind Enter. Root cause found by reading themes.contribution.ts (upstream VS Code,
// Microsoft-licensed, untouched by the workflows rename): this build's local theme catalogue is large (dozens of
// themes across many bundled extensions besides this fork's own 4) and the picker's `picks` are GROUPED BY
// TYPE (`[...darkEntries, ...lightEntries, ...hcEntries]` for a dark-preferred system scheme) - so "Clawdius
// Light" sits behind the ENTIRE dark-themes group while "Clawdius Dark" sits near the top (and is also the
// pre-focused CURRENT theme). A fixed short wait after typing is long enough to refilter a small catalogue but
// not this one: pressing Enter before the (large) refilter finishes can accept whatever was still active
// beforehand, which was observed landing on the picker's own unrelated "Browse Additional Color Themes..."
// entry (opening a "Marketplace Themes" sub-picker) - explaining why "Dark" always looked fine (no real
// transition needed) while "Light"/HC transitions did not. Polling the RENDERED ROW COUNT down to a small,
// genuinely-filtered set before clicking (rather than trusting a fixed delay) fixes this. Independently
// VERIFIES the result via `themeTypeClass()` afterward - the workbench's OWN rendered theme-type class.
//
// Also root-caused: this build's COMMAND PALETTE itself is similarly large (many bundled extensions
// contribute commands), so the SAME "don't accept before the filtered list has genuinely narrowed" fix is
// applied to the FIRST step too - blindly pressing Enter after typing "Preferences: Color Theme" was
// occasionally landing on a DIFFERENT, unrelated command from the still-unfiltered top of the list (there is
// a real, separate "Preferences: Browse Color Themes in Marketplace" command that also opens a quick pick),
// which explains a `"Searching for themes..."` result even before this function ever typed a theme name.

/** Poll `.quick-input-list .monaco-list-row` until it narrows to a small set, find the row whose
 *  `.quick-input-list-label .label-name` text equals `exactLabel`, and click it. Never types blind, never
 *  presses Enter. Returns the seen label texts (for diagnostics) alongside whether a match was clicked. */
async function pollAndClickExactRow(exactLabel) {
	let seen = [];
	for (let poll = 0; poll < 30; poll++) {
		await win.waitForTimeout(250);
		const rows = await win.$$('.quick-input-list .monaco-list-row');
		if (rows.length === 0 || rows.length > 8) { continue; } // not narrowed down (or not yet rendered) - keep waiting
		seen = [];
		for (const row of rows) {
			const label = await row.$('.quick-input-list-label .label-name');
			const text = label ? ((await label.innerText()) || '').trim() : ((await row.innerText()) || '').trim();
			seen.push(text);
			if (text === exactLabel) {
				await row.click();
				return { clicked: true, seen };
			}
		}
	}
	return { clicked: false, seen };
}

async function setThemeVerified(themeLabel) {
	const expected = EXPECTED_THEME_TYPE[themeLabel];
	let lastErr = '';
	for (let attempt = 1; attempt <= 3; attempt++) {
		if (attempt > 1) {
			// A previous attempt may have fallen through to the unrelated Marketplace-search sub-picker and
			// left it OPEN - a stuck widget that would otherwise swallow the next Ctrl+Shift+P as more typing
			// into that SAME stale search box rather than a fresh command palette/picker. Force it closed first.
			await closeQuickInput();
			await closeQuickInput();
			await win.waitForTimeout(300);
		}

		await win.keyboard.press('Control+Shift+P');
		await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
		await win.keyboard.type('Preferences: Color Theme', { delay: 8 });
		// Command palette rows combine category + title into ONE label ("{0}: {1}", commandsQuickAccess.ts) -
		// match the combined string, not the bare title.
		const cmd = await pollAndClickExactRow('Preferences: Color Theme');
		if (!cmd.clicked) {
			lastErr = `command palette never narrowed to exactly "Preferences: Color Theme"; last-seen rows: ${cmd.seen.join(' || ')}`;
			continue;
		}

		await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
		await win.waitForTimeout(300);
		await win.keyboard.type(themeLabel, { delay: 8 });
		const theme = await pollAndClickExactRow(themeLabel);
		if (!theme.clicked) {
			lastErr = `no exact row match after filtering for "${themeLabel}"; last-seen rows: ${theme.seen.join(' || ')}`;
			continue;
		}

		let actual;
		for (let poll = 0; poll < 15; poll++) {
			actual = await themeTypeClass();
			if (!expected || actual === expected) { return actual; }
			await win.waitForTimeout(300);
		}
		lastErr = `clicked "${themeLabel}" but workbench theme-type class read "${actual}", expected "${expected}"`;
	}
	throw new Error(`setThemeVerified("${themeLabel}") failed after 3 attempts: ${lastErr}`);
}

// --- workflows drill-in driving (result/agent/transcript editor panes) -----------------------------------------
//
// Drill-in editors open on the tree's `onDidOpen` (Enter or mouse activation, see claudeWorkflowsView.ts) as REAL
// EDITOR TABS in the editor area (IEditorService.openEditor), not sidebar DOM - so these helpers, unlike the
// tree-only ones above, wait for `.clawdius-workflow-detail`/`.clawdius-transcript` to ATTACH there.

// Open the workflows sidebar and wait for its first real paint (rows or a state message) - the same two-step
// wait (`.clawdius-workflows-tree` attached, then rows/state-message) every other workflows scenario in this
// file already does; factored here since the drill-in scenarios below need it more than once.
async function focusWorkflowsView() {
	await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
	await win.waitForTimeout(3000);
	// Dismiss any overlay a preceding scenario left up (e.g. a theme-picker quick input), which would otherwise
	// block clicks on the tree below and time them out.
	await win.keyboard.press('Escape');
	await win.waitForTimeout(150);
	await runCommand('Focus on Claude Code Ultracode Workflows View');
	await win.waitForSelector('.clawdius-workflows-tree', { state: 'attached', timeout: 15000 });
	await win.waitForFunction(
		() => document.querySelector('.clawdius-workflow-run-row') !== null || document.querySelector('[data-clawdius-workflows-state]') !== null,
		undefined, { timeout: 60000 },
	);
	await win.waitForTimeout(300);
	// Reset the virtualized tree to the TOP so every caller finds run rows from a deterministic state (a preceding
	// scenario may have paged/scrolled it, leaving a stale off-screen handle that then times out on click).
	const firstRow = await win.$('.clawdius-workflow-run-row');
	if (firstRow) {
		await firstRow.click().catch(() => { });
		await win.keyboard.press('Home');
		await win.waitForTimeout(250);
	}
}

// Expand ONE terminal run's row (click, then ArrowRight, then a twistie-click fallback - the exact sequence
// `ultracode-workflows-expand` already exercises) and, when it declares MORE THAN ONE phase (the 0/1/>1
// phase-grouping rule in `buildTerminalRunChildren`), also expand every `.clawdius-workflow-phase-row` that
// appears so any agent rows nested under a phase become visible too - otherwise a multi-phase run would falsely
// look agent-less. Returns the story leaf handle (undefined if the run never revealed one) and whatever
// `.clawdius-workflow-agent-row`s are now in the DOM - scoped correctly as long as the caller keeps only ONE run
// expanded at a time.
async function expandRunAndGatherAgents(target) {
	await target.scrollIntoViewIfNeeded();
	await target.click();
	await win.waitForTimeout(150);
	await win.keyboard.press('ArrowRight');
	await win.waitForTimeout(400);
	let storyHandles = await win.$$('.clawdius-workflow-story');
	if (storyHandles.length === 0) {
		const twistie = await target.$('.monaco-tl-twistie');
		if (twistie) {
			await twistie.click();
			await win.waitForTimeout(400);
			storyHandles = await win.$$('.clawdius-workflow-story');
		}
	}
	if (storyHandles.length === 0) {
		return { story: undefined, agentRows: [] };
	}
	const phaseRows = await win.$$('.clawdius-workflow-phase-row');
	for (const phaseRow of phaseRows) {
		try {
			await phaseRow.click();
			await win.waitForTimeout(100);
			await win.keyboard.press('ArrowRight');
			await win.waitForTimeout(250);
		} catch { /* best-effort: a phase row that can't expand just contributes no agent rows below */ }
	}
	const agentRows = await win.$$('.clawdius-workflow-agent-row');
	return { story: storyHandles[0], agentRows };
}

// Activate a leaf (story or agent row) and wait for its drill-in pane to attach in the editor area. Click first
// (this build's default `workbench.list.openMode` is `singleClick`, so `onDidOpen` should fire directly); fall
// back to select+Enter if the pane never attached - `onDidOpen` fires on either per claudeWorkflowsView.ts.
// Returns the attached pane's ElementHandle, or null if NEITHER activation opened it - a real defect the caller
// should assert (and fail loudly) on, never silently swallow.
async function activateAndWaitForDetail(rowHandle, kind) {
	const selector = `.clawdius-workflow-detail[data-clawdius-detail-kind="${kind}"]`;
	await rowHandle.scrollIntoViewIfNeeded();
	await rowHandle.click();
	// A completed run's FULL result can be very large (a real run here carried ~520K tokens of resultText -
	// several MB once rendered via `textContent`), and this is an unoptimized dev build, so the render+reflow
	// genuinely takes several seconds - give the first (click) activation real room before falling back. The
	// fallback does NOT re-click: the row is already selected from the click above, and a second onDidOpen while
	// the first openEditor() is still in flight would only add contention, not speed anything up.
	let pane = await win.waitForSelector(selector, { state: 'attached', timeout: 12000 }).catch(() => null);
	if (!pane) {
		// The click may have only selected the row (open-on-single-click is a setting); Enter always fires onDidOpen.
		await win.keyboard.press('Enter');
		pane = await win.waitForSelector(selector, { state: 'attached', timeout: 12000 }).catch(() => null);
	}
	return pane;
}

async function closeActiveEditorTab() {
	try {
		await win.keyboard.press('Control+w');
		await win.waitForTimeout(300);
	} catch { /* best effort */ }
}

// Inspect an already-open AGENT detail pane: its honest state (`data-clawdius-detail-state`, set by
// `renderAgentDetail` in claudeWorkflowDetailEditor.ts - NOT `data-clawdius-detail-status`, which is the RESULT
// variant's attribute), the transcript-affordance flag (`data-clawdius-detail-transcript`, "present" exactly
// when `payload.transcriptRef` was defined), and the present/absent split across its
// `[data-clawdius-detail-field]` rows - the dash-where-absent proof.
async function probeAgentPane(pane, agentId) {
	const state = await pane.getAttribute('data-clawdius-detail-state');
	const transcriptPresent = (await pane.getAttribute('data-clawdius-detail-transcript')) === 'present';
	const fieldHandles = await pane.$$('[data-clawdius-detail-field]');
	let present = 0, absent = 0;
	for (const f of fieldHandles) {
		if ((await f.getAttribute('data-clawdius-detail-field-present')) === 'true') { present++; } else { absent++; }
	}
	return { agentId, state, transcriptPresent, present, absent, total: fieldHandles.length, pane };
}

// --- failure-surfacing driving (errored-chip scan) --------------------------------------------------------------

// Scan the currently-rendered (visible) `.clawdius-workflow-run-row`s for the FIRST one carrying a REAL positive
// `.errored-chip`. `erroredAgentCount` (claudeWorkflowTree.ts) is `undefined` for a live/unknown-shape run and, for
// a terminal run, the RENDERER only sets the chip's `textContent` (to "{N} errored") and shows it when the tally is
// `> 0` - clearing `textContent` to '' and hiding it otherwise. So any non-empty text here is a genuine positive
// tally, never a fabricated "0 errored". Never scrolls to force a hit: the view orders runs most-actionable-first,
// so a genuine failure should already be in the first screenful; callers report an empty scan as an honest SKIP.
async function findErroredChipRun() {
	// The run list is a VIRTUALIZED tree: an errored run can sit below the initial screenful. Focus the tree, page to
	// the top, then page DOWN scanning each rendered screenful for the errored-agent chip (bounded). The returned
	// handle is one currently in the DOM, so the caller can expand it immediately.
	const first = await win.$('.clawdius-workflow-run-row');
	if (first) {
		await first.click();
		await win.keyboard.press('Home');
		await win.waitForTimeout(200);
	}
	const seen = new Set();
	for (let page = 0; page < 30; page++) {
		for (const h of await win.$$('.clawdius-workflow-run-row')) {
			const runId = await h.getAttribute('data-run-id');
			if (runId) { seen.add(runId); }
			const chip = await h.$('.clawdius-workflow-chip.errored-chip');
			if (!chip) { continue; }
			const chipText = ((await chip.textContent()) || '').trim();
			if (chipText) {
				return { target: h, runId, runKind: await h.getAttribute('data-run-kind'), chipText, scanned: seen.size };
			}
		}
		await win.keyboard.press('PageDown');
		await win.waitForTimeout(150);
	}
	return { target: undefined, runId: undefined, runKind: undefined, chipText: '', scanned: seen.size };
}

// --- sidebar width driving (theme x width matrix) --------------------------------------------------------------

async function getSidebarBox() {
	const el = await win.$('.part.sidebar');
	if (!el) { return undefined; }
	return (await el.boundingBox()) ?? undefined;
}

// The Grid's resize sash between the sidebar and its right-hand neighbor (the editor group) is one of possibly
// several `.monaco-sash.vertical` elements in the workbench (auxiliary bar, panel, etc. can add their own). Pick
// the one whose vertical extent overlaps the sidebar part AND whose x is closest to the sidebar's own right
// edge, rather than just the first match, so an unrelated sash (e.g. editor<->auxiliarybar) is never grabbed.
async function findSidebarResizeSash(sidebarBox) {
	const sashes = await win.$$('.monaco-sash.vertical');
	let best; let bestDist = Infinity;
	for (const sash of sashes) {
		const box = await sash.boundingBox();
		if (!box) { continue; }
		const overlapsY = box.y < sidebarBox.y + sidebarBox.height && (box.y + box.height) > sidebarBox.y;
		if (!overlapsY) { continue; }
		const dist = Math.abs(box.x - (sidebarBox.x + sidebarBox.width));
		if (dist < bestDist) { bestDist = dist; best = box; }
	}
	return best;
}

// Drag the sidebar/editor sash so the sidebar's MEASURED width lands near `targetPx`. Returns the ACTUAL width
// re-measured after the drag - never the target - so the caller can report honestly what was actually achieved.
// Throws only when the sidebar part or its resize sash cannot be located at all (a harness fault); landing
// outside tolerance is left for the caller to judge; it is not itself an error here.
async function setSidebarWidth(targetPx) {
	const before = await getSidebarBox();
	if (!before) { throw new Error('`.part.sidebar` not found - cannot measure or drag its width'); }
	const sash = await findSidebarResizeSash(before);
	if (!sash) { throw new Error('no `.monaco-sash.vertical` found adjacent to the sidebar'); }
	const delta = targetPx - before.width;
	const startX = sash.x + sash.width / 2;
	const startY = sash.y + sash.height / 2;
	await win.mouse.move(startX, startY);
	await win.mouse.down();
	await win.mouse.move(startX + delta, startY, { steps: 12 });
	await win.mouse.up();
	await win.waitForTimeout(300);
	const after = await getSidebarBox();
	return after ? after.width : before.width;
}

function assert(cond, msg) { if (!cond) { throw new Error(msg); } }

async function statusText() {
	return await win.$$eval('.statusbar .statusbar-item',
		els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean));
}

// --- workflows-rename backward-compat seed: a PRE-rename persisted transcript-editor tab -------
//
// Proves the workflows-rename backward-compat requirement: the rename PRESERVED the editor-
// input-serializer typeId string ('workbench.input.clawdiusMissionTranscript', see
// claudeWorkflowTranscriptInput.ts) so a tab that was open and persisted BEFORE the rename still
// restores through the RENAMED ClaudeWorkflowTranscriptEditor/ClaudeWorkflowTranscriptInput classes
// on the next boot. VS Code only reads persisted editor state at startup (there is no live
// "inject state" API), so this seeds it directly into the workspace's state.vscdb BEFORE the app's
// first launch - modeled on the existing `preseedChatExtensionEnablement` pattern in
// test/smoke/src/utils.ts (same sqlite3-CLI, best-effort approach).
//
// The workspace-storage dir is named by an MD5 hash of the opened folder's fsPath + birthtime,
// computed exactly as `getSingleFolderWorkspaceIdentifier` does (src/vs/platform/workspaces/node/
// workspaces.ts). This is the single most fragile part of this seed: a Node.js birthtime-precision
// or fsPath drive-letter-casing mismatch lands the seed in a dir the app never opens, and that fails
// SILENTLY (the boot just shows no restored tab, not an error). VERIFY FIRST on a real run: if the
// 'workflows-transcript-restore-backcompat' scenario reports no restored tab, dump the actual
// <userDataDir>/User/workspaceStorage/*/ dirs the app created and compare against the id logged
// below before assuming the serializer itself regressed.

/** VS Code's URI.file() lowercases a Windows drive letter but preserves the rest of the path's
 *  original casing (src/vs/base/common/uri.ts, the driveLetter branch ~line 639); POSIX paths pass
 *  through unchanged. */
function toVscodeFsPath(absPath) {
	if (process.platform === 'win32' && /^[A-Za-z]:/.test(absPath)) {
		return absPath[0].toLowerCase() + absPath.slice(1);
	}
	return absPath;
}

/** Replicates `getSingleFolderWorkspaceIdentifier`'s id (src/vs/platform/workspaces/node/workspaces.ts):
 *  md5(fsPath + a platform-specific ctime salt). This harness always opens REPO as a single-folder
 *  workspace (the `.` positional CLI arg below), so this is the workspace-storage dir name the app
 *  will use. */
function singleFolderWorkspaceStorageId(folderPath) {
	const stat = statSync(folderPath);
	const fsPath = toVscodeFsPath(folderPath);
	let ctime;
	if (process.platform === 'linux') { ctime = stat.ino; }
	else if (process.platform === 'darwin') { ctime = stat.birthtime.getTime(); }
	else { ctime = typeof stat.birthtimeMs === 'number' ? Math.floor(stat.birthtimeMs) : stat.birthtime.getTime(); }
	return createHash('md5').update(fsPath).update(ctime ? String(ctime) : '').digest('hex');
}

// The exact PRE-rename typeId string (preserved unchanged by the rename) + a synthetic FleetSubagent
// payload in its pre-rename shape (FleetSubagent itself is untouched by the rename - only the input/
// editor CLASS names and the view/container ids changed). The transcriptRef need not resolve to a
// real on-disk file for this proof: what is under test is that the pane OPENS (the serializer round
// trip fired through the preserved typeId), not the richness of what it then renders - an
// unresolvable ref still renders the editor's own honest "absent" state, which is a successful open.
const OLD_TRANSCRIPT_TYPE_ID = 'workbench.input.clawdiusMissionTranscript';
const SEEDED_SUBAGENT = {
	subagentId: 'e2e-precompat-subagent', parentRunId: 'e2e-precompat-run',
	transcriptRef: 'e2e-precompat-run/agent-e2e-precompat-subagent.jsonl',
	coverage: 'in-scope', freshness: 'polled', completeness: 'complete',
};

/** Seed <userDataDir>/User/workspaceStorage/<id>/state.vscdb with an editor-part memento carrying ONE
 *  group with ONE editor serialized under the OLD (preserved) typeId - modeled on
 *  `preseedChatExtensionEnablement` in test/smoke/src/utils.ts. Shapes match `IEditorPartUIState` /
 *  `ISerializedGrid` / `ISerializedEditorGroupModel` (editorPart.ts, grid.ts, editorGroupModel.ts).
 *  Best-effort: a missing `sqlite3` CLI just leaves the seed unset, and the backcompat scenario
 *  reports that plainly (a WARN, not a false pass) rather than the whole harness failing to launch. */
function seedPreRenameTranscriptEditorState(userDataDir, repoPath) {
	try {
		const workspaceId = singleFolderWorkspaceStorageId(repoPath);
		const storageDir = join(userDataDir, 'User', 'workspaceStorage', workspaceId);
		mkdirSync(storageDir, { recursive: true });
		const dbPath = join(storageDir, 'state.vscdb');
		const editorGroup = {
			id: 1,
			editors: [{ id: OLD_TRANSCRIPT_TYPE_ID, value: JSON.stringify(SEEDED_SUBAGENT) }],
			mru: [0],
		};
		const editorPartState = {
			'editorpart.state': {
				serializedGrid: {
					root: { type: 'leaf', data: editorGroup, size: 800 },
					orientation: 0, // Orientation.VERTICAL - src/vs/base/browser/ui/sash/sash.ts
					width: 800, height: 600,
				},
				activeGroup: 1,
				mostRecentActiveGroups: [1],
			},
		};
		const key = 'memento/workbench.parts.editor';
		const value = JSON.stringify(editorPartState).replace(/'/g, "''"); // SQL-escape single quotes
		const sql = [
			'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);',
			`INSERT INTO ItemTable (key, value) VALUES ('${key}', '${value}');`,
		].join(' ');
		execFileSync('sqlite3', [dbPath, sql]);
		return { seeded: true, workspaceId };
	} catch (err) {
		return { seeded: false, workspaceId: undefined, error: (err && err.message) || String(err) };
	}
}

// --- live/graduation donor + sandbox driving (real-build live-watch + in-place-graduation proof) ------------
//
// The Workflows sidebar's live-watch/graduation behavior can only be proven against a run whose journal exists
// on disk with no sibling manifest yet (live), followed by that manifest landing (graduation). Rather than
// hand-authoring a synthetic journal/manifest pair - which would prove the harness's own fixture shape, not a
// real one - this clones a REAL run's bytes (journal + agent sidecars + the manifest, kept in memory) out of the
// REAL `~/.claude/projects` corpus into an ISOLATED temp sandbox, then points a SECOND Electron instance's
// `USERPROFILE`/`HOME` at that sandbox so `IPathService.userHome()` (and therefore the reader's resolved config
// root) sees ONLY the sandbox tree - never the real user corpus, and the real corpus is never written to.

/** A journal record recognized the same way `toJournalRecord` (claudeReaderSeamService.ts) recognizes one: a
 *  string `type`, an `agentId` that is either absent or a string, and - for `started`/`result` records
 *  specifically - a non-empty `agentId` (the record's whole point). Anything else is not a record this function
 *  counts, mirroring the reader's own drop rules exactly rather than approximating them. */
function parseJournalRecords(text) {
	const records = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) { continue; }
		let parsed;
		try { parsed = JSON.parse(line); } catch { continue; }
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { continue; }
		const type = typeof parsed.type === 'string' ? parsed.type : undefined;
		if (type === undefined) { continue; }
		const agentId = parsed.agentId;
		if (agentId !== undefined && typeof agentId !== 'string') { continue; }
		if ((type === 'started' || type === 'result') && !agentId) { continue; }
		records.push({ type, agentId, result: type === 'result' ? parsed.result : undefined });
	}
	return records;
}

/** Bound `text` to at most `max` characters, matching `boundedPreview` in claudeReaderSeamService.ts exactly -
 *  the RESULT_PREVIEW_MAX_CHARS the live-progress leaf's landed-result previews are bounded to. */
function boundedPreview(text, max) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Mirrors `LIVE_PROGRESS_MAX_LANDED_PREVIEWS` (claudeWorkflowTree.ts): the render bound on how many
 *  landed-result previews the live-progress leaf shows directly, independent of how many actually landed. */
const LIVE_PROGRESS_MAX_LANDED_PREVIEWS = 5;

/** The exact `{startedCount, resultCount, seenCount, landedResults}` shape `workflowFromJournal` computes off a
 *  journal's raw text (claudeReaderSeamService.ts) - reproduced here so this harness asserts the live-progress leaf
 *  against the SAME algorithm the app itself runs, not a re-approximation that could quietly drift from it.
 *  `seenCount` is the UNION of the started/result agent-id sets (never just `startedCount`) - the honest "agents
 *  seen so far" denominator the ratio caption and the ProgressBar's total are both built from, so a result whose
 *  own `started` record was torn or otherwise dropped still counts as "seen" instead of inverting the ratio. */
function computeLiveProgress(journalText) {
	const isAgentId = v => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
	const records = parseJournalRecords(journalText);
	const startedIds = new Set(records.filter(r => r.type === 'started' && isAgentId(r.agentId)).map(r => r.agentId));
	const resultRecords = records.filter(r => r.type === 'result' && isAgentId(r.agentId));
	const resultIds = new Set(resultRecords.map(r => r.agentId));
	const seenIds = new Set([...startedIds, ...resultIds]);
	const landedByAgent = new Map();
	for (const r of resultRecords) { landedByAgent.set(r.agentId, r.result); }
	const landedResults = [...landedByAgent].map(([agentId, result]) => ({
		agentId,
		preview: typeof result === 'string' ? boundedPreview(result, 280) : 'Result landed',
	})).sort((a, b) => a.agentId.localeCompare(b.agentId));
	return { startedCount: startedIds.size, resultCount: resultIds.size, seenCount: seenIds.size, landedResults };
}

/** Scan the REAL `~/.claude/projects` corpus (read-only; NEVER written to) for a DONOR: a session whose
 *  `workflows/<runId>.json` manifest has a sibling `subagents/workflows/<runId>/journal.jsonl` - the on-disk
 *  pair `enumerateWorkflows` (claudeReaderSeamService.ts) keys a workflow run on. Mirrors that function's own
 *  directory walk (`projects/<enc>/<session>/`, skipping a `memory` session dir) and the manifest/journal
 *  filename shape (`RUN_ID_RE` = `^wf_[a-z0-9-]{6,}$`) exactly, so a candidate this finds is one the real reader
 *  would also recognize. Prefers a donor whose journal carries >=1 `started` and >=1 `result` record (so the
 *  live progress this scenario asserts against shows a genuine ratio and >=1 landed-result preview, never a
 *  fabricated one), tie-broken by the smallest combined manifest+journal size so the clone + graduation-write
 *  stays fast. Returns `undefined` when the corpus has no manifest/journal pair at all - the scenario's own SKIP
 *  condition, never a false pass. */
function findWorkflowDonor() {
	const projectsRoot = join(homedir(), '.claude', 'projects');
	const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
	let projectDirs;
	try { projectDirs = readdirSync(projectsRoot).filter(d => isDir(join(projectsRoot, d))); } catch { return undefined; }

	const candidates = [];
	for (const enc of projectDirs) {
		const projectDir = join(projectsRoot, enc);
		let sessionDirs;
		try { sessionDirs = readdirSync(projectDir).filter(d => d !== 'memory' && isDir(join(projectDir, d))); } catch { continue; }
		for (const session of sessionDirs) {
			const sessionDir = join(projectDir, session);
			const workflowsDir = join(sessionDir, 'workflows');
			let manifestNames;
			try { manifestNames = readdirSync(workflowsDir).filter(f => f.endsWith('.json') && statSync(join(workflowsDir, f)).isFile()); } catch { continue; }
			for (const manifestName of manifestNames) {
				const runId = manifestName.slice(0, -'.json'.length);
				if (!/^wf_[a-z0-9-]{6,}$/.test(runId)) { continue; }
				const journalDir = join(sessionDir, 'subagents', 'workflows', runId);
				const journalFile = join(journalDir, 'journal.jsonl');
				if (!existsSync(journalFile)) { continue; }
				let journalText;
				try { journalText = readFileSync(journalFile, 'utf8'); } catch { continue; }
				const liveProgress = computeLiveProgress(journalText);
				let sidecarNames = [];
				try { sidecarNames = readdirSync(journalDir).filter(f => /^agent-[A-Za-z0-9_-]+\.(jsonl|meta\.json)$/.test(f)); } catch { /* none */ }
				const manifestFile = join(workflowsDir, manifestName);
				let manifestSize = 0, journalSize = 0;
				try { manifestSize = statSync(manifestFile).size; } catch { /* best-effort size, only used to rank candidates */ }
				try { journalSize = statSync(journalFile).size; } catch { /* best-effort size, only used to rank candidates */ }
				candidates.push({ enc, session, runId, journalDir, journalFile, sidecarNames, manifestFile, liveProgress, manifestSize, journalSize });
			}
		}
	}

	const qualifying = candidates.filter(c => c.liveProgress.startedCount >= 1 && c.liveProgress.resultCount >= 1);
	const pool = qualifying.length > 0 ? qualifying : candidates;
	if (pool.length === 0) { return undefined; }
	pool.sort((a, b) => (a.manifestSize + a.journalSize) - (b.manifestSize + b.journalSize));
	const chosen = pool[0];
	return { ...chosen, manifestBytes: readFileSync(chosen.manifestFile) };
}

/** Scan the REAL `~/.claude/projects` corpus (read-only; NEVER written to) for a DONOR: a session whose
 *  `workflows/<runId>.json` manifest parses as JSON with `status: "failed"` - a real terminal failed run to clone
 *  the awareness-badge scenario's fixture from. Mirrors {@link findWorkflowDonor}'s own directory walk and
 *  filename shape, but only needs the manifest (no journal/sidecars - a terminal manifest alone is a complete,
 *  valid run). Returns `undefined` when the corpus has no failed run at all - the scenario's own SKIP condition,
 *  never a false pass. */
function findFailedWorkflowDonor() {
	const projectsRoot = join(homedir(), '.claude', 'projects');
	const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
	let projectDirs;
	try { projectDirs = readdirSync(projectsRoot).filter(d => isDir(join(projectsRoot, d))); } catch { return undefined; }

	for (const enc of projectDirs) {
		const projectDir = join(projectsRoot, enc);
		let sessionDirs;
		try { sessionDirs = readdirSync(projectDir).filter(d => d !== 'memory' && isDir(join(projectDir, d))); } catch { continue; }
		for (const session of sessionDirs) {
			const workflowsDir = join(projectDir, session, 'workflows');
			let manifestNames;
			try { manifestNames = readdirSync(workflowsDir).filter(f => f.endsWith('.json') && statSync(join(workflowsDir, f)).isFile()); } catch { continue; }
			for (const manifestName of manifestNames) {
				const runId = manifestName.slice(0, -'.json'.length);
				if (!/^wf_[a-z0-9-]{6,}$/.test(runId)) { continue; }
				const manifestFile = join(workflowsDir, manifestName);
				let parsed;
				try { parsed = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { continue; }
				if (!parsed || parsed.status !== 'failed') { continue; }
				return { enc, session, runId, manifestFile, manifestBytes: readFileSync(manifestFile) };
			}
		}
	}
	return undefined;
}

/** Expand a live run's row (click, ArrowRight, twistie fallback - the same sequence {@link expandRunAndGatherAgents}
 *  uses for a terminal run's story leaf) and return its `.clawdius-workflow-live-progress` leaf handle, or
 *  undefined if expansion never revealed one. */
async function expandLiveRunProgress(target) {
	await target.scrollIntoViewIfNeeded();
	await target.click();
	await win.waitForTimeout(150);
	await win.keyboard.press('ArrowRight');
	await win.waitForTimeout(400);
	let progressHandles = await win.$$('.clawdius-workflow-live-progress');
	if (progressHandles.length === 0) {
		const twistie = await target.$('.monaco-tl-twistie');
		if (twistie) {
			await twistie.click();
			await win.waitForTimeout(400);
			progressHandles = await win.$$('.clawdius-workflow-live-progress');
		}
	}
	return progressHandles[0];
}

// --- launch ----------------------------------------------------------------------------------

const prof = mkdtempSync(join(tmpdir(), 'clawdius-e2e-prof-'));
const exts = mkdtempSync(join(tmpdir(), 'clawdius-e2e-exts-'));
const seed = seedPreRenameTranscriptEditorState(prof, REPO);
console.log('repo:', REPO, '\nout :', OUT, '\nprofile:', prof, '\n');
if (seed.seeded) {
	console.log(`seeded pre-rename transcript editor state under workspaceStorage/${seed.workspaceId}\n`);
} else {
	console.log(`WARN: could not seed pre-rename editor state (${seed.error}) - the backcompat scenario will report absent, not a false pass\n`);
}

const app = await electron.launch({
	executablePath: join(REPO, '.build', 'electron', 'Clawdius.exe'),
	cwd: REPO,
	args: ['.', '--disable-extension=vscode.vscode-api-tests',
		`--user-data-dir=${prof}`, `--extensions-dir=${exts}`,
		'--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
	env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development' },
	timeout: 120000,
});
win = await app.firstWindow();

try {
	// 1. Boot
	await scenario('boot-workbench', true, async () => {
		await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
		await win.waitForTimeout(6000);
		const title = await win.title();
		assert(/clawdius/i.test(title), `title not Clawdius: ${title}`);
		const body = await win.$eval('.monaco-workbench', el => el.innerText || '');
		assert(!/copilot/i.test(body), 'copilot text present in workbench');
		return `title="${title}", no copilot text`;
	});

	// 1b. Workflows-rename backward compat: a transcript editor tab persisted BEFORE
	// this rename (serialized under the OLD, preserved typeId 'workbench.input.clawdiusMissionTranscript',
	// seeded into workspace storage before this launch - see seedPreRenameTranscriptEditorState above)
	// restores through the RENAMED ClaudeWorkflowTranscriptEditor/ClaudeWorkflowTranscriptInput classes on
	// this boot. This exercises VS Code's own restore path (EditorGroupModel.deserialize ->
	// registry.getEditorSerializer(id)) for real, against a real (isolated) profile - not just a source
	// read that the string looks unchanged. Non-critical: it depends on the `sqlite3` CLI being on PATH
	// and on the workspace-storage-id replication above being exact (see the seed's own risk note); a
	// missing/failed seed reports a clear WARN rather than silently passing or failing the whole gate.
	await scenario('workflows-transcript-restore-backcompat', false, async () => {
		if (!seed.seeded) {
			return `SKIPPED (seed unavailable: ${seed.error}) - install the sqlite3 CLI locally to exercise this scenario`;
		}
		// The restored tab is pinned + inactive per EditorPart.doApplyState (applyState/doApplyState),
		// but still present as a real editor; its pane is the same '.clawdius-transcript' container the
		// live drill-in path renders into (claudeWorkflowTranscriptEditor.ts createEditor()).
		const panes = await win.$$('.clawdius-transcript');
		assert(panes.length > 0, 'no .clawdius-transcript editor pane restored from the pre-rename seed');
		// The restored tab's aria-label carries the seeded subagent id (ClaudeWorkflowTranscriptInput's
		// getName()), proving the deserialized input is the one THIS seed produced, not some unrelated
		// editor left over from a prior run of this harness.
		const tabs = await win.$$eval('.tabs-container .tab',
			els => els.map(el => (el.getAttribute('aria-label') || el.textContent || '').trim()));
		const restored = tabs.some(t => t.includes(SEEDED_SUBAGENT.subagentId));
		assert(restored, `no restored tab named for the seeded subagent (${SEEDED_SUBAGENT.subagentId}); tabs: ${tabs.join(' || ')}`);
		return `restored "${SEEDED_SUBAGENT.subagentId}" transcript editor from pre-rename (${OLD_TRANSCRIPT_TYPE_ID}) persisted state`;
	});

	// 2. Status-bar feature pills
	await scenario('statusbar-pills', true, async () => {
		const s = await statusText();
		const joined = s.join(' | ');
		assert(/usage/i.test(joined), 'no usage pill');
		assert(/budget/i.test(joined), 'no context-budget pill');
		assert(/permission mode/i.test(joined), 'no permission pill');
		assert(/effort/i.test(joined), 'no effort pill');
		return joined;
	});

	// 3. Command palette lists the Clawdius commands
	await scenario('palette-clawdius-commands', true, async () => {
		await win.keyboard.press('Control+Shift+P');
		await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
		await win.keyboard.type('Clawdius: ', { delay: 8 });
		await win.waitForTimeout(800);
		const rows = await win.$$eval('.quick-input-list .monaco-list-row',
			els => els.map(e => (e.textContent || '').trim()).filter(Boolean));
		await closeQuickInput();
		const text = rows.join(' || ');
		assert(/Control Center/i.test(text), 'Control Center command missing');
		assert(/Usage Dashboard/i.test(text), 'Usage Dashboard command missing');
		// No Clawdius command TITLE may still say "Mission(s)" after the workflows rename. The command
		// palette is the authoritative list of command titles; the sidebar DOM scan cannot see it, so this
		// is where command-title coverage lives. ("Permission" does not match \bmissions?\b - no word boundary.)
		assert(!/\bmissions?\b/i.test(text), `a Clawdius command title still says "Mission(s)": ${text}`);
		return `${rows.length} Clawdius commands listed, none titled "Mission"`;
	});

	// 4. Control Center editor + tabs
	await scenario('control-center', true, async () => {
		await runCommand('Open Claude Code Control Center');
		await win.waitForTimeout(1500);
		const body = await win.$eval('.monaco-workbench', el => el.innerText || '');
		for (const tab of ['Usage', 'Permissions', 'MCP', 'Skills', 'Plugins', 'Hooks']) {
			assert(new RegExp(tab, 'i').test(body), `Control Center tab missing: ${tab}`);
		}
		return 'Usage/Permissions/MCP/Skills/Plugins/Hooks tabs present';
	});

	// 4b. Claude Code Ultracode Workflows sidebar: the ultracode workflow control surface, driven against
	// the REAL config root. This is the one scenario no unit test can stand in for. The suite's fixtures
	// are synthetic by construction, and CI runners have no ~/.claude at all, so only a real boot proves
	// what a user sees: that rows are named workflow runs carrying a real status - not chat sessions all
	// reading "status: unknown / completeness: partial", which is what the pre-fix view painted for all
	// 1200 of them. This also proves no user-facing "Missions" text remains
	// anywhere on the surface, and the renamed container/view/icon actually paint.
	//
	// Retargeted for the tree rewrite: the view's hand-rolled manual-DOM rows were replaced by a real
	// `WorkbenchObjectTree` (claudeWorkflowTree.ts / claudeWorkflowsView.ts) - `.clawdius-workflows-row` and
	// `[data-clawdius-workflows-empty]` no longer exist. The tree paints `.clawdius-workflow-run-row` (note
	// singular "workflow") elements carrying `data-run-kind` (the RUN's kind: live/terminal/unknown-shape) and
	// `data-completeness`; the empty/read-error/no-match message lives in `.clawdius-workflows-state` with a
	// `data-clawdius-workflows-state` attribute on that SAME element (not a descendant).
	await scenario('ultracode-workflows-sidebar', true, async () => {
		// Open via the view's auto-registered focus command. `registerFocusViewAction` derives its title
		// from the view descriptor's name ("Focus on {0} View"), so this string is the one the palette
		// actually offers post-rename - an invented title would fuzzy-match some other command and
		// silently leave the view closed, which would then read as a view defect rather than a broken test.
		await runCommand('Focus on Claude Code Ultracode Workflows View');
		// Distinguish "the view never opened" (a test-harness fault) from "the view opened and painted
		// nothing" (a real defect). Without this the two collapse into one indistinguishable failure. The
		// tree container `.clawdius-workflows-tree` (the WorkbenchObjectTree scroller) is the reliable
		// "view painted" sentinel - it is always in the DOM once renderBody ran, whether the tree itself is
		// showing rows or is hidden behind the state-message overlay.
		await win.waitForSelector('.clawdius-workflows-tree', { state: 'attached', timeout: 15000 });
		// `refresh()` is async (IPathService.userHome() -> resolveConfigRoot -> seam.listWorkflows(root), a REAL
		// disk read+validate of the REAL config root - on a populated root that is ~1200+ runs, not a synthetic
		// fixture) and neither rows nor the state-message container exist until `applyDisplayState` runs. Poll
		// for that real completion signal instead of a fixed sleep - a fixed short sleep is exactly what raced
		// the read on a large real root and left the pane looking (falsely) empty.
		await win.waitForFunction(
			() => document.querySelector('.clawdius-workflow-run-row') !== null || document.querySelector('[data-clawdius-workflows-state]') !== null,
			undefined, { timeout: 60000 },
		);
		await win.waitForTimeout(500);

		// No FORK-AUTHORED "Mission(s)" text may remain after the rename. Scan the workbench for the whole
		// word "mission" but skip only the USER-DATA leaves the reader surfaces verbatim - the run row
		// (.clawdius-workflow-run-row, whose label is the run's own summary/workflowName/runId), the story
		// leaf's summary/result/error text, and expanded agent rows (.clawdius-workflow-agent-row) - since a
		// run a user named "build-mission-rail" (or one whose own description happens to discuss "missions")
		// is legitimate user content, not a rename regression. Everything else stays in scope, INCLUDING the
		// fork's own chrome (chips, state messages, the surface label, and the tree's own widget aria-label),
		// so a label that regressed to "Mission" is still caught. For the title/aria case the exclusion ALSO
		// covers the native `.monaco-list-row` wrapper: the tree paints a row's aria-label on that wrapper, one
		// level ABOVE the renderer's own `.clawdius-workflow-run-row`/story/agent element, so it inherits the
		// exact same user data - but ONLY that wrapper is skipped, not every container above it, so a
		// fork-chrome aria-label on the list, tree container, or pane is still scanned.
		const userDataSel = '.clawdius-workflow-run-row, .clawdius-workflow-story-summary, .clawdius-workflow-story-result, .clawdius-workflow-story-error, .clawdius-workflow-agent-row';
		const missionChromeHits = await win.$$eval('.monaco-workbench *', (els, userSel) => {
			const rx = /\bmissions?\b/i;
			const out = [];
			for (const el of els) {
				const label = (typeof el.className === 'string' && el.className) ? el.className : el.tagName;
				if (!el.closest(userSel)) {
					const t = el.childElementCount === 0 ? (el.textContent || '') : '';
					if (rx.test(t)) { out.push('text ' + label + ' :: ' + t.trim().slice(0, 80)); }
				}
				if (!el.closest(userSel) && !(el.matches('.monaco-list-row') && el.querySelector(userSel))) {
					for (const attr of ['title', 'aria-label']) {
						const v = el.getAttribute && el.getAttribute(attr);
						if (v && rx.test(v)) { out.push(attr + ' ' + label + ' :: ' + v.trim().slice(0, 80)); }
					}
				}
			}
			return Array.from(new Set(out));
		}, userDataSel);
		assert(missionChromeHits.length === 0, 'fork-authored "Mission(s)" text still present after the rename: ' + JSON.stringify(missionChromeHits));

		// The renamed container/view icon (clawdiusWorkflowsIcon, id clawdius-claude-code-workflows,
		// registered in clawdiusCustomIcons.ts, wired onto the view container + view in
		// clawdius.contribution.ts) is not just registered - it is PRESENT in the DOM.
		const workflowsIcons = await win.$$('.codicon-clawdius-claude-code-workflows');
		assert(workflowsIcons.length > 0, 'renamed workflows icon did not paint');

		const rows = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => ({
			runId: el.getAttribute('data-run-id'),
			runKind: el.getAttribute('data-run-kind'),
			completeness: el.getAttribute('data-completeness'),
		})));
		if (rows.length === 0) {
			// An honest empty state is a legitimate outcome (no workflows on the config root), not a pass. The
			// state attribute is set directly ON `.clawdius-workflows-state` (not a descendant of it).
			const empty = await win.$$('.clawdius-workflows-state[data-clawdius-workflows-state="empty"]');
			assert(empty.length === 1, 'Workflows rendered neither run rows nor a distinct empty state');
			return 'no workflow runs on this config root (honest empty state); no Missions text; icon painted';
		}
		// Every row's RUN kind must be one of the model's three discriminated shapes - never empty/null.
		const runKindCounts = {};
		for (const r of rows) { runKindCounts[r.runKind] = (runKindCounts[r.runKind] || 0) + 1; }
		const runKinds = Object.keys(runKindCounts);
		const badRunKinds = runKinds.filter(k => k !== 'live' && k !== 'terminal' && k !== 'unknown-shape');
		assert(badRunKinds.length === 0, `rows with an unrecognized/empty data-run-kind: ${JSON.stringify(badRunKinds)}`);
		// Every row must be NAMED: the pre-fix view showed opaque run ids.
		const unnamed = rows.filter(r => !r.runId);
		assert(unnamed.length === 0, `${unnamed.length} workflow runs rendered without a run id`);
		// The completeness ladder must not be pinned to `partial` for every row - the pre-fix bug.
		const completenessCounts = {};
		for (const r of rows) { completenessCounts[r.completeness] = (completenessCounts[r.completeness] || 0) + 1; }
		const completeness = Object.keys(completenessCounts);
		assert(!(completeness.length === 1 && completeness[0] === 'partial'),
			`every workflow run reads completeness=partial (the ladder collapsed): ${rows.length} rows, run-kinds=${JSON.stringify(runKindCounts)}, completeness=${JSON.stringify(completenessCounts)}`);
		return `${rows.length} workflow runs; run-kinds=${JSON.stringify(runKindCounts)}; completeness=${JSON.stringify(completenessCounts)}; e.g. "${rows[0].runId}"; no Missions text; icon painted`;
	});

	// 4c. Native tree expansion: a TERMINAL run expands (WorkbenchObjectTree's own collapse/expand, not a
	// bespoke click handler) to its story leaf (summary + cost, always present per `buildTerminalRunChildren`)
	// and, only when the run legitimately declares them, its phase/agent rows. This is drill-in-adjacent but
	// NOT drill-in: no editor opens here (see claudeWorkflowsView.ts's task banner - drill-in is a later change).
	await scenario('ultracode-workflows-expand', true, async () => {
		await runCommand('Focus on Claude Code Ultracode Workflows View');
		await win.waitForSelector('.clawdius-workflows-tree', { state: 'attached', timeout: 15000 });
		await win.waitForFunction(
			() => document.querySelector('.clawdius-workflow-run-row') !== null || document.querySelector('[data-clawdius-workflows-state]') !== null,
			undefined, { timeout: 60000 },
		);
		await win.waitForTimeout(300);

		const rowHandles = await win.$$('.clawdius-workflow-run-row');
		let target;
		for (const handle of rowHandles) {
			if ((await handle.getAttribute('data-run-kind')) === 'terminal') { target = handle; break; }
		}
		if (!target) {
			return 'SKIPPED (no terminal runs on this config root)';
		}
		const runId = await target.getAttribute('data-run-id');

		await target.scrollIntoViewIfNeeded();
		await target.click();
		await win.waitForTimeout(200);
		await win.keyboard.press('ArrowRight');
		await win.waitForTimeout(600);

		let storyHandles = await win.$$('.clawdius-workflow-story');
		if (storyHandles.length === 0) {
			// Fall back to the twistie directly, in case the click above didn't land keyboard focus on the row.
			const twistie = await target.$('.monaco-tl-twistie');
			if (twistie) {
				await twistie.click();
				await win.waitForTimeout(600);
				storyHandles = await win.$$('.clawdius-workflow-story');
			}
		}
		assert(storyHandles.length > 0, `expanding terminal run "${runId}" did not reveal a .clawdius-workflow-story leaf`);

		const story = storyHandles[0];
		const summary = await story.$('.clawdius-workflow-story-summary');
		const cost = await story.$('.clawdius-workflow-story-cost');
		assert(summary, 'story leaf missing .clawdius-workflow-story-summary');
		assert(cost, 'story leaf missing .clawdius-workflow-story-cost');

		// Guarded on actual presence, never a forced minimum: a run with <=1 declared phase legitimately
		// renders NO `.clawdius-workflow-phase-row` (the 0/1/>1 phase-grouping rule, buildTerminalRunChildren).
		// When rows ARE present, verify what's there is well-formed rather than asserting a blind existence
		// this scenario has no independent way to expect.
		const agentRows = await win.$$('.clawdius-workflow-agent-row');
		if (agentRows.length > 0) {
			const states = await Promise.all(agentRows.map(r => r.getAttribute('data-agent-state')));
			assert(states.every(s => s === 'done' || s === 'error'), `agent row(s) with an unrecognized data-agent-state: ${JSON.stringify(states)}`);
		}
		const phaseRows = await win.$$('.clawdius-workflow-phase-row');
		if (phaseRows.length > 0) {
			const titles = await Promise.all(phaseRows.map(r => r.$eval('.clawdius-workflow-phase-title', el => (el.textContent || '').trim())));
			assert(titles.every(t => t.length > 0), `phase row(s) with an empty title: ${JSON.stringify(titles)}`);
		}

		return `expanded terminal run "${runId}": story leaf present (summary+cost ok); ${agentRows.length} agent rows; ${phaseRows.length} phase rows`;
	});

	// 4d. Drill-in: open a completed run's FULL result, an agent's DETAIL, and (when the identity join gave it a
	// transcriptRef) that agent's raw TRANSCRIPT - all from the workflows tree, as real EDITOR TABS
	// (IEditorService.openEditor, per claudeWorkflowsView.ts's `openResultDetail`/`openAgentDetail`), not sidebar
	// DOM. This is the one thing `ultracode-workflows-expand` above does NOT cover: that scenario only proves
	// native tree EXPANSION; nothing there opens an editor. `onDidOpen` fires on click OR Enter for a
	// `story`/`agent` leaf - `activateAndWaitForDetail` tries click first, falling back to Enter.
	await scenario('ultracode-workflows-drill-in', true, async () => {
		await focusWorkflowsView();

		const rowHandles = await win.$$('.clawdius-workflow-run-row');
		const terminalHandles = [];
		for (const h of rowHandles) {
			if ((await h.getAttribute('data-run-kind')) === 'terminal') { terminalHandles.push(h); }
		}
		if (terminalHandles.length === 0) {
			return 'SKIPPED (no terminal runs on this config root)';
		}

		// --- 1. Full result, off the first terminal run (the same pick `ultracode-workflows-expand` makes). ---
		const firstTarget = terminalHandles[0];
		const firstRunId = await firstTarget.getAttribute('data-run-id');
		let expanded = await expandRunAndGatherAgents(firstTarget);
		assert(expanded.story, `expanding terminal run "${firstRunId}" did not reveal a .clawdius-workflow-story leaf`);

		const resultPane = await activateAndWaitForDetail(expanded.story, 'result');
		assert(resultPane, `activating the story leaf for run "${firstRunId}" (click, then select+Enter) never attached a .clawdius-workflow-detail[data-clawdius-detail-kind="result"] pane`);
		const resultTextHandle = await resultPane.$('.clawdius-workflow-detail-result');
		assert(resultTextHandle, 'result detail pane missing .clawdius-workflow-detail-result node');
		const resultText = ((await resultTextHandle.innerText()) || '').trim();
		const resultMarker = await resultTextHandle.getAttribute('data-clawdius-detail-result');
		const isNoResult = resultText === 'No result recorded';
		assert(isNoResult ? resultMarker === 'absent' : resultMarker === 'present',
			`result text/marker mismatch for run "${firstRunId}": text="${resultText.slice(0, 60)}" marker="${resultMarker}"`);
		await closeActiveEditorTab();

		// --- 2 + 3. Agent detail + (when available) its transcript. Re-expand the same run (the tab close above
		// didn't touch tree expansion state, but DOM nodes may have recycled) and, if IT declares no agents, widen
		// the scan to further terminal runs - bounded, so one unlucky pick can't turn an honest structural gap into
		// a false SKIP of the whole sub-step. ---
		// Agent detail + (when available) its transcript, off the SAME expanded run (a `WorkbenchObjectTree` only
		// renders visible rows, so gathering agent handles from one already-expanded run and probing them without
		// re-scrolling keeps the handles attached). Probe up to 8 agent rows for the FIRST whose identity join gave it
		// a transcriptRef; keep the FIRST agent-detail opened as the fallback report even if none carries a transcript.
		expanded = await expandRunAndGatherAgents(firstTarget);
		const scanTargets = expanded.agentRows;
		if (scanTargets.length === 0) {
			return `result: run "${firstRunId}" -> ${isNoResult ? '"No result recorded"' : `real result text (${resultText.length} chars)`}; `
				+ `SKIPPED (agent+transcript: run "${firstRunId}" exposed no .clawdius-workflow-agent-row)`;
		}
		let firstProbe;
		let chosenProbe;
		for (const agentRow of scanTargets.slice(0, 8)) {
			const agentId = await agentRow.getAttribute('data-agent-id');
			const pane = await activateAndWaitForDetail(agentRow, 'agent');
			if (!pane) { continue; }
			const probe = await probeAgentPane(pane, agentId);
			if (!firstProbe) { firstProbe = probe; }
			if (probe.transcriptPresent) { chosenProbe = probe; break; }
			await closeActiveEditorTab();
		}
		assert(firstProbe, `no .clawdius-workflow-agent-row opened an agent detail pane (probed ${Math.min(scanTargets.length, 8)} of run "${firstRunId}")`);
		assert(firstProbe.total > 0, `agent detail pane for "${firstProbe.agentId}" rendered zero [data-clawdius-detail-field] rows`);
		const scannedRunIds = [firstRunId];

		const reportProbe = chosenProbe || firstProbe;
		let transcriptDetail;
		if (!reportProbe.transcriptPresent) {
			transcriptDetail = `SKIPPED (no transcript affordance found across ${scannedRunIds.length} scanned run(s) - the identity join withheld it on every probed agent)`;
			await closeActiveEditorTab();
		} else {
			const button = await reportProbe.pane.$('.clawdius-workflow-detail-actions .monaco-button');
			assert(button, `agent "${reportProbe.agentId}" carries data-clawdius-detail-transcript="present" but no .monaco-button in .clawdius-workflow-detail-actions`);
			await button.click();
			const transcriptPane = await win.waitForSelector('.clawdius-transcript', { state: 'attached', timeout: 8000 }).catch(() => null);
			assert(transcriptPane, `clicking "Open Transcript" for agent "${reportProbe.agentId}" never attached a .clawdius-transcript pane`);
			// The pane container attaches synchronously in createEditor; setInput reads the transcript ASYNC and only
			// then renders the record rows (or the honest empty state). Wait for that render to settle before counting.
			await win.waitForFunction(() => {
				const p = document.querySelector('.clawdius-transcript');
				return !!p && (p.querySelector('.clawdius-transcript-record') !== null || p.querySelector('.clawdius-transcript-empty') !== null);
			}, undefined, { timeout: 10000 }).catch(() => { });
			const recordHandles = await transcriptPane.$$('.clawdius-transcript-record');
			const emptyMarker = await transcriptPane.$('.clawdius-transcript-empty');
			transcriptDetail = recordHandles.length > 0
				? `transcript pane opened with ${recordHandles.length} .clawdius-transcript-record row(s)`
				: emptyMarker
					? 'transcript pane opened (honest empty state)'
					: 'transcript pane opened (no records, no empty marker)';
			await closeActiveEditorTab();
		}

		return `result: run "${firstRunId}" -> ${isNoResult ? '"No result recorded"' : `real result text (${resultText.length} chars)`}; `
			+ `agent: "${reportProbe.agentId}" state="${reportProbe.state}" fields ${reportProbe.present} present / ${reportProbe.absent} absent (of ${reportProbe.total}); `
			+ `transcript: ${transcriptDetail}`;
	});

	// 4e. Failure surfacing: a FAILED/errored terminal run's errored-agent COUNT chip, the ERRORED-FIRST agent
	// ordering (`erroredAgentsFirst`, claudeWorkflowTree.ts), the auto-expand of the first error-bearing phase
	// (`collapsed: false` singled out in `buildTerminalRunChildren`), and the errored agent's own detail pane
	// carrying the AUTHORITATIVE error text (`renderAgentDetail`, claudeWorkflowDetailEditor.ts) - proving the
	// whole failure-surfacing contract end to end against the real config root (per the corpus scan, 14 terminal
	// runs here carry >=1 errored agent and 3 are `status: failed`, so a hit is expected, not merely hoped for).
	await scenario('ultracode-workflows-failure', true, async () => {
		await focusWorkflowsView();

		const found = await findErroredChipRun();
		if (!found.target) {
			return `SKIPPED (scanned ${found.scanned} visible run row(s), none carried a positive errored-chip)`;
		}
		assert(/^\d+ errored$/.test(found.chipText), `errored-chip text did not match the expected "{N} errored" shape: "${found.chipText}"`);
		assert(found.runKind === 'terminal', `run "${found.runId}" carries an errored-chip but data-run-kind="${found.runKind}" (expected "terminal")`);
		const target = found.target;
		const runId = found.runId;

		// Expand the RUN only (click + ArrowRight, no phase clicks yet) so any agent rows that show up next are
		// there SOLELY because of the tree's own auto-expand - never because this harness clicked a phase row.
		// Scroll the run to the TOP of the (virtualized) tree first: the WorkbenchObjectTree only renders visible
		// rows, so a run found lower in the list would expand its children BELOW the viewport fold and they would
		// virtualize out of the DOM - putting the run at the top gives its children room to render in view.
		await target.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
		await win.waitForTimeout(300);
		await target.click();
		await win.waitForTimeout(150);
		await win.keyboard.press('ArrowRight');
		await win.waitForTimeout(400);
		let storyHandles = await win.$$('.clawdius-workflow-story');
		if (storyHandles.length === 0) {
			const twistie = await target.$('.monaco-tl-twistie');
			if (twistie) {
				await twistie.click();
				await win.waitForTimeout(400);
				storyHandles = await win.$$('.clawdius-workflow-story');
			}
		}
		assert(storyHandles.length > 0, `expanding run "${runId}" did not reveal a .clawdius-workflow-story leaf`);

		// The tree is a VIRTUALIZED WorkbenchObjectTree: a run found lower in the list renders its expanded children
		// BELOW the viewport fold, so they virtualize OUT of the DOM (a DOM-level scrollIntoView does not move the
		// tree's own transform-based scroll). Walk the children with the KEYBOARD - the tree auto-scrolls to keep the
		// focused row visible, rendering each row as focus lands. ArrowDown from the (focused) run walks story ->
		// agents; a COLLAPSED phase's children are skipped, so any errored agent the walk surfaces proves the error
		// phase auto-expanded (or is a direct child of a <=1-phase run) - never a manual expand. Collect agent rows in
		// first-seen DOM order (dedup by id) since only a window is in the DOM at any moment.
		const orderedAgents: { id: string; state: string }[] = [];
		const seenAgentIds = new Set<string>();
		let stepsSinceNew = 0;
		for (let step = 0; step < 80 && stepsSinceNew < 6; step++) {
			let foundNew = false;
			for (const r of await win.$$('.clawdius-workflow-agent-row')) {
				const id = await r.getAttribute('data-agent-id');
				if (id && !seenAgentIds.has(id)) {
					seenAgentIds.add(id);
					orderedAgents.push({ id, state: (await r.getAttribute('data-agent-state')) || '?' });
					foundNew = true;
				}
			}
			stepsSinceNew = foundNew ? 0 : stepsSinceNew + 1;
			await win.keyboard.press('ArrowDown');
			await win.waitForTimeout(70);
		}
		assert(orderedAgents.length > 0, `run "${runId}" carries a positive errored-chip ("${found.chipText}") but a keyboard walk of its expanded children surfaced ZERO .clawdius-workflow-agent-row`);
		const states = orderedAgents.map(a => a.state);
		const badStates = states.filter(s => s !== 'error' && s !== 'done');
		assert(badStates.length === 0, `agent row(s) with an unrecognized data-agent-state: ${JSON.stringify(badStates)}`);
		const errorIdxs = states.map((s, k) => (s === 'error' ? k : -1)).filter(k => k >= 0);
		const doneIdxs = states.map((s, k) => (s === 'done' ? k : -1)).filter(k => k >= 0);
		assert(errorIdxs.length > 0, `run "${runId}" carries a positive errored-chip ("${found.chipText}") but the walk found no data-agent-state="error" row`);
		const orderingOk = doneIdxs.length === 0 || Math.max(...errorIdxs) < Math.min(...doneIdxs);
		assert(orderingOk, `errored-first ordering violated for run "${runId}": data-agent-state sequence = ${JSON.stringify(states)}`);
		const autoExpandDetail = `errored agent surfaced with NO manual phase expand (${states.length} agent row(s) walked)`;

		// Open the FIRST errored agent's detail. Walk back UP (errored agents render first) until its row is in the DOM
		// again, then activate it while visible. Its pane must read state="error" and carry the AUTHORITATIVE error text.
		const agentId = orderedAgents.find(a => a.state === 'error')!.id;
		let firstErrorRow = await win.$(`.clawdius-workflow-agent-row[data-agent-id="${agentId}"]`);
		for (let up = 0; up < 90 && !firstErrorRow; up++) {
			await win.keyboard.press('ArrowUp');
			await win.waitForTimeout(60);
			firstErrorRow = await win.$(`.clawdius-workflow-agent-row[data-agent-id="${agentId}"]`);
		}
		assert(firstErrorRow, `could not bring the first errored agent row "${agentId}" back into view to open its detail`);

		const pane = await activateAndWaitForDetail(firstErrorRow, 'agent');
		assert(pane, `activating errored agent row "${agentId}" (click, then select+Enter) never attached an agent detail pane`);
		const probe = await probeAgentPane(pane, agentId);
		assert(probe.state === 'error', `errored agent "${agentId}" detail pane read data-clawdius-detail-state="${probe.state}" (expected "error")`);
		const errorField = await pane.$('[data-clawdius-detail-field="error"] .clawdius-workflow-detail-field-value');
		assert(errorField, `agent "${agentId}" detail pane missing [data-clawdius-detail-field="error"] .clawdius-workflow-detail-field-value`);
		const errorFieldPresent = await pane.$eval('[data-clawdius-detail-field="error"]', el => el.getAttribute('data-clawdius-detail-field-present'));
		const errorText = ((await errorField.textContent()) || '').trim();
		assert(errorFieldPresent === 'true' && errorText.length > 0 && errorText !== '—',
			`errored agent "${agentId}" error field did not carry the authoritative error text: present="${errorFieldPresent}" text="${errorText.slice(0, 80)}"`);
		await closeActiveEditorTab();

		return `errored-chip "${found.chipText}" on run "${runId}"; agent-state sequence (${states.length}): ${JSON.stringify(states)} (errored-first ok); `
			+ `auto-expand: ${autoExpandDetail}; errored agent "${agentId}" detail state="${probe.state}", error field ${errorText.length} chars`;
	});

	// 4f. Failure surfacing under theme: re-opens the SAME kind of errored-agent detail pane under Clawdius Dark /
	// Clawdius Light / Clawdius High Contrast and asserts the authoritative error field still renders under each -
	// screenshot-for-review, non-critical (a render hiccup under one theme should not fail the gate), but the
	// field's presence is still genuinely asserted per theme, never silently skipped.
	await scenario('ultracode-workflows-failure-themes', false, async () => {
		const THEMES = ['Clawdius Dark', 'Clawdius Light', 'Clawdius High Contrast'];
		const slug = (s2: string) => s2.toLowerCase().replace(/[^a-z0-9]+/g, '-');
		const rendered: Record<string, string> = {};
		// Open the errored agent's detail ONCE, then verify the SAME open pane under each theme (a theme change does
		// NOT close an editor). Re-finding/clicking a virtualized row AFTER a theme switch is what flakes, so we open
		// the pane first and only switch themes + re-read the (still-open) pane afterwards - no post-switch tree click.
		await focusWorkflowsView();
		const found = await findErroredChipRun();
		if (!found.target) { await setThemeVerified('Clawdius Dark'); return `SKIPPED (no errored-chip run found across ${found.scanned} run(s))`; }
		await found.target.click();
		await win.keyboard.press('ArrowRight');
		await win.waitForTimeout(400);
		// Walk (keyboard) to the first errored agent - errored-first, so it is near the top of the children.
		let erroredId: string | null = null;
		const seenIds = new Set<string>();
		for (let step = 0; step < 80 && !erroredId; step++) {
			for (const r of await win.$$('.clawdius-workflow-agent-row')) {
				const id = await r.getAttribute('data-agent-id');
				if (id && !seenIds.has(id)) { seenIds.add(id); if ((await r.getAttribute('data-agent-state')) === 'error') { erroredId = id; break; } }
			}
			if (!erroredId) { await win.keyboard.press('ArrowDown'); await win.waitForTimeout(70); }
		}
		if (!erroredId) { await setThemeVerified('Clawdius Dark'); return `SKIPPED (run "${found.runId}" errored-chip "${found.chipText}" but no errored agent row surfaced)`; }
		let erroredRow = await win.$(`.clawdius-workflow-agent-row[data-agent-id="${erroredId}"]`);
		for (let up = 0; up < 90 && !erroredRow; up++) { await win.keyboard.press('ArrowUp'); await win.waitForTimeout(60); erroredRow = await win.$(`.clawdius-workflow-agent-row[data-agent-id="${erroredId}"]`); }
		if (!erroredRow) { await setThemeVerified('Clawdius Dark'); return `SKIPPED (could not re-reach errored agent "${erroredId}")`; }
		const openedPane = await activateAndWaitForDetail(erroredRow, 'agent');
		assert(openedPane, `activating errored agent "${erroredId}" never attached a detail pane`);
		for (const theme of THEMES) {
			await setThemeVerified(theme);
			const actualType = await themeTypeClass();
			await shot(`failure-${slug(theme)}`);
			// Re-query the (still-open) pane from the document each iteration - a held handle can go stale across a theme re-render.
			const errorFieldNode = await win.$('.clawdius-workflow-detail[data-clawdius-detail-kind="agent"] [data-clawdius-detail-field="error"] .clawdius-workflow-detail-field-value');
			const errorText = errorFieldNode ? ((await errorFieldNode.textContent()) || '').trim() : '';
			assert(errorText.length > 0 && errorText !== '—', `[${theme}] the errored agent's error field did not render under this theme: "${errorText.slice(0, 60)}"`);
			rendered[theme] = `rendered (workbench theme-type=${actualType}, error field ${errorText.length} chars)`;
		}
		await closeActiveEditorTab();
		await setThemeVerified('Clawdius Dark');
		return JSON.stringify(rendered);
	});

	// 5. Usage dashboard
	await scenario('usage-dashboard', true, async () => {
		await runCommand('Open Claude Code Usage Dashboard');
		await win.waitForTimeout(1500);
		const body = await win.$eval('.monaco-workbench', el => el.innerText || '');
		assert(/usage/i.test(body), 'usage dashboard did not render');
		return 'dashboard rendered';
	});

	// 6. Context Budget panel
	await scenario('context-budget-panel', false, async () => {
		await runCommand('Open Claude Code Context Budget');
		await win.waitForTimeout(1200);
		return 'opened';
	});

	// 7. Permission-mode picker
	await scenario('permission-picker', true, async () => {
		await runCommand('Set Default Permission Mode');
		await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
		const rows = await win.$$eval('.quick-input-list .monaco-list-row', els => els.map(e => (e.textContent || '').trim()));
		const text = rows.join(' || ');
		await closeQuickInput();
		assert(/Plan/i.test(text) && /Bypass/i.test(text), `picker missing modes: ${text}`);
		return `modes: ${rows.length}`;
	});

	// 8. Effort picker
	await scenario('effort-picker', false, async () => {
		await runCommand('Set Default Effort Level');
		await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
		const rows = await win.$$eval('.quick-input-list .monaco-list-row', els => els.map(e => (e.textContent || '').trim()));
		await closeQuickInput();
		return `effort options: ${rows.length}`;
	});

	// 9. Check for Updates (no network assertion here; just that it runs without throwing)
	await scenario('check-for-updates', false, async () => {
		await runCommand('Check for Updates');
		await win.waitForTimeout(2500);
		return 'command ran';
	});

	// 9b. Theme x sidebar-width render-integrity matrix (screenshots): Clawdius Dark / Clawdius Light /
	// Clawdius High Contrast (this fork's own installed HC theme - clawdius-themes/package.json, uiTheme
	// hc-black) at 240/300/400px. Screenshots are for human review; a sash-drag hiccup should not fail the
	// gate, so this scenario is NON-critical - but it still asserts the view renders SOMETHING (rows or a
	// state message) at every combo actually driven, and reports the REAL measured widths, never the targets.
	//
	// Theme selection here goes through `setThemeVerified` (see its own doc comment above) rather than the
	// plain `setTheme` used by theme-clawdius-dark/-light below - this build's large, extension-heavy local
	// theme catalogue and command palette made a blind type-then-Enter unreliable (it could land on the
	// picker's own unrelated "Browse Additional Color Themes..." entry instead of the intended theme, upstream
	// VS Code behavior, not part of the workflows rename), so `setThemeVerified` polls the filtered row list down
	// to an exact match and clicks it, then independently confirms the result via the workbench's own rendered
	// theme-type class.
	await scenario('ultracode-workflows-theme-width-matrix', false, async () => {
		const THEME_MATRIX = ['Clawdius Dark', 'Clawdius Light', 'Clawdius High Contrast'];
		const WIDTH_MATRIX = [240, 300, 400];
		const TOLERANCE = 8;
		const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

		const focusWorkflows = async () => {
			await runCommand('Focus on Claude Code Ultracode Workflows View');
			await win.waitForSelector('.clawdius-workflows-tree', { state: 'attached', timeout: 15000 });
		};
		const selectTheme = async label => {
			const actual = await setThemeVerified(label);
			await focusWorkflows();
			return actual;
		};

		await focusWorkflows();

		// Probe whether sash-dragging is reliable at all (2 honest attempts at one width) BEFORE committing to
		// the full 3x3 matrix - an unreliable drag falls back to natural-width screenshots, never fabricated px.
		let dragOk = false;
		let probeDetail = '';
		for (let attempt = 1; attempt <= 2 && !dragOk; attempt++) {
			try {
				const achieved = await setSidebarWidth(300);
				dragOk = Math.abs(achieved - 300) <= TOLERANCE;
				probeDetail = `probe attempt ${attempt}: target 300px, achieved ${Math.round(achieved)}px`;
			} catch (err) {
				probeDetail = `probe attempt ${attempt} threw: ${(err && err.message) || String(err)}`;
			}
		}

		const renderOk = [];
		if (!dragOk) {
			const naturalWidths = {};
			for (const theme of THEME_MATRIX) {
				await selectTheme(theme);
				await win.waitForTimeout(300);
				const box = await getSidebarBox();
				naturalWidths[theme] = box ? Math.round(box.width) : undefined;
				await shot(`workflows-${slug(theme)}-natural`);
				const rows = await win.$$('.clawdius-workflow-run-row');
				const stateMsgs = await win.$$('[data-clawdius-workflows-state]');
				renderOk.push(rows.length > 0 || stateMsgs.length > 0);
			}
			await selectTheme('Clawdius Dark');
			assert(renderOk.every(Boolean), 'the workflows view rendered nothing (no rows, no state message) at natural width for at least one theme');
			return `SKIPPED (px width matrix not driven - sash drag unreliable: ${probeDetail}); screenshotted at natural widths instead: ${JSON.stringify(naturalWidths)}`;
		}

		const achievedWidths = {};
		for (const theme of THEME_MATRIX) {
			await selectTheme(theme);
			achievedWidths[theme] = {};
			for (const width of WIDTH_MATRIX) {
				const achieved = await setSidebarWidth(width);
				achievedWidths[theme][width] = Math.round(achieved);
				await win.waitForTimeout(200);
				await shot(`workflows-${slug(theme)}-${width}`);
				const rows = await win.$$('.clawdius-workflow-run-row');
				const stateMsgs = await win.$$('[data-clawdius-workflows-state]');
				renderOk.push(rows.length > 0 || stateMsgs.length > 0);
			}
		}
		await selectTheme('Clawdius Dark');
		assert(renderOk.every(Boolean), 'the workflows view rendered nothing (no rows, no state message) for at least one theme/width combo');
		return `3 themes x 3 widths driven; actual widths achieved in px (target->theme->achieved): ${JSON.stringify(achievedWidths)}`;
	});

	// 9c. Drill-in render-integrity: the RESULT detail pane under Clawdius Dark / Clawdius Light / Clawdius High
	// Contrast (this fork's own installed HC theme - same label the theme-width matrix above already verified
	// maps to `hc-black` via `themeTypeClass()`). Non-critical, screenshot-for-review, but still asserts the pane
	// renders SOMETHING under every theme actually driven - never a blank pane.
	await scenario('ultracode-workflows-drill-in-themes', false, async () => {
		const THEMES = ['Clawdius Dark', 'Clawdius Light', 'Clawdius High Contrast'];
		const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
		const rendered = {};

		for (const theme of THEMES) {
			await setThemeVerified(theme);
			await focusWorkflowsView();

			const rowHandles = await win.$$('.clawdius-workflow-run-row');
			let target;
			for (const h of rowHandles) {
				if ((await h.getAttribute('data-run-kind')) === 'terminal') { target = h; break; }
			}
			if (!target) {
				rendered[theme] = 'SKIPPED (no terminal runs)';
				continue;
			}

			const expanded = await expandRunAndGatherAgents(target);
			assert(expanded.story, `[${theme}] expanding a terminal run did not reveal a story leaf`);
			const pane = await activateAndWaitForDetail(expanded.story, 'result');
			assert(pane, `[${theme}] activating the story leaf never attached a result detail pane`);

			const actualType = await themeTypeClass();
			await shot(`drill-in-${slug(theme)}`);

			const resultNode = await pane.$('.clawdius-workflow-detail-result');
			const fieldNode = await pane.$('[data-clawdius-detail-field]');
			assert(resultNode || fieldNode, `[${theme}] detail pane rendered neither .clawdius-workflow-detail-result nor a [data-clawdius-detail-field] row`);
			rendered[theme] = `rendered (workbench theme-type=${actualType})`;

			await closeActiveEditorTab();
		}

		await setThemeVerified('Clawdius Dark');
		return JSON.stringify(rendered);
	});

	// 9d. LIVE run + GRADUATION, against the REAL built app: clones a REAL run's journal + agent sidecars (see
	// `findWorkflowDonor` above) into an isolated sandbox with NO sibling manifest, points a SECOND Electron
	// instance's `USERPROFILE`/`HOME` at that sandbox ONLY (the real `~/.claude` is never touched), and proves -
	// against the actual `.build/electron/Clawdius.exe`, not a unit test - that a run whose journal has no
	// sibling manifest renders LIVE with honest progress (a real started/result ratio phrased "seen so far", a
	// progress bar, landed-result previews, a live status icon, and no fabricated total/percentage or "paused"),
	// then GRADUATES IN PLACE the moment the manifest lands - one row per run identity throughout, never a
	// live/terminal pair - across Dark/Light/High-Contrast. Leaves the main `win`/first app untouched: it
	// swaps the module's `win` to the second window only for the scope of this scenario and restores it after.
	await scenario('ultracode-workflows-live-graduation', true, async () => {
		const donor = findWorkflowDonor();
		if (!donor) {
			return 'SKIPPED (no run under the real ~/.claude/projects carries BOTH a workflows/<runId>.json manifest '
				+ 'and a subagents/workflows/<runId>/journal.jsonl - nothing to clone a live/graduation transition from)';
		}

		const sandbox = mkdtempSync(join(tmpdir(), 'clawdius-e2e-sandbox-'));
		const prof2 = mkdtempSync(join(tmpdir(), 'clawdius-e2e-prof2-'));
		const exts2 = mkdtempSync(join(tmpdir(), 'clawdius-e2e-exts2-'));
		const syntheticSession = `${donor.session}-e2e-${process.pid}`;
		const savedWin = win;
		let app2;
		try {
			// Clone the LIVE fixture: the journal + every agent sidecar, landing under a FRESH synthetic session
			// so the real runId can be reused with no collision. The manifest's dir is created (so it is already
			// inside the recursively-watched tree below) but stays EMPTY - a journal with no sibling manifest is
			// the live shape by construction, never hand-authored.
			const journalDestDir = join(sandbox, '.claude', 'projects', donor.enc, syntheticSession, 'subagents', 'workflows', donor.runId);
			mkdirSync(journalDestDir, { recursive: true });
			copyFileSync(donor.journalFile, join(journalDestDir, 'journal.jsonl'));
			for (const name of donor.sidecarNames) {
				copyFileSync(join(donor.journalDir, name), join(journalDestDir, name));
			}
			const manifestDestDir = join(sandbox, '.claude', 'projects', donor.enc, syntheticSession, 'workflows');
			mkdirSync(manifestDestDir, { recursive: true });
			const manifestDestFile = join(manifestDestDir, `${donor.runId}.json`);

			app2 = await electron.launch({
				executablePath: join(REPO, '.build', 'electron', 'Clawdius.exe'),
				cwd: REPO,
				args: ['.', '--disable-extension=vscode.vscode-api-tests',
					`--user-data-dir=${prof2}`, `--extensions-dir=${exts2}`,
					'--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development', USERPROFILE: sandbox, HOME: sandbox },
				timeout: 120000,
			});
			win = await app2.firstWindow();

			await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
			await win.waitForTimeout(6000);
			await focusWorkflowsView();

			// --- LIVE: exactly one row, honest progress, no fabrication ------------------------------------
			const rowSelector = `.clawdius-workflow-run-row[data-run-id="${donor.runId}"][data-session-id="${syntheticSession}"]`;
			await win.waitForSelector(rowSelector, { state: 'attached', timeout: 20000 });
			let rowsForIdentity = await win.$$(rowSelector);
			assert(rowsForIdentity.length === 1, `expected exactly one row for the cloned run identity while live, found ${rowsForIdentity.length}`);
			const liveRow = rowsForIdentity[0];
			const liveKind = await liveRow.getAttribute('data-run-kind');
			assert(liveKind === 'live', `cloned run "${donor.runId}" rendered data-run-kind="${liveKind}" (expected "live") - a manifest-less journal did not read as a live run`);
			const liveIconClass = await liveRow.$eval('.clawdius-workflow-status-icon', el => el.className);
			assert(/\bstatus-live\b/.test(liveIconClass), `live run's status icon carries no "status-live" class: "${liveIconClass}"`);

			const progress = await expandLiveRunProgress(liveRow);
			assert(progress, `expanding live run "${donor.runId}" did not reveal a .clawdius-workflow-live-progress leaf`);
			const progressBar = await progress.$('.monaco-progress-container');
			assert(progressBar, 'live-progress leaf missing a .monaco-progress-container progress bar');

			const ratioText = ((await progress.$eval('.clawdius-workflow-live-ratio', el => el.textContent || '')) || '').trim();
			const expectedRatio = donor.liveProgress.seenCount > 0
				? `${donor.liveProgress.resultCount} of ${donor.liveProgress.seenCount} agents seen so far have a result`
				: 'No agents observed yet';
			assert(ratioText === expectedRatio, `live ratio caption read "${ratioText}", expected "${expectedRatio}"`);

			const landedHandles = await progress.$$('.clawdius-workflow-live-landed-item');
			const expectedLandedShown = Math.min(donor.liveProgress.landedResults.length, LIVE_PROGRESS_MAX_LANDED_PREVIEWS);
			assert(landedHandles.length === expectedLandedShown, `live-progress leaf showed ${landedHandles.length} landed-result preview(s), expected ${expectedLandedShown}`);
			const landedTexts = [];
			for (const h of landedHandles) { landedTexts.push(((await h.textContent()) || '').trim()); }
			for (let i = 0; i < landedTexts.length; i++) {
				assert(landedTexts[i] === donor.liveProgress.landedResults[i].preview,
					`landed-result preview #${i} read "${landedTexts[i].slice(0, 60)}", expected "${donor.liveProgress.landedResults[i].preview.slice(0, 60)}"`);
			}

			// `textContent` (not `innerText`) deliberately - this must catch a fabrication even if some future
			// change rendered it into a hidden node, not just what happens to be visible right now.
			const rowText = await liveRow.evaluate(el => el.textContent || '');
			const progressText = await progress.evaluate(el => el.textContent || '');
			const combined = `${rowText}\n${progressText}`;
			assert(!/\d+\s*%/.test(combined), `live row/progress text fabricated a percentage: ${JSON.stringify(combined.slice(0, 300))}`);
			assert(!/\d+\s*\/\s*\d+/.test(combined), `live row/progress text fabricated a "N/total" fraction: ${JSON.stringify(combined.slice(0, 300))}`);
			assert(!/\bpaused\b/i.test(combined), `live row/progress text fabricated a "paused" state: ${JSON.stringify(combined.slice(0, 300))}`);

			const liveDetail = `live: data-run-kind="live", icon has "status-live"; progress bar present; ratio="${ratioText}"; `
				+ `${landedHandles.length} landed preview(s) shown of ${donor.liveProgress.landedResults.length} total; `
				+ `no %, no "N/total", no "paused"; exactly 1 row for the identity`;

			// --- GRADUATION: write the manifest, poll past the 250ms coalesce, then re-check the SAME identity ---
			writeFileSync(manifestDestFile, donor.manifestBytes);
			await win.waitForFunction((sel) => {
				const row = document.querySelector(sel);
				return !!row && row.getAttribute('data-run-kind') === 'terminal';
			}, rowSelector, { timeout: 20000, polling: 300 });

			rowsForIdentity = await win.$$(rowSelector);
			assert(rowsForIdentity.length === 1, `expected exactly one row for the run identity AFTER graduation (live and terminal must never coexist as two rows), found ${rowsForIdentity.length}`);
			const terminalRow = rowsForIdentity[0];
			const terminalKind = await terminalRow.getAttribute('data-run-kind');
			assert(terminalKind === 'terminal', `run "${donor.runId}" read data-run-kind="${terminalKind}" after the manifest landed (expected "terminal")`);
			const terminalIconClass = await terminalRow.$eval('.clawdius-workflow-status-icon', el => el.className);
			const statusMatch = terminalIconClass.match(/\bstatus-(completed|failed)\b/);
			assert(statusMatch, `graduated run's status icon carries neither "status-completed" nor "status-failed": "${terminalIconClass}"`);

			const graduationDetail = `graduation: data-run-kind "live" -> "terminal", status icon "status-live" -> "status-${statusMatch[1]}"; `
				+ `exactly 1 row for the identity after graduation`;

			// --- THEME MATRIX: the graduated row survives Dark / Light / High Contrast --------------------
			const THEME_MATRIX = ['Clawdius Dark', 'Clawdius Light', 'Clawdius High Contrast'];
			const themeResults = {};
			for (const theme of THEME_MATRIX) {
				await setThemeVerified(theme);
				await focusWorkflowsView();
				const rows = await win.$$(rowSelector);
				assert(rows.length === 1, `[${theme}] expected exactly 1 row for the run identity, found ${rows.length}`);
				const kind = await rows[0].getAttribute('data-run-kind');
				assert(kind === 'terminal', `[${theme}] graduated run row read data-run-kind="${kind}" (expected "terminal")`);
				const actualType = await themeTypeClass();
				await shot(`live-graduation-${theme.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
				themeResults[theme] = `present, kind=terminal, workbench theme-type=${actualType}`;
			}
			await setThemeVerified('Clawdius Dark');

			return `donor: enc="${donor.enc}" session="${donor.session}" runId="${donor.runId}" `
				+ `(journal: ${donor.liveProgress.startedCount} started / ${donor.liveProgress.resultCount} result / ${donor.liveProgress.landedResults.length} landed); `
				+ `${liveDetail}; ${graduationDetail}; themes=${JSON.stringify(themeResults)}`;
		} finally {
			if (app2) { try { await app2.close(); } catch { /* best-effort cleanup */ } }
			try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(prof2, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(exts2, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			win = savedWin;
		}
	});

	// 9e. AWARENESS: the activity-bar container badge appears for an UNSEEN failed run, clears the moment the
	// workflows view is opened/focused, and a RESTART of the same profile does not re-alarm the now-seen failure -
	// against the REAL built app. Clones a REAL FAILED run's manifest bytes (findFailedWorkflowDonor above) into
	// an isolated sandbox and points a SECOND Electron instance's `USERPROFILE`/`HOME` at it (the real ~/.claude is
	// never touched). Unlike the live-graduation scenario above, this one launches with a FIXED `--user-data-dir`
	// reused across a close+relaunch, since the failure watermark lives in PROFILE-scoped storage and must survive
	// that restart for the assertion to mean anything. The container's action item is found by its codicon class
	// (`codicon-clawdius-claude-code-workflows`, stable per its icon registration) rather than by aria-label: the
	// label text lives on the inner `.action-label` anchor while the outer `.action-item` itself carries an EMPTY
	// aria-label, so an aria-label-based selector on the outer element would never match.
	// SKIPs+WARNs (never a false pass, never a weakened assertion) when the config root has no failed run to clone,
	// or when the activity-bar action item/badge cannot be found in the DOM at all.
	await scenario('ultracode-workflows-awareness-badge', true, async () => {
		const donor = findFailedWorkflowDonor();
		if (!donor) {
			return 'SKIPPED (no run under the config root carries a workflows/<runId>.json manifest '
				+ 'with status:"failed" - nothing to clone an unseen-failure badge from)';
		}

		const sandbox = mkdtempSync(join(tmpdir(), 'clawdius-e2e-awareness-sandbox-'));
		const profile = mkdtempSync(join(tmpdir(), 'clawdius-e2e-awareness-prof-'));
		const exts = mkdtempSync(join(tmpdir(), 'clawdius-e2e-awareness-exts-'));
		const syntheticSession = `${donor.session}-e2e-awareness-${process.pid}`;
		const savedWin = win;
		let app;

		const iconSelector = '.part.activitybar .action-item .action-label.codicon-clawdius-claude-code-workflows';

		const launch = async () => {
			const a = await electron.launch({
				executablePath: join(REPO, '.build', 'electron', 'Clawdius.exe'),
				cwd: REPO,
				args: ['.', '--disable-extension=vscode.vscode-api-tests',
					`--user-data-dir=${profile}`, `--extensions-dir=${exts}`,
					'--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development', USERPROFILE: sandbox, HOME: sandbox },
				timeout: 120000,
			});
			const w = await a.firstWindow();
			await w.waitForSelector('.monaco-workbench', { timeout: 90000 });
			await w.waitForTimeout(6000);
			return { app: a, win: w };
		};

		// Read the container's CURRENT badge state, or `undefined` if the action item itself cannot be found at
		// all (the scenario's own "badge DOM unreachable" SKIP trigger).
		const readBadge = async w => {
			const icon = await w.$(iconSelector);
			if (!icon) { return undefined; }
			return icon.evaluate(el => {
				const item = el.closest('.action-item');
				const badge = item ? item.querySelector('.badge') : null;
				if (!badge) { return { visible: false, isWarning: false, numberText: '' }; }
				const content = badge.querySelector('.badge-content');
				return {
					visible: badge.style.display !== 'none',
					isWarning: !!content && content.classList.contains('codicon-warning'),
					numberText: content ? (content.textContent || '') : '',
				};
			});
		};

		try {
			// Clone the FAILED run's manifest bytes under a fresh synthetic session - no journal/sidecars needed
			// (a terminal manifest alone is a complete, valid run).
			const manifestDestDir = join(sandbox, '.claude', 'projects', donor.enc, syntheticSession, 'workflows');
			mkdirSync(manifestDestDir, { recursive: true });
			writeFileSync(join(manifestDestDir, `${donor.runId}.json`), donor.manifestBytes);

			let launched = await launch();
			app = launched.app;
			win = launched.win;

			// A COLD profile over a PRE-EXISTING failed run must NOT alarm: the first read with no stored watermark
			// baselines every currently-failed identity into "seen" WITHOUT badging. So the badge is absent right
			// after launch even though a failed run is present - the no-cold-start-alarm rule.
			const afterLaunch = await readBadge(win);
			if (!afterLaunch) {
				return `SKIPPED (the workflows container's activity-bar action item could not be found - selector "${iconSelector}" matched nothing)`;
			}
			assert(!afterLaunch.visible, `expected NO badge on a cold profile whose only failed run was baselined as already-seen (no cold-start alarm), badge state: ${JSON.stringify(afterLaunch)}`);
			const coldStartDetail = `no cold-start badge (baseline absorbed the pre-existing failure): ${JSON.stringify(afterLaunch)}`;

			// A NEW failure that lands AFTER the baseline is genuinely unseen -> the warning badge appears. Write a
			// second failed run (a distinct run id) into the already-watched sandbox and wait for the watcher to
			// surface it. liveCount is 0 here (only terminal runs), so the failure indicator is what shows.
			const newFailedRunId = 'wf_e2eawaretwo';
			writeFileSync(join(manifestDestDir, `${newFailedRunId}.json`), donor.manifestBytes);
			await win.waitForFunction((sel) => {
				const icon = document.querySelector(sel);
				const item = icon ? icon.closest('.action-item') : null;
				const badge = item ? item.querySelector('.badge') : null;
				const content = badge ? badge.querySelector('.badge-content') : null;
				return !!badge && badge.style.display !== 'none' && !!content && content.classList.contains('codicon-warning');
			}, iconSelector, { timeout: 20000, polling: 300 }).catch(() => { });
			const afterNewFailure = await readBadge(win);
			assert(afterNewFailure && afterNewFailure.visible, `expected the unseen-failure badge to APPEAR after a new failed run landed post-baseline, badge state: ${JSON.stringify(afterNewFailure)}`);
			assert(afterNewFailure.isWarning, `expected the unseen-failure badge to be a warning icon badge, badge state: ${JSON.stringify(afterNewFailure)}`);
			const launchDetail = `${coldStartDetail}; badge appeared for a new failure: ${JSON.stringify(afterNewFailure)}`;

			// --- open/focus the workflows view: the badge must clear ---------------------------------------------
			await focusWorkflowsView();
			await win.waitForFunction((sel) => {
				const icon = document.querySelector(sel);
				const item = icon ? icon.closest('.action-item') : null;
				const badge = item ? item.querySelector('.badge') : null;
				return !!badge && badge.style.display === 'none';
			}, iconSelector, { timeout: 15000, polling: 300 }).catch(() => { });
			const afterOpen = await readBadge(win);
			assert(afterOpen && !afterOpen.visible, `expected the badge to clear after opening/focusing the workflows view, badge state: ${JSON.stringify(afterOpen)}`);
			const openDetail = `badge cleared after focusing the view: ${JSON.stringify(afterOpen)}`;

			// --- prove the watermark PERSISTED across a real restart, DISTINGUISHABLY -----------------------------
			// A bare "no badge after restart" cannot tell a persisted watermark from a re-baseline: both leave the two
			// pre-existing failures unbadged. So make it distinguishing. First switch the active side bar AWAY from
			// the workflows view (focus the Explorer) so the restored window does NOT restore the workflows view as
			// visible and fire its on-visible mark-seen - that would acknowledge the new failure below and erase the
			// proof. Then stage a THIRD, still-unseen failure that is already present at the restart's FIRST read, and
			// relaunch the same profile + sandbox. On restart the warning badge appears ONLY if the watermark
			// persisted: with a real watermark the two already-seen failures stay quiet and the new one alarms; if
			// persistence had been lost the restart would cold-start-baseline ALL THREE into "seen" and show nothing.
			await win.keyboard.press('Control+Shift+E');
			await win.waitForTimeout(500);
			const restartFailedRunId = 'wf_e2eawarethree';
			writeFileSync(join(manifestDestDir, `${restartFailedRunId}.json`), donor.manifestBytes);

			await app.close();
			app = undefined;
			launched = await launch();
			app = launched.app;
			win = launched.win;
			await win.waitForFunction((sel) => {
				const icon = document.querySelector(sel);
				const item = icon ? icon.closest('.action-item') : null;
				const badge = item ? item.querySelector('.badge') : null;
				const content = badge ? badge.querySelector('.badge-content') : null;
				return !!badge && badge.style.display !== 'none' && !!content && content.classList.contains('codicon-warning');
			}, iconSelector, { timeout: 20000, polling: 300 }).catch(() => { });
			const afterRestart = await readBadge(win);
			assert(afterRestart, `the workflows container's activity-bar action item was not found after the restart (selector "${iconSelector}")`);
			assert(afterRestart.visible && afterRestart.isWarning, `expected the warning badge to APPEAR on restart for a new unseen failure while the two persisted-seen failures stayed quiet (proving the watermark survived the restart - a lost watermark would have re-baselined all three into "seen" and shown nothing), badge state: ${JSON.stringify(afterRestart)}`);
			const restartDetail = `warning badge on restart for a new failure while persisted-seen failures stayed quiet: ${JSON.stringify(afterRestart)}`;

			return `donor: enc="${donor.enc}" session="${donor.session}" runId="${donor.runId}"; ${launchDetail}; ${openDetail}; ${restartDetail}`;
		} finally {
			if (app) { try { await app.close(); } catch { /* best-effort cleanup */ } }
			try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(profile, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(exts, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			win = savedWin;
		}
	});

	// HONEST EDGES: every degraded/degenerate run shape stays VISIBLE and never crashes the list - an
	// unknown-shape manifest, a run/agent missing its cost numbers (a dash, never a fabricated zero), a live run
	// whose result landed with no surviving started record, a live run with a torn (non-tail) journal line, and a
	// manifest naming one agentId twice - against the real built app. These shapes are hand-authored (they are not
	// expected in ordinary use), staged into an isolated sandbox that a separate instance reads via an overridden
	// USERPROFILE/HOME pointed at the sandbox only, so the reader sees only the sandbox and never the user's own
	// config root, across Dark/Light/High-Contrast.
	await scenario('ultracode-workflows-honest-edges', true, async () => {
		const sandbox = mkdtempSync(join(tmpdir(), 'clawdius-e2e-edges-sandbox-'));
		const prof3 = mkdtempSync(join(tmpdir(), 'clawdius-e2e-edges-prof-'));
		const exts3 = mkdtempSync(join(tmpdir(), 'clawdius-e2e-edges-exts-'));
		const savedWin = win;
		let app3;
		try {
			const projectsRoot = join(sandbox, '.claude', 'projects');
			const proj = join(projectsRoot, 'edge-cases');

			// 1. UNKNOWN-SHAPE: a manifest present but not a recognized shape (no `status`).
			const unknownShapeDir = join(proj, 'session-unknown-shape', 'workflows');
			mkdirSync(unknownShapeDir, { recursive: true });
			writeFileSync(join(unknownShapeDir, 'wf_unknownshape.json'), JSON.stringify({ foo: 'bar' }));

			// 2. MISSING NUMBERS: a terminal run with no cost totals at all, and one agent with no model/tokens/toolCalls.
			const missingNumsDir = join(proj, 'session-missing-numbers', 'workflows');
			mkdirSync(missingNumsDir, { recursive: true });
			writeFileSync(join(missingNumsDir, 'wf_missingnums.json'), JSON.stringify({
				workflowName: 'missing-numbers-edge', summary: 'No cost totals were ever computed.', status: 'completed',
				workflowProgress: [{ type: 'workflow_agent', agentId: 'a1', label: 'bare-agent', state: 'done' }],
			}));

			// 3. RESULT-BEFORE-START: a live run (manifest-less journal) whose result landed with no started record.
			const resultBeforeStartDir = join(proj, 'session-result-before-start', 'subagents', 'workflows', 'wf_resultbeforestart');
			mkdirSync(resultBeforeStartDir, { recursive: true });
			writeFileSync(join(resultBeforeStartDir, 'journal.jsonl'), '{"type":"result","agentId":"a1","result":"Landed with no started record."}\n');

			// 4. TORN TAIL: a live run whose journal has a torn (NOT last) line; the readable records still render.
			const tornTailDir = join(proj, 'session-torn-tail', 'subagents', 'workflows', 'wf_torntail');
			mkdirSync(tornTailDir, { recursive: true });
			writeFileSync(join(tornTailDir, 'journal.jsonl'),
				'{"type":"started","agentId":"a1"}\n{"type":"started","agen\n{"type":"result","agentId":"a1","result":"Done despite the torn line."}\n');

			// 5. DUPLICATE AGENT ID: one manifest naming the same agentId twice.
			const dupAgentDir = join(proj, 'session-duplicate-agent', 'workflows');
			mkdirSync(dupAgentDir, { recursive: true });
			writeFileSync(join(dupAgentDir, 'wf_dupagent.json'), JSON.stringify({
				workflowName: 'duplicate-agent-edge', status: 'completed',
				workflowProgress: [
					{ type: 'workflow_agent', agentId: 'a1', label: 'first', state: 'done' },
					{ type: 'workflow_agent', agentId: 'a1', label: 'second', state: 'done' },
				],
			}));

			// 6. ZERO-AGENT TERMINAL: a run that genuinely ran no agents (complete, no chip) vs one whose only agent
			// entry was unreadable (also an empty agent list, but partial) - the distinguishing pair.
			const zeroAgentDir = join(proj, 'session-zero-agent', 'workflows');
			mkdirSync(zeroAgentDir, { recursive: true });
			writeFileSync(join(zeroAgentDir, 'wf_zeroagent.json'), JSON.stringify({
				workflowName: 'zero-agent-edge', summary: 'Ran no agents at all.', status: 'completed', workflowProgress: [],
			}));
			const zeroAgentPartialDir = join(proj, 'session-zero-agent-partial', 'workflows');
			mkdirSync(zeroAgentPartialDir, { recursive: true });
			writeFileSync(join(zeroAgentPartialDir, 'wf_zeroagentpartial.json'), JSON.stringify({
				workflowName: 'zero-agent-partial-edge', summary: 'Its only agent entry was unreadable.', status: 'completed',
				workflowProgress: [{ type: 'workflow_agent', label: 'missing id and state' }],
			}));

			// A HEALTHY sibling run beside the degenerate ones - proves the whole list never blanks or crashes.
			const healthyDir = join(proj, 'session-healthy', 'workflows');
			mkdirSync(healthyDir, { recursive: true });
			writeFileSync(join(healthyDir, 'wf_healthy.json'), JSON.stringify({
				workflowName: 'healthy-sibling', summary: 'A normal run beside the degenerate ones.', status: 'completed',
				durationMs: 1000, totalTokens: 500, totalToolCalls: 3, defaultModel: 'claude-opus-4-8[1m]',
				workflowProgress: [{ type: 'workflow_agent', agentId: 'h1', label: 'healthy-agent', state: 'done', model: 'opus', tokens: 500, toolCalls: 3, durationMs: 1000 }],
			}));

			app3 = await electron.launch({
				executablePath: join(REPO, '.build', 'electron', 'Clawdius.exe'),
				cwd: REPO,
				args: ['.', '--disable-extension=vscode.vscode-api-tests',
					`--user-data-dir=${prof3}`, `--extensions-dir=${exts3}`,
					'--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development', USERPROFILE: sandbox, HOME: sandbox },
				timeout: 120000,
			});
			win = await app3.firstWindow();
			await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
			await win.waitForTimeout(6000);
			await focusWorkflowsView();

			const errorOverlay = await win.$('[data-clawdius-workflows-state="read-error"]');
			assert(!errorOverlay, 'the workflows list rendered a read-error overlay instead of the degenerate runs');
			await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_healthy"]', { state: 'attached', timeout: 20000 });

			// Expand-then-collapse ONE row at a time: the story/live-progress leaf carries no data-run-id of its own
			// (it is a SEPARATE tree row below the run, not a nested child), so only ONE such leaf may be expanded
			// at a time for `expandRunAndGatherAgents`/`expandLiveRunProgress`'s global `.clawdius-workflow-story` /
			// `.clawdius-workflow-live-progress` lookups to unambiguously belong to the run under test.
			const collapse = async (row) => { await row.click(); await win.keyboard.press('ArrowLeft'); await win.waitForTimeout(200); };

			const results = {};

			// --- 1. unknown-shape --------------------------------------------------------------------------------
			const unknownRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_unknownshape"]', { state: 'attached', timeout: 10000 });
			const unknownKind = await unknownRow.getAttribute('data-run-kind');
			const unknownCompleteness = await unknownRow.getAttribute('data-completeness');
			const unknownText = (await unknownRow.textContent()) || '';
			assert(unknownKind === 'unknown-shape' && unknownCompleteness === 'unknown-shape',
				`unknown-shape run read data-run-kind="${unknownKind}" data-completeness="${unknownCompleteness}"`);
			assert(unknownText.includes('Shape not recognized'), `unknown-shape row text missing "Shape not recognized": ${JSON.stringify(unknownText)}`);
			results.unknownShape = `data-run-kind="unknown-shape"; row text includes "Shape not recognized"`;

			// --- 2. missing numbers --------------------------------------------------------------------------------
			const missingRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_missingnums"]', { state: 'attached', timeout: 10000 });
			const missingExpand = await expandRunAndGatherAgents(missingRow);
			assert(missingExpand.story, 'missing-numbers run did not reveal its story leaf');
			const storyText = (await missingExpand.story.textContent()) || '';
			const storyDashCount = (storyText.match(/—/g) || []).length;
			assert(storyDashCount === 5, `expected exactly 5 dash placeholders (duration/tokens/toolCalls/model/agentCount) in the missing-numbers story leaf, found ${storyDashCount}: ${JSON.stringify(storyText)}`);
			assert(!/\b0 tokens\b|\b0 tool calls\b/.test(storyText), `missing-numbers story leaf fabricated a zero: ${JSON.stringify(storyText)}`);
			let agentDashCount = -1;
			if (missingExpand.agentRows.length > 0) {
				const agentText = (await missingExpand.agentRows[0].textContent()) || '';
				agentDashCount = (agentText.match(/—/g) || []).length;
				assert(agentDashCount === 3, `expected exactly 3 dash placeholders (tokens/calls/duration) in the missing-numbers agent row, found ${agentDashCount}: ${JSON.stringify(agentText)}`);
				assert(!/\b0 tokens\b|\b0 calls\b/.test(agentText), `missing-numbers agent row fabricated a zero: ${JSON.stringify(agentText)}`);
			}
			await collapse(missingRow);
			results.missingNumbers = `story leaf dash count=${storyDashCount}, agent row dash count=${agentDashCount}, no fabricated zero`;

			// --- 3. result-before-start --------------------------------------------------------------------------
			const rbsRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_resultbeforestart"]', { state: 'attached', timeout: 10000 });
			const rbsCompleteness = await rbsRow.getAttribute('data-completeness');
			const rbsProgress = await expandLiveRunProgress(rbsRow);
			assert(rbsProgress, 'result-before-start run did not reveal its live-progress leaf');
			const rbsRatio = ((await rbsProgress.$eval('.clawdius-workflow-live-ratio', el => el.textContent || '')) || '').trim();
			assert(rbsRatio === '1 of 1 agents seen so far have a result', `result-before-start ratio read "${rbsRatio}", expected "1 of 1 agents seen so far have a result" (the union, never inverted)`);
			assert(rbsCompleteness === 'complete', `result-before-start alone (no torn line) must stay complete, read data-completeness="${rbsCompleteness}"`);
			await collapse(rbsRow);
			results.resultBeforeStart = `ratio="${rbsRatio}"; data-completeness="${rbsCompleteness}"`;

			// --- 4. torn tail --------------------------------------------------------------------------------------
			const tornRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_torntail"]', { state: 'attached', timeout: 10000 });
			const tornCompleteness = await tornRow.getAttribute('data-completeness');
			const tornProgress = await expandLiveRunProgress(tornRow);
			assert(tornProgress, 'torn-tail run did not reveal its live-progress leaf');
			const tornDegradedText = ((await tornProgress.$eval('.clawdius-workflow-live-degraded', el => el.textContent || '')) || '').trim();
			assert(tornDegradedText.length > 0, 'torn-tail live-progress leaf shows no degraded caption');
			const tornRatio = ((await tornProgress.$eval('.clawdius-workflow-live-ratio', el => el.textContent || '')) || '').trim();
			assert(tornRatio === '1 of 1 agents seen so far have a result', `torn-tail ratio read "${tornRatio}" - the readable started+result records must still render`);
			assert(tornCompleteness === 'partial', `a torn journal line must degrade the run to partial, read data-completeness="${tornCompleteness}"`);
			await collapse(tornRow);
			results.tornTail = `degraded caption="${tornDegradedText}"; ratio="${tornRatio}" (readable records still render); data-completeness="${tornCompleteness}"`;

			// --- 5. duplicate agent id ------------------------------------------------------------------------------
			const dupAgentRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_dupagent"]', { state: 'attached', timeout: 10000 });
			const dupAgentCompleteness = await dupAgentRow.getAttribute('data-completeness');
			const dupAgentExpand = await expandRunAndGatherAgents(dupAgentRow);
			assert(dupAgentExpand.agentRows.length === 1, `expected exactly ONE agent row for the duplicate agentId, found ${dupAgentExpand.agentRows.length}`);
			assert(dupAgentCompleteness === 'partial', `a manifest naming one agentId twice must degrade the run to partial, read data-completeness="${dupAgentCompleteness}"`);
			await collapse(dupAgentRow);
			results.duplicateAgentId = `exactly 1 agent row for the duplicated agentId (never 2); data-completeness="${dupAgentCompleteness}"`;

			// --- 6. zero-agent terminal: complete vs partial ------------------------------------------------------
			const zeroAgentRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_zeroagent"]', { state: 'attached', timeout: 10000 });
			const zeroAgentCompleteness = await zeroAgentRow.getAttribute('data-completeness');
			const zeroAgentChip = await zeroAgentRow.$('.completeness-chip');
			const zeroAgentChipVisible = zeroAgentChip ? await zeroAgentChip.evaluate(el => el.style.display !== 'none') : false;
			assert(zeroAgentCompleteness === 'complete' && !zeroAgentChipVisible,
				`a genuinely agent-less run must read complete with no completeness chip, read data-completeness="${zeroAgentCompleteness}", chip visible=${zeroAgentChipVisible}`);
			const zeroAgentPartialRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_zeroagentpartial"]', { state: 'attached', timeout: 10000 });
			const zeroAgentPartialCompleteness = await zeroAgentPartialRow.getAttribute('data-completeness');
			assert(zeroAgentPartialCompleteness === 'partial', `an empty agent list caused by an unreadable entry must read partial, read data-completeness="${zeroAgentPartialCompleteness}"`);
			results.zeroAgentTerminal = `genuinely agent-less: data-completeness="complete", no chip; unreadable-entry empty list: data-completeness="partial"`;

			// --- THEME MATRIX: every degenerate row survives Dark / Light / High Contrast --------------------------
			const rowSelectors = {
				unknownShape: '.clawdius-workflow-run-row[data-run-id="wf_unknownshape"]',
				missingNumbers: '.clawdius-workflow-run-row[data-run-id="wf_missingnums"]',
				resultBeforeStart: '.clawdius-workflow-run-row[data-run-id="wf_resultbeforestart"]',
				tornTail: '.clawdius-workflow-run-row[data-run-id="wf_torntail"]',
				duplicateAgentId: '.clawdius-workflow-run-row[data-run-id="wf_dupagent"]',
				zeroAgentTerminal: '.clawdius-workflow-run-row[data-run-id="wf_zeroagent"]',
			};
			const THEME_MATRIX = ['Clawdius Dark', 'Clawdius Light', 'Clawdius High Contrast'];
			const themeResults = {};
			for (const theme of THEME_MATRIX) {
				await setThemeVerified(theme);
				await focusWorkflowsView();
				for (const [name, sel] of Object.entries(rowSelectors)) {
					const count = (await win.$$(sel)).length;
					assert(count === 1, `[${theme}] expected exactly 1 row for "${name}", found ${count}`);
				}
				const overlay = await win.$('[data-clawdius-workflows-state="read-error"]');
				assert(!overlay, `[${theme}] the workflows list rendered a read-error overlay`);
				const actualType = await themeTypeClass();
				await shot(`honest-edges-${theme.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
				themeResults[theme] = `all 6 edge rows present exactly once, no error overlay, workbench theme-type=${actualType}`;
			}
			await setThemeVerified('Clawdius Dark');

			return `${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ')}; themes=${JSON.stringify(themeResults)}`;
		} finally {
			if (app3) { try { await app3.close(); } catch { /* best-effort cleanup */ } }
			try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(prof3, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(exts3, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			win = savedWin;
		}
	});

	// --- scale fixtures (real-build interactivity budgets at scale) --------------------------------------------------
	//
	// Both fixtures below are HAND-AUTHORED, not cloned from the real corpus: the budgets are stated at a specific
	// scale (~300 runs, ~1000 agents) the real corpus is not guaranteed to have, so these sandboxes exist purely to
	// exercise that scale deterministically. Mirrors the honest-edges sandbox pattern: a temp `USERPROFILE`/`HOME`
	// so the reader sees ONLY the sandbox, the real `~/.claude` untouched.

	const SCALE_LIST_RUN_COUNT = 300;
	const SCALE_EXPAND_AGENT_COUNT = 1000;

	function scaleListRunId(index) {
		return `wf_scale${String(index).padStart(4, '0')}`;
	}

	/** One small terminal-run manifest for the ~300-run first-paint/filter fixture: real cost numbers, one agent, no
	 *  journal/sidecars at all (nothing here exercises the transcript join - that is the OTHER fixture's job) - kept
	 *  minimal so writing and parsing 300 of them stays fast, which is the point: this budget measures the LIST
	 *  path itself, not agent volume. */
	function buildScaleListManifest(index) {
		return {
			workflowName: `scale-run-${index}`, summary: `Synthetic scale-fixture run number ${index}.`, status: 'completed',
			timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(), durationMs: 1500, totalTokens: 4000 + index, totalToolCalls: 2,
			defaultModel: 'claude-opus-4-8[1m]',
			workflowProgress: [
				{ type: 'workflow_agent', agentId: 'a0', label: `scale-agent-${index}`, state: 'done', model: 'claude-opus-4-8[1m]', tokens: 800, toolCalls: 2, durationMs: 400 },
			],
		};
	}

	/** The ~1000-agent manifest for the expand/scroll fixture: `agentCount` is set EXPLICITLY
	 *  (the reader never derives it from the agent list - see claudeReaderSeamService.ts) so the story leaf's
	 *  rendered count is a direct, checkable proof the row came from the manifest. Every `workflow_agent` entry
	 *  carries real cost numbers so an agent row never falls back to a dash. */
	function buildScaleExpandManifest() {
		const workflowProgress = [];
		for (let i = 0; i < SCALE_EXPAND_AGENT_COUNT; i++) {
			workflowProgress.push({
				type: 'workflow_agent', agentId: `a${i}`, label: `scale-agent-${i}`, state: 'done',
				model: 'claude-opus-4-8[1m]', tokens: 500 + i, toolCalls: 2, durationMs: 200,
			});
		}
		return {
			workflowName: 'scale-expand-fixture', summary: 'Synthetic scale fixture with 1000 agents.', status: 'completed',
			timestamp: new Date().toISOString(), durationMs: 120000, totalTokens: 900000, totalToolCalls: 2000,
			agentCount: SCALE_EXPAND_AGENT_COUNT, defaultModel: 'claude-opus-4-8[1m]', workflowProgress,
		};
	}

	/** The expand fixture's journal: a `started` record for every one of its {@link SCALE_EXPAND_AGENT_COUNT}
	 *  agents - satisfying the identity join's first three conditions (path-safe id, present in a `started` record,
	 *  unique) for EVERY agent, so the join genuinely reaches its fourth condition (the sibling `agent-<id>.jsonl`
	 *  file) for each one instead of short-circuiting earlier. See the expand scenario body for why the sidecar
	 *  files are then never created at all - the fixture half of the sidecars-absent check. */
	function buildScaleExpandJournal() {
		const lines = [];
		for (let i = 0; i < SCALE_EXPAND_AGENT_COUNT; i++) {
			lines.push(JSON.stringify({ type: 'started', agentId: `a${i}` }));
		}
		return lines.join('\n') + '\n';
	}

	/** Sample `requestAnimationFrame` deltas for `durationMs`, resolving with every delta measured (the caller drops
	 *  however many leading samples it judges as start-up scheduling noise). Runs entirely in-page; the caller
	 *  drives the actual scroll input concurrently (see the scroll scenario body) so the samples cover active
	 *  scrolling, not an idle tree. */
	async function sampleAnimationFrameDeltas(durationMs) {
		return win.evaluate((duration) => new Promise((resolve) => {
			const deltas = [];
			const start = performance.now();
			let last = start;
			const tick = () => {
				const now = performance.now();
				deltas.push(now - last);
				last = now;
				if (now - start < duration) {
					requestAnimationFrame(tick);
				} else {
					resolve(deltas);
				}
			};
			requestAnimationFrame(tick);
		}), durationMs);
	}

	function median(numbers) {
		const sorted = [...numbers].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	}

	/** Open the workflows view and return ONLY the time from the moment the command palette's already-narrowed
	 *  exact row is CLICKED to the first run row (or an honest state message) appearing - never including how long
	 *  it took to open the palette or type into it. `runCommand` (used elsewhere in this file for ordinary UI
	 *  driving) pads a full command invocation with realism-motivated fixed waits - up to ~2s of typing-settle
	 *  delay unrelated to the view's own react time - which would swallow a sub-second budget outright if the
	 *  timer started there; this measures the app's OWN latency, isolated from how this harness happens to drive
	 *  the palette. */
	async function focusWorkflowsViewTimed() {
		await win.keyboard.press('Control+Shift+P');
		await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
		await win.keyboard.type('Focus on Claude Code Ultracode Workflows View', { delay: 0 });
		let target;
		for (let poll = 0; poll < 40 && !target; poll++) {
			await win.waitForTimeout(50);
			const rows = await win.$$('.quick-input-list .monaco-list-row');
			if (rows.length === 0 || rows.length > 8) { continue; }
			for (const row of rows) {
				const label = await row.$('.quick-input-list-label .label-name');
				const text = label ? ((await label.innerText()) || '').trim() : ((await row.innerText()) || '').trim();
				// Command palette rows combine category + title into ONE label ("{0}: {1}", commandsQuickAccess.ts -
				// `registerFocusViewAction` uses the view CONTAINER's own title as the category), so match the row
				// whose label ENDS WITH the bare title rather than requiring an exact full-string match.
				if (text.endsWith('Focus on Claude Code Ultracode Workflows View')) { target = row; break; }
			}
		}
		if (!target) { throw new Error('command palette never narrowed to an exact "Focus on Claude Code Ultracode Workflows View" row'); }
		const paintStart = Date.now();
		await target.click();
		await win.waitForSelector('.clawdius-workflows-tree', { state: 'attached', timeout: 15000 });
		await win.waitForFunction(
			() => document.querySelector('.clawdius-workflow-run-row') !== null || document.querySelector('[data-clawdius-workflows-state]') !== null,
			undefined, { timeout: 60000 },
		);
		return Date.now() - paintStart;
	}

	// SCALE: ~300-run first paint + filter, against a hand-authored fixture sized to the stated budgets - a
	// deterministic stand-in for the real corpus, which is not guaranteed to carry ~300 runs. First paint is timed
	// from issuing the view-open command to the first run row (or an honest state message) appearing; the filter
	// budget covers the SAME 200ms debounce + render the real-corpus find-sort scenario above already documents,
	// just measured against a fixture large and deterministic enough to assert a hard number rather than merely
	// report one. The tree is VIRTUALIZED - only the rows that fit the viewport (plus overscan) are ever in the
	// DOM at once, so the full 300-run enumeration is proven the SAME way the ~1000-agent expand scenario proves
	// its full set below: keyboard Home/End bounds-check the newest and oldest run against the default
	// newest-first sort, rather than counting DOM nodes.
	await scenario('ultracode-workflows-scale-first-paint', true, async () => {
		const sandbox = mkdtempSync(join(tmpdir(), 'clawdius-e2e-scale-list-sandbox-'));
		const prof = mkdtempSync(join(tmpdir(), 'clawdius-e2e-scale-list-prof-'));
		const exts = mkdtempSync(join(tmpdir(), 'clawdius-e2e-scale-list-exts-'));
		const savedWin = win;
		let app5;
		try {
			const workflowsDir = join(sandbox, '.claude', 'projects', 'scale-list', 'session-scale-list', 'workflows');
			mkdirSync(workflowsDir, { recursive: true });
			for (let i = 0; i < SCALE_LIST_RUN_COUNT; i++) {
				writeFileSync(join(workflowsDir, `${scaleListRunId(i)}.json`), JSON.stringify(buildScaleListManifest(i)));
			}

			app5 = await electron.launch({
				executablePath: join(REPO, '.build', 'electron', 'Clawdius.exe'),
				cwd: REPO,
				args: ['.', '--disable-extension=vscode.vscode-api-tests',
					`--user-data-dir=${prof}`, `--extensions-dir=${exts}`,
					'--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development', USERPROFILE: sandbox, HOME: sandbox },
				timeout: 120000,
			});
			win = await app5.firstWindow();
			await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
			await win.waitForTimeout(3000);
			await win.keyboard.press('Escape');
			await win.waitForTimeout(150);

			// --- first paint: view-open trigger to the first run row - the <=500ms budget ---------------------------
			const firstPaintMs = await focusWorkflowsViewTimed();

			const expectedIds = new Set();
			for (let i = 0; i < SCALE_LIST_RUN_COUNT; i++) { expectedIds.add(scaleListRunId(i)); }
			const rowIdsAtTop = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));
			assert(rowIdsAtTop.length > 0 && rowIdsAtTop.every(id => expectedIds.has(id)),
				`expected the visible rows to be the synthetic fixture's own run ids, got ${JSON.stringify(rowIdsAtTop)}`);
			assert(rowIdsAtTop.includes(scaleListRunId(SCALE_LIST_RUN_COUNT - 1)),
				`the newest synthetic run ("${scaleListRunId(SCALE_LIST_RUN_COUNT - 1)}") was not among the top rows under the default newest-first sort: ${JSON.stringify(rowIdsAtTop)}`);
			assert(firstPaintMs <= 500, `first paint of ${SCALE_LIST_RUN_COUNT} runs took ${firstPaintMs}ms, budget is <=500ms`);

			// The full 300-run set materialized (not merely the visible top slice) - keyboard End bounds-checks the
			// OLDEST run, the same technique the ~1000-agent expand scenario uses for its own full-set proof. Click
			// the top row first to establish DOM/keyboard focus ON THE TREE (the "Focus on View" command that just
			// triggered the timed paint focuses the VIEW pane, not necessarily a specific row yet).
			const topRow = await win.$('.clawdius-workflow-run-row');
			if (topRow) { await topRow.click(); }
			await win.waitForTimeout(150);
			await win.keyboard.press('End');
			const oldestRow = await win.waitForSelector(`.clawdius-workflow-run-row[data-run-id="${scaleListRunId(0)}"]`, { state: 'attached', timeout: 15000 }).catch(() => null);
			assert(oldestRow, `the oldest synthetic run ("${scaleListRunId(0)}") never appeared after jumping to the end of the ${SCALE_LIST_RUN_COUNT}-run list`);
			await win.keyboard.press('Home');
			await win.waitForTimeout(200);

			// --- filter: narrow to one exact run id - the <=300ms budget --------------------------------------------
			const targetRunId = scaleListRunId(150);
			const filterInput = await win.$('.clawdius-workflows-filter input');
			assert(filterInput, 'the persistent filter InputBox did not render (.clawdius-workflows-filter input)');
			const filterStart = Date.now();
			await filterInput.fill(targetRunId);
			let narrowedIds = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));
			for (let i = 0; i < 40 && !(narrowedIds.length === 1 && narrowedIds[0] === targetRunId); i++) {
				await win.waitForTimeout(10);
				narrowedIds = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));
			}
			const filterMs = Date.now() - filterStart;
			assert(narrowedIds.length === 1 && narrowedIds[0] === targetRunId,
				`filtering to "${targetRunId}" left ${JSON.stringify(narrowedIds)} visible`);
			assert(filterMs <= 300, `filtering ${SCALE_LIST_RUN_COUNT} runs down to one took ${filterMs}ms, budget is <=300ms`);

			await filterInput.fill('');
			await win.waitForTimeout(300);

			return `first paint: ${SCALE_LIST_RUN_COUNT} runs in ${firstPaintMs}ms (budget <=500ms), full range confirmed newest-to-oldest via keyboard Home/End; `
				+ `filter: narrowed to 1 of ${SCALE_LIST_RUN_COUNT} in ${filterMs}ms (budget <=300ms)`;
		} finally {
			if (app5) { try { await app5.close(); } catch { /* best-effort cleanup */ } }
			try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(prof, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(exts, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			win = savedWin;
		}
	});

	// SCALE: expand a synthetic ~1000-agent run and measure how the listing path behaves at that size. The run's OWN
	// journal carries a `started` record for every one of its 1000 agents, so the identity join's per-agent check
	// genuinely reaches its FOURTH condition (does `agent-<id>.jsonl` exist as a sibling file) for each one - never
	// short-circuited earlier. Those 1000 sibling files are then never created AT ALL, and the run is asserted to
	// still read `complete` with all 1000 agent rows present and correctly labeled straight off the manifest.
	//
	// What that establishes, stated no more strongly than it holds: listing a run's agents does not DEPEND on the
	// transcript sidecars - every row's content comes off the manifest, and the run still reads whole with none of
	// them on disk. That is ALL it establishes. It is explicitly NOT a zero-transcript-reads proof, and completeness
	// is not the instrument that would catch one: a missing sidecar resolves the join to "no transcript ref" for that
	// agent WITHOUT marking the read degraded, so a read added on this path that swallowed its own file-not-found
	// would leave the run `complete` and pass this scenario unchanged. That the path performs no transcript BODY read
	// today is a source-level property of `resolveTranscriptRef` (claudeReaderSeamService.ts), which only ever calls
	// `fileService.exists()` against that path and never `readFile()`. A guard that could actually fail on a future
	// read would have to count reads at the file service rather than infer them from this output.
	await scenario('ultracode-workflows-scale-expand', true, async () => {
		const sandbox = mkdtempSync(join(tmpdir(), 'clawdius-e2e-scale-expand-sandbox-'));
		const prof = mkdtempSync(join(tmpdir(), 'clawdius-e2e-scale-expand-prof-'));
		const exts = mkdtempSync(join(tmpdir(), 'clawdius-e2e-scale-expand-exts-'));
		const savedWin = win;
		let app6;
		try {
			const runId = 'wf_scaleexpand';
			const sessionDir = join(sandbox, '.claude', 'projects', 'scale-expand', 'session-scale-expand');
			const workflowsDir = join(sessionDir, 'workflows');
			mkdirSync(workflowsDir, { recursive: true });
			writeFileSync(join(workflowsDir, `${runId}.json`), JSON.stringify(buildScaleExpandManifest()));
			// The run's own journal (required for the join's first three conditions - see buildScaleExpandJournal's
			// doc comment). Its agent sidecar files (agent-<id>.jsonl - the join's fourth condition, and the ONLY
			// thing a transcript drill-in ever reads) are deliberately never created.
			const journalDir = join(sessionDir, 'subagents', 'workflows', runId);
			mkdirSync(journalDir, { recursive: true });
			writeFileSync(join(journalDir, 'journal.jsonl'), buildScaleExpandJournal());

			app6 = await electron.launch({
				executablePath: join(REPO, '.build', 'electron', 'Clawdius.exe'),
				cwd: REPO,
				args: ['.', '--disable-extension=vscode.vscode-api-tests',
					`--user-data-dir=${prof}`, `--extensions-dir=${exts}`,
					'--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development', USERPROFILE: sandbox, HOME: sandbox },
				timeout: 120000,
			});
			win = await app6.firstWindow();
			await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
			await win.waitForTimeout(3000);
			await win.keyboard.press('Escape');
			await win.waitForTimeout(150);
			await runCommand('Focus on Claude Code Ultracode Workflows View');
			await win.waitForSelector('.clawdius-workflows-tree', { state: 'attached', timeout: 15000 });
			const rowSelector = `.clawdius-workflow-run-row[data-run-id="${runId}"]`;
			// No stated budget on reaching this point - only the EXPAND action itself (below) is budgeted. Listing
			// resolves the whole run (including every agent's transcript-join check) BEFORE the row ever paints, so
			// that cost is already sunk by the time this wait resolves; expand is then a pure tree operation.
			await win.waitForSelector(rowSelector, { state: 'attached', timeout: 60000 });

			const row = await win.$(rowSelector);
			const runKind = await row.getAttribute('data-run-kind');
			const completeness = await row.getAttribute('data-completeness');
			assert(runKind === 'terminal', `synthetic 1000-agent run rendered data-run-kind="${runKind}" (expected "terminal")`);
			assert(completeness === 'complete', `expected data-completeness="complete" with every transcript sidecar absent (see this scenario's doc comment for exactly what that does and does not establish), read "${completeness}"`);

			// --- expand: click + ArrowRight to the story leaf attaching - the <=500ms budget -------------------------
			const expandStart = Date.now();
			await row.scrollIntoViewIfNeeded();
			await row.click();
			await win.waitForTimeout(50);
			await win.keyboard.press('ArrowRight');
			let storyHandle = await win.waitForSelector('.clawdius-workflow-story', { state: 'attached', timeout: 5000 }).catch(() => null);
			if (!storyHandle) {
				const twistie = await row.$('.monaco-tl-twistie');
				if (twistie) {
					await twistie.click();
					storyHandle = await win.waitForSelector('.clawdius-workflow-story', { state: 'attached', timeout: 5000 }).catch(() => null);
				}
			}
			const expandMs = Date.now() - expandStart;
			assert(storyHandle, 'expanding the synthetic 1000-agent run never revealed a .clawdius-workflow-story leaf');
			assert(expandMs <= 500, `expanding the 1000-agent run took ${expandMs}ms, budget is <=500ms`);

			const costText = (await storyHandle.$eval('.clawdius-workflow-story-cost', el => el.textContent || '')) || '';
			assert(costText.includes(`${SCALE_EXPAND_AGENT_COUNT} agents`), `story leaf cost line did not report "${SCALE_EXPAND_AGENT_COUNT} agents" (sourced straight from the manifest's own agentCount field): "${costText}"`);

			const transcriptPanesAfterExpand = await win.$$('.clawdius-transcript');
			assert(transcriptPanesAfterExpand.length === 0, 'a .clawdius-transcript editor pane exists after expand alone - transcripts open only on an explicit drill-in');

			// --- the full 1000-row set materialized, not a truncated slice - keyboard End reaches the LAST row --------
			await win.keyboard.press('End');
			const lastAgentRow = await win.waitForSelector(`.clawdius-workflow-agent-row[data-agent-id="a${SCALE_EXPAND_AGENT_COUNT - 1}"]`, { state: 'attached', timeout: 15000 }).catch(() => null);
			assert(lastAgentRow, `the last agent row (a${SCALE_EXPAND_AGENT_COUNT - 1}) never appeared after jumping to the end of the expanded run`);
			const lastAgentState = await lastAgentRow.getAttribute('data-agent-state');
			assert(lastAgentState === 'done', `last agent row read data-agent-state="${lastAgentState}" (expected "done")`);
			const topAgentIdAtEnd = (await win.$$eval('.clawdius-workflow-agent-row', els => (els[0] ? els[0].getAttribute('data-agent-id') : undefined)));

			// --- baseline: this environment's OWN idle frame cadence, no scroll input driven at all - a strict <=16ms
			// budget is only meaningful against the TREE's behavior when the environment itself can sustain that
			// cadence at rest; never a weakened budget, but an honest SKIP when the display/compositor cannot hit
			// 60fps here regardless of page content, rather than attributing an environment ceiling to the tree.
			const baselineDeltas = await sampleAnimationFrameDeltas(1000);
			const baselineMedian = median(baselineDeltas.slice(2));

			// --- scroll: drive real wheel input over the expanded list while sampling rAF cadence ---------------------
			const treeBox = await win.$eval('.clawdius-workflows-tree', el => {
				const r = el.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			});
			await win.mouse.move(treeBox.x, treeBox.y);
			const SCROLL_SAMPLE_MS = 2500;
			const samplePromise = sampleAnimationFrameDeltas(SCROLL_SAMPLE_MS);
			const scrollDeadline = Date.now() + SCROLL_SAMPLE_MS;
			while (Date.now() < scrollDeadline) {
				await win.mouse.wheel(0, -240); // scroll back up through the 1000-row list, away from the End position
				await win.waitForTimeout(30);
			}
			const deltas = await samplePromise;
			const settled = deltas.slice(2); // drop the sampler's own leading start-up scheduling samples
			const frameMedian = median(settled);
			const frameMax = Math.max(...settled);
			const topAgentIdAfterScroll = (await win.$$eval('.clawdius-workflow-agent-row', els => (els[0] ? els[0].getAttribute('data-agent-id') : undefined)));
			assert(topAgentIdAfterScroll !== topAgentIdAtEnd, 'the visible agent rows never changed while scrolling - the scroll input did not reach the tree');

			const expandDetail = `expand: ${expandMs}ms (budget <=500ms); the enumeration stayed "complete" with all ${SCALE_EXPAND_AGENT_COUNT} `
				+ `agent-<id>.jsonl sidecars absent from disk, so listing a run's agents does not depend on reading them; `
				+ `last row "a${SCALE_EXPAND_AGENT_COUNT - 1}" reached via keyboard End`;

			// The scroll frame budget is reported as its OWN result. It is environment-dependent - an idle baseline
			// already above the budget means this machine cannot hold the cadence with nothing on screen - and
			// folding it into this scenario's verdict would let one unmeasurable budget mask the expand assertions
			// that DID run and pass.
			await scenario('ultracode-workflows-scale-scroll', false, async () => {
				if (baselineMedian > 16) {
					return `SKIPPED (not measurable here: the idle baseline is itself median ${baselineMedian.toFixed(2)}ms with nothing on screen, `
						+ `above the <=16ms budget - not attributable to the workflows tree); for reference: median ${frameMedian.toFixed(2)}ms / `
						+ `max ${frameMax.toFixed(2)}ms over ${settled.length} sampled frames`;
				}
				assert(frameMedian <= 16, `scroll median frame time ${frameMedian.toFixed(2)}ms exceeds the <=16ms budget (${settled.length} frames sampled; idle baseline was ${baselineMedian.toFixed(2)}ms)`);
				assert(frameMax <= 50, `scroll saw a frame of ${frameMax.toFixed(2)}ms, exceeding the <=50ms no-frame-over-budget (${settled.length} frames sampled)`);
				return `median ${frameMedian.toFixed(2)}ms / max ${frameMax.toFixed(2)}ms over ${settled.length} sampled frames (budgets <=16ms / <=50ms; idle baseline ${baselineMedian.toFixed(2)}ms)`;
			});

			return expandDetail;
		} finally {
			if (app6) { try { await app6.close(); } catch { /* best-effort cleanup */ } }
			try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(prof, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(exts, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			win = savedWin;
		}
	});

	// --- accessibility fixtures + proof ---------------------------------------------------------------------------

	function buildA11yFailedRunManifest() {
		return {
			workflowName: 'a11y-failed-run', summary: 'Accessibility fixture: one errored agent across two phases.',
			status: 'failed', timestamp: new Date().toISOString(), durationMs: 3000, totalTokens: 6000, totalToolCalls: 5,
			defaultModel: 'claude-opus-4-8[1m]',
			phases: [{ title: 'Analyze' }, { title: 'Report' }],
			workflowProgress: [
				{ type: 'workflow_agent', agentId: 'a1', label: 'analyzer', state: 'error', error: 'The analyzer crashed.', phaseIndex: 0, model: 'claude-opus-4-8[1m]', tokens: 2000, toolCalls: 2, durationMs: 1000 },
				{ type: 'workflow_agent', agentId: 'a2', label: 'reporter', state: 'done', phaseIndex: 1, model: 'claude-opus-4-8[1m]', tokens: 4000, toolCalls: 3, durationMs: 2000 },
			],
		};
	}

	function buildA11yLiveJournal() {
		return [
			JSON.stringify({ type: 'started', agentId: 'a1' }),
			JSON.stringify({ type: 'started', agentId: 'a2' }),
			JSON.stringify({ type: 'result', agentId: 'a1', result: 'Analysis complete.' }),
		].join('\n') + '\n';
	}

	const A11Y_GRADUATION_SUMMARY = 'Accessibility fixture graduation target';
	const A11Y_MOTION_SUMMARY = 'Accessibility fixture, motion-reduced graduation target';

	function buildA11yGraduationManifest() {
		return {
			workflowName: 'a11y-graduation-run', summary: A11Y_GRADUATION_SUMMARY, status: 'failed',
			timestamp: new Date().toISOString(), durationMs: 500, totalTokens: 1000, totalToolCalls: 1,
			defaultModel: 'claude-opus-4-8[1m]',
			workflowProgress: [{ type: 'workflow_agent', agentId: 'a1', label: 'grad-agent', state: 'done', model: 'claude-opus-4-8[1m]', tokens: 500, toolCalls: 1, durationMs: 500 }],
		};
	}

	/** The `.monaco-list-row` wrapper the tree's own accessibility renderer sets `aria-label` on - one level ABOVE
	 *  the row-kind renderer's own element (`.clawdius-workflow-run-row` etc.), the same wrapper/element
	 *  relationship the fork-chrome text scan earlier in this file already reasons about. */
	async function ariaLabelOf(handle) {
		return handle.evaluate(el => {
			const wrapper = el.closest('.monaco-list-row');
			return wrapper ? (wrapper.getAttribute('aria-label') || '') : '';
		});
	}

	/** Start recording EVERY announcement `IAccessibilityService.alert()` writes into the alternating
	 *  `.monaco-alert[role="alert"]` containers (base/browser/ui/aria/aria.ts). Reading the containers' CURRENT text
	 *  is not sufficient: there are only two and each new announcement OVERWRITES one, so any unrelated notification
	 *  landing between the moment under test and the read silently erases the evidence - a race that makes such a
	 *  check pass or fail on timing alone. Observing every mutation captures an announcement whether or not something
	 *  later overwrote it. Install this BEFORE triggering the moment under test. */
	async function startAlertRecorder() {
		await win.evaluate(() => {
			const seen = [];
			window.__clawdiusRecordedAlerts = seen;
			if (window.__clawdiusAlertObserver) { window.__clawdiusAlertObserver.disconnect(); }
			// Record from the MUTATION RECORDS, never by re-reading a container's current text: observer callbacks
			// are BATCHED, so two announcements landing in one batch would collapse to whichever wrote last. aria.ts
			// clears the container and appends a fresh text node per announcement, so each added node IS exactly one
			// announcement. Nothing already present is seeded either, so text sitting in a container BEFORE this
			// installs can never satisfy a later assertion - only announcements that actually fire afterwards count.
			const observer = new MutationObserver(records => {
				for (const record of records) {
					for (const node of record.addedNodes) {
						const text = (node.textContent || '').trim();
						if (text) { seen.push(text); }
					}
					if (record.type === 'characterData') {
						const text = (record.target.textContent || '').trim();
						if (text) { seen.push(text); }
					}
				}
			});
			window.__clawdiusAlertObserver = observer;
			for (const el of document.querySelectorAll('.monaco-alert')) {
				observer.observe(el, { childList: true, characterData: true, subtree: true });
			}
		});
	}

	/** Every announcement {@link startAlertRecorder} has captured since it was installed. */
	async function recordedAlertTexts() {
		return win.evaluate(() => window.__clawdiusRecordedAlerts || []);
	}

	/** Wait until the recorder has captured `expected`, then return everything captured (the full list makes a
	 *  failure legible - it shows exactly which announcements DID fire). */
	async function waitForRecordedAlert(expected) {
		await win.waitForFunction(exp => (window.__clawdiusRecordedAlerts || []).includes(exp), expected,
			{ timeout: 15000, polling: 100 }).catch(() => { });
		return recordedAlertTexts();
	}

	// ACCESSIBILITY: aria-label content per element kind (run status/errored-count, story, phase error-count, agent
	// state, live-progress ratio/activity), full keyboard-only operability (expand + drill-in, no mouse), aria
	// persisting under High Contrast, and - across a real live-to-terminal graduation - the row's aria-label
	// switching to the FRESH graduated state, focus staying on the same row, and the accessibility-service
	// announcement firing.
	await scenario('ultracode-workflows-accessibility', true, async () => {
		const sandbox = mkdtempSync(join(tmpdir(), 'clawdius-e2e-a11y-sandbox-'));
		const prof = mkdtempSync(join(tmpdir(), 'clawdius-e2e-a11y-prof-'));
		const exts = mkdtempSync(join(tmpdir(), 'clawdius-e2e-a11y-exts-'));
		const savedWin = win;
		let app7;
		try {
			const sessionDir = join(sandbox, '.claude', 'projects', 'a11y-fixtures', 'session-a11y');
			const workflowsDir = join(sessionDir, 'workflows');
			mkdirSync(workflowsDir, { recursive: true });
			writeFileSync(join(workflowsDir, 'wf_a11yfailed.json'), JSON.stringify(buildA11yFailedRunManifest()));

			const liveJournalDir = join(sessionDir, 'subagents', 'workflows', 'wf_a11ylive');
			mkdirSync(liveJournalDir, { recursive: true });
			writeFileSync(join(liveJournalDir, 'journal.jsonl'), buildA11yLiveJournal());

			const gradJournalDir = join(sessionDir, 'subagents', 'workflows', 'wf_a11ygrad');
			mkdirSync(gradJournalDir, { recursive: true });
			writeFileSync(join(gradJournalDir, 'journal.jsonl'), '{"type":"started","agentId":"a1"}\n');

			app7 = await electron.launch({
				executablePath: join(REPO, '.build', 'electron', 'Clawdius.exe'),
				cwd: REPO,
				args: ['.', '--disable-extension=vscode.vscode-api-tests',
					`--user-data-dir=${prof}`, `--extensions-dir=${exts}`,
					'--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development', USERPROFILE: sandbox, HOME: sandbox },
				timeout: 120000,
			});
			win = await app7.firstWindow();
			await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
			await win.waitForTimeout(6000);
			await focusWorkflowsView();
			// `focusWorkflowsView`'s own "reset scroll to top" step clicks the FIRST row to establish a
			// deterministic focus point - for a collapsible row that ALSO expands it here (this tree does not gate
			// expand-on-click to the twistie alone). The default newest-first sort pins live runs first by
			// identity, so that first row is `wf_a11ygrad` - collapse it immediately so exactly one row is expanded
			// at a time from here on, the same discipline the honest-edges scenario's own `collapse` helper
			// documents as required for the SHARED `expandRunAndGatherAgents`/`expandLiveRunProgress` helpers'
			// global `.clawdius-workflow-story` / `.clawdius-workflow-live-progress` lookups to stay unambiguous.
			const collapse = async row => { await row.click(); await win.keyboard.press('ArrowLeft'); await win.waitForTimeout(200); };
			const gradRowInitial = await win.$('.clawdius-workflow-run-row[data-run-id="wf_a11ygrad"]');
			if (gradRowInitial) { await collapse(gradRowInitial); }

			const results = {};

			// --- 1. aria labels: run status/errored-count, story, phase error-count, agent state ----------------------
			const failedRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_a11yfailed"]', { state: 'attached', timeout: 15000 });
			const failedRunAria = await ariaLabelOf(failedRow);
			assert(/failed/.test(failedRunAria) && /1 errored/.test(failedRunAria),
				`failed run's aria-label missing status/errored-count: "${failedRunAria}"`);

			const failedExpand = await expandRunAndGatherAgents(failedRow);
			assert(failedExpand.story, 'wf_a11yfailed did not reveal its story leaf');
			const storyAria = await ariaLabelOf(failedExpand.story);
			assert(storyAria.startsWith('Summary and result for'), `story leaf aria-label missing the expected prefix: "${storyAria}"`);

			const phaseRows = await win.$$('.clawdius-workflow-phase-row');
			assert(phaseRows.length === 2, `expected 2 phase rows for wf_a11yfailed, found ${phaseRows.length}`);
			const phaseArias = [];
			for (const p of phaseRows) { phaseArias.push(await ariaLabelOf(p)); }
			const erroredPhaseAria = phaseArias.find(a => /errors/.test(a));
			const cleanPhaseAria = phaseArias.find(a => !/errors/.test(a));
			assert(erroredPhaseAria && /Analyze/.test(erroredPhaseAria), `no phase aria-label named its error count: ${JSON.stringify(phaseArias)}`);
			assert(cleanPhaseAria && /Report/.test(cleanPhaseAria), `the error-free phase's aria-label unexpectedly mentioned errors: ${JSON.stringify(phaseArias)}`);

			assert(failedExpand.agentRows.length === 2, `expected 2 agent rows for wf_a11yfailed, found ${failedExpand.agentRows.length}`);
			const agentAriaById = {};
			for (const r of failedExpand.agentRows) {
				const id = await r.getAttribute('data-agent-id');
				agentAriaById[id] = await ariaLabelOf(r);
			}
			assert(/error/.test(agentAriaById['a1'] || ''), `errored agent a1's aria-label did not mention its state: "${agentAriaById['a1']}"`);
			assert(/done/.test(agentAriaById['a2'] || ''), `done agent a2's aria-label did not mention its state: "${agentAriaById['a2']}"`);
			results.ariaLabels = `run: "${failedRunAria}"; story: "${storyAria}"; phases: ${JSON.stringify(phaseArias)}; agents: ${JSON.stringify(agentAriaById)}`;
			await collapse(failedRow);

			// --- 2. live progress aria: ratio + activity captions ------------------------------------------------------
			// Reset to a deterministic top-of-list scroll position and re-query the row FRESH immediately before
			// interacting with it - the SAME defensive pattern the failure-surfacing scenario above uses when several
			// rows sit adjacent to each other in the virtualized tree, so a stale handle can never be clicked.
			await win.keyboard.press('Home');
			await win.waitForTimeout(200);
			const liveRow = await win.$('.clawdius-workflow-run-row[data-run-id="wf_a11ylive"]');
			assert(liveRow, 'wf_a11ylive run row not found at the top-of-list scroll position');
			const liveRowId = await liveRow.getAttribute('data-run-id');
			assert(liveRowId === 'wf_a11ylive', `resolved the wrong row before expanding: data-run-id="${liveRowId}"`);
			const liveProgress = await expandLiveRunProgress(liveRow);
			assert(liveProgress, 'wf_a11ylive did not reveal its live-progress leaf');
			const liveAria = await ariaLabelOf(liveProgress);
			assert(liveAria.includes('1 of 2 agents seen so far have a result') && liveAria.includes('Journal last wrote'),
				`live-progress aria-label missing the ratio/activity captions: "${liveAria}"`);
			results.liveProgressAria = liveAria;
			await collapse(liveRow);

			// --- 3. keyboard-only operability: Home, walk to the failed run, expand, drill in - no mouse used ----------
			await win.keyboard.press('Home');
			await win.waitForTimeout(150);
			let onTarget = false;
			for (let step = 0; step < 20 && !onTarget; step++) {
				const focusedRunId = await win.$eval('.monaco-list-row.focused .clawdius-workflow-run-row', el => el.getAttribute('data-run-id')).catch(() => undefined);
				if (focusedRunId === 'wf_a11yfailed') { onTarget = true; break; }
				await win.keyboard.press('ArrowDown');
				await win.waitForTimeout(60);
			}
			assert(onTarget, 'keyboard-only ArrowDown walk from Home never reached the wf_a11yfailed run row');
			await win.keyboard.press('ArrowRight'); // expand
			await win.waitForTimeout(300);
			await win.keyboard.press('ArrowDown'); // move focus onto the story leaf, the run's first child
			await win.waitForTimeout(150);
			await win.keyboard.press('Enter'); // drill in
			const detailPane = await win.waitForSelector('.clawdius-workflow-detail[data-clawdius-detail-kind="result"]', { state: 'attached', timeout: 8000 }).catch(() => null);
			assert(detailPane, 'keyboard-only navigation (Home, ArrowDown*, ArrowRight, ArrowDown, Enter) never opened the result detail pane');
			await closeActiveEditorTab();
			results.keyboardOnly = 'Home -> ArrowDown* -> ArrowRight (expand) -> ArrowDown -> Enter opened the result detail pane, no mouse used';

			// --- 4. High Contrast: the same aria-label content survives a theme change -----------------------------------
			await setThemeVerified('Clawdius High Contrast');
			await focusWorkflowsView();
			const hcRow = await win.waitForSelector('.clawdius-workflow-run-row[data-run-id="wf_a11yfailed"]', { state: 'attached', timeout: 15000 });
			const hcAria = await ariaLabelOf(hcRow);
			assert(hcAria === failedRunAria, `aria-label changed under High Contrast: "${failedRunAria}" -> "${hcAria}"`);
			const hcRows = await win.$$('.clawdius-workflow-run-row');
			assert(hcRows.length > 0, 'the tree rendered no rows under Clawdius High Contrast');
			await setThemeVerified('Clawdius Dark');
			await focusWorkflowsView();
			results.highContrast = `aria-label unchanged under High Contrast ("${hcAria}"); ${hcRows.length} rows rendered`;

			// --- 5. graduation: aria updates to the FRESH (terminal) state, alert fires, focus preserved -----------------
			const gradRowSelector = '.clawdius-workflow-run-row[data-run-id="wf_a11ygrad"]';
			const gradRow = await win.waitForSelector(gradRowSelector, { state: 'attached', timeout: 15000 });
			await gradRow.click();
			await win.waitForTimeout(200);
			const gradAriaLive = await ariaLabelOf(gradRow);
			assert(gradAriaLive.includes('in progress'), `live run's aria-label did not read "in progress" before graduation: "${gradAriaLive}"`);
			const focusedBefore = await win.$eval('.monaco-list-row.focused .clawdius-workflow-run-row', el => el.getAttribute('data-run-id')).catch(() => undefined);
			assert(focusedBefore === 'wf_a11ygrad', `expected wf_a11ygrad focused before graduation, DOM focus was on "${focusedBefore}"`);

			// Record announcements from BEFORE the graduation is triggered - the alert containers are overwritten by
			// any later announcement, so sampling them after the fact would pass or fail on timing alone.
			await startAlertRecorder();
			writeFileSync(join(workflowsDir, 'wf_a11ygrad.json'), JSON.stringify(buildA11yGraduationManifest()));
			await win.waitForFunction((sel) => {
				const row = document.querySelector(sel);
				return !!row && row.getAttribute('data-run-kind') === 'terminal';
			}, gradRowSelector, { timeout: 20000, polling: 300 });

			const gradRowAfter = await win.$(gradRowSelector);
			const gradAriaAfter = await ariaLabelOf(gradRowAfter);
			assert(gradAriaAfter.includes('failed') && !gradAriaAfter.includes('in progress'),
				`aria-label did not switch to the FRESH graduated (failed) state, still read: "${gradAriaAfter}"`);
			const focusedAfter = await win.$eval('.monaco-list-row.focused .clawdius-workflow-run-row', el => el.getAttribute('data-run-id')).catch(() => undefined);
			assert(focusedAfter === 'wf_a11ygrad', `focus was not preserved across graduation - the focused row read "${focusedAfter}"`);

			const expectedAlert = `Workflow run ${A11Y_GRADUATION_SUMMARY} failed.`;
			const alertTexts = await waitForRecordedAlert(expectedAlert);
			assert(alertTexts.includes(expectedAlert), `no announcement carried the expected graduation text "${expectedAlert}"; recorded: ${JSON.stringify(alertTexts)}`);
			results.graduation = `aria-label "in progress" -> "${gradAriaAfter}"; focus preserved on the same row; alert fired: "${expectedAlert}"`;

			return Object.entries(results).map(([k, v]) => `${k}: ${v}`).join(' | ');
		} finally {
			if (app7) { try { await app7.close(); } catch { /* best-effort cleanup */ } }
			try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(prof, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(exts, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			win = savedWin;
		}
	});

	// ACCESSIBILITY (reduced motion): the announcement still fires and the transient graduation highlight class
	// never applies, with `workbench.reduceMotion` seeded directly into the profile's settings BEFORE launch (the
	// same seed-before-boot approach the pre-rename transcript-editor-state seed above uses, rather than driving
	// the Settings UI).
	await scenario('ultracode-workflows-accessibility-reduced-motion', true, async () => {
		const sandbox = mkdtempSync(join(tmpdir(), 'clawdius-e2e-a11y-motion-sandbox-'));
		const prof = mkdtempSync(join(tmpdir(), 'clawdius-e2e-a11y-motion-prof-'));
		const exts = mkdtempSync(join(tmpdir(), 'clawdius-e2e-a11y-motion-exts-'));
		const savedWin = win;
		let app8;
		try {
			const sessionDir = join(sandbox, '.claude', 'projects', 'a11y-motion', 'session-a11y-motion');
			const workflowsDir = join(sessionDir, 'workflows');
			const journalDir = join(sessionDir, 'subagents', 'workflows', 'wf_a11ymotion');
			mkdirSync(workflowsDir, { recursive: true });
			mkdirSync(journalDir, { recursive: true });
			writeFileSync(join(journalDir, 'journal.jsonl'), '{"type":"started","agentId":"a1"}\n');

			const settingsDir = join(prof, 'User');
			mkdirSync(settingsDir, { recursive: true });
			writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ 'workbench.reduceMotion': 'on' }, null, 2));

			app8 = await electron.launch({
				executablePath: join(REPO, '.build', 'electron', 'Clawdius.exe'),
				cwd: REPO,
				args: ['.', '--disable-extension=vscode.vscode-api-tests',
					`--user-data-dir=${prof}`, `--extensions-dir=${exts}`,
					'--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development', USERPROFILE: sandbox, HOME: sandbox },
				timeout: 120000,
			});
			win = await app8.firstWindow();
			await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
			await win.waitForTimeout(6000);
			await focusWorkflowsView();

			const rowSelector = '.clawdius-workflow-run-row[data-run-id="wf_a11ymotion"]';
			const row = await win.waitForSelector(rowSelector, { state: 'attached', timeout: 15000 });
			await row.click();
			await win.waitForTimeout(200);

			// Record announcements from BEFORE the graduation is triggered - see startAlertRecorder.
			await startAlertRecorder();
			writeFileSync(join(workflowsDir, 'wf_a11ymotion.json'), JSON.stringify({
				workflowName: 'a11y-motion-run', summary: A11Y_MOTION_SUMMARY, status: 'completed',
				timestamp: new Date().toISOString(), durationMs: 200, totalTokens: 400, totalToolCalls: 1,
				defaultModel: 'claude-opus-4-8[1m]',
				workflowProgress: [{ type: 'workflow_agent', agentId: 'a1', label: 'motion-agent', state: 'done', model: 'claude-opus-4-8[1m]', tokens: 400, toolCalls: 1, durationMs: 200 }],
			}));
			await win.waitForFunction((sel) => {
				const r = document.querySelector(sel);
				return !!r && r.getAttribute('data-run-kind') === 'terminal';
			}, rowSelector, { timeout: 20000, polling: 300 });

			const expectedAlert = `Workflow run ${A11Y_MOTION_SUMMARY} finished.`;
			const alertTexts = await waitForRecordedAlert(expectedAlert);
			assert(alertTexts.includes(expectedAlert), `the announcement must not be skipped under reduced motion; expected "${expectedAlert}", recorded: ${JSON.stringify(alertTexts)}`);

			const graduatedRow = await win.$(rowSelector);
			const rowClass = await graduatedRow.evaluate(el => el.className);
			assert(!/clawdius-workflow-graduated/.test(rowClass), `the transient graduation highlight class was applied under reduced motion: "${rowClass}"`);
			await win.waitForTimeout(2000); // past the highlight window a non-reduced-motion run would have used - still must never appear
			const rowClassLater = await graduatedRow.evaluate(el => el.className);
			assert(!/clawdius-workflow-graduated/.test(rowClassLater), `the graduation highlight class appeared after a delay under reduced motion: "${rowClassLater}"`);

			return `the announcement fired ("${expectedAlert}") with reduced motion on; the transient highlight class never applied`;
		} finally {
			if (app8) { try { await app8.close(); } catch { /* best-effort cleanup */ } }
			try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(prof, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			try { rmSync(exts, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
			win = savedWin;
		}
	});

	// 9. Find/sort against the REAL config root: typing into the persistent filter InputBox narrows the visible
	// rows to an exact run id (the filter matches a run's OWN runId, so this is a deterministic, always-findable
	// needle - never a synthetic fixture), measured against the ~300ms budget; switching the sort SelectBox to
	// "status" then REORDERS the visible rows using real completed/failed/live classification already painted by
	// the existing run-row renderer (data-run-kind + the status icon's status-* class - no new instrumentation
	// needed here); repeating the same selection reproduces the IDENTICAL order, proving the mode's order is
	// deterministic on real data, not merely non-empty. SKIPs+WARNs (never a false pass) when the real corpus is
	// empty - the same posture every sibling real-corpus scenario in this file takes.
	await scenario('ultracode-workflows-find-sort', true, async () => {
		await focusWorkflowsView();

		const beforeRows = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));
		if (beforeRows.length === 0) {
			return 'SKIPPED (no workflow runs on this config root - nothing to filter or sort)';
		}
		const targetRunId = beforeRows[0];

		// --- filter: narrow to exactly the one run carrying this (unique) run id -----------------------------------
		const filterInput = await win.$('.clawdius-workflows-filter input');
		assert(filterInput, 'the persistent filter InputBox did not render (.clawdius-workflows-filter input)');
		await filterInput.fill(targetRunId);
		const typedAt = Date.now();

		let narrowedIds = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));
		for (let i = 0; i < 30 && !(narrowedIds.length > 0 && narrowedIds.every(id => id === targetRunId)); i++) {
			await win.waitForTimeout(25);
			narrowedIds = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));
		}
		const settleMs = Date.now() - typedAt;
		assert(narrowedIds.length > 0, `typing the exact run id "${targetRunId}" into the filter left ZERO rows visible`);
		assert(narrowedIds.every(id => id === targetRunId),
			`the filter did not narrow to only "${targetRunId}": visible ids = ${JSON.stringify(narrowedIds)}`);
		assert(narrowedIds.length < beforeRows.length || beforeRows.length === 1,
			`the filter matched ${narrowedIds.length} row(s) but the unfiltered view already showed only ${beforeRows.length}`);

		// --- clear the filter, restore the full (unfiltered, still recency-sorted) list ---------------------------
		await filterInput.fill('');
		await win.waitForTimeout(400);
		let restoredIds = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));
		for (let i = 0; i < 20 && restoredIds.length < beforeRows.length; i++) {
			await win.waitForTimeout(25);
			restoredIds = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));
		}
		const firstRestoredRow = await win.$('.clawdius-workflow-run-row');
		if (firstRestoredRow) { await firstRestoredRow.click(); await win.keyboard.press('Home'); await win.waitForTimeout(200); }
		const beforeSortIds = await win.$$eval('.clawdius-workflow-run-row', els => els.map(el => el.getAttribute('data-run-id')));

		// --- sort: switch to "status" (failed before completed, live always first) and prove a REAL reorder --------
		const sortSelect = await win.$('.clawdius-workflows-sort select');
		assert(sortSelect, 'the sort SelectBox did not render (.clawdius-workflows-sort select)');
		const readVisible = () => win.$$eval('.clawdius-workflow-run-row', els => els.map(el => ({
			runId: el.getAttribute('data-run-id'),
			runKind: el.getAttribute('data-run-kind'),
			statusClass: el.querySelector('.clawdius-workflow-status-icon')?.className || '',
		})));

		await win.selectOption('.clawdius-workflows-sort select', { label: 'Sort: Failed First' });
		await win.waitForTimeout(300);
		const afterStatusSort = await readVisible();
		assert(afterStatusSort.length > 0, 'switching to the "status" sort mode left ZERO rows visible');

		// Real-data invariants: live pinned first, then no `status-failed` row after a `status-completed` one.
		let sawNonLive = false;
		let sawCompleted = false;
		const violations = [];
		for (const row of afterStatusSort) {
			if (row.runKind === 'live') {
				if (sawNonLive) { violations.push(`live run "${row.runId}" appeared after a non-live row`); }
				continue;
			}
			sawNonLive = true;
			const isFailed = /\bstatus-failed\b/.test(row.statusClass);
			const isCompleted = /\bstatus-completed\b/.test(row.statusClass);
			if (isCompleted) { sawCompleted = true; }
			if (isFailed && sawCompleted) { violations.push(`failed run "${row.runId}" appeared after a completed row`); }
		}
		assert(violations.length === 0, `status-sort ordering violated on real data: ${JSON.stringify(violations)}`);

		const afterIds = afterStatusSort.map(r => r.runId);
		const reordered = JSON.stringify(afterIds) !== JSON.stringify(beforeSortIds);

		// --- determinism: switch away and back to "status" must reproduce the EXACT same order on the same data ----
		await win.selectOption('.clawdius-workflows-sort select', { label: 'Sort: Newest First' });
		await win.waitForTimeout(300);
		await win.selectOption('.clawdius-workflows-sort select', { label: 'Sort: Failed First' });
		await win.waitForTimeout(300);
		const secondStatusSort = await readVisible();
		const secondIds = secondStatusSort.map(r => r.runId);
		assert(JSON.stringify(secondIds) === JSON.stringify(afterIds),
			`the "status" sort mode produced a DIFFERENT order on a repeat selection over the same data: ${JSON.stringify(afterIds)} vs ${JSON.stringify(secondIds)}`);

		// Leave the view in its default state for whichever scenario runs next.
		await win.selectOption('.clawdius-workflows-sort select', { label: 'Sort: Newest First' });
		await win.waitForTimeout(200);

		return `filter: run id "${targetRunId}" narrowed ${beforeRows.length} -> ${narrowedIds.length} visible row(s) in ~${settleMs}ms (target ~300ms budget); `
			+ `sort: switching to "status" ${reordered ? 'reordered' : 'left the order unchanged (already status-ordered)'} `
			+ `${afterStatusSort.length} visible row(s) - live-first and failed-before-completed held on real data, and a repeat selection reproduced the identical order`;
	});

	// 10-11. Themes - switch + screenshot the status bar to eyeball the safety-pill contrast fix
	await scenario('theme-clawdius-dark', false, async () => { await setTheme('Clawdius Dark'); return 'set'; });
	await scenario('theme-clawdius-light', false, async () => { await setTheme('Clawdius Light'); return 'set'; });
	// restore dark
	await setTheme('Clawdius Dark');

	if (KEEP_OPEN) { console.log('\n--keep-open: leaving the window up. Ctrl+C to exit.'); await win.waitForTimeout(600000); }
} finally {
	writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
	const fails = results.filter(r => !r.ok && r.critical);
	const warns = results.filter(r => !r.ok && !r.critical);
	const skips = results.filter(r => r.skipped);
	const passes = results.filter(r => r.ok && !r.skipped);
	console.log(`\n=== ${results.length} scenarios: ${passes.length} pass, ${skips.length} skipped, ${fails.length} critical-fail, ${warns.length} warn ===`);
	console.log(`screenshots + report.json in ${OUT}`);
	if (!KEEP_OPEN) { await app.close(); }
	process.exitCode = fails.length ? 1 : 0;
}
