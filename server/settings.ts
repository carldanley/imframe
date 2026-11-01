import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaults, parseSettings, type FrameSettings } from '../shared/model.js';

export class SettingsStore {
  private current: FrameSettings = structuredClone(defaults);
  private writes = Promise.resolve();
  constructor(private directory: string) {}

  async load() {
    try { this.current = parseSettings(JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read data/settings.json. Fix or move the file before starting.', { cause: error });
    }
  }
  get() { return structuredClone(this.current); }
  async save(input: unknown) {
    const next = parseSettings(input);
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const target = join(this.directory, 'settings.json');
      await writeFile(`${target}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(`${target}.tmp`, target);
      this.current = next;
    });
    this.writes = write.catch(() => {});
    await write;
    return this.get();
  }
}
