/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - WorkbenchObjectTree model + renderers
// Replaces the Workflows view's hand-rolled manual-DOM row list with a real `WorkbenchObjectTree` bound
// directly to the discriminated `WorkflowRun` union (`common/claudeWorkflowModel.ts`) - no more flattening the
// validated model back into the legacy `MissionRun` shape. A run is the tree's top-level row; a TERMINAL run
// additionally expands to a variable-height "story" leaf (summary + cost + result) and its phases/agents (the
// 0/1/>1 phase-grouping rule below); a LIVE or unknown-shape run is a leaf row with no children (a rich live
// leaf and failure-aware auto-expand are later changes - see the overview in claudeWorkflowsView.ts).
//
// The ownership-chrome rule lives in two places by design: `computeUniformlyForeign` is the pure
// predicate the VIEW evaluates once per refresh (never per-row - it must never re-read disk from inside a
// renderer), and the run-row renderer reads the already-computed signal off a small mutable `IWorkflowRenderContext`
// the view owns and updates in place. The SURFACE label (one line above the tree, shown only while every run is
// foreign) is painted by the view itself, not by any renderer - see `updateSurfaceOwnershipLabel` in
// claudeWorkflowsView.ts.

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { IconLabel } from '../../../../../base/browser/ui/iconLabel/iconLabel.js';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { ITreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { formatTokenCount } from '../../../../../base/common/numbers.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { FleetOwnership } from '../../common/claudeFleetModel.js';
import { CompletenessState } from '../../common/claudeReaderSeam.js';
import {
	agentInPhase, TerminalWorkflowAgent, TerminalWorkflowRun, WorkflowPhase, WorkflowRun, WorkflowRunListResult,
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
	| { readonly kind: 'phase'; readonly run: TerminalWorkflowRun; readonly phase: WorkflowPhase }
	| { readonly kind: 'agent'; readonly run: TerminalWorkflowRun; readonly agent: TerminalWorkflowAgent };

function isStoryElement(element: WorkflowTreeElement): element is Extract<WorkflowTreeElement, { kind: 'story' }> {
	return element.kind === 'story';
}

// --- identity ----------------------------------------------------------------------------------------------

/** The tree's stable per-element key: `run:<identity>` / `story:<identity>` / `phase:<identity>:<index>` /
 *  `agent:<identity>:<agentId>`, always built off the model's own composite `identity` (never a bare `runId`,
 *  which can collide across sessions). */
export function workflowTreeElementId(element: WorkflowTreeElement): string {
	switch (element.kind) {
		case 'run': return `run:${element.run.identity}`;
		case 'story': return `story:${element.run.identity}`;
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
			// Honest minimal: NO name/summary exists for a live run (see claudeWorkflowModel.ts). Rich live
			// rendering (started/result counts, landed-result previews) is a later change.
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
}

// --- tree shape: the 0/1/>1 phase-grouping rule -------------------------------------------------------------

function agentLeaf(run: TerminalWorkflowRun, agent: TerminalWorkflowAgent): ITreeElement<WorkflowTreeElement> {
	return { element: { kind: 'agent', run, agent } };
}

function phaseNode(run: TerminalWorkflowRun, phase: WorkflowPhase, agents: readonly TerminalWorkflowAgent[]): ITreeElement<WorkflowTreeElement> {
	return {
		element: { kind: 'phase', run, phase },
		children: agents.map(agent => agentLeaf(run, agent)),
	};
}

/**
 * A terminal run's children: the story leaf, always first, then its agents - grouped under phase nodes only when
 * `phases.length > 1` (the 0/1/>1 rule). An agent that matches no declared phase (a gap the seam already tolerates -
 * see `claudeWorkflowModel.ts`) is never dropped: it still hangs directly under the run, after the phase nodes,
 * rather than silently vanishing from the tree.
 */
export function buildTerminalRunChildren(run: TerminalWorkflowRun): ITreeElement<WorkflowTreeElement>[] {
	const story: ITreeElement<WorkflowTreeElement> = { element: { kind: 'story', run }, collapsible: false };
	if (run.phases.length <= 1) {
		return [story, ...run.agents.map(agent => agentLeaf(run, agent))];
	}
	const assigned = new Set<string>();
	const phaseNodes = run.phases.map(phase => {
		const agentsInPhase = run.agents.filter(agent => {
			// The SAME phase-membership predicate the reader uses to derive `phase.agentCount`, so a phase row's count
			// can never contradict the agent rows nested beneath it.
			const matches = agentInPhase(agent, phase);
			if (matches) {
				assigned.add(agent.agentId);
			}
			return matches;
		});
		return phaseNode(run, phase, agentsInPhase);
	});
	const unassigned = run.agents.filter(agent => !assigned.has(agent.agentId));
	return [story, ...phaseNodes, ...unassigned.map(agent => agentLeaf(run, agent))];
}

/** One run's full tree element (its children per {@link buildTerminalRunChildren}, empty for a live/unknown-shape
 *  run - a rich live leaf is a later change, so a live run is a leaf row here). */
export function buildRunElement(run: WorkflowRun): ITreeElement<WorkflowTreeElement> {
	if (run.kind !== 'terminal') {
		return { element: { kind: 'run', run } };
	}
	return { element: { kind: 'run', run }, children: buildTerminalRunChildren(run) };
}

/** The whole tree's top-level children, in the seam's own enumeration order (never re-sorted here). */
export function buildWorkflowTreeChildren(runs: readonly WorkflowRun[]): ITreeElement<WorkflowTreeElement>[] {
	return runs.map(buildRunElement);
}

// --- accessibility + keyboard nav -------------------------------------------------------------------------

export class WorkflowTreeAccessibilityProvider implements IListAccessibilityProvider<WorkflowTreeElement> {
	getWidgetAriaLabel(): string {
		return localize('clawdius.workflows.tree.aria', "Claude Code Ultracode Workflows");
	}
	getAriaLabel(element: WorkflowTreeElement): string {
		switch (element.kind) {
			case 'run': {
				const content = describeRunRow(element.run);
				return content.secondaryParts.length > 0
					? localize('clawdius.workflows.run.aria', "{0}, {1}", content.primary, content.secondaryParts.join(', '))
					: content.primary;
			}
			case 'story':
				return localize('clawdius.workflows.story.aria', "Summary and result for {0}", describeRunRow(element.run).primary);
			case 'phase':
				return localize('clawdius.workflows.phase.aria', "Phase {0}: {1}", element.phase.index + 1, element.phase.title);
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
	Phase = 'clawdius-workflow-phase',
	Agent = 'clawdius-workflow-agent',
}

export class WorkflowTreeVirtualDelegate implements IListVirtualDelegate<WorkflowTreeElement> {
	constructor(private readonly storyHeights: WorkflowStoryHeightCache) { }

	getHeight(element: WorkflowTreeElement): number {
		if (isStoryElement(element)) {
			return this.storyHeights.get(element.run.identity) ?? STORY_MIN_HEIGHT;
		}
		return FIXED_ROW_HEIGHT;
	}

	getTemplateId(element: WorkflowTreeElement): string {
		switch (element.kind) {
			case 'run': return WorkflowTreeTemplateId.Run;
			case 'story': return WorkflowTreeTemplateId.Story;
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
	readonly completenessChip: HTMLElement;
	readonly ownershipChip: HTMLElement;
}

/**
 * The run row: a status codicon + an `IconLabel` whose primary text is the run's summary (terminal) / runId
 * (live/unknown-shape) and whose description is `workflowName, relative-time`. the ownership rule's exception-only right edge
 * lives here: the completeness chip is exception-only (shown whenever the run did not read whole, independent of
 * ownership); the ownership chip is exception-only in the OTHER direction (shown only when ownership can differ
 * across the view, i.e. NOT `context.uniformlyForeign` - the common uniformly-foreign case paints no per-run
 * ownership chrome at all, deferring to the view's single surface label).
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
		const completenessChip = append(chips, $('.clawdius-workflow-chip.completeness-chip'));
		const ownershipChip = append(chips, $('.clawdius-workflow-chip.ownership-chip'));
		return { container, icon, iconLabel, badge, completenessChip, ownershipChip };
	}

	renderElement(node: ITreeNode<WorkflowTreeElement, FuzzyScore>, _index: number, template: IWorkflowRunTemplate): void {
		const element = node.element;
		if (element.kind !== 'run') {
			return;
		}
		const run = element.run;
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
