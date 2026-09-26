// Разбор закрытого случая (`docs/04-medical-model.md` §10): как менялась уверенность, что
// ничего не добавило и как прошёл бы этот случай разумный врач. Только для закрытого
// случая — здесь нужна правда.
import type { ContentDb, Id } from '../../content/types';
import type { Rng } from '../core/rng';
import { complaintObservations } from './exams';
import { knownFacts, posterior } from './infer';
import { examCost, runDoctor } from './policy';
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

export function buildReview(
  db: ContentDb, patient: Patient, arrivals: readonly Arrival[], chosen: Id,
  candidates: readonly Id[], exams: readonly Id[], rng: Rng,
): ReviewData {
  const truth = patient.truth.conditions[0].id;
  const beliefsOf = (obs: readonly Observation[]) => {
    const known = knownFacts(db, obs);
    return posterior(db, candidates, obs, { sex: patient.sex, age: patient.age, season: patient.season, knownRisks: known.risks, knownConditions: known.conditions });
  };
  const p = (b: { id: Id; p: number }[], id: Id) => b.find(x => x.id === id)?.p ?? 0;

  const obs: Observation[] = complaintObservations(patient);
  let prev = beliefsOf(obs);
  const timeline: ReviewData['timeline'] = [{ exam: 'complaint', truth: p(prev, truth), chosen: p(prev, chosen) }];
  const idle: Id[] = [];
  for (const a of arrivals) {
    obs.push(...a.obs);
    const next = beliefsOf(obs);
    timeline.push({ exam: a.exam, truth: p(next, truth), chosen: p(next, chosen) });
    if (Math.abs(p(next, truth) - p(prev, truth)) < IDLE_SHIFT && next[0].id === prev[0].id) idle.push(a.exam);
    prev = next;
  }

  const r = runDoctor(db, patient, 'rational', rng, { candidates: [...candidates], exams: [...exams] });
  return {
    timeline,
    idle,
    rational: { exams: r.exams, diagnosis: r.diagnosis, cost: r.exams.reduce((a, id) => a + examCost(db, id), 0), money: r.money, minutes: r.minutes },
  };
}
