/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - drill-in editor tests
// Unit coverage for the three read-only drill-in editors an expanded completed run opens: the discriminated
// ClaudeWorkflowDetailInput/Editor (the RESULT variant renders a run's full resultText; the AGENT variant renders
// one agent's honest cost/error/preview fields, dash-when-absent, never fabricated) and the transcript editor's
// migration to the identity model (WorkflowTranscriptRef instead of the legacy FleetSubagent - a stored path/URI
// is never round-tripped, the seam re-derives it from bare identities on every read). The headline backward-compat
// case: a tab persisted BEFORE the identity migration serialized a legacy FleetSubagent payload, and the
// deserializer must still open it into an honest absent read, never a crash.

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { FleetSubagent, FleetTranscriptSlice } from '../../common/claudeFleetModel.js';
import { CompletenessState, CoverageLabel, FreshnessLabel } from '../../common/claudeReaderSeam.js';
import { WorkflowTranscriptRef } from '../../common/claudeWorkflowModel.js';
import {
	ClaudeWorkflowAgentDetailPayload, ClaudeWorkflowDetailInput, ClaudeWorkflowDetailInputSerializer,
	ClaudeWorkflowResultDetailPayload, DETAIL_RESULT_MAX_CHARS,
} from '../../browser/workflows/claudeWorkflowDetailInput.js';
import { renderAgentDetail, renderResultDetail } from '../../browser/workflows/claudeWorkflowDetailEditor.js';
import { renderTranscriptSlice } from '../../browser/workflows/claudeWorkflowTranscriptEditor.js';
import { ClaudeWorkflowTranscriptInput, ClaudeWorkflowTranscriptInputSerializer } from '../../browser/workflows/claudeWorkflowTranscriptInput.js';

function resultPayload(overrides: Partial<ClaudeWorkflowResultDetailPayload> = {}): ClaudeWorkflowResultDetailPayload {
	return { kind: 'result', identity: 'run:s1:wf_a', runId: 'wf_a', status: 'completed', ...overrides };
}

function agentPayload(overrides: Partial<ClaudeWorkflowAgentDetailPayload> = {}): ClaudeWorkflowAgentDetailPayload {
	return { kind: 'agent', identity: 'run:s1:wf_a', runId: 'wf_a', agentId: 'a1', label: 'agent-1', state: 'done', ...overrides };
}

suite('Clawdius Claude Code Ultracode Workflows - result detail render', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders the full resultText via textContent, and the run title + status honestly', () => {
		const container = $('div');
		renderResultDetail(container, resultPayload({ resultText: 'line one\nline two', workflowName: 'audit-fleet' }));
		assert.deepStrictEqual({
			status: container.getAttribute('data-clawdius-detail-status'),
			title: container.querySelector('.clawdius-workflow-detail-title')?.textContent,
			resultPresent: container.querySelector('.clawdius-workflow-detail-result')?.getAttribute('data-clawdius-detail-result'),
			resultText: container.querySelector('.clawdius-workflow-detail-result')?.textContent,
		}, {
			status: 'completed', title: 'audit-fleet', resultPresent: 'present', resultText: 'line one\nline two',
		});
	});

	test('an absent result renders the literal "No result recorded" fallback, never a blank body', () => {
		const container = $('div');
		renderResultDetail(container, resultPayload({ resultText: undefined }));
		const result = container.querySelector('.clawdius-workflow-detail-result')!;
		assert.deepStrictEqual(
			{ present: result.getAttribute('data-clawdius-detail-result'), text: result.textContent },
			{ present: 'absent', text: 'No result recorded' });
	});

	test('every missing cost number is the dash literal, never a fabricated 0', () => {
		const container = $('div');
		renderResultDetail(container, resultPayload({
			durationMs: undefined, totalTokens: undefined, totalToolCalls: undefined, defaultModel: undefined, agentCount: undefined,
		}));
		const parts = Array.from(container.querySelectorAll('.clawdius-workflow-detail-cost span:not(.clawdius-workflow-detail-sep)')).map(el => el.textContent);
		assert.deepStrictEqual(parts, ['—', '—', '—', '—', '—']);
	});

	test('a failed run is labeled honestly, not painted over as completed', () => {
		const container = $('div');
		renderResultDetail(container, resultPayload({ status: 'failed' }));
		assert.strictEqual(container.getAttribute('data-clawdius-detail-status'), 'failed');
	});
});

