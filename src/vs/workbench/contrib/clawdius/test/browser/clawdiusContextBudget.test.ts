/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ConfigScope, ConfigSection, ContextInclusion, IClawdiusConfigSnapshot, IConfigBudgetMeta, IConfigItem,
} from '../../common/clawdiusConfig.js';
import { BudgetTier, classifyMeasured, estimateTokens, formatApproxTokens, normalizeConfirmedPath, resolveContextBudget } from '../../common/clawdiusContextBudget.js';
import { dropPartialFirstLine, encodeProjectDir, extractPaths, isClaudeMdExcluded, nestedDirChain, parseConfirmedLoads, parseImportTargets, parseMeasuredPrefix } from '../../browser/clawdiusConfigStore.js';

function memoriesScope(scope: ConfigScope, key: string, root: URI, items: IConfigItem[], folderName?: string) {
	return { scope, key, root, folderName, exists: true, sections: [{ section: ConfigSection.Memories, items }] };
}

// A unique on-disk path per (scope, label) so the resolver's path dedup behaves like real data (where each
// source is a distinct file). The import-dedup test references these paths explicitly.
function pathFor(scope: ConfigScope, label: string): URI {
	return URI.file(`/x/${scope}/${label}`);
}

function item(scope: ConfigScope, section: ConfigSection, label: string, budget: IConfigBudgetMeta): IConfigItem {
	return { id: `${scope}:${section}:${label}`, scope, section, label, resource: pathFor(scope, label), budget };
}

function snapshot(): IClawdiusConfigSnapshot {
	return {
		scopes: [
			memoriesScope(ConfigScope.Global, 'global', URI.file('/home/.claude'), [
				item(ConfigScope.Global, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 420, chars: 1680, inclusion: ContextInclusion.Always }),
				item(ConfigScope.Global, ConfigSection.Memories, 'rules/python.md', { kind: 'rule', approxTokens: 50, chars: 200, inclusion: ContextInclusion.Glob, paths: ['*.py'] }),
			]),
			{
				scope: ConfigScope.Global, key: 'global', root: URI.file('/home/.claude'), exists: true,
				sections: [{
					section: ConfigSection.Skills, items: [
						item(ConfigScope.Global, ConfigSection.Skills, 'api-design', { kind: 'skill', approxTokens: 300, chars: 1200, inclusion: ContextInclusion.Manual }),
					],
				}],
			},
			memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [
				item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 180, chars: 720, inclusion: ContextInclusion.Always }),
				item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.local.md', { kind: 'memory', approxTokens: 30, chars: 120, inclusion: ContextInclusion.Always }),
				item(ConfigScope.Project, ConfigSection.Memories, 'rules/typescript.md', { kind: 'rule', approxTokens: 95, chars: 380, inclusion: ContextInclusion.Glob, paths: ['*.ts'] }),
			], 'work'),
		],
	};
}

