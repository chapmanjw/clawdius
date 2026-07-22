/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - tree model + renderer tests
// The WorkbenchObjectTree replacement for the manual-DOM row list: the discriminated tree-element union, the
// 0/1/>1 phase-grouping rule, the fixed-height compact rows (no inline story/live-progress leaf - see
// claudeWorkflowTree.ts's file header comment), the ownership-chrome split, and the three distinct
// empty/read-error/no-match states. Renderer tests assert through the DOM the renderer actually produces
// (querySelector), not through exported-for-test-only template internals - the same posture
// `claudeWorkflowTranscriptEditor.test.ts` takes with its pure `renderTranscriptSlice` helper.

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { IHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { ITreeNode } from '../../../../../base/browser/ui/tree/tree.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';
import {
	LiveWorkflowRun, TerminalWorkflowAgent, TerminalWorkflowRun, UnrecognizedWorkflowRun, WorkflowPhase, WorkflowRun,
	WorkflowRunListResult, workflowRunIdentity,
} from '../../common/claudeWorkflowModel.js';
import { BadgeSignal } from '../../browser/workflows/claudeWorkflowBadges.js';
import {
	buildRunElement, buildTerminalRunChildren, buildWorkflowTreeChildren, computeUniformlyForeign, describeAgent,
	describeCompletenessLabel, describeCoverageLabel, describeFreshnessLabel, describeOwnershipLabel,
	describePhase, describeRunMetaParts, describeRunRow, describeRunStatusForAria, erroredAgentCount, IWorkflowRenderContext,
	renderWorkflowsStateMessage, resolveWorkflowsDisplayState, runStatusClass, WorkflowAgentRowRenderer,
	WorkflowPhaseRowRenderer, WorkflowRunRowRenderer, WorkflowsDisplayState,
	WorkflowTreeAccessibilityProvider, WorkflowTreeElement,
	WorkflowTreeIdentityProvider, WorkflowTreeVirtualDelegate, workflowTreeElementId,
} from '../../browser/workflows/claudeWorkflowTree.js';
import {
	matchesWorkflowFilter, matchesWorkflowStatusFilter, sortWorkflowRuns, WorkflowSortMode, WorkflowStatusFilter,
} from '../../browser/workflows/claudeWorkflowsView.js';

/** A default, inert {@link IWorkflowRenderContext} for a test that does not care about ownership/badges/staleness -
 *  `runOf` always falls through to the tree element's own `run` (never resolves a fresher one), matching every
 *  OTHER context literal already used throughout this file. */
function fakeContext(overrides: Partial<IWorkflowRenderContext> = {}): IWorkflowRenderContext {
	return {
		uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined,
		runOf: () => undefined, justGraduated: () => false,
		...overrides,
	};
}

const IDENTITY_BASE = {
	ownership: 'foreign' as const, coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled,
	completeness: CompletenessState.Complete, adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
};

function terminalRun(overrides: Partial<TerminalWorkflowRun> = {}): TerminalWorkflowRun {
	// `identity` is derived from the (possibly overridden) sessionId/runId FIRST, then `...overrides` still wins if
	// a caller ever needs to override `identity` itself directly (e.g. a heuristic-trap fixture) - so a test that
	// overrides only `runId` gets the matching identity for free, instead of silently keeping the default's.
	const sessionId = overrides.sessionId ?? 's1';
	const runId = overrides.runId ?? 'wf_a';
	return {
		kind: 'terminal', sessionId, runId, identity: workflowRunIdentity(sessionId, runId),
		...IDENTITY_BASE, status: 'completed', phases: [], agents: [],
		...overrides,
	};
}

function liveRun(overrides: Partial<LiveWorkflowRun> = {}): LiveWorkflowRun {
	const sessionId = overrides.sessionId ?? 's1';
	const runId = overrides.runId ?? 'wf_b';
	return {
		kind: 'live', sessionId, runId, identity: workflowRunIdentity(sessionId, runId),
		...IDENTITY_BASE, freshness: FreshnessLabel.Live,
		startedCount: 1, resultCount: 0, seenCount: 1, landedResults: [], journalLastWriteTime: 1_700_000_000_000,
		...overrides,
	};
}

function unknownRun(overrides: Partial<UnrecognizedWorkflowRun> = {}): UnrecognizedWorkflowRun {
	const sessionId = overrides.sessionId ?? 's1';
	const runId = overrides.runId ?? 'wf_c';
	return {
		kind: 'unknown-shape', sessionId, runId, identity: workflowRunIdentity(sessionId, runId),
		ownership: 'foreign', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled,
		completeness: CompletenessState.UnknownShape, adapterVersion: { format: 'transcript-jsonl', versionKey: 'unknown-shape' },
		...overrides,
	};
}

function agent(overrides: Partial<TerminalWorkflowAgent> = {}): TerminalWorkflowAgent {
	return { agentId: 'a1', label: 'agent-1', state: 'done', ...overrides };
}

function phase(overrides: Partial<WorkflowPhase> = {}): WorkflowPhase {
	return { index: 0, title: 'Phase', agentCount: 0, errorCount: 0, ...overrides };
}

function fakeNode(element: WorkflowTreeElement): ITreeNode<WorkflowTreeElement, FuzzyScore> {
	return { element, children: [], depth: 0, visibleChildrenCount: 0, visibleChildIndex: -1, collapsible: false, collapsed: false, visible: true, filterData: undefined };
}

const fakeHoverDelegate: IHoverDelegate = { showHover: () => undefined, delay: 0 };

/** Renders one run row to a detached container via the real renderer + template lifecycle, for assertions against
 *  the actual DOM the renderer produces (shared by the ownership-chrome suite and the failure-surfacing suite
 *  below, rather than duplicated per suite). */
function renderRunRow(context: IWorkflowRenderContext, run: WorkflowRun): HTMLElement {
	const renderer = new WorkflowRunRowRenderer(context, fakeHoverDelegate);
	const container = $('div');
	const template = renderer.renderTemplate(container);
	renderer.renderElement(fakeNode({ kind: 'run', run }), 0, template);
	// `renderTemplate` created an `IconLabel`, a disposable NOT owned by the renderer itself (the real tree owns
	// each template's lifetime independently and calls `disposeTemplate` when it recycles/discards a row) - so a
	// direct-render test must dispose the template itself, not just the renderer.
	renderer.disposeTemplate(template);
	renderer.dispose();
	return container;
}

suite('Clawdius Claude Code Ultracode Workflows - tree identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('workflowTreeElementId is stable per kind and keyed off the composite identity, never a bare runId', () => {
		const run = terminalRun();
		assert.deepStrictEqual([
			workflowTreeElementId({ kind: 'run', run }),
			workflowTreeElementId({ kind: 'phase', run, phase: phase({ index: 2 }) }),
			workflowTreeElementId({ kind: 'agent', run, agent: agent({ agentId: 'a9' }) }),
		], [
			`run:${run.identity}`, `phase:${run.identity}:2`, `agent:${run.identity}:a9`,
		]);
	});

	test('WorkflowTreeIdentityProvider delegates to workflowTreeElementId', () => {
		const run = terminalRun();
		const provider = new WorkflowTreeIdentityProvider();
		assert.strictEqual(provider.getId({ kind: 'run', run }).toString(), `run:${run.identity}`);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - run row content', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('a terminal run: primary is summary, falling back to workflowName then runId', () => {
		const withSummary = describeRunRow(terminalRun({ summary: 'Audited the fleet module.', workflowName: 'audit-fleet' }));
		const noSummary = describeRunRow(terminalRun({ summary: undefined, workflowName: 'audit-fleet' }));
		const bareRun = describeRunRow(terminalRun({ summary: undefined, workflowName: undefined, runId: 'wf_bare' }));
		assert.deepStrictEqual([withSummary.primary, noSummary.primary, bareRun.primary], ['Audited the fleet module.', 'audit-fleet', 'wf_bare']);
	});

	test('a terminal run: secondary carries workflowName + the relative time, in that order, when both present', () => {
		const content = describeRunRow(
			terminalRun({ workflowName: 'audit-fleet', timestamp: 1000 }),
			ms => `${ms}ms-ago`,
		);
		assert.deepStrictEqual(content.secondaryParts, ['audit-fleet', '1000ms-ago']);
	});

	test('a terminal run with neither workflowName nor a timestamp has no secondary parts', () => {
		const content = describeRunRow(terminalRun({ workflowName: undefined, timestamp: undefined, startTime: undefined }));
		assert.deepStrictEqual(content.secondaryParts, []);
	});

	test('startTime is the fallback timestamp source when timestamp is absent', () => {
		const content = describeRunRow(terminalRun({ workflowName: undefined, timestamp: undefined, startTime: 500 }), ms => `t${ms}`);
		assert.deepStrictEqual(content.secondaryParts, ['t500']);
	});

	test('a live run is honest-minimal: runId as primary, journalLastWriteTime as its only secondary part', () => {
		const content = describeRunRow(liveRun({ runId: 'wf_live' }), ms => `t${ms}`);
		assert.deepStrictEqual(content, { primary: 'wf_live', secondaryParts: ['t1700000000000'] });
	});

	test('an unknown-shape run reads as a warning, never guessed into a name', () => {
		const content = describeRunRow(unknownRun({ runId: 'wf_weird' }));
		assert.deepStrictEqual(content, { primary: 'Shape not recognized', secondaryParts: ['wf_weird'] });
	});

	test('runStatusClass distinguishes completed/failed/live/unknown - not just terminal vs non-terminal', () => {
		assert.deepStrictEqual([
			runStatusClass(terminalRun({ status: 'completed' })),
			runStatusClass(terminalRun({ status: 'failed' })),
			runStatusClass(liveRun()),
			runStatusClass(unknownRun()),
		], ['status-completed', 'status-failed', 'status-live', 'status-unknown']);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - run row meta line (compact, line 2)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('a terminal run: model, tokens, duration, agent count, in that order - every missing number is the dash literal, never a fabricated 0', () => {
		const missing = terminalRun({ durationMs: undefined, totalTokens: undefined, defaultModel: undefined, agentCount: undefined });
		assert.deepStrictEqual(describeRunMetaParts(missing), ['—', '—', '—', '—']);

		const present = terminalRun({ durationMs: 605_027, totalTokens: 781_753, defaultModel: 'claude-opus-4-8[1m]', agentCount: 2 });
		assert.deepStrictEqual(describeRunMetaParts(present), ['claude-opus-4-8[1m]', '782K tokens', '10m', '2 agents']);
	});

	test('a live/unknown-shape run carries none of the terminal-only fields, so its meta line falls back to describeRunRow\'s own secondary parts', () => {
		const live = liveRun({ runId: 'wf_live' });
		assert.deepStrictEqual(describeRunMetaParts(live), describeRunRow(live).secondaryParts);
	});

	test('never inlines the run\'s summary, result, or error text', () => {
		const run = terminalRun({ summary: 'Audited the fleet module.', resultPreview: 'Found 3 issues.', error: 'boom' });
		const meta = describeRunMetaParts(run).join(' ');
		assert.ok(!meta.includes('Audited') && !meta.includes('Found 3 issues') && !meta.includes('boom'), `meta line leaked inline text: "${meta}"`);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - phase + agent content', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('describePhase carries title/detail/derived agent+error counts, error count only when > 0', () => {
		assert.deepStrictEqual(describePhase(phase({ title: 'Analyze', detail: 'one pass', agentCount: 3, errorCount: 0 })),
			{ title: 'Analyze', detail: 'one pass', agentsLabel: '3 agents', errorsLabel: undefined });
		assert.deepStrictEqual(describePhase(phase({ title: 'Analyze', agentCount: 3, errorCount: 1 })).errorsLabel, '1 errors');
	});

	test('describeAgent: dashes for missing metrics, a real value for present ones, icon by state', () => {
		const done = describeAgent(agent({ state: 'done', tokens: undefined, toolCalls: 6, durationMs: undefined }));
		assert.deepStrictEqual(done.metricsParts, ['—', '6 calls', '—']);
		assert.strictEqual(describeAgent(agent({ state: 'error' })).icon.id, 'error');
		assert.strictEqual(describeAgent(agent({ state: 'done' })).icon.id, 'check');
	});
});

