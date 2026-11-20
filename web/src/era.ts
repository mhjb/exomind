// Placing people in time: shared by the people graph and each note's people panel.

import type { PersonDates } from '../../shared/types';

// Arranging people by era. Time runs down the page on a square-root scale of years ago, so recent
// centuries (where most people are) get room while antiquity still sits clearly below: Shakespeare,
// then Jesus, then Aristotle. Year 2000 is at y = 0.
export const NOW = new Date().getFullYear() + 5;
export const ERA_SCALE = 34;
export const eraY = (year: number) => ERA_SCALE * (Math.sqrt(Math.max(0, NOW - year)) - Math.sqrt(NOW - 2000));
export const ERA_TICKS = [2000, 1950, 1900, 1850, 1800, 1700, 1600, 1500, 1400, 1300, 1200, 1000, 800, 600, 400, 200, 1, -200, -400, -600, -800, -1000, -1250, -1500, -2000, -2500, -3000];
export const yearLabel = (y: number) => (y < 0 ? `${-y} BC` : y < 1000 ? `AD ${y}` : `${y}`);

/** "384–322 BC", "c. 1564–1616", "b. 1962", "fl. c. 740 BC". */
export function lifeLabel(d: PersonDates): string {
  if (d.confidence === 'none' && d.born == null && d.active == null) return 'Not placed in time';
  const c = d.confidence === 'high' ? '' : 'c. ';
  const y = (n: number) => (n < 0 ? `${-n} BC` : `${n}`);
  let s: string;
  if (d.born != null && d.died != null) s = d.born < 0 && d.died < 0 ? `${-d.born}–${-d.died} BC` : d.born < 0 ? `${-d.born} BC – AD ${d.died}` : `${d.born}–${d.died}`;
  else if (d.born != null) s = `b. ${y(d.born)}`;
  else if (d.died != null) s = `d. ${y(d.died)}`;
  else s = `fl. ${y(d.active!)}`;
  return /^[bdf]/.test(s) ? s.replace(/^(\w+\.) /, `$1 ${c}`) : c + s;
}
