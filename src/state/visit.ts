// Живой приём одного пациента — прототип П4 (spec 2026-09-spikes).
//
// Время идёт делами (ADR 0005): каждое действие двигает часы на свою цену, результаты
// анализов приходят, когда наступает их время. Интерфейс получает только «вид» — открытое
// и сказанное (06-architecture.md §7); правда показывается разбором после диагноза.
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id, Setting } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { Rng } from '@/engine/core/rng';
import { observe } from '@/engine/med/course';
import { complaintObservations, runExam } from '@/engine/med/exams';
import { generatePatient } from '@/engine/med/generate';
import { type Belief, knownFacts, posterior } from '@/engine/med/infer';
import { evaluatePlan } from '@/engine/med/plan';
import { examCost } from '@/engine/med/policy';
import { buildReview } from '@/engine/med/review';
import { type Grade, type ScoreNote, scoreCase } from '@/engine/med/score';
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
  /** что было дальше: исход за неделю или перевод */
  outcome: string;
  grades: { key: string; label: string; grade: Grade }[];
  overall: Grade;
  notes: string[];
  plan: { name: string; role: string }[];
  settingName: string;
  rational: string;
  idle: string[];
  timeline: { label: string; truth: number; chosen: number }[];
}

/** Решение до «Завершить приём»: можно менять и дальше обследовать. */
export interface Draft {
  diagnosis?: Id;
  treatments: Id[];
  setting: Setting;
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
  /** всё лечение базы по алфавиту; warning — противопоказание, о котором врач уже знает */
  treatments: { id: Id; name: string; warning?: string }[];
  draft: Draft;
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
  draft: Draft;
  decision?: Decision;
  version: number;
}

