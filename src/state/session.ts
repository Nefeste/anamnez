// Смена в амбулатории — для экранов (spec 2026-09-first-shift). Движок смены
// (engine/shift) плюс то, что нужно игре, а не модели: часы на карте по скорости, автопауза
// на «красного» и на результаты, «за это время», автосохранение (ADR 0010). Живая партия —
// одна: практика (слот `shift`) или песочница — своя больница (слот `sandbox`, spec
// 2026-09-own-hospital); между сменами в песочнице строят (buildAction, undoBuild, endBuild).
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
import { build, type BuildCommand, type BuildError, type HospitalState, type Plan, planOf } from '@/engine/hospital/build';
import { type Block, examWhere, openBlocks, type Problem, problemsOf, workingRooms } from '@/engine/hospital/requirements';
import { type ClinicLayout, cropPlan, layoutOf } from '@/engine/hospital/clinic';
import { memberAt, type StaffMember, staffingOf } from '@/engine/hospital/staff';
import { missionProgress } from '@/engine/campaign/campaign';
import { levelOf } from '@/engine/economy/economy';
import { apply, current, type HospitalCtx, hospitalCtx, newCampaign, newSandbox, newShift, newSingle, observationsOf, reviewFor, SANDBOX_VENUE } from '@/engine/shift/engine';
import {
  type Command, DAY, type Difficulty, type Mode, type Notice, SHIFT_END, SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState, type Triage,
} from '@/engine/shift/types';
import { T } from '@/i18n';
import { type Arrival, type Decision, decisionOf, hhmm, makeCaseView, outcomeText, patientName, type VisitView } from './caseView';
import { CLINIC, type Doing, type Placement, placements } from './clinicMap';
import { achievementsBy, archivedCase, caseKey, type DayRecord, profile, recordCases, recordDay, recordSingle } from './profile';
import { dateText } from './profileView';
import { SINGLE_CATEGORIES, type SingleCategory, singleResult } from './single';
import { blockText, type CashView, cashView, examBlockText, levelText, paymentText, personName, statusText } from './sandboxView';
import { loadSlot, type RawStore, saveSlot } from './saves';
import { settings } from './settings';
import { momentKey, momentOf, type TipMoment, type TipScreen, tipFor } from './tips';

/** Слоты сохранения: практика, песочница и «Смена» — у каждой своё, у кампании — три карьеры. */
export const SLOT = 'shift';
export const SANDBOX_SLOT = 'sandbox';
export const SINGLE_SLOT = 'single';
export const CAREERS = [1, 2, 3] as const;
export const slotOf = (m: Mode, career = 1) => (m === 'sandbox' ? SANDBOX_SLOT : m === 'campaign' ? `campaign-${career}` : m === 'single' ? SINGLE_SLOT : SLOT);
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

/** Кого коснулись на карте: кто это и что делает. */
/** Помещение своей больницы на карте смены: что это, работает ли, кто в нём и что происходит. */
export interface RoomView {
  title: string;
  status: string;
  lines: string[];
}

export interface WhoView {
  /** «Волков Сергей, 45 лет» — или должность */
  title: string;
  complaint?: string;
  /** что делает сейчас */
  doing: string;
  triage?: Triage;
  /** ждёт приёма, кабинет свободен — можно пригласить */
  callable: boolean;
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
  /** песочница: касса и репутация за день */
  cash?: CashView;
  /** кампания: какие задания выполнены за день (тексты) и сколько пришло писем */
  chapterDay?: { done: string[]; letters: number };
  /** достижения, полученные этим днём, — названия */
  achievements: string[];
  /** «Смена»: итог по категориям и лучший результат в этой больнице */
  single?: SingleView;
}

/** Итог «Смены»: оценки по категориям, общая, строки, лучший в этой больнице. */
export interface SingleView {
  venue: string;
  grades: { key: SingleCategory; label: string; grade: Grade }[];
  overall?: Grade;
  lines: string[];
  best?: string;
}

function singleView(s: ShiftState): SingleView {
  const t = T.single;
  const venue = s.meta.venue ?? 'preset.clinic';
  const r = singleResult(s);
  if (!r) return { venue: venueName(venue), grades: [], lines: [t.nobody] };
  const b = profile().best[venue];
  const mine = b && b.seed === s.meta.seed && b.points === r.points && b.seen === r.seen;
  return {
    venue: venueName(venue),
    grades: SINGLE_CATEGORIES.map(key => ({ key, label: t.category[key], grade: r.grades[key] })),
    overall: r.overall,
    lines: [t.seen(r.seen, r.arrived), t.correct(r.correct), t.minutes(r.minutes)],
    ...(b ? { best: mine ? t.isBest : t.best(b.overall, points(b.points), dateText(b.at)) } : {}),
  };
}

