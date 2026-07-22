/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - WorkbenchObjectTree model + renderers
// Replaces the Workflows view's hand-rolled manual-DOM row list with a real `WorkbenchObjectTree` bound
// directly to the discriminated `WorkflowRun` union (`common/claudeWorkflowModel.ts`) - no more flattening the
// validated model back into the legacy `MissionRun` shape. A run is the tree's top-level row, rendered COMPACT
// (a status glyph + ellipsized name + an exception-only chip row on line one, a muted cost line on line two -
// never the summary/result/error text inline, see `WorkflowRunRowRenderer`). A TERMINAL run expands (native
// twistie / single click) to ONLY its phase/agent rows (the 0/1/>1 phase-grouping rule below) - no inline leaf of
// any kind; a LIVE or unknown-shape run has no children at all. Every row is a FIXED height (see
// `WorkflowTreeVirtualDelegate`) - there is no measured, variable-height leaf anywhere in this tree. Activating a
// terminal `run` row (Enter / double-click, never the twistie / single click that toggles expansion) opens the
// run's FULL result in the detail editor; activating an `agent` row opens that agent's detail; a `phase` row and
// a non-terminal `run` row open nothing.
//
// The ownership-chrome rule lives in two places by design: `computeUniformlyForeign` is the pure
// predicate the VIEW evaluates once per refresh (never per-row - it must never re-read disk from inside a
// renderer), and the run-row renderer reads the already-computed signal off a small mutable `IWorkflowRenderContext`
// the view owns and updates in place. The SURFACE label (one line above the tree, shown only while every run is
// foreign) is painted by the view itself, not by any renderer - see `updateSurfaceOwnershipLabel` in
// claudeWorkflowsView.ts.
//
// `reconcileWorkflowTree` (near the bottom of this file, alongside `buildWorkflowTreeChildren`) is the graduation-
// aware reconciliation the view's snapshot handler calls into: it is the one place that understands the tree's
// identity-diff subtlety (an unchanged-identity node's own data is never swapped in automatically - see that
// function's doc comment) and is exported, typed against the plain `ObjectTree` base class, so a test can drive it
// without constructing the full `ViewPane`.

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { IconLabel } from '../../../../../base/browser/ui/iconLabel/iconLabel.js';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { ObjectTree } from '../../../../../base/browser/ui/tree/objectTree.js';
import { IObjectTreeElement, ITreeElement, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { fromNow } from '../../../../../base/common/date.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { hash } from '../../../../../base/common/hash.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { formatTokenCount } from '../../../../../base/common/numbers.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { FleetOwnership } from '../../common/claudeFleetModel.js';
import { CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';
import {
	assignAgentsToPhases, TerminalWorkflowAgent, TerminalWorkflowRun, UnrecognizedWorkflowRun,
	WorkflowPhase, WorkflowRun, WorkflowRunListResult,
} from '../../common/claudeWorkflowModel.js';
import { formatDuration } from '../usage/claudeUsageData.js';
import { BadgeSignal } from './claudeWorkflowBadges.js';
import { resolveOwnership } from './claudeWorkflowOwnership.js';

/** The literal shown for a number the model declares optional and this run/agent did not carry - NEVER a
 *  fabricated 0. Reused verbatim from the pre-tree row renderer's convention. EXPORTED so the detail drill-in
 *  editor (claudeWorkflowDetailEditor.ts) reuses the exact same convention instead of a second dash literal. */
export const DASH = '—';

// --- the tree element union -----------------------------------------------------------------------------------

/** The tree's own discriminated element union - one node kind per row shape. A `phase`/`agent` node always
 *  carries its owning `run` (narrowed to `TerminalWorkflowRun`, the only kind with a manifest to describe) so a
 *  renderer never needs a separate parent lookup. */
export type WorkflowTreeElement =
	| { readonly kind: 'run'; readonly run: WorkflowRun }
	| { readonly kind: 'phase'; readonly run: TerminalWorkflowRun; readonly phase: WorkflowPhase }
	| { readonly kind: 'agent'; readonly run: TerminalWorkflowRun; readonly agent: TerminalWorkflowAgent };

// --- identity ----------------------------------------------------------------------------------------------

/** The tree's stable per-element key: `run:<identity>` / `phase:<identity>:<index>` / `agent:<identity>:<agentId>`,
 *  always built off the model's own composite `identity` (never a bare `runId`, which can collide across
 *  sessions). */
export function workflowTreeElementId(element: WorkflowTreeElement): string {
	switch (element.kind) {
		case 'run': return `run:${element.run.identity}`;
		case 'phase': return `phase:${element.run.identity}:${element.phase.index}`;
		case 'agent': return `agent:${element.run.identity}:${element.agent.agentId}`;
	}
}

export class WorkflowTreeIdentityProvider implements IIdentityProvider<WorkflowTreeElement> {
	getId(element: WorkflowTreeElement): { toString(): string } {
		return workflowTreeElementId(element);
	}
}

// --- pure content/formatting helpers (unit-testable without a DOM) -------------------------------------------

/** EXPORTED alongside {@link DASH} for the same reuse reason - the detail drill-in editor's cost rows follow the
 *  identical "dash when absent, formatted when present" rule the tree's own row content already established. */
export function orDash(value: number | undefined, format: (value: number) => string): string {
	return value === undefined ? DASH : format(value);
}

/** The run row's primary label + secondary parts (workflowName, relative time), computed PURELY off the model.
 *  `relativeTimeOf` is injectable (defaults to the real `fromNow`) so a unit test gets a deterministic string
 *  instead of stubbing the system clock. */
export interface WorkflowRunRowContent {
	readonly primary: string;
	readonly secondaryParts: readonly string[];
}

export function describeRunRow(run: WorkflowRun, relativeTimeOf: (ms: number) => string = ms => fromNow(ms, true)): WorkflowRunRowContent {
	switch (run.kind) {
		case 'terminal': {
			const primary = run.summary ?? run.workflowName ?? run.runId;
			const secondaryParts: string[] = [];
			if (run.workflowName) {
				secondaryParts.push(run.workflowName);
			}
			const timestamp = run.timestamp ?? run.startTime;
			if (timestamp !== undefined) {
				secondaryParts.push(relativeTimeOf(timestamp));
			}
			return { primary, secondaryParts };
		}
		case 'live':
			// Honest minimal: NO name/summary exists for a live run (see claudeWorkflowModel.ts), so the ROW stays
			// runId + last-write time - the only fields a live run's compact row ever shows (see the file header
			// comment: a live run has no children and no expanded detail to show its started/result counts in).
			return { primary: run.runId, secondaryParts: [relativeTimeOf(run.journalLastWriteTime)] };
		case 'unknown-shape':
			return { primary: localize('clawdius.workflows.unknownShape', "Shape not recognized"), secondaryParts: [run.runId] };
	}
}

export function runStatusIcon(run: WorkflowRun): ThemeIcon {
	switch (run.kind) {
		case 'live': return Codicon.sync;
		case 'terminal': return run.status === 'failed' ? Codicon.error : Codicon.passFilled;
		case 'unknown-shape': return Codicon.warning;
	}
}

export function runStatusClass(run: WorkflowRun): string {
	switch (run.kind) {
		case 'live': return 'status-live';
		case 'terminal': return run.status === 'failed' ? 'status-failed' : 'status-completed';
		case 'unknown-shape': return 'status-unknown';
	}
}

/** The run's errored-agent tally: how many of a TERMINAL run's validated agents ended in `state: 'error'`.
 *  `undefined` for a live/unknown-shape run, which carries no agent list at all - there is no tally to (not) show,
 *  so the run-row renderer must never fabricate a 0 for it. A terminal run with zero errored agents legitimately
 *  tallies to 0; whether 0 is shown is the RENDERER's call (exception-only - see `WorkflowRunRowRenderer`), not
 *  this pure function's. */
export function erroredAgentCount(run: WorkflowRun): number | undefined {
	return run.kind === 'terminal' ? run.agents.filter(agent => agent.state === 'error').length : undefined;
}

/** The run row's compact SECOND line (see the file header comment) - "model · tokens · duration · N agents" for a
 *  terminal run, the same dash-when-absent convention every cost line in this file uses (never a fabricated 0). A
 *  live/unknown-shape run carries none of these fields, so it falls back to {@link describeRunRow}'s own
 *  `secondaryParts` (the only honest content available for it) rather than a row of dashes. Deliberately never
 *  includes the run's summary/result/error text - those are reachable only by opening the run's detail. */
export function describeRunMetaParts(run: WorkflowRun): readonly string[] {
	if (run.kind !== 'terminal') {
		return describeRunRow(run).secondaryParts;
	}
	return [
		run.defaultModel ?? DASH,
		orDash(run.totalTokens, n => localize('clawdius.workflows.run.tokens', "{0} tokens", formatTokenCount(n))),
		orDash(run.durationMs, formatDuration),
		orDash(run.agentCount, n => localize('clawdius.workflows.run.agentCount', "{0} agents", n)),
	];
}

export function describePhase(phase: WorkflowPhase): { readonly title: string; readonly detail: string | undefined; readonly agentsLabel: string; readonly errorsLabel: string | undefined } {
	return {
		title: phase.title,
		detail: phase.detail,
		agentsLabel: localize('clawdius.workflows.phase.agents', "{0} agents", phase.agentCount),
		errorsLabel: phase.errorCount > 0 ? localize('clawdius.workflows.phase.errors', "{0} errors", phase.errorCount) : undefined,
	};
}

export function describeAgent(agent: TerminalWorkflowAgent): { readonly label: string; readonly metricsParts: readonly string[]; readonly icon: ThemeIcon } {
	return {
		label: agent.label,
		metricsParts: [
			orDash(agent.tokens, n => localize('clawdius.workflows.agent.tokens', "{0} tokens", formatTokenCount(n))),
			orDash(agent.toolCalls, n => localize('clawdius.workflows.agent.toolCalls', "{0} calls", n)),
			orDash(agent.durationMs, formatDuration),
		],
		icon: agent.state === 'error' ? Codicon.error : Codicon.check,
	};
}

// --- plain-English display text for the honesty labels ---------------------------------------------------------
//
// The reader seam's own vocabulary (`owned`/`foreign`, `in-scope`/`out-of-scope`, `polled`/`live`,
// `partial`/`absent`/`suppressed`/`unknown-shape`) is precise but reads as internal jargon to a user. These
// functions are the ONE place that maps each raw value to plain English for DISPLAY - the raw value itself still
// drives every `data-*` hook and per-state CSS class (untouched, since tests and the e2e harness key off them),
// only the text a user actually reads changes. Reused by the run row's ownership/completeness chips
// (`WorkflowRunRowRenderer`, below) and the transcript header's coverage/completeness/freshness badges
// (`claudeWorkflowTranscriptEditor.ts`).

/** Plain-English display text for a run's OWNERSHIP. The raw `FleetOwnership` value still drives the `data-*`
 *  hook and the `ownership-${value}` CSS class - only this text changes. */
export function describeOwnershipLabel(ownership: FleetOwnership): string {
	switch (ownership) {
		case 'owned': return localize('clawdius.workflows.ownership.owned', "Started here");
		case 'foreign': return localize('clawdius.workflows.ownership.foreign', "Observed");
	}
}

/** Plain-English display text for the {@link CoverageLabel} honesty dimension - how much of a run/transcript is
 *  in view. Exhaustive so a future member fails to compile here rather than falling through silently. */
export function describeCoverageLabel(coverage: CoverageLabel): string {
	switch (coverage) {
		case CoverageLabel.InScope: return localize('clawdius.workflows.coverage.inScope', "This workspace");
		case CoverageLabel.Foreign: return localize('clawdius.workflows.coverage.foreign', "Another workspace");
		case CoverageLabel.OutOfScope: return localize('clawdius.workflows.coverage.outOfScope', "Outside workspace");
	}
}

/** Plain-English display text for the {@link FreshnessLabel} honesty dimension - how current a read is. */
export function describeFreshnessLabel(freshness: FreshnessLabel): string {
	switch (freshness) {
		case FreshnessLabel.Live: return localize('clawdius.workflows.freshness.live', "Live");
		case FreshnessLabel.Polled: return localize('clawdius.workflows.freshness.polled', "From disk");
		case FreshnessLabel.Stale: return localize('clawdius.workflows.freshness.stale', "Possibly outdated");
	}
}

/** Plain-English display text for the {@link CompletenessState} honesty dimension, EXCEPTION-ONLY: `undefined`
 *  for `Complete` (the silent, expected case - every caller must gate on this rather than render an empty chip),
 *  mirroring {@link describeCompletenessForAria}'s own exhaustive-switch shape below. */
export function describeCompletenessLabel(completeness: CompletenessState): string | undefined {
	switch (completeness) {
		case CompletenessState.Complete: return undefined;
		case CompletenessState.Partial: return localize('clawdius.workflows.completeness.partial', "Partial read");
		case CompletenessState.Absent: return localize('clawdius.workflows.completeness.absent', "No data yet");
		case CompletenessState.Suppressed: return localize('clawdius.workflows.completeness.suppressed', "History suppressed");
		case CompletenessState.UnknownShape: return localize('clawdius.workflows.completeness.unknownShape', "Unrecognized data");
	}
}

// --- ownership-chrome rule -------------------------------------------------------------------------------------

/**
 * The pure predicate the view evaluates ONCE per refresh (never inside a renderer, never a second disk read):
 * every enumerated run resolves `foreign` against the owned-session-id set. An empty run list is vacuously
 * `true`, which is harmless - the view only ever paints the surface label alongside a non-empty tree (see
 * `updateSurfaceOwnershipLabel`).
 */
export function computeUniformlyForeign(runs: readonly WorkflowRun[], ownedSessionIds: ReadonlySet<string>): boolean {
	return runs.every(run => resolveOwnership(run, ownedSessionIds) === 'foreign');
}

/** The mutable, view-owned context every row renderer reads AT RENDER TIME - never recomputed or re-read from
 *  disk by a renderer. The view mutates `uniformlyForeign`/`ownedSessionIds` in place on every refresh(); `badgeOf`
 *  is a stable closure over the view's live badge map. */
export interface IWorkflowRenderContext {
	uniformlyForeign: boolean;
	ownedSessionIds: ReadonlySet<string>;
	badgeOf(runId: string): BadgeSignal | undefined;
	/**
	 * The CURRENT authoritative data for a run, keyed by its stable `identity` - read by the run-row renderer
	 * INSTEAD of its own tree element's `run` field. This indirection exists because the tree's identity-based
	 * `setChildren` diff (used for graduation and for ordinary live-progress refreshes; see `claudeWorkflowsView.ts`)
	 * deliberately leaves an unchanged-identity node's OWN `.element` untouched even when the underlying data
	 * changed - the same reason the live badge feed already reads its state from an external map rather than the
	 * element itself. Returns `undefined` when the view has not (yet) populated this run's identity, in which case
	 * the renderer falls back to its own element's `run`.
	 */
	runOf(identity: string): WorkflowRun | undefined;
	/** Whether `identity` graduated (live -> terminal/unknown-shape) within the last transient highlight window -
	 *  used to paint a brief, reduced-motion-aware visual cue on the row. Always `false` when nothing tracks this
	 *  (e.g. a unit test harness that never calls into the graduation path). */
	justGraduated(identity: string): boolean;
}

// --- tree shape: the 0/1/>1 phase-grouping rule -------------------------------------------------------------

function agentLeaf(run: TerminalWorkflowRun, agent: TerminalWorkflowAgent): ITreeElement<WorkflowTreeElement> {
	return { element: { kind: 'agent', run, agent } };
}

/**
 * Errored-first, STABLE reordering of a group of agents: every `state==='error'` agent before every `state==='done'`
 * one, with each state's own relative order preserved (a `filter` partition, not a comparator-based sort, so
 * stability holds independent of the engine's sort implementation). Applied to every place agents are listed -
 * directly under the run, under a phase, and among the unassigned leftovers - so a run's failure is legible
 * wherever its agents are shown, never just in the one grouping that happened to be built first.
 */
function erroredAgentsFirst(agents: readonly TerminalWorkflowAgent[]): readonly TerminalWorkflowAgent[] {
	return [...agents.filter(agent => agent.state === 'error'), ...agents.filter(agent => agent.state !== 'error')];
}

function phaseNode(run: TerminalWorkflowRun, phase: WorkflowPhase, agents: readonly TerminalWorkflowAgent[], collapsed?: boolean): ITreeElement<WorkflowTreeElement> {
	const node: ITreeElement<WorkflowTreeElement> = {
		element: { kind: 'phase', run, phase },
		children: agents.map(agent => agentLeaf(run, agent)),
	};
	// `collapsed` is left OFF the returned element (not merely `undefined`) for every phase but the one auto-expand
	// singles out - an explicit `collapsed: undefined` would still touch the field; the tree's own default-collapse
	// option must decide for every other phase, untouched.
	return collapsed === undefined ? node : { ...node, collapsed };
}

/**
 * A terminal run's children: ONLY phase/agent rows - grouped under phase nodes only when `phases.length > 1` (the
 * 0/1/>1 rule); no inline leaf of any kind (see the file header comment - the run's summary/result/error are
 * reachable only by opening its detail). An agent that matches no declared phase (a gap the seam already
 * tolerates - see `claudeWorkflowModel.ts`) is never dropped: it still hangs directly under the run, after the
 * phase nodes, rather than silently vanishing from the tree.
 *
 * Two failure-surfacing rules layer on top, applied in both the phase-grouped and the direct-under-run path:
 * agents within any one group are reordered errored-first (`erroredAgentsFirst`, stable), and when the run has
 * more than one phase, the FIRST phase whose `errorCount > 0` (in the manifest's own declared order) renders
 * pre-expanded (`collapsed: false`) so a failure is visible without an extra click - every other phase is left
 * untouched, and a run with no errored phase auto-expands nothing.
 */
export function buildTerminalRunChildren(run: TerminalWorkflowRun): ITreeElement<WorkflowTreeElement>[] {
	if (run.phases.length <= 1) {
		return erroredAgentsFirst(run.agents).map(agent => agentLeaf(run, agent));
	}
	// The SAME first-match assignment the reader uses to derive `phase.agentCount`, so a phase row's count can never
	// contradict the agent rows nested beneath it AND an agent whose title-only membership matches DUPLICATE phase
	// titles is nested ONCE (never two rows with the same identity), not under every same-titled phase.
	const { byPhaseIndex, unassigned } = assignAgentsToPhases(run.agents, run.phases);
	const firstErrorPhaseIndex = run.phases.find(candidate => candidate.errorCount > 0)?.index;
	const phaseNodes = run.phases.map(phase => {
		const agentsInPhase = byPhaseIndex.get(phase.index) ?? [];
		const collapsed = phase.index === firstErrorPhaseIndex ? false : undefined;
		return phaseNode(run, phase, erroredAgentsFirst(agentsInPhase), collapsed);
	});
	return [...phaseNodes, ...erroredAgentsFirst(unassigned).map(agent => agentLeaf(run, agent))];
}

/** One run's full tree element: a terminal run's children per {@link buildTerminalRunChildren}; a live or
 *  unrecognized-shape run has NO children - a live run carries no structured agent/phase list to expand into (see
 *  `LiveWorkflowRun`), and the measured live-progress leaf that used to stand in for one is gone (the file header
 *  comment; every row is now fixed-height). */
export function buildRunElement(run: WorkflowRun): ITreeElement<WorkflowTreeElement> {
	if (run.kind === 'terminal') {
		return { element: { kind: 'run', run }, children: buildTerminalRunChildren(run) };
	}
	return { element: { kind: 'run', run } };
}

/** The whole tree's top-level children, in the seam's own enumeration order (never re-sorted here) - which is
 *  already a deterministic sort by `(sessionId, runId)`, so concurrent live runs hold a stable order by run
 *  identifier for free, with no separate sort step needed here. */
export function buildWorkflowTreeChildren(runs: readonly WorkflowRun[]): ITreeElement<WorkflowTreeElement>[] {
	return runs.map(buildRunElement);
}

// --- graduation-aware reconciliation ----------------------------------------------------------------------------

/** The bookkeeping {@link reconcileWorkflowTree} needs carried from one reconcile to the next. */
export interface WorkflowTreeReconcileState {
	/** runId -> the exact element reference the tree currently tracks for that row. */
	readonly elementByRunId: ReadonlyMap<string, WorkflowTreeElement>;
	/** The identities carrying `kind: 'live'` as of the last reconcile. */
	readonly liveIdentities: ReadonlySet<string>;
	/** runId -> the content signature ({@link computeRunSignature}) that was actually rendered for that run last
	 *  time - lets a run that was ALREADY terminal/unknown-shape before and after this reconcile detect that its
	 *  manifest was rewritten (e.g. `completed` corrected to `failed`, or a tally changed) since it was last drawn,
	 *  and re-render, while a genuinely unchanged run is left untouched (preserving its expansion state). */
	readonly renderedSignatureByRunId: ReadonlyMap<string, string>;
}

export interface WorkflowTreeReconcileResult extends WorkflowTreeReconcileState {
	/** Runs that graduated (were live before, are terminal/unknown-shape now) THIS reconcile - the caller decides
	 *  what to announce; this function performs no side effect beyond the tree mutation itself. */
	readonly graduated: readonly (TerminalWorkflowRun | UnrecognizedWorkflowRun)[];
	/** Every element known to the tree after this reconcile, keyed by its stable id - for a focus/selection
	 *  restore that was captured by id before the call. */
	readonly idToElement: ReadonlyMap<string, WorkflowTreeElement>;
}

/** A stable content signature for one run - changes whenever any field the tree renders for that run (its row,
 *  its phase nodes, or its agent rows) differs. Used only to detect a REWRITTEN terminal/unknown-
 *  shape manifest (e.g. `completed` corrected to `failed`, a changed summary/result, or an agent whose label or
 *  state moved without the tally moving) after that run was already rendered once; see
 *  {@link WorkflowTreeReconcileState.renderedSignatureByRunId}. It hashes the WHOLE render-relevant projection - not
 *  a sample of a few scalars - so a rewrite that touches only `summary`, `defaultModel`, a per-agent field, or the
 *  middle of `resultText` still moves it; hashing (rather than embedding) keeps the stored signature compact even
 *  when `resultText` is large. The stable identity/version fields (`sessionId`/`runId`/`identity`/`adapterVersion`)
 *  are omitted deliberately: they never change for a given run, so including them would only add cost. Computed for
 *  every run kind so the reconcile can always record a fresh signature, even though the live branch never consults
 *  it (a still-live run's row is replaced unconditionally on every reconcile regardless). */
function computeRunSignature(run: WorkflowRun): string {
	const chrome = [run.ownership, run.coverage, run.freshness, run.completeness];
	if (run.kind === 'terminal') {
		return `terminal:${hash([...chrome,
		run.workflowName, run.summary, run.status, run.startTime, run.timestamp, run.durationMs, run.totalTokens,
		run.totalToolCalls, run.agentCount, run.defaultModel, run.resultText, run.resultPreview, run.error,
		run.phases.map(phase => [phase.index, phase.title, phase.detail, phase.agentCount, phase.errorCount]),
		run.agents.map(agent => [agent.agentId, agent.label, agent.state, agent.model, agent.tokens, agent.toolCalls,
		agent.durationMs, agent.phaseTitle, agent.phaseIndex, agent.lastToolName, agent.agentType,
		agent.promptPreview, agent.resultPreview, agent.error, agent.attempt, agent.transcriptRef !== undefined])])}`;
	}
	if (run.kind === 'live') {
		return `live:${hash([...chrome, run.startedCount, run.resultCount, run.seenCount, run.journalLastWriteTime,
		run.degradation, run.landedResults.map(landed => [landed.agentId, landed.preview])])}`;
	}
	return `unknown-shape:${hash(chrome)}`;
}

/**
 * Apply `runs` to `tree`'s top-level children, graduation-aware - the reconciliation `claudeWorkflowsView.ts`'s
 * snapshot handler calls into. `WorkbenchObjectTree.setChildren`'s identity diff (`diffIdentityProvider`) is what
 * gives an unrelated, unchanged run's row its scroll position / expansion / DOM for free, but it comes with a
 * documented cost: it deliberately leaves an UNCHANGED-identity node's own element untouched even when the
 * underlying data differs (`objectTree.ts`'s `setChildren` doc comment; traced against `objectTreeModel.ts`'s
 * `spliceSmart`, which never calls `createTreeNode` for an id the LCS diff finds unchanged). Since a run's identity
 * is the SAME whether it is live or terminal, that one call alone would silently keep painting a graduated run as
 * live forever, and would never repaint a still-live run's own row (last-write time, badges) either.
 *
 * So every run whose identity persists across the reconcile gets a SECOND, TARGETED pass, using the reference the
 * tree ALREADY tracks for it (never a freshly-built duplicate - `setChildren`/`rerender` scoped to an untracked
 * reference throw): a still-live run has no children to touch (see `buildRunElement`) so only its row is
 * `rerender()`ed, every time (cheap - live data changes on every poll); a run that just graduated gets its children
 * replaced with its real phase/agent rows (or none, for an unrecognized shape) and its row `rerender()`ed once. A
 * run that was already terminal/unknown-shape and stays so is compared against its last RENDERED content signature
 * ({@link computeRunSignature}): unchanged, it is left untouched (preserving the user's expansion state); changed
 * - the observation service re-reads on every manifest write, so a terminal manifest CAN legitimately be rewritten
 * after the fact (e.g. a corrected status or tally) - its children are replaced and its row `rerender()`ed exactly
 * like a fresh graduation, just without entering `graduated` (no live -> terminal transition happened here, so no
 * graduation announcement is owed). A brand-new run's INITIAL children are already correct from the first
 * `setChildren` call and need no second pass.
 *
 * The live/terminal representation of one run therefore never coexists as two rows: there is exactly one node per
 * identity throughout (the top-level `setChildren` either keeps the existing node or creates exactly one new node
 * per identity; the second pass only ever re-scopes an ALREADY-tracked node's own children, never adds a sibling).
 *
 * Typed against the plain `ObjectTree` base class (not `WorkbenchObjectTree`, which needs a workbench's worth of
 * injected services) so a test can construct a real tree directly and drive this exact code path.
 */
export function reconcileWorkflowTree(
	tree: ObjectTree<WorkflowTreeElement, FuzzyScore>,
	runs: readonly WorkflowRun[],
	previous: WorkflowTreeReconcileState,
): WorkflowTreeReconcileResult {
	// Only a run that actually HAS children gets the preserve-or-collapse treatment: `ObjectTreeModel.preserveCollapseState`
	// (objectTreeModel.ts) turns `PreserveOrCollapsed` into a literal `collapsed: true` on a brand-new node, which
	// alone is enough to make `indexTreeModel.ts` compute `collapsible: true` for it (`typeof collapsed !== 'undefined'`)
	// - EVEN with zero actual children - painting a twistie that toggles nothing. A live/unknown-shape run (no
	// `children` at all) or a zero-agent terminal run (`children: []`) must therefore be left with NO `collapsed`
	// field, so it stays genuinely non-collapsible (no twistie) instead of gaining an inert one.
	const children: IObjectTreeElement<WorkflowTreeElement>[] = buildWorkflowTreeChildren(runs).map(child =>
		child.element.kind === 'run' && Array.isArray(child.children) && child.children.length > 0
			? { ...child, collapsed: ObjectTreeElementCollapseState.PreserveOrCollapsed }
			: child);
	const builtElementByIdentity = new Map<string, WorkflowTreeElement>();
	for (const child of children) {
		if (child.element.kind === 'run') { builtElementByIdentity.set(child.element.run.identity, child.element); }
	}

	tree.setChildren(null, children, { diffIdentityProvider: new WorkflowTreeIdentityProvider() });

	const previousElementByIdentity = new Map<string, WorkflowTreeElement>();
	for (const element of previous.elementByRunId.values()) {
		previousElementByIdentity.set(element.run.identity, element);
	}

	const elementByRunId = new Map<string, WorkflowTreeElement>();
	const liveIdentities = new Set<string>();
	const renderedSignatureByRunId = new Map<string, string>();
	// Deliberately NOT seeded from `children` here: `children`'s own top-level 'run' elements are FRESHLY built on
	// every call, and for a run whose identity persists across this reconcile the tree keeps its OLD element (the
	// diff subtlety this whole function exists to work around) - seeding straight from `children` would hand a
	// focus/selection restore an untracked reference for exactly that run. Each run-row id is set below from
	// `tracked` instead - the SAME reference `elementByRunId` records for that run.
	const idToElement = new Map<string, WorkflowTreeElement>();
	const graduated: (TerminalWorkflowRun | UnrecognizedWorkflowRun)[] = [];

	for (const run of runs) {
		// The identity diff normally KEEPS the old node for a persisting identity, so its previous element is what the
		// tree tracks. But if the diff ever fell back to a full rebuild (an LCS `quitEarly` on a very large reordering),
		// the old element would be dropped and the freshly-built one tracked instead - so prefer the previous element
		// ONLY while the tree still holds it, else the built one. This keeps `tracked` a reference the tree actually
		// tracks in every case, so the targeted `setChildren(tracked, ...)`/`rerender(tracked)` below can never throw on
		// an untracked reference (parity with the `hasElement` guard the focus/selection restore already applies).
		const previousElement = previousElementByIdentity.get(run.identity);
		const tracked = (previousElement !== undefined && tree.hasElement(previousElement))
			? previousElement
			: builtElementByIdentity.get(run.identity);
		if (!tracked) {
			continue; // unreachable: builtElementByIdentity covers every run in `runs`
		}
		elementByRunId.set(run.runId, tracked);
		idToElement.set(workflowTreeElementId({ kind: 'run', run }), tracked);
		const newSignature = computeRunSignature(run);

		if (run.kind === 'live') {
			liveIdentities.add(run.identity);
			// No children to (re)build for a live run (see `buildRunElement`) - just repaint its own row so its
			// last-write time / live badge stay current on every poll.
			tree.rerender(tracked);
		} else if (previous.liveIdentities.has(run.identity)) {
			graduated.push(run);
			const newChildren = run.kind === 'terminal' ? buildTerminalRunChildren(run) : [];
			tree.setChildren(tracked, newChildren);
			// `setChildren` scoped to an EXISTING node never retroactively recomputes that node's OWN `collapsible`
			// flag (it was fixed at creation time - see the top-level `children.map(...)` fix above for why a
			// childless run must start `collapsible: false`) - a run graduating INTO real children (or, symmetrically,
			// a rewrite that empties them out) needs this explicit call, the same one `AsyncDataTree` uses for the
			// identical reason (abstractTree.ts's `setCollapsible`), or the twistie would stay stuck at whatever it
			// was when this row was first created.
			tree.setCollapsible(tracked, newChildren.length > 0);
			tree.rerender(tracked);
			for (const c of newChildren) { idToElement.set(workflowTreeElementId(c.element), c.element); }
		} else if (previous.renderedSignatureByRunId.has(run.runId) && newSignature !== previous.renderedSignatureByRunId.get(run.runId)) {
			// A run this function has ALREADY rendered before (so a comparison is even meaningful - a brand-new
			// run has no prior signature and needs no second pass, its initial `setChildren` above already built it
			// correctly), still terminal/unknown-shape now, but its rendered content signature moved - a rewritten
			// manifest (see the function doc comment), not a fresh graduation.
			const newChildren = run.kind === 'terminal' ? buildTerminalRunChildren(run) : [];
			tree.setChildren(tracked, newChildren);
			tree.setCollapsible(tracked, newChildren.length > 0); // see the graduation branch's comment above
			tree.rerender(tracked);
			for (const c of newChildren) { idToElement.set(workflowTreeElementId(c.element), c.element); }
		}
		// else: either a brand-new run (its initial children are already correct) or a run this function has
		// rendered before, still terminal/unknown-shape now, and unchanged since - left untouched either way
		// (see the function doc comment).

		renderedSignatureByRunId.set(run.runId, newSignature);
	}

	return { elementByRunId, liveIdentities, renderedSignatureByRunId, graduated, idToElement };
}

/** Resolves a captured focus/selection id set against `idToElement`, keeping only an id that both (a) still
 *  resolves to an element this reconcile knows about and (b) is an element the TREE currently tracks. (b) is a
 *  belt-and-suspenders check: `idToElement`'s own run-row entries are always the TRACKED reference (see
 *  `reconcileWorkflowTree`'s doc comment above), but staying defensive here means a caller can never hand
 *  `setFocus`/`setSelection` an untracked element, whatever future path builds `idToElement`. EXPORTED so
 *  `claudeWorkflowsView.ts`'s focus/selection restore and a test can drive the exact same resolution logic. */
export function resolveTrackedElements(
	ids: ReadonlySet<string>,
	idToElement: ReadonlyMap<string, WorkflowTreeElement>,
	hasElement: (element: WorkflowTreeElement) => boolean,
): WorkflowTreeElement[] {
	const resolved: WorkflowTreeElement[] = [];
	for (const id of ids) {
		const element = idToElement.get(id);
		if (element !== undefined && hasElement(element)) { resolved.push(element); }
	}
	return resolved;
}

// --- accessibility + keyboard nav -------------------------------------------------------------------------

/** The completeness dimension's aria phrase - `undefined` for `Complete` (the silent, expected case; nothing to
 *  say). Exhaustive over {@link CompletenessState} so a future member fails to compile here rather than falling
 *  through silently. */
function describeCompletenessForAria(completeness: CompletenessState): string | undefined {
	switch (completeness) {
		case CompletenessState.Complete: return undefined;
		case CompletenessState.Partial: return localize('clawdius.workflows.run.aria.partial', "partial data");
		case CompletenessState.UnknownShape: return localize('clawdius.workflows.run.aria.unknownData', "unrecognized data");
		case CompletenessState.Absent: return localize('clawdius.workflows.run.aria.noData', "no data yet");
		case CompletenessState.Suppressed: return localize('clawdius.workflows.run.aria.suppressed', "history suppressed");
	}
}

/**
 * The RUN row's status phrase for assistive technology - every piece of status chrome the row paints VISUALLY
 * (the status icon, the errored-count/completeness/live-badge chips) but that those chips alone never speak.
 * Empty for `unknown-shape`: its primary label already reads "Shape not recognized" (see `describeRunRow`), and an
 * unrecognized run carries no errored tally, no badge, and a completeness that says the same thing again - nothing
 * further to add. PURE off the model plus the optional live badge signal, so a unit test drives it without a DOM;
 * reuses the SAME localized strings the visual chips already carry (`erroredCount`, `badge.needsInput`,
 * `badge.completion`) rather than duplicating near-identical text under a second key.
 */
export function describeRunStatusForAria(run: WorkflowRun, badge: BadgeSignal | undefined): string {
	const parts: string[] = [];
	if (run.kind === 'terminal') {
		parts.push(run.status === 'failed'
			? localize('clawdius.workflows.run.aria.failed', "failed")
			: localize('clawdius.workflows.run.aria.completed', "completed"));
		const errored = erroredAgentCount(run);
		if (errored !== undefined && errored > 0) {
			parts.push(localize('clawdius.workflows.run.erroredCount', "{0} errored", errored));
		}
	} else if (run.kind === 'live') {
		parts.push(localize('clawdius.workflows.run.aria.live', "in progress"));
	}
	if (run.kind !== 'unknown-shape') {
		const completenessPhrase = describeCompletenessForAria(run.completeness);
		if (completenessPhrase) {
			parts.push(completenessPhrase);
		}
	}
	if (badge) {
		parts.push(badge.kind === 'needs-input'
			? localize('clawdius.workflows.badge.needsInput', "needs input")
			: localize('clawdius.workflows.badge.completion', "completed"));
	}
	return parts.join(', ');
}

export class WorkflowTreeAccessibilityProvider implements IListAccessibilityProvider<WorkflowTreeElement> {
	/** `context` resolves a RUN node's CURRENT data by identity (`context.runOf`) and its live badge
	 *  (`context.badgeOf`) - the same indirection `WorkflowRunRowRenderer` reads for the exact same reason (see
	 *  `IWorkflowRenderContext.runOf`'s doc comment): a graduation or a rewritten-manifest re-render keeps the
	 *  top-level 'run' tree node's OWN element reference unchanged, so reading `element.run` directly here would
	 *  announce and label the PRE-graduation state to assistive technology even after the row's visible icon/chips
	 *  had already moved on. Only the 'run' kind needs this - a 'phase'/'agent' node's own element is rebuilt fresh
	 *  on every reconcile (see `reconcileWorkflowTree`), never stale. */
	constructor(private readonly context: IWorkflowRenderContext) { }

	getWidgetAriaLabel(): string {
		return localize('clawdius.workflows.tree.aria', "Claude Code Ultracode Workflows");
	}
	getAriaLabel(element: WorkflowTreeElement): string {
		switch (element.kind) {
			case 'run': {
				const run = this.context.runOf(element.run.identity) ?? element.run;
				const content = describeRunRow(run);
				const base = content.secondaryParts.length > 0
					? localize('clawdius.workflows.run.aria', "{0}, {1}", content.primary, content.secondaryParts.join(', '))
					: content.primary;
				const status = describeRunStatusForAria(run, this.context.badgeOf(run.runId));
				return status.length > 0 ? localize('clawdius.workflows.run.aria.withStatus', "{0}. {1}.", base, status) : base;
			}
			case 'phase': {
				const content = describePhase(element.phase);
				return content.errorsLabel
					? localize('clawdius.workflows.phase.aria.withErrors', "Phase {0}: {1}, {2}", element.phase.index + 1, element.phase.title, content.errorsLabel)
					: localize('clawdius.workflows.phase.aria', "Phase {0}: {1}", element.phase.index + 1, element.phase.title);
			}
			case 'agent':
				return localize('clawdius.workflows.agent.aria', "Agent {0}, {1}", element.agent.label, element.agent.state);
		}
	}
}

export class WorkflowTreeKeyboardNavigationLabelProvider implements IKeyboardNavigationLabelProvider<WorkflowTreeElement> {
	getKeyboardNavigationLabel(element: WorkflowTreeElement): string {
		switch (element.kind) {
			case 'run': return describeRunRow(element.run).primary;
			case 'phase': return element.phase.title;
			case 'agent': return element.agent.label;
		}
	}
}

// --- virtual delegate: every row is a FIXED height - there is no measured, variable-height leaf in this tree ----

const FIXED_ROW_HEIGHT = 22;
/** The run row is two lines (name + the compact meta line - see `WorkflowRunRowRenderer`), so it gets its own,
 *  taller fixed height instead of the single-line rows every other kind uses. */
const RUN_ROW_HEIGHT = 40;

export const enum WorkflowTreeTemplateId {
	Run = 'clawdius-workflow-run',
	Phase = 'clawdius-workflow-phase',
	Agent = 'clawdius-workflow-agent',
}

export class WorkflowTreeVirtualDelegate implements IListVirtualDelegate<WorkflowTreeElement> {
	getHeight(element: WorkflowTreeElement): number {
		return element.kind === 'run' ? RUN_ROW_HEIGHT : FIXED_ROW_HEIGHT;
	}

	getTemplateId(element: WorkflowTreeElement): string {
		switch (element.kind) {
			case 'run': return WorkflowTreeTemplateId.Run;
			case 'phase': return WorkflowTreeTemplateId.Phase;
			case 'agent': return WorkflowTreeTemplateId.Agent;
		}
	}
}

// --- run row renderer ------------------------------------------------------------------------------------

interface IWorkflowRunTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly iconLabel: IconLabel;
	readonly meta: HTMLElement;
	readonly badge: HTMLElement;
	readonly erroredChip: HTMLElement;
	readonly completenessChip: HTMLElement;
	readonly ownershipChip: HTMLElement;
}

/**
 * The run row: compact, TWO lines (see the file header comment) - a status codicon +
 * line 1 (an `IconLabel` carrying only the run's summary/runId as its name, ellipsized, plus the exception-only
 * chip row) and line 2 (`meta`, muted, single line - {@link describeRunMetaParts}). Never the run's summary/
 * result/error TEXT beyond the ellipsized name; that is reachable only by opening the run's detail (see
 * `claudeWorkflowsView.ts`'s `onDidOpen`). The ownership rule's exception-only right edge lives in the chip row:
 * the completeness chip is exception-only (shown whenever the run did not read whole, independent of ownership);
 * the ownership chip is exception-only in the OTHER direction (shown only when ownership can differ across the
 * view, i.e. NOT `context.uniformlyForeign` - the common uniformly-foreign case paints no per-run ownership chrome
 * at all, deferring to the view's single surface label). The errored-agent chip is exception-only the same way the
 * completeness chip is: shown only when {@link erroredAgentCount} is defined AND greater than 0 (a `completed`
 * run, or a `failed` run whose agents all happened to end `done`, paints no such chip - it is never fabricated for
 * a run with no agent tally, i.e. live/unknown-shape).
 */
export class WorkflowRunRowRenderer extends Disposable implements ITreeRenderer<WorkflowTreeElement, FuzzyScore, IWorkflowRunTemplate> {
	readonly templateId = WorkflowTreeTemplateId.Run;

	constructor(
		private readonly context: IWorkflowRenderContext,
		private readonly hoverDelegate: IHoverDelegate,
	) {
		super();
	}

	renderTemplate(container: HTMLElement): IWorkflowRunTemplate {
		container.classList.add('clawdius-workflow-run-row');
		const icon = append(container, $('.clawdius-workflow-status-icon'));
		const lines = append(container, $('.clawdius-workflow-run-lines'));
		const titleRow = append(lines, $('.clawdius-workflow-run-title-row'));
		const iconLabel = new IconLabel(titleRow, { hoverDelegate: this.hoverDelegate });
		const chips = append(titleRow, $('.clawdius-workflow-chips'));
		const badge = append(chips, $('.clawdius-workflow-chip.clawdius-workflow-badge'));
		const erroredChip = append(chips, $('.clawdius-workflow-chip.errored-chip'));
		const completenessChip = append(chips, $('.clawdius-workflow-chip.completeness-chip'));
		const ownershipChip = append(chips, $('.clawdius-workflow-chip.ownership-chip'));
		const meta = append(lines, $('.clawdius-workflow-run-meta'));
		return { container, icon, iconLabel, meta, badge, erroredChip, completenessChip, ownershipChip };
	}

	renderElement(node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowRunTemplate): void {
		const element = node.element;
		if (element.kind !== 'run') {
			return;
		}
		// Read the CURRENT data through the context, not the element's own (possibly stale) `run` field - see
		// `IWorkflowRenderContext.runOf`'s doc comment for why a same-identity node's element can go stale (a
		// graduation, or an ordinary live-poll tick) without the tree ever swapping it out.
		const run = this.context.runOf(element.run.identity) ?? element.run;
		template.container.classList.toggle('clawdius-workflow-graduated', this.context.justGraduated(run.identity));
		template.container.setAttribute('data-run-id', run.runId);
		template.container.setAttribute('data-session-id', run.sessionId);
		template.container.setAttribute('data-kind', 'workflow');
		template.container.setAttribute('data-run-kind', run.kind);
		template.container.setAttribute('data-completeness', run.completeness);
		template.container.setAttribute('data-coverage', run.coverage);
		template.container.setAttribute('data-freshness', run.freshness);

		template.icon.className = `clawdius-workflow-status-icon ${ThemeIcon.asClassName(runStatusIcon(run))} ${runStatusClass(run)}`;

		const content = describeRunRow(run);
		template.iconLabel.setLabel(content.primary, undefined, { title: content.primary });
		template.meta.textContent = describeRunMetaParts(run).join('  ·  ');

		const badgeSignal = this.context.badgeOf(run.runId);
		clearNode(template.badge);
		template.badge.className = 'clawdius-workflow-chip clawdius-workflow-badge';
		if (badgeSignal) {
			template.badge.classList.add(`badge-${badgeSignal.kind}`);
			template.badge.textContent = badgeSignal.kind === 'needs-input'
				? localize('clawdius.workflows.badge.needsInput', "needs input")
				: localize('clawdius.workflows.badge.completion', "completed");
			template.badge.setAttribute('data-badge-kind', badgeSignal.kind);
		} else {
			template.badge.removeAttribute('data-badge-kind');
		}

		// Exception-only, the same shape as the completeness chip below: shown only for a run whose agent tally is
		// KNOWN (terminal) and non-zero - never fabricated for a live/unknown-shape run (no tally exists) or painted
		// for a run whose agents all happened to end `done`.
		const errored = erroredAgentCount(run);
		if (errored !== undefined && errored > 0) {
			template.erroredChip.textContent = localize('clawdius.workflows.run.erroredCount', "{0} errored", errored);
			template.erroredChip.style.display = '';
		} else {
			template.erroredChip.textContent = '';
			template.erroredChip.style.display = 'none';
		}

		// Exception-only: shown whenever the run did NOT read whole, independent of ownership. The mapping function
		// itself decides "exception-only" (undefined for Complete) - see describeCompletenessLabel's doc comment.
		const completenessLabel = describeCompletenessLabel(run.completeness);
		if (completenessLabel !== undefined) {
			template.completenessChip.textContent = completenessLabel;
			template.completenessChip.className = `clawdius-workflow-chip completeness-chip completeness-${run.completeness}`;
			template.completenessChip.style.display = '';
		} else {
			template.completenessChip.style.display = 'none';
		}

		// Exception-only in the other direction: shown only when ownership can differ across the view. The raw
		// value still drives the CSS class + `data-ownership-shown` (tests key off it); only the chip's own text
		// goes through the plain-English mapping.
		if (!this.context.uniformlyForeign) {
			const ownership: FleetOwnership = resolveOwnership(run, this.context.ownedSessionIds);
			template.ownershipChip.textContent = describeOwnershipLabel(ownership);
			template.ownershipChip.className = `clawdius-workflow-chip ownership-chip ownership-${ownership}`;
			template.ownershipChip.style.display = '';
			template.container.setAttribute('data-ownership-shown', ownership);
		} else {
			template.ownershipChip.style.display = 'none';
			template.container.setAttribute('data-ownership-shown', 'none');
		}
	}

	disposeTemplate(template: IWorkflowRunTemplate): void {
		template.iconLabel.dispose();
	}
}

// --- phase row renderer ----------------------------------------------------------------------------------

interface IWorkflowPhaseTemplate {
	readonly container: HTMLElement;
	readonly title: HTMLElement;
	readonly detail: HTMLElement;
	readonly counts: HTMLElement;
}

export class WorkflowPhaseRowRenderer implements ITreeRenderer<WorkflowTreeElement, FuzzyScore, IWorkflowPhaseTemplate> {
	readonly templateId = WorkflowTreeTemplateId.Phase;

	renderTemplate(container: HTMLElement): IWorkflowPhaseTemplate {
		container.classList.add('clawdius-workflow-phase-row');
		const title = append(container, $('.clawdius-workflow-phase-title'));
		const detail = append(container, $('.clawdius-workflow-phase-detail'));
		const counts = append(container, $('.clawdius-workflow-phase-counts'));
		return { container, title, detail, counts };
	}

	renderElement(node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowPhaseTemplate): void {
		const element = node.element;
		if (element.kind !== 'phase') {
			return;
		}
		const content = describePhase(element.phase);
		template.title.textContent = content.title;
		template.detail.textContent = content.detail ?? '';
		template.detail.style.display = content.detail ? '' : 'none';
		clearNode(template.counts);
		append(template.counts, $('span.clawdius-workflow-phase-agents', undefined, content.agentsLabel));
		if (content.errorsLabel) {
			append(template.counts, $('span.clawdius-workflow-phase-errors', undefined, content.errorsLabel));
		}
	}

	disposeTemplate(_template: IWorkflowPhaseTemplate): void { }
}

// --- agent row renderer -----------------------------------------------------------------------------------

interface IWorkflowAgentTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly iconLabel: IconLabel;
}

