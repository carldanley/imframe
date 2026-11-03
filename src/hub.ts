import { newId } from '../shared/id.js';
import { api, escapeHtml as e } from './api.js';
import { defaults, type Album, type FrameSettings } from '../shared/model.js';
import { displayMessage } from '../shared/display.js';
import type { HubState, PlaybackAction, SatelliteRecord } from '../shared/satellite.js';
import './hub.css';

const glyphs: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>', back: '<path d="m14 6-6 6 6 6"/>',
  previous: '<path d="M5 5v14m14-14L7 12l12 7Z"/>', next: '<path d="M19 5v14M5 5l12 7-12 7Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>', resume: '<path d="m7 4 14 8-14 8Z"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  frame: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 16 6-6 5 5 3-3 4 4"/><circle cx="16" cy="8" r="1"/>',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] ?? glyphs.frame}</svg>`;
const corners = [['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right'], ['top-left', 'Top left'], ['top-right', 'Top right']];
const numbers = new Set(Object.entries(defaults).filter(([, value]) => typeof value === 'number').map(([key]) => key));

  const path = (id: string, suffix: string) => `hub/satellites/${id}/${suffix}`;
  const asleep = (s: SatelliteRecord) => s.snapshot.display?.connected && s.snapshot.display.sleeping === true;
  const online = (s: SatelliteRecord) => !s.error && !asleep(s) && s.snapshot.playerOnline && Date.now() - Date.parse(s.lastSeenAt) < 15_000;
  const status = (s: SatelliteRecord) => s.error ? 'Offline' : asleep(s) ? 'Sleeping' : !s.snapshot.playerOnline ? 'Player offline' : s.snapshot.playback?.paused ? 'Paused' : 'Playing';

export async function showHub(root: HTMLElement) {
  document.body.classList.add('hub-page'); document.title = 'Hub · imframe';
  let state = await api<HubState>('hub');
  let selected: string | null = null;
  let tab = 'albums';
  let hubSettings = false;
  let albums: Album[] | null = null;
  let albumError = '';
  let query = '';
  let stopped = false;
  let polling = false;
  const busy = new Set<string>();
  const optimistic = new Map<string, Partial<FrameSettings>>();
  const drafts = new Map<string, Partial<FrameSettings>>();
  const saves = new Map<string, Promise<void>>();
  const previewTimes = new Map<string, number>();
  const previewUrls = new Map<string, string>();
  const previewBusy = new Set<string>();
  const record = (id = selected) => state.satellites.find(s => s.id === id);
  const settings = () => ({ ...defaults, ...record()!.snapshot.settings, ...record()!.pendingSettings, ...optimistic.get(selected!) });
  root.innerHTML = `<main class="hub-shell"><header class="hub-header"><button class="hub-brand" data-action="home" aria-label="Hub home"><img src="/hub-icon.webp" alt=""/><span>hub<small>BY IMFRAME</small></span></button><button class="hub-icon-button" data-action="hub-settings" aria-label="Hub settings">${icon('settings')}</button></header><div id="hub-content"></div><p class="hub-toast" role="status" hidden></p><dialog class="hub-dialog" aria-labelledby="add-title"></dialog></main>`;
  const content = root.querySelector<HTMLElement>('#hub-content')!;
  const toast = root.querySelector<HTMLElement>('.hub-toast')!;
  const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
  let toastTimer = 0;
  function notice(text: string, error = false) { clearTimeout(toastTimer); toast.textContent = text; toast.hidden = !text; toast.classList.toggle('is-error', error); if (!error) toastTimer = window.setTimeout(() => { toast.hidden = true; }, 6000); }
  function update(item: SatelliteRecord) { state.satellites = state.satellites.map(s => s.id === item.id ? item : s); }

  function transport(s: SatelliteRecord) {
    const paused = s.snapshot.playback?.paused;
    return `<div class="hub-transport" data-transport="${s.id}" data-transport-state="${paused}:${busy.has(s.id)}:${online(s)}:${e(s.snapshot.name)}">${(['previous', paused ? 'resume' : 'pause', 'next'] as const).map(action => `<button class="hub-icon-button ${action === 'pause' || action === 'resume' ? 'hub-play' : ''}" data-command="${action}" data-id="${s.id}" aria-label="${action === 'resume' ? 'Resume' : action[0]!.toUpperCase() + action.slice(1)} ${e(s.snapshot.name)}" ${!online(s) || busy.has(s.id) ? 'disabled' : ''}>${icon(action)}</button>`).join('')}</div>`;
  }
  function preview(s: SatelliteRecord, detail = false) {
    const viewport = s.snapshot.playback?.viewport;
    const ratio = detail && viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.height > 0 ? `${viewport.width}/${viewport.height}` : '16/10';
    return `<div class="hub-preview ${detail ? 'hub-preview-large' : ''}" style="--preview-ratio:${ratio}" data-preview="${s.id}"><span class="hub-preview-placeholder" ${previewUrls.has(s.id) ? 'hidden' : ''}>${icon('frame')}<span>Waiting for the frame</span></span><img alt="Current view on ${e(s.snapshot.name)}" ${previewUrls.has(s.id) ? `src="${previewUrls.get(s.id)}"` : 'hidden'} /><span class="hub-preview-status">${asleep(s) ? 'Sleeping · last view' : !online(s) ? 'Last view' : 'Live view · updates every 2s'}</span></div>`;
  }
  function field(key: keyof FrameSettings, label: string, options?: string[][], min?: number, max?: number, step = 1) {
    const value = settings()[key];
    const type = key === 'sleepStart' || key === 'sleepEnd' ? 'time' : typeof value === 'number' ? 'number' : 'text';
    return `<label class="hub-field"><span>${label}</span>${options ? `<select name="${key}">${options.map(([id, text]) => `<option value="${id}" ${String(value) === id ? 'selected' : ''}>${text}</option>`).join('')}</select>` : `<input name="${key}" type="${type}" value="${e(String(value))}" ${min === undefined ? '' : `min="${min}" max="${max}" step="${step}"`} ${key === 'name' ? 'maxlength="80"' : ''} required/>`}</label>`;
  }
  function toggle(key: keyof FrameSettings, label: string, hint = '') {
    return `<label class="hub-toggle"><span><strong>${label}</strong>${hint ? `<small>${hint}</small>` : ''}</span><input name="${key}" type="checkbox" ${settings()[key] ? 'checked' : ''}/><i aria-hidden="true"></i></label>`;
  }
  function albumList() {
    if (!albums) return `<p class="hub-muted">${e(albumError || 'Loading albums…')}</p>`;
    const s = settings();
    const visible = albums.filter(a => a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return visible.map(album => `<label class="hub-album ${s.albumIds.includes(album.id) ? 'is-selected' : ''}"><input type="checkbox" data-album="${album.id}" ${s.albumIds.includes(album.id) ? 'checked' : ''}/><span class="hub-album-art">${album.thumbnailId ? `<img src="/api/${path(selected!, `media/${album.thumbnailId}/thumbnail`)}" alt="" loading="lazy"/>` : icon('frame')}</span><span><strong>${e(album.name)}</strong><small>${album.count.toLocaleString()} items</small></span><i aria-hidden="true">✓</i></label>`).join('') || '<p class="hub-muted">No albums found. Add or share albums in Immich, then refresh.</p>';
  }
  function editor() {
    const s = settings();
    if (tab === 'albums') return `<div class="hub-section-title"><h2>Choose your albums</h2><button class="hub-text-button" data-action="refresh-albums" type="button">Refresh</button></div><p class="hub-muted">New photos and videos appear automatically.</p><input class="hub-search" type="search" placeholder="Find an album" aria-label="Find an album" value="${e(query)}"/><div class="hub-albums">${albumList()}</div><p class="hub-selection">${s.albumIds.length} ${s.albumIds.length === 1 ? 'album' : 'albums'} selected</p><div class="hub-fields">${field('playbackMode', 'Play albums', [['mixed', 'Mix them together'], ['albums', 'One album at a time']])}${field('mediaOrder', 'Media order', [['shuffle', 'Shuffle'], ['oldest', 'Oldest first'], ['newest', 'Newest first']])}</div><div data-dep="album-order" ${s.playbackMode !== 'albums' ? 'hidden' : ''}>${toggle('shuffleAlbums', 'Shuffle album order')}<details><summary>Album order</summary><ol class="hub-order">${s.albumIds.map((id, i) => `<li><span>${e(albums?.find(a => a.id === id)?.name ?? 'Unavailable album')}</span><button type="button" data-move="${id}" data-direction="-1" aria-label="Move album up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="${id}" data-direction="1" aria-label="Move album down" ${i === s.albumIds.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-remove-album="${id}" aria-label="Remove album">×</button></li>`).join('')}</ol></details></div>`;
    if (tab === 'style') return `<h2>Make it yours</h2><div class="hub-fields">${field('photoSeconds', 'Seconds per photo', undefined, 3, 300)}${field('fit', 'Picture fit', [['contain', 'Show the whole picture'], ['cover', 'Fill the screen']])}</div><p class="hub-muted">Videos finish playing. Live Photos play, then stay for the full photo time.</p><div class="hub-fields">${field('motion', 'Photo motion', [['none', 'Still'], ['in', 'Slow zoom in'], ['out', 'Slow zoom out'], ['random', 'Random pan & zoom']])}${field('transition', 'Transition', [['fade', 'Fade'], ['slide', 'Slide'], ['cut', 'Instant'], ['random', 'Random']])}</div><details><summary>Motion & transition details</summary><div class="hub-fields">${field('zoomPercent', 'Zoom percent', undefined, 1, 20)}${field('transitionSeconds', 'Transition seconds', undefined, .2, 3, .1)}</div></details><div class="hub-divider"></div>${toggle('showLocation', 'Show location', 'Place names from your photos')}${toggle('showDate', 'Show date taken', 'Always MM.DD.YY')}<details><summary>Caption positions</summary><div class="hub-fields">${field('locationCorner', 'Location', corners)}${field('dateCorner', 'Date taken', corners)}</div></details><div class="hub-divider"></div>${field('progressStyle', 'Media countdown', [['off', 'Off'], ['bar', 'Edge bar'], ['ring', 'Circular countdown']])}<div data-dep="ring" ${s.progressStyle !== 'ring' ? 'hidden' : ''}>${field('progressCorner', 'Countdown corner', corners)}</div><div data-dep="bar" ${s.progressStyle !== 'bar' ? 'hidden' : ''}>${field('progressPosition', 'Countdown edge', [['bottom', 'Bottom'], ['top', 'Top'], ['left', 'Left'], ['right', 'Right']])}</div>`;
    const item = record()!;
    if (tab === 'sleep') return `<h2>Sleep hours</h2><p class="hub-muted">Choose when the screen sleeps and wakes each day.</p><fieldset class="hub-sleep-controls" ${item.snapshot.display ? '' : 'disabled'}>${toggle('sleepEnabled', 'Sleep on a schedule', 'Turn off the screen during these hours')}<div class="hub-fields">${field('sleepStart', 'Sleep at')}${field('sleepEnd', 'Wake at')}</div></fieldset><p class="hub-muted" data-display-status>${e(displayMessage(item.snapshot.display))}</p><p class="hub-muted">The schedule stays on the Pi, so it still wakes when Hub is unavailable. Turn off the schedule to wake the screen early.</p>`;
    const agent = item.snapshot.update.agentSeenAt && Date.now() - Date.parse(item.snapshot.update.agentSeenAt) < 180_000;
    const result = item.snapshot.update.result;
    return `<h2>Advanced settings</h2>${field('name', 'Frame name')}<div class="hub-fields">${field('resolution', 'Display target', [['4k', '4K'], ['1080p', '1080p']])}${field('videoSource', 'Video source', [['original', 'Original quality'], ['immich', 'Immich playback copy']])}</div><p class="hub-muted">Photos stay full size. The display target checks detail; it does not change your monitor’s resolution.</p>${toggle('livePhotos', 'Play Live Photo motion')}<div class="hub-fields">${field('preloadCount', 'Preload ahead', undefined, 1, 5)}${field('preloadMegabytes', 'Download cache', [['128', '128 MB'], ['256', '256 MB'], ['512', '512 MB'], ['1024', '1 GB']])}</div>${field('refreshSeconds', 'Check albums every (seconds)', undefined, 15, 3600)}<div class="hub-divider"></div><h3>Frame software</h3><p class="hub-muted" data-update-status>Version ${e(item.snapshot.version)}${result ? ` · ${e(result.message || result.state)}` : ''}</p><button class="hub-button" type="button" data-action="update" ${!agent || busy.has(item.id) ? 'disabled' : ''}>Check for an update</button><p class="hub-muted">${agent ? 'Settings apply live. A software update briefly reloads the frame.' : 'Run the latest Pi setup script once to enable updates from Hub.'}</p><details><summary>Connection</summary><p class="hub-muted">${e(item.address)}</p><a class="hub-text-button" href="${e(item.address)}" target="_blank" rel="noopener">Open this frame directly ↗</a></details><button class="hub-text-button hub-danger" type="button" data-action="remove">Remove from Hub</button>`;
  }
  function render() {
    const focused = document.activeElement as HTMLInputElement | null;
    const focusName = focused?.name;
    const albumFocus = focused?.dataset.album;
    const scroll = content.querySelector('.hub-albums')?.scrollTop ?? 0;
    if (hubSettings) {
      content.innerHTML = `<button class="hub-text-button hub-back" data-action="home">${icon('back')} Your Frames</button><div class="hub-page-title"><h1>Hub settings</h1></div><section class="hub-panel hub-preferences"><h2>Frame updates</h2><p class="hub-muted">Hub asks each frame’s Pi updater to check its configured container tag. Your photos and settings stay on the frame.</p><label class="hub-field">Update policy<select id="hub-policy"><option value="manual" ${state.updatePolicy === 'manual' ? 'selected' : ''}>When I ask</option><option value="automatic" ${state.updatePolicy === 'automatic' ? 'selected' : ''}>Automatically, once a day</option></select></label><p class="hub-muted">Automatic updates run one frame at a time. Frames keep playing if Hub is unavailable.</p><div class="hub-divider"></div><h2>On your home screen</h2><div class="hub-home-icon"><img src="/hub-icon.webp" alt="Hub icon"/><p>On iPhone, open Hub in Safari, tap Share, then Add to Home Screen.</p></div></section>`;
    } else if (!selected || !record()) {
      selected = null;
      content.innerHTML = `<div class="hub-page-title"><h1>Your Frames</h1><button class="hub-button hub-primary" data-action="add">${icon('plus')} Add Frame</button></div>${!state.satellites.length ? '<section class="hub-empty"><h2>Your frames, in one place.</h2><p>Add a frame using its IP address to get started.</p><button class="hub-button hub-primary" data-action="add">Add Frame</button></section>' : `<div class="hub-grid">${state.satellites.map(s => `<article class="hub-card" data-card="${s.id}"><button class="hub-preview-link" data-open="${s.id}" aria-label="Customize ${e(s.snapshot.name)}">${preview(s)}</button><div class="hub-card-body"><div class="hub-card-title"><h2 data-name="${s.id}">${e(s.snapshot.name)}</h2><span class="hub-status" data-status="${s.id}">${status(s)}</span></div><p class="hub-muted" data-count="${s.id}">${s.snapshot.settings.albumIds.length} albums selected</p><div class="hub-card-actions">${transport(s)}<button class="hub-button" data-open="${s.id}">Customize</button></div></div></article>`).join('')}</div>`}`;
    } else {
      const s = record()!;
      content.innerHTML = `<button class="hub-text-button hub-back" data-action="home">${icon('back')} Your Frames</button><div class="hub-page-title"><h1 data-name="${s.id}">${e(s.snapshot.name)}</h1><span class="hub-status" data-status="${s.id}">${status(s)}</span></div><div class="hub-detail"><section class="hub-view">${preview(s, true)}${transport(s)}<p class="hub-muted hub-preview-note">This is the view reported by your frame, refreshed every two seconds.</p></section><section class="hub-panel"><nav class="hub-tabs" aria-label="Frame settings">${['albums', 'style', 'sleep', 'advanced'].map(t => `<button data-tab="${t}" aria-current="${tab === t ? 'page' : 'false'}">${t[0]!.toUpperCase() + t.slice(1)}</button>`).join('')}</nav><form class="hub-form">${editor()}</form><p class="hub-save-status" role="status">${s.pendingSettings ? 'Saved in Hub · waiting for frame' : 'Changes save automatically'}</p></section></div>`;
    }
    const list = content.querySelector('.hub-albums'); if (list) list.scrollTop = scroll;
    if (focusName) content.querySelector<HTMLInputElement>(`[name="${CSS.escape(focusName)}"]`)?.focus({ preventScroll: true });
    if (albumFocus) content.querySelector<HTMLInputElement>(`[data-album="${CSS.escape(albumFocus)}"]`)?.focus({ preventScroll: true });
    content.querySelector('form')?.addEventListener('submit', event => event.preventDefault());
    void previews();
  }
  function liveText() {
    for (const s of state.satellites) {
      root.querySelectorAll(`[data-name="${s.id}"]`).forEach(node => { node.textContent = s.snapshot.name; });
      root.querySelectorAll(`[data-status="${s.id}"]`).forEach(node => { node.textContent = status(s); node.classList.toggle('is-offline', !online(s)); });
      const count = root.querySelector(`[data-count="${s.id}"]`); if (count) count.textContent = `${s.snapshot.settings.albumIds.length} albums selected`;
      root.querySelectorAll<HTMLElement>(`[data-transport="${s.id}"]`).forEach(node => {
        if (node.dataset.transportState !== `${s.snapshot.playback?.paused}:${busy.has(s.id)}:${online(s)}:${s.snapshot.name}`) node.outerHTML = transport(s);
      });
      const label = root.querySelector(`[data-preview="${s.id}"] .hub-preview-status`);
      if (label) label.textContent = asleep(s) ? 'Sleeping · last view' : !online(s) ? 'Last view · frame offline' : Date.now() - (previewTimes.get(s.id) ?? 0) > 6000 ? 'Waiting for a fresh view' : 'Live view · updates every 2s';
    }
    if (selected && record() && !saves.has(selected) && !drafts.has(selected)) {
      const s = settings();
      for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.hub-form [name]')) {
        if (input === document.activeElement) continue;
        const value = s[input.name as keyof FrameSettings];
        if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = value as boolean;
        else input.value = String(value);
      }
      for (const checkbox of root.querySelectorAll<HTMLInputElement>('[data-album]')) {
        checkbox.checked = s.albumIds.includes(checkbox.dataset.album!);
        checkbox.closest('.hub-album')?.classList.toggle('is-selected', checkbox.checked);
      }
      const selection = root.querySelector('.hub-selection'); if (selection) selection.textContent = `${s.albumIds.length} ${s.albumIds.length === 1 ? 'album' : 'albums'} selected`;
      for (const [key, visible] of [['album-order', s.playbackMode === 'albums'], ['ring', s.progressStyle === 'ring'], ['bar', s.progressStyle === 'bar']] as const) {
        const target = root.querySelector<HTMLElement>(`[data-dep="${key}"]`); if (target) target.hidden = !visible;
      }
      const updateStatus = root.querySelector('[data-update-status]');
      const remote = record()!.snapshot;
      const displayStatus = root.querySelector('[data-display-status]');
      if (displayStatus) displayStatus.textContent = displayMessage(remote.display);
      const sleepControls = root.querySelector<HTMLFieldSetElement>('.hub-sleep-controls');
      if (sleepControls) sleepControls.disabled = !remote.display;
      if (updateStatus) updateStatus.textContent = `Version ${remote.version}${remote.update.result ? ` · ${remote.update.result.message || remote.update.result.state}` : ''}`;
      const updateButton = root.querySelector<HTMLButtonElement>('[data-action="update"]');
      if (updateButton) updateButton.disabled = !remote.update.agentSeenAt || Date.now() - Date.parse(remote.update.agentSeenAt) > 180_000 || busy.has(selected);
      const savedStatus = root.querySelector('.hub-save-status'); if (savedStatus) savedStatus.textContent = record()!.pendingSettings ? 'Saved in Hub · waiting for frame' : 'Saved on frame';
    }
  }
  async function previews() {
    if (document.hidden) return;
    for (const node of root.querySelectorAll<HTMLElement>('[data-preview]')) {
      const id = node.dataset.preview!;
      if (previewBusy.has(id) || record(id)?.error || (record(id) && asleep(record(id)!))) continue;
      previewBusy.add(id);
      void fetch(`/api/${path(id, 'preview')}`, { signal: AbortSignal.timeout(5000) }).then(async response => {
        if (!response.ok || response.status === 204 || !response.headers.get('content-type')?.startsWith('image/')) return;
        const url = URL.createObjectURL(await response.blob());
        const old = previewUrls.get(id); previewUrls.set(id, url);
        previewTimes.set(id, Number(response.headers.get('x-imframe-preview-at')) || 0);
        const current = root.querySelector<HTMLImageElement>(`[data-preview="${id}"] > img`);
        if (current) { current.src = url; current.hidden = false; const placeholder = current.parentElement?.querySelector<HTMLElement>('.hub-preview-placeholder'); if (placeholder) placeholder.hidden = true; }
        if (old) URL.revokeObjectURL(old);
      }).catch(() => {}).finally(() => previewBusy.delete(id));
    }
  }
  async function loadAlbums() {
    const id = selected!;
    albumError = '';
    try { const result = await api<Album[]>(path(id, 'albums')); if (id === selected) albums = result.toSorted((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { if (id === selected) { albumError = (error as Error).message; notice(albumError, true); } }
    if (id === selected && tab === 'albums') render();
  }
  function save(patch: Partial<FrameSettings>) {
    const id = selected!;
    drafts.set(id, { ...drafts.get(id), ...patch });
    optimistic.set(id, { ...optimistic.get(id), ...patch });
    const target = root.querySelector('.hub-save-status'); if (target) target.textContent = 'Saving…';
    const before = saves.get(id) ?? Promise.resolve();
    const work = before.then(async () => {
      const changes = drafts.get(id);
      if (!changes) return;
      drafts.delete(id);
      try {
        const result = await api<SatelliteRecord>(path(id, 'settings'), { method: 'PATCH', body: JSON.stringify(changes) });
        update(result);
        const remaining = { ...optimistic.get(id) } as Record<string, unknown>;
        for (const [key, value] of Object.entries(changes)) if (JSON.stringify(remaining[key]) === JSON.stringify(value)) delete remaining[key];
        if (Object.keys(remaining).length) optimistic.set(id, remaining); else optimistic.delete(id);
        if (selected === id) { const label = root.querySelector('.hub-save-status'); if (label) label.textContent = result.pendingSettings ? 'Saved in Hub · waiting for frame' : 'Saved on frame'; }
      } catch (error) { drafts.set(id, { ...changes, ...drafts.get(id) }); notice(`Could not save: ${(error as Error).message}`, true); }
    });
    saves.set(id, work);
    void work.finally(() => { if (saves.get(id) === work) saves.delete(id); liveText(); });
  }
  async function control(id: string, action: PlaybackAction) {
    if (busy.has(id)) return;
    busy.add(id); liveText(); notice('');
    try { await api(path(id, 'commands'), { method: 'POST', body: JSON.stringify({ id: newId(), action }) }); await poll(); }
    catch (error) { notice((error as Error).message, true); }
    finally { busy.delete(id); liveText(); }
  }
  function addDialog() {
    dialog.innerHTML = `<form id="hub-add-form"><h2 id="add-title">Add Frame</h2><p class="hub-muted">Enter its IP address. Hub reads the name already set on the frame.</p><label class="hub-field">Frame address<input name="address" placeholder="frame.local:3000" inputmode="url" autocomplete="off" required/></label><p id="hub-found" role="status"></p><div class="hub-dialog-actions"><button type="button" class="hub-button" data-action="cancel">Cancel</button><button class="hub-button hub-primary" type="submit">Find Frame</button></div></form>`;
    dialog.showModal();
    let found = '';
    dialog.querySelector('input')!.addEventListener('input', () => { found = ''; dialog.querySelector('button[type="submit"]')!.textContent = 'Find Frame'; });
    dialog.querySelector('form')!.addEventListener('submit', async event => {
      event.preventDefault();
      const button = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const message = dialog.querySelector('#hub-found')!;
      const address = dialog.querySelector('input')!.value;
      button.disabled = true;
      try {
        if (!found) {
          const result = await api<{ address: string; info: SatelliteRecord['snapshot'] }>('hub/discover', { method: 'POST', body: JSON.stringify({ address }) });
          found = result.address; message.textContent = `Found: ${result.info.name}`; button.textContent = 'Add Frame';
        } else {
          const added = await api<SatelliteRecord>('hub/satellites', { method: 'POST', body: JSON.stringify({ address: found }) });
          state.satellites.push(added); dialog.close(); render(); notice(`${added.snapshot.name} added.`);
        }
      } catch (error) { message.textContent = (error as Error).message; }
      finally { button.disabled = false; }
    });
  }
  root.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!button) return;
    const action = button.dataset.action;
    if (button.dataset.command) { void control(button.dataset.id!, button.dataset.command as PlaybackAction); return; }
    if (button.dataset.open) { selected = button.dataset.open; hubSettings = false; albums = null; tab = 'albums'; query = ''; render(); void loadAlbums(); return; }
    if (button.dataset.tab) { tab = button.dataset.tab; render(); return; }
    if (button.dataset.move || button.dataset.removeAlbum) {
      const ids = [...settings().albumIds];
      if (button.dataset.removeAlbum) ids.splice(ids.indexOf(button.dataset.removeAlbum), 1);
      else { const i = ids.indexOf(button.dataset.move!); const other = i + Number(button.dataset.direction); if (other >= 0 && other < ids.length) [ids[i], ids[other]] = [ids[other]!, ids[i]!]; }
      save({ albumIds: ids }); render(); return;
    }
    if (action === 'home') { selected = null; hubSettings = false; render(); }
    if (action === 'hub-settings') { hubSettings = true; selected = null; render(); }
    if (action === 'add') addDialog();
    if (action === 'cancel') dialog.close();
    if (action === 'refresh-albums') void loadAlbums();
    if (action === 'update' && selected) {
      const id = selected; busy.add(id); render();
      void api(path(id, 'update'), { method: 'POST', body: '{}' }).then(() => notice('Update requested. The Pi will check within a minute.'))
        .catch(error => notice(error.message, true)).finally(() => { busy.delete(id); if (selected === id) render(); });
    }
    if (action === 'remove' && selected) {
      const id = selected;
      dialog.innerHTML = `<h2 id="add-title">Remove this frame?</h2><p>Its photos and settings stay on the frame.</p><div class="hub-dialog-actions"><button class="hub-button" data-action="cancel">Cancel</button><button class="hub-button" id="confirm-remove">Remove from Hub</button></div>`;
      dialog.showModal();
      dialog.querySelector('#confirm-remove')!.addEventListener('click', () => {
        void api(`hub/satellites/${id}`, { method: 'DELETE' }).then(() => { state.satellites = state.satellites.filter(s => s.id !== id); selected = null; dialog.close(); render(); })
          .catch(error => notice(error.message, true));
      });
    }
  });
  root.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (input.classList.contains('hub-search')) { query = input.value; root.querySelector('.hub-albums')!.innerHTML = albumList(); }
  });
  root.addEventListener('change', event => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.id === 'hub-policy') {
      void api<HubState>('hub', { method: 'PATCH', body: JSON.stringify({ updatePolicy: input.value }) }).then(result => { state = result; notice('Update preference saved.'); }).catch(error => notice(error.message, true)); return;
    }
    if (input.dataset.album) {
      const ids = settings().albumIds;
      save({ albumIds: (input as HTMLInputElement).checked ? [...ids, input.dataset.album] : ids.filter(id => id !== input.dataset.album) }); render(); return;
    }
    if (!input.closest('.hub-form') || !input.name || !input.reportValidity()) return;
    const value = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : numbers.has(input.name) ? Number(input.value) : input.value;
    save({ [input.name]: value });
    if (['progressStyle', 'playbackMode'].includes(input.name)) render();
  });
  async function poll() {
    if (polling || stopped || document.hidden) return;
    polling = true;
    try {
      const next = await api<HubState>('hub', { signal: AbortSignal.timeout(10_000) });
      const changed = state.satellites.map(s => s.id).join(',') !== next.satellites.map(s => s.id).join(',');
      state = next;
      if (changed) render(); else liveText();
      const policy = root.querySelector<HTMLSelectElement>('#hub-policy');
      if (policy && policy !== document.activeElement) policy.value = state.updatePolicy;
      if (toast.textContent === 'Hub is reconnecting…') notice('');
      void previews();
    }
    catch { notice('Hub is reconnecting…', true); }
    finally { polling = false; }
  }
  render();
  const timer = setInterval(() => { void poll(); }, 2000);
  window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); for (const url of previewUrls.values()) URL.revokeObjectURL(url); }, { once: true });
}
