/** QuickTime's clean aperture excludes camera padding outside the intended picture.
 * https://developer.apple.com/documentation/quicktime-file-format/clean_aperture
 * Coordinates below include the track's orientation and pixel aspect ratio.
 */
export interface VideoAperture {
  sourceWidth: number;
  sourceHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Box { type: string; body: number; end: number }
const fourcc = (view: DataView, at: number) => String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(at + i)));

function boxes(view: DataView, start: number, end: number, sampleExtensions = false): Box[] {
  const result: Box[] = [];
  for (let at = start; at < end;) {
    // QuickTime sample descriptions may end with a four-byte zero terminator.
    if (sampleExtensions && end - at === 4 && view.getUint32(at) === 0) break;
    if (end - at < 8) throw new Error('Incomplete movie atom.');
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(at + 8)); header = 16; }
    else if (size === 0) size = end - at;
    if (!Number.isSafeInteger(size) || size < header || at + size > end) throw new Error('Invalid movie atom.');
    result.push({ type: fourcc(view, at + 4), body: at + header, end: at + size });
    at += size;
  }
  return result;
}

/** Parse only the movie metadata atom, never the compressed video payload. */
export function parseVideoAperture(bytes: Uint8Array): VideoAperture | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const child = (parent: Box | undefined, type: string) => parent && boxes(view, parent.body, parent.end).find(box => box.type === type);
    const movie = boxes(view, 0, view.byteLength).find(box => box.type === 'moov');
    if (!movie) return null;
    for (const track of boxes(view, movie.body, movie.end).filter(box => box.type === 'trak')) {
      const header = child(track, 'tkhd');
      const media = child(track, 'mdia');
      const handler = child(media, 'hdlr');
      if (!header || !handler || handler.end - handler.body < 12 || fourcc(view, handler.body + 8) !== 'vide') continue;
      if (!(view.getUint8(header.body + 3) & 1)) continue; // Ignore disabled auxiliary/depth tracks.
      const description = child(child(child(media, 'minf'), 'stbl'), 'stsd');
      if (!description || description.end - description.body < 8 || view.getUint32(description.body + 4) !== 1) return null;
      const sample = boxes(view, description.body + 8, description.end)[0];
      if (!sample || !['hvc1', 'hev1', 'avc1', 'avc3', 'mp4v', 'jpeg'].includes(sample.type) || sample.end - sample.body < 78) return null;
      const width = view.getUint16(sample.body + 24), height = view.getUint16(sample.body + 26);
      const extensions = boxes(view, sample.body + 78, sample.end, true);
      const clap = extensions.find(box => box.type === 'clap');
      if (!clap || clap.end - clap.body !== 32 || !width || !height) return null;
      const fraction = (offset: number) => {
        const denominator = view.getInt32(clap.body + offset + 4);
        if (denominator <= 0) throw new Error('Invalid aperture fraction.');
        return view.getInt32(clap.body + offset) / denominator;
      };
      const cleanWidth = fraction(0), cleanHeight = fraction(8);
      const left = (width - cleanWidth) / 2 + fraction(16);
      const top = (height - cleanHeight) / 2 + fraction(24);
      if (cleanWidth <= 0 || cleanHeight <= 0 || left < 0 || top < 0 || left + cleanWidth > width || top + cleanHeight > height) return null;
      const pasp = extensions.find(box => box.type === 'pasp');
      const pixelRatio = pasp && pasp.end - pasp.body === 8 ? view.getUint32(pasp.body) / view.getUint32(pasp.body + 4) : 1;
      if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) return null;
      const version = view.getUint8(header.body);
      if (version > 1) return null;
      const matrix = header.body + (version === 1 ? 52 : 40);
      if (matrix + 36 > header.end) return null;
      const a = view.getInt32(matrix) / 65536, b = view.getInt32(matrix + 4) / 65536;
      const c = view.getInt32(matrix + 12) / 65536, d = view.getInt32(matrix + 16) / 65536;
      // Camera orientations are quarter turns, optionally mirrored. Don't guess at arbitrary transforms.
      if (![a, b, c, d].every(n => [-1, 0, 1].includes(n)) || a * a + b * b !== 1 || c * c + d * d !== 1 || a * c + b * d !== 0) return null;
      const bounds = (x: number, y: number, w: number, h: number) => {
        const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
        const xs = corners.map(([px, py]) => a * px! * pixelRatio + c * py!);
        const ys = corners.map(([px, py]) => b * px! * pixelRatio + d * py!);
        return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      };
      const source = bounds(0, 0, width, height), clean = bounds(left, top, cleanWidth, cleanHeight);
      return { sourceWidth: source.width, sourceHeight: source.height, x: clean.x - source.x, y: clean.y - source.y, width: clean.width, height: clean.height };
    }
  } catch { /* Missing, malformed, or unsupported metadata leaves the video unchanged. */ }
  return null;
}