function start(seed: number): State {
  const patient = generatePatient(db, seed, { department: DEPARTMENT, season: 'winter' });
  return { patient, rng: Rng.seeded(seed).fork('visit'), clock: START, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [], draft: { treatments: [], setting: 'home' }, version: 0 };
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

export function chooseDiagnosis(id: Id) {
  if (state.decision) return;
  state.draft = { ...state.draft, diagnosis: id };
  changed();
}

export function toggleTreatment(tx: Id) {
  if (state.decision) return;
  const has = state.draft.treatments.includes(tx);
  state.draft = { ...state.draft, treatments: has ? state.draft.treatments.filter(t => t !== tx) : [...state.draft.treatments, tx].sort() };
  changed();
}

export function chooseSetting(setting: Setting) {
  if (state.decision) return;
  state.draft = { ...state.draft, setting };
  changed();
}

/** Завершить приём: диагноз и план проверяются по правде, болезнь проматывается на неделю. */
export function finish() {
  const s = state;
  const dx = s.draft.diagnosis;
  if (s.decision || !dx) return;
  const p = s.patient;
  const t = T.spikes.patient;
  const truth = p.truth.conditions[0].id;
  const cond = db.conditions[truth];
  const group = (x: Id) => db.conditions[x].group ?? x;
  const confidence = beliefs(s).find(x => x.id === dx)?.p ?? 0;
  const obs = [...complaintObservations(p), ...resultsOf(s)];
  const plan = { treatments: s.draft.treatments, setting: s.draft.setting };
  const ev = evaluatePlan(db, p, plan, obs);
  const outcome = observe(db, p, plan, ev, s.rng.fork('outcome'));
  const review = buildReview(db, p, s.arrived.map(a => ({ exam: a.exam, obs: a.obs })), dx, candidates(), Object.keys(db.exams).sort(), s.rng.fork('review'));
  const verdict = dx === truth ? 'correct' : group(dx) === group(truth) ? 'partly' : 'wrong';
  const present = new Set(p.truth.findings.map(f => f.f));
  const score = scoreCase({
    verdict, confidence, cost: s.done.reduce((a, id) => a + examCost(db, id), 0), rationalCost: review.rational.cost,
    plan: ev, outcome, selfLimiting: cond.selfLimiting === true,
    redFlags: (cond.redFlags ?? []).filter(f => present.has(f)).map(f => ({ f, seen: obs.some(o => o.f === f && o.shown) })),
  });
  const female = p.sex === 'f';
  const out = t.outcome;
  const outcomeText = outcome.kind === 'recovered' ? out.recovered(outcome.day, female)
    : outcome.kind === 'improved' ? out.improved(female)
      : outcome.kind === 'unchanged' ? out.unchanged
        : outcome.kind === 'worse' ? out.worse(outcome.day)
          : outcome.kind === 'reaction' && outcome.reaction ? out.reaction(db.treatments[outcome.reaction.tx].name.ru, riskName(outcome.reaction.by))
            : plan.setting === 'ambulance' ? out.ambulance : out.ward(female);
  const keys = ['accuracy', 'defensibility', 'thrift', 'treatment', 'setting', 'safety'] as const;
  const outOf10 = (x: number) => Math.round(x * 10);
  s.decision = {
    diagnosis: dx,
    verdict,
    truthName: cond.name.ru,
    outOf10: outOf10(confidence),
    pearls: (cond.pearls ?? []).map(x => x.ru),
    causes: p.truth.findings
      .filter(f => resultsOf(s).some(o => o.f === f.f && o.shown) || p.complaints.includes(f.f))
      .map(f => ({ finding: db.findings[f.f].name.ru, cause: f.cause === 'leak' ? t.causeLeak : (db.conditions[f.cause]?.name.ru ?? db.risks[f.cause]?.name.ru ?? f.cause) })),
    outcome: outcomeText,
    grades: keys.map(k => ({ key: k, label: t.grade[k], grade: score[k] })),
    overall: score.overall,
    notes: score.notes.map(noteText),
    plan: ev.roles.map(r => ({ name: db.treatments[r.tx].name.ru, role: t.role[r.role] })),
    settingName: t.setting[plan.setting],
    rational: t.rationalLine(
      review.rational.exams.length > 0 ? review.rational.exams.map(e => db.exams[e].name.ru).join(', ') : t.rationalNone,
      review.rational.minutes, T.common.rub(review.rational.money), db.conditions[review.rational.diagnosis].name.ru),
    idle: review.idle.map(e => db.exams[e].name.ru),
    timeline: review.timeline.map(x => ({ label: x.exam === 'complaint' ? t.timelineComplaints : db.exams[x.exam].name.ru, truth: outOf10(x.truth), chosen: outOf10(x.chosen) })),
  };
  changed();
}

/** Противопоказание — фактор риска (аллергия) или состояние. */
function riskName(id: Id) {
  return db.risks[id]?.name.ru ?? db.conditions[id]?.name.ru ?? id;
}

function noteText(n: ScoreNote): string {
  const t = T.spikes.patient.note;
  const tx = (id: Id) => db.treatments[id].name.ru;
  switch (n.code) {
    case 'tx.harmful': return t.harmful(tx(n.tx));
    case 'tx.notIndicated': return t.notIndicated(tx(n.tx));
    case 'tx.acceptable': return t.acceptable(tx(n.tx));
    case 'tx.noCure': return t.noCure;
    case 'tx.none': return t.none;
    case 'setting.under': return t.settingUnder(n.recommended === 'ambulance' ? 'ambulance' : 'ward');
    case 'setting.over': return t.settingOver(n.recommended === 'home' ? 'home' : 'ward');
    case 'safety.knownViolation': return t.knownViolation(tx(n.tx), riskName(n.by));
    case 'safety.unaskedViolation': return t.unaskedViolation(tx(n.tx), riskName(n.by));
    case 'safety.notAsked': return t.notAsked(riskName(n.by));
    case 'safety.redFlagIgnored': return t.redFlagIgnored(db.findings[n.f].name.ru);
    case 'safety.redFlagUnchecked': return t.redFlagUnchecked(db.findings[n.f].name.ru);
    case 'thrift.over': return t.thriftOver(n.times);
  }
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

/** Выбор лечения: противопоказание, о котором пациент сказал, — предупреждение (`04` §8). */
function treatmentChoices(s: State): VisitView['treatments'] {
  const known = knownFacts(db, [...complaintObservations(s.patient), ...resultsOf(s)]);
  const knownIds = new Set([...known.risks, ...known.conditions]);
  return Object.values(db.treatments)
    .map(x => {
      const by = x.contraindications.find(k => knownIds.has(k.id));
      return { id: x.id, name: x.name.ru, warning: by ? T.spikes.patient.contraindicated(riskName(by.id)) : undefined };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
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
    treatments: treatmentChoices(s),
    draft: s.draft,
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

/** «Что это?» о лечении. */
export function treatmentTerm(id: Id): TermInfo {
  const x = db.treatments[id];
  return { title: x.name.ru, text: [x.texts.hint.ru] };
}


/** «Что это?» о болезни — только общее описание из энциклопедии. */
export function conditionTerm(id: Id): TermInfo {
  const c = db.conditions[id];
  return { title: c.name.ru, text: [c.texts.summary.ru] };
}

export function conditionChoices(): { id: Id; name: string }[] {
  return candidates().map(id => ({ id, name: db.conditions[id].name.ru })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
