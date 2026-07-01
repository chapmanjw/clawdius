# Clawdius local E2E harness

A reusable Playwright harness that launches the compiled dev build of Clawdius and drives every
Clawdius feature end-to-end, screenshotting and asserting each step. Use it as the local UX
regression test after an upstream merge or a feature change.

It runs against an **isolated** user-data/extensions dir, so it never touches your real
`~/.clawdius` profile.

## Prereqs

1. Build the dev app once (gets electron, compiles, built-in extensions):
   ```
   node build/lib/preLaunch.ts
   ```
   Re-run after source changes, or run `node build/next/index.ts transpile` for a fast TS-only pass.
2. A display (this drives a real Electron window). On the dev machine it just works; in CI you need a
   virtual display (Xvfb on Linux).

## Run

From the repo root:
```
node test/clawdius-e2e/harness.ts
```
Options:
- `--out <dir>` screenshot + report dir (default `.build/clawdius-e2e`)
- `--grep <substr>` run only scenarios whose name contains `<substr>`
- `--keep-open` leave the window up at the end for manual poking

Output: one PNG per scenario (`NN-<name>.png`) plus `report.json` (name / ok / detail / screenshot).
Exit code is non-zero if any **critical** scenario fails.

## Scenario catalogue (replay steps)

Each scenario is one boot's worth of driving. `critical` scenarios gate the exit code.

| # | Scenario | critical | Replay steps | Assertion / expected |
|---|---|---|---|---|
| 1 | `boot-workbench` | yes | launch `.build/electron/Clawdius.exe .` (VSCODE_DEV=1) -> wait `.monaco-workbench` | title matches `Clawdius`; workbench inner text has NO `copilot` |
| 2 | `statusbar-pills` | yes | read `.statusbar .statusbar-item` aria-labels | text contains usage + budget + "permission mode" + effort |
| 3 | `palette-clawdius-commands` | yes | `Ctrl+Shift+P`, type `Clawdius: `, read `.quick-input-list .monaco-list-row` | list contains "Control Center" and "Usage Dashboard" (>=11 commands) |
| 4 | `control-center` | yes | run cmd "Open Claude Code Control Center" | workbench text shows tabs Usage/Permissions/MCP/Skills/Plugins/Hooks |
| 5 | `usage-dashboard` | yes | run cmd "Open Claude Code Usage Dashboard" | dashboard editor renders (usage text present) |
| 6 | `context-budget-panel` | no | run cmd "Open Claude Code Context Budget" | opens without throwing |
| 7 | `permission-picker` | yes | run cmd "Set Default Permission Mode" -> read the quick pick | modes include Plan .. Bypass (4 rows) |
| 8 | `effort-picker` | no | run cmd "Set Default Effort Level" -> read the quick pick | effort options listed (~6) |
| 9 | `check-for-updates` | no | run cmd "Check for Updates" | command runs (no network assertion here - see zero-egress note) |
| 10 | `theme-clawdius-dark` | no | run "Preferences: Color Theme" -> pick "Clawdius Dark" | status-bar screenshot for eyeballing the safety-pill contrast fix |
| 11 | `theme-clawdius-light` | no | run "Preferences: Color Theme" -> pick "Clawdius Light" | status-bar screenshot for eyeballing the safety-pill contrast fix |

Commands are run through the command palette by their palette title (category is "Clawdius", so the
palette entry is `Clawdius: <title>`). The exact titles come from
`src/vs/workbench/contrib/clawdius/browser/**` (`localize2(..., "<title>")`); keep this table in sync
if a title changes.

## What is NOT covered here (and why)

- **Zero-egress / OTEL gate** - asserting "no outbound at idle" and "no OTLP even with
  `OTEL_EXPORTER_OTLP_ENDPOINT` set" needs a network monitor (a proxy or `--proxy-server` capture),
  not just DOM. Add a scenario that launches behind a recording proxy and asserts zero requests at
  idle, then one Claude turn with the OTEL env set stays silent. Until then this is covered by
  `branding-guard` + the unit layer.
- **The chat "Thinking" toggle color fix** - lives in the installed `anthropic.claude-code` webview,
  which the isolated profile does not install (no network). To test it, pre-seed the extensions-dir
  with the plugin, then screenshot the toggle on Clawdius Dark + Light and compare the on/off track.
- **Remote / WSL** - launch with a `--folder-uri vscode-remote://wsl+...` (needs the REH server) to
  exercise the remote usage dashboard + the effort-change-does-not-disconnect fix.

These are the next scenarios to add; the harness is structured so each is one more `scenario(...)`
call.

## Adding a scenario

In `harness.ts`, add `await scenario('<name>', <critical>, async () => { ...drive...; assert(...); return '<detail>'; });`.
Use `runCommand('<palette title>')`, `setTheme('<label>')`, `statusText()`, and `assert(cond, msg)`.
A screenshot is captured automatically after each scenario.

## Last known-good

Post-1.126-merge: **11/11 scenarios pass** (0 critical-fail, 0 warn) on the merged dev build.
