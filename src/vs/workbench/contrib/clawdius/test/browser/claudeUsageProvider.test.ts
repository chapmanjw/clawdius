/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeProvider, engineIsAnthropic, providerFromEnv } from '../../../../../platform/clawdius/common/claudeUsageProvider.js';
import { usageHomePath } from '../../browser/usage/claudeUsageData.js';

suite('claudeUsageProvider', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// --- providerFromEnv --------------------------------------------------------------------------------------

	test('providerFromEnv: Anthropic default, Bedrock/Vertex flags, custom vs anthropic base URL, empty env', () => {
		assert.deepStrictEqual(
			[
				providerFromEnv({}),
				providerFromEnv({ CLAUDE_CODE_USE_BEDROCK: true }),
				providerFromEnv({ CLAUDE_CODE_USE_VERTEX: 1 }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://proxy.internal/v1' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: '' }),
			],
			[
				ClaudeProvider.Anthropic,
				ClaudeProvider.Bedrock,
				ClaudeProvider.Vertex,
				ClaudeProvider.Custom,
				ClaudeProvider.Anthropic,
				ClaudeProvider.Anthropic,
			],
		);
	});

	test('providerFromEnv: host-spoof base URLs are Custom, not Anthropic (egress gate)', () => {
		// The provider gate must classify by the parsed HOST, not a substring/regex match, so a lookalike or
		// userinfo/query/fragment trick cannot be mistaken for Anthropic and leak the CLI OAuth token. Genuine
		// forms (port, path, uppercase, http) stay Anthropic; unparseable/scheme-less fail closed to Custom.
		assert.deepStrictEqual(
			[
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com@evil.example/' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://evil.example?@api.anthropic.com' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://evil.example#@api.anthropic.com' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com.evil.example/' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'ftp://api.anthropic.com' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'api.anthropic.com' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com:443/v1' }),
				providerFromEnv({ ANTHROPIC_BASE_URL: 'http://API.ANTHROPIC.COM' }),
			],
			[
				ClaudeProvider.Custom,
				ClaudeProvider.Custom,
				ClaudeProvider.Custom,
				ClaudeProvider.Custom,
				ClaudeProvider.Custom,
				ClaudeProvider.Custom,
				ClaudeProvider.Anthropic,
				ClaudeProvider.Anthropic,
			],
		);
	});

	// --- engineIsAnthropic ------------------------------------------------------------------------------------

	test('engineIsAnthropic: true only for Anthropic, false for Bedrock/Vertex/Custom', () => {
		assert.deepStrictEqual(
			[
				engineIsAnthropic({}),
				engineIsAnthropic({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' }),
				engineIsAnthropic({ CLAUDE_CODE_USE_BEDROCK: true }),
				engineIsAnthropic({ CLAUDE_CODE_USE_VERTEX: 'true' }),
				engineIsAnthropic({ ANTHROPIC_BASE_URL: 'https://proxy.internal/v1' }),
			],
			[true, true, false, false, false],
		);
	});

	// --- usageHomePath ----------------------------------------------------------------------------------------

	test('usageHomePath: file URI resolves to fsPath, vscode-remote URI resolves to its POSIX path', () => {
		// A local home is a file:// URI (its native fsPath); a WSL/SSH remote home is a vscode-remote:// URI whose
		// `.path` is the remote POSIX home. fsPath would mangle the remote URI, so the file branch must use fsPath
		// and the remote branch must use `.path`. The file case compares against fsPath (computed) so the assertion
		// holds on any harness OS; the remote case pins the literal POSIX path.
		const fileHome = URI.file('/home/jdoe');
		const remoteHome = URI.from({ scheme: Schemas.vscodeRemote, authority: 'wsl+ubuntu', path: '/home/jdoe' });
		assert.deepStrictEqual(
			[usageHomePath(fileHome), usageHomePath(remoteHome)],
			[fileHome.fsPath, '/home/jdoe'],
		);
	});
});
