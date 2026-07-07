/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Clawdius Layer-2 e2e smoke suite
// Drives the shipped Clawdius surfaces through the test/automation Electron driver so "run the battery" is one
// command and gates every release. Scoped to native, local, auth-free UI (status bar, Control Center, usage
// dashboard chrome) so it is deterministic in CI without ~/.claude auth, a chat session, or the plugin.

import assert from 'assert';
import { Application, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';

const OPEN_CONTROL_CENTER = 'clawdius.openControlCenter';
const TAB_ORDER = ['Usage', 'Permissions', 'MCP', 'Skills', 'Plugins', 'Hooks', 'Claude Code Settings', 'Sandbox', 'Trust'];

export function setup(logger: Logger) {
	describe('Clawdius', () => {

		installAllHandlers(logger);

		it('renders the always-on Clawdius status-bar entries', async function () {
			const app = this.app as Application;
			// These register on activation and persist for the session, independent of auth or a chat session.
			await app.code.waitForElement('.statusbar-item[id="clawdius.usage"]');
			await app.code.waitForElement('.statusbar-item[id="clawdius.contextBudget"]');
			await app.code.waitForElement('.statusbar-item[id="clawdius.effort"]');
		});

		it('opens the Control Center with the nine tabs in the expected order', async function () {
			const app = this.app as Application;
			await app.workbench.quickaccess.runCommand(OPEN_CONTROL_CENTER);
			await app.code.waitForElement('.clawdius-control');
			const tabs = await app.code.waitForElements('.clawdius-control-tabs .clawdius-control-tab', false, els => els.length === TAB_ORDER.length);
			const labels = tabs.map(t => (t.textContent || '').trim());
			assert.deepStrictEqual(labels, TAB_ORDER, `tab labels/order were ${JSON.stringify(labels)}`);
		});

		it('renders a hero on every tab', async function () {
			const app = this.app as Application;
			await app.workbench.quickaccess.runCommand(OPEN_CONTROL_CENTER);
			await app.code.waitForElement('.clawdius-control');
			// data-tab is a stable hook set on each tab button. Cover a representative spread incl. the renamed
			// "Claude Code Settings" (internal key 'effective'), Sandbox, Trust, and the Usage dashboard.
			for (const tab of ['permissions', 'mcp', 'effective', 'sandbox', 'trust', 'usage']) {
				await app.code.waitAndClick(`.clawdius-control-tab[data-tab="${tab}"]`);
				await app.code.waitForElement('.clawdius-control-hero, .clawdius-usage-hero');
			}
		});

		it('renders the Star on GitHub and Sponsor actions in the tab row', async function () {
			const app = this.app as Application;
			await app.workbench.quickaccess.runCommand(OPEN_CONTROL_CENTER);
			await app.code.waitForElement('.clawdius-control');
			// Both actions are real buttons beside (outside) the tablist. The star button opens the repo so the user
			// stars it themselves; the count pill is fail-silent so it may or may not be present (no assertion on it).
			const star = await app.code.waitForElement('.clawdius-control-star');
			assert.ok((star.textContent || '').includes('Star on GitHub'), `star button text was "${star.textContent}"`);
			await app.code.waitForElement('.clawdius-control-sponsor');
		});

		it('renders the usage dashboard chrome', async function () {
			const app = this.app as Application;
			await app.workbench.quickaccess.runCommand(OPEN_CONTROL_CENTER);
			await app.code.waitAndClick('.clawdius-control-tab[data-tab="usage"]');
			await app.code.waitForElement('.clawdius-usage-dashboard-inner');
			await app.code.waitForElement('.clawdius-usage-hero');
			// The "Subscription limits" section always renders (a non-subscription note when there is no plan).
			await app.code.waitForElements('.clawdius-usage-block-title', false, els => els.length >= 1);
			// The Refresh control is present (its handler drives the on-demand refresh).
			await app.code.waitForElement('.clawdius-usage-refresh');
		});
	});
}
// CLAWDIUS-END
