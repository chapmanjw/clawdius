/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - validated read model
// The pure `common/` read model the Workflows surface binds to: a discriminated projection of one on-disk
// workflow run, validated field-by-field at read time (never cast) by the reader seam. A `WorkflowRun` holds NO
// authoritative Claude state and is never a second copy of it - it is a labeled index over what the seam read
// under the resolved config root, carrying the same honesty labels (coverage / freshness / completeness + the
// adapter-version stamp) every other seam projection carries. This layer stays pure so it can be unit-tested
// without a host: the only imports are the reader-seam label vocabulary and the fleet ownership type; there is
// NO Node/`process`/renderer import (purity is enforced by `valid-layers-check`).
//
// The three run kinds encode an asymmetry measured on real data: a TERMINAL run has a valid sibling manifest
// (written only once the run finishes) and so can carry a summary/cost/phases/agents; a LIVE run has only its
// append-only journal and so can carry counts + a last-write time and nothing richer (no name, no cost, no
// phases - none of that exists on disk yet); a run whose manifest exists but is not a recognized shape is neither
// - it is surfaced honestly as `unknown-shape` rather than guessed into one of the other two.

import { FleetOwnership } from './claudeFleetModel.js';
import { AdapterVersionStamp, CompletenessState, CoverageLabel, FreshnessLabel } from './claudeReaderSeam.js';

/** Stable composite identity for one workflow run: a bare `runId` can collide across sessions (the launcher's run
 *  ids are not guaranteed globally unique), so every consumer keys off this composite instead. */
export function workflowRunIdentity(sessionId: string, runId: string): string {
	return `run:${sessionId}:${runId}`;
}

/** Fields every {@link WorkflowRun} variant carries, terminal or live or unrecognized - the identity + the
 *  honesty labels every seam projection attaches. */
interface WorkflowRunBase {
	/** The session that launched this run - the join key for its journal and agent transcripts. */
	readonly sessionId: string;
	/** The run identity (`wf_<id>`), also its journal dir name and manifest stem. */
	readonly runId: string;
	/** The stable composite identity ({@link workflowRunIdentity}), used by the tree's identity provider. */
	readonly identity: string;
	/** `foreign` until a later registry probe promotes it - a run merely observed on disk stays `foreign`. */
	readonly ownership: FleetOwnership;
	/** How much of the run is in view. */
	readonly coverage: CoverageLabel;
	/** How current the read is. */
	readonly freshness: FreshnessLabel;
	/** Whether the read was whole, and if not, why. */
	readonly completeness: CompletenessState;
	/** Which adapter/shape produced the run, so a schema shift across Claude CLI versions is detectable. */
	readonly adapterVersion: AdapterVersionStamp;
}

/** One landed result on a still-live run: an agent's `result` journal payload, reduced to a safe preview. A
 *  non-string payload cannot be shown as text, so it reads as the honest fallback rather than being coerced or
 *  dropped. */
export interface LiveWorkflowResult {
	readonly agentId: string;
	/** A bounded preview of a string payload (textContent-safe), or the literal "Result landed" fallback for a non-string one. */
	readonly preview: string;
}

/**
 * A run whose journal has no valid sibling manifest yet - the ONLY shape a run still in flight has on disk. Holds
 * NO name / summary / phase / model / cost / total-agent-count / percentage: none of that exists until the
 * manifest is written, so showing any of it here would be fabricated, not merely estimated.
 */
export interface LiveWorkflowRun extends WorkflowRunBase {
	readonly kind: 'live';
	/** Distinct agent ids with a `started` journal record. */
	readonly startedCount: number;
	/** Distinct agent ids with a `result` journal record. `started > result` means work is still in flight. */
	readonly resultCount: number;
	/** The results that have landed so far, each a safe preview or the "Result landed" fallback. */
	readonly landedResults: readonly LiveWorkflowResult[];
	/** The journal file's mtime - the ONLY time signal a live run has (never a fabricated "paused" state). */
	readonly journalLastWriteTime: number;
	/** Set when the journal itself was a known gap: `partial` for a torn line among otherwise-recognized records,
	 *  `unknown-shape` when the file had content but nothing recognizable came out of it. Absent when the read of
	 *  what exists is otherwise whole (an in-flight run is not incomplete merely for being in flight). */
	readonly degradation?: 'partial' | 'unknown-shape';
}

