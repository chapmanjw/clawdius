/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - tree model + renderer tests
// The WorkbenchObjectTree replacement for the manual-DOM row list: the discriminated tree-element union, the
// 0/1/>1 phase-grouping rule, the measured-height story leaf, the ownership-chrome split, and the three
// distinct empty/read-error/no-match states. Renderer tests assert through the DOM the renderer actually produces
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
import {
	buildRunElement, buildTerminalRunChildren, buildWorkflowTreeChildren, computeUniformlyForeign, describeAgent,
	describePhase, describeRunRow, describeStoryCostParts, describeStoryError, describeStoryResultText,
	describeStorySummaryText, erroredAgentCount, errorSummary, IWorkflowRenderContext, renderWorkflowsStateMessage,
	resolveWorkflowsDisplayState, runStatusClass, WorkflowAgentRowRenderer, WorkflowPhaseRowRenderer,
	WorkflowRunRowRenderer, WorkflowsDisplayState, WorkflowStoryHeightCache, WorkflowStoryLeafRenderer,
	WorkflowTreeAccessibilityProvider, WorkflowTreeElement, WorkflowTreeIdentityProvider,
	WorkflowTreeVirtualDelegate, workflowTreeElementId, STORY_MIN_HEIGHT,
} from '../../browser/workflows/claudeWorkflowTree.js';

const IDENTITY_BASE = {
	ownership: 'foreign' as const, coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled,
	completeness: CompletenessState.Complete, adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
};

function terminalRun(overrides: Partial<TerminalWorkflowRun> = {}): TerminalWorkflowRun {
	return {
		kind: 'terminal', sessionId: 's1', runId: 'wf_a', identity: workflowRunIdentity('s1', 'wf_a'),
		...IDENTITY_BASE, status: 'completed', phases: [], agents: [],
		...overrides,
	};
}

function liveRun(overrides: Partial<LiveWorkflowRun> = {}): LiveWorkflowRun {
	return {
		kind: 'live', sessionId: 's1', runId: 'wf_b', identity: workflowRunIdentity('s1', 'wf_b'),
		...IDENTITY_BASE, freshness: FreshnessLabel.Live,
		startedCount: 1, resultCount: 0, landedResults: [], journalLastWriteTime: 1_700_000_000_000,
		...overrides,
	};
}

