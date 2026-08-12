/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootDir = path.resolve(import.meta.dirname, '..', '..');

function runProcess(command: string, args: ReadonlyArray<string> = []) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
		child.on('exit', err => !err ? resolve() : process.exit(err ?? 1));
		child.on('error', reject);
	});
}

async function exists(subdir: string) {
	try {
		await fs.stat(path.join(rootDir, subdir));
		return true;
	} catch {
		return false;
	}
}

async function ensureNodeModules() {
	if (!(await exists('node_modules'))) {
		await runProcess(npm, ['ci']);
	}
}

async function getElectron() {
	// `npm run electron` deletes and re-downloads `.build/electron` on every
	// invocation. When preLaunch runs repeatedly (e.g. once per integration test
	// section) this is both wasteful and a source of flaky failures on Windows,
	// where the just-exited Electron process can still hold file locks while the
	// directory is being removed and re-extracted. Skip the refresh when the
	// already-present Electron matches the expected version; any detection
	// failure falls back to a (re)download to preserve the previous behavior.
	if (await isExpectedElectronInstalled()) {
		return;
	}
	await runProcess(npm, ['run', 'electron']);
}

async function isExpectedElectronInstalled(): Promise<boolean> {
	try {
		const { getElectronVersion } = await import('./util.ts');
		const { electronVersion } = getElectronVersion();
		const installedVersion = (await fs.readFile(path.join(rootDir, '.build', 'electron', 'version'), 'utf8')).trim().replace(/^v/, '');
		return installedVersion === electronVersion;
	} catch {
		return false;
	}
}

async function ensureCompiled() {
	if (!(await exists('out'))) {
		await runProcess(npm, ['run', 'compile']);
	}
}

// CLAWDIUS-BEGIN restore node-pty's conpty binaries if a rebuild dropped them
// node-pty ships conpty.dll + OpenConsole.exe under third_party/ and its own postinstall copies them into
// build/Release/conpty/. Rebuilding the native modules directly (node-gyp rebuild / npm rebuild) regenerates
// the .node files WITHOUT re-running that postinstall, so the directory silently disappears. Nothing notices
// until you open a terminal and get "Cannot find conpty.dll ... error code: 3", which reads like a broken
// install rather than a missing post-install step. Checked here because you always launch after rebuilding.
async function ensureConptyBinaries() {
	if (process.platform !== 'win32') {
		return;
	}
	const ptyDir = path.join(rootDir, 'node_modules', 'node-pty');
	const postInstall = path.join(ptyDir, 'scripts', 'post-install.js');
	if (!(await exists(path.join('node_modules', 'node-pty', 'build', 'Release'))) || !(await exists(path.join('node_modules', 'node-pty', 'scripts', 'post-install.js')))) {
		return; // node-pty absent or laid out differently - leave it to the normal install path
	}
	if (await exists(path.join('node_modules', 'node-pty', 'build', 'Release', 'conpty', 'conpty.dll'))) {
		return;
	}
	console.log('node-pty is missing its conpty binaries (a rebuild dropped them); re-running its post-install');
	// Spawned WITHOUT a shell on purpose: runProcess() sets shell:true on Windows, and process.execPath is
	// normally "C:\Program Files\nodejs\node.exe", which the shell splits at the space ("'C:\Program' is not
	// recognized"). The guard would then report the problem and fail to fix it.
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [postInstall], { cwd: ptyDir, stdio: 'inherit', env: process.env, shell: false });
		child.on('exit', code => code ? reject(new Error(`node-pty post-install exited with ${code}`)) : resolve());
		child.on('error', reject);
	});
}
// CLAWDIUS-END

async function main() {
	await ensureNodeModules();
	await getElectron();
	await ensureConptyBinaries();
	await ensureCompiled();

	// Can't require this until after dependencies are installed
	const { getBuiltInExtensions } = await import('./builtInExtensions.ts');
	await getBuiltInExtensions();
}

if (import.meta.main) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
