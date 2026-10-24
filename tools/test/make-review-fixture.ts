// Отпечатки сразу считаемого разбора приёмов нанятых врачей — для tools/test/lazy-review.test.ts. До 0.6.9 их записал
// движок до разбора по требованию (@ 96503ac). С 0.6.9 (spec 2026-10-clinic-flow) путь пациента по больнице другой
// нарочно — регистратура и медсестра по одному, процедурная по одному, — и прежним движком его не сыграть: отпечатки
// пишет нынешний движок, досчитывая разбор после каждой минуты, как сразу считал прежний. Перезаписывать — только если
// смена изменилась нарочно (тогда же — и в «Больнице», Nefeste/bolnitsa); в последний раз — часть 89 (spec
// 2026-10-code-blue): анализы одному — один забор, пробы — партиями. С 0.6.12 номер базы в отпечаток не входит: смена
// та же, отпечатки записаны заново один раз. bun tools/test/make-review-fixture.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, newSingle, settleReviews } from '../../src/engine/shift/engine';
import { DAY, type ShiftState } from '../../src/engine/shift/types';
import { buildDb } from '../content/load';

const { db } = buildDb();
// номер базы в состоянии смены — не сама смена: с новой версией базы отпечаток прежний (0.6.12, база 79)
const hash = (x: unknown) => Bun.hash(JSON.stringify(x, (k, v) => (k === 'contentVersion' ? undefined : v))).toString(16);
const hired = (s: ShiftState) => Object.values(s.patients).filter(p => p.closed?.by !== undefined).sort((a, b) => (a.id < b.id ? -1 : 1));
function liveUntil(s: ShiftState, hour: number) {
  const end = (s.day - 1) * DAY + hour * 3600;
  while (s.t < end) {
    apply(db, s, { kind: 'advance', seconds: Math.min(60, end - s.t) });
    settleReviews(db, s);
  }
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