suite('clawdiusContextBudget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const folders = [URI.file('/work')];

	test('resolves buckets, path-rule match, tiers and the always-on total for a .ts file', () => {
		const budget = resolveContextBudget(snapshot(), URI.file('/work/src/auth/login.ts'), folders);

		assert.deepStrictEqual(budget.alwaysOn.map(s => s.label).sort(), ['CLAUDE.local.md', 'CLAUDE.md', 'CLAUDE.md', 'rules/typescript.md']);
		assert.deepStrictEqual(budget.notApplied.map(s => s.label), ['rules/python.md']);
		assert.deepStrictEqual(budget.onInvoke.map(s => s.label), ['api-design']);
		assert.strictEqual(budget.alwaysOnTokens, 725); // 420 + 180 + 30 + 95

		const local = budget.alwaysOn.find(s => s.label === 'CLAUDE.local.md');
		assert.strictEqual(local?.tier, BudgetTier.Local);
		assert.strictEqual(budget.alwaysOn.find(s => s.scope === ConfigScope.Global)?.tier, BudgetTier.User);
		const projMemory = budget.alwaysOn.find(s => s.label === 'CLAUDE.md' && s.scope === ConfigScope.Project);
		assert.strictEqual(projMemory?.tier, BudgetTier.Project);
		assert.strictEqual(budget.alwaysOn.find(s => s.label === 'rules/typescript.md')?.matched, true);
	});

	test('a .py file flips which path-scoped rule applies', () => {
		const budget = resolveContextBudget(snapshot(), URI.file('/work/scripts/run.py'), folders);
		assert.ok(budget.alwaysOn.some(s => s.label === 'rules/python.md'));
		assert.deepStrictEqual(budget.notApplied.map(s => s.label), ['rules/typescript.md']);
		assert.strictEqual(budget.alwaysOnTokens, 680); // 420 + 180 + 30 + 50
	});

	test('with no active file, path-scoped rules are not counted as always-on', () => {
		const budget = resolveContextBudget(snapshot(), undefined, folders);
		assert.deepStrictEqual(budget.alwaysOn.map(s => s.label).sort(), ['CLAUDE.local.md', 'CLAUDE.md', 'CLAUDE.md']);
		assert.strictEqual(budget.alwaysOnTokens, 630);
		assert.deepStrictEqual(budget.notApplied.map(s => s.label).sort(), ['rules/python.md', 'rules/typescript.md']);
	});

	test('nested CLAUDE.md along the active file path folds into always-on, marked nested', () => {
		const nested = [
			item(ConfigScope.Project, ConfigSection.Memories, 'src/CLAUDE.md', { kind: 'memory', approxTokens: 60, chars: 240, inclusion: ContextInclusion.Always, nested: true }),
		];
		const base = resolveContextBudget(snapshot(), URI.file('/work/src/auth/login.ts'), folders);
		const withNested = resolveContextBudget(snapshot(), URI.file('/work/src/auth/login.ts'), folders, nested);
		const nestedSrc = withNested.alwaysOn.find(s => s.label === 'src/CLAUDE.md');
		assert.strictEqual(nestedSrc?.nested, true);
		assert.strictEqual(nestedSrc?.tier, BudgetTier.Project);
		assert.strictEqual(withNested.alwaysOn.length, base.alwaysOn.length + 1);
		assert.strictEqual(withNested.alwaysOnTokens, base.alwaysOnTokens + 60);
	});

	test('a brace path (*.{ts,tsx}) matches a .tsx file', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [
				item(ConfigScope.Project, ConfigSection.Memories, 'rules/react.md', { kind: 'rule', approxTokens: 40, chars: 160, inclusion: ContextInclusion.Glob, paths: ['*.{ts,tsx}'] }),
			], 'work')],
		};
		const tsx = resolveContextBudget(snap, URI.file('/work/src/App.tsx'), folders);
		assert.ok(tsx.alwaysOn.some(s => s.label === 'rules/react.md'), 'brace path should match .tsx');
		const md = resolveContextBudget(snap, URI.file('/work/README.md'), folders);
		assert.deepStrictEqual(md.notApplied.map(s => s.label), ['rules/react.md']);
	});

	test('a directory path (src/**) matches files under that directory, not files outside it', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [
				item(ConfigScope.Project, ConfigSection.Memories, 'rules/api.md', { kind: 'rule', approxTokens: 30, chars: 120, inclusion: ContextInclusion.Glob, paths: ['src/**'] }),
			], 'work')],
		};
		assert.ok(resolveContextBudget(snap, URI.file('/work/src/auth/login.ts'), folders).alwaysOn.some(s => s.label === 'rules/api.md'));
		assert.deepStrictEqual(resolveContextBudget(snap, URI.file('/work/README.md'), folders).notApplied.map(s => s.label), ['rules/api.md']);
	});

	test('multi-root: an unrelated project folder\'s memory + rules are excluded', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [
				memoriesScope(ConfigScope.Project, 'file:///repoA', URI.file('/repoA/.claude'), [
					item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 100, chars: 400, inclusion: ContextInclusion.Always }),
					item(ConfigScope.Project, ConfigSection.Memories, 'rules/src.md', { kind: 'rule', approxTokens: 20, chars: 80, inclusion: ContextInclusion.Glob, paths: ['src/**'] }),
				], 'repoA'),
				memoriesScope(ConfigScope.Project, 'file:///repoB', URI.file('/repoB/.claude'), [
					item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 70, chars: 280, inclusion: ContextInclusion.Always }),
				], 'repoB'),
			],
		};
		const budget = resolveContextBudget(snap, URI.file('/repoB/src/foo.ts'), [URI.file('/repoA'), URI.file('/repoB')]);
		assert.deepStrictEqual(budget.alwaysOn.map(s => s.label), ['CLAUDE.md']);
		assert.strictEqual(budget.alwaysOnTokens, 70);
		assert.strictEqual(budget.notApplied.length, 0);
	});

	test('project containment is case-insensitive (Windows drive-letter / path casing)', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [memoriesScope(ConfigScope.Project, URI.file('/Work').toString(), URI.file('/Work/.claude'), [
				item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 50, chars: 200, inclusion: ContextInclusion.Always }),
			], 'Work')],
		};
		const budget = resolveContextBudget(snap, URI.file('/work/src/foo.ts'), [URI.file('/Work')]);
		assert.deepStrictEqual(budget.alwaysOn.map(s => s.label), ['CLAUDE.md']);
		assert.strictEqual(budget.alwaysOnTokens, 50);
	});

	test('@-imports are folded into always-on and deduped against an auto-scanned rule', () => {
		const sharedUri = URI.file('/x/project/rules/shared.md').toString();
		const docsUri = URI.file('/x/project/docs/style.md').toString();
		const snap: IClawdiusConfigSnapshot = {
			scopes: [memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [
				item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', {
					kind: 'memory', approxTokens: 100, chars: 400, inclusion: ContextInclusion.Always,
					imports: [{ uri: sharedUri, label: 'rules/shared.md', approxTokens: 50 }, { uri: docsUri, label: 'docs/style.md', approxTokens: 80 }],
				}),
				// rules/shared.md is ALSO auto-scanned - it must count once, not twice.
				item(ConfigScope.Project, ConfigSection.Memories, 'rules/shared.md', { kind: 'rule', approxTokens: 50, chars: 200, inclusion: ContextInclusion.Always }),
			], 'work')],
		};
		const budget = resolveContextBudget(snap, URI.file('/work/x.ts'), folders);
		assert.deepStrictEqual(budget.alwaysOn.map(s => s.label).sort(), ['CLAUDE.md', 'docs/style.md', 'rules/shared.md']);
		assert.strictEqual(budget.alwaysOnTokens, 230); // 100 + 50 (shared, once) + 80 (docs import)
		assert.strictEqual(budget.alwaysOn.find(s => s.label === 'docs/style.md')?.kind, 'import');
	});

	test('Managed (org-policy) memory is always-on with the Managed tier', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [
				memoriesScope(ConfigScope.Managed, 'managed', URI.file('/mgd/.claude'), [
					item(ConfigScope.Managed, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 60, chars: 240, inclusion: ContextInclusion.Always }),
				]),
				memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [
					item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 40, chars: 160, inclusion: ContextInclusion.Always }),
				], 'work'),
			],
		};
		const budget = resolveContextBudget(snap, URI.file('/work/x.ts'), folders);
		const managed = budget.alwaysOn.find(s => s.scope === ConfigScope.Managed);
		assert.strictEqual(managed?.tier, BudgetTier.Managed);
		assert.strictEqual(budget.alwaysOnTokens, 100); // 60 managed + 40 project
	});

	test('nested multi-root resolves to the most-specific (inner) folder', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [
				memoriesScope(ConfigScope.Project, URI.file('/work').toString(), URI.file('/work/.claude'), [
					item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 200, chars: 800, inclusion: ContextInclusion.Always }),
				], 'work'),
				memoriesScope(ConfigScope.Project, URI.file('/work/inner').toString(), URI.file('/work/inner/.claude'), [
					item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 50, chars: 200, inclusion: ContextInclusion.Always }),
				], 'inner'),
			],
		};
		// A file in the inner root resolves to inner only (not the outer root).
		const budget = resolveContextBudget(snap, URI.file('/work/inner/src/x.ts'), [URI.file('/work'), URI.file('/work/inner')]);
		assert.strictEqual(budget.alwaysOnTokens, 50);
	});

	test('an anchored path (/src/**) matches files under the root src directory', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [
				item(ConfigScope.Project, ConfigSection.Memories, 'rules/api.md', { kind: 'rule', approxTokens: 30, chars: 120, inclusion: ContextInclusion.Glob, paths: ['/src/**'] }),
			], 'work')],
		};
		assert.ok(resolveContextBudget(snap, URI.file('/work/src/x.ts'), folders).alwaysOn.some(s => s.label === 'rules/api.md'));
		assert.deepStrictEqual(resolveContextBudget(snap, URI.file('/work/lib/x.ts'), folders).notApplied.map(s => s.label), ['rules/api.md']);
	});

	test('an anchored basename path (/*.ts) matches only root-level files, not nested', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [
				item(ConfigScope.Project, ConfigSection.Memories, 'rules/root.md', { kind: 'rule', approxTokens: 10, chars: 40, inclusion: ContextInclusion.Glob, paths: ['/*.ts'] }),
			], 'work')],
		};
		assert.ok(resolveContextBudget(snap, URI.file('/work/index.ts'), folders).alwaysOn.some(s => s.label === 'rules/root.md'));
		assert.deepStrictEqual(resolveContextBudget(snap, URI.file('/work/src/deep.ts'), folders).notApplied.map(s => s.label), ['rules/root.md']);
	});

	test('a memory file exposes its per-heading token breakdown (heaviest resolvable)', () => {
		const here = URI.file('/work/CLAUDE.md');
		const child = (label: string, line: number, tokens: number): IConfigItem => ({
			id: `h:${label}`, scope: ConfigScope.Project, section: ConfigSection.Memories, label, resource: here,
			reveal: { lineNumber: line }, budget: { kind: 'memory', approxTokens: tokens, chars: tokens * 4, inclusion: ContextInclusion.Always },
		});
		const mem: IConfigItem = {
			id: 'p:memories:CLAUDE.md', scope: ConfigScope.Project, section: ConfigSection.Memories, label: 'CLAUDE.md', resource: here,
			budget: { kind: 'memory', approxTokens: 100, chars: 400, inclusion: ContextInclusion.Always },
			children: [child('Intro', 1, 30), child('Rules', 10, 70)],
		};
		const snap: IClawdiusConfigSnapshot = { scopes: [memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [mem], 'work')] };
		const src = resolveContextBudget(snap, URI.file('/work/x.ts'), folders).alwaysOn.find(s => s.label === 'CLAUDE.md');
		assert.strictEqual(src?.headings?.length, 2);
		assert.strictEqual(src?.headings?.find(h => h.label === 'Rules')?.approxTokens, 70);
	});

	test('parseImportTargets skips code fences/spans and reads ~/, relative, bare forms', () => {
		const md = ['@~/.claude/rules/a.md', '`@not-an-import`', '```', '@inside-fence.md', '```', '~~~', '@inside-tilde.md', '~~~', 'see @./rel.md here'].join('\n');
		assert.deepStrictEqual(parseImportTargets(md), ['~/.claude/rules/a.md', './rel.md']);
	});

	test('extractPaths parses inline array, comma list, brace group, block list; ** is treated as always-on', () => {
		assert.deepStrictEqual(extractPaths('---\npaths: ["*.ts","*.tsx"]\n---\nbody'), ['*.ts', '*.tsx']);
		assert.deepStrictEqual(extractPaths('---\npaths: *.ts, *.tsx\n---\nbody'), ['*.ts', '*.tsx']);
		assert.deepStrictEqual(extractPaths('---\npaths: *.{ts,tsx}\n---\nbody'), ['*.{ts,tsx}']);
		assert.deepStrictEqual(extractPaths('---\npaths:\n  - "src/api/**/*.ts"\n  - src/*.tsx\n---\nbody'), ['src/api/**/*.ts', 'src/*.tsx']);
		// No paths key, or a bare ** => unconditional (always-on) => undefined.
		assert.strictEqual(extractPaths('---\ndescription: a rule\n---\nbody'), undefined);
		assert.strictEqual(extractPaths('---\npaths: **\n---\nbody'), undefined);
		// Cursor's globs:/alwaysApply: keys are NOT Claude Code keys => ignored.
		assert.strictEqual(extractPaths('---\nglobs: *.ts\nalwaysApply: false\n---\nbody'), undefined);
		assert.strictEqual(extractPaths('no frontmatter here'), undefined);
	});

	test('normalizeConfirmedPath collapses backslashes and case so a Windows + POSIX spelling match', () => {
		assert.deepStrictEqual(
			[normalizeConfirmedPath('C:\\Users\\X\\CLAUDE.md'), normalizeConfirmedPath('c:/users/x/claude.md')],
			['c:/users/x/claude.md', 'c:/users/x/claude.md'],
		);
	});

	test('classifyMeasured distinguishes delta / estimate-exceeds-measured / equal', () => {
		assert.deepStrictEqual(classifyMeasured(40000, 5000), { kind: 'delta', remainder: 35000 });
		assert.deepStrictEqual(classifyMeasured(3000, 5000), { kind: 'exceeds' }); // the honesty-bug case
		assert.deepStrictEqual(classifyMeasured(5000, 5000), { kind: 'equal' });
	});

	test('dropPartialFirstLine removes the truncated leading record but keeps a newline-less window whole', () => {
		assert.strictEqual(dropPartialFirstLine('rtial\n{"a":1}\n{"b":2}'), '{"a":1}\n{"b":2}');
		assert.strictEqual(dropPartialFirstLine('one-line-no-newline'), 'one-line-no-newline');
	});

	test('nestedDirChain returns dirs between the folder (exclusive) and the active file dir (inclusive), outer-first', () => {
		assert.deepStrictEqual(
			nestedDirChain(URI.file('/work/a/b/c/login.ts'), URI.file('/work')).map(u => u.path),
			['/work/a', '/work/a/b', '/work/a/b/c'],
		);
		assert.deepStrictEqual(nestedDirChain(URI.file('/work/x.ts'), URI.file('/work')), []); // file in root -> no nested
	});

	test('parseConfirmedLoads scopes by cwd, keeps the most recent record per path, and tolerates junk', () => {
		const lines = [
			'{"file_path":"/work/a.md","cwd":"/work","load_reason":"session_start"}',
			'not json',
			'{"file_path":"/work/a.md","cwd":"/work/sub","load_reason":"include"}',   // later record for a.md wins
			'{"file_path":"/other/b.md","cwd":"/workother"}',                          // cwd outside scope -> dropped
			'{"file_path":"/work/c.md","cwd":42}',                                     // non-string cwd -> dropped
		].join('\n');
		const map = parseConfirmedLoads(lines, ['/work']);
		assert.deepStrictEqual([...map.keys()].sort(), ['/work/a.md']);
		assert.strictEqual(map.get('/work/a.md')?.loadReason, 'include'); // most-recent-wins
		assert.strictEqual(parseConfirmedLoads(lines, []).size, 3); // empty scopes admits all valid records
	});

	test('encodeProjectDir replaces every non-alphanumeric (matching Claude Code projects/<enc>)', () => {
		// Verified against real ~/.claude/projects names: a dot flips to '-' too, not just separators (the bug
		// was replacing only [\\/:], which left '.' intact and mismatched the real dir for any dotted path).
		// Drive-letter paths make fsPath platform-dependent, so pin the behavior with separator-only paths whose
		// fsPath is identical on Windows and POSIX.
		assert.strictEqual(encodeProjectDir(URI.file('/Users/x/my.app')), '-Users-x-my-app');
		assert.strictEqual(encodeProjectDir(URI.file('/x/.config')), '-x--config'); // separator + dot => two dashes
	});

	test('isClaudeMdExcluded matches an absolute path or a glob, case-insensitively when asked', () => {
		const p = '/proj/src/CLAUDE.md';
		assert.deepStrictEqual(
			[
				isClaudeMdExcluded(p, [], false),
				isClaudeMdExcluded(p, ['/proj/src/CLAUDE.md'], false),     // exact absolute path
				isClaudeMdExcluded(p, ['**/src/CLAUDE.md'], false),        // glob (both forms verified live)
				isClaudeMdExcluded(p, ['/proj/other/CLAUDE.md'], false),   // unrelated path
				isClaudeMdExcluded(p, ['**/test/CLAUDE.md'], false),       // unrelated glob
				isClaudeMdExcluded('C:\\Proj\\Src\\CLAUDE.md', ['c:/proj/src/claude.md'], true), // win case-insensitive
			],
			[false, true, true, false, false, true],
		);
	});

	test('estimateTokens weights CJK ~1/char and prose ~1/4 chars', () => {
		assert.strictEqual(estimateTokens(''), 0);
		assert.strictEqual(estimateTokens('abcd'), 1);
		assert.strictEqual(estimateTokens('a'.repeat(400)), 100);
		assert.strictEqual(estimateTokens('你好世界'), 4); // 4 CJK chars -> ~4 tokens
		assert.ok(estimateTokens('中'.repeat(100)) >= 100);
	});

	test('the skill menu (names + descriptions) is aggregated into one always-on row', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [{
				scope: ConfigScope.Global, key: 'global', root: URI.file('/home/.claude'), exists: true,
				sections: [{
					section: ConfigSection.Skills, items: [
						item(ConfigScope.Global, ConfigSection.Skills, 'a', { kind: 'skill', approxTokens: 500, chars: 2000, inclusion: ContextInclusion.Manual, menuTokens: 12 }),
						item(ConfigScope.Global, ConfigSection.Skills, 'b', { kind: 'skill', approxTokens: 300, chars: 1200, inclusion: ContextInclusion.Manual, menuTokens: 8 }),
					],
				}],
			}],
		};
		const budget = resolveContextBudget(snap, undefined, []);
		const menu = budget.alwaysOn.find(s => s.kind === 'menu');
		assert.strictEqual(menu?.approxTokens, 20); // 12 + 8 menu tokens
		assert.strictEqual(budget.alwaysOnTokens, 20);
		assert.strictEqual(budget.onInvoke.length, 2); // the skill bodies are still on-invoke
	});

	test('parseMeasuredPrefix reads the last assistant turn\'s cached prefix from a JSONL transcript', () => {
		const jsonl = [
			JSON.stringify({ type: 'user', message: { content: 'hi' } }),
			JSON.stringify({ type: 'assistant', timestamp: '2026-06-27T10:00:00Z', message: { usage: { cache_creation_input_tokens: 17000, input_tokens: 12000 } } }),
			JSON.stringify({ type: 'user', message: { content: 'more' } }),
			JSON.stringify({ type: 'assistant', timestamp: '2026-06-27T10:05:00Z', message: { usage: { cache_read_input_tokens: 34000, cache_creation_input_tokens: 500, input_tokens: 80 } } }),
			'', // trailing blank line
		].join('\n');
		const m = parseMeasuredPrefix(jsonl);
		assert.strictEqual(m?.tokens, 34500); // last turn: cache_read 34000 + cache_creation 500
		assert.strictEqual(m?.atIso, '2026-06-27T10:05:00Z');
		assert.strictEqual(parseMeasuredPrefix('not json\n{bad'), undefined);
		assert.strictEqual(parseMeasuredPrefix(''), undefined);
	});

	test('formatApproxTokens', () => {
		assert.strictEqual(formatApproxTokens(0), '~0');
		assert.strictEqual(formatApproxTokens(420), '~420');
		assert.strictEqual(formatApproxTokens(999), '~999');
		assert.strictEqual(formatApproxTokens(1200), '~1.2k');
		assert.strictEqual(formatApproxTokens(15400), '~15.4k');
	});
});