suite('Clawdius Claude Code Ultracode Workflows - the 0/1/>1 phase-grouping rule', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('0 phases: agents hang directly under the run, no phase node - and no inline leaf of any kind', () => {
		const run = terminalRun({ phases: [], agents: [agent({ agentId: 'a1' }), agent({ agentId: 'a2' })] });
		const children = buildTerminalRunChildren(run);
		assert.deepStrictEqual(children.map(c => c.element.kind), ['agent', 'agent']);
	});

	test('1 phase: agents STILL hang directly under the run, no phase node - the rule is > 1, not >= 1', () => {
		const run = terminalRun({ phases: [phase({ title: 'Only phase' })], agents: [agent({ agentId: 'a1', phaseIndex: 0 })] });
		const children = buildTerminalRunChildren(run);
		assert.deepStrictEqual(children.map(c => c.element.kind), ['agent']);
	});

	test('>1 phases: agents are grouped under phase nodes, matched by phaseIndex', () => {
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze' }), phase({ index: 1, title: 'Synthesize' })],
			agents: [agent({ agentId: 'a1', phaseIndex: 0 }), agent({ agentId: 'a2', phaseIndex: 1 }), agent({ agentId: 'a3', phaseIndex: 0 })],
		});
		const children = buildTerminalRunChildren(run);
		assert.strictEqual(children.length, 2); // 2 phase nodes, no top-level agent leaves
		assert.deepStrictEqual(children.map(c => c.element.kind), ['phase', 'phase']);
		const [analyze, synthesize] = children;
		assert.deepStrictEqual([...(analyze.children ?? [])].map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId), ['a1', 'a3']);
		assert.deepStrictEqual([...(synthesize.children ?? [])].map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId), ['a2']);
	});

	test('>1 phases: an agent matched by phaseTitle (no phaseIndex) still groups correctly', () => {
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze' }), phase({ index: 1, title: 'Synthesize' })],
			agents: [agent({ agentId: 'a1', phaseIndex: undefined, phaseTitle: 'Synthesize' })],
		});
		const [analyze, synthesize] = buildTerminalRunChildren(run);
		assert.deepStrictEqual([...(analyze.children ?? [])], []);
		assert.strictEqual([...(synthesize.children ?? [])].length, 1);
	});

	test('>1 phases: an agent whose phaseIndex and phaseTitle DISAGREE nests where its count is attributed (index-first)', () => {
		// The reader derives phase.agentCount and the tree nests children through the SAME predicate, so a
		// self-contradictory agent (phaseIndex 0 = Analyze, phaseTitle 'Synthesize' = index 1) can never show a count
		// under one phase and its row under the other. Index wins: it nests (and is counted) under Analyze only.
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze' }), phase({ index: 1, title: 'Synthesize' })],
			agents: [agent({ agentId: 'a1', phaseIndex: 0, phaseTitle: 'Synthesize' })],
		});
		const [analyze, synthesize] = buildTerminalRunChildren(run);
		assert.deepStrictEqual({
			analyze: [...(analyze.children ?? [])].map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId),
			synthesize: [...(synthesize.children ?? [])].map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId),
		}, { analyze: ['a1'], synthesize: [] });
	});

	test('>1 phases with DUPLICATE titles: a title-only agent nests under the FIRST match once, never double-rendered', () => {
		// A run may legally declare two phases with the same title. A title-only agent (no phaseIndex) matches BOTH by
		// title, but the shared first-match assignment nests it under the FIRST only - never two rows with the SAME
		// identity (which a WorkbenchObjectTree rejects).
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Build' }), phase({ index: 1, title: 'Build' })],
			agents: [agent({ agentId: 'a1', phaseIndex: undefined, phaseTitle: 'Build' })],
		});
		const [firstBuild, secondBuild] = buildTerminalRunChildren(run);
		assert.deepStrictEqual({
			first: [...(firstBuild.children ?? [])].map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId),
			second: [...(secondBuild.children ?? [])].map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId),
		}, { first: ['a1'], second: [] });
	});

	test('>1 phases: an agent matching NO declared phase is never dropped - it hangs after the phase nodes', () => {
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze' }), phase({ index: 1, title: 'Synthesize' })],
			agents: [agent({ agentId: 'a1', phaseIndex: 0 }), agent({ agentId: 'orphan', phaseIndex: undefined, phaseTitle: undefined })],
		});
		const children = buildTerminalRunChildren(run);
		assert.deepStrictEqual(children.map(c => c.element.kind), ['phase', 'phase', 'agent']);
		assert.strictEqual((children[2].element as { agent: TerminalWorkflowAgent }).agent.agentId, 'orphan');
	});

	test('a live run has NO children (no structured agent/phase list to expand into) - same as an unknown-shape run', () => {
		assert.strictEqual(buildRunElement(liveRun()).children, undefined);
		assert.strictEqual(buildRunElement(unknownRun()).children, undefined);
	});

	test('a zero-agent terminal run renders no children - no phantom agent/phase rows, no inline leaf', () => {
		// A run that genuinely ran no agents (agents: [], phases: []) - the run row still renders, there is simply
		// nothing beneath it. Distinct from a partial read that happens to have produced no readable agents: that
		// distinction lives in `run.completeness` (proved at the reader level), not in the tree shape, which is
		// identical either way - this test pins the SHAPE half of that honesty contract.
		const run = terminalRun({ agents: [], phases: [] });
		const children = buildTerminalRunChildren(run);
		assert.deepStrictEqual(children, []);
	});

	test('buildWorkflowTreeChildren preserves the seam\'s own enumeration order (never re-sorted)', () => {
		const runs: readonly WorkflowRun[] = [terminalRun({ runId: 'z' }), terminalRun({ runId: 'a' })];
		const children = buildWorkflowTreeChildren(runs);
		assert.deepStrictEqual(children.map(c => (c.element as { run: WorkflowRun }).run.runId), ['z', 'a']);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - failure surfacing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function agentIds(children: readonly { element: WorkflowTreeElement }[]): string[] {
		return children.map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId);
	}

	test('erroredAgentCount tallies a terminal run\'s errored agents; undefined for a live/unknown-shape run (no agent list exists at all)', () => {
		const someErrored = terminalRun({ agents: [agent({ agentId: 'a1', state: 'error' }), agent({ agentId: 'a2', state: 'done' }), agent({ agentId: 'a3', state: 'error' })] });
		const noneErrored = terminalRun({ agents: [agent({ agentId: 'a1', state: 'done' })] });
		assert.deepStrictEqual([
			erroredAgentCount(someErrored), erroredAgentCount(noneErrored), erroredAgentCount(liveRun()), erroredAgentCount(unknownRun()),
		], [2, 0, undefined, undefined]);
	});

	test('0/1 phase case: errored agents sort first directly under the run, done agents keep their relative order after them (stable)', () => {
		const run = terminalRun({
			agents: [agent({ agentId: 'd1', state: 'done' }), agent({ agentId: 'e1', state: 'error' }), agent({ agentId: 'd2', state: 'done' }), agent({ agentId: 'e2', state: 'error' })],
		});
		const agents = buildTerminalRunChildren(run);
		assert.deepStrictEqual(agentIds(agents), ['e1', 'e2', 'd1', 'd2']);
	});

	test('>1 phases: errored agents sort first WITHIN each phase group and among the unassigned leftovers, each preserving relative order (stable)', () => {
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze', errorCount: 1 }), phase({ index: 1, title: 'Synthesize', errorCount: 0 })],
			agents: [
				agent({ agentId: 'a-done1', phaseIndex: 0, state: 'done' }),
				agent({ agentId: 'a-err', phaseIndex: 0, state: 'error' }),
				agent({ agentId: 'a-done2', phaseIndex: 0, state: 'done' }),
				agent({ agentId: 'b-done', phaseIndex: 1, state: 'done' }),
				agent({ agentId: 'orphan-done', state: 'done' }),
				agent({ agentId: 'orphan-err', state: 'error' }),
			],
		});
		const [analyze, synthesize, ...unassigned] = buildTerminalRunChildren(run);
		assert.deepStrictEqual({
			analyze: agentIds([...(analyze.children ?? [])]),
			synthesize: agentIds([...(synthesize.children ?? [])]),
			unassigned: agentIds(unassigned),
		}, { analyze: ['a-err', 'a-done1', 'a-done2'], synthesize: ['b-done'], unassigned: ['orphan-err', 'orphan-done'] });
	});

	test('>1 phases: the FIRST error-bearing phase (in declared order) auto-expands (collapsed: false); every other phase is left untouched', () => {
		const run = terminalRun({
			phases: [
				phase({ index: 0, title: 'Analyze', errorCount: 0 }),
				phase({ index: 1, title: 'Synthesize', errorCount: 2 }),
				phase({ index: 2, title: 'Report', errorCount: 1 }),
			],
			agents: [],
		});
		const [analyze, synthesize, report] = buildTerminalRunChildren(run);
		assert.deepStrictEqual(
			{ analyze: analyze.collapsed, synthesize: synthesize.collapsed, report: report.collapsed },
			{ analyze: undefined, synthesize: false, report: undefined });
	});

	test('>1 phases: no phase has an error -> nothing auto-expands', () => {
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze', errorCount: 0 }), phase({ index: 1, title: 'Synthesize', errorCount: 0 })],
			agents: [],
		});
		const [analyze, synthesize] = buildTerminalRunChildren(run);
		assert.deepStrictEqual([analyze.collapsed, synthesize.collapsed], [undefined, undefined]);
	});

	test('the run row shows an errored-agent chip only when the tally is > 0, never fabricated for a run with no agent tally', () => {
		const context: IWorkflowRenderContext = {
			uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined,
			runOf: () => undefined, justGraduated: () => false,
		};
		const zero = renderRunRow(context, terminalRun({ agents: [agent({ state: 'done' })] }));
		const two = renderRunRow(context, terminalRun({
			agents: [agent({ agentId: 'a1', state: 'error' }), agent({ agentId: 'a2', state: 'error' }), agent({ agentId: 'a3', state: 'done' })],
		}));
		const live = renderRunRow(context, liveRun());
		assert.deepStrictEqual({
			zero: { display: zero.querySelector<HTMLElement>('.errored-chip')!.style.display, text: zero.querySelector('.errored-chip')!.textContent },
			two: { display: two.querySelector<HTMLElement>('.errored-chip')!.style.display, text: two.querySelector('.errored-chip')!.textContent },
			live: live.querySelector<HTMLElement>('.errored-chip')!.style.display,
		}, {
			zero: { display: 'none', text: '' },
			two: { display: '', text: '2 errored' },
			live: 'none',
		});
	});
});

