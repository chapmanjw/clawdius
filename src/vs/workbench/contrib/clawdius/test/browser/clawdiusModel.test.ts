/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN model status pill unit tests
// Covers the model list build over the LIVE SDK catalog (real display names + descriptions + the 1M-context
// variants, rendered in catalog order, mirroring the plugin's chat picker), the config/env union for proxied
// ids, the "[1m] is a real 1M suffix, not junk" cleaning rule, unset-key -> Default resolution, the
// settings.json parse/write logic, and the compact status-bar label.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { timeout } from '../../../../../base/common/async.js';
import { IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	ClawdiusModelStatusEntry,
	MODEL_KEY,
	DEFAULT_MODEL,
	ICatalogModel,
	IModelWrite,
	buildModelList,
	cleanModelId,
	envModelIdsFrom,
	modelDisplay,
	modelPicks,
	modelWrites,
	normalizeFamily,
	parseSettingsState,
	planModelEdit,
	resolveCurrent,
	sanitizeModelId,
	shortModelLabel,
} from '../../browser/clawdiusModelStatusEntry.js';

/** Mirror of IJSONEditingService's merge for single-segment paths: set the key, or delete on undefined. */
function applyWrites(base: Record<string, unknown>, writes: readonly IModelWrite[]): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const w of writes) {
		const key = w.path[0];
		if (w.value === undefined) {
			delete out[key];
		} else {
			out[key] = w.value;
		}
	}
	return out;
}

// A live catalog shaped like the real SDK `supportedModels()` output: a "default" entry, the 1M-context
// variants (id suffix `[1m]`), descriptions carrying the version, and one entry (Fable) with no description.
const CATALOG: ICatalogModel[] = [
	{ id: 'default', name: 'Default (recommended)', maxContextWindow: 1_000_000, description: 'Opus 4.8 with 1M context - Best for everyday, complex tasks' },
	{ id: 'opus[1m]', name: 'Opus (1M context)', maxContextWindow: 1_000_000, description: 'Opus 4.8 with 1M context - Best for everyday, complex tasks' },
	{ id: 'sonnet', name: 'Sonnet', maxContextWindow: 200_000, description: 'Sonnet 5 - Efficient for routine tasks' },
	{ id: 'haiku', name: 'Haiku', maxContextWindow: 200_000, description: 'Haiku 4.5 - Fastest for quick answers' },
	{ id: 'claude-fable-5[1m]', name: 'Fable', maxContextWindow: 1_000_000, description: undefined },
];

