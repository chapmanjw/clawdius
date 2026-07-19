/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - detail drill-in editor input (RESULT / AGENT)
// A read-only, discriminated EditorInput for the two read-only drill-in panes an expanded completed run opens: the
// run's FULL result (`kind: 'result'`) and one agent's DETAIL - cost, error, prompt/result previews
// (`kind: 'agent'`). Unlike the transcript drill-in (which re-reads live through the seam on every open, see
// claudeWorkflowTranscriptInput.ts), a completed run's result and an agent's recorded detail are IMMUTABLE - the
// tree already holds every field in memory off the SAME `listWorkflows` read that painted the row, so this input
// carries a SNAPSHOT of the rendered fields rather than a handle to re-read. That snapshot is also what makes the
// editor restorable across a workbench restart with no seam re-read (see the serializer below) - there is no
// `listWorkflowAgents`/`readWorkflowResult` seam method to restore through (no such method exists; see the
// reader-seam overview), so re-rendering from the snapshot is the only restore path available and is CORRECT for
// content that cannot change once the run terminated.

import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { WorkflowTranscriptRef } from '../../common/claudeWorkflowModel.js';

const ClaudeWorkflowResultDetailIcon = registerIcon('clawdius-workflow-result-detail-icon', Codicon.output, localize('clawdius.workflows.resultDetailIcon', "Icon of a Claude Code workflow run's full result."));
const ClaudeWorkflowAgentDetailIcon = registerIcon('clawdius-workflow-agent-detail-icon', Codicon.robot, localize('clawdius.workflows.agentDetailIcon', "Icon of a Claude Code workflow agent's detail."));

/** The RESULT variant's snapshot: the bounded/summary fields a completed run's story leaf already renders, plus
 *  the FULL `resultText` (the story leaf only ever shows `resultPreview`). Every field mirrors
 *  `TerminalWorkflowRun` (see claudeWorkflowModel.ts) - never a second, divergent shape. */
export interface ClaudeWorkflowResultDetailPayload {
	readonly kind: 'result';
	/** The owning run's composite identity (`workflowRunIdentity(sessionId, runId)`) - the dedupe/resource key. */
	readonly identity: string;
	readonly runId: string;
	readonly workflowName?: string;
	readonly status: 'completed' | 'failed';
	readonly durationMs?: number;
	readonly totalTokens?: number;
	readonly totalToolCalls?: number;
	readonly defaultModel?: string;
	readonly agentCount?: number;
	/** The full result as plain text - textContent-safe (see `TerminalWorkflowRun.resultText`), never innerHTML. */
	readonly resultText?: string;
}

/** The AGENT variant's snapshot: one `TerminalWorkflowAgent`'s fields, unpacked (never re-derived or fabricated -
 *  a field absent on the source agent stays absent here). `transcriptRef` rides along so the AGENT-DETAIL pane can
 *  offer to open the transcript - withheld (undefined) exactly when the tree's own row withheld it. */
export interface ClaudeWorkflowAgentDetailPayload {
	readonly kind: 'agent';
	/** The owning run's composite identity - half of the dedupe/resource key (the other half is `agentId`). */
	readonly identity: string;
	readonly runId: string;
	readonly agentId: string;
	readonly label: string;
	readonly state: 'done' | 'error';
	readonly model?: string;
	readonly tokens?: number;
	readonly toolCalls?: number;
	readonly durationMs?: number;
	readonly promptPreview?: string;
	readonly resultPreview?: string;
	/** The authoritative failure text on `state: 'error'` - shown honestly, never fabricated when absent. */
	readonly error?: string;
	/** Present only when the tree's own identity join succeeded for this agent; the AGENT-DETAIL pane's "Open
	 *  Transcript" action is withheld whenever this is undefined. */
	readonly transcriptRef?: WorkflowTranscriptRef;
}

export type ClaudeWorkflowDetailPayload = ClaudeWorkflowResultDetailPayload | ClaudeWorkflowAgentDetailPayload;

/** Bound on the run RESULT text this pane displays AND persists. The seam bounds only `resultPreview` (see
 *  `RESULT_PREVIEW_MAX_CHARS` in claudeReaderSeamService.ts) - `resultText` itself is whatever the manifest
 *  recorded, which can be large (a structured workflow return serialized to JSON reaches ~1M chars on the real
 *  corpus). The bound is applied at payload-BUILD time ({@link boundResultText}, called by the view) so a freshly
 *  opened tab and its persisted-then-restored copy render IDENTICALLY, and so a single non-virtualized `textContent`
 *  node never has to lay out ~1M chars (which janks the pane). Truncation is signalled by the trailing ellipsis. */
