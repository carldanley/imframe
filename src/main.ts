import './style.css';
import { showSettings } from './settings.js';
import { startPlayer } from './player.js';
import { api } from './api.js';

const root = document.querySelector<HTMLElement>('#app')!;
async function start() {
  const app = await api<{ mode: string }>('app');
  if (app.mode === 'hub') await (await import('./hub.js')).showHub(root);
  else await (location.pathname.startsWith('/frame') ? startPlayer : showSettings)(root);
}
void start().catch(error => {
  const message = document.createElement('p');
  message.className = 'fatal-error';
  message.textContent = `Could not start imframe: ${(error as Error).message}. Reload to try again.`;
  root.replaceChildren(message);
});
