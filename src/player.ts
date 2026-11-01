import { api } from './api.js';
import { defaults, formatLocation, formatTakenDate, mediaUrl, type FrameSettings, type Library, type LocationCorner, type Media } from '../shared/model.js';
import { Playlist } from '../shared/playlist.js';
import { PlaybackHealth } from '../shared/playback-health.js';
import { PlaybackClock } from '../shared/playback-clock.js';
import { PlaybackIndicators } from './playback-indicators.js';
import { loadVideoAperture } from '../shared/video-aperture.js';
import { frameVideo } from './video-framing.js';

interface Slide {
  media: Media;
  element: HTMLDivElement;
  caption: HTMLDivElement;
  date: HTMLDivElement;
  image?: HTMLImageElement;
  video?: HTMLVideoElement;
  startMotion?: (seconds: number) => void;
  warnings: string[];
  width: number;
  height: number;
  loadMs: number;
  dispose(): void;
}

function prepareMotion(foreground: HTMLElement, settings: FrameSettings): Slide['startMotion'] {
  if (settings.motion === 'none') return;
  const zoom = 1 + settings.zoomPercent / 100;
  const zoomIn = settings.motion === 'in' || (settings.motion === 'random' && Math.random() > 0.5);
  const frames = [{ transform: `scale(${zoomIn ? 1 : zoom})` }, { transform: `scale(${zoomIn ? zoom : 1})` }];
  foreground.style.transformOrigin = `${25 + Math.random() * 50}% ${25 + Math.random() * 50}%`;
  // Establish the first animation frame while the slide is still hidden.
  foreground.style.transform = frames[0]!.transform;
  return seconds => {
    if (seconds > 0) foreground.animate(frames, { duration: seconds * 1000, easing: 'linear', fill: 'forwards' });
  };
}

function positionCaption(slide: Slide, caption: HTMLElement, corner: LocationCorner) {
  let group = slide.element.querySelector<HTMLElement>(`.frame-corner[data-corner="${corner}"]`);
  if (!group) {
    group = document.createElement('div');
    group.className = 'frame-corner';
    group.dataset.corner = corner;
    slide.element.append(group);
  }
  if (caption.parentElement !== group) group.append(caption);
  caption.dataset.corner = corner;
}

function updateOverlays(slide: Slide, settings: FrameSettings) {
  const { city, state, country } = slide.media.location ?? {};
  slide.caption.hidden = !settings.showLocation || !(city || state || country);
  positionCaption(slide, slide.caption, settings.locationCorner);
  slide.caption.querySelector<HTMLElement>('.location-primary')!.hidden = !(city || state);
  slide.caption.querySelector('.location-city')!.textContent = city ?? '';
  slide.caption.querySelector('.location-state')!.textContent = state ? `${city ? ', ' : ''}${state}` : '';
  const countryLine = slide.caption.querySelector<HTMLElement>('.location-country')!;
  countryLine.textContent = country ?? '';
  countryLine.hidden = !country;
  const sourceDate = [slide.media.localDateTime, slide.media.takenAt].find(value => formatTakenDate(value) !== null);
  const formattedDate = formatTakenDate(sourceDate);
  slide.date.hidden = !settings.showDate || !formattedDate;
  positionCaption(slide, slide.date, settings.dateCorner);
  const time = slide.date.querySelector('time')!;
  if (time.textContent !== (formattedDate ?? '')) {
    time.replaceChildren(...Array.from(formattedDate ?? '', (digit, index) => {
      if (digit !== '0' || index % 3 !== 0) return digit;
      const zero = document.createElement('span');
      zero.className = 'date-leading-zero';
      zero.textContent = digit;
      return zero;
    }));
  }
  time.dateTime = formattedDate ? sourceDate!.slice(0, 10) : '';
}

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = window.setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); }
  signal?.addEventListener('abort', abort, { once: true });
});

