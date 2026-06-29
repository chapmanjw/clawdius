#!/usr/bin/env bash
# Build, sign, notarize, and package the Clawdius macOS (Apple Silicon / arm64) desktop app.
# Runs on macOS (a macos-14 / Apple Silicon runner). Produces in <repo>/release-artifacts/:
#   Clawdius-darwin-arm64-<version>.dmg
#   Clawdius-darwin-arm64-<version>.zip
#   SHA256SUMS-darwin-arm64.txt
#
# Clawdius ships an arm64-only macOS build for now. The runner is Apple Silicon, so the app
# gets genuine arm64 native modules. A true universal build needs real per-arch native modules
# for the x64 slice - several @vscode/* prebuilts otherwise come out byte-identical across
# arches (i.e. not actually x64), which would make a "universal" app broken on Intel. Building
# those x64 native modules is separate work tracked for a later release.
#
# Signing runs only when CODESIGN_IDENTITY is set (a Developer ID Application identity already
# imported into a keychain at $AGENT_TEMPDIRECTORY/buildagent.keychain). Notarization runs only
# when the App Store Connect API key env is present (APPLE_API_KEY_P8_PATH, APPLE_API_KEY_ID,
# APPLE_API_ISSUER_ID). Without these the .app/.dmg are produced UNSIGNED (Gatekeeper-blocked;
# fine for pre-release validation).
#
# Usage: bash build/release/darwin.sh    (env SKIP_BUILD=1 reuses the arch build)
set -euo pipefail

arch="arm64"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
buildDir="$(dirname "$repo")"
version="$(node -p "require('./package.json').version")"
appName="$(node -p "require('./product.json').nameLong").app"
out="$repo/release-artifacts"
mkdir -p "$out"
export VSCODE_ARCH="$arch"
echo "=== Clawdius darwin $arch v$version (app: $appName) ==="

# 1. Build the arm64 client app (-> $buildDir/VSCode-darwin-arm64/<app>).
if [ "${SKIP_BUILD:-}" != "1" ]; then
	echo "==> gulp vscode-darwin-$arch-min"
	VSCODE_ARCH="$arch" npm run gulp "vscode-darwin-$arch-min"
fi
appPath="$buildDir/VSCode-darwin-$arch/$appName"
[ -d "$appPath" ] || { echo "ERROR: app missing: $appPath" >&2; exit 1; }

# 2. Codesign (Developer ID, hardened runtime + entitlements) - guarded.
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
	echo "==> codesign (Developer ID)"
	export AGENT_TEMPDIRECTORY="${AGENT_TEMPDIRECTORY:-${RUNNER_TEMP:-/tmp}}"
	VSCODE_ARCH="$arch" node build/darwin/sign.ts "$buildDir"

	# 3. Notarize + staple the app - guarded on the App Store Connect API key.
	if [ -n "${APPLE_API_KEY_P8_PATH:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER_ID:-}" ]; then
		echo "==> notarize app"
		ditto -c -k --keepParent "$appPath" "$out/_notarize.zip"
		xcrun notarytool submit "$out/_notarize.zip" --key "$APPLE_API_KEY_P8_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait
		xcrun stapler staple "$appPath"
		rm -f "$out/_notarize.zip"
	else
		echo "   notarization skipped (no App Store Connect API key)"
	fi
else
	echo "   signing + notarization skipped (no CODESIGN_IDENTITY)"
fi

# 4. DMG (create-dmg.ts emits VSCode-darwin-$arch.dmg into $out).
echo "==> create dmg"
node build/darwin/create-dmg.ts "$buildDir" "$out"
mv "$out/VSCode-darwin-$arch.dmg" "$out/Clawdius-darwin-$arch-$version.dmg"
# The DMG needs its OWN notarization ticket (the app's ticket inside does not cover it, so
# `stapler staple <dmg>` fails unless the DMG itself was submitted to notarytool).
if [ -n "${CODESIGN_IDENTITY:-}" ] && [ -n "${APPLE_API_KEY_P8_PATH:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER_ID:-}" ]; then
	echo "==> notarize dmg"
	xcrun notarytool submit "$out/Clawdius-darwin-$arch-$version.dmg" --key "$APPLE_API_KEY_P8_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait
	xcrun stapler staple "$out/Clawdius-darwin-$arch-$version.dmg"
fi

# 5. Portable zip of the (signed) app.
echo "==> zip app"
ditto -c -k --keepParent "$appPath" "$out/Clawdius-darwin-$arch-$version.zip"

# 6. Checksums.
( cd "$out" && shasum -a 256 "Clawdius-darwin-$arch-$version.dmg" "Clawdius-darwin-$arch-$version.zip" > "SHA256SUMS-darwin-$arch.txt" )

echo "=== darwin $arch done ==="
ls -lh "$out" | grep -E "darwin-$arch" || true
