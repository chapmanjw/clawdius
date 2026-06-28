/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
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

/** The MCP transports this tab can configure. `ws` is remote (url-based) like http/sse but has no OAuth. */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws' | 'unknown'; // exported for the add / edit form
/** The transports the add / edit form offers (excludes the read-only 'unknown' fallback). */
export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse', 'ws'];
/** True for url-based transports (http / sse / ws). stdio is command-based. */
function isRemoteTransport(transport: McpTransport): boolean {
	return transport === 'http' || transport === 'sse' || transport === 'ws';
}
/** True for transports that support an OAuth block (http / sse only - not ws). */
export function transportSupportsOauth(transport: McpTransport): boolean {
	return transport === 'http' || transport === 'sse';
}

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
	/** True when a `headersHelper` shell command is configured (remote only). The command itself is not exposed. */
	readonly hasHeadersHelper: boolean;
	/** True when an `oauth` block is present (http / sse). The clientSecret never lives in the file. */
	readonly hasOauth: boolean;
	/** The request timeout in ms, if set. Non-secret. */
	readonly timeout: number | undefined;
	/** The `alwaysLoad` flag, if set. Non-secret. */
	readonly alwaysLoad: boolean | undefined;
}

/** Summarize an mcpServers[name] definition for display. Secret values (env / headers / oauth) are never returned. */
export function summarizeMcpDef(def: unknown): IMcpDefSummary {
	const d = (def && typeof def === 'object') ? def as Record<string, unknown> : {};
	const type = typeof d['type'] === 'string' ? (d['type'] as string).toLowerCase() : undefined;
	const url = typeof d['url'] === 'string' ? d['url'] as string : undefined;
	const command = typeof d['command'] === 'string' ? d['command'] as string : undefined;
	const args = Array.isArray(d['args']) ? d['args'].filter((a): a is string => typeof a === 'string') : [];
	const envKeys = d['env'] && typeof d['env'] === 'object' ? Object.keys(d['env'] as object) : [];
	const headerKeys = d['headers'] && typeof d['headers'] === 'object' ? Object.keys(d['headers'] as object) : [];
	const hasHeadersHelper = typeof d['headersHelper'] === 'string' && (d['headersHelper'] as string).length > 0;
	const hasOauth = !!(d['oauth'] && typeof d['oauth'] === 'object');
	const timeout = typeof d['timeout'] === 'number' ? d['timeout'] as number : undefined;
	const alwaysLoad = typeof d['alwaysLoad'] === 'boolean' ? d['alwaysLoad'] as boolean : undefined;

	let transport: McpTransport;
	let detail: string;
	if (url) {
		transport = type === 'sse' ? 'sse' : type === 'ws' ? 'ws' : 'http';
		detail = redactUrl(url);
	} else if (command) {
		transport = 'stdio';
		detail = [command, ...args].join(' ');
	} else {
		transport = 'unknown';
		detail = '';
	}
	return { transport, detail, envKeys, headerKeys, hasHeadersHelper, hasOauth, timeout, alwaysLoad };
}

/** True when two def summaries are equal. Used to decide whether a server's def actually changed across a config
 *  refresh - an unchanged def keeps its discovered-tools cache, so a freshly loaded tool list does not flash and
 *  disappear when a benign refresh (e.g. the discovery spawn touching ~/.claude) re-reads the defs. */
