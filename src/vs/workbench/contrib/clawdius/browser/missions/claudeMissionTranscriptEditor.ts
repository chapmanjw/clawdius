/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet - transcript drill-in EditorPane (US2)
// A native-DOM EditorPane (no webview => zero-egress; pattern: claudeControlCenterEditor) that opens a subagent's
// REAL on-disk transcript in the editor area. It reads ONLY through the shipped seam (FR-002): the subagent's
// opaque transcriptRef -> the seam's per-subagent transcript read, which returns an INDEX-ONLY labeled slice (the
// record types in view + the four honesty labels), never the message bodies. The drill-in read's completeness
// runs the out-of-band tool-result probe, so a transcript referencing a missing out-of-band file paints `partial`,
// not `complete` (SC-003) - the label is rendered honestly, never fabricated up to complete. The header + record
// rows carry `data-*` hooks so the real-build Playwright render can assert the completeness label + record count.

import './media/claudeMissions.css';
import { $, append, clearNode, Dimension, size } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { FleetTranscriptSlice } from '../../common/claudeFleetModel.js';
import { ClawdiusReaderSeamService } from '../reader/claudeReaderSeamService.js';
import { ClaudeMissionTranscriptInput } from './claudeMissionTranscriptInput.js';

/**
 * Render a labeled subagent transcript slice into a container: a header carrying the completeness / coverage /
 * freshness labels (as badges AND `data-*` hooks) plus the record count, then one row per INDEX-ONLY record (its
 * type + a subagent marker for sidechain records). Never renders a message body - the seam is an index, not a copy.
 * Pure over its inputs (no services, no IO), so a unit test can drive it directly. `partial` completeness is
 * rendered exactly as the seam labeled it (SC-003), never quietly promoted to `complete`.
 */
export function renderTranscriptSlice(container: HTMLElement, slice: FleetTranscriptSlice): void {
	clearNode(container);
	// The honest projection Playwright asserts: the completeness label + the record count + the subagent id.
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
	append(labels, $(`.clawdius-transcript-label.completeness-${slice.completeness}`, undefined, localize('clawdius.transcript.completeness', "completeness: {0}", slice.completeness)));
	append(labels, $(`.clawdius-transcript-label.coverage-${slice.coverage}`, undefined, localize('clawdius.transcript.coverage', "coverage: {0}", slice.coverage)));
	append(labels, $(`.clawdius-transcript-label.freshness-${slice.freshness}`, undefined, localize('clawdius.transcript.freshness', "freshness: {0}", slice.freshness)));

	const list = append(container, $('.clawdius-transcript-records'));
	if (slice.records.length === 0) {
		append(list, $('.clawdius-transcript-empty', { 'data-clawdius-transcript-empty': 'true' })).textContent =
			localize('clawdius.transcript.empty', "No transcript records in view.");
		return;
	}
	for (const rec of slice.records) {
		const row = append(list, $(`.clawdius-transcript-record${rec.isSidechain ? '.sidechain' : ''}`, {
			'data-record-type': rec.type,
			'data-sidechain': String(rec.isSidechain),
		}));
		append(row, $('.clawdius-transcript-record-type')).textContent = rec.type;
		if (rec.isSidechain) {
			append(row, $('.clawdius-transcript-record-badge')).textContent = localize('clawdius.transcript.sidechain', "subagent");
		}
	}
}

/** The transcript drill-in editor pane: reads a subagent's transcript through the seam and renders it, honestly
 *  completeness-labeled. Read-only + zero-egress (native DOM, local seam read). */
export class ClaudeMissionTranscriptEditor extends EditorPane {

	static readonly ID = 'workbench.editor.clawdiusMissionTranscript';

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
	) {
		super(ClaudeMissionTranscriptEditor.ID, group, telemetryService, themeService, storageService);
		// The seam service is not a registered singleton; instantiate it (teams probe off) so the pane reads through
		// the SAME seam path the enumeration + unit tests exercise. It is stateless + read-only (not a disposable).
		this.seam = instantiationService.createInstance(ClawdiusReaderSeamService, false);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.clawdius-transcript'));
		this.container.tabIndex = -1;
	}

	override async setInput(input: ClaudeMissionTranscriptInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		// Read the transcript through the seam (FR-002 - the only data path). Honest on failure: the seam degrades to
		// a labeled absent/unknown-shape slice rather than throwing, so the pane always has something honest to paint.
		const slice = await this.seam.readSubagentTranscript(input.subagent);
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
		renderTranscriptSlice(this.content, slice);
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
