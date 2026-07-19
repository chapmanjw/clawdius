/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - detail drill-in EditorPane (RESULT / AGENT)
// A native-DOM EditorPane (no webview => zero-egress) that renders the discriminated
// `ClaudeWorkflowDetailInput` payload: a run's FULL result, or one agent's cost/error/preview detail. Unlike the
// transcript pane this does NO seam read on `setInput` - the payload is already a complete, immutable snapshot
// (see claudeWorkflowDetailInput.ts) - so `setInput` is synchronous rendering only. Every visible field goes
// through `textContent`, per the fork's rule that all rendered text is safe-via-textContent, never innerHTML.
// The two render functions are exported PURE (container + payload in, DOM out) so they are unit-testable without
// standing up the pane; the pane itself only wires the interactive "Open Transcript" action, which needs
// `IEditorService` the pure functions deliberately do not depend on.

import './media/claudeWorkflows.css';
import { $, append, clearNode, Dimension, size } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { formatTokenCount } from '../../../../../base/common/numbers.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { formatDuration } from '../usage/claudeUsageData.js';
import { DASH, orDash } from './claudeWorkflowTree.js';
import { ClaudeWorkflowAgentDetailPayload, ClaudeWorkflowDetailInput, ClaudeWorkflowDetailPayload, ClaudeWorkflowResultDetailPayload } from './claudeWorkflowDetailInput.js';
import { ClaudeWorkflowTranscriptInput } from './claudeWorkflowTranscriptInput.js';

function appendCostParts(container: HTMLElement, parts: readonly string[]): void {
	for (const part of parts) {
		if (container.childElementCount > 0) {
			append(container, $('span.clawdius-workflow-detail-sep', undefined, '·'));
		}
		append(container, $('span', undefined, part));
	}
}

/** One labeled free-text field row (Error / Prompt / Result): the value via `textContent` when present, the
 *  shared {@link DASH} literal when absent - never fabricated. `key` drives both the `data-*` test hook and a
 *  per-field CSS class (so the error row alone can be styled). */
function appendDetailField(container: HTMLElement, label: string, value: string | undefined, key: string): void {
	const row = append(container, $(`.clawdius-workflow-detail-field.clawdius-workflow-detail-field-${key}`));
	row.setAttribute('data-clawdius-detail-field', key);
	row.setAttribute('data-clawdius-detail-field-present', String(value !== undefined));
	append(row, $('.clawdius-workflow-detail-field-label', undefined, label));
	append(row, $('.clawdius-workflow-detail-field-value')).textContent = value ?? DASH;
}

/**
 * Render the RESULT variant: a run's title + status, its cost summary (dash for every missing number, never a
 * fabricated 0 - the same convention `describeStoryCostParts` uses), and the FULL `resultText` via `textContent`
 * in the scrollable body - falling back to the literal "No result recorded" when the run carried none. Pure: no
 * services, no disposables (there is nothing interactive in this variant).
 */
export function renderResultDetail(container: HTMLElement, payload: ClaudeWorkflowResultDetailPayload): void {
	clearNode(container);
	container.setAttribute('data-clawdius-detail-kind', 'result');
	container.setAttribute('data-clawdius-detail-status', payload.status);

	const header = append(container, $('.clawdius-workflow-detail-header'));
	append(header, $('.clawdius-workflow-detail-title')).textContent = payload.workflowName ?? payload.runId;
	append(header, $(`.clawdius-workflow-detail-status-badge.status-${payload.status}`, undefined, payload.status));

	const cost = append(container, $('.clawdius-workflow-detail-cost'));
	appendCostParts(cost, [
		orDash(payload.durationMs, formatDuration),
		orDash(payload.totalTokens, n => localize('clawdius.workflows.detail.tokens', "{0} tokens", formatTokenCount(n))),
		orDash(payload.totalToolCalls, n => localize('clawdius.workflows.detail.toolCalls', "{0} tool calls", n)),
		payload.defaultModel ?? DASH,
		orDash(payload.agentCount, n => localize('clawdius.workflows.detail.agentCount', "{0} agents", n)),
	]);

	const result = append(container, $('.clawdius-workflow-detail-result'));
	result.setAttribute('data-clawdius-detail-result', payload.resultText !== undefined ? 'present' : 'absent');
	result.textContent = payload.resultText ?? localize('clawdius.workflows.detail.noResult', "No result recorded");
}

