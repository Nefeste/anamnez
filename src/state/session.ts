// Смена в амбулатории — для экранов (spec 2026-09-first-shift). Движок смены
// (engine/shift) плюс то, что нужно игре, а не модели: часы на карте по скорости, автопауза
// на «красного» и на результаты, «за это время», автосохранение в слот `shift` (ADR 0010).
//
// Хранилище приходит снаружи (setStore): на телефоне — файлы, в вебе — localStorage, в
// тестах — память. Модуль, как и saves.ts, не знает про платформу.
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id, Season, Setting } from '@/content/types';
import { complaintObservations } from '@/engine/med/exams';
import { evaluatePlan } from '@/engine/med/plan';
import type { Grade } from '@/engine/med/score';
import { complaintText } from '@/engine/med/text';
import { apply, current, newShift, observationsOf, reviewOf } from '@/engine/shift/engine';
import { type Command, DAY, type Notice, SHIFT_END, SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState, type Triage } from '@/engine/shift/types';
import { T } from '@/i18n';
import { type Arrival, type Decision, decisionOf, hhmm, makeCaseView, outcomeText, patientName, type VisitView } from './caseView';
import { loadSlot, type RawStore, saveSlot } from './saves';

export const SLOT = 'shift';
/** Скорость часов на карте — игровых минут в секунду. */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
/** Часы на карте тикают по четыре раза в секунду. */
export const TICK_MS = 250;
/** Автосохранение — не реже раза в игровой час: убитое приложение теряет не больше часа. */
const SAVE_EVERY = 3600;
const LOG_SIZE = 12;

export type LogKind = 'red' | 'arrived' | 'results' | 'left' | 'end';

export interface QueueRow {
  id: string;
  name: string;
  age: string;
  triage: Triage;
  complaint: string;
  waits: string;
  badges: string[];
}

export interface CaseRow {
  id: string;
  name: string;
  verdict: 'correct' | 'partly' | 'wrong';
  overall: Grade;
  diagnosis: string;
}

export interface SummaryView {
  day: number;
  arrived: number;
  seen: number;
  left: number;
  unseen: number;
  correct: number;
  partly: number;
  wrong: number;
  grades: Record<Grade, number>;
  /** средняя уверенность идеального врача в поставленных диагнозах, 0–10 */
  confidence?: number;
  money: number;
  rationalMoney: number;
  returnsPlanned: number;
  returnsToday: number;
  cases: CaseRow[];
  /** исходы отпущенных домой, ставшие известными в этот день */
  news: { id: string; text: string }[];
}

export interface ShiftView {
  version: number;
  /** none — сохранения нет, ready — смена открыта */
  status: 'idle' | 'loading' | 'none' | 'ready';
  day: number;
  clock: string;
  dayOpen: boolean;
  /** после 14:00 новые не приходят */
  afterHours: boolean;
  /** все пришедшие приняты или ушли, новых не будет — пора закрывать день */
  allDone: boolean;
  speed: Speed;
  paused: boolean;
  pauseReason?: string;
  inRoom?: { id: string; name: string };
  queue: QueueRow[];
  away: { id: string; name: string; ready: string }[];
  /** что случилось — новое сверху */
  log: { key: number; kind: LogKind; text: string; at: string }[];
  counts: { seen: number; left: number; waiting: number; /** не будут приняты, если закрыть день сейчас */ unseen: number };
  summary?: SummaryView;
  /** прочитана предыдущая копия: текущая была испорчена */
  restored: boolean;
}

interface Session {
  s: ShiftState;
  speed: Speed;
  paused: boolean;
  pauseReason?: string;
  log: { key: number; t: number; kind: LogKind; text: string }[];
  logSeq: number;
  /** «за это время» — для карты пациента, после последнего действия врача */
  meanwhile: string[];
  /** среди них — срочный пациент */
  urgent: boolean;
  /** чей итог показывать: только что закрытый или выбранный в итогах дня */
  focus?: string;
  savedT: number;
  restored: boolean;
}

let store: RawStore | null = null;
let session: Session | null = null;
let status: ShiftView['status'] = 'idle';
let loading: Promise<void> | null = null;
let saving: Promise<unknown> = Promise.resolve();
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// --- сохранение ------------------------------------------------------------------------

export function setStore(s: RawStore) {
  store = s;
}

