import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Serialize mutations as well as writes so concurrent requests cannot lose data. */
export class JsonStore<T> {
  private writes = Promise.resolve();
  constructor(private file: string, private current: T) {}
  async load() {
    try { this.current = JSON.parse(await readFile(this.file, 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  get(): T { return structuredClone(this.current); }
  async change(mutator: (current: T) => T) {
    const write = this.writes.then(async () => {
      const next = mutator(this.get());
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.current = next;
    });
    this.writes = write.catch(() => {});
    await write;
    return this.get();
  }
}
