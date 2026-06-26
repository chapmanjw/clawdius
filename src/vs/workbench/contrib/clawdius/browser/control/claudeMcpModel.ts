/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN MCP control model (Control Center MCP tab)
// Pure, UI-free logic for the MCP tab: parse the project-server approval settings (enabledMcpjsonServers /
// disabledMcpjsonServers / enableAllProjectMcpServers) and compute the writes to approve / reject / reset a
// project .mcp.json server, plus a transport summary of a server definition. The approval arrays are RELATIVE
// mutations (add/remove a name), so the editor computes the writes against a FRESH read at apply time (never a
// stale render-time snapshot), exactly like the permission-rule writer. Keys are verified against
// claude-code-settings.schema.json. Never surfaces secret values (env / header values).

import { IJsonWrite } from './claudePermissionsModel.js';

const ENABLED_KEY = 'enabledMcpjsonServers';
const DISABLED_KEY = 'disabledMcpjsonServers';
const ENABLE_ALL_KEY = 'enableAllProjectMcpServers';

/** The explicit approval of a project .mcp.json server. `default` = in neither approve/reject list. */
export type McpApproval = 'approved' | 'rejected' | 'default';
/** The effective approval, factoring in the scope-level `enableAllProjectMcpServers` flag. */
export type McpEffectiveApproval = 'approved' | 'rejected' | 'default' | 'approved-by-enable-all';

export interface IMcpSettingsState {
	readonly enabled: readonly string[];
	readonly disabled: readonly string[];
	readonly enableAllProjectServers: boolean;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Parse the project-server approval settings out of a settings.json object. */
export function parseMcpSettings(settings: Record<string, unknown>): IMcpSettingsState {
	return {
		enabled: stringArray(settings[ENABLED_KEY]),
		disabled: stringArray(settings[DISABLED_KEY]),
		enableAllProjectServers: settings[ENABLE_ALL_KEY] === true,
	};
}

/** The explicit approval of `name` (ignores enableAll). */
export function mcpApproval(state: IMcpSettingsState, name: string): McpApproval {
	if (state.disabled.includes(name)) { return 'rejected'; }
	if (state.enabled.includes(name)) { return 'approved'; }
	return 'default';
}

/** The effective approval: explicit rejected wins, then explicit approved, then enableAll, then default. */
export function mcpEffectiveApproval(state: IMcpSettingsState, name: string): McpEffectiveApproval {
	if (state.disabled.includes(name)) { return 'rejected'; }
	if (state.enabled.includes(name)) { return 'approved'; }
	if (state.enableAllProjectServers) { return 'approved-by-enable-all'; }
	return 'default';
}

/** The writes to set `name`'s approval to `next` (whole-array writes; an emptied array is deleted). Relative to
 *  the latest parsed state - compute this AFTER a fresh read at apply time, never from a render-time snapshot. */
export function mcpApprovalWrites(latest: IMcpSettingsState, name: string, next: McpApproval): IJsonWrite[] {
	const enabled = latest.enabled.filter(n => n !== name);
	const disabled = latest.disabled.filter(n => n !== name);
	if (next === 'approved') { enabled.push(name); }
	else if (next === 'rejected') { disabled.push(name); }
	const writes: IJsonWrite[] = [];
	if (!sameOrder(enabled, latest.enabled)) { writes.push({ path: [ENABLED_KEY], value: enabled.length > 0 ? enabled : undefined }); }
	if (!sameOrder(disabled, latest.disabled)) { writes.push({ path: [DISABLED_KEY], value: disabled.length > 0 ? disabled : undefined }); }
	return writes;
}

/** The write to set the scope-level `enableAllProjectMcpServers` flag. `false` deletes the key (absent = off). */
export function enableAllProjectMcpServersWrite(value: boolean): IJsonWrite {
	return { path: [ENABLE_ALL_KEY], value: value ? true : undefined };
}

// --- server definition summary (transport + redacted detail) -------------------------------------------------

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

/** Redact a remote URL for display: keep scheme/host/path, strip userinfo + query/hash (may carry tokens). */
function redactUrl(url: string): string {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}${u.pathname}${u.search || u.hash ? '?...' : ''}`;
	} catch {
		return url;
	}
}

export interface IMcpDefSummary {
	readonly transport: McpTransport;
	/** The command line (stdio) or URL (remote). Never includes env / header VALUES. */
	readonly detail: string;
	/** Names of env vars / headers, for a "+N env" hint - values are never exposed. */
	readonly envKeys: readonly string[];
	readonly headerKeys: readonly string[];
}

/** Summarize an mcpServers[name] definition for display. Secret values (env / headers) are never returned. */
export function summarizeMcpDef(def: unknown): IMcpDefSummary {
	const d = (def && typeof def === 'object') ? def as Record<string, unknown> : {};
	const type = typeof d['type'] === 'string' ? (d['type'] as string).toLowerCase() : undefined;
	const url = typeof d['url'] === 'string' ? d['url'] as string : undefined;
	const command = typeof d['command'] === 'string' ? d['command'] as string : undefined;
	const args = Array.isArray(d['args']) ? d['args'].filter((a): a is string => typeof a === 'string') : [];
	const envKeys = d['env'] && typeof d['env'] === 'object' ? Object.keys(d['env'] as object) : [];
	const headerKeys = d['headers'] && typeof d['headers'] === 'object' ? Object.keys(d['headers'] as object) : [];

	let transport: McpTransport;
	let detail: string;
	if (url) {
		transport = type === 'sse' ? 'sse' : 'http';
		detail = redactUrl(url);
	} else if (command) {
		transport = 'stdio';
		detail = [command, ...args].join(' ');
	} else {
		transport = 'unknown';
		detail = '';
	}
	return { transport, detail, envKeys, headerKeys };
}
// CLAWDIUS-END
