// Исход случая (`docs/04-medical-model.md` §7, §9). Для «домой» болезнь проматывается на
// срок наблюдения с назначенным планом; перевод — исход сразу. Вернувшийся хуже пациент —
// главное наказание за ошибку: последствие, а не надпись «неверно».
//
// Код меняет состояние партии, поэтому только целые числа и именованные ветви генератора
// (ADR 0004): одинаковый исход на телефоне и в тестах.
import type { ContentDb, Id } from '../../content/types';
import { P_ONE, type Rng } from '../core/rng';
import { curesOf, type Plan, type PlanEval, primaryOf, selfLimits, SETTING_ORDER, untreatedOf } from './plan';
import type { Patient } from './types';

/** Сколько дней после приёма модель следит за пациентом, отпущенным домой. */
export const OBSERVE_DAYS = 7;

/** `admitted` — лёг в свою палату (часть 26) или в операционную, затем в палату (часть 28): чем кончится, скажет выписка. */
export type OutcomeKind = 'recovered' | 'improved' | 'unchanged' | 'worse' | 'reaction' | 'transferred' | 'admitted' | 'died';

export interface Outcome {
  kind: OutcomeKind;
  /** на какой день после приёма это стало ясно */
  day: number;
  /** вернётся ли пациент новым обращением и когда */
  returns?: { day: number; reason: 'worse' | 'reaction' | 'unchanged' };
  /** подействовало ли лечение на причину — для разбора */
  cured: boolean;
  /** что вызвало реакцию: назначение и противопоказание к нему */
  reaction?: { tx: Id; by: Id };
  /** переведён в тяжёлом состоянии — «мягкий режим» вместо смерти (spec 2026-09-chapter-2, часть 28б) */
  severe?: true;
}

/** 1 − Π(1 − pᵢ) в долях 1/10 000, целыми. */
function anyOf(ps: readonly number[]): number {
  let miss = P_ONE;
  for (const p of ps) miss = Math.floor((miss * (P_ONE - p)) / P_ONE);
  return P_ONE - miss;
}

export function observe(db: ContentDb, patient: Patient, plan: Plan, ev: PlanEval, rng: Rng): Outcome {
  // своя палата, операционная и ПИТ (часть 38а) — лежит у нас; иначе — увезли или направили
  if (plan.setting === 'admit' || plan.setting === 'surgery' || plan.setting === 'icu') return { kind: 'admitted', day: 0, cured: ev.effective };
  if (plan.setting !== 'home') return { kind: 'transferred', day: 0, cured: false };
  const primary = primaryOf(patient);
  const cond = db.conditions[primary.id];

  // 1. Противопоказание, которое у пациента есть: вред с вероятностью из записи лечения.
  for (const v of ev.violations) {
    const k = db.treatments[v.tx].contraindications.find(c => c.id === v.by)!;
    if (rng.fork(`reaction:${v.tx}:${v.by}`).chance(k.reaction)) {
      return { kind: 'reaction', day: 1, returns: { day: 1, reason: 'reaction' }, cured: false, reaction: { tx: v.tx, by: v.by } };
    }
  }

  // 2. Лечение причины. Дома то, что надо лечить в стационаре, помогает вдвое реже.
  const cures = curesOf(db, primary, plan.treatments);
  const underTreated = SETTING_ORDER[ev.setting.recommended] > SETTING_ORDER.home;
  const pCure = anyOf(cures.map(e => (underTreated ? Math.floor(e.p / 2) : e.p)));
  if (cures.length > 0 && rng.fork('cure').chance(pCure)) {
    const lo = Math.min(...cures.map(e => e.days[0]));
    const hi = Math.max(...cures.map(e => e.days[1]));
    const day = rng.fork('cure-day').range(lo, hi);
    return day <= OBSERVE_DAYS ? { kind: 'recovered', day, cured: true } : { kind: 'improved', day: OBSERVE_DAYS, cured: true };
  }

  // 3. Без действенного лечения: ухудшение по записи состояния, иначе — как пойдёт болезнь.
  // И то и другое может зависеть от скрытого параметра (часть 30д: форма дивертикулита).
  const untreated = untreatedOf(db, primary);
  if (untreated && rng.fork('worse').chance(untreated.p)) {
    const day = Math.min(OBSERVE_DAYS, rng.fork('worse-day').range(untreated.days[0], untreated.days[1]));
    return { kind: 'worse', day, returns: { day, reason: 'worse' }, cured: false };
  }
  if (selfLimits(db, primary)) {
    // проходит к концу последней стадии, считая от дня болезни на приёме
    const end = cond.stages[cond.stages.length - 1].days[1];
    const left = Math.max(1, end - primary.day);
    return left <= OBSERVE_DAYS ? { kind: 'recovered', day: left, cured: false } : { kind: 'improved', day: OBSERVE_DAYS, cured: false };
  }
  return { kind: 'unchanged', day: OBSERVE_DAYS, returns: { day: OBSERVE_DAYS, reason: 'unchanged' }, cured: false };
}
