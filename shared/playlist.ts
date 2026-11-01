import type { AlbumMedia, FrameSettings, Media } from './model.js';

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function buildCycle(albums: AlbumMedia[], settings: FrameSettings, random = Math.random): Media[] {
  const byId = new Map(albums.map(a => [a.albumId, a.media]));
  let ids = settings.albumIds;
  if (settings.playbackMode === 'albums' && settings.shuffleAlbums) ids = shuffled(ids, random);
  const groups = ids.map(id => byId.get(id) ?? []);
  // Immich may expose the motion component separately. Display a Live Photo once.
  const motionIds = new Set(groups.flat().map(m => m.livePhotoVideoId).filter(Boolean));
  const seen = new Set<string>();
  const unique = (media: Media[]) => media.filter(m => {
    if (seen.has(m.id) || motionIds.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  const order = (media: Media[]) => settings.mediaOrder === 'shuffle'
    ? shuffled(media, random)
    : media.toSorted((a, b) => {
      const compare = a.takenAt.localeCompare(b.takenAt) || a.id.localeCompare(b.id);
      return settings.mediaOrder === 'newest' ? -compare : compare;
    });
  return settings.playbackMode === 'mixed' ? order(unique(groups.flat())) : groups.flatMap(group => order(unique(group)));
}

/** A shuffle bag: refreshes add/remove media without resetting the current cycle. */
export class Playlist {
  private library: AlbumMedia[] = [];
  private settings: FrameSettings;
  private remaining: Media[] = [];
  private seen = new Set<string>();
  private lastId: string | null = null;
  private all = new Map<string, Media>();
  private cycleAlbumIds: string[] = [];
  private orderSignature = '';

  constructor(settings: FrameSettings, private random = Math.random) { this.settings = settings; }

  update(albums: AlbumMedia[], settings: FrameSettings) {
    this.library = albums;
    this.settings = settings;
    const signature = JSON.stringify([settings.albumIds, settings.playbackMode, settings.shuffleAlbums, settings.mediaOrder]);
    if (signature !== this.orderSignature) { this.orderSignature = signature; this.chooseAlbumOrder(); }
    const cycle = this.cycle();
    this.all = new Map(cycle.map(m => [m.id, m]));
    this.remaining = cycle.filter(m => !this.seen.has(m.id));
  }

  get size() { return this.all.size; }
  contains(id: string) { return this.all.has(id); }
  get(id: string) { return this.all.get(id); }

  private chooseAlbumOrder() {
    this.cycleAlbumIds = this.settings.playbackMode === 'albums' && this.settings.shuffleAlbums
      ? shuffled(this.settings.albumIds, this.random) : [...this.settings.albumIds];
  }
  private cycle() {
    return buildCycle(this.library, { ...this.settings, albumIds: this.cycleAlbumIds, shuffleAlbums: false }, this.random);
  }

  next(): Media | undefined {
    if (!this.remaining.length) {
      this.seen.clear();
      this.chooseAlbumOrder();
      this.remaining = this.cycle();
      // Avoid repeating the final slide immediately at the cycle boundary.
      if (this.settings.playbackMode === 'mixed' && this.remaining.length > 1 && this.remaining[0]?.id === this.lastId) {
        this.remaining.push(this.remaining.shift()!);
      }
    }
    const next = this.remaining.shift();
    if (next) { this.seen.add(next.id); this.lastId = next.id; }
    return next;
  }
}
