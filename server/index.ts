import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { SatelliteRuntime } from './satellite.js';
import { Hub, createHubApp } from './hub.js';
import { createApp } from './app.js';
import { ImmichClient } from './immich.js';
import { SettingsStore } from './settings.js';

const directory = resolve(process.env.DATA_DIR ?? './data');
const version = (JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string }).version;
const mode = process.env.IMFRAME_MODE ?? 'satellite';
if (!['hub', 'satellite'].includes(mode)) throw new Error('IMFRAME_MODE must be hub or satellite.');
const hub = mode === 'hub' ? new Hub(directory) : null;
const satellite = new SatelliteRuntime(directory, version);
const settings = new SettingsStore(directory);
if (hub) await hub.load();
else { await settings.load(); await satellite.load(); }
const immich = new ImmichClient(process.env.IMMICH_URL || 'http://immich.local:2283', process.env.IMMICH_API_KEY ?? '');
const server = hub ? createHubApp(hub, { staticDir: resolve('dist'), version })
  : createApp({ immich, settings, satellite, staticDir: resolve('dist'), demo: process.env.IMFRAME_DEMO === '1' });
const updateTimer = hub ? setInterval(() => { void hub.automaticUpdates().catch(() => {}); }, 60_000) : null;
updateTimer?.unref();
let syncing = false;
const syncTimer = hub ? setInterval(() => {
  if (syncing) return;
  syncing = true;
  void hub.refreshAll().catch(() => {}).finally(() => { syncing = false; });
}, 5000) : null;
syncTimer?.unref();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
server.listen(port, host, () => console.log(`imframe server: http://localhost:${port}`));
const shutdown = () => { if (updateTimer) clearInterval(updateTimer); if (syncTimer) clearInterval(syncTimer); hub?.close(); server.close(); server.closeAllConnections(); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
