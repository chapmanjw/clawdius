/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN skill validation model (Agent Skills spec)
// Pure, fs-free validation of a skill package's SKILL.md against the Agent Skills format spec
// (https://agentskills.io/specification). Used by the Control Center Skills tab to show a per-skill badge +
// issue list. A small dedicated frontmatter parser (we deliberately do NOT pull in a YAML dependency): it
// reads the top-level scalar fields the spec validates (name, description, compatibility, license,
// allowed-tools) and notes which top-level keys carry a nested block (e.g. metadata), which we treat shallowly.

/** The Agent Skills `name` rule: lowercase alphanumerics + single hyphens, no leading/trailing/double hyphens. */
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const DESCRIPTION_SHORT = 20;
const COMPATIBILITY_MAX = 500;
const BODY_LINES_MAX = 500;

/** A machine-readable issue code; the editor maps it to a localized, user-facing message. */
export type SkillIssueCode =
	| 'missing-skill-md' | 'no-frontmatter'
	| 'name-missing' | 'name-too-long' | 'name-format' | 'name-folder-mismatch'
	| 'description-missing' | 'description-too-long' | 'description-short'
	| 'compatibility-too-long' | 'body-too-long';

export interface ISkillIssue {
	readonly severity: 'error' | 'warning';
	readonly code: SkillIssueCode;
	readonly field?: string;
	/** Context for the localized message (a limit count, or the expected folder name). */
	readonly arg?: string | number;
}
// (ISkillIssue / ISkillValidation are consumed by the Skills tab to render the badge + issue list. The model
// stays string-free so all user-facing text is localized in the editor.)

export interface ISkillValidation {
	readonly errors: readonly ISkillIssue[];
	readonly warnings: readonly ISkillIssue[];
	readonly hasFrontmatter: boolean;
	/** The parsed top-level scalar frontmatter fields (for display). */
	readonly fields: Readonly<Record<string, string>>;
	readonly bodyLineCount: number;
}

interface IParsedSkillMd {
	readonly fields: Record<string, string>;
	/** Top-level keys whose value is a nested block (e.g. `metadata:` with indented children). */
	readonly nestedKeys: ReadonlySet<string>;
	readonly bodyLineCount: number;
	readonly hasFrontmatter: boolean;
}

/** Count physical lines, ignoring a single trailing newline (the conventional file terminator). */
function countLines(text: string): number {
	const trimmed = text.replace(/\r?\n$/, '');
	return trimmed.trim() ? trimmed.split(/\r?\n/).length : 0;
}

/** Strip one layer of matching surrounding quotes from a scalar value. */
function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Parse a SKILL.md into its leading YAML frontmatter (top-level scalars + nested-key detection) and the body
 * line count. Defensive + dependency-free; good enough for the spec's validatable fields, not a full YAML parser.
 */
export function parseSkillMd(content: string): IParsedSkillMd {
	const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content);
	if (!match) {
		return { fields: {}, nestedKeys: new Set(), bodyLineCount: countLines(content), hasFrontmatter: false };
	}
	const fields: Record<string, string> = {};
	const nestedKeys = new Set<string>();
	let currentTopKey: string | undefined;
	for (const line of match[1].split(/\r?\n/)) {
		if (/^[ \t]+\S/.test(line)) {
			// Indented -> a child of the most recent top-level key (a nested block, e.g. metadata).
			if (currentTopKey) { nestedKeys.add(currentTopKey); }
			continue;
		}
		const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
		if (!kv) { continue; }
		currentTopKey = kv[1];
		const value = kv[2].trim();
		if (value !== '') { fields[currentTopKey] = unquote(value); }
	}
	const body = content.slice(match[0].length);
	return { fields, nestedKeys, bodyLineCount: countLines(body), hasFrontmatter: true };
}

/** Validate a skill package (the directory name + its SKILL.md content) against the Agent Skills spec. */
export function validateSkillPackage(input: { directoryName: string; skillMdContent: string | undefined }): ISkillValidation {
	const errors: ISkillIssue[] = [];
	const warnings: ISkillIssue[] = [];

	const content = input.skillMdContent;
	if (content === undefined || content.trim() === '') {
		errors.push({ severity: 'error', code: 'missing-skill-md' });
		return { errors, warnings, hasFrontmatter: false, fields: {}, bodyLineCount: 0 };
	}

	const parsed = parseSkillMd(content);
	if (!parsed.hasFrontmatter) {
		errors.push({ severity: 'error', code: 'no-frontmatter' });
		return { errors, warnings, hasFrontmatter: false, fields: {}, bodyLineCount: parsed.bodyLineCount };
	}

	const name = parsed.fields['name'];
	if (!name) {
		errors.push({ severity: 'error', code: 'name-missing', field: 'name' });
	} else {
		if (name.length > NAME_MAX) {
			errors.push({ severity: 'error', code: 'name-too-long', field: 'name', arg: NAME_MAX });
		}
		if (!SKILL_NAME_RE.test(name)) {
			errors.push({ severity: 'error', code: 'name-format', field: 'name' });
		} else if (name !== input.directoryName) {
			errors.push({ severity: 'error', code: 'name-folder-mismatch', field: 'name', arg: input.directoryName });
		}
	}

	const description = parsed.fields['description'];
	if (!description) {
		errors.push({ severity: 'error', code: 'description-missing', field: 'description' });
	} else if (description.length > DESCRIPTION_MAX) {
		errors.push({ severity: 'error', code: 'description-too-long', field: 'description', arg: DESCRIPTION_MAX });
	} else if (description.length < DESCRIPTION_SHORT) {
		warnings.push({ severity: 'warning', code: 'description-short', field: 'description' });
	}

	const compatibility = parsed.fields['compatibility'];
	if (compatibility && compatibility.length > COMPATIBILITY_MAX) {
		errors.push({ severity: 'error', code: 'compatibility-too-long', field: 'compatibility', arg: COMPATIBILITY_MAX });
	}

	if (parsed.bodyLineCount > BODY_LINES_MAX) {
		warnings.push({ severity: 'warning', code: 'body-too-long', arg: BODY_LINES_MAX });
	}

	return { errors, warnings, hasFrontmatter: true, fields: parsed.fields, bodyLineCount: parsed.bodyLineCount };
}
// CLAWDIUS-END
