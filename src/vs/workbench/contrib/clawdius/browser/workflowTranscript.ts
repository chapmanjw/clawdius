/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN native main-IDE clawdius container (Phase 2d: workflow transcript)
// Renders a workflow sub-agent's on-disk agent-<id>.jsonl transcript as a readable, read-only Markdown
// document so the user can drill into what a sub-agent actually did - the same turns/tool-calls they would
// see in the CLI. A text-model content provider backs a virtual `clawdius-workflow-transcript:` resource;
// the source .jsonl path travels in the resource's query so no temp files are written.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

export const WORKFLOW_TRANSCRIPT_SCHEME = 'clawdius-workflow-transcript';

/** Cap each rendered block so a single huge tool result can't make the transcript unscrollable. */
const MAX_BLOCK_CHARS = 4000;

/**
 * Build the virtual resource for a transcript document. The editor tab takes its label from the path, and
 * the real agent-<id>.jsonl file: URI rides along in the query for the content provider to read.
 */
export function transcriptDocUri(transcriptUri: URI, label: string): URI {
	const safe = label.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'transcript';
	return URI.from({ scheme: WORKFLOW_TRANSCRIPT_SCHEME, path: `/${safe}.md`, query: transcriptUri.toString() });
}

/** Render a Claude Code transcript (one JSON event per line) as Markdown. Pure; exported for testing. */
export function formatWorkflowTranscript(jsonl: string, title?: string): string {
	const out: string[] = [];
	if (title) {
		out.push(`# ${title}`, '');
	}
	let rendered = 0;
	for (const line of jsonl.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // a partially-flushed last line during a live run
		}
		if (ev.type !== 'user' && ev.type !== 'assistant') {
			continue;
		}
		const message = ev.message;
		if (!message || typeof message !== 'object') {
			continue;
		}
		const body = renderContent((message as Record<string, unknown>).content);
		if (!body.trim()) {
			continue;
		}
		const isAssistant = (message as Record<string, unknown>).role === 'assistant';
		out.push(isAssistant ? '### \u{1F916} Assistant' : '### \u{1F464} User', '', body, '');
		rendered++;
	}
	if (rendered === 0) {
		out.push(localize('clawdius.transcript.empty', "_No transcript has been recorded for this agent yet._"));
	}
	return out.join('\n');
}

function renderContent(content: unknown): string {
	if (typeof content === 'string') {
		return truncate(content.trim());
	}
	if (!Array.isArray(content)) {
		return '';
	}
	const parts: string[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const block = raw as Record<string, unknown>;
		switch (block.type) {
			case 'text': {
				const text = typeof block.text === 'string' ? block.text.trim() : '';
				if (text) {
					parts.push(truncate(text));
				}
				break;
			}
			case 'thinking': {
				const text = typeof block.thinking === 'string' ? block.thinking : (typeof block.text === 'string' ? block.text : '');
				if (text.trim()) {
					parts.push(blockquote(`\u{1F4AD} ${truncate(text.trim())}`));
				}
				break;
			}
			case 'tool_use': {
				const name = typeof block.name === 'string' ? block.name : 'tool';
				parts.push(`**\u{1F527} ${name}**`);
				const input = stringify(block.input);
				if (input) {
					parts.push(fence(truncate(input), 'json'));
				}
				break;
			}
			case 'tool_result': {
				const result = renderToolResult(block.content);
				if (result.trim()) {
					parts.push('**↩︎ result**', fence(truncate(result.trim())));
				}
				break;
			}
		}
	}
	return parts.join('\n\n');
}

function renderToolResult(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(b => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string' ? (b as Record<string, unknown>).text as string : ''))
			.filter(Boolean)
			.join('\n');
	}
	return content === undefined ? '' : stringify(content);
}

function stringify(value: unknown): string {
	if (value === undefined || value === null) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value, undefined, 2);
	} catch {
		return String(value);
	}
}

function truncate(text: string): string {
	if (text.length <= MAX_BLOCK_CHARS) {
		return text;
	}
	const dropped = text.length - MAX_BLOCK_CHARS;
	return `${text.slice(0, MAX_BLOCK_CHARS)}\n… (truncated ${dropped.toLocaleString()} more characters)`;
}

/** Fence with enough backticks to safely wrap content that may itself contain backtick runs. */
function fence(text: string, lang: string = ''): string {
	let longest = 2;
	const runs = text.match(/`+/g);
	if (runs) {
		for (const run of runs) {
			longest = Math.max(longest, run.length);
		}
	}
	const ticks = '`'.repeat(longest + 1);
	return `${ticks}${lang}\n${text}\n${ticks}`;
}

function blockquote(text: string): string {
	return text.split('\n').map(l => `> ${l}`).join('\n');
}

/**
 * Backs the virtual `clawdius-workflow-transcript:` resources with a read-only, Markdown-rendered view of the
 * referenced agent-<id>.jsonl file. Registered as a workbench contribution so it is available for the
 * window's lifetime.
 */
export class WorkflowTranscriptContribution extends Disposable implements IWorkbenchContribution, ITextModelContentProvider {

	static readonly ID = 'workbench.contrib.clawdius.workflowTranscript';

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(WORKFLOW_TRANSCRIPT_SCHEME, this));
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this._modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const title = basename(resource).replace(/\.md$/, '');
		let text = '';
		if (resource.query) {
			try {
				text = (await this._fileService.readFile(URI.parse(resource.query))).value.toString();
			} catch {
				// File missing/unreadable (e.g. transcript pruned): formatter renders the empty-state note.
			}
		}
		const markdown = formatWorkflowTranscript(text, title);
		return this._modelService.createModel(markdown, this._languageService.createById('markdown'), resource);
	}
}
// CLAWDIUS-END
