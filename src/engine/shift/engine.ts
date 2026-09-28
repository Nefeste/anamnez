// Движок смены: приход пациентов, сортировка, очередь, терпение, обследования со своими
// сроками, закрытие случая и дня (spec 2026-09-first-shift, «Движок»; ADR 0005).
//
// Две точки входа, как в `06-architecture.md` §2: `apply(state, command)` — действие врача,
// которое двигает часы на свою цену, и команда `advance` — время на карте. Состояние
// меняется на месте; случайность — только из именованных ветвей зерна смены (ADR 0004).
import type { ContentDb, Id, Season } from '../../content/types';
import { fnv1a } from '../core/hash';
import {
  caseIncome, consumablesOf, emptyLedger, expensesOf, flowOf, incomeOf, interestOf, type Ledger, levelOf, payerOf, reputationAfter, salariesOf, upkeepOf,
} from '../economy/economy';
import { campaignEvening, chapterOf, startChapter } from '../campaign/campaign';
import { build, emptyPlot, type HospitalState, type Plan, planOf, presetHospital, UNDO_DEPTH } from '../hospital/build';
import { DOCTOR, doctorRoom, examWhere, openBlocks, type Staffing, workingRooms } from '../hospital/requirements';
import { applicantsOf, doctorOf, grow, memberAt, presetStaff, readingOf, type StaffMember, speedOf, staffingOf } from '../hospital/staff';
import { RNG_VERSION, Rng } from '../core/rng';
import { observe } from '../med/course';
import { complaintObservations, type ExamSkill, NORMAL_SKILL, runExam } from '../med/exams';
import { generatePatient, typicalPatient } from '../med/generate';
import { knownFacts, posterior } from '../med/infer';
import { evaluatePlan } from '../med/plan';
import { examCost, indicated, nextStep } from '../med/policy';
import { buildReview, type ReviewData } from '../med/review';
import { scoreCase } from '../med/score';
import type { Observation } from '../med/types';
import {
  type ClosedCase, type ColleagueDay, type Command, DAY, type DaySummary, type Difficulty, type Notice, type PlannedReturn, SHIFT_END, SHIFT_SCHEMA_VERSION,
  SHIFT_START, type ShiftEvent, type ShiftPatient, type ShiftState, type Triage, type VisitKind,
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

// --- больница смены: план, штат, что работает (spec 2026-09-own-hospital, часть 8) ------------

/** Больница смены: план, штат, кто на месте, какие помещения работают, стулья, есть ли доврачебный. */
export interface HospitalCtx {
  plan: Plan;
  staff: StaffMember[];
  staffed: Staffing;
  working: Set<string>;
  seats: number;
  triage: boolean;
}

const presets = new WeakMap<ContentDb, { hospital: HospitalState; staff: StaffMember[] }>();
const ctxs = new WeakMap<HospitalState, WeakMap<StaffMember[], HospitalCtx>>();

/** Практика — готовая амбулатория каталога со своим штатом; песочница — своя больница. */
function presetOf(db: ContentDb) {
  let p = presets.get(db);
  if (!p) {
    const rec = db.presets['preset.clinic'];
    p = { hospital: presetHospital(db, rec).hospital, staff: presetStaff(db, rec) };
    presets.set(db, p);
  }
  return p;
}

/**
 * План и штат меняются только между сменами, и каждый раз — новым объектом: за день план
 * строится один раз.
 */
export function hospitalCtx(db: ContentDb, s: ShiftState): HospitalCtx {
  const hospital = s.hospital ?? presetOf(db).hospital;
  const staff = s.staff ?? presetOf(db).staff;
  let byStaff = ctxs.get(hospital);
  if (!byStaff) {
    byStaff = new WeakMap();
    ctxs.set(hospital, byStaff);
  }
  let c = byStaff.get(staff);
  if (!c) {
    const plan = planOf(db, hospital);
    const staffed = staffingOf(db, plan, staff);
    const working = workingRooms(db, plan, staffed);
    const live = plan.rooms.filter(r => working.has(r.id));
    c = { plan, staff, staffed, working, seats: live.reduce((n, r) => n + r.seats.length, 0), triage: live.some(r => r.type === 'room.triage') };
    byStaff.set(staff, c);
  }
  return c;
}
/** «Студент»: обследования не ошибаются, пациенты ждут в полтора раза дольше (03-game-design.md §14). */
const exact = (s: ShiftState) => s.meta.difficulty === 'student';
const STUDENT_PATIENCE = 1.5;

export function newShift(db: ContentDb, opts: { seed: number; season: Season; department?: Id; difficulty?: Difficulty }): ShiftState {
  const s: ShiftState = {
    meta: {
      schemaVersion: SHIFT_SCHEMA_VERSION, contentVersion: db.contentVersion, rngVersion: RNG_VERSION, mode: 'shift',
      seed: opts.seed >>> 0, season: opts.season, department: opts.department ?? 'dept.therapy', difficulty: opts.difficulty ?? 'doctor',
    },
    t: SHIFT_START,
    day: 1,
    dayOpen: true,
    patients: {},
    queue: [],
    events: [],
    seq: 0,
    rooms: {},
    returns: [],
    summary: emptySummary(1),
    history: [],
    journal: [],
  };
  planDay(db, s);
  return s;
}

/**
 * Песочница — своя больница (spec 2026-09-own-hospital): день 0, смена ещё не открыта, касса
 * по выбранному бюджету. С готовой амбулаторией — та же амбулатория, что в практике, в углу
 * участка, а денег — только доля бюджета.
 */
export function newSandbox(db: ContentDb, opts: { seed: number; season: Season; difficulty?: Difficulty; start: 'empty' | 'clinic'; budget: number }): ShiftState {
  const sb = db.economy.sandbox;
  const [w, h] = sb.plot;
  const hospital = opts.start === 'clinic'
    ? presetHospital(db, db.presets['preset.clinic'], sb.plot).hospital
    : emptyPlot(w, h, sb.entrance, sb.corridor);
  const cash = opts.start === 'clinic' ? Math.floor((opts.budget * sb.clinicShare) / 100) : opts.budget;
  const staff = opts.start === 'clinic' ? presetStaff(db, db.presets['preset.clinic']) : [];
  const hired = applicantsOf(db, opts.seed >>> 0, 0, 1);
  return {
    meta: {
      schemaVersion: SHIFT_SCHEMA_VERSION, contentVersion: db.contentVersion, rngVersion: RNG_VERSION, mode: 'sandbox', start: opts.start,
      seed: opts.seed >>> 0, season: opts.season, department: 'dept.therapy', difficulty: opts.difficulty ?? 'doctor',
    },
    t: 0,
    day: 0,
    dayOpen: false,
    patients: {},
    queue: [],
    events: [],
    seq: 0,
    rooms: {},
    returns: [],
    summary: emptySummary(0),
    history: [],
    journal: [],
    hospital,
    economy: { cash, reputation: db.economy.reputation.start, ledger: emptyLedger() },
    undo: [],
    staff,
    candidates: hired.list,
    nextStaff: hired.next,
  };
}

/** Где идёт «Смена»: своя больница из песочницы — не запись базы. */
export const SANDBOX_VENUE = 'sandbox';

/**
 * «Смена» (spec 2026-09-campaign, часть 14): один день в выбранной больнице — готовой из базы
 * (амбулатория практики, больница главы) или копии своей из песочницы, со своим штатом. Кассы
 * нет, как в практике; итог — по категориям (src/state/single.ts).
 */
export function newSingle(
  db: ContentDb,
  opts: { seed: number; season: Season; difficulty?: Difficulty; venue: Id; hospital?: HospitalState; staff?: StaffMember[] },
): ShiftState {
  const s = newShift(db, opts);
  s.meta.mode = 'single';
  s.meta.venue = opts.venue;
  // амбулатория практики — та, что у движка по умолчанию; другая готовая — из её записи
  const rec = db.presets[opts.venue];
  if (opts.venue !== 'preset.clinic' && rec) {
    s.hospital = presetHospital(db, rec).hospital;
    s.staff = presetStaff(db, rec);
  } else if (opts.hospital) {
    // копия: смена своей больницы не меняет песочницу
    s.hospital = JSON.parse(JSON.stringify(opts.hospital)) as HospitalState;
    s.staff = JSON.parse(JSON.stringify(opts.staff ?? [])) as StaffMember[];
  }
  return s;
}

/**
 * Кого нанимают в главе кампании: тех, кому не нужно своё помещение, или чьё помещение глава
 * строит, — терапевты придут с главой, где откроется ординаторская (spec 2026-09-hired-doctors).
 */
function builtIn(db: ContentDb, build: readonly Id[]): (role: Id) => boolean {
  return role => {
    const needs = db.roles[role]?.needs;
    return !needs || build.includes(needs);
  };
}

/**
 * Кампания (spec 2026-09-campaign): карьера в слоте `career`, первая глава — по порядку.
 * Больница главы — её готовая больница на участке песочницы со штатом, касса — бюджет главы;
 * в начале — письма «в начале главы». Остальное — как в песочнице.
 */
export function newCampaign(db: ContentDb, opts: { seed: number; season: Season; difficulty?: Difficulty; career: number; chapter?: Id }): ShiftState {
  const ch = opts.chapter ? db.chapters[opts.chapter] : Object.values(db.chapters)[0];
  const preset = db.presets[ch.preset];
  const hired = applicantsOf(db, opts.seed >>> 0, 0, 1, builtIn(db, ch.build));
  return {
    meta: {
      schemaVersion: SHIFT_SCHEMA_VERSION, contentVersion: db.contentVersion, rngVersion: RNG_VERSION, mode: 'campaign', career: opts.career,
      seed: opts.seed >>> 0, season: opts.season, department: ch.department, difficulty: opts.difficulty ?? 'doctor',
    },
    t: 0,
    day: 0,
    dayOpen: false,
    patients: {},
    queue: [],
    events: [],
    seq: 0,
    rooms: {},
    returns: [],
    summary: emptySummary(0),
    history: [],
    journal: [],
    hospital: presetHospital(db, preset, db.economy.sandbox.plot).hospital,
    economy: { cash: ch.budget, reputation: db.economy.reputation.start, ledger: emptyLedger() },
    undo: [],
    staff: presetStaff(db, preset),
    candidates: hired.list,
    nextStaff: hired.next,
    campaign: startChapter(db, ch.id, 0),
  };
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
      closeDay(db, s);
      return [];
    case 'nextDay':
      nextDay(db, s);
      return [];
    case 'build':
    case 'undo':
    case 'buildEnd':
      building(db, s, cmd);
      return [];
    case 'hire':
    case 'fire':
    case 'assign':
      hiring(db, s, cmd);
      return [];
    case 'takeOver':
      return takeOver(db, s, cmd.id);
  }
}

