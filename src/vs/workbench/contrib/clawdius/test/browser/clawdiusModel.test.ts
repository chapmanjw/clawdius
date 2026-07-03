/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN model status pill unit tests
// Covers the egress-free model list build (union of live catalog + configured/proxied ids, de-duped, Default
// first, known families ordered opus/sonnet/haiku, unknown ids name-only with NO fabricated blurb), family
// normalization, the settings.json parse/write logic (Default clears the `model` key), the plan branches, and
// the compact status-bar label for long proxied ids.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
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

const CATALOG: ICatalogModel[] = [
	{ id: 'haiku', name: 'Claude Haiku', maxContextWindow: 200_000 },
	{ id: 'opus', name: 'Claude Opus', maxContextWindow: 1_000_000 },
	{ id: 'sonnet', name: 'Claude Sonnet', maxContextWindow: 1_000_000 },
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
		assert.strictEqual(normalizeFamily('CLAUDE-SONNET-4-5'), 'sonnet');
		assert.strictEqual(normalizeFamily('default'), undefined);
		assert.strictEqual(normalizeFamily('opusplan'), 'opus'); // contains "opus"
		assert.strictEqual(normalizeFamily('my-local-llama'), undefined);
		assert.strictEqual(normalizeFamily(undefined), undefined);
		assert.strictEqual(normalizeFamily(''), undefined);
	});

	test('buildModelList: Default first, families ordered opus/sonnet/haiku, blurbs only for known families', () => {
		const list = buildModelList(CATALOG, DEFAULT_MODEL, []);
		assert.deepStrictEqual(list.map(m => m.id), [DEFAULT_MODEL, 'opus', 'sonnet', 'haiku']);
		assert.strictEqual(list[0].isDefault, true);
		// Known families carry a blurb.
		assert.ok(list[1].detail && list[1].detail.length > 0, 'opus has a blurb');
		assert.ok(list[3].detail && list[3].detail.length > 0, 'haiku has a blurb');
		// Context window carried from the catalog.
		assert.strictEqual(list[1].maxContextWindow, 1_000_000);
	});

	test('buildModelList: a proxied/configured id not in the catalog is appended NAME-ONLY (no invented blurb)', () => {
		const arn = 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.mystery-x';
		const list = buildModelList(CATALOG, arn, []);
		const row = list.find(m => m.id === arn);
		assert.ok(row, 'the configured proxied id is present');
		assert.strictEqual(row!.label, arn, 'label is the raw id');
		assert.strictEqual(row!.detail, undefined, 'no fabricated blurb for an unknown id');
	});

	test('buildModelList: a proxied id that MENTIONS a family still gets that family blurb', () => {
		const id = 'bedrock/anthropic.claude-sonnet-v2';
		const list = buildModelList([], id, []);
		const row = list.find(m => m.id === id);
		assert.ok(row);
		assert.ok(row!.detail && row!.detail.length > 0, 'sonnet-bearing id gets the sonnet blurb');
	});

	test('buildModelList: env-declared proxied ids are unioned and de-duped against the catalog + configured', () => {
		const list = buildModelList(CATALOG, 'opus', ['opus', 'my-proxy-model', 'my-proxy-model']);
		const ids = list.map(m => m.id);
		// opus already in the catalog -> not duplicated; my-proxy-model appears exactly once.
		assert.strictEqual(ids.filter(x => x === 'opus').length, 1);
		assert.strictEqual(ids.filter(x => x === 'my-proxy-model').length, 1);
	});

	test('buildModelList: empty catalog falls back to the authored known families (still dynamic via config union)', () => {
		const list = buildModelList([], DEFAULT_MODEL, ['local-qwen']);
		assert.deepStrictEqual(list.map(m => m.id), [DEFAULT_MODEL, 'opus', 'sonnet', 'haiku', 'local-qwen']);
		assert.strictEqual(list.find(m => m.id === 'local-qwen')!.detail, undefined);
	});

	test('envModelIdsFrom extracts ANTHROPIC_MODEL + small-fast, ignores blanks and non-strings', () => {
		assert.deepStrictEqual(envModelIdsFrom({ ANTHROPIC_MODEL: 'claude-opus-4.7', ANTHROPIC_SMALL_FAST_MODEL: 'haiku' }), ['claude-opus-4.7', 'haiku']);
		assert.deepStrictEqual(envModelIdsFrom({ ANTHROPIC_MODEL: '   ' }), []);
		assert.deepStrictEqual(envModelIdsFrom({ ANTHROPIC_MODEL: 42 }), []);
		assert.deepStrictEqual(envModelIdsFrom(undefined), []);
		assert.deepStrictEqual(envModelIdsFrom('nope'), []);
	});

	test('sanitizeModelId strips ANSI SGR text remnants + control chars, leaves real ids untouched', () => {
		// The real corruption seen in the wild: a terminal /model flow left the literal "[1m]" (an ESC-less
		// bold-code remnant) in the value. It must clean back to the plain alias so it matches the catalog.
		assert.strictEqual(sanitizeModelId('opus[1m]'), 'opus');
		assert.strictEqual(sanitizeModelId('sonnet[22m'), 'sonnet');
		assert.strictEqual(sanitizeModelId('[1mhaiku[22m'), 'haiku');
		// A stray ESC (U+001B) control byte is stripped too.
		assert.strictEqual(sanitizeModelId(String.fromCharCode(27) + '[1mopus'), 'opus');
		// Real ids pass through unchanged - no "[<digits>m]" SGR pattern in any of them.
		assert.strictEqual(sanitizeModelId('opus'), 'opus');
		assert.strictEqual(sanitizeModelId('claude-opus-4.7'), 'claude-opus-4.7');
		assert.strictEqual(sanitizeModelId('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-x'), 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-x');
		assert.strictEqual(sanitizeModelId('projects/p/locations/l/models/claude'), 'projects/p/locations/l/models/claude');
		// A bracketed non-SGR token (no trailing "m") is preserved.
		assert.strictEqual(sanitizeModelId('gpt-4[preview]'), 'gpt-4[preview]');
	});

	test('cleanModelId: junk-only or blank -> undefined; non-string -> undefined', () => {
		assert.strictEqual(cleanModelId('opus[1m]'), 'opus');
		assert.strictEqual(cleanModelId('[1m]'), undefined); // nothing left after cleaning
		assert.strictEqual(cleanModelId('   '), undefined);
		assert.strictEqual(cleanModelId(''), undefined);
		assert.strictEqual(cleanModelId(42), undefined);
		assert.strictEqual(cleanModelId(undefined), undefined);
	});

	test('parseSettingsState sanitizes a polluted model value so it de-dupes against the catalog', () => {
		const st = parseSettingsState('{ "model": "opus[1m]" }');
		assert.strictEqual(st.kind, 'ok');
		if (st.kind === 'ok') {
			assert.strictEqual(st.settings.model, 'opus', 'polluted "opus[1m]" cleaned to "opus"');
		}
		// End-to-end: the cleaned current now matches the catalog "opus" -> ONE row, not a garbled duplicate.
		const list = buildModelList(CATALOG, 'opus', []);
		assert.strictEqual(list.filter(m => m.id === 'opus').length, 1, 'no duplicate opus row');
		assert.ok(!list.some(m => m.id.includes('[1m')), 'no garbled id survives into the list');
	});

	test('parseSettingsState: reads the model key + env-declared ids, classifies seed/invalid', () => {
		assert.deepStrictEqual(parseSettingsState(undefined), { kind: 'ok', settings: { envModelIds: [] }, needsSeed: true });
		assert.deepStrictEqual(parseSettingsState('   '), { kind: 'ok', settings: { envModelIds: [] }, needsSeed: true });

		const ok = parseSettingsState('{ "model": "sonnet", "env": { "ANTHROPIC_MODEL": "claude-opus-4.7" } }');
		assert.strictEqual(ok.kind, 'ok');
		if (ok.kind === 'ok') {
			assert.strictEqual(ok.settings.model, 'sonnet');
			assert.deepStrictEqual(ok.settings.envModelIds, ['claude-opus-4.7']);
			assert.strictEqual(ok.needsSeed, false);
		}

		// A blank/whitespace model string is treated as unset.
		const blank = parseSettingsState('{ "model": "   " }');
		assert.strictEqual(blank.kind === 'ok' && blank.settings.model, undefined);

		assert.strictEqual(parseSettingsState('{ not json ').kind, 'invalid');
	});

	test('modelWrites: a concrete model sets the key; Default DELETES it (preserving other keys)', () => {
		const base = { model: 'opus', effortLevel: 'high' };
		assert.deepStrictEqual(applyWrites(base, modelWrites('sonnet')), { model: 'sonnet', effortLevel: 'high' });
		// Default clears the key entirely (let the CLI decide), leaving unrelated keys intact.
		assert.deepStrictEqual(applyWrites(base, modelWrites(DEFAULT_MODEL)), { effortLevel: 'high' });
	});

	test('planModelEdit mirrors the effort action branch order', () => {
		const ok = parseSettingsState('{ "model": "opus" }');
		const invalid = parseSettingsState('{ bad');

		// initial invalid -> invalid (never write an unparseable file)
		assert.strictEqual(planModelEdit(invalid, { id: 'sonnet' }, 'opus', ok).action, 'invalid');
		// nothing chosen -> noop
		assert.strictEqual(planModelEdit(ok, undefined, 'opus', undefined).action, 'noop');
		// chose the current -> noop
		assert.strictEqual(planModelEdit(ok, { id: 'opus' }, 'opus', ok).action, 'noop');
		// re-read invalid mid-pick -> invalid
		assert.strictEqual(planModelEdit(ok, { id: 'sonnet' }, 'opus', invalid).action, 'invalid');
		// real change -> write
		const plan = planModelEdit(ok, { id: 'sonnet' }, 'opus', ok);
		assert.strictEqual(plan.action, 'write');
		assert.deepStrictEqual(plan.writes, [{ path: [MODEL_KEY], value: 'sonnet' }]);
	});

	test('shortModelLabel: strips "Claude " for families, truncates long proxied ids, Default is "Default"', () => {
		assert.strictEqual(shortModelLabel({ id: 'opus', label: 'Claude Opus', detail: undefined, maxContextWindow: undefined }), 'Opus');
		assert.strictEqual(shortModelLabel({ id: DEFAULT_MODEL, label: 'Default', detail: undefined, maxContextWindow: undefined, isDefault: true }), 'Default');
		// A long ARN gets its last segment, capped with an ellipsis.
		const arn = 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0';
		const short = shortModelLabel({ id: arn, label: arn, detail: undefined, maxContextWindow: undefined });
		assert.ok(short.length <= 22, `short label within budget: "${short}"`);
	});

	test('modelPicks: current row marked, non-default rows carry the raw id in description', () => {
		const list = buildModelList(CATALOG, 'sonnet', []);
		const picks = modelPicks(list, 'sonnet');
		const sonnet = picks.find(p => p.id === 'sonnet')!;
		assert.ok(sonnet.description && sonnet.description.includes('sonnet'), 'id + Current in description');
		const opus = picks.find(p => p.id === 'opus')!;
		assert.strictEqual(opus.description, 'opus', 'non-current, non-default row shows the id');
	});

	test('modelDisplay: shows the selected model name and a provider note for non-Anthropic presets', () => {
		const list = buildModelList(CATALOG, 'opus', []);
		const anthropic = modelDisplay('opus', list, 'oauth');
		assert.ok(anthropic.text.includes('Opus'));
		assert.ok(!/Provider:/.test(anthropic.tooltip), 'oauth preset adds no provider note');

		const bedrock = modelDisplay('opus', list, 'bedrock');
		assert.ok(/Bedrock/.test(bedrock.tooltip), 'bedrock preset annotates the tooltip');

		// Unknown current id (proxied) still resolves to a Default-safe display without throwing.
		const unknown = modelDisplay('mystery', buildModelList(CATALOG, 'mystery', []), 'custom');
		assert.ok(unknown.text.length > 0);
	});
});
// CLAWDIUS-END
