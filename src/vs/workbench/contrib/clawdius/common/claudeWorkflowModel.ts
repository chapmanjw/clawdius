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
	/** The `projects/<dir>` directory this run's artifacts were walked out of, VERBATIM. This is Claude Code's own
	 *  LOSSY encoding of the launching process's working directory (every non-alphanumeric replaced with '-'), not a
	 *  path and not invertible - it is never decoded back to a location and never read from. Carried as the raw
	 *  OBSERVED name so the (fallible, case-variant, many-to-one) comparison against the open workspace folders stays
	 *  OUT of enumeration and lives in {@link matchesWorkflowWorkspaceScope}, which each surface re-runs against the
	 *  CURRENT folder set - a set that changes while the pane is open, with no re-walk of the corpus.
	 *
	 *  REQUIRED, deliberately: on this model `?` means "the on-disk source did not record it" (see
	 *  {@link LiveWorkflowRun}'s comment and {@link TerminalWorkflowRun.agentCount}). This is not a READ field - it is
	 *  a fact about where the seam walked, held in hand at every construction site - so marking it optional would
	 *  assert a legitimate-absence case that cannot occur, and would make a future seam path that genuinely forgot to
	 *  set it indistinguishable from an honest gap. A bare `string` also adds no import, so this layer stays pure. */
	readonly projectDirName: string;
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
	/** The number of DISTINCT agent ids that have ANY journal record (the union of the started and result id sets) -
	 *  the honest "agents seen so far" denominator, always >= `resultCount` even when a `started` record was torn
	 *  or otherwise dropped. `startedCount` and `resultCount` are counted from INDEPENDENT id sets, so a result whose
	 *  own `started` line never survived would otherwise let `resultCount` exceed `startedCount` - painting a ratio
	 *  like "3 of 1 agents seen so far" and handing a progress bar a `worked` value above its own `total`. */
	readonly seenCount: number;
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

// --- workspace scope ---------------------------------------------------------------------------------------------
//
// The scope vocabulary + its predicate live HERE, in the pure `common/` layer, rather than beside the SelectBox that
// drives them. TWO surfaces apply this exact rule to the exact same run set - the Workflows pane's list and the
// activity-bar badge the observation service registers for the pane's container - and the two must never disagree
// about what "this workspace" contains. The service cannot import the predicate from the view (the view already
// imports the snapshot type and the container id FROM the service, so the reverse edge would close an import
// cycle), and both can reach `common/`. Nothing added here takes an import, so this layer stays pure.

/** Whether the Workflows surface is limited to the runs attributable to the currently-open workspace folder(s), or
 *  shows every run under the Claude config root. A `const enum` with string values, matching the pane's sibling
 *  filter/sort enums - the values are what is PERSISTED, so they must stay stable. */
export const enum WorkflowWorkspaceScope {
	ThisWorkspace = 'this-workspace',
	AllWorkspaces = 'all-workspaces',
}

/** The scope in force when nothing has been persisted yet. `this-workspace`: the config root is machine-global, so
 *  an unscoped surface is dominated by other projects' runs. Read by BOTH the view's restore-from-storage and the
 *  observation service's badge computation, so a fresh profile cannot have the badge counting one set of runs while
 *  the pane lists another. */
export const DEFAULT_WORKFLOW_WORKSPACE_SCOPE = WorkflowWorkspaceScope.ThisWorkspace;

/** Whether a persisted string is a scope this build actually offers - a stored value from a newer (or corrupt)
 *  profile reads as "never stored" and falls back to {@link DEFAULT_WORKFLOW_WORKSPACE_SCOPE}, never as a scope
 *  nothing matches. */
export function isWorkflowWorkspaceScope(value: string | undefined): value is WorkflowWorkspaceScope {
	return value === WorkflowWorkspaceScope.ThisWorkspace || value === WorkflowWorkspaceScope.AllWorkspaces;
}

/**
 * Whether a run belongs to `scope`. `all-workspaces` matches every run. `this-workspace` matches a run whose
 * `projectDirName` equals, or sits UNDER, one of `workspaceKeys` - the CASE-FOLDED `encodeProjectDir` (see
 * `clawdiusConfigStore.ts`) of each open folder.
 *
 * Three deliberate widenings, all of which can only SHOW a run, never hide one:
 *  - The compare is CASE-FOLDED. `URI.fsPath` lower-cases the Windows drive letter, so `encodeProjectDir` always
 *    yields `c--...` while Claude Code writes `C--...` on disk (measured: 135 of 140 real project dirs on this
 *    machine). Exact equality would make this filter hide everything on Windows. Mirrors the same tolerance
 *    `normalizePath` applies in claudeReaderSeamService.ts, for the same stated reason.
 *  - The compare is a PREFIX match on the encoded path, not set membership. Claude Code records the LAUNCHING
 *    process's working directory, which is the folder ROOT only when the developer happened to run `claude` from
 *    the root - running it from `C:\repo\packages\api` in an open `C:\repo` writes `C--repo-packages-api`, and
 *    Clawdius's OWN worktree isolation guarantees the mismatch (`getWorktreesRoot` locks the agent cwd to
 *    `<repo>.worktrees/<branch>`, which encodes as `<repoKey>-worktrees-<branch>` and can never equal `<repoKey>`).
 *    Exact membership dropped every one of those from the shipped default scope. The `-` separator is required, so
 *    a folder `c--src-claw` cannot match a sibling repo `c--src-clawdius`; a genuine encoding collision
 *    (`C:\src\claw-dius` under an open `C:\src\claw`) errs toward SURFACING the run.
 *  - An EMPTY `workspaceKeys` (no folder open) matches every run: there is nothing to scope to, so the effective
 *    scope is All Workspaces. Diverges DELIBERATELY from the seam's `coverageForEnum`, which labels a cwd-declaring
 *    run `Foreign` with no folders open. That is right for a LABEL, which still SURFACES the run, and wrong for a
 *    FILTER, which deletes it - applying a labelling rule to a hiding mechanism turns an honesty signal into data
 *    loss.
 *
 * A run whose `projectDirName` is empty is unattributable and is likewise SHOWN, matching `coverageForEnum`'s
 * missing-cwd branch: a filter must never hide what the seam itself declines to narrow.
 *
 * Deliberately NOT defended against: encoding collisions (`/a/b-c`, `/a-b/c` and `/a/b.c` all encode alike) and a
 * cwd that is neither the folder nor under it (a symlinked or sibling checkout). The encoding is lossy and
 * non-invertible; there is no honest way to disambiguate. The answer is that this is a USER-CHOSEN scope with a
 * one-click escape hatch and an empty state that says how many runs it withheld - never a silent blank pane.
 */
export function matchesWorkflowWorkspaceScope(
	run: WorkflowRun, scope: WorkflowWorkspaceScope, workspaceKeys: ReadonlySet<string>,
): boolean {
	if (scope === WorkflowWorkspaceScope.AllWorkspaces) { return true; }
	if (workspaceKeys.size === 0 || run.projectDirName.length === 0) { return true; }
	const key = run.projectDirName.toLowerCase();
	for (const folderKey of workspaceKeys) {
		if (key === folderKey || key.startsWith(`${folderKey}-`)) { return true; }
	}
	return false;
}

/** The persisted set of failure identities the developer has already seen (the awareness watermark) - a
 *  versioned identity SET, never a max-timestamp (which cannot classify a missing timestamp, a pre-open run, or
 *  a tie). Identities are {@link WorkflowRunBase.identity} strings. */
export interface FailureWatermark {
	readonly version: 1;
	readonly seen: readonly string[];
}
// CLAWDIUS-END