/** Найм — только в песочнице и между сменами. Назначенный на занятое место сменяет того, кто там был, — тот в резерв. */
function hiring(db: ContentDb, s: ShiftState, cmd: Extract<Command, { kind: 'hire' | 'fire' | 'assign' }>) {
  if (!s.staff || !s.hospital || s.dayOpen) return;
  if (cmd.kind === 'hire') {
    const c = s.candidates?.find(x => x.id === cmd.id);
    if (!c) return;
    s.staff = [...s.staff, c];
    s.candidates = (s.candidates ?? []).filter(x => x.id !== cmd.id);
    return;
  }
  const m = s.staff.find(x => x.id === cmd.id);
  if (!m) return;
  if (cmd.kind === 'fire') {
    s.staff = s.staff.filter(x => x.id !== cmd.id);
    return;
  }
  if (cmd.room !== undefined) {
    const room = s.hospital.rooms.find(r => r.id === cmd.room);
    // встающий на чужое место (терапевт) — на место врача, но в вашем кабинете врач — вы
    const post = db.roles[m.role]?.stands ?? m.role;
    if (!room || !db.rooms[room.type].staff.includes(post)) return;
    if (post === DOCTOR && room.id === doctorRoom(hospitalCtx(db, s).plan)) return;
  }
  s.staff = s.staff.map(x => {
    if (x.id === m.id) return cmd.room === undefined ? { ...x, room: undefined } : { ...x, room: cmd.room };
    if (cmd.room !== undefined && x.room === cmd.room && x.role === m.role) return { ...x, room: undefined };
    return x;
  });
}

