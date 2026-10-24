// Сценарии «Быстрой игры» (часть 91, spec 2026-10-scenarios): итог недели — итог «Смены» за пять смен и цели сценария.
// «Зимний грипп» — пневмонию не пропустить и антибиотик без нужды не давать; «Закрыли соседнюю больницу» — очередь и
// смертность; «Рентген сломался» — итог недели не ниже «B». У каждого сценария — и сколько своих пациентов за неделю: по
// двум-трём о неделе не судят.
import type { ContentDb } from '@/content/types';
import { type Scenario, SCENARIO_DAYS } from '@/engine/shift/scenarios';
import type { ShiftPatient, ShiftState } from '@/engine/shift/types';
import { POINTS, singleResult, type SingleResult } from './single';

/** своих пациентов за неделю — не меньше */
export const WEEK_SEEN = 30;
/** «Зимний грипп»: пневмонию распознали у стольких процентов своих больных с ней — не меньше */
export const PNEUMONIA_CAUGHT = 75;
/** «Зимний грипп»: антибиотик без нужды — не больше чем у стольких процентов своих пациентов */
export const NEEDLESS_ANTIBIOTIC = 5;
/** «Закрыли соседнюю больницу»: ушли, не дождавшись, и не приняты к концу смены — не больше стольких процентов пришедших */
export const QUEUE_LOST = 30;
/** «Закрыли соседнюю больницу»: умерли — не больше стольких процентов своих пациентов */
export const DEATHS = 3;
/** «Рентген сломался»: итог недели — не ниже */
export const WEEK_GRADE = 'B' as const;

export type ScenarioGoalKey = 'seen' | 'pneumonia' | 'antibiotic' | 'queue' | 'deaths' | 'overall';

export interface ScenarioGoal {
  key: ScenarioGoalKey;
  /** сколько вышло: проценты, пациенты, у итога — оценка */
  value: number | string;
  /** из скольких — у долей */
  of?: number;
  ok: boolean;
}

export interface ScenarioResult {
  /** итог «Смены» за все смены недели — своими приёмами */
  week: SingleResult | undefined;
  goals: ScenarioGoal[];
  /** неделя закончена и все цели выполнены */
  passed: boolean;
  /** смен сыграно (закрыто) — из `SCENARIO_DAYS` */
  days: number;
}

const own = (s: ShiftState) => Object.values(s.patients).filter((p): p is ShiftPatient & { closed: NonNullable<ShiftPatient['closed']> } => !!p.closed && !p.closed.by);
const pct = (a: number, b: number) => (b > 0 ? Math.round((100 * a) / b) : 0);

/** Антибиотик без нужды: в разборе приёма — «не показан» у назначенного антибиотика. */
export function needlessAntibiotic(db: ContentDb, p: { closed?: ShiftPatient['closed'] }): boolean {
  return !!p.closed?.notes.some(n => n.code === 'tx.notIndicated' && !!n.tx && !!db.treatments[n.tx]?.class?.startsWith('antibiotic.'));
}

/**
 * Итог недели сценария по тому, что сыграно: смены — закрытые дни; цели — по своим приёмам недели (у пневмонии — по
 * правде, как в разборе); `passed` — после пятой смены.
 */
export function scenarioResult(db: ContentDb, s: ShiftState): ScenarioResult | undefined {
  const scenario: Scenario | undefined = s.meta.scenario;
  if (!scenario) return undefined;
  const cases = own(s);
  const week = singleResult(s);
  const days = s.history.length;
  const arrived = s.history.reduce((a, h) => a + h.arrived, 0) + (s.dayOpen ? s.summary.arrived : 0);
  const lost = s.history.reduce((a, h) => a + h.left + h.unseen, 0) + (s.dayOpen ? s.summary.left : 0);
  const goals: ScenarioGoal[] = [{ key: 'seen', value: cases.length, ok: cases.length >= WEEK_SEEN }];
  if (scenario === 'flu') {
    const sick = cases.filter(p => p.patient.truth.conditions.some(c => c.id === 'cond.pneumonia_cap'));
    const caught = sick.filter(p => p.closed.diagnosis === 'cond.pneumonia_cap').length;
    goals.push({ key: 'pneumonia', value: pct(caught, sick.length), of: sick.length, ok: sick.length === 0 || pct(caught, sick.length) >= PNEUMONIA_CAUGHT });
    const needless = cases.filter(p => needlessAntibiotic(db, p)).length;
    goals.push({ key: 'antibiotic', value: needless, of: cases.length, ok: pct(needless, cases.length) <= NEEDLESS_ANTIBIOTIC });
  } else if (scenario === 'neighbor') {
    goals.push({ key: 'queue', value: pct(lost, arrived), of: arrived, ok: pct(lost, arrived) <= QUEUE_LOST });
    const died = cases.filter(p => p.closed.outcome.kind === 'died').length;
    goals.push({ key: 'deaths', value: died, of: cases.length, ok: pct(died, cases.length) <= DEATHS });
  } else {
    goals.push({ key: 'overall', value: week?.overall ?? 'D', ok: !!week && POINTS[week.overall] >= POINTS[WEEK_GRADE] });
  }
  const done = !s.dayOpen && s.day >= SCENARIO_DAYS;
  return { week, goals, passed: done && goals.every(g => g.ok), days };
}
