import type { FrameSettings } from './model.js';

export type PowerPhase = 'awake' | 'sleeping' | 'warming';
export interface PowerState { phase: PowerPhase; warmupSeconds: number; }
export const warmupSeconds = 120;

const clocks = new Map<string, Intl.DateTimeFormat>();
const seconds = (value: string) => { const [hour, minute] = value.split(':').map(Number); return hour! * 3600 + minute! * 60; };
export function powerState(settings: Pick<FrameSettings, 'sleepEnabled' | 'sleepStart' | 'sleepEnd'>, timeZone: string, now = Date.now()): PowerState {
  if (!settings.sleepEnabled) return { phase: 'awake', warmupSeconds };
  let clock = clocks.get(timeZone);
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    clocks.set(timeZone, clock);
  }
  const start = seconds(settings.sleepStart), end = seconds(settings.sleepEnd);
  const local = (time: number) => {
    const parts = Object.fromEntries(clock!.formatToParts(time).map(part => [part.type, part.value]));
    return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  };
  const asleep = (time: number) => { const current = local(time); return start < end ? current >= start && current < end : current >= start || current < end; };
  if (!asleep(now)) return { phase: 'awake', warmupSeconds };
  const remaining = (end - local(now) + 86400) % 86400;
  // Check real elapsed time too: DST can skip or repeat a local clock hour.
  const warming = (remaining <= warmupSeconds && !asleep(now + remaining * 1000)) || !asleep(now + warmupSeconds * 1000);
  return { phase: warming ? 'warming' : 'sleeping', warmupSeconds };
}
