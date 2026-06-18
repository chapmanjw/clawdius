#!/usr/bin/env node
// Clawdius forbidden-content scan. Flags Copilot/GitHub-Copilot branding, known Microsoft
// telemetry keys, and Amazon-internal terms (from an env-referenced wordlist that is never
// committed) in CLAWDIUS-AUTHORED files only. The upstream VS Code tree legitimately contains
// "copilot" until Phase 2 removes the chrome, so this scan deliberately skips upstream paths
// and only inspects Clawdius-owned files plus files carrying a CLAUDIUS-BEGIN marker.
//
// Usage: node script/clawdius/scan-forbidden.js [--largefiles] <files...>
// Exit 1 on any finding.
import fs from 'node:fs'

const args = process.argv.slice(2)
const largeFilesMode = args.includes('--largefiles')
const files = args.filter((a) => !a.startsWith('--'))

// Clawdius-owned path prefixes the content scan applies to.
const OWNED = [/^clawdius\//, /^src\/vs\/workbench\/contrib\/clawdius\//, /^script\/clawdius\//,
  /^test\/clawdius\//, /^CHANGES_AGAINST_UPSTREAM\.md$/, /^MERGING\.md$/, /^README-CLAWDIUS/]
const MARKER = 'CLAWDIUS-BEGIN'

const FORBIDDEN = [
  { id: 'copilot-brand', re: /\bcopilot\b/i },
  { id: 'github-copilot-brand', re: /github\s+copilot/i },
  { id: 'ms-instrumentation-key', re: /InstrumentationKey=/i },
  { id: 'ms-aiconfig', re: /aiKey"?\s*[:=]/i },
]

// Amazon-internal wordlist (path supplied via env, never committed).
let internal = []
const wlPath = process.env.CLAWDIUS_INTERNAL_WORDLIST
if (wlPath && fs.existsSync(wlPath)) {
  internal = fs.readFileSync(wlPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

const LARGE_LIMIT = 5 * 1024 * 1024
const LARGE_ALLOW = [/^clawdius\/branding\//, /\.(icns|ico)$/]

let findings = 0
for (const f of files) {
  if (largeFilesMode) {
    try {
      const sz = fs.statSync(f).size
      if (sz > LARGE_LIMIT && !LARGE_ALLOW.some((re) => re.test(f))) {
        console.error(`[large-file] ${f} is ${(sz / 1048576).toFixed(1)} MB (> 5 MB)`) ; findings++
      }
    } catch {}
    continue
  }
  const owned = OWNED.some((re) => re.test(f))
  let text = ''
  try { text = fs.readFileSync(f, 'utf8') } catch { continue }
  const scan = owned || text.includes(MARKER)
  if (!scan) continue
  for (const rule of FORBIDDEN) {
    if (rule.re.test(text)) { console.error(`[${rule.id}] forbidden content in ${f}`); findings++ }
  }
  for (const term of internal) {
    if (term && text.toLowerCase().includes(term.toLowerCase())) {
      console.error(`[amazon-internal] term match in ${f}`); findings++
    }
  }
}

if (findings) { console.error(`\nForbidden-content scan failed: ${findings} finding(s).`); process.exit(1) }
process.exit(0)
