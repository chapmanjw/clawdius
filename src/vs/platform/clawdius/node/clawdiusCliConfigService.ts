/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { delimiter, join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { ClawdiusCliProviderPreset, IClawdiusCliConfigService, IClawdiusCliResolution, IClawdiusCliSettings, projectCliResolution } from '../common/clawdiusCliConfig.js';

/**
 * File names of the Claude Code native binary, by platform. Deliberately excludes `.cmd`/`.bat` shims: those
 * are shell launchers, not directly-spawnable engines, and the Agent SDK would try to exec them as a native
 * binary. `claude` (no extension) covers the official native installer's output on every platform (on this
 * machine it is a PE binary named plain `claude`).
 */
const CLAUDE_BINARY_NAMES: readonly string[] = process.platform === 'win32' ? ['claude.exe', 'claude'] : ['claude'];

function narrowProviderPreset(value: unknown): ClawdiusCliProviderPreset | undefined {
	switch (value) {
		case 'oauth':
		case 'bedrock':
		case 'vertex':
		case 'foundry':
		case 'custom':
			return value;
		default:
			return undefined;
	}
}

function narrowEnvironmentVariables(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === 'string') { out[k] = v; }
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Agent-host node-process implementation of {@link IClawdiusCliConfigService}. Reads the `clawdius.cli.*`
 * settings from the agent-host {@link IConfigurationService} (which is backed by the user `settings.json`;
 * see `agentHostBootstrap.ts`), checks the named paths for existence via {@link IFileService}, and projects
 * a {@link IClawdiusCliResolution} through the pure {@link projectCliResolution}. Performs NO network and
 * spawns NO process — existence checks only — preserving Clawdius's zero-uninitiated-egress posture.
 */
export class ClawdiusCliConfigService implements IClawdiusCliConfigService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async resolveCliBackend(): Promise<IClawdiusCliResolution> {
		const explicitNodeCliPath = this._configurationService.getValue<string | undefined>('clawdius.cli.nodeCliPath')?.trim() || undefined;
		const wrapperPath = this._configurationService.getValue<string | undefined>('clawdius.cli.wrapperPath');
		const preferInstalled = this._configurationService.getValue<boolean | undefined>('clawdius.cli.preferInstalledCli') ?? true;

		// When the user has NOT explicitly pinned an engine (no nodeCliPath, no wrapper) and hasn't opted out,
		// auto-detect their installed Claude Code engine and prefer it over the bundled one. This is what keeps
		// the fork from drifting: the model catalog and behavior track the user's own, self-updating install
		// (the same engine they run in a terminal) instead of a version frozen into the bundled SDK. Detection
		// is filesystem-only (existence checks) - no network, no process spawn.
		let nodeCliPath = explicitNodeCliPath;
		let autoDetected = false;
		if (!nodeCliPath && !wrapperPath?.trim() && preferInstalled) {
			const detected = await this._detectInstalledCli();
			if (detected) {
				nodeCliPath = detected;
				autoDetected = true;
			}
		}

		const settings: IClawdiusCliSettings = {
			wrapperPath,
			nodeCliPath,
			environmentVariables: narrowEnvironmentVariables(this._configurationService.getValue('clawdius.cli.environmentVariables')),
			disableLoginPrompt: this._configurationService.getValue<boolean | undefined>('clawdius.cli.disableLoginPrompt'),
			providerPreset: narrowProviderPreset(this._configurationService.getValue('clawdius.cli.providerPreset')),
		};

		const existence = {
			wrapperPathExists: await this._exists(settings.wrapperPath),
			nodeCliPathExists: await this._exists(settings.nodeCliPath),
		};

		const resolution = projectCliResolution(settings, existence);
		if (resolution.unsupportedReason) {
			this._logService.warn(`[Clawdius CLI] ${resolution.unsupportedReason}`);
		}
		if (autoDetected && resolution.mode === 'userCli') {
			this._logService.info(`[Clawdius CLI] Using your installed Claude Code engine at '${nodeCliPath}' (auto-detected). Set clawdius.cli.preferInstalledCli to false to use the bundled engine, or clawdius.cli.nodeCliPath to pin a specific one.`);
		}
		return resolution;
	}

	/**
	 * Look for an installed Claude Code native binary (existence-only; no spawn). Checks the official native
	 * installer location (`~/.local/bin`) FIRST - the user's canonical, self-updating engine - then each `PATH`
	 * directory, returning the first existing file. Returns an ABSOLUTE path so it is safe to hand to the SDK's
	 * `pathToClaudeCodeExecutable` (which does not PATH-resolve). Returns `undefined` when none is found, so the
	 * caller falls back to the bundled engine.
	 */
	private async _detectInstalledCli(): Promise<string | undefined> {
		const dirs: string[] = [join(homedir(), '.local', 'bin')];
		for (const entry of (process.env.PATH ?? '').split(delimiter)) {
			const dir = entry.trim();
			if (dir) {
				dirs.push(dir);
			}
		}
		const seen = new Set<string>();
		for (const dir of dirs) {
			for (const name of CLAUDE_BINARY_NAMES) {
				const candidate = join(dir, name);
				const key = candidate.toLowerCase();
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				if (await this._isFile(candidate)) {
					return candidate;
				}
			}
		}
		return undefined;
	}

	private async _exists(path: string | undefined): Promise<boolean> {
		const trimmed = path?.trim();
		if (!trimmed) {
			return false;
		}
		try {
			return await this._fileService.exists(URI.file(trimmed));
		} catch {
			return false;
		}
	}

	/** Existence check that also rejects a directory, so a directory named `claude` on the PATH is not picked. */
	private async _isFile(path: string): Promise<boolean> {
		try {
			const stat = await this._fileService.stat(URI.file(path));
			return !stat.isDirectory;
		} catch {
			return false;
		}
	}
}
