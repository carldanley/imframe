#!/usr/bin/env bash
set -euo pipefail

# Import the actual desktop environment instead of guessing a Wayland socket.
for variable in DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP; do
  if [[ -n ${!variable:-} ]]; then
    systemctl --user import-environment "$variable"
  fi
done
# The display agent starts Chromium only when awake or preparing to wake.
systemctl --user start imframe-display.service
