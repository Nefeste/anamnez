// Исход случая (`docs/04-medical-model.md` §7, §9). Для «домой» болезнь проматывается на
// срок наблюдения с назначенным планом; перевод — исход сразу. Вернувшийся хуже пациент —
// главное наказание за ошибку: последствие, а не надпись «неверно».
//
// Код меняет состояние партии, поэтому только целые числа и именованные ветви генератора
// (ADR 0004): одинаковый исход на телефоне и в тестах.
import type { ContentDb, Id } from '../../content/types';
import { P_ONE, type Rng } from '../core/rng';
import { curesOf, harmsOf, type Plan, type PlanEval, primaryOf, selfLimits, SETTING_ORDER, untreatedOf, whenHolds } from './plan';
import type { Patient } from './types';

/** Сколько дней после приёма модель следит за пациентом, отпущенным домой. */
export const OBSERVE_DAYS = 7;

/** `admitted` — лёг в свою палату (часть 26) или в операционную, затем в палату (часть 28): чем кончится, скажет выписка. */
export type OutcomeKind = 'recovered' | 'improved' | 'unchanged' | 'worse' | 'reaction' | 'transferred' | 'admitted' | 'died';

export interface Outcome {
  kind: OutcomeKind;
  /** на какой день после приёма это стало ясно */
  day: number;
  /**
   * вернётся ли пациент новым обращением и когда; `as` (spec 2026-10-chapter-3, часть 41б) — с
   * другой болезнью: после ТИА без профилактики — с инсультом
   */
  returns?: { day: number; reason: 'worse' | 'reaction' | 'unchanged'; as?: Id };
  /** подействовало ли лечение на причину — для разбора */
  cured: boolean;
  /** что вызвало реакцию: назначение и противопоказание к нему */
  reaction?: { tx: Id; by: Id };
  /** переведён в тяжёлом состоянии — «мягкий режим» вместо смерти (spec 2026-09-chapter-2, часть 28б) */
  severe?: true;
  /** переведён в сосудистый центр с подъёмом ST: как и когда открыли артерию (spec 2026-10-chapter-3, часть 39б) */
  rsc?: Reperfused;
  /**
   * выписан после острого периода (часть 41а): `clear` — лечение подействовало, последствий нет;
   * `residual` — последствия остались, дальше реабилитация
   */
  settled?: 'clear' | 'residual';
}

/**
 * Как и когда открыли артерию переведённому (часть 39б): тромболизис здесь удался; не удался —
 * «спасающее» вмешательство в центре; без тромболизиса — вмешательство в центре после пути.
 */
export interface Reperfused {
  by: 'lysis' | 'rescue' | 'pci';
  /** часов от начала болезни до реперфузии, целые */
  hours: number;
  /** доля потери пользы по часам, %: позже последнего часа записи — 100 */
  loss: number;
}

/** Путь в сосудистый центр: часов дороги и от приезда до вмешательства (economy.yaml, `transfer`). */
export interface Way {
  hours: number;
  pci: number;
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
  // вред при самой болезни (часть 41в): тромболизис при кровоизлиянии в мозг — кровотечение
  for (const h of harmsOf(db, primary, plan.treatments)) {
    if (rng.fork(`harm:${h.tx}`).chance(h.p)) return { kind: 'reaction', day: 1, returns: { day: 1, reason: 'reaction' }, cured: false, reaction: { tx: h.tx, by: primary.id } };
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
    return { kind: 'worse', day, returns: { day, reason: 'worse', ...(untreated.as ? { as: untreated.as } : {}) }, cured: false };
  }
  if (selfLimits(db, primary)) {
    // проходит к концу последней стадии, считая от дня болезни на приёме
    const end = cond.stages[cond.stages.length - 1].days[1];
    const left = Math.max(1, end - primary.day);
    return left <= OBSERVE_DAYS ? { kind: 'recovered', day: left, cured: false } : { kind: 'improved', day: OBSERVE_DAYS, cured: false };
  }
  return { kind: 'unchanged', day: OBSERVE_DAYS, returns: { day: OBSERVE_DAYS, reason: 'unchanged' }, cured: false };
}

/** Доля потери по часам до реперфузии, %: первый интервал записи, в который попали минуты; позже — 100. */
export function lossAt(loss: readonly (readonly [number, number])[], minutes: number): number {
  return loss.find(([h]) => minutes < h * 60)?.[1] ?? 100;
}

/**
 * Исход переведённого в сосудистый центр по часам до реперфузии (spec 2026-10-chapter-3, часть
 * 39б). `decided` — минут от начала болезни до решения о переводе. Тромболизис в плане открывает
 * артерию через `lysis.hours` с долей `lysis.p` (ветвь `lysis`); не открыл — «спасающее»
 * вмешательство в центре после пути; без тромболизиса — вмешательство после пути. Смертность — в
 * границах класса Killip, ближе к верхней на долю потери по часам (ветвь `death`). Нет записи или
 * болезнь не та (без подъёма ST) — undefined: исход прежний. В «мягком режиме» вместо смерти —
 * переведён в тяжёлом состоянии.
 */
export function rscOutcome(db: ContentDb, patient: Patient, plan: Plan, decided: number, way: Way, rng: Rng, soft = false): Outcome | undefined {
  const primary = primaryOf(patient);
  const r = db.conditions[primary.id]?.reperfusion;
  if (!r || !whenHolds(r.when, primary.params)) return undefined;
  const lysed = plan.treatments.includes(r.lysis.tx);
  const by: Reperfused['by'] = !lysed ? 'pci' : rng.fork('lysis').chance(r.lysis.p) ? 'lysis' : 'rescue';
  const at = Math.round(decided) + (by === 'lysis' ? r.lysis.hours * 60 : (way.hours + way.pci) * 60);
  const loss = lossAt(r.loss, at);
  // класс из сохранений до 0.3.6 не известен — первый, без сердечной недостаточности
  const [lo, hi] = r.death[primary.params[r.by]] ?? Object.values(r.death)[0];
  const rsc: Reperfused = { by, hours: Math.round(at / 60), loss };
  if (!rng.fork('death').chance(lo + Math.floor(((hi - lo) * loss) / 100))) return { kind: 'transferred', day: 0, cured: false, rsc };
  if (soft) return { kind: 'transferred', day: 0, cured: false, severe: true, rsc };
  return { kind: 'died', day: rng.fork('death-day').range(0, 2), cured: false, rsc };
}