suite('Clawdius Claude Code Ultracode Workflows - honesty-label display text', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('describeOwnershipLabel: plain English for both FleetOwnership values, never the raw jargon', () => {
		assert.deepStrictEqual(
			[describeOwnershipLabel('owned'), describeOwnershipLabel('foreign')],
			['Started here', 'Observed']);
	});

	test('describeCoverageLabel: plain English for all three CoverageLabel values', () => {
		assert.deepStrictEqual(
			[describeCoverageLabel(CoverageLabel.InScope), describeCoverageLabel(CoverageLabel.Foreign), describeCoverageLabel(CoverageLabel.OutOfScope)],
			['This workspace', 'Another workspace', 'Outside workspace']);
	});

	test('describeFreshnessLabel: plain English for all three FreshnessLabel values', () => {
		assert.deepStrictEqual(
			[describeFreshnessLabel(FreshnessLabel.Live), describeFreshnessLabel(FreshnessLabel.Polled), describeFreshnessLabel(FreshnessLabel.Stale)],
			['Live', 'From disk', 'Possibly outdated']);
	});

	test('describeCompletenessLabel: undefined (exception-only) for Complete, plain English for every other member', () => {
		assert.deepStrictEqual(
			[
				describeCompletenessLabel(CompletenessState.Complete),
				describeCompletenessLabel(CompletenessState.Partial),
				describeCompletenessLabel(CompletenessState.Absent),
				describeCompletenessLabel(CompletenessState.Suppressed),
				describeCompletenessLabel(CompletenessState.UnknownShape),
			],
			[undefined, 'Partial read', 'No data yet', 'History suppressed', 'Unrecognized data']);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - ownership-chrome rule', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('computeUniformlyForeign is true only when every run resolves foreign', () => {
		const owned = new Set(['owned-session']);
		assert.strictEqual(computeUniformlyForeign([terminalRun({ sessionId: 'foreign-1' }), terminalRun({ sessionId: 'foreign-2' })], owned), true);
		assert.strictEqual(computeUniformlyForeign([terminalRun({ sessionId: 'foreign-1' }), terminalRun({ sessionId: 'owned-session' })], owned), false);
	});

	test('case 1: uniformlyForeign paints NO per-run ownership chrome (the common case)', () => {
		const context: IWorkflowRenderContext = {
			uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined,
			runOf: () => undefined, justGraduated: () => false,
		};
		const container = renderRunRow(context, terminalRun());
		const chip = container.querySelector<HTMLElement>('.ownership-chip')!;
		assert.strictEqual(chip.style.display, 'none');
	});

	test('case 3: NOT uniformlyForeign shows a per-run ownership label, on both the foreign AND the owned run', () => {
		const context: IWorkflowRenderContext = {
			uniformlyForeign: false, ownedSessionIds: new Set(['owned-session']), badgeOf: () => undefined,
			runOf: () => undefined, justGraduated: () => false,
		};
		const foreignContainer = renderRunRow(context, terminalRun({ sessionId: 'foreign-session' }));
		const ownedContainer = renderRunRow(context, terminalRun({ sessionId: 'owned-session' }));
		// The chip's own displayed TEXT is the plain-English mapping (describeOwnershipLabel); the raw 'foreign'/
		// 'owned' value still drives the CSS class + data-ownership-shown attribute, asserted separately below.
		assert.deepStrictEqual(
			[foreignContainer.querySelector('.ownership-chip')?.textContent, ownedContainer.querySelector('.ownership-chip')?.textContent],
			['Observed', 'Started here']);
		assert.deepStrictEqual(
			[foreignContainer.getAttribute('data-ownership-shown'), ownedContainer.getAttribute('data-ownership-shown')],
			['foreign', 'owned']);
	});

	test('a partial/unknown-shape run ALWAYS shows its completeness chip, independent of uniformlyForeign', () => {
		const uniform: IWorkflowRenderContext = {
			uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined,
			runOf: () => undefined, justGraduated: () => false,
		};
		const mixed: IWorkflowRenderContext = {
			uniformlyForeign: false, ownedSessionIds: new Set(['s1']), badgeOf: () => undefined,
			runOf: () => undefined, justGraduated: () => false,
		};
		const partialRun = terminalRun({ completeness: CompletenessState.Partial });
		const uniformChip = renderRunRow(uniform, partialRun).querySelector<HTMLElement>('.completeness-chip')!;
		const mixedChip = renderRunRow(mixed, partialRun).querySelector<HTMLElement>('.completeness-chip')!;
		assert.deepStrictEqual(
			{ uniform: { display: uniformChip.style.display, text: uniformChip.textContent }, mixed: { display: mixedChip.style.display, text: mixedChip.textContent } },
			{ uniform: { display: '', text: 'Partial read' }, mixed: { display: '', text: 'Partial read' } });
	});

	test('a complete run shows NO completeness chip - the chip is exception-only', () => {
		const context: IWorkflowRenderContext = {
			uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined,
			runOf: () => undefined, justGraduated: () => false,
		};
		const container = renderRunRow(context, terminalRun({ completeness: CompletenessState.Complete }));
		assert.strictEqual(container.querySelector<HTMLElement>('.completeness-chip')!.style.display, 'none');
	});
});

