#!/usr/bin/env bash
set -euo pipefail

# Import the actual desktop environment instead of guessing a Wayland socket.
for variable in DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP; do
  if [[ -n ${!variable:-} ]]; then
    systemctl --user import-environment "$variable"
  fi
done
systemctl --user start imframe-kiosk.service