/** One phase a terminal run's script declared up front, with the agent/error tallies derived from its own
 *  validated agents (never a raw on-disk count - the manifest carries no such field). Grouping under phase nodes
 *  is a view-layer decision applied only when `phases.length > 1`. */
export interface WorkflowPhase {
	/** The phase's position among the manifest's declared phases (0-based). */
	readonly index: number;
	/** The phase title, as authored. */
	readonly title: string;
	/** The optional one-line detail the script declared alongside the title. */
	readonly detail?: string;
	/** How many of the run's validated agents belong to this phase. */
	readonly agentCount: number;
	/** How many of those agents ended in `state: 'error'`. */
	readonly errorCount: number;
}

/** Whether a validated agent belongs to a phase. `phaseIndex` is the unambiguous positional key, so it wins when
 *  present (a title can be duplicated across phases; an index cannot); the title is the fallback. This ONE predicate
 *  is shared by the reader's phase-count derivation and the tree's agent grouping, so a phase's rendered agent count
 *  can never contradict the agent rows nested beneath it. */
export function agentInPhase(
	agent: { readonly phaseIndex?: number; readonly phaseTitle?: string },
	phase: { readonly index: number; readonly title: string },
): boolean {
	return agent.phaseIndex !== undefined ? agent.phaseIndex === phase.index : agent.phaseTitle === phase.title;
}

/** Assign each agent to the FIRST declared phase it belongs to (by {@link agentInPhase}, declared order), returning
 *  the agents grouped by `phase.index` plus the agents that matched no phase. First-match placement is what makes a
 *  title-only agent whose title matches DUPLICATE phase titles land in ONE phase, not several - so the reader never
 *  double-COUNTS it and the tree never double-NESTS it into two rows with the same identity. Shared by both so a
 *  phase's rendered count can never disagree with the rows beneath it. Phase indices are positional and unique, so
 *  the grouping map never collapses two phases. */
export function assignAgentsToPhases<A extends { readonly phaseIndex?: number; readonly phaseTitle?: string }>(
	agents: readonly A[],
	phases: readonly { readonly index: number; readonly title: string }[],
): { readonly byPhaseIndex: ReadonlyMap<number, readonly A[]>; readonly unassigned: readonly A[] } {
	const byPhaseIndex = new Map<number, A[]>();
	for (const phase of phases) { byPhaseIndex.set(phase.index, []); }
	const unassigned: A[] = [];
	for (const agent of agents) {
		const phase = phases.find(candidate => agentInPhase(agent, candidate));
		const bucket = phase ? byPhaseIndex.get(phase.index) : undefined;
		if (bucket) { bucket.push(agent); } else { unassigned.push(agent); }
	}
	return { byPhaseIndex, unassigned };
}

/** Identities locating one agent's raw on-disk transcript - never a URI. The seam re-derives
 *  `subagents/workflows/wf_<runId>/agent-<agentId>.jsonl` under the resolved root from these three components
 *  before every read, so a restored/serialized ref can never redirect the read elsewhere. */
export interface WorkflowTranscriptRef {
	readonly sessionId: string;
	readonly runId: string;
	readonly agentId: string;
}

/**
 * One agent inside a terminal run - a FILE with its own transcript, not a sidechain record inside a parent
 * transcript. `agentId`/`label`/`state` are the only required fields (the measured vocabulary); every other field
 * is validated independently and simply absent when not present or not readable. `error` is the AUTHORITATIVE
 * failure content on an errored agent: measured on every errored agent in the real corpus, so its absence there
 * is itself a known gap, not silence.
 */
export interface TerminalWorkflowAgent {
	/** The agent identity, validated path-safe - the join key to its transcript and meta sidecar. */
	readonly agentId: string;
	/** The agent's display label, as authored. */
	readonly label: string;
	/** The only measured state vocabulary. */
	readonly state: 'done' | 'error';
	readonly model?: string;
	readonly tokens?: number;
	readonly toolCalls?: number;
	readonly durationMs?: number;
	readonly phaseTitle?: string;
	readonly phaseIndex?: number;
	readonly lastToolName?: string;
	readonly agentType?: string;
	/** Shown where present, else a dash - never fabricated. */
	readonly promptPreview?: string;
	/** Shown where present; typically absent on an errored agent (its `error` field carries the failure instead). */
	readonly resultPreview?: string;
	/** The authoritative failure text on `state: 'error'`. Its absence on an errored agent degrades the read to
	 *  `partial` rather than being silently omitted. */
	readonly error?: string;
	/** Surfaced only when greater than 1 (a first attempt is not called out). */
	readonly attempt?: number;
	/** Present ONLY when the deterministic identity join (manifest agentId -> journal `started` -> sibling
	 *  transcript file) succeeds for this exact agent. Absent means the [open transcript] action is withheld. */
	readonly transcriptRef?: WorkflowTranscriptRef;
}

