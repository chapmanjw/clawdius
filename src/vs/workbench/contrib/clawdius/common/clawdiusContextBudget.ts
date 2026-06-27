/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Context Budget Inspector - resolver
// Pure logic for "what does Claude see for THIS file?": given the config snapshot + the active file, sort the
// memory / rule / skill sources into ALWAYS-ON (loaded every turn), ON-INVOKE (skills), and NOT-APPLIED (glob
// rules whose patterns the active file does not match), with an estimated token total. No I/O, no services -
// every input is already in the snapshot (the store read the files during its scan), so this is unit-testable.
//
// Honesty: token counts are estimates (chars / 4), never exact - there is no in-process tokenizer, and the
// only signal of what *actually* loaded for a turn (an InstructionsLoaded-style hook) does not exist yet, so
// every source here is PREDICTED, not confirmed. The UI labels it as such.

import { match as globMatch } from '../../../../base/common/glob.js';
import { basename, extUriIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ConfigScope, ConfigSection, ContextInclusion, IClawdiusConfigSnapshot, IConfigItem } from './clawdiusConfig.js';

/** The precedence tier a source belongs to. Derived from scope + filename; managed/enterprise is not scanned
 *  (no managed path exists), so it is never produced - the UI shows it as "not detected" if it surfaces that. */
export const enum BudgetTier {
	User = 'user',
	Project = 'project',
	Local = 'local',
}

/** One context source (a memory file, a rule, or a skill) as resolved for the active file. */
export interface IBudgetSource {
	readonly label: string;
	readonly scope: ConfigScope;
	readonly tier: BudgetTier;
	readonly kind: 'memory' | 'rule' | 'skill';
	readonly approxTokens: number;
	readonly resource?: URI;
	/** For a glob rule: its frontmatter glob patterns (so the UI can show which patterns scope it). */
	readonly globs?: readonly string[];
	/** For a glob rule: whether the active file matched (true -> always-on, false -> not-applied). */
	readonly matched?: boolean;
}

/** The resolved context budget for one active file. */
export interface IContextBudget {
	readonly activeFile?: URI;
	/** Sources loaded every turn for this file: memories + always-rules + matching glob-rules. */
	readonly alwaysOn: readonly IBudgetSource[];
	/** Skills - loaded on demand, not every turn. */
	readonly onInvoke: readonly IBudgetSource[];
	/** Glob rules whose patterns the active file did not match. */
	readonly notApplied: readonly IBudgetSource[];
	/** Sum of `approxTokens` across `alwaysOn` (the every-turn cost). Estimated. */
	readonly alwaysOnTokens: number;
}

/** Derive the precedence tier from scope + the memory file's label. */
function tierOf(scope: ConfigScope, label: string): BudgetTier {
	if (scope === ConfigScope.Global) { return BudgetTier.User; }
	return label === 'CLAUDE.local.md' ? BudgetTier.Local : BudgetTier.Project;
}

/** The workspace folder that contains the active file. Project scopes apply only to their own folder; with no
 *  active file we can disambiguate only a single-root workspace. Uses URI identity (authority + path casing). */
function containingFolderOf(activeFile: URI | undefined, folders: readonly URI[]): URI | undefined {
	if (activeFile) {
		// Ignore path casing: on Windows the workspace folder + the active file can differ only by drive-letter
		// case (`/C:/...` vs `/c:/...`), which a case-sensitive compare would wrongly treat as unrelated.
		return folders.find(folder => extUriIgnorePathCase.isEqualOrParent(activeFile, folder));
	}
	return folders.length === 1 ? folders[0] : undefined;
}

/** Does a rule glob apply to the active file? A bare pattern (`*.ts`, no slash) applies to that file type at
 *  any depth (matched on the basename + as `**`-prefixed); a rooted pattern (`src/**`) matches the relative
 *  path. Mirrors how path-scoped rules are commonly authored. */
function globApplies(glob: string, relPath: string): boolean {
	const basename = relPath.split('/').pop() ?? relPath;
	if (!glob.includes('/')) {
		return globMatch(glob, basename) || globMatch('**/' + glob, relPath);
	}
	return globMatch(glob, relPath);
}

function anyGlobApplies(globs: readonly string[] | undefined, relPath: string | undefined): boolean {
	if (!globs || globs.length === 0 || relPath === undefined) { return false; }
	return globs.some(g => globApplies(g, relPath));
}

function toSource(item: IConfigItem, scope: ConfigScope, matched?: boolean): IBudgetSource {
	const b = item.budget!;
	return {
		label: item.label,
		scope,
		tier: tierOf(scope, item.label),
		kind: b.kind,
		approxTokens: b.approxTokens,
		resource: item.resource,
		globs: b.globs,
		matched,
	};
}

/**
 * Resolve the context budget for the active file from the config snapshot. Pure: pass the active file URI and
 * the workspace folder URIs (to compute the relative path that rule globs match against).
 */
export function resolveContextBudget(
	snapshot: IClawdiusConfigSnapshot,
	activeFile: URI | undefined,
	workspaceFolders: readonly URI[],
): IContextBudget {
	const folder = containingFolderOf(activeFile, workspaceFolders);
	// The active file's path relative to its own project folder (so a rule's globs match within that project),
	// or its basename when it is outside every folder.
	const relPath = activeFile ? (folder ? extUriIgnorePathCase.relativePath(folder, activeFile) : undefined) ?? basename(activeFile) : undefined;
	const alwaysOn: IBudgetSource[] = [];
	const onInvoke: IBudgetSource[] = [];
	const notApplied: IBudgetSource[] = [];

	for (const scopeGroup of snapshot.scopes) {
		// A Project scope applies only when the active file lives in THAT project's folder (its `key` is the
		// folder URI string); the Global (user) scope always applies. This keeps an unrelated multi-root
		// project's memories and rules out of the active file's budget. Compare case-insensitively so a
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
						alwaysOn.push(toSource(item, scopeGroup.scope));
					} else if (b.inclusion === ContextInclusion.Glob) {
						const matched = anyGlobApplies(b.globs, relPath);
						(matched ? alwaysOn : notApplied).push(toSource(item, scopeGroup.scope, matched));
					}
				}
			} else if (section.section === ConfigSection.Skills) {
				for (const item of section.items) {
					if (item.budget) { onInvoke.push(toSource(item, scopeGroup.scope)); }
				}
			}
		}
	}

	const alwaysOnTokens = alwaysOn.reduce((sum, s) => sum + s.approxTokens, 0);
	return { activeFile, alwaysOn, onInvoke, notApplied, alwaysOnTokens };
}

/** Compact, honest token label: "~420", "~1.2k". Always carries the leading "~" (these are estimates). */
export function formatApproxTokens(tokens: number): string {
	if (tokens < 1000) { return `~${tokens}`; }
	return `~${(tokens / 1000).toFixed(1)}k`;
}
// CLAWDIUS-END
