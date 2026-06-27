/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Context Budget Inspector - resolver
// Pure logic for "what does Claude see for THIS file?": given the config snapshot + the active file, sort the
// memory / rule / skill sources into ALWAYS-ON (loaded every turn), ON-INVOKE (skills), and NOT-APPLIED (path-
// scoped rules whose `paths` the active file does not match), with an estimated token total. No I/O, no
// services - every input is already in the snapshot (the store read the files during its scan), so this is
// unit-testable.
//
// Matches Claude Code's real model (verified against the bundled engine): memory loads concatenated as
// Managed -> User -> Project(root..cwd) -> Local + per-project AutoMem; .claude/rules/*.md auto-load always-on
// unless they declare a `paths:` frontmatter (then they are conditional); CLAUDE.md/rules `@`-import other
// files (resolved by the store) which load always-on too. A file that is both auto-scanned AND @-imported is
// counted ONCE (deduped by path here).
//
// Honesty: token counts are estimates (chars / 4), never exact - there is no in-process tokenizer. Every source
// is PREDICTED from config, not confirmed for a specific turn (a real InstructionsLoaded hook exists in the CLI
// and could later confirm loads, but is not wired yet). The headline counts memory + rules only - NOT the
// system prompt, the skill/agent menu, or MCP tool schemas, which dominate the true always-on prefix.

import { match as globMatch } from '../../../../base/common/glob.js';
import { basename, extUriIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ConfigScope, ConfigSection, ContextInclusion, IClawdiusConfigSnapshot, IConfigBudgetMeta, IConfigItem } from './clawdiusConfig.js';

/** The precedence tier a source belongs to (broad -> specific). Managed is org-policy memory (highest). */
export const enum BudgetTier {
	Managed = 'managed',
	User = 'user',
	Project = 'project',
	Local = 'local',
}

/** What kind of context source a row is. `import` is a file pulled in via `@`-import; `automem` is MEMORY.md;
 *  `menu` is the aggregated always-on skill/agent menu (names + descriptions injected every turn). */
export type BudgetSourceKind = 'memory' | 'rule' | 'skill' | 'automem' | 'import' | 'menu';

/** One context source (a memory file, a rule, a skill, an import) as resolved for the active file. */
export interface IBudgetSource {
	readonly label: string;
	readonly scope: ConfigScope;
	readonly tier: BudgetTier;
	readonly kind: BudgetSourceKind;
	readonly approxTokens: number;
	readonly resource?: URI;
	/** For a skill: its description - the "when" the model uses to decide to invoke it. */
	readonly description?: string;
	/** For a path-scoped rule: its frontmatter `paths` patterns (so the UI can show what scopes it). */
	readonly paths?: readonly string[];
	/** For a path-scoped rule: whether the active file matched (true -> always-on, false -> not-applied). */
	readonly matched?: boolean;
	/** For a skill/agent: its always-on menu cost (name + description); aggregated into the synthetic menu row. */
	readonly menuTokens?: number;
	/** Per-heading token breakdown of a memory/rule file (heaviest-first in the UI; click to open at the line). */
	readonly headings?: readonly IBudgetHeading[];
	/** A nested/subtree CLAUDE.md: loads on demand when the active file's directory is read, not every turn. */
	readonly nested?: boolean;
}

/** A markdown heading's section within a memory/rule file, with its estimated token span. */
export interface IBudgetHeading {
	readonly label: string;
	readonly approxTokens: number;
	readonly lineNumber: number;
}

/** The resolved context budget for one active file. */
export interface IContextBudget {
	readonly activeFile?: URI;
	/** Sources loaded every turn for this file: memories + always-rules + matching path-rules + imports + automem.
	 *  Deduped by path (an auto-scanned file that is also @-imported appears once). */
	readonly alwaysOn: readonly IBudgetSource[];
	/** Skills - loaded on demand, not every turn. */
	readonly onInvoke: readonly IBudgetSource[];
	/** Path-scoped rules whose `paths` the active file did not match. */
	readonly notApplied: readonly IBudgetSource[];
	/** Sum of `approxTokens` across `alwaysOn` (the every-turn cost). Estimated; memory + rules only. */
	readonly alwaysOnTokens: number;
}

/** Derive the precedence tier from scope + the memory file's label. */
function tierOf(scope: ConfigScope, label: string): BudgetTier {
	if (scope === ConfigScope.Managed) { return BudgetTier.Managed; }
	if (scope === ConfigScope.Global) { return BudgetTier.User; }
	return label === 'CLAUDE.local.md' ? BudgetTier.Local : BudgetTier.Project;
}

/** The workspace folder that contains the active file. Project scopes apply only to their own folder; with no
 *  active file we can disambiguate only a single-root workspace. Uses URI identity (authority + path casing). */
