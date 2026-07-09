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
// mirrors data-model.md: it DEFAULTS to `foreign` at enumeration time (the conservative, never-falsely-owned,
// read-only-until-proven floor) and is promoted to `owned` ONLY by the later registry probe - a run merely
// observed on disk stays `foreign`.

import { AdapterVersionStamp, CompletenessState, CoverageLabel, FreshnessLabel } from './claudeReaderSeam.js';

/** How a run was launched, as far as the fleet can tell. Refined by later slices; `single` is the default. */
export type FleetRunKind = 'single' | 'background' | 'team';

/**
 * Whether THIS Clawdius workbench holds the run (`owned`) or it is merely observed on disk (`foreign`). At
 * enumeration time this is ALWAYS `foreign`: `owned` is a positive signal resolved later by the registry probe,
 * never inferred from an on-disk read. The two-value shape matches data-model.md + the fleet contract.
 */
export type FleetOwnership = 'owned' | 'foreign';

/**
 * One observable run enumerated by the seam across the config root's `projects/` dir - a labeled projection, not
 * an authoritative copy. Every instance carries the four honesty labels inline (coverage / freshness /
 * completeness + the adapter-version stamp), so a consumer can render an honest status for every run without a
 * second read. A foreign or suppressed run appears in the enumeration WITH its label, never omitted (SC-002).
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
// CLAWDIUS-END
