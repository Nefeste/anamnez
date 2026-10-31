// Спокойный учебный день главы 1 (часть 100, spec 2026-10-publish-ready; ответ владельца на вопрос 67): половина потока,
// у пришедших сами и записанных, кроме заданных, — жалобы только «в порядке очереди»; со второго дня — как было.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { ContentDb } from '../../src/content/types';
import { apply, newCampaign } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';

const ch1 = db.chapters['chapter.district'];
/** та же база, но глава 1 — без спокойного учебного дня */
const { tutorialCalm: _calm, ...plainCh1 } = ch1;
const plain: ContentDb = { ...db, chapters: { ...db.chapters, [ch1.id]: plainCh1 } };

function day(base: ContentDb, seed: number, days = 1): ShiftState {
  const s = newCampaign(base, { seed, season: 'winter', difficulty: 'student', career: 1 });
  for (let d = 0; d < days; d++) {
    if (d > 0) apply(base, s, { kind: 'closeDay' });
    apply(base, s, { kind: 'nextDay' });
  }
  return s;
}
const today = (s: ShiftState) => Object.values(s.patients).filter(p => p.id.startsWith(`${s.day}-`));
const calmOf = (p: ShiftState['patients'][string]) => p.patient.complaints.every(f => db.findings[f]?.triage === undefined);
const SEEDS = Array.from({ length: 12 }, (_, i) => 900 + i);

describe('спокойный учебный день главы 1', () => {
  test('у главы 1 — спокойный учебный день, у остальных — нет', () => {
    expect(Object.values(db.chapters).filter(c => c.tutorialCalm).map(c => c.id)).toEqual(['chapter.district']);
  });

  test('в учебный день — около половины потока', () => {
    const calm = SEEDS.reduce((n, seed) => n + today(day(db, seed)).length, 0);
    const before = SEEDS.reduce((n, seed) => n + today(day(plain, seed)).length, 0);
    expect(calm / before).toBeGreaterThan(0.35);
    expect(calm / before).toBeLessThan(0.65);
  });

  test('незаданные — без «нужно скоро» и «срочно»; заданные — как глава велит', () => {
    for (const seed of SEEDS) {
      const ps = today(day(db, seed));
      const taught = ps.filter(p => p.taught);
      expect(taught.map(p => p.patient.truth.conditions[0].id).sort()).toEqual([...ch1.tutorial.map(t => t.condition)].sort());
      for (const p of ps.filter(x => !x.taught)) expect({ seed, id: p.id, calm: calmOf(p) }).toEqual({ seed, id: p.id, calm: true });
    }
  });

  test('со второго дня — поток как был', () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const a = today(day(db, seed, 2)).map(p => [p.arriveT, p.patient.truth.conditions[0].id]);
      const b = today(day(plain, seed, 2)).map(p => [p.arriveT, p.patient.truth.conditions[0].id]);
      expect(a).toEqual(b);
    }
  });
});