export class WorkflowAgentRowRenderer extends Disposable implements ITreeRenderer<WorkflowTreeElement, FuzzyScore, IWorkflowAgentTemplate> {
	readonly templateId = WorkflowTreeTemplateId.Agent;

	constructor(private readonly hoverDelegate: IHoverDelegate) {
		super();
	}

	renderTemplate(container: HTMLElement): IWorkflowAgentTemplate {
		container.classList.add('clawdius-workflow-agent-row');
		const icon = append(container, $('.clawdius-workflow-agent-icon'));
		const iconLabel = new IconLabel(container, { hoverDelegate: this.hoverDelegate });
		return { container, icon, iconLabel };
	}

	renderElement(node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowAgentTemplate): void {
		const element = node.element;
		if (element.kind !== 'agent') {
			return;
		}
		template.container.setAttribute('data-agent-id', element.agent.agentId);
		template.container.setAttribute('data-agent-state', element.agent.state);
		const content = describeAgent(element.agent);
		template.icon.className = `clawdius-workflow-agent-icon ${ThemeIcon.asClassName(content.icon)} agent-${element.agent.state}`;
		template.iconLabel.setLabel(content.label, content.metricsParts.join('  ·  '));
	}

	disposeTemplate(template: IWorkflowAgentTemplate): void {
		template.iconLabel.dispose();
	}
}

