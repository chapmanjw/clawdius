/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS hidden-settings unit tests. Verifies the registry mutation that hides the inert upstream chat
// settings from the Settings editor in Clawdius mode: each still-registered target is DEREGISTERED and then
// re-ADDED with `included: false` (the registry routes that to the excluded set the Settings editor never shows),
// and a target that is not registered is skipped. The registry's own routing of `included: false` is upstream
// VS Code behavior; here we pin the transform this fork performs on top of it.

import assert from 'assert';
import { IStringDictionary } from '../../../../../base/common/collections.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationScope, IConfigurationNode, IConfigurationRegistry, IRegisteredConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS, hideInapplicableClawdiusSettings } from '../../browser/clawdiusHiddenSettings.js';

interface IUpdateCall {
	add: IConfigurationNode[];
	remove: IConfigurationNode[];
}

// Minimal IConfigurationRegistry stub: it exposes a controlled property map and records updateConfigurations
// calls, so the test is deterministic and never touches the global registry singleton.
function stubRegistry(properties: IStringDictionary<IRegisteredConfigurationPropertySchema>): { registry: IConfigurationRegistry; calls: IUpdateCall[] } {
	const calls: IUpdateCall[] = [];
	const registry = {
		getConfigurationProperties: () => properties,
		updateConfigurations: (delta: IUpdateCall) => { calls.push(delta); },
	} as unknown as IConfigurationRegistry;
	return { registry, calls };
}

function sampleProperty(overrides: Partial<IRegisteredConfigurationPropertySchema> = {}): IRegisteredConfigurationPropertySchema {
	return {
		type: 'boolean',
		default: true,
		scope: ConfigurationScope.WINDOW,
		...overrides,
	};
}

suite('Clawdius hidden settings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every listed key is a chat setting (guards against an over-broad list)', () => {
		assert.ok(CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS.length > 0);
		for (const key of CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS) {
			assert.ok(key.startsWith('chat.'), `hidden setting "${key}" is not a chat.* setting`);
		}
	});

	test('deregisters each registered target and re-adds it with included:false', () => {
		const properties: IStringDictionary<IRegisteredConfigurationPropertySchema> = {};
		for (const key of CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS) {
			properties[key] = sampleProperty();
		}
		const { registry, calls } = stubRegistry(properties);

		const hidden = hideInapplicableClawdiusSettings(registry);

		assert.deepStrictEqual([...hidden].sort(), [...CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS].sort());
		assert.strictEqual(calls.length, 1);
		const { add, remove } = calls[0];
		assert.strictEqual(add.length, 1);
		assert.strictEqual(remove.length, 1);

		for (const key of CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS) {
			// remove carries the ORIGINAL schema object (so removeFromSchema targets the right scope bucket).
			assert.strictEqual(remove[0].properties![key], properties[key], `remove should reuse the original schema for ${key}`);
			// add carries a COPY marked included:false, preserving the rest of the schema.
			const added = add[0].properties![key];
			assert.strictEqual(added.included, false, `${key} should be added with included:false`);
			assert.notStrictEqual(added, properties[key], `${key} added copy must not mutate the original`);
			assert.strictEqual(added.type, 'boolean');
			assert.strictEqual(added.scope, ConfigurationScope.WINDOW);
			// The original stays untouched (still visible) until the registry applies the delta.
			assert.notStrictEqual((properties[key] as IRegisteredConfigurationPropertySchema).included, false);
		}
	});

	test('skips a target that is not registered (only hides what is present)', () => {
		const present = CLAWDIUS_HIDDEN_UPSTREAM_SETTINGS[0];
		const { registry, calls } = stubRegistry({ [present]: sampleProperty() });

		const hidden = hideInapplicableClawdiusSettings(registry);

		assert.deepStrictEqual(hidden, [present]);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(Object.keys(calls[0].add[0].properties!), [present]);
		assert.deepStrictEqual(Object.keys(calls[0].remove[0].properties!), [present]);
	});

	test('does nothing (no registry mutation) when no target is registered', () => {
		const { registry, calls } = stubRegistry({});

		const hidden = hideInapplicableClawdiusSettings(registry);

		assert.deepStrictEqual(hidden, []);
		assert.strictEqual(calls.length, 0);
	});
});
