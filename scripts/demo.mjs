import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asset = (n, type = 'IMAGE', live = false) => ({
  id: id(n), type, originalFileName: type === 'VIDEO' ? 'Demo video.mp4' : live ? 'Demo Live Photo' : `Demo photo ${n}`,
  originalMimeType: type === 'VIDEO' ? 'video/mp4' : 'image/svg+xml',
  fileCreatedAt: `2026-01-0${n}T12:00:00Z`, updatedAt: '2026-01-01T00:00:00Z',
  width: type === 'VIDEO' ? 640 : 3840, height: type === 'VIDEO' ? 360 : 2160,
  duration: type === 'VIDEO' ? 3000 : null, livePhotoVideoId: live ? id(9) : null,
  exifInfo: n === 5 ? null : { city: n === 4 ? 'Vancouver' : 'Juneau', state: n === 4 ? 'British Columbia' : 'Alaska', country: n === 4 ? 'Canada' : 'United States' },
  people: n === 5 ? [] : [
    { id: id(201), name: 'Alex', birthDate: '2020-06-10' },
    ...(n === 1 || n === 4 ? [{ id: id(202), name: 'Sam', birthDate: '2025-08-01' }] : []),
  ],
});
const albums = [
  { id: id(101), albumName: 'Demo · Everyday', assetCount: 3, albumThumbnailAssetId: id(1) },
  { id: id(102), albumName: 'Demo · Weekends', assetCount: 3, albumThumbnailAssetId: id(4) },
];
const media = new Map([[id(101), [asset(1), asset(2, 'IMAGE', true), asset(3, 'VIDEO')]], [id(102), [asset(1), asset(4), asset(5)]]]);

export async function startDemo() {
  const video = await readFile(new URL('../tests/fixtures/motion.mp4', import.meta.url));
  await mkdir('data/demo', { recursive: true });
  try { await readFile('data/demo/settings.json'); }
  catch {
    // Importing TypeScript is not needed in this development launcher.
    await writeFile('data/demo/settings.json', JSON.stringify({
      schemaVersion: 1, name: 'Demo frame', albumIds: albums.map(a => a.id), playbackMode: 'mixed',
      shuffleAlbums: false, mediaOrder: 'oldest', photoSeconds: 5, fit: 'contain', motion: 'random',
      zoomPercent: 8, transition: 'fade', transitionSeconds: 0.8, resolution: '4k', videoSource: 'original', livePhotos: true, refreshSeconds: 30,
      showLocation: true, locationCorner: 'bottom-left',
    }, null, 2));
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/server/version') return json({ major: 3, minor: 3, patch: 5 });
    if (req.headers['x-api-key'] !== 'local-demo-key') { res.writeHead(401); res.end(); return; }
    if (url.pathname === '/api/albums') return json(albums);
    if (url.pathname === '/api/search/metadata') {
      let body = ''; for await (const chunk of req) body += chunk;
      const album = JSON.parse(body).filter.albumIds.any[0];
      return json({ assets: { items: media.get(album) ?? [], nextCursor: null } });
    }
    const parts = url.pathname.split('/');
    if (parts[2] === 'assets') {
      if (parts[4] === 'original' || parts[4] === 'video') {
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = Math.min(range?.[2] ? Number(range[2]) : video.length - 1, video.length - 1);
        if (start >= video.length || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${video.length}` }); res.end(); return; }
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) });
        res.end(video.subarray(start, end + 1)); return;
      }
      const n = Number(parts[3].slice(-2));
      const colors = ['#b4bfa1', '#92adb7', '#bba789', '#8a9b77', '#a7b5bd', '#c6a294'];
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="3840" height="2160" viewBox="0 0 3840 2160"><rect width="3840" height="2160" fill="${colors[n % colors.length]}"/><circle cx="2800" cy="650" r="260" fill="#fff5d1"/><path d="M0 1650L950 650 1900 1800 3000 850 3840 1500V2160H0Z" fill="#364d3b"/><path d="M0 1980L1300 1350 2500 1950 3840 1450V2160H0Z" fill="#243e32"/><text x="180" y="260" fill="#fff" font-family="sans-serif" font-size="100">DEMO · PHOTO ${n}</text></svg>`); return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(3001, '127.0.0.1'); await once(server, 'listening');
  console.log('Generated demo library: http://127.0.0.1:3001');
  return server;
}
