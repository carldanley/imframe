import { createServer } from 'node:http';
import { isId, type Library, type Status } from '../shared/model.js';
import { HttpError, ImmichClient } from './immich.js';
import { SettingsStore } from './settings.js';
import { SatelliteRuntime } from './satellite.js';
import { json, readJson, serveStatic, failure, stream } from './http.js';

export function createApp(options: { immich: ImmichClient; settings: SettingsStore; staticDir?: string; demo?: boolean; satellite?: SatelliteRuntime }) {
  const { immich, settings } = options;
  const satellite = options.satellite ?? new SatelliteRuntime();
  let libraryCache: { signature: string; expires: number; data: Library } | undefined;
  let libraryPending: { signature: string; promise: Promise<Library> } | undefined;
  let playerReport: Record<string, unknown> | null = null;

  async function library(force: boolean): Promise<Library> {
    const config = settings.get();
    const signature = JSON.stringify(config.albumIds);
    if (!force && libraryCache?.signature === signature && libraryCache.expires > Date.now()) return libraryCache.data;
    if (libraryPending?.signature === signature) return libraryPending.promise;
    const promise = (async () => {
      const available = config.albumIds.length ? await immich.albums() : [];
      const allowed = new Set(available.map(a => a.id));
      const warnings: string[] = [];
      const albums = [];
      // Keep requests bounded; a frame typically has only a few selected albums.
      for (const id of config.albumIds) {
        if (!allowed.has(id)) { warnings.push('A selected album was removed or is no longer shared with this account.'); continue; }
        albums.push(await immich.albumMedia(id));
      }
      const data = { albums, warnings, refreshedAt: new Date().toISOString() };
      libraryCache = { signature, expires: Date.now() + config.refreshSeconds * 1000, data };
      return data;
    })();
    libraryPending = { signature, promise };
    try { return await promise; }
    finally { if (libraryPending?.promise === promise) libraryPending = undefined; }
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://frame.local');
    try {
      if (url.pathname === '/api/preview') {
        if (request.method === 'GET') {
          const image = satellite.getPreview();
          if (!image) { response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return; }
          response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': image.bytes.length, 'X-Imframe-Preview-At': String(image.capturedAt) });
          response.end(image.bytes); return;
        }
        if (request.method === 'POST') {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 512_000) throw new HttpError(413, 'Preview is too large.');
            chunks.push(Buffer.from(chunk));
          }
          const image = Buffer.concat(chunks);
          if (image[0] !== 0xff || image[1] !== 0xd8) throw new HttpError(400, 'Expected a JPEG preview.');
          satellite.setPreview(url.searchParams.get('session'), image);
          return json(response, 200, { ok: true });
        }
      }
      if (url.pathname === '/api/app') return json(response, 200, { mode: 'satellite', version: satellite.version });
      if (url.pathname === '/api/satellite' && request.method === 'GET') return json(response, 200, satellite.info(settings.get()));
      if (url.pathname === '/api/events' && request.method === 'GET') return satellite.subscribe(response);
      if (url.pathname === '/api/commands' && request.method === 'POST') return json(response, 200, await satellite.command(await readJson(request)));
      const ack = url.pathname.match(/^\/api\/commands\/([^/]+)\/ack$/);
      if (ack && request.method === 'POST') { satellite.acknowledge(ack[1]!, await readJson(request)); return json(response, 200, { ok: true }); }
      if (url.pathname === '/api/management' && request.method === 'PUT') return json(response, 200, await satellite.manage(await readJson(request)));
      if (url.pathname === '/api/update' && request.method === 'POST') return json(response, 202, await satellite.requestUpdate());
      if (url.pathname === '/api/update-agent' && request.method === 'POST') return json(response, 200, await satellite.agent(await readJson(request)));
      if (url.pathname === '/api/display-agent' && request.method === 'POST') return json(response, 200, satellite.displayAgent(await readJson(request), settings.get()));
      if (url.pathname === '/api/status' && request.method === 'GET') {
        const status: Status = { configured: immich.configured, connected: false, serverUrl: immich.base.href.replace(/\/api\/$/, ''), version: null, error: null, demo: options.demo ?? false };
        try {
          status.version = await immich.version();
          if (immich.configured) { await immich.albums(); status.connected = true; }
          else status.error = 'Add your API key to .env, then restart the app.';
        } catch (error) { status.error = error instanceof HttpError ? error.message : 'Cannot reach Immich. Check its address and your network connection.'; }
        return json(response, 200, status);
      }
      if (url.pathname === '/api/settings') {
        if (request.method === 'GET') return json(response, 200, settings.get());
        if (request.method === 'PUT' || request.method === 'PATCH') {
          let saved;
          try { saved = await settings.save(await readJson(request), request.method === 'PATCH'); }
          catch (error) {
            if (error instanceof HttpError) throw error;
            if ((error as NodeJS.ErrnoException).code) throw error;
            throw new HttpError(400, (error as Error).message);
          }
          libraryCache = undefined;
          satellite.settingsChanged();
          return json(response, 200, saved);
        }
      }
      if (url.pathname === '/api/albums' && request.method === 'GET') return json(response, 200, await immich.albums());
      if (url.pathname === '/api/library' && request.method === 'GET') return json(response, 200, await library(url.searchParams.get('refresh') === '1'));
      if (url.pathname === '/api/player') {
        if (request.method === 'GET') return json(response, 200, playerReport);
        if (request.method === 'POST') {
          const report = await readJson(request);
          if (!report || typeof report !== 'object' || Array.isArray(report)) throw new HttpError(400, 'Invalid player report.');
          const receipt = 'sessionId' in report ? satellite.report(report) : { accepted: !satellite.online, commands: [] };
          if (receipt.accepted) playerReport = { ...report, reportedAt: new Date().toISOString() };
          return json(response, 200, receipt);
        }
      }
      const media = url.pathname.match(/^\/api\/media\/([^/]+)\/(photo|thumbnail|video|original)$/);
      if (media && (request.method === 'GET' || request.method === 'HEAD')) {
        const [, id, kind] = media;
        if (!isId(id)) throw new HttpError(400, 'Invalid media ID.');
        const controller = new AbortController();
        response.on('close', () => controller.abort());
        // Abort the connection attempt without imposing a total duration limit on long videos.
        const timer = setTimeout(() => controller.abort(), 30_000);
        let upstream: Response;
        try { upstream = await immich.media(id, kind as 'photo' | 'thumbnail' | 'video' | 'original', request.headers.range, controller.signal); }
        finally { clearTimeout(timer); }
        await stream(upstream, response, request.method === 'HEAD');
        return;
      }
      await serveStatic(url, request, response, options.staticDir);
    } catch (error) { failure(response, error); }
  });
}