export const DETAIL_RESULT_MAX_CHARS = 100_000;
/** Bound on the agent free-text fields (`promptPreview` / `resultPreview` / `error`) in a persisted snapshot -
 *  smaller than {@link DETAIL_RESULT_MAX_CHARS} since these are already launcher-authored previews or a single
 *  failure message, not a whole run result; capped defensively since the seam does not bound them itself. */
export const DETAIL_SNAPSHOT_FIELD_MAX_CHARS = 4_000;

/** Bound `text` to AT MOST `max` characters total, the last being an ellipsis when truncated (so the returned
 *  length never exceeds `max`). */
function capText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Bound a run's `resultText` to {@link DETAIL_RESULT_MAX_CHARS} for display + persistence. Applied by the view
 *  when it builds the RESULT payload, so the live tab and its restored copy carry the SAME bounded text. */
export function boundResultText(resultText: string | undefined): string | undefined {
	return resultText === undefined ? undefined : capText(resultText, DETAIL_RESULT_MAX_CHARS);
}

/** Cap the free-text fields of a payload for PERSISTED storage only - see the two bounds above. Leaves a payload
 *  under the bound untouched (no copy), so the common case never allocates. */
function capPayloadForSnapshot(payload: ClaudeWorkflowDetailPayload): ClaudeWorkflowDetailPayload {
	if (payload.kind === 'result') {
		return payload.resultText === undefined || payload.resultText.length <= DETAIL_RESULT_MAX_CHARS
			? payload
			: { ...payload, resultText: capText(payload.resultText, DETAIL_RESULT_MAX_CHARS) };
	}
	return {
		...payload,
		promptPreview: payload.promptPreview !== undefined ? capText(payload.promptPreview, DETAIL_SNAPSHOT_FIELD_MAX_CHARS) : undefined,
		resultPreview: payload.resultPreview !== undefined ? capText(payload.resultPreview, DETAIL_SNAPSHOT_FIELD_MAX_CHARS) : undefined,
		error: payload.error !== undefined ? capText(payload.error, DETAIL_SNAPSHOT_FIELD_MAX_CHARS) : undefined,
	};
}

export class ClaudeWorkflowDetailInput extends EditorInput {

	static readonly ID = 'workbench.input.clawdiusWorkflowDetail';

	constructor(readonly payload: ClaudeWorkflowDetailPayload) {
		super();
	}

	override get typeId(): string {
		return ClaudeWorkflowDetailInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// Read-only: a completed run's result / an agent's detail is an immutable snapshot; this pane never writes.
		return EditorInputCapabilities.Readonly;
	}

	// Dedupes per (run identity, variant, agentId): a result tab keys off the run identity alone; an agent tab
	// additionally keys off its agentId, so two agents on the same run never collapse to one tab.
	readonly resource = URI.from({
		scheme: 'clawdius-workflow-detail',
		path: this.payload.kind === 'agent' ? `${this.payload.identity}/agent/${this.payload.agentId}` : `${this.payload.identity}/result`,
	});

	override getName(): string {
		if (this.payload.kind === 'agent') {
			return localize('clawdius.workflows.detail.agentTabName', "Agent: {0}", this.payload.label);
		}
		return localize('clawdius.workflows.detail.resultTabName', "Result: {0}", this.payload.workflowName ?? this.payload.runId);
	}

	override getIcon(): ThemeIcon {
		return this.payload.kind === 'agent' ? ClaudeWorkflowAgentDetailIcon : ClaudeWorkflowResultDetailIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) { return true; }
		if (!(other instanceof ClaudeWorkflowDetailInput)) { return false; }
		const a = this.payload;
		const b = other.payload;
		if (a.kind !== b.kind) { return false; }
		if (a.kind === 'agent' && b.kind === 'agent') {
			return a.identity === b.identity && a.agentId === b.agentId;
		}
		return a.identity === b.identity;
	}
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** A present value must be a string; absent is allowed. False only when present-but-not-string. */
function okOptStr(v: unknown): boolean { return v === undefined || typeof v === 'string'; }
/** A present value must be a finite number; absent is allowed. False only when present-but-not-a-finite-number. */
function okOptNum(v: unknown): boolean { return v === undefined || (typeof v === 'number' && Number.isFinite(v)); }
/** Drop `undefined`-valued keys, so a validated reconstruction round-trips to the SAME shape a JSON serialize/parse
 *  produces (which omits absent optionals) rather than one carrying explicit `undefined` keys. No `any`. */
