export type Transition = 'fade' | 'slide' | 'cut' | 'random';
export type LocationCorner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
export interface FrameSettings {
  schemaVersion: 1;
  name: string;
  albumIds: string[];
  playbackMode: 'mixed' | 'albums';
  shuffleAlbums: boolean;
  mediaOrder: 'oldest' | 'newest' | 'shuffle';
  photoSeconds: number;
  fit: 'contain' | 'cover';
  motion: 'none' | 'in' | 'out' | 'random';
  zoomPercent: number;
  transition: Transition;
  transitionSeconds: number;
  resolution: '4k' | '1080p';
  videoSource: 'original' | 'immich';
  livePhotos: boolean;
  refreshSeconds: number;
  preloadCount: number;
  preloadMegabytes: number;
  showLocation: boolean;
  locationCorner: LocationCorner;
  showDate: boolean;
  dateCorner: LocationCorner;
  progressStyle: 'off' | 'bar' | 'ring';
  progressPosition: 'top' | 'bottom' | 'left' | 'right';
  progressCorner: LocationCorner;
}

export const defaults: FrameSettings = {
  schemaVersion: 1, name: 'Living room', albumIds: [],
  playbackMode: 'mixed', shuffleAlbums: false, mediaOrder: 'shuffle',
  photoSeconds: 12, fit: 'contain', motion: 'none', zoomPercent: 8,
  transition: 'fade', transitionSeconds: 0.8, resolution: '4k',
  videoSource: 'original', livePhotos: true, refreshSeconds: 60,
  preloadCount: 3, preloadMegabytes: 512,
  showLocation: false, locationCorner: 'bottom-left',
  showDate: false, dateCorner: 'top-left',
  progressStyle: 'off', progressPosition: 'bottom', progressCorner: 'bottom-right',
};

export interface Album {
  id: string;
  name: string;
  count: number;
  thumbnailId: string | null;
}

export interface MediaLocation {
  city: string | null;
  state: string | null;
  country: string | null;
}

export function formatLocation(location: MediaLocation | null | undefined): string | null {
  return location ? [location.city, location.state, location.country].filter(Boolean).join(', ') || null : null;
}

/** Keep the capture's calendar date; do not convert it to the frame's time zone. */
export function formatTakenDate(value: string | null | undefined): string | null {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (!parts) return null;
  const [, year, month, day] = parts as [string, string, string, string];
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return null;
  return `${month}.${day}.${year.slice(-2)}`;
}

export interface Media {
  id: string;
  type: 'IMAGE' | 'VIDEO';
  name: string;
  takenAt: string;
  localDateTime: string | null;
  updatedAt: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  mimeType: string;
  livePhotoVideoId: string | null;
  location: MediaLocation | null;
}

export interface AlbumMedia { albumId: string; media: Media[] }
export interface Library {
  albums: AlbumMedia[];
  refreshedAt: string;
  warnings: string[];
}
export interface Status {
  configured: boolean;
  connected: boolean;
  serverUrl: string;
  version: string | null;
  error: string | null;
  demo: boolean;
}

export const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function parseSettings(input: unknown): FrameSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.');
  const p = input as Record<string, unknown>;
  const choice = <T extends string>(key: string, allowed: readonly T[]): T => {
    if (!allowed.includes(p[key] as T)) throw new Error(`Invalid ${key}.`);
    return p[key] as T;
  };
  const number = (key: string, min: number, max: number) => {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    return v;
  };
  const boolean = (key: string) => {
    if (typeof p[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
    return p[key];
  };
  if (p.schemaVersion !== 1) throw new Error('Unsupported settings version.');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) throw new Error('Use a frame name between 1 and 80 characters.');
  if (!Array.isArray(p.albumIds) || p.albumIds.length > 100 || !p.albumIds.every(isId)) throw new Error('Select up to 100 valid albums.');
  const progressStyle = p.progressStyle === undefined ? defaults.progressStyle : choice('progressStyle', ['off', 'bar', 'ring']);
  const progressPosition = p.progressPosition === undefined ? defaults.progressPosition : choice('progressPosition', ['top', 'bottom', 'left', 'right']);
  const legacyCorners = { top: 'top-right', bottom: 'bottom-right', left: 'bottom-left', right: 'bottom-right' } as const;
  const preloadCount = p.preloadCount === undefined ? defaults.preloadCount : number('preloadCount', 1, 5);
  const preloadMegabytes = p.preloadMegabytes === undefined ? defaults.preloadMegabytes : number('preloadMegabytes', 128, 1024);
  if (!Number.isInteger(preloadCount)) throw new Error('preloadCount must be a whole number.');
  if (![128, 256, 512, 1024].includes(preloadMegabytes)) throw new Error('Choose a supported preloadMegabytes limit.');
  return {
    schemaVersion: 1, name: p.name.trim(), albumIds: [...new Set(p.albumIds as string[])],
    playbackMode: choice('playbackMode', ['mixed', 'albums']), shuffleAlbums: boolean('shuffleAlbums'),
    mediaOrder: choice('mediaOrder', ['oldest', 'newest', 'shuffle']),
    photoSeconds: number('photoSeconds', 3, 300), fit: choice('fit', ['contain', 'cover']),
    motion: choice('motion', ['none', 'in', 'out', 'random']), zoomPercent: number('zoomPercent', 1, 20),
    transition: choice('transition', ['fade', 'slide', 'cut', 'random']), transitionSeconds: number('transitionSeconds', 0.2, 3),
    resolution: choice('resolution', ['4k', '1080p']), videoSource: choice('videoSource', ['original', 'immich']),
    livePhotos: boolean('livePhotos'), refreshSeconds: number('refreshSeconds', 15, 3600),
    preloadCount, preloadMegabytes,
    // Older settings files remain valid; the next save persists the new fields.
    showLocation: p.showLocation === undefined ? defaults.showLocation : boolean('showLocation'),
    locationCorner: p.locationCorner === undefined ? defaults.locationCorner : choice('locationCorner', ['bottom-left', 'bottom-right', 'top-left', 'top-right']),
    showDate: p.showDate === undefined ? defaults.showDate : boolean('showDate'),
    dateCorner: p.dateCorner === undefined ? defaults.dateCorner : choice('dateCorner', ['bottom-left', 'bottom-right', 'top-left', 'top-right']),
    progressStyle, progressPosition,
    progressCorner: p.progressCorner === undefined
      ? progressStyle === 'ring' ? legacyCorners[progressPosition] : defaults.progressCorner
      : choice('progressCorner', ['bottom-left', 'bottom-right', 'top-left', 'top-right']),
  };
}

export function mediaUrl(media: Media, kind: 'photo' | 'video', settings: FrameSettings, live = false) {
  const id = live ? media.livePhotoVideoId : media.id;
  const rendition = kind === 'photo' ? 'photo' : settings.videoSource === 'original' ? 'original' : 'video';
  return `/api/media/${id}/${rendition}?v=${encodeURIComponent(media.updatedAt)}`;
}
