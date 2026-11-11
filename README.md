<p align="center"><img src="public/hub-icon.png" width="100" alt="imframe icon" /></p>
<h1 align="center">imframe</h1>
<p align="center">Your Immich albums, on your photo frames.</p>

Connect a Raspberry Pi to a monitor and let your photos play. Use **Hub** on your phone to manage all your frames in one place. Add new photos in Immich; they appear on the frames automatically.

## What it does

| | Features |
| --- | --- |
| **Your Frames** | Add frames by address, see what is playing, and use Previous, Pause, and Next. Hub reads each frame’s existing name. |
| **Albums** | Pick several albums. Mix them together or play one at a time. Shuffle, play oldest first, or play newest first. |
| **Media** | Full-size photos, videos, and Live Photos. Live Photo motion fades into the still before the photo timer starts. |
| **Style** | Pan and zoom, adjustable transitions, blurred backgrounds, and optional location, date, and countdown displays. |
| **People & ages** | Choose names for each frame and show their age when the photo or video was taken. Pick a corner or turn the overlay off. |
| **Sleep hours** | Turn the screen off and stop playback and media downloads overnight. Photos preload before the scheduled wake time. |
| **Everyday use** | Start fullscreen when the Pi boots. Preload upcoming media. Change settings without restarting playback. |

Hub has a simple **Albums / Style / Sleep / Advanced** layout. Each frame also keeps its own settings page and works when Hub is offline. Previews are small snapshots from the running player, refreshed about every two seconds.

## Set it up

You need an Immich server and one Raspberry Pi with a monitor per frame. The Pi installer supports **Raspberry Pi OS 64-bit Desktop (Trixie)**. Run Hub once on a computer or server that can reach your frames.

### 1. Set up each frame

Clone this repository on your computer and copy `.env.example` to `.env`. Add your Immich URL and API key. The key needs `album.read`, `asset.read`, `asset.view`, and `asset.download` permissions.

```sh
bash deploy/pi/provision.sh \
  --host frame.local --user YOUR_PI_USERNAME \
  --env-file .env --browser hevc --reboot
```

Use your Pi’s hostname or IP address and username. Repeat for each frame. The script installs the app and starts Chromium fullscreen at boot. The `hevc` browser option supports original iPhone videos and Live Photos on Pi 5; see the [Pi setup guide](docs/setup.md#original-hevc-video-on-pi-5).

**HEIC or RAW photos?** Enable Immich’s full-size image generation first. [Image setup](docs/setup.md#heic-and-raw-photos).

### 2. Start Hub

On the computer or server hosting Hub, save [compose.hub.yaml](compose.hub.yaml) and run:

```sh
docker compose -f compose.hub.yaml up -d
```

Open `http://<hub-address>:3002`. Hub needs no Immich API key; each frame keeps its own connection. [More deployment options](docs/hub.md), including Kubernetes and existing Pi upgrades.

### 3. Add your frames

1. In Hub, choose **Add Frame** and enter the Pi’s address, such as `frame.local:3000`.
2. Confirm the name Hub finds, then choose **Add Frame**.
3. Tap **Customize** to choose albums and adjust how they look.

Changes save automatically. Keep managing your photos and albums in Immich. On iPhone, use Safari’s **Share → Add to Home Screen** to give Hub its own icon.

For ages, enable **Style → Show people & ages** and enter one Immich name per line. Use the full name; capitalization does not matter. Birthdays stay in Immich. For another account’s photos, share both the album and the People profiles with the account used by the frame. People without birthdays are hidden.

## Updates

Choose **When I ask** or **Automatically, once a day** in Hub settings. Automatic updates run one frame at a time. Frames outside Hub check for updates themselves every 15 minutes.

The container supports AMD64 and ARM64. Use `ghcr.io/carldanley/imframe:latest` for stable releases, `:0.5` for the `0.5.x` series, or `:0.5.0` to pin a version. Settings survive updates. [Update details](docs/setup.md#automatic-updates).

## Try it locally

With Node.js 24 or newer, open two terminals in this checkout:

```sh
npm ci
npm run demo
```

```sh
npm run dev:hub
```

Open the [demo player](http://localhost:5173/frame?kiosk=1), then [Hub](http://localhost:5174) and add `localhost:3000`. The demo uses generated sample media and separate frame settings.

## Guides

- [Frame setup](docs/setup.md) — Immich, picture quality, Docker, and Raspberry Pi setup.
- [Hub setup](docs/hub.md) — connecting frames, updates, and hosting.
- [Development](docs/development.md) — local testing, CI, and releases.

imframe is for a trusted home network and has no login page. Immich must be reachable to load new media; there is no persistent offline library.

Inspired by [ImmichFrame](https://github.com/immichFrame/ImmichFrame).
