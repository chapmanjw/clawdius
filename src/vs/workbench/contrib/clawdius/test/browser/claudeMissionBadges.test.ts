/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet - live badge feed tests
// The POSITIVE-path proof the sanitized Playwright harness cannot provide (its null agent host's onDidAction is
// Event.None): an injected onDidAction event drives the SAME production path the ViewPane wires - the badge feed
// correlates the event to a run, gates on ownership, and the FleetRunsList row is decorated. Proves honesty
// from both directions: an OWNED run's ChatInputRequested/ChatTurnComplete raises a `live` badge that renders on
// the row; the same event on a FOREIGN run (or with no ownership) raises NO badge and the row keeps its honest
// polled labels. Also covers the pure `badgeFreshnessFor` floor and a source-scan that the module does not import
// `vs/sessions` `SessionStatus` (valid-layers-check is the real enforcer; this is the belt-and-suspenders check).

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { ActionType, type ActionEnvelope, type StateAction } from '../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import { buildDefaultChatUri, buildSubagentChatUri } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { BadgeSignal, ClaudeMissionBadgeFeed, badgeFreshnessFor } from '../../browser/missions/claudeMissionBadges.js';
import { FleetRunsList, renderRunBadge } from '../../browser/missions/claudeMissionsView.js';
import { MissionRun } from '../../common/claudeFleetModel.js';
import { CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';

/** A minimally-labeled FleetRun carrying the given ids - enumeration always emits `foreign`. */
function run(runId: string, sessionId: string): MissionRun {
	return {
		runId, sessionId, name: runId, status: 'completed', agentCount: 0, phases: [], progress: [], ownership: 'foreign',
		coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete,
		adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
	};
}

/** The bare session URI string for a raw session id (`<provider>:/<rawId>`). */
function sessionUri(rawSessionId: string): string {
	return AgentSession.uri('claude', rawSessionId).toString();
}

/** The DEFAULT chat channel a session's ChatInputRequested/ChatTurnComplete actions actually ride, exactly as the
 *  agent host builds it (`ahp-chat://default/<base64(sessionUri)>`) - the REAL production `envelope.channel`. */
function chatChannel(rawSessionId: string): string {
	return buildDefaultChatUri(sessionUri(rawSessionId));
}

/** The SUBAGENT chat channel a subagent's ChatTurnComplete rides (`ahp-chat://subagent/<base64(sessionUri)>/<tc>`),
 *  which decodes back to its OWNING session - so a subagent completion badges the parent run. */
function subagentChatChannel(rawSessionId: string, toolCallId: string): string {
	return buildSubagentChatUri(sessionUri(rawSessionId), toolCallId);
}

/** Wrap a state action as an ActionEnvelope on the given channel (the URI string the agent host stamps onto
 *  `envelope.channel` via `resource.toString()`). */
function envelope(channel: string, action: StateAction): ActionEnvelope {
	return { channel, action, serverSeq: 1, origin: undefined };
}

/** A needs-input trigger (the run is blocked on the user). */
function inputRequested(): StateAction {
	return { type: ActionType.ChatInputRequested, request: { id: 'req-1' } };
}

/** A completion trigger, optionally carrying `_meta` subagent attribution (how a subagent completion reaches us). */
function turnComplete(meta?: Record<string, unknown>): StateAction {
	return { type: ActionType.ChatTurnComplete, turnId: 'turn-1', _meta: meta };
}

/** The live-badge state a row carries (the `data-live-badge` hook on its badge host + the badge's `data-*`) -
 *  the badge-less shape when no live badge is present. */
function badgeOf(row: HTMLElement | null): unknown {
	const host = row?.querySelector<HTMLElement>('[data-live-badge]') ?? null;
	const badge = row?.querySelector<HTMLElement>('.clawdius-missions-badge') ?? null;
	if (!badge) {
		return { liveBadgeAttr: host?.getAttribute('data-live-badge') ?? null, badge: null };
	}
	return {
		liveBadgeAttr: host?.getAttribute('data-live-badge') ?? null,
		badge: { kind: badge.getAttribute('data-badge-kind'), freshness: badge.getAttribute('data-badge-freshness') },
	};
}

suite('Clawdius missions fleet - live badges', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const OWNED = run('owned-0001', 'sess-owned');
	const FOREIGN = run('foreign-0001', 'sess-foreign');

	/** Build the full production path: a rendered FleetRunsList + a badge feed over an injected onDidAction, wired
	 *  exactly as the ViewPane wires them (feed.onDidChangeBadge -> list.decorateRun). Returns the pieces to drive. */
	function harness(runs: readonly MissionRun[], ownedSessionIds: ReadonlySet<string>) {
		const container = $('div');
		const list = store.add(new FleetRunsList(container));
		list.render(runs);
		const onDidAction = store.add(new Emitter<ActionEnvelope>());
		const feed = store.add(new ClaudeMissionBadgeFeed({
			onDidAction: onDidAction.event,
			getRuns: () => runs,
			getOwnedSessionIds: () => ownedSessionIds,
		}));
		store.add(feed.onDidChangeBadge(signal => list.decorateRun(signal)));
		const rowFor = (r: MissionRun) => container.querySelector<HTMLElement>(`.clawdius-missions-row[data-run-id="${r.runId}"]`);
		return { feed, fire: (e: ActionEnvelope) => onDidAction.fire(e), rowFor };
	}

	test('ChatInputRequested on an OWNED run raises a live needs-input badge that renders on the row', () => {
		const { feed, fire, rowFor } = harness([OWNED, FOREIGN], new Set(['sess-owned']));
		// The event rides the session's REAL default chat channel (ahp-chat://default/<base64(sessionUri)>), so this
		// proves the production correlation (recover session URI -> AgentSession.id), not a fabricated session channel.
		fire(envelope(chatChannel('sess-owned'), inputRequested()));
		assert.deepStrictEqual(
			{
				signal: feed.getBadge('owned-0001'),
				ownedRow: badgeOf(rowFor(OWNED)),
			},
			{
				signal: { runId: 'owned-0001', kind: 'needs-input', freshness: FreshnessLabel.Live, source: 'live-event' } satisfies BadgeSignal,
				ownedRow: { liveBadgeAttr: 'needs-input', badge: { kind: 'needs-input', freshness: 'live' } },
			},
		);
	});

	test('the same event on a FOREIGN run raises NO live badge - the row keeps its honest polled labels', () => {
		const { feed, fire, rowFor } = harness([OWNED, FOREIGN], new Set(['sess-owned']));
		fire(envelope(chatChannel('sess-foreign'), inputRequested()));
		assert.deepStrictEqual(
			{
				signal: feed.getBadge('foreign-0001'),
				foreignRow: badgeOf(rowFor(FOREIGN)),
				stillPolled: rowFor(FOREIGN)?.getAttribute('data-freshness'),
			},
			{ signal: undefined, foreignRow: { liveBadgeAttr: null, badge: null }, stillPolled: 'polled' },
		);
	});

	test('a subagent ChatTurnComplete (on the subagent chat channel, carrying _meta) badges the owning run', () => {
		const { feed, fire, rowFor } = harness([OWNED], new Set(['sess-owned']));
		// A subagent completion rides the SUBAGENT chat channel, which decodes back to the owning session - so it
		// badges the parent run. The _meta carries the subagent attribution the browser sees (not a node-side signal).
		fire(envelope(subagentChatChannel('sess-owned', 'tool-7'), turnComplete({ subagentId: 'sub-7' })));
		assert.deepStrictEqual(
			{ signal: feed.getBadge('owned-0001'), row: badgeOf(rowFor(OWNED)) },
			{
				signal: { runId: 'owned-0001', kind: 'completion', freshness: FreshnessLabel.Live, source: 'live-event' } satisfies BadgeSignal,
				row: { liveBadgeAttr: 'completion', badge: { kind: 'completion', freshness: 'live' } },
			},
		);
	});

	test('badgeFreshnessFor is live only for an owned run with a live event, else polled (the honesty floor)', () => {
		assert.deepStrictEqual(
			[
				badgeFreshnessFor('owned', true),
				badgeFreshnessFor('owned', false),
				badgeFreshnessFor('foreign', true),
				badgeFreshnessFor('foreign', false),
			],
			[FreshnessLabel.Live, FreshnessLabel.Polled, FreshnessLabel.Polled, FreshnessLabel.Polled],
		);
	});

	test('renderRunBadge clears a prior badge when handed no signal (no fabricated live state persists)', () => {
		const host = $('.clawdius-missions-badgehost');
		renderRunBadge(host, { runId: 'x', kind: 'completion', freshness: FreshnessLabel.Live, source: 'live-event' });
		renderRunBadge(host, undefined);
		assert.deepStrictEqual(
			{ liveBadgeAttr: host.getAttribute('data-live-badge'), badges: host.querySelectorAll('.clawdius-missions-badge').length },
			{ liveBadgeAttr: null, badges: 0 },
		);
	});

	test('the badge module does not import vs/sessions SessionStatus (layer purity - valid-layers-check enforces)', async () => {
		const source = await (await fetch(new URL('../../browser/missions/claudeMissionBadges.js', import.meta.url))).text();
		// Strip comments (the module's own prose names `vs/sessions`/`SessionStatus` to document the deliberate
		// avoidance); the scan targets real import statements only.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
		assert.deepStrictEqual(
			{ importsSessionStatus: /\bSessionStatus\b/.test(code), importsSessionsLayer: /from\s+['"][^'"]*\/sessions\//.test(code) },
			{ importsSessionStatus: false, importsSessionsLayer: false },
		);
	});
});
// CLAWDIUS-END
