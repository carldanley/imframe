import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSettings, isId, type FrameSettings } from '../shared/model.js';
import type { HubState, SatelliteInfo, SatelliteRecord } from '../shared/satellite.js';
import { JsonStore } from './json-store.js';
import { HttpError } from './immich.js';
import { failure, json, object, readJson, serveStatic, stream } from './http.js';

export function satelliteAddress(input: unknown): string {
  if (typeof input !== 'string' || input.length > 300) throw new HttpError(400, 'Enter the frame’s IP address or URL.');
  let url: URL;
  try {
    const bare = !input.includes('://');
    url = new URL(bare ? `http://${input.trim()}` : input.trim());
    if (bare && !url.port) url.port = '3000';
  } catch { throw new HttpError(400, 'Enter a valid frame address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new HttpError(400, 'Use the frame’s HTTP or HTTPS address without a path or password.');
  }
  return url.origin;
}

export class Hub {
  private store: JsonStore<HubState>;
  private views = new Map<string, SatelliteRecord>();
  private pending = new Map<string, Promise<SatelliteRecord>>();
  private saving = new Map<string, Promise<unknown>>();
  private updating = false;
  private lifetime = new AbortController();
  constructor(directory: string, private fetcher: typeof fetch = fetch) {
    this.store = new JsonStore(join(directory, 'hub.json'), { id: randomUUID(), updatePolicy: 'manual', lastUpdateCheck: null, satellites: [] });
  }
  async load() { await this.store.load(); await this.store.change(state => state); }
  close() { this.lifetime.abort(); }
  state(): HubState {
    const state = this.store.get();
    return { ...state, satellites: state.satellites.map(s => this.views.get(s.id) ?? s) };
  }
  satellite(id: string) {
    const record = this.state().satellites.find(s => s.id === id);
    if (!record) throw new HttpError(404, 'Frame not found.');
    return record;
  }
  async request(address: string, path: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await this.fetcher(`${address}/api/${path}`, { ...init, redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, init.signal ?? AbortSignal.timeout(5000)]), headers: { 'Content-Type': 'application/json', ...init.headers } }); }
    catch { throw new HttpError(503, 'Frame unavailable. Check that it is on and connected to your network.'); }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new HttpError(response.status, typeof body?.error === 'string' ? body.error : 'The frame could not complete this request.');
    return body;
  }
  async discover(input: unknown) {
    const address = satelliteAddress(input);
    const info = await this.request(address, 'satellite') as SatelliteInfo;
    if (!isId(info?.id) || info.apiVersion !== 1 || !info.settings) throw new HttpError(422, 'Update this frame to a version that supports Hub.');
    info.settings = parseSettings(info.settings);
    info.name = info.settings.name;
    return { address, info };
  }
  async add(input: unknown) {
    const { address, info } = await this.discover(input);
    const state = this.store.get();
    if (state.satellites.some(s => s.id === info.id || s.address === address)) throw new HttpError(409, 'This frame has already been added.');
    if (state.satellites.length >= 50) throw new HttpError(400, 'Hub supports up to 50 frames.');
    if (info.update.managedBy && info.update.managedBy !== state.id) throw new HttpError(409, 'This frame belongs to another Hub. Remove it there first.');
    info.update = await this.request(address, 'management', { method: 'PUT', body: JSON.stringify({ hubId: state.id }) });
    const record: SatelliteRecord = { id: info.id, address, snapshot: info, lastSeenAt: new Date().toISOString(), pendingSettings: null, error: null };
    await this.store.change(current => {
      if (current.satellites.some(s => s.id === info.id || s.address === address)) throw new HttpError(409, 'This frame has already been added.');
      return { ...current, satellites: [...current.satellites, record] };
    });
    return record;
  }
  async remove(id: string) {
    const record = await this.refresh(id);
    if (record.error) throw new HttpError(503, record.error);
    await this.request(record.address, 'management', { method: 'PUT', body: JSON.stringify({ hubId: null }) });
    await this.store.change(state => ({ ...state, satellites: state.satellites.filter(s => s.id !== id) }));
    this.views.delete(id);
  }
  async refresh(id: string): Promise<SatelliteRecord> {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const work = this.refreshOne(id);
    this.pending.set(id, work);
    try { return await work; } finally { this.pending.delete(id); }
  }
  private async refreshOne(id: string) {
    const record = this.satellite(id);
    let next: SatelliteRecord;
    try {
      const snapshot = await this.request(record.address, 'satellite') as SatelliteInfo;
      if (snapshot.id !== id || snapshot.apiVersion !== 1) throw new HttpError(409, 'A different frame is using this address. Remove and add it again.');
      next = { ...record, snapshot, error: null, lastSeenAt: new Date().toISOString() };
    } catch (error) { next = { ...record, error: (error as Error).message }; }
    // A settings request may finish while this network read is in flight.
    next.pendingSettings = this.store.get().satellites.find(s => s.id === id)?.pendingSettings ?? null;
    this.views.set(id, next);
    return next;
  }
  async refreshAll() {
    const ids = this.state().satellites.map(s => s.id);
    for (let start = 0; start < ids.length; start += 4) await Promise.all(ids.slice(start, start + 4).map(id => this.refresh(id)));
    for (const record of this.state().satellites) {
      if (!record.error && record.pendingSettings && !this.saving.has(record.id)) await this.settings(record.id, {}).catch(() => {});
    }
    return this.state();
  }
  async settings(id: string, input: unknown): Promise<SatelliteRecord> {
    const patch = object(input);
    const previous = this.saving.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const record = this.satellite(id);
      const combined = { ...record.pendingSettings, ...patch };
      let validated: FrameSettings;
      try { validated = parseSettings({ ...record.snapshot.settings, ...combined }); }
      catch (error) { throw new HttpError(400, (error as Error).message); }
      const changes = Object.fromEntries(Object.keys(combined).filter(key => key in validated).map(key => [key, validated[key as keyof FrameSettings]]));
      // Persist intent before sending it. Retrying an absolute settings patch is safe.
      await this.store.change(state => ({ ...state, satellites: state.satellites.map(s => s.id === id ? { ...s, pendingSettings: changes } : s) }));
      let next: SatelliteRecord = { ...record, pendingSettings: changes };
      try {
        const identity = await this.request(record.address, 'satellite') as SatelliteInfo;
        if (identity.id !== id) throw new HttpError(409, 'A different frame is using this address.');
        const saved = await this.request(record.address, 'settings', { method: 'PATCH', body: JSON.stringify(changes) }) as FrameSettings;
        next = { ...next, snapshot: { ...identity, name: saved.name, settings: saved }, error: null, pendingSettings: null, lastSeenAt: new Date().toISOString() };
      } catch (error) { next.error = (error as Error).message; }
      this.views.set(id, next);
      await this.store.change(state => ({ ...state, satellites: state.satellites.map(s => s.id === id ? next : s) }));
      return next;
    });
    this.saving.set(id, work);
    try { return await work; } finally { if (this.saving.get(id) === work) this.saving.delete(id); }
  }
  async policy(input: unknown) {
    const { updatePolicy } = object(input);
    if (updatePolicy !== 'manual' && updatePolicy !== 'automatic') throw new HttpError(400, 'Choose manual or automatic updates.');
    await this.store.change(state => ({ ...state, updatePolicy }));
    return this.state();
  }
  async command(id: string, input: unknown) {
    const record = await this.refresh(id);
    if (record.error) throw new HttpError(503, record.error);
    const result = await this.request(record.address, 'commands', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(35_000) });
    await this.refresh(id);
    return result;
  }
  async requestUpdate(id: string) {
    const record = await this.refresh(id);
    if (record.error) throw new HttpError(503, record.error);
    const result = await this.request(record.address, 'update', { method: 'POST', body: '{}' });
    await this.refresh(id);
    return result;
  }
  async automaticUpdates() {
    const state = this.state();
    if (this.updating || state.updatePolicy !== 'automatic' || (state.lastUpdateCheck && Date.now() - Date.parse(state.lastUpdateCheck) < 86_400_000)) return;
    this.updating = true;
    try {
      await this.store.change(current => ({ ...current, lastUpdateCheck: new Date().toISOString() }));
      // Request the next frame only after the previous one finishes (or times out).
      for (const satellite of state.satellites) {
        if (this.lifetime.signal.aborted) return;
        try {
          const update = await this.requestUpdate(satellite.id);
          const deadline = Date.now() + 600_000;
          while (Date.now() < deadline) {
            await delay(5000, undefined, { signal: this.lifetime.signal });
            const current = await this.refresh(satellite.id);
            const result = current.snapshot.update.result;
            if (result?.id === update.requested.id && result?.state !== 'running') break;
          }
        } catch { /* Keep the remaining frames eligible when one is offline. */ }
      }
    } finally { this.updating = false; }
  }
}

