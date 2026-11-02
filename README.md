# imframe

Turn your Immich albums into a photo frame.

Run imframe on a Raspberry Pi connected to a monitor, choose albums from your phone, and let it play. Keep adding photos in Immich—the frame picks up changes automatically. Each frame has its own albums and settings.

## Features

### Your albums, your order

- Select multiple albums and mix them together or play one album at a time.
- Play oldest first, newest first, or shuffle without repeats within a cycle.
- Reorder albums or shuffle their order independently.
- Media shared between selected albums plays once per cycle.
- New photos and videos appear automatically, with an adjustable refresh interval.

### Photos, videos, and Live Photos

- Display full-size photos, with support for 4K screens.
- Play videos silently through to the end.
- Play a Live Photo's motion, fade into its still, then start the photo timer. Motion can also be turned off.
- Download up to five upcoming items early, with a configurable cache limit.
- Keep filenames and controls off the picture in kiosk mode.
- With the Pi installer, start the frame at boot and check for container updates automatically.

### Make each frame your own

| Setting | Options |
| --- | --- |
| Photo duration | 3 seconds to 5 minutes |
| Image fit | Show the whole image with a blurred background, or fill the screen and crop the edges |
| Motion | Still, slow zoom in, slow zoom out, or random pan and zoom |
| Zoom amount | 1–20% |
| Transitions | Crossfade, slide, instant, or random, with adjustable timing |
| Location | Map pin and city, region, and country in any corner |
| Date taken | Calendar icon and date in `MM.DD.YY` format, in any corner |
| Countdown | A progress bar along any edge, or a circular countdown in any corner |
| Video source | Original file or Immich's playback version for compatibility |
| Preloading | 1–5 upcoming items; a temporary download cache from 128 MB to 1 GB |

Location, date, and countdown displays are optional. Photos and videos both get a blurred background when they don't fill the screen.

## Get started with Docker

Images are available for Linux AMD64 and ARM64, including 64-bit Raspberry Pi OS.

1. Save [compose.ghcr.yaml](compose.ghcr.yaml) and [.env.example](.env.example) in a new folder. Copy `.env.example` to `.env`.
2. In Immich, create an API key with `album.read`, `asset.read`, `asset.view`, and `asset.download` permissions.
3. Set these values in `.env`:

```dotenv
IMMICH_URL=http://immich.local:2283
IMMICH_API_KEY=your-api-key
IMFRAME_IMAGE=ghcr.io/carldanley/imframe:latest
```

Start the frame:

```sh
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
```

Open `http://<frame-address>:3000` on your phone to choose albums and save settings. Open `http://localhost:3000/frame?kiosk=1` in Chromium on the frame itself.

Settings stay on that frame and survive container updates. The API key stays in the backend. imframe is intended for a trusted home network; it has no login page and needs access to Immich to load media.

Use `latest` to follow stable releases, a minor tag such as `0.1` for patch updates, or a full version such as `0.1.0` to stay on one release. See [update options](docs/setup.md#automatic-updates) for details.

**Using HEIC or RAW photos?** Enable full-size image generation in Immich first. See the [setup guide](docs/setup.md#heic-and-raw-photos).

## Try it without your photos

With Node.js 24 or newer, run these commands from a checkout of this repository:

```sh
npm ci
npm run demo
```

Open [localhost:5173](http://localhost:5173). Demo mode uses generated sample images, a test video, and a sample Live Photo. It doesn't connect to your Immich library and keeps its settings separate.

## Guides

- [Frame setup](docs/setup.md): Immich image settings, picture quality, Raspberry Pi fullscreen startup, and updates.
- [Development](docs/development.md): run locally, check changes, and publish containers through GitHub Actions.

Inspired by [ImmichFrame](https://github.com/immichFrame/ImmichFrame).
