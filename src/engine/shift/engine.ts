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
  type WardClose, wardIncome,
} from '../economy/economy';
import { campaignEvening, chapterOf, startChapter } from '../campaign/campaign';
import { build, emptyPlot, type HospitalState, type Plan, planOf, presetHospital, UNDO_DEPTH } from '../hospital/build';
import { DOCTOR, doctorRoom, examWhere, openBlocks, type Problem, problemsOf, type Staffing, workingRooms } from '../hospital/requirements';
import { applicantsOf, doctorOf, grow, memberAt, presetStaff, readingOf, type StaffMember, speedOf, staffingOf } from '../hospital/staff';
import { RNG_VERSION, Rng } from '../core/rng';
import { observe } from '../med/course';
import { complaintObservations, type ExamSkill, examFits, NORMAL_SKILL, runExam } from '../med/exams';
import { generatePatient, typicalPatient } from '../med/generate';
import { contextOf, posterior } from '../med/infer';
import { scaleTriage } from '../med/news2';
import { choiceFor, evaluatePlan, primaryOf, recommendedSetting, settingFit, type Venue } from '../med/plan';
import { examCost, indicated, nextStep } from '../med/policy';
import { buildReview, type ReviewData } from '../med/review';
import { scoreCase } from '../med/score';
import type { Observation } from '../med/types';
import {
  type ClosedCase, type ColleagueDay, type Command, DAY, type DaySummary, type Difficulty, type Notice, type PlannedReturn, SHIFT_END, SHIFT_SCHEMA_VERSION,
  SHIFT_START, type ShiftEvent, type ShiftPatient, type ShiftState, type Triage, type VisitKind, type WardDay, type AmbulanceDay, type SurgeryDay,
} from './types';
import { COMPLICATION_DAYS, complicationAt, complicationsOf, deathsOf, onsetHours, operationFor } from './surgery';
import { type Bed, daysIn, type StayEnd, stayNorm, wardCourse, wardState } from './ward';

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
 * строит, — терапевты придут с главой, где откроется ординаторская (spec 2026-09-hired-doctors);
 * и только тех, кто работает в помещении, которое глава строит или которое уже стоит в её больнице:
 * хирург и анестезиолог — с главой, где есть операционная (spec 2026-09-chapter-2, часть 28).
 */
function builtIn(db: ContentDb, build: readonly Id[], preset?: Id): (role: Id) => boolean {
  const here = new Set([...build, ...(preset ? (db.presets[preset]?.rooms.map(r => r.type) ?? []) : [])]);
  return role => {
    const r = db.roles[role];
    if (!r || (r.needs && !build.includes(r.needs))) return false;
    return r.rooms.some(id => here.has(id));
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
  const hired = applicantsOf(db, opts.seed >>> 0, 0, 1, builtIn(db, ch.build, ch.preset));
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
      // из болезней отделений, с какими его приняли (часть 30): в амбулатории хирургии нет
      if (p && db.conditions[cmd.id]?.presenting && (p.departments ?? [s.meta.department]).includes(db.conditions[cmd.id].department)) {
        p.draft.diagnosis = cmd.id;
        // у нового диагноза операции здесь нет — в палату, а нет койки — скорая (часть 28)
        if (p.draft.setting === 'surgery' && !canOperate(db, s, cmd.id)) p.draft.setting = freeBeds(db, s).length > 0 ? 'admit' : 'ambulance';
      }
      return [];
    }
    case 'toggleTreatment': {
      const p = current(s);
      // операцию выбирают «В операционную», а не в списке лечения (часть 28)
      if (!p || !db.treatments[cmd.id] || db.treatments[cmd.id].kind === 'surgery') return [];
      const has = p.draft.treatments.includes(cmd.id);
      p.draft.treatments = has ? p.draft.treatments.filter(x => x !== cmd.id) : [...p.draft.treatments, cmd.id].sort();
      return [];
    }
    case 'setting': {
      const p = current(s);
      // в свою палату — только если есть свободная койка (часть 26); в операционную — если у
      // диагноза есть операция, операционная её делает и после неё есть койка (часть 28)
      const ok = cmd.setting === 'admit' ? freeBeds(db, s).length > 0 : cmd.setting === 'surgery' ? canOperate(db, s, p?.draft.diagnosis) : true;
      if (p && ok) p.draft.setting = cmd.setting;
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
    case 'discharge':
    case 'transfer':
      return leaveWard(db, s, cmd.id, cmd.kind);
    case 'replan':
      return replan(db, s, cmd.id, cmd.treatments);
    case 'sort':
      return sortAmbulance(db, s, cmd.id, cmd.triage);
    case 'operate':
      return operate(db, s, cmd.id);
    case 'soft':
      if (cmd.on) s.meta.soft = true;
      else delete s.meta.soft;
      return [];
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
  // скорая (spec 2026-09-chapter-2, часть 27): работает смотровая приёмного — машины в любое
  // время смены, из своей ветви дня; без смотровой день прежний
  if (emergencyBays(db, s).length > 0) {
    const a = db.economy.ambulance;
    const ar = r.fork('ambulance');
    const cars = ar.range(a.perDay[0], a.perDay[1]);
    for (let i = 0; i < cars; i++) {
      const minute = ar.fork(`amb:${i}`).range(0, (SHIFT_END - SHIFT_START) / MIN - 30);
      plan.push({ t: base + SHIFT_START + minute * MIN, kind: 'ambulance', key: `amb:${i}` });
    }
  }
  plan.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1));
  // кампания: в первый день главы первые пришедшие — с болезнями, заданными главой (обучение
  // с наставником); человек — тот же, что пришёл бы, если болезнь у него обычна
  const tutorial = s.campaign && d === s.campaign.since + 1 ? (chapterOf(db, s.campaign)?.tutorial ?? []) : [];
  let taught = 0;
  // какие отделения больница принимает сегодня (часть 30): с работающей смотровой приёмного — и хирургию
  const departments = departmentsOf(db, s);
  plan.forEach((a, i) => {
    const id = `${d}-${String(i + 1).padStart(2, '0')}`;
    const gen = { department: s.meta.department, departments, season: s.meta.season };
    const primary = a.ret || a.kind === 'ambulance' ? undefined : tutorial[taught];
    if (primary) taught++;
    const patient = a.ret
      ? returningPatient(db, s, a.ret)
      : a.kind === 'ambulance'
        ? ambulancePatient(db, s, d, a.key, departments)
        : primary
        ? typicalPatient(db, k => fnv1a(`${s.meta.seed}:${d}:${a.key}${k ? `:${k}` : ''}`), { ...gen, primary })
        : generatePatient(db, fnv1a(`${s.meta.seed}:${d}:${a.key}`), gen);
    // вернувшийся — и с теми отделениями, с какими его приняли в первый раз
    const own = a.ret ? [...new Set([...(s.patients[a.ret.of]?.departments ?? []), ...departments])] : departments;
    s.patients[id] = {
      id, patient, arriveT: a.t, kind: a.kind, triage: 'green', status: 'coming', queuedT: 0, wait: 0, patience: 0,
      results: [], pending: [], done: [], step: 0, spent: { seconds: 0, money: 0 }, draft: { treatments: [], setting: 'home' },
      ...(a.ret ? { returnOf: a.ret.of, returnReason: a.ret.reason } : {}),
      ...(own.length > 1 ? { departments: own } : {}),
      // скорая не платит отдельно: привезённый — случай ОМС (spec 2026-09-chapter-2, «Баланс»;
      // скорую и экстренную помощь оказывают бесплатно — 323-ФЗ, ст. 11 и 35)
      ...(s.economy ? { payer: a.kind === 'ambulance' ? 'oms' : payerOf(db, s.meta.seed, id, s.economy.reputation ?? db.economy.reputation.start) } : {}),
    };
    schedule(s, a.t, { kind: 'arrive', id });
  });
  schedule(s, base + SHIFT_END, { kind: 'shiftEnd' });
}

