#!/usr/bin/env node
// Clawdius pre-push hygiene gate. Wired via the package.json `prepush` script, which husky runs from the git
// pre-push hook, so it runs on EVERY push before commits leave the machine. It runs the forbidden-content +
// internal-reference scan over Clawdius-owned files (and the CLAUDIUS-BEGIN regions of upstream files) - the
// same scan CI runs - so a brand leak, a secret, an Amazon-internal term, or an internal spec/planning
// reference (slice / SC- / FR- / US- / task ids, roadmap phase labels, private paths) cannot reach the public
// remote. Exits non-zero (blocking the push) on any finding.
//
// This is the local half of "internal references are a standard part of reviewing every commit before it is
// pushed"; CI's fork-hygiene job is the remote backstop.
import { execFileSync } from 'node:child_process'

// Run git with argv passed directly (NO shell), so pathspecs like 'clawdius/**' are not mangled by the platform
// shell. A shelled `git ls-files '...'` returns ZERO matches under Windows cmd (which does not strip the single
// quotes), which would silently scan nothing and FALSE-PASS. Always pass an argv array, never a shell string.
function git(args: string[]): string[] {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}

// The Clawdius file set to scan (mirror the OWNED + INTERNAL_REF_SCOPE sets scan-forbidden.ts classifies).
// agentHost is Clawdius content with upstream headers - the scan treats it as internal-ref scope (no brand).
const OWNED_PATHSPECS = ['clawdius/**', 'src/vs/workbench/contrib/clawdius/**', 'src/vs/platform/clawdius/**',
  'src/vs/platform/agentHost/**', 'script/clawdius/**', 'test/clawdius/**', 'test/clawdius-e2e/**', 'extensions/clawdius-*/**',
  'docs/BUILD.md', 'docs/MERGING.md', 'docs/CHANGES_AGAINST_UPSTREAM.md', 'docs/CONTRIBUTING.md', 'docs/SECURITY.md']
const owned = git(['ls-files', ...OWNED_PATHSPECS])
// Sanity floor: a healthy checkout ALWAYS has owned files; an empty result means git/pathspec failure, and
// scanning only the marker files would false-pass on owned files without a marker. Fail hard instead of passing.
if (owned.length === 0) {
  console.error('pre-push: git ls-files returned no Clawdius-owned files - refusing to run a scan that would false-pass. Check git availability / pathspecs.')
  process.exit(1)
}
const marked = git(['grep', '-lI', 'CLAWDIUS-BEGIN'])
const files = [...new Set([...owned, ...marked])]
if (files.length === 0) { process.exit(0) }

// Chunk the file list: passing ~800 files as one argv exceeds the OS command-line length limit (notably on
// Windows), which would make the scan spawn FAIL rather than run. Batch it, and OR the results together.
const CHUNK = 250
let failed = false
for (let i = 0; i < files.length; i += CHUNK) {
  const batch = files.slice(i, i + CHUNK)
  try {
    execFileSync('node', ['--experimental-strip-types', 'script/clawdius/scan-forbidden.ts', ...batch], { stdio: 'inherit' })
  } catch { failed = true }
}
if (failed) {
  console.error('\npre-push blocked: the Clawdius forbidden-content / internal-reference scan found problems (above). Fix them, then push.')
  process.exit(1)
}
process.exit(0)
