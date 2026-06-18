# Changes against upstream

The authoritative ledger of every in-place edit to an upstream microsoft/vscode file. A reviewer
should be able to read this and know the entire fork surface area. New files in new directories are
NOT listed here (they never conflict); only edits to files that exist upstream.

Base: microsoft/vscode `1.125.0` (see `UPSTREAM_VERSION`).

## In-place edits

| File | Reason | Marker | Upstream area |
|---|---|---|---|
| `README.md` | Merge resolution at Phase 0 import: kept upstream README for the vanilla baseline. Clawdius rebrand lands in Phase 1. | n/a (merge resolution) | root docs |
| `.gitignore` | Appended a marked Clawdius block (research workspace, provider secrets, local config). | `# CLAWDIUS-BEGIN gitignore additions` | root |
| `.github/workflows/*` | Removed the 16 inherited microsoft/vscode CI workflows (they need Microsoft secrets, self-hosted runners, and the distro repo, and fail on any fork); replaced with `clawdius-ci.yml`. | n/a (upstream file removal) | CI |

## New files / directories (no conflict, not part of the diff surface)
`UPSTREAM_VERSION`, `MERGING.md`, `CHANGES_AGAINST_UPSTREAM.md`, `BUILD.md`, `.gitleaks.toml`,
`.pre-commit-config.yaml`, `script/clawdius/**`, `clawdius/**`, `.github/workflows/clawdius-ci.yml`.

## Discipline
Every future in-place edit is wrapped in `// CLAWDIUS-BEGIN <reason>` / `// CLAWDIUS-END` (or the
comment syntax of the file), kept minimal, and added to the table above with the file, reason, and
upstream area touched. Prefer data (`product.json`) and new files over in-place edits.
