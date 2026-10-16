// Отпечатки прежнего, сразу считаемого разбора приёмов нанятых врачей — для tools/test/lazy-review.test.ts. Записаны
// движком до разбора по требованию (@ 96503ac): перезаписывать — только с прежним движком и только если медицина
// изменилась нарочно (тогда же — и в «Больнице», Nefeste/bolnitsa). bun tools/test/make-review-fixture.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, newSingle } from '../../src/engine/shift/engine';
import { DAY, type ShiftState } from '../../src/engine/shift/types';
import { buildDb } from '../content/load';

const { db } = buildDb();
const hash = (x: unknown) => Bun.hash(JSON.stringify(x)).toString(16);
const hired = (s: ShiftState) => Object.values(s.patients).filter(p => p.closed?.by !== undefined).sort((a, b) => (a.id < b.id ? -1 : 1));
function liveUntil(s: ShiftState, hour: number) {
  const end = (s.day - 1) * DAY + hour * 3600;
  while (s.t < end) apply(db, s, { kind: 'advance', seconds: Math.min(60, end - s.t) });
}
const out = [1, 2, 3].map(seed => {
  const venue = 'preset.city';
  const s = newSingle(db, { seed, season: 'winter', venue });
  liveUntil(s, 12);
  const noon = hired(s);
  const atNoon = { count: noon.length, hash: hash(noon.map(p => [p.id, p.closed])) };
  liveUntil(s, 18);
  apply(db, s, { kind: 'closeDay' });
  return { venue, seed, atNoon, hired: hired(s).length, closed: hash(s) };
});
writeFileSync(join(import.meta.dir, 'fixtures/eager-review.json'), `${JSON.stringify(out, null, 2)}\n`);
