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
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
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
	await runCommand('Focus on Claude Code Ultracode Workflows View');
	await win.waitForSelector('.clawdius-workflows-tree', { state: 'attached', timeout: 15000 });
	await win.waitForFunction(
		() => document.querySelector('.clawdius-workflow-run-row') !== null || document.querySelector('[data-clawdius-workflows-state]') !== null,
		undefined, { timeout: 60000 },
	);
	await win.waitForTimeout(300);
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
		// disk read+validate of the REAL config root - on this machine that is ~1200+ runs, not a synthetic
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
		// run a user named "build-mission-rail" is content, not a rename regression. Everything else stays in
		// scope, INCLUDING the fork's own chrome (chips, state messages, the surface label), so a label that
		// regressed to "Mission" is still caught. title/aria-label are checked only OUTSIDE the run rows (a
		// row tooltip can legitimately embed the user's run name).
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
				if (!el.closest('.clawdius-workflow-run-row')) {
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
			// An honest empty state is a legitimate outcome (no workflows on this machine), not a pass. The
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
