// Движок смены: приход пациентов, сортировка, очередь, терпение, обследования со своими
// сроками, закрытие случая и дня (spec 2026-09-first-shift, «Движок»; ADR 0005).
//
// Две точки входа, как в `06-architecture.md` §2: `apply(state, command)` — действие врача,
// которое двигает часы на свою цену, и команда `advance` — время на карте. Состояние
// меняется на месте; случайность — только из именованных ветвей зерна смены (ADR 0004).
import type { ContentDb, Id, Season } from '../../content/types';
import { fnv1a } from '../core/hash';
import { RNG_VERSION, Rng } from '../core/rng';
import { observe } from '../med/course';
import { complaintObservations, runExam } from '../med/exams';
import { generatePatient } from '../med/generate';
import { knownFacts, posterior } from '../med/infer';
import { evaluatePlan } from '../med/plan';
import { examCost } from '../med/policy';
import { buildReview, type ReviewData } from '../med/review';
import { scoreCase } from '../med/score';
import type { Observation } from '../med/types';
import {
  type ClosedCase, type Command, DAY, type DaySummary, type Notice, type PlannedReturn, SHIFT_END, SHIFT_SCHEMA_VERSION, SHIFT_START,
  type ShiftEvent, type ShiftPatient, type ShiftState, type Triage, type VisitKind,
} from './types';

const MIN = 60;
const TRIAGE_RANK: Record<Triage, number> = { red: 0, yellow: 1, green: 2 };
/** Сколько минут готовы ждать: красный не уходит, а ухудшается (`03-game-design.md` §4). */
const PATIENCE: Record<Exclude<Triage, 'red'>, [number, number]> = { yellow: [120, 180], green: [60, 150] };
/** Слоты записи: каждые 20 минут с 08:00 до 13:40, занято около 60 %. */
const SLOTS = 18;
const SLOT_MIN = 20;
const SLOT_BOOKED = 6000;
/** Без записи — 2–6 человек, больше утром. */
const WALK_INS: [number, number] = [2, 6];

const branch = (s: ShiftState, name: string) => Rng.seeded(s.meta.seed).fork(name);

export function newShift(db: ContentDb, opts: { seed: number; season: Season; department?: Id }): ShiftState {
  const s: ShiftState = {
    meta: {
      schemaVersion: SHIFT_SCHEMA_VERSION, contentVersion: db.contentVersion, rngVersion: RNG_VERSION, mode: 'shift',
      seed: opts.seed >>> 0, season: opts.season, department: opts.department ?? 'dept.therapy',
    },
    t: SHIFT_START,
    day: 1,
    dayOpen: true,
    patients: {},
    queue: [],
    events: [],
    seq: 0,
    rooms: { xray: 0, ecg: 0 },
    returns: [],
    summary: emptySummary(1),
    history: [],
    journal: [],
  };
  planDay(db, s);
  return s;
}

/**
 * Действие врача или ход времени. Недопустимая команда ничего не меняет (но пишется в журнал).
 * Ходы времени подряд журнал сливает в один: прожить a, затем b — то же, что прожить a + b,
 * а часы на карте тикают по четыре раза в секунду.
 */
export function apply(db: ContentDb, s: ShiftState, cmd: Command): Notice[] {
  const last = s.journal[s.journal.length - 1];
  if (cmd.kind === 'advance' && last?.kind === 'advance') last.seconds += cmd.seconds;
  else s.journal.push({ ...cmd });
  switch (cmd.kind) {
    case 'advance':
      return s.dayOpen ? advanceBy(db, s, cmd.seconds) : [];
    case 'call':
      return call(db, s, cmd.id);
    case 'exam':
      return exam(db, s, cmd.exam);
    case 'waitResults': {
      const p = current(s);
      if (!p || p.pending.length === 0) return [];
      p.step++;
      const target = Math.min(...p.pending.map(x => x.readyAt));
      return spend(db, s, p, Math.max(0, target - s.t));
    }
    case 'sendAway': {
      const p = current(s);
      if (!p || p.pending.length === 0) return [];
      p.status = 'away';
      p.wait++;
      p.step++; // что придёт, пока его нет, — «новое» при следующем вызове, а прежнее — нет
      s.current = undefined;
      return spend(db, s, p, MIN);
    }
    case 'diagnose': {
      const p = current(s);
      if (p && db.conditions[cmd.id]?.presenting) p.draft.diagnosis = cmd.id;
      return [];
    }
    case 'toggleTreatment': {
      const p = current(s);
      if (!p || !db.treatments[cmd.id]) return [];
      const has = p.draft.treatments.includes(cmd.id);
      p.draft.treatments = has ? p.draft.treatments.filter(x => x !== cmd.id) : [...p.draft.treatments, cmd.id].sort();
      return [];
    }
    case 'setting': {
      const p = current(s);
      if (p) p.draft.setting = cmd.setting;
      return [];
    }
    case 'finish':
      return finish(db, s);
    case 'closeDay':
      closeDay(s);
      return [];
    case 'nextDay':
      nextDay(db, s);
      return [];
  }
}

