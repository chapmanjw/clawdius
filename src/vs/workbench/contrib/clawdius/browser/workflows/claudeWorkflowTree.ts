/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - WorkbenchObjectTree model + renderers
// Replaces the Workflows view's hand-rolled manual-DOM row list with a real `WorkbenchObjectTree` bound
// directly to the discriminated `WorkflowRun` union (`common/claudeWorkflowModel.ts`) - no more flattening the
// validated model back into the legacy `MissionRun` shape. A run is the tree's top-level row; a TERMINAL run
// expands to a variable-height "story" leaf (summary + cost + result) and its phases/agents (the 0/1/>1
// phase-grouping rule below); a LIVE run expands to its own variable-height "live-progress" leaf (the live
// analogue of the story leaf); an unknown-shape run is a leaf row with no children.
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
import { ProgressBar } from '../../../../../base/browser/ui/progressbar/progressbar.js';
import { ObjectTree } from '../../../../../base/browser/ui/tree/objectTree.js';
import { IObjectTreeElement, ITreeElement, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { hash } from '../../../../../base/common/hash.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { formatTokenCount } from '../../../../../base/common/numbers.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { FleetOwnership } from '../../common/claudeFleetModel.js';
import { CompletenessState } from '../../common/claudeReaderSeam.js';
import {
	assignAgentsToPhases, LiveWorkflowResult, LiveWorkflowRun, TerminalWorkflowAgent, TerminalWorkflowRun, UnrecognizedWorkflowRun,
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

/** The tree's own discriminated element union - one node kind per row shape. A `story`/`phase`/`agent` node always
 *  carries its owning `run` (narrowed to `TerminalWorkflowRun`, the only kind with a manifest to describe) so a
 *  renderer never needs a separate parent lookup. */
export type WorkflowTreeElement =
	| { readonly kind: 'run'; readonly run: WorkflowRun }
	| { readonly kind: 'story'; readonly run: TerminalWorkflowRun }
	| { readonly kind: 'liveProgress'; readonly run: LiveWorkflowRun }
	| { readonly kind: 'phase'; readonly run: TerminalWorkflowRun; readonly phase: WorkflowPhase }
	| { readonly kind: 'agent'; readonly run: TerminalWorkflowRun; readonly agent: TerminalWorkflowAgent };

function isStoryElement(element: WorkflowTreeElement): element is Extract<WorkflowTreeElement, { kind: 'story' }> {
	return element.kind === 'story';
}

function isLiveProgressElement(element: WorkflowTreeElement): element is Extract<WorkflowTreeElement, { kind: 'liveProgress' }> {
	return element.kind === 'liveProgress';
}

/** Either of the two measured, non-twistie leaves: the terminal story leaf and the live-progress leaf both hold
 *  variable-height, multi-line content (a summary/cost/result block; a progress bar plus landed-result previews),
 *  so both share the same "no fixed row height" treatment, keyed by the owning run's identity, instead of the
 *  fixed-height rows every other kind of tree row uses. */
function isMeasuredLeafElement(element: WorkflowTreeElement): element is Extract<WorkflowTreeElement, { kind: 'story' | 'liveProgress' }> {
	return element.kind === 'story' || element.kind === 'liveProgress';
}

// --- identity ----------------------------------------------------------------------------------------------

/** The tree's stable per-element key: `run:<identity>` / `story:<identity>` / `phase:<identity>:<index>` /
 *  `agent:<identity>:<agentId>`, always built off the model's own composite `identity` (never a bare `runId`,
 *  which can collide across sessions). */
export function workflowTreeElementId(element: WorkflowTreeElement): string {
	switch (element.kind) {
		case 'run': return `run:${element.run.identity}`;
		case 'story': return `story:${element.run.identity}`;
		case 'liveProgress': return `liveProgress:${element.run.identity}`;
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

/**
 * The one-line summary of a workflow run's error: its first non-empty line, whitespace-collapsed. A workflow
 * failure arrives as a multi-line stack trace, and only its leading line names the actual fault. PURE, so the
 * clamp is unit-testable without a DOM; the full text stays on the element's tooltip.
 */
export function errorSummary(error: string): string {
	const first = error.split('\n').find(line => line.trim().length > 0) ?? '';
	return first.trim().replace(/\s+/g, ' ');
}

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
			// runId + last-write time. The rich live progress (started/result counts, landed-result previews) is
			// rendered by the live-progress leaf beneath the row (see buildLiveProgressChildren), never fabricated here.
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

/** The story leaf's wrapped-summary text; falls back to an honest "no summary" label rather than an empty node
 *  (a terminal run's `summary` is optional on-disk). */
export function describeStorySummaryText(run: TerminalWorkflowRun): string {
	return run.summary ?? localize('clawdius.workflows.story.noSummary', "No summary recorded");
}

/** The story leaf's cost line, as independent already-localized parts (never string-concatenated into one
 *  translatable string) - the renderer joins them with its own separator DOM nodes. Every missing number is the
 *  literal dash, never a fabricated 0. */
export function describeStoryCostParts(run: TerminalWorkflowRun): readonly string[] {
	return [
		orDash(run.durationMs, formatDuration),
		orDash(run.totalTokens, n => localize('clawdius.workflows.story.tokens', "{0} tokens", formatTokenCount(n))),
		orDash(run.totalToolCalls, n => localize('clawdius.workflows.story.toolCalls', "{0} tool calls", n)),
		run.defaultModel ?? DASH,
		orDash(run.agentCount, n => localize('clawdius.workflows.story.agentCount', "{0} agents", n)),
	];
}

export function describeStoryResultText(run: TerminalWorkflowRun): string {
	return run.resultPreview ?? localize('clawdius.workflows.story.noResult', "No result recorded");
}

/** The run-level failure text (distinct from any per-agent error), clamped to one line with the full text kept
 *  for the tooltip - `undefined` when the run recorded none (most `completed` runs, and even some `failed` ones -
 *  see `TerminalWorkflowRun.error`). */
export function describeStoryError(run: TerminalWorkflowRun): { readonly summary: string; readonly full: string } | undefined {
	return run.error ? { summary: errorSummary(run.error), full: run.error } : undefined;
}

/** The bound on how many landed-result previews the live-progress leaf shows directly - a RENDER bound, not a data
 *  one: {@link LiveProgressContent.landedCountCaption} always states the true total, so a workflow with many agents
 *  never reads as having fewer results than it does, it just stops listing them past this count. */
export const LIVE_PROGRESS_MAX_LANDED_PREVIEWS = 5;

/** The live-progress leaf's content, computed PURELY off the model - unit-testable without a DOM. Honesty rules
 *  `startedCount`/`resultCount` are never clamped against each other, so the ratio can legitimately
 *  move BACKWARD between renders (a newly-started agent raises `startedCount` before it raises `resultCount`); the
 *  caption is phrased "among agents seen so far" because a live run has no known total - a percentage-of-total
 *  would fabricate a denominator that does not exist yet. `activityCaption` reports only the journal's own
 *  last-write time - never an inferred "paused" state, which the journal cannot support. */
export interface LiveProgressContent {
	readonly startedCount: number;
	readonly resultCount: number;
	/** The honest "agents seen so far" denominator - see {@link LiveWorkflowRun.seenCount}. Always >= `resultCount`,
	 *  even when a `started` record was torn or otherwise dropped, so a progress bar built from this and
	 *  `resultCount` can never be handed a `worked` value above its own `total`. */
	readonly seenCount: number;
	/** `max(0, started - result)` - a COUNT, so unlike the ratio caption this is never negative. */
	readonly runningCount: number;
	readonly ratioCaption: string;
	readonly activityCaption: string;
	readonly landedCountCaption: string | undefined;
	readonly landedPreviews: readonly LiveWorkflowResult[];
	/** True when {@link LiveWorkflowResult}s exist beyond what {@link landedPreviews} lists. */
	readonly hasMoreLanded: boolean;
	readonly degradedCaption: string | undefined;
}

export function describeLiveProgress(run: LiveWorkflowRun, relativeTimeOf: (ms: number) => string = ms => fromNow(ms, true)): LiveProgressContent {
	const runningCount = Math.max(0, run.startedCount - run.resultCount);
	const ratioCaption = run.seenCount > 0
		? localize('clawdius.workflows.live.ratio', "{0} of {1} agents seen so far have a result", run.resultCount, run.seenCount)
		: localize('clawdius.workflows.live.noneStarted', "No agents observed yet");
	const activityCaption = localize('clawdius.workflows.live.lastWrite', "Journal last wrote {0}", relativeTimeOf(run.journalLastWriteTime));
	const landedCountCaption = run.landedResults.length > 0
		? localize('clawdius.workflows.live.landedCount', "{0} results landed", run.landedResults.length)
		: undefined;
	const degradedCaption = run.degradation === 'partial'
		? localize('clawdius.workflows.live.degradedPartial', "The journal has an unreadable entry; this may undercount.")
		: run.degradation === 'unknown-shape'
			? localize('clawdius.workflows.live.degradedUnknown', "The journal's shape was not recognized.")
			: undefined;
	return {
		startedCount: run.startedCount, resultCount: run.resultCount, seenCount: run.seenCount, runningCount, ratioCaption, activityCaption,
		landedCountCaption, landedPreviews: run.landedResults.slice(0, LIVE_PROGRESS_MAX_LANDED_PREVIEWS),
		hasMoreLanded: run.landedResults.length > LIVE_PROGRESS_MAX_LANDED_PREVIEWS, degradedCaption,
	};
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
 * A terminal run's children: the story leaf, always first, then its agents - grouped under phase nodes only when
 * `phases.length > 1` (the 0/1/>1 rule). An agent that matches no declared phase (a gap the seam already tolerates -
 * see `claudeWorkflowModel.ts`) is never dropped: it still hangs directly under the run, after the phase nodes,
 * rather than silently vanishing from the tree.
 *
 * Two failure-surfacing rules layer on top, applied in both the phase-grouped and the direct-under-run path:
 * agents within any one group are reordered errored-first (`erroredAgentsFirst`, stable), and when the run has
 * more than one phase, the FIRST phase whose `errorCount > 0` (in the manifest's own declared order) renders
 * pre-expanded (`collapsed: false`) so a failure is visible without an extra click - every other phase is left
 * untouched, and a run with no errored phase auto-expands nothing.
 */
export function buildTerminalRunChildren(run: TerminalWorkflowRun): ITreeElement<WorkflowTreeElement>[] {
	const story: ITreeElement<WorkflowTreeElement> = { element: { kind: 'story', run }, collapsible: false };
	if (run.phases.length <= 1) {
		return [story, ...erroredAgentsFirst(run.agents).map(agent => agentLeaf(run, agent))];
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
	return [story, ...phaseNodes, ...erroredAgentsFirst(unassigned).map(agent => agentLeaf(run, agent))];
}

/** A live run's single child: the measured, non-twistie live-progress leaf (the live analogue of the terminal
 *  story leaf - same variable-height treatment, for the same reason: its progress bar plus landed-result previews
 *  do not fit a fixed row height). Exported so the view can rebuild ONLY this child when a still-live run's counts
 *  advance, without touching the run's own top-level node. */
export function buildLiveProgressChildren(run: LiveWorkflowRun): ITreeElement<WorkflowTreeElement>[] {
	return [{ element: { kind: 'liveProgress', run }, collapsible: false }];
}

/** One run's full tree element: a terminal run's children per {@link buildTerminalRunChildren}, a live run's
 *  single live-progress leaf per {@link buildLiveProgressChildren}, empty for an unrecognized-shape run. */
export function buildRunElement(run: WorkflowRun): ITreeElement<WorkflowTreeElement> {
	if (run.kind === 'terminal') {
		return { element: { kind: 'run', run }, children: buildTerminalRunChildren(run) };
	}
	if (run.kind === 'live') {
		return { element: { kind: 'run', run }, children: buildLiveProgressChildren(run) };
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
 *  its story leaf, its phase nodes, or its agent rows) differs. Used only to detect a REWRITTEN terminal/unknown-
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
 * live forever, and would never advance a still-live run's progress leaf either.
 *
 * So every run whose identity persists across the reconcile gets a SECOND, TARGETED pass, using the reference the
 * tree ALREADY tracks for it (never a freshly-built duplicate - `setChildren`/`rerender` scoped to an untracked
 * reference throw): a still-live run's single progress-leaf child is replaced fresh and its row is `rerender()`ed
 * every time (cheap - live data changes on every poll); a run that just graduated gets its children replaced with
 * its real story/phase/agent rows (or none, for an unrecognized shape) and its row `rerender()`ed once. A run that
 * was already terminal/unknown-shape and stays so is compared against its last RENDERED content signature
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
	const children: IObjectTreeElement<WorkflowTreeElement>[] = buildWorkflowTreeChildren(runs).map(child =>
		child.element.kind === 'run' ? { ...child, collapsed: ObjectTreeElementCollapseState.PreserveOrCollapsed } : child);
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
			const liveChildren = buildLiveProgressChildren(run);
			tree.setChildren(tracked, liveChildren);
			tree.rerender(tracked);
			for (const c of liveChildren) { idToElement.set(workflowTreeElementId(c.element), c.element); }
		} else if (previous.liveIdentities.has(run.identity)) {
			graduated.push(run);
			const newChildren = run.kind === 'terminal' ? buildTerminalRunChildren(run) : [];
			tree.setChildren(tracked, newChildren);
			tree.rerender(tracked);
			for (const c of newChildren) { idToElement.set(workflowTreeElementId(c.element), c.element); }
		} else if (previous.renderedSignatureByRunId.has(run.runId) && newSignature !== previous.renderedSignatureByRunId.get(run.runId)) {
			// A run this function has ALREADY rendered before (so a comparison is even meaningful - a brand-new
			// run has no prior signature and needs no second pass, its initial `setChildren` above already built it
			// correctly), still terminal/unknown-shape now, but its rendered content signature moved - a rewritten
			// manifest (see the function doc comment), not a fresh graduation.
			const newChildren = run.kind === 'terminal' ? buildTerminalRunChildren(run) : [];
			tree.setChildren(tracked, newChildren);
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
	 *  had already moved on. Only the 'run' kind needs this - a 'story'/'liveProgress'/'phase'/'agent' node's own
	 *  element is rebuilt fresh on every reconcile (see `reconcileWorkflowTree`), never stale. */
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
			case 'story':
				return localize('clawdius.workflows.story.aria', "Summary and result for {0}", describeRunRow(element.run).primary);
			case 'liveProgress': {
				const content = describeLiveProgress(element.run);
				return localize('clawdius.workflows.liveProgress.aria', "{0}. {1}", content.ratioCaption, content.activityCaption);
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
			case 'story': return describeStorySummaryText(element.run);
			case 'liveProgress': return describeLiveProgress(element.run).ratioCaption;
			case 'phase': return element.phase.title;
			case 'agent': return element.agent.label;
		}
	}
}

// --- virtual delegate + the story leaf's measured-height cache -----------------------------------------------

const FIXED_ROW_HEIGHT = 22;
/** The minimum story-leaf height, covering its three required lines (summary / cost / result). */
export const STORY_MIN_HEIGHT = 60;

/** Per-run measured story-leaf heights, keyed by the run's composite `identity`. Owned by the view, shared
 *  between the virtual delegate (which reads it for `getHeight`) and the story renderer (which writes it after
 *  measuring the rendered DOM). */
export class WorkflowStoryHeightCache {
	private readonly heights = new Map<string, number>();
	get(identity: string): number | undefined {
		return this.heights.get(identity);
	}
	set(identity: string, height: number): void {
		this.heights.set(identity, height);
	}
	clear(): void {
		this.heights.clear();
	}
}

export const enum WorkflowTreeTemplateId {
	Run = 'clawdius-workflow-run',
	Story = 'clawdius-workflow-story',
	LiveProgress = 'clawdius-workflow-live-progress',
	Phase = 'clawdius-workflow-phase',
	Agent = 'clawdius-workflow-agent',
}

export class WorkflowTreeVirtualDelegate implements IListVirtualDelegate<WorkflowTreeElement> {
	constructor(private readonly storyHeights: WorkflowStoryHeightCache) { }

	getHeight(element: WorkflowTreeElement): number {
		if (isMeasuredLeafElement(element)) {
			return this.storyHeights.get(element.run.identity) ?? STORY_MIN_HEIGHT;
		}
		return FIXED_ROW_HEIGHT;
	}

	getTemplateId(element: WorkflowTreeElement): string {
		switch (element.kind) {
			case 'run': return WorkflowTreeTemplateId.Run;
			case 'story': return WorkflowTreeTemplateId.Story;
			case 'liveProgress': return WorkflowTreeTemplateId.LiveProgress;
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
	readonly badge: HTMLElement;
	readonly erroredChip: HTMLElement;
	readonly completenessChip: HTMLElement;
	readonly ownershipChip: HTMLElement;
}

/**
 * The run row: a status codicon + an `IconLabel` whose primary text is the run's summary (terminal) / runId
 * (live/unknown-shape) and whose description is `workflowName, relative-time`. the ownership rule's exception-only right edge
 * lives here: the completeness chip is exception-only (shown whenever the run did not read whole, independent of
 * ownership); the ownership chip is exception-only in the OTHER direction (shown only when ownership can differ
 * across the view, i.e. NOT `context.uniformlyForeign` - the common uniformly-foreign case paints no per-run
 * ownership chrome at all, deferring to the view's single surface label). The errored-agent chip is exception-only
 * the same way the completeness chip is: shown only when {@link erroredAgentCount} is defined AND greater than 0
 * (a `completed` run, or a `failed` run whose agents all happened to end `done`, paints no such chip - it is never
 * fabricated for a run with no agent tally, i.e. live/unknown-shape).
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
		const iconLabel = new IconLabel(container, { hoverDelegate: this.hoverDelegate });
		const chips = append(iconLabel.element, $('.clawdius-workflow-chips'));
		const badge = append(chips, $('.clawdius-workflow-chip.clawdius-workflow-badge'));
		const erroredChip = append(chips, $('.clawdius-workflow-chip.errored-chip'));
		const completenessChip = append(chips, $('.clawdius-workflow-chip.completeness-chip'));
		const ownershipChip = append(chips, $('.clawdius-workflow-chip.ownership-chip'));
		return { container, icon, iconLabel, badge, erroredChip, completenessChip, ownershipChip };
	}

	renderElement(node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowRunTemplate): void {
		const element = node.element;
		if (element.kind !== 'run') {
			return;
		}
		// Read the CURRENT data through the context, not the element's own (possibly stale) `run` field - see
		// `IWorkflowRenderContext.runOf`'s doc comment for why a same-identity node's element can go stale (a
		// graduation, or an ordinary live-progress tick) without the tree ever swapping it out.
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
		template.iconLabel.setLabel(content.primary, content.secondaryParts.join('  ·  '), { title: content.primary });

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

		// Exception-only: shown whenever the run did NOT read whole, independent of ownership.
		if (run.completeness !== CompletenessState.Complete) {
			template.completenessChip.textContent = run.completeness;
			template.completenessChip.className = `clawdius-workflow-chip completeness-chip completeness-${run.completeness}`;
			template.completenessChip.style.display = '';
		} else {
			template.completenessChip.style.display = 'none';
		}

		// Exception-only in the other direction: shown only when ownership can differ across the view.
		if (!this.context.uniformlyForeign) {
			const ownership: FleetOwnership = resolveOwnership(run, this.context.ownedSessionIds);
			template.ownershipChip.textContent = ownership;
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

// --- terminal story-leaf renderer (measured, variable height) ------------------------------------------

interface IWorkflowStoryTemplate {
	readonly container: HTMLElement;
	readonly summary: HTMLElement;
	readonly cost: HTMLElement;
	readonly result: HTMLElement;
	readonly error: HTMLElement;
	element: Extract<WorkflowTreeElement, { kind: 'story' }> | undefined;
}

export interface IWorkflowStoryHeightChange {
	readonly element: WorkflowTreeElement;
	readonly height: number;
}

/**
 * The story leaf: `collapsible:false`, no children (see `buildTerminalRunChildren`) - a true keyboard-focusable
 * leaf with no twistie. After every render it measures its OWN rendered content height and, when the integer
 * height changed, caches it and fires {@link onDidChangeItemHeight} so the owning view can call
 * `tree.updateElementHeight` (guarded there by `tree.hasElement`). `remeasureAll` re-measures every currently
 * RENDERED (visible) leaf - a virtualized-out leaf has no live DOM to remeasure; it gets a fresh measurement the
 * next time it scrolls into view and `renderElement` runs again, which is why the view only needs to call this on
 * a width change (see `claudeWorkflowsView.ts`'s layoutBody), never for the full known run list.
 */
export class WorkflowStoryLeafRenderer extends Disposable implements ITreeRenderer<WorkflowTreeElement, FuzzyScore, IWorkflowStoryTemplate> {
	readonly templateId = WorkflowTreeTemplateId.Story;

	private readonly _onDidChangeItemHeight = this._register(new Emitter<IWorkflowStoryHeightChange>());
	readonly onDidChangeItemHeight: Event<IWorkflowStoryHeightChange> = this._onDidChangeItemHeight.event;

	private readonly liveTemplates = new Set<IWorkflowStoryTemplate>();

	constructor(private readonly heights: WorkflowStoryHeightCache) {
		super();
	}

	renderTemplate(container: HTMLElement): IWorkflowStoryTemplate {
		container.classList.add('clawdius-workflow-story');
		const summary = append(container, $('.clawdius-workflow-story-summary'));
		const cost = append(container, $('.clawdius-workflow-story-cost'));
		const result = append(container, $('.clawdius-workflow-story-result'));
		const error = append(container, $('.clawdius-workflow-story-error'));
		return { container, summary, cost, result, error, element: undefined };
	}

	renderElement(node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowStoryTemplate): void {
		const element = node.element;
		if (!isStoryElement(element)) {
			return;
		}
		template.element = element;
		const run = element.run;
		template.summary.textContent = describeStorySummaryText(run);

		clearNode(template.cost);
		for (const part of describeStoryCostParts(run)) {
			if (template.cost.childElementCount > 0) {
				append(template.cost, $('span.clawdius-workflow-story-sep', undefined, '·'));
			}
			append(template.cost, $('span', undefined, part));
		}

		template.result.textContent = describeStoryResultText(run);

		const errorInfo = describeStoryError(run);
		if (errorInfo) {
			template.error.textContent = errorInfo.summary;
			template.error.title = errorInfo.full;
			template.error.style.display = '';
		} else {
			template.error.textContent = '';
			template.error.removeAttribute('title');
			template.error.style.display = 'none';
		}

		this.liveTemplates.add(template);
		this.measure(template);
	}

	disposeElement(_node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowStoryTemplate): void {
		this.liveTemplates.delete(template);
		template.element = undefined;
	}

	disposeTemplate(_template: IWorkflowStoryTemplate): void { }

	/** Re-measure every currently-rendered story leaf (see the class doc for why this covers exactly what a width
	 *  change needs to invalidate). */
	remeasureAll(): void {
		for (const template of this.liveTemplates) {
			this.measure(template);
		}
	}

	private measure(template: IWorkflowStoryTemplate): void {
		const element = template.element;
		if (!element) {
			return;
		}
		const measured = Math.max(STORY_MIN_HEIGHT, Math.round(template.container.scrollHeight));
		const identity = element.run.identity;
		if (this.heights.get(identity) === measured) {
			return;
		}
		this.heights.set(identity, measured);
		this._onDidChangeItemHeight.fire({ element, height: measured });
	}
}

// --- live-progress leaf renderer (measured, variable height) --------------------------------------------------

interface IWorkflowLiveProgressTemplate {
	readonly container: HTMLElement;
	readonly progressBar: ProgressBar;
	readonly ratio: HTMLElement;
	readonly running: HTMLElement;
	readonly activity: HTMLElement;
	readonly degraded: HTMLElement;
	readonly landedCount: HTMLElement;
	readonly landedList: HTMLElement;
	element: Extract<WorkflowTreeElement, { kind: 'liveProgress' }> | undefined;
}

/**
 * The live-progress leaf: the live analogue of {@link WorkflowStoryLeafRenderer} - `collapsible: false`, no
 * children, measured after every render exactly the same way (see that class's doc for why this is a true leaf
 * rather than a nested-scroll region). Shows a `ProgressBar` against agents SEEN so far ({@link LiveWorkflowRun.seenCount},
 * never a fixed total a live run does not have - `seenCount` is itself observed, not declared), the running count,
 * the journal's own last-write activity text, and up to
 * {@link LIVE_PROGRESS_MAX_LANDED_PREVIEWS} landed-result previews. The `ProgressBar` is created once per
 * template (reused across row recycles, exactly like the run/agent rows' `IconLabel`) and disposed in
 * `disposeTemplate` - never leaked, never recreated per render.
 */
export class WorkflowLiveProgressRenderer extends Disposable implements ITreeRenderer<WorkflowTreeElement, FuzzyScore, IWorkflowLiveProgressTemplate> {
	readonly templateId = WorkflowTreeTemplateId.LiveProgress;

	private readonly _onDidChangeItemHeight = this._register(new Emitter<IWorkflowStoryHeightChange>());
	readonly onDidChangeItemHeight: Event<IWorkflowStoryHeightChange> = this._onDidChangeItemHeight.event;

	private readonly liveTemplates = new Set<IWorkflowLiveProgressTemplate>();

	constructor(private readonly heights: WorkflowStoryHeightCache) {
		super();
	}

	renderTemplate(container: HTMLElement): IWorkflowLiveProgressTemplate {
		container.classList.add('clawdius-workflow-live-progress');
		const progressBar = new ProgressBar(container, defaultProgressBarStyles);
		const ratio = append(container, $('.clawdius-workflow-live-ratio'));
		const running = append(container, $('.clawdius-workflow-live-running'));
		const activity = append(container, $('.clawdius-workflow-live-activity'));
		const degraded = append(container, $('.clawdius-workflow-live-degraded'));
		const landedCount = append(container, $('.clawdius-workflow-live-landed-count'));
		const landedList = append(container, $('.clawdius-workflow-live-landed-list'));
		return { container, progressBar, ratio, running, activity, degraded, landedCount, landedList, element: undefined };
	}

	renderElement(node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowLiveProgressTemplate): void {
		const element = node.element;
		if (!isLiveProgressElement(element)) {
			return;
		}
		template.element = element;
		const content = describeLiveProgress(element.run);

		if (content.seenCount > 0) {
			// `seenCount` (the union of started/result agent ids - never just `startedCount`) is the total: using
			// `startedCount` here could paint `worked` (resultCount) ABOVE `total` whenever a result's own `started`
			// record was torn or otherwise dropped, an invalid `aria-valuenow` > `aria-valuemax` state.
			template.progressBar.total(content.seenCount);
			// `ProgressBar.setWorked` floors its argument to a minimum of 1 (base/browser/ui/progressbar), so calling
			// it with a genuine 0 would misleadingly paint ONE unit of progress before anything has landed - leave the
			// bar at its freshly-`total()`-reset zero state instead of coercing an honest zero into a fabricated one.
			if (content.resultCount > 0) {
				template.progressBar.setWorked(content.resultCount);
			}
		} else {
			template.progressBar.infinite();
		}

		template.ratio.textContent = content.ratioCaption;
		template.running.textContent = content.runningCount > 0
			? localize('clawdius.workflows.live.running', "{0} still running", content.runningCount)
			: '';
		template.running.style.display = content.runningCount > 0 ? '' : 'none';
		template.activity.textContent = content.activityCaption;

		template.degraded.textContent = content.degradedCaption ?? '';
		template.degraded.style.display = content.degradedCaption ? '' : 'none';

		template.landedCount.textContent = content.landedCountCaption ?? '';
		template.landedCount.style.display = content.landedCountCaption ? '' : 'none';

		clearNode(template.landedList);
		for (const landed of content.landedPreviews) {
			append(template.landedList, $('.clawdius-workflow-live-landed-item', undefined, landed.preview));
		}
		if (content.hasMoreLanded) {
			append(template.landedList, $('.clawdius-workflow-live-landed-more', undefined,
				localize('clawdius.workflows.live.moreLanded', "More results have landed than shown here.")));
		}

		this.liveTemplates.add(template);
		this.measure(template);
	}

	disposeElement(_node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowLiveProgressTemplate): void {
		this.liveTemplates.delete(template);
		template.element = undefined;
	}

	disposeTemplate(template: IWorkflowLiveProgressTemplate): void {
		template.progressBar.dispose();
	}

	/** Re-measure every currently-rendered live-progress leaf - the same width-change hook `WorkflowStoryLeafRenderer`
	 *  exposes, called from the view's `layoutBody` alongside it. */
	remeasureAll(): void {
		for (const template of this.liveTemplates) {
			this.measure(template);
		}
	}

	private measure(template: IWorkflowLiveProgressTemplate): void {
		const element = template.element;
		if (!element) {
			return;
		}
		const measured = Math.max(STORY_MIN_HEIGHT, Math.round(template.container.scrollHeight));
		const identity = element.run.identity;
		if (this.heights.get(identity) === measured) {
			return;
		}
		this.heights.set(identity, measured);
		this._onDidChangeItemHeight.fire({ element, height: measured });
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
 * plus whether a filter is currently active. `filterActive` is threaded through now (the state +
 * wiring to exist) even though nothing yet sets it true - the filter itself is a later change; until then this
 * always resolves `empty` on a genuinely empty read, never `no-match`.
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
