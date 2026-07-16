# Building Clawdius

Clawdius is a fork of microsoft/vscode and builds with the upstream toolchain. The supported baseline
matches microsoft/vscode's own CI: the Visual Studio 2022 C++ Build Tools plus the pinned Node. On that
baseline the build is a clean `npm ci` with no workarounds.

Base: microsoft/vscode `1.125.0` (see `UPSTREAM_VERSION`).

## Prerequisites (Windows x64, supported baseline)

- Node.js the version in `.nvmrc` (24.15.0), same major (24). Older patches fail the preinstall guard.
- Python 3.x on PATH (node-gyp needs it).
- Visual Studio 2022 C++ Build Tools (standalone, no IDE needed), with:
  - the C++ build tools workload `Microsoft.VisualStudio.Workload.VCTools` (MSVC v143 + Windows 11 SDK
    via `--includeRecommended`), and
  - the MSVC x64/x86 Spectre-mitigated libs
    `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`. Required because VS Code builds its
    native modules with Spectre mitigation on (else MSB8040).

  Install:
  ```
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre"
  ```

## Recipe (VS 2022 baseline)

One command (detects VS 2022 via vswhere, enters its dev env, installs, compiles):
```
powershell -ExecutionPolicy Bypass -File script\clawdius\build-win.ps1
```

Or by hand, from a VS 2022 x64 developer environment so `VCINSTALLDIR` and `cl.exe` are set:
```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
cd /d <repo>
npm ci             :: installs deps + builds all native modules (root + extensions)
npm run compile    :: TypeScript -> out/
scripts\code.bat . :: launch
```

No `vs2022_install` override and no node-gyp override are needed on the VS 2022 baseline.

## VS 2026 compatibility lane (only if you build on VS 2026 / toolset v18)

VS 2026 is newer than VS Code 1.125's blessed toolchain and needs two workarounds, which is why the
VS 2022 baseline above is preferred:
1. `set vs2022_install=<VS 2026 path>` because preinstall only whitelists "2022" and "2019".
2. Run inside the VS 2026 x64 dev env (`vcvarsall.bat x64`) for `VCINSTALLDIR`.

## Verification

A build launches as Clawdius and boots as a normal multi-process Electron app (main, renderers,
extension host, GPU, utilities, and the Claude agent-host utility process) with no crash, and shuts
down cleanly. `.build/electron` downloads on first launch.

## Notes

- Git LFS: some upstream test-cache objects 404 on the LFS server. Use `GIT_LFS_SKIP_SMUDGE=1` for
  clone, checkout, and merge (CI uses `actions/checkout` with `lfs: false`). The pointers are not
  needed to build.
- Full incremental development uses the watch tasks, not `npm run compile`; see the inherited
  `.claude/CLAUDE.md`. `npm run compile` is the correct one-shot full build used here.
- Cross-platform packaging (NSIS, dmg, deb, rpm), signing, and the full CI matrix are future work.
