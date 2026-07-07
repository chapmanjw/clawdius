/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildOptions, buildSubprocessEnv } from '../../node/claude/claudeSdkOptions.js';
import type { IClawdiusCliResolution } from '../../../clawdius/common/clawdiusCliConfig.js';

suite('claudeSdkOptions / buildSubprocessEnv', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const SAVED_ENV = { ...process.env };
	const KNOWN_KEYS = [
		'ELECTRON_RUN_AS_NODE',
		'NODE_OPTIONS',
		'ANTHROPIC_API_KEY',
		'VSCODE_PID',
		'VSCODE_NLS_CONFIG',
		'ELECTRON_NO_ATTACH_CONSOLE',
		'PATH',
		'HOME',
		'OTEL_EXPORTER_OTLP_ENDPOINT',
		'OTEL_SERVICE_NAME',
		'COPILOT_OTEL_TOKEN',
	];

	function clearAndSet(values: Record<string, string>): void {
		for (const key of KNOWN_KEYS) { delete process.env[key]; }
		for (const [key, value] of Object.entries(values)) { process.env[key] = value; }
	}

	teardown(() => {
		for (const key of KNOWN_KEYS) { delete process.env[key]; }
		for (const [key, value] of Object.entries(SAVED_ENV)) {
			if (value !== undefined) { process.env[key] = value; }
		}
	});

	test('strips VSCODE_*, ELECTRON_*, NODE_OPTIONS, ANTHROPIC_API_KEY; keeps ELECTRON_RUN_AS_NODE; preserves unrelated vars', () => {
		clearAndSet({
			VSCODE_PID: '1234',
			VSCODE_NLS_CONFIG: '{}',
			ELECTRON_NO_ATTACH_CONSOLE: '1',
			NODE_OPTIONS: '--inspect',
			ANTHROPIC_API_KEY: 'sk-leak',
			PATH: '/usr/bin',
			HOME: '/Users/test',
		});

		const env = buildSubprocessEnv();

		assert.deepStrictEqual({
			runAsNode: env.ELECTRON_RUN_AS_NODE,
			nodeOptions: env.NODE_OPTIONS,
			anthropicKey: env.ANTHROPIC_API_KEY,
			vscodePid: env.VSCODE_PID,
			vscodeNls: env.VSCODE_NLS_CONFIG,
			electronOther: env.ELECTRON_NO_ATTACH_CONSOLE,
			path: env.PATH,
			home: env.HOME,
		}, {
			runAsNode: '1',
			nodeOptions: undefined,
			anthropicKey: undefined,
			vscodePid: undefined,
			vscodeNls: undefined,
			electronOther: undefined,
			path: undefined, // not explicitly forwarded; PATH is composed in settingsEnv, not subprocessEnv
			home: undefined, // unrelated vars are simply absent from the override map (inherited by SDK)
		});
	});

	test('always sets ELECTRON_RUN_AS_NODE=1 even when not present in process.env', () => {
		clearAndSet({});

		const env = buildSubprocessEnv();

		assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1');
	});

	test('native mode (proxied=false) inherits auth vars + PATH (SDK replace semantics) while still stripping VSCODE_*/ELECTRON_*/NODE_OPTIONS', () => {
		clearAndSet({
			VSCODE_PID: '1234',
			ELECTRON_NO_ATTACH_CONSOLE: '1',
			NODE_OPTIONS: '--inspect',
			ANTHROPIC_API_KEY: 'sk-user-key',
			CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-user',
			PATH: '/usr/bin',
			HOME: '/Users/test',
		});

		const env = buildSubprocessEnv(false);

		assert.deepStrictEqual({
			// Inherited so the user's own credentials reach the `claude` subprocess.
			anthropicKey: env.ANTHROPIC_API_KEY,
			oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
			path: env.PATH,
			home: env.HOME,
			// Still stripped — these break the Electron-node subprocess.
			vscodePid: env.VSCODE_PID,
			electronOther: env.ELECTRON_NO_ATTACH_CONSOLE,
			nodeOptions: env.NODE_OPTIONS,
			runAsNode: env.ELECTRON_RUN_AS_NODE,
		}, {
			anthropicKey: 'sk-user-key',
			oauthToken: 'sk-ant-oat-user',
			path: '/usr/bin',
			home: '/Users/test',
			vscodePid: undefined,
			electronOther: undefined,
			nodeOptions: undefined,
			runAsNode: '1',
		});
	});

	test('strips OTEL_*/COPILOT_OTEL_* in both modes so the subprocess cannot inherit an OTLP exporter (zero egress)', () => {
		clearAndSet({
			OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
			OTEL_SERVICE_NAME: 'leak',
			COPILOT_OTEL_TOKEN: 'tok',
			PATH: '/usr/bin',
		});

		// The scrub must hold in BOTH the proxy and native branches - an inherited OTLP endpoint would let the
		// claude subprocess export traces off-box, defeating the zero-egress posture.
		for (const proxied of [true, false]) {
			const env = buildSubprocessEnv(proxied);
			assert.deepStrictEqual({
				endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
				service: env.OTEL_SERVICE_NAME,
				copilotOtel: env.COPILOT_OTEL_TOKEN,
			}, {
				endpoint: undefined,
				service: undefined,
				copilotOtel: undefined,
			}, `proxied=${proxied}`);
		}
	});
});

