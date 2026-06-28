/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN transcript-derived usage stats service (node, #94)
// Aggregates ~/.claude/projects/**/*.jsonl into IClaudeStats off the UI thread (this runs in the agentHost
// utility process). Streams each transcript line-by-line via readline (constant memory over 100MB+ files) and
// keeps an incremental per-file cache at ~/.claude/.clawdius-usage-stats.json keyed by (size, mtimeMs): only
// changed / new files are re-parsed, removed files are dropped, the cache is written atomically (temp +
// rename). A cold parse is a few seconds; warm (only the active session's file changed) is near-instant. All
// local file reads - ZERO egress.

import { createReadStream } from 'fs';
import { readdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { join, sep } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { IClaudeUsageStatsResult, IClaudeUsageStatsService } from '../common/claudeUsageStats.js';
import { IUsageFilePartial, UsageFileAccumulator, localDateKey, mergePartials } from '../common/claudeUsageStatsModel.js';

/** Bump to invalidate every cached partial (parser-semantics or partial-schema change). v2 adds the per-day
 *  token split + per-day hour counts (dailyHourCounts) the windowed dashboard tiles need, so v1 partials are
 *  stale and must be recomputed from the transcripts. */
const CACHE_VERSION = 2;
const CACHE_FILE = '.clawdius-usage-stats.json';

interface ICachedFile { readonly size: number; readonly mtimeMs: number; readonly partial: IUsageFilePartial }
interface ICacheShape { readonly version: number; files: { [path: string]: ICachedFile } }

export class ClaudeUsageStatsService implements IClaudeUsageStatsService {

	declare readonly _serviceBrand: undefined;

	/** In-flight de-dupe per home dir: concurrent callers (open + refresh) share one computation. */
	private readonly inFlight = new Map<string, Promise<IClaudeUsageStatsResult>>();

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	getUsageStats(homeDirPath: string): Promise<IClaudeUsageStatsResult> {
		let pending = this.inFlight.get(homeDirPath);
		if (!pending) {
			pending = this.compute(homeDirPath).finally(() => { this.inFlight.delete(homeDirPath); });
			this.inFlight.set(homeDirPath, pending);
		}
		return pending;
	}

	private async compute(homeDirPath: string): Promise<IClaudeUsageStatsResult> {
		try {
			const claudeDir = join(homeDirPath, '.claude');
			const projectsDir = join(claudeDir, 'projects');
			const cachePath = join(claudeDir, CACHE_FILE);

			const files = await this.scanJsonl(projectsDir);
			const cache = await this.loadCache(cachePath);
			const nextFiles: { [path: string]: ICachedFile } = {};
			const partials: IUsageFilePartial[] = [];

			for (const fp of files) {
				let st;
				try {
					st = await stat(fp);
				} catch {
					continue; // raced deletion
				}
				const cached = cache.files[fp];
				if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
					nextFiles[fp] = cached;
					partials.push(cached.partial);
				} else {
					// Isolate per-file failures (raced deletion, locked / mid-write file): skip + log, never let
					// one bad transcript abort the whole aggregate. Keep a stale cached partial if we have one so
					// its data isn't lost; its old (size, mtime) means we retry the file on the next compute.
					try {
						const partial = await this.parseFile(fp);
						nextFiles[fp] = { size: st.size, mtimeMs: st.mtimeMs, partial };
						partials.push(partial);
					} catch (err) {
						this.logService.warn(`[Clawdius] skipped unreadable transcript ${fp}`, err);
						if (cached) { nextFiles[fp] = cached; partials.push(cached.partial); }
					}
				}
			}
			// Files no longer on disk are simply absent from nextFiles -> dropped from the cache.

			const stats = mergePartials(partials, localDateKey(Date.now()));
			// Persisting the cache is best-effort: a write failure (AV / lock / permissions) must not discard the
			// stats we just computed, only cost us the warm-start speedup next time.
			try {
				await this.saveCache(cachePath, { version: CACHE_VERSION, files: nextFiles });
			} catch (err) {
				this.logService.warn('[Clawdius] could not persist the usage stats cache', err);
			}
			return { status: 'ok', stats, computedAt: Date.now(), fileCount: files.length };
		} catch (err) {
			this.logService.error('[Clawdius] usage stats aggregation failed', err);
			return { status: 'error', message: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Recursively collect every `*.jsonl` path under `dir` (returns [] if the dir is absent). */
	private async scanJsonl(dir: string): Promise<string[]> {
		const out: string[] = [];
		const walk = async (d: string): Promise<void> => {
			let entries;
			try {
				entries = await readdir(d, { withFileTypes: true });
			} catch {
				return; // missing / unreadable dir
			}
			for (const e of entries) {
				const full = join(d, e.name);
				if (e.isDirectory()) {
					await walk(full);
				} else if (e.isFile() && e.name.endsWith('.jsonl')) {
					out.push(full);
				}
			}
		};
		await walk(dir);
		return out;
	}

	/** Stream a transcript line-by-line into the pure accumulator; tag subagent transcripts from the path. */
	private async parseFile(fp: string): Promise<IUsageFilePartial> {
		const acc = new UsageFileAccumulator();
		const rl = createInterface({ input: createReadStream(fp, { encoding: 'utf8' }), crlfDelay: Infinity });
		try {
			for await (const line of rl) { acc.addLine(line); }
		} finally {
			rl.close();
		}
		const isSubagent = fp.split(sep).includes('subagents');
		return { ...acc.finish(), isSubagent };
	}

	private async loadCache(cachePath: string): Promise<ICacheShape> {
		try {
			const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<ICacheShape>;
			if (parsed && parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') {
				return { version: CACHE_VERSION, files: parsed.files };
			}
		} catch {
			// missing / malformed / stale-version cache -> recompute from scratch
		}
		return { version: CACHE_VERSION, files: {} };
	}

	private async saveCache(cachePath: string, cache: ICacheShape): Promise<void> {
		const tmp = `${cachePath}.tmp`;
		await writeFile(tmp, JSON.stringify(cache), 'utf8');
		await rename(tmp, cachePath);
	}
}
