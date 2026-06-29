#!/usr/bin/env bash
# Build and tar the Clawdius REH (remote extension host) server for one arch.
# Produces in <repo>/release-artifacts/:
#   clawdius-reh-linux-<arch>-<version>.tar.gz   (downloaded by open-remote-ssh/-wsl)
#   SHA256SUMS-reh-linux-<arch>.txt              (+ .asc detached GPG signature when signing)
#
# The Open Remote - SSH / Open Remote - WSL extensions resolve product.json's
# serverDownloadUrlTemplate to this asset, extract it (tar --strip-components 1), and run
# bin/clawdius-server on the remote. The server's product.json commit is stamped from the same
# source tree as the desktop client, so a client and the server built in the SAME workflow run
# match at the version/commit handshake.
#
# Usage: bash build/release/reh.sh <x64|arm64>   (env SKIP_BUILD=1 reuses the built folder)
set -euo pipefail

arch="${1:-x64}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
version="$(node -p "require('./package.json').version")"
out="$repo/release-artifacts"
mkdir -p "$out"
rehdir="$(dirname "$repo")/vscode-reh-linux-$arch"
echo "=== Clawdius REH linux $arch v$version ==="

case "$arch" in
	x64|arm64) ;;
	*) echo "ERROR: unsupported arch: $arch" >&2; exit 1 ;;
esac

# 1. Build the REH server folder (emits ../vscode-reh-linux-<arch>). Non-minified on purpose: the
#    minifier's mangler step OOM-kills the 16 GB CI runner, and the server does not need mangling
#    (the desktop client only mangles its -min build). The server is bundled but not minified.
if [ "${SKIP_BUILD:-}" != "1" ]; then
	npm run gulp "vscode-reh-linux-$arch"
fi
[ -d "$rehdir" ] || { echo "ERROR: REH folder missing: $rehdir" >&2; exit 1; }
[ -f "$rehdir/bin/clawdius-server" ] || { echo "ERROR: bin/clawdius-server missing in $rehdir" >&2; exit 1; }

# 2. Tar with -C parent so the archive has a single top-level dir
#    (the extensions extract with tar --strip-components 1, so the inner name is irrelevant).
echo "==> tar.gz"
tar -czf "$out/clawdius-reh-linux-$arch-$version.tar.gz" \
	-C "$(dirname "$repo")" "vscode-reh-linux-$arch"

# 3. Checksum + detached GPG signature (guarded), mirroring the desktop Linux legs so the remote
#    server ships a signed verification artifact. The signed SHA256SUMS-reh-*.asc is the dependable
#    cross-distro way to verify the downloaded server tarball.
( cd "$out" && sha256sum "clawdius-reh-linux-$arch-$version.tar.gz" > "SHA256SUMS-reh-linux-$arch.txt" )
if [ -n "${GPG_KEY_ID:-}" ]; then
	echo "==> GPG sign checksums (key $GPG_KEY_ID)"
	export GPG_TTY="$(tty 2>/dev/null || echo /dev/console)"
	gpg --batch --yes --pinentry-mode loopback ${GPG_PASSPHRASE:+--passphrase "$GPG_PASSPHRASE"} \
		--local-user "$GPG_KEY_ID" --armor --detach-sign \
		--output "$out/SHA256SUMS-reh-linux-$arch.txt.asc" "$out/SHA256SUMS-reh-linux-$arch.txt" || echo "  (checksum signature failed)"
else
	echo "   GPG signing skipped (no GPG_KEY_ID)"
fi

echo "=== REH linux $arch done ==="
ls -lh "$out" | grep -E "reh-linux-$arch" || true
