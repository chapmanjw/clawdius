/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - transcript drill-in EditorPane
// A native-DOM EditorPane (no webview => zero-egress; pattern: claudeControlCenterEditor) that opens a workflow
// agent's REAL on-disk transcript in the editor area. It reads ONLY through the shipped seam, by IDENTITY
// (`readWorkflowAgentTranscript(root, ref)` - the sessionId/runId/agentId triple the input carries, NEVER a
// stored path/URI), which returns a labeled slice (the record types in view + the four honesty labels + each
// record's message-content body, projected to plain text). The seam re-derives the on-disk path from those
// identities on every call, which is what closes the URI-serialization disclosure seam a stored path would
// otherwise reopen on restore - see claudeWorkflowTranscriptInput.ts for the identity-migration + legacy-restore
// detail. The identity-only contract extends to the body too: `ClaudeWorkflowTranscriptInput` still carries only
// the identity triple, so a restored tab is never a stale/serialized copy of message content - the body is always
// a fresh read off local disk at `setInput` time. The drill-in read's completeness runs the out-of-band tool-result
// probe, so a transcript referencing a missing out-of-band file paints `partial`, not `complete` - the label is
// rendered honestly, never fabricated up to complete, and a missing oob ref never fabricates body content either.
// The body renders as sanitized Markdown (`renderMarkdown`, never raw innerHTML) inside the shared bordered
// `.clawdius-workflow-artifact` container (claudeWorkflows.css) so a record's real content reads as the run's own
// document, not Clawdius's UI - never the literal `## heading` / unrendered Markdown syntax a plain `textContent`
// assignment used to show. The header + record rows carry `data-*` hooks (the RAW honesty-label values, e.g.
// `data-clawdius-transcript-completeness="partial"`) so the real-build render can assert the completeness label +
// record count; the badges' own DISPLAYED text goes through the plain-English mapping in claudeWorkflowTree.ts
// (`describeCompletenessLabel`/`describeCoverageLabel`/`describeFreshnessLabel`) instead of the raw value.

import './media/claudeWorkflows.css';
import { $, append, clearNode, Dimension, size } from '../../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { FleetTranscriptSlice } from '../../common/claudeFleetModel.js';
import { resolveConfigRoot } from '../../common/claudeReaderSeam.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';
import { describeCompletenessLabel, describeCoverageLabel, describeFreshnessLabel } from './claudeWorkflowTree.js';
import { ClaudeWorkflowTranscriptInput } from './claudeWorkflowTranscriptInput.js';

/**
 * Render a labeled subagent transcript slice into a container: a header carrying the coverage / freshness labels
 * (always shown) and the completeness label (EXCEPTION-ONLY - omitted for `complete`, mirroring the run row's own
 * completeness chip) - each as a plain-English badge AND a `data-*` hook carrying the RAW value - plus the record
 * count, then one row per record - its type, a subagent marker for sidechain records, and its message body
 * underneath. The body renders as sanitized Markdown (never innerHTML) inside the shared bordered
 * `.clawdius-workflow-artifact` container when the record's projected body is non-empty; a record with an EMPTY
 * projected body gets an explicit, muted `.clawdius-transcript-record-body-empty` placeholder instead of a bare
 * head with nothing beneath it - a bare head alone is what made two consecutive empty-bodied records read as one
 * duplicated header (see PROBLEM 4 in the pixel-review pass). Pure over its inputs (no services, no IO) other than
 * the markdown renderer, so a unit test can drive it directly. `partial` completeness is rendered exactly as the
 * seam labeled it, never quietly promoted to `complete`. Returns the render's own disposables (the markdown
 * renderer's, one per non-empty body) for the caller to own.
 */