export function current(s: ShiftState): ShiftPatient | undefined {
  return s.current ? s.patients[s.current] : undefined;
}

// --- день ---------------------------------------------------------------------------

function emptySummary(day: number): DaySummary {
  return { day, arrived: 0, seen: 0, left: 0, unseen: 0, correct: 0, partly: 0, wrong: 0, grades: { A: 0, B: 0, C: 0, D: 0 }, money: 0, returnsPlanned: 0, returnsToday: 0 };
}

/**
 * Кто придёт сегодня: по записи, без записи и повторно. Каждый пациент — из своей ветви
 * (слот, номер без записи, чей возврат), поэтому новый повтор не меняет остальных.
 */
function planDay(db: ContentDb, s: ShiftState) {
  const d = s.day;
  const base = (d - 1) * DAY;
  const r = branch(s, `day:${d}`);
  const plan: { t: number; kind: VisitKind; key: string; ret?: PlannedReturn }[] = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const sr = r.fork(`slot:${slot}`);
    if (!sr.chance(SLOT_BOOKED)) continue;
    const late = sr.range(-5, 10);
    plan.push({ t: base + SHIFT_START + Math.max(0, slot * SLOT_MIN + late) * MIN, kind: 'appointment', key: `slot:${slot}` });
  }
  const wr = r.fork('walk-ins');
  const walkIns = wr.range(WALK_INS[0], WALK_INS[1]);
  for (let i = 0; i < walkIns; i++) {
    const w = wr.fork(`walk:${i}`);
    const minute = Math.min(w.range(0, 330), w.range(0, 330)); // меньшее из двух — ближе к утру
    plan.push({ t: base + SHIFT_START + minute * MIN, kind: 'walkIn', key: `walk:${i}` });
  }
  for (const ret of s.returns.filter(x => x.day === d)) {
    plan.push({ t: base + SHIFT_START + r.fork(`return:${ret.of}`).range(0, 120) * MIN, kind: 'return', key: `return:${ret.of}`, ret });
  }
  plan.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1));
  plan.forEach((a, i) => {
    const id = `${d}-${String(i + 1).padStart(2, '0')}`;
    const patient = a.ret
      ? returningPatient(db, s, a.ret)
      : generatePatient(db, fnv1a(`${s.meta.seed}:${d}:${a.key}`), { department: s.meta.department, season: s.meta.season });
    s.patients[id] = {
      id, patient, arriveT: a.t, kind: a.kind, triage: 'green', status: 'coming', queuedT: 0, wait: 0, patience: 0,
      results: [], pending: [], done: [], step: 0, spent: { seconds: 0, money: 0 }, draft: { treatments: [], setting: 'home' },
      ...(a.ret ? { returnOf: a.ret.of, returnReason: a.ret.reason } : {}),
    };
    schedule(s, a.t, { kind: 'arrive', id });
  });
  schedule(s, base + SHIFT_END, { kind: 'shiftEnd' });
}

/**
 * Тот же человек с той же болезнью, но новый её день (`generatePatient`, `visit`).
 * Вернулся хуже — у болезни с тяжестью она становится тяжёлой.
 */
function returningPatient(db: ContentDb, s: ShiftState, ret: PlannedReturn) {
  const prev = s.patients[ret.of];
  let visit = 1;
  for (let x = prev; x?.returnOf; x = s.patients[x.returnOf]) visit++;
  const primary = prev.patient.truth.conditions[0].id;
  const severe = ret.reason === 'worse' && db.conditions[primary].params?.severity?.severe !== undefined;
  return generatePatient(db, prev.patient.seed, {
    department: s.meta.department, season: s.meta.season, primary, visit, ...(severe ? { params: { severity: 'severe' } } : {}),
  });
}

