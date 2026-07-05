/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWeb } from '../../../base/common/platform.js';
import * as nls from '../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import product from '../../product/common/product.js';
import { Registry } from '../../registry/common/platform.js';
import { AgentHostEnabledSettingId } from './agentService.js';

// `chat.agentHost.enabled` is read in the desktop main process
// (`src/vs/code/electron-main/app.ts`) to decide whether to spawn the agent
// host, and in the renderer for various gating decisions. The remote server
// does **not** consume this key — it spawns the agent host based on its own
// `--agent-host-port` / `--agent-host-path` CLI args — so this registration
// is intentionally not imported there.
//
// Side-effect imports of this file:
//   - `src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts`
//     (loaded transitively from `app.ts`).
//   - `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts`
//     (renderer registration for the settings UI).
//
// The `policy` block for `chat.agentHost.enabled` is added in the browser
// layer (`agentHost/browser/agentHost.config.contribution.ts`) via
// `updateConfigurations` because the `value` callback cannot be
// structured-cloned over Electron IPC.

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'chatAgentHost',
	title: nls.localize('chatAgentHostConfigurationTitle', "Chat Agent Host"),
	type: 'object',
	properties: {
		[AgentHostEnabledSettingId]: {
			type: 'boolean',
			description: nls.localize('chat.agentHost.enabled', "When enabled, some agents run in a separate agent host process."),
			// CLAWDIUS-BEGIN agent host on for clawdius
			// Clawdius (entitlementUrl empty) powers the Agents window via the agent-host Claude provider, so
			// the host must spawn in dev AND built/stable. This key is read in the main process where product.json
			// configurationDefaults are NOT applied, so the flip must live here.
			default: !isWeb && (!product.defaultChatAgent?.entitlementUrl || product.quality !== 'stable'),
			// CLAWDIUS-END
			tags: ['experimental', 'advanced'],
			experiment: { mode: 'startup' },
		},
		'chat.agents.copilotCli.hideExtensionHost': {
			type: 'boolean',
			markdownDescription: nls.localize('chat.agents.copilotCli.hideExtensionHost', "When enabled, hides the Extension Host Copilot CLI entry from the Agents window picker. Requires `#{0}#`.", AgentHostEnabledSettingId),
			default: false,
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
		'chat.editor.defaultProvider': {
			type: 'string',
			// CLAWDIUS-BEGIN native agent-host Claude default provider
			// The GitHub Copilot CLI providers (copilotEh/copilotAh) are suppressed in Clawdius; instead Clawdius
			// offers (and defaults to) the native agent-host Claude backend (`claudeAh`) so the chat panel opens
			// an agent-host Claude session - the same engine the workflows/CLI use - rather than the constrained
			// clawdius-chat shim. Upstream (entitlementUrl present) keeps the Copilot options unchanged.
			enum: product.defaultChatAgent?.entitlementUrl ? ['local', 'copilotEh', 'copilotAh'] : ['local', 'claudeAh'],
			enumDescriptions: product.defaultChatAgent?.entitlementUrl ? [
				nls.localize('chat.editor.defaultProvider.local', "Use the built-in Clawdius local chat harness"),
				nls.localize('chat.editor.defaultProvider.copilotEh', "Use the Extension Host Copilot CLI"),
				nls.localize('chat.editor.defaultProvider.copilotAh', "Use the Agent Host Copilot CLI"),
			] : [
				nls.localize('chat.editor.defaultProvider.local', "Use the built-in Clawdius local chat harness"),
				nls.localize('chat.editor.defaultProvider.claudeAh', "Use the native agent-host Claude Code engine (the Clawdius default)"),
			],
			description: nls.localize('chat.editor.defaultProvider', "Controls which provider is used as the default for new editor chat sessions."),
			default: product.defaultChatAgent?.entitlementUrl ? 'local' : 'claudeAh',
			tags: ['experimental'],
			// In Clawdius the default (claudeAh) is a deliberate static choice; don't let a startup experiment
			// override it back to local. Upstream keeps it experiment-controlled.
			...(product.defaultChatAgent?.entitlementUrl ? { experiment: { mode: 'startup' as const } } : {}),
			// CLAWDIUS-END
		},
		'chat.editor.localAgent.enabled': {
			type: 'boolean',
			// CLAWDIUS-BEGIN brand sweep (local agent harness setting description)
			description: nls.localize('chat.editor.localAgent.enabled', "When enabled, shows the Clawdius local chat harness in the chat picker."),
			// CLAWDIUS-END
			default: true,
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
		'chat.editor.copilotCli.hideExtensionHost': {
			type: 'boolean',
			description: nls.localize('chat.editor.copilotCli.hideExtensionHost', "When enabled, hides the Extension Host Copilot CLI entry from the editor window chat picker."),
			default: false,
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
	}
});

// CLAWDIUS-BEGIN clawdius cli engine settings
// These drive IClawdiusCliConfigService in the agent-host process (which reads the user settings.json) to
// pick which Claude Code engine to launch. Only meaningful in Clawdius mode (empty entitlementUrl), so the
// schema/defaults are registered only there. Resolution is file-existence-only: no network, no process spawn.
if (!product.defaultChatAgent?.entitlementUrl) {
	configurationRegistry.registerConfiguration({
		id: 'clawdiusCli',
		title: nls.localize('clawdiusCliConfigurationTitle', "Clawdius CLI"),
		type: 'object',
		properties: {
			'clawdius.cli.preferInstalledCli': {
				type: 'boolean',
				default: true,
				markdownDescription: nls.localize('clawdius.cli.preferInstalledCli', "When enabled (the default), Clawdius auto-detects your installed Claude Code engine - the native binary at `~/.local/bin/claude` from the official installer, or `claude` on your `PATH` - and launches it instead of the bundled one, so the available models and behavior always match your own, self-updating install. Set `#clawdius.cli.nodeCliPath#` to pin a specific engine (that takes precedence), or turn this off to always use the bundled engine. Ignored when an enterprise `#clawdius.cli.wrapperPath#` is set."),
				tags: ['clawdius'],
			},
			'clawdius.cli.nodeCliPath': {
				type: 'string',
				default: '',
				markdownDescription: nls.localize('clawdius.cli.nodeCliPath', "Absolute path to a specific Claude Code engine to launch - a native binary (e.g. `~/.local/bin/claude`) or a `cli.js` JavaScript entrypoint. When set and valid, Clawdius launches this engine and it takes precedence over `#clawdius.cli.preferInstalledCli#` auto-detection. Leave empty to auto-detect your install (or fall back to the bundled engine)."),
				tags: ['clawdius'],
			},
			'clawdius.cli.wrapperPath': {
				type: 'string',
				default: '',
				markdownDescription: nls.localize('clawdius.cli.wrapperPath', "Absolute path to an enterprise Claude **process wrapper** - a directly-spawnable launcher executable that injects auth, proxy, Bedrock/Vertex, or policy around the real CLI (like the official extension's `claudeProcessWrapper`). When set, Clawdius launches the engine through this wrapper and never silently bypasses it. (On Windows a `.cmd`/`.bat` batch wrapper is not supported yet - use an `.exe`.)"),
				tags: ['clawdius'],
			},
			'clawdius.cli.providerPreset': {
				type: 'string',
				enum: ['oauth', 'bedrock', 'vertex', 'foundry', 'custom'],
				default: 'oauth',
				enumDescriptions: [
					nls.localize('clawdius.cli.providerPreset.oauth', "Native ~/.claude OAuth (the default; same as the claude CLI)."),
					nls.localize('clawdius.cli.providerPreset.bedrock', "Amazon Bedrock (sets CLAUDE_CODE_USE_BEDROCK)."),
					nls.localize('clawdius.cli.providerPreset.vertex', "Google Vertex AI (sets CLAUDE_CODE_USE_VERTEX)."),
					nls.localize('clawdius.cli.providerPreset.foundry', "Azure AI Foundry (configure via Environment Variables)."),
					nls.localize('clawdius.cli.providerPreset.custom', "A custom provider (configure via Environment Variables)."),
				],
				description: nls.localize('clawdius.cli.providerPreset.desc', "Which provider the Claude Code engine authenticates against."),
				tags: ['clawdius'],
			},
			'clawdius.cli.environmentVariables': {
				type: 'object',
				additionalProperties: { type: 'string' },
				default: {},
				markdownDescription: nls.localize('clawdius.cli.environmentVariables', "Environment variables passed to the Claude Code subprocess (e.g. provider credentials / region). Keys that Clawdius manages for the subprocess (`NODE_OPTIONS`, `VSCODE_*`, `ELECTRON_*`) cannot be overridden."),
				tags: ['clawdius'],
			},
			'clawdius.cli.disableLoginPrompt': {
				type: 'boolean',
				default: false,
				description: nls.localize('clawdius.cli.disableLoginPrompt', "Suppress the interactive OAuth login prompt (for provider-backed or headless setups). Reserved: not yet enforced."),
				tags: ['clawdius'],
			},
		},
	});
}
// CLAWDIUS-END
