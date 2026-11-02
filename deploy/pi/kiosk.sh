#!/usr/bin/env bash
set -euo pipefail

until curl --fail --silent --output /dev/null --max-time 5 http://127.0.0.1:3000/api/settings; do
  sleep 2
done

profile_dir="${XDG_DATA_HOME:-$HOME/.local/share}/imframe/chromium"
mkdir -p "$profile_dir"
platform=()
if [[ ${XDG_SESSION_TYPE:-} == wayland ]]; then
  platform=(--ozone-platform=wayland)
fi

# A separate profile keeps the frame independent of normal desktop browsing.
# Auto-login leaves the desktop keyring locked; this kiosk does not need it.
exec "${IMFRAME_CHROMIUM:-/usr/bin/chromium}" "${platform[@]}" \
  --use-angle=gles --enable-gpu-rasterization \
  --user-data-dir="$profile_dir" \
  --password-store=basic \
  --kiosk --no-first-run --no-default-browser-check --noerrdialogs \
  --disable-session-crashed-bubble \
  'http://localhost:3000/frame?kiosk=1'
