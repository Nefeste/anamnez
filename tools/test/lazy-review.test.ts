// Разбор приёма нанятого врача по требованию: при закрытии его приёма разумный врач разбора больше не считается —
// бережливость и общая оценка досчитываются `settleReviews` при закрытии дня (в паузах игры его готовит
// `prepareReview`), а экраны читают приём через `reviewedCase`, не меняя состояния. Всё — то же до байта, что прежде:
// отпечатки сразу считаемого разбора — tools/test/fixtures/eager-review.json (до 0.6.9 — движок @ 96503ac, с 0.6.9 —
// нынешний, разбор после каждой минуты; те же смены; tools/test/make-review-fixture.ts). Ускорение — из «Больницы» (Nefeste/bolnitsa, spec 2026-10-engine-speed, ч. 1).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDb } from '../content/load';
import { apply, newSingle, reviewedCase, reviewsDue, settleReviews } from '../../src/engine/shift/engine';
import { DAY, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';

const { db } = buildDb();
const eager = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/eager-review.json'), 'utf8')) as {
  venue: string; seed: number; atNoon: { count: number; hash: string }; hired: number; closed: string;
}[];

const hash = (x: unknown) => Bun.hash(JSON.stringify(x)).toString(16);
const hiredClosed = (s: ShiftState): ShiftPatient[] => Object.values(s.patients).filter(p => p.closed?.by !== undefined).sort((a, b) => (a.id < b.id ? -1 : 1));
function liveUntil(s: ShiftState, hour: number) {
  const end = (s.day - 1) * DAY + hour * 3600;
  while (s.t < end) apply(db, s, { kind: 'advance', seconds: Math.min(60, end - s.t) });
}

describe('разбор нанятого врача по требованию', () => {
  for (const want of eager) {
    test(`городская больница, зерно ${want.seed}: прочитанный приём и итог дня — те же, что сразу`, () => {
      const s = newSingle(db, { seed: want.seed, season: 'winter', venue: want.venue });
      liveUntil(s, 12);
      const noon = hiredClosed(s);
      expect(noon.length).toBe(want.atNoon.count);
      expect(reviewsDue(s)).toBe(noon.length);
      const before = hash(s);
      expect(hash(noon.map(p => [p.id, reviewedCase(db, s, p)]))).toBe(want.atNoon.hash);
      // прочитать — не значит изменить
      expect(hash(s)).toBe(before);
      liveUntil(s, 18);
      apply(db, s, { kind: 'closeDay' });
      expect(reviewsDue(s)).toBe(0);
      expect(hiredClosed(s).length).toBe(want.hired);
      expect(hash(s)).toBe(want.closed);
    }, 60_000);
  }

  test('досчёт по частям среди дня — тот же итог дня', () => {
    const want = eager[0];
    const s = newSingle(db, { seed: want.seed, season: 'winter', venue: want.venue });
    liveUntil(s, 11);
    let rounds = 0;
    for (;;) {
      let left = 3;
      rounds++;
      if (settleReviews(db, s, () => left-- > 0)) break;
    }
    expect(rounds).toBeGreaterThan(1);
    expect(reviewsDue(s)).toBe(0);
    liveUntil(s, 18);
    apply(db, s, { kind: 'closeDay' });
    expect(hash(s)).toBe(want.closed);
  }, 60_000);
});
