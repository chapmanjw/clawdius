/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows needs-input/completion badge feed
// A LIVE-ONLY badge feed. It subscribes to the workbench-facing `IAgentHostService.onDidAction` action stream and
// raises an honest needs-input / completion badge for an OWNED run when a live event actually fires:
//   - `ActionType.ChatInputRequested` -> a `needs-input` badge (the run is blocked on the user).
//   - `ActionType.ChatTurnComplete`   -> a `completion` badge (the assistant went idle). A SUBAGENT completion
//     also arrives as this same `ChatTurnComplete`, dispatched on the subagent's chat channel and correlated to
//     its owning run via that channel (below) - NOT a node-side `onDidSessionProgress` signal (that lives on the
//     per-provider `IAgent`, unreachable from `vs/workbench`).
//
// `freshness` is `live` ONLY for an OWNED run (resolved via the shipped `resolveOwnership`) when an event
// fired. A foreign / non-live run gets NO live badge - its row shows the seam's honest polled status instead. The
// feed NEVER fabricates a needs-input / completion badge from disk: the indexed transcript record carries no such
// field, so there is no honest disk-derived signal (the seam only ever reports `status:'unknown'` / `polled`).
//
// The event's originating run is correlated from the envelope's `channel`. These two chat actions are emitted on
// the session's CHAT channel, not a bare session URI: their `resource` is `buildDefaultChatUri(sessionUri)` =
// `ahp-chat://<chatId>/<base64(sessionUri)>` (a subagent completion arrives on the subagent chat channel,
// `ahp-chat://subagent/<base64(sessionUri)>/<toolCallId>`), which the agent host stamps onto `envelope.channel`.
// So the run's session id is recovered by `parseDefaultChatUri` (the inverse of `buildDefaultChatUri`, which also
// decodes a subagent chat URI back to its OWNING session) and then `AgentSession.id` on the recovered session URI
// - yielding the agent-host raw session id matched against `FleetRun.sessionId`. A non-chat channel falls back to
// being read as a bare session URI. Whether the agent-host raw id and the seam's `sessionId` share a namespace is
// an identity-join question left for later; where they do not, no run matches and no badge is
// raised - the safe, never-falsely-live outcome. This module names ONLY `ActionType`-discriminated action types
// from the agent-host protocol layer; it deliberately does NOT import `vs/sessions` `SessionStatus`.

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { ActionType, type ActionEnvelope, type StateAction } from '../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import { parseDefaultChatUri } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { FleetOwnership } from '../../common/claudeFleetModel.js';
import { FreshnessLabel } from '../../common/claudeReaderSeam.js';
import { resolveOwnership } from './claudeWorkflowOwnership.js';

/** The two honest live badges the fleet raises: the run is blocked on the user, or its turn finished. */
export type BadgeKind = 'needs-input' | 'completion';

/**
 * Recover the run's agent-host raw session id from an action envelope's `channel`. The badge-trigger chat actions
 * ride the session's CHAT channel (`ahp-chat://<chatId>/<base64(sessionUri)>`, or a subagent chat URI that decodes
 * to its OWNING session), so `parseDefaultChatUri` recovers the session URI first; a non-chat channel is read as a
 * bare session URI. Then `AgentSession.id` extracts the raw id matched against `FleetRun.sessionId`.
 */
export function runSessionIdFromChannel(channel: string): string {
	return AgentSession.id(parseDefaultChatUri(channel) ?? channel);
}

/**
 * One live badge for a run. Emitted ONLY for an OWNED run when an `onDidAction` event actually fired, so its
 * `freshness` is always `live` (a foreign / non-live run never produces a `BadgeSignal` - the row falls back to
 * the seam's honest polled status). `source` records where the signal came from for the honesty audit.
 */
export interface BadgeSignal {
	/** The run this badge belongs to (correlated from the event's session channel). */
	readonly runId: string;
	/** Whether the run is blocked on the user (`needs-input`) or its turn finished (`completion`). */
	readonly kind: BadgeKind;
	/** Always `live` for an emitted signal - a badge is raised only for an OWNED run on a real live event. */
	readonly freshness: FreshnessLabel;
	/** Provenance of the signal (the live agent-host action stream), for the honesty audit. */
	readonly source: 'live-event';
}

/**
 * The identity a badge correlates against: the minimum a row must expose to receive a live badge. Structural on
 * purpose - the feed matches an event's session id to a row and keys the badge by run id, and needs nothing else -
 * so both a `FleetRun` and a `WorkflowRun` satisfy it without the feed knowing which entity the list paints.
 */