function closeDay(s: ShiftState) {
  if (!s.dayOpen) return;
  for (const p of Object.values(s.patients)) {
    if (p.status === 'waiting' || p.status === 'inRoom' || p.status === 'away' || p.status === 'coming') {
      if (p.status !== 'coming') s.summary.unseen++;
      p.status = 'unseen';
    }
  }
  s.queue = [];
  s.current = undefined;
  s.events = [];
  s.dayOpen = false;
  s.history.push({ ...s.summary, grades: { ...s.summary.grades } });
}

/** Следующий день: часы — на 08:00, кабинеты свободны, план прихода с повторными обращениями. */
function nextDay(db: ContentDb, s: ShiftState) {
  if (s.dayOpen) return;
  s.day++;
  s.t = (s.day - 1) * DAY + SHIFT_START;
  s.rooms = { xray: 0, ecg: 0 };
  s.summary = emptySummary(s.day);
  s.journal = [];
  s.dayOpen = true;
  planDay(db, s);
  prune(s);
}

/**
 * Старое не храним: принятых — неделю (их исходы — в итогах следующих дней) и тех, к кому
 * ещё вернутся; ушедших и не принятых в прошлые дни — нет: их числа уже в итогах дня.
 */
function prune(s: ShiftState) {
  const keep = new Set(s.returns.filter(r => r.day >= s.day).map(r => r.of));
  for (const [id, p] of Object.entries(s.patients)) {
    const day = Number(id.split('-')[0]);
    if (keep.has(id) || day >= s.day) continue;
    if (day < s.day - 7 || p.status === 'left' || p.status === 'unseen') delete s.patients[id];
  }
  s.returns = s.returns.filter(r => r.day >= s.day);
}

// --- врач ---------------------------------------------------------------------------

function call(db: ContentDb, s: ShiftState, id: string): Notice[] {
  const p = s.patients[id];
  if (!s.dayOpen || s.current || !p || p.status !== 'waiting') return [];
  s.queue = s.queue.filter(x => x !== id);
  p.status = 'inRoom';
  p.wait++; // прежняя проверка терпения недействительна
  s.current = id;
  return spend(db, s, p, MIN);
}

/** Обследование текущему пациенту. Цена для врача — сама процедура; рентген и ЭКГ — назначить. */
function exam(db: ContentDb, s: ShiftState, examId: Id): Notice[] {
  const p = current(s);
  const e = db.exams[examId];
  if (!p || !e || p.done.includes(examId)) return [];
  p.step++;
  p.done.push(examId);
  p.spent.money += e.cost;
  s.summary.money += e.cost;
  const obs = runExam(db, p.patient, examId, branch(s, `exam:${p.id}:${p.done.length}:${examId}`));
  const after = (e.time.report ?? 0) + (e.time.turnaround ?? 0);
  if (e.kind === 'imaging' || e.kind === 'functional') {
    // кабинет один: следующий снимок — когда аппарат освободится
    const room = e.kind === 'imaging' ? 'xray' : 'ecg';
    const order = 2 * MIN;
    const start = Math.max(s.t + order, s.rooms[room]);
    s.rooms[room] = start + e.time.procedure * MIN;
    addPending(s, p, examId, start + (e.time.procedure + after) * MIN, obs);
    return spend(db, s, p, order);
  }
  const cost = e.time.procedure * MIN;
  if (after > 0) addPending(s, p, examId, s.t + cost + after * MIN, obs);
  else p.results.push({ exam: examId, obs, at: s.t + cost, step: p.step });
  return spend(db, s, p, cost);
}

function addPending(s: ShiftState, p: ShiftPatient, examId: Id, readyAt: number, obs: Observation[]) {
  p.pending.push({ exam: examId, readyAt, obs });
  schedule(s, readyAt, { kind: 'result', id: p.id });
}