suite('Clawdius Claude Code Ultracode Workflows - agent detail render', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('present fields render via textContent; absent fields render the dash literal, never fabricated', () => {
		const container = $('div');
		store.add(renderAgentDetail(container, agentPayload({
			model: 'opus', tokens: 100, toolCalls: 2, durationMs: 5000,
			promptPreview: 'do the thing', resultPreview: undefined, error: undefined,
		}), () => { }));
		const field = (key: string) => container.querySelector(`[data-clawdius-detail-field="${key}"] .clawdius-workflow-detail-field-value`)?.textContent;
		assert.deepStrictEqual({
			state: container.getAttribute('data-clawdius-detail-state'),
			prompt: field('prompt'), result: field('result'), error: field('error'),
		}, { state: 'done', prompt: 'do the thing', result: '—', error: '—' });
	});

	test('an errored agent shows its authoritative error text honestly, never suppressed', () => {
		const container = $('div');
		store.add(renderAgentDetail(container, agentPayload({ state: 'error', error: 'boom: script threw' }), () => { }));
		assert.deepStrictEqual({
			state: container.getAttribute('data-clawdius-detail-state'),
			error: container.querySelector('[data-clawdius-detail-field="error"] .clawdius-workflow-detail-field-value')?.textContent,
		}, { state: 'error', error: 'boom: script threw' });
	});

	test('an errored agent with an absent resultPreview reads its error in FULL (never clamped) and its result as a dash - never fabricated', () => {
		const container = $('div');
		const fullError = 'boom: script threw\n    at frame (workflow.js:12:3)';
		store.add(renderAgentDetail(container, agentPayload({ state: 'error', error: fullError, resultPreview: undefined }), () => { }));
		const field = (key: string) => container.querySelector(`[data-clawdius-detail-field="${key}"] .clawdius-workflow-detail-field-value`)?.textContent;
		assert.deepStrictEqual({
			state: container.getAttribute('data-clawdius-detail-state'),
			error: field('error'),
			result: field('result'),
		}, { state: 'error', error: fullError, result: '—' });
	});

	test('the "Open Transcript" action is withheld when transcriptRef is absent, present only when it is present', () => {
		const withoutRef = $('div');
		store.add(renderAgentDetail(withoutRef, agentPayload({ transcriptRef: undefined }), () => { }));
		const withRef = $('div');
		const ref: WorkflowTranscriptRef = { sessionId: 's1', runId: 'wf_a', agentId: 'a1' };
		store.add(renderAgentDetail(withRef, agentPayload({ transcriptRef: ref }), () => { }));
		assert.deepStrictEqual({
			without: { flag: withoutRef.getAttribute('data-clawdius-detail-transcript'), buttons: withoutRef.querySelectorAll('.monaco-button').length },
			with: { flag: withRef.getAttribute('data-clawdius-detail-transcript'), buttons: withRef.querySelectorAll('.monaco-button').length },
		}, {
			without: { flag: 'absent', buttons: 0 },
			with: { flag: 'present', buttons: 1 },
		});
	});
});

