import './style.css';
import { showSettings } from './settings.js';
import { startPlayer } from './player.js';

const root = document.querySelector<HTMLElement>('#app')!;
const start = location.pathname.startsWith('/frame') ? startPlayer : showSettings;
void start(root).catch(error => {
  const message = document.createElement('p');
  message.className = 'fatal-error';
  message.textContent = `Could not start imframe: ${(error as Error).message}. Reload to try again.`;
  root.replaceChildren(message);
});
