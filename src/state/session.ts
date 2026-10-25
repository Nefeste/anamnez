// Смена в амбулатории — для экранов (spec 2026-09-first-shift). Движок смены
// (engine/shift) плюс то, что нужно игре, а не модели: часы на карте по скорости, автопауза
// на «красного» и на результаты, «за это время», автосохранение (ADR 0010). Живая партия —
// одна: практика (слот `shift`) или песочница — своя больница (слот `sandbox`, spec
// 2026-09-own-hospital); между сменами в песочнице строят (buildAction, undoBuild, endBuild).
//
// Хранилище приходит снаружи (setStore): на телефоне — файлы, в вебе — localStorage, в
// тестах — память. Модуль, как и saves.ts, не знает про платформу.
import { useEffect, useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id, Mission, Season, Setting } from '@/content/types';
import { complaintObservations } from '@/engine/med/exams';
import { deriveByParams, deriveByValue, deriveParams } from '@/engine/med/generate';
import { evaluatePlan, primaryOf } from '@/engine/med/plan';
import type { Grade } from '@/engine/med/score';
import { complaintText, observationText } from '@/engine/med/text';
import { build, type BuildCommand, type BuildError, type HospitalState, type Plan, planOf } from '@/engine/hospital/build';
import { type Block, DOCTOR, doctorRoom, examWhere, openBlocks, type Problem, problemsOf, standInOf, standInsOf, workingRooms } from '@/engine/hospital/requirements';
import { type ClinicLayout, cropPlan, layoutOf } from '@/engine/hospital/clinic';
import { memberAt, presetStaff, type StaffMember, staffingOf } from '@/engine/hospital/staff';
import { type MissionProgress, missionProgress, missionsOf, nextChapterOf, tutorialDayOf } from '@/engine/campaign/campaign';
import { levelOf } from '@/engine/economy/economy';
import { askMinutes, skillsFor } from '@/engine/career/skills';
import {
  apply, atDoctor, atDoorOf, bedsideEquipment, bedsideOf, boxBeds, brokenOf, current, freeBeds, freeBoxBeds, freeIcuBeds, freeRicuBeds, type HospitalCtx, hospitalCtx, icuBeds, inBox, inIcu, inpatientsOf, inRicu,
  leftForPlayer, moreUrgent, newCampaign, newSandbox, ricuBeds,
  newScenario, newShift, newSingle, observationsOf, operationOf, type OrBlock, orBlock, orQueueOf, prepareReview, reviewFor, type ReviewMeta, SANDBOX_VENUE, stayEquipment, targetPlace,
  venueState,
  wardBeds, catchUp, prepareFinish, reviewedCase, waitUntil,
} from '@/engine/shift/engine';
import { BUDGET, type Challenge, challengeBlock } from '@/engine/shift/challenges';
import { bayVitals, measuresDue, valueKey } from '@/engine/shift/measures';
import { isXray, type Scenario, SCENARIO_DAYS, SCENARIOS, scenarioFits, scenarioPrior } from '@/engine/shift/scenarios';
import { minutesTo, targetStart, targetsFor } from '@/engine/shift/targets';
import {
  type ClosedCase, type Command, DAY, type Difficulty, easyLevel, type Mode, type Notice, SHIFT_END, SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState, type Triage,
} from '@/engine/shift/types';
import { T } from '@/i18n';
import { lowerFirst } from '@/i18n/case';
import {
  type Arrival, type CaseTarget, type Decision, decisionOf, type FirstMeasuresView, hhmm, makeCaseView, type MeasureButton, outcomeText, patientName, resultName,
  type SettingOption, treatmentGroupsFor, type VisitView,
} from './caseView';
import { daysIn, stayNorm, vitalOn, WARD_VITALS, type WardState, wardState } from '@/engine/shift/ward';
import { staffAge, type StaffPortrait } from '@/render/look';
import { CLINIC, type Doing, type Placement, placements, uniformOfRole } from './clinicMap';
import { type RoomSign, roomSigns } from './roomSigns';
import { achievementsBy, archivedCase, caseKey, type DayRecord, profile, recordCases, recordDay, recordSingle, type SingleBest } from './profile';
import { dateText } from './profileView';
import { challengePassed, SINGLE_CATEGORIES, type SingleCategory, singleResult } from './single';
import { DEATHS, NEEDLESS_ANTIBIOTIC, PNEUMONIA_CAUGHT, QUEUE_LOST, type ScenarioGoal, scenarioResult, WEEK_GRADE, WEEK_SEEN } from './scenario';
import { blockText, type CashView, cashView, examBlockText, levelText, paymentText, personName, problemText, statusText } from './sandboxView';
import { loadSlot, type RawStore, saveSlot } from './saves';
import { settings } from './settings';
import { momentKey, momentOf, type TipMoment, type TipScreen, tipFor } from './tips';

/** Слоты сохранения: практика, песочница и «Смена» — у каждой своё, у кампании — три карьеры. */
export const SLOT = 'shift';
export const SANDBOX_SLOT = 'sandbox';
export const SINGLE_SLOT = 'single';
/** сценарий (часть 91): неделя — в своём слоте, «Смена» её не перезаписывает */
export const SCENARIO_SLOT = 'scenario';
export const CAREERS = [1, 2, 3] as const;
export const slotOf = (m: Mode, career = 1) =>
  (m === 'sandbox' ? SANDBOX_SLOT : m === 'campaign' ? `campaign-${career}` : m === 'single' ? SINGLE_SLOT : m === 'scenario' ? SCENARIO_SLOT : SLOT);
/** Скорость часов на карте — игровых минут в секунду. */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
/** Часы на карте тикают по четыре раза в секунду. */
export const TICK_MS = 250;
/** Автосохранение — не реже раза в игровой час: убитое приложение теряет не больше часа. */
const SAVE_EVERY = 3600;
const LOG_SIZE = 12;

export type LogKind = 'red' | 'arrived' | 'results' | 'left' | 'end' | 'taken';

export interface QueueRow {
  id: string;
  name: string;
  age: string;
  triage: Triage;
  complaint: string;
  waits: string;
  badges: string[];
  /** привезла скорая: смотрят в смотровой приёмного, в кабинет не идёт (часть 27) */
  ambulance?: boolean;
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
  /** пациент нанятого врача — можно открыть его приём и забрать себе (часть 19) */
  colleague?: boolean;
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
  /** нанятые врачи за день (spec 2026-09-hired-doctors): кто, его приёмы одной строкой и списком — к разбору */
  colleagues: { id: string; title: string; line: string; cases: CaseRow[]; portrait?: StaffPortrait }[];
  /** принято нанятыми врачами; прежние строки итогов — ваши приёмы */
  theirs: number;
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
  /** неделя сценария (часть 91): цели и, после пятой смены, итог */
  scenario?: ScenarioView;
  /** стационар за день (spec 2026-09-chapter-2, часть 26): поступили, выписаны, лежат; сроки у выписанных */
  wardLines?: string[];
  /** скорая за день (часть 27): привезли, отсортировали, сверка со шкалой */
  ambulanceLines?: string[];
  /** сроки за день (spec 2026-10-chapter-3, часть 37): у скольких ваших приёмов выполнены */
  targetLines?: string[];
  /** операционная за день (часть 28): операций, в срок и позже, осложнения */
  surgeryLines?: string[];
}

/** Итог «Смены»: оценки по категориям, общая, строки, лучший в этой больнице. */
export interface SingleView {
  venue: string;
  /** «Итог смены · …»; в неделе сценария (часть 91) — за сыгранные смены, после пятой — итог недели */
  title: string;
  grades: { key: SingleCategory; label: string; grade: Grade }[];
  overall?: Grade;
  lines: string[];
  best?: string;
}

/**
 * Где «Смена» — названием больницы; принимали только вы (часть 79) — так и сказано. Лучший результат такой смены —
 * свой: всех новых вы принимали один, сравнивать с днём, когда работали нанятые врачи, нечестно.
 */
const singleName = (s: ShiftState) =>
  `${venueName(s.meta.venue ?? 'preset.clinic')}${s.meta.solo ? T.single.soloSuffix : ''}${s.meta.challenges ? T.challenges.suffix(challengeNames(s.meta.challenges)) : ''}`
  + (s.meta.scenario ? T.scenarios.suffix(T.scenarios.names[s.meta.scenario]) : '');
/** Лучший результат — свой у больницы, «только вы» и набора испытаний (часть 91): с условием сравнивать с обычной сменой нечестно. */
export const bestKey = (s: Pick<ShiftState, 'meta'>) =>
  `${s.meta.venue ?? 'preset.clinic'}${s.meta.solo ? SOLO_BEST : ''}${s.meta.challenges ? `${CHALLENGE_BEST}${s.meta.challenges.join('+')}` : ''}`
  // сценарий (часть 91): лучший итог недели — свой у сценария в каждой больнице
  + (s.meta.scenario ? `${SCENARIO_BEST}${s.meta.scenario}` : '');
const SOLO_BEST = ':solo';
const CHALLENGE_BEST = ':ch=';
const SCENARIO_BEST = ':sc=';
/** Испытания смены названиями: «Нелюдимый врач, Скупой главврач». */
const challengeNames = (list: readonly Challenge[]) => list.map(c => T.challenges.names[c]).join(', ');

/** Лучше ли смена `a`, чем `b`: по общей оценке, затем по баллу и по тому, кого приняли больше, — как `recordSingle`. */
const betterSingle = (a: SingleBest, b: SingleBest) =>
  a.overall !== b.overall ? a.overall < b.overall : a.points !== b.points ? a.points > b.points : a.seen > b.seen;

/**
 * Испытания (часть 91, spec 2026-10-challenges): лучший итог смены с испытанием `c` — в любой больнице и вместе с любыми
 * другими испытаниями — и где он; таких смен ещё не было — undefined.
 */
export function challengeBest(c: Challenge): { best: SingleBest; venue: string } | undefined {
  let out: { best: SingleBest; venue: string } | undefined;
  for (const [key, b] of Object.entries(profile().best)) {
    const at = key.indexOf(CHALLENGE_BEST);
    if (at < 0 || !key.slice(at + CHALLENGE_BEST.length).split('+').includes(c)) continue;
    if (!out || betterSingle(b, out.best)) out = { best: b, venue: venueName(key.slice(0, at).replace(SOLO_BEST, '')) };
  }
  return out;
}

/** Сценарий (часть 91): лучший итог недели в любой больнице и где; недель ещё не было — undefined. */
export function scenarioBest(sc: Scenario): { best: SingleBest; venue: string } | undefined {
  let out: { best: SingleBest; venue: string } | undefined;
  for (const [key, b] of Object.entries(profile().best)) {
    const at = key.indexOf(SCENARIO_BEST);
    if (at < 0 || key.slice(at + SCENARIO_BEST.length) !== sc) continue;
    if (!out || betterSingle(b, out.best)) out = { best: b, venue: venueName(key.slice(0, at)) };
  }
  return out;
}

/** Неделя сценария (часть 91): сыграно смен, цели строками — выполнена ли каждая; после пятой смены — итог. */
export interface ScenarioView {
  id: Scenario;
  name: string;
  /** «Неделя: день 2 из 5» */
  day: string;
  /** неделя закончена: пять смен закрыты */
  final: boolean;
  goals: { text: string; ok: boolean }[];
  /** итог недели: пройден ли сценарий — после пятой смены */
  verdict?: string;
  passed: boolean;
}

function goalText(g: ScenarioGoal): string {
  const t = T.scenarios.goal;
  const n = typeof g.value === 'number' ? g.value : 0;
  if (g.key === 'seen') return t.seen(n, WEEK_SEEN);
  if (g.key === 'pneumonia') return t.pneumonia(n, g.of ?? 0, PNEUMONIA_CAUGHT);
  if (g.key === 'antibiotic') return t.antibiotic(n, g.of ?? 0, NEEDLESS_ANTIBIOTIC);
  if (g.key === 'queue') return t.queue(n, g.of ?? 0, QUEUE_LOST);
  if (g.key === 'deaths') return t.deaths(n, g.of ?? 0, DEATHS);
  return t.overall(String(g.value), WEEK_GRADE);
}

function scenarioView(s: ShiftState): ScenarioView | undefined {
  const r = scenarioResult(db, s);
  const id = s.meta.scenario;
  if (!r || !id) return undefined;
  const final = !s.dayOpen && s.day >= SCENARIO_DAYS;
  return {
    id, name: T.scenarios.names[id], day: T.scenarios.day(Math.min(s.day, SCENARIO_DAYS), SCENARIO_DAYS), final,
    goals: r.goals.map(g => ({ text: goalText(g), ok: g.ok })),
    ...(final ? { verdict: r.passed ? T.scenarios.passed : T.scenarios.failed } : {}),
    passed: r.passed,
  };
}

