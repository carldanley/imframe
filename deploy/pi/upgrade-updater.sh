#!/usr/bin/env bash
set -euo pipefail

# One-time migration for frames installed before Hub support. Existing app,
# browser, display configuration, and Immich credentials remain in place.
[[ $EUID == 0 ]] || { echo 'Run this script with sudo.' >&2; exit 1; }
[[ -s /opt/imframe/.env && -f /etc/default/imframe ]] || { echo 'Provision this frame before upgrading its updater.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec 8>/opt/imframe/update.lock
flock 8
install -d -m 0755 /usr/local/libexec/imframe
install -m 0755 "$source_dir/update.sh" "$source_dir/agent.py" /usr/local/libexec/imframe/
install -m 0644 "$source_dir/imframe-update.service" "$source_dir/imframe-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/imframe-update.service /etc/systemd/system/imframe-update.timer
flock -u 8
systemctl enable --now imframe-update.timer
systemctl restart imframe-update.timer
systemctl start imframe-update.service
echo 'Hub updater installed. Existing frame settings and browser are unchanged.'
