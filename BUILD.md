# Building Clawdius

Clawdius is a fork of microsoft/vscode and builds with the upstream toolchain. This file records the
reproducible recipe and the environment quirks found while building the Phase 0 baseline on a current
bleeding-edge Windows toolchain (Visual Studio 2026 + Node 24 + VS Code 1.125).

Base: microsoft/vscode `1.125.0` (see `UPSTREAM_VERSION`).

## Prerequisites (Windows x64)

- Node.js `>= 24.15.0` on the same major as `.nvmrc` (24). The preinstall guard rejects older patches
  (24.14.x fails). A portable Node works; it does not need to be the system Node.
- Python 3.x on PATH (node-gyp needs it). 3.11 and 3.12 both worked.
- Visual Studio 2022 or 2026 with the "Desktop development with C++" workload AND the
  "MSVC C++ x64/x86 Spectre-mitigated libs (Latest)" individual component. VS Code builds its native
  modules with Spectre mitigation on, so the Spectre libs are required (else MSB8040).

## Environment quirks on VS 2026 (toolset v18)

1. VS Code's `build/npm/preinstall.ts` only whitelists VS "2022" and "2019". On VS 2026 it throws
   "Invalid C/C++ Compiler Toolchain". Work around it by pointing the override env var at the VS 2026
   install: `set vs2022_install=C:\Program Files\Microsoft Visual Studio\18\Professional`.
2. Build inside a VS x64 developer environment so `VCINSTALLDIR` and `cl.exe` are set:
   `call "<VS>\VC\Auxiliary\Build\vcvarsall.bat" x64`.
3. Root native modules build cleanly: the repo's node-gyp (12.2.0) auto-detects VS 2026 via vswhere.
4. The bundled `copilot` extension pins a deprecated `sqlite3` whose bundled node-gyp (10.3.1) does not
   recognize VS 2026 and fails. Build that one module with a modern node-gyp (>= 13). See the workaround
   below. Phase 2 removes the Copilot extension, which eliminates this issue entirely.

## Recipe

```bat
:: 1. VS x64 dev env + Node 24.15.0 on PATH + the VS-version override
call "C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvarsall.bat" x64
set "PATH=<portable-node-24.15>;%PATH%"
set "vs2022_install=C:\Program Files\Microsoft Visual Studio\18\Professional"

:: 2. install deps + build root native modules + all extensions
cd /d <repo>
call npm install

:: 3. Copilot sqlite3 workaround (deprecated dep, old node-gyp vs VS 2026); skip once Phase 2 removes copilot
npm install -g node-gyp@latest
cd /d <repo>\extensions\copilot
call npm install --ignore-scripts
cd node_modules\sqlite3
node "<global-node-gyp-13>\bin\node-gyp.js" rebuild --runtime=electron --target=42.3.0 --dist-url=https://electronjs.org/headers --arch=x64

:: 4. compile and launch
cd /d <repo>
call npm run compile
call scripts\code.bat .
```

## Verification (Phase 0 done)

A vanilla build launches as "Code - OSS" (branding lands in Phase 1). The Electron app starts as a normal
multi-process tree (main, renderers, extension host, GPU, utilities) with no crash. `out/` is populated
(~206 MB) and `.build/electron` is downloaded on first launch.

## Notes

- The Copilot sqlite3 workaround is not committed into the repo; it is a build-time step that Phase 2's
  Copilot removal makes obsolete. Keeping it out preserves the small-diff doctrine.
- Cross-platform packaging (NSIS, dmg, deb, rpm), signing, and a CI build matrix are Phase 7.
