#!/usr/bin/env bash
# Build, package, and (optionally) GPG-sign the Clawdius Linux desktop app for one arch.
#
# Produces in <repo>/release-artifacts/:
#   Clawdius-linux-<arch>-<version>.tar.gz   portable archive
#   <package>.deb                            Debian/Ubuntu package
#   <package>.rpm                            Fedora/RHEL package
#   SHA256SUMS-linux-<arch>.txt              (+ .asc detached signature when signing)
#
# GPG signing runs only when GPG_KEY_ID is set and that key is imported into the
# runner's gpg keyring (GPG_PASSPHRASE optional). The detached SHA256SUMS.asc is the
# reliable cross-distro verification artifact; embedded rpm/deb signing is best-effort
# (the non-interactive gpg setup may need a runner tweak).
#
# Usage: bash build/release/linux.sh <x64|arm64>   (env SKIP_BUILD=1 reuses the app folder)
set -euo pipefail

arch="${1:-x64}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
version="$(node -p "require('./package.json').version")"
out="$repo/release-artifacts"
mkdir -p "$out"
appdir="$(dirname "$repo")/VSCode-linux-$arch"
echo "=== Clawdius linux $arch v$version ==="

# 1. Build the unpacked client app folder.
if [ "${SKIP_BUILD:-}" != "1" ]; then
	npm run gulp "vscode-linux-$arch-min"
fi
[ -d "$appdir" ] || { echo "ERROR: app folder missing: $appdir" >&2; exit 1; }

# 2. Portable tarball.
echo "==> tar.gz"
tar -czf "$out/Clawdius-linux-$arch-$version.tar.gz" -C "$(dirname "$appdir")" "VSCode-linux-$arch"

# 3. .deb
echo "==> deb"
npm run gulp "vscode-linux-$arch-prepare-deb"
npm run gulp "vscode-linux-$arch-build-deb"
find .build/linux/deb -name '*.deb' -exec cp -v {} "$out/" \;

# 4. .rpm
echo "==> rpm"
npm run gulp "vscode-linux-$arch-prepare-rpm"
npm run gulp "vscode-linux-$arch-build-rpm"
find .build/linux/rpm -name '*.rpm' -exec cp -v {} "$out/" \;

# 5. GPG sign (guarded). Embedded package signing is best-effort; the signed
#    SHA256SUMS.asc below is the dependable verification artifact.
if [ -n "${GPG_KEY_ID:-}" ]; then
	echo "==> GPG sign (key $GPG_KEY_ID)"
	export GPG_TTY="$(tty 2>/dev/null || echo /dev/console)"
	printf '%%_gpg_name %s\n' "$GPG_KEY_ID" > "$HOME/.rpmmacros"
	for f in "$out"/*.rpm; do [ -e "$f" ] && { rpm --addsign "$f" || echo "  (rpm --addsign needs runner tuning)"; }; done
	for f in "$out"/*.deb; do [ -e "$f" ] && { command -v dpkg-sig >/dev/null && dpkg-sig --sign builder -k "$GPG_KEY_ID" "$f" || echo "  (deb sign skipped)"; }; done
else
	echo "   GPG signing skipped (no GPG_KEY_ID)"
fi

# 6. Checksums + detached signature.
echo "==> checksums"
( cd "$out" && sha256sum "Clawdius-linux-$arch-$version.tar.gz" *.deb *.rpm > "SHA256SUMS-linux-$arch.txt" )
if [ -n "${GPG_KEY_ID:-}" ]; then
	gpg --batch --yes --pinentry-mode loopback ${GPG_PASSPHRASE:+--passphrase "$GPG_PASSPHRASE"} \
		--local-user "$GPG_KEY_ID" --armor --detach-sign \
		--output "$out/SHA256SUMS-linux-$arch.txt.asc" "$out/SHA256SUMS-linux-$arch.txt" || echo "  (checksum signature failed)"
fi

echo "=== linux $arch done ==="
ls -lh "$out" | grep -E "linux-$arch|\.deb|\.rpm" || true
