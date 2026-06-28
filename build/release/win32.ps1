#!/usr/bin/env pwsh
#Requires -Version 7.0
# Build, optionally sign, and package the Clawdius Windows desktop app for one arch.
#
# Produces in <repo>/release-artifacts/:
#   Clawdius-win32-<arch>-<version>.zip       portable archive (signed app inside)
#   ClawdiusUserSetup-<arch>-<version>.exe     per-user installer (no admin)
#   ClawdiusSystemSetup-<arch>-<version>.exe   system installer
#   SHA256SUMS-win32-<arch>.txt
#
# Signing is applied to the app binaries (before packaging) and to the installers
# (after) ONLY when Azure Trusted Signing is FULLY configured via env:
#   AZ_TRUSTED_SIGNING_ENDPOINT / _ACCOUNT / _PROFILE  (signing target)
#   AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET  (DefaultAzureCredential)
#   CLAWDIUS_SIGN_DLIB    full path to Azure.CodeSigning.Dlib.dll
#   CLAWDIUS_SIGNTOOL     full path to signtool.exe
# If any are missing the artifacts are produced UNSIGNED (fine for pre-release validation).
[CmdletBinding()]
param(
	[ValidateSet('x64', 'arm64')][string]$Arch = 'x64',
	[string]$Version,
	[switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
Set-Location $repo
if (-not $Version) { $Version = (node -p "require('./package.json').version") }
$appDir = Join-Path (Split-Path $repo -Parent) "VSCode-win32-$Arch"
$out = Join-Path $repo 'release-artifacts'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Write-Host "=== Clawdius win32 $Arch v$Version ===" -ForegroundColor Cyan

# 1. Build the unpacked client app folder.
if (-not $SkipBuild) {
	Write-Host "==> npm run gulp vscode-win32-$Arch-min"
	& npm run gulp "vscode-win32-$Arch-min"
	if ($LASTEXITCODE -ne 0) { throw "vscode-win32-$Arch-min failed ($LASTEXITCODE)" }
}
$exe = Join-Path $appDir 'Clawdius.exe'
if (-not (Test-Path $exe)) { throw "app not found: $exe (build first, or drop -SkipBuild)" }

# Guarded Azure Trusted Signing helper (signtool + the Azure.CodeSigning dlib). All of the
# signing-target vars AND the DefaultAzureCredential vars must be present; otherwise signtool
# would run and fail to authenticate, aborting the build instead of degrading to unsigned.
$canSign = $env:AZ_TRUSTED_SIGNING_ENDPOINT -and $env:AZ_TRUSTED_SIGNING_ACCOUNT -and $env:AZ_TRUSTED_SIGNING_PROFILE -and $env:CLAWDIUS_SIGN_DLIB -and $env:CLAWDIUS_SIGNTOOL -and $env:AZURE_TENANT_ID -and $env:AZURE_CLIENT_ID -and $env:AZURE_CLIENT_SECRET
function Invoke-Sign([string[]]$files) {
	if (-not $files) { return }
	if (-not $canSign) { Write-Host "   signing skipped (Azure Trusted Signing not fully configured)" -ForegroundColor Yellow; return }
	$meta = Join-Path ($env:RUNNER_TEMP ?? $env:TEMP) 'clawdius-signing-metadata.json'
	@{ Endpoint = $env:AZ_TRUSTED_SIGNING_ENDPOINT; CodeSigningAccountName = $env:AZ_TRUSTED_SIGNING_ACCOUNT; CertificateProfileName = $env:AZ_TRUSTED_SIGNING_PROFILE } | ConvertTo-Json | Set-Content -Path $meta -Encoding utf8
	foreach ($f in $files) {
		& $env:CLAWDIUS_SIGNTOOL sign /v /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /dlib $env:CLAWDIUS_SIGN_DLIB /dmdf $meta $f
		if ($LASTEXITCODE -ne 0) { throw "signtool failed on $f" }
	}
}

# 2. Stage the inno-updater tool into the app FIRST, so it is signed with everything else
#    (code.iss pulls tools\* into both installers + the zip via SourceDir=$appDir).
Write-Host "==> npm run gulp vscode-win32-$Arch-inno-updater"
& npm run gulp "vscode-win32-$Arch-inno-updater"
if ($LASTEXITCODE -ne 0) { throw "inno-updater failed ($LASTEXITCODE)" }

# 3. Sign all app binaries BEFORE packaging (now incl. tools\inno_updater.exe + vcruntime140.dll).
$bins = Get-ChildItem $appDir -Recurse -Include *.exe, *.dll, *.node -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
Write-Host "==> sign $($bins.Count) app binaries"
Invoke-Sign $bins

# 4. Build the installers (user + system).
foreach ($target in 'user', 'system') {
	Write-Host "==> npm run gulp vscode-win32-$Arch-$target-setup"
	& npm run gulp "vscode-win32-$Arch-$target-setup"
	if ($LASTEXITCODE -ne 0) { throw "$target-setup failed ($LASTEXITCODE)" }
	$built = Join-Path $repo ".build/win32-$Arch/$target-setup/ClawdiusSetup.exe"
	if (-not (Test-Path $built)) { throw "installer not produced: $built" }
	$label = if ($target -eq 'user') { 'User' } else { 'System' }
	Copy-Item $built (Join-Path $out "Clawdius${label}Setup-$Arch-$Version.exe") -Force
}

# 5. Sign the installers.
Write-Host "==> sign installers"
Invoke-Sign (Get-ChildItem $out -Filter "Clawdius*Setup-$Arch-$Version.exe" | ForEach-Object { $_.FullName })

# 6. Portable zip of the (signed) app folder.
$zip = Join-Path $out "Clawdius-win32-$Arch-$Version.zip"
Write-Host "==> zip -> $(Split-Path $zip -Leaf)"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $appDir '*') -DestinationPath $zip -CompressionLevel Optimal

# 7. Per-arch checksums.
Get-ChildItem $out -File | Where-Object { $_.Name -match "win32-$Arch-$Version" -or $_.Name -match "Setup-$Arch-$Version" } | ForEach-Object {
	"$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)"
} | Set-Content -Path (Join-Path $out "SHA256SUMS-win32-$Arch.txt") -Encoding ascii

Write-Host "=== win32 $Arch done ===" -ForegroundColor Green
Get-ChildItem $out | Where-Object { $_.Name -match "win32-$Arch" -or $_.Name -match "Setup-$Arch" } | ForEach-Object { "  {0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB) }
