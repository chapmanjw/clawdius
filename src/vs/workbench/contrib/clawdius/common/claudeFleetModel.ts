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
export type FleetRunKind = 'single' | 'background' | 'team';

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
