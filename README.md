# imframe

A local photo frame for Immich. Run one copy per Raspberry Pi, open `/frame` in its browser, and open `/` from a phone to choose albums and playback settings. Your family keeps managing photos in Immich.

## Run on your computer

Requires Node.js 24 or newer.

```sh
npm ci
cp .env.example .env
# Add your Immich URL and API key to .env.
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome. Select albums, save, then open the frame. Vite also prints the computer's LAN addresses for testing from a phone on the same network. Saving settings updates an already open player within about five seconds; album membership refreshes every 60 seconds by default.

Keep an existing `.env` when it already contains your settings. After changing `.env`, restart the development command.

Create an Immich API key with `album.read`, `asset.read`, `asset.view`, and `asset.download`. The key stays in the backend. `.env` and `data/` are ignored by Git and excluded from the Docker build context.

To test without an Immich server, stop the normal development server and run `npm run demo`. This uses generated photos, a short test-pattern video, a synthetic Live Photo, and two overlapping albums. It stores its settings separately in `data/demo/`. The small MP4 fixture was generated with FFmpeg; it is not a family video.

## Playback

- Select multiple albums. Mix all their media, or finish one album before moving to the next.
- Set chronological or shuffled media order, and independently shuffle the album order. Reorder selected albums under **Selected album order**.
- A cycle includes each asset ID once, even if it appears in several selected albums. Live Photo motion components are not duplicated as separate slides. Different Immich asset IDs containing identical files are treated as different assets.
- Photos support a fixed duration, fit or crop, slow zoom in/out, and randomized pan/zoom. Transitions include crossfade, slide, cut, and random selection.
- Fit mode fills unused space with a blurred, dimmed cover copy of the same photo. The full-quality foreground stays sharp; Live Photos keep this backdrop during their motion clip and still.
- Videos in fit mode use a still captured from their first decoded frame for the same blurred background. This needs no extra download or second video player and leaves playback quality unchanged.
- Motion starts from a transform prepared before the image becomes visible, so zoom-out and random motion do not jump after a transition.
- Videos play muted to their end. Live Photos play their paired motion clip, then show the still for the full configured photo duration, even when the clip is longer than that duration. If only the motion clip is incompatible, its still remains usable and the issue is reported.
- A Live Photo shares the same initial pan/zoom framing between its clip and sharp still. When the clip ends, its last frame dissolves into the full-resolution still over 650 ms. The photo timer and zoom animation start after the dissolve finishes, giving the fully visible still its entire display interval. The blurred backdrop stays still underneath.
- Live Photo clips honor their QuickTime clean aperture, hiding encoded camera padding that can otherwise appear as smeared edges in Chrome. Small metadata ranges are read during preload; the video is not transcoded. Rotation is accounted for, and browser renditions that already apply the crop are left alone. Missing or unsupported crop metadata leaves playback available with its existing framing.
- The next photo is downloaded and decoded before display. The next video is prepared until the browser has a first frame and at least one second buffered, or its entire duration if shorter. `preload="auto"` alone is not considered ready.
- The current slide stays visible until the next one is ready. Failed media is skipped with bounded retries. Video startup and stalled playback have timeouts.
- A centered loading spinner appears on startup, while waiting for the next playable item, and during video buffering. Background preloading does not interrupt an item that is still playing.
- Adding/removing album media is picked up by polling. A temporary Immich outage retains the last successful playlist and the current display. Removing all selected albums clears the frame.
- The frame is a display-only view: filenames, settings links, next buttons, and playback details stay off the picture. Playback status remains available on the separate settings page.
- **Show location** adds a map pin and the city/region/country already recorded by Immich, for photos, Live Photos, and videos. Choose any of the four corners. It starts off, hides automatically when place names are unavailable, and updates on an open frame when settings are saved. No external map or geocoding service is contacted.
- **Show date taken** adds an independent corner overlay in fixed **MM.DD.YY** format with tabular, lining digits. It starts off and uses Immich's local capture date without shifting it to the frame's time zone, falling back to the recorded asset date when needed. Missing or invalid dates stay hidden. Date and location stack when assigned to the same corner, and the location pin is centered vertically beside its text.
- **Media countdown** offers **Off**, **Edge bar**, or **Circular countdown**. Bars use the top, bottom, left, or right edge: horizontal bars fill left to right; vertical bars fill top to bottom. Circles use the bottom right, bottom left, top left, or top right corner, with a transparent center, the next media type above, and remaining seconds below. Each style remembers its own position. Videos use actual playback time, including buffering pauses. For Live Photos, the countdown stays hidden during motion and the dissolve, then starts at the full photo duration. Unknown video durations show “Playing” instead of a guessed countdown. The countdown hides while the frame waits for the next item to load.

Countdown appearance, date, and location overlays update on the running frame. Photo duration and motion settings apply to newly displayed media; an ongoing photo keeps its current timing and motion.

In a regular browser, move the pointer to reveal **Full screen**. It only enters fullscreen; **Escape** exits using the browser's normal behavior. While fullscreen, moving or clicking does not reveal controls. Browser/OS shortcuts can still leave fullscreen. The right-arrow key advances media when testing with a keyboard. Detailed status is on `/`, accessible from your phone.

Only current/next media elements are kept by the player. Photo object URLs and old video elements are released. The server streams videos with byte-range support and does not keep a media library or disk cache. Browser-managed video buffers are not an exact application-enforced byte limit. There is no offline library: after a restart, Immich must be reachable.

## Quality and Immich setup

The **4K** setting is a detail target, not an Immich resize request and not a command to change the monitor's output. The Pi/OS must actually output 3840 × 2160 at 60 Hz. Photos are requested at full source size, which also preserves extra detail for zooming. A lower-resolution source cannot gain real detail from a 4K screen.

Browser-compatible photos such as JPEG normally resolve to their original file. HEIC and RAW need Immich's full-size browser-compatible rendition. If Immich redirects a full-size request to a smaller preview, this app refuses that downgrade and reports the photo as unavailable.

For those formats in Immich 3.3.5:

1. Open **Administration → Settings → Image Settings → Full-size Image Settings**.
2. Enable **Enable full-size image generation**. JPEG at quality 100 is a practical maximum-quality browser rendition; it is still a conversion from the source.
3. Save, then run **Administration → Jobs → Generate Thumbnails → All** for existing media, or open an individual photo and choose **More → Refresh thumbnails**. In Immich 3.3.5, the **Missing** job's [full-size selection uses a case-sensitive extension match](https://github.com/immich-app/immich/blob/v3.3.5/server/src/repositories/asset-job.repository.ts#L88), so existing uppercase `.HEIC`/`.CR2` files can be skipped even when the queue finishes. **All** bypasses that filter. New uploads are processed by Immich automatically.
4. Check **Frame status** for the actual decoded dimensions. With RAW images, Immich's **Prefer embedded preview** setting can use the camera's embedded JPEG rather than decoding the full RAW. Its size and rendering depend on the camera. Reprocessing existing renditions after changing image settings may require the full job, which can take substantial server time and storage.

These generated images live on the Immich server, not on the Pi. The app never changes Immich settings, starts Immich processing jobs, or writes to albums.

If media cannot load, the settings page shows the number of skipped items and an actionable error. The player retries them on later passes and clears each warning after that item loads successfully. Removing an item from the selected albums also removes its warning.

Videos default to the **original** endpoint. **Immich playback** is an explicit compatibility option and may return a smaller transcode, depending on Immich's settings. Neither endpoint accepts a per-frame “give me 4K” size parameter. Frame status reports decoded dimensions, browser output dimensions, preloading state, warnings, and dropped video frames. Color accuracy and HDR output also depend on the browser, OS, cable, and panel; they are not guaranteed by source resolution.

Immich photo edits are not currently requested: this foundation displays original compositions/full-size source renditions. Asset replacements and album membership refresh automatically.

## Production and Docker

```sh
npm run build
npm start
```

The production server hosts settings and playback at port 3000. Or run:

```sh
docker compose up -d --build
```

The Docker image targets Linux AMD64 and ARM64 (use a 64-bit Raspberry Pi OS). Builds run the tests and compile on the builder's architecture, then package portable JavaScript with the target architecture's Node runtime. The app runs as an unprivileged user, with a health check and a separate settings volume. `.dockerignore` allows only the required source/configuration files and generated test fixture into the build. Immich credentials are supplied at runtime through `.env`.

`compose.yaml` builds locally, gives each installation its own settings volume, and restarts the app after reboot. Run Chromium on the Pi host, with the app in Docker:

```sh
chromium --kiosk --no-first-run 'http://localhost:3000/frame?kiosk=1'
```

`?kiosk=1` omits all frame controls, even when the browser does not report fullscreen. Chromium's kiosk mode supplies fullscreen at launch without a webpage click. This is separate from the browser's **Full screen** button: Escape exits normal webpage fullscreen, while the dedicated kiosk process is managed through the Pi's desktop/SSH session.

For Raspberry Pi OS using labwc, enable desktop auto-login and disable display blanking in the Pi's settings. Following the [official Raspberry Pi kiosk guide](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/), add this to the existing `~/.config/labwc/autostart` file on the Pi:

```sh
(
  until curl --fail --silent --output /dev/null http://localhost:3000/; do sleep 2; done
  chromium --kiosk --no-first-run 'http://localhost:3000/frame?kiosk=1'
) &
```

The app/container starts at boot, the desktop starts, and Chromium waits for the local app before opening the frame. Keep Chromium running on the host so it can use the display and GPU. Exact startup integration still needs verification on the installed Pi OS version; this repository does not change your desktop or install a kiosk service automatically.

Use `http://<pi-address>:3000` on your phone. Each Pi has its own albums and settings. There is no central multi-frame fleet UI or app login; this is intended for your trusted home network.

