import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVideoAperture, parseVideoAperture, playbackAperture } from '../shared/video-aperture.js';

function atom(type: string, ...parts: Uint8Array[]) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(type, 4);
  return Buffer.concat([header, body]);
}

function track({ rotation = 0, offsetX = 0, offsetY = 0, clap = true, denominator = 1, version = 0, enabled = true, pixelRatio = 1, terminator = true } = {}) {
  const tkhd = Buffer.alloc(version === 1 ? 96 : 84);
  tkhd[0] = version; tkhd[3] = enabled ? 3 : 0;
  const matrices = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [0, -1, 1, 0]];
  const matrix = matrices[rotation / 90]!;
  const at = version === 1 ? 52 : 40;
  [0, 4, 12, 16].forEach((offset, i) => tkhd.writeInt32BE(matrix[i]! * 65536, at + offset));
  tkhd.writeInt32BE(1 << 30, at + 32);
  const hdlr = Buffer.alloc(12); hdlr.write('vide', 8);
  const sample = Buffer.alloc(78); sample.writeUInt16BE(1920, 24); sample.writeUInt16BE(1440, 26);
  const aperture = Buffer.alloc(32);
  [1744, denominator, 1308, 1, offsetX, 1, offsetY, 1].forEach((value, i) => aperture.writeInt32BE(value, i * 4));
  const pasp = Buffer.alloc(8); pasp.writeUInt32BE(pixelRatio, 0); pasp.writeUInt32BE(1, 4);
  const stsd = Buffer.alloc(8); stsd.writeUInt32BE(1, 4);
  return atom('trak', atom('tkhd', tkhd), atom('mdia', atom('hdlr', hdlr), atom('minf', atom('stbl', atom('stsd', stsd,
    atom('hvc1', sample, atom('pasp', pasp), ...(clap ? [atom('clap', aperture)] : []), ...(terminator ? [Buffer.alloc(4)] : [])))))));
}

test('Live Photo padding uses its declared aperture, including rotated and offset pictures', () => {
  const expected = [
    { sourceWidth: 1920, sourceHeight: 1440, x: 98, y: 46, width: 1744, height: 1308 },
    { sourceWidth: 1440, sourceHeight: 1920, x: 86, y: 98, width: 1308, height: 1744 },
    { sourceWidth: 1920, sourceHeight: 1440, x: 78, y: 86, width: 1744, height: 1308 },
    { sourceWidth: 1440, sourceHeight: 1920, x: 46, y: 78, width: 1308, height: 1744 },
  ];
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(parseVideoAperture(atom('moov', track({ rotation: i * 90, offsetX: 10, offsetY: -20, version: i % 2, terminator: i % 2 === 0 }))), expected[i]);
  }
  assert.deepEqual(parseVideoAperture(atom('moov', track({ pixelRatio: 2 }))),
    { sourceWidth: 3840, sourceHeight: 1440, x: 176, y: 66, width: 3488, height: 1308 });
});

test('missing or invalid aperture metadata never invents a crop or borrows one from an auxiliary track', () => {
  const plain = atom('moov', track({ clap: false }), track());
  assert.equal(parseVideoAperture(plain), null);
  assert.equal(parseVideoAperture(atom('moov', track({ denominator: 0 }))), null);
  assert.equal(parseVideoAperture(atom('moov', track({ offsetX: 500 }))), null);
  const valid = atom('moov', track());
  assert.equal(parseVideoAperture(valid.subarray(0, -1)), null);
  assert.equal(parseVideoAperture(new Uint8Array()), null);
  assert.deepEqual(parseVideoAperture(atom('moov', track({ enabled: false }), track({ rotation: 90 }))),
    { sourceWidth: 1440, sourceHeight: 1920, x: 66, y: 88, width: 1308, height: 1744 });
});

test('already-cropped or resized browser video is not cropped a second time', () => {
  const aperture = parseVideoAperture(atom('moov', track({ rotation: 90 })))!;
  assert.equal(playbackAperture(aperture, 1440, 1920), aperture);
  assert.equal(playbackAperture(aperture, 1308, 1744), null);
  assert.equal(playbackAperture(aperture, 720, 960), null);
  assert.equal(playbackAperture(aperture, 1920, 1440), null);
  assert.equal(playbackAperture({ ...aperture, x: 0, y: 0, width: 1440, height: 1920 }, 1440, 1920), null);
});

test('metadata ranges skip large video payloads, including 64-bit mdat atoms', async () => {
  const ftyp = atom('ftyp', Buffer.from('qt  \0\0\0\0qt  ', 'binary'));
  const mdatSize = 5 * 1024 ** 3; // Sparse fixture: never allocate or fetch the 5 GiB payload.
  const mdat = Buffer.alloc(16); mdat.writeUInt32BE(1); mdat.write('mdat', 4); mdat.writeBigUInt64BE(BigInt(mdatSize), 8);
  const moov = atom('moov', track({ rotation: 90 }));
  const moovStart = ftyp.length + mdatSize, total = moovStart + moov.length;
  const requests: [number, number][] = [];
  const fetcher = (async (_url, init) => {
    const range = new Headers(init?.headers).get('range')!.match(/^bytes=(\d+)-(\d+)$/)!;
    const start = Number(range[1]), end = Math.min(Number(range[2]), total - 1);
    requests.push([start, end]);
    const data = Buffer.alloc(end - start + 1);
    if (start === 0) { ftyp.copy(data); mdat.copy(data, ftyp.length); }
    else { assert.equal(start, moovStart); moov.copy(data); }
    return new Response(data, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${total}` } });
  }) as typeof fetch;
  assert.deepEqual(await loadVideoAperture('/video', new AbortController().signal, fetcher),
    { sourceWidth: 1440, sourceHeight: 1920, x: 66, y: 88, width: 1308, height: 1744 });
  assert.equal(requests.length, 2);
  assert.ok(requests.reduce((sum, [start, end]) => sum + end - start + 1, 0) < 128 * 1024);
});

test('range failures and cancellation leave playback available without downloading the whole movie', async () => {
  let cancelled = false;
  const ignoredRange = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as typeof fetch;
  assert.equal(await loadVideoAperture('/video', new AbortController().signal, ignoredRange), null);
  assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort();
  assert.equal(await loadVideoAperture('/video', controller.signal, (async () => { throw new Error('Must not fetch an aborted preload.'); }) as typeof fetch), null);
  const malformed = (async () => new Response(Buffer.from('garbage!'), { status: 206, headers: { 'Content-Range': 'bytes 0-7/8' } })) as typeof fetch;
  assert.equal(await loadVideoAperture('/video', new AbortController().signal, malformed), null);
});
