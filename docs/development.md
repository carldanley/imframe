# Development

[Back to the README](../README.md)

The app uses TypeScript and Vite for the browser UI, with a native Node HTTP backend. Node.js 24 or newer is required.

## Run locally

```sh
npm ci
cp .env.example .env
# Add your Immich URL and API key to .env.
npm run dev
```

Keep your existing `.env` if you've already configured it. Restart the development server after changing that file.

Open [localhost:5173](http://localhost:5173) in Chrome. `/` is the settings page; `/frame` is the player. Vite also prints LAN addresses for testing from a phone.

To use generated sample media instead, stop the normal development server and run `npm run demo`. Demo settings are stored separately in `data/demo/`.

## Check changes

```sh
npm run lint
npm test
npm run test:pi
npm run test:release
npm run release:check
npm run build
npm audit --audit-level=low
```

The build includes strict TypeScript checks. Tests cover album ordering, library updates, settings, date formatting, Live Photo timing, video cropping, the Immich proxy, and bounded preloading with cancellation and streaming fallback. Pi tests check credential transfer and cleanup, SSH argument validation, failed installations, unchanged images, failed downloads, and container rollback. Check codecs, motion, and transitions on the intended display too.

To run the production build locally:

```sh
npm run build
npm start
```

The app serves both pages at [localhost:3000](http://localhost:3000).

## Build a container

```sh
docker build --check .
docker build -t imframe:check .
npm run test:container -- imframe:check
```

The smoke test checks startup, both pages, the health check, non-root execution, and saved settings after a restart. It creates and removes its own container and volume without connecting to Immich.

To run your local build with `.env` and persistent settings:

```sh
docker compose up -d --build
```

## CI and publishing

The [Container workflow](../.github/workflows/container.yaml) runs on pull requests and pushes to `main`.

| Check | Coverage |
| --- | --- |
| Lint | TypeScript, JavaScript, GitHub Actions, Dockerfile checks, Pi shell scripts, and Python installer syntax |
| Tests and build | Unit/integration tests, Pi setup and recovery, release versioning, strict types, and production assets |
| Security checks | Git history credential scan and npm dependency audit |
| Container tests | Native AMD64 and ARM64 builds, startup, health, and settings persistence |
| Published image tests | Pull from GHCR and repeat the smoke test on both architectures |

Push a version tag such as `v0.1.0` to publish a release. The tag must match the version in both `package.json` and `package-lock.json`; CI checks this before building. Publishing waits for all checks and native AMD64/ARM64 container tests to pass.

| Trigger | Image tags (examples) |
| --- | --- |
| `v0.1.0` | `0.1.0`, `0.1`, `latest`, `sha-…` |
| `v1.2.3` | `1.2.3`, `1.2`, `1`, `latest`, `sha-…` |
| `v1.3.0-rc.1` | `1.3.0-rc.1`, `sha-…` |
| Manual run on any branch | `sha-…` only |

The rolling tags (`latest`, major, and minor) advance only when the release is the newest stable Git tag in that series. A backport can update its own minor series without replacing a newer major/minor release. There is no `0` tag because compatibility is still evolving before 1.0. Prereleases never change rolling tags.

Use **Actions → Container → Run workflow** on a branch to publish a test build. It does not change `latest`, so frames following stable releases stay on their current release. A manual run on a version tag follows the same release rules as a tag push.

Images publish to `ghcr.io/carldanley/imframe` for `linux/amd64` and `linux/arm64`. Forks publish under their own owner/repository name. Actions uses its built-in `GITHUB_TOKEN`; no Immich API key is needed in CI.

For private GHCR packages, authenticate before pulling with a classic personal access token that has `read:packages` permission. See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Version a release

Use [SemVer](https://semver.org/): patch for fixes, minor for added features, major for incompatible changes to configuration, saved settings, or the API. During `0.x` development, incompatible changes go in a new minor release; patch releases should preserve existing behavior and settings.

Prepare the next version with one of:

```sh
npm run version:bump -- patch
npm run version:bump -- minor
npm run version:bump -- major
```

Choose one command per release. It updates both package files without committing, tagging, or pushing. For a preview, use an explicit version such as `npm run version:bump -- 0.2.0-rc.1`. Release tags omit SemVer's optional `+build` suffix because Docker tags cannot contain `+`; SHA tags and image revision labels identify the build.

After reviewing and committing the software changes, an example patch release from `0.1.0` is:

```sh
npm run version:bump -- patch
npm run release:check -- v0.1.1
git add package.json package-lock.json
git commit -m "chore(release): v0.1.1"
git tag -a v0.1.1 -m "v0.1.1"
git push --atomic origin main v0.1.1
```

Use the actual version produced by the bump command. The initial `0.1.0` release can use the existing package version without a bump. Never move a released Git tag or reuse a version for changed software; increment the version instead. Wait for **Container** to finish, including its published-image tests, before installing a new version on additional frames.

## Files to keep local

`.env`, `data/`, dependencies, and generated builds are ignored by Git. `.dockerignore` includes only the inputs needed to build the app. The tracked video fixture is a generated test pattern.

Use generated demo media for screenshots unless the owner has approved the exact personal photos shown.
