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
npm run build
npm audit --audit-level=low
```

The build includes strict TypeScript checks. Tests cover album ordering, library updates, settings, date formatting, Live Photo timing, video cropping, and the Immich proxy. Check codecs, motion, and transitions in a browser too.

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
| Lint | TypeScript, JavaScript, GitHub Actions, and Dockerfile checks |
| Tests and build | Unit/integration tests, strict types, and production assets |
| Security checks | Git history credential scan and npm dependency audit |
| Container tests | Native AMD64 and ARM64 builds, startup, health, and settings persistence |
| Published image tests | Pull from GHCR and repeat the smoke test on both architectures |

To publish, choose **Actions → Container → Run workflow**, or push a version tag such as `v0.1.0`. Publishing waits for the checks to pass.

| Trigger | Image tags |
| --- | --- |
| Manual run on the default branch | `latest`, `sha-…` |
| Manual run on another branch | `sha-…` |
| Stable version tag, such as `v0.1.0` | `0.1.0`, `0.1`, `latest`, `sha-…` |

Images publish to `ghcr.io/carldanley/imframe` for `linux/amd64` and `linux/arm64`. Forks publish under their own owner/repository name. Actions uses its built-in `GITHUB_TOKEN`; no Immich API key is needed in CI.

For private GHCR packages, authenticate before pulling with a classic personal access token that has `read:packages` permission. See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Files to keep local

`.env`, `data/`, dependencies, and generated builds are ignored by Git. `.dockerignore` includes only the inputs needed to build the app. The tracked video fixture is a generated test pattern.

Use generated demo media for screenshots unless the owner has approved the exact personal photos shown.