/** Сохранение от этой базы: всё, на что оно ссылается, в ней есть (после обновления — может не быть). */
export function compatible(s: ShiftState | undefined): boolean {
  if (!s || s.meta?.mode !== 'shift' || typeof s.patients !== 'object') return false;
  const has = (table: Record<string, unknown>) => (id: Id) => table[id] !== undefined;
  const finding = has(db.findings);
  const exam = has(db.exams);
  const tx = has(db.treatments);
  return Object.values(s.patients).every(p =>
    p.patient.truth.conditions.every(c => has(db.conditions)(c.id))
    && p.patient.truth.findings.every(f => finding(f.f))
    && p.patient.complaints.every(finding)
    && p.results.every(r => exam(r.exam) && r.obs.every(o => finding(o.f)))
    && p.pending.every(r => exam(r.exam))
    && p.done.every(exam)
    && p.draft.treatments.every(tx)
    && (p.closed?.plan.treatments ?? []).every(tx)
    && (p.draft.diagnosis === undefined || has(db.conditions)(p.draft.diagnosis)));
}

/** Прочитать сохранение, если ещё не читали; его нет — статус 'none'. */
export function loadShift(): Promise<void> {
  if (session || status === 'none') return Promise.resolve();
  if (loading) return loading;
  const st = store;
  if (!st) {
    status = 'none';
    changed();
    return Promise.resolve();
  }
  status = 'loading';
  changed();
  loading = loadSlot<ShiftState>(st, SLOT, e => e.schemaVersion === SHIFT_SCHEMA_VERSION && compatible(e.data))
    .then(r => {
      if (r && !session) session = fresh(r.envelope.data, r.from !== 'current');
    })
    .catch(() => undefined)
    .finally(() => {
      status = session ? 'ready' : 'none';
      loading = null;
      changed();
    });
  return loading;
}

function save(): Promise<unknown> {
  const sess = session;
  const st = store;
  if (!sess || !st) return saving;
  sess.savedT = sess.s.t;
  saving = saving
    .then(() => saveSlot(st, SLOT, sess.s, SHIFT_SCHEMA_VERSION, new Date().toISOString()))
    .catch(() => undefined); // не записалось — попробуем в следующий раз; игра продолжается
  return saving;
}

/** Сохранить сейчас — приложение уходит в фон. */
export function saveNow(): Promise<unknown> {
  return save();
}

/** Дождаться записи — для тестов. */
export function saved(): Promise<unknown> {
  return saving;
}

function fresh(s: ShiftState, restored: boolean): Session {
  return { s, speed: 1, paused: false, log: [], logSeq: 0, meanwhile: [], urgent: false, savedT: s.t, restored };
}

export function seasonOf(d: Date): Season {
  const m = d.getMonth(); // 0 — январь
  return m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}

/** Новая практика: день 1, 08:00. Прежнее сохранение перезаписывается. */
export function startShift(seed?: number, season?: Season) {
  const s = newShift(db, { seed: seed ?? Date.now() % 0x7fffffff, season: season ?? seasonOf(new Date()) });
  session = fresh(s, false);
  status = 'ready';
  decisions.clear();
  save();
  changed();
}

/** Для тестов: забыть смену в памяти, как после перезапуска приложения. */
export function forgetShift() {
  session = null;
  status = 'idle';
  loading = null;
  decisions.clear();
  changed();
}

// --- часы -----------------------------------------------------------------------------

function run(sess: Session, cmd: Command): Notice[] {
  const notices = apply(db, sess.s, cmd);
  record(sess, notices);
  if (sess.s.t - sess.savedT >= SAVE_EVERY) save();
  return notices;
}

function dayStart(s: ShiftState) {
  return (s.day - 1) * DAY;
}

function allDone(s: ShiftState) {
  return s.t >= dayStart(s) + SHIFT_END && s.queue.length === 0 && !s.current && !Object.values(s.patients).some(p => p.status === 'away' || p.status === 'coming');
}

/**
 * Время на карте: идёт, пока в кабинете никого. Пришёл «красный» или вернулся с
 * результатами — пауза. Отдаёт случившееся — для звука.
 */
export function tick(ms: number = TICK_MS): Notice[] {
  const sess = session;
  if (!sess || sess.paused || !sess.s.dayOpen || sess.s.current || allDone(sess.s)) return [];
  const notices = run(sess, { kind: 'advance', seconds: Math.round((ms / 1000) * sess.speed * 60) });
  const red = notices.find(n => n.kind === 'arrived' && n.triage === 'red');
  const back = notices.find(n => n.kind === 'resultsReady' && sess.s.patients[n.id].status === 'waiting');
  if (red && red.kind === 'arrived') pause(sess, T.shift.pause.red(nameOf(sess.s.patients[red.id])));
  else if (back && back.kind === 'resultsReady') pause(sess, T.shift.pause.results(nameOf(sess.s.patients[back.id])));
  changed();
  return notices;
}

