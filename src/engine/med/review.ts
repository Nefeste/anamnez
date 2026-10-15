// Разбор закрытого случая (`docs/10-medical-model.md` §10): как менялась уверенность, что
// ничего не добавило и как прошёл бы этот случай разумный врач. Только для закрытого
// случая — здесь нужна правда.
import type { ContentDb, Id } from '../../content/types';
import type { Rng } from '../core/rng';
import { complaintObservations } from './exams';
import { type Belief, contextOf, posterior } from './infer';
import { type DoctorResult, examCost, runDoctor } from './policy';
import type { Observation, Patient } from './types';

export interface Arrival {
  exam: Id;
  obs: Observation[];
}

export interface ReviewData {
  /** уверенность после жалоб и после каждого результата: в правде и в поставленном диагнозе */
  timeline: { exam: Id | 'complaint'; truth: number; chosen: number }[];
  /** обследования, после которых уверенность в правде почти не сдвинулась и лидер не сменился */
  idle: Id[];
  /** как прошёл бы этот случай разумный врач */
  rational: { exams: Id[]; diagnosis: Id; cost: number; money: number; minutes: number };
}

/** Сдвиг уверенности в правде меньше этого — обследование «ничего не добавило». */
export const IDLE_SHIFT = 0.03;

/** Уверенность разбора по наблюдениям — тот же вывод, что у закрытия приёма. */
export function reviewBeliefs(db: ContentDb, patient: Patient, candidates: readonly Id[], obs: readonly Observation[]): Belief[] {
  return posterior(db, candidates, obs, contextOf(db, patient, obs));
}

/**
 * `rational` — разумный врач, посчитанный заранее (`startRational`, 0.5.11): тем же зерном и с теми же кандидатами и
 * обследованиями; нет — считается здесь. `beliefs` — уверенность после жалоб и после каждого результата, посчитанная
 * заранее (`reviewBeliefs`, 0.5.11); нет — считается здесь.
 */
export function buildReview(
  db: ContentDb, patient: Patient, arrivals: readonly Arrival[], chosen: Id,
  candidates: readonly Id[], exams: readonly Id[], rng: Rng, rational?: DoctorResult, beliefs?: readonly (readonly Belief[])[],
): ReviewData {
  const truth = patient.truth.conditions[0].id;
  const p = (b: readonly Belief[], id: Id) => b.find(x => x.id === id)?.p ?? 0;

  const obs: Observation[] = complaintObservations(patient);
  const at = (i: number) => beliefs?.[i] ?? reviewBeliefs(db, patient, candidates, obs);
  let prev = at(0);
  const timeline: ReviewData['timeline'] = [{ exam: 'complaint', truth: p(prev, truth), chosen: p(prev, chosen) }];
  const idle: Id[] = [];
  for (const [i, a] of arrivals.entries()) {
    obs.push(...a.obs);
    const next = at(i + 1);
    timeline.push({ exam: a.exam, truth: p(next, truth), chosen: p(next, chosen) });
    if (Math.abs(p(next, truth) - p(prev, truth)) < IDLE_SHIFT && next[0].id === prev[0].id) idle.push(a.exam);
    prev = next;
  }

  const r = rational ?? runDoctor(db, patient, 'rational', rng, { candidates: [...candidates], exams: [...exams] });
  return {
    timeline,
    idle,
    rational: { exams: r.exams, diagnosis: r.diagnosis, cost: r.exams.reduce((a, id) => a + examCost(db, id), 0), money: r.money, minutes: r.minutes },
  };
}
