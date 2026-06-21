/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN ultracode workflow store
// Reads the durable Claude Code "Ultracode" workflow-run records the CLI's workflow runner writes to
// ~/.claude/projects/<encoded-cwd>/<sessionId>/workflows/wf_*.json - one fully self-describing multi-agent
// run per file. This is the data source for the Ultracode window's "Workflows" board (the past-runs lane).
// The live running-workflow lane is sourced separately from the agent host's subagent session tree.

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/** A single agent within a workflow run (one `workflow_agent` progress event). */
export interface IWorkflowAgent {
	readonly agentId: string;
	readonly label: string;
	readonly agentType: string | undefined;
	readonly model: string | undefined;
	/** Lifecycle state the runner recorded: e.g. 'queued' | 'running' | 'done' | 'error'. */
	readonly state: string | undefined;
	readonly phaseTitle: string | undefined;
	readonly tokens: number | undefined;
	readonly toolCalls: number | undefined;
	readonly durationMs: number | undefined;
	readonly lastToolName: string | undefined;
	readonly promptPreview: string | undefined;
	readonly resultPreview: string | undefined;
}

/** A durable multi-agent workflow run (one `wf_*.json` file). */
export interface IWorkflowRun {
	readonly runId: string;
	readonly sessionId: string;
	readonly workflowName: string;
	/** Runner status: e.g. 'completed' | 'failed' | 'running'. */
	readonly status: string;
	readonly startTime: number | undefined;
	readonly durationMs: number | undefined;
	readonly agentCount: number;
	readonly totalTokens: number | undefined;
	readonly totalToolCalls: number | undefined;
	readonly defaultModel: string | undefined;
	readonly summary: string | undefined;
	readonly phases: readonly { readonly title: string }[];
	readonly agents: readonly IWorkflowAgent[];
	/** The on-disk wf_*.json, for drill-in / future actions. */
	readonly resource: URI;
}

/**
 * Encode an absolute filesystem path the way the Claude Code CLI names its per-project transcript dirs
 * under ~/.claude/projects: path separators and the drive colon become '-'. Verified against the on-disk
 * layout (e.g. C:\Users\chapm\Projects\Clawdius\clawdius -> C--Users-chapm-Projects-Clawdius-clawdius).
 */
export function encodeClaudeProjectDir(fsPath: string): string {
	return fsPath.replace(/[\\/:]/g, '-');
}