function waitForVideo(video: HTMLVideoElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const events = ['loadeddata', 'canplay', 'progress', 'error'];
    const interval = window.setInterval(check, 200);
    function finish(error?: Error) {
      clearInterval(interval);
      for (const event of events) video.removeEventListener(event, check);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    }
    function abort() { finish(new Error('Video preload timed out or was cancelled.')); }
    function check() {
      if (video.error) { finish(new Error('This browser could not decode the video. Try the explicit Immich video option, or test a compatible browser on the Pi.')); return; }
      const required = Math.min(1, Number.isFinite(video.duration) ? video.duration : 1);
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && video.buffered.start(i) <= 0.1 && video.buffered.end(i) >= required) { finish(); return; }
      }
    }
    for (const event of events) video.addEventListener(event, check);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}

function resolutionWarning(media: Media, width: number, height: number, settings: FrameSettings) {
  const portrait = window.innerHeight > window.innerWidth;
  let [w, h] = settings.resolution === '4k' ? [3840, 2160] : [1920, 1080];
  if (portrait) [w, h] = [h!, w!];
  const scale = (settings.fit === 'cover' ? Math.max(w! / width, h! / height) : Math.min(w! / width, h! / height))
    * (media.type === 'IMAGE' && settings.motion !== 'none' ? 1 + settings.zoomPercent / 100 : 1);
  if (scale <= 1.01) return null;
  const derived = Math.max(media.width ?? 0, media.height ?? 0) > Math.max(width, height);
  return `${derived ? 'This rendition' : 'The source media'} is ${width} × ${height}, below the pixels needed for ${settings.resolution === '4k' ? '4K' : '1080p'} with this fit and zoom.`;
}

function addBackdrop(element: HTMLElement, source: string) {
  const backdrop = document.createElement('div');
  backdrop.className = 'slide-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.style.backgroundImage = `url("${source}")`;
  element.append(backdrop);
}

