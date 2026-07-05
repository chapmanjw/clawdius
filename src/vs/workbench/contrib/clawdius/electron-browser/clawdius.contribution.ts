/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Desktop-only Clawdius services
// The first electron-browser entry point for the Clawdius contribution: desktop-only services that need native
// reach. Gated on Clawdius mode (no chat-agent entitlement), mirroring browser/clawdius.contribution.ts.

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import product from '../../../../platform/product/common/product.js';
import { IClawdiusRegistryReader } from '../common/clawdiusRegistryReader.js';
import { ClawdiusRegistryReader } from './clawdiusRegistryReader.js';

if (!product.defaultChatAgent?.entitlementUrl) {
	// The Windows registry managed-policy reader (HKLM/HKCU), consumed @optional by the effective-config service to
	// complete the managed band on desktop. Absent in web/remote, where the registry tiers do not apply.
	registerSingleton(IClawdiusRegistryReader, ClawdiusRegistryReader, InstantiationType.Delayed);
}
// CLAWDIUS-END