export interface IBadgeCorrelatableRun {
	/** The row's stable identity, which the badge is keyed by. */
	readonly runId: string;
	/** The session the row belongs to, matched against the agent-host event's raw session id. */
	readonly sessionId: string;
}

/**
 * The PURE freshness classifier the honesty of the badge turns on: a badge is `live` iff the run is OWNED AND a
 * live event actually fired; in every other case it is `polled` (the seam's honest fallback). This is the
 * never-falsely-live floor - a foreign run, or an owned run with no event, is `polled`, never `live`.
 */
export function badgeFreshnessFor(ownership: FleetOwnership, hadLiveEvent: boolean): FreshnessLabel {
	return ownership === 'owned' && hadLiveEvent ? FreshnessLabel.Live : FreshnessLabel.Polled;
}

/**
 * The PURE action discriminator: maps a state action to the badge it raises, or `undefined` for any action that
 * is not a badge trigger. Discriminates on `ActionType` only - `ChatInputRequested` -> `needs-input`,
 * `ChatTurnComplete` -> `completion` (including a subagent completion, which arrives as a `ChatTurnComplete` on
 * the subagent's chat channel and is correlated to its owning run via that channel).
 */
export function badgeKindForAction(action: StateAction): BadgeKind | undefined {
	switch (action.type) {
		case ActionType.ChatInputRequested:
			return 'needs-input';
		case ActionType.ChatTurnComplete:
			return 'completion';
		default:
			return undefined;
	}
}

/** The inputs the feed needs, injectable so the correlation is unit-testable without a live agent host. */
export interface IBadgeFeedSource {
	/** The workbench-facing live action stream (`IAgentHostService.onDidAction`). */
	readonly onDidAction: Event<ActionEnvelope>;
	/** The runs currently in view, to correlate an event's session id back to the row that owns it. Structural on
	 *  purpose: the feed correlates on identity alone, so it serves both a `FleetRun` and a `WorkflowRun` row
	 *  without knowing which entity the list is painting. */
	getRuns(): readonly IBadgeCorrelatableRun[];
	/** The owned raw-session-id set (from `getActiveSubscriptions()` via the ownership adapter). */
	getOwnedSessionIds(): ReadonlySet<string>;
}

/**
 * Subscribes to the live agent-host action stream and raises an honest needs-input / completion badge for an
 * OWNED run. Holds the latest badge per run so a re-render can re-apply it, and fires {@link onDidChangeBadge} on
 * every new signal. A foreign / non-live run never produces a badge (never-falsely-live). Dispose to unsubscribe.
 */
export class ClaudeWorkflowBadgeFeed extends Disposable {

	private readonly _onDidChangeBadge = this._register(new Emitter<BadgeSignal>());
	/** Fires when a live badge is raised for an owned run. */
	readonly onDidChangeBadge: Event<BadgeSignal> = this._onDidChangeBadge.event;

	private readonly _badges = new Map<string, BadgeSignal>();

	constructor(private readonly source: IBadgeFeedSource) {
		super();
		this._register(source.onDidAction(envelope => this.handle(envelope)));
	}

	/** The latest live badge per run (empty until a live event fires) - reused by the view on re-render. */
	get badges(): ReadonlyMap<string, BadgeSignal> {
		return this._badges;
	}

	/** The latest live badge for one run, or `undefined` when none has fired. */
	getBadge(runId: string): BadgeSignal | undefined {
		return this._badges.get(runId);
	}

	private handle(envelope: ActionEnvelope): void {
		const kind = badgeKindForAction(envelope.action);
		if (!kind) {
			return;
		}
		// Correlate the event's chat channel back to a run in view. No match -> no badge (the safe outcome when the
		// agent-host id namespace and the seam's `sessionId` do not align - that join is left for later).
		const sessionId = runSessionIdFromChannel(envelope.channel);
		const run = this.source.getRuns().find(candidate => candidate.sessionId === sessionId);
		if (!run) {
			return;
		}
		// A live badge is raised ONLY for an OWNED run. A foreign run gets no live badge - the row keeps
		// the seam's honest polled status.
		const ownership = resolveOwnership(run, this.source.getOwnedSessionIds());
		if (badgeFreshnessFor(ownership, true) !== FreshnessLabel.Live) {
			return;
		}
		const signal: BadgeSignal = { runId: run.runId, kind, freshness: FreshnessLabel.Live, source: 'live-event' };
		this._badges.set(run.runId, signal);
		this._onDidChangeBadge.fire(signal);
	}
}
// CLAWDIUS-END
