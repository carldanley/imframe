import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Separate ports and data let Hub run alongside the existing satellite dev server.
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
const env = { ...process.env, IMFRAME_MODE: 'hub', PORT: process.env.HUB_PORT ?? '3002',
  API_PORT: process.env.HUB_PORT ?? '3002', VITE_PORT: process.env.HUB_VITE_PORT ?? '5174', DATA_DIR: process.env.HUB_DATA_DIR ?? './data/hub' };
for (const args of [['--import', 'tsx', '--watch', 'server/index.ts'], [resolve('node_modules/vite/bin/vite.js')]]) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
