/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../../../../platform/extensions/common/extensions.js';
import { ActionListItemKind, IActionListItem, IActionListOptions } from '../../../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction } from '../../../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ITelemetryService } from '../../../../../../../../platform/telemetry/common/telemetry.js';
import { ModelPickerConfiguration } from '../../../../../browser/widget/input/modelPicker/modelPickerConfiguration.js';
import { IModelConfigurationAccess } from '../../../../../browser/widget/input/modelPicker/modelPickerActionItem.js';
import { ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier } from '../../../../../common/languageModels.js';

function createModel(): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier: 'copilot/test-model',
		metadata: {
			extension: new ExtensionIdentifier('test.extension'),
			id: 'test-model',
			name: 'Test Model',
			vendor: 'copilot',
			version: '1.0',
			family: 'test',
			maxInputTokens: 128000,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
			configurationSchema: {
				properties: {
					effort: {
						type: 'string',
						group: 'navigation',
						enum: ['low', 'medium'],
						enumItemLabels: ['Low', 'Medium'],
						enumDescriptions: ['Faster', 'Balanced'],
						default: 'low',
					},
					context: {
						type: 'number',
						group: 'tokens',
						enum: [32768, 65536],
						enumItemLabels: ['32K', '64K'],
						default: 32768,
					},
				},
			},
		} as ILanguageModelChatMetadata,
	};
}

suite('ModelPickerConfiguration', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders the combined label and builds accessible option sections', () => {
		const model = createModel();
		const configuration = { effort: 'medium', context: 65536 };
		const access: IModelConfigurationAccess = {
			getModelConfiguration: () => configuration,
			setModelConfiguration: async (_modelId, values) => { Object.assign(configuration, values); },
			getModelConfigurationActions: () => [],
		};
		let shownItems: IActionListItem<IActionWidgetDropdownAction>[] = [];
		let shownOptions: IActionListOptions | undefined;
		const actionWidgetService = {
			show: (
				_id: string,
				_supportsPreview: boolean,
				items: IActionListItem<IActionWidgetDropdownAction>[],
				_delegate: unknown,
				_anchor: unknown,
				_container: unknown,
				_actions: unknown,
				_accessibilityProvider: unknown,
				options: IActionListOptions,
			) => {
				shownItems = items;
				shownOptions = options;
			},
			focusItemById: () => { },
			updateItems: () => { },
		} as unknown as IActionWidgetService;
		const controller = new ModelPickerConfiguration({
			getSelectedModel: () => model,
			getConfigurationAccess: () => access,
			isDisabled: () => false,
			shouldShowCacheBreakHint: () => false,
			getCacheBreakLearnMoreLink: () => undefined,
			dismissCacheBreakHint: () => { },
		}, actionWidgetService, { publicLog2: () => { } } as unknown as ITelemetryService);
		const button = document.createElement('a');

		controller.renderButton(button, false, false);
		controller.show(button);

		assert.deepStrictEqual({
			label: button.textContent,
			ariaLabel: button.ariaLabel,
			listOptions: {
				reserveSubmenuSpace: shownOptions?.reserveSubmenuSpace,
			},
			sections: shownItems.map(item => item.kind === ActionListItemKind.Action ? {
				className: item.className,
				label: item.label,
				checked: item.item!.checked,
				ariaDescription: item.ariaDescription,
			} : { kind: item.kind, label: item.label }),
		}, {
			label: 'Medium 64K',
			ariaLabel: 'Thinking Effort: Medium, Context Size: 64K',
			listOptions: {
				reserveSubmenuSpace: false,
			},
			sections: [
				{ kind: ActionListItemKind.Header, label: 'Thinking Effort' },
				{ className: 'chat-model-picker-config-option', label: 'Low', checked: false, ariaDescription: 'Default, Faster' },
				{ className: 'chat-model-picker-config-option', label: 'Medium', checked: true, ariaDescription: 'Balanced' },
				{ kind: ActionListItemKind.Separator, label: undefined },
				{ kind: ActionListItemKind.Header, label: 'Context Size' },
				{ className: 'chat-model-picker-config-option', label: '32K', checked: false, ariaDescription: 'Default' },
				{ className: 'chat-model-picker-config-option', label: '64K', checked: true, ariaDescription: undefined },
			],
		});
	});

	// CLAWDIUS-BEGIN keep the effort pill on for the agent host
	// Clawdius runs as the agent host with an empty product `entitlementUrl`, and its Claude models
	// advertise a `thinkingLevel` (navigation-group) config but no context-size (tokens) group.
	// Upstream once gated the picker's config pills behind usage-based billing; the fork OR-ed in
	// `!entitlementUrl` to force the effort pill on. Upstream's 1.130 refactor removed that gate, so
	// the pill now renders purely from the model's advertised config. This guard fails if a change to
	// the pill's render/config path (renderButton / _getConfigProperty) re-introduces a gate that
	// hides the effort pill. A gate added at the caller — deciding whether to build the pill at all —
	// is out of this unit's reach; pin that at the widget boundary if it is ever wanted.
	test('CLAWDIUS: effort pill renders for an agent-host model advertising thinking-level config, with no entitlement gate', () => {
		const model: ILanguageModelChatMetadataAndIdentifier = {
			identifier: 'clawdius/claude-test',
			metadata: {
				extension: new ExtensionIdentifier('clawdius.agentHost'),
				id: 'claude-test',
				name: 'Claude Test',
				vendor: 'clawdius',
				version: '1.0',
				family: 'claude',
				maxInputTokens: 200000,
				maxOutputTokens: 8192,
				isDefaultForLocation: {},
				configurationSchema: {
					properties: {
						thinkingLevel: {
							type: 'string',
							group: 'navigation',
							enum: ['low', 'medium', 'high', 'xhigh', 'max'],
							enumItemLabels: ['Low', 'Medium', 'High', 'Extra High', 'Max'],
							default: 'high',
						},
					},
				},
			} as ILanguageModelChatMetadata,
		};
		const access: IModelConfigurationAccess = {
			getModelConfiguration: () => ({}),
			setModelConfiguration: async () => { },
			getModelConfigurationActions: () => [],
		};
		const actionWidgetService = {
			show: () => { },
			focusItemById: () => { },
			updateItems: () => { },
		} as unknown as IActionWidgetService;
		const controller = new ModelPickerConfiguration({
			getSelectedModel: () => model,
			getConfigurationAccess: () => access,
			isDisabled: () => false,
			shouldShowCacheBreakHint: () => false,
			getCacheBreakLearnMoreLink: () => undefined,
			dismissCacheBreakHint: () => { },
		}, actionWidgetService, { publicLog2: () => { } } as unknown as ITelemetryService);
		const button = document.createElement('a');

		controller.renderButton(button, false, false);

		// The pill must be visible (display !== 'none') and show the default thinking level, with no
		// usage-based-billing / entitlement precondition.
		assert.deepStrictEqual(
			{ hidden: button.style.display === 'none', label: button.textContent },
			{ hidden: false, label: 'High' },
		);
	});
	// CLAWDIUS-END
});