/**
 * A terminal run - one whose manifest exists and was recognized. `status: 'failed'` is still terminal: it gets
 * the same story-leaf + cost + per-agent presentation as `completed`, with failure diagnostics (errored-agent
 * count, error-phase, authoritative `error`) layered on top by the view.
 */
export interface TerminalWorkflowRun extends WorkflowRunBase {
	readonly kind: 'terminal';
	readonly workflowName?: string;
	readonly summary?: string;
	readonly status: 'completed' | 'failed';
	/** Run start, epoch ms. */
	readonly startTime?: number;
	/** Run completion, epoch ms. The manifest records this as an ISO-8601 string (and `startTime` as epoch ms); the
	 *  seam parses either form to epoch ms, degrading the read to `partial` only on an unparseable value. */
	readonly timestamp?: number;
	readonly durationMs?: number;
	readonly totalTokens?: number;
	readonly totalToolCalls?: number;
	readonly agentCount?: number;
	readonly defaultModel?: string;
	/** The full result as plain text - safe WHEN rendered via `textContent` (the fork renders all such text via
	 *  `textContent`, never innerHTML/markdown); NOT markup-escaped at the seam, which would double-escape. A
	 *  STRUCTURED (object/array) manifest result - the common shape, since a workflow script returns structured data
	 *  - is serialized to JSON text at the seam; a plain-string result is kept as-is. */
	readonly resultText?: string;
	/** A bounded preview of {@link resultText}; absent means the row reads "No result recorded". */
	readonly resultPreview?: string;
	/** The RUN-level failure text a `failed` run recorded (distinct from a per-agent `error`). */
	readonly error?: string;
	/** Grouped under phase nodes only when `phases.length > 1`. */
	readonly phases: readonly WorkflowPhase[];
	readonly agents: readonly TerminalWorkflowAgent[];
}

/** A run whose manifest exists but was not a shape this reader version recognizes - a schema shift, surfaced
 *  honestly (a warning row + "shape not recognized") rather than guessed into `live` or `terminal`. */
export interface UnrecognizedWorkflowRun extends WorkflowRunBase {
	readonly kind: 'unknown-shape';
}

/** One observable Claude Code workflow run, discriminated by on-disk shape. */
export type WorkflowRun = LiveWorkflowRun | TerminalWorkflowRun | UnrecognizedWorkflowRun;

/**
 * A terminal run's agents PLUS the list's own completeness - the envelope exists because a gap can erase a row
 * rather than mark one (the shipped `MissionAgentList` invariant, preserved): an empty list can still say
 * `partial` (its agents were unreadable), distinct from a run that genuinely ran none.
 */
export interface WorkflowAgentList {
	readonly agents: readonly TerminalWorkflowAgent[];
	readonly completeness: CompletenessState;
}

/**
 * The typed root envelope {@link listWorkflows} returns, replacing a bare array so an enumeration failure can
 * never collapse to the same shape as a successful empty read - an empty read and a read failure are distinct
 * outcomes and must render distinctly.
 */
export type WorkflowRunListResult =
	| { readonly state: 'ok'; readonly runs: readonly WorkflowRun[] }
	| { readonly state: 'partial'; readonly runs: readonly WorkflowRun[]; readonly message: string }
	| { readonly state: 'read-error'; readonly runs: readonly []; readonly message: string };

/** The persisted set of failure identities the developer has already seen (the awareness watermark) - a
 *  versioned identity SET, never a max-timestamp (which cannot classify a missing timestamp, a pre-open run, or
 *  a tie). Identities are {@link WorkflowRunBase.identity} strings. */
export interface FailureWatermark {
	readonly version: 1;
	readonly seen: readonly string[];
}
// CLAWDIUS-END
