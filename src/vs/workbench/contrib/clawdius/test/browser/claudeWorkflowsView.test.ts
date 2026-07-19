/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - Sidebar view render tests
// The view layer honesty guarantee: the fleet binds to the seam's listRuns and renders EVERY enumerated run as a
// labeled row carrying its status + coverage/freshness/completeness/ownership as both a badge and a `data-*` hook;
// a foreign/suppressed run is rendered PRESENT-WITH-LABEL (marked, never omitted). Drives the
// SAME production code path the ViewPane uses (FleetRunsList over a fake IFleetRunSource), so the test needs no
// workbench host. Also covers the honest empty state (no runs -> a labeled empty row, never a crash).

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MissionAgent as WorkflowAgent, MissionAgentList as WorkflowAgentList, MissionRun as WorkflowRun } from '../../common/claudeFleetModel.js';
import { CompletenessState, CoverageLabel, FreshnessLabel, ReaderConfigRoot } from '../../common/claudeReaderSeam.js';
import { LiveWorkflowRun, TerminalWorkflowRun, UnrecognizedWorkflowRun, workflowRunIdentity } from '../../common/claudeWorkflowModel.js';
import { errorSummary, FleetRunsList, IFleetRowInteractions, IFleetRunSource, toMissionShape } from '../../browser/workflows/claudeWorkflowsView.js';

/** A fake enumeration source: returns a fixed labeled list, so the view test binds to the SAME `listRuns` shape
 *  the seam produces without touching disk. */
class FakeRunSource implements IFleetRunSource {
	constructor(private readonly runs: readonly WorkflowRun[]) { }
	async listMissions(_root: ReaderConfigRoot): Promise<readonly WorkflowRun[]> {
		return this.runs;
	}
}

/** A fully-labeled WorkflowRun with the given overrides (defaults are the conservative enumeration labels). */
function run(overrides: Partial<WorkflowRun>): WorkflowRun {
	return {
		runId: 'r', sessionId: 's', name: 'a-workflow', status: 'completed', agentCount: 0,
		phases: [], progress: [], ownership: 'foreign',
		coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete,
		adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
		...overrides,
	};
}

/** Extract the honest projection each rendered row carries (its `data-*` hooks + the count of label badges), the
 *  view-layer analogue of the enumeration snapshot the enumeration tests assert. */
function rowsOf(container: HTMLElement): unknown[] {
	return [...container.querySelectorAll<HTMLElement>('.clawdius-workflows-row')].map(el => ({
		runId: el.getAttribute('data-run-id'),
		sessionId: el.getAttribute('data-session-id'),
		kind: el.getAttribute('data-kind'),
		status: el.getAttribute('data-status'),
		ownership: el.getAttribute('data-ownership'),
		coverage: el.getAttribute('data-coverage'),
		freshness: el.getAttribute('data-freshness'),
		completeness: el.getAttribute('data-completeness'),
		foreignMarked: el.classList.contains('foreign'),
		labelCount: el.querySelectorAll('.clawdius-workflows-label').length,
	}));
}

