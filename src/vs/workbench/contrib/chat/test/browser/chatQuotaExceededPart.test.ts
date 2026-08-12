/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMarkdownRenderer } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IChatResponseErrorDetails } from '../../common/chatService/chatService.js';
import { IChatErrorDetailsPart, IChatResponseViewModel } from '../../common/model/chatViewModel.js';
import { ChatQuotaExceededPart } from '../../browser/widget/chatContentParts/chatQuotaExceededPart.js';


function createMockRenderer(): IMarkdownRenderer {
	return {
		render(markdown: MarkdownString) {
			const el = mainWindow.document.createElement('div');
			el.textContent = markdown.value;
			return { element: el, dispose() { } };
		},
		dispose() { },
	} as unknown as IMarkdownRenderer;
}

function createMockElement(errorDetails: IChatResponseErrorDetails): IChatResponseViewModel {
	return {
		errorDetails,
		sessionResource: URI.parse('test://session'),
	} as unknown as IChatResponseViewModel;
}

function createMockContent(): IChatErrorDetailsPart {
	return {
		kind: 'errorDetails',
		errorDetails: { message: 'test', isQuotaExceeded: true },
		isLast: true,
	};
}

suite('ChatQuotaExceededPart', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createWidget(errorDetails: IChatResponseErrorDetails): ChatQuotaExceededPart {
		const widget = new ChatQuotaExceededPart(
			createMockElement(errorDetails),
			createMockContent(),
			createMockRenderer(),
		);
		store.add(widget);
		mainWindow.document.body.appendChild(widget.domNode);
		return widget;
	}

	teardown(() => {
		for (const el of mainWindow.document.body.querySelectorAll('.chat-quota-error-widget')) {
			el.remove();
		}
	});

	// The upgrade / manage-budget call to action used to live here, but the
	// commands behind it no longer exist in this product, so the part is now
	// informational only.
	test('renders the error message and no call to action', () => {
		const widget = createWidget({
			message: 'Quota exceeded',
			isQuotaExceeded: true,
		});

		assert.deepStrictEqual({
			message: widget.domNode.querySelector('.chat-quota-error-message')?.textContent,
			button: widget.domNode.querySelector('.chat-quota-error-button'),
		}, {
			message: 'Quota exceeded',
			button: null,
		});
	});

	test('renders the error message and no call to action for a spend limit error', () => {
		const widget = createWidget({
			message: 'Spend limit reached',
			isQuotaExceeded: true,
			code: 'additional_spend_limit_reached',
		});

		assert.deepStrictEqual({
			message: widget.domNode.querySelector('.chat-quota-error-message')?.textContent,
			button: widget.domNode.querySelector('.chat-quota-error-button'),
		}, {
			message: 'Spend limit reached',
			button: null,
		});
	});
});
