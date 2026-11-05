#!/usr/bin/env bash
set -euo pipefail

# Existing desktops can gain fullscreen recovery without a root installation.
# apt-get verifies the package against the system's authenticated package index.
tools_dir=${1:-$HOME/.local/libexec/imframe/tools}
if command -v wlrctl >/dev/null || [[ -x $tools_dir/usr/bin/wlrctl ]]; then exit 0; fi
if ! command -v apt-get >/dev/null || ! command -v dpkg-deb >/dev/null; then
  echo 'Install wlrctl before upgrading the display service.' >&2
  exit 1
fi
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
(cd -- "$temporary" && apt-get download wlrctl)
packages=("$temporary"/wlrctl_*.deb)
[[ ${#packages[@]} == 1 && -f ${packages[0]} ]] || {
  echo 'Could not download the wlrctl package.' >&2
  exit 1
}
dpkg-deb -x "${packages[0]}" "$temporary/package"
# Check runtime dependencies before installing anything. Keep the package docs
# and license alongside the executable; no package scripts run as root.
"$temporary/package/usr/bin/wlrctl" --version
install -d -m 0755 "$tools_dir"
cp -R "$temporary/package/." "$tools_dir/"
