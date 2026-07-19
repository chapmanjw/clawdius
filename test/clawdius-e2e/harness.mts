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
	await scenario('ultracode-workflows-sidebar', true, async () => {
		// Open via the view's auto-registered focus command. `registerFocusViewAction` derives its title
		// from the view descriptor's name ("Focus on {0} View"), so this string is the one the palette
		// actually offers post-rename - an invented title would fuzzy-match some other command and
		// silently leave the view closed, which would then read as a view defect rather than a broken test.
		await runCommand('Focus on Claude Code Ultracode Workflows View');
		// Distinguish "the view never opened" (a test-harness fault) from "the view opened and painted
		// nothing" (a real defect). Without this the two collapse into one indistinguishable failure.
		await win.waitForSelector('[data-clawdius-workflows]', { state: 'attached', timeout: 15000 });
		await win.waitForTimeout(2500);

		// No FORK-AUTHORED "Mission(s)" text may remain after the rename. Scan the workbench for the whole
		// word "mission" but skip only the USER-DATA leaves the reader surfaces verbatim - the run name
		// (.clawdius-workflows-run), the run error (.clawdius-workflows-error), and expanded subagent rows
		// (.clawdius-workflows-subagent) - since a run a user named "build-mission-rail" is content, not a
		// rename regression. Everything else stays in scope, INCLUDING the fork's own per-row labels
		// ("status:", "agents:", ...), so a label that regressed to "Mission" is still caught. title/aria-label
		// are checked only OUTSIDE the rows (a row tooltip can legitimately embed the user's run name).
		const userDataSel = '.clawdius-workflows-run, .clawdius-workflows-error, .clawdius-workflows-subagent';
		const missionChromeHits = await win.$$eval('.monaco-workbench *', (els, userSel) => {
			const rx = /\bmissions?\b/i;
			const out = [];
			for (const el of els) {
				const label = (typeof el.className === 'string' && el.className) ? el.className : el.tagName;
				if (!el.closest(userSel)) {
					const t = el.childElementCount === 0 ? (el.textContent || '') : '';
					if (rx.test(t)) { out.push('text ' + label + ' :: ' + t.trim().slice(0, 80)); }
				}
				if (!el.closest('.clawdius-workflows-row')) {
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

		const rows = await win.$$eval('.clawdius-workflows-row', els => els.map(el => ({
			name: el.getAttribute('data-workflow-name'),
			status: el.getAttribute('data-status'),
			kind: el.getAttribute('data-kind'),
			agents: el.getAttribute('data-agent-count'),
			completeness: el.getAttribute('data-completeness'),
		})));
		if (rows.length === 0) {
			// An honest empty state is a legitimate outcome (no workflows on this machine), not a pass.
			const empty = await win.$$('[data-clawdius-workflows-empty]');
			assert(empty.length === 1, 'Workflows rendered neither rows nor an empty state');
			return 'no workflow runs on this config root (honest empty state); no Missions text; icon painted';
		}
		// Every row must be a workflow, never a chat session.
		const notWorkflow = rows.filter(r => r.kind !== 'workflow');
		assert(notWorkflow.length === 0, `${notWorkflow.length} rows are not workflows`);
		// Every row must be NAMED: the pre-fix view showed opaque run ids.
		const unnamed = rows.filter(r => !r.name);
		assert(unnamed.length === 0, `${unnamed.length} workflow runs rendered without a name`);
		// The status label must carry information. The pre-fix bug was a constant.
		const statuses = [...new Set(rows.map(r => r.status))];
		assert(!(statuses.length === 1 && statuses[0] === 'unknown'), 'every workflow run reads status=unknown (the label is a constant)');
		// The completeness ladder must not be pinned to `partial` for every row.
		const completeness = [...new Set(rows.map(r => r.completeness))];
		assert(!(completeness.length === 1 && completeness[0] === 'partial'), 'every workflow run reads completeness=partial (the ladder collapsed)');
		return `${rows.length} workflow runs; statuses=${statuses.join('/')}; completeness=${completeness.join('/')}; e.g. "${rows[0].name}" (${rows[0].agents} agents); no Missions text; icon painted`;
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
