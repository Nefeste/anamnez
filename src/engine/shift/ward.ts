// Стационар своей больницы (spec 2026-09-chapter-2, часть 26): палаты и койки, лежащие, течение
// болезни по суткам с назначенным планом, обход и выписка.
//
// Как пойдёт болезнь, решается при поступлении и при каждой смене плана — из именованной ветви
// зерна пациента (ADR 0004); ночь сама ничего не меняет: где пациент в своей болезни, считается
// по суткам в стационаре. Так обход, итоги дня и повтор дают одно и то же.
import type { ContentDb, Id } from '../../content/types';
import { P_ONE, type Rng } from '../core/rng';
import { type Plan, type PlanEval, primaryOf } from '../med/plan';
import type { Patient } from '../med/types';
import type { Operation } from './surgery';

/** Койка: помещение-палата и номер койки в нём. */
export interface Bed {
  room: string;
  bed: number;
}

/** Как идёт болезнь лежащего — с суток `from` от поступления (после смены плана — с неё). */
export interface WardCourse {
  /** через сколько суток от поступления можно выписывать; нет — лечение на причину не действует */
  readyAfter?: number;
  /** через сколько суток станет хуже, если лечение не действует */
  worseAfter?: number;
  /** реакция на назначенное при противопоказании, которое у пациента есть: что и на что */
  reaction?: { tx: Id; by: Id; after: number };
}

/** Лежит в палате своей больницы. */
export interface Stay extends WardCourse, Bed {
  /** день поступления */
  since: number;
  /** назначенное сейчас */
  plan: Plan;
  /** с каких суток идёт нынешний план */
  planFrom: number;
  /** сколько раз план меняли — номер ветви зерна */
  replans: number;
  /** операция (spec 2026-09-chapter-2, часть 28): ждёт, идёт или сделана */
  op?: Operation;
}

/** Что видно на обходе: лучше, без перемен, хуже, можно выписывать, реакция на лечение. */
export type WardState = 'better' | 'same' | 'worse' | 'ready' | 'reaction';

/** Итог стационара у закрытого случая: сколько суток, обычный срок, выписан ли рано. */
export interface StayResult {
  days: number;
  norm: number;
  end: 'discharged' | 'early' | 'transferred';
}

/** Сутки в стационаре: день поступления — ноль, следующее утро — первые сутки. */
export const daysIn = (stay: Stay, day: number) => Math.max(0, day - stay.since);

/**
 * Обычный срок стационара при этой болезни, сутки: `stay` записи (по рекомендации), иначе —
 * конец срока действия на причину у типичного назначения, иначе неделя.
 */
export function stayNorm(db: ContentDb, condition: Id): number {
  const c = db.conditions[condition];
  if (!c) return 7;
  if (c.stay) return c.stay[1];
  const plan = c.treatment?.plan ?? c.treatment?.firstLine ?? [];
  const days = plan.flatMap(tx => db.treatments[tx]?.effects.filter(e => e.on === condition && e.kind === 'cure').map(e => e.days[1]) ?? []);
  return days.length > 0 ? Math.max(...days) : 7;
}

/** 1 − Π(1 − pᵢ) в долях 1/10 000, целыми — как у исхода дома (course.ts). */
function anyOf(ps: readonly number[]): number {
  let miss = P_ONE;
  for (const p of ps) miss = Math.floor((miss * (P_ONE - p)) / P_ONE);
  return P_ONE - miss;
}

/**
 * Течение в палате с планом `plan` с суток `from`: противопоказание, которое есть, — реакция
 * на следующие сутки; лечение причины — выписка через срок `stay` записи (или срок действия
 * лечения); не действует — хуже через срок `untreated`, а само проходящее проходит к концу
 * своих стадий.
 */
export function wardCourse(db: ContentDb, patient: Patient, plan: Plan, ev: PlanEval, rng: Rng, from = 0): WardCourse {
  const primary = primaryOf(patient);
  const cond = db.conditions[primary.id];
  const out: WardCourse = {};
  for (const v of ev.violations) {
    const k = db.treatments[v.tx].contraindications.find(c => c.id === v.by)!;
    if (rng.fork(`reaction:${v.tx}:${v.by}`).chance(k.reaction)) {
      out.reaction = { tx: v.tx, by: v.by, after: from + 1 };
      break;
    }
  }
  const cures = plan.treatments.flatMap(tx => db.treatments[tx]?.effects.filter(e => e.on === primary.id && e.kind === 'cure') ?? []);
  if (cures.length > 0 && rng.fork('cure').chance(anyOf(cures.map(e => e.p)))) {
    const [lo, hi] = cond.stay ?? [Math.max(1, Math.min(...cures.map(e => e.days[0]))), Math.max(1, ...cures.map(e => e.days[1]))];
    out.readyAfter = from + rng.fork('ready').range(lo, hi);
    return out;
  }
  if (cond.selfLimiting) {
    const end = cond.stages[cond.stages.length - 1].days[1];
    out.readyAfter = from + Math.max(1, end - primary.day - from);
    return out;
  }
  if (cond.untreated) out.worseAfter = from + Math.max(1, rng.fork('worse').range(cond.untreated.days[0], cond.untreated.days[1]));
  return out;
}

/** Где лежащий в своей болезни на эти сутки. */
export function wardState(stay: Stay, days: number): WardState {
  if (stay.reaction && days >= stay.reaction.after) return 'reaction';
  if (stay.readyAfter !== undefined) return days >= stay.readyAfter ? 'ready' : 'better';
  if (stay.worseAfter !== undefined && days >= stay.worseAfter) return 'worse';
  return 'same';
}

/** Витальные на обходе: температура, пульс, частота дыхания, сатурация, давление. */
export const WARD_VITALS: Id[] = ['vital.fever', 'vital.tachycardia', 'vital.tachypnea', 'vital.spo2_low', 'vital.bp_high'];

/**
 * Значение витального на сутки: к выписке — к норме по прямой, при ухудшении — дальше от
 * нормы, к краю «есть признак», иначе — как при поступлении. Без случайности: график обхода
 * тот же при каждом открытии.
 */
export function vitalOn(db: ContentDb, patient: Patient, stay: Stay, f: Id, days: number): number | undefined {
  const spec = db.findings[f]?.value;
  const base = patient.truth.values[f];
  if (!spec || base === undefined) return undefined;
  const normal = (spec.absent[0] + spec.absent[1]) / 2;
  const round = (x: number) => Number(x.toFixed(spec.decimals));
  if (stay.readyAfter !== undefined) {
    const from = stay.planFrom;
    const span = Math.max(1, stay.readyAfter - from);
    const k = Math.min(1, Math.max(0, (days - from) / span));
    // до смены плана болезнь шла, как шла: значение при поступлении
    return round(days <= from ? base : base + (normal - base) * k);
  }
  if (stay.worseAfter !== undefined && days >= stay.worseAfter) {
    const far = Math.abs(spec.present[0] - normal) > Math.abs(spec.present[1] - normal) ? spec.present[0] : spec.present[1];
    const k = Math.min(1, (days - stay.worseAfter + 1) / 2);
    // хуже — дальше от нормы; если значение уже было в норме, болезнь уводит его к признаку
    return round(base + (far - base) * k * 0.5);
  }
  return round(base);
}