suite('Clawdius Claude Code Ultracode Workflows - accessibility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const a11y = new WorkflowTreeAccessibilityProvider(fakeContext());

	test('each element kind gets a distinct, informative aria label, including RUN status/errored-count', () => {
		const run = terminalRun({ agents: [agent({ agentId: 'a1', label: 'audit:fleet', state: 'error' })], phases: [phase({ index: 0, title: 'Analyze' })] });
		assert.deepStrictEqual([
			a11y.getAriaLabel({ kind: 'run', run }),
			a11y.getAriaLabel({ kind: 'phase', run, phase: phase({ index: 0, title: 'Analyze', errorCount: 0 }) }),
			a11y.getAriaLabel({ kind: 'phase', run, phase: phase({ index: 1, title: 'Report', errorCount: 2 }) }),
			a11y.getAriaLabel({ kind: 'agent', run, agent: agent({ agentId: 'a1', label: 'audit:fleet', state: 'error' }) }),
		], [
			`${describeRunRow(run).primary}. completed, 1 errored.`,
			`Phase ${0 + 1}: Analyze`,
			`Phase ${1 + 1}: Report, 2 errors`,
			'Agent audit:fleet, error',
		]);
	});

	test('getWidgetAriaLabel names the view', () => {
		assert.strictEqual(a11y.getWidgetAriaLabel(), 'Claude Code Ultracode Workflows');
	});

	test('describeRunStatusForAria: status word, errored count, completeness, and live badge - each exception-only', () => {
		const needsInputBadge: BadgeSignal = { runId: 'wf_b', kind: 'needs-input', freshness: FreshnessLabel.Live, source: 'live-event' };
		assert.deepStrictEqual({
			completed: describeRunStatusForAria(terminalRun({ status: 'completed' }), undefined),
			failed: describeRunStatusForAria(terminalRun({ status: 'failed' }), undefined),
			errored: describeRunStatusForAria(terminalRun({ agents: [agent({ state: 'error' })] }), undefined),
			partial: describeRunStatusForAria(terminalRun({ completeness: CompletenessState.Partial }), undefined),
			live: describeRunStatusForAria(liveRun(), undefined),
			unknownShape: describeRunStatusForAria(unknownRun(), undefined),
			badgedLive: describeRunStatusForAria(liveRun(), needsInputBadge),
		}, {
			completed: 'completed', failed: 'failed', errored: 'completed, 1 errored', partial: 'completed, partial data',
			live: 'in progress', unknownShape: '', badgedLive: 'in progress, needs input',
		});
	});

	test('the RUN label reads the CURRENT run via context.runOf, never a STALE element.run - the graduation case', () => {
		// `reconcileWorkflowTree` deliberately leaves an unchanged-identity node's OWN element pointing at the
		// pre-graduation data (see that function's doc comment) - the tree element handed to `getAriaLabel` here is
		// exactly that stale reference. Only `context.runOf` carries the fresh, graduated (terminal, failed) run.
		const staleLive = liveRun({ runId: 'wf_g' });
		const freshTerminal = terminalRun({ runId: 'wf_g', sessionId: staleLive.sessionId, status: 'failed' });
		const graduated = new WorkflowTreeAccessibilityProvider(fakeContext({
			runOf: identity => (identity === freshTerminal.identity ? freshTerminal : undefined),
		}));
		const label = graduated.getAriaLabel({ kind: 'run', run: staleLive });
		assert.ok(label.includes('failed'), `expected the graduated (terminal, failed) status in the label, got: "${label}"`);
		assert.ok(!label.includes('in progress'), `label still described the pre-graduation live state: "${label}"`);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - virtual delegate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('every row kind is a FIXED height - no measured, variable-height leaf exists in this tree', () => {
		const delegate = new WorkflowTreeVirtualDelegate();
		const run = terminalRun();
		assert.deepStrictEqual({
			phase: delegate.getHeight({ kind: 'phase', run, phase: phase() }),
			agent: delegate.getHeight({ kind: 'agent', run, agent: agent() }),
			run: delegate.getHeight({ kind: 'run', run }),
		}, { phase: 22, agent: 22, run: 40 }); // the run row is two lines (name + meta), taller than a single-line row
	});
});

suite('Clawdius Claude Code Ultracode Workflows - phase + agent renderers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the phase row renders title/detail/counts, hiding detail and the error count when absent', () => {
		const renderer = new WorkflowPhaseRowRenderer();
		const container = $('div');
		const template = renderer.renderTemplate(container);
		const run = terminalRun();
		renderer.renderElement(fakeNode({ kind: 'phase', run, phase: phase({ title: 'Analyze', detail: undefined, agentCount: 2, errorCount: 0 }) }), 0, template);
		assert.deepStrictEqual({
			title: container.querySelector('.clawdius-workflow-phase-title')!.textContent,
			detailHidden: (container.querySelector('.clawdius-workflow-phase-detail') as HTMLElement).style.display,
			errors: container.querySelector('.clawdius-workflow-phase-errors'),
		}, { title: 'Analyze', detailHidden: 'none', errors: null });

		renderer.renderElement(fakeNode({ kind: 'phase', run, phase: phase({ title: 'Analyze', detail: 'one pass', agentCount: 2, errorCount: 1 }) }), 0, template);
		assert.deepStrictEqual({
			detailText: container.querySelector('.clawdius-workflow-phase-detail')!.textContent,
			errorsText: container.querySelector('.clawdius-workflow-phase-errors')!.textContent,
		}, { detailText: 'one pass', errorsText: '1 errors' });
	});

	test('the agent row carries its state as a data attribute and the done/error icon class', () => {
		const store = new WorkflowAgentRowRenderer(fakeHoverDelegate);
		const container = $('div');
		const template = store.renderTemplate(container);
		const run = terminalRun();
		store.renderElement(fakeNode({ kind: 'agent', run, agent: agent({ agentId: 'a1', state: 'error' }) }), 0, template);
		assert.deepStrictEqual({
			state: container.getAttribute('data-agent-state'),
			iconHasError: container.querySelector('.clawdius-workflow-agent-icon')!.classList.contains('agent-error'),
		}, { state: 'error', iconHasError: true });
		store.disposeTemplate(template);
		store.dispose();
	});
});

