/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Effective-config tier paths
// Well-known Claude Code settings filenames + the per-OS managed-settings system directory. Pure: the managed
// root takes the TARGET operating system as a parameter (never a renderer platform constant) so the caller can
// resolve the path against the correct host - the local desktop, or a remote agent in a WSL/SSH window.

import { OperatingSystem } from '../../../../base/common/platform.js';

export const CLAUDE_DIR = '.claude';
export const SETTINGS_JSON = 'settings.json';
export const SETTINGS_LOCAL_JSON = 'settings.local.json';
export const REMOTE_SETTINGS_JSON = 'remote-settings.json';
export const MANAGED_SETTINGS_JSON = 'managed-settings.json';
export const MANAGED_SETTINGS_DROPIN_DIR = 'managed-settings.d';

/**
 * The absolute system directory that holds `managed-settings.json` (and the `managed-settings.d` drop-in dir) for
 * the given target OS. A native path string; the caller builds a URI on the correct target-environment authority.
 * The legacy Windows `C:\\ProgramData\\ClaudeCode` location was dropped by Claude Code in v2.1.75 and is not read.
 */
export function managedSettingsRoot(os: OperatingSystem): string {
	switch (os) {
		case OperatingSystem.Windows: return 'C:\\Program Files\\ClaudeCode';
		case OperatingSystem.Macintosh: return '/Library/Application Support/ClaudeCode';
		default: return '/etc/claude-code';
	}
}
// CLAWDIUS-END