suite('claudeSdkOptions / buildOptions plugins projection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const BUNDLED: IClawdiusCliResolution = { mode: 'bundled', executable: 'node', extraEnv: {}, providerPreset: 'oauth', disableLoginPrompt: false };

	function input(plugins: readonly URI[] | undefined, cliResolution: IClawdiusCliResolution = BUNDLED, trusted = true) {
		return {
			sessionId: 's1',
			workingDirectory: URI.file('/tmp/x'),
			model: undefined,
			abortController: new AbortController(),
			permissionMode: 'default' as const,
			trusted,
			canUseTool: async () => ({ behavior: 'allow' as const, updatedInput: {} }),
			isResume: false,
			mcpServers: undefined,
			cliResolution,
			...(plugins !== undefined ? { plugins } : {}),
		};
	}

	test('Barrier 1: an untrusted workspace forces default mode, empty settingSources, no skip', async () => {
		const opts = await buildOptions(input(undefined, BUNDLED, /*trusted*/ false), () => { }, () => { });
		assert.strictEqual(opts.permissionMode, 'default');
		assert.deepStrictEqual(opts.settingSources, []);
		assert.strictEqual(opts.allowDangerouslySkipPermissions, false);
	});

	test('Barrier 1: a trusted workspace loads all settingSources and honours bypassPermissions', async () => {
		const opts = await buildOptions({ ...input(undefined), permissionMode: 'bypassPermissions' as const, trusted: true }, () => { }, () => { });
		assert.deepStrictEqual(opts.settingSources, ['user', 'project', 'local']);
		assert.strictEqual(opts.allowDangerouslySkipPermissions, true);
		assert.strictEqual(opts.permissionMode, 'bypassPermissions');
	});

	test('Barrier 1: an untrusted bypassPermissions request is neutralised', async () => {
		const opts = await buildOptions({ ...input(undefined), permissionMode: 'bypassPermissions' as const, trusted: false }, () => { }, () => { });
		assert.strictEqual(opts.allowDangerouslySkipPermissions, false);
		assert.strictEqual(opts.permissionMode, 'default');
		assert.deepStrictEqual(opts.settingSources, []);
	});

	test('non-empty plugins project to Options.plugins as local entries', async () => {
		const opts = await buildOptions(
			input([URI.file('/p/a'), URI.file('/p/b')]),
			() => { },
			() => { },
		);
		assert.deepStrictEqual(opts.plugins, [
			{ type: 'local', path: URI.file('/p/a').fsPath },
			{ type: 'local', path: URI.file('/p/b').fsPath },
		]);
	});

	test('empty plugins array omits Options.plugins', async () => {
		const opts = await buildOptions(input([]), () => { }, () => { });
		assert.strictEqual(opts.plugins, undefined);
	});

	test('undefined plugins omits Options.plugins', async () => {
		const opts = await buildOptions(input(undefined), () => { }, () => { });
		assert.strictEqual(opts.plugins, undefined);
	});

	test('bundled resolution maps executable to the current binary and omits pathToClaudeCodeExecutable', async () => {
		const opts = await buildOptions(input(undefined, { mode: 'bundled', executable: 'node', extraEnv: {}, providerPreset: 'oauth', disableLoginPrompt: false }), () => { }, () => { });
		assert.strictEqual(opts.executable, process.execPath);
		assert.strictEqual(opts.pathToClaudeCodeExecutable, undefined);
	});

	test('userCli resolution points the SDK at the user cli.js', async () => {
		const opts = await buildOptions(input(undefined, { mode: 'userCli', executable: 'node', pathToClaudeCodeExecutable: '/u/claude/cli.js', extraEnv: {}, providerPreset: 'oauth', disableLoginPrompt: false }), () => { }, () => { });
		assert.strictEqual(opts.pathToClaudeCodeExecutable, '/u/claude/cli.js');
	});

	test('extraEnv overlays onto the subprocess env (base env preserved)', async () => {
		const opts = await buildOptions(input(undefined, { mode: 'bundled', executable: 'node', extraEnv: { CLAUDE_CODE_USE_BEDROCK: '1' }, providerPreset: 'bedrock', disableLoginPrompt: true }), () => { }, () => { });
		const env = opts.env as Record<string, string | undefined>;
		assert.strictEqual(env.CLAUDE_CODE_USE_BEDROCK, '1');
		assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1');
	});

	test('user env overlay cannot reintroduce a scrubbed reserved key (scrub wins)', async () => {
		const opts = await buildOptions(input(undefined, { mode: 'bundled', executable: 'node', extraEnv: { NODE_OPTIONS: '--inspect', SAFE_VAR: 'ok' }, providerPreset: 'oauth', disableLoginPrompt: false }), () => { }, () => { });
		const env = opts.env as Record<string, string | undefined>;
		assert.strictEqual(env.NODE_OPTIONS, undefined); // the deliberate scrub wins over the user overlay
		assert.strictEqual(env.SAFE_VAR, 'ok'); // a non-reserved user var still passes through
	});

	test('wrapper resolution projects spawnClaudeCodeProcess (enterprise wrapper launch)', async () => {
		const opts = await buildOptions(input(undefined, { mode: 'wrapper', executable: 'node', wrapperPath: '/opt/ent/claude', wrapperTarget: 'bundled', extraEnv: {}, providerPreset: 'oauth', disableLoginPrompt: false }), () => { }, () => { });
		assert.strictEqual(typeof opts.spawnClaudeCodeProcess, 'function');
	});

	test('non-wrapper resolution omits spawnClaudeCodeProcess', async () => {
		const opts = await buildOptions(input(undefined, { mode: 'bundled', executable: 'node', extraEnv: {}, providerPreset: 'oauth', disableLoginPrompt: false }), () => { }, () => { });
		assert.strictEqual(opts.spawnClaudeCodeProcess, undefined);
	});
});
