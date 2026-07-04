/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN first-run plugin-install overlay
// A NON-BLOCKING, dismissible card shown while Clawdius installs its default plugins on first run (the ~225 MB
// Claude Code engine download is the slow one). It floats centered over the workbench via ILayoutService's
// mainContainer, but the overlay layer is pointer-events:none so ONLY the card takes clicks - the IDE behind
// stays fully interactive, and "Continue in background" dismisses it while the install proceeds (the existing
// notification-location progress keeps reporting). It reuses the Control Center's animated Clawd hero art
// (../control/media/clawd-dance.svg, or clawd-static.svg when "Disable animations" is on). Byte progress is not
// exposed by IExtensionsWorkbenchService.install, so the bar pulses (honestly "working") and the description
// names the current plugin + an "N of M" step counter rather than faking a percentage.

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../nls.js';
import './media/clawdiusStartupModal.css';

export class ClawdiusStartupInstallOverlay extends Disposable {

	private readonly _root: HTMLElement;
	private readonly _desc: HTMLElement;
	private _closed = false;

	/**
	 * @param container the workbench main container (ILayoutService.mainContainer).
	 * @param staticMark true to use the still Clawd art instead of the animated dance (Disable animations).
	 * @param onDismiss invoked when the user clicks "Continue in background".
	 */
	constructor(container: HTMLElement, staticMark: boolean, onDismiss: () => void) {
		super();

		this._root = append(container, $('.clawdius-startup-overlay'));
		const card = append(this._root, $('.clawdius-startup-card'));

		const mark = append(card, $('.clawdius-startup-hero-mark'));
		if (staticMark) {
			mark.classList.add('static');
		}

		const body = append(card, $('.clawdius-startup-body'));
		append(body, $('.clawdius-startup-title')).textContent = localize('clawdius.startup.title', "Setting up Clawdius");
		this._desc = append(body, $('.clawdius-startup-desc'));
		this._desc.textContent = localize('clawdius.startup.preparing', "Preparing your Claude Code workspace…");

		const barHost = append(body, $('.clawdius-startup-progress'));
		// No byte-level progress from install(); a pulse honestly says "working" without a fake percentage.
		this._register(new ProgressBar(barHost, defaultProgressBarStyles)).infinite();

		const actions = append(card, $('.clawdius-startup-actions'));
		const dismiss = append(actions, $<HTMLButtonElement>('button.clawdius-startup-dismiss'));
		dismiss.textContent = localize('clawdius.startup.dismiss', "Continue in background");
		this._register(addDisposableListener(dismiss, 'click', () => onDismiss()));

		this._register(toDisposable(() => { this._closed = true; this._root.remove(); }));
	}

	/** Point the description at the plugin being installed (0-based `index` of `total`). No-op once disposed. */
	setStep(label: string, index: number, total: number): void {
		if (this._closed) {
			return;
		}
		this._desc.textContent = total > 1
			? localize('clawdius.startup.installingN', "Installing {0} ({1} of {2})…", label, index + 1, total)
			: localize('clawdius.startup.installing1', "Installing {0}…", label);
	}
}
// CLAWDIUS-END
