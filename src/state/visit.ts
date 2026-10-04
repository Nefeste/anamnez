// Живой приём одного пациента — прототип П4 (spec 2026-09-spikes) и «Случай дня» (spec
// 2026-09-campaign, часть 14): у каждого свой приём из `createVisit`.
//
// Время идёт делами (ADR 0005): каждое действие двигает часы на свою цену, результаты
// анализов приходят, когда наступает их время. Интерфейс получает только «вид» — открытое
// и сказанное (06-architecture.md §7); правда показывается разбором после диагноза.
// Вид строит caseView.ts — тот же, что у смены (session.ts).
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id, Season, Setting } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { Rng } from '@/engine/core/rng';
import { observe } from '@/engine/med/course';
import { complaintObservations, examFits, runExam } from '@/engine/med/exams';
import { generatePatient } from '@/engine/med/generate';
import { evaluatePlan, primaryOf, selfLimits, txAvailable } from '@/engine/med/plan';
import { examCost } from '@/engine/med/policy';
import { buildReview } from '@/engine/med/review';
import { scoreCase } from '@/engine/med/score';
import type { Observation, Patient } from '@/engine/med/types';
import { T } from '@/i18n';
import { type Arrival, beliefsOf, candidates, type Decision, DEPARTMENT, decisionOf, type Draft, makeCaseView, type VisitView } from './caseView';

export {
  conditionChoices, conditionTerm, type Decision, diagnosisGroups, type Draft, examInfo, examsByAction, examTerm, findingInfo,
  type Line, type ResultGroup, type TermInfo, treatmentTerm, type VisitView,
} from './caseView';

const START = 8 * 60; // 08:00

interface Pending {
  exam: Id;
  readyAt: number;
  obs: Observation[];
}

interface State {
  patient: Patient;
  rng: Rng;
  /** минуты от полуночи */
  clock: number;
  money: number;
  step: number;
  arrived: Arrival[];
  pending: Pending[];
  meanwhile: string[];
  done: Id[];
  draft: Draft;
  decision?: Decision;
  version: number;
}

/** Приём одного пациента: действия врача, вид для экранов, подписка. */
export interface Visit {
  /** новый приём: пациент из зерна */
  start(seed: number, season?: Season): void;
  act(examId: Id): void;
  waitForResults(): void;
  chooseDiagnosis(id: Id): void;
  toggleTreatment(tx: Id): void;
  chooseSetting(setting: Setting): void;
  finish(): void;
  view(): VisitView;
  subscribe(cb: () => void): () => void;
  /** зерно пациента — оно же называет приём */
  seed(): number;
}

function begin(seed: number, season: Season, version: number): State {
  const patient = generatePatient(db, seed, { department: DEPARTMENT, season });
  return { patient, rng: Rng.seeded(seed).fork('visit'), clock: START, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [], draft: { treatments: [], setting: 'home' }, version };
}

const resultsOf = (s: State): Observation[] => s.arrived.flatMap(a => a.obs);

function flush(s: State) {
  const ready = s.pending.filter(p => p.readyAt <= s.clock).sort((a, b) => a.readyAt - b.readyAt);
  for (const p of ready) {
    s.arrived.push({ exam: p.exam, step: s.step, at: p.readyAt, obs: p.obs });
    s.meanwhile.push(T.spikes.patient.ready(db.exams[p.exam].name.ru));
  }
  s.pending = s.pending.filter(p => p.readyAt > s.clock);
}

function makeView(s: State): VisitView {
  return makeCaseView({
    version: s.version,
    patient: s.patient,
    clock: s.clock,
    minutesSpent: s.clock - START,
    money: s.money,
    step: s.step,
    arrived: s.arrived,
    pending: s.pending,
    meanwhile: s.meanwhile,
    done: s.done,
    draft: s.draft,
    decision: s.decision,
  });
}

/**
 * Приём со своим пациентом и часами. `onFinish` — после «Завершить приём», с итогом: так
 * «Случай дня» записывает первую попытку в профиль.
 */
