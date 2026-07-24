/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - detail drill-in EditorPane (RESULT / AGENT)
// A native-DOM EditorPane (no webview => zero-egress) that renders the discriminated
// `ClaudeWorkflowDetailInput` payload: a run's FULL result, or one agent's cost/error/preview detail. Unlike the
// transcript pane this does NO seam read on `setInput` - the payload is already a complete, immutable snapshot
// (see claudeWorkflowDetailInput.ts) - so `setInput` is synchronous rendering only. Every visible field is safe:
// a plain field (title, status, cost line, Error) goes through `textContent`; the RESULT body and the agent
// Result/Prompt fields go through `renderRichText` (below): a value that parses as a JSON object/array renders as a
// SECTIONED DOCUMENT (see `renderStructuredValue`) - each object field is a muted key label above its own value,
// arrays list their elements, string leaves render as sanitized Markdown (so `\n`/`#`/`*` become real prose, not a
// literal escaped-JSON blob), scalars as plain text, nesting indented, with a compact JSON block only as a
// depth/empty fallback; a JSON-SHAPED but truncated preview (invalid to parse) renders as one monospace JSON block;
// anything else renders as sanitized Markdown via the base `renderMarkdown` helper (safe DOM, never raw innerHTML) -
// never the literal `## heading` / `{"a":1}` blob the field carried on disk. The RESULT body is additionally wrapped in a bordered `.clawdius-workflow-artifact`
// container (see claudeWorkflows.css) so it reads as the RUN's own document, not Clawdius's own UI chrome. The two
// render functions are exported PURE (container + payload in, DOM + disposables out) so they are unit-testable
// without standing up the pane; the pane itself only wires the interactive "Open Transcript" action, which needs
// `IEditorService` the pure functions deliberately do not depend on. Every render function threads its own
// disposables (the markdown renderer's, when that branch is taken) back to the caller - `ClaudeWorkflowDetailEditor.render()`
// owns them via `renderStore`, the same pattern the button in the AGENT variant already used.

import './media/claudeWorkflows.css';
import { $, append, clearNode, Dimension, size } from '../../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { formatTokenCount } from '../../../../../base/common/numbers.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
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

/** One labeled PLAIN-text field row (Error): the value via `textContent` when present, the shared {@link DASH}
 *  literal when absent - never fabricated. `key` drives both the `data-*` test hook and a per-field CSS class (so
 *  the error row alone can be styled). Kept plain (never rich): a failure's authoritative text is a stack
 *  trace/message, not something that benefits from JSON pretty-printing or Markdown parsing. */
function appendDetailField(container: HTMLElement, label: string, value: string | undefined, key: string): void {
	const row = append(container, $(`.clawdius-workflow-detail-field.clawdius-workflow-detail-field-${key}`));
	row.setAttribute('data-clawdius-detail-field', key);
	row.setAttribute('data-clawdius-detail-field-present', String(value !== undefined));
	append(row, $('.clawdius-workflow-detail-field-label', undefined, label));
	append(row, $('.clawdius-workflow-detail-field-value')).textContent = value ?? DASH;
}

/** `text` parsed as a JSON OBJECT or ARRAY, else `undefined` - never a bare string/number/boolean/null, which
 *  reads better through the Markdown/plain-text path than as a pretty-printed scalar. */
function parseJsonStructure(text: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	return (typeof parsed === 'object' && parsed !== null) ? parsed : undefined;
}

/** Whether `text` LOOKS like a JSON object/array even when it does not actually PARSE as one - the case a
 *  Prompt/Result PREVIEW hits when the full value was truncated mid-structure (e.g. `{"synthesis":"# ...` cut off
 *  before its closing brace). {@link parseJsonStructure} legitimately returns `undefined` for that (it is not
 *  valid JSON), but falling all the way through to the Markdown renderer would paint the raw `{`/`"` noise in the
 *  proportional editor font as if it were prose. A cheap prefix check - never a second parse attempt - is enough
 *  to route it to the monospace JSON block instead (see {@link renderRichText}). */
