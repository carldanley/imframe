#!/usr/bin/env bash
set -euo pipefail

frame_dir=${IMFRAME_DIR:-/opt/imframe}
frame_project=${IMFRAME_PROJECT:-imframe}
frame_user=${IMFRAME_USER:-}
cd "$frame_dir"

# The timer and a manual invocation must never replace the container together.
exec 9>"$frame_dir/update.lock"
flock -n 9 || exit 0
compose=(docker compose --project-name "$frame_project" --env-file .env --file compose.yaml)
"${compose[@]}" config --quiet
image=$("${compose[@]}" config --images)
previous_container=$("${compose[@]}" ps --all --quiet imframe)
previous_image=
if [[ -n "$previous_container" ]]; then
  previous_image=$(docker inspect --format '{{.Image}}' "$previous_container")
fi

# A failed download leaves the current container running.
timeout 300 "${compose[@]}" pull imframe
desired_image=$(docker image inspect --format '{{.Id}}' "$image")
if [[ -n "$previous_image" && "$previous_image" != "$desired_image" ]]; then
  docker image tag "$previous_image" "$frame_project:rollback"
fi

restart_kiosk() {
  [[ -n "$frame_user" ]] || return 0
  local frame_uid
  frame_uid=$(id -u "$frame_user")
  [[ -S "/run/user/$frame_uid/bus" ]] || return 0
  runuser -u "$frame_user" -- env \
    XDG_RUNTIME_DIR="/run/user/$frame_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$frame_uid/bus" \
    systemctl --user try-restart imframe-kiosk.service
}

if ! "${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 120 imframe; then
  if [[ -n "$previous_image" && "$previous_image" != "$desired_image" ]]; then
    echo 'Updated container failed its health check; restoring the previous image.' >&2
    IMFRAME_IMAGE="$frame_project:rollback" "${compose[@]}" up \
      --detach --no-build --pull never --wait --wait-timeout 120 imframe
    restart_kiosk
  fi
  exit 1
fi

current_container=$("${compose[@]}" ps --quiet imframe)
if [[ "$current_container" != "$previous_container" ]]; then
  restart_kiosk
  echo 'Frame container is healthy; kiosk reloaded if a desktop session is active.'
else
  echo 'Frame is already running the current image; playback left running.'
fi
