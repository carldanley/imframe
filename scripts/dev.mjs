import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const demo = process.argv.includes('--demo');
const children = [];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
};
const start = (args, env = process.env) => {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
  return child;
};
const env = demo ? {
  ...process.env, IMMICH_URL: 'http://127.0.0.1:3001', IMMICH_API_KEY: 'local-demo-key',
  DATA_DIR: './data/demo', IMFRAME_DEMO: '1',
} : process.env;
if (demo) {
  // The fixture server prints a ready marker before the API server is started.
  const { startDemo } = await import('./demo.mjs');
  const demoServer = await startDemo();
  process.on('exit', () => demoServer.close());
  process.once('SIGTERM', () => demoServer.close());
  process.once('SIGINT', () => demoServer.close());
}
start(['--env-file-if-exists=.env', '--import', 'tsx', '--watch', 'server/index.ts'], env);
start([resolve('node_modules/vite/bin/vite.js')]);
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
