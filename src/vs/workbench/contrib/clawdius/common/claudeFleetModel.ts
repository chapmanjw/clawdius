/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet enumeration read model
// The pure `common/` read-model the Missions fleet binds to: the labeled projection the seam's run-/subagent-
// enumeration produces. A `FleetRun` / `FleetSubagent` holds NO authoritative Claude state - it is a labeled
// index over what the seam enumerated under the resolved config root, carrying the same honesty labels
// (coverage / freshness / completeness + the adapter-version stamp) the shipped reader seam attaches to every
// read. This layer stays pure so it can be unit-tested without a host: the only import is the reader-seam label
// vocabulary from the sibling `common/claudeReaderSeam.ts`; there is NO Node/`process`/renderer import (purity
// is enforced by `valid-layers-check`, whose browser tsconfig has no `@types/node`). The two-value `ownership`
// DEFAULTS to `foreign` at enumeration time (the conservative, never-falsely-owned,
// read-only-until-proven floor) and is promoted to `owned` ONLY by the later registry probe - a run merely
// observed on disk stays `foreign`.

import { AdapterVersionStamp, CompletenessState, CoverageLabel, FreshnessLabel } from './claudeReaderSeam.js';

// The drill-in read model. A `FleetTranscriptSlice` is the labeled projection the seam produces when a
// subagent's transcript is opened in the editor area: an INDEX-ONLY list of the transcript's records (each reduced
// to its record type + whether it is a subagent sidechain record - never the message body, keeping the seam a
// second index and never a copy of Claude's authoritative content) plus the four honesty labels. Its
// `completeness` is computed at DRILL-IN time and, unlike the coarse enumeration label, includes the out-of-band
// tool-result probe: a record referencing a missing out-of-band file degrades the slice to `partial`, not
// `complete`. Pure `common/`: the only imports are the reader-seam label vocabulary.

/** How a run was launched, as far as the fleet can tell. Refined by later slices; `single` is the default. */
export type FleetRunKind = 'single' | 'background' | 'team' | 'workflow';

/**
 * The lifecycle of one ultracode workflow mission.
 *
 * The on-disk contract is asymmetric and this vocabulary encodes it: the run manifest
 * (`projects/<enc>/<session>/workflows/<runId>.json`) is written ONLY when the run reaches a terminal state, so
 * `completed` / `failed` are read straight off `manifest.status`, while `running` is INFERRED - a journal
 * (`projects/<enc>/<session>/subagents/workflows/<runId>/journal.jsonl`) that exists with no manifest beside it is
 * a run still in flight. `unknown` is the honest floor for a run whose journal and manifest disagree, never a
 * guess.
 */
export type MissionStatus = 'running' | 'completed' | 'failed' | 'unknown';

/** One phase a mission's script declared up front (the `phases` block of its `meta`). */
export interface MissionPhase {
	/** The phase title, as authored. Matched to progress entries by title. */
	readonly title: string;
	/** The optional one-line detail the script declared alongside the title. */
	readonly detail?: string;
}

/** Whether a progress entry marks a phase boundary or one agent's participation. */
export type MissionProgressKind = 'workflow_phase' | 'workflow_agent';

/** One entry in a mission's progress ledger, in the order the run recorded it. */
export interface MissionProgressEntry {
	/** The entry's ordinal within its kind, as recorded by the run. */
	readonly index: number;
	/** The phase title or agent label this entry records. */
	readonly title: string;
	/** Whether this entry is a phase boundary or an agent. */
	readonly kind: MissionProgressKind;
}

/**
 * One ultracode workflow run - a Mission. This is the fleet's PRIMARY entity: Missions is a control surface for
 * orchestrated multi-agent runs, not a transcript browser, so a plain chat session is not a mission and is never
 * enumerated as one.
 *
 * A mission is identified by the existence of its run artifacts under the owning session's sidecar dir, NOT by any
 * field inside a transcript record: the `workflows/<runId>.json` manifest (terminal runs) and the
 * `subagents/workflows/<runId>/journal.jsonl` ledger (live runs). Both are small, so enumerating missions never
 * reads a transcript. Child agents hang off {@link MissionAgent} and are resolved lazily on drill-in.
 *
 * Like every other seam projection this is a LABELED INDEX, never an authoritative copy: it carries the same
 * honesty labels (coverage / freshness / completeness + the adapter-version stamp) as the rest of the read model,
 * and `ownership` defaults to `foreign` until the registry probe positively promotes it.
 */
