/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import minimatch from 'minimatch';
import { makeUniversalApp } from 'vscode-universal-bundler';

const root = path.dirname(path.dirname(import.meta.dirname));

const nodeModulesBases = [
	path.join('Contents', 'Resources', 'app', 'node_modules'),
	path.join('Contents', 'Resources', 'app', 'node_modules.asar.unpacked')
];

/**
 * Ensures a directory exists in both the x64 and arm64 app bundles by copying
 * it from whichever build has it to the one that does not. This is needed for
 * platform-specific native module directories that npm only installs for the
 * host architecture.
 */
function crossCopyPlatformDir(x64AppPath: string, arm64AppPath: string, relativePath: string): void {
	const inX64 = path.join(x64AppPath, relativePath);
	const inArm64 = path.join(arm64AppPath, relativePath);

	if (fs.existsSync(inX64) && !fs.existsSync(inArm64)) {
		fs.mkdirSync(inArm64, { recursive: true });
		fs.cpSync(inX64, inArm64, { recursive: true });
	} else if (fs.existsSync(inArm64) && !fs.existsSync(inX64)) {
		fs.mkdirSync(inX64, { recursive: true });
		fs.cpSync(inArm64, inX64, { recursive: true });
	}
}

async function main(buildDir?: string) {
	const arch = process.env['VSCODE_ARCH'];

	if (!buildDir) {
		throw new Error('Build dir not provided');
	}

	const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
	const appName = product.nameLong + '.app';
	const x64AppPath = path.join(buildDir, 'VSCode-darwin-x64', appName);
	const arm64AppPath = path.join(buildDir, 'VSCode-darwin-arm64', appName);
	const asarRelativePath = path.join('Contents', 'Resources', 'app', 'node_modules.asar');
	const outAppPath = path.join(buildDir, `VSCode-darwin-${arch}`, appName);
	const productJsonPath = path.resolve(outAppPath, 'Contents', 'Resources', 'app', 'product.json');

	// @vscode/ripgrep-universal ships per-platform native binaries, but the
	// per-arch packaging step (getRipgrepExcludeFilter) keeps only the target
	// platform's binary in each build. The universal app merger requires both
	// builds to have identical file trees, so we cross-copy each missing
	// directory from the other build. The binaries are then excluded from
	// comparison (filesToSkip) and the x64 binary is tagged as arch-specific
	// (x64ArchFiles) so the merger keeps both.
	for (const plat of ['darwin-x64', 'darwin-arm64']) {
		for (const base of nodeModulesBases) {
			// @vscode/os-proxy-resolver-{platform} packages
			crossCopyPlatformDir(x64AppPath, arm64AppPath, path.join(base, '@vscode', `os-proxy-resolver-${plat}`));
			// @vscode/ripgrep-universal/bin/{platform} (rg binary)
			crossCopyPlatformDir(x64AppPath, arm64AppPath, path.join(base, '@vscode', 'ripgrep-universal', 'bin', plat));
		}
	}

	for (const base of nodeModulesBases) {
		for (const mxcArch of ['x64', 'arm64']) {
			crossCopyPlatformDir(x64AppPath, arm64AppPath, path.join(base, '@microsoft', 'mxc-sdk', 'bin', mxcArch));
		}
	}

	const filesToSkip = [
		'**/CodeResources',
		'**/Credits.rtf',
		'**/policies/{*.mobileconfig,**/*.plist}',
		'**/node_modules/@vscode/os-proxy-resolver-darwin-x64/**',
		'**/node_modules/@vscode/os-proxy-resolver-darwin-arm64/**',
		'**/node_modules.asar.unpacked/@vscode/os-proxy-resolver-darwin-x64/**',
		'**/node_modules.asar.unpacked/@vscode/os-proxy-resolver-darwin-arm64/**',
		'**/node_modules/@vscode/ripgrep-universal/bin/darwin-x64/**',
		'**/node_modules/@vscode/ripgrep-universal/bin/darwin-arm64/**',
		'**/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-x64/**',
		'**/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/**',
		// @microsoft/mxc-sdk ships per-arch native binaries under bin/<arch>;
		// the package includes both arm64 and x64 trees regardless of host arch.
		'**/node_modules/@microsoft/mxc-sdk/bin/**',
		'**/node_modules.asar.unpacked/@microsoft/mxc-sdk/bin/**',
		// @vscode/fs-copyfile ships a prebuilt native binary that is byte-identical across arches.
		'**/node_modules/@vscode/fs-copyfile/build/Release/*.node',
		'**/node_modules.asar.unpacked/@vscode/fs-copyfile/build/Release/*.node',
		// @parcel/watcher likewise ships a native binary identical across arches.
		'**/node_modules/@parcel/watcher/build/Release/*.node',
		'**/node_modules.asar.unpacked/@parcel/watcher/build/Release/*.node',
		// @vscode/deviceid ships per-platform prebuilds (incl. windows.node) identical across mac arches.
		'**/node_modules/@vscode/deviceid/build/Release/*.node',
		'**/node_modules.asar.unpacked/@vscode/deviceid/build/Release/*.node',
		// @vscode/native-watchdog reports byte-identical across arches as well.
		'**/node_modules/@vscode/native-watchdog/build/Release/*.node',
		'**/node_modules.asar.unpacked/@vscode/native-watchdog/build/Release/*.node',
		// @vscode/policy-watcher: same again.
		'**/node_modules/@vscode/policy-watcher/build/Release/*.node',
		'**/node_modules.asar.unpacked/@vscode/policy-watcher/build/Release/*.node',
		// onnxruntime-node (on-device transcription) ships a darwin/arm64 binary
		// but not darwin/x64; the x64 build strips the entire bin/ tree. The
		// universal merger sees bin/ as unique to arm64 — skip it.
		'**/node_modules/onnxruntime-node/bin/**',
		'**/node_modules.asar.unpacked/onnxruntime-node/bin/**',
	];

	await makeUniversalApp({
		x64AppPath,
		arm64AppPath,
		asarPath: asarRelativePath,
		outAppPath,
		force: true,
		mergeASARs: true,
		// Files that are unique to a single arch *inside* the merged `node_modules.asar`.
		// Their on-disk (unpacked) copies are cross-copied between builds above, but the
		// ASAR header still only references the target arch's package, so the merger sees
		// them as arch-unique. Paths here are ASAR-internal (top level, no `node_modules`
		// prefix). Over-covering is harmless: the allowlist is only consulted for files
		// that are actually unique to one arch.
		singleArchFiles: '{**/@vscode/ripgrep-universal/bin/darwin-*,**/@vscode/ripgrep-universal/bin/darwin-*/**,**/@vscode/os-proxy-resolver-darwin-*,**/@vscode/os-proxy-resolver-darwin-*/**,**/@microsoft/mxc-sdk/bin/*,**/@microsoft/mxc-sdk/bin/*/**,**/onnxruntime-node/bin,**/onnxruntime-node/bin/**}',
		x64ArchFiles: '{*/kerberos.node,**/extensions/microsoft-authentication/dist/libmsalruntime.dylib,**/extensions/microsoft-authentication/dist/msal-node-runtime.node,**/node_modules/@vscode/ripgrep-universal/bin/darwin-*/*,**/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-*/*,**/node_modules/@vscode/os-proxy-resolver-darwin-*/**,**/node_modules.asar.unpacked/@vscode/os-proxy-resolver-darwin-*/**,**/node_modules/@microsoft/mxc-sdk/bin/**,**/node_modules.asar.unpacked/@microsoft/mxc-sdk/bin/**,**/node_modules/@vscode/fs-copyfile/build/Release/*.node,**/node_modules.asar.unpacked/@vscode/fs-copyfile/build/Release/*.node,**/node_modules/@parcel/watcher/build/Release/*.node,**/node_modules.asar.unpacked/@parcel/watcher/build/Release/*.node,**/node_modules/@vscode/deviceid/build/Release/*.node,**/node_modules.asar.unpacked/@vscode/deviceid/build/Release/*.node,**/node_modules/@vscode/native-watchdog/build/Release/*.node,**/node_modules.asar.unpacked/@vscode/native-watchdog/build/Release/*.node,**/node_modules/@vscode/policy-watcher/build/Release/*.node,**/node_modules.asar.unpacked/@vscode/policy-watcher/build/Release/*.node}',
		filesToSkipComparison: (file: string) => {
			for (const expected of filesToSkip) {
				if (minimatch(file, expected)) {
					return true;
				}
			}
			return false;
		}
	});

	const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
	Object.assign(productJson, {
		darwinUniversalAssetId: 'darwin-universal'
	});
	fs.writeFileSync(productJsonPath, JSON.stringify(productJson, null, '\t'));
}

if (import.meta.main) {
	main(process.argv[2]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