/**
 * Кого везёт скорая: человек — как любой пришедший, болезнь — из отделений больницы с весом у
 * него (возраст, привычки, камни — часть 30) и по тяжести: лёгкое не везут. У болезни с тяжестью
 * — чаще тяжёлая, жребий ветви машины.
 */
function ambulancePatient(db: ContentDb, s: ShiftState, d: number, key: string, departments: readonly Id[]) {
  const a = db.economy.ambulance;
  const severe = branch(s, `ambulance:${d}:${key}`).fork('severe').chance(a.severe * 100);
  return generatePatient(db, fnv1a(`${s.meta.seed}:${d}:${key}`), {
    department: s.meta.department, departments, season: s.meta.season, carried: a.weight, ...(severe ? { params: { severity: 'severe' } } : {}),
  });
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
  nightOperations(db, s);
  nightDeaths(db, s);
  const lying = inpatientsOf(s).length;
  if (lying > 0 || s.summary.ward) wardDay(s).lying = lying;
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
    const ch = s.campaign ? chapterOf(db, s.campaign) : undefined;
    const c = applicantsOf(db, s.meta.seed, s.day, s.nextStaff ?? 1, s.campaign ? builtIn(db, ch?.build ?? [], ch?.preset) : undefined);
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
  // лежащие ночуют в палате: койко-день у каждого (часть 26)
  ledger.expenses.ward = inpatientsOf(s).length * db.economy.ward.bedDay;
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
    ledger: {
      income: { ...ledger.income }, cases: { ...ledger.cases }, expenses: { ...ledger.expenses }, audit: { ...ledger.audit },
      ...(ledger.ward ? { ward: { ...ledger.ward } } : {}),
    },
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
  // ночью операционная не работала — утром бригада берёт очередь (часть 28)
  startOperations(db, s);
}

/**
 * Старое не храним: принятых — неделю (их исходы — в итогах следующих дней) и тех, к кому
 * ещё вернутся; ушедших и не принятых в прошлые дни — нет: их числа уже в итогах дня.
 */
function prune(s: ShiftState) {
  const keep = new Set(s.returns.filter(r => r.day >= s.day).map(r => r.of));
  for (const [id, p] of Object.entries(s.patients)) {
    const day = Number(id.split('-')[0]);
    if (keep.has(id) || day >= s.day || p.status === 'admitted') continue;
    if (day < s.day - 7 || p.status === 'left' || p.status === 'unseen') delete s.patients[id];
  }
  s.returns = s.returns.filter(r => r.day >= s.day);
}