function pause(sess: Session, reason?: string) {
  sess.paused = true;
  sess.pauseReason = reason;
}

export function setSpeed(speed: Speed) {
  if (!session) return;
  session.speed = speed;
  session.paused = false;
  session.pauseReason = undefined;
  changed();
}

export function pauseClock() {
  if (!session) return;
  pause(session);
  changed();
}

// --- врач -----------------------------------------------------------------------------

/** Пригласить в кабинет; false — нельзя (кабинет занят, пациент уже не ждёт). */
export function callPatient(id: string): boolean {
  const sess = session;
  if (!sess || sess.s.current || sess.s.patients[id]?.status !== 'waiting') return false;
  run(sess, { kind: 'call', id });
  sess.meanwhile = [];
  sess.urgent = false;
  sess.focus = undefined;
  // автопауза сделала своё: позвали того, из-за кого встали часы, или другого
  if (sess.pauseReason) {
    sess.paused = false;
    sess.pauseReason = undefined;
  }
  changed();
  return true;
}

function doctor(cmd: Command, justDone?: Id) {
  const sess = session;
  const p = sess && current(sess.s);
  if (!sess || !p) return;
  const notices = run(sess, cmd);
  sess.meanwhile = meanwhileOf(sess.s, p, notices, justDone);
  sess.urgent = notices.some(n => n.kind === 'arrived' && n.triage === 'red');
  changed();
}

export function examine(exam: Id) {
  doctor({ kind: 'exam', exam }, exam);
}

export function waitForResults() {
  doctor({ kind: 'waitResults' });
}

export function sendAway() {
  const sess = session;
  if (!sess || !current(sess.s)) return;
  run(sess, { kind: 'sendAway' });
  sess.meanwhile = [];
  sess.urgent = false;
  save();
  changed();
}

function draft(cmd: Command) {
  const sess = session;
  if (!sess || !current(sess.s)) return;
  run(sess, cmd);
  changed();
}

export function chooseDiagnosis(id: Id) {
  draft({ kind: 'diagnose', id });
}

export function toggleTreatment(id: Id) {
  draft({ kind: 'toggleTreatment', id });
}

export function chooseSetting(setting: Setting) {
  draft({ kind: 'setting', setting });
}

/** Завершить приём: случай закрыт, его итог — на экране итога (фокус). */
export function finishCase() {
  const sess = session;
  const p = sess && current(sess.s);
  if (!sess || !p || !p.draft.diagnosis) return;
  run(sess, { kind: 'finish' });
  sess.focus = p.id;
  sess.meanwhile = [];
  sess.urgent = false;
  save();
  changed();
}

/** Открыть итог и разбор закрытого случая — из итогов дня. */
export function openCase(id: string) {
  if (!session?.s.patients[id]?.closed) return;
  session.focus = id;
  changed();
}

export function leaveCase() {
  if (!session || session.focus === undefined) return;
  session.focus = undefined;
  changed();
}

export function closeDay() {
  const sess = session;
  if (!sess || !sess.s.dayOpen) return;
  run(sess, { kind: 'closeDay' });
  sess.focus = undefined;
  sess.meanwhile = [];
  sess.urgent = false;
  save();
  changed();
}

export function nextDay() {
  const sess = session;
  if (!sess || sess.s.dayOpen) return;
  run(sess, { kind: 'nextDay' });
  sess.log = [];
  sess.focus = undefined;
  sess.paused = false;
  sess.pauseReason = undefined;
  save();
  changed();
}

// --- «за это время» ------------------------------------------------------------------------

const nameOf = (p: ShiftPatient) => patientName(p.patient);
const female = (p: ShiftPatient) => p.patient.sex === 'f';

function complaintOf(p: ShiftPatient): string {
  const first = complaintObservations(p.patient)[0];
  return first ? complaintText(db, first, p.patient.sex, p.patient.seed) : T.shift.checkup;
}

function record(sess: Session, notices: Notice[]) {
  const s = sess.s;
  for (const n of notices) {
    const p = n.kind === 'shiftEnd' ? undefined : s.patients[n.id];
    const item = (kind: LogKind, text: string) => sess.log.unshift({ key: sess.logSeq++, t: s.t, kind, text });
    if (n.kind === 'arrived' && p) item(n.triage === 'red' ? 'red' : 'arrived', n.triage === 'red' ? T.shift.notice.red(nameOf(p), complaintOf(p)) : T.shift.notice.arrived(nameOf(p), female(p)));
    else if (n.kind === 'resultsReady' && p && p.status === 'waiting') item('results', T.shift.notice.results(nameOf(p), female(p)));
    else if (n.kind === 'left' && p) item('left', T.shift.notice.left(nameOf(p), female(p)));
    else if (n.kind === 'shiftEnd') item('end', T.shift.notice.end);
  }
  sess.log.length = Math.min(sess.log.length, LOG_SIZE);
}