export function renderTranscriptSlice(container: HTMLElement, slice: FleetTranscriptSlice): IDisposable {
	clearNode(container);
	// The honest projection the real-build render asserts: the completeness label + the record count + the subagent id.
	container.setAttribute('data-clawdius-transcript-subagent', slice.subagentId);
	container.setAttribute('data-clawdius-transcript-completeness', slice.completeness);
	container.setAttribute('data-clawdius-transcript-coverage', slice.coverage);
	container.setAttribute('data-clawdius-transcript-freshness', slice.freshness);
	container.setAttribute('data-clawdius-transcript-records', String(slice.records.length));

	const header = append(container, $('.clawdius-transcript-header'));
	append(header, $('.clawdius-transcript-title')).textContent = slice.subagentId
		? localize('clawdius.transcript.title', "Subagent transcript: {0}", slice.subagentId)
		: localize('clawdius.transcript.titleRoot', "Subagent transcript");
	const labels = append(header, $('.clawdius-transcript-labels'));
	const completenessLabel = describeCompletenessLabel(slice.completeness);
	if (completenessLabel !== undefined) {
		append(labels, $(`.clawdius-transcript-label.completeness-${slice.completeness}`, undefined, completenessLabel));
	}
	append(labels, $(`.clawdius-transcript-label.coverage-${slice.coverage}`, undefined, describeCoverageLabel(slice.coverage)));
	append(labels, $(`.clawdius-transcript-label.freshness-${slice.freshness}`, undefined, describeFreshnessLabel(slice.freshness)));

	const store = new DisposableStore();
	const list = append(container, $('.clawdius-transcript-records'));
	if (slice.records.length === 0) {
		append(list, $('.clawdius-transcript-empty', { 'data-clawdius-transcript-empty': 'true' })).textContent =
			localize('clawdius.transcript.empty', "No transcript records in view.");
		return store;
	}
	for (const rec of slice.records) {
		const row = append(list, $(`.clawdius-transcript-record${rec.isSidechain ? '.sidechain' : ''}`, {
			'data-record-type': rec.type,
			'data-sidechain': String(rec.isSidechain),
		}));
		const head = append(row, $('.clawdius-transcript-record-head'));
		append(head, $('.clawdius-transcript-record-type')).textContent = rec.type;
		if (rec.isSidechain) {
			append(head, $('.clawdius-transcript-record-badge')).textContent = localize('clawdius.transcript.sidechain', "subagent");
		}
		// Sanitized Markdown (`renderMarkdown`, never innerHTML), inside the shared bordered artifact container -
		// combined on this SAME element (never nested), matching the run RESULT body's treatment. `breaks: true` so
		// the author's own line breaks are preserved without an ancestor `white-space: pre-wrap`, which would
		// double up on Markdown's own paragraph spacing (see the CSS comment on `.clawdius-transcript-record-body`).
		// A record with no readable content (e.g. a bare `summary` line) gets an explicit, MUTED placeholder instead
		// of a bare head with nothing beneath it - a bare head alone is what made two such records back-to-back read
		// as one duplicated, empty header; the placeholder also keeps this row visually distinct from a genuinely
		// empty artifact box (never a stray blank one).
		if (rec.body) {
			const bodyEl = append(row, $('.clawdius-transcript-record-body.clawdius-workflow-artifact'));
			const rendered = store.add(renderMarkdown(new MarkdownString(rec.body), { markedOptions: { breaks: true } }));
			rendered.element.classList.add('clawdius-workflow-detail-markdown');
			append(bodyEl, rendered.element);
		} else {
			append(row, $('.clawdius-transcript-record-body-empty')).textContent =
				localize('clawdius.transcript.recordEmpty', "No message content");
		}
	}
	return store;
}

/** The transcript drill-in editor pane: reads a subagent's transcript through the seam and renders it, honestly
 *  completeness-labeled. Read-only + zero-egress (native DOM, local seam read). */
export class ClaudeWorkflowTranscriptEditor extends EditorPane {

	static readonly ID = 'workbench.editor.clawdiusWorkflowTranscript';

	private container!: HTMLElement;
	private content: HTMLElement | undefined;
	private readonly seam: ClawdiusReaderSeamService;
	private readonly renderStore = this._register(new DisposableStore());
	private disposed = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IPathService private readonly pathService: IPathService,
	) {
		super(ClaudeWorkflowTranscriptEditor.ID, group, telemetryService, themeService, storageService);
		// The seam service is not a registered singleton; instantiate it (teams probe off) so the pane reads through
		// the SAME seam path the enumeration + unit tests exercise. It is stateless + read-only (not a disposable).
		this.seam = instantiationService.createInstance(ClawdiusReaderSeamService, false);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.clawdius-transcript'));
		this.container.tabIndex = -1;
	}

	override async setInput(input: ClaudeWorkflowTranscriptInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const home = await this.pathService.userHome();
		if (token.isCancellationRequested || this.disposed) { return; }
		const root = resolveConfigRoot(undefined, home);
		// Read by IDENTITY (sessionId/runId/agentId), never a stored path: the seam re-derives the on-disk path
		// under the resolved root on every call, so a restored tab can never redirect the read elsewhere. Honest
		// on failure: a legacy-restored ref with no sessionId degrades to the seam's own absent/out-of-scope
		// slice rather than throwing, exactly like any other unreadable transcript.
		const slice = await this.seam.readWorkflowAgentTranscript(root, input.ref);
		if (token.isCancellationRequested || this.disposed) { return; }
		this.render(slice);
	}

	private render(slice: FleetTranscriptSlice): void {
		if (!this.container || this.disposed) { return; }
		this.renderStore.clear();
		if (!this.content) {
			this.content = append(this.container, $('.clawdius-transcript-inner'));
		} else {
			clearNode(this.content);
		}
		this.renderStore.add(renderTranscriptSlice(this.content, slice));
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
