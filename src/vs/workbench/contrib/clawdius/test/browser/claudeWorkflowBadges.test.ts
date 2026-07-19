/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - live badge feed tests
// The POSITIVE-path proof the sanitized Playwright harness cannot provide (its null agent host's onDidAction is
// Event.None): an injected onDidAction event drives the SAME production path the ViewPane wires - the badge feed
// correlates the event to a run, gates on ownership, and re-renders that run's tree row through
// `WorkflowRunRowRenderer` reading the SAME `IWorkflowRenderContext.badgeOf` the view feeds it (see
// `claudeWorkflowsView.ts`'s badgeFeed.onDidChangeBadge wiring). Proves honesty from both directions: an OWNED
// run's ChatInputRequested/ChatTurnComplete raises a `live` badge that renders on the row; the same event on a
// FOREIGN run (or with no ownership) raises NO badge and the row keeps its honest polled labels. Also covers the
// pure `badgeFreshnessFor` floor and a source-scan that the module does not import `vs/sessions` `SessionStatus`.

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { IHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { ITreeNode } from '../../../../../base/browser/ui/tree/tree.js';
import { Emitter } from '../../../../../base/common/event.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { ActionType, type ActionEnvelope, type StateAction } from '../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import { buildDefaultChatUri, buildSubagentChatUri } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { IWorkflowRenderContext, WorkflowRunRowRenderer, WorkflowTreeElement } from '../../browser/workflows/claudeWorkflowTree.js';
import { BadgeSignal, ClaudeWorkflowBadgeFeed, badgeFreshnessFor } from '../../browser/workflows/claudeWorkflowBadges.js';
import { CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';
import { TerminalWorkflowRun, workflowRunIdentity } from '../../common/claudeWorkflowModel.js';

const fakeHoverDelegate: IHoverDelegate = { showHover: () => undefined, delay: 0 };

function fakeNode(element: WorkflowTreeElement): ITreeNode<WorkflowTreeElement, FuzzyScore> {
	return { element, children: [], depth: 0, visibleChildrenCount: 0, visibleChildIndex: -1, collapsible: false, collapsed: false, visible: true, filterData: undefined };
}

/** A minimally-labeled terminal run carrying the given ids - enumeration always emits `foreign`. */
function run(runId: string, sessionId: string): TerminalWorkflowRun {
	return {
		kind: 'terminal', runId, sessionId, identity: workflowRunIdentity(sessionId, runId),
		workflowName: runId, status: 'completed', phases: [], agents: [], ownership: 'foreign',
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

/** The live-badge state a rendered row carries: its badge chip's kind, or `null` when none is present. */
function badgeOf(container: HTMLElement | undefined): { kind: string | null } | null {
	if (!container) { return null; }
	const badge = container.querySelector<HTMLElement>('.clawdius-workflow-badge');
	return { kind: badge?.getAttribute('data-badge-kind') ?? null };
}

suite('Clawdius Claude Code Ultracode Workflows - live badges', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const OWNED = run('owned-0001', 'sess-owned');
	const FOREIGN = run('foreign-0001', 'sess-foreign');

	/** Build the full production path: a `WorkflowRunRowRenderer` bound to a live `IWorkflowRenderContext.badgeOf`,
	 *  wired to a badge feed over an injected onDidAction - exactly as the ViewPane wires them
	 *  (badgeFeed.onDidChangeBadge -> badges.set + a re-render of that run's row). Mirrors how the real tree treats a
	 *  template: rendered ONCE per row and re-used across re-renders (never a fresh `IconLabel` per event), disposed
	 *  once at teardown. Returns the pieces to drive. */
	function harness(runs: readonly TerminalWorkflowRun[], ownedSessionIds: ReadonlySet<string>) {
		const badges = new Map<string, BadgeSignal>();
		const context: IWorkflowRenderContext = {
			uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: runId => badges.get(runId),
			runOf: () => undefined, justGraduated: () => false,
		};
		const renderer = store.add(new WorkflowRunRowRenderer(context, fakeHoverDelegate));
		const rows = new Map<string, { container: HTMLElement; template: ReturnType<WorkflowRunRowRenderer['renderTemplate']> }>();
		for (const r of runs) {
			const container = $('div');
			const template = renderer.renderTemplate(container);
			renderer.renderElement(fakeNode({ kind: 'run', run: r }), 0, template);
			rows.set(r.runId, { container, template });
		}
		store.add(toDisposable(() => { for (const { template } of rows.values()) { renderer.disposeTemplate(template); } }));

		const onDidAction = store.add(new Emitter<ActionEnvelope>());
		const feed = store.add(new ClaudeWorkflowBadgeFeed({
			onDidAction: onDidAction.event,
			getRuns: () => runs,
			getOwnedSessionIds: () => ownedSessionIds,
		}));
		store.add(feed.onDidChangeBadge(signal => {
			badges.set(signal.runId, signal);
			const owning = runs.find(r => r.runId === signal.runId);
			const row = rows.get(signal.runId);
			if (owning && row) { renderer.renderElement(fakeNode({ kind: 'run', run: owning }), 0, row.template); }
		}));
		return { feed, fire: (e: ActionEnvelope) => onDidAction.fire(e), rowFor: (r: TerminalWorkflowRun) => rows.get(r.runId)?.container };
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
				ownedRow: { kind: 'needs-input' },
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
			{ signal: undefined, foreignRow: { kind: null }, stillPolled: 'polled' },
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
				row: { kind: 'completion' },
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

	test('a row with no badge signal renders no badge chip (no fabricated live state)', () => {
		const context: IWorkflowRenderContext = {
			uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined,
			runOf: () => undefined, justGraduated: () => false,
		};
		const renderer = store.add(new WorkflowRunRowRenderer(context, fakeHoverDelegate));
		const container = $('div');
		const template = renderer.renderTemplate(container);
		renderer.renderElement(fakeNode({ kind: 'run', run: OWNED }), 0, template);
		assert.deepStrictEqual(badgeOf(container), { kind: null });
		renderer.disposeTemplate(template);
	});

	test('the badge module does not import vs/sessions SessionStatus (layer purity - valid-layers-check enforces)', async () => {
		const source = await (await fetch(new URL('../../browser/workflows/claudeWorkflowBadges.js', import.meta.url))).text();
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
