// Отпечаток большого прогона генератора и обследований (`docs/09-testing.md` §2).
// Один и тот же код считают тест в Bun, экран проверки в приложении (Hermes) и сценарий
// в браузере (V8): совпадение отпечатков — проверка детерминизма между движками (П3).
import type { ContentDb } from '../../content/types';
import { fingerprint } from '../core/hash';
import { Rng } from '../core/rng';
import { runExam } from './exams';
import { generatePatient } from './generate';

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