## GitHub Container Registry

The `Container` GitHub Actions workflow runs on pull requests and pushes to `main`. It lints TypeScript/JavaScript and workflow definitions, scans Git history for secrets, audits npm dependencies, runs tests, type-checks the app, and builds production assets. Dockerfile checks and container smoke tests then run on native AMD64 and ARM64 runners. A failed check blocks publishing.

Publishing runs only when you push a version tag such as `v0.1.0`, or choose **Actions → Container → Run workflow**. After publishing, fresh AMD64 and ARM64 jobs pull the image from GHCR by its immutable digest and test startup, health, unprivileged execution, and settings persistence across a restart. CI uses synthetic media and needs no connection to an Immich server.

Images are published as `ghcr.io/<owner>/<repository>` for `linux/amd64` and `linux/arm64`. For this repository, the image is `ghcr.io/carldanley/imframe`. GitHub's built-in `GITHUB_TOKEN` supplies registry credentials; no Immich credentials belong in GitHub Actions or build arguments. Actions are pinned to commit IDs, and the workflow/secret scanner images are pinned to digests. The image links back to its source repository.

- A version tag such as `v0.1.0` publishes `:0.1.0`, `:0.1`, and a commit-based `:sha-…` tag. Stable version tags also update `:latest`.
- A manual run on the default branch publishes `:latest` and a commit tag. Manual runs on other branches publish a commit tag.
- New GHCR packages default to private. Package visibility is separate from repository visibility. For a private image, sign in to GHCR on each Pi with a classic personal access token limited to `read:packages`, using `docker login ghcr.io --username YOUR_ACCOUNT --password-stdin`. Publishing from Actions uses the built-in token instead. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

