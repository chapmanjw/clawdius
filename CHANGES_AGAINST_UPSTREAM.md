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
| `product.json` | M1 branding + privacy overlay: names, app/data/bundle ids, fresh win32 GUIDs, URLs to the repo, extensionsGallery to Open VSX, enableTelemetry false, voiceWsUrl dropped, defaultChatAgent.extensionId off GitHub.copilot, GitHub auth trust emptied. M1 review fix: emptied the five defaultChatAgent Copilot **egress** URLs (entitlementUrl, tokenEntitlementUrl, mcpRegistryDataUrl, managedSettingsUrl, entitlementSignupLimitedUrl) that core `DefaultAccountProviderContribution` fetched at BlockStartup, and repointed the aka.ms/github-copilot plan/signup links to the brand domain. Theme follow-up: curated `onboardingThemes` (the welcomeOnboarding picker list) from the upstream Dark/Light 2026 + Solarized + HC set down to the four Clawdius themes. Phase 2 (B): `defaultChatAgent.provider.default.name` `"GitHub"` → `"Clawdius"` — the central knob that flips ~20 interpolated `{0}` chat-setup strings and the default agent name to "Clawdius Copilot" (paired with the `chatListRenderer.ts` `COPILOT_USERNAME` edit above). Data-only. | n/a (data overlay) | product config |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | M1 Phase 4: default color theme constants set to Clawdius Dark/Light; and the pre-theme first-paint `COLOR_THEME_*_INITIAL_COLORS` accent hexes recolored from Microsoft blue (#0078D4/#005FB8) to the Clawdius orange family, so first paint is Clawdius not blue (neutrals + semantic add/delete/error colors untouched; chat-surface accents left for Phase 2). Welcome-picker follow-up: `COLOR_THEME_HC_DARK`/`COLOR_THEME_HC_LIGHT` repointed from upstream `Default High Contrast`/`Default High Contrast Light` to the new `Clawdius High Contrast`/`Clawdius High Contrast Light` themes (folded into the same marked region). | `// CLAWDIUS-BEGIN default theme`, `// CLAWDIUS-BEGIN initial-colors accent recolor` | theme service |
| `build/hygiene.ts` | M1: inverted the upstream "product.json must not contain extensionsGallery" guard into "Open VSX only" (exact `https://open-vsx.org/` host prefix across serviceUrl/itemUrl/resourceUrlTemplate) so the baked-in Open VSX gallery passes hygiene while the Microsoft Marketplace stays blocked. Phase 2 (G1): `checkCopilotEnginesVersion` short-circuits to `undefined` when `extensions/copilot/package.json` is absent (it was deleted), instead of crashing the precommit hook with ENOENT on the missing manifest. | `// CLAWDIUS-BEGIN gallery policy`, `// CLAWDIUS-BEGIN copilot eliminated` | build hygiene |
| `src/vs/workbench/services/accounts/browser/defaultAccount.ts` | M1 review fix: `DefaultAccountProviderContribution` (registered at `WorkbenchPhase.BlockStartup`) skips registering the GitHub/Copilot default-account provider when `defaultChatAgent.entitlementUrl` is empty (Clawdius empties it), closing ALL startup account egress at the source — incl. the **enterprise** branch that reconstructs `api.{ghe-host}/copilot_internal/*` from user settings, which emptying the product URLs alone did not catch. `DefaultAccountService` opens its init barrier in that no-provider case so `getDefaultAccount()/refresh()/signIn()/signOut()` resolve to "no account" instead of hanging forever (provider registration is otherwise the only `initBarrier.open()`). | `// CLAWDIUS-BEGIN no default-account egress`, `// CLAWDIUS-BEGIN no default-account` | account service |
| `src/vs/workbench/contrib/welcomeGettingStarted/common/media/theme_picker.ts`, `theme_picker_small.ts` | Welcome "Pick a Color Theme" walkthrough: rebranded the four tile labels (Dark Modern / Light Modern / Dark High Contrast / Light High Contrast) to Clawdius Dark / Clawdius Light / Clawdius High Contrast / Clawdius High Contrast Light. The tiles already *applied* the correct themes via the `ThemeSettingDefaults.COLOR_THEME_*` constants; this fixes the visible labels. Markers wrap the module outside the HTML template literal (JS comments cannot live inside it). | `// CLAWDIUS-BEGIN theme-picker labels` | welcome / getting-started |
| `src/vs/workbench/contrib/welcomeGettingStarted/common/media/dark.png`, `light.png`, `dark-hc.png`, `light-hc.png` | Regenerated the four welcome-picker preview thumbnails (874×600) as recolored mockups built from each Clawdius theme's real editor/sidebar/token/accent colors (orange tab indicator + accent pill; the HC variants keep the white-on-black / black-on-white high-contrast frame and divider). Replaces the upstream Modern/HC preview art. | n/a (binary asset) | welcome / getting-started |
| `extensions/theme-defaults/package.json` | "Only Clawdius themes" (Phase 4 follow-up): removed the 10 upstream color themes (Dark/Light Modern, Dark/Light+, VS Dark/Light, Dark/Light 2026, Default High Contrast + Light) from `contributes.themes`; kept the `vs-minimal` icon theme. The inert `themes/*.json` files are left untouched (so they merge cleanly) but are no longer contributed. | n/a (JSON, no inline comments) | built-in themes |
| `extensions/theme-{abyss,kimbie-dark,monokai,monokai-dimmed,quietlight,red,solarized-dark,solarized-light,tomorrow-night-blue}/**` | "Only Clawdius themes": deleted the 9 standalone upstream color-theme extensions wholesale (each contributed exactly one color theme and nothing else), so only the four Clawdius themes ship. `theme-seti` (default file icons) and `theme-defaults` (icon theme) are kept. `branding-guard.ts` scans every extension manifest and fails if any non-Clawdius color theme reappears (e.g. via an upstream merge). | n/a (upstream dir removal) | built-in themes |
| `build/gulpfile.extensions.ts` | Phase 2 (A): registered the new in-tree `extensions/clawdius-chat` extension in the hardcoded `compilations` list so its TypeScript compiles (the auto-glob is commented out upstream, so a new extension is not picked up automatically). | `// CLAWDIUS-BEGIN clawdius-chat` | build / extensions |
| `src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts` | Phase 2 (B): `COPILOT_USERNAME` `'GitHub Copilot'` → `'Clawdius Copilot'`, in lockstep with `product.json` `provider.default.name` → `'Clawdius'` (the default agent's display name is `${provider.default.name} Copilot`), so the redundant chat username + avatar stay hidden in the transcript. Must move together with the product.json flip. | `// CLAWDIUS-BEGIN brand username` | chat |
| `extensions/copilot/**` | Phase 2 (G1): "Copilot eliminated". Deleted the GitHub Copilot Chat extension wholesale (the prebuilt `dist/` bundle + 4154 tracked files). It registered SIX competing `isDefault` panel chat participants (`github.copilot.default/editingSession/editsAgent/...`) + 9 `chatViewsWelcome` sign-in overlays on `onStartupFinished`; since the panel default is "last isDefault extension agent wins" (`_preferExtensionAgent`), it raced the Clawdius participant for the panel nondeterministically. With it gone, `clawdius-chat` deterministically owns the panel. Build-safe: core references `github.copilot.*` only as product.json strings + context-key names (no TS import — core type-check stays green), and `packageCopilotExtensionStream` (build/lib/extensions.ts) already guards a missing dir with `fs.existsSync` → returns an empty stream, so the dead `compile-copilot-extension-build` gulp task (still wired into the packaging series in gulpfile.vscode.ts/reh.ts) is a harmless no-op. Those upstream build files are deliberately LEFT UNEDITED to keep the merge surface minimal. `branding-guard.ts` now fails if `extensions/copilot` reappears. | n/a (upstream dir removal) | built-in extensions (Copilot) |
| `eslint.config.js` | Phase 2 (G1) fallout: the root flat-config imported a custom ESLint plugin from INSIDE the deleted extension (`./extensions/copilot/.eslintplugin/index.ts`) and carried ~400 lines of copilot-only lint blocks (7 config objects, lines 2493-2892, using the `copilot-local` plugin). Removed the import + all seven blocks + two now-dead `extensions/copilot/**/*` ignore globs, so the config loads without the missing module (27 blocks remain). Left untouched: the `@github/copilot-sdk` / `@vscode/copilot-api` restricted-import entries and the `copilotChatSessions` sessions-provider zone — those belong to the agentHost subsystem + Agents window, a separate deeper elimination, not this extension. | n/a (block + import removal) | lint config |

## Branding asset replacements (in-place upstream binary / SVG swaps)
The VS Code logo/mark assets, replaced in place with the Clawdius mark (orange `#d97757` family,
re-exported from `clawdius-private-docs/images/clawdius-logo.{svg,png}`). These are upstream files, so a
merge that touches the same asset conflicts; re-export from the Clawdius master rather than hand-merge.
- **OS app-icon family:** `resources/win32/code.ico` + `code_150x150.png` + `code_70x70.png`,
  `resources/darwin/code.icns`, `resources/linux/code.png`, `resources/linux/rpm/code.xpm` (256px),
  `resources/server/code-192.png`, `code-512.png`, `favicon.ico`. `linux/code` + `server/code-192/512`
  share one 1024² master (byte-identical, retina-correct).
- **Inno installer wizard art:** `resources/win32/inno-{big,small}-{100,125,150,175,200,225,250}.bmp`
  (14 BMPs) — Clawdius logo centered on white at each placeholder's footprint size.
- **In-product / chrome logos:** `src/vs/workbench/browser/media/code-icon.svg` (titlebar/banner/welcome),
  `src/vs/sessions/browser/media/vscode-icon.svg` (Open-in-VS-Code), and `sessions-icon.svg`
  (Open-in-Agents widget; blue gradient recolored to the orange family).
- **Auth login chrome (interim, until Phase 2/3 removes the flow):**
  `extensions/github-authentication/media/favicon.ico` + `code-icon.svg`,
  `extensions/microsoft-authentication/media/favicon.ico`.

## New files / directories (no conflict, not part of the diff surface)
`UPSTREAM_VERSION`, `MERGING.md`, `CHANGES_AGAINST_UPSTREAM.md`, `BUILD.md`, `.gitleaks.toml`,
`.pre-commit-config.yaml`, `script/clawdius/**`, `clawdius/**`, `.github/workflows/clawdius-ci.yml`,
`extensions/clawdius-themes/**`, `extensions/clawdius-chat/**` (Phase 2 default chat participant stub),
`src/vs/workbench/services/accounts/test/browser/defaultAccount.test.ts` (Clawdius regression test).

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