suite('Clawdius Claude Code Ultracode Workflows - Sidebar view', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const ROOT: ReaderConfigRoot = { kind: 'resolved', root: URI.file('/home/tester/.claude') };

	test('binds to listRuns and renders every run labeled; a foreign run is present-with-label', async () => {
		const source = new FakeRunSource([
			run({ runId: 'a-0001', sessionId: 'sess-a', coverage: CoverageLabel.InScope }),
			run({ runId: 'f-0001', sessionId: 'sess-foreign', coverage: CoverageLabel.Foreign }),
			run({ runId: 'malformed', sessionId: 'malformed', completeness: CompletenessState.UnknownShape }),
		]);
		const container = $('div');
		const list = store.add(new FleetRunsList(container));

		// Bind exactly as the ViewPane does: pull the enumerated runs off the seam, then render them.
		list.render(await source.listMissions(ROOT));

		// Every run present (the foreign run WITH its label, not omitted), each fully labeled with four
		// badges + all four honesty `data-*` hooks, and the foreign run visually marked.
		assert.strictEqual(container.getAttribute('data-clawdius-workflows'), '3');
		assert.deepStrictEqual(rowsOf(container), [
			{ runId: 'a-0001', sessionId: 'sess-a', kind: 'workflow', status: 'completed', ownership: 'foreign', coverage: 'in-scope', freshness: 'polled', completeness: 'complete', foreignMarked: false, labelCount: 4 },
			{ runId: 'f-0001', sessionId: 'sess-foreign', kind: 'workflow', status: 'completed', ownership: 'foreign', coverage: 'foreign', freshness: 'polled', completeness: 'complete', foreignMarked: true, labelCount: 4 },
			{ runId: 'malformed', sessionId: 'malformed', kind: 'workflow', status: 'completed', ownership: 'foreign', coverage: 'in-scope', freshness: 'polled', completeness: 'unknown-shape', foreignMarked: false, labelCount: 4 },
		]);
	});

	test('a failed workflow run shows its error clamped to one line, with the FULL text kept on the tooltip', () => {
		// The real shape this regressed on: a workflow failure arrives as a multi-line stack trace whose frames are
		// bundler paths. Rendered whole it wrapped to eight lines and pushed every run below it off screen.
		const stack = 'TelemetrySafeError: StructuredOutput retry cap (5) exceeded\n'
			+ '    at <anonymous> (B:/~BUN/root/src/entrypoints/cli.js:6072:2729)\n'
			+ '    at processTicksAndRejections (native:7:39)';
		const container = $('div');
		const list = store.add(new FleetRunsList(container));
		list.render([run({ runId: 'boom', status: 'failed', error: stack })]);

		const error = container.querySelector<HTMLElement>('.clawdius-workflows-error')!;
		// Present (never hidden - an invisible failure is the defect this view exists to prevent), summarised to the
		// one line that names the fault, and STILL complete on the tooltip: painted short, never known short.
		assert.deepStrictEqual(
			{ text: error.textContent, title: error.title, marked: error.hasAttribute('data-workflow-error') },
			{ text: 'TelemetrySafeError: StructuredOutput retry cap (5) exceeded', title: stack, marked: true });
	});

	test('errorSummary keeps the fault line and collapses the frames; a blank-led error never yields a blank row', () => {
		assert.deepStrictEqual([
			errorSummary('Error: CLAUDE_PLUGIN_ROOT is not defined\n    at <anonymous> (workflow.js:245:225)'),
			errorSummary('\n\n   Error:   spaced   out   \n    at frame'),
			errorSummary('single line'),
			errorSummary(''),
		], [
			'Error: CLAUDE_PLUGIN_ROOT is not defined',
			'Error: spaced out',
			'single line',
			'',
		]);
	});

	test('no runs -> an honest labeled empty state, never a crash', () => {
		const container = $('div');
		const list = store.add(new FleetRunsList(container));
		list.render([]);
		assert.strictEqual(container.getAttribute('data-clawdius-workflows'), '0');
		assert.strictEqual(container.querySelectorAll('.clawdius-workflows-row').length, 0);
		assert.strictEqual(container.querySelectorAll('[data-clawdius-workflows-empty]').length, 1);
	});
});

/** A subagent with the given id, fully labeled (defaults are the conservative enumeration labels). */
function subagent(id: string): WorkflowAgent {
	return { agentId: id, runId: 'r', agentType: 'workflow-subagent', finished: true, transcriptRef: 'file:///t.jsonl', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete };
}

