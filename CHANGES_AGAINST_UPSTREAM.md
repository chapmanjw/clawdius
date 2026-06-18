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
| `product.json` | M1 branding + privacy overlay: names, app/data/bundle ids, fresh win32 GUIDs, URLs to the repo, extensionsGallery to Open VSX, enableTelemetry false, voiceWsUrl dropped, defaultChatAgent.extensionId off GitHub.copilot, GitHub auth trust emptied. M1 review fix: emptied the five defaultChatAgent Copilot **egress** URLs (entitlementUrl, tokenEntitlementUrl, mcpRegistryDataUrl, managedSettingsUrl, entitlementSignupLimitedUrl) that core `DefaultAccountProviderContribution` fetched at BlockStartup, and repointed the aka.ms/github-copilot plan/signup links to the brand domain. Data-only. | n/a (data overlay) | product config |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | M1 Phase 4: default color theme constants set to Clawdius Dark/Light; and the pre-theme first-paint `COLOR_THEME_*_INITIAL_COLORS` accent hexes recolored from Microsoft blue (#0078D4/#005FB8) to the Clawdius orange family, so first paint is Clawdius not blue (neutrals + semantic add/delete/error colors untouched; chat-surface accents left for Phase 2). | `// CLAWDIUS-BEGIN default theme`, `// CLAWDIUS-BEGIN initial-colors accent recolor` | theme service |
| `build/hygiene.ts` | M1: inverted the upstream "product.json must not contain extensionsGallery" guard into "Open VSX only" (exact `https://open-vsx.org/` host prefix across serviceUrl/itemUrl/resourceUrlTemplate) so the baked-in Open VSX gallery passes hygiene while the Microsoft Marketplace stays blocked. | `// CLAWDIUS-BEGIN gallery policy` | build hygiene |
| `src/vs/workbench/services/accounts/browser/defaultAccount.ts` | M1 review fix: `DefaultAccountProviderContribution` (registered at `WorkbenchPhase.BlockStartup`) now skips registering the GitHub/Copilot default-account provider entirely when `defaultChatAgent.entitlementUrl` is empty (Clawdius empties it). Closes ALL startup account egress at the source, including the **enterprise** branch that reconstructs `api.{ghe-host}/copilot_internal/*` from user settings — which emptying the product URL fields alone did not catch. | `// CLAWDIUS-BEGIN no default-account egress` | account service |

## New files / directories (no conflict, not part of the diff surface)
`UPSTREAM_VERSION`, `MERGING.md`, `CHANGES_AGAINST_UPSTREAM.md`, `BUILD.md`, `.gitleaks.toml`,
`.pre-commit-config.yaml`, `script/clawdius/**`, `clawdius/**`, `.github/workflows/clawdius-ci.yml`,
`extensions/clawdius-themes/**`.

## Known privacy follow-ups (tracked, deferred by design — not yet addressed)
Surfaced by the M1 review; recorded so the zero-egress claim stays honest about what is and is not done.
- `product.json` `webviewContentExternalBaseUrlTemplate` still points at `*.vscode-cdn.net`. Verified this
  is **not** a desktop egress vector: desktop webviews use the local `vscode-webview://{{uuid}}` scheme
  (`environmentService.ts` electron-browser); `vscode-cdn.net` appears only in the web/server build CSP
  (`webClientServer.ts`) and the remote-resource URI transform. Re-point to a Clawdius-controlled host
  before shipping the web/REH build.
- `product.json` `defaultChatAgent` still carries Copilot-specific command/output identifiers
  (`chatExtensionOutputId`, `chatExtensionOutputExtensionStateCommand`, the `github.copilot.*` commands /
  contexts / settings) and a GitHub auth provider block. These are non-URL identifier strings with no
  egress sink. The startup contribution that *consumes* the provider block (`DefaultAccountProviderContribution`)
  is now disabled while `entitlementUrl` is empty (see the `defaultAccount.ts` edit above), so the provider
  data is inert in M1. Replace the identifiers and define the real auth model with the Phase 2 Clawdius chat
  extension (M2).
- `product.json` documentation/terms/privacy/plan/signup URLs are placeholders on `https://clawdiuscode.io`.
  Confirm the domain is registered with landing content before public release.

## Discipline
Every future in-place edit is wrapped in `// CLAWDIUS-BEGIN <reason>` / `// CLAWDIUS-END` (or the
comment syntax of the file), kept minimal, and added to the table above with the file, reason, and
upstream area touched. Prefer data (`product.json`) and new files over in-place edits.
