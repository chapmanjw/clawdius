/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Shared write-path canonicalization
// The symlink-following realpath + the Windows ADS/8.3/reserved-name safety check, promoted out of
// sessionPermissions.ts so the per-session permission manager AND the workspace-trust gate share ONE canonicalizer
// (one place to get path containment right; two divergent copies would be a security bug waiting to happen).

import * as path from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { Promises } from '../../../base/node/pfs.js';

/**
 * Validates that a path doesn't contain suspicious characters that could be
 * used to bypass security checks on Windows (e.g. NTFS Alternate Data Streams,
 * invalid characters, reserved device names). Throws if the path is suspicious.
 */
export function assertPathIsSafe(fsPath: string, _isWindows = isWindows): void {
	if (fsPath.includes('\0')) {
		throw new Error(`Path contains null bytes: ${fsPath}`);
	}

	if (!_isWindows) {
		return;
	}

	// Check for NTFS Alternate Data Streams (ADS)
	const colonIndex = fsPath.indexOf(':', 2);
	if (colonIndex !== -1) {
		throw new Error(`Path contains invalid characters (alternate data stream): ${fsPath}`);
	}

	// Check for invalid Windows filename characters
	const invalidChars = /[<>"|?*]/;
	const pathAfterDrive = fsPath.length > 2 ? fsPath.substring(2) : fsPath;
	if (invalidChars.test(pathAfterDrive)) {
		throw new Error(`Path contains invalid characters: ${fsPath}`);
	}

	// Check for named pipes or device paths
	if (fsPath.startsWith('\\\\.') || fsPath.startsWith('\\\\?')) {
		throw new Error(`Path is a reserved device path: ${fsPath}`);
	}

	const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

	// Check for trailing dots and spaces on path components (Windows quirk)
	const parts = fsPath.split('\\');
	for (const part of parts) {
		if (part.length === 0) {
			continue;
		}

		if (reserved.test(part)) {
			throw new Error(`Reserved device name in path: ${fsPath}`);
		}

		if (part.endsWith('.') || part.endsWith(' ')) {
			throw new Error(`Path contains invalid trailing characters: ${fsPath}`);
		}

		const tildeIndex = part.indexOf('~');
		if (tildeIndex !== -1) {
			const afterTilde = part.substring(tildeIndex + 1);
			if (afterTilde.length > 0 && /^\d/.test(afterTilde)) {
				throw new Error(`Path appears to use short filename format (8.3 names): ${fsPath}. Please use the full path.`);
			}
		}
	}
}

/**
 * Resolves the real path of `fsPath`, walking up the parent chain when the path
 * (or its ancestors) does not yet exist on disk. This ensures a symlink at any
 * ancestor is followed even for files that are about to be created.
 *
 * @param realpath Override for the underlying `fs.realpath` call. Defaults to
 * {@link Promises.realpath}; tests pass a stub to deterministically exercise
 * error paths (e.g. `EACCES`/`EPERM`) that are hard to set up on a real
 * filesystem across platforms.
 */
export async function resolveRealPathForNonexistent(fsPath: string, realpath: (fsPath: string) => Promise<string> = Promises.realpath): Promise<string> {
	try {
		return await realpath(fsPath);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw e;
		}
	}

	const tail: string[] = [path.basename(fsPath)];
	let current = path.dirname(fsPath);
	while (true) {
		const parent = path.dirname(current);
		if (parent === current) {
			// Reached the filesystem root without finding an existing ancestor.
			return fsPath;
		}
		try {
			const resolved = await realpath(current);
			return path.join(resolved, ...tail);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'ENOTDIR') {
				throw e;
			}
		}
		tail.unshift(path.basename(current));
		current = parent;
	}
}
// CLAWDIUS-END
