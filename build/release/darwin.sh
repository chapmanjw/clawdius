#!/usr/bin/env bash
# Build, sign, notarize, and package the Clawdius macOS universal desktop app.
# Runs on macOS (a macos-14 runner). Produces in <repo>/release-artifacts/:
#   Clawdius-darwin-universal-<version>.dmg
#   Clawdius-darwin-universal-<version>.zip
#   SHA256SUMS-darwin-universal.txt
#
# Signing runs only when CODESIGN_IDENTITY is set (a Developer ID Application identity
# already imported into a keychain at $AGENT_TEMPDIRECTORY/buildagent.keychain).
# Notarization runs only when the App Store Connect API key env is present
# (APPLE_API_KEY_P8_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID). Without these the
# .app/.dmg are produced UNSIGNED (Gatekeeper-blocked; fine for pre-release validation).
#
# NOTE: authored against build/darwin/{create-universal-app,sign,create-dmg}.ts but NOT
# yet run on a Mac. Validate on a macos runner before relying on it.
#
# Usage: bash build/release/darwin.sh    (env SKIP_BUILD=1 reuses the arch builds)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
buildDir="$(dirname "$repo")"
version="$(node -p "require('./package.json').version")"
appName="$(node -p "require('./product.json').nameLong").app"
out="$repo/release-artifacts"
mkdir -p "$out"
echo "=== Clawdius darwin universal v$version (app: $appName) ==="

# 1. Build both arch slices (-> $buildDir/VSCode-darwin-{x64,arm64}/<app>).
if [ "${SKIP_BUILD:-}" != "1" ]; then
	for a in x64 arm64; do
		echo "==> gulp vscode-darwin-$a-min"
		VSCODE_ARCH="$a" npm run gulp "vscode-darwin-$a-min"
	done
fi

# 2. Merge into the universal app (-> $buildDir/VSCode-darwin-universal/<app>).
echo "==> create universal app"
export VSCODE_ARCH=universal
node build/darwin/create-universal-app.ts "$buildDir"
appPath="$buildDir/VSCode-darwin-universal/$appName"
[ -d "$appPath" ] || { echo "ERROR: universal app missing: $appPath" >&2; exit 1; }

# 3. Codesign (Developer ID, hardened runtime + entitlements) - guarded.
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
	echo "==> codesign (Developer ID)"
	export AGENT_TEMPDIRECTORY="${AGENT_TEMPDIRECTORY:-${RUNNER_TEMP:-/tmp}}"
	VSCODE_ARCH=universal node build/darwin/sign.ts "$buildDir"

	# 4. Notarize + staple the app - guarded on the App Store Connect API key.
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

# 5. DMG (create-dmg.ts emits VSCode-darwin-universal.dmg into $out).
echo "==> create dmg"
node build/darwin/create-dmg.ts "$buildDir" "$out"
mv "$out/VSCode-darwin-universal.dmg" "$out/Clawdius-darwin-universal-$version.dmg"
[ -n "${APPLE_API_KEY_P8_PATH:-}" ] && xcrun stapler staple "$out/Clawdius-darwin-universal-$version.dmg" || true

# 6. Portable zip of the (signed) app.
echo "==> zip app"
ditto -c -k --keepParent "$appPath" "$out/Clawdius-darwin-universal-$version.zip"

# 7. Checksums.
( cd "$out" && shasum -a 256 "Clawdius-darwin-universal-$version.dmg" "Clawdius-darwin-universal-$version.zip" > "SHA256SUMS-darwin-universal.txt" )

echo "=== darwin done ==="
ls -lh "$out" | grep -E "darwin-universal" || true