/**
 * «За это время» в карте пациента: срочный — первым (spec, «Неудачные случаи»), затем
 * результаты этого пациента, затем остальная очередь.
 */
function meanwhileOf(s: ShiftState, p: ShiftPatient, notices: Notice[], justDone?: Id): string[] {
  const out: string[] = [];
  const arrived = notices.filter((n): n is Extract<Notice, { kind: 'arrived' }> => n.kind === 'arrived');
  for (const n of arrived) if (n.triage === 'red') out.push(T.shift.notice.red(nameOf(s.patients[n.id]), complaintOf(s.patients[n.id])));
  for (const r of p.results) if (r.step === p.step && r.exam !== justDone) out.push(T.spikes.patient.ready(db.exams[r.exam].name.ru));
  const others = arrived.filter(n => n.triage !== 'red').length;
  if (others > 0) out.push(T.shift.notice.more(others));
  for (const n of notices) {
    const q = n.kind === 'shiftEnd' ? undefined : s.patients[n.id];
    if (n.kind === 'left' && q) out.push(T.shift.notice.left(nameOf(q), female(q)));
    if (n.kind === 'resultsReady' && q && q.id !== p.id && q.status === 'waiting') out.push(T.shift.notice.results(nameOf(q), female(q)));
    if (n.kind === 'shiftEnd') out.push(T.shift.notice.end);
  }
  return out;
}

// --- вид -------------------------------------------------------------------------------

const minuteOfDay = (t: number) => Math.floor((t % DAY) / 60);
const closedDay = (p: ShiftPatient) => Math.floor(p.closed!.at / DAY) + 1;

function row(s: ShiftState, p: ShiftPatient): QueueRow {
  const badges: string[] = [];
  if (p.kind === 'return') badges.push(T.shift.badge.return);
  else badges.push(p.kind === 'appointment' ? T.shift.badge.appointment : T.shift.badge.walkIn);
  if (p.step > 0) badges.push(T.shift.badge.results);
  return {
    id: p.id,
    name: nameOf(p),
    age: T.spikes.patient.years(p.patient.age),
    triage: p.triage,
    complaint: complaintOf(p),
    waits: T.shift.waits(Math.max(0, Math.floor((s.t - p.arriveT) / 60))),
    badges,
  };
}

function summaryOf(s: ShiftState): SummaryView | undefined {
  const h = s.history[s.history.length - 1];
  if (!h) return undefined;
  const all = Object.values(s.patients);
  const cases = all.filter(p => p.closed && closedDay(p) === h.day).sort((a, b) => a.closed!.at - b.closed!.at);
  const news = all
    .filter(p => p.closed && p.closed.plan.setting === 'home' && closedDay(p) + p.closed.outcome.day === h.day)
    .sort((a, b) => a.closed!.at - b.closed!.at)
    .map(p => ({ id: p.id, text: T.shift.news(nameOf(p), closedDay(p), outcomeText(p.closed!.outcome, 'home', female(p))) }));
  return {
    ...h,
    grades: { ...h.grades },
    confidence: cases.length > 0 ? Math.round((cases.reduce((a, p) => a + p.closed!.confidence, 0) / cases.length) * 10) : undefined,
    rationalMoney: cases.reduce((a, p) => a + p.closed!.rationalMoney, 0),
    cases: cases.map(p => ({ id: p.id, name: nameOf(p), verdict: p.closed!.verdict, overall: p.closed!.grades.overall, diagnosis: db.conditions[p.closed!.diagnosis].name.ru })),
    news,
  };
}

const EMPTY: Omit<ShiftView, 'version' | 'status'> = {
  day: 0, clock: '', dayOpen: false, afterHours: false, allDone: false, speed: 1, paused: false,
  queue: [], away: [], log: [], counts: { seen: 0, left: 0, waiting: 0, unseen: 0 }, restored: false,
};