suite('Clawdius Claude Code Ultracode Workflows - the three distinct display states', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	function okResult(runs: readonly WorkflowRun[]): WorkflowRunListResult {
		return { state: 'ok', runs };
	}

	test('an ok read with runs resolves to the tree state, carrying those runs', () => {
		const runs: readonly WorkflowRun[] = [terminalRun()];
		assert.deepStrictEqual(resolveWorkflowsDisplayState(okResult(runs), false), { kind: 'tree', runs });
	});

	test('an ok/partial read with ZERO runs resolves to empty when no filter is active', () => {
		assert.deepStrictEqual(resolveWorkflowsDisplayState(okResult([]), false), { kind: 'empty' });
		assert.deepStrictEqual(resolveWorkflowsDisplayState({ state: 'partial', runs: [], message: 'oops' }, false), { kind: 'empty' });
	});

	test('a read-error ALWAYS resolves to read-error, even with a filter active - it is not the same as empty', () => {
		assert.deepStrictEqual(resolveWorkflowsDisplayState({ state: 'read-error', runs: [], message: 'disk unreadable' }, false),
			{ kind: 'read-error', message: 'disk unreadable' });
		assert.deepStrictEqual(resolveWorkflowsDisplayState({ state: 'read-error', runs: [], message: 'disk unreadable' }, true),
			{ kind: 'read-error', message: 'disk unreadable' });
	});

	test('zero runs WITH a filter active resolves to no-match, not empty - the two are opposite facts', () => {
		assert.deepStrictEqual(resolveWorkflowsDisplayState(okResult([]), true), { kind: 'no-match' });
	});

	test('empty, read-error, and no-match are pairwise distinct icon + text in the rendered DOM', () => {
		const rendered = (state: Exclude<WorkflowsDisplayState, { kind: 'tree' }>) => {
			const container = $('div');
			const store = renderWorkflowsStateMessage(container, state, () => { });
			const snapshot = {
				iconClass: container.querySelector('.clawdius-workflows-state-icon')!.className,
				text: container.querySelector('.clawdius-workflows-state-text')!.textContent,
			};
			store.dispose();
			return snapshot;
		};
		const empty = rendered({ kind: 'empty' });
		const noMatch = rendered({ kind: 'no-match' });
		const readError = rendered({ kind: 'read-error', message: 'disk unreadable' });
		assert.notStrictEqual(empty.iconClass, noMatch.iconClass);
		assert.notStrictEqual(empty.iconClass, readError.iconClass);
		assert.notStrictEqual(noMatch.iconClass, readError.iconClass);
		assert.notStrictEqual(empty.text, noMatch.text);
		assert.notStrictEqual(empty.text, readError.text);
		assert.notStrictEqual(noMatch.text, readError.text);
	});

	test('only the read-error state carries the "Read again" affordance, and it calls the RE-ENUMERATION, not a control verb', () => {
		let readAgainCalls = 0;
		const onReadAgain = () => { readAgainCalls++; };

		const emptyContainer = $('div');
		const emptyStore = renderWorkflowsStateMessage(emptyContainer, { kind: 'empty' }, onReadAgain);
		assert.strictEqual(emptyContainer.querySelector('.monaco-button'), null);
		emptyStore.dispose();

		const noMatchContainer = $('div');
		const noMatchStore = renderWorkflowsStateMessage(noMatchContainer, { kind: 'no-match' }, onReadAgain);
		assert.strictEqual(noMatchContainer.querySelector('.monaco-button'), null);
		noMatchStore.dispose();

		const readErrorContainer = $('div');
		const store = renderWorkflowsStateMessage(readErrorContainer, { kind: 'read-error', message: 'disk unreadable' }, onReadAgain);
		const button = readErrorContainer.querySelector<HTMLElement>('.monaco-button')!;
		assert.strictEqual(button.textContent, 'Read Again');
		button.click();
		assert.strictEqual(readAgainCalls, 1);
		store.dispose();
	});

	test('a read-error with an empty message falls back to an honest generic label, never a blank line', () => {
		const container = $('div');
		const store = renderWorkflowsStateMessage(container, { kind: 'read-error', message: '' }, () => { });
		assert.strictEqual(container.querySelector('.clawdius-workflows-state-text')!.textContent, 'Claude Code workflow runs could not be read.');
		store.dispose();
	});
});

