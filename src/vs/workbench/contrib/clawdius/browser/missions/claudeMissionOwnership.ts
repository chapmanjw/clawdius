/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet ownership probe
// Decides, per enumerated `FleetRun`, whether THIS Clawdius workbench holds the run (`owned`) or it is merely
// observed on disk (`foreign`). Split into a PURE resolver + a thin service adapter so the correlation is
// unit-testable without a live agent host.
//
// The owned set is derived from the workbench-facing `IAgentHostService` PUBLIC surface - NOT from any disk
// read. `getActiveSubscriptions()` reports the connection's live resource subscriptions; the `Session`-kind
// entries are the sessions this workbench currently holds. Each subscription `resource` is a `<provider>:/<rawId>`
// session URI, so `AgentSession.id` extracts the agent-host RAW session id. Deliberately NOT used:
// `IAgentService.listSessions()` (the PERSISTED catalog - it includes foreign on-disk runs), and no component's
// private state (e.g. the chat contrib's private `_activeSessions` `ResourceMap`) - only the public accessor.
//
// SAFETY FLOOR: default `foreign`; a run is promoted to `owned` ONLY when its `sessionId` is positively present in
// the owned set. A run merely observed on disk, or one present only in the persisted catalog, stays `foreign`.
//
// NAMESPACE DEPENDENCY (disclosed): `AgentSession.id(resource)` yields the agent-host RAW session id, while
// `FleetRun.sessionId` is `runEntity.sessionId || fileStem(file)` - the transcript's own id / filename stem
// (`claudeReaderSeamService.ts`). Whether those two id namespaces are the SAME string is an identity-join
// question owned by later reliability work; this probe correlates on plain string equality. Where the
// namespaces do not (yet) align, the run resolves `foreign` - the safe, never-falsely-owned outcome - so
// functional owned-detection in the real build may pend that join. The resolver's mechanism is correct today;
// only the guarantee that the two namespaces coincide is deferred.

import { AgentSession, IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IActiveSubscriptionInfo } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import { StateComponents } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { FleetOwnership, FleetRun } from '../../common/claudeFleetModel.js';

/**
 * The PURE ownership decision: a run is `owned` iff its `sessionId` is present in the owned set, else `foreign`.
 * This is the never-falsely-owned safety floor - a run absent from the set (disk-only, or only in the persisted
 * catalog) stays `foreign`. No side effects, no host access; correlates on plain string equality so it can be
 * unit-tested against an injected set.
 */
export function resolveOwnership(run: FleetRun, ownedSessionIds: ReadonlySet<string>): FleetOwnership {
	return ownedSessionIds.has(run.sessionId) ? 'owned' : 'foreign';
}

/**
 * PURE mapping from a connection's active subscriptions to the owned raw-session-id set: keep only the
 * `Session`-kind subscriptions and extract each one's raw id via `AgentSession.id`. Separated from the live host
 * so the mapping is testable against an injected `IActiveSubscriptionInfo[]`.
 */
export function ownedSessionIdsFromSubscriptions(subscriptions: readonly IActiveSubscriptionInfo[]): Set<string> {
	const owned = new Set<string>();
	for (const subscription of subscriptions) {
		if (subscription.kind === StateComponents.Session) {
			owned.add(AgentSession.id(subscription.resource));
		}
	}
	return owned;
}

/**
 * The thin service adapter: read the owned set off the workbench-facing `IAgentHostService` PUBLIC surface
 * (`getActiveSubscriptions()`), with no disk read. A tiny wrapper over the pure mapping so a caller can resolve
 * ownership against the live connection.
 */
export function ownedSessionIdsFromHost(agentHostService: IAgentHostService): Set<string> {
	return ownedSessionIdsFromSubscriptions(agentHostService.getActiveSubscriptions());
}
// CLAWDIUS-END
