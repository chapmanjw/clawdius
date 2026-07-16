# Clawdius security and content scan standards

These gates exist before substantive content and run in CI (the `fork-hygiene` job) on pull requests to
`main` and on pushes to `main` / `upstream-*` / `merge/**`. They live in new paths so they do not conflict
on upstream merges.

## Two scanners, one CI job (`fork-hygiene`)
1. Secrets (`.gitleaks.toml`): gitleaks default rules plus John's environment shapes (Anthropic
   `sk-ant-`, AWS keys, LWA client secret `amzn1.application-oa2-client.*`, SP-API refresh `Atzr|`).
2. Forbidden content (`script/clawdius/scan-forbidden.ts`): Copilot / GitHub-Copilot branding,
   known Microsoft telemetry keys, and Amazon-internal terms (from an env-referenced wordlist that
   is never committed via `CLAWDIUS_INTERNAL_WORDLIST`).

## Scoping against the upstream tree (important)
The upstream VS Code tree legitimately contains "copilot" until the Copilot chrome is removed, and its
tests contain example tokens. So:
- The forbidden-content scan inspects Clawdius-authored paths in full (`clawdius/**`,
  `extensions/clawdius-*/**`, `src/vs/workbench/contrib/clawdius/**`, `script/clawdius/**`, the ledger);
  for an in-place upstream edit carrying a `CLAWDIUS-BEGIN` marker it inspects ONLY the marked regions
  (brand mentions are allowed there since the comments describe the removal; telemetry keys and
  Amazon-internal terms are still flagged). It does not flag the surrounding upstream tree.
- gitleaks (`.gitleaks.toml`) deliberately does NOT globally allowlist `test/` or `fixtures/` paths, so a
  real credential committed to a Clawdius mock/test file is caught; intentional mock creds live under
  `test/clawdius/mocks/` or carry an inline `gitleaks:allow`. The one upstream false positive - VS Code's
  shared PUBLIC Application Insights aiKey, committed verbatim in ~13 extension manifests - is allowlisted by
  VALUE (not by a path exemption), so the Clawdius extension manifests stay scanned too. A full-history scan
  of the upstream tree should use `--baseline-path` for its known example-token findings. (Where gitleaks
  actually runs - the CI `fork-hygiene` scan vs. the opt-in pre-commit hook - is under "Where they run" below.)

Known limitation: the brand-name exemption for a marked region is region-wide, not comment-only, so a
marked region that shipped an actual user-visible Copilot string in code (not just an explanatory
comment) would not be flagged. The scan's threat model is accidental *leftover* upstream brand, not
self-inflicted brand inside a deliberate Clawdius edit; a companion guard against the BUILT product is
PLANNED as the backstop for shipped strings (not yet wired in CI - see the workflow header).

## Where they run
- Pre-commit (`.pre-commit-config.yaml`): activate per developer with `pre-commit install`. Not
  auto-enforced against the upstream import.
- CI: the `fork-hygiene` job runs gitleaks `--no-git` over the Clawdius-authored trees (a working-tree
  scan, NOT history), plus the forbidden-content scan over Clawdius paths, the two secret-scan
  falsifiability probes, and the fork-diff / brand ratchets. It gates pushes to `main` / `upstream-*` /
  `merge/**` and PRs to `main`. The large-file guard is a pre-commit hook (`.pre-commit-config.yaml`), not
  a CI step. `fork-hygiene` also runs the source-level `branding-guard.ts` (against `product.json`); a
  companion branding scan of the BUILT product is a planned expansion (see the workflow header), not a
  current CI step. (A full-history secret scan is a manual pre-publish step - see the checklist below.)

## Pre-publish checklist
Before the repo goes public or a release is cut: full gitleaks history scan clean; forbidden-content
scan clean over Clawdius paths and built artifacts; no `.env`, `.aws/`, provider keys, or
`*.local.json` tracked; manual spot-check of early commits for Amazon-internal content.
