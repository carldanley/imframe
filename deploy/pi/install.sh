#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: sudo bash deploy/pi/install.sh DESKTOP_USERNAME --env-file FILE [--image IMAGE] [--browser system|hevc|keep] [--replace-config]'
}
fail() { echo "$*" >&2; exit 1; }
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
[[ $EUID == 0 && $# -ge 1 ]] || { usage >&2; exit 1; }
frame_user=$1; shift
env_file=
image=ghcr.io/carldanley/imframe:latest
browser=keep
replace=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-file|--image|--browser)
      [[ $# -ge 2 && -n $2 ]] || fail "Missing value for $1"
      case $1 in --env-file) env_file=$2 ;; --image) image=$2 ;; --browser) browser=$2 ;; esac
      shift 2 ;;
    --replace-config) replace=true; shift ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[[ $frame_user =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Invalid desktop username.'
[[ $image =~ ^[a-z0-9][a-z0-9._/:@-]*$ ]] || fail 'Use a lowercase container image reference.'
[[ $browser == system || $browser == hevc || $browser == keep ]] || fail 'Browser must be system, hevc, or keep.'
frame_uid=$(id -u "$frame_user")
frame_group=$(id -gn "$frame_user")
frame_home=$(getent passwd "$frame_user" | cut -d: -f6)
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$source_dir/../.." && pwd)

if [[ $frame_uid == 0 || ! -d "$frame_home" || ! -x /usr/bin/chromium || ! -x /usr/bin/labwc ]]; then
  fail 'Use a normal desktop user on Raspberry Pi OS Desktop with Chromium and labwc installed.'
fi
# shellcheck source=/dev/null
source /etc/os-release
[[ ${VERSION_CODENAME:-} == trixie && $(dpkg --print-architecture) == arm64 ]] || fail 'This installer supports 64-bit Raspberry Pi OS Trixie.'
command -v raspi-config >/dev/null || fail 'Raspberry Pi OS and raspi-config are required.'
if [[ ! -s /opt/imframe/.env ]] || $replace; then
  [[ -n $env_file && -s $env_file ]] || fail 'Supply --env-file with your configured .env.'
  for key in IMMICH_URL IMMICH_API_KEY; do
    grep -Eq "^$key=.+" "$env_file" || fail "The env file must define $key."
  done
fi

# Use Docker's signed apt repository; leave an existing working engine alone.
if ! command -v docker >/dev/null; then
  if dpkg-query -W -f='${Status}' docker.io 2>/dev/null | grep -q 'install ok installed'; then
    fail "An existing Debian Docker installation needs its Compose plugin. Follow Docker's migration instructions first."
  fi
  apt-get update
  apt-get install -y ca-certificates curl
  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error --location https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<'SOURCES'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: trixie
Components: stable
Architectures: arm64
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker compose version >/dev/null || fail 'Docker Compose v2 or newer is required. Install the Compose plugin for your Docker distribution.'
command -v curl >/dev/null || apt-get install -y curl

install -d -m 0755 /opt/imframe
# Serialize configuration changes with a timer that may already be running.
exec 8>/opt/imframe/update.lock
flock 8
if [[ ! -s /opt/imframe/.env ]] || $replace; then
  # Never source an env file or pass its values as command arguments.
  # The selected image is explicit; other per-frame settings live in the volume.
  umask 077
  staged_dir=$(mktemp -d /opt/imframe/.setup.XXXXXX)
  trap 'rm -rf -- "$staged_dir"' EXIT
  sed '/^IMFRAME_IMAGE=/d' "$env_file" > "$staged_dir/.env"
  printf '\nIMFRAME_IMAGE=%s\n' "$image" >> "$staged_dir/.env"
  cp "$repo_dir/compose.ghcr.yaml" "$staged_dir/compose.yaml"
  docker compose --project-name imframe --env-file "$staged_dir/.env" --file "$staged_dir/compose.yaml" config --quiet
  mv -f "$staged_dir/.env" /opt/imframe/.env
  rm -rf -- "$staged_dir"
  trap - EXIT
else
  echo 'Keeping existing /opt/imframe/.env (use --replace-config to change it).'
fi

install -d -m 0755 -o "$frame_user" -g "$frame_group" \
  "$frame_home/.local/libexec/imframe" "$frame_home/.config/systemd/user" "$frame_home/.config/imframe"
install -m 0755 -o "$frame_user" -g "$frame_group" "$source_dir/kiosk.sh" "$source_dir/session.sh" "$frame_home/.local/libexec/imframe/"
install -m 0644 -o "$frame_user" -g "$frame_group" "$source_dir/imframe-kiosk.service" "$frame_home/.config/systemd/user/"
if [[ $browser == hevc ]]; then
  # Keep the installer accessible even when this checkout is inside /root.
  install -m 0644 -o "$frame_user" -g "$frame_group" "$source_dir/install-browser.py" "$source_dir/chromium-hevc.json" "$frame_home/.local/libexec/imframe/"
  runuser -u "$frame_user" -- python3 "$frame_home/.local/libexec/imframe/install-browser.py"
elif [[ $browser == system ]]; then
  rm -f "$frame_home/.config/imframe/browser.env"
fi

install -d -m 0755 /usr/local/libexec/imframe
install -m 0755 "$source_dir/update.sh" /usr/local/libexec/imframe/
install -m 0755 "$source_dir/agent.py" /usr/local/libexec/imframe/
install -m 0644 "$source_dir/imframe-update.service" "$source_dir/imframe-update.timer" /etc/systemd/system/
install -m 0644 "$repo_dir/compose.ghcr.yaml" /opt/imframe/compose.yaml
chmod 0600 /opt/imframe/.env
printf 'IMFRAME_USER=%s\n' "$frame_user" > /etc/default/imframe
chmod 0644 /etc/default/imframe

install -d -m 0755 -o "$frame_user" -g "$frame_group" "$frame_home/.config/labwc"
autostart="$frame_home/.config/labwc/autostart"
if [[ ! -f "$autostart" ]]; then
  # labwc's per-user file replaces the global file: preserve the desktop startup.
  install -m 0644 /etc/xdg/labwc/autostart "$autostart"
fi
if [[ ! -f "$autostart.before-imframe" ]]; then
  cp -p "$autostart" "$autostart.before-imframe"
fi
# Migrate the earlier root-owned launcher without adding a second startup entry.
sed -i '\|^/usr/local/libexec/imframe/session.sh &$|d' "$autostart"
# Expand HOME at desktop login, not while running the installer as root.
# shellcheck disable=SC2016
if ! grep -Fq '"$HOME/.local/libexec/imframe/session.sh" &' "$autostart"; then
  # shellcheck disable=SC2016
  printf '\n# Start the photo frame after the desktop is ready.\n"$HOME/.local/libexec/imframe/session.sh" &\n' >> "$autostart"
fi
chown "$frame_user:$frame_group" "$autostart" "$autostart.before-imframe"

# raspi-config uses SUDO_USER to select the desktop configuration to change.
if [[ ! -f /etc/lightdm/lightdm.conf.before-imframe ]]; then
  cp -p /etc/lightdm/lightdm.conf /etc/lightdm/lightdm.conf.before-imframe
fi
SUDO_USER="$frame_user" raspi-config nonint do_boot_behaviour B4
SUDO_USER="$frame_user" raspi-config nonint do_blanking 1
systemctl enable --now docker
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/imframe-update.service /etc/systemd/system/imframe-update.timer
flock -u 8
systemctl start imframe-update.service
systemctl enable --now imframe-update.timer

if [[ -S "/run/user/$frame_uid/bus" ]]; then
  runuser -u "$frame_user" -- env \
    XDG_RUNTIME_DIR="/run/user/$frame_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$frame_uid/bus" \
    systemctl --user daemon-reload
fi
echo 'Installed. The frame will open at the next desktop login or reboot.'
