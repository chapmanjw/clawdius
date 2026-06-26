/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN plugins-tab model (marketplaces + browseable catalog)
// Pure, UI-free parse logic for the Plugins tab's local JSON sources under ~/.claude/plugins/:
//   - known_marketplaces.json                              -> IMarketplace[]      (the configured marketplaces)
//   - marketplaces/<name>/.claude-plugin/marketplace.json  -> ICatalogPlugin[]    (one marketplace's catalog)
//   - installed_plugins.json                               -> IInstalledPlugin[]  (what is installed locally)
// No file or service access here; the editor pane does the IO and hands the parsed JSON in. The shapes are
// tolerant of junk (unknown -> skip) since these files are written by the Claude Code CLI, not by us.

/** One configured plugin marketplace (a key in known_marketplaces.json). */
export interface IMarketplace {
	readonly name: string;
	readonly sourceLabel: string;
	readonly lastUpdated?: string;
	readonly autoUpdate: boolean;
}

/** One available plugin from a marketplace catalog (marketplace.json). Its id is `<name>@<marketplace>`. */
export interface ICatalogPlugin {
	readonly id: string;
	readonly name: string;
	readonly marketplace: string;
	readonly description?: string;
	readonly author?: string;
	readonly category?: string;
}

/** One locally installed plugin (a key in installed_plugins.json). */
export interface IInstalledPlugin {
	readonly id: string;
	readonly version?: string;
}

/** A marketplace name that is safe to drop into a terminal command (no shell metacharacters). */
export const MARKETPLACE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** True when `value` is a plain (non-array) object we can read keys off of. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A non-empty trimmed string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Pick a human label for a marketplace `source` block: `repo` (github), else `url` (git), else `path` (local),
 * else the inner `source` type string (e.g. "github"). Empty string when nothing is readable.
 */
function marketplaceSourceLabel(source: unknown): string {
	if (!isRecord(source)) { return ''; }
	return nonEmptyString(source['repo'])
		?? nonEmptyString(source['url'])
		?? nonEmptyString(source['path'])
		?? nonEmptyString(source['source'])
		?? '';
}

/** Read an author into a flat display name: `author.name` if an object, the string itself if a string. */
function catalogAuthor(author: unknown): string | undefined {
	if (typeof author === 'string') { return nonEmptyString(author); }
	if (isRecord(author)) { return nonEmptyString(author['name']); }
	return undefined;
}

/** Parse known_marketplaces.json into a sorted-by-name list. Each key is a marketplace name. */
export function parseKnownMarketplaces(json: unknown): IMarketplace[] {
	if (!isRecord(json)) { return []; }
	const out: IMarketplace[] = [];
	for (const [name, value] of Object.entries(json)) {
		if (name.length === 0 || !isRecord(value)) { continue; }
		out.push({
			name,
			sourceLabel: marketplaceSourceLabel(value['source']),
			lastUpdated: nonEmptyString(value['lastUpdated']),
			autoUpdate: !!value['autoUpdate'],
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse one marketplace's marketplace.json catalog. Each plugin's id is `<plugin.name>@<marketplaceName>`. */
export function parseMarketplaceCatalog(json: unknown, marketplaceName: string): ICatalogPlugin[] {
	if (!isRecord(json) || !Array.isArray(json['plugins'])) { return []; }
	const out: ICatalogPlugin[] = [];
	for (const raw of json['plugins']) {
		if (!isRecord(raw)) { continue; }
		const name = nonEmptyString(raw['name']);
		if (!name) { continue; }
		out.push({
			id: `${name}@${marketplaceName}`,
			name,
			marketplace: marketplaceName,
			description: nonEmptyString(raw['description']),
			author: catalogAuthor(raw['author']),
			category: nonEmptyString(raw['category']),
		});
	}
	return out;
}

/** Parse installed_plugins.json into a flat list. The version is the first install record's `version`, if any. */
export function parseInstalledPlugins(json: unknown): IInstalledPlugin[] {
	if (!isRecord(json) || !isRecord(json['plugins'])) { return []; }
	const out: IInstalledPlugin[] = [];
	for (const [id, value] of Object.entries(json['plugins'])) {
		if (id.length === 0) { continue; }
		let version: string | undefined;
		if (Array.isArray(value) && isRecord(value[0])) {
			version = nonEmptyString(value[0]['version']);
		}
		out.push({ id, version });
	}
	return out;
}
// CLAWDIUS-END
