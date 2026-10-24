// Разбор закрытого случая (`docs/10-medical-model.md` §10): как менялась уверенность, что
// ничего не добавило и как прошёл бы этот случай разумный врач. Только для закрытого
// случая — здесь нужна правда.
import type { ContentDb, Id } from '../../content/types';
import type { Rng } from '../core/rng';
import { type CaseHardness, hardnessOf } from './difficulty';
import { complaintObservations } from './exams';
import { type Belief, contextOf, posterior, type Prior } from './infer';
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
  /** трудность случая (часть 92): ряд у двери и хватило ли разумному врачу расспроса и осмотра */
  hardness: CaseHardness;
}

/** Сдвиг уверенности в правде меньше этого — обследование «ничего не добавило». */
export const IDLE_SHIFT = 0.03;

/**
 * Уверенность разбора по наблюдениям — тот же вывод, что у закрытия приёма; `prior` — что знает о потоке разумный врач
 * разбора (эпидемия «Зимнего гриппа», часть 91): с тем же множителем, что «Похоже на».
 */
export function reviewBeliefs(db: ContentDb, patient: Patient, candidates: readonly Id[], obs: readonly Observation[], prior?: Prior): Belief[] {
  return posterior(db, candidates, obs, contextOf(db, patient, obs, prior));
}

/** Что разбор берёт готовым — посчитанное заранее (0.5.11), и что знает о потоке разумный врач (часть 91). */
export interface ReviewReady {
  /** разумный врач тем же зерном и с теми же кандидатами и обследованиями (`startRational`) */
  rational?: DoctorResult;
  /** уверенность после жалоб и после каждого результата (`reviewBeliefs`) */
  beliefs?: readonly (readonly Belief[])[];
  /** эпидемия «Зимнего гриппа» — у разумного врача и уверенности разбора */
  prior?: Prior;
  /** трудность случая (часть 92) */
  hardness?: CaseHardness;
}

/** Что не дано готовым (`ReviewReady`), считается здесь. */
export function buildReview(
  db: ContentDb, patient: Patient, arrivals: readonly Arrival[], chosen: Id,
  candidates: readonly Id[], exams: readonly Id[], rng: Rng, ready: ReviewReady = {},
): ReviewData {
  const { beliefs, prior } = ready;
  const truth = patient.truth.conditions[0].id;
  const p = (b: readonly Belief[], id: Id) => b.find(x => x.id === id)?.p ?? 0;

  const obs: Observation[] = complaintObservations(patient);
  const at = (i: number) => beliefs?.[i] ?? reviewBeliefs(db, patient, candidates, obs, prior);
  let prev = at(0);
  const door = prev;
  const timeline: ReviewData['timeline'] = [{ exam: 'complaint', truth: p(prev, truth), chosen: p(prev, chosen) }];
  const idle: Id[] = [];
  for (const [i, a] of arrivals.entries()) {
    obs.push(...a.obs);
    const next = at(i + 1);
    timeline.push({ exam: a.exam, truth: p(next, truth), chosen: p(next, chosen) });
    if (Math.abs(p(next, truth) - p(prev, truth)) < IDLE_SHIFT && next[0].id === prev[0].id) idle.push(a.exam);
    prev = next;
  }

  const r = ready.rational ?? runDoctor(db, patient, 'rational', rng, { candidates: [...candidates], exams: [...exams], ...(prior ? { prior } : {}) });
  return {
    timeline,
    idle,
    rational: { exams: r.exams, diagnosis: r.diagnosis, cost: r.exams.reduce((a, id) => a + examCost(db, id), 0), money: r.money, minutes: r.minutes },
    hardness: ready.hardness ?? hardnessOf(db, patient, candidates, door, r, prior),
  };
}
