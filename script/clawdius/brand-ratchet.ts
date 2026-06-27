#!/usr/bin/env node
// Clawdius brand ratchet. Per-file counts of Copilot brand surfaces, across src/ AND extensions/, that can only
// SHRINK.
//
// Why this exists (gap found in the coverage audit + two release-readiness review rounds): branding-guard.ts
// pins a fixed set of known product/UI sites, and scan-forbidden.ts only inspects Clawdius-owned files +
// CLAWDIUS-BEGIN-marked regions. NEITHER catches a NEW Copilot icon OR a new user-visible "Copilot" string that
// an upstream microsoft/vscode merge introduces in an unmarked file. The first version of this ratchet only
// walked .ts under src/, which the consensus review showed still left the whole extensions/ tree and every
// non-.ts file (css/json/md/svg/png/...) unscanned - and Copilot text lives in those surfaces today
// (e.g. extensions/terminal-suggest/.../copilot.ts ships "GitHub Copilot CLI ...").
//
// This walks src/, extensions/ and cli/ (minus Clawdius-owned trees and build/dependency dirs), counts each
// tracked pattern per file over text-bearing files, AND tracks any Copilot-named file (so a bundled copilot.svg
// / .png icon asset is caught without needing a code change). It FAILS if any file rises above its committed
// baseline or a file not in the baseline introduces the pattern. The baseline is the upstream residue tolerated
// today; it can only get smaller. Clawdius-owned trees are excluded here because scan-forbidden already scans
// them in full.
//
// SCOPE (deliberately stated, not overclaimed): this ratchet + scan-forbidden (owned/marked) + branding-guard
// (product.json) cover the SHIPPED SOURCE brand surface - src/, extensions/, cli/, and product.json. They do
// NOT cover: (a) the build/ PACKAGING pipeline, which still bundles the upstream Copilot extension + @github/
// copilot prebuilds - a tracked Phase-6 built-product item, separate from a source brand leak; (b) non-shipped
// test fixtures. A new user-visible Copilot string in src/extensions/cli is caught; the build de-Copilot is its
// own follow-up.
//
// Usage:
//   node script/clawdius/brand-ratchet.ts            check against the committed baseline (CI mode)
//   node script/clawdius/brand-ratchet.ts --update   regenerate the baseline (only when you intentionally reduce)
import fs from 'node:fs'

const ROOTS = ['src', 'extensions', 'cli']
const BASELINE_PATH = 'script/clawdius/brand-ratchet-baseline.json'
// Text-bearing extensions whose contents are scanned for the text patterns. Binary assets (svg counts as text
// but png/ico do not) are covered by the filename pattern instead.
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.css', '.html', '.svg', '.txt', '.yml', '.yaml', '.rs', '.toml'])
// Content patterns (scanned inside text files) + a filename pattern (matches the file's own name, any extension,
// so a Copilot icon asset like copilot.svg / copilot-dark.png is tracked even though its bytes are binary).
const CONTENT_PATTERNS: Record<string, RegExp> = {
	'Codicon.copilot': /Codicon\.copilot\b/g,
	'copilot-text': /\bcopilot\b/gi,
}
const FILENAME_PATTERN = /copilot/i
const FILENAME_KEY = 'copilot-filename'
// Directories never descended into (Clawdius-owned -> governed by scan-forbidden; build output + deps -> noise).
const SKIP_DIRS = new Set(['node_modules', 'out', 'out-build', 'dist', '.git', '.build', 'target'])
const SKIP_PATHS = [
	/^src\/vs\/workbench\/contrib\/clawdius\//, /^src\/vs\/platform\/clawdius\//, /^extensions\/clawdius-/,
]

type Counts = Record<string, Record<string, number>> // pattern -> (file -> count)

function walk(dir: string, out: string[]): void {
	let entries: fs.Dirent[]
	try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
	for (const entry of entries) {
		const full = `${dir}/${entry.name}`
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) { walk(full, out) }
		} else {
			out.push(full)
		}
	}
}

function extOf(name: string): string {
	const i = name.lastIndexOf('.')
	return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function countOccurrences(): Counts {
	const files: string[] = []
	for (const root of ROOTS) { walk(root, files) }
	const counts: Counts = {}
	for (const key of [...Object.keys(CONTENT_PATTERNS), FILENAME_KEY]) { counts[key] = {} }
	for (const f of files) {
		const rel = f.replace(/\\/g, '/')
		if (SKIP_PATHS.some((re) => re.test(rel))) { continue }
		const base = rel.slice(rel.lastIndexOf('/') + 1)
		if (FILENAME_PATTERN.test(base)) { counts[FILENAME_KEY][rel] = 1 }
		if (!TEXT_EXT.has(extOf(base))) { continue }
		let text: string
		try { text = fs.readFileSync(f, 'utf8') } catch { continue }
		for (const [key, re] of Object.entries(CONTENT_PATTERNS)) {
			const n = (text.match(re) || []).length
			if (n > 0) { counts[key][rel] = n }
		}
	}
	return counts
}

function totalsLine(counts: Counts): string {
	return Object.keys(counts).map((k) => {
		const files = counts[k] ?? {}
		const total = Object.values(files).reduce((a, b) => a + b, 0)
		return `${k}: ${total} in ${Object.keys(files).length} file(s)`
	}).join('; ')
}

const current = countOccurrences()

if (process.argv.includes('--update')) {
	const sorted: Counts = {}
	for (const key of Object.keys(current)) {
		sorted[key] = Object.fromEntries(Object.keys(current[key]).sort().map((f) => [f, current[key][f]]))
	}
	fs.writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, '\t') + '\n')
	console.log(`brand-ratchet baseline updated: ${totalsLine(current)}.`)
	process.exit(0)
}

let baseline: Counts = {}
try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) } catch {
	console.error(`brand-ratchet: missing/unreadable baseline at ${BASELINE_PATH}. Run with --update to create it.`)
	process.exit(1)
}

const violations: string[] = []
for (const key of Object.keys(current)) {
	const base = baseline[key] ?? {}
	for (const [file, n] of Object.entries(current[key])) {
		const allowed = base[file] ?? 0
		if (n > allowed) {
			violations.push(allowed === 0
				? `[${key}] ${file}: newly introduced (${n}) - this file is not in the brand-ratchet baseline`
				: `[${key}] ${file}: rose to ${n} (baseline ${allowed})`)
		}
	}
}

if (violations.length) {
	console.error('BRAND RATCHET FAILED (a Copilot icon/string/asset may only be REMOVED, never added):')
	for (const v of violations) { console.error('  - ' + v) }
	console.error('\nIf you intentionally REDUCED usage, regenerate the baseline: node script/clawdius/brand-ratchet.ts --update')
	process.exit(1)
}
console.log(`brand ratchet passed: ${totalsLine(current)}; none above baseline.`)
process.exit(0)
