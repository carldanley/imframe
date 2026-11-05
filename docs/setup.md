# Frame setup

[Back to the README](../README.md)

Start with the [quick setup](../README.md#set-it-up). The sections below cover image formats, the Pi's display, and updates.

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

## Preloading larger videos

Under **Picture quality**, **Preload ahead** selects 1–5 upcoming items. The default is 3, with a 512 MB **Download cache limit**. This gives a video time to download while earlier photos or videos are still playing.

The frame downloads one file at a time and holds completed files temporarily in the browser. Live Photos include both the photo and its motion clip. Only the current and next items are prepared for display, so looking farther ahead does not create a video decoder for every cached clip. Files retain their original quality; this does not create new Immich copies or transcode anything.

Files that exceed the available cache space stream normally. If a download is unfinished when its turn arrives, the player stops that download and switches to normal streaming rather than waiting for the entire file. More lookahead helps when the network is temporarily slow; it cannot guarantee uninterrupted playback on a consistently slow connection.

**Frame status** shows how many upcoming items are downloaded and how much cache space is in use. The limit covers file bytes; rendering and video decoding need additional memory. Cached files are discarded as they leave the upcoming selection or the player closes. There is no persistent offline library.

## Screen sleep hours

In Hub, open a frame and choose **Sleep**, or use **Sleep hours** on the frame’s own settings page. Set **Sleep at** and **Wake at**, then enable **Sleep on a schedule**. It is off by default. Hours repeat daily in the Pi’s local time zone, including daylight-saving changes. Overnight windows work automatically; sleep and wake times must differ.

The Pi uses `wlopm` to switch display power off. A monitor that supports standby can then sleep. Chromium stops during sleep, releasing its video decoders and memory. Automatic album refreshes and media downloads stop too. The Pi stays online for settings, updates, and SSH; it does not suspend or power off. Each Pi saves its schedule locally, so HDMI wakes on time even if Hub, Immich, or the app container is unavailable. Turning off the schedule wakes the screen within about 15 seconds.

Two minutes before wake-up, Chromium starts with the screen still off. It prepares the first item and fills the configured **Preload ahead** cache within its memory limit. Photos, videos, and countdowns stay paused until wake time. Large files that exceed the cache budget use normal streaming; a slow or unavailable library does not delay the screen’s scheduled wake.

Some monitors briefly disconnect and reconnect while checking for a signal. Setup disables labwc’s automatic output enabling, and the display service suspends `kanshi` during sleep so those reconnects cannot wake the screen. It saves the display mode and restores it with `wlr-randr` at wake time, including the refresh rate. Existing labwc settings are retained, with a backup at `~/.config/labwc/rc.xml.before-imframe-sleep` when a user configuration already exists.

Fresh Pi setups include the display service. Existing frames need both the app update and the host service update for overnight idle. Run this from a current checkout **on the Pi as the desktop user, without sudo**:

```sh
bash deploy/pi/upgrade-display.sh
```

The upgrade preserves sleep during an overnight service restart.

If either display tool is missing, install them with `sudo apt-get install wlopm wlr-randr` first. Re-running the normal Pi provisioner also installs the service; reboot afterward. No Docker socket or display access is added to the app container.

## Raspberry Pi fullscreen startup

Use a 64-bit OS. The suggested hardware is a Raspberry Pi 5 with 8 GB RAM, active cooling, the official 27 W power supply, and a micro-HDMI cable that supports your monitor's resolution. Power the monitor separately; the Pi's USB-C power port is not a display output.

The [Pi installer](../deploy/pi/install.sh) configures desktop auto-login, disables screen blanking, and starts Chromium in kiosk mode after the app is ready. A user service restarts Chromium if it exits.

### Set up a fresh Pi from your computer

1. Flash **Raspberry Pi OS 64-bit Desktop (Trixie)** with Raspberry Pi Imager. Set a hostname, desktop username, password, Wi-Fi if needed, and enable SSH.
2. Boot the Pi with its monitor connected and find its hostname or IP address.
3. On your computer, clone this repository and configure `.env` as described in the README.
4. From that checkout on macOS or Linux, run:

```sh
bash deploy/pi/provision.sh \
  --host frame.local --user YOUR_DESKTOP_USERNAME \
  --env-file .env --browser hevc --reboot
```

Replace the host and username with your Pi's details. SSH prompts for a password or uses your existing key; sudo may ask for the Pi password. Passwords are never arguments or saved by the script. Use `--identity /path/to/key` or `--port 2222` if needed.

`--browser hevc` installs the optional browser described below for original iPhone videos and Live Photos on Pi 5/CM5. Omit it for the OS browser on a new installation. `--reboot` schedules a reboot one minute after successful setup; omit it to reboot later.

The script installs Docker from its [official signed Debian repository](https://docs.docker.com/engine/install/debian/), pulls the app, configures desktop auto-login and kiosk startup, disables screen blanking, and enables container updates. It expects the desktop image's Chromium and labwc; the Lite image is not supported.

Only deployment files and your supplied `.env` are transferred. Credentials are stored in `/opt/imframe/.env`, readable by root, and removed from the temporary setup folders when the script finishes. No IP address, username, password, or API key needs to be added to the repository. If a connection is interrupted before cleanup, remove the leftover `/tmp/imframe-setup.*` directory on the Pi.

For a second frame, run the same command with its host and username. Configure its albums at `http://<pi-address>:3000`. Each Pi has independent settings. Re-running setup preserves credentials, the selected browser, and the settings volume; use `--replace-config` to replace the connection file or change `--image`. To use another published image, pass `--image ghcr.io/your-account/imframe:latest`.

If you prefer to run setup directly on the Pi, clone the repository as your desktop user, configure `.env`, and run:

```sh
sudo bash deploy/pi/install.sh YOUR_DESKTOP_USERNAME --env-file .env --browser hevc
sudo reboot
```

For a private container image, authenticate on the Pi with `sudo docker login ghcr.io` first; the root updater uses that login. The published imframe image is public.

### Original HEVC video on Pi 5

Pi 5 has an HEVC hardware decoder, but the stock Chromium build tested here did not decode our HEVC videos. The `hevc` option installs the community [chromium-rpi-hevc](https://github.com/sslivins/chromium-rpi-hevc) build in the desktop user's home directory. It enables hardware decoding of original HEVC videos and Live Photo motion without making new copies in Immich. Keep imframe's **Video source** set to **Original**.

- The [manifest](../deploy/pi/chromium-hevc.json) pins a release and verifies every downloaded package's SHA-256 checksum.
- The build must match the installed Chromium version, run on ARM64 Trixie, and have the `rpi-hevc-dec` kernel driver available. A version mismatch stops installation; it does not downgrade OS packages.
- System Chromium stays installed and unchanged. The frame uses its own browser copy and profile, with sandboxing enabled.
- This browser is not updated by the container timer or apt. To update it, review a compatible upstream release, update the manifest, and rerun setup with `--browser hevc`. Use `--browser system` to return to the OS browser, then restart the kiosk or reboot.

Original HEVC Live Photos and a 1080 × 1920, 60 fps, 10-bit HDR video have been tested on Pi 5 with this build. The hardware decoder was active and the display owner confirmed smooth playback. The browser still reported some dropped frames on the 60 fps clip. That does not establish 4K/60 performance or HDR output quality; test those on your intended monitor. Decoding HDR and displaying HDR are separate capabilities.

### Startup and display controls

The app runs from `/opt/imframe` with Compose project name `imframe`. Docker starts it at boot using the locally downloaded image. Chromium runs on the host as your desktop user, with its own browser profile. It opens `http://localhost:3000/frame?kiosk=1` fullscreen after the app responds.

The dedicated kiosk profile uses Chromium's basic password store so automatic login does not trigger a desktop keyring unlock prompt.

If a working monitor is reported as disconnected after reboot, and forcing HDMI detection restores it, the [Raspberry Pi HDMI troubleshooting guide](https://pip-assets.raspberrypi.com/categories/1259-audio-camera-and-display/documents/RP-004341-WP-2-Troubleshooting%20KMS%20HDMI%20output.pdf) describes a persistent kernel video override. Back up `/boot/firmware/cmdline.txt`, then append a supported mode to its existing single line. For example, `video=HDMI-A-1:1920x1080@60D` forces HDMI0 on at 1080p/60 Hz; use the connected port and a mode supported by your monitor. Reboot to apply it.

If media downloads stall only while HDMI is enabled, compare the monitor's supported refresh rates. A Pi 5 with a Philips 24E2N1100 was observed to stall Wi-Fi transfers at 1080p/60 and 75 Hz, while 1080p/100 Hz restored playback. For that monitor, use `video=HDMI-A-1:1920x1080@100D` and a matching profile in `~/.config/kanshi/config` so desktop login keeps the tested mode:

```text
profile imframe {
    output HDMI-A-1 enable mode 1920x1080@100Hz
}
```

Use a refresh rate advertised by the connected monitor and preserve any existing display profiles.

Existing desktop autostart entries are retained. The installer saves backups of the labwc autostart file and LightDM configuration with a `.before-imframe` suffix. Boot startup has been tested on a Pi 5 with 64-bit Trixie and labwc.

To stop or restart just the display, run these as the desktop user over SSH:

```sh
systemctl --user stop imframe-kiosk.service
systemctl --user start imframe-kiosk.service
```

The dedicated kiosk service is managed through SSH. In a normal browser window, the app's **Full screen** button uses webpage fullscreen, which you can leave with **Escape**.

Before leaving a frame running, check portrait and landscape photos, Live Photos, your video formats, Wi-Fi recovery, and a full reboot. The settings page's **Frame status** shows loaded dimensions, dropped video frames, and playback errors.

## Automatic updates

The Pi installer enables an agent that checks for Hub requests about once a minute, starting 30 seconds after boot. Standalone frames check GHCR every 15 minutes. Enrolled frames wait for Hub to request updates; choose manual or daily automatic updates in Hub. Choose which releases it follows with `IMFRAME_IMAGE` in `/opt/imframe/.env`:

| Image tag | Update behavior |
| --- | --- |
| `:latest` | Follow the newest stable release, including new major versions |
| `:0.4` | Follow patch releases in the `0.4.x` series |
| `:1` | Follow stable releases in major version 1 (available from 1.0 onward) |
| `:0.4.0` | Stay on that specific release until you change the tag |
| `:0.4.0-rc.1` | Test that specific prerelease |

These are examples; each tag becomes available after its release is published. For example, `IMFRAME_IMAGE=ghcr.io/carldanley/imframe:0.4` keeps a frame on `0.4.x` while still receiving patch updates. New installs default to `latest`. The same tags work with the provisioner's `--image` option.

- Downloads happen while the current frame keeps playing.
- An unchanged image leaves playback running.
- A new image replaces the container, keeping its settings volume.
- Once the new container is healthy, Chromium restarts to load the updated app.
- A failed download leaves the existing container alone. A failed startup health check restores the previous image.

Push a stable `vX.Y.Z` Git tag to publish a release; see [Version a release](development.md#version-a-release). Regular code pushes run CI without publishing. Manual branch builds publish SHA tags only and do not update frames following stable releases.

To check for an update now, inspect the schedule, or read the last update's log:

```sh
sudo /usr/local/libexec/imframe/update.sh
systemctl list-timers imframe-update.timer
sudo journalctl -u imframe-update.service -n 50 --no-pager
```

To turn automatic updates off while leaving the frame running:

```sh
sudo systemctl disable --now imframe-update.timer
```

## Manual updates and saved settings

For an installation started directly with the README's Compose commands, run these in the same folder used for setup:

```sh
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
```

Use `:latest` for the newest stable release. To keep a particular build, set `IMFRAME_IMAGE` in `.env` to its full version or `sha-…` tag before running the commands.

Settings live in the `frame-settings` Docker volume (`imframe_frame-settings` when using the Pi installer). Keep the same Compose project/directory name to reuse it. Keep `.env` locally; it is excluded from Git and the Docker build. When moving an existing installation to the Pi installer, preserve its settings before switching Compose projects.

Each Pi runs its own copy of imframe. Manage all of them through [Hub](hub.md), or open `http://<pi-address>:3000` to configure that frame. Saved settings notify an open player immediately, with a five-second polling fallback; album contents refresh every 60 seconds by default. Photo duration and motion changes take effect on the next item.

There is no offline media library. During a temporary outage, the current picture stays visible while the app retries. Immich must be reachable to load new media after a restart.

## Run a frame with Docker only

Copy `.env.example` to `.env` and configure your Immich URL, key, and image:

```dotenv
IMMICH_URL=http://immich.local:2283
IMMICH_API_KEY=your-api-key
IMFRAME_IMAGE=ghcr.io/carldanley/imframe:latest
```

```sh
docker compose -f compose.ghcr.yaml up -d
```

Open `http://<frame-address>:3000` to select albums, then open `/frame?kiosk=1` on the display. This runs the satellite app; the Pi installer additionally sets up Chromium and boot startup.
