/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet identity-join (reliability correlation)
// Pure `common/` reliability layer over the enumerated read model: correlate a run's subagents (and, via the
// live registry, its held session) into ONE run grouping so the fleet groups them correctly, and LABEL every
// weak correlation rather than guess. Pure over `FleetRun` / `FleetSubagent`; the only imports are the sibling
// `common/` read-model + label vocabulary (no Node/`process`/renderer import - `valid-layers-check` is the
// enforcer, whose browser tsconfig has no `@types/node`).
//
// NAMESPACE ALIGNMENT (resolved): the two id namespaces this module must join provably COINCIDE BY
// CONSTRUCTION, so the correlation is exact string equality, not a heuristic:
//   • The agent host mints a run's session id once (`generateUuid()`, `claudeAgent.ts` createSession) and stamps
//     it into the session URI via `AgentSession.uri(provider, id)`, so `AgentSession.id(uri)` recovers exactly
//     that string (`agentService.ts`).
//   • That same id is handed to the Claude SDK as `{ sessionId }` for a new session (`{ resume: id }` on
//     resume) at `claudeSdkOptions.ts`, so the SDK writes the transcript as `<id>.jsonl` with that id in each
//     record's `sessionId` field.
//   • The reader seam reads `FleetRun.sessionId = runEntity.sessionId || fileStem(file)` (`claudeReaderSeam
//     Service.ts`) - the transcript's own `sessionId` / filename stem, i.e. that same UUID.
// Therefore the agent-host RAW session id (`AgentSession.id`) and `FleetRun.sessionId` are the SAME string, and
// the ownership probe's string-equality resolver is functionally live: a run held by this workbench
// is joined to its live session by `sessionId` equality. This module carries that liveness join into an honest
// run lifecycle. (An empty `sessionId` never joins - the empty-string false-match guard.)
//
// HONESTY: an AMBIGUOUS correlation is LABELED, never silently merged. A run identity claimed by more than one
// run, and a subagent id reused across runs (a cross-run collision), are surfaced with `confidence: 'ambiguous'`
// and their subagents are held OUT of any single run's grouping (`unjoined`), so the fleet never mixes one run's
// subagents into another. Consent scope is preserved by construction: a subagent only ever joins the
// run it names (`parentRunId`), and that run carries its own coverage label, so a foreign-coverage run's
// subagents are never re-attributed into an in-scope run.

import { CompletenessState } from './claudeReaderSeam.js';
import { FleetRun, FleetSubagent } from './claudeFleetModel.js';

/**
 * How much to trust a run grouping. `high` = a unique run identity with cleanly-attributed subagents; `ambiguous`
 * = the run identity is duplicated or a subagent id is reused across runs (labeled, never merged); `low` = the
 * run is missing a join key (empty `runId` / `sessionId`), so it cannot be correlated reliably.
 */
export type JoinConfidence = 'high' | 'ambiguous' | 'low';

/**
 * The honest run lifecycle derived from the live session registry. `active` = the run's session is held live by
 * this workbench (its `sessionId` is in the owned set - the `AgentSession.id` <-> `FleetRun.sessionId` join);
 * `detached` = the live registry was polled and this run is NOT in it (session-GC'd / finished / held by another
 * process - observed on disk only; the seam carries no terminal status to tell those apart, so a non-live
 * on-disk run is honestly `detached`, never falsely `finished`); `unknown` = no liveness signal was supplied, or
 * the run's read degraded (unknown-shape / absent), so the lifecycle cannot be classified.
 */
export type RunLifecycle = 'active' | 'detached' | 'unknown';

/** Why a subagent could not be attributed to exactly one run. */
export type UnjoinedReason = 'orphan' | 'ambiguous';

/** One run and the subagents confidently correlated to it, with the join confidence and the run lifecycle. */
export interface FleetRunGroup {
	/** The run this grouping is for (carrying its own coverage / freshness / completeness labels). */
	readonly run: FleetRun;
	/** The subagents cleanly attributed to this run (an ambiguous / colliding subagent is held out - see `unjoined`). */
	readonly subagents: readonly FleetSubagent[];
	/** How much to trust this grouping. */
	readonly confidence: JoinConfidence;
	/** The honest run lifecycle from the live-session join. */
	readonly lifecycle: RunLifecycle;
}

/** A subagent that could NOT be attributed to exactly one run - surfaced with its reason, never dropped or guessed. */
export interface UnjoinedSubagent {
	readonly subagent: FleetSubagent;
	readonly reason: UnjoinedReason;
}

/** The correlated fleet: one group per run, plus the subagents that could not be joined to exactly one run. */
export interface FleetIdentityJoin {
	readonly groups: readonly FleetRunGroup[];
	readonly unjoined: readonly UnjoinedSubagent[];
}

