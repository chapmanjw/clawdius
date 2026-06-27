#!/usr/bin/env node
// Clawdius brand ratchet. Tree-wide per-file counts of Copilot brand surfaces that can only SHRINK.
//
// Why this exists (gap found in the coverage audit + the release-readiness review): branding-guard.ts pins a
// fixed set of known UI string/icon sites, and scan-forbidden.ts only inspects Clawdius-owned files +
// CLAWDIUS-BEGIN-marked regions. NEITHER catches a NEW Copilot icon OR a new user-visible "Copilot" string that
// an upstream microsoft/vscode merge introduces in an unmarked file - exactly the silent brand leak-back this
// fork must prevent. This walks the whole src/ tree, counts each tracked pattern per file, and FAILS if any file
// rises above its committed baseline or a file not in the baseline introduces the pattern. The baseline is the
// upstream residue tolerated today; it can only get smaller. (Clawdius-owned trees are excluded here because
// scan-forbidden already scans them in full; together the two guards leave no unscanned surface.)
//
// Usage:
//   node script/clawdius/brand-ratchet.ts            check against the committed baseline (CI mode)
//   node script/clawdius/brand-ratchet.ts --update   regenerate the baseline (only when you intentionally reduce)
import fs from 'node:fs'

const ROOT = 'src'
const BASELINE_PATH = 'script/clawdius/brand-ratchet-baseline.json'
// Tracked brand surfaces. `copilot-text` is the broad net the release review asked for: any "copilot" word
// (case-insensitive) - branding strings, command ids, identifiers. The baseline absorbs today's upstream residue;
// the ratchet only forbids it GROWING, so a merge that adds a new Copilot string/icon in any file trips CI.
const PATTERNS: Record<string, RegExp> = {
	'Codicon.copilot': /Codicon\.copilot\b/g,
	'copilot-text': /\bcopilot\b/gi,
}
// Clawdius-owned trees are scanned in full by scan-forbidden already; exclude them so their (zero) usage and any
// future intentional reference is governed there, not here.
const SKIP = [/^src\/vs\/workbench\/contrib\/clawdius\//, /^src\/vs\/platform\/clawdius\//]

type Counts = Record<string, Record<string, number>> // pattern -> (file -> count)

function walk(dir: string, out: string[]): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = `${dir}/${entry.name}`
		if (entry.isDirectory()) { walk(full, out); }
		else if (entry.name.endsWith('.ts')) { out.push(full); }
	}
}

function countOccurrences(): Counts {
	const files: string[] = []
	walk(ROOT, files)
	const counts: Counts = {}
	for (const key of Object.keys(PATTERNS)) { counts[key] = {} }
	for (const f of files) {
		const rel = f.replace(/\\/g, '/')
		if (SKIP.some((re) => re.test(rel))) { continue }
		const text = fs.readFileSync(f, 'utf8')
		for (const [key, re] of Object.entries(PATTERNS)) {
			const n = (text.match(re) || []).length
			if (n > 0) { counts[key][rel] = n }
		}
	}
	return counts
}

function totalsLine(counts: Counts): string {
	return Object.keys(PATTERNS).map((k) => {
		const files = counts[k] ?? {}
		const total = Object.values(files).reduce((a, b) => a + b, 0)
		return `${k}: ${total} in ${Object.keys(files).length} file(s)`
	}).join('; ')
}

const current = countOccurrences()

if (process.argv.includes('--update')) {
	const sorted: Counts = {}
	for (const key of Object.keys(PATTERNS)) {
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
for (const key of Object.keys(PATTERNS)) {
	const base = baseline[key] ?? {}
	for (const [file, n] of Object.entries(current[key] ?? {})) {
		const allowed = base[file] ?? 0
		if (n > allowed) {
			violations.push(allowed === 0
				? `[${key}] ${file}: newly introduced (${n}) - this file is not in the brand-ratchet baseline`
				: `[${key}] ${file}: rose to ${n} (baseline ${allowed})`)
		}
	}
}

if (violations.length) {
	console.error('BRAND RATCHET FAILED (a Copilot icon/string may only be REMOVED, never added):')
	for (const v of violations) { console.error('  - ' + v) }
	console.error('\nIf you intentionally REDUCED usage, regenerate the baseline: node script/clawdius/brand-ratchet.ts --update')
	process.exit(1)
}
console.log(`brand ratchet passed: ${totalsLine(current)}; none above baseline.`)
process.exit(0)
