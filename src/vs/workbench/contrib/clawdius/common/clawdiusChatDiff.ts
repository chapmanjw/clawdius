/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native webview Claude chat: pure line-diff for file-edit inline diffs (extracted for testing)
// Renders a file edit's before/after content (resolved from ContentRefs by the ViewPane) as a compact
// unified-style line diff. The LCS line diff lives here so it can be unit-tested without a webview/DOM.

import { ISequence, LcsDiff } from '../../../../base/common/diff/diff.js';

/** One projected diff line: `+` added, `-` removed, ` ` unchanged context, separating gaps marked with `s` = '...'. */
export interface ClawdiusDiffLine {
	readonly t: '+' | '-' | ' ';
	readonly s: string;
}

class LineSequence implements ISequence {
	constructor(private readonly _lines: readonly string[]) { }
	getElements(): string[] {
		return this._lines as string[];
	}
}

function splitLines(text: string): string[] {
	return text.length ? text.split('\n') : [];
}

/**
 * Compute a compact unified-style line diff between `before` and `after`. Each change shows up to `context`
 * unchanged lines on each side; skipped gaps between changes are marked with a `...` line. The output is capped
 * at `maxLines` (a trailing `...` marks truncation) so a huge file edit cannot bloat the webview DOM. A pure
 * creation (`before === ''`) reads as all-added; a pure deletion (`after === ''`) as all-removed.
 */
export function computeLineDiff(before: string, after: string, maxLines: number): ClawdiusDiffLine[] {
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	const changes = new LcsDiff(new LineSequence(beforeLines), new LineSequence(afterLines)).ComputeDiff(true).changes;
	const out: ClawdiusDiffLine[] = [];
	const context = 2;
	let modPos = 0;
	for (const change of changes) {
		const leadStart = Math.max(modPos, change.modifiedStart - context);
		if (leadStart > modPos) {
			out.push({ t: ' ', s: '...' });
		}
		for (let i = leadStart; i < change.modifiedStart; i++) {
			out.push({ t: ' ', s: afterLines[i] });
		}
		for (let i = change.originalStart; i < change.originalStart + change.originalLength; i++) {
			out.push({ t: '-', s: beforeLines[i] });
		}
		for (let i = change.modifiedStart; i < change.modifiedStart + change.modifiedLength; i++) {
			out.push({ t: '+', s: afterLines[i] });
		}
		modPos = change.modifiedStart + change.modifiedLength;
		const trailEnd = Math.min(afterLines.length, modPos + context);
		for (let i = modPos; i < trailEnd; i++) {
			out.push({ t: ' ', s: afterLines[i] });
		}
		modPos = trailEnd;
		if (out.length >= maxLines) {
			out.length = maxLines;
			out.push({ t: ' ', s: '...' });
			break;
		}
	}
	return out;
}
// CLAWDIUS-END
