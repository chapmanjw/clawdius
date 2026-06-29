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
# reliable cross-distro verification artifact; embedded rpm/deb signing is best-effort.
#
# Usage: bash build/release/linux.sh <x64|arm64>   (env SKIP_BUILD=1 reuses the app folder)
set -euo pipefail
shopt -s nullglob   # unmatched *.deb/*.rpm globs expand to nothing, so the asserts below work

arch="${1:-x64}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
version="$(node -p "require('./package.json').version")"
out="$repo/release-artifacts"
mkdir -p "$out"
appdir="$(dirname "$repo")/VSCode-linux-$arch"
echo "=== Clawdius linux $arch v$version ==="

# Per-arch package-arch names, also used to scope the find roots (prepare-* only cleans
# the current arch's subdir, so an unscoped find could pick up a stale other-arch package).
case "$arch" in
	x64)   debarch=amd64; rpmarch=x86_64 ;;
	arm64) debarch=arm64; rpmarch=aarch64 ;;
	*) echo "ERROR: unsupported arch: $arch" >&2; exit 1 ;;
esac

# 1. Build the unpacked client app folder.
if [ "${SKIP_BUILD:-}" != "1" ]; then
	npm run gulp "vscode-linux-$arch-min"
fi
[ -d "$appdir" ] || { echo "ERROR: app folder missing: $appdir" >&2; exit 1; }

# 2. Portable tarball.
echo "==> tar.gz"
tar -czf "$out/Clawdius-linux-$arch-$version.tar.gz" -C "$(dirname "$appdir")" "VSCode-linux-$arch"

# 3. .deb (scoped to this arch; assert it was produced).
echo "==> deb"
npm run gulp "vscode-linux-$arch-prepare-deb"
npm run gulp "vscode-linux-$arch-build-deb"
debs=(".build/linux/deb/$debarch/deb/"*.deb)
[ ${#debs[@]} -gt 0 ] || { echo "ERROR: no .deb produced for $arch" >&2; exit 1; }
cp -v "${debs[@]}" "$out/"

# 4. .rpm (scoped; assert produced).
echo "==> rpm"
npm run gulp "vscode-linux-$arch-prepare-rpm"
npm run gulp "vscode-linux-$arch-build-rpm"
rpms=(".build/linux/rpm/$rpmarch/rpmbuild/RPMS/$rpmarch/"*.rpm)
[ ${#rpms[@]} -gt 0 ] || { echo "ERROR: no .rpm produced for $arch" >&2; exit 1; }
cp -v "${rpms[@]}" "$out/"

# 5. GPG sign (guarded). Embedded package signing is best-effort; the signed
#    SHA256SUMS.asc below is the dependable verification artifact.
if [ -n "${GPG_KEY_ID:-}" ]; then
	echo "==> GPG sign (key $GPG_KEY_ID)"
	export GPG_TTY="$(tty 2>/dev/null || echo /dev/console)"
	# rpm --addsign must get the passphrase non-interactively: feed it via a temp
	# file + rpm's _gpg_sign_cmd_extra_args (loopback pinentry).
	rpmpass="$(mktemp)"
	printf '%s' "${GPG_PASSPHRASE:-}" > "$rpmpass"
	for f in "$out"/*.rpm; do
		rpm --addsign \
			--define "_gpg_name $GPG_KEY_ID" \
			--define "_gpg_sign_cmd_extra_args --pinentry-mode loopback --passphrase-file $rpmpass" \
			"$f" || echo "  WARNING: rpm signing FAILED for $(basename "$f")"
	done
	rm -f "$rpmpass"
	for f in "$out"/*.deb; do
		if command -v dpkg-sig >/dev/null; then
			dpkg-sig --sign builder -k "$GPG_KEY_ID" "$f" || echo "  WARNING: deb signing FAILED for $(basename "$f")"
		else
			echo "  (dpkg-sig not installed; .deb embedded signing skipped)"
		fi
	done
else
	echo "   GPG signing skipped (no GPG_KEY_ID)"
fi

# 6. Checksums + detached signature (guard against an empty package set).
echo "==> checksums"
( cd "$out" && {
	files=("Clawdius-linux-$arch-$version.tar.gz" *.deb *.rpm)
	[ ${#files[@]} -gt 1 ] || { echo "ERROR: no packages to checksum" >&2; exit 1; }
	sha256sum "${files[@]}" > "SHA256SUMS-linux-$arch.txt"
} )
if [ -n "${GPG_KEY_ID:-}" ]; then
	gpg --batch --yes --pinentry-mode loopback ${GPG_PASSPHRASE:+--passphrase "$GPG_PASSPHRASE"} \
		--local-user "$GPG_KEY_ID" --armor --detach-sign \
		--output "$out/SHA256SUMS-linux-$arch.txt.asc" "$out/SHA256SUMS-linux-$arch.txt" || echo "  (checksum signature failed)"
fi

echo "=== linux $arch done ==="
ls -lh "$out" | grep -E "linux-$arch|\.deb|\.rpm" || true