suite('Clawdius model pill', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('settings key matches the CLI source-of-truth file', () => {
		assert.strictEqual(MODEL_KEY, 'model');
		assert.strictEqual(DEFAULT_MODEL, '');
	});

	test('normalizeFamily maps aliases and full ids, rejects unknown/proxied', () => {
		assert.strictEqual(normalizeFamily('opus'), 'opus');
		assert.strictEqual(normalizeFamily('sonnet'), 'sonnet');
		assert.strictEqual(normalizeFamily('haiku'), 'haiku');
		assert.strictEqual(normalizeFamily('claude-opus-4.7'), 'opus');
		assert.strictEqual(normalizeFamily('default'), undefined);
		assert.strictEqual(normalizeFamily('claude-fable-5[1m]'), undefined); // Fable is not opus/sonnet/haiku
		assert.strictEqual(normalizeFamily('my-local-llama'), undefined);
		assert.strictEqual(normalizeFamily(undefined), undefined);
	});

	test('buildModelList (live catalog): renders the catalog verbatim, in order, with its descriptions, no synthetic Default', () => {
		const list = buildModelList(CATALOG, 'opus[1m]', []);
		// Catalog order is preserved exactly (this mirrors the plugin's picker) - no synthetic Default prepended.
		assert.deepStrictEqual(list.map(m => m.id), ['default', 'opus[1m]', 'sonnet', 'haiku', 'claude-fable-5[1m]']);
		assert.ok(!list.some(m => m.isDefault), 'no synthetic Default row when the live catalog is present');
		// The live description is used verbatim.
		assert.strictEqual(list.find(m => m.id === 'sonnet')!.detail, 'Sonnet 5 - Efficient for routine tasks');
		// A catalog entry with no description and no known family gets no invented blurb.
		assert.strictEqual(list.find(m => m.id === 'claude-fable-5[1m]')!.detail, undefined);
		// The 1M id is kept intact (NOT stripped) so it matches the configured value.
		assert.strictEqual(list.filter(m => m.id === 'opus[1m]').length, 1);
	});

	test('buildModelList (empty catalog): falls back to authored family names + a synthetic Default', () => {
		const list = buildModelList([], DEFAULT_MODEL, ['local-qwen']);
		assert.deepStrictEqual(list.map(m => m.id), [DEFAULT_MODEL, 'opus', 'sonnet', 'haiku', 'local-qwen']);
		assert.strictEqual(list[0].isDefault, true);
		assert.ok(list[1].detail && list[1].detail.length > 0, 'authored family blurb in fallback');
		assert.strictEqual(list.find(m => m.id === 'local-qwen')!.detail, undefined, 'no invented blurb for a local id');
	});

	test('buildModelList: a proxied/configured id not in the catalog is appended NAME-ONLY (no invented blurb)', () => {
		const arn = 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.mystery-x';
		const list = buildModelList(CATALOG, arn, []);
		const row = list.find(m => m.id === arn);
		assert.ok(row, 'the configured proxied id is present');
		assert.strictEqual(row!.label, arn, 'label is the raw id');
		assert.strictEqual(row!.detail, undefined, 'no fabricated blurb for an unknown id');
	});

	test('buildModelList: env-declared ids are unioned and de-duped against catalog + configured', () => {
		const list = buildModelList(CATALOG, 'opus[1m]', ['opus[1m]', 'my-proxy-model', 'my-proxy-model']);
		const ids = list.map(m => m.id);
		assert.strictEqual(ids.filter(x => x === 'opus[1m]').length, 1, 'catalog id not duplicated by the configured value');
		assert.strictEqual(ids.filter(x => x === 'my-proxy-model').length, 1, 'env id appears once');
	});

	test('resolveCurrent: unset key resolves to the catalog "default" row; a set value is used as-is', () => {
		const live = buildModelList(CATALOG, DEFAULT_MODEL, []);
		assert.strictEqual(resolveCurrent(DEFAULT_MODEL, live), 'default', 'unset -> the recommended default row');
		assert.strictEqual(resolveCurrent('opus[1m]', live), 'opus[1m]', 'a concrete selection is preserved');
		const fallback = buildModelList([], DEFAULT_MODEL, []);
		assert.strictEqual(resolveCurrent(DEFAULT_MODEL, fallback), DEFAULT_MODEL, 'no catalog default -> stays unset');
	});

	test('sanitizeModelId strips only control chars; a real "[1m]" 1M suffix is PRESERVED', () => {
		// "[1m]" is a genuine model-id suffix for the 1M-context variant, NOT junk - it must survive.
		assert.strictEqual(sanitizeModelId('opus[1m]'), 'opus[1m]');
		assert.strictEqual(sanitizeModelId('claude-fable-5[1m]'), 'claude-fable-5[1m]');
		// A stray ESC (U+001B) control byte IS stripped (leaving the rest intact).
		assert.strictEqual(sanitizeModelId(String.fromCharCode(27) + 'opus[1m]'), 'opus[1m]');
		// Real ids pass through unchanged.
		assert.strictEqual(sanitizeModelId('opus'), 'opus');
		assert.strictEqual(sanitizeModelId('claude-opus-4.7'), 'claude-opus-4.7');
		assert.strictEqual(sanitizeModelId('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-x'), 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-x');
	});

	test('cleanModelId: blank -> undefined; non-string -> undefined; a real "[1m]" id is kept', () => {
		assert.strictEqual(cleanModelId('opus[1m]'), 'opus[1m]');
		assert.strictEqual(cleanModelId('   '), undefined);
		assert.strictEqual(cleanModelId(''), undefined);
		assert.strictEqual(cleanModelId(42), undefined);
		assert.strictEqual(cleanModelId(undefined), undefined);
	});

	test('parseSettingsState: reads the model key (preserving a 1M "[1m]" id) + env ids, classifies seed/invalid', () => {
		assert.deepStrictEqual(parseSettingsState(undefined), { kind: 'ok', settings: { envModelIds: [] }, needsSeed: true });
		assert.deepStrictEqual(parseSettingsState('   '), { kind: 'ok', settings: { envModelIds: [] }, needsSeed: true });

		const ok = parseSettingsState('{ "model": "opus[1m]", "env": { "ANTHROPIC_MODEL": "claude-opus-4.7" } }');
		assert.strictEqual(ok.kind, 'ok');
		if (ok.kind === 'ok') {
			assert.strictEqual(ok.settings.model, 'opus[1m]', 'the real 1M id is preserved, not stripped');
			assert.deepStrictEqual(ok.settings.envModelIds, ['claude-opus-4.7']);
			assert.strictEqual(ok.needsSeed, false);
		}

		const blank = parseSettingsState('{ "model": "   " }');
		assert.strictEqual(blank.kind === 'ok' && blank.settings.model, undefined);
		assert.strictEqual(parseSettingsState('{ not json ').kind, 'invalid');
	});

	test('envModelIdsFrom extracts ANTHROPIC_MODEL + small-fast, ignores blanks and non-strings', () => {
		assert.deepStrictEqual(envModelIdsFrom({ ANTHROPIC_MODEL: 'claude-opus-4.7', ANTHROPIC_SMALL_FAST_MODEL: 'haiku' }), ['claude-opus-4.7', 'haiku']);
		assert.deepStrictEqual(envModelIdsFrom({ ANTHROPIC_MODEL: '   ' }), []);
		assert.deepStrictEqual(envModelIdsFrom({ ANTHROPIC_MODEL: 42 }), []);
		assert.deepStrictEqual(envModelIdsFrom(undefined), []);
	});

	test('modelWrites: a concrete model sets the key; the synthetic Default sentinel DELETES it', () => {
		const base = { model: 'opus[1m]', effortLevel: 'high' };
		assert.deepStrictEqual(applyWrites(base, modelWrites('sonnet')), { model: 'sonnet', effortLevel: 'high' });
		assert.deepStrictEqual(applyWrites(base, modelWrites('default')), { model: 'default', effortLevel: 'high' });
		assert.deepStrictEqual(applyWrites(base, modelWrites(DEFAULT_MODEL)), { effortLevel: 'high' });
	});

	test('planModelEdit mirrors the effort action branch order', () => {
		const ok = parseSettingsState('{ "model": "opus[1m]" }');
		const invalid = parseSettingsState('{ bad');

		assert.strictEqual(planModelEdit(invalid, { id: 'sonnet' }, 'opus[1m]', ok).action, 'invalid');
		assert.strictEqual(planModelEdit(ok, undefined, 'opus[1m]', undefined).action, 'noop');
		assert.strictEqual(planModelEdit(ok, { id: 'opus[1m]' }, 'opus[1m]', ok).action, 'noop');
		assert.strictEqual(planModelEdit(ok, { id: 'sonnet' }, 'opus[1m]', invalid).action, 'invalid');
		const plan = planModelEdit(ok, { id: 'sonnet' }, 'opus[1m]', ok);
		assert.strictEqual(plan.action, 'write');
		assert.deepStrictEqual(plan.writes, [{ path: [MODEL_KEY], value: 'sonnet' }]);
	});

	test('shortModelLabel: strips "Claude ", keeps a short display name, truncates long proxied ids', () => {
		assert.strictEqual(shortModelLabel({ id: 'opus', label: 'Claude Opus', detail: undefined, maxContextWindow: undefined }), 'Opus');
		assert.strictEqual(shortModelLabel({ id: 'opus[1m]', label: 'Opus (1M context)', detail: undefined, maxContextWindow: undefined }), 'Opus (1M context)');
		assert.strictEqual(shortModelLabel({ id: DEFAULT_MODEL, label: 'Default', detail: undefined, maxContextWindow: undefined, isDefault: true }), 'Default');
		const arn = 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0';
		assert.ok(shortModelLabel({ id: arn, label: arn, detail: undefined, maxContextWindow: undefined }).length <= 22);
	});

	test('modelPicks: current row marked (incl. unset -> Default), non-current rows carry the id', () => {
		const list = buildModelList(CATALOG, 'opus[1m]', []);
		const picks = modelPicks(list, 'opus[1m]');
		assert.ok(picks.find(p => p.id === 'opus[1m]')!.description!.includes('Current'), 'selected row marked Current');
		assert.strictEqual(picks.find(p => p.id === 'sonnet')!.description, 'sonnet', 'non-current row shows its id');
		// Unset key marks the catalog "default" row as Current.
		const unsetPicks = modelPicks(list, DEFAULT_MODEL);
		assert.ok(unsetPicks.find(p => p.id === 'default')!.description!.includes('Current'));
	});

	test('modelDisplay: shows the live display name; provider note only for non-Anthropic presets', () => {
		const list = buildModelList(CATALOG, 'opus[1m]', []);
		const anthropic = modelDisplay('opus[1m]', list, 'oauth');
		assert.ok(anthropic.text.includes('Opus (1M context)'), 'status text uses the live display name');
		assert.ok(!/Provider:/.test(anthropic.tooltip), 'oauth preset adds no provider note');
		assert.ok(/Bedrock/.test(modelDisplay('opus[1m]', list, 'bedrock').tooltip), 'bedrock preset annotates the tooltip');
		// Unset key resolves to the Default row without throwing.
		assert.ok(modelDisplay(DEFAULT_MODEL, list, 'oauth').text.includes('Default'));
	});

	test('live refresh: a catalog change RE-READS settings.json (regression: pill stuck on "Default" after a pick)', async () => {
		// Repro of the model-pill-stuck-on-Default bug. Setting a model writes ~/.claude/settings.json and restarts
		// the ext host, which re-fires onDidChangeLanguageModels - but the single-file home-dir settings.json watch
		// can miss the write. The catalog/config handlers must RE-READ settings on that reliable event (refresh),
		// not reuse the stale in-memory cache. Before the fix they called update() (stale) and the pill never moved.
		const store = new DisposableStore();
		try {
			const lmChange = store.add(new Emitter<void>());
			let fileContent = '{ "model": "" }';
			let lastText: string | undefined;

			const pathService = { userHome: async () => URI.file('/home/test') };
			const fileService = {
				readFile: async () => ({ value: VSBuffer.fromString(fileContent) }),
				watch: () => Disposable.None,
				onDidFilesChange: Event.None,
			};
			const languageModelsService = {
				getLanguageModelIds: () => [],
				lookupLanguageModel: () => undefined,
				onDidChangeLanguageModels: lmChange.event,
			};
			const configurationService = { getValue: () => undefined, onDidChangeConfiguration: Event.None };
			const statusbarService = {
				addEntry: (props: { text: string }) => {
					lastText = props.text;
					return { update: (p: { text: string }) => { lastText = p.text; }, dispose: () => { } };
				},
			};

			store.add(new ClawdiusModelStatusEntry(
				statusbarService as unknown as IStatusbarService,
				fileService as unknown as IFileService,
				pathService as unknown as IPathService,
				languageModelsService as unknown as ILanguageModelsService,
				configurationService as unknown as IConfigurationService,
			));

			// Async init (userHome -> read settings -> render). Wait for the first paint.
			for (let i = 0; i < 50 && lastText === undefined; i++) { await timeout(0); }
			assert.ok(lastText !== undefined, 'pill initialized');
			assert.ok(lastText.includes('Default'), `unset model shows Default (got: ${lastText})`);

			// The pick landed on disk but the file-watch missed it; the ext-host restart re-fires the catalog event.
			fileContent = '{ "model": "opus[1m]" }';
			lmChange.fire();
			for (let i = 0; i < 50 && !(lastText && lastText.includes('opus[1m]')); i++) { await timeout(0); }
			assert.ok(lastText.includes('opus[1m]'), `catalog event re-reads settings and reflects the pick (got: ${lastText})`);
		} finally {
			store.dispose();
		}
	});
});
// CLAWDIUS-END