function looksLikeJsonStructure(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/** The deepest the sectioned renderer descends before falling back to one compact JSON block, so a pathologically
 *  nested payload cannot produce an unbounded tower of indented sections. Set generously: real report payloads nest
 *  several levels (e.g. `{synthesis, verifications:[{area, verifications:[{item, status, note}]}]}`), and every level
 *  that falls back to compact JSON would re-introduce the raw escaped-`\n` blob this renderer exists to avoid. The
 *  persisted resultText is length-capped upstream (DETAIL_RESULT_MAX_CHARS), so total DOM stays bounded regardless. */
const MAX_STRUCTURE_DEPTH = 12;

/** Render a parsed JSON `value` as a readable SECTIONED document rather than a raw pretty-printed blob: a string
 *  renders as sanitized Markdown (so `\n` and `#`/`*` markup become real prose, never literal escapes); a scalar
 *  (number/boolean/null) renders as plain text; an array lists each element in an indented item; an object renders a
 *  muted key label per field above that field's own recursively rendered value. Past {@link MAX_STRUCTURE_DEPTH}, or
 *  for an empty array/object, it falls back to one compact monospace JSON block (via `textContent`, safe). Every
 *  markdown renderer's disposable lands in `store`, owned by the caller. */
function renderStructuredValue(container: HTMLElement, value: unknown, store: DisposableStore, depth: number): void {
	if (typeof value === 'string') {
		renderMarkdownBlock(container, store, value);
		return;
	}
	if (value === null || typeof value === 'number' || typeof value === 'boolean') {
		append(container, $('.clawdius-workflow-artifact-scalar')).textContent = String(value);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length === 0 || depth >= MAX_STRUCTURE_DEPTH) {
			append(container, $('pre.clawdius-workflow-detail-json')).textContent = JSON.stringify(value, null, 2);
			return;
		}
		for (const element of value) {
			renderStructuredValue(append(container, $('.clawdius-workflow-artifact-item')), element, store, depth + 1);
		}
		return;
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0 || depth >= MAX_STRUCTURE_DEPTH) {
		append(container, $('pre.clawdius-workflow-detail-json')).textContent = JSON.stringify(value, null, 2);
		return;
	}
	for (const [key, entry] of entries) {
		const section = append(container, $('.clawdius-workflow-artifact-section'));
		append(section, $('.clawdius-workflow-artifact-section-key')).textContent = key;
		renderStructuredValue(section, entry, store, depth + 1);
	}
}

/** Render `text` as sanitized Markdown into `container` (`breaks: true` so a plain-text value - a stack trace, a
 *  one-line result - still preserves its own line breaks visually, since without it a single newline would
 *  collapse to a space the way GitHub-flavored Markdown normally treats one), tagged with the shared
 *  `clawdius-workflow-detail-markdown` class, and its disposable added to `store`. Factored out so the
 *  sectioned-document branch and the plain-Markdown fallback in {@link renderRichText} share one render path. */
function renderMarkdownBlock(container: HTMLElement, store: DisposableStore, text: string): void {
	const rendered = store.add(renderMarkdown(new MarkdownString(text), { markedOptions: { breaks: true } }));
	rendered.element.classList.add('clawdius-workflow-detail-markdown');
	append(container, rendered.element);
}

/**
 * Render `text` richly into `container`:
 *  1. A value that parses as a JSON object or array (see {@link parseJsonStructure}) renders as a SECTIONED
 *     document via {@link renderStructuredValue} - object fields become muted key labels above their own values,
 *     arrays list their elements, string leaves render as sanitized Markdown, scalars as plain text - so a
 *     report-shaped result never degrades to one unreadable escaped-string JSON blob.
 *  2. A JSON-SHAPED but truncated preview (starts with `{`/`[` yet fails to parse - see {@link looksLikeJsonStructure})
 *     renders as one monospace `<pre>` (still via `textContent` - safe), never mistaken for Markdown prose.
 *  3. Otherwise, sanitized Markdown via the base `renderMarkdown` helper (safe DOM, never innerHTML -
 *     `MarkdownString`'s default `isTrusted: false` / `supportHtml: false` keep it sanitized).
 * Returns the render's own disposables (the markdown renderers', for branches 1 and 3) for the caller to own -
 * the truncated-preview branch (2) owns nothing.
 */
function renderRichText(container: HTMLElement, text: string): IDisposable {
	const structured = parseJsonStructure(text);
	if (structured !== undefined) {
		const store = new DisposableStore();
		renderStructuredValue(container, structured, store, 0);
		return store;
	}
	if (looksLikeJsonStructure(text)) {
		// A JSON-shaped PREVIEW that was truncated mid-structure (see looksLikeJsonStructure's doc comment) - the raw
		// text still reads far better as monospace JSON-ish content than as Markdown prose, even though it is not
		// valid JSON to parse into a sectioned document.
		append(container, $('pre.clawdius-workflow-detail-json')).textContent = text;
		return Disposable.None;
	}
	const store = new DisposableStore();
	renderMarkdownBlock(container, store, text);
	return store;
}