// --- врач ---------------------------------------------------------------------------

function call(db: ContentDb, s: ShiftState, id: string): Notice[] {
  const p = s.patients[id];
  if (!s.dayOpen || s.current || !p || p.status !== 'waiting' || p.by) return [];
  // привезённого скорой сначала сортируют по листу передачи (часть 27)
  if (p.kind === 'ambulance' && !p.sorted) return [];
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
 * аппарата и человека, точность снимка — аппарата и того, кто описывает снимок; в готовой амбулатории
 * всё ровно как в базе.
 */
function exam(db: ContentDb, s: ShiftState, examId: Id): Notice[] {
  const p = current(s);
  const cost = p ? orderExam(db, s, p, examId) : null;
  return p && cost !== null ? spend(db, s, p, cost) : [];
}

/**
 * Точность снимка в помещении: поправка аппарата и того, кто снимки этого помещения описывает, —
 * в рентгене рентгенолога, в УЗИ врача УЗД (роль с `reads`, часть 29), п. п.
 */
export function imagingSkill(db: ContentDb, staff: readonly StaffMember[], room: { id: string; type: Id }, eqId?: Id): ExamSkill {
  const eq = eqId ? db.equipment[eqId] : undefined;
  const reader = db.rooms[room.type].staff.find(r => db.roles[r]?.reads);
  const [rs, rp] = readingOf(db, reader ? memberAt(staff, room.id, reader) : undefined);
  return { sens: 1, spec: 1, sensPp: (eq?.quality.sens ?? 0) + rs, specPp: (eq?.quality.spec ?? 0) + rp };
}

/**
 * Назначить обследование пациенту — вашему или нанятого врача. Возвращает, сколько времени
 * занят врач (сама процедура в кабинете, у нанятого — с поправкой `pct` его навыка), или null —
 * сделать нельзя, ничего не меняется.
 */
function orderExam(db: ContentDb, s: ShiftState, p: ShiftPatient, examId: Id, pct = 100): number | null {
  const e = db.exams[examId];
  if (!e || p.done.includes(examId) || !examFits(e, p.patient)) return null;
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
  const skill = room && e.kind === 'imaging' ? imagingSkill(db, ctx.staff, room, eqId) : NORMAL_SKILL;

  // песочница: показано ли — по тому, что известно сейчас; показанные оплачивают ОМС и ДМС
  if (s.economy && e.cost > 0 && indicated(db, p.patient, observationsOf(p), candidatesOf(db, p.departments ?? s.meta.department), examId)) (p.indicated ??= []).push(examId);
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
  // последнюю койку успели занять — направить в стационар другой больницы (часть 26); оперировать
  // этот диагноз здесь нечем или некому — вызвать скорую, как из амбулатории (часть 28)
  if (p.draft.setting === 'admit' && freeBeds(db, s).length === 0) p.draft.setting = 'ward';
  if (p.draft.setting === 'surgery' && !canOperate(db, s, p.draft.diagnosis)) p.draft.setting = 'ambulance';
  const closed = closeCase(db, s, p);
  if (p.by) closed.by = p.by;
  if (p.from) closed.from = p.from;
  p.closed = closed;
  p.status = 'done';
  // скорая (часть 27): сверка сортировки со шкалой — строкой разбора; место в смотровой свободно
  if (p.kind === 'ambulance' && p.sorted && p.scale) {
    const d = TRIAGE_RANK[p.triage] - TRIAGE_RANK[p.scale.triage];
    if (d !== 0) {
      closed.notes.push({ code: d > 0 ? 'triage.under' : 'triage.over', triage: p.scale.triage, news2: p.scale.news2, ...(p.scale.flag ? { flag: p.scale.flag } : {}) });
    }
  }
  if (p.bay) {
    delete p.bay;
    seatAtDoor(db, s);
  }
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
  if (closed.plan.setting === 'admit' || closed.plan.setting === 'surgery') admit(db, s, p);
  return closed;
}

/** Кандидаты вывода — всё, с чем приходят в это отделение. */
export function candidatesOf(db: ContentDb, department: Id | readonly Id[]): Id[] {
  const depts: readonly Id[] = typeof department === 'string' ? [department] : department;
  return Object.keys(db.conditions).filter(id => db.conditions[id].presenting && depts.includes(db.conditions[id].department)).sort();
}

/**
 * Какие отделения принимает больница смены (spec 2026-09-chapter-2, часть 30): своё и те, что
 * принимают её работающие помещения (`admits`: смотровая приёмного — хирургию). В амбулатории
 * практики и в главе 1 — только своё.
 */
export function departmentsOf(db: ContentDb, s: ShiftState): Id[] {
  const ctx = hospitalCtx(db, s);
  const out = [s.meta.department];
  for (const r of ctx.plan.rooms) {
    if (!ctx.working.has(r.id)) continue;
    for (const d of db.rooms[r.type]?.admits ?? []) if (!out.includes(d)) out.push(d);
  }
  return out;
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
  const candidates = candidatesOf(db, p.departments ?? s.meta.department);
  const beliefs = posterior(db, candidates, obs, contextOf(db, patient, obs));
  const confidence = beliefs.find(b => b.id === dx)?.p ?? 0;
  // в операционную — операцией поставленного диагноза (часть 28)
  const op = p.draft.setting === 'surgery' ? operationFor(db, dx) : undefined;
  const plan = { treatments: op ? [...new Set([...p.draft.treatments, op])].sort() : [...p.draft.treatments], setting: p.draft.setting };
  const ev = evaluatePlan(db, patient, plan, obs);
  const outcome = observe(db, patient, plan, ev, branch(s, `outcome:${p.id}`));
  const review = reviewOf(db, s, p, dx);
  const present = new Set(patient.truth.findings.map(f => f.f));
  const verdict = dx === truth ? 'correct' : group(dx) === group(truth) ? 'partly' : 'wrong';
  const score = scoreCase({
    verdict, confidence, cost: p.done.reduce((a, id) => a + examCost(db, id), 0), rationalCost: review.rational.cost,
    plan: ev, outcome, selfLimiting: cond.selfLimiting === true,
    redFlags: (cond.redFlags ?? []).filter(f => present.has(f)).map(f => ({ f, seen: obs.some(o => o.f === f && o.shown) })),
    // что было правильно выбрать здесь: со своей палатой — положить в неё, со своей операционной — оперировать
    should: choiceFor(recommendedSetting(db, patient), venueOf(db, s, plan.setting === 'admit' || plan.setting === 'surgery', operationFor(db, truth) ?? null)),
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

/**
 * Разбор по одной записи пациента: из смены нужны только зерно и отделение — так его строит и
 * архив профиля; отделения, с какими больница его приняла (часть 30), — в самой записи.
 */
export function reviewFor(db: ContentDb, meta: Pick<ShiftState['meta'], 'seed' | 'department'>, p: ShiftPatient, diagnosis: Id): ReviewData {
  const rng = Rng.seeded(meta.seed).fork(`review:${p.id}`);
  return buildReview(db, p.patient, p.results.map(r => ({ exam: r.exam, obs: r.obs })), diagnosis, candidatesOf(db, p.departments ?? meta.department), Object.keys(db.exams).sort(), rng);
}

// --- стационар (spec 2026-09-chapter-2, часть 26) ---------------------------------------------

/** Койки своей больницы в работающих палатах, по порядку помещений и коек. */
export function wardBeds(db: ContentDb, s: ShiftState): Bed[] {
  if (!s.hospital) return [];
  const ctx = hospitalCtx(db, s);
  return ctx.plan.rooms
    .filter(r => db.rooms[r.type]?.beds && ctx.working.has(r.id))
    .flatMap(r => r.beds.map((_, bed) => ({ room: r.id, bed })));
}

/** Свободные койки: работающие, на которых никто не лежит. */
export function freeBeds(db: ContentDb, s: ShiftState): Bed[] {
  const taken = new Set(Object.values(s.patients).filter(p => p.status === 'admitted' && p.stay).map(p => `${p.stay!.room}:${p.stay!.bed}`));
  return wardBeds(db, s).filter(b => !taken.has(`${b.room}:${b.bed}`));
}

/**
 * Что есть в больнице для решения «где лечить»: своя палата со свободной койкой (или уже занятой
 * этим пациентом); операционная, где сделают операцию `op` (не указана — хоть какую; `null` —
 * операции у болезни нет), и койка после неё.
 */
function venueOf(db: ContentDb, s: ShiftState, admitting = false, op?: Id | null): Venue {
  const bed = admitting || freeBeds(db, s).length > 0;
  const or = bed && op !== null && orBlock(db, s, op) === null;
  return { ...(bed ? { ward: true } : {}), ...(or ? { or: true } : {}) };
}

/** Лежащие сейчас. */
export function inpatientsOf(s: ShiftState): ShiftPatient[] {
  return Object.values(s.patients).filter(p => p.status === 'admitted' && p.stay).sort((a, b) => a.stay!.since - b.stay!.since || (a.id < b.id ? -1 : 1));
}

// --- приёмное и скорая (spec 2026-09-chapter-2, часть 27) -----------------------------------

/** Места смотровой приёмного в работающих помещениях, по порядку помещений и коек. */
export function emergencyBays(db: ContentDb, s: ShiftState): Bed[] {
  if (!s.hospital) return [];
  const ctx = hospitalCtx(db, s);
  return ctx.plan.rooms
    .filter(r => db.rooms[r.type]?.emergency && ctx.working.has(r.id))
    .flatMap(r => r.beds.map((_, bed) => ({ room: r.id, bed })));
}

/** Место занято, пока пациента не закрыли: ждёт, у врача или на обследовании. */
const holdsBay = (p: ShiftPatient) => p.bay !== undefined && (p.status === 'waiting' || p.status === 'inRoom' || p.status === 'away');

/** Свободные места смотровой. */
export function freeBays(db: ContentDb, s: ShiftState): Bed[] {
  const taken = new Set(Object.values(s.patients).filter(holdsBay).map(p => `${p.bay!.room}:${p.bay!.bed}`));
  return emergencyBays(db, s).filter(b => !taken.has(`${b.room}:${b.bed}`));
}

/** Привезённые скорой, что ждут у входа: мест в смотровой не было. По времени приезда. */
export function atDoorOf(s: ShiftState): ShiftPatient[] {
  return Object.values(s.patients)
    .filter(p => p.kind === 'ambulance' && !p.bay && p.status === 'waiting')
    .sort((a, b) => a.arriveT - b.arriveT || (a.id < b.id ? -1 : 1));
}

/** Освободилось место — первый ждущий у входа занимает его. */
function seatAtDoor(db: ContentDb, s: ShiftState) {
  for (const p of atDoorOf(s)) {
    const bay = freeBays(db, s)[0];
    if (!bay) return;
    p.bay = bay;
  }
}

function ambulanceDay(s: ShiftState): AmbulanceDay {
  return (s.summary.ambulance ??= { arrived: 0, sorted: 0, under: 0, over: 0 });
}

/**
 * Врач сортирует привезённого по листу передачи: цвет — место в очереди. Сверка со шкалой —
 * в итогах дня и в разборе. Прочитать лист — минута.
 */
function sortAmbulance(db: ContentDb, s: ShiftState, id: string, triage: Triage): Notice[] {
  const p = s.patients[id];
  if (!s.dayOpen || !p || p.kind !== 'ambulance' || p.sorted || p.status !== 'waiting' || !p.scale) return [];
  p.triage = triage;
  p.sorted = true;
  const day = ambulanceDay(s);
  day.sorted++;
  const d = TRIAGE_RANK[triage] - TRIAGE_RANK[p.scale.triage];
  if (d > 0) day.under++;
  if (d < 0) day.over++;
  enqueue(s, p, p.arriveT);
  return advanceBy(db, s, MIN);
}

function wardDay(s: ShiftState): WardDay {
  return (s.summary.ward ??= { admitted: 0, discharged: 0, early: 0, transferred: 0, lying: 0, stayDays: 0, stayNorm: 0 });
}

/**
 * Положить в палату: первая свободная койка, план приёма, как пойдёт болезнь — своя ветвь зерна.
 * В операционную (часть 28) — так же на койку, и в очередь операционной: операция — в плане.
 */
function admit(db: ContentDb, s: ShiftState, p: ShiftPatient) {
  const bed = freeBeds(db, s)[0];
  const closed = p.closed!;
  if (!bed) return;
  const plan = { treatments: [...closed.plan.treatments], setting: closed.plan.setting };
  const ev = evaluatePlan(db, p.patient, plan, observationsOf(p));
  const op = plan.setting === 'surgery' ? operationFor(db, closed.diagnosis) : undefined;
  p.stay = {
    ...bed, since: s.day, plan, planFrom: 0, replans: 0, ...wardCourse(db, p.patient, plan, ev, branch(s, `ward:${p.id}:0`)),
    ...(op ? { op: { tx: op, queued: s.t } } : {}),
  };
  p.status = 'admitted';
  wardDay(s).admitted++;
  if (op) startOperations(db, s);
}

// --- операционная (spec 2026-09-chapter-2, часть 28) -------------------------------------------

/** Почему операцию не сделать: нет операционной, она не работает (и первая причина), нет аппарата. */
export type OrBlock = { kind: 'noRoom' } | { kind: 'down'; problem: Problem } | { kind: 'noEquipment'; equipment: Id };

/** Операции базы — на них проверяют операционную, когда операция ещё не выбрана. */
const operations = (db: ContentDb) => Object.values(db.treatments).filter(t => t.surgery).map(t => t.id).sort();

/** Работающие операционные, где есть все аппараты операции, — по порядку помещений. */
function orsFor(db: ContentDb, s: ShiftState, op: Id): string[] {
  const x = db.treatments[op]?.surgery;
  if (!s.hospital || !x) return [];
  const ctx = hospitalCtx(db, s);
  return ctx.plan.rooms
    .filter(r => r.type === x.room && ctx.working.has(r.id) && x.equipment.every(e => r.equipment.includes(e)))
    .map(r => r.id);
}

/** Можно ли сделать операцию `op` (без неё — хоть одну) и если нет — почему. */
export function orBlock(db: ContentDb, s: ShiftState, op?: Id): OrBlock | null {
  const ops = op ? [op] : operations(db);
  if (!s.hospital || ops.length === 0) return { kind: 'noRoom' };
  if (ops.some(o => orsFor(db, s, o).length > 0)) return null;
  const ctx = hospitalCtx(db, s);
  const x = db.treatments[ops[0]].surgery!;
  const rooms = ctx.plan.rooms.filter(r => r.type === x.room);
  if (rooms.length === 0) return { kind: 'noRoom' };
  const down = rooms.find(r => !ctx.working.has(r.id));
  if (down && rooms.every(r => !ctx.working.has(r.id))) return { kind: 'down', problem: problemsOf(db, ctx.plan, down, ctx.staffed)[0] };
  const room = rooms.find(r => ctx.working.has(r.id))!;
  return { kind: 'noEquipment', equipment: x.equipment.find(e => !room.equipment.includes(e))! };
}

/** Можно ли с этим диагнозом в операционную: у него есть операция, операционная её делает, после неё есть койка. */
function canOperate(db: ContentDb, s: ShiftState, diagnosis: Id | undefined): boolean {
  const op = diagnosis ? operationFor(db, diagnosis) : undefined;
  return op !== undefined && orBlock(db, s, op) === null && freeBeds(db, s).length > 0;
}

/** Лежащие с операцией, которая ещё не началась, — по времени решения. */
export function orQueueOf(s: ShiftState): ShiftPatient[] {
  return inpatientsOf(s)
    .filter(p => p.stay!.op && p.stay!.op.start === undefined)
    .sort((a, b) => a.stay!.op!.queued - b.stay!.op!.queued || (a.id < b.id ? -1 : 1));
}

/** Кто сейчас на столе в этой операционной. */
export function onTableIn(s: ShiftState, room: string): ShiftPatient | undefined {
  return inpatientsOf(s).find(p => p.stay!.op?.room === room && !p.stay!.op.done && p.stay!.op.start !== undefined);
}

/** Свободные операционные берут следующих из очереди: операция — `minutes` минут по часам смены. */
function startOperations(db: ContentDb, s: ShiftState) {
  if (!s.dayOpen) return;
  for (const p of orQueueOf(s)) {
    const op = p.stay!.op!;
    const room = orsFor(db, s, op.tx).find(r => !onTableIn(s, r));
    if (!room) continue;
    const surgeon = hospitalCtx(db, s).staff.find(m => m.room === room && m.role === 'role.surgeon');
    op.room = room;
    if (surgeon) op.surgeon = surgeon.id;
    op.start = s.t;
    op.end = s.t + db.treatments[op.tx].surgery!.minutes * MIN;
    schedule(s, op.end, { kind: 'opEnd', id: p.id });
  }
}

function surgeryDay(s: ShiftState): SurgeryDay {
  return (s.summary.surgery ??= { done: 0, onTime: 0, late: 0, complications: 0 });
}

/**
 * Операция кончилась: осложнение — по доле операции и навыку хирурга, из ветви зерна пациента;
 * стационар после него дольше. В разбор — сколько часов прошло от решения до операции и в срок
 * ли это для болезни; расходники — в кассу дня. Операционная свободна — берёт следующего.
 */
function finishOperation(db: ContentDb, s: ShiftState, p: ShiftPatient | undefined) {
  const op = p?.stay?.op;
  if (!p || !op || op.done || op.start === undefined || p.status !== 'admitted') return;
  op.done = true;
  const surgeon = hospitalCtx(db, s).staff.find(m => m.id === op.surgeon);
  const day = surgeryDay(s);
  const stay = p.stay!;
  day.done++;
  // стадия болезни на момент разреза (часть 28б): перфорация, если ждали дольше, чем она ждёт
  const truth = primaryOf(p.patient).id;
  const onset = onsetHours(p.patient);
  const hours = onset + (op.start - p.arriveT) / 3600;
  const at = complicationAt(db, p.patient);
  const complicated = hours >= at;
  if (complicated) {
    op.complicated = true;
    day.complicated = (day.complicated ?? 0) + 1;
    // после операции в осложнённой стадии — свой срок стационара, от суток операции
    const norm = db.conditions[truth]?.complication?.stay;
    if (norm && stay.readyAfter !== undefined) stay.readyAfter = daysIn(stay, s.day) + branch(s, `surgery:${p.id}:stay`).range(norm[0], norm[1]);
    p.closed!.notes.push({ code: 'op.complicated', tx: op.tx, of: truth, hours: Math.round(hours), before: at <= onset });
  }
  if (branch(s, `surgery:${p.id}`).chance(complicationsOf(db, op.tx, surgeon, complicated))) {
    op.complication = true;
    day.complications++;
    if (stay.readyAfter !== undefined) stay.readyAfter += branch(s, `surgery:${p.id}:days`).range(COMPLICATION_DAYS[0], COMPLICATION_DAYS[1]);
    p.closed!.notes.push({ code: 'op.complication', tx: op.tx });
  }
  // умер после операции — решено сейчас, случится ночью (часть 28б): доля — по стадии
  if (branch(s, `surgery:${p.id}:death`).chance(deathsOf(db, op.tx, complicated, (op.start - p.arriveT) / 3600))) stay.dies = daysIn(stay, s.day);
  // срок — от решения положить: наблюдали, потом оперировали — считается от поступления; у
  // холецистита — от начала болезни (часть 30): пришедшему на третьи сутки оперировать уже поздно
  const plan = db.conditions[p.closed!.diagnosis]?.surgery;
  if (plan) {
    const fromOnset = plan.from === 'onset';
    const rounded = fromOnset ? Math.round(hours * 10) / 10 : Math.round((op.start - p.closed!.at) / 360) / 10;
    const onTime = rounded <= plan.window;
    if (onTime) day.onTime++;
    else day.late++;
    p.closed!.notes.push({ code: onTime ? 'op.onTime' : 'op.late', tx: op.tx, hours: rounded, window: plan.window, ...(fromOnset ? { onset: true as const } : {}) });
  }
  if (s.economy) ledgerOf(s).expenses.consumables += db.treatments[op.tx].cost;
  startOperations(db, s);
}

/**
 * Ночь (часть 28): неотложную операцию не откладывают до утра — идущие кончаются, очередь
 * оперируют по одному в каждой работающей операционной, начиная с вечера. Операционной нет —
 * ждут утра.
 */
function nightOperations(db: ContentDb, s: ShiftState) {
  const running = inpatientsOf(s).filter(p => p.stay!.op && !p.stay!.op.done && p.stay!.op.start !== undefined);
  const free: Record<string, number> = {};
  for (const p of running) {
    free[p.stay!.op!.room!] = p.stay!.op!.end!;
    finishOperation(db, s, p);
  }
  for (const p of orQueueOf(s)) {
    const op = p.stay!.op!;
    const rooms = orsFor(db, s, op.tx);
    if (rooms.length === 0) continue;
    const room = rooms.reduce((a, b) => ((free[b] ?? s.t) < (free[a] ?? s.t) ? b : a));
    const surgeon = hospitalCtx(db, s).staff.find(m => m.room === room && m.role === 'role.surgeon');
    op.room = room;
    if (surgeon) op.surgeon = surgeon.id;
    op.start = Math.max(s.t, free[room] ?? s.t);
    op.end = op.start + db.treatments[op.tx].surgery!.minutes * MIN;
    free[room] = op.end;
    finishOperation(db, s, p);
  }
}

/**
 * С обхода — в операционную (часть 28): лежащего, у которого операции ещё не было, — операцией
 * его диагноза; болезнь идёт дальше с планом, где она есть, с этих суток.
 */
function operate(db: ContentDb, s: ShiftState, id: string): Notice[] {
  const p = s.patients[id];
  if (!s.dayOpen || !p || p.status !== 'admitted' || !p.stay || p.stay.op || !p.closed) return [];
  const op = operationFor(db, p.closed.diagnosis);
  if (!op || orBlock(db, s, op) !== null) return [];
  const stay = p.stay;
  const from = daysIn(stay, s.day);
  const plan = { treatments: [...new Set([...stay.plan.treatments, op])].sort(), setting: 'surgery' as const };
  const ev = evaluatePlan(db, p.patient, plan, observationsOf(p));
  const replans = stay.replans + 1;
  const course = wardCourse(db, p.patient, plan, ev, branch(s, `ward:${p.id}:${replans}`), from);
  p.stay = { room: stay.room, bed: stay.bed, since: stay.since, plan, planFrom: from, replans, ...course, op: { tx: op, queued: s.t } };
  const notices = advanceBy(db, s, 2 * MIN);
  startOperations(db, s);
  return notices;
}

/**
 * Выписать или перевести лежащего. Выписка, когда болезнь разрешилась, — «выздоровел»; раньше —
 * вернётся хуже. Перевод — исход «переведён». ОМС платит за случай стационара: выписка в срок —
 * полностью, прерванный (перевод, ранняя выписка) — долю, госпитализация без показаний — ничего;
 * итог стационара — в закрытый случай.
 */
function leaveWard(db: ContentDb, s: ShiftState, id: string, how: 'discharge' | 'transfer'): Notice[] {
  const p = s.patients[id];
  // обход — днём: доход случая идёт в кассу этого дня
  if (!s.dayOpen || !p || p.status !== 'admitted' || !p.stay || !p.closed) return [];
  const stay = p.stay;
  // на столе — ни выписать, ни перевести; ждёт операции — только перевести (часть 28)
  if (stay.op && !stay.op.done && (stay.op.start !== undefined || how === 'discharge')) return [];
  const days = daysIn(stay, s.day);
  const state = wardState(stay, days);
  const ward = wardDay(s);
  let end: StayEnd;
  if (how === 'transfer') {
    end = 'transferred';
    p.closed.outcome = { kind: 'transferred', day: days, cured: false };
    ward.transferred++;
  } else if (state === 'ready') {
    end = 'discharged';
    p.closed.outcome = { kind: 'recovered', day: days, cured: true };
    ward.discharged++;
  } else {
    // выписан, когда болезнь ещё не прошла: вернётся хуже через день-два
    end = 'early';
    const back = Math.max(1, branch(s, `early:${p.id}`).range(1, 2));
    p.closed.outcome = { kind: 'worse', day: days + back, returns: { day: back, reason: 'worse' }, cured: false };
    s.returns.push({ day: s.day + back, of: p.id, reason: 'worse' });
    s.summary.returnsPlanned++;
    ward.discharged++;
    ward.early++;
  }
  closeStay(db, s, p, end, days);
  return advanceBy(db, s, 2 * MIN); // выписка, эпикриз
}

/**
 * Случай стационара кончился: срок — у выписанных, касса — по тому, как кончился. Без показаний
 * — то, что разбор приёма счёл лишним: по нужде пациента, как оценка «где лечить»; умер —
 * страховая платит за случай, как за законченный (часть 28б).
 */
function closeStay(db: ContentDb, s: ShiftState, p: ShiftPatient, end: StayEnd, days: number) {
  const stay = p.stay!;
  const closed = p.closed!;
  const norm = stayNorm(db, closed.diagnosis);
  const ward = wardDay(s);
  if (end === 'discharged' || end === 'early') {
    ward.stayDays += days;
    ward.stayNorm += norm;
  }
  closed.stay = { days, norm, end };
  p.status = 'done';
  if (s.economy) {
    const chosen = stay.plan.setting === 'surgery' ? 'surgery' : 'admit';
    const close: WardClose = settingFit(recommendedSetting(db, p.patient), chosen) === 'over' ? 'unindicated' : end === 'discharged' || end === 'died' ? 'full' : 'interrupted';
    const ledger = ledgerOf(s);
    ledger.ward ??= { cases: 0, income: 0, interrupted: 0, unindicated: 0 };
    ledger.ward.cases++;
    ledger.ward.income += wardIncome(db, closed.diagnosis, closed.grades.defensibility, close, stay.op?.done === true);
    if (close === 'interrupted') ledger.ward.interrupted++;
    if (close === 'unindicated') ledger.ward.unindicated++;
  }
}

/**
 * Ночь (часть 28б): кому после операции выпало умереть — умирает; в «мягком режиме» его вместо
 * этого переводят в областную больницу в тяжёлом состоянии, оценки те же. В итогах — одной
 * спокойной строкой.
 */
function nightDeaths(db: ContentDb, s: ShiftState) {
  for (const p of inpatientsOf(s)) {
    const stay = p.stay!;
    const days = daysIn(stay, s.day);
    if (stay.dies === undefined || days < stay.dies || !p.closed) continue;
    const ward = wardDay(s);
    if (s.meta.soft) {
      p.closed.outcome = { kind: 'transferred', day: days, cured: false, severe: true };
      ward.transferred++;
      closeStay(db, s, p, 'transferred', days);
    } else {
      p.closed.outcome = { kind: 'died', day: days, cured: false };
      ward.died = (ward.died ?? 0) + 1;
      closeStay(db, s, p, 'died', days);
    }
  }
}

/** Сменить лечение лежащего на обходе: болезнь идёт дальше с новым планом с этих суток. */
function replan(db: ContentDb, s: ShiftState, id: string, treatments: Id[]): Notice[] {
  const p = s.patients[id];
  if (!s.dayOpen || !p || p.status !== 'admitted' || !p.stay) return [];
  const known = treatments.filter(tx => db.treatments[tx] && db.treatments[tx].kind !== 'surgery');
  const stay = p.stay;
  const from = daysIn(stay, s.day);
  // операция остаётся в плане: её меняют «В операционную», а не сменой лечения (часть 28)
  const plan = { treatments: [...new Set([...known, ...(stay.op ? [stay.op.tx] : [])])].sort(), setting: stay.plan.setting };
  const ev = evaluatePlan(db, p.patient, plan, observationsOf(p));
  const replans = stay.replans + 1;
  const course = wardCourse(db, p.patient, plan, ev, branch(s, `ward:${p.id}:${replans}`), from);
  if (stay.op?.done) {
    // после операции причина устранена: новое лечение выписку не сдвигает, своя у него — только реакция
    const { reaction: _, ...kept } = stay;
    p.stay = { ...kept, plan, replans, ...(course.reaction ? { reaction: course.reaction } : {}) };
  } else {
    p.stay = { room: stay.room, bed: stay.bed, since: stay.since, plan, planFrom: from, replans, ...course, ...(stay.op ? { op: stay.op } : {}) };
  }
  return advanceBy(db, s, 2 * MIN);
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
    case 'opEnd':
      return finishOperation(db, s, s.patients[ev.id]);
    case 'free':
      return staffDesks(db, s);
    case 'shiftEnd':
      notices.push({ kind: 'shiftEnd' });
  }
}

/** Пришёл: медсестра меряет витальные и сортирует — по тому, что видит (жалобы и измерения). */
function arrive(db: ContentDb, s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  if (p.status !== 'coming') return;
  if (p.kind === 'ambulance') return arriveByAmbulance(db, s, p, notices);
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

/**
 * Привезла скорая (часть 27): фельдшер передаёт лист — жалобы и витальные, которые он измерил;
 * пациент — на свободное место в смотровой приёмного, мест нет — ждёт у входа. В очередь он
 * встаёт, когда его отсортирует врач; шкала (NEWS2 и красные флаги) — для сверки. Не уходит.
 */
function arriveByAmbulance(db: ContentDb, s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  if (db.exams['exam.vitals']) {
    p.done.push('exam.vitals');
    p.results.push({ exam: 'exam.vitals', obs: runExam(db, p.patient, 'exam.vitals', branch(s, `paramedic:${p.id}`), undefined, exact(s)), at: s.t, step: 0 });
  }
  p.scale = scaleTriage(db, p.patient.complaints, p.results.flatMap(r => r.obs));
  p.sorted = false;
  p.patience = 0;
  p.status = 'waiting';
  p.queuedT = s.t;
  const bay = freeBays(db, s)[0];
  if (bay) p.bay = bay;
  s.summary.arrived++;
  ambulanceDay(s).arrived++;
  notices.push({ kind: 'ambulance', id: p.id });
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
  return p.status === 'waiting' && p.by === undefined && p.calledT === undefined && p.kind !== 'return' && p.kind !== 'ambulance' && !(p.triaged !== false && p.triage === 'red');
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
    candidates: candidatesOf(db, p.departments ?? s.meta.department), exams: examsHere(db, s), threshold: how.threshold, minGain: how.minGain,
    // навык 1–2 иногда забывает спросить перед лечением — жребий своей ветви
    skipAsk: q => how.forget > 0 && branch(s, `forget:${p.id}:${q}`).chance(how.forget * 100),
    venue: venueOf(db, s),
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
