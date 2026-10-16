// Живой приём одного пациента — прототип П4 (spec 2026-09-spikes), «Случай дня» (spec
// 2026-09-campaign, часть 14) и «Разобрать случай» (spec 2026-10-study-case, часть 74): у каждого свой
// приём из `createVisit`; у последнего — и своё место: больница, где болезнь из статьи лечат.
//
// Время идёт делами (ADR 0005): каждое действие двигает часы на свою цену, результаты
// анализов приходят, когда наступает их время. Интерфейс получает только «вид» — открытое
// и сказанное (02-architecture.md §7); правда показывается разбором после диагноза.
// Вид строит caseView.ts — тот же, что у смены (session.ts).
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id, Season, Setting } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { Rng } from '@/engine/core/rng';
import { examHarmOutcome, observe } from '@/engine/med/course';
import { complaintObservations, examFits, runExam } from '@/engine/med/exams';
import { freezeClock, generatePatient } from '@/engine/med/generate';
import { evaluatePlan, primaryOf, selfLimits, settingRoomsOf, txAvailable, type Venue, verdictOf } from '@/engine/med/plan';
import { examCost } from '@/engine/med/policy';
import { buildReview } from '@/engine/med/review';
import { scoreCase } from '@/engine/med/score';
import type { Observation, Patient } from '@/engine/med/types';
import { T } from '@/i18n';
import { type Arrival, beliefsOf, candidates, type Decision, DEPARTMENT, decisionOf, type Draft, makeCaseView, type SettingOption, type VisitView } from './caseView';

export {
  conditionChoices, conditionTerm, type Decision, diagnosisGroups, type Draft, examInfo, examsByAction, examTerm, findingInfo,
  type Line, type ResultGroup, type TermInfo, treatmentTerm, type VisitView,
} from './caseView';

const START = 8 * 60; // 08:00

/**
 * Где идёт приём (spec 2026-10-study-case, часть 74): больница, где лечат болезнь из статьи. Нет — кабинет терапевта
 * амбулатории, как у прототипа и «Случая дня»: диагноз из болезней терапии, «где лечить» — домой, в стационар, скорая.
 */
export interface VisitPlace {
  /** больной этого приёма — по зерну и сезону */
  patient(seed: number, season: Season): Patient;
  /** отделения больницы: из их болезней диагноз, вывод и разбор */
  departments: readonly Id[];
  /** где лечить — что есть в этой больнице: по диагнозу (операционная) и тому, что видно */
  settings?(diagnosis: Id | undefined, obs: readonly Observation[], patient: Patient): SettingOption[];
  /** операция поставленного диагноза — «В операционную» (часть 28) */
  operation?(diagnosis: Id, obs: readonly Observation[], patient: Patient): Id | undefined;
  /** обследования, которых здесь не сделать, — почему */
  unavailable?: Readonly<Record<Id, string>>;
  /** аппараты у постели: лежит в смотровой приёмного под монитором */
  bedside: readonly Id[];
  /** виды работающих помещений: лечение в кабинете (часть 53а) */
  rooms: readonly Id[];
  /** своя реанимация: ИВЛ можно */
  ricu?: boolean;
  /** привезла скорая: давление, пульс и сатурацию уже померил фельдшер */
  ambulance?: boolean;
  /** строки «За это время» в начале приёма: где лежит, кто привёз */
  notes?: readonly string[];
}

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
  /** новый приём: пациент из зерна; `place` — больница из статьи (часть 74), нет — кабинет терапевта */
  start(seed: number, season?: Season, place?: VisitPlace): void;
  act(examId: Id): void;
  waitForResults(): void;
  chooseDiagnosis(id: Id): void;
  toggleTreatment(tx: Id): void;
  chooseSetting(setting: Setting): void;
  /** дифференциальный ряд (spec 2026-10-differential): добавить гипотезу или убрать её */
  toggleHypothesis(id: Id): void;
  finish(): void;
  view(): VisitView;
  subscribe(cb: () => void): () => void;
  /** зерно пациента — оно же называет приём */
  seed(): number;
}

function begin(seed: number, season: Season, version: number, place?: VisitPlace): State {
  const patient = place ? place.patient(seed, season) : generatePatient(db, seed, { department: DEPARTMENT, season });
  const s: State = { patient, rng: Rng.seeded(seed).fork('visit'), clock: START, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [], draft: { treatments: [], setting: 'home' }, version };
  // привезла скорая (как на смене, часть 27): давление, пульс и сатурацию померил фельдшер
  if (place?.ambulance && db.exams['exam.vitals']) {
    s.done.push('exam.vitals');
    s.arrived.push({ exam: 'exam.vitals', step: 0, at: START, obs: runExam(db, patient, 'exam.vitals', s.rng.fork('paramedic')) });
  }
  s.meanwhile.push(...(place?.notes ?? []));
  return s;
}