After publishing, copy `compose.ghcr.yaml` and `.env.example` to each Pi. Create its local `.env` with the Immich URL/key and an image reference, for example `IMFRAME_IMAGE=ghcr.io/carldanley/imframe:latest`. Use a version or `sha-…` tag to pin a specific release. Then run:

```sh
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
```

To update a frame, change the image version in `.env` and run those commands again. Its named settings volume is retained. Keep the same Compose project/directory name when switching between local builds and GHCR images so Compose uses the same volume.

Before the first commit, review `git status --short --untracked-files=all` and `git diff --cached`. `.env`, personal media/screenshots under `data/`, dependencies, and generated builds must stay excluded. Only `.env.example` belongs in Git; it contains a placeholder URL and no API key.

## Hardware acceptance test

Prototype with a Raspberry Pi 5 (8 GB), active cooling, an official 27 W supply, and a micro-HDMI cable to a 4K60-capable monitor. Power the monitor separately. The Pi's USB-C power connector is not a display output.

A 4K60 HDMI output and hardware HEVC decoder do **not** prove that a particular Chromium build will decode every original iPhone video at 4K. Validate one frame before buying several:

- Full-resolution landscape/portrait photos, HEIC-derived photos, RAW-derived photos, and Live Photos.
- Real 4K H.264 and HEVC clips, including 60 fps and HDR examples if present.
- Zero unexpected downscaling; acceptable dropped frames, temperatures, and transition timing.
- A long playback run, Wi-Fi interruption/recovery, album changes from Immich, and reboot recovery.
- Correct colors and orientation on the chosen panel.

