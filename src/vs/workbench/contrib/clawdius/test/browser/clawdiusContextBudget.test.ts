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
import { extractGlobs } from '../../browser/clawdiusConfigStore.js';

function memoriesScope(scope: ConfigScope, key: string, root: URI, items: IConfigItem[], folderName?: string) {
	return { scope, key, root, folderName, exists: true, sections: [{ section: ConfigSection.Memories, items }] };
}

function item(scope: ConfigScope, section: ConfigSection, label: string, budget: IConfigBudgetMeta): IConfigItem {
	return { id: `${scope}:${section}:${label}`, scope, section, label, resource: URI.file(`/x/${label}`), budget };
}

function snapshot(): IClawdiusConfigSnapshot {
	return {
		scopes: [
			{
				scope: ConfigScope.Global, key: 'global', root: URI.file('/home/.claude'), exists: true,
				sections: [
					{
						section: ConfigSection.Memories, items: [
							item(ConfigScope.Global, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 420, chars: 1680, inclusion: ContextInclusion.Always }),
							item(ConfigScope.Global, ConfigSection.Memories, 'rules/python.md', { kind: 'rule', approxTokens: 50, chars: 200, inclusion: ContextInclusion.Glob, globs: ['*.py'] }),
						]
					},
					{
						section: ConfigSection.Skills, items: [
							item(ConfigScope.Global, ConfigSection.Skills, 'api-design', { kind: 'skill', approxTokens: 300, chars: 1200, inclusion: ContextInclusion.Manual }),
						]
					},
				],
			},
			{
				scope: ConfigScope.Project, key: 'file:///work', root: URI.file('/work/.claude'), folderName: 'work', exists: true,
				sections: [
					{
						section: ConfigSection.Memories, items: [
							item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 180, chars: 720, inclusion: ContextInclusion.Always }),
							item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.local.md', { kind: 'memory', approxTokens: 30, chars: 120, inclusion: ContextInclusion.Always }),
							item(ConfigScope.Project, ConfigSection.Memories, 'rules/typescript.md', { kind: 'rule', approxTokens: 95, chars: 380, inclusion: ContextInclusion.Glob, globs: ['*.ts'] }),
						]
					},
				],
			},
		],
	};
}

