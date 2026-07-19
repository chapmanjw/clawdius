/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Ultracode Workflows - transcript drill-in editor input
// A read-only EditorInput carrying the WorkflowTranscriptRef (the sessionId/runId/agentId identity triple) a
// workflow agent row was drilled into. NOT a singleton: each agent is its own transcript, so each opens as a
// distinct editor (a re-open of the SAME agent reveals the existing one via `matches`). The input holds only the
// identity triple, never a stored path/URI - the pane re-derives the transcript's on-disk path from these
// identities on every read (see claudeWorkflowTranscriptEditor.ts / `readWorkflowAgentTranscript`), which is
// what closes the URI-serialization disclosure seam a stored path would otherwise reopen on restore.
//
// BACKWARD COMPAT: a tab persisted BEFORE this identity migration serialized the legacy `FleetSubagent` shape
// (`{subagentId,parentRunId,transcriptRef,coverage,freshness,completeness}`), which carries no `sessionId`. The
// deserializer below still opens such a payload rather than throwing: it maps what it can
// (agentId<-subagentId, runId<-parentRunId, sessionId<-'') into the same `WorkflowTranscriptRef` shape. The empty
// sessionId fails the seam's own path-safety check, so the restored pane opens and renders the seam's own honest
// absent/out-of-scope state - never a crash, and never a guess at a path the old payload cannot actually locate.

import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { WorkflowTranscriptRef } from '../../common/claudeWorkflowModel.js';

const ClaudeWorkflowTranscriptIcon = registerIcon('clawdius-workflow-transcript-icon', Codicon.commentDiscussion, localize('clawdius.workflows.transcriptIcon', "Icon of a Claude Code subagent transcript."));

export class ClaudeWorkflowTranscriptInput extends EditorInput {

	// PRESERVED for backward compat: this is the editor-input-serializer typeId VS Code persists to restore an
	// already-open transcript editor across a restart (registerEditorSerializer keys off this exact string in
	// clawdius.contribution.ts). It must NOT change with the identity-model migration, or a pre-migration
	// persisted editor tab would fail to restore.
	static readonly ID = 'workbench.input.clawdiusMissionTranscript';

	constructor(readonly ref: WorkflowTranscriptRef) {
		super();
	}

	override get typeId(): string {
		return ClaudeWorkflowTranscriptInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// Read-only: the transcript pane only reads through the seam, it never writes under the config root.
		return EditorInputCapabilities.Readonly;
	}

	// A stable, per-agent resource so the editor system treats distinct agents as distinct editors while a
	// re-open of the same agent reveals the existing one. The session + run ride in the query so two agents that
	// (defensively) share an id but belong to different runs never collapse to one tab.
	readonly resource = URI.from({
		scheme: 'clawdius-workflow-transcript',
		path: this.ref.agentId || 'root',
		query: `session=${this.ref.sessionId}&run=${this.ref.runId}`,
	});

	override getName(): string {
		return this.ref.agentId
			? localize('clawdius.workflows.transcriptName', "Transcript: {0}", this.ref.agentId)
			: localize('clawdius.workflows.transcriptNameRoot', "Subagent transcript");
	}

	override getIcon(): ThemeIcon {
		return ClaudeWorkflowTranscriptIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof ClaudeWorkflowTranscriptInput
			&& other.ref.sessionId === this.ref.sessionId
			&& other.ref.runId === this.ref.runId
			&& other.ref.agentId === this.ref.agentId);
	}
}

/**
 * Recover a {@link WorkflowTranscriptRef} from a persisted editor-input payload, in EITHER shape a restore can
 * hand back: the identity triple this input serializes going forward, or a pre-migration `FleetSubagent` payload
 * (`subagentId`/`parentRunId`/... - no `sessionId`). The legacy shape maps what it can rather than refusing to
 * open - see the file-level BACKWARD COMPAT note. Returns undefined only when NEITHER shape is recognizable (a
 * payload belonging to neither generation), so the editor fails to restore rather than opening on a guess.
 */
function toTranscriptRef(parsed: Record<string, unknown>): WorkflowTranscriptRef | undefined {
	if (typeof parsed.sessionId === 'string' && typeof parsed.runId === 'string' && typeof parsed.agentId === 'string') {
		return { sessionId: parsed.sessionId, runId: parsed.runId, agentId: parsed.agentId };
	}
	if (typeof parsed.subagentId === 'string' && typeof parsed.parentRunId === 'string') {
		return { sessionId: '', runId: parsed.parentRunId, agentId: parsed.subagentId };
	}
	return undefined;
}

// The transcript drill-in input round-trips its WorkflowTranscriptRef (the identity triple, never a stored
// path/URI). On restore the pane re-derives the transcript's path from these identities and reads it live
// through the seam, so a stale serialized label is refreshed on open and a restored tab can never redirect the
// read elsewhere.
export class ClaudeWorkflowTranscriptInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(input: EditorInput): string {
		return JSON.stringify((input as ClaudeWorkflowTranscriptInput).ref);
	}
	deserialize(_instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const ref = toTranscriptRef(JSON.parse(serialized) as Record<string, unknown>);
			return ref ? new ClaudeWorkflowTranscriptInput(ref) : undefined;
		} catch {
			return undefined;
		}
	}
}
// CLAWDIUS-END