/** Some browsers/renditions already honor the aperture. Never crop those a second time. */
export function playbackAperture(aperture: VideoAperture | null, width: number, height: number): VideoAperture | null {
  if (!aperture || Math.abs(aperture.sourceWidth - width) > 0.5 || Math.abs(aperture.sourceHeight - height) > 0.5) return null;
  return aperture.width < aperture.sourceWidth || aperture.height < aperture.sourceHeight ? aperture : null;
}

/** Read bounded HTTP ranges so a large mdat before moov never causes a second video download. */
export async function loadVideoAperture(url: string, cancel: AbortSignal, fetcher: typeof fetch = fetch): Promise<VideoAperture | null> {
  const controller = new AbortController();
  const signal = AbortSignal.any([cancel, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 5_000);
  const limit = 4 * 1024 * 1024;
  let cached = new Uint8Array(0), cachedStart = 0, fileSize: number | undefined;
  try {
    async function read(start: number, length: number): Promise<Uint8Array> {
      signal.throwIfAborted();
      if (length > limit || length < 8 || (fileSize !== undefined && start + length > fileSize)) throw new Error('Invalid metadata size.');
      if (start >= cachedStart && start + length <= cachedStart + cached.length) return cached.subarray(start - cachedStart, start - cachedStart + length);
      const end = Math.min(start + Math.max(length, 65536), fileSize ?? Infinity) - 1;
      const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (response.status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) > end) {
        await response.body?.cancel();
        throw new Error('Video metadata ranges are unavailable.');
      }
      const total = Number(range[3]);
      if (!Number.isSafeInteger(total) || total <= Number(range[2]) || (fileSize !== undefined && total !== fileSize)) {
        await response.body?.cancel(); throw new Error('Invalid video range.');
      }
      fileSize = total;
      cached = new Uint8Array(await response.arrayBuffer());
      cachedStart = start;
      if (cached.length !== Number(range[2]) - start + 1 || cached.length < length) throw new Error('Incomplete video range.');
      return cached.subarray(0, length);
    }
    for (let at = 0, count = 0; count < 32; count++) {
      if (fileSize !== undefined && at + 8 > fileSize) break;
      const head = await read(at, 8);
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const type = fourcc(view, 4);
      let size = view.getUint32(0), headerSize = 8;
      if (size === 1) {
        const extended = await read(at, 16);
        size = Number(new DataView(extended.buffer, extended.byteOffset, extended.byteLength).getBigUint64(8));
        headerSize = 16;
      } else if (size === 0) size = fileSize! - at;
      if (!Number.isSafeInteger(size) || size < headerSize || at + size > fileSize!) break;
      if (type === 'moov') return parseVideoAperture(await read(at, size));
      at += size;
    }
  } catch { /* Optional framing metadata must not make otherwise playable media fail. */ }
  finally { clearTimeout(timer); }
  return null;
}