export interface ShiftView {
  version: number;
  /** none — сохранения нет, ready — смена открыта */
  status: 'idle' | 'loading' | 'none' | 'ready';
  /** практика или песочница: какую партию показывает (и какой нет, если status — none) */
  mode: Mode;
  /** касса песочницы, ₽ */
  cash?: number;
  difficulty: Difficulty;
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
  /** кто где на карте амбулатории (clinicMap.ts) */
  people: Placement[];
  /** план своей больницы для карты смены — в песочнице; в практике — готовая амбулатория (CLINIC) */
  layout?: ClinicLayout;
  /** кто это — для каждого на карте */
  who: Record<string, WhoView>;
  /** песочница: помещения карты смены — по касанию */
  rooms?: Record<string, RoomView>;
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
/** режим живой партии или той, что читается; status — про неё */
let mode: Mode = 'shift';
/** кампания: какая карьера (слот) */
let career = 1;
let status: ShiftView['status'] = 'idle';
let loading: Promise<void> | null = null;
let saving: Promise<unknown> = Promise.resolve();
let version = 0;
/** Подсказки наставника: момент, в который закрыли последнюю, — в тот же момент следующей нет. */
let tipHold: string | undefined;
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
  if (!s || !['shift', 'sandbox', 'campaign', 'single'].includes(s.meta?.mode) || typeof s.patients !== 'object') return false;
  const has = (table: Record<string, unknown>) => (id: Id) => table[id] !== undefined;
  if (s.meta.mode === 'campaign' && (!s.campaign || !db.chapters[s.campaign.chapter])) return false;
  if (s.meta.mode === 'single' && s.meta.venue !== SANDBOX_VENUE && !db.presets[s.meta.venue ?? '']) return false;
  // своя больница — у песочницы и кампании всегда, у «Смены» — кроме амбулатории практики
  if (s.meta.mode === 'sandbox' || s.meta.mode === 'campaign' || (s.meta.mode === 'single' && s.hospital)) {
    const h = s.hospital;
    if (!h || (s.meta.mode !== 'single' && !s.economy) || !Array.isArray(h.rooms)) return false;
    const ok = h.rooms.every(r => db.rooms[r.type]?.sizes.some(z => z.id === r.size) && r.equipment.every(e => e === null || has(db.equipment)(e)));
    if (!ok) return false;
  }
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

/**
 * Прочитать сохранение практики или песочницы, если ещё не читали; его нет — статус 'none'.
 * Без режима — тот, что уже выбран (сначала практика). Другой режим — живая партия
 * записывается и уступает место.
 */
export function loadShift(which?: Mode, careerNo?: number): Promise<void> {
  const want = which ?? mode;
  const wantCareer = want === 'campaign' ? (careerNo ?? career) : career;
  if (loading) return loading.then(() => loadShift(want, wantCareer));
  if (mode === want && career === wantCareer && (session || status === 'none')) return Promise.resolve();
  if (session) {
    save(true);
    session = null;
    decisions.clear();
  }
  mode = want;
  career = wantCareer;
  const st = store;
  if (!st) {
    status = 'none';
    changed();
    return Promise.resolve();
  }
  status = 'loading';
  changed();
  loading = loadSlot<ShiftState>(st, slotOf(want, wantCareer), e => fits(e, want, wantCareer))
    .then(r => {
      if (r && !session) {
        session = fresh(r.envelope.data, r.from === 'prev-1' || r.from === 'prev-2');
        // приёмы, закрытые до профиля (0.0.14 и раньше) или до сбоя, — в профиль; повторы он отбросит
        recordCases(closedCases(session.s));
      }
    })
    .catch(() => undefined)
    .finally(() => {
      status = session ? 'ready' : 'none';
      loading = null;
      changed();
    });
  return loading;
}

/** Сохранение этой партии: версия схемы, совместимо с базой, тот режим и та карьера. */
function fits(e: { schemaVersion: number; data: ShiftState }, m: Mode, c: number): boolean {
  return e.schemaVersion === SHIFT_SCHEMA_VERSION && compatible(e.data) && e.data.meta.mode === m && (m !== 'campaign' || (e.data.meta.career ?? 1) === c);
}

/** Отложенная запись, если она уже назначена. */
let deferred: ReturnType<typeof setTimeout> | null = null;

/**
 * Сохранить. Обычно — следующей задачей, а не посреди касания: экран успевает смениться
 * («Завершить приём» → итог), а несколько просьб подряд дают одну запись. Уходя в фон —
 * сразу (`now`): отложенная запись могла бы не успеть. Записи идут строго по очереди.
 */
function save(now = false): Promise<unknown> {
  if (!session || !store) return saving;
  session.savedT = session.s.t;
  if (now) return flush();
  deferred ??= setTimeout(flush, 0);
  return saving;
}

function flush(): Promise<unknown> {
  if (deferred) clearTimeout(deferred);
  deferred = null;
  const st = store;
  // партия — своя в каждой записи: сменилась на другую, пока запись ждала очереди, — пишется прежняя в свой слот
  const s = session?.s;
  saving = saving
    .then(() => (s && st ? saveSlot(st, slotOf(s.meta.mode, s.meta.career), s, SHIFT_SCHEMA_VERSION, new Date().toISOString()) : undefined))
    .catch(() => undefined); // не записалось — попробуем в следующий раз; игра продолжается
  return saving;
}

/** Сохранить сейчас — приложение уходит в фон. */
export function saveNow(): Promise<unknown> {
  return save(true);
}

/** Дождаться записи, в том числе отложенной, — для тестов. */
export function saved(): Promise<unknown> {
  return deferred ? flush() : saving;
}

function fresh(s: ShiftState, restored: boolean): Session {
  tipHold = undefined;
  return { s, speed: 1, paused: false, log: [], logSeq: 0, meanwhile: [], urgent: false, savedT: s.t, restored };
}

export function seasonOf(d: Date): Season {
  const m = d.getMonth(); // 0 — январь
  return m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}

/** Новая практика: день 1, 08:00. Прежнее сохранение перезаписывается. */
/** Новая практика; сложность выбирает игрок, без выбора — «Врач», как было до 0.0.16. */
export function startShift(seed?: number, season?: Season, difficulty: Difficulty = 'doctor') {
  begin(newShift(db, { seed: seed ?? Date.now() % 0x7fffffff, season: season ?? seasonOf(new Date()), difficulty }));
}

export type Budget = 'modest' | 'normal' | 'generous';

/** Новая песочница: участок пустой или с готовой амбулаторией, касса — по бюджету. Прежняя перезаписывается. */
export function startSandbox(opts: { start: 'empty' | 'clinic'; budget: Budget; difficulty: Difficulty; seed?: number; season?: Season }) {
  begin(newSandbox(db, {
    seed: opts.seed ?? Date.now() % 0x7fffffff, season: opts.season ?? seasonOf(new Date()), difficulty: opts.difficulty, start: opts.start,
    budget: db.economy.sandbox.budgets[opts.budget],
  }));
}

/** Новая карьера в слоте `career`: глава 1, её больница и бюджет, письма. Прежняя в этом слоте перезаписывается. */
export function startCampaign(opts: { career: number; difficulty: Difficulty; seed?: number; season?: Season }) {
  begin(newCampaign(db, { seed: opts.seed ?? Date.now() % 0x7fffffff, season: opts.season ?? seasonOf(new Date()), difficulty: opts.difficulty, career: opts.career }));
}

/** Своя больница из песочницы: живая партия или сохранение; песочницы нет — undefined. */
async function sandboxHospital(): Promise<{ hospital: HospitalState; staff: StaffMember[] } | undefined> {
  const live = session?.s;
  if (live?.meta.mode === 'sandbox' && live.hospital) return { hospital: live.hospital, staff: live.staff ?? [] };
  if (!store) return undefined;
  await saved();
  const r = await loadSlot<ShiftState>(store, SANDBOX_SLOT, e => fits(e, 'sandbox', 1)).catch(() => null);
  const s = r?.envelope.data;
  return s?.hospital ? { hospital: s.hospital, staff: s.staff ?? [] } : undefined;
}

/** Чего не хватает, чтобы открыть смену в этой больнице; всё есть — пусто. */
function blocksOf(h: { hospital: HospitalState; staff: StaffMember[] }) {
  const plan = planOf(db, h.hospital);
  const staffed = staffingOf(h.staff);
  return openBlocks(db, plan, workingRooms(db, plan, staffed), staffed);
}

/** Больница в списке «Смены»: можно ли, почему нет, лучший результат в ней. */
export interface VenueView {
  venue: Id;
  name: string;
  ok: boolean;
  hint: string;
}

const venueName = (venue: Id) => (venue === SANDBOX_VENUE ? T.single.sandbox : (db.presets[venue]?.name.ru ?? venue));
const points = (n: number) => n.toFixed(2).replace('.', ',');

/**
 * Где можно провести «Смену» (spec 2026-09-campaign, часть 14): амбулатория практики — всегда;
 * больница главы — если глава открыта в какой-нибудь карьере; своя из песочницы — если смену в
 * ней можно открыть. Нельзя — в списке с причиной.
 */
export async function singleVenues(): Promise<VenueView[]> {
  const games = await savedGames();
  const opened = Math.max(0, ...games.map(g => (g.mode === 'campaign' && g.chapter ? (db.chapters[g.chapter]?.order ?? 0) : 0)));
  const best = profile().best;
  const bestHint = (venue: Id, fallback: string) => (best[venue] ? T.single.bestShort(best[venue].overall, points(best[venue].points)) : fallback);
  const out: VenueView[] = [{ venue: 'preset.clinic', name: venueName('preset.clinic'), ok: true, hint: bestHint('preset.clinic', T.single.menuHint) }];
  for (const ch of Object.values(db.chapters)) {
    if (ch.preset === 'preset.clinic' || out.some(v => v.venue === ch.preset)) continue;
    const ok = ch.order <= opened;
    out.push({ venue: ch.preset, name: venueName(ch.preset), ok, hint: ok ? bestHint(ch.preset, ch.place.ru) : T.single.needChapter(ch.order, ch.name.ru) });
  }
  const own = await sandboxHospital();
  const blocks = own ? blocksOf(own) : [];
  out.push({
    venue: SANDBOX_VENUE, name: venueName(SANDBOX_VENUE), ok: !!own && blocks.length === 0,
    hint: !own ? T.single.noSandbox : blocks.length > 0 ? `${T.sandbox.needToOpen} ${blocks.map(b => blockText(db, b)).join(', ')}` : bestHint(SANDBOX_VENUE, T.single.sandboxHint),
  });
  return out;
}

/**
 * Новая «Смена»: один день в выбранной больнице; своя — копия песочницы. Прежняя смена
 * перезаписывается. Нельзя (больницы нет или смену в ней не открыть) — false.
 */
export async function startSingle(opts: { venue: Id; difficulty: Difficulty; seed?: number; season?: Season }): Promise<boolean> {
  let own: { hospital: HospitalState; staff: StaffMember[] } | undefined;
  if (opts.venue === SANDBOX_VENUE) {
    own = await sandboxHospital();
    if (!own || blocksOf(own).length > 0) return false;
  } else if (!db.presets[opts.venue]) return false;
  begin(newSingle(db, {
    seed: (opts.seed ?? Date.now() % 0x7fffffff) >>> 0, season: opts.season ?? seasonOf(new Date()), difficulty: opts.difficulty, venue: opts.venue,
    ...(own ? { hospital: own.hospital, staff: own.staff } : {}),
  }));
  return true;
}

function begin(s: ShiftState) {
  if (session) save(true); // прежняя партия — в свой слот
  session = fresh(s, false);
  mode = s.meta.mode;
  if (s.meta.career) career = s.meta.career;
  status = 'ready';
  decisions.clear();
  save();
  changed();
}

/** Для тестов: забыть смену в памяти, как после перезапуска приложения. */
export function forgetShift() {
  if (deferred) clearTimeout(deferred);
  deferred = null;
  session = null;
  mode = 'shift';
  career = 1;
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
 * результатами — пауза, если она не выключена в настройках. Отдаёт случившееся — для звука.
 */
export function tick(ms: number = TICK_MS): Notice[] {
  const sess = session;
  if (!sess || sess.paused || !sess.s.dayOpen || sess.s.current || allDone(sess.s)) return [];
  const notices = run(sess, { kind: 'advance', seconds: Math.round((ms / 1000) * sess.speed * 60) });
  const { pauseOnRed, pauseOnResults } = settings();
  const red = pauseOnRed ? notices.find(n => n.kind === 'arrived' && n.triage === 'red') : undefined;
  const back = pauseOnResults ? notices.find(n => n.kind === 'resultsReady' && sess.s.patients[n.id].status === 'waiting') : undefined;
  if (red && red.kind === 'arrived') pause(sess, T.shift.pause.red(nameOf(sess.s.patients[red.id])));
  else if (back && back.kind === 'resultsReady') pause(sess, T.shift.pause.results(nameOf(sess.s.patients[back.id])));
  changed();
  return notices;
}

function pause(sess: Session, reason?: string) {
  sess.paused = true;
  sess.pauseReason = reason;
}

/** Не дольше этого проматываем за раз — четыре игровых часа. */
const SKIP_MAX = 4 * 3600;

/**
 * Промотать пустое время: кабинет свободен, в очереди никого — часы идут поминутно, пока
 * кто-нибудь не придёт, не вернётся с результатами или не кончится приём (отзыв на 0.0.7:
 * следующего пациента ждали 40 секунд). Те же события, что на ×1, только без ожидания.
 */
export function skipIdle(): Notice[] {
  const sess = session;
  if (!sess || !sess.s.dayOpen || sess.s.current || sess.s.queue.length > 0 || allDone(sess.s)) return [];
  const out: Notice[] = [];
  for (let spent = 0; spent < SKIP_MAX && !allDone(sess.s); spent += 60) {
    const notices = run(sess, { kind: 'advance', seconds: 60 });
    out.push(...notices);
    if (sess.s.queue.length > 0 || notices.some(n => n.kind === 'shiftEnd')) break;
  }
  sess.paused = false;
  sess.pauseReason = undefined;
  changed();
  return out;
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
  recordCases(closedCases(sess.s));
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
  recordDay(dayRecord(sess.s));
  // «Смена»: лучший результат в этой больнице — в профиль
  const r = sess.s.meta.mode === 'single' ? singleResult(sess.s) : undefined;
  if (r) recordSingle(sess.s.meta.venue ?? 'preset.clinic', { points: r.points, overall: r.overall, seen: r.seen, arrived: r.arrived, seed: sess.s.meta.seed });
  sess.focus = undefined;
  sess.meanwhile = [];
  sess.urgent = false;
  save();
  changed();
}

export function nextDay() {
  const sess = session;
  if (!sess || sess.s.dayOpen) return;
  // песочница: без регистратуры, зоны ожидания и кабинета смену не открыть — движок не откроет
  run(sess, { kind: 'nextDay' });
  if (!sess.s.dayOpen) {
    changed();
    return;
  }
  sess.log = [];
  sess.focus = undefined;
  sess.paused = false;
  sess.pauseReason = undefined;
  save();
  changed();
}

/** Ключ закрытого дня: партия и день — день засчитывается достижениям один раз. */
const dayKey = (s: ShiftState, day: number) => `${s.meta.mode}:${s.meta.seed}:${day}`;

/** Закрытый день — для достижений: кого приняли, всех ли, что работало в своей больнице, выполнена ли глава. */
function dayRecord(s: ShiftState): DayRecord {
  const h = s.history[s.history.length - 1];
  const ctx = s.hospital ? hospitalCtx(db, s) : undefined;
  return {
    key: dayKey(s, h.day),
    seen: h.seen,
    noLeft: h.seen > 0 && h.left === 0 && h.unseen === 0,
    rooms: ctx ? [...new Set(ctx.plan.rooms.filter(r => ctx.working.has(r.id)).map(r => r.type))] : [],
    chapters: s.campaign?.complete !== undefined ? [s.campaign.chapter] : [],
  };
}

const achievementNames = (key: string) => achievementsBy(key).map(id => db.achievements[id].name.ru);

// --- стройка: песочница, между сменами (ADR 0016) ------------------------------------------

/** Постройка; нельзя — почему (экран пишет причину), и ничего не меняется. */
export function buildAction(cmd: BuildCommand): BuildError | null {
  const sess = session;
  const s = sess?.s;
  if (!sess || !s?.hospital || !s.economy || s.dayOpen) return { kind: 'unknown' };
  const r = build(db, { hospital: s.hospital, cash: s.economy.cash }, cmd);
  if (!r.ok) return r.error;
  run(sess, { kind: 'build', cmd });
  save();
  changed();
  return null;
}

/** «Отменить» — последнее действие стройки, деньги возвращаются полностью. */
export function undoBuild() {
  const sess = session;
  if (!sess?.s.undo?.length) return;
  run(sess, { kind: 'undo' });
  save();
  changed();
}

/** Экран стройки закрыт: отменять больше нечего. */
export function endBuild() {
  const sess = session;
  if (!sess?.s.hospital) return;
  run(sess, { kind: 'buildEnd' });
  save();
  changed();
}

// --- персонал: песочница, между сменами -----------------------------------------------------

function staffAction(cmd: Command) {
  const sess = session;
  if (!sess?.s.staff || sess.s.dayOpen) return;
  run(sess, cmd);
  save();
  changed();
}

/** Нанять кандидата — в резерв; назначить — в помещение (нет — в резерв); уволить. */
export const hire = (id: string) => staffAction({ kind: 'hire', id });
export const fire = (id: string) => staffAction({ kind: 'fire', id });
export const assign = (id: string, room?: string) => staffAction({ kind: 'assign', id, ...(room ? { room } : {}) });

export interface PersonView {
  id: string;
  name: string;
  role: Id;
  roleName: string;
  skill: number;
  trait?: string;
  salary: number;
  /** где работает; нет — в резерве */
  room?: string;
  roomName?: string;
}

/** Место в помещении, где нужен человек: занято ли и кем. */
export interface PostView {
  room: string;
  roomName: string;
  role: Id;
  roleName: string;
  who?: string;
}

export interface StaffView {
  version: number;
  staff: PersonView[];
  candidates: PersonView[];
  posts: PostView[];
  /** зарплаты всех нанятых за смену, ₽ */
  salaries: number;
}

function personOf(s: ShiftState, m: StaffMember): PersonView {
  const room = m.room ? s.hospital?.rooms.find(r => r.id === m.room) : undefined;
  return {
    id: m.id, name: personName(m.sex, m.seed), role: m.role, roleName: db.roles[m.role]?.name.ru ?? m.role, skill: m.skill,
    ...(m.trait ? { trait: T.sandbox.traits[m.trait] } : {}), salary: m.salary,
    ...(room ? { room: room.id, roomName: db.rooms[room.type].name.ru } : {}),
  };
}

function buildStaffView(): StaffView | undefined {
  const s = session?.s;
  if (!s?.hospital || !s.staff) return undefined;
  const staff = s.staff;
  const posts: PostView[] = s.hospital.rooms.flatMap(r => db.rooms[r.type].staff.filter(role => db.roles[role]?.hire).map(role => ({
    room: r.id, roomName: db.rooms[r.type].name.ru, role, roleName: db.roles[role].name.ru,
    ...(() => {
      const m = staff.find(x => x.room === r.id && x.role === role);
      return m ? { who: m.id } : {};
    })(),
  })));
  return {
    version, staff: staff.map(m => personOf(s, m)), candidates: (s.candidates ?? []).map(m => personOf(s, m)), posts,
    salaries: staff.reduce((n, m) => n + m.salary, 0),
  };
}

let staffCache: { version: number; view: StaffView | undefined } | null = null;

export function staffView(): StaffView | undefined {
  if (staffCache?.version !== version) staffCache = { version, view: buildStaffView() };
  return staffCache.view;
}

export function useStaff(): StaffView | undefined {
  return useSyncExternalStore(subscribe, staffView, staffView);
}

// план своей больницы на карте смены — один объект на план и штат: карта держит своих ходоков
const layouts = new WeakMap<HospitalCtx, ClinicLayout>();

function sandboxLayout(s: ShiftState): ClinicLayout {
  const ctx = hospitalCtx(db, s);
  let l = layouts.get(ctx);
  if (!l) {
    l = layoutOf(cropPlan(ctx.plan), ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
    layouts.set(ctx, l);
  }
  return l;
}

// обследования, которых в своей больнице не сделать, — и почему
const blocked = new WeakMap<HospitalCtx, Record<Id, string>>();

function unavailableOf(s: ShiftState): Record<Id, string> {
  const ctx = hospitalCtx(db, s);
  let out = blocked.get(ctx);
  if (!out) {
    out = {};
    for (const id of Object.keys(db.exams)) {
      const w = examWhere(db, ctx.plan, ctx.working, ctx.staffed, id);
      if ('block' in w) out[id] = examBlockText(db, w.block);
    }
    blocked.set(ctx, out);
  }
  return out;
}

export interface BuildView {
  version: number;
  hospital: HospitalState;
  plan: Plan;
  cash: number;
  /** сколько действий можно отменить */
  undo: number;
  /** чего не хватает каждому помещению; пусто — работает */
  problems: Record<string, Problem[]>;
  /** что мешает открыть смену */
  open: Block[];
  /** репутация 0–100 */
  reputation: number;
  /** тариф ОМС за приём по уровню амбулатории — строкой */
  level: string;
  /** кампания: какие помещения можно строить в главе; нет — любые */
  allowed?: Id[];
}

function buildBuildView(): BuildView | undefined {
  const s = session?.s;
  if (!s?.hospital || !s.economy) return undefined;
  const plan = planOf(db, s.hospital);
  const staffed = staffingOf(s.staff ?? []);
  const problems: Record<string, Problem[]> = {};
  for (const r of plan.rooms) problems[r.id] = problemsOf(db, plan, r, staffed);
  const working = workingRooms(db, plan, staffed);
  return {
    version, hospital: s.hospital, plan, cash: s.economy.cash, undo: s.undo?.length ?? 0, problems, open: openBlocks(db, plan, working, staffed),
    reputation: s.economy.reputation ?? db.economy.reputation.start, level: levelText(db, levelOf(db, plan, working)),
    ...(s.campaign && db.chapters[s.campaign.chapter] ? { allowed: db.chapters[s.campaign.chapter].build } : {}),
  };
}

let buildCache: { version: number; view: BuildView | undefined } | null = null;

export function buildView(): BuildView | undefined {
  if (buildCache?.version !== version) buildCache = { version, view: buildBuildView() };
  return buildCache.view;
}

export function useBuild(): BuildView | undefined {
  return useSyncExternalStore(subscribe, buildView, buildView);
}

// --- сохранения для меню ---------------------------------------------------------------------

/** Сохранённая партия — для «Продолжить» в меню: что, когда записана, где остановились. */
export interface GameSummary {
  mode: Mode;
  savedAt: string;
  day: number;
  clock: string;
  difficulty: Difficulty;
  cash?: number;
  /** кампания: слот карьеры, глава и основные задания — выполнено из скольких */
  career?: number;
  chapter?: string;
  mains?: { done: number; of: number };
  /** «Смена»: в какой больнице — названием */
  venue?: string;
}

/** Обе партии с диска, последняя записанная — первой. Живая партия сначала записывается. */
export async function savedGames(): Promise<GameSummary[]> {
  const st = store;
  if (!st) return [];
  await saved();
  const out: GameSummary[] = [];
  const slots: [Mode, number][] = [['shift', 1], ['sandbox', 1], ['single', 1], ...CAREERS.map(c => ['campaign', c] as [Mode, number])];
  for (const [m, c] of slots) {
    const r = await loadSlot<ShiftState>(st, slotOf(m, c), e => fits(e, m, c)).catch(() => null);
    if (!r) continue;
    const s = r.envelope.data;
    const ch = s.campaign ? db.chapters[s.campaign.chapter] : undefined;
    const mains = ch?.missions.filter(x => x.main) ?? [];
    out.push({
      mode: m, savedAt: r.envelope.savedAt, day: s.day, clock: hhmm(minuteOfDay(s.t)), difficulty: s.meta.difficulty ?? 'doctor',
      ...(s.economy ? { cash: s.economy.cash } : {}),
      ...(ch && s.campaign ? { career: c, chapter: ch.id, mains: { done: mains.filter(x => s.campaign!.done[x.id] !== undefined).length, of: mains.length } } : {}),
      ...(m === 'single' ? { venue: venueName(s.meta.venue ?? 'preset.clinic') } : {}),
    });
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

// --- кампания (spec 2026-09-campaign) ---------------------------------------------------------

/** Письмо в главе: от кого, портрет, текст, когда пришло, прочитано ли. */
export interface LetterView {
  id: string;
  from: string;
  role: string;
  portrait: { seed: number; sex: 'm' | 'f'; age: number };
  text: string;
  day: number;
  read: boolean;
}

/** Задание главы: текст, основное ли, ход словами, выполнено ли и в какой день. */
export interface MissionView {
  id: string;
  text: string;
  main: boolean;
  progress: string;
  done?: number;
}

/** Глава для экрана между сменами и для итогов дня. */
export interface CampaignView {
  version: number;
  title: string;
  place: string;
  /** день главы: первый — первая смена в ней */
  day: number;
  letters: LetterView[];
  missions: MissionView[];
  /** все основные задания выполнены */
  complete: boolean;
}

function buildCampaignView(): CampaignView | undefined {
  const s = session?.s;
  const c = s?.campaign;
  const ch = c ? db.chapters[c.chapter] : undefined;
  if (!s || !c || !ch) return undefined;
  const t = T.campaign;
  const letters = [...c.letters].reverse().flatMap(l => {
    const rec = ch.letters.find(x => x.id === l.id);
    const who = rec ? db.characters[rec.from] : undefined;
    if (!rec || !who) return [];
    return [{ id: l.id, from: who.short.ru, role: who.role.ru, portrait: { seed: who.portrait, sex: who.sex, age: who.age }, text: rec.text.ru, day: l.day - c.since, read: !!l.read }];
  });
  const cv = { campaign: c, history: s.history, hospital: s.hospital, staff: s.staff };
  const missions = ch.missions.map(m => {
    const p = missionProgress(db, cv, m);
    const done = c.done[m.id];
    return {
      id: m.id, text: m.text.ru, main: m.main,
      progress: done !== undefined ? t.doneOn(done - c.since) : m.kind === 'seen' ? t.seenProgress(p.value, p.target, p.accuracy ?? 0) : m.kind === 'roomWorks' ? t.notYet : t.dayProgress(p.value, p.target),
      ...(done !== undefined ? { done: done - c.since } : {}),
    };
  });
  return { version, title: t.chapter(ch.order, ch.name.ru), place: ch.place.ru, day: s.day - c.since, letters, missions, complete: c.complete !== undefined };
}

let campaignCache: { version: number; view: CampaignView | undefined } | null = null;

export function campaignView(): CampaignView | undefined {
  if (campaignCache?.version !== version) campaignCache = { version, view: buildCampaignView() };
  return campaignCache.view;
}

export function useCampaign(): CampaignView | undefined {
  return useSyncExternalStore(subscribe, campaignView, campaignView);
}

/** Письмо прочитано — отметка в сохранении карьеры, не ход игры. */
export function readLetter(id: string) {
  const l = session?.s.campaign?.letters.find(x => x.id === id);
  if (!l || l.read) return;
  l.read = true;
  save();
  changed();
}

// --- подсказки наставника (spec 2026-09-campaign) -------------------------------------------

/** Подсказка на экране: заголовок, текст, кто подсказывает; первая в карьере — с «Без подсказок». */
export interface TipView {
  id: string;
  title: string;
  text: string;
  from: string;
  portrait: { seed: number; sex: 'm' | 'f'; age: number };
  first: boolean;
}

/** Приём сейчас — только в первую смену главы с обучением (до «Открыть смену» следующего дня). */
function tipMoment(screen: TipScreen): TipMoment | undefined {
  const s = session?.s;
  const c = s?.campaign;
  const ch = c ? db.chapters[c.chapter] : undefined;
  if (!s || !c || !ch || ch.tutorial.length === 0 || s.day !== c.since + 1) return undefined;
  const id = screen === 'review' ? (session?.focus ?? s.current) : s.current;
  const p = id ? s.patients[id] : undefined;
  return p ? momentOf(db, screen, p) : undefined;
}

function buildTipView(screen: TipScreen): TipView | undefined {
  const c = session?.s.campaign;
  const m = tipMoment(screen);
  if (!c || !m) return undefined;
  const st = c.tips ?? { shown: [] };
  const tip = tipFor(db, st, m, tipHold);
  const who = tip ? db.characters[tip.from] : undefined;
  if (!tip || !who) return undefined;
  return {
    id: tip.id, title: tip.name.ru, text: tip.text.ru, from: who.short.ru, portrait: { seed: who.portrait, sex: who.sex, age: who.age },
    first: st.shown.length === 0,
  };
}

const tipCache: Partial<Record<TipScreen, { version: number; view: TipView | undefined }>> = {};

export function tipView(screen: TipScreen): TipView | undefined {
  if (tipCache[screen]?.version !== version) tipCache[screen] = { version, view: buildTipView(screen) };
  return tipCache[screen]?.view;
}

export function useTip(screen: TipScreen): TipView | undefined {
  const get = () => tipView(screen);
  return useSyncExternalStore(subscribe, get, get);
}

/** «Понятно»: подсказка показана в этой карьере; следующая — не раньше следующего действия врача. */
export function seenTip(id: string, screen: TipScreen) {
  const c = session?.s.campaign;
  if (!c) return;
  const st = (c.tips ??= { shown: [] });
  if (!st.shown.includes(id)) st.shown.push(id);
  const m = tipMoment(screen);
  tipHold = m ? momentKey(m) : undefined;
  save();
  changed();
}

/** «Без подсказок» — в этой карьере их больше нет. */
export function tipsOff() {
  const c = session?.s.campaign;
  if (!c) return;
  (c.tips ??= { shown: [] }).off = true;
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
  if (p.payer) badges.push(T.sandbox.payers[p.payer]);
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
    ...(h.economy ? { cash: cashView(db, h.economy) } : {}),
    ...(h.campaign && s.campaign ? {
      chapterDay: {
        done: h.campaign.done.map(id => db.chapters[s.campaign!.chapter]?.missions.find(m => m.id === id)?.text.ru ?? id),
        letters: h.campaign.letters.length,
      },
    } : {}),
    achievements: achievementNames(dayKey(s, h.day)),
    ...(s.meta.mode === 'single' ? { single: singleView(s) } : {}),
  };
}

const EMPTY: Omit<ShiftView, 'version' | 'status' | 'mode'> = {
  difficulty: 'student', day: 0, clock: '', dayOpen: false, afterHours: false, allDone: false, speed: 1, paused: false,
  queue: [], away: [], log: [], counts: { seen: 0, left: 0, waiting: 0, unseen: 0 }, restored: false, people: [], who: {},
};

function buildShiftView(): ShiftView {
  const sess = session;
  if (!sess) return { ...EMPTY, version, status, mode };
  const s = sess.s;
  const inRoom = current(s);
  const away = Object.values(s.patients).filter(p => p.status === 'away').sort((a, b) => (a.id < b.id ? -1 : 1));
  const layout = s.hospital ? sandboxLayout(s) : undefined;
  const people = placements(db, layout ?? CLINIC, s);
  return {
    version,
    status,
    mode: s.meta.mode,
    ...(s.economy ? { cash: s.economy.cash } : {}),
    difficulty: s.meta.difficulty ?? 'doctor',
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
    people,
    who: whoOf(s, people),
    ...(s.hospital ? { rooms: roomsOf(s) } : {}),
    ...(layout ? { layout } : {}),
  };
}

// помещения своей больницы: что это, работает ли и кто в нём — на день; что происходит — сейчас
const roomBase = new WeakMap<HospitalCtx, Record<string, RoomView>>();

function roomsOf(s: ShiftState): Record<string, RoomView> {
  const ctx = hospitalCtx(db, s);
  let base = roomBase.get(ctx);
  if (!base) {
    base = {};
    for (const r of ctx.plan.rooms) {
      const rec = db.rooms[r.type];
      const who = rec.staff.flatMap(role => {
        const m = memberAt(ctx.staff, r.id, role);
        return m ? [T.sandbox.roomWho(db.roles[role].name.ru, personName(m.sex, m.seed), m.skill)] : [];
      });
      base[r.id] = { title: rec.name.ru, status: statusText(db, problemsOf(db, ctx.plan, r, ctx.staffed)), lines: who };
    }
    roomBase.set(ctx, base);
  }
  const t = T.sandbox;
  const all = Object.values(s.patients);
  const out: Record<string, RoomView> = {};
  for (const r of ctx.plan.rooms) {
    const now: string[] = [];
    if (r.type === 'room.office') {
      const p = current(s);
      now.push(p ? t.roomInOffice(nameOf(p)) : t.roomFree, t.roomQueue(s.queue.length));
    } else if (r.type === 'room.waiting') {
      now.push(t.roomSeats(s.queue.length, r.seats.length));
    } else if (r.type === 'room.lab') {
      const n = all.reduce((m, p) => m + p.pending.filter(x => x.room === r.id).length, 0);
      now.push(n > 0 ? t.roomLab(n) : t.roomFree);
    } else if (db.rooms[r.type].staff.length > 0 && all.some(p => p.pending.some(x => x.room === r.id))) {
      // рентген, ЭКГ: кто сейчас на обследовании и сколько ждут
      const here = all.flatMap(p => p.pending.filter(x => x.room === r.id).map(x => ({ p, x })));
      const at = here.find(({ x }) => (x.start ?? 0) <= s.t && s.t < (x.end ?? 0));
      if (at) now.push(t.roomNow(nameOf(at.p)));
      const next = here.filter(({ x }) => (x.start ?? 0) > s.t).length;
      if (next > 0) now.push(t.roomNext(next));
      if (!at && next === 0) now.push(t.roomFree);
    }
    out[r.id] = { ...base[r.id], lines: [...base[r.id].lines, ...now] };
  }
  return out;
}

function whoOf(s: ShiftState, people: readonly Placement[]): Record<string, WhoView> {
  const t = T.shift.map;
  const out: Record<string, WhoView> = {};
  for (const x of people) {
    const d = x.doing;
    if (d.kind === 'staff') {
      out[x.id] = { title: t.staff[d.role], doing: t.duty[d.role], callable: false };
      continue;
    }
    const p = s.patients[x.id];
    if (!p) continue;
    out[x.id] = {
      title: `${nameOf(p)}, ${T.spikes.patient.years(p.patient.age)}`,
      complaint: complaintOf(p),
      doing: doingText(s, p, d),
      triage: p.triage,
      callable: !!x.callable,
    };
  }
  return out;
}

function doingText(s: ShiftState, p: ShiftPatient, d: Doing): string {
  const t = T.shift.map.doing;
  switch (d.kind) {
    case 'registration':
      return t.registration;
    case 'triage':
      return t.triage;
    case 'waiting':
      return t.waiting(Math.max(0, Math.floor((s.t - p.arriveT) / 60)));
    case 'office':
      return t.office;
    case 'exam':
      return t.exam[d.room];
    case 'examQueue':
      return t.examQueue[d.room];
    case 'results':
      return t.results(hhmm(minuteOfDay(d.readyAt)));
    case 'leaving':
      return t.leaving;
    case 'left':
      return t.left(female(p));
    case 'staff':
      return '';
  }
}

/** Итог и разбор закрытого случая: разбор пересчитывается той же ветвью зерна (engine/reviewFor). */
const decisions = new Map<string, Decision>();

/** «Домой» — исход в итогах дня, когда он стал ясен; перевод — сразу (spec, «Что увидит игрок»). */
function outcomeKnown(s: ShiftState, p: ShiftPatient): boolean {
  const c = p.closed!;
  const lastClosed = s.dayOpen ? s.day - 1 : s.day;
  return c.plan.setting !== 'home' || lastClosed >= closedDay(p) + c.outcome.day;
}

function decisionFor(meta: Pick<ShiftState['meta'], 'seed' | 'department'>, p: ShiftPatient, arrived: Arrival[], known: boolean): Decision {
  const c = p.closed!;
  const key = `${meta.seed}:${p.id}:${known}`;
  const cached = decisions.get(key);
  if (cached) return cached;
  const ev = evaluatePlan(db, p.patient, c.plan, observationsOf(p));
  const review = reviewFor(db, meta, p, c.diagnosis);
  const d = decisionOf({ patient: p.patient, arrived, diagnosis: c.diagnosis, verdict: c.verdict, confidence: c.confidence, plan: c.plan, ev, outcome: c.outcome, score: { ...c.grades, notes: c.notes }, review });
  const out = known ? d : { ...d, outcome: T.shift.outcomeLater };
  decisions.set(key, out);
  return out;
}

const arrivedOf = (p: ShiftPatient): Arrival[] => p.results.map(r => ({ exam: r.exam, step: r.step, at: minuteOfDay(r.at), obs: r.obs }));

/** Закрытые приёмы смены — для профиля (profile.ts, recordCases). */
function closedCases(s: ShiftState) {
  return Object.values(s.patients)
    .filter(p => p.closed)
    .map(p => ({ seed: s.meta.seed, department: s.meta.department, day: closedDay(p), patient: p }));
}

/**
 * Итог и разбор приёма из архива профиля — та же ветвь зерна, что в смене (engine/reviewFor).
 * Исход «домой» в нынешней практике открывается, как в смене, — в итогах дня.
 */
export function archiveCaseView(key: string): VisitView | undefined {
  const r = archivedCase(key);
  if (!r) return undefined;
  const p = r.patient;
  const s = session?.s;
  const known = s && s.meta.seed === r.seed ? outcomeKnown(s, p) : true;
  const arrived = arrivedOf(p);
  return makeCaseView({
    version: 0,
    patient: p.patient,
    clock: minuteOfDay(p.closed!.at),
    minutesSpent: Math.round(p.spent.seconds / 60),
    money: p.spent.money,
    step: p.step,
    arrived,
    pending: [],
    meanwhile: [],
    done: p.done,
    draft: p.draft,
    decision: decisionFor(r, p, arrived, known),
    difficulty: 'doctor',
  });
}

function buildCaseView(): VisitView | undefined {
  const sess = session;
  if (!sess) return undefined;
  const s = sess.s;
  const id = sess.focus ?? s.current;
  const p = id ? s.patients[id] : undefined;
  if (!p) return undefined;
  const arrived = arrivedOf(p);
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
    decision: p.closed ? decisionFor(s.meta, p, arrived, outcomeKnown(s, p)) : undefined,
    canSendAway: p.status === 'inRoom' && p.pending.length > 0,
    returnNote: p.returnReason && prev?.closed ? T.shift.returnNote(p.returnReason, closedDay(prev), female(p)) : undefined,
    difficulty: s.meta.difficulty ?? 'doctor',
    ...(s.hospital ? { unavailable: unavailableOf(s) } : {}),
    ...(p.payer ? { payerNote: T.sandbox.payerNote[p.payer] } : {}),
    ...(p.paid && p.closed ? { payment: paymentText(db, p.payer ?? 'oms', p.paid, p.closed) } : {}),
    ...(p.closed ? { achievements: achievementNames(caseKey(s.meta.seed, p.id)) } : {}),
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