export function containingFolderOf(activeFile: URI | undefined, folders: readonly URI[]): URI | undefined {
	if (activeFile) {
		// The MOST-specific (longest-path) containing folder, so a file in a nested workspace root resolves to
		// the inner root, not an outer one. Ignore path casing: on Windows the folder + the active file can
		// differ only by drive-letter case (`/C:/...` vs `/c:/...`), which a case-sensitive compare would miss.
		let best: URI | undefined;
		for (const folder of folders) {
			if (extUriIgnorePathCase.isEqualOrParent(activeFile, folder) && (!best || folder.path.length > best.path.length)) {
				best = folder;
			}
		}
		return best;
	}
	return folders.length === 1 ? folders[0] : undefined;
}

/** Does a rule `paths` glob apply to the active file? A bare pattern (`*.ts`, no slash) applies to that file
 *  type at any depth; a rooted pattern (`src/**`) matches the relative path. Approximates Claude Code's
 *  gitignore-style matching for the common authored patterns. */
function globApplies(glob: string, relPath: string): boolean {
	// A leading `/` anchors a gitignore pattern to the project root; our relPath is already root-relative. An
	// anchored pattern (e.g. `/*.ts`) must NOT use the bare-pattern "any depth" expansion below.
	const anchored = glob.startsWith('/');
	if (anchored) { glob = glob.slice(1); }
	// Directory-scoped forms (`src/**`, `src/`) match any file under that directory - VS Code's `match` does not
	// treat `src/**` the gitignore way, so handle the prefix explicitly.
	const dir = glob.endsWith('/**') ? glob.slice(0, -3) : (glob.endsWith('/') ? glob.slice(0, -1) : undefined);
	if (dir !== undefined && dir.length > 0 && !dir.includes('*') && (relPath === dir || relPath.startsWith(dir + '/'))) {
		return true;
	}
	// A bare pattern (no slash, not anchored) applies at any depth; an anchored or rooted pattern is matched
	// against the root-relative path directly.
	if (!anchored && !glob.includes('/')) {
		const base = relPath.split('/').pop() ?? relPath;
		return globMatch(glob, base) || globMatch('**/' + glob, relPath);
	}
	return globMatch(glob, relPath);
}

function anyGlobApplies(paths: readonly string[] | undefined, relPath: string | undefined): boolean {
	if (!paths || paths.length === 0 || relPath === undefined) { return false; }
	return paths.some(g => globApplies(g, relPath));
}

function toSource(item: IConfigItem, scope: ConfigScope, matched?: boolean): IBudgetSource {
	const b = item.budget!;
	const headings: IBudgetHeading[] = (item.children ?? [])
		.filter(c => c.budget !== undefined && c.reveal !== undefined)
		.map(c => ({ label: c.label, approxTokens: c.budget!.approxTokens, lineNumber: c.reveal!.lineNumber }));
	return {
		label: item.label,
		scope,
		tier: tierOf(scope, item.label),
		kind: b.kind,
		approxTokens: b.approxTokens,
		resource: item.resource,
		description: item.description,
		paths: b.paths,
		matched,
		menuTokens: b.menuTokens,
		headings: headings.length ? headings : undefined,
		nested: b.nested,
	};
}

/** Dedup key for an always-on source: scheme + authority + the path lowercased. Preserving scheme/authority
 *  avoids merging same-path files from different providers; case-folding the path keeps a Windows drive-letter
 *  case difference (rules auto-scan vs an `@`-import of the same file) deduped. Falls back to the label. (On a
 *  case-sensitive FS this can over-merge files differing only by case - an accepted edge for memory files.) */
function dedupKey(resource: URI | undefined, label: string): string {
	return resource ? `${resource.scheme}://${resource.authority}${resource.path.toLowerCase()}` : `label:${label}`;
}

/** Build the always-on import sources for one memory/rule file (its transitively-resolved `@`-imports), tagged
 *  with the importer's tier/scope. Added after the primaries so an auto-scanned file wins over its import dup. */
function importSources(meta: IConfigBudgetMeta, scope: ConfigScope, tier: BudgetTier): IBudgetSource[] {
	return (meta.imports ?? []).map(imp => ({
		label: imp.label,
		scope,
		tier,
		kind: 'import' as const,
		approxTokens: imp.approxTokens,
		resource: URI.parse(imp.uri),
	}));
}

/**
 * Resolve the context budget for the active file from the config snapshot. Pure: pass the active file URI and
 * the workspace folder URIs (to compute the relative path that rule `paths` match against).
 */