export function createHubApp(hub: Hub, options: { staticDir?: string; version?: string } = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://hub.local');
    try {
      if (url.pathname === '/api/app' && request.method === 'GET') return json(response, 200, { mode: 'hub', version: options.version ?? 'development' });
      // Shared container health check, with no Immich connection needed in Hub mode.
      if (url.pathname === '/api/settings' && request.method === 'GET') return json(response, 200, { mode: 'hub' });
      if (url.pathname === '/api/hub') {
        if (request.method === 'GET') return json(response, 200, await hub.refreshAll());
        if (request.method === 'PATCH') return json(response, 200, await hub.policy(await readJson(request)));
      }
      if (url.pathname === '/api/hub/discover' && request.method === 'POST') return json(response, 200, await hub.discover(object(await readJson(request)).address));
      if (url.pathname === '/api/hub/satellites' && request.method === 'POST') return json(response, 201, await hub.add(object(await readJson(request)).address));
      const match = url.pathname.match(/^\/api\/hub\/satellites\/([\w-]+)(?:\/(.*))?$/);
      if (match) {
        const id = match[1]!;
        const path = match[2];
        const record = hub.satellite(id);
        if (!path && request.method === 'DELETE') { await hub.remove(id); return json(response, 200, { ok: true }); }
        if (path === 'settings' && request.method === 'PATCH') return json(response, 200, await hub.settings(id, await readJson(request)));
        if (path === 'commands' && request.method === 'POST') return json(response, 200, await hub.command(id, await readJson(request)));
        if (path === 'update' && request.method === 'POST') return json(response, 202, await hub.requestUpdate(id));
        if (path === 'albums' && request.method === 'GET') return json(response, 200, await hub.request(record.address, path));
        if (path === 'preview' && request.method === 'GET') {
          const upstream = await fetch(`${record.address}/api/preview`, { redirect: 'error', signal: AbortSignal.timeout(4000) });
          await stream(upstream, response, false); return;
        }
        const media = path?.match(/^media\/([\w-]+)\/(photo|thumbnail|video|original)$/);
        if (media && isId(media[1]) && ['GET', 'HEAD'].includes(request.method ?? '')) {
          const controller = new AbortController();
          response.on('close', () => controller.abort());
          const timer = setTimeout(() => controller.abort(), 15_000);
          let upstream: Response;
          try { upstream = await fetch(`${record.address}/api/${path}`, { method: request.method, redirect: 'error', signal: controller.signal, headers: request.headers.range ? { Range: request.headers.range } : {} }); }
          finally { clearTimeout(timer); }
          await stream(upstream, response, request.method === 'HEAD');
          return;
        }
      }
      await serveStatic(url, request, response, options.staticDir);
    } catch (error) { failure(response, error); }
  });
  return server;
}