function singleView(s: ShiftState): SingleView {
  const t = T.single;
  const r = singleResult(s);
  const venue = singleName(s);
  // сценарий (часть 91): итог — за сыгранные смены недели, после пятой — итог недели; лучший итог — недели
  const weekOpen = s.meta.mode === 'scenario' && (s.dayOpen || s.day < SCENARIO_DAYS);
  const title = s.meta.mode !== 'scenario' ? t.resultTitle(venue) : `${weekOpen ? T.scenarios.soFar : T.scenarios.weekTitle} · ${venue}`;
  if (!r) return { venue, title, grades: [], lines: [t.nobody] };
  const b = weekOpen ? undefined : profile().best[bestKey(s)];
  const mine = b && b.seed === s.meta.seed && b.points === r.points && b.seen === r.seen;
  return {
    venue, title,
    grades: SINGLE_CATEGORIES.map(key => ({ key, label: t.category[key], grade: r.grades[key] })),
    overall: r.overall,
    lines: [
      t.seen(r.seen, r.arrived), t.correct(r.correct), t.minutes(r.minutes),
      // испытание (часть 91): пройдено — итог не ниже «B» и не меньше 8 своих пациентов
      ...(s.meta.challenges ? [challengePassed(r) ? T.challenges.passed(r.seen) : T.challenges.failed] : []),
    ],
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
  /** неделя сценария (часть 91): название и «Неделя: день 2 из 5» */
  scenario?: { name: string; day: string };
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
  /** оформляются: регистратура и медсестра (spec 2026-10-clinic-flow) — в очереди врача их ещё нет; по приходу */
  intake: { id: string; name: string; stage: string }[];
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
  /** названия кабинетов специалистов на карте (spec 2026-10-chapter-4, часть 59): «Кабинет гастроэнтеролога» */
  offices?: Record<string, string>;
  /** кто это — для каждого на карте */
  who: Record<string, WhoView>;
  /** песочница: помещения карты смены — по касанию */
  rooms?: Record<string, RoomView>;
  /** что показывает помещение на карте: анализы лаборатории, очередь, «нет персонала» (часть 23) */
  signs: RoomSign[];
  /** пациенты нанятых врачей (spec 2026-09-hired-doctors, часть 19): кто, у кого, что сейчас */
  colleagues: { id: string; name: string; hint: string }[];
  /** сколько лежит в палатах своей больницы — кнопка «Обход» (spec 2026-09-chapter-2, часть 26) */
  inpatients: number;
  /** привезённые скорой, что ждут сортировки врачом (часть 27) */
  ambulance: AmbulanceRow[];
  /** отсортированные, что лежат в смотровой (spec 2026-10-first-measures, часть 95): монитор и первые меры — по касанию */
  bays: AmbulanceRow[];
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
  /** среди них — остановка сердца в смотровой: тревога монитора (FR-AV-1) */
  alarm: boolean;
  /** чей итог показывать: только что закрытый или выбранный в итогах дня */
  focus?: string;
  savedT: number;
  restored: boolean;
  /**
   * время последней команды ещё доживается (0.5.13, `catchUp`): её события — по мере того, как прожиты; у действия врача
   * — чей приём и что сделано, для «За это время», когда время приёма прожито; `clock` — ход часов, его доживает тик
   */
  tail?: { notices: Notice[]; doctor?: { id: string; justDone?: Id }; clock?: boolean };
  /** ваш приём закрывается (0.5.13): разбор не успели посчитать заранее — он досчитывается в кадрах (`finishFrame`) */
  finishing?: string;
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
  if (!s || !['shift', 'sandbox', 'campaign', 'single', 'scenario'].includes(s.meta?.mode) || typeof s.patients !== 'object') return false;
  const has = (table: Record<string, unknown>) => (id: Id) => table[id] !== undefined;
  // «Смена» и неделя сценария (часть 91) — в готовой больнице или своей
  const single = s.meta.mode === 'single' || s.meta.mode === 'scenario';
  if (s.meta.mode === 'campaign' && (!s.campaign || !db.chapters[s.campaign.chapter])) return false;
  if (single && s.meta.venue !== SANDBOX_VENUE && !db.presets[s.meta.venue ?? '']) return false;
  if (s.meta.mode === 'scenario' && !SCENARIOS.includes(s.meta.scenario as Scenario)) return false;
  // своя больница — у песочницы и кампании всегда, у «Смены» — кроме амбулатории практики
  if (s.meta.mode === 'sandbox' || s.meta.mode === 'campaign' || (single && s.hospital)) {
    const h = s.hospital;
    if (!h || (!single && !s.economy) || !Array.isArray(h.rooms)) return false;
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
        // пациенты из сохранений до 0.3.4 — без порогов на измерении: досчитать по их числам (часть 38б);
        // до 0.3.7 — без коронарографии в первые сутки при ОКС: по правилу на их признаках (часть 39в)
        for (const p of Object.values(r.envelope.data.patients)) {
          deriveByValue(db, p.patient.truth.conditions, p.patient.truth.values);
          deriveParams(db, p.patient.truth.conditions, p.patient, p.patient.truth.findings);
          // параметры по другим параметрам (часть 41а) — после всех остальных
          deriveByParams(db, p.patient.truth.conditions);
        }
        session = fresh(r.envelope.data, r.from === 'prev-1' || r.from === 'prev-2');
        // сохранили, пока время команды доживалось (0.5.13), — доживается дальше
        if (session.s.until !== undefined) scheduleCatchUp();
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
  // открыли сохранение посреди дня — что сломалось с утра (FR-EQ-3), в журнале снова первым
  const log = s.dayOpen ? brokenLines(s).map((text, key) => ({ key, t: s.t, kind: 'end' as const, text })) : [];
  return { s, speed: 1, paused: false, log, logSeq: log.length, meanwhile: [], urgent: false, alarm: false, savedT: s.t, restored };
}

export function seasonOf(d: Date): Season {
  const m = d.getMonth(); // 0 — январь
  return m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}

/** Новая практика: день 1, 08:00. Прежнее сохранение перезаписывается. */
/** Новая практика; сложность выбирает игрок, без выбора — «Врач», как было до 0.0.16. */
export function startShift(seed?: number, season?: Season, difficulty: Difficulty = 'doctor') {
  begin(newShift(db, { seed: seed ?? Date.now() % 0x7fffffff, season: season ?? seasonOf(new Date()), difficulty, variety: settings().variety }));
}

export type Budget = 'modest' | 'normal' | 'generous';

/** Новая песочница: участок пустой или с готовой амбулаторией, касса — по бюджету. Прежняя перезаписывается. */
export function startSandbox(opts: { start: 'empty' | 'clinic'; budget: Budget; difficulty: Difficulty; seed?: number; season?: Season }) {
  begin(newSandbox(db, {
    seed: opts.seed ?? Date.now() % 0x7fffffff, season: opts.season ?? seasonOf(new Date()), difficulty: opts.difficulty, start: opts.start,
    budget: db.economy.sandbox.budgets[opts.budget], variety: settings().variety,
  }));
}

/**
 * Новая карьера в слоте `career`: глава 1, её больница и бюджет, письма; `short` — «Главы короче» (часть 93). Прежняя в
 * этом слоте перезаписывается.
 */
export function startCampaign(opts: { career: number; difficulty: Difficulty; short?: boolean; seed?: number; season?: Season }) {
  begin(newCampaign(db, {
    seed: opts.seed ?? Date.now() % 0x7fffffff, season: opts.season ?? seasonOf(new Date()), difficulty: opts.difficulty, career: opts.career, short: opts.short,
  }));
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
  const staffed = staffingOf(db, plan, h.staff);
  return openBlocks(db, plan, workingRooms(db, plan, staffed), staffed);
}

/** Больница в списке «Смены»: можно ли, почему нет, лучший результат в ней. */
export interface VenueView {
  venue: Id;
  name: string;
  ok: boolean;
  hint: string;
  /** в ней работают нанятые врачи — можно выбрать, кто принимает (часть 79) */
  doctors: boolean;
}

/** Есть ли в штате врачи, что принимают пациентов, — терапевты и специалисты в кабинетах. */
const hasDoctors = (staff: readonly StaffMember[]) => staff.some(m => m.room !== undefined && db.roles[m.role]?.stands === DOCTOR);

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
  const out: VenueView[] = [{ venue: 'preset.clinic', name: venueName('preset.clinic'), ok: true, hint: bestHint('preset.clinic', T.single.clinicHint), doctors: false }];
  for (const ch of Object.values(db.chapters)) {
    if (ch.preset === 'preset.clinic' || out.some(v => v.venue === ch.preset)) continue;
    const ok = ch.order <= opened;
    out.push({
      venue: ch.preset, name: venueName(ch.preset), ok, hint: ok ? bestHint(ch.preset, ch.place.ru) : T.single.needChapter(ch.order, ch.name.ru),
      doctors: hasDoctors(presetStaff(db, db.presets[ch.preset])),
    });
  }
  const own = await sandboxHospital();
  const blocks = own ? blocksOf(own) : [];
  out.push({
    venue: SANDBOX_VENUE, name: venueName(SANDBOX_VENUE), ok: !!own && blocks.length === 0,
    hint: !own ? T.single.noSandbox : blocks.length > 0 ? `${T.sandbox.needToOpen} ${blocks.map(b => blockText(db, b)).join(', ')}` : bestHint(SANDBOX_VENUE, T.single.sandboxHint),
    doctors: !!own && hasDoctors(own.staff),
  });
  return out;
}

/**
 * Новая «Смена»: один день в выбранной больнице; своя — копия песочницы. Прежняя смена
 * перезаписывается. Нельзя (больницы нет или смену в ней не открыть) — false.
 */
export async function startSingle(opts: { venue: Id; difficulty: Difficulty; seed?: number; season?: Season; solo?: boolean; challenges?: Challenge[] }): Promise<boolean> {
  let own: { hospital: HospitalState; staff: StaffMember[] } | undefined;
  if (opts.venue === SANDBOX_VENUE) {
    own = await sandboxHospital();
    if (!own || blocksOf(own).length > 0) return false;
  } else if (!db.presets[opts.venue]) return false;
  begin(newSingle(db, {
    seed: (opts.seed ?? Date.now() % 0x7fffffff) >>> 0, season: opts.season ?? seasonOf(new Date()), difficulty: opts.difficulty, venue: opts.venue,
    ...(own ? { hospital: own.hospital, staff: own.staff } : {}), variety: settings().variety, ...(opts.solo ? { solo: true } : {}),
    ...(opts.challenges && opts.challenges.length > 0 ? { challenges: opts.challenges } : {}),
  }));
  return true;
}

/** Типы помещений больницы «Смены»: готовой — по её плану, своей — по песочнице. */
async function venueRooms(venue: Id): Promise<Set<Id>> {
  if (venue === SANDBOX_VENUE) {
    const own = await sandboxHospital();
    return new Set(own ? planOf(db, own.hospital).rooms.map(r => r.type) : []);
  }
  return new Set(hospitalCtx(db, venueState(db, venue)).plan.rooms.map(r => r.type));
}

/**
 * Где можно провести неделю сценария (часть 91, spec 2026-10-scenarios): там же, где «Смену», и где сценарий имеет смысл —
 * «Закрыли соседнюю больницу» — со смотровой приёмного, «Рентген сломался» — с рентген-кабинетом; не подходит — с причиной.
 */
export async function scenarioVenues(sc: Scenario): Promise<VenueView[]> {
  const out: VenueView[] = [];
  for (const v of await singleVenues()) {
    const fits = scenarioFits(sc, await venueRooms(v.venue));
    out.push({ ...v, ok: v.ok && fits, hint: fits ? (v.ok ? '' : v.hint) : T.scenarios.unfit[sc] });
  }
  return out;
}

/** Новая неделя сценария (часть 91): пять смен в выбранной больнице; прежняя неделя перезаписывается. Нельзя — false. */
export async function startScenario(opts: { scenario: Scenario; venue: Id; difficulty: Difficulty; seed?: number; season?: Season }): Promise<boolean> {
  let own: { hospital: HospitalState; staff: StaffMember[] } | undefined;
  if (opts.venue === SANDBOX_VENUE) {
    own = await sandboxHospital();
    if (!own || blocksOf(own).length > 0) return false;
  } else if (!db.presets[opts.venue]) return false;
  if (!scenarioFits(opts.scenario, await venueRooms(opts.venue))) return false;
  begin(newScenario(db, {
    seed: (opts.seed ?? Date.now() % 0x7fffffff) >>> 0, season: opts.season ?? seasonOf(new Date()), difficulty: opts.difficulty, venue: opts.venue,
    scenario: opts.scenario, ...(own ? { hospital: own.hospital, staff: own.staff } : {}), variety: settings().variety,
  }));
  return true;
}

/**
 * Умения врача сейчас (spec 2026-10-skills, часть 75): по опыту специальностей в профиле; настройка выключена — без них.
 * Смене — через команду: новые действуют со следующего дня.
 */
export function playerSkills(): Id[] {
  return settings().skills ? skillsFor(db, profile().experience) : [];
}

const sameIds = (a: readonly Id[], b: readonly Id[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function begin(s: ShiftState) {
  if (session) save(true); // прежняя партия — в свой слот
  // новая игра — с умениями врача сразу: её первый день открывается сейчас; без умений — без команды в журнале
  const skills = playerSkills();
  if (skills.length > 0) apply(db, s, { kind: 'skills', ids: skills, today: true });
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

function run(sess: Session, cmd: Command, more?: () => boolean, clock = false): Notice[] {
  // время прошлой команды ещё доживается (0.5.13) — сначала оно, со своими событиями
  settle(sess);
  // «мягкий режим» из настроек (часть 28б) — в состояние смены раньше команды: ночью по нему решают
  const soft = settings().softMode;
  if ((sess.s.meta.soft ?? false) !== soft) apply(db, sess.s, { kind: 'soft', on: soft });
  // «Больные: разнообразие» (spec 2026-10-variety) — так же; день по нему разыгрывают утром, в
  // кампании его нет
  const variety = settings().variety && sess.s.meta.mode !== 'campaign';
  if ((sess.s.meta.variety ?? false) !== variety) apply(db, sess.s, { kind: 'variety', on: variety });
  // умения врача (spec 2026-10-skills) — так же: выросли или выключены за день — со следующего дня
  const skills = playerSkills();
  if (!sameIds(sess.s.meta.skillsNext ?? sess.s.meta.skills ?? [], skills)) apply(db, sess.s, { kind: 'skills', ids: skills });
  // «свои больные» (spec 2026-10-own-patients, часть 76) — сразу: следующего нового врач уже оставит вам
  const mine = settings().mine;
  if (!sameIds(sess.s.meta.mine ?? [], mine)) apply(db, sess.s, { kind: 'mine', systems: mine });
  const notices = apply(db, sess.s, cmd, more);
  record(sess, notices);
  if (sess.s.t - sess.savedT >= SAVE_EVERY) save();
  sess.tail = sess.s.until !== undefined ? { notices: [...notices], ...(clock ? { clock } : {}) } : undefined;
  if (sess.tail && !clock) scheduleCatchUp();
  return notices;
}

// --- время команды по частям (0.5.13, NFR-PRF-1; spec 2026-10-parts) -------------------------------

/** Время команды — по частям: включает игра (`timeInParts`); тесты сессии живут, как прежде, сразу. */
let inParts = false;
/** Сколько миллисекунд за раз доживать время команды — в кадре и в тике, как срезы тика с 0.5.11. */
const PART_MS = 40;
let partMs = PART_MS;
export function timeInParts(on = true, ms = PART_MS) {
  inParts = on;
  partMs = ms;
}

/** Счёт до `ms` миллисекунд от сейчас; `first` — одно событие всегда, чтобы время шло и без запаса (кадр, тик). */
function budget(ms: number, first = false): () => boolean {
  const end = performance.now() + ms;
  let once = first;
  return () => {
    if (!once) return performance.now() <= end;
    once = false;
    return true;
  };
}

/** Сколько можно считать в команде игрока: она возвращается сразу, остальное — в кадрах; не по частям — всё сразу. */
const partBudget = () => (inParts ? budget(partMs) : undefined);

/** Сессия, где прошлая команда прожита целиком: действие игрока видит больницу такой же, как прежде. */
function live(): Session | null {
  const sess = session;
  if (sess) settle(sess);
  return sess;
}

/** Дожить время прошлой команды — всё сразу. */
function settle(sess: Session) {
  if (sess.s.until !== undefined) absorb(sess, catchUp(db, sess.s));
}

/** События дожитого — в журнал смены и в команду; прожито всё — «За это время» после действия врача. */
function absorb(sess: Session, notices: Notice[]) {
  record(sess, notices);
  const tail = sess.tail;
  if (!tail) return;
  tail.notices.push(...notices);
  if (sess.s.until !== undefined) return;
  sess.tail = undefined;
  const p = tail.doctor ? sess.s.patients[tail.doctor.id] : undefined;
  if (!p || sess.s.current !== p.id) return;
  sess.meanwhile = meanwhileOf(sess.s, p, tail.notices, tail.doctor?.justDone);
  sess.urgent = urgentIn(tail.notices);
  sess.alarm = alarmIn(tail.notices);
}

const urgentIn = (notices: Notice[]) => notices.some(n => (n.kind === 'arrived' && n.triage === 'red') || n.kind === 'ambulance');
/** Тревога монитора: остановка сердца в смотровой (0.5.7), а с частью 95 — «хуже» без первой меры и код синий. */
export const alarmIn = (notices: readonly Notice[]) => notices.some(n => n.kind === 'arrest' || n.kind === 'worse' || n.kind === 'code');

/**
 * Что стало хуже — для сигнала (часть 95): числа монитора, которые сдвигает ступень нужды, и что эта ступень добавила
 * (спутанность, у глюкозы — оглушение, кома, судороги).
 */
function worseText(s: ShiftState, p: ShiftPatient, measure: Id, step: number): string {
  const t = T.shift.ambulance;
  const m = db.measures[measure];
  const v = bayVitals(db, s, p);
  const label: Record<Id, (x: number) => string> = { 'vital.spo2_low': t.spo2, 'vital.bp_low': t.bp, 'vital.tachycardia': t.pulse, 'vital.tachypnea': t.breath };
  const parts = Object.keys(m?.steps[0]?.change ?? {})
    .filter(f => label[f] && v.values[valueKey(db, f)] !== undefined)
    .map(f => label[f](Math.round(v.values[valueKey(db, f)])));
  for (const f of m?.steps[step - 1]?.add ?? []) parts.push(lowerFirst(db.findings[f]?.name.ru ?? f));
  return parts.join(', ');
}

let frameQueued = false;
function nextFrame(f: () => void) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(f);
  else setTimeout(f, 0);
}

/** Дожить время действия игрока в следующих кадрах — по `partMs` за кадр; ход часов доживает тик. */
function scheduleCatchUp() {
  if (frameQueued || !inParts) return;
  frameQueued = true;
  nextFrame(catchUpFrame);
}

function catchUpFrame() {
  frameQueued = false;
  const sess = session;
  if (!sess || sess.s.until === undefined || sess.tail?.clock) return;
  absorb(sess, catchUp(db, sess.s, budget(partMs, true)));
  if (sess.s.until !== undefined) scheduleCatchUp();
  else changed();
}

function dayStart(s: ShiftState) {
  return (s.day - 1) * DAY;
}

function allDone(s: ShiftState) {
  return s.t >= dayStart(s) + SHIFT_END && s.queue.length === 0 && !s.current
    && !Object.values(s.patients).some(p => p.status === 'away' || p.status === 'coming' || p.status === 'intake' || (p.by !== undefined && (p.status === 'inRoom' || p.status === 'waiting'))
      // привезённый скорой ждёт сортировки — в очереди его ещё нет (часть 27)
      || (p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted));
}

/**
 * Время на карте: идёт, пока в кабинете никого. Пришёл «красный» или вернулся с
 * результатами — пауза, если она не выключена в настройках. Отдаёт случившееся — для звука.
 */
export function tick(ms: number = TICK_MS): Notice[] {
  const sess = session;
  if (!sess || sess.paused || !sess.s.dayOpen || sess.s.current || allDone(sess.s)) return [];
  // по срезам и не дольше `TICK_BUDGET_MS` (0.5.11, NFR-PRF-1): много работы у нанятых врачей — остаток тика пропускается,
  // часы идут чуть медленнее, а экран не замирает; события те же — время проматывается по ним. По частям (0.5.13) — и
  // срез: не прожит за тик — доживается в следующем, а сначала — недожитое; его события — тоже этого тика, если это
  // ход часов
  const total = Math.round((ms / 1000) * sess.speed * 60);
  const more = budget(inParts ? partMs : TICK_BUDGET_MS, true);
  const part = inParts ? more : undefined;
  const notices: Notice[] = [];
  const { pauseOnRed, pauseOnResults } = settings();
  const redOf = (ns: Notice[]) => (pauseOnRed ? ns.find(n => (n.kind === 'arrived' && n.triage === 'red') || n.kind === 'ambulance' || n.kind === 'worse' || n.kind === 'code' || n.kind === 'died') : undefined);
  const backOf = (ns: Notice[]) => (pauseOnResults ? ns.find(n => n.kind === 'resultsReady' && sess.s.patients[n.id].status === 'waiting') : undefined);
  if (sess.s.until !== undefined) {
    const clock = sess.tail?.clock;
    const n = catchUp(db, sess.s, part);
    absorb(sess, n);
    if (clock) notices.push(...n);
  }
  // автопауза — в том срезе, где пришёл срочный или вернулся с результатами (0.5.14): часы не уходят дальше до конца тика
  for (let done = 0; sess.s.until === undefined && done < total && !redOf(notices) && !backOf(notices) && more(); ) {
    const step = Math.min(TICK_SLICE, total - done);
    notices.push(...run(sess, { kind: 'advance', seconds: step }, part, true));
    done += step;
  }
  const red = redOf(notices);
  const back = backOf(notices);
  if (red && red.kind === 'ambulance') pause(sess, T.shift.pause.ambulance(nameOf(sess.s.patients[red.id])));
  else if (red && red.kind === 'arrived') pause(sess, T.shift.pause.red(nameOf(sess.s.patients[red.id])));
  // первые меры (часть 95): хуже без меры, код синий, смерть в смотровой
  else if (red && red.kind === 'worse') pause(sess, T.shift.pause.worse(nameOf(sess.s.patients[red.id]), worseText(sess.s, sess.s.patients[red.id], red.measure, red.step)));
  else if (red && red.kind === 'code') pause(sess, T.shift.pause.code(nameOf(sess.s.patients[red.id])));
  else if (red && red.kind === 'died') pause(sess, T.shift.pause.died(nameOf(sess.s.patients[red.id]), female(sess.s.patients[red.id]), red.soft === true));
  else if (back && back.kind === 'resultsReady') pause(sess, T.shift.pause.results(nameOf(sess.s.patients[back.id])));
  changed();
  return notices;
}

/** Игровых секунд в срезе тика (0.5.11): на ×4 тик — 60 секунд, четыре среза. */
const TICK_SLICE = 15;
/** Дольше этого тик срезов не добавляет (0.5.11, NFR-PRF-1): кадр на телефоне — 16 мс, подвисание — от 100. */
const TICK_BUDGET_MS = 40;

/** Сколько миллисекунд за раз считать разбор заранее (0.5.11, NFR-PRF-1). */
const PREPARE_MS = 8;

/**
 * Посчитать заранее разбор того, кто у вас в кабинете, а затем приёмов нанятых врачей и ждущих в очереди
 * (`prepareReview`), — по шагу, пока не кончится `budget`: экраны смены зовут это в паузах игры, и закрытие приёма не
 * ждёт разумного врача разбора. Состояния не меняет.
 */
export function prepareIdle(budget: number = PREPARE_MS) {
  const sess = session;
  if (!sess || !sess.s.dayOpen) return;
  const t0 = performance.now();
  while (prepareReview(db, sess.s) && performance.now() - t0 < budget) {
    // шаг за шагом: один шаг на телефоне может быть дольше бюджета — тогда один
  }
}

/** Как часто считать разбор заранее, пока смена на экране (0.5.11). */
const PREPARE_EVERY_MS = 100;

/** Сколько экранов смены просят считать заранее; счёт один на всех. */
let preparing = 0;
let prepareTimer: ReturnType<typeof setInterval> | null = null;

/** Пока экран смены на виду — считать разбор заранее (`prepareIdle`); экранов несколько — счёт один. */
export function usePrepareIdle() {
  useEffect(() => {
    if (preparing++ === 0) prepareTimer = setInterval(() => prepareIdle(), PREPARE_EVERY_MS);
    return () => {
      if (--preparing === 0 && prepareTimer) {
        clearInterval(prepareTimer);
        prepareTimer = null;
      }
    };
  }, []);
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
  const sess = live();
  if (!sess || !sess.s.dayOpen || sess.s.current || sess.s.queue.length > 0 || allDone(sess.s)) return [];
  // привезённого скорой ждёт сортировка — мимо него часы не проматываем (часть 27)
  if (Object.values(sess.s.patients).some(p => p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted)) return [];
  const out: Notice[] = [];
  for (let spent = 0; spent < SKIP_MAX && !allDone(sess.s); spent += 60) {
    const notices = run(sess, { kind: 'advance', seconds: 60 });
    out.push(...notices);
    if (sess.s.queue.length > 0 || notices.some(n => n.kind === 'shiftEnd' || n.kind === 'ambulance' || n.kind === 'worse' || n.kind === 'code' || n.kind === 'died')) break;
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
  const sess = live();
  if (!sess || sess.s.current || sess.s.patients[id]?.status !== 'waiting') return false;
  run(sess, { kind: 'call', id }, partBudget());
  sess.meanwhile = [];
  sess.urgent = false;
  sess.alarm = false;
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
  const sess = live();
  const p = sess && current(sess.s);
  if (!sess || !p || sess.finishing) return;
  const notices = run(sess, cmd, partBudget());
  if (sess.tail) {
    // время приёма ещё доживается (0.5.13): «За это время» — когда прожито
    sess.tail.doctor = { id: p.id, ...(justDone ? { justDone } : {}) };
    sess.meanwhile = [];
    sess.urgent = false;
    sess.alarm = false;
  } else {
    sess.meanwhile = meanwhileOf(sess.s, p, notices, justDone);
    sess.urgent = urgentIn(notices);
    sess.alarm = alarmIn(notices);
  }
  changed();
}

export function examine(exam: Id) {
  doctor({ kind: 'exam', exam }, exam);
}

/**
 * Бланк направления (0.6.0, вопрос 45): отмеченное — разом, как касаниями по одному, и время — целиком: назначения
 * короткие. С 0.6.9 (spec 2026-10-clinic-flow) — сначала то, что делают при враче (мазок, глюкометр), потом — по
 * направлениям, в порядке бланка: иначе врач ждал бы, пока пациент сдаст кровь, чтобы взять мазок. «За это время» и
 * тревога — за всё отправленное, а не только за последнее.
 */
export function examineAll(exams: readonly Id[]) {
  const sess = live();
  const p = sess && current(sess.s);
  if (!sess || !p || sess.finishing || exams.length === 0) return;
  const out = new Set(exams.filter(e => atDoctor(db, sess.s, p, e) === false));
  const order = [...exams.filter(e => !out.has(e)), ...exams.filter(e => out.has(e))];
  const notices = order.flatMap(exam => run(sess, { kind: 'exam', exam }));
  sess.meanwhile = meanwhileOf(sess.s, p, notices, order[order.length - 1]);
  sess.urgent = urgentIn(notices);
  sess.alarm = alarmIn(notices);
  changed();
}

export function waitForResults() {
  doctor({ kind: 'waitResults' });
}

export function sendAway() {
  const sess = live();
  if (!sess || !current(sess.s) || sess.finishing) return;
  run(sess, { kind: 'sendAway' }, partBudget());
  sess.meanwhile = [];
  sess.urgent = false;
  sess.alarm = false;
  save();
  changed();
}

function draft(cmd: Command) {
  const sess = live();
  if (!sess || !current(sess.s) || sess.finishing) return;
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

/** Дифференциальный ряд (spec 2026-10-differential): добавить гипотезу или убрать её. */
export function toggleHypothesis(id: Id) {
  draft({ kind: 'hypothesis', id });
}

/**
 * Завершить приём: случай закрыт, его итог — на экране итога (фокус). Разбор не успели посчитать заранее (0.5.13,
 * NFR-PRF-1) — он досчитывается в следующих кадрах, по `partMs` за кадр, а приём закрывается, когда разбор готов; экран
 * итога пока — «Закрываем приём».
 */
export function finishCase() {
  const sess = live();
  const p = sess && current(sess.s);
  if (!sess || !p || !p.draft.diagnosis || sess.finishing) return;
  if (inParts && !prepareFinish(db, sess.s, budget(partMs))) {
    sess.finishing = p.id;
    nextFrame(finishFrame);
    changed();
    return;
  }
  closeVisit(sess, p);
}

function closeVisit(sess: Session, p: ShiftPatient) {
  run(sess, { kind: 'finish' }, partBudget());
  recordCases(closedCases(sess.s));
  sess.focus = p.id;
  sess.meanwhile = [];
  sess.urgent = false;
  sess.alarm = false;
  save();
  changed();
}

/** Кадр закрытия приёма (0.5.13): разбор — по `partMs`; готов — приём закрыт. */
function finishFrame() {
  const sess = session;
  const id = sess?.finishing;
  if (!sess || id === undefined) return;
  const p = sess.s.patients[id];
  if (sess.s.current !== id || !p?.draft.diagnosis) {
    sess.finishing = undefined;
    changed();
    return;
  }
  if (!prepareFinish(db, sess.s, budget(partMs, true))) {
    nextFrame(finishFrame);
    return;
  }
  sess.finishing = undefined;
  closeVisit(sess, p);
}

/** Открыть итог и разбор закрытого случая — из итогов дня. */
export function openCase(id: string) {
  if (!session?.s.patients[id]?.closed) return;
  session.focus = id;
  changed();
}

/** Открыть приём нанятого врача — карта только для чтения (spec 2026-09-hired-doctors, часть 19). */
export function openColleagueCase(id: string) {
  const p = session?.s.patients[id];
  if (!session || !p?.by || p.closed) return;
  session.focus = id;
  changed();
}

/** Забрать себе пациента нанятого врача: вы свободны — он сразу у вас в кабинете (`true`). */
export function takeOver(id: string): boolean {
  const sess = live();
  const p = sess?.s.patients[id];
  // уже не у врача (забрали касанием раньше, приём закрыт) — ничего не делаем
  if (!sess?.s.dayOpen || !p?.by || p.closed) return !!sess && sess.s.current === id;
  sess.focus = undefined;
  run(sess, { kind: 'takeOver', id });
  if (!p.by && sess.s.current !== id) {
    sess.log.unshift({ key: sess.logSeq++, t: sess.s.t, kind: 'taken', text: T.shift.colleagueCase.taken(nameOf(p), p.status === 'away') });
    sess.log.length = Math.min(sess.log.length, LOG_SIZE);
  }
  save();
  changed();
  return sess.s.current === id;
}

/** Нанятый врач словами: «терапевт Иванова Елена»; уволен — просто «врач». */
function doctorOfCase(s: ShiftState, by: string): string {
  const m = s.staff?.find(x => x.id === by);
  return m ? T.shift.colleagueCase.doctor(lowerFirst(db.roles[m.role]?.name.ru ?? ''), personName(m.sex, m.seed)) : T.shift.colleagueCase.someone;
}

/** Приём нанятого врача: кто ведёт — строкой и портретом (0.5.7); ушёл на обследования — «away». */
function colleagueOf(s: ShiftState, p: ShiftPatient): { id: string; doctor: string; away?: boolean; portrait?: StaffPortrait } {
  const m = s.staff?.find(x => x.id === p.by);
  return { id: p.id, doctor: doctorOfCase(s, p.by!), ...(p.status === 'away' ? { away: true } : {}), ...(m ? { portrait: portraitOf(m) } : {}) };
}

/** Кто вёл закрытый приём — для экрана итога: глагол по полу врача; уволен — без имени. */
function byDoctorLine(s: ShiftState, by: string): string {
  const m = s.staff?.find(x => x.id === by);
  return m ? T.spikes.patient.byDoctor(doctorOfCase(s, by), m.sex === 'f') : T.spikes.patient.byGone;
}

export function leaveCase() {
  if (!session || session.focus === undefined) return;
  session.focus = undefined;
  changed();
}

export function closeDay() {
  const sess = live();
  if (!sess || !sess.s.dayOpen) return;
  run(sess, { kind: 'closeDay' });
  // ночью умерший после операции (часть 28б) — в архиве профиля его приём с исходом
  recordCases(closedCases(sess.s));
  recordDay(dayRecord(sess.s));
  // «Смена»: лучший результат в этой больнице — в профиль; сценарий (часть 91) — итог недели, после пятой смены
  const week = sess.s.meta.mode === 'scenario' && sess.s.day >= SCENARIO_DAYS;
  const r = sess.s.meta.mode === 'single' || week ? singleResult(sess.s) : undefined;
  if (r) recordSingle(bestKey(sess.s), { points: r.points, overall: r.overall, seen: r.seen, arrived: r.arrived, seed: sess.s.meta.seed });
  sess.focus = undefined;
  sess.meanwhile = [];
  sess.urgent = false;
  sess.alarm = false;
  save();
  changed();
}

export function nextDay() {
  const sess = live();
  if (!sess || sess.s.dayOpen) return;
  // песочница: без регистратуры, зоны ожидания и кабинета смену не открыть — движок не откроет
  run(sess, { kind: 'nextDay' });
  if (!sess.s.dayOpen) {
    changed();
    return;
  }
  // с утра сломался аппарат (FR-EQ-3) — первой строкой журнала дня
  sess.log = brokenLines(sess.s).map(text => ({ key: sess.logSeq++, t: sess.s.t, kind: 'end', text }));
  sess.focus = undefined;
  sess.paused = false;
  sess.pauseReason = undefined;
  save();
  changed();
}

/** Что сломалось с утра (FR-EQ-3): «Не работает: рентгеновский аппарат (рентген-кабинет) — починят к завтра». */
function brokenLines(s: ShiftState): string[] {
  if (!s.broken || s.broken.length === 0) return [];
  const ctx = hospitalCtx(db, s);
  const names = roomNames(ctx.plan.rooms);
  return s.broken.map(k => {
    const [room, slot] = k.split(':');
    const id = ctx.plan.rooms.find(r => r.id === room)?.equipment[Number(slot)];
    // «Рентген сломался» (часть 91): рентген — до конца недели
    if (id && s.meta.scenario === 'xray' && isXray(id)) return T.scenarios.brokenWeek(lowerFirst(db.equipment[id].name.ru), lowerFirst(names[room] ?? ''));
    return T.shift.notice.broken(id ? db.equipment[id].name.ru : '', names[room] ?? '');
  });
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
    // испытания «Смены» (часть 91): пройдены — все испытания дня
    ...(s.meta.mode === 'single' && s.meta.challenges && challengePassed(singleResult(s)) ? { challenges: [...s.meta.challenges] } : {}),
    // сценарий (часть 91): неделя закончена и цели выполнены
    ...(s.meta.mode === 'scenario' && s.meta.scenario && scenarioResult(db, s)?.passed ? { scenario: s.meta.scenario } : {}),
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
  /** назначен, но не работает: нет места в ординаторской (spec 2026-09-hired-doctors) */
  problem?: string;
  portrait: StaffPortrait;
}

/** Место в помещении, где нужен человек: занято ли и кем. */
export interface PostView {
  room: string;
  roomName: string;
  role: Id;
  roleName: string;
  /** кого можно назначить: на место врача — терапевта и специалистов (spec 2026-10-chapter-4, часть 59) */
  roles: Id[];
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

/** Названия помещений больницы: одинаковых несколько — с номером, «Кабинет врача № 2». */
function roomNames(rooms: readonly { id: string; type: Id }[]): Record<string, string> {
  const count: Record<string, number> = {};
  const seen: Record<string, number> = {};
  for (const r of rooms) count[r.type] = (count[r.type] ?? 0) + 1;
  return Object.fromEntries(rooms.map(r => {
    seen[r.type] = (seen[r.type] ?? 0) + 1;
    const name = db.rooms[r.type]?.name.ru ?? r.type;
    return [r.id, count[r.type] > 1 ? T.sandbox.roomN(name, seen[r.type]) : name];
  }));
}

/** Портрет сотрудника (FR-AV-4, 0.5.7): с навыком и местом работы не меняется — кандидат и нанятый на одно лицо. */
const portraitOf = (m: StaffMember): StaffPortrait => ({ seed: m.seed, sex: m.sex, age: staffAge(m.seed, m.trait), uniform: uniformOfRole(m.role) });

function personOf(m: StaffMember, names: Record<string, string>, problem?: string): PersonView {
  return {
    id: m.id, name: personName(m.sex, m.seed), role: m.role, roleName: db.roles[m.role]?.name.ru ?? m.role, skill: m.skill,
    ...(m.trait ? { trait: T.sandbox.traits[m.trait] } : {}), salary: m.salary,
    ...(m.room && names[m.room] ? { room: m.room, roomName: names[m.room] } : {}),
    ...(problem ? { problem } : {}),
    portrait: portraitOf(m),
  };
}

function buildStaffView(): StaffView | undefined {
  const s = session?.s;
  if (!s?.hospital || !s.staff) return undefined;
  const staff = s.staff;
  const ctx = hospitalCtx(db, s);
  const mine = doctorRoom(ctx.plan);
  const names = roomNames(s.hospital.rooms);
  // место врача в другом кабинете — для нанятого врача (терапевта или специалиста, часть 59); в вашем кабинете врач — вы
  const posts: PostView[] = s.hospital.rooms.flatMap(r => db.rooms[r.type].staff.flatMap(role => {
    const post = db.roles[role]?.hire ? role : r.id !== mine ? standInOf(db, role) : undefined;
    if (!post) return [];
    const roles = db.roles[role]?.hire ? [role] : standInsOf(db, role);
    const m = staff.find(x => x.room === r.id && roles.includes(x.role));
    const roleName = roles.length > 1 ? T.sandbox.doctorPost(db.roles[post].name.ru) : db.roles[post].name.ru;
    return [{ room: r.id, roomName: names[r.id], role: post, roleName, roles, ...(m ? { who: m.id } : {}) }];
  }));
  const problem = (m: StaffMember) => {
    const needs = db.roles[m.role]?.needs;
    return needs && m.room && ctx.staffed.unplaced?.(m.room) ? T.sandbox.problem.noPlace(db.rooms[needs]?.gen.ru ?? needs) : undefined;
  };
  return {
    version, staff: staff.map(m => personOf(m, names, problem(m))), candidates: (s.candidates ?? []).map(m => personOf(m, names)), posts,
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
    // принимаете только вы (часть 79): нанятых врачей в этот день на карте нет — их кабинеты пусты
    const off = (m: StaffMember) => s.meta.solo === true && db.roles[m.role]?.stands === DOCTOR;
    l = layoutOf(cropPlan(ctx.plan), ctx.staff.flatMap(m => (m.room && !off(m) ? [{ room: m.room, role: m.role, stands: db.roles[m.role]?.stands }] : [])));
    layouts.set(ctx, l);
  }
  return l;
}

// обследования, которых в этой больнице не сделать, — и почему: в своей и в амбулатории практики; сломанные с утра
// аппараты (FR-EQ-3) — свои на каждый день
const blocked = new WeakMap<HospitalCtx, Map<string, Record<Id, string>>>();

function unavailableOf(s: ShiftState): Record<Id, string> {
  const ctx = hospitalCtx(db, s);
  const key = (s.broken ?? []).join(',');
  let byDay = blocked.get(ctx);
  if (!byDay) {
    byDay = new Map();
    blocked.set(ctx, byDay);
  }
  let out = byDay.get(key);
  if (!out) {
    out = {};
    const broken = brokenOf(s);
    for (const id of Object.keys(db.exams)) {
      const w = examWhere(db, ctx.plan, ctx.working, ctx.staffed, id, broken);
      if (!('block' in w)) continue;
      // «Рентген сломался» (часть 91): снимков нет до конца недели
      const b = w.block;
      out[id] = s.meta.scenario === 'xray' && b.kind === 'broken' && b.equipment.some(isXray) ? T.scenarios.brokenExam(lowerFirst(db.equipment[b.equipment[0]]?.name.ru ?? '')) : examBlockText(db, b);
    }
    byDay.set(key, out);
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
  const staffed = staffingOf(db, plan, s.staff ?? []);
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
  /** кампания с «Главы короче» (часть 93) */
  short?: true;
  /** «Смена»: в какой больнице — названием */
  venue?: string;
}

/** Обе партии с диска, последняя записанная — первой. Живая партия сначала записывается. */
export async function savedGames(): Promise<GameSummary[]> {
  const st = store;
  if (!st) return [];
  await saved();
  const out: GameSummary[] = [];
  const slots: [Mode, number][] = [['shift', 1], ['sandbox', 1], ['single', 1], ['scenario', 1], ...CAREERS.map(c => ['campaign', c] as [Mode, number])];
  for (const [m, c] of slots) {
    const r = await loadSlot<ShiftState>(st, slotOf(m, c), e => fits(e, m, c)).catch(() => null);
    if (!r) continue;
    const s = r.envelope.data;
    const ch = s.campaign ? db.chapters[s.campaign.chapter] : undefined;
    const mains = ch ? missionsOf(ch, s.meta.shortChapters).filter(x => x.main) : [];
    out.push({
      // у карьеры — день главы: во второй главе счёт с её начала (spec 2026-09-chapter-2, часть 34)
      mode: m, savedAt: r.envelope.savedAt, day: s.day - (s.campaign?.since ?? 0), clock: hhmm(minuteOfDay(s.t)), difficulty: s.meta.difficulty ?? 'doctor',
      ...(s.economy ? { cash: s.economy.cash } : {}),
      ...(ch && s.campaign ? { career: c, chapter: ch.id, mains: { done: mains.filter(x => s.campaign!.done[x.id] !== undefined).length, of: mains.length } } : {}),
      ...(ch && s.meta.shortChapters ? { short: true as const } : {}),
      ...(m === 'single' || m === 'scenario' ? { venue: singleName(s) } : {}),
    });
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

/** После какой главы кампании открывается песочница (09-game-design.md §10; решение владельца 15.10.2026, вопрос 12). */
export const SANDBOX_AFTER: Id = 'chapter.hospital';

/**
 * Закрыта ли песочница (spec 2026-10-rules, часть 72): открыта, если глава 2 выполнена — её достижение в профиле, — или
 * какая-нибудь карьера уже дальше неё, или песочница уже начата: начатую не закрываем. Закрыта — какая глава её откроет.
 */
export function sandboxLock(games: readonly GameSummary[], got: Readonly<Record<Id, unknown>>): { order: number; name: string } | undefined {
  const after = db.chapters[SANDBOX_AFTER];
  if (!after || games.some(g => g.mode === 'sandbox')) return undefined;
  if (games.some(g => g.mode === 'campaign' && g.chapter && (db.chapters[g.chapter]?.order ?? 0) > after.order)) return undefined;
  if (Object.values(db.achievements).some(a => a.kind === 'chapter' && a.chapter === SANDBOX_AFTER && got[a.id] !== undefined)) return undefined;
  return { order: after.order, name: after.name.ru };
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

/**
 * Следующая глава, когда эта выполнена (spec 2026-09-chapter-2, часть 34): кнопка перехода, лист
 * подтверждения; перейти можно между сменами.
 */
export interface NextChapterView {
  title: string;
  /** кнопка: «Перейти в районную больницу» */
  move: string;
  place: string;
  /** что останется и что будет новым — в листе подтверждения */
  text: string;
  ready: boolean;
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
  /** выполнена: что дальше — следующая глава или «в следующей версии» */
  after?: string;
  next?: NextChapterView;
}

/** Ход задания словами: принято и точность, дни, скорая, операции, выписанные подряд. */
function missionText(m: Mission, p: MissionProgress): string {
  const t = T.campaign;
  switch (m.kind) {
    case 'seen':
      return t.seenProgress(p.value, p.target, p.accuracy ?? 0);
    case 'roomWorks':
      return t.notYet;
    case 'triage':
      return t.triageProgress(p.value, p.target);
    case 'operations':
      return t.operationsProgress(p.value, p.target);
    case 'stay':
      return t.stayProgress(p.value, p.target, p.stay ? { days: Math.round(p.stay.days * 10) / 10, norm: Math.round(p.stay.norm * 10) / 10 } : undefined);
    case 'streak':
    case 'days':
      return t.dayProgress(p.value, p.target);
    // глава 3 (spec 2026-10-chapter-3, часть 45а)
    case 'deadline':
      return t.deadlineProgress(p.value, p.target);
    case 'thrombolysis':
      return t.lysisProgress(p.value, p.target);
    // глава 4 (spec 2026-10-chapter-4, часть 60а)
    case 'staff':
      return t.staffProgress(p.value, p.target, p.accuracy ?? 0, p.doctors ?? 0, m.doctors);
    case 'mortality':
      return t.mortalityProgress(p.value, p.target, p.mortality, m.lying);
  }
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
  const cv = { campaign: c, history: s.history, hospital: s.hospital, staff: s.staff, short: s.meta.shortChapters === true };
  const missions = missionsOf(ch, cv.short).map(m => {
    const p = missionProgress(db, cv, m);
    const done = c.done[m.id];
    return {
      id: m.id, text: m.text.ru, main: m.main,
      progress: done !== undefined ? t.doneOn(done - c.since) : missionText(m, p),
      ...(done !== undefined ? { done: done - c.since } : {}),
    };
  });
  const complete = c.complete !== undefined;
  const next = complete ? nextChapterOf(db, c) : undefined;
  return {
    version, title: t.chapter(ch.order, ch.name.ru), place: ch.place.ru, day: s.day - c.since, letters, missions, complete,
    ...(complete ? { after: next ? t.completeNext : t.completeLast } : {}),
    ...(next ? {
      next: {
        // глава с крылом (часть 45а) — та же больница; при переезде лежащих долечат врачи прежней (spec 2026-10-chapter-4,
        // часть 61б): выписки ждать не нужно
        title: t.chapter(next.order, next.name.ru), move: next.move?.ru ?? t.moveTo(next.order), place: next.place.ru,
        text: next.wing ? t.moveWingText(T.common.rub(next.budget)) : t.moveText(ch.place.ru, Object.values(s.patients).filter(p => p.status === 'admitted').length),
        ready: !s.dayOpen,
      },
    } : {}),
  };
}

let campaignCache: { version: number; view: CampaignView | undefined } | null = null;

export function campaignView(): CampaignView | undefined {
  if (campaignCache?.version !== version) campaignCache = { version, view: buildCampaignView() };
  return campaignCache.view;
}

export function useCampaign(): CampaignView | undefined {
  return useSyncExternalStore(subscribe, campaignView, campaignView);
}

/**
 * «Перейти в районную больницу» (spec 2026-09-chapter-2, часть 34): глава выполнена, день закрыт —
 * карьера идёт в следующей главе. Движок не перейдёт раньше — тогда ничего не меняется.
 */
export function moveToNextChapter() {
  const sess = session;
  if (!sess || sess.s.meta.mode !== 'campaign' || sess.s.dayOpen) return;
  const was = sess.s.campaign?.chapter;
  run(sess, { kind: 'nextChapter' });
  if (sess.s.campaign?.chapter === was) return;
  sess.focus = undefined;
  save();
  changed();
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

/**
 * Приём сейчас — только в первую смену главы с обучением (до «Открыть смену» следующего дня), а
 * обход — и утром после неё: лежат те, кого положили в первую смену (часть 34б). На экране смены
 * момент — привезённый скорой, который ждёт сортировки; на обходе — первый лежащий.
 */
function tipMoment(screen: TipScreen): TipMoment | undefined {
  const s = session?.s;
  const c = s?.campaign;
  const ch = c ? db.chapters[c.chapter] : undefined;
  if (!s || !c || !ch || ch.tutorial.length === 0) return undefined;
  // смена с обучением — первый день главы; у главы с помещением обучения (часть 45б) — первый с ним
  const first = tutorialDayOf(ch, c);
  if (first === undefined || !(s.day === first || (screen === 'rounds' && s.day === first + 1))) return undefined;
  const id = screen === 'review'
    ? (session?.focus ?? s.current)
    : screen === 'queue'
      ? (s.current ? undefined : Object.values(s.patients).find(p => p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted)?.id)
      : screen === 'rounds'
        ? inpatientsOf(s)[0]?.id
        : s.current;
  const p = id ? s.patients[id] : undefined;
  return p ? momentOf(db, screen, p) : undefined;
}

function buildTipView(screen: TipScreen): TipView | undefined {
  const c = session?.s.campaign;
  const m = tipMoment(screen);
  if (!c || !m) return undefined;
  const st = c.tips ?? { shown: [] };
  const tip = tipFor(db, st, m, tipHold, c.chapter);
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
    else if (n.kind === 'ambulance' && p) item('red', T.shift.notice.ambulance(nameOf(p), complaintOf(p)));
    else if (n.kind === 'arrest' && p) item('red', T.shift.notice.arrest(nameOf(p)));
    else if (n.kind === 'worse' && p) item('red', T.shift.notice.worse(nameOf(p), worseText(s, p, n.measure, n.step)));
    else if (n.kind === 'code' && p) item('red', T.shift.notice.code(nameOf(p)));
    else if (n.kind === 'died' && p) item('red', T.shift.notice.died(nameOf(p), female(p), n.soft === true));
    else if (n.kind === 'shiftEnd') item('end', T.shift.notice.end);
  }
  sess.log.length = Math.min(sess.log.length, LOG_SIZE);
}

/**
 * «За это время» в карте пациента: остановка сердца в смотровой — первой, она и звучит тревогой монитора (0.5.7);
 * затем срочный (spec, «Неудачные случаи»), результаты этого пациента, остальная очередь.
 */
function meanwhileOf(s: ShiftState, p: ShiftPatient, notices: Notice[], justDone?: Id): string[] {
  const out: string[] = [];
  const arrived = notices.filter((n): n is Extract<Notice, { kind: 'arrived' }> => n.kind === 'arrived');
  for (const n of notices) if (n.kind === 'arrest' && s.patients[n.id]) out.push(T.shift.notice.arrest(nameOf(s.patients[n.id])));
  // первые меры (часть 95): код синий, смерть и «хуже» в смотровой — так же первыми, их звук — тревога монитора
  for (const n of notices) {
    const q = n.kind === 'code' || n.kind === 'died' || n.kind === 'worse' ? s.patients[n.id] : undefined;
    if (!q) continue;
    if (n.kind === 'code') out.push(T.shift.notice.code(nameOf(q)));
    else if (n.kind === 'died') out.push(T.shift.notice.died(nameOf(q), female(q), n.soft === true));
    else if (n.kind === 'worse') out.push(T.shift.notice.worse(nameOf(q), worseText(s, q, n.measure, n.step)));
  }
  for (const n of notices) if (n.kind === 'ambulance') out.push(T.shift.notice.ambulance(nameOf(s.patients[n.id]), complaintOf(s.patients[n.id])));
  for (const n of arrived) if (n.triage === 'red') out.push(T.shift.notice.red(nameOf(s.patients[n.id]), complaintOf(s.patients[n.id])));
  for (const r of p.results) if (r.step === p.step && r.exam !== justDone) out.push(T.spikes.patient.ready(resultName(r.exam, r.repeat)));
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
  else if (p.kind === 'ambulance') badges.push(T.shift.badge.ambulance);
  else if (p.kind !== 'appointment') badges.push(T.shift.badge.walkIn);
  else {
    // записан к специалисту (spec 2026-10-chapter-4, часть 59) — «по записи к гастроэнтерологу»
    const to = p.to ? s.staff?.find(x => x.id === p.to) : undefined;
    badges.push(to ? T.shift.badge.booked(db.roles[to.role]?.dat?.ru ?? '') : T.shift.badge.appointment);
  }
  if (p.payer) badges.push(T.sandbox.payers[p.payer]);
  if (p.step > 0) badges.push(T.shift.badge.results);
  // «свои больные» (часть 76): новых этой группы нанятые врачи оставляют вам
  if (leftForPlayer(db, s, p)) badges.push(T.shift.badge.mine);
  return {
    id: p.id,
    name: nameOf(p),
    age: T.spikes.patient.years(p.patient.age),
    triage: p.triage,
    complaint: complaintOf(p),
    waits: T.shift.waits(Math.max(0, Math.floor((s.t - p.arriveT) / 60))),
    badges,
    ...(p.kind === 'ambulance' ? { ambulance: true } : {}),
  };
}

/** Где оформляется (spec 2026-10-clinic-flow): ждёт регистратуру, в регистратуре, ждёт медсестру, у медсестры. */
function stageOf(s: ShiftState, p: ShiftPatient): string {
  const t = T.shift.intake;
  const i = p.intake;
  if (!i || s.t < i.reg.start) return t.regQueue;
  if (s.t < i.reg.end || !i.nurse) return t.reg;
  return s.t < i.nurse.start ? t.nurseQueue : t.nurse;
}

function summaryOf(s: ShiftState): SummaryView | undefined {
  const h = s.history[s.history.length - 1];
  if (!h) return undefined;
  const all = Object.values(s.patients);
  const cases = all.filter(p => p.closed && !p.closed.by && closedDay(p) === h.day).sort((a, b) => a.closed!.at - b.closed!.at);
  // нанятые врачи (spec 2026-09-hired-doctors): строка на каждого — его приёмы за день
  const caseRow = (p: ShiftPatient): CaseRow => ({ id: p.id, name: nameOf(p), verdict: p.closed!.verdict, overall: p.closed!.grades.overall,
    // умер в смотровой до решения (часть 95) — диагноза нет
    diagnosis: db.conditions[p.closed!.diagnosis]?.name.ru ?? T.spikes.patient.noDiagnosis });
  const colleagues = Object.entries(h.colleagues ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, c]) => {
    const m = s.staff?.find(x => x.id === id);
    return {
      id, title: m ? T.shift.summary.colleague(personName(m.sex, m.seed), lowerFirst(db.roles[m.role]?.name.ru ?? '')) : T.shift.summary.colleagueGone,
      line: T.shift.summary.colleagueLine(c.seen, c.correct, c.partly, c.wrong, c.grades, c.taken ?? 0),
      // его приёмы — к разбору, как ваши (часть 19)
      cases: all.filter(p => p.closed?.by === id && closedDay(p) === h.day).sort((a, b) => a.closed!.at - b.closed!.at).map(caseRow),
      ...(m ? { portrait: portraitOf(m) } : {}),
    };
  });
  // умер в стационаре или переведён в тяжёлом состоянии этой ночью (часть 28б) — той же спокойной строкой
  const endedTonight = (p: ShiftPatient) => {
    const c = p.closed?.stay;
    return c !== undefined && p.stay !== undefined && (c.end === 'died' || p.closed!.outcome.severe === true) && p.stay.since + c.days === h.day;
  };
  const news = all
    .filter(p => p.closed && ((p.closed.plan.setting === 'home' && closedDay(p) + p.closed.outcome.day === h.day) || endedTonight(p)))
    .sort((a, b) => a.closed!.at - b.closed!.at)
    .map(p => ({ id: p.id, text: T.shift.news(nameOf(p), closedDay(p), outcomeText(p.closed!.outcome, p.closed!.plan.setting, female(p))) }));
  return {
    ...h,
    grades: { ...h.grades },
    confidence: cases.length > 0 ? Math.round((cases.reduce((a, p) => a + p.closed!.confidence, 0) / cases.length) * 10) : undefined,
    rationalMoney: cases.reduce((a, p) => a + p.closed!.rationalMoney, 0),
    cases: cases.map(caseRow),
    colleagues,
    theirs: colleagues.length > 0 ? Object.values(h.colleagues ?? {}).reduce((n, c) => n + c.seen, 0) : 0,
    news,
    ...(h.economy ? { cash: cashView(db, h.economy) } : {}),
    ...(h.campaign && s.campaign ? {
      chapterDay: {
        done: h.campaign.done.map(id => {
          const ch = db.chapters[s.campaign!.chapter];
          return (ch ? missionsOf(ch, s.meta.shortChapters).find(m => m.id === id)?.text.ru : undefined) ?? id;
        }),
        letters: h.campaign.letters.length,
      },
    } : {}),
    achievements: achievementNames(dayKey(s, h.day)),
    ...(s.meta.mode === 'single' || s.meta.mode === 'scenario' ? { single: singleView(s) } : {}),
    ...(s.meta.mode === 'scenario' && scenarioView(s) ? { scenario: scenarioView(s) } : {}),
    ...(h.ward ? { wardLines: wardLines(h.ward) } : {}),
    ...(h.ambulance && h.ambulance.arrived > 0 ? { ambulanceLines: ambulanceLines(h.ambulance, s.meta.soft === true) } : {}),
    ...(h.targets && Object.keys(h.targets).length > 0 ? { targetLines: targetDayLines(h.targets) } : {}),
    ...(h.surgery && h.surgery.done > 0 ? { surgeryLines: surgeryLines(h.surgery) } : {}),
  };
}

/** Сроки за день — строками итогов: «ЭКГ при боли в груди в срок: 5 из 6». */
function targetDayLines(x: NonNullable<ShiftState['summary']['targets']>): string[] {
  return Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, n]) => T.shift.summary.targets.line(db.targets[id]?.name.ru ?? id, n.onTime, n.total));
}

/** Операционная за день — строками итогов: операций и в срок ли, осложнения. */
function surgeryLines(x: NonNullable<ShiftState['summary']['surgery']>): string[] {
  const t = T.shift.summary.surgery;
  const out = [t.line(x.done, x.onTime, x.late)];
  if ((x.complicated ?? 0) > 0) out.push(t.complicated(x.complicated!));
  if (x.complications > 0) out.push(t.complications(x.complications));
  return out;
}

/** Скорая за день — строками итогов: привезли, отсортировали, сколько совпало со шкалой. */
function ambulanceLines(a: NonNullable<ShiftState['summary']['ambulance']>, soft: boolean): string[] {
  const t = T.shift.summary.ambulance;
  const out = [t.line(a.arrived, a.sorted)];
  if (a.sorted > 0) out.push(t.check(a.sorted - a.under - a.over, a.under, a.over));
  if (a.arrived > a.sorted) out.push(t.unsorted(a.arrived - a.sorted));
  // первые меры (spec 2026-10-first-measures, часть 95): скольким тяжёлым нужны, скольким вовремя, у скольких хуже, умерли
  const m = a.measures;
  if (m && m.needed + m.died > 0) {
    out.push(t.measures(m.onTime, m.needed));
    if (m.worse > 0) out.push(t.worse(m.worse));
    if (m.died > 0) out.push(t.died(m.died, soft));
  }
  return out;
}

/** Стационар за день — строками итогов: сколько поступило, выписано (из них рано), переведено, лежит; сроки. */
function wardLines(w: NonNullable<ShiftState['summary']['ward']>): string[] {
  const t = T.shift.summary.ward;
  const out = [t.moves(w.admitted, w.discharged, w.transferred, w.lying)];
  if (w.early > 0) out.push(t.early(w.early));
  if ((w.died ?? 0) > 0) out.push(t.died(w.died!));
  if (w.discharged > 0) out.push(t.stay(Math.round((w.stayDays / w.discharged) * 10) / 10, Math.round((w.stayNorm / w.discharged) * 10) / 10));
  // палата интенсивной терапии (часть 38а) и реанимация (spec 2026-10-chapter-4, часть 47)
  if ((w.icu ?? 0) > 0 || (w.icuLying ?? 0) > 0) out.push(t.icu(w.icu ?? 0, w.icuLying ?? 0));
  if ((w.ricu ?? 0) > 0 || (w.ricuLying ?? 0) > 0) out.push(t.ricu(w.ricu ?? 0, w.ricuLying ?? 0));
  // боксы инфекционного отделения (часть 49а)
  if ((w.box ?? 0) > 0 || (w.boxLying ?? 0) > 0) out.push(t.box(w.box ?? 0, w.boxLying ?? 0));
  return out;
}

const EMPTY: Omit<ShiftView, 'version' | 'status' | 'mode'> = {
  difficulty: 'student', day: 0, clock: '', dayOpen: false, afterHours: false, allDone: false, speed: 1, paused: false,
  queue: [], intake: [], away: [], log: [], counts: { seen: 0, left: 0, waiting: 0, unseen: 0 }, restored: false, people: [], who: {}, colleagues: [], signs: [], inpatients: 0, ambulance: [],
  bays: [],
};

function buildShiftView(): ShiftView {
  const sess = session;
  if (!sess) return { ...EMPTY, version, status, mode };
  const s = sess.s;
  const inRoom = current(s);
  // ваши — на обследованиях; пациенты нанятых врачей — их забота (spec 2026-09-hired-doctors)
  const away = Object.values(s.patients).filter(p => p.status === 'away' && !p.by).sort((a, b) => (a.id < b.id ? -1 : 1));
  const intake = Object.values(s.patients).filter(p => p.status === 'intake').sort((a, b) => a.arriveT - b.arriveT || (a.id < b.id ? -1 : 1));
  const theirs = Object.values(s.patients).filter(p => p.by !== undefined && (p.status === 'inRoom' || p.status === 'waiting' || p.status === 'away')).length;
  const layout = s.hospital ? sandboxLayout(s) : undefined;
  // живой фон (spec 2026-10-living-background): прогулки — в секундах экрана, на любой скорости
  const people = placements(db, layout ?? CLINIC, s, { pace: sess.speed * 60 });
  return {
    version,
    status,
    mode: s.meta.mode,
    ...(s.economy ? { cash: s.economy.cash } : {}),
    difficulty: s.meta.difficulty ?? 'doctor',
    day: s.day,
    clock: hhmm(minuteOfDay(s.t)),
    ...(s.meta.scenario ? { scenario: { name: T.scenarios.names[s.meta.scenario], day: T.scenarios.day(Math.min(s.day, SCENARIO_DAYS), SCENARIO_DAYS) } } : {}),
    dayOpen: s.dayOpen,
    afterHours: s.t >= dayStart(s) + SHIFT_END,
    allDone: s.dayOpen && allDone(s),
    speed: sess.speed,
    paused: sess.paused,
    pauseReason: sess.pauseReason,
    inRoom: inRoom ? { id: inRoom.id, name: nameOf(inRoom) } : undefined,
    queue: s.queue.map(id => row(s, s.patients[id])),
    intake: intake.map(p => ({ id: p.id, name: `${nameOf(p)}, ${T.spikes.patient.years(p.patient.age)}`, stage: stageOf(s, p) })),
    away: away.map(p => ({ id: p.id, name: nameOf(p), ready: hhmm(minuteOfDay(Math.max(...p.pending.map(x => x.readyAt)))) })),
    log: sess.log.map(l => ({ key: l.key, kind: l.kind, text: l.text, at: hhmm(minuteOfDay(l.t)) })),
    counts: { seen: s.summary.seen, left: s.summary.left, waiting: s.queue.length, unseen: s.queue.length + intake.length + away.length + (inRoom ? 1 : 0) + theirs },
    summary: s.dayOpen ? undefined : summaryOf(s),
    restored: sess.restored,
    people,
    who: whoOf(s, people),
    signs: roomSigns(layout ?? CLINIC, s, s.hospital ? understaffed(s) : undefined),
    colleagues: colleagueRows(s),
    inpatients: inpatientsOf(s).length,
    ambulance: ambulanceRows(s),
    bays: bayRows(s),
    ...(s.hospital ? { rooms: roomsOf(s) } : {}),
    ...(layout ? { layout } : {}),
    ...(s.staff?.some(m => m.room && db.roles[m.role]?.profile) ? { offices: specialistOffices(s) } : {}),
  };
}

/** Кабинеты, где работают специалисты (часть 59), — их названия на карте; у терапевта — прежнее «Кабинет терапевта». */
function specialistOffices(s: ShiftState): Record<string, string> {
  return Object.fromEntries((s.staff ?? []).flatMap(m => (m.room && db.roles[m.role]?.profile ? [[m.room, T.shift.map.specialistOffice(db.roles[m.role].gen.ru)]] : [])));
}

// помещения своей больницы без нужной должности — значок «нет персонала» на карте (часть 23)
const shortStaffed = new WeakMap<HospitalCtx, Set<string>>();

function understaffed(s: ShiftState): Set<string> {
  const ctx = hospitalCtx(db, s);
  let out = shortStaffed.get(ctx);
  if (!out) {
    out = new Set(ctx.plan.rooms.filter(r => problemsOf(db, ctx.plan, r, ctx.staffed).some(p => p.kind === 'noStaff' || p.kind === 'noPlace')).map(r => r.id));
    shortStaffed.set(ctx, out);
  }
  return out;
}

// помещения своей больницы: что это, работает ли и кто в нём — на день; что происходит — сейчас
const roomBase = new WeakMap<HospitalCtx, Record<string, RoomView>>();
/** Строк анализов в лаборатории на касание — не больше: длинный список не читается под картой. */
const LAB_LINES = 4;

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
    if (r.type === 'room.office' && r.id !== doctorRoom(ctx.plan)) {
      // кабинет нанятого врача: кого он принимает
      const m = ctx.staff.find(x => x.room === r.id && db.roles[x.role]?.stands);
      const p = m ? all.find(q => q.status === 'inRoom' && q.by === m.id) : undefined;
      now.push(p ? t.roomInOffice(nameOf(p)) : t.roomFree);
    } else if (r.type === 'room.office') {
      const p = current(s);
      now.push(p ? t.roomInOffice(nameOf(p)) : t.roomFree, t.roomQueue(s.queue.length));
    } else if (r.type === 'room.waiting') {
      now.push(t.roomSeats(s.queue.length, r.seats.length));
    } else if (r.type === 'room.lab') {
      // чьё в работе (spec 2026-10-clinic-flow): несут из процедурной — и до какого часа анализ
      const here = all.flatMap(p => p.pending.filter(x => x.room === r.id && (x.end ?? x.start ?? 0) <= s.t).map(x => ({ p, x })))
        .sort((a, b) => a.x.readyAt - b.x.readyAt || (a.p.id < b.p.id ? -1 : 1));
      for (const { p, x } of here.slice(0, LAB_LINES)) {
        const exam = db.exams[x.exam]?.name.ru ?? x.exam;
        // ещё в процедурной — медсестра понесёт с пробами следующих (spec 2026-10-code-blue)
        if (x.sent !== undefined && s.t < x.sent) now.push(t.roomRack(exam, nameOf(p)));
        else now.push(x.lab !== undefined && s.t < x.lab ? t.roomCarry(exam, nameOf(p)) : t.roomInWork(exam, nameOf(p), hhmm(minuteOfDay(x.readyAt))));
      }
      if (here.length > LAB_LINES) now.push(t.roomMore(here.length - LAB_LINES));
      if (here.length === 0) now.push(t.roomFree);
    } else if (r.type === 'room.procedure') {
      // кровь — по одному: у кого берут и сколько ждут (spec 2026-10-clinic-flow); повторный забор — в свой срок, его не ждут
      const here = all.flatMap(p => p.pending.filter(x => x.draw === r.id).map(x => ({ p, x })));
      const at = here.find(({ x }) => (x.start ?? 0) <= s.t && s.t < (x.end ?? 0));
      if (at) now.push(t.roomDraw(nameOf(at.p)));
      // ждут — люди, а не пробирки: у одного забора их бывает несколько (spec 2026-10-code-blue)
      const next = new Set(here.filter(({ x }) => (x.start ?? 0) > s.t && !x.repeat).map(({ p }) => p.id)).size;
      if (next > 0) now.push(t.roomDrawNext(next));
      if (!at && next === 0) now.push(t.roomFree);
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

/** Пациенты нанятых врачей: у кого и что сейчас — для раздела «У врачей» (часть 19). */
function colleagueRows(s: ShiftState): ShiftView['colleagues'] {
  const t = T.shift.colleagueCase;
  return Object.values(s.patients)
    .filter(p => p.by !== undefined && !p.closed && (p.status === 'inRoom' || p.status === 'waiting' || p.status === 'away'))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(p => {
      const doing = p.status === 'inRoom' ? t.inRoom(hhmm(minuteOfDay(p.calledT ?? s.t)))
        : p.status === 'away' ? t.results(hhmm(minuteOfDay(Math.max(s.t, ...p.pending.map(x => x.readyAt)))))
          : t.back;
      return { id: p.id, name: `${nameOf(p)}, ${T.spikes.patient.years(p.patient.age)}`, hint: t.row(doctorOfCase(s, p.by!), doing) };
    });
}

function whoOf(s: ShiftState, people: readonly Placement[]): Record<string, WhoView> {
  const t = T.shift.map;
  const out: Record<string, WhoView> = {};
  for (const x of people) {
    const d = x.doing;
    if ((d.kind === 'staff' || d.kind === 'reading') && d.role === 'therapist') {
      // нанятый врач: кто он и кого принимает (spec 2026-09-hired-doctors); никого — читает (spec 2026-10-living-background)
      const room = x.id.slice('staff.therapist.'.length);
      const m = s.staff?.find(y => y.room === room && db.roles[y.role]?.stands);
      const p = m ? Object.values(s.patients).find(q => q.status === 'inRoom' && q.by === m.id) : undefined;
      out[x.id] = {
        title: m ? t.therapist(personName(m.sex, m.seed), lowerFirst(db.roles[m.role]?.name.ru ?? ''), m.skill) : t.staff.therapist,
        doing: p ? t.therapistWith(nameOf(p)) : d.kind === 'reading' ? t.doing.reading : m && db.roles[m.role]?.profile ? t.duty.specialist : t.duty.therapist, callable: false,
      };
      continue;
    }
    if (d.kind === 'staff') {
      out[x.id] = { title: t.staff[d.role], doing: t.duty[d.role], callable: false };
      continue;
    }
    if (d.kind === 'carry' || d.kind === 'code') {
      out[x.id] = { title: t.staff[d.role], doing: d.kind === 'code' ? t.doing.code : t.doing.carry, callable: false };
      continue;
    }
    // перерыв (spec 2026-10-living-background)
    if (d.kind === 'coffee' || d.kind === 'rest' || d.kind === 'reading') {
      out[x.id] = { title: t.staff[d.role], doing: d.kind === 'reading' ? t.doing.reading : t.doing.rest, callable: false };
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
      ...(p.by && !p.closed && s.dayOpen ? { colleague: true } : {}),
    };
  }
  return out;
}

function doingText(s: ShiftState, p: ShiftPatient, d: Doing): string {
  const t = T.shift.map.doing;
  switch (d.kind) {
    case 'registration':
      return t.registration;
    case 'registrationQueue':
      return t.registrationQueue;
    case 'triageQueue':
      return t.triageQueue;
    case 'triage':
      return t.triage;
    case 'waiting':
      return t.waiting(Math.max(0, Math.floor((s.t - p.arriveT) / 60)));
    case 'office': {
      // у нанятого врача — «у терапевта Ивановой», у специалиста — по должности (часть 59)
      const m = d.by ? s.staff?.find(x => x.id === d.by) : undefined;
      return m ? t.colleague(db.roles[m.role]?.gen.ru ?? '', personName(m.sex, m.seed)) : t.office;
    }
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
    case 'ward':
      return d.op ? t.waitingOp(db.treatments[d.op]?.name.ru ?? d.op) : d.ricu ? t.ricu(d.days) : d.icu ? t.icu(d.days) : d.box ? t.box(d.days) : t.ward(d.days);
    case 'surgery':
      return t.onTable(db.treatments[d.tx]?.name.ru ?? d.tx, hhmm(minuteOfDay(d.end)));
    case 'ambulance':
      return t.ambulance[d.state];
    // живой фон (spec 2026-10-living-background)
    case 'toilet':
      return t.toilet;
    case 'wash':
      return t.wash;
    case 'toiletQueue':
      return t.toiletQueue;
    case 'staff':
    case 'carry':
    case 'code':
    case 'coffee':
    case 'rest':
    case 'reading':
      return '';
  }
}

// --- обход (spec 2026-09-chapter-2, часть 26) --------------------------------------------------

/** Карточка лежащего на обходе. */
export interface RoundCard {
  id: string;
  title: string;
  diagnosis: string;
  day: string;
  state: WardState;
  stateText: string;
  /** «Студент»: болезнь прошла — можно выписывать */
  readyHint?: string;
  vitals: { label: string; values: string }[];
  treatments: string;
  treatmentIds: Id[];
  /** операция (spec 2026-09-chapter-2, часть 28): ждёт, идёт до…, после операции */
  op?: string;
  /** «В операционную» — у диагноза есть операция, а её ещё не было; нельзя — почему */
  operate?: { hint: string; disabled?: boolean };
  /** на столе — ни выписать, ни перевести; ждёт операции — только перевести */
  canDischarge: boolean;
  canTransfer: boolean;
  /** лежит в палате интенсивной терапии, под монитором (spec 2026-10-chapter-3, часть 38а) */
  icu?: string;
  /** что случилось за сутки: фибрилляция желудочков под монитором ПИТ (часть 39б) */
  event?: string;
}

const fmtVital = (f: Id, v: number) => {
  const spec = db.findings[f]!.value!;
  const main = v.toFixed(spec.decimals).replace('.', ',');
  const dia = spec.derived?.dia;
  return dia ? `${main}/${Math.round(v * dia)}` : main;
};

/** Лежащие сейчас — карточками обхода: сутки, как идёт болезнь, витальные по суткам, лечение. */
export function roundsView(): RoundCard[] {
  const sess = session;
  if (!sess) return [];
  const s = sess.s;
  const t = T.shift.ward;
  const student = easyLevel(s.meta.difficulty);
  const hasOr = s.hospital !== undefined && hospitalCtx(db, s).plan.rooms.some(r => r.type === 'room.or');
  const queue = orQueueOf(s).map(p => p.id);
  return inpatientsOf(s).map(p => {
    const stay = p.stay!;
    const days = daysIn(stay, s.day);
    const state = wardState(stay, days);
    const from = Math.max(0, days - 5);
    const range = Array.from({ length: days - from + 1 }, (_, i) => from + i);
    const vitals = WARD_VITALS.flatMap(f => {
      const spec = db.findings[f]?.value;
      const series = range.map(d => vitalOn(db, p.patient, stay, f, d));
      if (!spec || series.some(v => v === undefined)) return [];
      // температура — всегда; остальное — если выходило за норму
      const off = series.some(v => v! < spec.ref[0] || v! > spec.ref[1]);
      if (f !== 'vital.fever' && !off) return [];
      return [{ label: t.vital[f] ?? f, values: `${series.map(v => fmtVital(f, v!)).join(' → ')}\u00a0${spec.unit}` }];
    });
    const dx = p.closed?.diagnosis;
    const op = stay.op;
    const opName = op ? (db.treatments[op.tx]?.name.ru ?? op.tx) : '';
    const stage = op?.complicated ? db.conditions[primaryOf(p.patient).id]?.complication?.name.ru : undefined;
    const opLine = !op ? undefined
      : op.done ? `${t.opDone(opName)}${stage ? ` · ${t.opStage(stage)}` : ''}${op.complication ? ` · ${t.opComplication}` : ''}`
        : op.start !== undefined ? t.opOn(opName, hhmm(minuteOfDay(op.end ?? op.start))) : t.opWaiting(opName, queue.indexOf(p.id) + 1);
    const dxOp = !op && dx && hasOr ? operationOf(db, p, dx) : undefined;
    const block = dxOp ? orBlock(db, s, dxOp) : null;
    return {
      id: p.id,
      title: `${nameOf(p)}, ${T.spikes.patient.years(p.patient.age)}`,
      diagnosis: dx ? db.conditions[dx]?.name.ru ?? dx : '',
      day: days === 0 ? t.today(female(p)) : t.days(days, stayNorm(db, dx ?? '')),
      state,
      // вред другой болезнью (часть 42а) — она и после чего: «Ишемический инсульт после лечения «…»»
      stateText: state === 'reaction' && stay.reaction?.as
        ? t.state.harmAs(db.conditions[stay.reaction.as]?.name.ru ?? stay.reaction.as, db.treatments[stay.reaction.tx]?.name.ru ?? stay.reaction.tx)
        : state === 'reaction' && stay.reaction
        ? t.state.reaction(db.treatments[stay.reaction.tx]?.name.ru ?? stay.reaction.tx, db.risks[stay.reaction.by]?.name.ru ?? db.conditions[stay.reaction.by]?.name.ru ?? stay.reaction.by)
        : t.state[state === 'reaction' ? 'same' : state],
      ...(student && state === 'ready' ? { readyHint: t.readyHint } : {}),
      vitals,
      treatments: stay.plan.treatments.length > 0 ? stay.plan.treatments.map(tx => db.treatments[tx]?.name.ru ?? tx).join(', ') : t.noTreatment,
      // операцию меняют «В операционную», а не сменой лечения
      treatmentIds: stay.plan.treatments.filter(tx => db.treatments[tx]?.kind !== 'surgery'),
      ...(opLine ? { op: opLine } : {}),
      ...(dxOp ? { operate: block ? { hint: orBlockText(block), disabled: true } : { hint: db.treatments[dxOp].name.ru } } : {}),
      canDischarge: !op || op.done === true,
      canTransfer: !op || op.done === true || op.start === undefined,
      // реанимация (spec 2026-10-chapter-4, часть 47): на ИВЛ или под монитором
      ...(inRicu(db, s, p) ? { icu: stay.plan.treatments.some(tx => db.treatments[tx]?.place === 'ricu') ? t.onVent : t.inRicu } : inIcu(db, s, p) ? { icu: t.inIcu } : {}),
      // бокс инфекционного отделения (spec 2026-10-chapter-4, часть 49а)
      ...(inBox(db, s, p) ? { icu: t.inBox } : {}),
      ...(stay.shock !== undefined && days === stay.shock + 1 ? { event: t.shock } : {}),
    };
  });
}

let roundsCache: { version: number; view: RoundCard[] } | null = null;

function roundsCached(): RoundCard[] {
  if (roundsCache?.version !== version) roundsCache = { version, view: roundsView() };
  return roundsCache.view;
}

export function useRounds(): RoundCard[] {
  return useSyncExternalStore(subscribe, roundsCached, roundsCached);
}

/** Лечение по группам для смены плана лежащего — с тем, что о нём известно, и аппаратами у его койки (часть 39а). */
export function replanChoices(id: string): ReturnType<typeof treatmentGroupsFor> {
  const s = session?.s;
  const p = s?.patients[id];
  return s && p ? treatmentGroupsFor(observationsOf(p), stayEquipment(db, s, p), hospitalCtx(db, s).rooms) : [];
}

function wardAct(cmd: Command) {
  const sess = live();
  if (!sess || !sess.s.dayOpen) return;
  run(sess, cmd, partBudget());
  // выписан или переведён — в архиве профиля его приём с исходом
  if (cmd.kind !== 'replan') recordCases(closedCases(sess.s));
  save();
  changed();
}

// --- скорая (spec 2026-09-chapter-2, часть 27) -------------------------------------------------

/** Лист передачи фельдшера: повод, что он измерил; на «Студенте» — баллы NEWS2 и тревожный признак, что поднял цвет. */
export interface HandoverView {
  reason: string;
  measured: string[];
  news2?: string;
  flag?: string;
  /** лежит в смотровой (spec 2026-10-first-measures, часть 95): монитор и первые меры; у входа, на каталке, — нет */
  measures?: FirstMeasuresView;
}

/**
 * Привезённый скорой, что ждёт сортировки, или отсортированный, что лежит в смотровой (часть 95): кто, повод, где лежит,
 * лист передачи; `worse` — без первой меры ему уже хуже.
 */
export interface AmbulanceRow {
  id: string;
  name: string;
  line: string;
  handover: HandoverView;
  sorted?: true;
  worse?: true;
}

function ambulanceRows(s: ShiftState): AmbulanceRow[] {
  const door = new Set(atDoorOf(s).map(p => p.id));
  return Object.values(s.patients)
    .filter(p => p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted)
    .sort((a, b) => a.arriveT - b.arriveT || (a.id < b.id ? -1 : 1))
    .map(p => handoverRow(s, p, door.has(p.id)));
}

/** Отсортированные привезённые, что лежат в смотровой (часть 95): монитор и первые меры — по касанию. */
function bayRows(s: ShiftState): AmbulanceRow[] {
  return Object.values(s.patients)
    .filter(p => p.kind === 'ambulance' && p.sorted && p.bay && !p.closed && (p.status === 'waiting' || p.status === 'inRoom' || p.status === 'away'))
    .sort((a, b) => a.arriveT - b.arriveT || (a.id < b.id ? -1 : 1))
    .map(p => handoverRow(s, p, false));
}

function handoverRow(s: ShiftState, p: ShiftPatient, door: boolean): AmbulanceRow {
  const t = T.shift.ambulance;
  const paramedic = p.results.find(r => r.exam === 'exam.vitals');
  const student = easyLevel(s.meta.difficulty) && p.scale !== undefined;
  const flag = student && p.scale?.flag ? db.findings[p.scale.flag]?.name.ru : undefined;
  const measures = firstMeasuresOf(s, p);
  return {
    id: p.id,
    name: `${nameOf(p)}, ${T.spikes.patient.years(p.patient.age)}`,
    line: p.sorted && measures ? `${measures.lines.map(l => l.text).join(', ')} · ${t.bayOpen}` : `${t.reason(complaintOf(p))} · ${door ? t.door : t.bay}`,
    handover: {
      reason: t.sheetReason(complaintOf(p)),
      measured: (paramedic?.obs ?? []).filter(o => o.value !== undefined).map(o => observationText(db, o, p.patient.sex, p.patient.seed)),
      ...(student && p.scale ? { news2: t.news2(p.scale.news2) } : {}),
      ...(flag && p.scale ? { flag: t.flag(flag, p.scale.triage) } : {}),
      ...(measures ? { measures } : {}),
    },
    ...(p.sorted ? { sorted: true as const } : {}),
    ...(measures?.lines.some(l => l.worse) ? { worse: true as const } : {}),
  };
}

/**
 * Первые меры лежащего в смотровой (spec 2026-10-first-measures, часть 95): монитор — лист передачи со сдвигами ступеней и
 * мер, со стрелкой; под монитором с дефибриллятором — «Монитор», без него цифры называет медсестра. Кнопки мер; «Практиканту»
 * и «Студенту» — что сделать сразу по листу, тем же правилом, что у разумного врача: подсказка по известному, а не по правде.
 */
function firstMeasuresOf(s: ShiftState, p: ShiftPatient, now = s.t): FirstMeasuresView | undefined {
  if (p.kind !== 'ambulance' || !p.bay || p.closed) return undefined;
  const t = T.shift.ambulance;
  const v = bayVitals(db, s, p, now);
  const lines: FirstMeasuresView['lines'] = [];
  const num = (f: Id, text: (x: number) => string, bad: (d: number) => boolean) => {
    const key = valueKey(db, f);
    const x = v.values[key];
    if (x === undefined) return;
    const d = v.delta[key] ?? 0;
    lines.push({ text: `${text(Math.round(x))}${d < 0 ? ' ↓' : d > 0 ? ' ↑' : ''}`, ...(bad(d) ? { worse: true as const } : {}) });
  };
  num('vital.spo2_low', t.spo2, d => d < 0);
  num('vital.bp_low', t.bp, d => d < 0);
  num('vital.tachycardia', t.pulse, d => d > 0);
  num('vital.tachypnea', t.breath, d => d > 0);
  for (const f of v.added) lines.push({ text: lowerFirst(db.findings[f]?.name.ru ?? f), worse: true });
  if (v.cleared) lines.push({ text: t.woke(female(p)) });
  const buttons: MeasureButton[] = Object.values(db.measures).map(m => {
    const x = p.measures?.find(y => y.tx === m.tx);
    const state: MeasureButton['state'] = !x ? 'give' : x.done > now ? 'doing' : 'done';
    const note = !x ? t.give : x.done > now ? t.doing(Math.max(1, Math.ceil((x.done - now) / 60))) : t.done(hhmm(minuteOfDay(x.done)));
    return { tx: m.tx, name: m.name.ru, state, note };
  });
  const hints = easyLevel(s.meta.difficulty) ? measureHints(s, p) : [];
  return {
    title: bedsideEquipment(db, s, p).includes('eq.monitor_defib') ? t.monitor : t.nurse,
    lines, buttons, ...(hints.length > 0 ? { hints } : {}), ...(p.code !== undefined ? { code: true as const } : {}),
  };
}

/** Что сделать сразу по листу передачи и тому, что уже известно (часть 95), — правило разумного врача; данное — не повторяет. */
function measureHints(s: ShiftState, p: ShiftPatient): string[] {
  const t = T.shift.ambulance.hint;
  const obs = observationsOf(p);
  const given = new Set((p.measures ?? []).map(m => m.tx));
  const base = bayVitals(db, s, p, p.bayT ?? s.t).values;
  const out: string[] = [];
  for (const tx of measuresDue(db, p.patient.complaints, obs)) {
    if (given.has(tx)) continue;
    if (tx === 'tx.oxygen_mask') out.push(t.oxygen(Math.round(base[valueKey(db, 'vital.spo2_low')] ?? 0)));
    else if (tx === 'tx.iv_fluids') out.push(t.fluids(Math.round(base[valueKey(db, 'vital.bp_low')] ?? 0)));
    else if (tx === 'tx.dextrose_iv') out.push(t.glucose);
    else if (tx === 'tx.pressure_dressing') out.push(t.bleeding);
  }
  // сознание спутано, а сахар не мерили — глюкометр: гипогликемию находят им
  const dazed = ['sym.confusion', 'sym.found_unconscious', 'sign.gcs_low', 'sign.gcs_coma'].some(f => obs.some(o => o.f === f && o.shown));
  if (dazed && !p.done.includes('exam.glucometer') && !given.has('tx.dextrose_iv')) out.push(t.glucometer);
  return out;
}

/** Первая мера (часть 95): медсестре смотровой — назначение лежащему в ней; минут врача не стоит. */
export function giveMeasure(id: string, tx: Id) {
  const sess = live();
  if (!sess || !sess.s.dayOpen) return;
  run(sess, { kind: 'measure', id, tx }, partBudget());
  save();
  changed();
}

/** Отсортировать привезённого скорой: цвет — место в очереди. */
export function sortAmbulance(id: string, triage: Triage) {
  const sess = live();
  if (!sess || !sess.s.dayOpen) return;
  run(sess, { kind: 'sort', id, triage }, partBudget());
  save();
  changed();
}

export const dischargePatient = (id: string) => wardAct({ kind: 'discharge', id });
/** С обхода — в операционную (часть 28). */
export const operatePatient = (id: string) => wardAct({ kind: 'operate', id });
export const transferPatient = (id: string) => wardAct({ kind: 'transfer', id });
export const replanPatient = (id: string, treatments: Id[]) => wardAct({ kind: 'replan', id, treatments });

/** Итог и разбор закрытого случая: разбор пересчитывается той же ветвью зерна (engine/reviewFor). */
const decisions = new Map<string, Decision>();

/** «Домой» — исход в итогах дня, когда он стал ясен; перевод — сразу (spec, «Что увидит игрок»). */
function outcomeKnown(s: ShiftState, p: ShiftPatient): boolean {
  const c = p.closed!;
  const lastClosed = s.dayOpen ? s.day - 1 : s.day;
  return c.plan.setting !== 'home' || lastClosed >= closedDay(p) + c.outcome.day;
}

function decisionFor(meta: ReviewMeta, p: ShiftPatient, arrived: Arrival[], known: boolean, c: ClosedCase = p.closed!): Decision {
  // исход лежащего меняется при выписке — ключ с ним
  const key = `${meta.seed}:${p.id}:${known}:${c.outcome.kind}`;
  const cached = decisions.get(key);
  if (cached) return cached;
  // аппараты у постели в момент решения (часть 39а): разбор помнит, был ли тромболизис возможен
  const ev = evaluatePlan(db, p.patient, c.plan, observationsOf(p), { bedside: c.bedside ?? [] });
  const review = reviewFor(db, meta, p, c.diagnosis);
  const d = decisionOf({
    patient: p.patient, arrived, diagnosis: c.diagnosis, verdict: c.verdict, confidence: c.confidence, plan: c.plan, ev, outcome: c.outcome,
    score: { ...c.grades, notes: c.notes }, review, ...(c.targets ? { targets: c.targets } : {}),
    ...(c.arrest ? { arrest: true } : {}),
  });
  const out = known ? d : { ...d, outcome: T.shift.outcomeLater };
  decisions.set(key, out);
  return out;
}

/**
 * Ваш пациент на час `t` (0.5.14): результаты, готовые к нему, — уже пришли, по порядку, как их отдаст движок, когда
 * больница доживёт до него (`results`: по времени, затем по обследованию). Только для карты: смена — та же.
 */
function seenAt(p: ShiftPatient, t: number): ShiftPatient {
  const ready = p.pending.filter(x => x.readyAt <= t).sort((a, b) => a.readyAt - b.readyAt || (a.exam < b.exam ? -1 : 1));
  if (ready.length === 0) return p;
  return {
    ...p,
    pending: p.pending.filter(x => x.readyAt > t),
    results: [...p.results, ...ready.map(x => ({ exam: x.exam, obs: x.obs, at: x.readyAt, step: p.step, ...(x.repeat ? { repeat: x.repeat } : {}) }))],
  };
}

/** Пришедшие результаты; `until` — только готовые к этому времени (приём врача идёт: что он выясняет сейчас, ещё не известно). */
const arrivedOf = (p: ShiftPatient, until = Infinity): Arrival[] =>
  p.results.filter(r => r.at <= until).map(r => ({
    exam: r.exam, step: r.step, at: minuteOfDay(r.at), obs: r.obs, ...(r.repeat ? { repeat: r.repeat } : {}), ...(r.card ? { card: r.card } : {}),
  }));

/** Ваши закрытые приёмы смены — для профиля (profile.ts, recordCases); приёмы нанятых врачей не в счёт. */
function closedCases(s: ShiftState) {
  return Object.values(s.patients)
    .filter(p => p.closed && !p.closed.by)
    .map(p => ({
      seed: s.meta.seed, department: s.meta.department, day: closedDay(p), patient: p, ...(s.meta.challenges ? { challenges: s.meta.challenges } : {}),
      ...(s.meta.scenario ? { scenario: s.meta.scenario } : {}),
    }));
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
  // разбор — с испытаниями той смены (часть 91): разумный врач с теми же запретами
  const meta: ReviewMeta = { seed: r.seed, department: r.department, ...(r.challenges ? { challenges: r.challenges } : {}), ...(r.scenario ? { scenario: r.scenario } : {}) };
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
    decision: decisionFor(meta, p, arrived, known),
    difficulty: 'doctor',
    ...(p.departments ? { departments: p.departments } : {}),
  });
}

/**
 * Где лечить в больнице со своей палатой (spec 2026-09-chapter-2, часть 26): домой, в палату
 * (сколько коек свободно; нет свободных — нельзя), направить в другую больницу, скорая. Есть
 * операционная (часть 28) — и «В операционную»: какая операция — по диагнозу, нельзя — почему.
 * Есть палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а) — и «В ПИТ»: сколько коек
 * под монитором свободно, нет свободных — нельзя. Есть реанимация (spec 2026-10-chapter-4, часть 47) — и
 * «В ОРИТ»: сколько коек с монитором и аппаратом ИВЛ свободно. Есть боксы инфекционного отделения (часть 49а) — и «В бокс».
 */
function settingOptions(s: ShiftState, p: ShiftPatient): SettingOption[] {
  const diagnosis = p.draft.diagnosis;
  const all = wardBeds(db, s).length;
  const free = freeBeds(db, s).length;
  const t = T.shift.ward;
  const setting = T.spikes.patient.setting;
  const rooms = hospitalCtx(db, s).plan.rooms;
  const hasOr = rooms.some(r => r.type === 'room.or');
  const hasIcu = rooms.some(r => db.rooms[r.type]?.icu && !db.rooms[r.type].vent);
  const icuAll = icuBeds(db, s).length;
  const icuFree = freeIcuBeds(db, s).length;
  const hasRicu = rooms.some(r => db.rooms[r.type]?.vent);
  const ricuAll = ricuBeds(db, s).length;
  const ricuFree = freeRicuBeds(db, s).length;
  const boxAll = boxBeds(db, s).length;
  const boxFree = freeBoxBeds(db, s).length;
  const hasBox = rooms.some(r => db.rooms[r.type]?.box);
  return [
    { key: 'home', title: setting.home },
    ...(all > 0 ? [{ key: 'admit' as const, title: t.admit, hint: free > 0 ? t.freeBeds(free, all) : t.noBeds, disabled: free === 0 }] : []),
    ...(hasIcu ? [{ key: 'icu' as const, title: t.icu, hint: icuFree > 0 ? t.freeIcuBeds(icuFree, icuAll) : t.noBeds, disabled: icuFree === 0 }] : []),
    ...(hasRicu ? [{ key: 'ricu' as const, title: t.ricu, hint: ricuFree > 0 ? t.freeRicuBeds(ricuFree, ricuAll) : t.noBeds, disabled: ricuFree === 0 }] : []),
    ...(hasBox ? [{ key: 'box' as const, title: t.box, hint: boxFree > 0 ? t.freeBoxBeds(boxFree, boxAll) : t.noBeds, disabled: boxFree === 0 }] : []),
    ...(hasOr ? [orOption(s, p, diagnosis, free, all)] : []),
    { key: 'ward', title: t.refer },
    { key: 'ambulance', title: setting.ambulance },
  ];
}

/** «В операционную»: операция диагноза — по тому, что видно (часть 32б), — и свободные койки; нельзя — почему (часть 28). */
function orOption(s: ShiftState, p: ShiftPatient, diagnosis: Id | undefined, free: number, all: number): SettingOption {
  const t = T.shift.ward;
  const op = diagnosis ? operationOf(db, p, diagnosis) : undefined;
  const block = op ? orBlock(db, s, op) : null;
  const why = !diagnosis ? t.noDiagnosis : !op ? t.noOperation : block ? orBlockText(block) : free === 0 ? t.noBeds : undefined;
  return why ? { key: 'surgery', title: t.operate, hint: why, disabled: true } : { key: 'surgery', title: t.operate, hint: t.opHint(db.treatments[op!].name.ru, free, all) };
}

function orBlockText(b: OrBlock): string {
  const t = T.shift.ward;
  if (b.kind === 'noEquipment') return t.noOpEquipment(db.equipment[b.equipment]?.gen.ru ?? b.equipment);
  if (b.kind === 'down') return t.orDown(problemText(db, b.problem));
  return t.orDown(T.sandbox.problem.noEquipment);
}

/**
 * Сроки пациента — справка из рекомендации, не таймер (spec 2026-10-chapter-3, «Проверка по
 * обещаниям студии»): сколько даёт рекомендация и сколько прошло с прихода; сделано — через
 * сколько минут (часть 37).
 */
function targetLines(s: ShiftState, p: ShiftPatient): CaseTarget[] {
  const t = T.spikes.patient;
  return targetsFor(db, p, targetPlace(db, s, p)).map(target => {
    const done = minutesTo(db, p, target);
    // от находки (часть 39б): «в первые 10 минут от ЭКГ с подъёмом ST; прошло — N мин»; от правила (часть 48а) — так же
    const start = targetStart(db, p, target) ?? p.arriveT;
    if (done !== undefined) return { text: t.targetDone(target.name.ru, done, target.minutes, target.texts.after?.ru), done: true };
    return { text: t.target(target.name.ru, target.minutes, Math.round((s.t - start) / 60), target.texts.from?.ru), done: false };
  });
}

function buildCaseView(): VisitView | undefined {
  const sess = session;
  if (!sess) return undefined;
  const s = sess.s;
  const id = sess.focus ?? s.current;
  const p = id ? s.patients[id] : undefined;
  if (!p) return undefined;
  // ваш пациент — на конец вашего действия (0.5.14): больница ещё доживает его минуты, а результаты к этому часу и
  // возвращение пациента — уже такие, какими вы их увидите; смена от этого не меняется
  const mine = p.id === s.current;
  const now = mine && s.until !== undefined ? s.until : s.t;
  const seen = mine && s.until !== undefined ? seenAt(p, s.until) : p;
  // полоса «Ждём» (0.6.0): ждём результатов или его самого с обследования (0.5.12)
  const waits = mine && p.status === 'inRoom' && (seen.pending.length > 0 || (p.out !== undefined && p.out.back > now));
  // приём врача идёт (часть 19): врач записывает вопрос или осмотр сразу, со временем конца —
  // до него это «идёт», как анализ
  const watching = p.by !== undefined && !p.closed;
  const arrived = arrivedOf(seen, watching ? s.t : Infinity);
  const asking = watching ? p.results.filter(r => r.at > s.t).map(r => ({ exam: r.exam, readyAt: minuteOfDay(r.at) })) : [];
  const prev = p.returnOf ? s.patients[p.returnOf] : undefined;
  // у постели в смотровой приёмного (часть 37): ЭКГ монитором — 5 минут, без очереди и описания
  const bedside: Record<Id, number> = {};
  if (!p.closed && !watching) {
    for (const [eid, e] of Object.entries(db.exams)) if (e.bedside && bedsideOf(db, s, p, eid)) bedside[eid] = e.bedside.time.procedure;
  }
  const unavailable: Record<Id, string> = Object.fromEntries(Object.entries(unavailableOf(s)).filter(([eid]) => bedside[eid] === undefined));
  // умения дня (spec 2026-10-skills): вопрос расспроса у вас — короче, и в списке — его настоящие минуты
  const minutes: Record<Id, number> = {};
  if (!p.closed && !watching) {
    for (const [eid, e] of Object.entries(db.exams)) {
      const m = askMinutes(db, s.meta.skills, e, e.time.procedure);
      if (m !== e.time.procedure) minutes[eid] = m + (e.time.report ?? 0) + (e.time.turnaround ?? 0);
    }
  }
  // ушёл на обследование в другой кабинет (0.5.12): что делают при нём — когда вернётся; в другой кабинет — можно
  if (mine && p.out !== undefined && p.out.back > now) {
    const why = T.spikes.patient.awayExam(hhmm(minuteOfDay(p.out!.back)));
    for (const eid of Object.keys(db.exams)) if (!unavailable[eid] && !p.done.includes(eid) && atDoctor(db, s, p, eid)) unavailable[eid] = why;
  }
  // испытание «Смены» (часть 91, spec 2026-10-challenges): что оно запрещает вашему пациенту — серым и почему
  const challenges = p.by ? undefined : s.meta.challenges;
  if (challenges && !p.closed) {
    for (const eid of Object.keys(db.exams)) {
      if (unavailable[eid] || p.done.includes(eid)) continue;
      const b = challengeBlock(db, challenges, p.spent.money, eid, bedside[eid] !== undefined);
      if (b) unavailable[eid] = b.challenge === 'thrifty' ? T.challenges.budgetLeft(T.common.rub(b.left)) : T.challenges.blocked[b.challenge];
    }
  }
  const view = makeCaseView({
    version,
    patient: p.patient,
    // у вас в кабинете — ваше время: конец последнего действия, пока больница его доживает (0.5.13)
    clock: minuteOfDay(now),
    minutesSpent: Math.round(p.spent.seconds / 60),
    money: p.spent.money,
    step: p.step,
    arrived,
    pending: [...asking, ...seen.pending.map(x => ({ exam: x.exam, readyAt: minuteOfDay(x.readyAt), ...(x.repeat ? { repeat: x.repeat } : {}) }))],
    // ушёл на обследование в другой кабинет (0.5.12): когда вернётся
    ...(mine && p.out && p.out.back > now ? { away: { exam: p.out.exam, back: minuteOfDay(p.out.back) } } : {}),
    // приём закрывается (0.5.13): разбор досчитывается в кадрах
    ...(p.id === sess.finishing ? { finishing: true as const } : {}),
    meanwhile: p.id === s.current ? sess.meanwhile : [],
    urgent: p.id === s.current && sess.urgent,
    alarm: p.id === s.current && sess.alarm,
    done: p.done,
    draft: p.draft,
    // приём нанятого врача — с досчитанным разбором: среди дня его бережливость ещё отложена (`reviewedCase`)
    decision: p.closed ? decisionFor(s.meta, p, arrived, outcomeKnown(s, p), reviewedCase(db, s, p)) : undefined,
    canSendAway: p.status === 'inRoom' && seen.pending.length > 0,
    // ждать нечего, а ждёт кто-то срочнее — «Попросить подождать» (часть 37)
    canStepOut: p.status === 'inRoom' && seen.pending.length === 0 && moreUrgent(db, s, p),
    // ждём результатов, а ждёт кто-то срочнее, и сколько минут ждать (замечание владельца 24.10.2026: назначил рентген,
    // нажал «Подождать» — привезённый скорой ждал те же полчаса); строка — когда его можно отпустить: идёт обратно
    // с готовым результатом — нельзя, вернётся — «Попросить подождать»
    ...(waits ? { urgentWaiting: seen.pending.length > 0 && moreUrgent(db, s, p), waitMinutes: Math.max(1, Math.ceil((waitUntil(s, p) - now) / 60)) } : {}),
    returnNote: p.returnReason && prev?.closed ? T.shift.returnNote(p.returnReason, closedDay(prev), female(p)) : undefined,
    difficulty: s.meta.difficulty ?? 'doctor',
    // и в практике: кабинета УЗИ в амбулатории нет (часть 29)
    unavailable,
    // испытания (часть 91): какие — карте; у «Скупого главврача» — сколько осталось на пациента
    ...(challenges ? { challenges, ...(challenges.includes('thrifty') ? { budget: { left: Math.max(0, BUDGET - p.spent.money), of: BUDGET } } : {}) } : {}),
    // сценарий «Зимний грипп» (часть 91): «Похоже на» знает об эпидемии
    ...(scenarioPrior(s.meta.scenario) ? { prior: scenarioPrior(s.meta.scenario) } : {}),
    ...(Object.keys(bedside).length > 0 ? { bedside } : {}),
    ...(Object.keys(minutes).length > 0 ? { minutes } : {}),
    // лечение у постели (часть 39а): тромболизис — лежащему под монитором
    bedsideEquipment: bedsideEquipment(db, s, p),
    // лечение в кабинете (spec 2026-10-chapter-4, часть 53а): гемостаз — где работает эндоскопический кабинет
    rooms: hospitalCtx(db, s).rooms,
    // лечение реанимации (spec 2026-10-chapter-4, часть 47): ИВЛ — если в ней есть свободная койка
    ...(ricuBeds(db, s).length > 0 ? { ricu: freeRicuBeds(db, s).length > 0 ? 'free' as const : 'full' as const } : {}),
    ...(p.by ? {} : { targets: targetLines(s, p) }),
    // с какими отделениями его приняли (часть 30): с приёмным — и хирургия
    ...(p.departments ? { departments: p.departments } : {}),
    // своя палата, своя палата интенсивной терапии (часть 38а) или боксы (часть 49а) — выбор больницы
    ...(wardBeds(db, s).length > 0 || hospitalCtx(db, s).plan.rooms.some(r => db.rooms[r.type]?.icu || db.rooms[r.type]?.box) ? { settings: settingOptions(s, p) } : {}),
    ...(p.payer ? { payerNote: T.sandbox.payerNote[p.payer] } : {}),
    ...(p.paid && p.closed ? { payment: paymentText(db, p.payer ?? 'oms', p.paid, p.closed) } : {}),
    ...(p.closed ? { achievements: achievementNames(caseKey(s.meta.seed, p.id)) } : {}),
    // нанятый врач: его приём идёт — только для чтения; закрыт — кто вёл (часть 19)
    ...(p.by && !p.closed ? { colleague: colleagueOf(s, p) } : {}),
    ...(p.closed?.by ? { byDoctor: byDoctorLine(s, p.closed.by) } : {}),
  });
  return withMeasures(s, p, now, view);
}

/**
 * Первые меры в карте (spec 2026-10-first-measures, часть 95): лежит в смотровой — монитор и кнопки мер; данная мера — в
 * листе назначений отмечена, с временем, снять её нельзя.
 */
function withMeasures(s: ShiftState, p: ShiftPatient, now: number, view: VisitView): VisitView {
  const measures = p.by === undefined ? firstMeasuresOf(s, p, now) : undefined;
  const given = new Map((p.measures ?? []).map(m => [m.tx, m.done] as const));
  if (!measures && given.size === 0) return view;
  const lock = (x: VisitView['treatments'][number]): VisitView['treatments'][number] =>
    (given.has(x.id) ? { ...x, warning: T.shift.ambulance.given(hhmm(minuteOfDay(given.get(x.id)!))), locked: true } : x);
  return {
    ...view, ...(measures ? { measures } : {}),
    treatments: view.treatments.map(lock), suggested: view.suggested.map(lock), treatmentGroups: view.treatmentGroups.map(g => ({ ...g, items: g.items.map(lock) })),
  };
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
