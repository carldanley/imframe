export interface PrefetchedFile {
  blob: Blob;
  release(): void;
}

interface Entry {
  url: string;
  state: 'queued' | 'loading' | 'ready' | 'skipped';
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
  blob?: Blob;
  bytes: number;
  users: number;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

/** Download upcoming files without creating additional image/video decoders. */
export class MediaPrefetch {
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private limit = 0;
  private running = false;
  private paused = false;
  private closed = false;

  constructor(private fetcher: typeof fetch = (input, init) => fetch(input, init), private changed: () => void = () => {}) {}

  get bytes() { return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0); }
  ready(url: string) { return this.entries.get(url)?.state === 'ready'; }
  get loading() { return [...this.entries.values()].filter(entry => entry.state === 'loading').length; }

  plan(urls: string[], limitBytes: number) {
    if (this.closed) return;
    const increased = limitBytes > this.limit;
    this.order = [...new Set(urls)];
    this.limit = limitBytes;
    for (const entry of this.entries.values()) {
      if ((!this.order.includes(entry.url) && !entry.users) || (increased && entry.state === 'skipped')) this.remove(entry);
    }
    // A smaller budget evicts the farthest unused downloads first. Files being
    // displayed stay valid until their slide releases them.
    for (const url of this.order.toReversed()) {
      const entry = this.entries.get(url);
      if (this.bytes <= this.limit) break;
      if (entry && !entry.users) this.skip(entry);
    }
    for (const url of this.order) {
      if (this.entries.has(url)) continue;
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      this.entries.set(url, { url, state: 'queued', controller: new AbortController(), done, finish, bytes: 0, users: 0 });
    }
    this.pump();
  }

  pause(paused: boolean) {
    this.paused = paused;
    if (!paused) this.pump();
  }

  /** Wait while another slide is playing; stream normally if this file is due. */
  async acquire(url: string, cancel: AbortSignal, needed: AbortSignal): Promise<PrefetchedFile | null> {
    cancel.throwIfAborted();
    const entry = this.entries.get(url);
    if (!entry) return null;
    if (entry.state === 'queued' || entry.state === 'loading') {
      let wake!: () => void;
      const interrupted = new Promise<void>(resolve => { wake = resolve; });
      cancel.addEventListener('abort', wake, { once: true });
      needed.addEventListener('abort', wake, { once: true });
      try {
        if (!needed.aborted && !cancel.aborted) await Promise.race([entry.done, interrupted]);
      } finally {
        cancel.removeEventListener('abort', wake);
        needed.removeEventListener('abort', wake);
      }
      cancel.throwIfAborted();
    }
    if (entry.state !== 'ready' || !entry.blob) {
      // Do not keep downloading a duplicate while the video element streams it.
      this.skip(entry);
      return null;
    }
    entry.users++;
    let released = false;
    return {
      blob: entry.blob,
      release: () => {
        if (released) return;
        released = true;
        entry.users--;
        if (!entry.users && !this.order.includes(url)) this.remove(entry);
      },
    };
  }

  dispose() {
    this.closed = true;
    this.order = [];
    for (const entry of this.entries.values()) this.remove(entry);
  }

  private skip(entry: Entry) {
    if (entry.users) return;
    entry.controller.abort();
    void entry.reader?.cancel().catch(() => {});
    entry.blob = undefined;
    entry.bytes = 0;
    entry.state = 'skipped';
    entry.finish();
  }

  private remove(entry: Entry) {
    entry.controller.abort();
    void entry.reader?.cancel().catch(() => {});
    entry.blob = undefined;
    entry.bytes = 0;
    entry.finish();
    this.entries.delete(entry.url);
  }

  private pump() {
    if (this.running || this.paused || this.closed) return;
    this.running = true;
    void (async () => {
      try {
        while (!this.paused && !this.closed) {
          const entry = this.order.map(url => this.entries.get(url)).find(item => item?.state === 'queued');
          if (!entry) break;
          await this.download(entry);
        }
      } finally { this.running = false; }
    })();
  }

  private async download(entry: Entry) {
    entry.state = 'loading';
    const timeout = setTimeout(() => entry.controller.abort(), 120_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(entry.url, { signal: entry.controller.signal });
      if (!response.ok || response.status === 206 || !response.body) {
        await response.body?.cancel();
        throw new Error('No complete file to preload.');
      }
      const lengthHeader = response.headers.get('content-length');
      const length = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
      if (length !== undefined && (!Number.isSafeInteger(length) || length > this.limit - this.bytes)) {
        await response.body.cancel();
        throw new Error('File exceeds the available preload budget.');
      }
      entry.controller.signal.throwIfAborted();
      entry.bytes = length ?? 0;
      reader = response.body.getReader();
      entry.reader = reader;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let received = 0;
      while (true) {
        const result = await reader.read();
        entry.controller.signal.throwIfAborted();
        if (result.done) break;
        received += result.value.byteLength;
        const extra = Math.max(0, received - entry.bytes);
        if (this.bytes + extra > this.limit) throw new Error('File exceeds the preload budget.');
        entry.bytes += extra;
        chunks.push(new Uint8Array(result.value));
      }
      if (length !== undefined && received !== length) throw new Error('Incomplete preload.');
      entry.blob = new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
      entry.bytes = received;
      entry.state = 'ready';
    } catch {
      // Prefetch is optional. The normal media path reports any real playback error.
      this.skip(entry);
    } finally {
      clearTimeout(timeout);
      await reader?.cancel().catch(() => {});
      entry.reader = undefined;
      entry.finish();
      this.changed();
    }
  }
}