function compact<T extends object>(o: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(o as Record<string, unknown>)) {
		if (value !== undefined) { out[key] = value; }
	}
	return out as T;
}

/**
 * Validate a deserialized detail payload field-by-field, returning a CLEAN reconstructed payload (only the known,
 * correctly-typed fields) or `undefined` when any required field is missing/mistyped, any present optional field is
 * mistyped, or the nested `transcriptRef` is malformed. This is the same validate-don't-cast posture the reader seam
 * takes for on-disk data, applied to the workbench-storage memento a restart replays (which can be stale across a
 * version change or corrupted): a malformed payload restores NO tab rather than a fabricated/garbage one, and a
 * bad `transcriptRef` can never mint an "Open Transcript" action.
 */
function validateDetailPayload(parsed: unknown): ClaudeWorkflowDetailPayload | undefined {
	if (!isObject(parsed) || typeof parsed.identity !== 'string' || typeof parsed.runId !== 'string') { return undefined; }
	if (parsed.kind === 'result') {
		if (parsed.status !== 'completed' && parsed.status !== 'failed') { return undefined; }
		if (!okOptStr(parsed.workflowName) || !okOptStr(parsed.defaultModel) || !okOptStr(parsed.resultText)) { return undefined; }
		if (!okOptNum(parsed.durationMs) || !okOptNum(parsed.totalTokens) || !okOptNum(parsed.totalToolCalls) || !okOptNum(parsed.agentCount)) { return undefined; }
		const result: ClaudeWorkflowResultDetailPayload = {
			kind: 'result', identity: parsed.identity, runId: parsed.runId, status: parsed.status,
			workflowName: parsed.workflowName as string | undefined, defaultModel: parsed.defaultModel as string | undefined,
			durationMs: parsed.durationMs as number | undefined, totalTokens: parsed.totalTokens as number | undefined,
			totalToolCalls: parsed.totalToolCalls as number | undefined, agentCount: parsed.agentCount as number | undefined,
			resultText: parsed.resultText as string | undefined,
		};
		return compact(result);
	}
	if (parsed.kind === 'agent') {
		if (typeof parsed.agentId !== 'string' || typeof parsed.label !== 'string') { return undefined; }
		if (parsed.state !== 'done' && parsed.state !== 'error') { return undefined; }
		if (!okOptStr(parsed.model) || !okOptStr(parsed.promptPreview) || !okOptStr(parsed.resultPreview) || !okOptStr(parsed.error)) { return undefined; }
		if (!okOptNum(parsed.tokens) || !okOptNum(parsed.toolCalls) || !okOptNum(parsed.durationMs)) { return undefined; }
		let transcriptRef: WorkflowTranscriptRef | undefined;
		if (parsed.transcriptRef !== undefined) {
			const ref = parsed.transcriptRef;
			if (!isObject(ref) || typeof ref.sessionId !== 'string' || typeof ref.runId !== 'string' || typeof ref.agentId !== 'string') { return undefined; }
			transcriptRef = { sessionId: ref.sessionId, runId: ref.runId, agentId: ref.agentId };
		}
		const agent: ClaudeWorkflowAgentDetailPayload = {
			kind: 'agent', identity: parsed.identity, runId: parsed.runId, agentId: parsed.agentId, label: parsed.label,
			state: parsed.state, model: parsed.model as string | undefined, tokens: parsed.tokens as number | undefined,
			toolCalls: parsed.toolCalls as number | undefined, durationMs: parsed.durationMs as number | undefined,
			promptPreview: parsed.promptPreview as string | undefined, resultPreview: parsed.resultPreview as string | undefined,
			error: parsed.error as string | undefined, transcriptRef,
		};
		return compact(agent);
	}
	return undefined;
}

// The detail drill-in input round-trips its rendered-field SNAPSHOT (never a stored URI, never re-read through
// the seam on restore - see the file-level doc for why a snapshot is correct here). Free-text fields are capped
// for persisted storage only (`capPayloadForSnapshot`); a freshly opened tab in the current window is never capped.
// The restored JSON is VALIDATED field-by-field (`validateDetailPayload`), never cast: a malformed memento restores
// no tab.
export class ClaudeWorkflowDetailInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(input: EditorInput): string {
		return JSON.stringify(capPayloadForSnapshot((input as ClaudeWorkflowDetailInput).payload));
	}
	deserialize(_instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const payload = validateDetailPayload(JSON.parse(serialized));
			return payload ? new ClaudeWorkflowDetailInput(payload) : undefined;
		} catch {
			return undefined;
		}
	}
}
// CLAWDIUS-END