function videoStill(video: HTMLVideoElement) {
  // A small, static copy is enough for the blurred backdrop; the video stays full quality.
  const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cannot capture the video background.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

async function prepare(media: Media, settings: FrameSettings, stage: HTMLElement, cancel: AbortSignal): Promise<Slide> {
  const started = performance.now();
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(45_000)]);
  const element = document.createElement('div');
  element.className = 'slide';
  element.setAttribute('aria-hidden', 'true');
  element.style.setProperty('--fit', settings.fit);
  element.dataset.mediaId = media.id;
  stage.append(element);
  // Live Photo motion and its still share one framing transform.
  const foreground = document.createElement('div');
  foreground.className = 'slide-foreground';
  element.append(foreground);
  const caption = document.createElement('div');
  caption.className = 'frame-caption frame-location';
  caption.hidden = true;
  caption.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>
    <span class="location-copy"><span class="location-primary"><span class="location-city"></span><span class="location-state"></span></span>
    <span class="location-country"></span></span>`;
  const date = document.createElement('div');
  date.className = 'frame-caption frame-date';
  date.hidden = true;
  date.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18M8 15h.01M12 15h.01M16 15h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>
    <span class="date-copy"><span class="date-label">Date taken</span><time></time></span>`;
  // Keep opposite-corner captions aligned, including when a location wraps.
  const captionSize = new ResizeObserver(([entry]) => {
    const height = entry?.borderBoxSize[0]?.blockSize ?? caption.getBoundingClientRect().height;
    if (height > 0) element.style.setProperty('--caption-height', `${height}px`);
    else element.style.removeProperty('--caption-height');
  });
  captionSize.observe(caption);
  let blobUrl: string | undefined;
  let disposeVideoFraming: (() => void) | undefined;
  const slide: Slide = {
    media, element, caption, date, warnings: [], width: 0, height: 0, loadMs: 0,
    dispose() {
      captionSize.disconnect();
      disposeVideoFraming?.();
      for (const animation of element.getAnimations({ subtree: true })) animation.cancel();
      if (slide.video) { slide.video.pause(); slide.video.removeAttribute('src'); slide.video.load(); }
      element.remove();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    },
  };
  try {
    if (media.type === 'IMAGE') {
      const response = await fetch(mediaUrl(media, 'photo', settings), { signal });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Photo download failed.' }));
        throw new Error(error.error);
      }
      blobUrl = URL.createObjectURL(await response.blob());
      const image = new Image();
      image.alt = '';
      image.src = blobUrl;
      await image.decode();
      if (signal.aborted) throw new Error('Photo preload cancelled.');
      slide.image = image;
      slide.width = image.naturalWidth;
      slide.height = image.naturalHeight;
      slide.startMotion = prepareMotion(foreground, settings);
      if (settings.fit === 'contain') {
        // Reuse the loaded photo; only the sharp foreground gets pan/zoom motion.
        addBackdrop(element, blobUrl);
      }
      foreground.append(image);
    }
    if (media.type === 'VIDEO' || (media.livePhotoVideoId && settings.livePhotos)) {
      const video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('aria-label', media.type === 'VIDEO' ? 'Video' : 'Live Photo motion');
      foreground.append(video);
      slide.video = video;
      video.src = mediaUrl(media, 'video', settings, media.type === 'IMAGE');
      video.load();
      // iPhone Live Photos can contain padded edges that Chrome does not crop itself.
      const aperture = slide.image ? loadVideoAperture(video.src, signal) : Promise.resolve(null);
      try {
        await waitForVideo(video, signal);
        const framing = await aperture;
        signal.throwIfAborted();
        disposeVideoFraming = frameVideo(video, foreground, framing, settings.fit);
        if (media.type === 'VIDEO') {
          slide.width = video.videoWidth; slide.height = video.videoHeight;
          if (settings.fit === 'contain') {
            try { addBackdrop(element, videoStill(video)); }
            catch { slide.warnings.push('The video background could not be captured; video playback is still available.'); }
          }
        }
        else if (slide.image) {
          // Video letterboxing is transparent; hide the sharp still beneath it.
          slide.image.hidden = true;
          if (video.videoWidth < (media.width ?? 0)) slide.warnings.push(`Live Photo motion: ${video.videoWidth} × ${video.videoHeight}; its still may have more detail.`);
        }
      } catch (error) {
        if (cancel.aborted || media.type === 'VIDEO') throw error;
        slide.warnings.push(`Live Photo shown as a still: ${(error as Error).message}`);
        video.pause(); video.removeAttribute('src'); video.load(); video.remove(); slide.video = undefined;
      }
    }
    const quality = resolutionWarning(media, slide.width, slide.height, settings);
    if (quality) slide.warnings.push(quality);
    updateOverlays(slide, settings);
    slide.loadMs = Math.round(performance.now() - started);
    return slide;
  } catch (error) { slide.dispose(); throw error; }
}