suite('Clawdius Claude Code Ultracode Workflows - drill-in interactions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function run(id: string): WorkflowRun {
		return {
			runId: id, sessionId: id, name: id, status: 'completed', agentCount: 0, phases: [], progress: [],
			ownership: 'foreign',
			coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete,
			adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
		};
	}

	test('an interactive run row expands to its subagents; clicking one opens its transcript', async () => {
		const opened: string[] = [];
		const interactions: IFleetRowInteractions = {
			listAgents: async () => ({ agents: [subagent('sub-1'), subagent('sub-2')], completeness: CompletenessState.Complete }),
			openAgent: agent => { opened.push(agent.agentId); },
		};
		const container = $('div');
		const list = store.add(new FleetRunsList(container, interactions));
		list.render([run('a')]);

		const row = container.querySelector<HTMLElement>('.clawdius-workflows-row')!;
		// Expandable rows carry the twistie + the expanded hook; the run's four labels are still intact.
		assert.strictEqual(row.classList.contains('expandable'), true);
		assert.strictEqual(row.querySelectorAll('.clawdius-workflows-label').length, 4);
		row.click();
		// listSubagents resolves on a microtask; let it settle, then the two subagent rows are present.
		await Promise.resolve();
		await Promise.resolve();
		const subrows = container.querySelectorAll<HTMLElement>('.clawdius-workflows-subrow');
		assert.strictEqual(subrows.length, 2);
		subrows[1].click();
		assert.deepStrictEqual(opened, ['sub-2']);

		// A second click collapses the row - the subagent list is removed.
		row.click();
		assert.strictEqual(container.querySelectorAll('.clawdius-workflows-subrow').length, 0);
	});

	test('a render() while a subagent list is in flight discards the stale expansion (no detached rows, no leak)', async () => {
		let resolveList: (list: WorkflowAgentList) => void = () => { };
		const interactions: IFleetRowInteractions = {
			listAgents: () => new Promise<WorkflowAgentList>(res => { resolveList = res; }),
			openAgent: () => { },
		};
		const container = $('div');
		const list = store.add(new FleetRunsList(container, interactions));
		list.render([run('a')]);
		container.querySelector<HTMLElement>('.clawdius-workflows-row')!.click();
		// A full re-render tears the expanding row down before the list resolves.
		list.render([run('b')]);
		// The now-stale list resolves: the generation guard must drop it - no subagent rows, no listeners leaked.
		resolveList({ agents: [subagent('sub-1')], completeness: CompletenessState.Complete });
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(container.querySelectorAll('.clawdius-workflows-subrow').length, 0);
		assert.strictEqual(container.querySelectorAll('.clawdius-workflows-row').length, 1);
	});
});

