/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../../base/common/collections.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigExtensions, IConfigurationNode, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

// Clawdius hides a small set of upstream chat settings from the Settings editor because the ONLY UI
// surface that reads each one is a surface Clawdius suppresses (the built-in chat sign-in / setup chrome, and the
// upstream CLI entries in the session pickers). They keep working if a user sets them in settings.json -
// `included: false` only removes a property from the Settings-editor list and the settings.json schema, it does
// not delete the value - but they stop cluttering the UI with toggles that can never do anything in Clawdius mode.
//
// STRICTLY INERT ONLY. Every key below has been traced to readers that are all dead in Clawdius mode (empty
// product.defaultChatAgent.entitlementUrl). Anything the retained agent-host / agent-sessions stack still
// consumes is deliberately left visible - over-hiding a live setting would be a regression, under-hiding is
// harmless, so when in doubt a setting stays out of this list.
export const CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS: readonly string[] = [
	// The title-bar "Sign In" button. Both readers are dead in Clawdius: ChatSetupContribution short-circuits
	// (its entitlement context is never built - ChatEntitlementService bails on an empty entitlementUrl), so
	// registerActions() never registers the sign-in title-bar action; and ChatStatusBarEntry early-returns its
	// constructor before it reads this key. There is no IDE sign-in in Clawdius.
	'chat.titleBar.signIn.enabled',
	// The setup "growth" nudge shown in the sessions view. Its sole reader is ChatSetupContribution's
	// registerGrowthSession(), which never runs once ChatSetupContribution short-circuits in Clawdius mode.
	'chat.growthNotification.enabled',
	// Toggle to hide the "Extension Host CLI" entry from the Agents-window picker. In Clawdius that entry
	// is unconditionally absent - copilotChatSessionsProvider._isCopilotCliAvailable() returns false before this
	// toggle is ever consulted - so the toggle can never change anything.
	'chat.agents.copilotCli.hideExtensionHost',
	// The same toggle for the editor-window chat picker. It is only consulted for the CopilotCLI session type,
	// which Clawdius suppresses, so it is likewise inert.
	'chat.editor.copilotCli.hideExtensionHost',
	// The preferCopilotHarness / defaultToCopilotHarness toggles (registered by agentHostEnablementService) only
	// select an AgentHostCopilot session type Clawdius never surfaces; hide them from the Settings search.
	'chat.editor.preferCopilotHarness',
	'chat.defaultToCopilotHarness',
];

const CLAWDIUS_HIDDEN_SETTINGS_NODE_ID = 'clawdius.hiddenUpstreamSettings';

// Re-register each still-registered target property with `included: false`. The configuration registry routes an
// `included: false` property into `excludedConfigurationProperties` (hidden from the Settings editor and the
// settings.json schema) instead of `configurationProperties` (what the Settings editor reads). A property that is
// already registered is NOT replaced by a plain re-registration, so we DEREGISTER it first (updateConfigurations'
// `remove`) and then ADD the excluded copy - the net effect is the key moves out of the visible set and into the
// excluded set. updateConfigurations fires onDidSchemaChange, so a Settings editor that is already open refreshes
// live. Returns the keys actually hidden (a key that is missing or already excluded is skipped).
export function hideInapplicableClawdiusSettings(registry: IConfigurationRegistry): string[] {
	const properties = registry.getConfigurationProperties();
	const removeProperties: IStringDictionary<IConfigurationPropertySchema> = {};
	const addProperties: IStringDictionary<IConfigurationPropertySchema> = {};
	const hidden: string[] = [];
	for (const key of CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS) {
		const existing = properties[key];
		if (!existing) {
			// Not registered (or already excluded) - nothing to hide.
			continue;
		}
		// Keep the existing schema for the remove pass so removeFromSchema targets the right scope bucket, and
		// carry it forward (plus included: false) for the excluded re-registration.
		removeProperties[key] = existing;
		addProperties[key] = { ...existing, included: false };
		hidden.push(key);
	}
	if (hidden.length === 0) {
		return hidden;
	}
	const removeNode: IConfigurationNode = { id: CLAWDIUS_HIDDEN_SETTINGS_NODE_ID, properties: removeProperties };
	const addNode: IConfigurationNode = { id: CLAWDIUS_HIDDEN_SETTINGS_NODE_ID, properties: addProperties };
	registry.updateConfigurations({ add: [addNode], remove: [removeNode] });
	return hidden;
}

// Applies the hide at startup. Registered ONLY from the Clawdius-mode block in clawdius.contribution.ts, so a
// non-Clawdius build never loads it and the settings stay visible. A workbench contribution instantiates well
// after all module-load configuration registration has completed, so every target property is present by the
// time this runs.
export class ClawdiusHiddenSettingsContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusHiddenSettings';

	constructor() {
		hideInapplicableClawdiusSettings(Registry.as<IConfigurationRegistry>(ConfigExtensions.Configuration));
	}
}