function finish(db: ContentDb, s: ShiftState): Notice[] {
  const p = current(s);
  if (!p || !p.draft.diagnosis) return [];
  // не дождались — результат приходит в пустоту: случай решён тем, что было известно
  p.pending = [];
  const closed = closeCase(db, s, p);
  p.closed = closed;
  p.status = 'done';
  s.current = undefined;
  const sum = s.summary;
  sum.seen++;
  sum[closed.verdict]++;
  sum.grades[closed.grades.overall]++;
  const back = closed.outcome.returns;
  if (back) {
    s.returns.push({ day: s.day + Math.max(1, back.day), of: p.id, reason: back.reason });
    sum.returnsPlanned++;
  }
  return spend(db, s, p, 2 * MIN); // рецепт, направление
}

/** Кандидаты вывода — всё, с чем приходят в это отделение. */
export function candidatesOf(db: ContentDb, department: Id): Id[] {
  return Object.keys(db.conditions).filter(id => db.conditions[id].presenting && db.conditions[id].department === department).sort();
}

/** Всё, что врач знает о пациенте: жалобы и пришедшие результаты. */
export function observationsOf(p: ShiftPatient): Observation[] {
  return [...complaintObservations(p.patient), ...p.results.flatMap(r => r.obs)];
}

/** Закрыть случай: проверить план по правде, промотать болезнь, поставить оценки (`04` §8–10). */
function closeCase(db: ContentDb, s: ShiftState, p: ShiftPatient): ClosedCase {
  const dx = p.draft.diagnosis!;
  const patient = p.patient;
  const truth = patient.truth.conditions[0].id;
  const cond = db.conditions[truth];
  const group = (x: Id) => db.conditions[x].group ?? x;
  const obs = observationsOf(p);
  const candidates = candidatesOf(db, s.meta.department);
  const known = knownFacts(db, obs);
  const beliefs = posterior(db, candidates, obs, { sex: patient.sex, age: patient.age, season: patient.season, knownRisks: known.risks, knownConditions: known.conditions });
  const confidence = beliefs.find(b => b.id === dx)?.p ?? 0;
  const plan = { treatments: [...p.draft.treatments], setting: p.draft.setting };
  const ev = evaluatePlan(db, patient, plan, obs);
  const outcome = observe(db, patient, plan, ev, branch(s, `outcome:${p.id}`));
  const review = reviewOf(db, s, p, dx);
  const present = new Set(patient.truth.findings.map(f => f.f));
  const verdict = dx === truth ? 'correct' : group(dx) === group(truth) ? 'partly' : 'wrong';
  const score = scoreCase({
    verdict, confidence, cost: p.done.reduce((a, id) => a + examCost(db, id), 0), rationalCost: review.rational.cost,
    plan: ev, outcome, selfLimiting: cond.selfLimiting === true,
    redFlags: (cond.redFlags ?? []).filter(f => present.has(f)).map(f => ({ f, seen: obs.some(o => o.f === f && o.shown) })),
  });
  const { notes, ...grades } = score;
  return { at: s.t, diagnosis: dx, verdict, confidence, plan, outcome, grades, notes, rationalCost: review.rational.cost, rationalMoney: review.rational.money };
}

/**
 * Разбор случая: как менялась уверенность, что ничего не добавило, как прошёл бы его разумный
 * врач. Та же ветвь зерна, что при закрытии, — поэтому экран разбора пересчитывает его, а не
 * хранит в сохранении.
 */
export function reviewOf(db: ContentDb, s: ShiftState, p: ShiftPatient, diagnosis: Id): ReviewData {
  return reviewFor(db, s.meta, p, diagnosis);
}

/** Разбор по одной записи пациента: из смены нужны только зерно и отделение — так его строит и архив профиля. */
export function reviewFor(db: ContentDb, meta: Pick<ShiftState['meta'], 'seed' | 'department'>, p: ShiftPatient, diagnosis: Id): ReviewData {
  const rng = Rng.seeded(meta.seed).fork(`review:${p.id}`);
  return buildReview(db, p.patient, p.results.map(r => ({ exam: r.exam, obs: r.obs })), diagnosis, candidatesOf(db, meta.department), Object.keys(db.exams).sort(), rng);
}

// --- время --------------------------------------------------------------------------

function spend(db: ContentDb, s: ShiftState, p: ShiftPatient, seconds: number): Notice[] {
  p.spent.seconds += seconds;
  return advanceBy(db, s, seconds);
}

