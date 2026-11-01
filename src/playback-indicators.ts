import type { FrameSettings, Media } from '../shared/model.js';
import type { PlaybackProgress } from '../shared/playback-clock.js';

export class PlaybackIndicators {
  private loader: HTMLDivElement;
  private progress: HTMLDivElement;
  private bar: HTMLElement;
  private arc: SVGCircleElement;
  private title: HTMLElement;
  private seconds: HTMLElement;
  private unit: HTMLElement;

  constructor(player: HTMLElement) {
    this.loader = document.createElement('div');
    this.loader.className = 'player-loading';
    this.loader.setAttribute('role', 'status');
    this.loader.setAttribute('aria-label', 'Loading media');
    this.loader.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span>';
    this.progress = document.createElement('div');
    this.progress.className = 'playback-progress';
    this.progress.hidden = true;
    this.progress.setAttribute('role', 'progressbar');
    this.progress.setAttribute('aria-label', 'Time until next media');
    this.progress.setAttribute('aria-valuemin', '0');
    this.progress.setAttribute('aria-valuemax', '100');
    this.progress.innerHTML = `<div class="progress-track"><div class="progress-fill"></div></div>
      <div class="countdown-ring"><span class="countdown-title"></span>
        <svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><circle class="countdown-track" cx="50" cy="50" r="43"/><circle class="countdown-arc" cx="50" cy="50" r="43" pathLength="100"/></svg>
        <span class="countdown-time"><strong></strong><span></span></span>
      </div>`;
    this.bar = this.progress.querySelector('.progress-fill')!;
    this.arc = this.progress.querySelector('.countdown-arc')!;
    this.title = this.progress.querySelector('.countdown-title')!;
    this.seconds = this.progress.querySelector('.countdown-time strong')!;
    this.unit = this.progress.querySelector('.countdown-time span')!;
    player.append(this.progress, this.loader);
  }

  loading(active: boolean) { if (this.loader.hidden === active) this.loader.hidden = !active; }

  render(settings: FrameSettings, progress: PlaybackProgress | null, nextType?: Media['type']) {
    const hidden = settings.progressStyle === 'off' || !progress;
    if (this.progress.hidden !== hidden) this.progress.hidden = hidden;
    if (hidden || !progress) return;
    if (this.progress.dataset.style !== settings.progressStyle) this.progress.dataset.style = settings.progressStyle;
    const position = settings.progressStyle === 'ring' ? settings.progressCorner : settings.progressPosition;
    if (this.progress.dataset.position !== position) this.progress.dataset.position = position;
    const vertical = ['left', 'right'].includes(settings.progressPosition);
    this.bar.style.transform = `scale${vertical ? 'Y' : 'X'}(${progress.fraction})`;
    this.arc.style.strokeDashoffset = String(100 * (1 - progress.fraction));
    const title = nextType === 'IMAGE' ? 'Next photo' : nextType === 'VIDEO' ? 'Next video' : 'Next media';
    const seconds = progress.remainingSeconds === null ? '—' : String(progress.remainingSeconds);
    const unit = progress.remainingSeconds === null ? 'Playing' : progress.remainingSeconds === 1 ? 'second' : 'seconds';
    if (this.title.textContent !== title) this.title.textContent = title;
    if (this.seconds.textContent !== seconds) this.seconds.textContent = seconds;
    if (this.unit.textContent !== unit) this.unit.textContent = unit;
    const percent = String(Math.round(progress.fraction * 100));
    if (this.progress.getAttribute('aria-valuenow') !== percent) this.progress.setAttribute('aria-valuenow', percent);
    const description = progress.remainingSeconds === null ? 'Playing; duration unavailable' : `${title} in ${seconds} ${unit}`;
    if (this.progress.getAttribute('aria-valuetext') !== description) this.progress.setAttribute('aria-valuetext', description);
  }
}