function unknownRun(overrides: Partial<UnrecognizedWorkflowRun> = {}): UnrecognizedWorkflowRun {
	return {
		kind: 'unknown-shape', sessionId: 's1', runId: 'wf_c', identity: workflowRunIdentity('s1', 'wf_c'),
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
			workflowTreeElementId({ kind: 'story', run }),
			workflowTreeElementId({ kind: 'phase', run, phase: phase({ index: 2 }) }),
			workflowTreeElementId({ kind: 'agent', run, agent: agent({ agentId: 'a9' }) }),
		], [
			`run:${run.identity}`, `story:${run.identity}`, `phase:${run.identity}:2`, `agent:${run.identity}:a9`,
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

suite('Clawdius Claude Code Ultracode Workflows - story leaf content', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('every missing cost number is the dash literal - never a fabricated 0', () => {
		const run = terminalRun({ durationMs: undefined, totalTokens: undefined, totalToolCalls: undefined, defaultModel: undefined, agentCount: undefined });
		assert.deepStrictEqual(describeStoryCostParts(run), ['—', '—', '—', '—', '—']);
	});

	test('a present cost number is formatted, not the dash - the two branches are each other\'s guard', () => {
		const run = terminalRun({ durationMs: 605_027, totalTokens: 781_753, totalToolCalls: 191, defaultModel: 'claude-opus-4-8[1m]', agentCount: 2 });
		assert.deepStrictEqual(describeStoryCostParts(run), ['10m', '782K tokens', '191 tool calls', 'claude-opus-4-8[1m]', '2 agents']);
	});

	test('resultPreview present -> shown; absent -> the literal "No result recorded", never a blank leaf', () => {
		assert.deepStrictEqual([
			describeStoryResultText(terminalRun({ resultPreview: 'Found 3 issues.' })),
			describeStoryResultText(terminalRun({ resultPreview: undefined })),
		], ['Found 3 issues.', 'No result recorded']);
	});

	test('summary present -> shown; absent -> an honest "no summary" label, never a blank leaf', () => {
		assert.deepStrictEqual([
			describeStorySummaryText(terminalRun({ summary: 'Audited the fleet module.' })),
			describeStorySummaryText(terminalRun({ summary: undefined })),
		], ['Audited the fleet module.', 'No summary recorded']);
	});

	test('a run-level error is clamped to its first line with the full text kept for the tooltip; absent -> undefined', () => {
		const stack = 'TelemetrySafeError: retry cap exceeded\n    at frame (file.js:1:1)';
		assert.deepStrictEqual(describeStoryError(terminalRun({ error: stack })), { summary: 'TelemetrySafeError: retry cap exceeded', full: stack });
		assert.strictEqual(describeStoryError(terminalRun({ error: undefined })), undefined);
	});

	test('errorSummary keeps the fault line and collapses the frames; a blank-led error never yields a blank line', () => {
		assert.deepStrictEqual([
			errorSummary('Error: CLAUDE_PLUGIN_ROOT is not defined\n    at <anonymous> (workflow.js:245:225)'),
			errorSummary('\n\n   Error:   spaced   out   \n    at frame'),
			errorSummary(''),
		], ['Error: CLAUDE_PLUGIN_ROOT is not defined', 'Error: spaced out', '']);
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
	test('0 phases: agents hang directly under the run, no phase node', () => {
		const run = terminalRun({ phases: [], agents: [agent({ agentId: 'a1' }), agent({ agentId: 'a2' })] });
		const children = buildTerminalRunChildren(run);
		assert.deepStrictEqual(children.map(c => c.element.kind), ['story', 'agent', 'agent']);
	});

	test('1 phase: agents STILL hang directly under the run, no phase node - the rule is > 1, not >= 1', () => {
		const run = terminalRun({ phases: [phase({ title: 'Only phase' })], agents: [agent({ agentId: 'a1', phaseIndex: 0 })] });
		const children = buildTerminalRunChildren(run);
		assert.deepStrictEqual(children.map(c => c.element.kind), ['story', 'agent']);
	});

	test('>1 phases: agents are grouped under phase nodes, matched by phaseIndex', () => {
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze' }), phase({ index: 1, title: 'Synthesize' })],
			agents: [agent({ agentId: 'a1', phaseIndex: 0 }), agent({ agentId: 'a2', phaseIndex: 1 }), agent({ agentId: 'a3', phaseIndex: 0 })],
		});
		const children = buildTerminalRunChildren(run);
		assert.strictEqual(children.length, 3); // story + 2 phase nodes, no top-level agent leaves
		assert.deepStrictEqual(children.map(c => c.element.kind), ['story', 'phase', 'phase']);
		const [, analyze, synthesize] = children;
		assert.deepStrictEqual([...(analyze.children ?? [])].map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId), ['a1', 'a3']);
		assert.deepStrictEqual([...(synthesize.children ?? [])].map(c => (c.element as { agent: TerminalWorkflowAgent }).agent.agentId), ['a2']);
	});

	test('>1 phases: an agent matched by phaseTitle (no phaseIndex) still groups correctly', () => {
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze' }), phase({ index: 1, title: 'Synthesize' })],
			agents: [agent({ agentId: 'a1', phaseIndex: undefined, phaseTitle: 'Synthesize' })],
		});
		const [, analyze, synthesize] = buildTerminalRunChildren(run);
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
		const [, analyze, synthesize] = buildTerminalRunChildren(run);
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
		const [, firstBuild, secondBuild] = buildTerminalRunChildren(run);
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
		assert.deepStrictEqual(children.map(c => c.element.kind), ['story', 'phase', 'phase', 'agent']);
		assert.strictEqual((children[3].element as { agent: TerminalWorkflowAgent }).agent.agentId, 'orphan');
	});

	test('a live or unknown-shape run has NO children - a rich live leaf is a later change', () => {
		assert.strictEqual(buildRunElement(liveRun()).children, undefined);
		assert.strictEqual(buildRunElement(unknownRun()).children, undefined);
	});

	test('the story leaf is always first and never collapsible', () => {
		const run = terminalRun({ agents: [agent()] });
		const [story] = buildTerminalRunChildren(run);
		assert.deepStrictEqual({ kind: story.element.kind, collapsible: story.collapsible }, { kind: 'story', collapsible: false });
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
		const [, ...agents] = buildTerminalRunChildren(run);
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
		const [, analyze, synthesize, ...unassigned] = buildTerminalRunChildren(run);
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
		const [, analyze, synthesize, report] = buildTerminalRunChildren(run);
		assert.deepStrictEqual(
			{ analyze: analyze.collapsed, synthesize: synthesize.collapsed, report: report.collapsed },
			{ analyze: undefined, synthesize: false, report: undefined });
	});

	test('>1 phases: no phase has an error -> nothing auto-expands', () => {
		const run = terminalRun({
			phases: [phase({ index: 0, title: 'Analyze', errorCount: 0 }), phase({ index: 1, title: 'Synthesize', errorCount: 0 })],
			agents: [],
		});
		const [, analyze, synthesize] = buildTerminalRunChildren(run);
		assert.deepStrictEqual([analyze.collapsed, synthesize.collapsed], [undefined, undefined]);
	});

	test('the run row shows an errored-agent chip only when the tally is > 0, never fabricated for a run with no agent tally', () => {
		const context: IWorkflowRenderContext = { uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined };
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

suite('Clawdius Claude Code Ultracode Workflows - ownership-chrome rule', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('computeUniformlyForeign is true only when every run resolves foreign', () => {
		const owned = new Set(['owned-session']);
		assert.strictEqual(computeUniformlyForeign([terminalRun({ sessionId: 'foreign-1' }), terminalRun({ sessionId: 'foreign-2' })], owned), true);
		assert.strictEqual(computeUniformlyForeign([terminalRun({ sessionId: 'foreign-1' }), terminalRun({ sessionId: 'owned-session' })], owned), false);
	});

	test('case 1: uniformlyForeign paints NO per-run ownership chrome (the common case)', () => {
		const context: IWorkflowRenderContext = { uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined };
		const container = renderRunRow(context, terminalRun());
		const chip = container.querySelector<HTMLElement>('.ownership-chip')!;
		assert.strictEqual(chip.style.display, 'none');
	});

	test('case 3: NOT uniformlyForeign shows a per-run ownership label, on both the foreign AND the owned run', () => {
		const context: IWorkflowRenderContext = { uniformlyForeign: false, ownedSessionIds: new Set(['owned-session']), badgeOf: () => undefined };
		const foreignContainer = renderRunRow(context, terminalRun({ sessionId: 'foreign-session' }));
		const ownedContainer = renderRunRow(context, terminalRun({ sessionId: 'owned-session' }));
		assert.deepStrictEqual(
			[foreignContainer.querySelector('.ownership-chip')?.textContent, ownedContainer.querySelector('.ownership-chip')?.textContent],
			['foreign', 'owned']);
	});

	test('a partial/unknown-shape run ALWAYS shows its completeness chip, independent of uniformlyForeign', () => {
		const uniform: IWorkflowRenderContext = { uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined };
		const mixed: IWorkflowRenderContext = { uniformlyForeign: false, ownedSessionIds: new Set(['s1']), badgeOf: () => undefined };
		const partialRun = terminalRun({ completeness: CompletenessState.Partial });
		assert.strictEqual(renderRunRow(uniform, partialRun).querySelector<HTMLElement>('.completeness-chip')!.style.display, '');
		assert.strictEqual(renderRunRow(mixed, partialRun).querySelector<HTMLElement>('.completeness-chip')!.style.display, '');
	});

	test('a complete run shows NO completeness chip - the chip is exception-only', () => {
		const context: IWorkflowRenderContext = { uniformlyForeign: true, ownedSessionIds: new Set(), badgeOf: () => undefined };
		const container = renderRunRow(context, terminalRun({ completeness: CompletenessState.Complete }));
		assert.strictEqual(container.querySelector<HTMLElement>('.completeness-chip')!.style.display, 'none');
	});
});

suite('Clawdius Claude Code Ultracode Workflows - accessibility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const a11y = new WorkflowTreeAccessibilityProvider();

	test('each element kind gets a distinct, informative aria label', () => {
		const run = terminalRun({ agents: [agent({ agentId: 'a1', label: 'audit:fleet', state: 'error' })], phases: [phase({ index: 0, title: 'Analyze' })] });
		assert.deepStrictEqual([
			a11y.getAriaLabel({ kind: 'run', run }),
			a11y.getAriaLabel({ kind: 'story', run }),
			a11y.getAriaLabel({ kind: 'phase', run, phase: phase({ index: 0, title: 'Analyze' }) }),
			a11y.getAriaLabel({ kind: 'agent', run, agent: agent({ agentId: 'a1', label: 'audit:fleet', state: 'error' }) }),
		], [
			describeRunRow(run).primary,
			'Summary and result for ' + describeRunRow(run).primary,
			`Phase ${0 + 1}: Analyze`,
			'Agent audit:fleet, error',
		]);
	});

	test('getWidgetAriaLabel names the view', () => {
		assert.strictEqual(a11y.getWidgetAriaLabel(), 'Claude Code Ultracode Workflows');
	});
});

