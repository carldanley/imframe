import { resolve } from 'node:path';
import { createApp } from './app.js';
import { ImmichClient } from './immich.js';
import { SettingsStore } from './settings.js';

const settings = new SettingsStore(resolve(process.env.DATA_DIR ?? './data'));
await settings.load();
const immich = new ImmichClient(process.env.IMMICH_URL || 'http://immich.local:2283', process.env.IMMICH_API_KEY ?? '');
const server = createApp({ immich, settings, staticDir: resolve('dist'), demo: process.env.IMFRAME_DEMO === '1' });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
server.listen(port, host, () => console.log(`imframe server: http://localhost:${port}`));
const shutdown = () => { server.close(); server.closeAllConnections(); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