export function createVisit(first: number, opts: { season?: Season; onFinish?: (d: Decision) => void } = {}): Visit {
  let state = begin(first, opts.season ?? 'winter', 0);
  let view = makeView(state);
  const listeners = new Set<() => void>();
  const changed = () => {
    state.version++;
    view = makeView(state);
    for (const l of listeners) l();
  };
  return {
    start(seed, season = 'winter') {
      // счёт действий — заново: от него зерно «Следующего пациента» у прототипа
      state = begin(seed, season, 0);
      changed();
    },
    // провести обследование: часы двигаются на время процедуры, результат — сразу или позже
    act(examId) {
      const s = state;
      const e = db.exams[examId];
      if (s.decision || s.done.includes(examId) || !examFits(e, s.patient)) return;
      s.step++;
      s.meanwhile = [];
      s.clock += e.time.procedure;
      s.money += e.cost;
      s.done.push(examId);
      const obs = runExam(db, s.patient, examId, s.rng.fork(`order:${s.done.length}:${examId}`));
      const wait = (e.time.turnaround ?? 0) + (e.time.report ?? 0);
      if (wait > 0) s.pending.push({ exam: examId, readyAt: s.clock + wait, obs });
      else s.arrived.push({ exam: examId, step: s.step, at: s.clock, obs });
      flush(s);
      changed();
    },
    // подождать до ближайшего результата
    waitForResults() {
      const s = state;
      if (s.pending.length === 0) return;
      s.step++;
      s.meanwhile = [];
      s.clock = Math.min(...s.pending.map(p => p.readyAt));
      flush(s);
      changed();
    },
    chooseDiagnosis(id) {
      if (state.decision) return;
      state.draft = { ...state.draft, diagnosis: id };
      changed();
    },
    toggleTreatment(tx) {
      if (state.decision) return;
      const has = state.draft.treatments.includes(tx);
      // в кабинете врача монитора у постели нет — тромболизис не назначить (часть 39а)
      if (!has && !txAvailable(db, tx)) return;
      state.draft = { ...state.draft, treatments: has ? state.draft.treatments.filter(t => t !== tx) : [...state.draft.treatments, tx].sort() };
      changed();
    },
    chooseSetting(setting) {
      if (state.decision) return;
      state.draft = { ...state.draft, setting };
      changed();
    },
    // завершить приём: диагноз и план проверяются по правде, болезнь проматывается на неделю
    finish() {
      const s = state;
      const dx = s.draft.diagnosis;
      if (s.decision || !dx) return;
      const p = s.patient;
      const truth = p.truth.conditions[0].id;
      const cond = db.conditions[truth];
      const group = (x: Id) => db.conditions[x].group ?? x;
      const obs = [...complaintObservations(p), ...resultsOf(s)];
      const confidence = beliefsOf(p, obs).find(x => x.id === dx)?.p ?? 0;
      const plan = { treatments: s.draft.treatments, setting: s.draft.setting };
      const ev = evaluatePlan(db, p, plan, obs);
      const outcome = observe(db, p, plan, ev, s.rng.fork('outcome'));
      const review = buildReview(db, p, s.arrived.map(a => ({ exam: a.exam, obs: a.obs })), dx, candidates(), Object.keys(db.exams).sort(), s.rng.fork('review'));
      const verdict = dx === truth ? 'correct' : group(dx) === group(truth) ? 'partly' : 'wrong';
      const present = new Set(p.truth.findings.map(f => f.f));
      const score = scoreCase({
        verdict, confidence, cost: s.done.reduce((a, id) => a + examCost(db, id), 0), rationalCost: review.rational.cost,
        plan: ev, outcome, selfLimiting: selfLimits(db, primaryOf(p)),
        redFlags: (cond.redFlags ?? []).filter(f => present.has(f)).map(f => ({ f, seen: obs.some(o => o.f === f && o.shown) })),
      });
      s.decision = decisionOf({ patient: p, arrived: s.arrived, diagnosis: dx, verdict, confidence, plan, ev, outcome, score, review });
      opts.onFinish?.(s.decision);
      changed();
    },
    view: () => view,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    seed: () => state.patient.seed,
  };
}

// --- прототип П4: один приём на модуль, «Следующий пациент» -----------------------------------

const proto = createVisit(fnv1a('first-visit'));

export const act = proto.act;
export const waitForResults = proto.waitForResults;
export const chooseDiagnosis = proto.chooseDiagnosis;
export const toggleTreatment = proto.toggleTreatment;
export const chooseSetting = proto.chooseSetting;
export const finish = proto.finish;

export function nextPatient() {
  proto.start(fnv1a(`visit:${proto.seed()}:${proto.view().version}`));
}

/** Текущий вид приёма — для тестов и не-React кода; экраны берут его через useVisit. */
export function visitView(): VisitView {
  return proto.view();
}

export function useVisit(): VisitView {
  return useSyncExternalStore(proto.subscribe, proto.view, proto.view);
}