// --- the three distinct display states --------------------------------------------------------------

export type WorkflowsDisplayState =
	| { readonly kind: 'tree'; readonly runs: readonly WorkflowRun[] }
	| { readonly kind: 'empty' }
	| { readonly kind: 'read-error'; readonly message: string }
	| { readonly kind: 'no-match' };

/**
 * Resolve which of the three (or the populated-tree) states the view should show, purely off the seam's envelope
 * plus whether a filter is currently active. `filterActive` distinguishes the two ways a run list can come back
 * empty: nothing was read at all (`empty`) versus runs were read but the active filter matched none of them
 * (`no-match`). The view sets it from the live filter (see `claudeWorkflowsView.ts`), so both are reachable.
 */
export function resolveWorkflowsDisplayState(result: WorkflowRunListResult, filterActive: boolean): WorkflowsDisplayState {
	if (result.state === 'read-error') {
		return { kind: 'read-error', message: result.message };
	}
	if (result.runs.length === 0) {
		return filterActive ? { kind: 'no-match' } : { kind: 'empty' };
	}
	return { kind: 'tree', runs: result.runs };
}

/**
 * Paint one of the three non-tree states into `container` as a message overlay - distinct icon + distinct text per
 * state, so empty / read-error / no-match are visually distinguishable at a glance. The read-error state carries
 * the "Read again" affordance, wired to `onReadAgain` (the same `listWorkflows` RE-ENUMERATION the view already
 * calls on refresh - never a run control).
 */