/** Что есть у постели и в больнице — для лечения и оценки плана; без места — кабинет врача амбулатории. */
const venueOf = (place: VisitPlace | undefined): Venue => (place ? { bedside: place.bedside, rooms: place.rooms, ...(place.ricu ? { ricu: true } : {}) } : {});

const resultsOf = (s: State): Observation[] => s.arrived.flatMap(a => a.obs);

function flush(s: State) {
  const ready = s.pending.filter(p => p.readyAt <= s.clock).sort((a, b) => a.readyAt - b.readyAt);
  for (const p of ready) {
    s.arrived.push({ exam: p.exam, step: s.step, at: p.readyAt, obs: p.obs });
    s.meanwhile.push(T.spikes.patient.ready(db.exams[p.exam].name.ru));
  }
  s.pending = s.pending.filter(p => p.readyAt > s.clock);
}

function makeView(s: State, place?: VisitPlace): VisitView {
  const at = place && {
    departments: place.departments,
    ...(place.settings ? { settings: place.settings(s.draft.diagnosis, [...complaintObservations(s.patient), ...resultsOf(s)], s.patient) } : {}),
    ...(place.unavailable ? { unavailable: { ...place.unavailable } } : {}),
    bedsideEquipment: place.bedside,
    rooms: place.rooms,
    ...(place.ricu ? { ricu: 'free' as const } : {}),
  };
  return makeCaseView({
    ...at,
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
  let place: VisitPlace | undefined;
  let state = begin(first, opts.season ?? 'winter', 0);
  let view = makeView(state);
  const listeners = new Set<() => void>();
  const changed = () => {
    state.version++;
    view = makeView(state, place);
    for (const l of listeners) l();
  };
  return {
    start(seed, season = 'winter', at) {
      // счёт действий — заново: от него зерно «Следующего пациента» у прототипа
      place = at;
      state = begin(seed, season, 0, place);
      changed();
    },
    // провести обследование: часы двигаются на время процедуры, результат — сразу или позже
    act(examId) {
      const s = state;
      const e = db.exams[examId];
      // в этой больнице его не сделать (часть 74) — как на смене: кнопка серая, с причиной
      if (s.decision || s.done.includes(examId) || !examFits(e, s.patient) || place?.unavailable?.[examId]) return;
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
      // в кабинете врача монитора у постели нет — тромболизис не назначить (часть 39а); в смотровой приёмного — можно
      if (!has && !txAvailable(db, tx, venueOf(place))) return;
      state.draft = { ...state.draft, treatments: has ? state.draft.treatments.filter(t => t !== tx) : [...state.draft.treatments, tx].sort() };
      changed();
    },
    chooseSetting(setting) {
      if (state.decision) return;
      state.draft = { ...state.draft, setting };
      changed();
    },
    // гипотеза — в конец ряда; уже в ряду — убрать
    toggleHypothesis(id) {
      if (state.decision || !db.conditions[id]?.presenting) return;
      const row = state.draft.hypotheses ?? [];
      state.draft = { ...state.draft, hypotheses: row.includes(id) ? row.filter(x => x !== id) : [...row, id] };
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
      const obs = [...complaintObservations(p), ...resultsOf(s)];
      const confidence = beliefsOf(p, obs, place?.departments).find(x => x.id === dx)?.p ?? 0;
      // в операционную — операцией поставленного диагноза (часть 28), как при закрытии случая на смене
      const op = s.draft.setting === 'surgery' ? place?.operation?.(dx, obs, p) : undefined;
      const plan = { treatments: op ? [...new Set([...s.draft.treatments, op])].sort() : s.draft.treatments, setting: s.draft.setting };
      // сделанное, чей результат ещё не пришёл (spec 2026-10-chapter-4, часть 50а): пункция при противопоказании. В
      // больнице из статьи (часть 74) — как на смене: аппараты у постели, окна по часам на минуту решения, кабинеты
      const minutes = s.clock - START;
      const ev = place
        ? evaluatePlan(db, p, plan, obs, { ...venueOf(place), minutes, done: s.done, rooms: settingRoomsOf(db, place.rooms) }, freezeClock(db, p, minutes))
        : evaluatePlan(db, p, plan, obs, { done: s.done });
      const outcome = (place && examHarmOutcome(db, plan, ev, s.rng.fork('outcome'))) || observe(db, p, plan, ev, s.rng.fork('outcome'));
      const exams = Object.keys(db.exams).filter(id => !place?.unavailable?.[id]).sort();
      const review = buildReview(db, p, s.arrived.map(a => ({ exam: a.exam, obs: a.obs })), dx, candidates(place?.departments), exams, s.rng.fork('review'));
      const verdict = verdictOf(db, dx, p);
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
export const toggleHypothesis = proto.toggleHypothesis;
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
