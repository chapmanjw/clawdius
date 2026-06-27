#!/usr/bin/env node
// Clawdius brand ratchet. A tree-wide count of the Copilot ICON usage (Codicon.copilot) that can only SHRINK.
//
// Why this exists (gap found in the coverage audit): branding-guard.ts pins a fixed set of known UI string/icon
// sites, and scan-forbidden.ts only inspects Clawdius-owned files + CLAWDIUS-BEGIN-marked regions. NEITHER would
// catch a NEW Codicon.copilot that an upstream microsoft/vscode merge introduces in an unmarked file - exactly
// the silent brand leak-back this fork must prevent. This walks the whole src/ tree, counts the pattern per file,
// and fails if any file rises above its committed baseline or a file not in the baseline introduces it. The
// baseline is the upstream residue we tolerate today; it can only get smaller.
//
// Usage:
//   node script/clawdius/brand-ratchet.ts            check against the committed baseline (CI mode)
//   node script/clawdius/brand-ratchet.ts --update   regenerate the baseline (only when you intentionally reduce)
import fs from 'node:fs'

const ROOT = 'src'
const PATTERN = /Codicon\.copilot\b/g
const BASELINE_PATH = 'script/clawdius/brand-ratchet-baseline.json'
// Clawdius-owned trees are scanned in full by scan-forbidden already; exclude them so their (zero) usage and any
// future intentional reference is governed there, not here.
const SKIP = [/^src\/vs\/workbench\/contrib\/clawdius\//, /^src\/vs\/platform\/clawdius\//]

function walk(dir: string, out: string[]): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = `${dir}/${entry.name}`
		if (entry.isDirectory()) { walk(full, out); }
		else if (entry.name.endsWith('.ts')) { out.push(full); }
	}
}

function countOccurrences(): Record<string, number> {
	const files: string[] = []
	walk(ROOT, files)
	const counts: Record<string, number> = {}
	for (const f of files) {
		const rel = f.replace(/\\/g, '/')
		if (SKIP.some((re) => re.test(rel))) { continue }
		const text = fs.readFileSync(f, 'utf8')
		const n = (text.match(PATTERN) || []).length
		if (n > 0) { counts[rel] = n }
	}
	return counts
}

const current = countOccurrences()

if (process.argv.includes('--update')) {
	const sorted = Object.fromEntries(Object.keys(current).sort().map((k) => [k, current[k]]))
	fs.writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, '\t') + '\n')
	const total = Object.values(current).reduce((a, b) => a + b, 0)
	console.log(`brand-ratchet baseline updated: ${Object.keys(sorted).length} file(s), ${total} Codicon.copilot occurrence(s).`)
	process.exit(0)
}

let baseline: Record<string, number> = {}
try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) } catch {
	console.error(`brand-ratchet: missing/unreadable baseline at ${BASELINE_PATH}. Run with --update to create it.`)
	process.exit(1)
}

const violations: string[] = []
for (const [file, n] of Object.entries(current)) {
	const allowed = baseline[file] ?? 0
	if (n > allowed) {
		violations.push(allowed === 0
			? `${file}: Codicon.copilot newly introduced (${n}) - this file is not in the brand-ratchet baseline`
			: `${file}: Codicon.copilot rose to ${n} (baseline ${allowed})`)
	}
}

if (violations.length) {
	console.error('BRAND RATCHET FAILED (the Copilot icon may only be REMOVED, never added):')
	for (const v of violations) { console.error('  - ' + v) }
	console.error('\nIf you intentionally REDUCED usage, regenerate the baseline: node script/clawdius/brand-ratchet.ts --update')
	process.exit(1)
}
const total = Object.values(current).reduce((a, b) => a + b, 0)
console.log(`brand ratchet passed: ${total} Codicon.copilot occurrence(s) across ${Object.keys(current).length} file(s), none above baseline.`)
process.exit(0)