/** The pooled enumerated read model to correlate, plus the optional live owned-session-id set (the liveness poll). */
export interface IdentityJoinInput {
	/** The enumerated runs (labeled projections from the seam). */
	readonly runs: readonly FleetRun[];
	/** The enumerated subagents, pooled across runs (each names its parent run via `parentRunId`). */
	readonly subagents: readonly FleetSubagent[];
	/**
	 * The agent-host raw session ids this workbench currently holds live (from the ownership probe's
	 * `getActiveSubscriptions()` adapter). Because `AgentSession.id` and `FleetRun.sessionId` are the same string
	 * (see header), membership is an exact-equality liveness join. Omit when no liveness poll is available - every
	 * run's lifecycle is then `unknown`.
	 */
	readonly ownedSessionIds?: ReadonlySet<string>;
}

/**
 * Whether a run's session is held live by this workbench: its `sessionId` is present in the owned set. The
 * `AgentSession.id` <-> `FleetRun.sessionId` join is exact string equality (see header). An empty `sessionId`
 * never joins (the empty-string false-match guard).
 */
export function isRunLive(run: FleetRun, ownedSessionIds: ReadonlySet<string>): boolean {
	return run.sessionId.length > 0 && ownedSessionIds.has(run.sessionId);
}

/** Derive the honest lifecycle: a degraded read or an absent liveness poll is `unknown`; else `active` when the
 *  run is held live, `detached` when the registry was polled and the run is not in it. */
function lifecycleOf(run: FleetRun, ownedSessionIds: ReadonlySet<string> | undefined): RunLifecycle {
	if (run.completeness === CompletenessState.UnknownShape || run.completeness === CompletenessState.Absent) {
		return 'unknown';
	}
	if (!ownedSessionIds) {
		return 'unknown';
	}
	return isRunLive(run, ownedSessionIds) ? 'active' : 'detached';
}

/**
 * Correlate the pooled read model into one grouping per run, labeling every weak join instead of guessing:
 * subagents are attributed to the run they name (`parentRunId` === `runId`); a run identity claimed by more than
 * one run, and a subagent id reused across runs, are labeled `ambiguous` and their subagents are held out
 * (`unjoined`), never mixed into a single run; a subagent whose parent run is absent is an `orphan`. The
 * run lifecycle comes from the live-session join. Deterministic: groups follow `runs` order, `unjoined` follows
 * `subagents` order.
 */
export function joinFleetIdentity(input: IdentityJoinInput): FleetIdentityJoin {
	const { runs, subagents, ownedSessionIds } = input;

	// A run identity claimed by more than one run is an ambiguous identity (cannot own a subagent uniquely).
	const runCountById = new Map<string, number>();
	for (const run of runs) {
		runCountById.set(run.runId, (runCountById.get(run.runId) ?? 0) + 1);
	}

	// A subagent id whose instances name more than one distinct parent run is a cross-run collision (id reuse).
	const parentsBySubagentId = new Map<string, Set<string>>();
	for (const subagent of subagents) {
		let parents = parentsBySubagentId.get(subagent.subagentId);
		if (!parents) {
			parents = new Set<string>();
			parentsBySubagentId.set(subagent.subagentId, parents);
		}
		parents.add(subagent.parentRunId);
	}
	const isColliding = (subagentId: string): boolean =>
		subagentId.length > 0 && (parentsBySubagentId.get(subagentId)?.size ?? 0) > 1;

	const knownRunIds = new Set<string>(runs.map(r => r.runId));

	const groups: FleetRunGroup[] = [];
	const grouped = new Set<FleetSubagent>();

	for (const run of runs) {
		const identityAmbiguous = run.runId.length > 0 && (runCountById.get(run.runId) ?? 0) > 1;
		const missingKey = run.runId.length === 0 || run.sessionId.length === 0;

		const attributed: FleetSubagent[] = [];
		let sawColliding = false;
		for (const subagent of subagents) {
			if (subagent.parentRunId.length === 0 || subagent.parentRunId !== run.runId) {
				continue;
			}
			// A collided subagent id, or a subagent naming an ambiguous run identity, cannot be attributed to one
			// run - hold it out for `unjoined` rather than guess.
			if (identityAmbiguous || isColliding(subagent.subagentId)) {
				sawColliding = sawColliding || isColliding(subagent.subagentId);
				continue;
			}
			attributed.push(subagent);
			grouped.add(subagent);
		}

		const confidence: JoinConfidence = missingKey
			? 'low'
			: (identityAmbiguous || sawColliding) ? 'ambiguous' : 'high';

		groups.push({ run, subagents: attributed, confidence, lifecycle: lifecycleOf(run, ownedSessionIds) });
	}

	// Every subagent not confidently grouped is surfaced (never dropped): `ambiguous` when its id collides across
	// runs or its parent run identity is duplicated; `orphan` when no run claims its parent.
	const unjoined: UnjoinedSubagent[] = [];
	for (const subagent of subagents) {
		if (grouped.has(subagent)) {
			continue;
		}
		const parentKnown = subagent.parentRunId.length > 0 && knownRunIds.has(subagent.parentRunId);
		const parentAmbiguous = parentKnown && (runCountById.get(subagent.parentRunId) ?? 0) > 1;
		const reason: UnjoinedReason = (isColliding(subagent.subagentId) || parentAmbiguous) ? 'ambiguous' : 'orphan';
		unjoined.push({ subagent, reason });
	}

	return { groups, unjoined };
}
// CLAWDIUS-END