suite('Clawdius Claude Code Ultracode Workflows - find/sort: the text-filter corpus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches workflowName, summary, runId, each agent label, and the run\'s own error text - case-insensitively', () => {
		const run = terminalRun({
			runId: 'wf_Alpha', workflowName: 'Audit Fleet', summary: 'Found three issues',
			error: 'Boom: retry cap exceeded', agents: [agent({ agentId: 'a1', label: 'Reviewer-One' })],
		});
		assert.deepStrictEqual([
			matchesWorkflowFilter(run, 'audit'), matchesWorkflowFilter(run, 'THREE ISSUES'),
			matchesWorkflowFilter(run, 'wf_alpha'), matchesWorkflowFilter(run, 'reviewer-one'),
			matchesWorkflowFilter(run, 'boom'), matchesWorkflowFilter(run, 'no-such-needle'),
		], [true, true, true, true, true, false]);
	});

	test('NEVER matches resultText, resultPreview, or any agent\'s resultPreview - those fields are never even read', () => {
		const run = terminalRun({
			runId: 'wf_beta', resultText: 'THE FULL SENSITIVE RESULT BODY', resultPreview: 'a bounded preview of the result',
			agents: [agent({ agentId: 'a1', label: 'worker', resultPreview: 'a secret agent result body' })],
		});
		assert.deepStrictEqual([
			matchesWorkflowFilter(run, 'sensitive result body'),
			matchesWorkflowFilter(run, 'bounded preview'),
			matchesWorkflowFilter(run, 'secret agent result'),
		], [false, false, false]);
	});

	test('an empty query matches every run kind', () => {
		assert.deepStrictEqual([
			matchesWorkflowFilter(terminalRun(), ''), matchesWorkflowFilter(liveRun(), ''), matchesWorkflowFilter(unknownRun(), ''),
		], [true, true, true]);
	});

	test('a live/unknown-shape run matches only by its own runId - it carries none of the terminal-only fields', () => {
		const live = liveRun({ runId: 'wf_live_9' });
		const unknown = unknownRun({ runId: 'wf_unknown_9' });
		assert.deepStrictEqual([
			matchesWorkflowFilter(live, 'wf_live_9'), matchesWorkflowFilter(live, 'no-such-text'),
			matchesWorkflowFilter(unknown, 'wf_unknown_9'), matchesWorkflowFilter(unknown, 'no-such-text'),
		], [true, false, true, false]);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - find/sort: the status-category filter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('all matches every kind; live/completed/failed match exactly their own category, never the others', () => {
		const kinds = [liveRun(), terminalRun({ status: 'completed' }), terminalRun({ status: 'failed' }), unknownRun()];
		assert.deepStrictEqual({
			all: kinds.map(r => matchesWorkflowStatusFilter(r, WorkflowStatusFilter.All)),
			live: kinds.map(r => matchesWorkflowStatusFilter(r, WorkflowStatusFilter.Live)),
			completed: kinds.map(r => matchesWorkflowStatusFilter(r, WorkflowStatusFilter.Completed)),
			failed: kinds.map(r => matchesWorkflowStatusFilter(r, WorkflowStatusFilter.Failed)),
		}, {
			all: [true, true, true, true],
			live: [true, false, false, false],
			completed: [false, true, false, false],
			failed: [false, false, true, false],
		});
	});
});

