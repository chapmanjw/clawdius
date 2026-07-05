/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Effective-config assembly service
// Reads every LOCAL settings source for a workspace folder and runs the pure resolver, returning the resolved
// config plus honest diagnostics about what was NOT evaluated. Cross-host safety: user/project/local/remote-cache
// URIs are built from IPathService.userHome() + the workspace-folder URI, so a WSL/SSH window reads the REMOTE
// filesystem. The managed-settings.json system path is only read when the home is LOCAL (file scheme); a remote
// managed read and the Windows registry tiers land in a later increment, and until then are reported as
// "not evaluated" so the effective view never presents a MISLEADING complete result on a managed machine.

import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OS, isWindows } from '../../../../../base/common/platform.js';
import { parse as parseJsonc } from '../../../../../base/common/jsonc.js';
import { localize } from '../../../../../nls.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import {
	IEffectiveConfig, ITierInput, JsonObject, SettingsTier, resolveEffectiveConfig,
} from '../../common/clawdiusEffectiveConfig.js';
import { detectPolicyHelper, mergeSettingsChain, parsePolicySettings } from '../../common/clawdiusSettingsMerge.js';
import { IClawdiusRegistryReader } from '../../common/clawdiusRegistryReader.js';
import {
	CLAUDE_DIR, MANAGED_SETTINGS_DROPIN_DIR, MANAGED_SETTINGS_JSON, REMOTE_SETTINGS_JSON,
	SETTINGS_JSON, SETTINGS_LOCAL_JSON, managedSettingsRoot,
} from '../../common/clawdiusTierPaths.js';

/** A source that exists but could not be fully evaluated - surfaced so the UI never implies a complete result. */
export interface ITierReadDiagnostic {
	readonly tier: SettingsTier;
	readonly resource?: URI;
	/** `malformed` = present but unparseable; `unevaluated` = a tier this increment does not read yet. */
	readonly kind: 'malformed' | 'unevaluated';
	readonly detail: string;
}

export interface IEffectiveConfigResult {
	readonly config: IEffectiveConfig;
	readonly diagnostics: readonly ITierReadDiagnostic[];
	/** The raw per-tier inputs the resolver ran on (for the "sources" drill-in + tests). */
	readonly tiers: readonly ITierInput[];
}

export const IClawdiusEffectiveConfigService = createDecorator<IClawdiusEffectiveConfigService>('clawdiusEffectiveConfigService');

export interface IClawdiusEffectiveConfigService {
	readonly _serviceBrand: undefined;
	/** Read every local source for `workspaceFolder` (undefined = no folder: global + managed only) and resolve. */
	resolve(workspaceFolder: URI | undefined): Promise<IEffectiveConfigResult>;
}

