/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Config actions (create / delete / refresh)
// Title-bar + welcome-button + context-menu commands that let the config views CREATE and DELETE Claude Code
// configuration items, in either the Global (~/.claude) or Project (<folder>/.claude) scope. File/folder
// sections (memories, commands, skills, sub-agents) create a templated file; settings-backed sections (hooks,
// permissions, MCP) edit the JSONC settings via IJSONEditingService so existing formatting is preserved. Every
// path is a local file - no network. Registration is gated to Clawdius mode by the caller.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { parse as parseJsonc } from '../../../../base/common/jsonc.js';
import { JSONPath } from '../../../../base/common/json.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';
import {
	ConfigBacking, ConfigScope, ConfigSection, CONFIG_SECTIONS, IClawdiusConfigService, IConfigItem,
	sectionCreateLabel, sectionViewId,
} from '../common/clawdiusConfig.js';

const CATEGORY = localize2('clawdius.config.category', "Claude Code Config");

/** The command that creates a new item in a given section (also the welcome-button target). */
export function configCreateCommandId(section: ConfigSection): string {
	return `clawdius.config.create.${section}`;
}
export const CONFIG_DELETE_COMMAND_ID = 'clawdius.config.delete';
export const CONFIG_REFRESH_COMMAND_ID = 'clawdius.config.refresh';

/** Hook events Claude Code understands (the create picker offers these). */
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'SubagentStop', 'Notification', 'PreCompact'];

interface ICreateServices {
	readonly quickInput: IQuickInputService;
	readonly fileService: IFileService;
	readonly pathService: IPathService;
	readonly workspaceService: IWorkspaceContextService;
	readonly editorService: IEditorService;
	readonly jsonEditing: IJSONEditingService;
	readonly configService: IClawdiusConfigService;
	readonly logService: ILogService;
}

interface IDeleteServices {
	readonly fileService: IFileService;
	readonly dialogService: IDialogService;
	readonly jsonEditing: IJSONEditingService;
	readonly configService: IClawdiusConfigService;
	readonly logService: ILogService;
}

/** One creatable scope: Global, or a project workspace folder. */
interface IScopeTarget {
	readonly scope: ConfigScope;
	readonly claudeDir: URI;
	readonly baseDir: URI;
	readonly label: string;
}

// --- small helpers -------------------------------------------------------------------------------

/** Turn a free-text name into a filesystem-safe slug (keeps `:` as a sub-path separator for commands). */
function slug(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

function getAtPath(obj: unknown, path: readonly (string | number)[]): unknown {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur === null || typeof cur !== 'object') { return undefined; }
		cur = (cur as Record<string | number, unknown>)[key];
	}
	return cur;
}

async function resolveScopeTargets(s: ICreateServices): Promise<IScopeTarget[]> {
	const home = await s.pathService.userHome();
	const targets: IScopeTarget[] = [{
		scope: ConfigScope.Global, claudeDir: URI.joinPath(home, '.claude'), baseDir: home,
		label: localize('clawdius.config.global', "Global"),
	}];
	for (const folder of s.workspaceService.getWorkspace().folders) {
		targets.push({
			scope: ConfigScope.Project, claudeDir: URI.joinPath(folder.uri, '.claude'), baseDir: folder.uri,
			label: localize('clawdius.config.projectFolder', "Project: {0}", folder.name),
		});
	}
	return targets;
}

/** Pick a scope; auto-selects when only one is available (e.g. no workspace open). */
async function pickScope(s: ICreateServices, targets: IScopeTarget[]): Promise<IScopeTarget | undefined> {
	if (targets.length === 1) { return targets[0]; }
	const picked = await s.quickInput.pick(
		targets.map(t => ({ label: t.label, target: t })),
		{ placeHolder: localize('clawdius.config.pickScope', "Where should this be created?") },
	);
	return picked?.target;
}

