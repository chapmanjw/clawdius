/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN live MCP tool discovery (#93) - untrusted-workspace guard
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IClawdiusCliConfigService } from '../../../clawdius/common/clawdiusCliConfig.js';
import { ClaudeMcpToolDiscoveryService } from '../../node/claude/claudeMcpToolDiscoveryService.js';
import { IClaudeAgentSdkService } from '../../node/claude/claudeAgentSdkService.js';

suite('claudeMcpToolDiscoveryService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('untrusted discovery is refused before any CLI resolution or session spawn', async () => {
		// Both dependencies throw if touched: the refusal must happen before the service resolves the CLI
		// backend or starts an SDK session (a discovery session would spawn the repo's `.mcp.json` commands).
		const sdkService = {
			startup: () => { throw new Error('startup() must not be called for an untrusted discovery'); },
		} as unknown as IClaudeAgentSdkService;
		const cliConfig = {
			resolveCliBackend: () => { throw new Error('resolveCliBackend() must not be called for an untrusted discovery'); },
		} as unknown as IClawdiusCliConfigService;

		const service = new ClaudeMcpToolDiscoveryService(sdkService, cliConfig, new NullLogService());
		const result = await service.discoverServerTools('someServer', 'C:\\some\\repo', false);

		assert.deepStrictEqual(
			{ status: result.status, tools: result.tools, hasMessage: typeof result.message === 'string' && result.message.length > 0 },
			{ status: 'untrusted', tools: [], hasMessage: true },
		);
	});
});
// CLAWDIUS-END
