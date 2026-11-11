import { formatTakenDate, personNameKey, type FrameSettings, type Media } from './model.js';

/** Compare capture calendar dates, without converting them to the frame's time zone. */
export function ageWhenTaken(birthDate: string | null | undefined, capturedAt: string | null | undefined): string | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !formatTakenDate(birthDate) || !formatTakenDate(capturedAt)) return null;
  const birth = new Date(`${birthDate}T00:00:00Z`);
  const capture = new Date(`${capturedAt!.slice(0, 10)}T00:00:00Z`);
  if (capture < birth) return null;
  let months = (capture.getUTCFullYear() - birth.getUTCFullYear()) * 12 + capture.getUTCMonth() - birth.getUTCMonth();
  // Treat the last day of a shorter month as that month's anniversary (including leap-day birthdays).
  const monthEnd = new Date(capture);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  if (capture.getUTCDate() < Math.min(birth.getUTCDate(), monthEnd.getUTCDate())) months--;
  if (months < 1) {
    const days = Math.floor((capture.getTime() - birth.getTime()) / 86_400_000);
    return days === 0 ? 'Newborn' : `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return [years ? `${years} ${years === 1 ? 'year' : 'years'}` : '', remainder ? `${remainder} ${remainder === 1 ? 'month' : 'months'}` : ''].filter(Boolean).join(', ');
}

export interface PersonAge { name: string; age: string }

export function peopleAges(media: Media, settings: Pick<FrameSettings, 'showPeople' | 'peopleNames'>): PersonAge[] {
  if (!settings.showPeople || !settings.peopleNames.length) return [];
  const capture = [media.localDateTime, media.takenAt].find(value => formatTakenDate(value) !== null);
  const result: PersonAge[] = [];
  const seen = new Set<string>();
  for (const allowed of settings.peopleNames) {
    const key = personNameKey(allowed);
    if (!key) continue;
    for (const person of media.people ?? []) {
      if (personNameKey(person.name) !== key) continue;
      const age = ageWhenTaken(person.birthDate, capture);
      const identity = `${key}:${person.birthDate}`;
      if (!age || seen.has(identity)) continue;
      seen.add(identity);
      result.push({ name: person.name, age });
    }
  }
  return result;
}