export interface MissionRun {
	/** The run identity (`wf_<id>`), which is also its journal dir name and manifest stem. */
	readonly runId: string;
	/** The session that launched this mission - the join key for liveness and for stop/steer targeting. */
	readonly sessionId: string;
	/** The workflow's declared name (`meta.name`), shown as the mission's title. */
	readonly name: string;
	/** Terminal status from the manifest, or `running` inferred from a manifest-less journal. */
	readonly status: MissionStatus;
	/** How many agents the run declared (manifest) or has started (live journal). */
	readonly agentCount: number;
	/** Agents whose journal `started` record was seen. Present for live reads. */
	readonly startedCount?: number;
	/** Agents whose journal `result` record was seen. `started > result` means work still in flight. */
	readonly resultCount?: number;
	/** The phases the script declared up front. Empty when the run never reported any. */
	readonly phases: readonly MissionPhase[];
	/** The progress ledger, in recorded order. Empty for a live run whose manifest does not exist yet. */
	readonly progress: readonly MissionProgressEntry[];
	/** Wall-clock duration in ms. Terminal runs only - a live run has no recorded duration. */
	readonly durationMs?: number;
	/** Output tokens the run reported. Terminal runs only. */
	readonly totalTokens?: number;
	/** Tool calls the run reported. Terminal runs only. */
	readonly totalToolCalls?: number;
	/** The model the run defaulted its agents to. Terminal runs only. */
	readonly defaultModel?: string;
	/** Where the orchestration script was authored. May point OUTSIDE the session tree; never hard-require it. */
	readonly scriptPath?: string;
	/** The failure reason a `failed` run recorded. */
	readonly error?: string;
	/** `foreign` until the registry probe promotes it - a mission merely observed on disk stays `foreign`. */
	readonly ownership: FleetOwnership;
	/** How much of the mission is in view. */
	readonly coverage: CoverageLabel;
	/** `live` once the badge slice layers a running mission; `polled` for a plain enumeration read. */
	readonly freshness: FreshnessLabel;
	/** Whether the mission's artifacts were whole (a journal with no manifest is in-flight, NOT incomplete). */
	readonly completeness: CompletenessState;
	/** Which adapter/shape produced the mission, so a schema shift across Claude CLI versions is detectable. */
	readonly adapterVersion: AdapterVersionStamp;
}

/**
 * One agent inside a mission - a FILE with its own transcript, not a sidechain record inside a parent transcript.
 * Resolved lazily when a mission is expanded, by joining the journal's `agentId` to the sibling
 * `agent-<agentId>.jsonl` and its `agent-<agentId>.meta.json` sidecar.
 */
export interface MissionAgent {
	/** The agent identity, and the join key to both its transcript and its meta sidecar. */
	readonly agentId: string;
	/** The mission that spawned this agent. */
	readonly runId: string;
	/** The agent role the sidecar recorded (e.g. `workflow-subagent`, `general-purpose`, `Explore`). */
	readonly agentType?: string;
	/** Whether the agent reported a result. `false` means started-but-unfinished (in flight, failed, or aborted). */
	readonly finished: boolean;
	/** An opaque reference locating the agent's transcript for a later drill-in read. */
	readonly transcriptRef: string;
	/** How much of the agent is in view (inherited from the parent mission's read). */
	readonly coverage: CoverageLabel;
	/** How current the read is. */
	readonly freshness: FreshnessLabel;
	/** Whether the read was whole, and if not, why. */
	readonly completeness: CompletenessState;
}

/**
 * Whether THIS Clawdius workbench holds the run (`owned`) or it is merely observed on disk (`foreign`). At
 * enumeration time this is ALWAYS `foreign`: `owned` is a positive signal resolved later by the registry probe,
 * never inferred from an on-disk read.
 */
export type FleetOwnership = 'owned' | 'foreign';

