/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { ClawdiusCliProviderPreset, IClawdiusCliConfigService, IClawdiusCliResolution, IClawdiusCliSettings, projectCliResolution } from '../common/clawdiusCliConfig.js';

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
		const settings: IClawdiusCliSettings = {
			wrapperPath: this._configurationService.getValue<string | undefined>('clawdius.cli.wrapperPath'),
			nodeCliPath: this._configurationService.getValue<string | undefined>('clawdius.cli.nodeCliPath'),
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
		return resolution;
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
}
