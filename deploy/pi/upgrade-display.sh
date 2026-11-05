#!/usr/bin/env bash
set -euo pipefail

# Run as the existing desktop user. This does not need access to Docker or secrets.
[[ $EUID != 0 ]] || { echo 'Run this as the Pi desktop user, without sudo.' >&2; exit 1; }
command -v wlopm >/dev/null || { echo 'Install wlopm first: sudo apt-get install wlopm' >&2; exit 1; }
command -v wlr-randr >/dev/null || { echo 'Install wlr-randr first: sudo apt-get install wlr-randr' >&2; exit 1; }
[[ -f $HOME/.local/libexec/imframe/kiosk.sh ]] || { echo 'Provision this frame before adding display sleep.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 0755 "$HOME/.config/systemd/user"
install -m 0755 "$source_dir/display.py" "$source_dir/session.sh" "$HOME/.local/libexec/imframe/"
install -m 0644 "$source_dir/imframe-display.service" "$HOME/.config/systemd/user/"
python3 "$HOME/.local/libexec/imframe/display.py" --configure
systemctl --user daemon-reload
if systemctl --user show-environment | grep -q '^WAYLAND_DISPLAY='; then
  if systemctl --user is-active --quiet imframe-display.service && python3 "$HOME/.local/libexec/imframe/display.py" --is-sleeping; then
    # Older agents wake the monitor in their SIGTERM/finally handler. The new
    # ExecStopPost preserves sleep, and Restart=always starts the new agent.
    systemctl --user kill --kill-whom=main --signal=SIGKILL imframe-display.service
    for ((attempt = 0; attempt < 15; attempt++)); do
      sleep 1
      if systemctl --user is-active --quiet imframe-display.service; then break; fi
    done
    systemctl --user is-active --quiet imframe-display.service
  else
    systemctl --user restart imframe-display.service
  fi
  echo 'Display sleep service installed and running.'
else
  echo 'Display sleep service installed. It will start at the next desktop login.'
fi