suite('Clawdius Claude Code Ultracode Workflows - detail input identity + serialization', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the detail input typeId is a new, stable string, distinct from the transcript editor typeId', () => {
		assert.strictEqual(ClaudeWorkflowDetailInput.ID, 'workbench.input.clawdiusWorkflowDetail');
	});

	test('matches dedupes a result tab by run identity; a different run is a distinct tab', () => {
		const a = store.add(new ClaudeWorkflowDetailInput(resultPayload({ identity: 'run:s1:wf_a' })));
		const bSame = store.add(new ClaudeWorkflowDetailInput(resultPayload({ identity: 'run:s1:wf_a', resultText: 'different content, same run' })));
		const cOther = store.add(new ClaudeWorkflowDetailInput(resultPayload({ identity: 'run:s1:wf_b' })));
		assert.deepStrictEqual([a.matches(bSame), a.matches(cOther)], [true, false]);
	});

	test('matches dedupes an agent tab by (run identity, agentId); a different agent on the SAME run is distinct', () => {
		const a = store.add(new ClaudeWorkflowDetailInput(agentPayload({ agentId: 'a1' })));
		const bSame = store.add(new ClaudeWorkflowDetailInput(agentPayload({ agentId: 'a1', label: 'renamed' })));
		const cOther = store.add(new ClaudeWorkflowDetailInput(agentPayload({ agentId: 'a2' })));
		assert.deepStrictEqual([a.matches(bSame), a.matches(cOther)], [true, false]);
	});

	test('a result tab and an agent tab on the same run never match each other', () => {
		const result = store.add(new ClaudeWorkflowDetailInput(resultPayload()));
		const agent = store.add(new ClaudeWorkflowDetailInput(agentPayload()));
		assert.strictEqual(result.matches(agent), false);
	});

	test('the serializer round-trips a result payload through the preserved typeId', () => {
		const input = store.add(new ClaudeWorkflowDetailInput(resultPayload({ resultText: 'a short result', workflowName: 'audit-fleet' })));
		const serializer = new ClaudeWorkflowDetailInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());
		const restored = store.add(serializer.deserialize(instantiationService, serializer.serialize(input))!);
		assert.ok(restored instanceof ClaudeWorkflowDetailInput);
		assert.deepStrictEqual(restored.payload, input.payload);
	});

	test('the serializer caps an oversized resultText in the persisted snapshot, never growing the memento unbounded', () => {
		const huge = 'x'.repeat(DETAIL_RESULT_MAX_CHARS + 500);
		const input = store.add(new ClaudeWorkflowDetailInput(resultPayload({ resultText: huge })));
		const serializer = new ClaudeWorkflowDetailInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());
		const restored = store.add(serializer.deserialize(instantiationService, serializer.serialize(input))!) as ClaudeWorkflowDetailInput;
		const restoredPayload = restored.payload as ClaudeWorkflowResultDetailPayload;
		assert.deepStrictEqual(
			{ capped: restoredPayload.resultText!.length <= DETAIL_RESULT_MAX_CHARS, endsWithEllipsis: restoredPayload.resultText!.endsWith('…') },
			{ capped: true, endsWithEllipsis: true });
	});

	test('an unrecognized serialized payload fails to deserialize rather than opening a guessed tab', () => {
		const serializer = new ClaudeWorkflowDetailInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());
		const parsed: unknown = { kind: 'nonsense' };
		assert.strictEqual(serializer.deserialize(instantiationService, JSON.stringify(parsed)), undefined);
	});

	test('a malformed persisted payload is rejected field-by-field, restoring no tab', () => {
		const serializer = new ClaudeWorkflowDetailInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());
		const de = (o: unknown) => serializer.deserialize(instantiationService, JSON.stringify(o));
		// RESULT: bad status enum / wrong-typed number / missing required identity all restore NOTHING.
		assert.strictEqual(de({ ...resultPayload(), status: 'weird' }), undefined);
		assert.strictEqual(de({ ...resultPayload(), totalTokens: 'lots' }), undefined);
		assert.strictEqual(de({ ...resultPayload(), identity: 42 }), undefined);
		// AGENT: bad state enum / missing required agentId / wrong-typed number.
		assert.strictEqual(de({ ...agentPayload(), state: 'paused' }), undefined);
		assert.strictEqual(de({ ...agentPayload(), agentId: undefined }), undefined);
		assert.strictEqual(de({ ...agentPayload(), tokens: 'many' }), undefined);
		// A malformed transcriptRef can NEVER mint an "Open Transcript" action (missing / non-string component).
		assert.strictEqual(de({ ...agentPayload(), transcriptRef: { sessionId: 's', runId: 'r' } }), undefined);
		assert.strictEqual(de({ ...agentPayload(), transcriptRef: { sessionId: 1, runId: 'r', agentId: 'a' } }), undefined);
	});

	test('a well-formed payload of each kind deserializes, and a valid transcriptRef survives intact', () => {
		const serializer = new ClaudeWorkflowDetailInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());
		const de = (o: unknown) => store.add(serializer.deserialize(instantiationService, JSON.stringify(o))!) as ClaudeWorkflowDetailInput;
		assert.ok(de(resultPayload()) instanceof ClaudeWorkflowDetailInput);
		const agent = de(agentPayload({ transcriptRef: { sessionId: 's1', runId: 'wf_r', agentId: 'a1' } }));
		assert.deepStrictEqual((agent.payload as ClaudeWorkflowAgentDetailPayload).transcriptRef, { sessionId: 's1', runId: 'wf_r', agentId: 'a1' });
	});
});

