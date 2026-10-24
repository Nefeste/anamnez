// Дифференциальный ряд игрока (FR-DX-7, spec 2026-10-differential, 0.5.8): что в открытом о пациенте говорит за
// гипотезу и против неё и что типичное для неё ещё не проверено. Числа — из той же модели, что вывод (`infer.ts`):
// вероятность признака при гипотезе и без неё, с известными хроническими болезнями и факторами риска. Правды движок
// здесь не трогает — только то, что врач видит, и то, что база знает о болезни.
import type { ContentDb, Id } from '../../content/types';
import { examFits } from './exams';
import { findingProbability, type InferContext } from './infer';
import type { Observation, Patient } from './types';

/** «За»: при гипотезе признак бывает хотя бы вдвое чаще, чем без неё, и разница — не меньше 10 из 100 (игровая оценка). */
export const PRO_RATIO = 2;
export const PRO_MIN = 0.1;
/** «Не объясняет»: без гипотезы признак редок (реже 3 из 10), и с ней — не чаще чем в полтора раза (игровая оценка). */
export const RARE = 0.3;
export const NO_RAISE = 1.5;
/** Типичный признак: при гипотезе — хотя бы у половины; его отсутствие — довод против, а непроверенный — в списке. */
export const TYPICAL = 0.5;
/** Сколько непроверенных показывать: самые частые при гипотезе. */
export const UNCHECKED_MAX = 5;

export interface Evidence {
  /** найденные признаки, которые при гипотезе заметно чаще; `p` — как часто при ней */
  pro: { f: Id; p: number }[];
  /** найденные признаки, которых она не объясняет, и отсутствующие, которые при ней обычно есть */
  con: { f: Id; kind: 'unexplained' | 'absent'; p: number }[];
  /** типичные для неё признаки, которых ещё никто не искал; `exam` — самое дешёвое обследование, что их ищет */
  unchecked: { f: Id; p: number; exam?: Id }[];
}

/**
 * Кто ищет признак: обследования, подходящие пациенту, — самое дешёвое первым; уточнения (`given`) не в счёт. С частью 94 —
 * и для подсказки «Практиканту»: чем проверить важное при опасной причине.
 */
export function examsFor(db: ContentDb, f: Id, patient: Pick<Patient, 'sex' | 'age' | 'complaints'>): Id[] {
  return Object.values(db.exams)
    .filter(e => e.checks.some(c => c.f === f && !c.given) && examFits(e, patient))
    .sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1))
    .map(e => e.id);
}

/**
 * Доводы за гипотезу `h` и против неё по наблюдениям врача; `done` — сделанные обследования: признак, который они
 * ищут, проверен, даже если о нём нет строки.
 */
export function evidenceFor(
  db: ContentDb, h: Id, observations: readonly Observation[], ctx: InferContext, patient: Pick<Patient, 'sex' | 'age' | 'complaints'>, done: readonly Id[],
): Evidence {
  const c = db.conditions[h];
  const out: Evidence = { pro: [], con: [], unchecked: [] };
  if (!c) return out;
  const known = ctx.knownConditions.filter(x => x !== h);
  // у этого пациента (FR-MED-1): пол и возраст меняют частоты
  const withH = (f: Id) => findingProbability(db, f, [h, ...(c.requires ?? []), ...known], ctx.knownRisks, 1, ctx);
  const without = (f: Id) => findingProbability(db, f, known, ctx.knownRisks, 1, ctx);
  // одно наблюдение на признак: показано ли «есть» хоть раз
  const seen = new Map<Id, boolean>();
  for (const o of observations) {
    if (db.findings[o.f]?.evidence === false) continue;
    seen.set(o.f, (seen.get(o.f) ?? false) || o.shown);
  }
  for (const [f, shown] of seen) {
    const p = withH(f);
    if (!shown) {
      if (p >= TYPICAL) out.con.push({ f, kind: 'absent', p });
      continue;
    }
    const q = without(f);
    if (p >= q * PRO_RATIO && p - q >= PRO_MIN) out.pro.push({ f, p });
    else if (q < RARE && p < q * NO_RAISE) out.con.push({ f, kind: 'unexplained', p });
  }
  const checked = new Set([...seen.keys(), ...done.flatMap(id => db.exams[id]?.checks.map(x => x.f) ?? [])]);
  const typical = new Map<Id, number>();
  for (const l of c.findings) {
    if (checked.has(l.f) || typical.has(l.f) || db.findings[l.f]?.evidence === false) continue;
    const p = withH(l.f);
    if (p >= TYPICAL) typical.set(l.f, p);
  }
  out.unchecked = [...typical]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, UNCHECKED_MAX)
    .map(([f, p]) => {
      const exam = examsFor(db, f, patient)[0];
      return exam ? { f, p, exam } : { f, p };
    });
  out.pro.sort((a, b) => b.p - a.p || (a.f < b.f ? -1 : 1));
  out.con.sort((a, b) => (a.kind === b.kind ? b.p - a.p : a.kind === 'unexplained' ? -1 : 1) || (a.f < b.f ? -1 : 1));
  return out;
}
