/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN status-bar widgets master toggle
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/** Master on/off setting for Clawdius's informational status-bar widgets. */
export const CLAWDIUS_STATUS_BAR_ENABLED_SETTING = 'clawdius.statusBar.enabled';

/**
 * Whether Clawdius's informational status-bar widgets (effort, model, permission mode, context budget, usage)
 * should be shown. Defaults to true - a missing/undefined value shows them; only an explicit `false` hides them.
 * The transient "install Claude Code" prompt is intentionally NOT gated by this and always shows.
 */
export function isClawdiusStatusBarEnabled(configurationService: IConfigurationService): boolean {
	return configurationService.getValue(CLAWDIUS_STATUS_BAR_ENABLED_SETTING) !== false;
}
// CLAWDIUS-END
