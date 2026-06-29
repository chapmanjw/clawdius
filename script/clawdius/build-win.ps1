# Clawdius Windows build bootstrap.
# Detects the VS 2022 C++ Build Tools via vswhere, enters its x64 developer environment, and runs a
# clean install + compile. Prerequisites in docs/BUILD.md (VS 2022 Build Tools + Spectre libs, Node from
# .nvmrc, Python). VS 2022 is the supported baseline; on it the build needs no workarounds.
$ErrorActionPreference = 'Stop'
$env:GIT_LFS_SKIP_SMUDGE = '1'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere not found. Install the VS 2022 C++ Build Tools (see docs/BUILD.md)." }

# Prefer VS 2022 (version 17.x) with the C++ toolset; fall back to any VS with C++ tools.
$req = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
$vs = (& $vswhere -products '*' -version '[17.0,18.0)' -requires $req -property installationPath | Select-Object -First 1)
if (-not $vs) { $vs = (& $vswhere -products '*' -requires $req -property installationPath | Select-Object -First 1) }
if (-not $vs) { throw "No Visual Studio install with the C++ toolset (VCTools) was found. See docs/BUILD.md." }
Write-Host "Clawdius build: using Visual Studio at $vs"

# Enter the VS x64 developer shell (sets VCINSTALLDIR, cl.exe, INCLUDE, LIB).
Import-Module (Join-Path $vs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null

Set-Location $repo
Write-Host "Node $(node --version), npm $(npm --version)"

cmd /c "npm ci"
if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
cmd /c "npm run compile"
if ($LASTEXITCODE -ne 0) { throw "npm run compile failed (exit $LASTEXITCODE)" }

Write-Host "Clawdius build complete. Launch with: scripts\code.bat ."
