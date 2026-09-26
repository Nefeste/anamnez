// Живой приём одного пациента — прототип П4 (spec 2026-09-spikes).
//
// Время идёт делами (ADR 0005): каждое действие двигает часы на свою цену, результаты
// анализов приходят, когда наступает их время. Интерфейс получает только «вид» — открытое
// и сказанное (06-architecture.md §7); правда показывается разбором после диагноза.
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { Rng } from '@/engine/core/rng';
import { complaintObservations, runExam } from '@/engine/med/exams';
import { generatePatient } from '@/engine/med/generate';
import { type Belief, knownFacts, posterior } from '@/engine/med/infer';
import { complaintText, observationText } from '@/engine/med/text';
import type { Observation, Patient } from '@/engine/med/types';
import { T } from '@/i18n';

const DEPARTMENT = 'dept.therapy';
const START = 8 * 60; // 08:00

interface Pending {
  exam: Id;
  readyAt: number;
  obs: Observation[];
}

export interface Line {
  f: Id;
  text: string;
  shown: boolean;
  exam: Id | 'complaint';
}

/** Результаты одного обследования. `fresh` — пришли за последнее действие игрока. */
export interface ResultGroup {
  key: string;
  exam: Id;
  name: string;
  at: string;
  fresh: boolean;
  lines: Line[];
}

/** Справка о термине для «Что это?»: только знания из базы, не правда о пациенте. */
export interface TermInfo {
  title: string;
  text: string[];
  list?: { label: string; items: string[] };
}

export interface Decision {
  diagnosis: Id;
  verdict: 'correct' | 'partly' | 'wrong';
  truthName: string;
  /** уверенность идеального врача в поставленном диагнозе, 0–10 */
  outOf10: number;
  pearls: string[];
  causes: { finding: string; cause: string }[];
}

export interface VisitView {
  version: number;
  title: string;
  /** для портрета: пол и возраст видны врачу, ключ портрета — не зерно генерации */
  portrait: { key: number; sex: 'm' | 'f'; age: number };
  clock: string;
  minutesSpent: number;
  money: number;
  complaints: Line[];
  /** все результаты по порядку прихода */
  results: Line[];
  /** те же результаты по обследованиям, новые сверху */
  groups: ResultGroup[];
  /** сколько результатов пришло за последнее действие */
  freshCount: number;
  pending: { name: string; at: string }[];
  meanwhile: string[];
  done: Id[];
  hints: { id: Id; name: string; outOf10: number }[];
  decision?: Decision;
}

/** Результаты, пришедшие разом: шаг — номер действия игрока, за которое они пришли. */
interface Arrival {
  exam: Id;
  step: number;
  at: number;
  obs: Observation[];
}

interface State {
  patient: Patient;
  rng: Rng;
  clock: number;
  money: number;
  step: number;
  arrived: Arrival[];
  pending: Pending[];
  meanwhile: string[];
  done: Id[];
  decision?: Decision;
  version: number;
}

function start(seed: number): State {
  const patient = generatePatient(db, seed, { department: DEPARTMENT, season: 'winter' });
  return { patient, rng: Rng.seeded(seed).fork('visit'), clock: START, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [], version: 0 };
}

function changed() {
  state.version++;
  view = makeView(state);
  for (const l of listeners) l();
}