function buildShiftView(): ShiftView {
  const sess = session;
  if (!sess) return { ...EMPTY, version, status };
  const s = sess.s;
  const inRoom = current(s);
  const away = Object.values(s.patients).filter(p => p.status === 'away').sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    version,
    status,
    day: s.day,
    clock: hhmm(minuteOfDay(s.t)),
    dayOpen: s.dayOpen,
    afterHours: s.t >= dayStart(s) + SHIFT_END,
    allDone: s.dayOpen && allDone(s),
    speed: sess.speed,
    paused: sess.paused,
    pauseReason: sess.pauseReason,
    inRoom: inRoom ? { id: inRoom.id, name: nameOf(inRoom) } : undefined,
    queue: s.queue.map(id => row(s, s.patients[id])),
    away: away.map(p => ({ id: p.id, name: nameOf(p), ready: hhmm(minuteOfDay(Math.max(...p.pending.map(x => x.readyAt)))) })),
    log: sess.log.map(l => ({ key: l.key, kind: l.kind, text: l.text, at: hhmm(minuteOfDay(l.t)) })),
    counts: { seen: s.summary.seen, left: s.summary.left, waiting: s.queue.length, unseen: s.queue.length + away.length + (inRoom ? 1 : 0) },
    summary: s.dayOpen ? undefined : summaryOf(s),
    restored: sess.restored,
  };
}

/** Итог и разбор закрытого случая: разбор пересчитывается той же ветвью зерна (engine/reviewOf). */
const decisions = new Map<string, Decision>();

function decisionFor(s: ShiftState, p: ShiftPatient, arrived: Arrival[]): Decision {
  const c = p.closed!;
  // «домой» — исход в итогах дня, когда он стал ясен; перевод — сразу (spec, «Что увидит игрок»)
  const lastClosed = s.dayOpen ? s.day - 1 : s.day;
  const known = c.plan.setting !== 'home' || lastClosed >= closedDay(p) + c.outcome.day;
  const key = `${s.meta.seed}:${p.id}:${known}`;
  const cached = decisions.get(key);
  if (cached) return cached;
  const ev = evaluatePlan(db, p.patient, c.plan, observationsOf(p));
  const review = reviewOf(db, s, p, c.diagnosis);
  const d = decisionOf({ patient: p.patient, arrived, diagnosis: c.diagnosis, verdict: c.verdict, confidence: c.confidence, plan: c.plan, ev, outcome: c.outcome, score: { ...c.grades, notes: c.notes }, review });
  const out = known ? d : { ...d, outcome: T.shift.outcomeLater };
  decisions.set(key, out);
  return out;
}

function buildCaseView(): VisitView | undefined {
  const sess = session;
  if (!sess) return undefined;
  const s = sess.s;
  const id = sess.focus ?? s.current;
  const p = id ? s.patients[id] : undefined;
  if (!p) return undefined;
  const arrived: Arrival[] = p.results.map(r => ({ exam: r.exam, step: r.step, at: minuteOfDay(r.at), obs: r.obs }));
  const prev = p.returnOf ? s.patients[p.returnOf] : undefined;
  return makeCaseView({
    version,
    patient: p.patient,
    clock: minuteOfDay(s.t),
    minutesSpent: Math.round(p.spent.seconds / 60),
    money: p.spent.money,
    step: p.step,
    arrived,
    pending: p.pending.map(x => ({ exam: x.exam, readyAt: minuteOfDay(x.readyAt) })),
    meanwhile: p.id === s.current ? sess.meanwhile : [],
    urgent: p.id === s.current && sess.urgent,
    done: p.done,
    draft: p.draft,
    decision: p.closed ? decisionFor(s, p, arrived) : undefined,
    canSendAway: p.status === 'inRoom' && p.pending.length > 0,
    returnNote: p.returnReason && prev?.closed ? T.shift.returnNote(p.returnReason, closedDay(prev), female(p)) : undefined,
  });
}

let shiftCache: { version: number; view: ShiftView } | null = null;
let caseCache: { version: number; view: VisitView | undefined } | null = null;

export function shiftView(): ShiftView {
  if (shiftCache?.version !== version) shiftCache = { version, view: buildShiftView() };
  return shiftCache.view;
}

/** Приём в кабинете или итог только что закрытого (выбранного) случая. */
export function shiftCaseView(): VisitView | undefined {
  if (caseCache?.version !== version) caseCache = { version, view: buildCaseView() };
  return caseCache.view;
}

export function useShift(): ShiftView {
  return useSyncExternalStore(subscribe, shiftView, shiftView);
}

export function useShiftCase(): VisitView | undefined {
  return useSyncExternalStore(subscribe, shiftCaseView, shiftCaseView);
}

/** Состояние смены — для тестов и отчёта об ошибке. */
export function shiftState(): ShiftState | undefined {
  return session?.s;
}
