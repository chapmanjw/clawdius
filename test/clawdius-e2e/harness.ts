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
// Run:            `node test/clawdius-e2e/harness.mjs`   (from the repo root; needs a display)
// Options:        `--out <dir>` (screenshot dir, default .build/clawdius-e2e)
//                 `--keep-open` (leave the window open at the end for manual poking)
//                 `--grep <substr>` (run only scenarios whose name contains <substr>)
//
// Exit code is non-zero if any scenario marked `critical` fails. See README.md for the full
// replay-step catalogue.

import { _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
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
	const rec = { name, critical, ok: false, detail: '', screenshot: '' };
	try {
		rec.detail = (await fn()) || 'ok';
		rec.ok = true;
	} catch (err) {
		rec.detail = (err && err.message) || String(err);
	}
	rec.screenshot = await shot(name);
	results.push(rec);
	console.log(`${rec.ok ? 'PASS' : (critical ? 'FAIL' : 'WARN')}  ${name}  -  ${rec.detail}`);
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

// --- launch ----------------------------------------------------------------------------------

const prof = mkdtempSync(join(tmpdir(), 'clawdius-e2e-prof-'));
const exts = mkdtempSync(join(tmpdir(), 'clawdius-e2e-exts-'));
console.log('repo:', REPO, '\nout :', OUT, '\nprofile:', prof, '\n');

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
		return `${rows.length} Clawdius commands listed`;
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

	// 4b. Missions sidebar: the ultracode workflow control surface, driven against the REAL config root.
	// This is the one scenario no unit test can stand in for. The suite's fixtures are synthetic by
	// construction, and CI runners have no ~/.claude at all, so only a real boot proves what a user sees:
	// that rows are named workflow runs carrying a real status - not chat sessions all reading
	// "status: unknown / completeness: partial", which is what the pre-fix view painted for all 1200 of them.
	await scenario('missions-sidebar', true, async () => {
		// Open via the view's auto-registered focus command. `registerFocusViewAction` derives its title from the
		// view descriptor's name ("Focus on {0} View"), so this string is the one the palette actually offers -
		// an invented title would fuzzy-match some other command and silently leave the view closed, which would
		// then read as a view defect rather than a broken test.
		await runCommand('Focus on Claude Code Missions View');
		// Distinguish "the view never opened" (a test-harness fault) from "the view opened and painted nothing"
		// (a real defect). Without this the two collapse into one indistinguishable failure.
		await win.waitForSelector('[data-clawdius-missions]', { state: 'attached', timeout: 15000 });
		await win.waitForTimeout(2500);
		const rows = await win.$$eval('.clawdius-missions-row', els => els.map(el => ({
			name: el.getAttribute('data-mission-name'),
			status: el.getAttribute('data-status'),
			kind: el.getAttribute('data-kind'),
			agents: el.getAttribute('data-agent-count'),
			completeness: el.getAttribute('data-completeness'),
		})));
		if (rows.length === 0) {
			// An honest empty state is a legitimate outcome (no workflows on this machine), not a pass.
			const empty = await win.$$('[data-clawdius-missions-empty]');
			assert(empty.length === 1, 'Missions rendered neither rows nor an empty state');
			return 'no missions on this config root (honest empty state)';
		}
		// Every row must be a workflow, never a chat session.
		const notWorkflow = rows.filter(r => r.kind !== 'workflow');
		assert(notWorkflow.length === 0, `${notWorkflow.length} rows are not workflows`);
		// Every row must be NAMED: the pre-fix view showed opaque run ids.
		const unnamed = rows.filter(r => !r.name);
		assert(unnamed.length === 0, `${unnamed.length} missions rendered without a name`);
		// The status label must carry information. The pre-fix bug was a constant.
		const statuses = [...new Set(rows.map(r => r.status))];
		assert(!(statuses.length === 1 && statuses[0] === 'unknown'), 'every mission reads status=unknown (the label is a constant)');
		// The completeness ladder must not be pinned to `partial` for every row.
		const completeness = [...new Set(rows.map(r => r.completeness))];
		assert(!(completeness.length === 1 && completeness[0] === 'partial'), 'every mission reads completeness=partial (the ladder collapsed)');
		return `${rows.length} missions; statuses=${statuses.join('/')}; completeness=${completeness.join('/')}; e.g. "${rows[0].name}" (${rows[0].agents} agents)`;
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
	console.log(`\n=== ${results.length} scenarios: ${results.filter(r => r.ok).length} pass, ${fails.length} critical-fail, ${warns.length} warn ===`);
	console.log(`screenshots + report.json in ${OUT}`);
	if (!KEEP_OPEN) { await app.close(); }
	process.exitCode = fails.length ? 1 : 0;
}
