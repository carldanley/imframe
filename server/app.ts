import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isId, type Library, type Status } from '../shared/model.js';
import { HttpError, ImmichClient } from './immich.js';
import { SettingsStore } from './settings.js';

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 32_768) throw new HttpError(413, 'Request is too large.');
  }
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export function createApp(options: { immich: ImmichClient; settings: SettingsStore; staticDir?: string; demo?: boolean }) {
  const { immich, settings } = options;
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
        if (request.method === 'PUT') {
          let saved;
          try { saved = await settings.save(await readJson(request)); }
          catch (error) {
            if (error instanceof HttpError) throw error;
            if ((error as NodeJS.ErrnoException).code) throw error;
            throw new HttpError(400, (error as Error).message);
          }
          libraryCache = undefined;
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
          playerReport = { ...report, reportedAt: new Date().toISOString() };
          return json(response, 200, { ok: true });
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
        const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(upstream.status, headers);
        if (request.method === 'HEAD' || !upstream.body) { await upstream.body?.cancel(); response.end(); return; }
        await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), response);
        return;
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'API endpoint not found.');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      if (!options.staticDir) throw new HttpError(404, 'Use the Vite development URL on port 5173.');
      const root = resolve(options.staticDir);
      const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'Not found.');
      const isPage = ['/', '/frame', '/frame/'].includes(url.pathname);
      const target = isPage ? resolve(root, 'index.html') : file;
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) throw new HttpError(404, 'Not found.');
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      response.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream', 'Cache-Control': isPage ? 'no-cache' : 'public, max-age=31536000, immutable' });
      if (request.method === 'HEAD') { response.end(); return; }
      await pipeline(createReadStream(target), response);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof HttpError ? error.message : 'The frame could not complete this request. Check that Immich is reachable and try again.';
      json(response, status, { error: message });
    }
  });
}
