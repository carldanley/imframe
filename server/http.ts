import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './immich.js';

export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
export async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 32_768) throw new HttpError(413, 'Request is too large.');
  }
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
export function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Expected an object.');
  return input as Record<string, unknown>;
}
export function failure(response: ServerResponse, error: unknown) {
  if (response.headersSent) { response.destroy(); return; }
  json(response, error instanceof HttpError ? error.status : 502,
    { error: error instanceof HttpError ? error.message : 'Could not complete this request. Check the connection and try again.' });
}
export async function stream(upstream: Response, response: ServerResponse, head: boolean) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'x-imframe-preview-at']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);
  if (head || !upstream.body) { await upstream.body?.cancel(); response.end(); return; }
  await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), response);
}
export async function serveStatic(url: URL, request: IncomingMessage, response: ServerResponse, directory?: string) {
  if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'API endpoint not found.');
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  if (!directory) throw new HttpError(404, 'Use the Vite development URL.');
  const root = resolve(directory);
  const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'Not found.');
  const isPage = ['/', '/frame', '/frame/'].includes(url.pathname);
  const target = isPage ? resolve(root, 'index.html') : file;
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, 'Not found.');
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
  response.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream',
    'Cache-Control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (request.method === 'HEAD') { response.end(); return; }
  await pipeline(createReadStream(target), response);
}
