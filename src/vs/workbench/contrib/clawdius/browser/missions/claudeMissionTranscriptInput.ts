/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Missions fleet - transcript drill-in editor input
// A read-only EditorInput carrying the FleetSubagent a fleet row was drilled into. NOT a singleton: each subagent
// is its own transcript, so each opens as a distinct editor (a re-open of the SAME subagent reveals the existing
// one via `matches`). The input holds only the labeled index handle (the subagent's opaque transcriptRef +
// labels); the pane reads the transcript live through the seam on open, so a restored editor re-reads from disk.

import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { FleetSubagent } from '../../common/claudeFleetModel.js';

const ClaudeMissionTranscriptIcon = registerIcon('clawdius-mission-transcript-icon', Codicon.commentDiscussion, localize('clawdius.missions.transcriptIcon', "Icon of a Claude Code subagent transcript."));

export class ClaudeMissionTranscriptInput extends EditorInput {

	static readonly ID = 'workbench.input.clawdiusMissionTranscript';

	constructor(readonly subagent: FleetSubagent) {
		super();
	}

	override get typeId(): string {
		return ClaudeMissionTranscriptInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// Read-only: the transcript pane only reads through the seam, it never writes under the config root.
		return EditorInputCapabilities.Readonly;
	}

	// A stable, per-subagent resource so the editor system treats distinct subagents as distinct editors while a
	// re-open of the same subagent reveals the existing one. The transcriptRef rides in the query so two subagents
	// that (defensively) share an id but index different files never collapse to one.
	readonly resource = URI.from({
		scheme: 'clawdius-mission-transcript',
		path: this.subagent.subagentId || 'root',
		query: this.subagent.transcriptRef,
	});

	override getName(): string {
		return this.subagent.subagentId
			? localize('clawdius.missions.transcriptName', "Transcript: {0}", this.subagent.subagentId)
			: localize('clawdius.missions.transcriptNameRoot', "Subagent transcript");
	}

	override getIcon(): ThemeIcon {
		return ClaudeMissionTranscriptIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof ClaudeMissionTranscriptInput
			&& other.subagent.subagentId === this.subagent.subagentId
			&& other.subagent.transcriptRef === this.subagent.transcriptRef);
	}
}
// CLAWDIUS-END
