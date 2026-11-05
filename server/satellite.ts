import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { FrameSettings } from '../shared/model.js';
import { isId } from '../shared/model.js';
import type { DisplayState, PlaybackCommand, PlaybackSnapshot, SatelliteInfo, UpdateState } from '../shared/satellite.js';
import { HttpError } from './immich.js';
import { object } from './http.js';
import { JsonStore } from './json-store.js';
import { powerState } from '../shared/power.js';

export class SatelliteRuntime {
  private saved: { id: string; update: UpdateState; timeZone?: string } = { id: randomUUID(), update: { managedBy: null, requested: null, result: null, agentSeenAt: null } };
  private store?: JsonStore<typeof this.saved>;
  private player: { id: string; kiosk: boolean; seenAt: number } | null = null;
  private playback: PlaybackSnapshot | null = null;
  private preview: Buffer | null = null;
  private previewAt = 0;
  private previewUntil = 0;
  private display: Omit<DisplayState, 'connected'> = { sleeping: null, timeZone: null, error: null };
  private displaySeenAt = 0;
  private listeners = new Set<ServerResponse>();
  private commands = new Map<string, { command: PlaybackCommand; session: string; promise: Promise<unknown>; settle: (error?: string) => void }>();
  private completed = new Map<string, { action: string; error?: string }>();
  private powerPhase = '';
  constructor(directory?: string, readonly version = 'development', private timeoutMs = 30_000) {
    if (directory) this.store = new JsonStore(join(directory, 'satellite.json'), this.saved);
  }
  async load() {
    if (!this.store) return;
    await this.store.load();
    this.saved = await this.store.change(value => value);
  }
  get online() { return !!this.player && Date.now() - this.player.seenAt < 8_000; }
  power(settings: FrameSettings) { return powerState(settings, this.saved.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone); }
  powerChanged(settings: FrameSettings) {
    const power = this.power(settings);
    if (power.phase !== this.powerPhase) {
      this.powerPhase = power.phase;
      for (const listener of this.listeners) listener.write('data: power\n\n');
    }
    return power;
  }
  getPreview() { this.previewUntil = Date.now() + 10_000; return this.preview ? { bytes: this.preview, capturedAt: this.previewAt } : null; }
  setPreview(session: string | null, image: Buffer) {
    if (this.player?.id === session && this.online) { this.preview = image; this.previewAt = Date.now(); }
  }
  info(settings: FrameSettings): SatelliteInfo {
    return { id: this.saved.id, apiVersion: 1, version: this.version, name: settings.name, settings,
      playback: this.playback, playerOnline: this.online, update: structuredClone(this.saved.update),
      display: { ...this.display, phase: this.power(settings).phase, connected: this.displaySeenAt > 0 && Date.now() - this.displaySeenAt < 45_000 } };
  }
  async displayAgent(input: unknown, settings: FrameSettings) {
    const data = object(input);
    if ((data.sleeping !== null && typeof data.sleeping !== 'boolean') ||
      typeof data.timeZone !== 'string' || !data.timeZone || data.timeZone.length > 100 ||
      (data.error !== null && (typeof data.error !== 'string' || data.error.length > 200)) ||
      (data.kioskRunning !== undefined && data.kioskRunning !== null && typeof data.kioskRunning !== 'boolean')) {
      throw new HttpError(400, 'Invalid display report.');
    }
    try { Intl.DateTimeFormat('en', { timeZone: data.timeZone }).resolvedOptions(); }
    catch { throw new HttpError(400, 'Invalid display time zone.'); }
    if (data.timeZone !== this.saved.timeZone) {
      if (this.store) this.saved = await this.store.change(state => ({ ...state, timeZone: data.timeZone as string }));
      else this.saved.timeZone = data.timeZone;
    }
    this.display = { sleeping: data.sleeping as boolean | null, timeZone: data.timeZone, error: data.error as string | null,
      ...(data.kioskRunning !== undefined ? { kioskRunning: data.kioskRunning as boolean | null } : {}) };
    this.displaySeenAt = Date.now();
    const { sleepEnabled, sleepStart, sleepEnd } = settings;
    return { sleepEnabled, sleepStart, sleepEnd, power: this.power(settings) };
  }
  subscribe(response: ServerResponse) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.write('data: ready\n\n');
    this.listeners.add(response);
    const timer = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    response.on('close', () => { clearInterval(timer); this.listeners.delete(response); });
  }
  settingsChanged() { for (const listener of this.listeners) listener.write('data: settings\n\n'); }

  report(input: unknown) {
    const data = object(input);
    const session = data.sessionId;
    if (!isId(session)) throw new HttpError(400, 'Invalid player session.');
    const kiosk = data.kiosk === true;
    if (!this.online || this.player?.id === session || (kiosk && !this.player?.kiosk)) {
      if (this.player?.id !== session) {
        for (const entry of this.commands.values()) entry.settle('The player changed. Try again.');
        this.preview = null;
      }
      this.player = { id: session, kiosk, seenAt: Date.now() };
      const snapshot = object(data.playback);
      if (!['loading', 'photo', 'motion', 'video', 'still'].includes(String(snapshot.phase)) ||
        typeof snapshot.paused !== 'boolean' || !Number.isFinite(snapshot.position) ||
        (snapshot.asset !== null && !isId(object(snapshot.asset).id))) throw new HttpError(400, 'Invalid playback state.');
      this.playback = { ...snapshot, reportedAt: new Date().toISOString() } as unknown as PlaybackSnapshot;
      return { accepted: true, commands: [...this.commands.values()].map(entry => entry.command), previewRequested: Date.now() < this.previewUntil };
    }
    return { accepted: false, commands: [] };
  }

  command(input: unknown) {
    const data = object(input);
    if (!isId(data.id) || !['previous', 'pause', 'resume', 'next'].includes(String(data.action))) throw new HttpError(400, 'Invalid playback command.');
    const id = data.id;
    const prior = this.completed.get(id);
    const pending = this.commands.get(id);
    if ((prior && prior.action !== data.action) || (pending && pending.command.action !== data.action)) throw new HttpError(409, 'Command ID has already been used.');
    if (prior?.error) throw new HttpError(409, prior.error);
    if (prior) return Promise.resolve({ acknowledged: true, id });
    if (pending) return pending.promise;
    if (!this.online) throw new HttpError(409, 'The frame’s player is offline.');
    if (this.commands.size) throw new HttpError(409, 'Wait for the previous command to finish.');
    const command: PlaybackCommand = { id, action: data.action as PlaybackCommand['action'], expiresAt: Date.now() + this.timeoutMs };
    let settle!: (error?: string) => void;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle('The player did not acknowledge this command. Check the frame before trying again.'), this.timeoutMs);
      settle = error => {
        clearTimeout(timer);
        this.commands.delete(id);
        this.completed.set(id, { action: command.action, ...(error ? { error } : {}) });
        if (this.completed.size > 100) this.completed.delete(this.completed.keys().next().value!);
        if (error) reject(new HttpError(409, error));
        else resolve({ acknowledged: true, id });
      };
    });
    this.commands.set(id, { command, promise, settle, session: this.player!.id });
    return promise;
  }
  acknowledge(id: string, input: unknown) {
    const data = object(input);
    const entry = this.commands.get(id);
    if (entry && entry.session === data.sessionId && this.player?.id === data.sessionId) {
      entry.settle(typeof data.error === 'string' ? data.error.slice(0, 200) : undefined);
    }
  }
  async update(change: (state: UpdateState) => UpdateState) {
    if (this.store) this.saved = await this.store.change(state => ({ ...state, update: change(state.update) }));
    else this.saved.update = change(this.saved.update);
    return structuredClone(this.saved.update);
  }
  async manage(input: unknown) {
    const { hubId } = object(input);
    if (hubId !== null && !isId(hubId)) throw new HttpError(400, 'Invalid Hub ID.');
    return this.update(state => ({ ...state, managedBy: hubId as string | null }));
  }
  async requestUpdate() {
    if (!this.saved.update.agentSeenAt || Date.now() - Date.parse(this.saved.update.agentSeenAt) > 180_000) {
      throw new HttpError(409, 'Install the current Pi updater to enable updates from Hub.');
    }
    return this.update(state => state.requested && (state.result?.id !== state.requested.id || state.result.state === 'running') ? state : {
      ...state, requested: { id: randomUUID(), requestedAt: new Date().toISOString() },
    });
  }
  async agent(input: unknown) {
    const data = object(input);
    return this.update(state => {
      let result = state.result;
      if (data.id && data.id === state.requested?.id && ['running', 'succeeded', 'failed'].includes(String(data.state))) {
        result = { id: String(data.id), state: data.state as NonNullable<UpdateState['result']>['state'],
          message: typeof data.message === 'string' ? data.message.slice(0, 200) : '', reportedAt: new Date().toISOString() };
      }
      return { ...state, agentSeenAt: new Date().toISOString(), result };
    });
  }
}
