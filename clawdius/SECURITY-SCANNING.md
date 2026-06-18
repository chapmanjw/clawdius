# Clawdius security and content scan standards

These gates exist before substantive content and run in CI on every PR. They live in new paths so
they do not conflict on upstream merges.

## Two scanners, two jobs
1. Secrets (`.gitleaks.toml`): gitleaks default rules plus John's environment shapes (Anthropic
   `sk-ant-`, AWS keys, LWA client secret `amzn1.application-oa2-client.*`, SP-API refresh `Atzr|`).
2. Forbidden content (`script/clawdius/scan-forbidden.ts`): Copilot / GitHub-Copilot branding,
   known Microsoft telemetry keys, and Amazon-internal terms (from an env-referenced wordlist that
   is never committed via `CLAWDIUS_INTERNAL_WORDLIST`).

## Scoping against the upstream tree (important)
The upstream VS Code tree legitimately contains "copilot" until Phase 2 removes the chrome, and its
tests contain example tokens. So:
- The forbidden-content scan inspects only Clawdius-authored paths (`clawdius/**`,
  `src/vs/workbench/contrib/clawdius/**`, `script/clawdius/**`, the ledger) plus any file carrying a
  `CLAWDIUS-BEGIN` marker. It does not flag the upstream tree.
- gitleaks runs with an allowlist for test/fixture paths and lockfiles. Tune the allowlist against a
  clean baseline scan before activating gitleaks as a blocking pre-commit hook.

## Where they run
- Pre-commit (`.pre-commit-config.yaml`): activate per developer with `pre-commit install`. Not
  auto-enforced against the upstream import.
- CI (Phase 6): a `security-scan` job runs gitleaks over history, the forbidden-content scan over
  Clawdius paths, and the large-file guard, gating PRs and `merge/upstream-*` branches. The
  forbidden-content scan also seeds the Phase 6 branding-guard that runs against the BUILT product.

## Pre-publish checklist
Before the repo goes public or a release is cut: full gitleaks history scan clean; forbidden-content
scan clean over Clawdius paths and built artifacts; no `.env`, `.aws/`, provider keys, or
`*.local.json` tracked; manual spot-check of early commits for Amazon-internal content.
