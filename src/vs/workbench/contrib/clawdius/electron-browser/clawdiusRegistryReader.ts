/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Registry policy reader (electron-browser impl)
// Reads the Windows registry managed-policy tiers over the EXISTING INativeHostService channel (implemented in
// electron-main via @vscode/windows-registry) - no new process, no new IPC channel. A no-op on non-Windows hosts.

import { isWindows } from '../../../../base/common/platform.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IClawdiusRegistryReader } from '../common/clawdiusRegistryReader.js';

export class ClawdiusRegistryReader implements IClawdiusRegistryReader {
	declare readonly _serviceBrand: undefined;

	/** The registry only exists on Windows; on desktop macOS/Linux the registry tiers simply do not apply. */
	readonly available = isWindows;

	constructor(
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) { }

	async readPolicySettings(hive: 'HKLM' | 'HKCU'): Promise<string | undefined> {
		if (!isWindows) { return undefined; }
		try {
			return await this.nativeHostService.windowsGetStringRegKey(
				hive === 'HKLM' ? 'HKEY_LOCAL_MACHINE' : 'HKEY_CURRENT_USER',
				'SOFTWARE\\Policies\\ClaudeCode',
				'Settings',
			);
		} catch {
			// An unreadable key is treated as absent here; the effective-config service decides how to surface a
			// present-but-unreadable managed source (it never silently presents lower tiers as definitive).
			return undefined;
		}
	}
}
// CLAWDIUS-END
