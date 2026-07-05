/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Registry policy reader (decorator)
// Browser-safe capability seam for reading the Windows registry managed-policy tiers. The implementation lives in
// electron-browser (over the existing INativeHostService native channel); this decorator lets the browser-layer
// effective-config service inject it @optional - undefined in web / remote / non-desktop, where the registry
// tiers are simply absent.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IClawdiusRegistryReader = createDecorator<IClawdiusRegistryReader>('clawdiusRegistryReader');

export interface IClawdiusRegistryReader {
	readonly _serviceBrand: undefined;
	/**
	 * True when this host can actually read the Windows registry (a desktop Windows window). False on web, remote,
	 * and non-Windows hosts, where the caller reports the registry tiers as not-yet-evaluated rather than treating
	 * them as silently absent.
	 */
	readonly available: boolean;
	/**
	 * The JSON string stored at `<hive>\SOFTWARE\Policies\ClaudeCode` value `Settings`, or undefined when the key
	 * is absent, unreadable, or the host is not Windows. `HKLM` is the admin/MDM tier; `HKCU` is the user-writable
	 * fallback tier.
	 */
	readPolicySettings(hive: 'HKLM' | 'HKCU'): Promise<string | undefined>;
}

/**
 * The default reader for web / remote / non-desktop builds: the registry is unavailable. The electron-browser
 * build registers the real native reader after this one (last registration wins), so desktop windows get the
 * real implementation and every other build gets this no-op.
 */
export class ClawdiusNoopRegistryReader implements IClawdiusRegistryReader {
	declare readonly _serviceBrand: undefined;
	readonly available = false;
	async readPolicySettings(): Promise<string | undefined> { return undefined; }
}
// CLAWDIUS-END