suite('Clawdius Claude Code Ultracode Workflows - transcript identity migration + backward compat', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const REF: WorkflowTranscriptRef = { sessionId: 'sess-1', runId: 'wf_run-1', agentId: 'agent-1' };

	test('the transcript editor typeId is unchanged by the identity migration', () => {
		assert.strictEqual(ClaudeWorkflowTranscriptInput.ID, 'workbench.input.clawdiusMissionTranscript');
	});

	test('the serializer round-trips the identity triple, never a stored URI', () => {
		const input = store.add(new ClaudeWorkflowTranscriptInput(REF));
		const serializer = new ClaudeWorkflowTranscriptInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());
		const restored = store.add(serializer.deserialize(instantiationService, serializer.serialize(input))!);
		assert.ok(restored instanceof ClaudeWorkflowTranscriptInput);
		assert.deepStrictEqual(restored.ref, REF);
	});

	test('a LEGACY FleetSubagent payload still deserializes to an openable input, named for the subagentId', () => {
		const legacy: FleetSubagent = {
			subagentId: 'sub-legacy-01', parentRunId: 'wf_legacy-run', transcriptRef: 'opaque-legacy-ref',
			coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete,
		};
		const serializer = new ClaudeWorkflowTranscriptInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());
		const restored = store.add(serializer.deserialize(instantiationService, JSON.stringify(legacy))!);
		assert.ok(restored instanceof ClaudeWorkflowTranscriptInput);
		assert.deepStrictEqual(
			{ ref: restored.ref, name: restored.getName() },
			{ ref: { sessionId: '', runId: 'wf_legacy-run', agentId: 'sub-legacy-01' }, name: 'Transcript: sub-legacy-01' });
	});

	test('a payload matching neither the new nor the legacy shape fails to deserialize', () => {
		const serializer = new ClaudeWorkflowTranscriptInputSerializer();
		const instantiationService = store.add(new TestInstantiationService());
		assert.strictEqual(serializer.deserialize(instantiationService, JSON.stringify({ totallyUnrelated: true })), undefined);
	});
});

suite('Clawdius Claude Code Ultracode Workflows - transcript record-kind index (pure render)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renderTranscriptSlice paints the record-kind index + sidechain markers, never a message body', () => {
		const slice: FleetTranscriptSlice = {
			subagentId: 'agent-1',
			records: [
				{ type: 'user', isSidechain: false },
				{ type: 'assistant', isSidechain: false },
				{ type: 'assistant', isSidechain: true },
			],
			coverage: CoverageLabel.InScope, freshness: FreshnessLabel.Polled, completeness: CompletenessState.Complete,
			adapterVersion: { format: 'transcript-jsonl', versionKey: 'v1' },
		};
		const container = $('div');
		renderTranscriptSlice(container, slice);
		assert.deepStrictEqual({
			recordCount: container.getAttribute('data-clawdius-transcript-records'),
			types: Array.from(container.querySelectorAll('.clawdius-transcript-record-type')).map(el => el.textContent),
			sidechainRows: container.querySelectorAll('.clawdius-transcript-record.sidechain').length,
		}, { recordCount: '3', types: ['user', 'assistant', 'assistant'], sidechainRows: 1 });
	});
});
// CLAWDIUS-END
