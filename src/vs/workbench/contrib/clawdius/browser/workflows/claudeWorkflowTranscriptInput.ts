/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - transcript drill-in editor input
// A read-only EditorInput carrying the FleetSubagent a workflow row was drilled into. NOT a singleton: each
// subagent is its own transcript, so each opens as a distinct editor (a re-open of the SAME subagent reveals the
// existing one via `matches`). The input holds only the labeled index handle (the subagent's opaque transcriptRef +
// labels); the pane reads the transcript live through the seam on open, so a restored editor re-reads from disk.

import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { FleetSubagent } from '../../common/claudeFleetModel.js';

const ClaudeWorkflowTranscriptIcon = registerIcon('clawdius-workflow-transcript-icon', Codicon.commentDiscussion, localize('clawdius.workflows.transcriptIcon', "Icon of a Claude Code subagent transcript."));

export class ClaudeWorkflowTranscriptInput extends EditorInput {

	// PRESERVED for backward compat: this is the editor-input-serializer typeId VS Code persists to restore an
	// already-open transcript editor across a restart (registerEditorSerializer keys off this exact string in
	// clawdius.contribution.ts). It must NOT change with the rename, or a pre-rename persisted editor tab would
	// fail to restore.
	static readonly ID = 'workbench.input.clawdiusMissionTranscript';

	constructor(readonly subagent: FleetSubagent) {
		super();
	}

	override get typeId(): string {
		return ClaudeWorkflowTranscriptInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// Read-only: the transcript pane only reads through the seam, it never writes under the config root.
		return EditorInputCapabilities.Readonly;
	}

	// A stable, per-subagent resource so the editor system treats distinct subagents as distinct editors while a
	// re-open of the same subagent reveals the existing one. The transcriptRef rides in the query so two subagents
	// that (defensively) share an id but index different files never collapse to one.
	readonly resource = URI.from({
		scheme: 'clawdius-workflow-transcript',
		path: this.subagent.subagentId || 'root',
		query: this.subagent.transcriptRef,
	});

	override getName(): string {
		return this.subagent.subagentId
			? localize('clawdius.workflows.transcriptName', "Transcript: {0}", this.subagent.subagentId)
			: localize('clawdius.workflows.transcriptNameRoot', "Subagent transcript");
	}

	override getIcon(): ThemeIcon {
		return ClaudeWorkflowTranscriptIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof ClaudeWorkflowTranscriptInput
			&& other.subagent.subagentId === this.subagent.subagentId
			&& other.subagent.transcriptRef === this.subagent.transcriptRef);
	}
}

// The transcript drill-in input round-trips its FleetSubagent (a plain labeled index handle - subagent id, parent
// run id, the opaque transcriptRef, and the honesty labels; never authoritative content). On restore the pane
// re-reads the transcript live from disk through the seam, so a stale serialized label is refreshed on open.
export class ClaudeWorkflowTranscriptInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(input: EditorInput): string {
		return JSON.stringify((input as ClaudeWorkflowTranscriptInput).subagent);
	}
	deserialize(_instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			return new ClaudeWorkflowTranscriptInput(JSON.parse(serialized) as FleetSubagent);
		} catch {
			return undefined;
		}
	}
}
// CLAWDIUS-END