/** One labeled RICH field row (Prompt / Result on the agent variant): {@link renderRichText} when `value` is
 *  present, the shared {@link DASH} literal via `textContent` when absent - never fabricated. Markdown
 *  disposables land in `store`, owned by the caller (see the file's own render-function shape note). */
function appendRichDetailField(container: HTMLElement, label: string, value: string | undefined, key: string, store: DisposableStore): void {
	const row = append(container, $(`.clawdius-workflow-detail-field.clawdius-workflow-detail-field-${key}`));
	row.setAttribute('data-clawdius-detail-field', key);
	row.setAttribute('data-clawdius-detail-field-present', String(value !== undefined));
	append(row, $('.clawdius-workflow-detail-field-label', undefined, label));
	const valueEl = append(row, $('.clawdius-workflow-detail-field-value'));
	if (value === undefined) {
		valueEl.textContent = DASH;
		return;
	}
	store.add(renderRichText(valueEl, value));
}

/**
 * Render the RESULT variant: a run's title + status, its cost summary (dash for every missing number, never a
 * fabricated 0 - the same convention `describeRunMetaParts` uses), and the FULL `resultText` in the scrollable
 * body - a sectioned document, pretty-printed JSON, or sanitized Markdown via {@link renderRichText} (wrapped in a
 * bordered `.clawdius-workflow-artifact` container so it reads as the run's own document, not Clawdius's UI),
 * falling back to the literal "No result recorded" when the run carried none. Returns the render's own
 * disposables (the markdown renderer's, when that branch is taken) for the caller to own; an absent-result or
 * JSON render returns an empty, harmless store.
 */
export function renderResultDetail(container: HTMLElement, payload: ClaudeWorkflowResultDetailPayload): IDisposable {
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
	if (payload.resultText === undefined) {
		result.textContent = localize('clawdius.workflows.detail.noResult', "No result recorded");
		return Disposable.None;
	}
	const artifact = append(result, $('.clawdius-workflow-artifact'));
	return renderRichText(artifact, payload.resultText);
}

/**
 * Render the AGENT variant: the agent's label + honest state (done/error), its cost summary, then its `error`
 * (the authoritative failure text - PLAIN, via {@link appendDetailField}), `promptPreview`, and `resultPreview`
 * (RICH, via {@link appendRichDetailField} - pretty-printed JSON, a JSON-shaped-but-truncated preview, or sanitized
 * Markdown). The Error row is the ONE exception to "DASH where absent": it is withheld ENTIRELY when
 * `payload.error` is `undefined` (never a dash) - a passing agent has no failure text to show, and a bare "Error
 * —" row beside a DONE status previously read as a false alarm; Prompt/Result keep the ordinary present/{@link DASH}
 * convention. When `payload.transcriptRef` is defined an "Open Transcript" button is rendered (withheld entirely
 * otherwise, per the identity-join rule the tree's row already enforces); clicking it invokes `onOpenTranscript` -
 * the pane wires this to `IEditorService.openEditor`, kept out of this pure function so it stays unit-testable
 * without a running workbench. Returns the render's own disposables (the button, when present, plus any markdown
 * renderer the Prompt/Result fields used) for the caller to own; a plain-JSON, absent-transcript render returns an
 * empty, harmless store.
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

	// Withheld entirely when absent (never a DASH row) - a successful/DONE agent has no error to show, and an empty
	// "Error —" row next to a passing status reads as a false alarm (see the CSS's own belt-and-suspenders scoping
	// on `.clawdius-workflow-detail-field-error` for the same reasoning).
	if (payload.error !== undefined) {
		appendDetailField(container, localize('clawdius.workflows.detail.errorLabel', "Error"), payload.error, 'error');
	}

	const store = new DisposableStore();
	appendRichDetailField(container, localize('clawdius.workflows.detail.promptLabel', "Prompt"), payload.promptPreview, 'prompt', store);
	appendRichDetailField(container, localize('clawdius.workflows.detail.resultLabel', "Result"), payload.resultPreview, 'result', store);

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
			this.renderStore.add(renderResultDetail(this.content, payload));
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
