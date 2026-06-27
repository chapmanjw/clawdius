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
import { BudgetTier, formatApproxTokens, resolveContextBudget } from '../../common/clawdiusContextBudget.js';
import { extractPaths } from '../../browser/clawdiusConfigStore.js';

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

	test('formatApproxTokens', () => {
		assert.strictEqual(formatApproxTokens(0), '~0');
		assert.strictEqual(formatApproxTokens(420), '~420');
		assert.strictEqual(formatApproxTokens(999), '~999');
		assert.strictEqual(formatApproxTokens(1200), '~1.2k');
		assert.strictEqual(formatApproxTokens(15400), '~15.4k');
	});
});
