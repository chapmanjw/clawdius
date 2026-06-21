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
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
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
	/** The on-disk agent-<id>.jsonl transcript, for drill-in. Undefined when the agentId is unknown. */
	readonly transcriptUri: URI | undefined;
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
	/** Consecutive clean scans that saw no running work; used for the live-poll grace period. */
	private _idleScans = 0;
	/** Debounce watcher-driven refreshes - a single run emits many file events. */
	private readonly _scheduler = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 400));
	/** While any workflow is running (no completion summary yet), poll so journal progress shows live. */
	private readonly _livePoll = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 2500));

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
		const sessionDirs = await this._sessionDirs();
		// Watch both the completed-run summaries and the live subagent journal dirs.
		this._syncWatchers(sessionDirs.flatMap(s => [joinPath(s, 'workflows'), joinPath(s, 'subagents', 'workflows')]));

		const completed: IWorkflowRun[] = [];
		const running: IWorkflowRun[] = [];
		for (const sessionDir of sessionDirs) {
			completed.push(...await this._readRunsIn(joinPath(sessionDir, 'workflows')));
			running.push(...await this._readRunningRunsIn(sessionDir));
		}
		// A newer refresh started while we were scanning: let it win, don't publish stale data.
		if (gen !== this._refreshGen || this._store.isDisposed) {
			// Superseded by a newer scan. Keep the live poll alive if the published state still has running
			// work, so a refresh race can't silently kill liveness.
			this._armLivePoll(false);
			return;
		}
		// A just-completed run can momentarily appear in both lanes (summary written, journal dir not yet
		// pruned); dedupe on runId so it isn't double-listed.
		const completedIds = new Set(completed.map(r => r.runId));
		const runningDeduped = running.filter(r => !completedIds.has(r.runId));
		completed.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
		runningDeduped.sort((a, b) => b.runId.localeCompare(a.runId));
		// Running workflows first so in-progress work is always visible at the top.
		this._runs = [...runningDeduped, ...completed];
		this._onDidChange.fire();
		this._armLivePoll(runningDeduped.length > 0);
	}

	/**
	 * Keep the live poll armed while work is in flight, with a short grace period so it survives the
	 * completion handoff and refresh races (the recursive:false dir watchers don't reliably deliver the
	 * journal's appends, so the 2.5s poll is the real liveness mechanism).
	 */
	private _armLivePoll(scanHadRunning: boolean): void {
		if (this._store.isDisposed) {
			return;
		}
		const hasRunning = scanHadRunning || this._runs.some(r => r.status === 'running');
		if (hasRunning) {
			this._idleScans = 0;
			this._livePoll.schedule();
		} else if (this._idleScans++ < 2) {
			this._livePoll.schedule();
		}
	}

	/**
	 * The ~/.claude/projects/<encoded-cwd>/<sessionId> session dirs to read. v1 scans ALL projects (global)
	 * rather than only the current workspace folder, because a workflow run is stored under the Claude Code
	 * CLI session's cwd - which is often an ancestor of (or different from) the window's workspace folder -
	 * so workspace-only scoping would leave the board mysteriously empty. Each session dir holds both the
	 * completed-run summaries (workflows/wf_*.json) and the live subagent journals (subagents/workflows/<runId>).
	 * (Project grouping / scoping is a planned refinement.)
	 */
	private async _sessionDirs(): Promise<URI[]> {
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
				if (sessionDir.isDirectory) {
					out.push(sessionDir.resource);
				}
			}
		}
		return out;
	}

	/**
	 * Read the LIVE (in-progress) workflow runs for a session: a subagents/workflows/<runId> dir whose
	 * completion summary (workflows/<runId>.json) does not exist yet. The per-agent state comes from the
	 * incrementally-written journal.jsonl (started/result events) + each agent's meta.json (agentType /
	 * description). Running workflows carry less detail than completed ones (no tokens/duration/name until
	 * the summary lands), but they make in-progress work - including subagents spawned from a window chat
	 * session - visible the moment they start.
	 */
	private async _readRunningRunsIn(sessionDir: URI): Promise<IWorkflowRun[]> {
		const subWfDir = joinPath(sessionDir, 'subagents', 'workflows');
		const completedDir = joinPath(sessionDir, 'workflows');
		let stat;
		try {
			stat = await this._fileService.resolve(subWfDir);
		} catch {
			return [];
		}
		const sessionId = basename(sessionDir);
		const runs: IWorkflowRun[] = [];
		for (const runDir of stat.children ?? []) {
			if (!runDir.isDirectory || !/^wf_/.test(runDir.name)) {
				continue;
			}
			// Completed runs are already surfaced from the wf_*.json summary; skip those.
			if (await this._pathExists(joinPath(completedDir, runDir.name + '.json'))) {
				continue;
			}
			const run = await this._readRunningRun(runDir.resource, runDir.name, sessionId);
			if (run) {
				runs.push(run);
			}
		}
		return runs;
	}

	private async _readRunningRun(runDir: URI, runId: string, sessionId: string): Promise<IWorkflowRun | undefined> {
		// journal.jsonl: one {type:'started'|'result', agentId} per line, appended live.
		const started = new Set<string>();
		const done = new Set<string>();
		try {
			const journal = (await this._fileService.readFile(joinPath(runDir, 'journal.jsonl'))).value.toString();
			for (const line of journal.split(/\r?\n/)) {
				if (!line.trim()) { continue; }
				let ev: { type?: unknown; agentId?: unknown };
				try { ev = JSON.parse(line); } catch { continue; }
				const id = str(ev.agentId);
				if (!id) { continue; }
				if (ev.type === 'started') { started.add(id); }
				else if (ev.type === 'result') { done.add(id); }
			}
		} catch {
			// No journal yet - the run just started; fall through with whatever metas exist.
		}

		const agents: IWorkflowAgent[] = [];
		let dirStat;
		try { dirStat = await this._fileService.resolve(runDir); } catch { dirStat = undefined; }
		for (const child of dirStat?.children ?? []) {
			const m = /^agent-(.+)\.meta\.json$/.exec(child.name);
			if (!m) { continue; }
			const agentId = m[1];
			let meta: { agentType?: unknown; description?: unknown } = {};
			try { meta = JSON.parse((await this._fileService.readFile(child.resource)).value.toString()); } catch { /* partial */ }
			agents.push(runningAgent(agentId, str(meta.agentType), str(meta.description), started.has(agentId), done.has(agentId), joinPath(runDir, `agent-${agentId}.jsonl`)));
		}
		// If metas are not written yet, fall back to the agentIds the journal mentions (started OR result -
		// a result-only line must still surface its agent).
		for (const id of new Set([...started, ...done])) {
			if (!agents.some(a => a.agentId === id)) {
				agents.push(runningAgent(id, undefined, undefined, started.has(id), done.has(id), joinPath(runDir, `agent-${id}.jsonl`)));
			}
		}

		// An empty/leftover subagent dir (no journal, no metas) is not a real running workflow: don't
		// surface a phantom run, and don't keep the live poll alive for it.
		if (agents.length === 0) {
			return undefined;
		}

		return {
			runId,
			sessionId,
			workflowName: runId, // the human name lives in the summary, written only at completion
			status: 'running',
			startTime: undefined,
			durationMs: undefined,
			agentCount: agents.length,
			totalTokens: undefined,
			totalToolCalls: undefined,
			defaultModel: undefined,
			summary: undefined,
			phases: [],
			agents,
			resource: runDir,
		};
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
		// Transcripts for a completed run live beside the journal under
		// <sessionDir>/subagents/workflows/<summary-stem>/agent-<id>.jsonl. The dir name matches the summary
		// filename stem (not the internal runId field), so derive it from the resource path.
		const sessionDir = dirname(dirname(resource));
		const transcriptDir = joinPath(sessionDir, 'subagents', 'workflows', basename(resource).replace(/\.json$/, ''));
		const progress = Array.isArray(r.workflowProgress) ? r.workflowProgress : [];
		const agents: IWorkflowAgent[] = [];
		for (const ev of progress) {
			if (!ev || typeof ev !== 'object' || (ev as { type?: unknown }).type !== 'workflow_agent') {
				continue;
			}
			const a = ev as Record<string, unknown>;
			const agentId = str(a.agentId);
			agents.push({
				agentId: agentId ?? '',
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
				transcriptUri: agentId ? joinPath(transcriptDir, `agent-${agentId}.jsonl`) : undefined,
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

function runningAgent(agentId: string, agentType: string | undefined, description: string | undefined, started: boolean, done: boolean, transcriptUri: URI): IWorkflowAgent {
	return {
		agentId,
		label: description ?? agentType ?? 'agent',
		agentType,
		model: undefined,
		state: done ? 'done' : (started ? 'running' : 'queued'),
		phaseTitle: undefined,
		tokens: undefined,
		toolCalls: undefined,
		durationMs: undefined,
		lastToolName: undefined,
		promptPreview: undefined,
		resultPreview: undefined,
		transcriptUri,
	};
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
// CLAWDIUS-END