/** Actual ended/progress signals, with a stall watchdog rather than trusting EXIF duration. */
async function playVideo(video: HTMLVideoElement, signal: AbortSignal, buffering: (active: boolean) => void) {
  if (signal.aborted) return;
  const waiting = () => buffering(true);
  const playing = () => buffering(false);
  video.addEventListener('waiting', waiting);
  video.addEventListener('playing', playing);
  try {
    buffering(true);
    await Promise.race([
      video.play(),
      delay(15_000, signal).then(() => { throw new Error('Video did not start playing.'); }),
    ]);
    buffering(video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
    await new Promise<void>((resolve, reject) => {
      let lastTime = video.currentTime;
      let progressedAt = performance.now();
      const watch = window.setInterval(() => {
        if (video.currentTime > lastTime + 0.01) { lastTime = video.currentTime; progressedAt = performance.now(); }
        if (performance.now() - progressedAt > 20_000) finish(new Error('Video stopped making progress. Skipping it.'));
      }, 1000);
      function finish(error?: Error) {
        clearInterval(watch);
        video.removeEventListener('ended', ended);
        video.removeEventListener('error', failed);
        signal.removeEventListener('abort', ended);
        if (error) reject(error); else resolve();
      }
      function ended() { finish(); }
      function failed() { finish(new Error('Video playback failed.')); }
      video.addEventListener('ended', ended, { once: true });
      video.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', ended, { once: true });
      if (signal.aborted || video.ended) finish();
    });
  } finally {
    video.removeEventListener('waiting', waiting);
    video.removeEventListener('playing', playing);
    buffering(false);
  }
}

async function dissolveToStill(slide: Slide, durationMs: number, signal: AbortSignal) {
  const { image, video } = slide;
  if (!image || !video || signal.aborted || durationMs <= 0) return;
  // Retain the final decoded frame; never rewind or reload the clip for this handoff.
  video.pause();
  image.style.opacity = '0';
  image.hidden = false;
  const timing = { duration: durationMs, easing: 'ease-in-out', fill: 'forwards' as const };
  const fades = [
    image.animate([{ opacity: 0 }, { opacity: 1 }], timing),
    video.animate([{ opacity: 1 }, { opacity: 0 }], timing),
  ];
  const finished = Promise.all(fades.map(fade => fade.finished));
  const cancel = () => { for (const fade of fades) fade.cancel(); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try { await finished; }
  catch { /* Advancing or disposing the slide cancels the handoff. */ }
  finally {
    signal.removeEventListener('abort', cancel);
    video.hidden = true;
    image.style.removeProperty('opacity');
    cancel();
  }
}

export async function startPlayer(root: HTMLElement) {
  document.body.classList.add('player-page');
  const kiosk = new URLSearchParams(location.search).get('kiosk') === '1';
  root.innerHTML = `<main class="player" aria-label="Photo frame">
    <div class="stage"></div>
    <div class="player-message" role="status"><p>Connecting to your photos…</p></div>
    ${kiosk ? '' : '<div class="player-controls"><button class="button subtle" id="fullscreen" type="button" title="Enter fullscreen. Press Escape to leave.">Full screen</button><span id="fullscreen-help" role="status" hidden></span></div>'}
  </main>`;
  const stage = root.querySelector<HTMLElement>('.stage')!;
  const message = root.querySelector<HTMLElement>('.player-message')!;
  const statusText = message.querySelector('p')!;
  const indicators = new PlaybackIndicators(root.querySelector<HTMLElement>('.player')!);
  const clock = new PlaybackClock();
  let settings = structuredClone(defaults);
  const playlist = new Playlist(settings);
  const health = new PlaybackHealth();
  let current: Slide | undefined;
  let pending: { id: string; updatedAt: string; ready: boolean; controller: AbortController; promise: Promise<Slide | undefined> } | undefined;
  let displayController = new AbortController();
  let stopped = false;
  let refreshing = false;
  let refreshedAt = 0;
  let lastLibrary: Library = { albums: [], warnings: [], refreshedAt: '' };
  let recentErrors: string[] = [];
  let controlsTimer = 0;
  let awaitingMedia = true;
  let videoBuffering = false;
  let indicatorFrame = 0;
  const fullscreenDisplay = window.matchMedia('(display-mode: fullscreen)');

  function updateIndicators() {
    indicators.loading(videoBuffering || (awaitingMedia && (!refreshedAt || playlist.size > 0)));
    indicators.render(settings, awaitingMedia ? null : clock.sample(performance.now(), current?.video), pending ? playlist.get(pending.id)?.type : undefined);
    indicatorFrame = requestAnimationFrame(updateIndicators);
  }

  function showControls() {
    if (kiosk || document.fullscreenElement || fullscreenDisplay.matches) return;
    document.body.classList.add('controls-visible');
    clearTimeout(controlsTimer);
    controlsTimer = window.setTimeout(() => document.body.classList.remove('controls-visible'), 4000);
  }
  function fullscreenChanged() {
    clearTimeout(controlsTimer);
    document.body.classList.remove('controls-visible');
    showControls();
  }
  document.addEventListener('fullscreenchange', fullscreenChanged);
  fullscreenDisplay.addEventListener('change', fullscreenChanged);
  window.addEventListener('pointermove', showControls);
  window.addEventListener('pointerdown', showControls);
  window.addEventListener('keydown', event => { showControls(); if (event.code === 'ArrowRight') displayController.abort(); });
  root.querySelector('#fullscreen')?.addEventListener('click', async () => {
    const help = root.querySelector<HTMLElement>('#fullscreen-help')!;
    help.hidden = true;
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch (error) {
      console.warn('Fullscreen request failed:', error);
      help.textContent = 'Use your browser’s fullscreen menu.';
      help.hidden = false;
    }
  });

  function report(error?: string) {
    if (error) recentErrors = [...recentErrors.slice(-4), error];
    const quality = current?.video?.getVideoPlaybackQuality();
    const data = {
      state: current ? 'playing' : 'waiting', frame: settings.name,
      media: current?.media.name ?? null, kind: current?.media.type ?? null,
      location: formatLocation(current?.media.location),
      sourcePixels: current ? `${current.width} × ${current.height}` : null,
      browserPixels: `${Math.round(innerWidth * devicePixelRatio)} × ${Math.round(innerHeight * devicePixelRatio)}`,
      target: settings.resolution, videoSource: settings.videoSource,
      loadMs: current?.loadMs ?? null, nextMedia: pending ? pending.ready ? 'ready' : 'loading' : 'none',
      droppedVideoFrames: quality?.droppedVideoFrames ?? 0, totalVideoFrames: quality?.totalVideoFrames ?? 0,
      warnings: [...lastLibrary.warnings, ...(current?.warnings ?? [])], recentErrors,
      totalMedia: playlist.size, ...health.report(),
      lastLibraryRefresh: lastLibrary.refreshedAt,
      countdownSeconds: clock.sample(performance.now(), current?.video)?.remainingSeconds ?? null,
      loadingMedia: awaitingMedia || videoBuffering,
    };
    void api('player', { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
  }

  function cancelPending() {
    const previous = pending;
    pending = undefined;
    previous?.controller.abort();
    void previous?.promise.then(slide => slide?.dispose());
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const updated = await api<FrameSettings>('settings');
      const changed = JSON.stringify(updated) !== JSON.stringify(settings);
      const due = Date.now() - refreshedAt >= updated.refreshSeconds * 1000;
      if (changed || due || !refreshedAt) {
        const library = await api<Library>('library?refresh=1');
        if (stopped) return;
        settings = updated;
        lastLibrary = library;
        playlist.update(library.albums, settings);
        health.retain(id => playlist.contains(id));
        refreshedAt = Date.now();
        if (pending && (changed || !playlist.contains(pending.id) || playlist.get(pending.id)?.updatedAt !== pending.updatedAt)) cancelPending();
        if (current) {
          const media = playlist.get(current.media.id);
          if (media) { current.media = media; updateOverlays(current, settings); }
          else { current.dispose(); current = undefined; clock.clear(); awaitingMedia = true; displayController.abort(); }
        }
        if (!playlist.size) {
          message.hidden = false;
          statusText.textContent = settings.albumIds.length ? 'These albums have no available photos or videos yet.' : 'Choose albums from this frame’s settings page on your phone.';
        }
      }
      report();
    } catch (error) {
      if (!current) { message.hidden = false; statusText.textContent = 'Cannot reach your photo library. Retrying automatically…'; }
      report((error as Error).message);
    } finally { refreshing = false; }
  }

  function preload() {
    if (pending || !playlist.size) return;
    const controller = new AbortController();
    const job = { id: '', updatedAt: '', ready: false, controller, promise: Promise.resolve<Slide | undefined>(undefined) };
    pending = job;
    job.promise = (async () => {
      // Find a usable successor while the current slide is still on screen.
      // Bound retries so a library with missing renditions cannot hammer Immich.
      for (let attempt = 0; attempt < Math.min(playlist.size, 20); attempt++) {
        if (controller.signal.aborted) return;
        const media = playlist.next();
        if (!media) return;
        job.id = media.id; job.updatedAt = media.updatedAt;
        try {
          const slide = await prepare(media, { ...settings }, stage, controller.signal);
          if (controller.signal.aborted) { slide.dispose(); return; }
          job.ready = true;
          health.recovered(media.id);
          report();
          return slide;
        } catch (error) {
          if (controller.signal.aborted) return;
          health.failed(media, (error as Error).message);
          report();
        }
      }
    })();
  }

  async function transition(next: Slide) {
    const previous = current;
    next.media = playlist.get(next.media.id) ?? next.media;
    updateOverlays(next, settings);
    current = next;
    next.element.removeAttribute('aria-hidden');
    previous?.element.setAttribute('aria-hidden', 'true');
    next.element.classList.add('visible');
    next.element.style.zIndex = '2';
    if (previous) previous.element.style.zIndex = '1';
    const kind = settings.transition === 'random' ? ['fade', 'slide', 'cut'][Math.floor(Math.random() * 3)]! : settings.transition;
    if (previous && kind !== 'cut') {
      const frames = kind === 'slide' ? [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }] : [{ opacity: 0 }, { opacity: 1 }];
      await next.element.animate(frames, { duration: settings.transitionSeconds * 1000, easing: 'ease-in-out' }).finished.catch(() => {});
    }
    previous?.dispose();
    next.element.style.zIndex = '1';
    message.hidden = true;
  }

  const interval = window.setInterval(() => { void refresh(); }, 5000);
  window.addEventListener('pagehide', () => {
    stopped = true; clearInterval(interval); clearTimeout(controlsTimer);
    cancelAnimationFrame(indicatorFrame);
    document.removeEventListener('fullscreenchange', fullscreenChanged);
    fullscreenDisplay.removeEventListener('change', fullscreenChanged);
    cancelPending(); displayController.abort(); current?.dispose();
  }, { once: true });
  showControls();
  updateIndicators();
  await refresh();
  // The pagehide handler stops this loop while it yields to media/network work.
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition
  while (!stopped) {
    preload();
    const job = pending;
    awaitingMedia = true;
    if (!job) { clock.clear(); await delay(1000); continue; }
    const slide = await job.promise;
    if (stopped) { slide?.dispose(); break; }
    if (pending !== job) { slide?.dispose(); continue; }
    pending = undefined;
    if (!slide || !playlist.contains(slide.media.id)) {
      slide?.dispose();
      clock.clear();
      if (!current) {
        message.hidden = false;
        statusText.textContent = 'Waiting for playable media. Check this frame’s settings page on your phone. Retrying automatically…';
      }
      await delay(5000);
      continue;
    }
    displayController = new AbortController();
    clock.clear();
    awaitingMedia = false;
    await transition(slide);
    if (stopped || current !== slide) continue;
    const photoSeconds = settings.photoSeconds;
    let stillSeconds = photoSeconds;
    if (slide.video && slide.image) clock.startLivePhoto(photoSeconds);
    else if (slide.video) clock.startVideo();
    else clock.startPhoto(photoSeconds, performance.now());
    preload();
    report();
    try {
      if (slide.video) {
        try { await playVideo(slide.video, displayController.signal, active => { videoBuffering = active; }); }
        catch (error) { report((error as Error).message); }
        if (slide.image && !displayController.signal.aborted) {
          await dissolveToStill(slide, 650, displayController.signal);
          if (!displayController.signal.aborted) {
            // The full photo interval starts only once the sharp still is fully visible.
            stillSeconds = clock.holdStill(performance.now());
            report();
          }
        }
      }
      if (slide.image && stillSeconds > 0 && !displayController.signal.aborted) {
        slide.startMotion?.(stillSeconds);
        await delay(stillSeconds * 1000, displayController.signal);
      }
    } catch { /* Next, a settings change, or navigation cancelled the current wait. */ }
    slide.video?.pause();
  }
}
