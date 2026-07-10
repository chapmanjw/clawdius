/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet - Sidebar view render tests
// The view layer honesty guarantee: the fleet binds to the seam's listRuns and renders EVERY enumerated run as a
// labeled row carrying its status + coverage/freshness/completeness/ownership as both a badge and a `data-*` hook;
// a foreign/suppressed run is rendered PRESENT-WITH-LABEL (marked, never omitted). Drives the
// SAME production code path the ViewPane uses (FleetRunsList over a fake IFleetRunSource), so the test needs no
// workbench host. Also covers the honest empty state (no runs -> a labeled empty row, never a crash).

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FleetRun, FleetSubagent } from '../../common/claudeFleetModel.js';
import { CompletenessState, CoverageLabel, FreshnessLabel, ReaderConfigRoot, ReaderScope } from '../../common/claudeReaderSeam.js';
import { FleetRunsList, IFleetRowInteractions, IFleetRunSource } from '../../browser/missions/claudeMissionsView.js';

/** A fake enumeration source: returns a fixed labeled list, so the view test binds to the SAME `listRuns` shape
 *  the seam produces without touching disk. */
class FakeRunSource implements IFleetRunSource {
	constructor(private readonly runs: readonly FleetRun[]) { }
	async listRuns(_root: ReaderConfigRoot, _scope?: ReaderScope): Promise<readonly FleetRun[]> {
		return this.runs;
	}
}

/** A fully-labeled FleetRun with the given overrides (defaults are the conservative enumeration labels). */
function run(overrides: Partial<FleetRun>): FleetRun {
	return {
		runId: 'r', sessionId: 's', kind: 'single', status: 'unknown', ownership: 'foreign',
		coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete,
		adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
		...overrides,
	};
}

/** Extract the honest projection each rendered row carries (its `data-*` hooks + the count of label badges), the
 *  view-layer analogue of the enumeration snapshot the enumeration tests assert. */
function rowsOf(container: HTMLElement): unknown[] {
	return [...container.querySelectorAll<HTMLElement>('.clawdius-missions-row')].map(el => ({
		runId: el.getAttribute('data-run-id'),
		sessionId: el.getAttribute('data-session-id'),
		kind: el.getAttribute('data-kind'),
		status: el.getAttribute('data-status'),
		ownership: el.getAttribute('data-ownership'),
		coverage: el.getAttribute('data-coverage'),
		freshness: el.getAttribute('data-freshness'),
		completeness: el.getAttribute('data-completeness'),
		foreignMarked: el.classList.contains('foreign'),
		labelCount: el.querySelectorAll('.clawdius-missions-label').length,
	}));
}

suite('Clawdius missions fleet - Sidebar view', () => {
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
		list.render(await source.listRuns(ROOT));

		// Every run present (the foreign run WITH its label, not omitted), each fully labeled with four
		// badges + all four honesty `data-*` hooks, and the foreign run visually marked.
		assert.strictEqual(container.getAttribute('data-clawdius-missions'), '3');
		assert.deepStrictEqual(rowsOf(container), [
			{ runId: 'a-0001', sessionId: 'sess-a', kind: 'single', status: 'unknown', ownership: 'foreign', coverage: 'in-scope', freshness: 'polled', completeness: 'complete', foreignMarked: false, labelCount: 4 },
			{ runId: 'f-0001', sessionId: 'sess-foreign', kind: 'single', status: 'unknown', ownership: 'foreign', coverage: 'foreign', freshness: 'polled', completeness: 'complete', foreignMarked: true, labelCount: 4 },
			{ runId: 'malformed', sessionId: 'malformed', kind: 'single', status: 'unknown', ownership: 'foreign', coverage: 'in-scope', freshness: 'polled', completeness: 'unknown-shape', foreignMarked: false, labelCount: 4 },
		]);
	});

	test('no runs -> an honest labeled empty state, never a crash', () => {
		const container = $('div');
		const list = store.add(new FleetRunsList(container));
		list.render([]);
		assert.strictEqual(container.getAttribute('data-clawdius-missions'), '0');
		assert.strictEqual(container.querySelectorAll('.clawdius-missions-row').length, 0);
		assert.strictEqual(container.querySelectorAll('[data-clawdius-missions-empty]').length, 1);
	});
});

/** A subagent with the given id, fully labeled (defaults are the conservative enumeration labels). */
function subagent(id: string): FleetSubagent {
	return { subagentId: id, parentRunId: 'r', transcriptRef: 'file:///t.jsonl', coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete };
}

suite('Clawdius missions fleet - drill-in interactions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function run(id: string): FleetRun {
		return {
			runId: id, sessionId: id, kind: 'single', status: 'unknown', ownership: 'foreign',
			coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete,
			adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
		};
	}

	test('an interactive run row expands to its subagents; clicking one opens its transcript', async () => {
		const opened: string[] = [];
		const interactions: IFleetRowInteractions = {
			listSubagents: async () => [subagent('sub-1'), subagent('sub-2')],
			openSubagent: sub => { opened.push(sub.subagentId); },
		};
		const container = $('div');
		const list = store.add(new FleetRunsList(container, interactions));
		list.render([run('a')]);

		const row = container.querySelector<HTMLElement>('.clawdius-missions-row')!;
		// Expandable rows carry the twistie + the expanded hook; the run's four labels are still intact.
		assert.strictEqual(row.classList.contains('expandable'), true);
		assert.strictEqual(row.querySelectorAll('.clawdius-missions-label').length, 4);
		row.click();
		// listSubagents resolves on a microtask; let it settle, then the two subagent rows are present.
		await Promise.resolve();
		await Promise.resolve();
		const subrows = container.querySelectorAll<HTMLElement>('.clawdius-missions-subrow');
		assert.strictEqual(subrows.length, 2);
		subrows[1].click();
		assert.deepStrictEqual(opened, ['sub-2']);

		// A second click collapses the row - the subagent list is removed.
		row.click();
		assert.strictEqual(container.querySelectorAll('.clawdius-missions-subrow').length, 0);
	});

	test('a render() while a subagent list is in flight discards the stale expansion (no detached rows, no leak)', async () => {
		let resolveList: (subs: readonly FleetSubagent[]) => void = () => { };
		const interactions: IFleetRowInteractions = {
			listSubagents: () => new Promise<readonly FleetSubagent[]>(res => { resolveList = res; }),
			openSubagent: () => { },
		};
		const container = $('div');
		const list = store.add(new FleetRunsList(container, interactions));
		list.render([run('a')]);
		container.querySelector<HTMLElement>('.clawdius-missions-row')!.click();
		// A full re-render tears the expanding row down before the list resolves.
		list.render([run('b')]);
		// The now-stale list resolves: the generation guard must drop it - no subagent rows, no listeners leaked.
		resolveList([subagent('sub-1')]);
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(container.querySelectorAll('.clawdius-missions-subrow').length, 0);
		assert.strictEqual(container.querySelectorAll('.clawdius-missions-row').length, 1);
	});
});
// CLAWDIUS-END
