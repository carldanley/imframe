# Hub setup

[Back to the README](../README.md)

Hub is one place to manage your frames. In the code, each frame is called a **satellite**. Both use the same container image: satellite mode is the default; Hub uses `IMFRAME_MODE=hub`.

## Docker

```sh
docker compose -f compose.hub.yaml up -d
```

Open `http://<hub-address>:3002`. The `hub-settings` volume keeps your frame list, update preferences, and any settings waiting to reach an offline frame. Keep this volume when updating or moving Hub. It also holds Hub’s identity, which enrolled frames remember.

Hub connects to each frame over HTTP or HTTPS. The address you add must be reachable **from the Hub container**, not just your phone. Use LAN IP addresses or DNS names; multicast `.local` names may not resolve inside a container. Your phone only needs access to Hub. Preview images and album thumbnails pass through Hub, so an HTTPS Hub can manage HTTP frames without mixed-content errors.

Hub does not need the Immich key. It cannot change your Immich library. Each satellite keeps its own albums, display settings, and Immich connection.

## Kubernetes

Use [deploy/hub/kubernetes.yaml](../deploy/hub/kubernetes.yaml) as a starting point. It creates one Hub replica, a persistent volume claim, and a service. Adjust the namespace, storage class, image tag, and ingress for your cluster. The Hub pod needs network access to the frames on port 3000.

```sh
kubectl apply -f deploy/hub/kubernetes.yaml
kubectl port-forward service/imframe-hub 3002:3000
```

For a permanent phone bookmark, expose the service through your existing ingress with a stable hostname. Keep it on your trusted network. Run one Hub process per data volume; the JSON store is not a multi-replica database. The manifest uses a `Recreate` deployment strategy so two revisions do not write the volume together.

## Existing frames

Frames need imframe **0.2.0 or newer** for Hub. Updating the container adds the API and keeps the original direct settings page at `http://<frame-address>:3000`.

To let Hub control software updates, install the new host updater once. Re-running the Pi provisioner is the simplest option:

```sh
bash deploy/pi/provision.sh \
  --host frame.local --user YOUR_PI_USERNAME --env-file .env --browser keep
```

It keeps the existing credentials, browser selection, and frame settings. For a Pi that already has a current repository checkout, this smaller migration is also available:

```sh
sudo bash deploy/pi/upgrade-updater.sh
```

The updater stays on the Pi host. Neither Hub nor the satellite container mounts Docker’s socket or accepts shell commands. Hub can only request that the host pull the image already configured in `/opt/imframe/.env`.

## Using Hub

- **Add Frame:** enter its address. Hub reads the existing name. Renaming under Advanced changes the name on the frame itself.
- **Albums:** choose multiple albums, search the scrollable list, and set playback order.
- **Style:** change photo timing, motion, transitions, captions, and countdowns.
- **Advanced:** change quality preferences, preloading, the name, or request a software update.
- **Previous / Pause / Next:** control the active player. Acknowledgment comes from the player; commands are never queued for an offline frame. Previous uses this player session’s history.

Settings save automatically. If a frame is offline, Hub saves the changed fields and sends them when it reconnects, even if the Hub page is closed. This preserves unrelated changes made on the frame’s direct settings page. Photo duration, motion, fit, and source changes apply on the next item; captions and countdown preferences update live.

The preview is an approximate view of the actual player, refreshed every two seconds while Hub is visible. It follows the current media and pan/zoom, including video moments; it is not a video stream. Captions are simplified and countdowns are not captured. Previews are held in memory, requested only while viewed, and never stored in the Hub volume. Full-resolution playback on the frame is unchanged.

## Software updates

Hub defaults to **When I ask**. Use a frame’s Advanced tab to request a check. With **Automatically, once a day**, Hub requests each frame in turn and waits for its updater to finish before moving on. A software update briefly reloads the frame; ordinary settings changes do not.

The Pi agent checks requests about once a minute. Once a frame belongs to Hub, it stops checking GHCR independently. If Hub goes offline, the frame keeps playing its saved settings; software updates wait for Hub. Remove an online frame from Hub to return it to standalone updates.

An update follows the tag configured on that Pi. A pinned version stays pinned even if you request a check. Hub does not change the tag, update Raspberry Pi OS, or replace the HEVC browser. Hub’s own container is updated through your Docker or Kubernetes deployment.

Back up the Hub volume before replacing it. If it is lost, a frame can be detached from the old Hub with a request to its LAN API:

```sh
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"hubId":null}' http://frame.local:3000/api/management
```

Then add it to the replacement Hub.
