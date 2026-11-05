import type { Album, AlbumMedia, Media, MediaLocation } from '../shared/model.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface AssetDto {
  id: string; type: string; originalFileName: string; originalMimeType?: string;
  fileCreatedAt: string; localDateTime?: string | null; updatedAt: string; width: number | null; height: number | null;
  duration: number | null; livePhotoVideoId?: string | null; isOffline?: boolean; isTrashed?: boolean;
  exifInfo?: { city?: string | null; state?: string | null; country?: string | null } | null;
}
interface SearchResult { assets: { items: AssetDto[]; nextCursor: string | null } }

function locationInfo(exif: AssetDto['exifInfo']): MediaLocation | null {
  const seen = new Set<string>();
  const part = (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text.toLocaleLowerCase())) return null;
    seen.add(text.toLocaleLowerCase());
    return text;
  };
  const location = { city: part(exif?.city), state: part(exif?.state), country: part(exif?.country) };
  return location.city || location.state || location.country ? location : null;
}

export class ImmichClient {
  readonly base: URL;
  constructor(url: string, private key: string, private fetcher: typeof fetch = fetch) {
    this.base = new URL(`${url.replace(/\/+$/, '').replace(/\/api$/, '')}/api/`);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password) throw new Error('IMMICH_URL must be an HTTP(S) URL without credentials.');
  }
  get configured() { return Boolean(this.key); }

  async request(path: string, init: RequestInit = {}, publicRequest = false) {
    if (!this.key && !publicRequest) throw new HttpError(503, 'Add IMMICH_API_KEY to .env and restart the app.');
    const response = await this.fetcher(new URL(path, this.base), {
      ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', ...(this.key ? { 'x-api-key': this.key } : {}), ...init.headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new HttpError(502, 'Immich denied access. Check the API key and its album.read, asset.read, asset.view, and asset.download permissions.');
      throw new HttpError(502, `Immich returned HTTP ${response.status}.`);
    }
    return response.json();
  }

  async version(): Promise<string> {
    const v = await this.request('server/version', {}, true) as { major: number; minor: number; patch: number };
    if (v.major !== 3 || v.minor < 2) throw new HttpError(502, 'This player currently supports Immich 3.2 and newer within version 3.');
    return `${v.major}.${v.minor}.${v.patch}`;
  }

  async albums(signal?: AbortSignal): Promise<Album[]> {
    const data = await this.request('albums', { signal }) as { id: string; albumName: string; assetCount: number; albumThumbnailAssetId: string | null }[];
    return data.map(a => ({ id: a.id, name: a.albumName, count: a.assetCount, thumbnailId: a.albumThumbnailAssetId }));
  }

  async albumMedia(albumId: string, signal?: AbortSignal): Promise<AlbumMedia> {
    const result: Media[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const data = await this.request('search/metadata', {
        signal,
        method: 'POST', body: JSON.stringify({
          filter: { albumIds: { any: [albumId] }, trashedAt: { eq: null }, type: { in: ['IMAGE', 'VIDEO'] } },
          size: 500, orderBy: { field: 'fileCreatedAt', direction: 'asc' },
          withExif: true, ...(cursor ? { cursor } : {}),
        }),
      }) as SearchResult;
      for (const a of data.assets.items) {
        if (a.isOffline || a.isTrashed || !['IMAGE', 'VIDEO'].includes(a.type)) continue;
        result.push({
          id: a.id, type: a.type as Media['type'], name: a.originalFileName,
          takenAt: a.fileCreatedAt, localDateTime: a.localDateTime ?? null, updatedAt: a.updatedAt, width: a.width, height: a.height,
          durationMs: a.duration, mimeType: a.originalMimeType ?? '', livePhotoVideoId: a.livePhotoVideoId ?? null,
          location: locationInfo(a.exifInfo),
        });
      }
      cursor = data.assets.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new HttpError(502, 'Immich repeated a pagination cursor. Try refreshing the library.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { albumId, media: result };
  }

  async media(id: string, kind: 'photo' | 'thumbnail' | 'video' | 'original', range: string | undefined, signal: AbortSignal) {
    if (!this.key) throw new HttpError(503, 'Immich API key is missing.');
    const path = kind === 'photo' ? `assets/${id}/thumbnail?size=fullsize`
      : kind === 'thumbnail' ? `assets/${id}/thumbnail?size=thumbnail`
      : kind === 'video' ? `assets/${id}/video/playback` : `assets/${id}/original`;
    let url = new URL(path, this.base);
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.fetcher(url, {
        redirect: 'manual', signal,
        headers: { 'x-api-key': this.key, ...(range ? { Range: range } : {}), 'Accept-Encoding': 'identity' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new HttpError(502, 'Immich returned an invalid media redirect.');
        url = new URL(location, url);
        if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw new HttpError(502, 'Immich redirected media outside its API.');
        if (kind === 'photo' && ['preview', 'thumbnail'].includes(url.searchParams.get('size') ?? '')) {
          throw new HttpError(422, 'Full-size photo unavailable. In Immich, enable full-size image generation, then use this photo’s Refresh thumbnails action or Administration → Jobs → Generate Thumbnails → All. The Missing job can skip existing HEIC/RAW files in Immich 3.3.5.');
        }
        continue;
      }
      if (!response.ok && response.status !== 416) {
        await response.body?.cancel();
        throw new HttpError(response.status === 404 ? 404 : 502, `Immich media request failed (HTTP ${response.status}).`);
      }
      return response;
    }
    throw new HttpError(502, 'Too many Immich media redirects.');
  }
}
