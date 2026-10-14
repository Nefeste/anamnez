// Профессия пациента (FR-PAT-2, spec 2026-10-occupation, 0.5.10): кем работает — по полу и возрасту, пенсионер — по доле
// в возрасте; вредности профессии — доли её факторов риска. Генератор берёт их при рождении пациента, вывод — как долю
// неизвестного фактора: профессию знают с регистратуры.
import type { ContentDb, Id, P } from '../../content/types';
import type { Rng } from '../core/rng';
import type { Sex } from './types';

/** Кем работает: пенсионер — по доле его возраста, иначе — по весам профессий этого пола и возраста. */
export function pickJob(db: ContentDb, rng: Rng, sex: Sex, age: number): Id | undefined {
  const all = Object.keys(db.jobs).sort().map(id => db.jobs[id]);
  if (all.length === 0) return undefined;
  const retired = all.find(j => j.retired);
  const share = [...(retired?.retired ?? [])].reverse().find(r => age >= r.from)?.p ?? 0;
  if (retired && rng.fork('retired').chance(share)) return retired.id;
  const fits = all.filter(j => !j.retired && j.weight > 0 && j.sex[sex] > 0 && age >= j.age.min && age <= j.age.max);
  // валидатор базы следит, чтобы в каждом возрасте было кем работать
  if (fits.length === 0) return retired?.id;
  return rng.fork('pick').weighted(fits, j => Math.round(j.weight * (j.sex[sex] / (j.sex.m + j.sex.f)) * 1000)).id;
}

/** Доля фактора риска у человека этого пола и профессии: профессия его называет — её доля, иначе — доля записи. */
export function riskShare(db: ContentDb, risk: Id, sex: Sex, job: Id | undefined): P {
  const h = job ? db.jobs[job]?.hazards.find(x => x.id === risk) : undefined;
  return h ? h.p : db.risks[risk].p[sex];
}

/** Название профессии в роде пациента: «Учительница», «Строитель». */
export function jobName(db: ContentDb, job: Id, sex: Sex): string {
  const j = db.jobs[job];
  return (sex === 'f' ? j?.female?.ru : undefined) ?? j?.name.ru ?? job;
}