export function renderWorkflowsStateMessage(container: HTMLElement, state: Exclude<WorkflowsDisplayState, { kind: 'tree' }>, onReadAgain: () => void): IDisposable {
	clearNode(container);
	container.setAttribute('data-clawdius-workflows-state', state.kind);
	const store = new DisposableStore();
	// `ThemeIcon.asClassName` returns a SPACE-separated class list ("codicon codicon-<id>"), which the `$()`
	// tag-selector parser cannot embed inline (it has no notion of a space within one segment) - so the icon's
	// classes are applied via `classList.add` on an already-built element, never interpolated into a `$()` string.
	const appendStateIcon = (icon: ThemeIcon) => {
		const iconEl = append(container, $('.clawdius-workflows-state-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(icon));
	};
	switch (state.kind) {
		case 'empty':
			appendStateIcon(Codicon.inbox);
			append(container, $('.clawdius-workflows-state-text')).textContent =
				localize('clawdius.workflows.empty', "No Claude Code workflow runs found under your Claude config root.");
			break;
		case 'no-match':
			appendStateIcon(Codicon.filter);
			append(container, $('.clawdius-workflows-state-text')).textContent =
				localize('clawdius.workflows.noMatch', "No workflow runs match the current filter.");
			break;
		case 'read-error': {
			appendStateIcon(Codicon.error);
			append(container, $('.clawdius-workflows-state-text')).textContent = state.message.length > 0
				? state.message
				: localize('clawdius.workflows.readError', "Claude Code workflow runs could not be read.");
			const actionContainer = append(container, $('.clawdius-workflows-state-action'));
			const button = store.add(new Button(actionContainer, { ...defaultButtonStyles }));
			button.label = localize('clawdius.workflows.readAgain', "Read Again");
			store.add(button.onDidClick(() => onReadAgain()));
			break;
		}
	}
	return store;
}
// CLAWDIUS-END
