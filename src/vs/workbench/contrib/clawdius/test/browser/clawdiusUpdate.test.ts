/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer, bufferToStream } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClawdiusUpdateService, ClawdiusUpdateStartupContribution, IClawdiusUpdateService, IGithubRelease, isNewer, pickRelease } from '../../browser/update/clawdiusUpdateService.js';

function rel(tag: string, opts?: { prerelease?: boolean; draft?: boolean }): IGithubRelease {
	return {
		tag_name: tag,
		html_url: `https://example.test/${tag}`,
		prerelease: !!opts?.prerelease,
		draft: !!opts?.draft,
	};
}

suite('clawdiusUpdate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// --- pickRelease ------------------------------------------------------------------------------------------

	test('pickRelease: stable picks the newest non-prerelease and ignores prereleases', () => {
		const releases = [rel('v1.2.0'), rel('v1.3.0-beta1', { prerelease: true }), rel('v1.2.5')];
		assert.strictEqual(pickRelease(releases, 'stable')?.tag_name, 'v1.2.5');
	});

	test('pickRelease: prerelease picks the newest including prereleases', () => {
		const releases = [rel('v1.2.0'), rel('v1.3.0-beta1', { prerelease: true }), rel('v1.2.5')];
		assert.strictEqual(pickRelease(releases, 'prerelease')?.tag_name, 'v1.3.0-beta1');
	});

	test('pickRelease: drafts are always excluded on both channels', () => {
		const releases = [rel('v2.0.0', { draft: true }), rel('v2.1.0-rc1', { prerelease: true, draft: true }), rel('v1.9.0')];
		assert.strictEqual(pickRelease(releases, 'stable')?.tag_name, 'v1.9.0');
		assert.strictEqual(pickRelease(releases, 'prerelease')?.tag_name, 'v1.9.0');
	});

	test('pickRelease: empty list and no-match return undefined', () => {
		assert.strictEqual(pickRelease([], 'stable'), undefined);
		// On the stable channel a list of only prereleases yields no match.
		assert.strictEqual(pickRelease([rel('v1.0.0-rc1', { prerelease: true })], 'stable'), undefined);
	});

	test('pickRelease: tags with and without a leading v compare by semver, not lexically', () => {
		const releases = [rel('1.2.0'), rel('v1.10.0')];
		// 1.10.0 > 1.2.0 numerically (a lexical compare would wrongly pick "1.2.0").
		assert.strictEqual(pickRelease(releases, 'stable')?.tag_name, 'v1.10.0');
	});

	// --- isNewer ----------------------------------------------------------------------------------------------

	test('isNewer: prerelease ordering, stable over its prerelease, equal/older/invalid', () => {
		assert.deepStrictEqual(
			[
				isNewer('1.125.0-alpha4', '1.125.0-alpha3'),
				isNewer('1.125.0', '1.125.0-alpha3'),
				isNewer('v1.125.0', '1.125.0-alpha3'),
				isNewer('1.125.0', '1.125.0'),
				isNewer('1.124.0', '1.125.0'),
				isNewer('not-a-version', '1.125.0'),
				isNewer('1.125.0', 'not-a-version'),
			],
			[true, true, true, false, false, false, false],
		);
	});

	// --- ClawdiusUpdateStartupContribution gating (the falsifiable backstop the branding-guard grep cannot be) --

	function fakeConfig(values: Record<string, unknown>): IConfigurationService {
		return { getValue: (key: string) => values[key] } as unknown as IConfigurationService;
	}

	function recordingUpdateService(): { service: IClawdiusUpdateService; calls: ('user' | 'startup')[] } {
		const calls: ('user' | 'startup')[] = [];
		const service = { checkForUpdates: (trigger: 'user' | 'startup') => { calls.push(trigger); return Promise.resolve(); } } as unknown as IClawdiusUpdateService;
		return { service, calls };
	}

	test('startup gate: checkOnStartup=false fires no check (no launch egress)', () => {
		const { service, calls } = recordingUpdateService();
		new ClawdiusUpdateStartupContribution(fakeConfig({ 'clawdius.update.checkOnStartup': false }), service);
		assert.deepStrictEqual(calls, []);
	});

	test('startup gate: checkOnStartup=true fires exactly one startup check', () => {
		const { service, calls } = recordingUpdateService();
		new ClawdiusUpdateStartupContribution(fakeConfig({ 'clawdius.update.checkOnStartup': true }), service);
		assert.deepStrictEqual(calls, ['startup']);
	});

	test('startup gate: an absent/non-true setting does not fire (defaults off)', () => {
		const { service, calls } = recordingUpdateService();
		new ClawdiusUpdateStartupContribution(fakeConfig({}), service);
		assert.deepStrictEqual(calls, []);
	});

	// --- ClawdiusUpdateService.checkForUpdates orchestration (user vs startup quiet/loud, error swallowing) -----

	function buildService(opts: { current: string; channel?: 'stable' | 'prerelease'; release?: IGithubRelease; reject?: boolean }) {
		const prompts: string[] = [];
		const infos: string[] = [];
		const warns: string[] = [];
		const notificationService = {
			prompt: (_sev: unknown, message: string) => { prompts.push(message); return { close: () => { } }; },
			info: (message: string) => { infos.push(message); },
			warn: (message: string) => { warns.push(message); },
		} as unknown as INotificationService;
		const requestService = {
			request: async () => {
				if (opts.reject) { throw new Error('offline'); }
				const isPrerelease = opts.channel === 'prerelease';
				// Stable /releases/latest returns 404 when there is no non-prerelease release.
				const statusCode = (!isPrerelease && !opts.release) ? 404 : 200;
				const body = isPrerelease ? (opts.release ? [opts.release] : []) : (opts.release ?? null);
				return { res: { statusCode, headers: {} }, stream: bufferToStream(VSBuffer.fromString(JSON.stringify(body))) };
			},
		} as unknown as IRequestService;
		const service = new ClawdiusUpdateService(
			fakeConfig({ 'clawdius.update.channel': opts.channel ?? 'stable' }),
			requestService,
			{ open: async (_uri: URI) => true } as unknown as IOpenerService,
			notificationService,
			{ version: opts.current } as unknown as IProductService,
			{ warn: () => { } } as unknown as ILogService,
		);
		return { service, prompts, infos, warns };
	}

	test('checkForUpdates: newer release + user -> prompt naming the version', async () => {
		const { service, prompts, infos } = buildService({ current: '1.0.0', release: rel('v1.1.0') });
		await service.checkForUpdates('user');
		assert.strictEqual(prompts.length, 1);
		assert.ok(prompts[0].includes('1.1.0'), `prompt should name the version: ${prompts[0]}`);
		assert.strictEqual(infos.length, 0);
	});

	test('checkForUpdates: up-to-date + user -> info, no prompt', async () => {
		const { service, prompts, infos } = buildService({ current: '1.1.0', release: rel('v1.1.0') });
		await service.checkForUpdates('user');
		assert.strictEqual(prompts.length, 0);
		assert.strictEqual(infos.length, 1);
	});

	test('checkForUpdates: up-to-date + startup -> fully silent', async () => {
		const { service, prompts, infos, warns } = buildService({ current: '1.1.0', release: rel('v1.1.0') });
		await service.checkForUpdates('startup');
		assert.deepStrictEqual([prompts.length, infos.length, warns.length], [0, 0, 0]);
	});

	test('checkForUpdates: stable 404 (no stable release) + user -> up-to-date info, not a failure', async () => {
		const { service, warns, infos } = buildService({ current: '1.0.0', channel: 'stable' });
		await service.checkForUpdates('user');
		assert.strictEqual(warns.length, 0);
		assert.strictEqual(infos.length, 1);
	});

	test('checkForUpdates: request error + user -> warn, never throws', async () => {
		const { service, prompts, warns } = buildService({ current: '1.0.0', reject: true });
		await service.checkForUpdates('user');
		assert.strictEqual(warns.length, 1);
		assert.strictEqual(prompts.length, 0);
	});

	test('checkForUpdates: request error + startup -> silent', async () => {
		const { service, prompts, infos, warns } = buildService({ current: '1.0.0', reject: true });
		await service.checkForUpdates('startup');
		assert.deepStrictEqual([prompts.length, infos.length, warns.length], [0, 0, 0]);
	});
});