function hhmm(min: number) {
  return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
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

/** Провести обследование: часы двигаются на время процедуры, результат — сразу или позже. */
export function act(examId: Id) {
  const s = state;
  if (s.decision || s.done.includes(examId)) return;
  const e = db.exams[examId];
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
}

/** Подождать до ближайшего результата. */
export function waitForResults() {
  const s = state;
  if (s.pending.length === 0) return;
  s.step++;
  s.meanwhile = [];
  s.clock = Math.min(...s.pending.map(p => p.readyAt));
  flush(s);
  changed();
}

export function diagnose(id: Id) {
  const s = state;
  if (s.decision) return;
  const truth = s.patient.truth.conditions[0].id;
  const group = (x: Id) => db.conditions[x].group ?? x;
  const b = beliefs(s).find(x => x.id === id);
  s.decision = {
    diagnosis: id,
    verdict: id === truth ? 'correct' : group(id) === group(truth) ? 'partly' : 'wrong',
    truthName: db.conditions[truth].name.ru,
    outOf10: Math.round((b?.p ?? 0) * 10),
    pearls: (db.conditions[truth].pearls ?? []).map(p => p.ru),
    causes: s.patient.truth.findings
      .filter(f => resultsOf(s).some(o => o.f === f.f && o.shown) || s.patient.complaints.includes(f.f))
      .map(f => ({ finding: db.findings[f.f].name.ru, cause: f.cause === 'leak' ? T.spikes.patient.causeLeak : (db.conditions[f.cause]?.name.ru ?? db.risks[f.cause]?.name.ru ?? f.cause) })),
  };
  changed();
}

export function nextPatient() {
  state = start(fnv1a(`visit:${state.patient.seed}:${state.version}`));
  changed();
}

function candidates(): Id[] {
  return Object.keys(db.conditions).filter(id => db.conditions[id].presenting && db.conditions[id].department === DEPARTMENT);
}

function beliefs(s: State): Belief[] {
  const obs = [...complaintObservations(s.patient), ...resultsOf(s)];
  const known = knownFacts(db, obs);
  return posterior(db, candidates(), obs, { sex: s.patient.sex, age: s.patient.age, season: s.patient.season, knownRisks: known.risks, knownConditions: known.conditions });
}

function patientName(p: Patient): string {
  const n = T.names;
  const first = p.sex === 'm' ? n.male : n.female;
  const surname = n.surnames[fnv1a(`${p.seed}:s`) % n.surnames.length];
  return `${p.sex === 'm' ? surname : n.feminine(surname)} ${first[fnv1a(`${p.seed}:f`) % first.length]}`;
}

function makeView(s: State): VisitView {
  const p = s.patient;
  const line = (o: Observation): Line => ({
    f: o.f,
    shown: o.shown,
    exam: o.exam,
    text: o.exam === 'complaint' ? complaintText(db, o, p.sex, p.seed) : observationText(db, o, p.sex, p.seed),
  });
  return {
    version: s.version,
    title: `${patientName(p)}, ${T.spikes.patient.years(p.age)}, ${p.sex === 'm' ? T.spikes.patient.male : T.spikes.patient.female}`,
    portrait: { key: fnv1a(`${p.seed}:portrait`), sex: p.sex, age: p.age },
    clock: hhmm(s.clock),
    minutesSpent: s.clock - START,
    money: s.money,
    complaints: complaintObservations(p).map(line),
    results: resultsOf(s).map(line),
    groups: s.arrived
      .map((a, i) => ({ key: `${i}:${a.exam}`, exam: a.exam, name: db.exams[a.exam].name.ru, at: hhmm(a.at), fresh: s.step > 0 && a.step === s.step, lines: a.obs.map(line) }))
      .reverse(),
    freshCount: s.arrived.filter(a => s.step > 0 && a.step === s.step).reduce((n, a) => n + a.obs.length, 0),
    pending: s.pending.map(x => ({ name: db.exams[x.exam].name.ru, at: hhmm(x.readyAt) })),
    meanwhile: s.meanwhile,
    done: s.done,
    hints: beliefs(s).slice(0, 3).map(b => ({ id: b.id, name: db.conditions[b.id].name.ru, outOf10: Math.round(b.p * 10) })),
    decision: s.decision,
  };
}

// Состояние модуля заводится после всех помощников: makeView зовёт их уже при загрузке.
let state: State = start(fnv1a('first-visit'));
let view: VisitView = makeView(state);
const listeners = new Set<() => void>();

/** Текущий вид приёма — для тестов и не-React кода; экраны берут его через useVisit. */
export function visitView(): VisitView {
  return view;
}

export function useVisit(): VisitView {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    visitView,
    visitView,
  );
}

/** Обследования по разделам действий карты пациента. */
export function examsByAction(): Record<'ask' | 'examine' | 'order', Id[]> {
  const ids = Object.keys(db.exams).sort();
  return {
    ask: ids.filter(id => db.exams[id].kind === 'ask'),
    examine: ids.filter(id => ['physical', 'bedside'].includes(db.exams[id].kind)),
    order: ids.filter(id => ['lab', 'rapid', 'imaging', 'functional'].includes(db.exams[id].kind)),
  };
}

export function examInfo(id: Id): { name: string; minutes: number; cost: number } {
  const e = db.exams[id];
  return { name: e.name.ru, minutes: e.time.procedure + (e.time.report ?? 0) + (e.time.turnaround ?? 0), cost: e.cost };
}

/** «Что это?» о признаке: объяснение и чем его выявляют. */
export function findingInfo(id: Id): TermInfo {
  const f = db.findings[id];
  const by = (db.revealedBy[id] ?? []).map(e => db.exams[e].name.ru);
  return {
    title: f.name.ru,
    text: f.texts.hint ? [f.texts.hint.ru] : [],
    list: by.length > 0 ? { label: T.spikes.patient.revealedBy, items: by } : undefined,
  };
}

/** «Что это?» об обследовании: как делают, что показывает, какие признаки проверяет. */
export function examTerm(id: Id): TermInfo {
  const e = db.exams[id];
  return {
    title: e.name.ru,
    text: [e.texts.summary.ru, ...(e.texts.hint ? [e.texts.hint.ru] : [])],
    list: { label: T.spikes.patient.checks, items: e.checks.map(c => db.findings[c.f].name.ru) },
  };
}

/** «Что это?» о болезни — только общее описание из энциклопедии. */
export function conditionTerm(id: Id): TermInfo {
  const c = db.conditions[id];
  return { title: c.name.ru, text: [c.texts.summary.ru] };
}

export function conditionChoices(): { id: Id; name: string }[] {
  return candidates().map(id => ({ id, name: db.conditions[id].name.ru })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