export class WorkflowStore extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _runs: readonly IWorkflowRun[] = [];
	get runs(): readonly IWorkflowRun[] { return this._runs; }

	private readonly _watchers = this._register(new DisposableStore());
	private _watchedKeys = new Set<string>();
	/** Monotonic guard so an older in-flight scan can't clobber a newer one. */
	private _refreshGen = 0;
	/** Debounce watcher-driven refreshes - a single run emits many file events. */
	private readonly _scheduler = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 400));

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	/** Refresh the run list. Serialized via a generation guard; safe to call repeatedly. */
	async refresh(): Promise<void> {
		const gen = ++this._refreshGen;
		const dirs = await this._workflowDirs();
		this._syncWatchers(dirs);
		const runs: IWorkflowRun[] = [];
		for (const dir of dirs) {
			runs.push(...await this._readRunsIn(dir));
		}
		// A newer refresh started while we were scanning: let it win, don't publish stale data.
		if (gen !== this._refreshGen || this._store.isDisposed) {
			return;
		}
		// Newest first.
		runs.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
		this._runs = runs;
		this._onDidChange.fire();
	}

	/**
	 * The ~/.claude/projects/<encoded-cwd>/<sessionId>/workflows dirs to read. v1 scans ALL projects
	 * (global) rather than only the current workspace folder, because a workflow run is stored under the
	 * Claude Code CLI session's cwd - which is often an ancestor of (or different from) the window's
	 * workspace folder - so workspace-only scoping would leave the board mysteriously empty. The encoded
	 * dir for the current workspace is surfaced first so its runs sort to the top when timestamps tie.
	 * (Project grouping / scoping is a planned refinement.)
	 */
	private async _workflowDirs(): Promise<URI[]> {
		const userHome = await this._pathService.userHome();
		const projectsRoot = joinPath(userHome, '.claude', 'projects');

		let rootStat;
		try {
			rootStat = await this._fileService.resolve(projectsRoot);
		} catch {
			return []; // no Claude CLI transcripts at all
		}

		const out: URI[] = [];
		for (const projectDir of rootStat.children ?? []) {
			if (!projectDir.isDirectory) {
				continue;
			}
			let projectStat;
			try {
				projectStat = await this._fileService.resolve(projectDir.resource);
			} catch {
				continue;
			}
			for (const sessionDir of projectStat.children ?? []) {
				if (!sessionDir.isDirectory) {
					continue;
				}
				const wfDir = joinPath(sessionDir.resource, 'workflows');
				if (await this._pathExists(wfDir)) {
					out.push(wfDir);
				}
			}
		}
		return out;
	}

	private async _readRunsIn(wfDir: URI): Promise<IWorkflowRun[]> {
		let stat;
		try {
			stat = await this._fileService.resolve(wfDir);
		} catch {
			return [];
		}
		const sessionId = sessionIdFromWorkflowDir(wfDir);
		const runs: IWorkflowRun[] = [];
		for (const child of stat.children ?? []) {
			if (child.isDirectory || !/^wf_.*\.json$/.test(child.name)) {
				continue;
			}
			const run = await this._readRun(child.resource, sessionId);
			if (run) {
				runs.push(run);
			}
		}
		return runs;
	}

	private async _readRun(resource: URI, sessionId: string): Promise<IWorkflowRun | undefined> {
		let raw: unknown;
		try {
			const content = await this._fileService.readFile(resource);
			let text = content.value.toString();
			if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); } // strip a UTF-8 BOM (JSON.parse rejects it)
			raw = JSON.parse(text);
		} catch (err) {
			this._logService.trace('[WorkflowStore] skipping unreadable run', resource.toString(), err);
			return undefined;
		}
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}
		const r = raw as Record<string, unknown>;
		const progress = Array.isArray(r.workflowProgress) ? r.workflowProgress : [];
		const agents: IWorkflowAgent[] = [];
		for (const ev of progress) {
			if (!ev || typeof ev !== 'object' || (ev as { type?: unknown }).type !== 'workflow_agent') {
				continue;
			}
			const a = ev as Record<string, unknown>;
			agents.push({
				agentId: str(a.agentId) ?? '',
				label: str(a.label) ?? str(a.agentType) ?? 'agent',
				agentType: str(a.agentType),
				model: str(a.model),
				state: str(a.state),
				phaseTitle: str(a.phaseTitle),
				tokens: num(a.tokens),
				toolCalls: num(a.toolCalls),
				durationMs: num(a.durationMs),
				lastToolName: str(a.lastToolName),
				promptPreview: str(a.promptPreview),
				resultPreview: str(a.resultPreview),
			});
		}
		const phases = (Array.isArray(r.phases) ? r.phases : [])
			.map(p => (p && typeof p === 'object' ? str((p as Record<string, unknown>).title) : undefined))
			.filter((t): t is string => !!t)
			.map(title => ({ title }));

		return {
			runId: str(r.runId) ?? resource.path.split('/').pop() ?? 'workflow',
			sessionId,
			workflowName: str(r.workflowName) ?? str(r.runId) ?? 'workflow',
			status: str(r.status) ?? 'unknown',
			startTime: num(r.startTime) ?? num(r.timestamp),
			durationMs: num(r.durationMs),
			agentCount: num(r.agentCount) ?? agents.length,
			totalTokens: num(r.totalTokens),
			totalToolCalls: num(r.totalToolCalls),
			defaultModel: str(r.defaultModel),
			summary: str(r.summary),
			phases,
			agents,
			resource,
		};
	}

	/** (Re)attach watchers only when the watched dir set actually changes, and debounce the events. */
	private _syncWatchers(dirs: readonly URI[]): void {
		const wanted = new Set(dirs.map(d => d.toString()));
		if (wanted.size === this._watchedKeys.size && [...wanted].every(k => this._watchedKeys.has(k))) {
			return; // unchanged: keep existing watchers (avoids a teardown/rebuild window that drops events)
		}
		this._watchers.clear();
		this._watchedKeys = wanted;
		for (const dir of dirs) {
			try {
				const watcher = this._fileService.createWatcher(dir, { recursive: false, excludes: [] });
				this._watchers.add(watcher);
				this._watchers.add(watcher.onDidChange(() => this._scheduler.schedule()));
			} catch {
				// best-effort; a missing dir is fine
			}
		}
	}

	private _pathExists(resource: URI): Promise<boolean> {
		return this._fileService.exists(resource);
	}
}

function sessionIdFromWorkflowDir(wfDir: URI): string {
	// .../projects/<encoded-cwd>/<sessionId>/workflows
	const parts = wfDir.path.split('/').filter(Boolean);
	return parts.length >= 2 ? parts[parts.length - 2] : '';
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
// CLAWDIUS-END
