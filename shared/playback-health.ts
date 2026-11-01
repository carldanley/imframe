import type { Media } from './model.js';

export interface PlaybackHealthReport {
  unavailableCount: number;
  unavailableMedia: { id: string; name: string; message: string }[];
}

/** Current failures, rather than an error history that outlives repaired media. */
export class PlaybackHealth {
  private failures = new Map<string, { id: string; name: string; message: string }>();

  failed(media: Pick<Media, 'id' | 'name'>, message: string) {
    this.failures.set(media.id, { id: media.id, name: media.name, message });
  }

  recovered(id: string) { this.failures.delete(id); }

  retain(contains: (id: string) => boolean) {
    for (const id of this.failures.keys()) if (!contains(id)) this.failures.delete(id);
  }

  report(): PlaybackHealthReport {
    // Keep reports small even when many files lack browser-compatible renditions.
    return { unavailableCount: this.failures.size, unavailableMedia: [...this.failures.values()].slice(0, 5) };
  }
}
