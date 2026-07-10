/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet owned-run control affordances (Slice 5, US4)
// The minimal, honest control ceiling for a run: whole-run STOP + in-flight STEER for an OWNED run; a FOREIGN run
// is read-only, offering ONLY a terminal handoff (a read-only reveal). The fleet exposes no control it cannot
// actually perform (SC-006) - so the affordance set is keyed off the Slice-4a ownership signal and nothing else.
//
// Both control verbs act through the workbench-facing `IAgentHostService.dispatch(channel, action)` and NEVER
// through a per-provider agent method: the fleet has no `abortSession` (that lives on the per-provider `IAgent`,
// unreachable from `vs/workbench`). Instead -
//   - `stop(run)` dispatches a `ChatTurnCancelled` action. The node side-effect translates that into the
//     provider's whole-run abort plus a cancel of the run's subagent sessions - a genuine whole-run stop. The
//     `turnId` names the run's live turn; the node handler's turn tracker no-ops on an unknown id and the abort
//     is whole-session regardless. When no turn is in flight there is nothing to cancel, so `stop` is a
//     noop-success, exactly mirroring the shipped cancellation handler.
//   - `steerInFlight(run, message)` dispatches a `ChatPendingMessageSet` action with `kind` STEERING - the ONLY
//     kind that routes to the agent's in-flight steering message; a QUEUED kind would type-check but violate
//     FR-006 (it would queue a new turn instead of steering the live one), so the kind is named explicitly.
//
// The dispatch `channel` is the run session's DEFAULT chat channel (`buildDefaultChatUri` over the
// `<provider>:/<rawId>` session URI), the same channel class the badge feed correlates on - grounded in the agent
// host's own URI builders, not a bare session URI.
//
// Control CEILING (SC-006): the fleet's whole surface is {stop, steerInFlight, terminalHandoff}. It never exposes
// the unplumbed low-level interrupt-query or task-stop test stubs - production cancellation runs through the
// agent's abort controller, reached only via the dispatched `ChatTurnCancelled` above. A source-scan test asserts
// those stub names appear nowhere in this module.
//
// This module names ONLY agent-host protocol action types (via the workbench-facing surface); it does NOT import
// `vs/sessions` `SessionStatus`. Ownership is resolved by the shipped Slice-4a `resolveOwnership`, whose
// default-`foreign` floor keeps a run read-only until it is positively proven owned.

import { generateUuid } from '../../../../../base/common/uuid.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import type { ChatPendingMessageSetAction, ChatTurnCancelledAction } from '../../../../../platform/agentHost/common/state/protocol/channels-chat/actions.js';
import { MessageKind, PendingMessageKind } from '../../../../../platform/agentHost/common/state/protocol/channels-chat/state.js';
import { buildDefaultChatUri } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { FleetRun } from '../../common/claudeFleetModel.js';
import { resolveOwnership } from './claudeMissionOwnership.js';

/** The two `@clientDispatchable` `ChatAction`s the fleet dispatches for an owned run's control verbs. */
export type FleetControlAction = ChatTurnCancelledAction | ChatPendingMessageSetAction;

/**
 * The host surface the control affordances act through, injectable so the dispatch + ownership correlation are
 * unit-testable without a live agent host. In production these are backed by the workbench-facing
 * `IAgentHostService` (`dispatch`, `getActiveSubscriptions()` via the Slice-4a adapter) and the fleet's read-only
 * drill-in reveal.
 */
export interface IMissionControlHost {
	/** Dispatch a client-originated control action on a chat channel (`IAgentHostService.dispatch`). */
	dispatch(channel: string, action: FleetControlAction): void;
	/** The owned raw-session-id set (from `getActiveSubscriptions()` via the Slice-4a adapter). */
	getOwnedSessionIds(): ReadonlySet<string>;
	/** The run's live active-turn id, read from agent-host state; `undefined` when no turn is in flight. */
	getActiveTurnId(run: FleetRun): string | undefined;
	/** Reveal a run read-only - the terminal handoff for a foreign run (the shipped transcript drill-in surface). */
	revealReadOnly(run: FleetRun): void;
}

/** The control verbs available for an OWNED run: whole-run stop and in-flight steer. */
export interface OwnedRunAffordances {
	readonly ownership: 'owned';
	/** Stop the whole run (dispatch `ChatTurnCancelled` -> the provider's whole-run abort + subagent cancel). */
	stop(): void;
	/** Inject a steering message into the run's in-flight turn (dispatch `ChatPendingMessageSet`, steering kind). */
	steerInFlight(message: string): void;
}

/** The single affordance available for a FOREIGN run: a read-only terminal handoff, no control verb (FR-007). */
export interface ForeignRunAffordances {
	readonly ownership: 'foreign';
	/** Reveal the run read-only - the only affordance a foreign run gets; it exposes no stop/steer verb. */
	terminalHandoff(): void;
}

/** The affordance set for a run, discriminated by ownership so a foreign run structurally cannot offer control. */
export type RunAffordances = OwnedRunAffordances | ForeignRunAffordances;

/**
 * The DEFAULT chat channel a run's session actions ride (`ahp-chat://default/<base64(sessionUri)>`), built from the
 * run's `<provider>:/<rawId>` session URI exactly as the agent host builds it - the real `dispatch` channel, not a
 * bare session URI.
 */
export function controlChannelForRun(run: FleetRun): string {
	return buildDefaultChatUri(AgentSession.uri('claude', run.sessionId).toString());
}

/**
 * The control affordances for a run, keyed off the Slice-4a ownership signal: an OWNED run gets {stop,
 * steerInFlight}; a FOREIGN run gets ONLY {terminalHandoff}. The fleet exposes no control it cannot perform
 * (SC-006), and the default-`foreign` floor keeps a run read-only until it is positively proven owned.
 */
export function affordancesFor(run: FleetRun, host: IMissionControlHost): RunAffordances {
	if (resolveOwnership(run, host.getOwnedSessionIds()) === 'owned') {
		return {
			ownership: 'owned',
			stop: () => stopOwnedRun(run, host),
			steerInFlight: (message: string) => steerOwnedRun(run, host, message),
		};
	}
	return {
		ownership: 'foreign',
		terminalHandoff: () => host.revealReadOnly(run),
	};
}

/** Whole-run stop: dispatch `ChatTurnCancelled` for the run's live turn. No live turn -> nothing to cancel (a
 *  noop-success mirroring the shipped cancellation handler). */
function stopOwnedRun(run: FleetRun, host: IMissionControlHost): void {
	const turnId = host.getActiveTurnId(run);
	if (!turnId) {
		return;
	}
	const action: ChatTurnCancelledAction = { type: ActionType.ChatTurnCancelled, turnId };
	host.dispatch(controlChannelForRun(run), action);
}

/** In-flight steer: dispatch `ChatPendingMessageSet` with the STEERING kind (the only kind routed to the agent's
 *  live-turn steering message; a queued kind would violate FR-006). */
function steerOwnedRun(run: FleetRun, host: IMissionControlHost, message: string): void {
	const action: ChatPendingMessageSetAction = {
		type: ActionType.ChatPendingMessageSet,
		kind: PendingMessageKind.Steering,
		id: generateUuid(),
		message: { text: message, origin: { kind: MessageKind.User } },
	};
	host.dispatch(controlChannelForRun(run), action);
}
// CLAWDIUS-END
