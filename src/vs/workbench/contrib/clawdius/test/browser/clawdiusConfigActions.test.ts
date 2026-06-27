/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigBacking, ConfigScope, ConfigSection, IConfigItem } from '../../common/clawdiusConfig.js';
import { commandRelPath, getAtPath, planDeletion, resolveCreateResource, slug } from '../../browser/clawdiusConfigActions.js';

suite('clawdiusConfigActions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('slug lowercases, collapses runs of unsafe chars, trims leading/trailing -. and keeps :', () => {
		const munchen = 'caf\u00e9 m\u00fcnchen'; // 'cafe munchen' with accented letters (unicode -> separators)
		assert.deepStrictEqual(
			['Code Reviewer', '  Trim Me  ', 'git:commit', 'PDF Filler!!!', 'a  @#  b', '--leading.and.trailing--', munchen, '', '...'].map(slug),
			['code-reviewer', 'trim-me', 'git:commit', 'pdf-filler', 'a-b', 'leading.and.trailing', 'caf-m-nchen', '', ''],
		);
	});

	test('commandRelPath slugs then maps the : namespace separator to a sub-folder', () => {
		assert.deepStrictEqual(
			['review', 'git:commit', 'tools:fmt:run'].map(commandRelPath),
			['review', 'git/commit', 'tools/fmt/run'],
		);
	});

	test('getAtPath walks objects/arrays and returns undefined off a non-object or missing key', () => {
		const obj = { mcpServers: { srv: { command: 'x' } }, permissions: { allow: ['Read(a)', 'Read(b)'] } };
		assert.deepStrictEqual(
			[
				getAtPath(obj, ['mcpServers', 'srv', 'command']),
				getAtPath(obj, ['permissions', 'allow', 1]),
				getAtPath(obj, ['permissions', 'allow']),
				getAtPath(obj, ['missing', 'x']),
				getAtPath(obj, ['mcpServers', 'srv', 'command', 'tooDeep']), // descends into a string -> undefined
				getAtPath(null, ['a']),
				getAtPath(obj, []),
			],
			['x', 'Read(b)', ['Read(a)', 'Read(b)'], undefined, undefined, undefined, obj],
		);
	});

	test('resolveCreateResource maps each section to its scope-correct on-disk file', () => {
		const global = { scope: ConfigScope.Global, claudeDir: URI.file('/home/.claude'), baseDir: URI.file('/home') };
		const project = { scope: ConfigScope.Project, claudeDir: URI.file('/work/.claude'), baseDir: URI.file('/work') };
		assert.deepStrictEqual(
			[
				resolveCreateResource(ConfigSection.Memories, global).path,
				resolveCreateResource(ConfigSection.Memories, project).path,
				resolveCreateResource(ConfigSection.Commands, project, 'git:commit').path,
				resolveCreateResource(ConfigSection.Skills, project, 'PDF Filler').path,
				resolveCreateResource(ConfigSection.Agents, global, 'Code Reviewer').path,
				resolveCreateResource(ConfigSection.Mcp, project, 'srv').path,
				resolveCreateResource(ConfigSection.Mcp, global, 'srv').path,
				resolveCreateResource(ConfigSection.Hooks, project).path,
				resolveCreateResource(ConfigSection.Permissions, global).path,
				resolveCreateResource(ConfigSection.Plugins, project).path,
			],
			[
				'/home/.claude/CLAUDE.md',
				'/work/CLAUDE.md',
				'/work/.claude/commands/git/commit.md',
				'/work/.claude/skills/pdf-filler/SKILL.md',
				'/home/.claude/agents/code-reviewer.md',
				'/work/.mcp.json',
				'/home/.claude.json',
				'/work/.claude/settings.json',
				'/home/.claude/settings.json',
				'/work/.claude/settings.json',
			],
		);
	});

	test('planDeletion resolves the file/jsonc target, honoring canDelete + targetResource + path guards', () => {
		const fileUri = URI.file('/work/.claude/agents/a.md');
		const folderOpen = URI.file('/work/.claude/skills/s/SKILL.md');
		const folderTarget = URI.file('/work/.claude/skills/s');
		const jsoncUri = URI.file('/work/.claude/settings.json');
		const mk = (over: Partial<IConfigItem>): IConfigItem =>
			({ id: 'i', scope: ConfigScope.Project, section: ConfigSection.Agents, label: 'l', ...over });
		assert.deepStrictEqual(
			[
				planDeletion(mk({ canDelete: false, backing: ConfigBacking.File, resource: fileUri })),         // not deletable
				planDeletion(mk({ canDelete: true, backing: ConfigBacking.File, resource: fileUri })),          // file -> resource
				planDeletion(mk({ canDelete: true, backing: ConfigBacking.Folder, resource: folderOpen, targetResource: folderTarget })), // folder -> targetResource
				planDeletion(mk({ canDelete: true, backing: ConfigBacking.File })),                             // no target -> none
				planDeletion(mk({ canDelete: true, backing: ConfigBacking.Jsonc, resource: jsoncUri, jsonPath: ['mcpServers', 'srv'] })),
				planDeletion(mk({ canDelete: true, backing: ConfigBacking.Jsonc, resource: jsoncUri })),        // no jsonPath -> none
				planDeletion(mk({ canDelete: true, backing: ConfigBacking.Jsonc, jsonPath: ['permissions', 'allow', 0] })), // no resource -> none
			],
			[
				{ kind: 'none' },
				{ kind: 'file', target: fileUri },
				{ kind: 'file', target: folderTarget },
				{ kind: 'none' },
				{ kind: 'jsonc', resource: jsoncUri, path: ['mcpServers', 'srv'] },
				{ kind: 'none' },
				{ kind: 'none' },
			],
		);
	});
});