/**
 * One observable run enumerated by the seam across the config root's `projects/` dir - a labeled projection, not
 * an authoritative copy. Every instance carries the four honesty labels inline (coverage / freshness /
 * completeness + the adapter-version stamp), so a consumer can render an honest status for every run without a
 * second read. A foreign or suppressed run appears in the enumeration WITH its label, never omitted.
 */
export interface FleetRun {
	/** Stable run identity (the main-line record's id, falling back to the session id / session file identity). */
	readonly runId: string;
	/** The session this run belongs to. */
	readonly sessionId: string;
	/** How the run was launched, as far as the fleet can tell (default `single`; refined later). */
	readonly kind: FleetRunKind;
	/** A coarse status string. Live run status is layered by the badge slice; at enumeration it is not known. */
	readonly status: string;
	/** `foreign` at enumeration time, always - `owned` is only ever promoted by the later registry probe. */
	readonly ownership: FleetOwnership;
	/** How much of the run is in view: in-scope, foreign (another workspace), or out-of-scope. */
	readonly coverage: CoverageLabel;
	/** How current the read is: a pure enumeration read is `polled` (live is layered by the badge slice). */
	readonly freshness: FreshnessLabel;
	/** Whether the run's transcript read was whole, and if not, why (absent / partial / unknown-shape). */
	readonly completeness: CompletenessState;
	/** Which adapter/shape produced the run, so a schema shift across Claude CLI versions is detectable. */
	readonly adapterVersion: AdapterVersionStamp;
}

/**
 * One subagent spawned by a run, enumerated per-run by the seam - a labeled index into the subagent's transcript
 * (drillable via the shipped `subagent` / `transcript-slice` seam reads), never a copy of its content. Carries
 * the same honesty labels as its parent run's read.
 */
export interface FleetSubagent {
	/** Stable subagent identity (the sidechain root record's id). */
	readonly subagentId: string;
	/** The run that spawned this subagent. */
	readonly parentRunId: string;
	/** An opaque reference locating the subagent's transcript for a later drill-in read (the file identity). */
	readonly transcriptRef: string;
	/** How much of the subagent is in view (inherited from the parent run's read). */
	readonly coverage: CoverageLabel;
	/** How current the read is: `polled` at enumeration time. */
	readonly freshness: FreshnessLabel;
	/** Whether the read was whole, and if not, why. */
	readonly completeness: CompletenessState;
}

/**
 * One record in a drilled-in subagent transcript, reduced to the INDEX-ONLY fields the drill-in editor renders:
 * the record type (`user` / `assistant` / `system` / `summary`) and whether it is a subagent sidechain record.
 * The message body is deliberately never carried - the seam is an index over Claude's transcript, not a copy of it.
 */
export interface FleetTranscriptRecord {
	/** The transcript record type (`user` / `assistant` / `system` / `summary`). */
	readonly type: string;
	/** Whether this record belongs to a subagent's sidechain thread (vs the run's main line). */
	readonly isSidechain: boolean;
}

/**
 * A subagent's drilled-in transcript, read through the seam by the transcript-drill-in editor: the
 * subagent it was opened from, the index-only records in view, and the four honesty labels. `completeness` is the
 * drill-in read's OWN label, which unlike the coarse enumeration label runs the out-of-band tool-result probe, so
 * a transcript referencing a missing out-of-band file is `partial`, not `complete`. Never an
 * authoritative copy of Claude state.
 */
export interface FleetTranscriptSlice {
	/** The subagent this transcript was drilled into (empty when the drill-in root carried no id). */
	readonly subagentId: string;
	/** The index-only records in view (never the message bodies). */
	readonly records: readonly FleetTranscriptRecord[];
	/** How much of the transcript is in view. */
	readonly coverage: CoverageLabel;
	/** How current the read is: `polled` at drill-in time. */
	readonly freshness: FreshnessLabel;
	/** Whether the read was whole, and if not, why - including the out-of-band probe (missing ref -> `partial`). */
	readonly completeness: CompletenessState;
	/** Which adapter/shape produced the slice, so a schema shift across Claude CLI versions is detectable. */
	readonly adapterVersion: AdapterVersionStamp;
}
// CLAWDIUS-END
