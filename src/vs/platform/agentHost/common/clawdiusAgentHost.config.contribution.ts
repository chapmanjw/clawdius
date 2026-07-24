/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN clawdius-owned agent-host settings
// Fork-owned settings that upstream's agentHost enablement refactor (#325001, which removed
// agentHost.config.contribution.ts and merged the enablement config into agentHostEnablementService.ts)
// does not carry: the native Claude default editor provider, the workspace-trust deny-by-default gate, and
// the Clawdius CLI engine settings. Re-homed here and loaded via a side-effect import in
// agentHostEnablementService.ts so they register in the same main + renderer contexts that file does.

import * as nls from '../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import product from '../../product/common/product.js';
import { Registry } from '../../registry/common/platform.js';
import { WORKSPACE_TRUST_DENY_BY_DEFAULT_SETTING_ID } from './agentHostSchema.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

// The GitHub Copilot CLI providers (copilotEh/copilotAh) are suppressed in Clawdius; instead Clawdius offers
// (and defaults to) the native agent-host Claude backend (`claudeAh`) so the chat panel opens an agent-host
// Claude session - the same engine the workflows/CLI use - rather than the constrained clawdius-chat shim.
// Upstream (entitlementUrl present) keeps the Copilot options unchanged. Read via getConfiguredEditorDefaultSessionType.
configurationRegistry.registerConfiguration({
	id: 'clawdiusChatEditor',
	title: nls.localize('clawdiusChatEditorConfigurationTitle', "Clawdius Chat Editor"),
	type: 'object',
	properties: {
		'chat.editor.defaultProvider': {
			type: 'string',
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
		},
	}
});

// The opt-in security policy that flips the agent-host trust gate to fail-closed for sessions whose workspace
// trust was never established. Default off (no behaviour change); the node reads it via platformRootSchema after
// the agent-host clients forward it. Registered unconditionally so the fork's trust posture is always tunable.
configurationRegistry.registerConfiguration({
	id: 'clawdiusWorkspaceTrust',
	title: nls.localize('clawdiusWorkspaceTrustConfigurationTitle', "Clawdius Workspace Trust"),
	type: 'object',
	properties: {
		[WORKSPACE_TRUST_DENY_BY_DEFAULT_SETTING_ID]: {
			type: 'boolean',
			default: false,
			markdownDescription: nls.localize('clawdius.agent.workspaceTrust.denyByDefault', "When enabled, an agent session whose workspace trust has not been established is treated as **untrusted** - file writes, shell commands, MCP tools, and web access are blocked until the workspace is trusted. When off (the default), such a session keeps full access until a trust decision arrives. Turn this on to fail closed on any surface a trust decision never reaches."),
			tags: ['clawdius'],
		},
	},
});

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
