/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN "Disable animations" toggle
// A single boolean setting (clawdius.disableAnimations) that turns off Clawdius's animated brand art in favor of
// the static Clawd/letterpress stills. It has two surfaces:
//   - The empty-editor letterpress: reacts purely in CSS. This contribution toggles a `clawdius-disable-animations`
//     class on every workbench container (main + auxiliary windows); clawdiusDisableAnimations.css then swaps the
//     animated light/dark letterpress SVGs for the STATIC high-contrast ones already shipped for hc themes.
//   - The Control Center tab-header mark: handled where it renders (claudeControlCenterEditor reads the same
//     setting and adds a `.static` class to swap clawd-dance.svg for the static clawd.svg).
// This contribution owns only the letterpress class-toggle; the Control Center reacts to onDidChangeConfiguration
// on its own. Keeping the swap in CSS means it applies with no reflow the moment the class lands.

import './media/clawdiusDisableAnimations.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/** The boolean setting that turns off Clawdius's brand animations (empty-editor letterpress + Control Center mark). */
export const CLAWDIUS_DISABLE_ANIMATIONS_SETTING = 'clawdius.disableAnimations';

/** The class the letterpress CSS keys off; present on a workbench container exactly when animations are disabled. */
const DISABLE_ANIMATIONS_CLASS = 'clawdius-disable-animations';

/** Toggles the `clawdius-disable-animations` class on every workbench container so the empty-editor letterpress
 *  swaps to the static high-contrast art. Applied to existing containers, to any auxiliary window as it opens, and
 *  re-applied whenever the setting changes. */
export class ClawdiusDisableAnimationsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.clawdiusDisableAnimations';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
		this.apply();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CLAWDIUS_DISABLE_ANIMATIONS_SETTING)) { this.apply(); }
		}));
		// An auxiliary editor window is its own workbench container with its own letterpress, so class it too.
		this._register(this.layoutService.onDidAddContainer(({ container }) => this.applyTo(container)));
	}

	private apply(): void {
		for (const container of this.layoutService.containers) { this.applyTo(container); }
	}

	private applyTo(container: HTMLElement): void {
		const disabled = this.configurationService.getValue<boolean>(CLAWDIUS_DISABLE_ANIMATIONS_SETTING) === true;
		container.classList.toggle(DISABLE_ANIMATIONS_CLASS, disabled);
	}
}
// CLAWDIUS-END