The development computer's Chrome results are separate from Pi hardware validation. A different Pi browser build or a server-generated compatible video rendition may be necessary. The image/video settings remain explicit so this cannot silently reduce quality.

## Implementation and checks

- Vite and TypeScript for the settings UI and browser player; native Node HTTP for the backend.
- `server/immich.ts`: Immich 3.2+ within major version 3, verified against the 3.3.5 API. Uses cursor pagination rather than the obsolete embedded album asset list.
- `shared/playlist.ts`: deduplication, ordering, shuffle cycles, and live library updates.
- `src/player.ts`: preparation, transitions, motion playback, location overlays, error recovery, and status reporting.
- `data/settings.json`: validated, atomically saved configuration for this installation. No database required.

```sh
npm run lint
npm test
npm run build
npm audit --audit-level=low

# Check a locally built container without contacting Immich:
docker build --check .
docker build -t imframe:check .
npm run test:container -- imframe:check
```

Oxlint checks correctness and suspicious patterns in TypeScript and JavaScript, with warnings treated as failures. TypeScript's strict compiler checks run as part of `npm run build`. Tests cover pagination, v3 duration units, shuffle/deduplication, library changes, persistence, full-size downgrade rejection, redirect credential handling, byte-range streaming, capture dates, Live Photo timing, and video aperture parsing. Browser testing is also needed for media codecs and transitions; CI's ARM64 checks do not replace testing the Pi's Chromium/GPU and monitor.

## References

- [Immich 3.3.5 API schema](https://github.com/immich-app/immich/blob/v3.3.5/open-api/immich-openapi-specs.json)
- [Immich media endpoint behavior](https://github.com/immich-app/immich/blob/v3.3.5/server/src/services/asset-media.service.ts)
- [Immich full-size generation](https://github.com/immich-app/immich/blob/v3.3.5/server/src/services/media.service.ts)
- [Immich image settings UI](https://github.com/immich-app/immich/blob/v3.3.5/web/src/routes/admin/system-settings/ImageSettings.svelte)
- [Raspberry Pi 5 specifications](https://www.raspberrypi.com/products/raspberry-pi-5/)
- [Chromium muted autoplay policy](https://developer.chrome.com/blog/autoplay)

ImmichFrame was a reference for the use case. This is a separate implementation; no ImmichFrame source code was copied.