/** Стройка — только в песочнице и только между сменами (ADR 0016); ошибка — ничего не меняется. */
function building(db: ContentDb, s: ShiftState, cmd: Extract<Command, { kind: 'build' | 'undo' | 'buildEnd' }>) {
  if (!s.hospital || !s.economy || s.dayOpen) return;
  if (cmd.kind === 'buildEnd') {
    s.undo = [];
    return;
  }
  if (cmd.kind === 'undo') {
    const prev = s.undo?.pop();
    if (prev) {
      s.hospital = prev.hospital;
      s.economy.cash = prev.cash;
    }
    return;
  }
  // в главе кампании строят только то, что глава разрешает
  if (s.campaign && cmd.cmd.kind === 'room' && !chapterOf(db, s.campaign)?.build.includes(cmd.cmd.type)) return;
  const r = build(db, { hospital: s.hospital, cash: s.economy.cash }, cmd.cmd);
  if (!r.ok) return;
  s.undo = [...(s.undo ?? []), { hospital: s.hospital, cash: s.economy.cash }].slice(-UNDO_DEPTH);
  s.hospital = r.state.hospital;
  s.economy.cash = r.state.cash;
  // снесли помещение — кто в нём работал, в резерве
  const gone = cmd.cmd.kind === 'demolish' ? cmd.cmd.room : undefined;
  if (gone && s.staff?.some(m => m.room === gone)) s.staff = s.staff.map(m => (m.room === gone ? { ...m, room: undefined } : m));
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
  // песочница: с репутацией записываются и приходят чаще или реже (spec 2026-09-own-hospital)
  const flow = s.economy ? flowOf(db, s.economy.reputation ?? db.economy.reputation.start) : 100;
  const plan: { t: number; kind: VisitKind; key: string; ret?: PlannedReturn }[] = [];
  // запись: у вашего кабинета и у каждого нанятого врача — своя (spec 2026-09-hired-doctors);
  // ветви вашей записи — прежние, поэтому без врачей день тот же
  const desks = colleaguesOf(db, s).length;
  for (let k = 0; k <= desks; k++) {
    for (let slot = 0; slot < SLOTS; slot++) {
      const key = k === 0 ? `slot:${slot}` : `desk:${k}:slot:${slot}`;
      const sr = r.fork(key);
      if (!sr.chance(Math.min(10000, Math.round((SLOT_BOOKED * flow) / 100)))) continue;
      const late = sr.range(-5, 10);
      plan.push({ t: base + SHIFT_START + Math.max(0, slot * SLOT_MIN + late) * MIN, kind: 'appointment', key });
    }
  }
  const wr = r.fork('walk-ins');
  const walkIns = Math.round((wr.range(WALK_INS[0], WALK_INS[1]) * flow) / 100);
  for (let i = 0; i < walkIns; i++) {
    const w = wr.fork(`walk:${i}`);
    const minute = Math.min(w.range(0, 330), w.range(0, 330)); // меньшее из двух — ближе к утру
    plan.push({ t: base + SHIFT_START + minute * MIN, kind: 'walkIn', key: `walk:${i}` });
  }
  for (const ret of s.returns.filter(x => x.day === d)) {
    plan.push({ t: base + SHIFT_START + r.fork(`return:${ret.of}`).range(0, 120) * MIN, kind: 'return', key: `return:${ret.of}`, ret });
  }
  plan.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1));
  // кампания: в первый день главы первые пришедшие — с болезнями, заданными главой (обучение
  // с наставником); человек — тот же, что пришёл бы, если болезнь у него обычна
  const tutorial = s.campaign && d === s.campaign.since + 1 ? (chapterOf(db, s.campaign)?.tutorial ?? []) : [];
  let taught = 0;
  plan.forEach((a, i) => {
    const id = `${d}-${String(i + 1).padStart(2, '0')}`;
    const gen = { department: s.meta.department, season: s.meta.season };
    const primary = a.ret ? undefined : tutorial[taught];
    if (primary) taught++;
    const patient = a.ret
      ? returningPatient(db, s, a.ret)
      : primary
        ? typicalPatient(db, k => fnv1a(`${s.meta.seed}:${d}:${a.key}${k ? `:${k}` : ''}`), { ...gen, primary })
        : generatePatient(db, fnv1a(`${s.meta.seed}:${d}:${a.key}`), gen);
    s.patients[id] = {
      id, patient, arriveT: a.t, kind: a.kind, triage: 'green', status: 'coming', queuedT: 0, wait: 0, patience: 0,
      results: [], pending: [], done: [], step: 0, spent: { seconds: 0, money: 0 }, draft: { treatments: [], setting: 'home' },
      ...(a.ret ? { returnOf: a.ret.of, returnReason: a.ret.reason } : {}),
      ...(s.economy ? { payer: payerOf(db, s.meta.seed, id, s.economy.reputation ?? db.economy.reputation.start) } : {}),
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

function closeDay(db: ContentDb, s: ShiftState) {
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
  if (s.economy && s.hospital) settle(db, s);
  s.history.push({ ...s.summary, grades: { ...s.summary.grades } });
  // кампания: задания и письма — по итогам дня, в том числе сегодняшнего
  if (s.campaign) {
    const got = campaignEvening(db, { campaign: s.campaign, history: s.history, hospital: s.hospital, staff: s.staff }, s.day);
    s.summary.campaign = got;
    s.history[s.history.length - 1].campaign = got;
  }
  // песочница: кто работал — на смену опытнее; вечером — новые кандидаты
  if (s.staff && s.hospital) {
    s.staff = s.staff.map(m => grow(db, m));
    const c = applicantsOf(db, s.meta.seed, s.day, s.nextStaff ?? 1, s.campaign ? builtIn(db, chapterOf(db, s.campaign)?.build ?? []) : undefined);
    s.candidates = c.list;
    s.nextStaff = c.next;
  }
}

function ledgerOf(s: ShiftState): Ledger {
  const e = s.economy!;
  e.ledger ??= emptyLedger();
  return e.ledger;
}

/**
 * Вечер в песочнице: зарплаты, содержание аппаратов и помещений, процент на долг; касса;
 * репутация за день — и всё это в итоги дня (spec 2026-09-own-hospital, часть 9).
 */
function settle(db: ContentDb, s: ShiftState) {
  const e = s.economy!;
  const ledger = ledgerOf(s);
  const upkeep = upkeepOf(db, s.hospital!);
  ledger.expenses.salaries = salariesOf(s.staff ?? []);
  ledger.expenses.equipment = upkeep.equipment;
  ledger.expenses.rooms = upkeep.rooms;
  const before = e.cash + incomeOf(ledger) - expensesOf(ledger);
  ledger.expenses.interest = interestOf(db, before);
  e.cash = before - ledger.expenses.interest;
  const today = Object.values(s.patients).filter(p => Math.floor(p.arriveT / DAY) + 1 === s.day);
  const waits = today.filter(p => p.calledT !== undefined).map(p => (p.calledT! - p.arriveT) / MIN);
  const ctx = hospitalCtx(db, s);
  // репутация — по всем приёмам больницы: и вашим, и нанятых врачей
  const col = Object.values(s.summary.colleagues ?? {});
  const change = reputationAfter(db, e.reputation ?? db.economy.reputation.start, {
    arrived: s.summary.arrived, left: s.summary.left, unseen: s.summary.unseen,
    correct: col.reduce((n, c) => n + c.correct, s.summary.correct), wrong: col.reduce((n, c) => n + c.wrong, s.summary.wrong),
    returned: today.filter(p => p.kind === 'return' && (p.returnReason === 'worse' || p.returnReason === 'reaction')).length,
    ...(waits.length > 0 ? { meanWait: waits.reduce((a, b) => a + b, 0) / waits.length } : {}),
    toilet: ctx.plan.rooms.some(r => r.type === 'room.toilet' && ctx.plan.connected[r.id]),
  });
  e.reputation = change.to;
  s.summary.economy = {
    ledger: { income: { ...ledger.income }, cases: { ...ledger.cases }, expenses: { ...ledger.expenses }, audit: { ...ledger.audit } },
    cash: e.cash, reputation: change, level: levelOf(db, ctx.plan, ctx.working),
  };
}

/** Следующий день: часы — на 08:00, кабинеты свободны, план прихода с повторными обращениями. */
function nextDay(db: ContentDb, s: ShiftState) {
  if (s.dayOpen) return;
  // своя больница: без регистратуры, зоны ожидания и кабинета смену не открыть
  if (s.hospital) {
    const c = hospitalCtx(db, s);
    if (openBlocks(db, c.plan, c.working, c.staffed).length > 0) return;
    s.undo = [];
  }
  s.day++;
  s.t = (s.day - 1) * DAY + SHIFT_START;
  s.rooms = {};
  delete s.desk;
  if (s.economy) s.economy.ledger = emptyLedger();
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
  if (!s.dayOpen || s.current || !p || p.status !== 'waiting' || p.by) return [];
  s.queue = s.queue.filter(x => x !== id);
  p.status = 'inRoom';
  p.calledT ??= s.t;
  p.wait++; // прежняя проверка терпения недействительна
  s.current = id;
  return spend(db, s, p, MIN);
}

/**
 * Обследование текущему пациенту. Цена для врача — сама процедура; рентген и ЭКГ — назначить.
 * Сделать можно, только если в больнице работает его помещение с подходящим аппаратом и есть
 * где взять материал (spec 2026-09-own-hospital); иначе ничего не меняется. К аппарату —
 * очередь по помещению: снимок делают там, где освободятся раньше. Время — с поправкой
 * аппарата и человека, точность снимка — аппарата и рентгенолога; в готовой амбулатории
 * всё ровно как в базе.
 */
function exam(db: ContentDb, s: ShiftState, examId: Id): Notice[] {
  const p = current(s);
  const cost = p ? orderExam(db, s, p, examId) : null;
  return p && cost !== null ? spend(db, s, p, cost) : [];
}

/**
 * Назначить обследование пациенту — вашему или нанятого врача. Возвращает, сколько времени
 * занят врач (сама процедура в кабинете, у нанятого — с поправкой `pct` его навыка), или null —
 * сделать нельзя, ничего не меняется.
 */
function orderExam(db: ContentDb, s: ShiftState, p: ShiftPatient, examId: Id, pct = 100): number | null {
  const e = db.exams[examId];
  if (!e || p.done.includes(examId)) return null;
  const ctx = hospitalCtx(db, s);
  const where = examWhere(db, ctx.plan, ctx.working, ctx.staffed, examId);
  if ('block' in where) return null;
  const queued = e.kind === 'imaging' || e.kind === 'functional';
  const rooms = e.room ? where.rooms.map(id => ctx.plan.rooms.find(r => r.id === id)!) : [];
  const room = queued ? rooms.reduce((a, b) => ((s.rooms[b.id] ?? 0) < (s.rooms[a.id] ?? 0) ? b : a)) : rooms[0];
  const eqId = room?.equipment.find(x => x !== null && (e.equipment ?? []).includes(x)) ?? undefined;
  const eq = eqId ? db.equipment[eqId] : undefined;
  // время: аппарат и тот, кто делает (первая должность помещения), — в процентах записанного
  const roomPct = room ? Math.round((eq?.speed ?? 1) * speedOf(db, memberAt(ctx.staff, room.id, db.rooms[room.type].staff[0]))) : 100;
  let skill: ExamSkill = NORMAL_SKILL;
  if (room && e.kind === 'imaging') {
    const [rs, rp] = readingOf(db, memberAt(ctx.staff, room.id, 'role.radiologist'));
    skill = { sens: 1, spec: 1, sensPp: (eq?.quality.sens ?? 0) + rs, specPp: (eq?.quality.spec ?? 0) + rp };
  }

  // песочница: показано ли — по тому, что известно сейчас; показанные оплачивают ОМС и ДМС
  if (s.economy && e.cost > 0 && indicated(db, p.patient, observationsOf(p), candidatesOf(db, s.meta.department), examId)) (p.indicated ??= []).push(examId);
  p.step++;
  p.done.push(examId);
  p.spent.money += e.cost;
  if (!p.by) s.summary.money += e.cost; // в итогах — ваши обследования
  if (s.economy) ledgerOf(s).expenses.consumables += consumablesOf(db, e);
  const obs = runExam(db, p.patient, examId, branch(s, `exam:${p.id}:${p.done.length}:${examId}`), skill, exact(s));
  const after = (e.time.report ?? 0) + (e.time.turnaround ?? 0);
  if (queued && room) {
    const order = 2 * MIN;
    const start = Math.max(s.t + order, s.rooms[room.id] ?? 0);
    const end = start + Math.round((e.time.procedure * MIN * roomPct) / 100);
    s.rooms[room.id] = end;
    addPending(s, p, examId, end + after * MIN, obs, { room: room.id, start, end });
    return order;
  }
  const cost = Math.round((e.time.procedure * MIN * pct) / 100);
  // анализ: пока лаборатория готовит, — с поправкой лаборатории
  const wait = room ? Math.round((after * MIN * roomPct) / 100) : after * MIN;
  if (after > 0) addPending(s, p, examId, s.t + cost + wait, obs, room ? { room: room.id, start: s.t, end: s.t + cost } : undefined);
  else p.results.push({ exam: examId, obs, at: s.t + cost, step: p.step });
  return cost;
}

function addPending(s: ShiftState, p: ShiftPatient, examId: Id, readyAt: number, obs: Observation[], at?: { room: string; start: number; end: number }) {
  p.pending.push({ exam: examId, readyAt, obs, ...(at ?? {}) });
  schedule(s, readyAt, { kind: 'result', id: p.id });
}

function finish(db: ContentDb, s: ShiftState): Notice[] {
  const p = current(s);
  if (!p || !p.draft.diagnosis) return [];
  closePatient(db, s, p);
  s.current = undefined;
  return spend(db, s, p, 2 * MIN); // рецепт, направление
}

/**
 * Закрыть приём — ваш или нанятого врача: оценки, оплата, итоги дня, повторное обращение.
 * Приёмы врача идут в его строку итогов, а ваши строки — только о ваших приёмах.
 */
function closePatient(db: ContentDb, s: ShiftState, p: ShiftPatient): ClosedCase {
  // не дождались — результат приходит в пустоту: случай решён тем, что было известно
  p.pending = [];
  const closed = closeCase(db, s, p);
  if (p.by) closed.by = p.by;
  if (p.from) closed.from = p.from;
  p.closed = closed;
  p.status = 'done';
  // песочница: ОМС и ДМС платят после экспертизы, платный пациент — за всё сделанное
  if (s.economy) {
    const payer = p.payer ?? 'oms';
    const ctx = hospitalCtx(db, s);
    const x = caseIncome(db, payer, closed.diagnosis, p.done, p.indicated ?? [], closed.grades.defensibility, levelOf(db, ctx.plan, ctx.working).level);
    const ledger = ledgerOf(s);
    ledger.income[payer] += x.paid;
    ledger.cases[payer]++;
    ledger.audit.cut += x.cut;
    if (x.quality < 100) ledger.audit.weak++;
    if (x.unconfirmed) ledger.audit.unconfirmed++;
    ledger.audit.unindicated += x.unindicated.length;
    p.paid = x;
  }
  const sum = s.summary;
  if (p.by) {
    const c: ColleagueDay = ((sum.colleagues ??= {})[p.by] ??= { seen: 0, correct: 0, partly: 0, wrong: 0, grades: { A: 0, B: 0, C: 0, D: 0 } });
    c.seen++;
    c[closed.verdict]++;
    c.grades[closed.grades.overall]++;
  } else {
    sum.seen++;
    sum[closed.verdict]++;
    sum.grades[closed.grades.overall]++;
    // кампания: антибиотик, который не показан, — для задания «дни без него»
    if (s.campaign && closed.notes.some(n => n.code === 'tx.notIndicated' && db.treatments[n.tx]?.class?.startsWith('antibiotic.'))) {
      sum.needlessAntibiotic = (sum.needlessAntibiotic ?? 0) + 1;
    }
  }
  const back = closed.outcome.returns;
  if (back) {
    s.returns.push({ day: s.day + Math.max(1, back.day), of: p.id, reason: back.reason });
    sum.returnsPlanned++;
  }
  return closed;
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
      results(s, s.patients[ev.id], notices);
      return staffDesks(db, s);
    case 'patience': {
      const p = s.patients[ev.id];
      if (p.status !== 'waiting' || p.wait !== ev.wait) return;
      p.status = 'left';
      s.queue = s.queue.filter(x => x !== p.id);
      s.summary.left++;
      notices.push({ kind: 'left', id: p.id });
      return;
    }
    case 'colleague':
      return colleagueStep(db, s, s.patients[ev.id]);
    case 'free':
      return staffDesks(db, s);
    case 'shiftEnd':
      notices.push({ kind: 'shiftEnd' });
  }
}

/** Пришёл: медсестра меряет витальные и сортирует — по тому, что видит (жалобы и измерения). */
function arrive(db: ContentDb, s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  if (p.status !== 'coming') return;
  const ctx = hospitalCtx(db, s);
  // медсестра доврачебного кабинета меряет давление, пульс, температуру; нет её — врач сам
  if (ctx.triage && db.exams['exam.vitals']) {
    p.done.push('exam.vitals');
    p.results.push({ exam: 'exam.vitals', obs: runExam(db, p.patient, 'exam.vitals', branch(s, `vitals:${p.id}`), undefined, exact(s)), at: s.t, step: 0 });
  }
  p.triage = triageOf(db, p);
  if (!ctx.triage) p.triaged = false;
  const [lo, hi] = p.triage === 'red' ? [0, 0] : PATIENCE[p.triage];
  p.patience = Math.round(branch(s, `patience:${p.id}`).range(lo, hi) * MIN * (s.meta.difficulty === 'student' ? STUDENT_PATIENCE : 1));
  // своя больница: пришёл в полную зону ожидания — стоит, и ждать готов вдвое меньше
  if (s.hospital && p.patience > 0 && s.queue.length >= ctx.seats) p.patience = Math.round(p.patience / 2);
  s.summary.arrived++;
  if (p.kind === 'return') s.summary.returnsToday++;
  enqueue(s, p, s.t);
  notices.push({ kind: 'arrived', id: p.id, triage: p.triaged === false ? 'green' : p.triage });
  staffDesks(db, s);
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
  // срочность, если её определили (есть доврачебный кабинет), затем — кто раньше
  const rank = (q: ShiftPatient) => (q.triaged === false ? TRIAGE_RANK.green : TRIAGE_RANK[q.triage]);
  s.queue = [...s.queue.filter(x => x !== p.id), p.id].sort((a, b) => {
    const x = s.patients[a];
    const y = s.patients[b];
    return rank(x) - rank(y) || x.queuedT - y.queuedT || (a < b ? -1 : 1);
  });
  if (p.patience > 0) schedule(s, s.t + p.patience, { kind: 'patience', id: p.id, wait: p.wait });
}

/** Результаты пришли. Ушедший на анализы возвращается в очередь — впереди, по времени прихода. */
function results(s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  const ready = p.pending.filter(x => x.readyAt <= s.t).sort((a, b) => a.readyAt - b.readyAt || (a.exam < b.exam ? -1 : 1));
  if (ready.length === 0) return;
  p.pending = p.pending.filter(x => x.readyAt > s.t);
  for (const x of ready) p.results.push({ exam: x.exam, obs: x.obs, at: x.readyAt, step: p.step });
  if (p.status === 'away' && p.pending.length === 0 && p.by) {
    // пациент нанятого врача ждёт его, а не общей очереди: врач позовёт, когда освободится
    p.status = 'waiting';
    p.queuedT = s.t;
    p.wait++;
  } else if (p.status === 'away' && p.pending.length === 0) {
    enqueue(s, p, p.arriveT);
    notices.push({ kind: 'resultsReady', id: p.id });
  } else if (p.status === 'inRoom' && !p.by) {
    // у нанятого врача результаты ждёт он сам — его следующий шаг уже назначен
    notices.push({ kind: 'resultsReady', id: p.id });
  }
}

// --- нанятые врачи (spec 2026-09-hired-doctors) -------------------------------------------

/**
 * Кто из нанятых врачей сегодня принимает: терапевт в работающем кабинете врача — не в вашем
 * и с местом в ординаторской. Порядок — по номеру кабинета, затем человека.
 */
function colleaguesOf(db: ContentDb, s: ShiftState): StaffMember[] {
  if (!s.hospital || !s.staff) return [];
  const ctx = hospitalCtx(db, s);
  const mine = doctorRoom(ctx.plan);
  return ctx.staff
    .filter(m => db.roles[m.role]?.stands === DOCTOR && m.room !== undefined && m.room !== mine && ctx.working.has(m.room) && ctx.staffed(m.room, DOCTOR))
    .sort((a, b) => (a.room! < b.room! ? -1 : a.room! > b.room! ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * Кого берёт нанятый врач: нового пациента, которого ещё никто не смотрел, — не «красного» по
 * сортировке, не повторное обращение и не того, кого вы отпустили ждать результатов. Без
 * доврачебного кабинета срочность никто не определил — берёт по очереди прихода.
 */
function colleagueTakes(p: ShiftPatient): boolean {
  return p.status === 'waiting' && p.by === undefined && p.calledT === undefined && p.kind !== 'return' && !(p.triaged !== false && p.triage === 'red');
}

/**
 * Свободные врачи зовут: сначала своего, вернувшегося с результатами, потом нового из очереди.
 */
function staffDesks(db: ContentDb, s: ShiftState) {
  if (!s.dayOpen) return;
  const list = colleaguesOf(db, s);
  if (list.length === 0) return;
  const all = Object.values(s.patients);
  const busy = new Set(all.flatMap(p => (p.status === 'inRoom' && p.by ? [p.by] : [])));
  for (const m of list) {
    if (busy.has(m.id) || (s.desk?.[m.id] ?? 0) > s.t) continue;
    const back = all.filter(p => p.status === 'waiting' && p.by === m.id).sort((a, b) => a.queuedT - b.queuedT || (a.id < b.id ? -1 : 1))[0];
    const id = back?.id ?? s.queue.find(x => colleagueTakes(s.patients[x]));
    if (!id) continue;
    const p = s.patients[id];
    s.queue = s.queue.filter(x => x !== id);
    p.status = 'inRoom';
    if (!back) {
      p.by = m.id;
      p.phase = {};
    }
    p.calledT ??= s.t;
    p.wait++; // прежняя проверка терпения недействительна
    p.spent.seconds += MIN;
    schedule(s, s.t + MIN, { kind: 'colleague', id });
    busy.add(m.id);
  }
}

/**
 * Забрать себе пациента нанятого врача (часть 19): со всем, что уже пришло, — сразу в ваш
 * кабинет, если вы свободны (врач доделывает начатый вопрос или осмотр), иначе в вашу очередь
 * по времени прихода; ушедший на обследования вернётся к вам. Назначенное врачом, что ещё
 * идёт, придёт вам. Врач свободен и зовёт следующего.
 */
function takeOver(db: ContentDb, s: ShiftState, id: string): Notice[] {
  const p = s.patients[id];
  if (!s.dayOpen || !p?.by || p.closed || !(p.status === 'inRoom' || p.status === 'waiting' || p.status === 'away')) return [];
  const by = p.by;
  delete p.by;
  delete p.phase;
  p.from = by;
  // начатый вопрос или осмотр врач доделывает: результат уже записан, со временем конца. Время
  // шага записано вперёд, до следующего шага; ожидание результатов у врача — не в счёт приёма
  const busy = Math.max(s.t, ...p.results.map(r => r.at));
  const step = s.events.find(e => e.event.kind === 'colleague' && e.event.id === id);
  if (step) {
    p.spent.seconds -= Math.max(0, step.t - busy);
    s.events = s.events.filter(e => e !== step);
  }
  const col = s.summary.colleagues?.[by] ?? { seen: 0, correct: 0, partly: 0, wrong: 0, grades: { A: 0, B: 0, C: 0, D: 0 } };
  col.taken = (col.taken ?? 0) + 1;
  (s.summary.colleagues ??= {})[by] = col;
  let notices: Notice[] = [];
  if (p.status !== 'away') {
    if (!s.current) {
      p.status = 'inRoom';
      p.wait++;
      s.current = p.id;
      // дослушать ответ у врача и дойти до вас
      notices = [...advanceBy(db, s, busy - s.t), ...spend(db, s, p, MIN)];
    } else {
      // впереди — по времени прихода, как вернувшийся с обследований
      enqueue(s, p, p.arriveT);
    }
  }
  staffDesks(db, s);
  return notices;
}

/** Обследования, которые в этой больнице можно сделать, — из них выбирает нанятый врач. */
const examLists = new WeakMap<HospitalCtx, Id[]>();
function examsHere(db: ContentDb, s: ShiftState): Id[] {
  const ctx = hospitalCtx(db, s);
  let list = examLists.get(ctx);
  if (!list) {
    list = Object.keys(db.exams).sort().filter(id => !('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, id)));
    examLists.set(ctx, list);
  }
  return list;
}

/**
 * Шаг нанятого врача: тот же разумный врач, что проверяет базу (`nextStep`), с порогами своего
 * навыка. Обследование — как у вас, следующий шаг — когда придут результаты; решение — приём
 * закрыт, пара минут на карту, и врач зовёт следующего.
 */
function colleagueStep(db: ContentDb, s: ShiftState, p: ShiftPatient) {
  if (!s.dayOpen || p.status !== 'inRoom' || !p.by) return;
  const m = hospitalCtx(db, s).staff.find(x => x.id === p.by);
  if (!m) return;
  const how = doctorOf(db, m);
  const pct = speedOf(db, m);
  const r = nextStep(db, p.patient, observationsOf(p), p.done, p.phase ?? {}, {
    candidates: candidatesOf(db, s.meta.department), exams: examsHere(db, s), threshold: how.threshold, minGain: how.minGain,
    // навык 1–2 иногда забывает спросить перед лечением — жребий своей ветви
    skipAsk: q => how.forget > 0 && branch(s, `forget:${p.id}:${q}`).chance(how.forget * 100),
  });
  p.phase = r.phase;
  if (r.step.kind === 'exam') {
    const cost = orderExam(db, s, p, r.step.exam, pct) ?? 0;
    if (!p.done.includes(r.step.exam)) p.done.push(r.step.exam); // сделать нельзя — дальше без него
    // результатов ждать, а в очереди есть кого принять, — отпустить ждать и позвать следующего, как вы
    if (p.pending.length > 0 && s.queue.some(x => colleagueTakes(s.patients[x]))) {
      p.status = 'away';
      p.wait++;
      const away = cost + MIN;
      p.spent.seconds += away;
      (s.desk ??= {})[m.id] = s.t + away;
      schedule(s, s.t + away, { kind: 'free', by: m.id });
      return;
    }
    const next = Math.max(s.t + cost, ...p.pending.map(x => x.readyAt));
    p.spent.seconds += next - s.t;
    schedule(s, next, { kind: 'colleague', id: p.id });
    return;
  }
  p.draft = { diagnosis: r.step.diagnosis, treatments: [...r.step.plan.treatments], setting: r.step.plan.setting };
  closePatient(db, s, p);
  const paper = Math.round((2 * MIN * pct) / 100);
  p.spent.seconds += paper;
  (s.desk ??= {})[m.id] = s.t + paper;
  schedule(s, s.t + paper, { kind: 'free', by: m.id });
}