function schedule(s: ShiftState, t: number, event: ShiftEvent) {
  const item = { t, seq: s.seq++, event };
  let i = s.events.length;
  while (i > 0 && (s.events[i - 1].t > t || (s.events[i - 1].t === t && s.events[i - 1].seq > item.seq))) i--;
  s.events.splice(i, 0, item);
}

/** Прожить `seconds`: события по порядку, при равном времени — по номеру постановки. */
function advanceBy(db: ContentDb, s: ShiftState, seconds: number): Notice[] {
  const notices: Notice[] = [];
  if (seconds <= 0) return notices;
  const target = s.t + seconds;
  while (s.events.length > 0 && s.events[0].t <= target) {
    const { t, event } = s.events.shift()!;
    s.t = Math.max(s.t, t);
    handle(db, s, event, notices);
  }
  s.t = target;
  return notices;
}

function handle(db: ContentDb, s: ShiftState, ev: ShiftEvent, notices: Notice[]) {
  switch (ev.kind) {
    case 'arrive':
      return arrive(db, s, s.patients[ev.id], notices);
    case 'result':
      return results(s, s.patients[ev.id], notices);
    case 'patience': {
      const p = s.patients[ev.id];
      if (p.status !== 'waiting' || p.wait !== ev.wait) return;
      p.status = 'left';
      s.queue = s.queue.filter(x => x !== p.id);
      s.summary.left++;
      notices.push({ kind: 'left', id: p.id });
      return;
    }
    case 'shiftEnd':
      notices.push({ kind: 'shiftEnd' });
  }
}

/** Пришёл: медсестра меряет витальные и сортирует — по тому, что видит (жалобы и измерения). */
function arrive(db: ContentDb, s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  if (p.status !== 'coming') return;
  if (db.exams['exam.vitals']) {
    p.done.push('exam.vitals');
    p.results.push({ exam: 'exam.vitals', obs: runExam(db, p.patient, 'exam.vitals', branch(s, `vitals:${p.id}`)), at: s.t, step: 0 });
  }
  p.triage = triageOf(db, p);
  const [lo, hi] = p.triage === 'red' ? [0, 0] : PATIENCE[p.triage];
  p.patience = branch(s, `patience:${p.id}`).range(lo, hi) * MIN;
  s.summary.arrived++;
  if (p.kind === 'return') s.summary.returnsToday++;
  enqueue(s, p, s.t);
  notices.push({ kind: 'arrived', id: p.id, triage: p.triage });
}

export function triageOf(db: ContentDb, p: ShiftPatient): Triage {
  const seen = [...p.patient.complaints, ...p.results.flatMap(r => r.obs.filter(o => o.shown).map(o => o.f))];
  const levels = seen.map(f => db.findings[f]?.triage).filter(Boolean);
  return levels.includes('red') ? 'red' : levels.includes('yellow') ? 'yellow' : 'green';
}

function enqueue(s: ShiftState, p: ShiftPatient, queuedT: number) {
  p.status = 'waiting';
  p.queuedT = queuedT;
  p.wait++;
  s.queue = [...s.queue.filter(x => x !== p.id), p.id].sort((a, b) => {
    const x = s.patients[a];
    const y = s.patients[b];
    return TRIAGE_RANK[x.triage] - TRIAGE_RANK[y.triage] || x.queuedT - y.queuedT || (a < b ? -1 : 1);
  });
  if (p.patience > 0) schedule(s, s.t + p.patience, { kind: 'patience', id: p.id, wait: p.wait });
}

/** Результаты пришли. Ушедший на анализы возвращается в очередь — впереди, по времени прихода. */
function results(s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  const ready = p.pending.filter(x => x.readyAt <= s.t).sort((a, b) => a.readyAt - b.readyAt || (a.exam < b.exam ? -1 : 1));
  if (ready.length === 0) return;
  p.pending = p.pending.filter(x => x.readyAt > s.t);
  for (const x of ready) p.results.push({ exam: x.exam, obs: x.obs, at: x.readyAt, step: p.step });
  if (p.status === 'away' && p.pending.length === 0) {
    enqueue(s, p, p.arriveT);
    notices.push({ kind: 'resultsReady', id: p.id });
  } else if (p.status === 'inRoom') {
    notices.push({ kind: 'resultsReady', id: p.id });
  }
}
