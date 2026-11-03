#!/usr/bin/env bash
# Run on your computer. SSH handles authentication; no passwords are recorded.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash deploy/pi/provision.sh --host HOST --user USER [options]

  --env-file FILE       Immich configuration to copy (default: .env)
  --image IMAGE         Container image (default: ghcr.io/carldanley/imframe:latest)
  --browser MODE        keep (default), system, or hevc
  --port PORT           SSH port (default: 22)
  --identity FILE       SSH private key; otherwise use normal SSH authentication
  --replace-config     Replace an existing Pi .env (settings are retained)
  --reboot             Reboot after successful installation
  --help               Show this help

Requires Raspberry Pi OS 64-bit Desktop (Trixie), SSH, and a desktop user
with sudo access. The hevc browser option requires a Pi 5/CM5 and a matching
OS Chromium version. See docs/setup.md. Existing credentials are preserved
unless --replace-config is supplied. Use --browser keep to retain the browser.
USAGE
}

fail() { echo "$*" >&2; exit 1; }
frame_host='' frame_user='' identity=''
env_file=.env
image=ghcr.io/carldanley/imframe:latest
browser=keep
port=22
replace=false
reboot=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --host|--user|--env-file|--image|--browser|--port|--identity)
      [[ $# -ge 2 && -n $2 ]] || fail "Missing value for $1"
      case $1 in
        --host) frame_host=$2 ;; --user) frame_user=$2 ;; --env-file) env_file=$2 ;;
        --image) image=$2 ;; --browser) browser=$2 ;; --port) port=$2 ;; --identity) identity=$2 ;;
      esac
      shift 2 ;;
    --replace-config) replace=true; shift ;;
    --reboot) reboot=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[[ $frame_host =~ ^[[:alnum:]][[:alnum:].:%_-]*$ ]] || fail 'Supply a hostname or IP with --host.'
[[ $frame_user =~ ^[a-z_][a-z0-9_-]*$ && $frame_user != root ]] || fail 'Supply a normal desktop username with --user.'
if [[ ! $port =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then fail 'Invalid SSH port.'; fi
[[ $image =~ ^[a-z0-9][a-z0-9._/:@-]*$ ]] || fail 'Use a lowercase container image reference.'
[[ $browser == system || $browser == hevc || $browser == keep ]] || fail 'Browser must be system, hevc, or keep.'
[[ -s $env_file ]] || fail 'The env file is missing or empty. Copy .env.example and fill in your Immich connection.'
[[ -z $identity || -f $identity ]] || fail 'SSH identity file not found.'
for program in ssh tar mktemp; do command -v "$program" >/dev/null || fail "Missing command: $program"; done

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$source_dir/../.." && pwd)
# Keep the control socket path short enough for macOS's Unix socket limit.
umask 077
temporary=$(mktemp -d /tmp/imframe-provision.XXXXXX)
remote_dir=
target="$frame_user@$frame_host"
ssh_options=(-p "$port" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o "ControlPath=$temporary/ssh" -o ControlMaster=auto -o ControlPersist=600)
if [[ -n $identity ]]; then ssh_options+=(-i "$identity"); fi
cleanup() {
  if [[ -n $remote_dir ]]; then
    ssh "${ssh_options[@]}" -o BatchMode=yes "$target" "rm -rf -- '$remote_dir'" >/dev/null 2>&1 || true
  fi
  ssh "${ssh_options[@]}" -O exit "$target" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo 'Connecting to the Pi. SSH may ask for its fingerprint or your password.'
ssh "${ssh_options[@]}" -MNf "$target"
candidate=$(ssh "${ssh_options[@]}" "$target" 'umask 077; mktemp -d /tmp/imframe-setup.XXXXXX')
[[ $candidate =~ ^/tmp/imframe-setup\.[a-zA-Z0-9]+$ ]] || fail 'Could not create a private setup directory on the Pi.'
remote_dir=$candidate
mkdir -p "$temporary/payload/deploy/pi"
cp "$repo_dir/compose.ghcr.yaml" "$temporary/payload/"
cp "$source_dir"/*.sh "$source_dir"/*.service "$source_dir"/*.timer \
  "$source_dir/install-browser.py" "$source_dir/agent.py" "$source_dir/display.py" "$source_dir/chromium-hevc.json" "$temporary/payload/deploy/pi/"
cp "$env_file" "$temporary/payload/connection.env"
chmod 0600 "$temporary/payload/connection.env"
# remote_dir was restricted to the mktemp path pattern above.
# shellcheck disable=SC2029
COPYFILE_DISABLE=1 tar -C "$temporary/payload" -cf - . | \
  ssh "${ssh_options[@]}" "$target" "tar -xf - -C '$remote_dir'"

install_command="sudo bash '$remote_dir/deploy/pi/install.sh' '$frame_user' --env-file '$remote_dir/connection.env' --image '$image' --browser '$browser'"
if $replace; then install_command+=' --replace-config'; fi
echo 'Configuring the Pi. sudo may ask for your Pi password.'
ssh "${ssh_options[@]}" -tt "$target" "$install_command"
echo "Frame settings: http://$frame_host:3000"
if $reboot; then
  # Remove the transferred credentials before disconnecting for the reboot.
  # shellcheck disable=SC2029
  ssh "${ssh_options[@]}" "$target" "rm -rf -- '$remote_dir'"
  remote_dir=
  ssh "${ssh_options[@]}" -tt "$target" 'sudo shutdown -r +1'
  echo 'Reboot scheduled in one minute.'
else
  echo 'Reboot the Pi when ready to start the fullscreen display.'
fi
