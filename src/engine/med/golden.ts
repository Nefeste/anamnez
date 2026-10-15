// Отпечаток большого прогона генератора и обследований (`docs/06-testing.md` §2).
// Один и тот же код считают тест в Bun, экран проверки в приложении (Hermes) и сценарий
// в браузере (V8): совпадение отпечатков — проверка детерминизма между движками (П3).
import type { ContentDb } from '../../content/types';
import { fingerprint } from '../core/hash';
import { Rng } from '../core/rng';
import { complaintObservations, runExam } from './exams';
import { generatePatient } from './generate';
import { contextOf, expectedGain, posterior } from './infer';
import { runDoctor } from './policy';

export interface GoldenRun {
  hash: string;
  /** сколько раз выпало каждое основное заболевание */
  primaries: Record<string, number>;
}

export function goldenRun(db: ContentDb, count: number): GoldenRun {
  const seasons = ['winter', 'spring', 'summer', 'autumn'] as const;
  const examIds = Object.keys(db.exams).sort();
  const primaries: Record<string, number> = {};
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = generatePatient(db, 7_000_000 + i, { department: 'dept.therapy', season: seasons[i % 4] });
    const root = Rng.seeded(p.seed).fork('golden');
    const results = examIds.map(id => runExam(db, p, id, root.fork(id)));
    const primary = p.truth.conditions[0].id;
    primaries[primary] = (primaries[primary] ?? 0) + 1;
    parts.push(fingerprint({ p, results }));
  }
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(primaries).sort()) sorted[k] = primaries[k];
  return { hash: fingerprint(parts), primaries: sorted };
}

/**
 * Отпечаток вывода (0.5.11, NFR-PRF-1): разумный врач у `count` пациентов терапии — его обследования и диагноз, а на
 * каждом его шаге — уверенность во всех болезнях и польза каждого обследования. Ускорения вывода не меняют ни одного
 * числа: поменялось — тест падает, как у золотых случаев; меняется база — отпечаток пересоздают вместе с ними.
 */
export function inferenceRun(db: ContentDb, count: number): string {
  const seasons = ['winter', 'spring', 'summer', 'autumn'] as const;
  const exams = Object.keys(db.exams).sort();
  const candidates = Object.keys(db.conditions).sort().filter(id => db.conditions[id].presenting && db.conditions[id].department === 'dept.therapy');
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = generatePatient(db, 7_100_000 + i, { department: 'dept.therapy', season: seasons[i % 4] });
    const r = runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('inference'), { candidates, exams });
    const obs = complaintObservations(p);
    const steps: unknown[] = [];
    for (const e of [undefined, ...r.exams]) {
      if (e) obs.push(...runExam(db, p, e, Rng.seeded(p.seed).fork(`inference:${e}`)));
      const ctx = contextOf(db, p, obs);
      const beliefs = posterior(db, candidates, obs, ctx);
      const seen = new Set(obs.map(o => o.f));
      steps.push({ b: beliefs.map(x => [x.id, x.p]), g: exams.map(x => expectedGain(db, x, beliefs, ctx, seen)) });
    }
    parts.push(fingerprint({ d: r.diagnosis, e: r.exams, steps }));
  }
  return fingerprint(parts);
}
