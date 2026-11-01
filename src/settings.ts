import { api, escapeHtml as e } from './api.js';
import { defaults, type Album, type FrameSettings, type Status } from '../shared/model.js';
import type { PlaybackHealthReport } from '../shared/playback-health.js';

export async function showSettings(root: HTMLElement) {
  let settings = structuredClone(defaults);
  let albums: Album[] = [];
  let dirty = false;
  let query = '';
  let selected: string[] = [];
  root.innerHTML = `<div class="settings-shell">
    <header class="topbar"><a class="wordmark" href="/" aria-label="imframe home">imframe<span>•</span></a><span class="connection"><i></i> Connecting to Immich</span></header>
    <div class="page-heading"><div><p class="eyebrow">A LITTLE MORE EVERYDAY</p><h1>Your photos. Your frame.</h1><p>Choose what plays here. Add new memories in Immich.</p></div><a class="button primary" href="/frame">Open frame <span aria-hidden="true">↗</span></a></div>
    <div id="connection-message" class="notice" role="status" hidden></div>
    <div id="playback-message" class="notice error" role="status" hidden></div>
    <form id="settings-form">
      <div class="settings-grid">
        <section class="card albums-card" aria-labelledby="albums-title">
          <div class="card-heading"><div><span class="section-number">01</span><h2 id="albums-title">Choose your albums</h2></div><button class="text-button" type="button" id="refresh-albums">Refresh</button></div>
          <p class="hint">Select as many as you like. New media appears automatically.</p>
          <label class="search-label"><span aria-hidden="true">⌕</span><input id="album-search" type="search" placeholder="Find an album" aria-label="Find an album" /></label>
          <div id="album-list" class="album-list"><p class="empty">Loading your albums…</p></div>
          <div class="selection-summary"><strong id="selection-count">No albums selected</strong><span>Overlapping media plays once per cycle.</span></div>
          <details class="album-order"><summary>Selected album order</summary><p class="hint">Used when playing one album at a time.</p><ol id="selected-order"></ol></details>
        </section>
        <div class="settings-column">
          <section class="card" aria-labelledby="playback-title">
            <div class="card-heading"><div><span class="section-number">02</span><h2 id="playback-title">Make it yours</h2></div></div>
            <label class="field">Frame name<input name="name" type="text" maxlength="80" required /></label>
            <div class="field-grid"><label class="field">Play albums<select name="playbackMode"><option value="mixed">Mix all selected albums</option><option value="albums">One album at a time</option></select></label>
              <label class="field">Media order<select name="mediaOrder"><option value="shuffle">Shuffle without repeats</option><option value="oldest">Oldest first</option><option value="newest">Newest first</option></select></label></div>
            <label class="toggle-field" id="shuffle-albums-row"><input type="checkbox" name="shuffleAlbums" /><span>Shuffle album order</span></label>
            <div class="field-grid"><label class="field">Seconds per photo<input name="photoSeconds" type="number" min="3" max="300" step="1" required /></label>
              <label class="field">Image fit<select name="fit"><option value="contain">Show the whole image</option><option value="cover">Fill the screen (crop edges)</option></select></label></div>
            <p class="hint">Videos play to the end. For Live Photos, the photo timer starts after the motion finishes and fades into the still.</p>
            <div class="field-grid"><label class="field">Photo motion<select name="motion"><option value="none">Still</option><option value="in">Slow zoom in</option><option value="out">Slow zoom out</option><option value="random">Random pan & zoom</option></select></label>
              <label class="field">Zoom amount<input name="zoomPercent" type="number" min="1" max="20" step="1" required /><span class="field-caption">Percent · motion may crop edges</span></label></div>
            <div class="field-grid"><label class="field">Transition<select name="transition"><option value="fade">Crossfade</option><option value="slide">Slide</option><option value="cut">Instant</option><option value="random">Random</option></select></label>
              <label class="field">Transition seconds<input name="transitionSeconds" type="number" min="0.2" max="3" step="0.1" required /></label></div>
            <div class="location-settings">
              <label class="toggle-field"><input type="checkbox" name="showLocation" /><span>Show location</span></label>
              <label class="field">Location corner<select name="locationCorner"><option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option><option value="top-left">Top left</option><option value="top-right">Top right</option></select></label>
              <p class="hint">A small map pin and place name from Immich. Hidden when the photo or video has no location.</p>
            </div>
            <div class="location-settings">
              <label class="toggle-field"><input type="checkbox" name="showDate" /><span>Show date taken</span></label>
              <label class="field">Date corner<select name="dateCorner"><option value="top-left">Top left</option><option value="top-right">Top right</option><option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option></select></label>
              <p class="hint">The capture date from Immich, always MM.DD.YY. Hidden when no date is available.</p>
            </div>
            <div class="location-settings">
              <div class="field-grid"><label class="field">Media countdown<select name="progressStyle"><option value="off">Off</option><option value="bar">Edge bar</option><option value="ring">Circular countdown</option></select></label>
                <label class="field" id="countdown-edge-field">Countdown edge<select name="progressPosition"><option value="bottom">Bottom</option><option value="top">Top</option><option value="left">Left</option><option value="right">Right</option></select></label>
                <label class="field" id="countdown-corner-field" hidden>Countdown corner<select name="progressCorner"><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option><option value="top-left">Top left</option><option value="top-right">Top right</option></select></label></div>
              <p class="hint">Bars fill left to right on the top or bottom, and top to bottom on either side. The circle shows the seconds until the next item in your chosen corner.</p>
            </div>
          </section>
          <section class="card" aria-labelledby="quality-title">
            <div class="card-heading"><div><span class="section-number">03</span><h2 id="quality-title">Picture quality</h2></div><span class="pill">Sound off</span></div>
            <div class="field-grid"><label class="field">Display target<select name="resolution"><option value="4k">4K · 3840 × 2160</option><option value="1080p">Full HD · 1920 × 1080</option></select></label>
              <label class="field">Video source<select name="videoSource"><option value="original">Original · highest quality</option><option value="immich">Immich playback · compatibility</option></select></label></div>
            <p class="hint">Photos use full-size files. The display target checks available detail; it does not change your monitor’s output or upscale the source. Immich playback may use a lower-resolution video.</p>
            <label class="toggle-field"><input type="checkbox" name="livePhotos" /><span>Play Live Photo motion</span></label>
            <label class="field compact-field">Check albums every<input name="refreshSeconds" type="number" min="15" max="3600" step="1" required /><span class="field-caption">Seconds</span></label>
          </section>
        </div>
      </div>
      <div class="save-bar"><div><strong>This frame, just the way you like it.</strong><span id="save-status" role="status">Settings are saved on this frame.</span></div><button class="button primary" type="submit" id="save-button">Save settings</button></div>
    </form>
    <details class="status-card"><summary>Frame status</summary><div id="frame-report">Open the frame to see playback details.</div></details>
    <footer>imframe <span>Made for the photos you come home to.</span><span id="server-version"></span></footer>
  </div>`;
  const form = root.querySelector<HTMLFormElement>('#settings-form')!;
  const notice = root.querySelector<HTMLElement>('#connection-message')!;
  const saveStatus = root.querySelector<HTMLElement>('#save-status')!;
  const saveButton = root.querySelector<HTMLButtonElement>('#save-button')!;
  const list = root.querySelector<HTMLElement>('#album-list')!;

  function setNotice(text: string, error = false) {
    notice.hidden = !text;
    notice.textContent = text;
    notice.classList.toggle('error', error);
  }
  function markDirty() { dirty = true; saveStatus.textContent = 'You have unsaved changes.'; }
  function field(name: keyof FrameSettings) { return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement; }
  function populate() {
    for (const [key, value] of Object.entries(settings)) {
      const input = form.elements.namedItem(key);
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
      else if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) input.value = String(value);
    }
    selected = [...settings.albumIds];
    dependencies();
  }
  function dependencies() {
    const grouped = field('playbackMode').value === 'albums';
    root.querySelector<HTMLElement>('#shuffle-albums-row')!.hidden = !grouped;
    field('zoomPercent').disabled = field('motion').value === 'none';
    field('transitionSeconds').disabled = field('transition').value === 'cut';
    field('locationCorner').disabled = !(field('showLocation') as HTMLInputElement).checked;
    field('dateCorner').disabled = !(field('showDate') as HTMLInputElement).checked;
    const circular = field('progressStyle').value === 'ring';
    root.querySelector<HTMLElement>('#countdown-edge-field')!.hidden = circular;
    root.querySelector<HTMLElement>('#countdown-corner-field')!.hidden = !circular;
    field('progressPosition').disabled = field('progressStyle').value !== 'bar';
    field('progressCorner').disabled = !circular;
  }
  function renderAlbums() {
    const available = albums.filter(a => a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    list.innerHTML = available.length ? available.map(a => `<label class="album ${selected.includes(a.id) ? 'selected' : ''}">
      <input type="checkbox" data-album-id="${a.id}" ${selected.includes(a.id) ? 'checked' : ''} />
      <span class="album-art">${a.thumbnailId ? `<img src="/api/media/${a.thumbnailId}/thumbnail" alt="" loading="lazy" />` : '<span aria-hidden="true">▧</span>'}</span>
      <span class="album-info"><strong>${e(a.name)}</strong><span>${a.count.toLocaleString()} ${a.count === 1 ? 'item' : 'items'}</span></span><span class="album-check" aria-hidden="true">✓</span></label>`).join('')
      : `<p class="empty">${query ? 'No albums match your search.' : 'No albums available. Create or share an album in Immich, then refresh.'}</p>`;
    root.querySelector('#selection-count')!.textContent = selected.length ? `${selected.length} ${selected.length === 1 ? 'album' : 'albums'} selected` : 'No albums selected';
    root.querySelector('#selected-order')!.innerHTML = selected.map((id, index) => {
      const name = albums.find(a => a.id === id)?.name ?? 'Unavailable album';
      return `<li><span>${e(name)}</span><button type="button" class="order-button" data-move="${id}" data-direction="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move ${e(name)} up">↑</button><button type="button" class="order-button" data-move="${id}" data-direction="1" ${index === selected.length - 1 ? 'disabled' : ''} aria-label="Move ${e(name)} down">↓</button><button type="button" class="order-button" data-remove="${id}" aria-label="Remove ${e(name)}">×</button></li>`;
    }).join('');
    list.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { img.hidden = true; }));
  }
  async function loadAlbums() {
    const button = root.querySelector<HTMLButtonElement>('#refresh-albums')!;
    button.disabled = true;
    try { albums = (await api<Album[]>('albums')).toSorted((a, b) => a.name.localeCompare(b.name)); renderAlbums(); }
    catch (error) { setNotice((error as Error).message, true); list.innerHTML = '<p class="empty">Albums could not be loaded. Check the connection, then refresh.</p>'; }
    finally { button.disabled = false; }
  }
  form.addEventListener('input', event => { if ((event.target as HTMLElement).id !== 'album-search') markDirty(); });
  form.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.albumId) {
      selected = input.checked ? [...selected, input.dataset.albumId] : selected.filter(id => id !== input.dataset.albumId);
      renderAlbums();
    }
    dependencies(); markDirty();
  });
  root.querySelector('#album-search')!.addEventListener('input', event => {
    query = (event.target as HTMLInputElement).value; renderAlbums();
  });
  root.querySelector('#selected-order')!.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.remove) selected = selected.filter(id => id !== button.dataset.remove);
    if (button.dataset.move) {
      const index = selected.indexOf(button.dataset.move);
      const other = index + Number(button.dataset.direction);
      if (other >= 0 && other < selected.length) [selected[index], selected[other]] = [selected[other]!, selected[index]!];
    }
    renderAlbums(); markDirty();
  });
  root.querySelector('#refresh-albums')!.addEventListener('click', () => { void loadAlbums(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    saveButton.disabled = true;
    const next = { ...settings, albumIds: [...selected] } as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(settings)) {
      const input = form.elements.namedItem(key);
      if (input instanceof HTMLInputElement && input.type === 'checkbox') next[key] = input.checked;
      else if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) next[key] = typeof value === 'number' ? Number(input.value) : input.value;
    }
    try {
      settings = await api<FrameSettings>('settings', { method: 'PUT', body: JSON.stringify(next) });
      dirty = false;
      saveStatus.textContent = 'Saved. The frame picks up changes within a few seconds.';
      setNotice('');
    } catch (error) { saveStatus.textContent = 'Settings were not saved.'; setNotice((error as Error).message, true); }
    finally { saveButton.disabled = false; }
  });
  window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });

  async function report() {
    try {
      const data = await api<({ media: string; location?: string | null; sourcePixels: string; browserPixels: string; target: string; warnings: string[]; recentErrors: string[]; totalMedia?: number; reportedAt: string } & Partial<PlaybackHealthReport>) | null>('player');
      const target = root.querySelector('#frame-report')!;
      const playbackNotice = root.querySelector<HTMLElement>('#playback-message')!;
      playbackNotice.hidden = !data?.unavailableCount;
      if (!data) return;
      const recent = Date.now() - Date.parse(data.reportedAt) < 20_000;
      const unavailable = data.unavailableMedia ?? [];
      const count = data.unavailableCount ?? 0;
      if (count) {
        const first = unavailable[0];
        playbackNotice.innerHTML = `<strong>${recent ? '' : 'Last player report: '}Could not load ${count}${data.totalMedia === undefined ? '' : ` of ${data.totalMedia}`} ${(data.totalMedia ?? count) === 1 ? 'item' : 'items'}.</strong>
          ${first ? `<br>${e(first.name)}: ${e(first.message)}` : ''}<br>The frame retries automatically. See Frame status for details.`;
      }
      target.innerHTML = `<p><strong>${recent ? 'Player connected' : 'Last player report'}</strong> · ${e(new Date(data.reportedAt).toLocaleTimeString())}</p>
        <p>${data.media ? e(data.media) : 'Waiting for media'}</p><p>Media: ${e(data.sourcePixels ?? '—')} · Browser output: ${e(data.browserPixels)} · Target: ${e(data.target)}</p>
        ${data.location ? `<p>Location: ${e(data.location)}</p>` : ''}
        ${data.totalMedia === undefined ? '' : `<p>${data.totalMedia} items in selected albums · ${count} unavailable</p>`}
        ${unavailable.map(item => `<p class="report-warning">${e(item.name)}: ${e(item.message)}</p>`).join('')}
        ${[...(data.warnings ?? []), ...(data.recentErrors ?? [])].map(text => `<p class="report-warning">${e(text)}</p>`).join('')}`;
    } catch { /* Status is supplementary; keep the settings form usable. */ }
  }
  populate();
  try {
    settings = await api<FrameSettings>('settings'); populate();
    const status = await api<Status>('status');
    const connection = root.querySelector<HTMLElement>('.connection')!;
    connection.innerHTML = `<i></i>${status.connected ? status.demo ? 'Demo library' : 'Connected to Immich' : 'Connection needed'}`;
    connection.classList.toggle('online', status.connected);
    root.querySelector('#server-version')!.textContent = status.version ? `Immich ${status.version}` : '';
    if (status.error) setNotice(status.error, true);
    if (status.demo) setNotice('Demo mode uses generated sample media and separate settings. Your Immich library is not connected here.');
    if (status.connected) await loadAlbums();
    else list.innerHTML = '<p class="empty">Connect to Immich to see your albums.</p>';
  } catch (error) { setNotice((error as Error).message, true); }
  await report();
  const timer = window.setInterval(() => { void report(); }, 10_000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