export class ClawdiusEffectiveConfigService implements IClawdiusEffectiveConfigService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
		@IClawdiusRegistryReader private readonly registryReader: IClawdiusRegistryReader,
	) { }

	async resolve(workspaceFolder: URI | undefined): Promise<IEffectiveConfigResult> {
		const home = await this.pathService.userHome();
		const diagnostics: ITierReadDiagnostic[] = [];
		const inputs: ITierInput[] = [];

		// User / project / project-local: target-aware (home + workspace-folder URIs read the remote fs in a
		// WSL/SSH window). The user tier is always present as an input, even when its body is undefined, so the
		// resolver's tier set is stable; project tiers only exist when a folder is open.
		inputs.push({ tier: SettingsTier.User, body: await this.readJsonc(URI.joinPath(home, CLAUDE_DIR, SETTINGS_JSON), SettingsTier.User, diagnostics) });
		if (workspaceFolder) {
			inputs.push({ tier: SettingsTier.Project, body: await this.readJsonc(URI.joinPath(workspaceFolder, CLAUDE_DIR, SETTINGS_JSON), SettingsTier.Project, diagnostics) });
			inputs.push({ tier: SettingsTier.ProjectLocal, body: await this.readJsonc(URI.joinPath(workspaceFolder, CLAUDE_DIR, SETTINGS_LOCAL_JSON), SettingsTier.ProjectLocal, diagnostics) });
		}

		// Server-managed CACHE read (no network here - refreshing the cache is a later increment).
		const remoteBody = await this.readJsonc(URI.joinPath(home, CLAUDE_DIR, REMOTE_SETTINGS_JSON), SettingsTier.ServerManaged, diagnostics);
		if (remoteBody !== undefined) { inputs.push({ tier: SettingsTier.ServerManaged, body: remoteBody }); }

		// Managed file tier: only read when the home is LOCAL. Building the system path on a remote authority needs
		// the remote OS (a later increment), so a remote window reports it as not-yet-evaluated instead of reading
		// the wrong host's disk.
		const isLocal = home.scheme === Schemas.file;
		if (isLocal) {
			const managedBody = await this.readManagedFile(diagnostics);
			if (managedBody !== undefined) { inputs.push({ tier: SettingsTier.ManagedFile, body: managedBody }); }

			// Windows registry managed tiers (HKLM = admin/MDM, HKCU = user-writable fallback), read over the
			// native host when this desktop provides the reader. Without it (web) on Windows the managed band is
			// still incomplete, so warn rather than imply completeness.
			let mdmBody: JsonObject | undefined;
			if (this.registryReader.available) {
				mdmBody = await this.readRegistryTier('HKLM', SettingsTier.MdmRegistry, diagnostics);
				if (mdmBody !== undefined) { inputs.push({ tier: SettingsTier.MdmRegistry, body: mdmBody }); }
				const hkcuBody = await this.readRegistryTier('HKCU', SettingsTier.HkcuRegistry, diagnostics);
				if (hkcuBody !== undefined) { inputs.push({ tier: SettingsTier.HkcuRegistry, body: hkcuBody }); }
			} else if (isWindows) {
				diagnostics.push({ tier: SettingsTier.MdmRegistry, kind: 'unevaluated', detail: localize('clawdius.eff.registryPending', "Windows registry managed policy (HKLM/HKCU) could not be evaluated; the managed band may be incomplete.") });
			}

			// policyHelper is never executed - if an ADMIN source (the managed FILE or the MDM/HKLM registry, but
			// NOT server-managed or the user-writable HKCU) declares one, surface it as an opaque top tier.
			if (detectPolicyHelper([managedBody, mdmBody])) { inputs.push({ tier: SettingsTier.PolicyHelper, body: undefined, opaque: true }); }
		} else {
			diagnostics.push({ tier: SettingsTier.ManagedFile, kind: 'unevaluated', detail: localize('clawdius.eff.managedRemote', "Managed settings are not evaluated in remote windows yet.") });
		}

		return { config: resolveEffectiveConfig(inputs), diagnostics, tiers: inputs };
	}

	/** Read a JSONC settings file. Missing => absent tier (no diagnostic); present-but-unparseable => malformed. */
	private async readJsonc(resource: URI, tier: SettingsTier, diagnostics: ITierReadDiagnostic[]): Promise<JsonObject | undefined> {
		let raw: string;
		try {
			raw = (await this.fileService.readFile(resource)).value.toString();
		} catch (e) {
			if (toFileOperationResult(e) === FileOperationResult.FILE_NOT_FOUND) {
				this.logService.trace(`[clawdius] effective-config: no ${tier} at ${resource.toString(true)}`);
				return undefined; // genuinely absent - not a diagnostic
			}
			// Present but unreadable (permission denied, IO error, too large): report it, so a managed/policy source
			// is never silently collapsed into "absent" and lower tiers presented as definitive.
			this.logService.warn(`[clawdius] effective-config: unreadable ${tier} at ${resource.toString(true)}: ${e}`);
			diagnostics.push({ tier, resource, kind: 'unevaluated', detail: localize('clawdius.eff.unreadable', "Could not read {0}: {1}", resource.path, e instanceof Error ? e.message : String(e)) });
			return undefined;
		}
		if (raw.trim().length === 0) { return undefined; }
		try {
			const parsed = parseJsonc(raw);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) { return parsed as JsonObject; }
			diagnostics.push({ tier, resource, kind: 'malformed', detail: localize('clawdius.eff.notObject', "{0} is not a JSON object.", resource.path) });
			return undefined;
		} catch {
			diagnostics.push({ tier, resource, kind: 'malformed', detail: localize('clawdius.eff.parse', "Could not parse {0}.", resource.path) });
			return undefined;
		}
	}

	/** Read one registry policy tier. Absent (no key / empty value) => undefined with no diagnostic; present but
	 *  unparseable => a `malformed` diagnostic, matching how the file tiers treat unparseable content, so a broken
	 *  managed policy is never silently presented as absent. */
	private async readRegistryTier(hive: 'HKLM' | 'HKCU', tier: SettingsTier, diagnostics: ITierReadDiagnostic[]): Promise<JsonObject | undefined> {
		const raw = await this.registryReader.readPolicySettings(hive);
		if (raw === undefined || raw.trim().length === 0) { return undefined; }
		const body = parsePolicySettings(raw);
		if (body === undefined) {
			diagnostics.push({ tier, kind: 'malformed', detail: localize('clawdius.eff.registryMalformed', "The {0} registry managed-policy value is not valid JSON.", hive) });
		}
		return body;
	}

	/** The local system directory that holds managed-settings.json for THIS host's OS. A test seam so the managed
	 *  fold can be exercised over a fake filesystem without depending on a real drive-letter system path. */
	protected managedRootUri(): URI {
		return URI.file(managedSettingsRoot(OS));
	}

	/** managed-settings.json + the managed-settings.d/*.json drop-ins, folded systemd-style (base first, then the
	 *  drop-ins alphabetically). Local-only; the caller has already checked the home is on the file scheme. */
	private async readManagedFile(diagnostics: ITierReadDiagnostic[]): Promise<JsonObject | undefined> {
		const root = this.managedRootUri();
		const bodies: JsonObject[] = [];
		const base = await this.readJsonc(URI.joinPath(root, MANAGED_SETTINGS_JSON), SettingsTier.ManagedFile, diagnostics);
		if (base !== undefined) { bodies.push(base); }
		try {
			const dir = await this.fileService.resolve(URI.joinPath(root, MANAGED_SETTINGS_DROPIN_DIR));
			const dropins = (dir.children ?? [])
				.filter(c => !c.isDirectory && c.name.endsWith('.json'))
				.sort((a, b) => a.name.localeCompare(b.name));
			for (const f of dropins) {
				const body = await this.readJsonc(f.resource, SettingsTier.ManagedFile, diagnostics);
				if (body !== undefined) { bodies.push(body); }
			}
		} catch {
			// No drop-in directory - the base file (if any) stands alone.
		}
		return bodies.length === 0 ? undefined : mergeSettingsChain(bodies);
	}
}
// CLAWDIUS-END