/**
 * Render the AGENT variant: the agent's label + honest state (done/error), its cost summary, then its `error`
 * (the authoritative failure text), `promptPreview`, and `resultPreview` - each via `textContent` where PRESENT,
 * {@link DASH} where ABSENT, never fabricated. When `payload.transcriptRef` is defined an "Open Transcript"
 * button is rendered (withheld entirely otherwise, per the identity-join rule the tree's row already enforces);
 * clicking it invokes `onOpenTranscript` - the pane wires this to `IEditorService.openEditor`, kept out of this
 * pure function so it stays unit-testable without a running workbench. Returns the render's own disposables (the
 * button, when present) for the caller to own; an absent-transcript render returns an empty, harmless store.
 */
export function renderAgentDetail(container: HTMLElement, payload: ClaudeWorkflowAgentDetailPayload, onOpenTranscript: () => void): IDisposable {
	clearNode(container);
	container.setAttribute('data-clawdius-detail-kind', 'agent');
	container.setAttribute('data-clawdius-detail-state', payload.state);

	const header = append(container, $('.clawdius-workflow-detail-header'));
	append(header, $('.clawdius-workflow-detail-title')).textContent = payload.label;
	append(header, $(`.clawdius-workflow-detail-status-badge.status-${payload.state}`, undefined, payload.state));

	const cost = append(container, $('.clawdius-workflow-detail-cost'));
	appendCostParts(cost, [
		payload.model ?? DASH,
		orDash(payload.tokens, n => localize('clawdius.workflows.detail.tokens', "{0} tokens", formatTokenCount(n))),
		orDash(payload.toolCalls, n => localize('clawdius.workflows.detail.agentToolCalls', "{0} calls", n)),
		orDash(payload.durationMs, formatDuration),
	]);

	appendDetailField(container, localize('clawdius.workflows.detail.errorLabel', "Error"), payload.error, 'error');
	appendDetailField(container, localize('clawdius.workflows.detail.promptLabel', "Prompt"), payload.promptPreview, 'prompt');
	appendDetailField(container, localize('clawdius.workflows.detail.resultLabel', "Result"), payload.resultPreview, 'result');

	const store = new DisposableStore();
	if (payload.transcriptRef) {
		const actions = append(container, $('.clawdius-workflow-detail-actions'));
		const button = store.add(new Button(actions, { ...defaultButtonStyles }));
		button.label = localize('clawdius.workflows.detail.openTranscript', "Open Transcript");
		store.add(button.onDidClick(() => onOpenTranscript()));
		container.setAttribute('data-clawdius-detail-transcript', 'present');
	} else {
		container.setAttribute('data-clawdius-detail-transcript', 'absent');
	}
	return store;
}

/** The detail drill-in editor pane: renders the discriminated snapshot payload, no seam read (see the file doc).
 *  Read-only + zero-egress (native DOM, no IO of its own). */
export class ClaudeWorkflowDetailEditor extends EditorPane {

	static readonly ID = 'workbench.editor.clawdiusWorkflowDetail';

	private container!: HTMLElement;
	private content: HTMLElement | undefined;
	private readonly renderStore = this._register(new DisposableStore());
	private disposed = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(ClaudeWorkflowDetailEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.clawdius-workflow-detail'));
		this.container.tabIndex = -1;
	}

	override async setInput(input: ClaudeWorkflowDetailInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || this.disposed) { return; }
		this.render(input.payload);
	}

	private render(payload: ClaudeWorkflowDetailPayload): void {
		if (!this.container || this.disposed) { return; }
		this.renderStore.clear();
		// The pane ROOT carries the pane-level discriminant + state, so the pane is identifiable at its top element
		// (the inner content ALSO stamps these, alongside the kind-specific render attributes the unit tests assert).
		this.container.setAttribute('data-clawdius-detail-kind', payload.kind);
		if (payload.kind === 'agent') {
			this.container.setAttribute('data-clawdius-detail-state', payload.state);
			this.container.setAttribute('data-clawdius-detail-transcript', payload.transcriptRef ? 'present' : 'absent');
			this.container.removeAttribute('data-clawdius-detail-status');
		} else {
			this.container.setAttribute('data-clawdius-detail-status', payload.status);
			this.container.removeAttribute('data-clawdius-detail-state');
			this.container.removeAttribute('data-clawdius-detail-transcript');
		}
		if (!this.content) {
			this.content = append(this.container, $('.clawdius-workflow-detail-inner'));
		} else {
			clearNode(this.content);
		}
		if (payload.kind === 'result') {
			renderResultDetail(this.content, payload);
			return;
		}
		const ref = payload.transcriptRef;
		this.renderStore.add(renderAgentDetail(this.content, payload, () => {
			if (ref) {
				void this.editorService.openEditor(new ClaudeWorkflowTranscriptInput(ref), { pinned: true, revealIfOpened: true });
			}
		}));
	}

	override focus(): void {
		this.container?.focus();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			size(this.container, dimension.width, dimension.height);
		}
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}
// CLAWDIUS-END