suite('Clawdius Claude Code Ultracode Workflows - virtual delegate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('run/phase/agent rows are a fixed height; the story leaf reads the height cache', () => {
		const heights = new WorkflowStoryHeightCache();
		const delegate = new WorkflowTreeVirtualDelegate(heights);
		const run = terminalRun();
		assert.strictEqual(delegate.getHeight({ kind: 'run', run }), 22);
		assert.strictEqual(delegate.getHeight({ kind: 'phase', run, phase: phase() }), 22);
		assert.strictEqual(delegate.getHeight({ kind: 'agent', run, agent: agent() }), 22);
		// Unmeasured yet -> the minimum; measured -> the cached value.
		assert.strictEqual(delegate.getHeight({ kind: 'story', run }), STORY_MIN_HEIGHT);
		heights.set(run.identity, 140);
		assert.strictEqual(delegate.getHeight({ kind: 'story', run }), 140);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - the story leaf\'s measured height', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function withScrollHeight(el: HTMLElement, height: number): void {
		Object.defineProperty(el, 'scrollHeight', { value: height, configurable: true });
	}

	test('an integer height CHANGE fires onDidChangeItemHeight and updates the cache; an UNCHANGED re-render does not', () => {
		const heights = new WorkflowStoryHeightCache();
		const renderer = store.add(new WorkflowStoryLeafRenderer(heights));
		const container = $('div');
		const template = renderer.renderTemplate(container);
		withScrollHeight(container, 140);

		const run = terminalRun({ resultPreview: 'x'.repeat(400) });
		let fireCount = 0;
		let lastHeight = -1;
		store.add(renderer.onDidChangeItemHeight(change => { fireCount++; lastHeight = change.height; }));

		renderer.renderElement(fakeNode({ kind: 'story', run }), 0, template);
		assert.deepStrictEqual({ fireCount, lastHeight, cached: heights.get(run.identity) }, { fireCount: 1, lastHeight: 140, cached: 140 });

		// Re-render with the SAME scrollHeight: the guard is `cached === measured` - inverting it (always firing)
		// would make this assertion fail.
		renderer.renderElement(fakeNode({ kind: 'story', run }), 0, template);
		assert.strictEqual(fireCount, 1);

		// A real content change (e.g. the run grew a longer result) that changes the measured height fires again.
		withScrollHeight(container, 180);
		renderer.renderElement(fakeNode({ kind: 'story', run }), 0, template);
		assert.deepStrictEqual({ fireCount, lastHeight }, { fireCount: 2, lastHeight: 180 });
	});

	test('a measured height below the minimum is clamped up to STORY_MIN_HEIGHT, never shrunk under it', () => {
		const heights = new WorkflowStoryHeightCache();
		const renderer = store.add(new WorkflowStoryLeafRenderer(heights));
		const container = $('div');
		const template = renderer.renderTemplate(container);
		withScrollHeight(container, 10);
		const run = terminalRun();
		renderer.renderElement(fakeNode({ kind: 'story', run }), 0, template);
		assert.strictEqual(heights.get(run.identity), STORY_MIN_HEIGHT);
	});

	test('remeasureAll re-measures every currently-rendered leaf, and disposeElement stops tracking a recycled one', () => {
		const heights = new WorkflowStoryHeightCache();
		const renderer = store.add(new WorkflowStoryLeafRenderer(heights));
		const container = $('div');
		const template = renderer.renderTemplate(container);
		withScrollHeight(container, 140);
		const run = terminalRun();
		let fireCount = 0;
		store.add(renderer.onDidChangeItemHeight(() => fireCount++));
		renderer.renderElement(fakeNode({ kind: 'story', run }), 0, template);
		assert.strictEqual(fireCount, 1);

		// A width change grows the wrap height; remeasureAll must pick it up without a fresh renderElement call.
		withScrollHeight(container, 200);
		renderer.remeasureAll();
		assert.deepStrictEqual({ fireCount, cached: heights.get(run.identity) }, { fireCount: 2, cached: 200 });

		// Once the template is recycled away from this element, remeasureAll must no longer touch it.
		renderer.disposeElement(fakeNode({ kind: 'story', run }), 0, template);
		withScrollHeight(container, 999);
		renderer.remeasureAll();
		assert.strictEqual(fireCount, 2);
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
// CLAWDIUS-END