suite('clawdiusContextBudget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const folders = [URI.file('/work')];

	test('resolves buckets, glob match, tiers and the always-on total for a .ts file', () => {
		const budget = resolveContextBudget(snapshot(), URI.file('/work/src/auth/login.ts'), folders);

		// Always-on: 2 memories + 1 local memory + the matching *.ts rule (NOT the *.py rule).
		assert.deepStrictEqual(budget.alwaysOn.map(s => s.label).sort(), ['CLAUDE.local.md', 'CLAUDE.md', 'CLAUDE.md', 'rules/typescript.md']);
		// The *.py rule does not match a .ts file -> not applied.
		assert.deepStrictEqual(budget.notApplied.map(s => s.label), ['rules/python.md']);
		// Skills are on-invoke.
		assert.deepStrictEqual(budget.onInvoke.map(s => s.label), ['api-design']);
		// Always-on total = 420 + 180 + 30 + 95.
		assert.strictEqual(budget.alwaysOnTokens, 725);

		// Tier derivation: Global -> user, Project CLAUDE.md -> project, CLAUDE.local.md -> local.
		const local = budget.alwaysOn.find(s => s.label === 'CLAUDE.local.md');
		assert.strictEqual(local?.tier, BudgetTier.Local);
		assert.strictEqual(budget.alwaysOn.find(s => s.scope === ConfigScope.Global)?.tier, BudgetTier.User);
		const projMemory = budget.alwaysOn.find(s => s.label === 'CLAUDE.md' && s.scope === ConfigScope.Project);
		assert.strictEqual(projMemory?.tier, BudgetTier.Project);

		// The matched rule is flagged matched=true.
		assert.strictEqual(budget.alwaysOn.find(s => s.label === 'rules/typescript.md')?.matched, true);
	});

	test('a .py file flips which glob rule applies', () => {
		const budget = resolveContextBudget(snapshot(), URI.file('/work/scripts/run.py'), folders);
		assert.ok(budget.alwaysOn.some(s => s.label === 'rules/python.md'));
		assert.deepStrictEqual(budget.notApplied.map(s => s.label), ['rules/typescript.md']);
		// 420 + 180 + 30 + 50.
		assert.strictEqual(budget.alwaysOnTokens, 680);
	});

	test('with no active file, glob rules are not counted as always-on', () => {
		const budget = resolveContextBudget(snapshot(), undefined, folders);
		// Only the unconditional memories are always-on (no rule matches without a file).
		assert.deepStrictEqual(budget.alwaysOn.map(s => s.label).sort(), ['CLAUDE.local.md', 'CLAUDE.md', 'CLAUDE.md']);
		assert.strictEqual(budget.alwaysOnTokens, 630);
		assert.deepStrictEqual(budget.notApplied.map(s => s.label).sort(), ['rules/python.md', 'rules/typescript.md']);
	});

	test('a brace glob (*.{ts,tsx}) matches a .tsx file', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [memoriesScope(ConfigScope.Project, 'file:///work', URI.file('/work/.claude'), [
				item(ConfigScope.Project, ConfigSection.Memories, 'rules/react.md', { kind: 'rule', approxTokens: 40, chars: 160, inclusion: ContextInclusion.Glob, globs: ['*.{ts,tsx}'] }),
			], 'work')],
		};
		const tsx = resolveContextBudget(snap, URI.file('/work/src/App.tsx'), folders);
		assert.ok(tsx.alwaysOn.some(s => s.label === 'rules/react.md'), 'brace glob should match .tsx');
		const md = resolveContextBudget(snap, URI.file('/work/README.md'), folders);
		assert.deepStrictEqual(md.notApplied.map(s => s.label), ['rules/react.md']);
	});

	test('multi-root: an unrelated project folder\'s memory + rules are excluded', () => {
		const snap: IClawdiusConfigSnapshot = {
			scopes: [
				memoriesScope(ConfigScope.Project, 'file:///repoA', URI.file('/repoA/.claude'), [
					item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 100, chars: 400, inclusion: ContextInclusion.Always }),
					item(ConfigScope.Project, ConfigSection.Memories, 'rules/src.md', { kind: 'rule', approxTokens: 20, chars: 80, inclusion: ContextInclusion.Glob, globs: ['src/**'] }),
				], 'repoA'),
				memoriesScope(ConfigScope.Project, 'file:///repoB', URI.file('/repoB/.claude'), [
					item(ConfigScope.Project, ConfigSection.Memories, 'CLAUDE.md', { kind: 'memory', approxTokens: 70, chars: 280, inclusion: ContextInclusion.Always }),
				], 'repoB'),
			],
		};
		// A file in repoB must NOT pull repoA's CLAUDE.md or repoA's src/** rule (even though repoB/src/foo.ts matches src/**).
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
		// The active file references the folder with different casing (/work vs /Work) - the project memory must
		// still count (a case-sensitive compare would wrongly drop the whole project scope).
		const budget = resolveContextBudget(snap, URI.file('/work/src/foo.ts'), [URI.file('/Work')]);
		assert.deepStrictEqual(budget.alwaysOn.map(s => s.label), ['CLAUDE.md']);
		assert.strictEqual(budget.alwaysOnTokens, 50);
	});

	test('extractGlobs parses inline array, comma list, brace group, and a YAML block list', () => {
		assert.deepStrictEqual(extractGlobs('---\nglobs: ["*.ts","*.tsx"]\n---\nbody'), ['*.ts', '*.tsx']);
		assert.deepStrictEqual(extractGlobs('---\nglobs: *.ts, *.tsx\n---\nbody'), ['*.ts', '*.tsx']);
		assert.deepStrictEqual(extractGlobs('---\nglobs: *.{ts,tsx}\n---\nbody'), ['*.{ts,tsx}']);
		assert.deepStrictEqual(extractGlobs('---\nglobs:\n  - "**/*.ts"\n  - src/*.tsx\n---\nbody'), ['**/*.ts', 'src/*.tsx']);
		assert.strictEqual(extractGlobs('---\ndescription: a rule\n---\nbody'), undefined);
		assert.strictEqual(extractGlobs('no frontmatter here'), undefined);
	});

	test('formatApproxTokens', () => {
		assert.strictEqual(formatApproxTokens(0), '~0');
		assert.strictEqual(formatApproxTokens(420), '~420');
		assert.strictEqual(formatApproxTokens(999), '~999');
		assert.strictEqual(formatApproxTokens(1200), '~1.2k');
		assert.strictEqual(formatApproxTokens(15400), '~15.4k');
	});
});
