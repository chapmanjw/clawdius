/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseSkillMd, validateSkillPackage } from '../../browser/control/claudeSkillValidationModel.js';

function skillMd(frontmatter: string, body = 'Body.'): string {
	return `---\n${frontmatter}\n---\n${body}\n`;
}

/** Error fields/codes helper for terse assertions. */
function errs(content: string | undefined, dir: string): string[] {
	return validateSkillPackage({ directoryName: dir, skillMdContent: content }).errors.map(e => e.field ?? e.code);
}

suite('claudeSkillValidationModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('valid skill has no errors and no warnings', () => {
		const v = validateSkillPackage({
			directoryName: 'pdf-processing',
			skillMdContent: skillMd('name: pdf-processing\ndescription: Extracts text and tables from PDF files. Use when working with PDFs.'),
		});
		assert.deepStrictEqual({ errors: v.errors.length, warnings: v.warnings.length }, { errors: 0, warnings: 0 });
		assert.strictEqual(v.fields['name'], 'pdf-processing');
	});

	test('missing / empty / frontmatter-less SKILL.md are errors', () => {
		assert.deepStrictEqual(errs(undefined, 'x'), ['missing-skill-md']);
		assert.deepStrictEqual(errs('   ', 'x'), ['missing-skill-md']);
		assert.deepStrictEqual(errs('# Just markdown, no frontmatter', 'x'), ['no-frontmatter']);
	});

	test('name rules: required, regex, length, folder match', () => {
		assert.ok(errs(skillMd('description: A reasonably long description here.'), 'x').includes('name'), 'missing name');
		// uppercase / leading hyphen / double hyphen all fail the regex
		for (const bad of ['PDF-Processing', '-pdf', 'pdf--processing']) {
			assert.ok(errs(skillMd(`name: ${bad}\ndescription: A reasonably long description here.`), bad).some(f => f === 'name'), `invalid name ${bad}`);
		}
		// valid name but mismatched folder
		assert.ok(errs(skillMd('name: data-analysis\ndescription: A reasonably long description here.'), 'other-folder').includes('name'), 'name/folder mismatch');
		// over 64 chars
		const long = 'a'.repeat(65);
		assert.ok(errs(skillMd(`name: ${long}\ndescription: A reasonably long description here.`), long).includes('name'), 'name too long');
	});

	test('description rules: required, max length, short warning', () => {
		assert.ok(errs(skillMd('name: ok-skill'), 'ok-skill').includes('description'), 'missing description');
		const over = 'x'.repeat(1025);
		assert.ok(errs(skillMd(`name: ok-skill\ndescription: ${over}`), 'ok-skill').includes('description'), 'description too long');
		const short = validateSkillPackage({ directoryName: 'ok-skill', skillMdContent: skillMd('name: ok-skill\ndescription: short') });
		assert.deepStrictEqual({ errors: short.errors.length, warnings: short.warnings.length }, { errors: 0, warnings: 1 });
	});

	test('compatibility over 500 is an error', () => {
		const big = 'c'.repeat(501);
		assert.ok(errs(skillMd(`name: ok-skill\ndescription: A reasonably long description here.\ncompatibility: ${big}`), 'ok-skill').includes('compatibility'));
	});

	test('body over 500 lines warns; nested metadata parses without breaking scalars', () => {
		const longBody = Array.from({ length: 510 }, (_, i) => `line ${i}`).join('\n');
		const withMeta = `name: ok-skill\ndescription: A reasonably long description here.\nmetadata:\n  author: example-org\n  version: "1.0"`;
		const v = validateSkillPackage({ directoryName: 'ok-skill', skillMdContent: skillMd(withMeta, longBody) });
		assert.strictEqual(v.errors.length, 0, 'metadata block does not produce errors');
		assert.ok(v.warnings.some(w => w.code === 'body-too-long'), 'body length warning');
		// nested metadata lines must not leak in as top-level scalar fields
		assert.strictEqual(v.fields['author'], undefined);
		assert.strictEqual(v.fields['name'], 'ok-skill');
	});

	test('parseSkillMd strips quotes and counts body lines', () => {
		const p = parseSkillMd('---\nname: ok\ndescription: "quoted value"\n---\nline one\nline two\n');
		assert.strictEqual(p.fields['description'], 'quoted value');
		assert.strictEqual(p.bodyLineCount, 2);
		assert.strictEqual(p.hasFrontmatter, true);
	});

	test('unquote: single quotes are stripped; a mismatched quote pair is left verbatim', () => {
		// outer literal is single-quoted (lint forbids double-quoted literals); embedded ' is escaped, " is literal.
		const p = parseSkillMd('---\nname: \'single\'\ndescription: "mismatch\'\n---\nbody\n');
		assert.deepStrictEqual({ name: p.fields['name'], description: p.fields['description'] }, { name: 'single', description: '"mismatch\'' });
	});

	test('countLines via parseSkillMd: CRLF body lines counted, ignoring the trailing newline', () => {
		const p = parseSkillMd('---\r\nname: ok\r\n---\r\nline one\r\nline two\r\n');
		assert.strictEqual(p.bodyLineCount, 2);
	});

	test('parseSkillMd tolerates a leading UTF-8 BOM before the frontmatter', () => {
		const BOM = String.fromCharCode(0xFEFF);
		const p = parseSkillMd(`${BOM}---\nname: ok\ndescription: A reasonably long description here.\n---\nbody\n`);
		assert.deepStrictEqual({ hasFrontmatter: p.hasFrontmatter, name: p.fields['name'] }, { hasFrontmatter: true, name: 'ok' });
	});
});
