# Merging upstream into Clawdius

Clawdius tracks microsoft/vscode tagged releases and merges them on an ongoing basis. This runbook
keeps that tractable.

## Remotes and model
- `origin` = `chapmanjw/clawdius`, `upstream` = `https://github.com/microsoft/vscode`.
- `main` is the stable Clawdius branch. Take an upstream release on a `merge/upstream-<version>`
  branch, resolve, run the full suite, then fast-forward `main`.
- `git rerere` is enabled so conflict resolutions are recorded and replayed on the next merge.

## Current base
`UPSTREAM_VERSION` = `1.126.0`, the newest stable upstream tag taken. Bump that file and this doc as
part of every merge.

## History and LFS notes
The initial import fetched the base tag then ran `git fetch --unshallow upstream`, so the repo has full
history (about 159k commits, `.git` ~1.3 GB) and is NOT shallow. Preflight any merge with
`git rev-parse --is-shallow-repository` (must print `false`). Fetch release tags only, not all upstream
branches.

Git LFS: an upstream test-cache LFS object 404s on the LFS server, so set `GIT_LFS_SKIP_SMUDGE=1` for
every clone, checkout, and merge on the repo (the LFS pointers stay as harmless text and are not needed
to build). Track whether upstream fixes the object on the pinned tag.

## Taking a new release
```
git fetch upstream refs/tags/<NEW>:refs/tags/<NEW>
git switch -c merge/upstream-<NEW> main
GIT_LFS_SKIP_SMUDGE=1 git merge <NEW>
# resolve conflicts (rerere replays known ones)
# bump UPSTREAM_VERSION and this file; regenerate the brand-ratchet baseline (see Learnings)
npm ci && npm run compile        # build
# unit + integration + smoke + branding-guard + egress-guard + forbidden-content scan
git switch main && git merge --ff-only merge/upstream-<NEW>
```

## Known conflict hot spots
`product.json`, every file listed in `docs/CHANGES_AGAINST_UPSTREAM.md` (that ledger is the full fork
surface), `package.json`, both `package-lock.json` files (root and `remote/`), `eslint.config.js`,
`build/`, `.github/workflows/` (upstream CI removed; on merge, take ours and keep `clawdius-ci.yml`),
the chat contrib (`src/vs/workbench/contrib/chat/**`), and the agent host
(`src/vs/platform/agentHost/**`, where the retained upstream assistant code lives and shifts each bump).

## Post-merge verification checklist
- Build succeeds on all target platforms.
- Unit, integration, and smoke suites green.
- Branding-guard passes (no removed-assistant brand string or Microsoft telemetry key leaks; gallery is
  Open VSX; default theme is Clawdius Dark).
- Brand-ratchet baseline regenerated for the new base and passing (see Learnings).
- Forbidden-content scan clean on every new or newly-marked file (see Learnings).
- Network-egress guard passes (idle boot = zero outbound).
- Fresh-profile boot shows no account login and the orange theme.
- A Claude session round-trips against the mock provider.
- `script/clawdius/diff-stat` reviewed for unexpected fork-surface growth.

## Learnings and gotchas
Recurring traps that apply to every upstream merge, not just one release. Work through them alongside
the phases above.

### Lockfile: Windows npm prunes the ssh2 cpu-features stub
Regenerating `package-lock.json` on Windows (`npm install`) drops the `ssh2` optional `cpu-features`
entry that a Linux `npm ci` requires, so the Linux and remote-extension-host build legs (and any Linux
`npm ci`) fail with `npm error EUSAGE ... Missing: cpu-features@ from lock file`. After any lock regen,
graft the stub back into BOTH the root and `remote/package-lock.json`, immediately after the
`node_modules/ssh2` entry:

```
"node_modules/ssh2/node_modules/cpu-features": { "optional": true },
```

Do not run `npm install` again afterward or it re-prunes. Validate that `npm ci --dry-run` gets PAST the
EUSAGE sync check (a later postinstall failure under `--dry-run` is a stale-`node_modules` artifact, not
a real lock problem). A Linux-generated lock is not an option on a Windows-only checkout.

### Regenerate the brand-ratchet baseline on every version bump
An upstream bump shifts the tolerated residue of the removed-assistant brand across the retained
upstream files (agent host, session providers), so `script/clawdius/brand-ratchet.ts` fails on the
first push after the bump. Companion step to bumping `UPSTREAM_VERSION`:

```
node script/clawdius/brand-ratchet.ts --update
```

Then confirm the regenerated baseline touches ONLY upstream files - no Clawdius-authored file under
`src/vs/workbench/contrib/clawdius/**` may gain residue.

### Run the forbidden-content scan on new and marked files before pushing
`script/clawdius/scan-forbidden.ts` fails any Clawdius-authored file (or Clawdius-marked region inside
an upstream file, comments included) that contains the standalone brand word of the removed upstream
assistant. Compound identifiers are not flagged (no word boundary); a bare word in an explanatory
comment is. Run it on the files you touched before pushing, and phrase comments neutrally:

```
node script/clawdius/scan-forbidden.ts <files...>
```

### Keep the CI test lists in sync when tests are deleted
`.github/workflows/clawdius-ci.yml` wires each compiled test by explicit `out/**/*.test.js` path.
Deleting a test source (for example while removing a de-branded surface) breaks the job. Remove the
matching entry in the SAME commit that deletes the test.

### Removing the vendored assistant SDK type-deps
The upstream assistant-SDK packages the fork still carries are `import type` only - no runtime use. To
remove one: delete its now-orphaned agent-host directory, but FIRST relocate any GENERIC helper it
exports that live production code imports by RELATIVE path - a `git grep <dir>/` on the absolute import
path misses `./<dir>/` importers, so search both spellings. Then drop the dependency from `package.json`,
`remote/package.json`, and the `eslint.config.js` restricted-import allowlist, and regenerate plus
re-graft the lock (see the lockfile note). A fixture test that imported the SDK's types may need
re-expressing against the plain data model to sever the type import.

### The unit CI does not run the release build - validate with a throwaway tag
`clawdius-ci.yml` proves correctness (types, tests, hygiene) but never runs the multi-platform build or
publish. Before pushing the real release tag, push a throwaway `v0.0.0-test-<n>` tag and confirm every
build leg (Windows x64/arm64, Linux, remote-extension-host x64/arm64, snap, macOS) and the publish step
go green. The remote-extension-host legs are the ones that exercise the `remote/` lock (the root
`npm ci` postinstall runs `npm ci` inside `remote/`). The release action creates a DRAFT prerelease, so
nothing publishes until reviewed; delete the test tag and its draft afterward
(`gh release delete <tag> --yes --cleanup-tag`).

### Re-apply the egress and protocol gates every bump
Two fork invariants drift with upstream and must be re-checked each merge:
- The zero-egress gate on the agent-host OpenTelemetry exporter. Upstream constructs it unconditionally
  in both the desktop and server agent-host entrypoints; keep it gated on a non-empty
  `defaultChatAgent.entitlementUrl` (Clawdius empties that), and keep scrubbing `OTEL_*` env from the
  Claude SDK subprocess so an inherited endpoint cannot flip it on at fork time.
- Agent-host protocol renames. Upstream periodically renames the agent-host action/part types (for
  example a `Session*` -> `Chat*` sweep) and adds or drops session-provider ids; re-anchor the fork's
  gates and update any stale test expectations rather than treating the rename as a regression.