async function promptName(s: ICreateServices, prompt: string, placeHolder: string): Promise<string | undefined> {
	const value = await s.quickInput.input({
		prompt, placeHolder, ignoreFocusLost: true,
		validateInput: async v => v.trim() ? undefined : localize('clawdius.config.nameRequired', "Enter a name"),
	});
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** Create a file with `contents` if it does not already exist; returns whether it was newly created. */
async function ensureFile(s: ICreateServices, resource: URI, contents: string): Promise<boolean> {
	if (await s.fileService.exists(resource)) { return false; }
	await s.fileService.createFile(resource, VSBuffer.fromString(contents), { overwrite: false });
	return true;
}

async function ensureJsonFile(s: ICreateServices, resource: URI): Promise<void> {
	if (!(await s.fileService.exists(resource))) {
		await s.fileService.createFile(resource, VSBuffer.fromString('{}\n'), { overwrite: false });
	}
}

async function readJson(fileService: IFileService, resource: URI): Promise<Record<string, unknown>> {
	try {
		const text = (await fileService.readFile(resource)).value.toString();
		const parsed = parseJsonc<Record<string, unknown>>(text);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/** Append `entry` to the array at `path` (creating it if missing), preserving the rest of the file. */
async function appendJsoncArray(s: ICreateServices, resource: URI, path: JSONPath, entry: unknown): Promise<void> {
	await ensureJsonFile(s, resource);
	const json = await readJson(s.fileService, resource);
	const current = getAtPath(json, path);
	const next = Array.isArray(current) ? current.slice() : [];
	next.push(entry);
	await s.jsonEditing.write(resource, [{ path, value: next }], true);
}

async function openResource(s: ICreateServices, resource: URI): Promise<void> {
	try {
		await s.editorService.openEditor({ resource, options: { pinned: true } });
	} catch (err) {
		s.logService.warn('[Clawdius] open created config item failed', err);
	}
}

// --- templates -----------------------------------------------------------------------------------

function agentTemplate(name: string): string {
	return `---\nname: ${name}\ndescription: When Claude should hand work to this sub-agent\n---\n\nYou are ${name}. Describe this sub-agent's role, expertise, and how it should respond.\n`;
}

function skillTemplate(name: string): string {
	return `---\nname: ${name}\ndescription: What this skill does and when Claude should use it\n---\n\n# ${name}\n\nDocument the skill: what it does, when to use it, and the steps to follow.\n`;
}

function commandTemplate(name: string): string {
	return `---\ndescription: What this slash command does\n---\n\nWrite the prompt that Claude runs for /${name}. Use $ARGUMENTS for inputs.\n`;
}

// --- create dispatch -----------------------------------------------------------------------------

async function createInSection(s: ICreateServices, section: ConfigSection): Promise<void> {
	const targets = await resolveScopeTargets(s);
	// Plugins are a global-only concept in the CLI; everything else can be scoped.
	const target = section === ConfigSection.Plugins ? targets[0] : await pickScope(s, targets);
	if (!target) { return; }

	try {
		switch (section) {
			case ConfigSection.Memories: {
				// The canonical memory file Claude Code reads for this scope.
				const resource = target.scope === ConfigScope.Global
					? URI.joinPath(target.claudeDir, 'CLAUDE.md')
					: URI.joinPath(target.baseDir, 'CLAUDE.md');
				await ensureFile(s, resource, target.scope === ConfigScope.Global ? '# User memory\n\n' : '# Project memory\n\n');
				await openResource(s, resource);
				break;
			}
			case ConfigSection.Commands: {
				const name = await promptName(s, localize('clawdius.config.commandName', "Command name (use ':' for a subfolder, e.g. git:commit)"), 'review');
				if (!name) { return; }
				const rel = slug(name).replace(/:/g, '/');
				const resource = URI.joinPath(target.claudeDir, 'commands', `${rel}.md`);
				await ensureFile(s, resource, commandTemplate(name));
				await openResource(s, resource);
				break;
			}
			case ConfigSection.Skills: {
				const name = await promptName(s, localize('clawdius.config.skillName', "Skill name"), 'pdf-filler');
				if (!name) { return; }
				const resource = URI.joinPath(target.claudeDir, 'skills', slug(name), 'SKILL.md');
				await ensureFile(s, resource, skillTemplate(name));
				await openResource(s, resource);
				break;
			}
			case ConfigSection.Agents: {
				const name = await promptName(s, localize('clawdius.config.agentName', "Sub-agent name"), 'code-reviewer');
				if (!name) { return; }
				const resource = URI.joinPath(target.claudeDir, 'agents', `${slug(name)}.md`);
				await ensureFile(s, resource, agentTemplate(name));
				await openResource(s, resource);
				break;
			}
			case ConfigSection.Mcp: {
				const name = await promptName(s, localize('clawdius.config.mcpName', "MCP server name"), 'my-server');
				if (!name) { return; }
				const resource = target.scope === ConfigScope.Project
					? URI.joinPath(target.baseDir, '.mcp.json')
					: URI.joinPath(target.baseDir, '.claude.json');
				await ensureJsonFile(s, resource);
				await s.jsonEditing.write(resource, [{ path: ['mcpServers', name], value: { command: '', args: [] } }], true);
				await openResource(s, resource);
				break;
			}
			case ConfigSection.Hooks: {
				const event = await s.quickInput.pick(HOOK_EVENTS.map(label => ({ label })), { placeHolder: localize('clawdius.config.hookEvent', "Hook event") });
				if (!event) { return; }
				const resource = URI.joinPath(target.claudeDir, 'settings.json');
				await appendJsoncArray(s, resource, ['hooks', event.label], { matcher: '', hooks: [{ type: 'command', command: '' }] });
				await openResource(s, resource);
				break;
			}
			case ConfigSection.Permissions: {
				const kind = await s.quickInput.pick(
					[{ label: 'allow' }, { label: 'ask' }, { label: 'deny' }],
					{ placeHolder: localize('clawdius.config.permKind', "Permission type") },
				);
				if (!kind) { return; }
				const rule = await promptName(s, localize('clawdius.config.permRule', "Permission rule, e.g. Bash(git push:*)"), 'Read(~/.zshrc)');
				if (!rule) { return; }
				const resource = URI.joinPath(target.claudeDir, 'settings.json');
				await appendJsoncArray(s, resource, ['permissions', kind.label], rule);
				await openResource(s, resource);
				break;
			}
			case ConfigSection.Plugins: {
				// Plugins are installed via the CLI; open the settings file where they are enabled/disabled.
				const resource = URI.joinPath(target.claudeDir, 'settings.json');
				await ensureJsonFile(s, resource);
				await openResource(s, resource);
				break;
			}
		}
		await s.configService.refresh(true);
	} catch (err) {
		s.logService.error('[Clawdius] create config item failed', err);
	}
}

// --- delete --------------------------------------------------------------------------------------

async function deleteJsoncEntry(s: IDeleteServices, item: IConfigItem): Promise<void> {
	const resource = item.resource;
	if (!resource || !item.jsonPath) { return; }
	// A targeted removal at the EXACT path: an object property (an MCP server `['mcpServers',name]` or a hook
	// event `['hooks',event]`) or one array element (a permission rule `['permissions',kind,index]`). Passing
	// `value: undefined` makes setProperty/jsonc-parser delete just that node, leaving the rest of the file -
	// including its comments and sibling entries - untouched.
	const path: JSONPath = [...item.jsonPath];
	await s.jsonEditing.write(resource, [{ path, value: undefined }], true);
}

async function deleteItem(s: IDeleteServices, item: IConfigItem): Promise<void> {
	if (!item?.canDelete) { return; }
	const confirmed = await s.dialogService.confirm({
		type: 'warning',
		message: localize('clawdius.config.confirmDelete', "Delete '{0}'?", item.label),
		detail: item.backing === ConfigBacking.Jsonc
			? localize('clawdius.config.confirmDeleteJsonc', "This removes the entry from the settings file.")
			: localize('clawdius.config.confirmDeleteFile', "The file is moved to the trash."),
		primaryButton: localize('clawdius.config.delete', "Delete"),
	});
	if (!confirmed.confirmed) { return; }
	try {
		if (item.backing === ConfigBacking.File || item.backing === ConfigBacking.Folder) {
			const target = item.targetResource ?? item.resource;
			if (target) { await s.fileService.del(target, { useTrash: true, recursive: true }); }
		} else if (item.backing === ConfigBacking.Jsonc) {
			await deleteJsoncEntry(s, item);
		}
		await s.configService.refresh(true);
	} catch (err) {
		s.logService.error('[Clawdius] delete config item failed', err);
	}
}

// --- registration --------------------------------------------------------------------------------

function createServices(accessor: ServicesAccessor): ICreateServices {
	return {
		quickInput: accessor.get(IQuickInputService),
		fileService: accessor.get(IFileService),
		pathService: accessor.get(IPathService),
		workspaceService: accessor.get(IWorkspaceContextService),
		editorService: accessor.get(IEditorService),
		jsonEditing: accessor.get(IJSONEditingService),
		configService: accessor.get(IClawdiusConfigService),
		logService: accessor.get(ILogService),
	};
}

/** Register the create (per section) + delete + refresh commands. Called once, in Clawdius mode only. */
export function registerClawdiusConfigActions(): void {
	for (const section of CONFIG_SECTIONS) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: configCreateCommandId(section),
					title: localize2('clawdius.config.create', "Create {0}", sectionCreateLabel(section)),
					category: CATEGORY,
					icon: Codicon.add,
					f1: false,
					menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', sectionViewId(section)), group: 'navigation', order: 1 }],
				});
			}
			override run(accessor: ServicesAccessor): Promise<void> {
				return createInSection(createServices(accessor), section);
			}
		});
	}

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CONFIG_REFRESH_COMMAND_ID,
				title: localize2('clawdius.config.refresh', "Refresh"),
				category: CATEGORY,
				icon: Codicon.refresh,
				f1: false,
				menu: CONFIG_SECTIONS.map(section => ({ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', sectionViewId(section)), group: 'navigation', order: 2 })),
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IClawdiusConfigService).refresh();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CONFIG_DELETE_COMMAND_ID,
				title: localize2('clawdius.config.delete', "Delete"),
				category: CATEGORY,
				f1: false,
			});
		}
		override run(accessor: ServicesAccessor, item?: IConfigItem): Promise<void> {
			if (!item) { return Promise.resolve(); }
			return deleteItem({
				fileService: accessor.get(IFileService),
				dialogService: accessor.get(IDialogService),
				jsonEditing: accessor.get(IJSONEditingService),
				configService: accessor.get(IClawdiusConfigService),
				logService: accessor.get(ILogService),
			}, item);
		}
	});
}
// CLAWDIUS-END