// The temporary bridge: `listWorkflows`' new discriminated model is adapted to the legacy row shape so
// the render pipeline above renders identically on the real corpus. These tests pin exactly the fields `appendWorkflowRow` reads
// (name/status/agentCount/phases.length/error/coverage/freshness/completeness/ownership) - the bridge's contract.
suite('Clawdius Claude Code Ultracode Workflows - toMissionShape (validated-model view bridge)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const IDENTITY_BASE = {
		ownership: 'foreign' as const, coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled,
		completeness: CompletenessState.Complete, adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
	};

	test('a terminal run maps its name/status/cost/phases/error - exactly what the row renderer reads', () => {
		const terminal: TerminalWorkflowRun = {
			kind: 'terminal', sessionId: 's1', runId: 'wf_a', identity: workflowRunIdentity('s1', 'wf_a'),
			...IDENTITY_BASE,
			workflowName: 'audit-fleet', summary: 'ok', status: 'failed', error: 'script threw',
			durationMs: 100, totalTokens: 200, totalToolCalls: 3, agentCount: 2, defaultModel: 'opus',
			phases: [{ index: 0, title: 'Analyze', detail: 'one pass', agentCount: 2, errorCount: 1 }],
			agents: [],
		};
		const mapped = toMissionShape(terminal);
		assert.deepStrictEqual(
			{ name: mapped.name, status: mapped.status, agentCount: mapped.agentCount, phases: mapped.phases.length, error: mapped.error, coverage: mapped.coverage, freshness: mapped.freshness, completeness: mapped.completeness, ownership: mapped.ownership },
			{ name: 'audit-fleet', status: 'failed', agentCount: 2, phases: 1, error: 'script threw', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete, ownership: 'foreign' });
	});

	test('a terminal run with no workflowName falls back to the runId as its display name', () => {
		const terminal: TerminalWorkflowRun = {
			kind: 'terminal', sessionId: 's1', runId: 'wf_b', identity: workflowRunIdentity('s1', 'wf_b'),
			...IDENTITY_BASE, status: 'completed', phases: [], agents: [{ agentId: 'a1', label: 'x', state: 'done' }, { agentId: 'a2', label: 'y', state: 'done' }],
		};
		const mapped = toMissionShape(terminal);
		// A missing manifest agentCount stays undefined (rendered as a dash), NEVER fabricated from the validated
		// agents' length - the declared count and the count of readable agents are different facts.
		assert.deepStrictEqual({ name: mapped.name, agentCount: mapped.agentCount }, { name: 'wf_b', agentCount: undefined });
	});

	test('a live run maps to status "running" with started/result counts, no phases, no error', () => {
		const live: LiveWorkflowRun = {
			kind: 'live', sessionId: 's1', runId: 'wf_c', identity: workflowRunIdentity('s1', 'wf_c'),
			...IDENTITY_BASE, freshness: FreshnessLabel.Live,
			startedCount: 3, resultCount: 1, landedResults: [], journalLastWriteTime: 12345,
		};
		const mapped = toMissionShape(live);
		assert.deepStrictEqual(
			{ name: mapped.name, status: mapped.status, agentCount: mapped.agentCount, startedCount: mapped.startedCount, resultCount: mapped.resultCount, phases: mapped.phases, error: mapped.error },
			{ name: 'wf_c', status: 'running', agentCount: 3, startedCount: 3, resultCount: 1, phases: [], error: undefined });
	});

	test('an unrecognized run maps to status "unknown" with no declared agent count and no phases', () => {
		const unrecognized: UnrecognizedWorkflowRun = {
			kind: 'unknown-shape', sessionId: 's1', runId: 'wf_d', identity: workflowRunIdentity('s1', 'wf_d'),
			ownership: 'foreign', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled,
			completeness: CompletenessState.UnknownShape, adapterVersion: { format: 'transcript-jsonl', versionKey: 'unknown-shape' },
		};
		const mapped = toMissionShape(unrecognized);
		assert.deepStrictEqual(
			{ name: mapped.name, status: mapped.status, agentCount: mapped.agentCount, phases: mapped.phases, completeness: mapped.completeness },
			{ name: 'wf_d', status: 'unknown', agentCount: undefined, phases: [], completeness: CompletenessState.UnknownShape });
	});

	test('every mapped shape renders identically through the SAME row renderer the pre-bridge model used', () => {
		const terminal: TerminalWorkflowRun = {
			kind: 'terminal', sessionId: 's1', runId: 'wf_e', identity: workflowRunIdentity('s1', 'wf_e'),
			...IDENTITY_BASE, workflowName: 'demo', status: 'completed', agentCount: 5,
			phases: [{ index: 0, title: 'p1', agentCount: 5, errorCount: 0 }, { index: 1, title: 'p2', agentCount: 0, errorCount: 0 }],
			agents: [],
		};
		const container = $('div');
		const list = store.add(new FleetRunsList(container));
		list.render([toMissionShape(terminal)]);
		assert.deepStrictEqual(rowsOf(container), [
			// labelCount is 5, not the usual 4: this fixture has phases (2), so the row renderer adds the
			// "phases: N" label on top of the four always-present ones (agents/freshness/completeness/ownership).
			{ runId: 'wf_e', sessionId: 's1', kind: 'workflow', status: 'completed', ownership: 'foreign', coverage: 'in-scope', freshness: 'polled', completeness: 'complete', foreignMarked: false, labelCount: 5 },
		]);
	});
});
// CLAWDIUS-END