export function resolveContextBudget(
	snapshot: IClawdiusConfigSnapshot,
	activeFile: URI | undefined,
	workspaceFolders: readonly URI[],
	nestedMemories: readonly IConfigItem[] = [],
): IContextBudget {
	const folder = containingFolderOf(activeFile, workspaceFolders);
	// The active file's path relative to its own project folder (so a rule's `paths` match within that project),
	// or its basename when it is outside every folder.
	const relPath = activeFile ? (folder ? extUriIgnorePathCase.relativePath(folder, activeFile) : undefined) ?? basename(activeFile) : undefined;

	// Always-on sources deduped by path: primaries (memories, always-rules, matched path-rules, automem) win
	// over @-import duplicates of the same file. Insertion order preserved by Map.
	const alwaysOn = new Map<string, IBudgetSource>();
	const deferredImports: IBudgetSource[] = [];
	const onInvoke: IBudgetSource[] = [];
	const notApplied: IBudgetSource[] = [];

	const addPrimary = (src: IBudgetSource, meta: IConfigBudgetMeta) => {
		const key = dedupKey(src.resource, src.label);
		if (!alwaysOn.has(key)) { alwaysOn.set(key, src); }
		deferredImports.push(...importSources(meta, src.scope, src.tier));
	};

	for (const scopeGroup of snapshot.scopes) {
		// A Project scope applies only when the active file lives in THAT project's folder (its `key` is the
		// folder URI string). Managed + Global (user) scopes always apply. Compare case-insensitively so a
		// drive-letter case difference can't drop the project scope.
		if (scopeGroup.scope === ConfigScope.Project && (!folder || !extUriIgnorePathCase.isEqual(URI.parse(scopeGroup.key), folder))) {
			continue;
		}
		for (const section of scopeGroup.sections) {
			if (section.section === ConfigSection.Memories) {
				for (const item of section.items) {
					const b = item.budget;
					if (!b) { continue; }
					if (b.inclusion === ContextInclusion.Always) {
						addPrimary(toSource(item, scopeGroup.scope), b);
					} else if (b.inclusion === ContextInclusion.Glob) {
						if (anyGlobApplies(b.paths, relPath)) {
							addPrimary(toSource(item, scopeGroup.scope, true), b);
						} else {
							notApplied.push(toSource(item, scopeGroup.scope, false));
						}
					}
				}
			} else if (section.section === ConfigSection.Skills) {
				for (const item of section.items) {
					if (item.budget) { onInvoke.push(toSource(item, scopeGroup.scope)); }
				}
			}
		}
	}

	// Nested/subtree CLAUDE.md files along the active file's path: they load on demand (nested_traversal) when
	// Claude reads files under them, so they belong in always-on for THIS file. Added as primaries (their own
	// @-imports defer too), deduped by path against the static scan.
	for (const item of nestedMemories) {
		const b = item.budget;
		if (b && b.inclusion === ContextInclusion.Always) {
			addPrimary(toSource(item, ConfigScope.Project), b);
		}
	}

	// Fold in imports after all primaries, so a file that is both auto-scanned and @-imported counts once.
	for (const imp of deferredImports) {
		const key = dedupKey(imp.resource, imp.label);
		if (!alwaysOn.has(key)) { alwaysOn.set(key, imp); }
	}

	// The skill "menu" (each skill's name + description) is injected into the system prompt every turn so the
	// model can decide what to invoke - an always-on cost that grows with skill count. Aggregate it into one row.
	const menuTokens = onInvoke.reduce((sum, s) => sum + (s.menuTokens ?? 0), 0);
	if (menuTokens > 0) {
		alwaysOn.set('synthetic:skillMenu', {
			label: 'skill menu (names + descriptions)',
			scope: ConfigScope.Global,
			tier: BudgetTier.User,
			kind: 'menu',
			approxTokens: menuTokens,
		});
	}

	const sources = [...alwaysOn.values()];
	const alwaysOnTokens = sources.reduce((sum, s) => sum + s.approxTokens, 0);
	return { activeFile, alwaysOn: sources, onInvoke, notApplied, alwaysOnTokens };
}

/** Estimate tokens for text without a real tokenizer. Weights by character class: CJK / full-width / Hangul
 *  count ~1 token each (chars/4 badly under-counts them), everything else ~4 chars/token (English prose). An
 *  estimate, never exact - the UI always labels it. Keep the raw char count alongside so a real tokenizer can
 *  replace this later. */
export function estimateTokens(text: string): number {
	let cjk = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) {
			cjk++;
		}
	}
	return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Compact, honest token label: "~420", "~1.2k". Always carries the leading "~" (these are estimates). */
export function formatApproxTokens(tokens: number): string {
	if (tokens < 1000) { return `~${tokens}`; }
	return `~${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Normalize an absolute file path for set membership / equality across the Claude Code hook payload
 * (`file_path`) and a VS Code `URI.fsPath`. Claude documents `file_path` as absolute but does not promise
 * separator spelling or drive-letter casing, so collapse `\` to `/` and lowercase before comparing - else
 * the confirmed-load badges silently never match on Windows.
 */
export function normalizeConfirmedPath(p: string): string {
	return p.replace(/\\/g, '/').toLowerCase();
}
// CLAWDIUS-END
