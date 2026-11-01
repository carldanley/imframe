export interface PlaybackProgress {
  elapsed: number;
  duration: number | null;
  fraction: number;
  remainingSeconds: number | null;
}

type ClockState = { kind: 'idle' }
  | { kind: 'photo'; startedAt: number; duration: number }
  | { kind: 'video' }
  | { kind: 'live-photo'; stillSeconds: number };

/** A Live Photo's countdown waits until its motion and dissolve have finished. */
export class PlaybackClock {
  private state: ClockState = { kind: 'idle' };

  clear() { this.state = { kind: 'idle' }; }
  startPhoto(seconds: number, now: number) {
    this.state = { kind: 'photo', duration: seconds, startedAt: now };
  }
  startVideo() { this.state = { kind: 'video' }; }
  startLivePhoto(stillSeconds: number) { this.state = { kind: 'live-photo', stillSeconds }; }

  holdStill(now: number): number {
    if (this.state.kind !== 'live-photo') return 0;
    const seconds = this.state.stillSeconds;
    this.startPhoto(seconds, now);
    return seconds;
  }

  sample(now: number, video?: { currentTime: number; duration: number }): PlaybackProgress | null {
    if (this.state.kind === 'idle' || this.state.kind === 'live-photo') return null;
    const elapsed = this.state.kind === 'photo'
      ? Math.max(0, now - this.state.startedAt) / 1000
      : Math.max(0, Number.isFinite(video?.currentTime) ? video!.currentTime : 0);
    const duration = this.state.kind === 'photo' ? this.state.duration
      : Number.isFinite(video?.duration) && video!.duration > 0 ? video!.duration : null;
    return {
      elapsed: duration === null ? elapsed : Math.min(duration, elapsed), duration,
      fraction: duration === null ? 0 : duration > 0 ? Math.min(1, elapsed / duration) : 1,
      remainingSeconds: duration === null ? null : Math.ceil(Math.max(0, duration - elapsed)),
    };
  }
}