export function sameMcpDefSummary(a: IMcpDefSummary, b: IMcpDefSummary): boolean {
	return a.transport === b.transport
		&& a.detail === b.detail
		&& a.hasHeadersHelper === b.hasHeadersHelper
		&& a.hasOauth === b.hasOauth
		&& a.timeout === b.timeout
		&& a.alwaysLoad === b.alwaysLoad
		&& sameStringArray(a.envKeys, b.envKeys)
		&& sameStringArray(a.headerKeys, b.headerKeys);
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- add / edit form model -----------------------------------------------------------------------------------

/** One key/value pair in an env or headers repeater. Secret VALUES are never read from a stored def into the
 *  form: on edit the value is always '' (the key is preserved), and the merger keeps the stored value when the
 *  field is left blank. */
export interface IMcpKeyValue {
	readonly key: string;
	readonly value: string;
}

/** The non-secret OAuth sub-fields (http / sse only). clientSecret is NEVER part of the form: it lives in the
 *  CLI secure store, not the JSON file. Numeric callbackPort is a string here and coerced in the builder. */
export interface IMcpOauthForm {
	readonly clientId: string;
	readonly callbackPort: string;
	readonly scopes: string;
	readonly authServerMetadataUrl: string;
}

/** The editable shape of one MCP server definition. Numeric fields (timeout / callbackPort) are strings and
 *  coerced by the builder; non-numeric input is ignored. */
export interface IMcpServerForm {
	readonly transport: McpTransport;
	// stdio
	readonly command: string;
	readonly args: readonly string[];
	readonly env: readonly IMcpKeyValue[];
	// remote (http / sse / ws)
	readonly url: string;
	readonly headers: readonly IMcpKeyValue[];
	readonly headersHelper: string;
	// http / sse only
	readonly oauth: IMcpOauthForm;
	// common (all transports)
	readonly timeout: string;
	readonly alwaysLoad: boolean;
}

/** An empty form for a given transport (defaults to stdio). */
export function emptyMcpForm(transport: McpTransport = 'stdio'): IMcpServerForm {
	return {
		transport,
		command: '',
		args: [],
		env: [],
		url: '',
		headers: [],
		headersHelper: '',
		oauth: { clientId: '', callbackPort: '', scopes: '', authServerMetadataUrl: '' },
		timeout: '',
		alwaysLoad: false,
	};
}

/** Coerce a string to a finite integer, or undefined when blank / non-numeric. */
function toFiniteInt(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const n = Number(trimmed);
	return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** True when every OAuth sub-field is blank (so the block is omitted entirely). */
function isOauthBlank(oauth: IMcpOauthForm): boolean {
	return oauth.clientId.trim().length === 0
		&& oauth.callbackPort.trim().length === 0
		&& oauth.scopes.trim().length === 0
		&& oauth.authServerMetadataUrl.trim().length === 0;
}

/** Build the non-secret OAuth object from the form, or undefined when all sub-fields are blank. Never writes a
 *  clientSecret (it lives in the CLI secure store). */
function buildOauth(oauth: IMcpOauthForm): Record<string, unknown> | undefined {
	if (isOauthBlank(oauth)) {
		return undefined;
	}
	const out: Record<string, unknown> = {};
	const clientId = oauth.clientId.trim();
	if (clientId.length > 0) {
		out['clientId'] = clientId;
	}
	const callbackPort = toFiniteInt(oauth.callbackPort);
	if (callbackPort !== undefined) {
		out['callbackPort'] = callbackPort;
	}
	const scopes = oauth.scopes.trim();
	if (scopes.length > 0) {
		out['scopes'] = scopes;
	}
	const authServerMetadataUrl = oauth.authServerMetadataUrl.trim();
	if (authServerMetadataUrl.length > 0) {
		out['authServerMetadataUrl'] = authServerMetadataUrl;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Add the common (`timeout` / `alwaysLoad`) and OAuth fields to a def, omitting unset ones. */
function applyCommonFields(def: Record<string, unknown>, form: IMcpServerForm): void {
	const timeout = toFiniteInt(form.timeout);
	if (timeout !== undefined) {
		def['timeout'] = timeout;
	}
	if (form.alwaysLoad) {
		def['alwaysLoad'] = true;
	}
	if (transportSupportsOauth(form.transport)) {
		const oauth = buildOauth(form.oauth);
		if (oauth) {
			def['oauth'] = oauth;
		}
	}
}

/** Build a fresh `env` / `headers` object from the form's key/value pairs (blank keys dropped). Returns undefined
 *  when no pairs remain (so an empty object is never written). Used by the ADD path - on EDIT the merger keeps
 *  stored secret values for blank inputs instead. */
function buildKeyValueObject(pairs: readonly IMcpKeyValue[]): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const pair of pairs) {
		const key = pair.key.trim();
		if (key.length > 0) {
			out[key] = pair.value;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Assemble an mcpServers[name] definition from the form (ADD path). ALWAYS includes `type`. Omits every empty /
 *  blank field (no empty env / headers object, no args when empty, no oauth when all sub-fields blank, no
 *  timeout / alwaysLoad / headersHelper when unset). */
export function buildMcpDef(form: IMcpServerForm): Record<string, unknown> {
	const def: Record<string, unknown> = { type: form.transport };
	if (isRemoteTransport(form.transport)) {
		def['url'] = form.url.trim();
		const headers = buildKeyValueObject(form.headers);
		if (headers) {
			def['headers'] = headers;
		}
		const headersHelper = form.headersHelper.trim();
		if (headersHelper.length > 0) {
			def['headersHelper'] = headersHelper;
		}
	} else {
		def['command'] = form.command.trim();
		const args = form.args.map(a => a.trim()).filter(a => a.length > 0);
		if (args.length > 0) {
			def['args'] = args;
		}
		const env = buildKeyValueObject(form.env);
		if (env) {
			def['env'] = env;
		}
	}
	applyCommonFields(def, form);
	return def;
}

/** Read a string->string map from a def field (env / headers), tolerating bad shapes. */
function readStringMap(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (typeof v === 'string') {
				out[k] = v;
			}
		}
	}
	return out;
}

/** Prefill a form from an existing def for editing. Secret VALUES (env / header values, oauth.clientSecret) are
 *  NEVER read into the form: env / header keys are preserved with a BLANK value; oauth.clientSecret is dropped.
 *  Non-secret oauth sub-fields, headersHelper, timeout, alwaysLoad, command, args, url and transport are parsed. */
export function parseMcpDefForEdit(def: unknown): IMcpServerForm {
	const summary = summarizeMcpDef(def);
	const d = (def && typeof def === 'object') ? def as Record<string, unknown> : {};
	const transport: McpTransport = summary.transport === 'unknown' ? 'stdio' : summary.transport;
	const command = typeof d['command'] === 'string' ? d['command'] as string : '';
	const args = Array.isArray(d['args']) ? d['args'].filter((a): a is string => typeof a === 'string') : [];
	const url = typeof d['url'] === 'string' ? d['url'] as string : '';
	const headersHelper = typeof d['headersHelper'] === 'string' ? d['headersHelper'] as string : '';
	// Keys preserved, values stripped to '' (the merger restores stored values for blank inputs).
	const env: IMcpKeyValue[] = Object.keys(readStringMap(d['env'])).map(key => ({ key, value: '' }));
	const headers: IMcpKeyValue[] = Object.keys(readStringMap(d['headers'])).map(key => ({ key, value: '' }));
	const oauthRaw = (d['oauth'] && typeof d['oauth'] === 'object') ? d['oauth'] as Record<string, unknown> : {};
	const oauth: IMcpOauthForm = {
		clientId: typeof oauthRaw['clientId'] === 'string' ? oauthRaw['clientId'] as string : '',
		callbackPort: typeof oauthRaw['callbackPort'] === 'number' ? String(oauthRaw['callbackPort']) : '',
		scopes: typeof oauthRaw['scopes'] === 'string' ? oauthRaw['scopes'] as string : '',
		authServerMetadataUrl: typeof oauthRaw['authServerMetadataUrl'] === 'string' ? oauthRaw['authServerMetadataUrl'] as string : '',
	};
	return {
		transport,
		command,
		args,
		env,
		url,
		headers,
		headersHelper,
		oauth,
		timeout: summary.timeout !== undefined ? String(summary.timeout) : '',
		alwaysLoad: summary.alwaysLoad === true,
	};
}

/** Merge an env / headers map for the SAVE path: for each form pair with a non-blank key, a typed value
 *  overwrites and a BLANK value keeps the stored value from `fresh` (read at write time, never shown in the UI);
 *  a key absent from the form is dropped. Returns undefined when no pairs remain. */
function mergeKeyValueObject(fresh: Record<string, string>, pairs: readonly IMcpKeyValue[]): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const pair of pairs) {
		const key = pair.key.trim();
		if (key.length === 0) {
			continue;
		}
		if (pair.value.length > 0) {
			out[key] = pair.value;
		} else if (Object.hasOwn(fresh, key)) {
			out[key] = fresh[key];
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Assemble an mcpServers[name] definition for the EDIT path. Like buildMcpDef, but env / header VALUES are
 *  merged against a FRESH read of the backing def: blank keeps the stored value, typed overwrites, a removed key
 *  is dropped. oauth.clientSecret is never touched (it is not part of the form and lives in the CLI store). */
export function mergeMcpDefForSave(freshDef: unknown, form: IMcpServerForm): Record<string, unknown> {
	const fresh = (freshDef && typeof freshDef === 'object') ? freshDef as Record<string, unknown> : {};
	const def: Record<string, unknown> = { type: form.transport };
	if (isRemoteTransport(form.transport)) {
		def['url'] = form.url.trim();
		const headers = mergeKeyValueObject(readStringMap(fresh['headers']), form.headers);
		if (headers) {
			def['headers'] = headers;
		}
		const headersHelper = form.headersHelper.trim();
		if (headersHelper.length > 0) {
			def['headersHelper'] = headersHelper;
		}
	} else {
		def['command'] = form.command.trim();
		const args = form.args.map(a => a.trim()).filter(a => a.length > 0);
		if (args.length > 0) {
			def['args'] = args;
		}
		const env = mergeKeyValueObject(readStringMap(fresh['env']), form.env);
		if (env) {
			def['env'] = env;
		}
	}
	applyCommonFields(def, form);
	return def;
}

/** The write that deletes the server `name` from mcpServers (value `undefined` removes the key). */
export function mcpDeleteWrite(name: string): IJsonWrite {
	return { path: ['mcpServers', name], value: undefined };
}
// CLAWDIUS-END
