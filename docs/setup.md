# Frame setup

[Back to the README](../README.md)

Start with the [Docker setup](../README.md#get-started-with-docker). The sections below cover image formats, the Pi's display, and updates.

## Immich connection

Set `IMMICH_URL` to your server's base URL, without `/api`. Create an API key with `album.read`, `asset.read`, `asset.view`, and `asset.download` permissions and put it in your local `.env`.

The app supports Immich 3.2+ within major version 3 and has been tested against 3.3.5. It reads your library without changing albums or starting Immich processing jobs.

## HEIC and RAW photos

These formats need full-size browser-compatible copies on the Immich server. For Immich 3.3.5:

1. Open **Administration → Settings → Image Settings → Full-size Image Settings**.
2. Enable **Enable full-size image generation**, choose JPEG, and set quality to 100.
3. Save, then run **Administration → Jobs → Generate Thumbnails → All** for existing media. To refresh just one photo, use **More → Refresh thumbnails** on that photo.
4. Check **Frame status** in imframe's settings page for the loaded image dimensions or any errors.

In Immich 3.3.5, the **Missing** job can skip uppercase `.HEIC` and `.CR2` files because its [extension check is case-sensitive](https://github.com/immich-app/immich/blob/v3.3.5/server/src/repositories/asset-job.repository.ts#L88). Use **All** if the queue finishes but those photos still won't load. Reprocessing a large library can take time and server storage.

For RAW files, Immich's **Prefer embedded preview** option can use the camera's embedded JPEG. Turn it off if you want Immich to decode the full RAW instead, then regenerate the affected images.

## Picture quality

| Media | How imframe loads it |
| --- | --- |
| Browser-compatible photos | Full-size files, usually the original |
| HEIC and RAW | Immich's full-size browser-compatible copy |
| Videos: Original | The original video file |
| Videos: Immich playback | Immich's playback version, which may be a smaller transcode |

The **4K** display target checks available detail. Set the Pi's actual HDMI output separately to match your monitor. Photos are always requested at full size; imframe reports an error if Immich redirects a full-size photo request to a smaller preview.

Video compatibility, HDR, and color depend on the browser, OS, cable, and monitor. Check your own clips on the Pi, especially 4K HEVC, HDR, and 60 fps recordings. **Immich playback** can help with incompatible videos, but may reduce resolution. Immich photo edits are not currently applied.

## Raspberry Pi fullscreen startup

Use a 64-bit OS. The suggested hardware is a Raspberry Pi 5 with 8 GB RAM, active cooling, the official 27 W power supply, and a micro-HDMI cable that supports your monitor's resolution. Power the monitor separately; the Pi's USB-C power port is not a display output.

Run the app in Docker and Chromium on the Pi's desktop:

```sh
chromium --kiosk --no-first-run 'http://localhost:3000/frame?kiosk=1'
```

Kiosk mode opens the frame fullscreen with no controls. In a normal browser window, move the pointer to reveal **Full screen** and use **Escape** to leave webpage fullscreen. Chromium's kiosk process is managed through the desktop or SSH instead.

For Raspberry Pi OS using labwc, enable desktop auto-login and disable display blanking. Add this to the existing `~/.config/labwc/autostart` file:

```sh
(
  until curl --fail --silent --output /dev/null http://localhost:3000/; do sleep 2; done
  chromium --kiosk --no-first-run 'http://localhost:3000/frame?kiosk=1'
) &
```

Docker must start at boot. The Compose restart policy brings the app back, and Chromium waits for it before opening the frame. Startup setup depends on the installed desktop; see the [Raspberry Pi kiosk guide](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/). These steps still need verification on the finished Pi installation.

Before leaving a frame running, check portrait and landscape photos, Live Photos, your video formats, Wi-Fi recovery, and a full reboot. The settings page's **Frame status** shows loaded dimensions, dropped video frames, and playback errors.

## Updates and saved settings

Run these commands in the same folder used for setup:

```sh
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
```

Use `:latest` for the most recently published default-branch or stable release build. To keep a particular build, set `IMFRAME_IMAGE` in `.env` to its version or `sha-…` tag before running the commands.

Settings live in the `frame-settings` Docker volume. Keep the same Compose project/directory name to reuse it. Keep `.env` locally; it is excluded from Git and the Docker build.

Each Pi runs its own copy of imframe. Open `http://<pi-address>:3000` to configure that frame. Saved settings reach an open player within about five seconds; album contents refresh every 60 seconds by default. Photo duration and motion changes take effect on the next item.

There is no offline media library. During a temporary outage, the current picture stays visible while the app retries. Immich must be reachable to load new media after a restart.
