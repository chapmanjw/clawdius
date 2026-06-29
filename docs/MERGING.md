# Merging upstream into Clawdius

Clawdius tracks microsoft/vscode tagged releases and merges them on an ongoing basis. This runbook
keeps that tractable.

## Remotes and model
- `origin` = `chapmanjw/clawdius`, `upstream` = `https://github.com/microsoft/vscode`.
- `main` is the stable Clawdius branch. Take an upstream release on a `merge/upstream-<version>`
  branch, resolve, run the full suite, then fast-forward `main`.
- `git rerere` is enabled so conflict resolutions are recorded and replayed on the next merge.

## Current base
`UPSTREAM_VERSION` = `1.125.0`. Pinned at Phase 0 as the newest stable tag (decision 5).

## History and LFS notes (Phase 0)
Phase 0 imported the `1.125.0` tag then ran `git fetch --unshallow upstream`, so the repo has full
history (about 159k commits, `.git` ~1.3 GB) and is NOT shallow. Preflight any merge with
`git rev-parse --is-shallow-repository` (must print `false`). Fetch release tags only, not all upstream
branches.

Git LFS: an upstream test-cache object (`extensions/copilot/test/simulation/cache/base.sqlite`) 404s on
the LFS server, so set `GIT_LFS_SKIP_SMUDGE=1` for every clone, checkout, and merge (the LFS pointers stay
as harmless text and are not needed to build). Track whether upstream fixes the object on the pinned tag.

## Taking a new release
```
git fetch upstream refs/tags/<NEW>:refs/tags/<NEW>
git switch -c merge/upstream-<NEW> main
git merge <NEW>
# resolve conflicts (rerere replays known ones); update UPSTREAM_VERSION and this file
npm ci && npm run compile        # build
# run unit + integration + smoke + branding-guard + egress-guard
git switch main && git merge --ff-only merge/upstream-<NEW>
```

## Known conflict hot spots
`product.json`, every file in `CHANGES_AGAINST_UPSTREAM.md` (currently `README.md`, `.gitignore`),
`package.json`, `package-lock.json`, `build/`, `.github/workflows/` (upstream CI removed; on merge,
take ours and keep `clawdius-ci.yml`), and the chat contrib if patched
(`src/vs/workbench/contrib/chat/**`).

## Post-merge verification checklist
- Build succeeds on all target platforms.
- Unit, integration, and smoke suites green.
- Branding-guard passes (no `copilot` / Microsoft telemetry keys leak; gallery is Open VSX; default
  theme is Clawdius Dark).
- Network-egress guard passes (idle boot = zero outbound).
- Fresh-profile boot shows no account login and the orange theme.
- A Claude session round-trips against the mock provider.
- `script/clawdius/diff-stat` reviewed for unexpected fork-surface growth.
