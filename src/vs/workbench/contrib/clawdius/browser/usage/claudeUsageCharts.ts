/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN terminal/ASCII chart primitive for the usage status bar
// The status-bar usage indicator keeps the CLI-style block-shade bar (the dashboard + popup reverted to
// CSS/SVG bars). Each glyph is produced via String.fromCharCode so the SOURCE stays ASCII-only (the repo's
// precommit hygiene forbids non-ASCII source).

const FULL_BLOCK = String.fromCharCode(0x2588);   // full block, the filled portion of a bar
const LIGHT_SHADE = String.fromCharCode(0x2591);  // light shade, the empty track of a bar

/** A horizontal block-shade bar (full-block fill + light-shade track) for `fraction` (0..1) over `width` cells. */
export function blockBar(fraction: number, width: number): string {
	const filled = Math.max(0, Math.min(width, Math.round((isFinite(fraction) ? fraction : 0) * width)));
	return FULL_BLOCK.repeat(filled) + LIGHT_SHADE.repeat(width - filled);
}
// CLAWDIUS-END
