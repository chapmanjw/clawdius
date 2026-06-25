/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../dom.js';
import { ThemeIcon } from '../../../common/themables.js';

const labelWithIconsRegex = new RegExp(`(\\\\)?\\$\\((${ThemeIcon.iconNameExpression}(?:${ThemeIcon.iconModifierExpression})?)\\)`, 'g');

// CLAWDIUS-BEGIN per-cell animated meter cells
// A status-bar meter can embed an animated run as <NUL><className><NUL><chars><NUL> (NUL = U+0000, which never
// appears in a real label) so each glyph becomes its own span and CSS can colour/animate cells individually.
// No-op for any label without a NUL. Used by the Clawdius effort status-bar meter.
const CLAWDIUS_NUL = String.fromCharCode(0);
const CLAWDIUS_FULL_BLOCK = String.fromCharCode(0x2588);
function clawdiusPushText(elements: Array<HTMLSpanElement | string>, text: string): void {
	let rest = text;
	let start = rest.indexOf(CLAWDIUS_NUL);
	while (start !== -1) {
		const mid = rest.indexOf(CLAWDIUS_NUL, start + 1);
		const end = mid === -1 ? -1 : rest.indexOf(CLAWDIUS_NUL, mid + 1);
		if (mid === -1 || end === -1) {
			break; // malformed - fall through and push the remainder verbatim
		}
		if (start > 0) {
			elements.push(rest.substring(0, start));
		}
		const className = rest.substring(start + 1, mid);
		const chars = rest.substring(mid + 1, end);
		for (let i = 0; i < chars.length; i++) {
			const cell = dom.$('span');
			cell.className = `clawdius-meter-cell ${className} ${chars[i] === CLAWDIUS_FULL_BLOCK ? 'fill' : 'empty'}`;
			cell.textContent = chars[i];
			cell.style.setProperty('--clawdius-i', String(i));
			elements.push(cell);
		}
		rest = rest.substring(end + 1);
		start = rest.indexOf(CLAWDIUS_NUL);
	}
	if (rest.length > 0) {
		elements.push(rest);
	}
}
// CLAWDIUS-END

export function renderLabelWithIcons(text: string, renderIconsInDefaultColor?: boolean): Array<HTMLSpanElement | string> {
	const elements = new Array<HTMLSpanElement | string>();
	let match: RegExpExecArray | null;

	// CLAWDIUS: only the effort/usage status meters embed the NUL sentinel. Scan once up front: when the label
	// has no sentinel (every ordinary label across the IDE) take the exact original fast path - push the
	// substring verbatim - so this global hot path pays only a single indexOf and no per-segment helper call.
	const hasMeterCells = text.indexOf(CLAWDIUS_NUL) !== -1;

	let textStart = 0, textStop = 0;
	while ((match = labelWithIconsRegex.exec(text)) !== null) {
		textStop = match.index || 0;
		if (textStart < textStop) {
			const segment = text.substring(textStart, textStop);
			if (hasMeterCells) {
				clawdiusPushText(elements, segment); // CLAWDIUS: split out animated meter cells
			} else {
				elements.push(segment);
			}
		}
		textStart = (match.index || 0) + match[0].length;

		const [, escaped, codicon] = match;
		elements.push(escaped ? `$(${codicon})` : renderIcon({ id: codicon }, renderIconsInDefaultColor));
	}

	if (textStart < text.length) {
		const segment = text.substring(textStart);
		if (hasMeterCells) {
			clawdiusPushText(elements, segment); // CLAWDIUS: split out animated meter cells
		} else {
			elements.push(segment);
		}
	}
	return elements;
}

export function renderIcon(icon: ThemeIcon, renderDefaultColor?: boolean): HTMLSpanElement {
	const node = dom.$(`span`);
	const classes = ThemeIcon.asClassNameArray(icon);
	if (renderDefaultColor) {
		classes.push('codicon-colored');
	}
	node.classList.add(...classes);
	return node;
}