suite('Clawdius Claude Code Ultracode Workflows - find/sort: deterministic sort modes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recency: newest-first by timestamp; a run missing a timestamp (incl. unknown-shape) sorts last; remaining ties break by identity', () => {
		const newer = terminalRun({ runId: 'r-newer', timestamp: 2000 });
		const older = terminalRun({ runId: 'r-older', timestamp: 1000 });
		const noTimestamp = terminalRun({ runId: 'r-no-ts', timestamp: undefined });
		const unknown = unknownRun({ runId: 'r-unknown' });
		const tiedA = terminalRun({ runId: 'r-tie-a', timestamp: 500 });
		const tiedB = terminalRun({ runId: 'r-tie-b', timestamp: 500 });
		const ordered = sortWorkflowRuns([noTimestamp, tiedB, unknown, newer, tiedA, older], WorkflowSortMode.Recency);
		assert.deepStrictEqual(ordered.map(r => r.runId), ['r-newer', 'r-older', 'r-tie-a', 'r-tie-b', 'r-no-ts', 'r-unknown']);
	});

	test('cost: highest totalTokens first; a REAL zero is not "missing"; a missing total sorts last; remaining ties break by identity', () => {
		const high = terminalRun({ runId: 'r-high', totalTokens: 5000 });
		const low = terminalRun({ runId: 'r-low', totalTokens: 100 });
		const zero = terminalRun({ runId: 'r-zero', totalTokens: 0 });
		const missing = terminalRun({ runId: 'r-missing', totalTokens: undefined });
		const tiedA = terminalRun({ runId: 'r-tie-a', totalTokens: 42 });
		const tiedB = terminalRun({ runId: 'r-tie-b', totalTokens: 42 });
		const ordered = sortWorkflowRuns([missing, low, tiedB, high, zero, tiedA], WorkflowSortMode.Cost);
		assert.deepStrictEqual(ordered.map(r => r.runId), ['r-high', 'r-low', 'r-tie-a', 'r-tie-b', 'r-zero', 'r-missing']);
	});

	test('status: failed before completed; newest-first within a status; unknown-shape (no status) sorts last; remaining ties break by identity', () => {
		const failedNew = terminalRun({ runId: 'r-failed-new', status: 'failed', timestamp: 2000 });
		const failedOld = terminalRun({ runId: 'r-failed-old', status: 'failed', timestamp: 1000 });
		const completedNew = terminalRun({ runId: 'r-completed-new', status: 'completed', timestamp: 1500 });
		const completedOld = terminalRun({ runId: 'r-completed-old', status: 'completed', timestamp: 500 });
		const unknown = unknownRun({ runId: 'r-unknown' });
		const tiedFailedA = terminalRun({ runId: 'r-tie-failed-a', status: 'failed', timestamp: 999 });
		const tiedFailedB = terminalRun({ runId: 'r-tie-failed-b', status: 'failed', timestamp: 999 });
		const ordered = sortWorkflowRuns(
			[unknown, completedOld, tiedFailedB, failedNew, completedNew, tiedFailedA, failedOld], WorkflowSortMode.Status,
		);
		assert.deepStrictEqual(ordered.map(r => r.runId), [
			'r-failed-new', 'r-failed-old', 'r-tie-failed-a', 'r-tie-failed-b', 'r-completed-new', 'r-completed-old', 'r-unknown',
		]);
	});

	test('sortWorkflowRuns returns a NEW array and never mutates its input', () => {
		const a = terminalRun({ runId: 'r-a', timestamp: 1 });
		const b = terminalRun({ runId: 'r-b', timestamp: 2 });
		const input = [a, b];
		const inputIdsBefore = input.map(r => r.runId);
		const ordered = sortWorkflowRuns(input, WorkflowSortMode.Recency);
		assert.deepStrictEqual(input.map(r => r.runId), inputIdsBefore);
		assert.notStrictEqual(ordered, input);
	});

	test('the SAME run set in a different input array order produces the IDENTICAL output order - the order is a property of the data, never the input array', () => {
		const x = terminalRun({ runId: 'r-x', timestamp: 10 });
		const y = terminalRun({ runId: 'r-y', timestamp: 10 });
		const z = terminalRun({ runId: 'r-z', timestamp: 5 });
		const orderA = sortWorkflowRuns([x, y, z], WorkflowSortMode.Recency).map(r => r.runId);
		const orderB = sortWorkflowRuns([z, y, x], WorkflowSortMode.Recency).map(r => r.runId);
		assert.deepStrictEqual(orderA, orderB);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - find/sort: live pin among matches + exclusion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every sort mode pins LIVE runs first, ordered among themselves by identity, ahead of every terminal/unknown-shape run', () => {
		const liveB = liveRun({ runId: 'wf_live_b' });
		const liveA = liveRun({ runId: 'wf_live_a' });
		const terminal = terminalRun({ runId: 'wf_terminal', status: 'failed', timestamp: 9_999_999, totalTokens: 9_999_999 });
		for (const mode of [WorkflowSortMode.Recency, WorkflowSortMode.Cost, WorkflowSortMode.Status]) {
			const ordered = sortWorkflowRuns([terminal, liveB, liveA], mode);
			assert.deepStrictEqual(ordered.map(r => r.runId), ['wf_live_a', 'wf_live_b', 'wf_terminal'], `sort mode: ${mode}`);
		}
	});

	test('a live run that fails the text filter is EXCLUDED outright, never force-pinned - filtering happens BEFORE sorting, never around it', () => {
		const matchingLive = liveRun({ runId: 'wf_live_match' });
		const nonMatchingLive = liveRun({ runId: 'wf_live_other' });
		// The view's own composition, driven directly: filter, THEN sort.
		const filtered = [matchingLive, nonMatchingLive].filter(r => matchesWorkflowFilter(r, 'wf_live_match'));
		const ordered = sortWorkflowRuns(filtered, WorkflowSortMode.Recency);
		assert.deepStrictEqual(ordered.map(r => r.runId), ['wf_live_match']);
	});

	test('a live run is pinned first only AMONG MATCHES: a terminal run that matches the filter still leads a live run that fails it', () => {
		const matchingTerminal = terminalRun({ runId: 'wf_terminal_match', workflowName: 'audit' });
		const nonMatchingLive = liveRun({ runId: 'wf_live_nomatch' });
		const filtered = [matchingTerminal, nonMatchingLive].filter(r => matchesWorkflowFilter(r, 'audit'));
		const ordered = sortWorkflowRuns(filtered, WorkflowSortMode.Recency);
		assert.deepStrictEqual(ordered.map(r => r.runId), ['wf_terminal_match']);
	});
});
// CLAWDIUS-END
