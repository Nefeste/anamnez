// Движок смены: приход пациентов, сортировка, очередь, терпение, обследования со своими
// сроками, закрытие случая и дня (spec 2026-09-first-shift, «Движок»; ADR 0005).
//
// Две точки входа, как в `02-architecture.md` §2: `apply(state, command)` — действие врача,
// которое двигает часы на свою цену, и команда `advance` — время на карте. Состояние
// меняется на месте; случайность — только из именованных ветвей зерна смены (ADR 0004).
import { type BodySystem, type Chapter, type ContentDb, type Equipment, type Exam, type Id, type Preset, type Season, type Setting, SYSTEMS, type TutorialPatient } from '../../content/types';
import { fnv1a } from '../core/hash';
import {
  caseIncome, consumablesOf, emptyLedger, expensesOf, flowOf, incomeOf, interestOf, type Ledger, levelOf, payerOf, reputationAfter, salariesOf, upkeepOf,
  type WardClose, wardIncome,
} from '../economy/economy';
import { type CampaignProgress, campaignEvening, chapterOf, nextChapterOf, startChapter, tutorialDayOf } from '../campaign/campaign';
import { build, emptyPlot, type HospitalState, type Plan, planOf, presetHospital, sizeOf, UNDO_DEPTH, widenPlot } from '../hospital/build';
import { bedsideIn, DOCTOR, doctorRoom, examWhere, NONE_BROKEN, openBlocks, type Problem, problemsOf, slotKey, type Staffing, workingRooms } from '../hospital/requirements';
import { applicantsOf, doctorOf, grow, memberAt, presetStaff, PROFILE_PRIOR, readingOf, type StaffMember, speedOf, staffingOf } from '../hospital/staff';
import { walkSeconds } from '../hospital/walk';
import { log2 } from '../core/math';
import { P_ONE, RNG_VERSION, Rng } from '../core/rng';
import { examHarmOutcome, observe, type Outcome, rscOutcome } from '../med/course';
import { complaintObservations, type ExamSkill, examFits, NORMAL_SKILL, runExam } from '../med/exams';
import { freezeClock, generatePatient, patientAt, typicalPatient } from '../med/generate';
import { type Belief, contextOf, likelyParams, posterior, type Prior } from '../med/infer';
import { scaleTriage } from '../med/news2';
import { alsoSettings, choiceFor, evaluatePlan, primaryOf, recommendedSetting, selfLimits, settingFit, settingRoomsOf, STAYS, surgeriesOf, treatable, txAvailable, type Venue, verdictOf, whenHolds } from '../med/plan';
import { type DoctorRun, examCost, indicated, ORDER_MINUTES, type Parts, startRational, type StepResult, stepParts, whole } from '../med/policy';
import { type CaseHardness, hardnessOf } from '../med/difficulty';
import { buildReview, type ReviewData, reviewBeliefs } from '../med/review';
import { type Grade, scoreBase, type ScoreBase, scoreThrift, worstGrade } from '../med/score';
import { askMinutes, examSkillWith, mentorOf } from '../career/skills';
import type { Observation, Patient } from '../med/types';
import {
  type ClosedCase, type ColleagueDay, type Command, DAY, type DaySummary, type Desk, type Difficulty, easyLevel, HANDOFF, hospitalDay, type Notice, type PendingResult, type PlannedReturn, REGISTRATION, SHIFT_END, SHIFT_SCHEMA_VERSION,
  SHIFT_START, type ShiftEvent, type ShiftPatient, type ShiftState, TRIAGE, type Triage, type VisitKind, type WardDay, type AmbulanceDay, type SurgeryDay,
} from './types';
import { CARD_EXAMS, type Challenge, CHALLENGES, challengeBlock, reviewExams } from './challenges';
import { FLU_IDS, type Scenario, SCENARIO_DAYS, scenarioAmbulance, scenarioFlow, scenarioPrior, xrayBroken } from './scenarios';
import { COMPLICATION_DAYS, complicationAt, complicationsOf, deathsOf, onsetHours, operationFor } from './surgery';
import { dueIn, type TargetPlace, targetResults } from './targets';
import { type Bed, daysIn, type StayEnd, stayNorm, wardCourse, wardState } from './ward';

const MIN = 60;
const TRIAGE_RANK: Record<Triage, number> = { red: 0, yellow: 1, green: 2 };
/** Сколько минут готовы ждать: красный не уходит, а ухудшается (`09-game-design.md` §4). */
const PATIENCE: Record<Exclude<Triage, 'red'>, [number, number]> = { yellow: [120, 180], green: [60, 150] };
/** Слоты записи: каждые 20 минут с 08:00 до 13:40, занято около 60 %. */
const SLOTS = 18;
const SLOT_MIN = 20;
const SLOT_BOOKED = 6000;

/** первая скорая в первую смену главы с обучением по скорой — не позже стольких минут (часть 34б) */
const TUTORIAL_AMBULANCE_MIN = 20;
/**
 * сколько зёрен перебрать, чтобы заданная болезнь была у человека обычной (и в заданном возрасте, с заданными
 * производными параметрами, а обязательное лечение ему можно): инсульт в первые 3 часа — у каждого седьмого
 */
const TUTORIAL_TRIES = 64;
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
  /** работающие кабинеты — виды помещений, по порядку (spec 2026-10-chapter-4, часть 53а): где можно лечить в кабинете */
  rooms: readonly Id[];
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
    const rooms = [...new Set(live.map(r => r.type))].sort();
    c = { plan, staff, staffed, working, rooms, seats: live.reduce((n, r) => n + r.seats.length, 0), triage: live.some(r => r.type === 'room.triage') };
    byStaff.set(staff, c);
  }
  return c;
}
/** «Студент»: обследования не ошибаются, пациенты ждут в полтора раза дольше (09-game-design.md §14). */
const exact = (s: ShiftState) => easyLevel(s.meta.difficulty);
const STUDENT_PATIENCE = 1.5;
/** «Ординатор» (spec 2026-10-resident): обследования ошибаются, как у «Врача», а ждут в 1,2 раза дольше (§14). */
const RESIDENT_PATIENCE = 1.2;
const patienceOf = (d: Difficulty | undefined) => (easyLevel(d) ? STUDENT_PATIENCE : d === 'resident' ? RESIDENT_PATIENCE : 1);

/** Как пришли бы больные (spec 2026-10-variety): `variety` — «разнообразие» из настроек; нет — как в жизни. */
interface Variety {
  variety?: boolean;
}

export function newShift(db: ContentDb, opts: { seed: number; season: Season; department?: Id; difficulty?: Difficulty } & Variety): ShiftState {
  const s = shiftBase(db, opts);
  planDay(db, s);
  return s;
}

/** Практика в первый день, 08:00, без разыгранного дня: его разыгрывают, когда известна больница. */
function shiftBase(db: ContentDb, opts: { seed: number; season: Season; department?: Id; difficulty?: Difficulty } & Variety): ShiftState {
  return {
    meta: {
      schemaVersion: SHIFT_SCHEMA_VERSION, contentVersion: db.contentVersion, rngVersion: RNG_VERSION, mode: 'shift',
      seed: opts.seed >>> 0, season: opts.season, department: opts.department ?? 'dept.therapy', difficulty: opts.difficulty ?? 'doctor',
      ...(opts.variety ? { variety: true } : {}),
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
}

/**
 * Песочница — своя больница (spec 2026-09-own-hospital): день 0, смена ещё не открыта, касса
 * по выбранному бюджету. С готовой амбулаторией — та же амбулатория, что в практике, в углу
 * участка, а денег — только доля бюджета.
 */
export function newSandbox(db: ContentDb, opts: { seed: number; season: Season; difficulty?: Difficulty; start: 'empty' | 'clinic'; budget: number } & Variety): ShiftState {
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
      ...(opts.variety ? { variety: true } : {}),
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
  opts: {
    seed: number; season: Season; difficulty?: Difficulty; venue: Id; hospital?: HospitalState; staff?: StaffMember[]; solo?: boolean;
    challenges?: readonly Challenge[];
  } & Variety,
): ShiftState {
  const s = singleBase(db, opts);
  // принимаете только вы (часть 79): записи к нанятым врачам нет, новых они не берут — до того, как разыграли день
  if (opts.solo) s.meta.solo = true;
  // испытания (часть 91, spec 2026-10-challenges) — на весь день, в порядке списка испытаний
  const challenges = CHALLENGES.filter(c => opts.challenges?.includes(c));
  if (challenges.length > 0) s.meta.challenges = challenges;
  // день — в этой больнице (spec 2026-10-variety, «Заодно»): прежде он разыгрывался до неё, и в
  // районной больнице приходили только с терапией, без скорой
  planDay(db, s);
  return s;
}

/**
 * Сценарий (часть 91, spec 2026-10-scenarios, вопрос 55): неделя «Смены» — пять смен подряд в выбранной больнице с условием
 * сценария; «Зимний грипп» — всегда зимой. Режим — свой (`scenario`), со своим слотом: неделя не мешает «Смене».
 */
export function newScenario(
  db: ContentDb,
  opts: { seed: number; season: Season; difficulty?: Difficulty; venue: Id; scenario: Scenario; hospital?: HospitalState; staff?: StaffMember[] } & Variety,
): ShiftState {
  const s = singleBase(db, { ...opts, season: opts.scenario === 'flu' ? 'winter' : opts.season });
  s.meta.mode = 'scenario';
  s.meta.scenario = opts.scenario;
  // «Рентген сломался» — с первого утра
  const broken = xrayBroken(db, opts.scenario, hospitalCtx(db, s).plan.rooms);
  if (broken.length > 0) s.broken = broken;
  planDay(db, s);
  return s;
}

/**
 * Готовая больница «Смены» без разыгранного дня (spec 2026-10-study-case, часть 74): по ней «Разобрать случай» знает,
 * какие отделения, места и обследования есть там, куда он кладёт больного из статьи.
 */
export function venueState(db: ContentDb, venue: Id): ShiftState {
  return singleBase(db, { seed: 0, season: 'winter', venue });
}

function singleBase(
  db: ContentDb,
  opts: { seed: number; season: Season; difficulty?: Difficulty; venue: Id; hospital?: HospitalState; staff?: StaffMember[] } & Variety,
): ShiftState {
  const s = shiftBase(db, opts);
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
 * Специалисты — только в главе со специалистами: в главах 1–3 их нет, они приходят с главой 4 (spec
 * 2026-10-chapter-4, части 59 и 60а).
 */
function builtIn(db: ContentDb, ch: Chapter): (role: Id) => boolean {
  const here = new Set([...ch.build, ...(db.presets[ch.preset]?.rooms.map(r => r.type) ?? [])]);
  return role => {
    const r = db.roles[role];
    if (!r || (r.profile && !ch.specialists) || (r.needs && !ch.build.includes(r.needs))) return false;
    return r.rooms.some(id => here.has(id));
  };
}

/**
 * Машин скорой за смену (spec 2026-10-chapter-4, часть 60а): у готовой больницы главы или «Смены» — её собственные (в
 * городскую везут больше), иначе — как везде.
 */
function ambulanceOf(db: ContentDb, s: ShiftState): [number, number] {
  const preset = s.campaign ? db.presets[chapterOf(db, s.campaign)?.preset ?? ''] : s.meta.mode === 'single' || s.meta.mode === 'scenario' ? db.presets[s.meta.venue ?? ''] : undefined;
  // «Закрыли соседнюю больницу» (часть 91) — машин в полтора раза больше
  return scenarioAmbulance(s.meta.scenario, preset?.ambulance ?? db.economy.ambulance.perDay);
}

/**
 * Участок главы: участок песочницы, а больница главы шире него — её собственный: у главы 3 — с крылом (часть 45а), у
 * главы 4 — большая больница 56 × 40 (spec 2026-10-chapter-4, часть 60а).
 */
function chapterPlot(db: ContentDb, preset: Preset): [number, number] {
  const sb = db.economy.sandbox.plot;
  return [Math.max(sb[0], preset.plot[0]), Math.max(sb[1], preset.plot[1])];
}

/**
 * Кампания (spec 2026-09-campaign): карьера в слоте `career`, первая глава — по порядку.
 * Больница главы — её готовая больница на участке песочницы со штатом, касса — бюджет главы;
 * в начале — письма «в начале главы». Остальное — как в песочнице. Что строят и кого нанимают заданием главы
 * (часть 60а), в начале главы нет.
 */
export function newCampaign(db: ContentDb, opts: { seed: number; season: Season; difficulty?: Difficulty; career: number; chapter?: Id }): ShiftState {
  const ch = opts.chapter ? db.chapters[opts.chapter] : Object.values(db.chapters)[0];
  const preset = db.presets[ch.preset];
  const hired = applicantsOf(db, opts.seed >>> 0, 0, 1, builtIn(db, ch));
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
    hospital: presetHospital(db, preset, chapterPlot(db, preset), true).hospital,
    economy: { cash: ch.budget, reputation: db.economy.reputation.start, ledger: emptyLedger() },
    undo: [],
    staff: presetStaff(db, preset, true),
    candidates: hired.list,
    nextStaff: hired.next,
    campaign: startChapter(db, ch.id, 0),
  };
}

/**
 * Следующая глава карьеры (spec 2026-09-chapter-2, часть 34): основные задания главы выполнены,
 * день закрыт — врач переходит в готовую больницу следующей главы. Врач, сложность, итоги дней и
 * подсказки — прежние; больница, штат, кандидаты, касса (бюджет главы) и репутация — новые. Кто
 * должен был вернуться — вернётся в прежнюю больницу: его возврат снят. Глава с крылом (spec
 * 2026-10-chapter-3, часть 45а) — та же больница: см. `wingChapter`.
 */
function nextChapter(db: ContentDb, s: ShiftState) {
  const c = s.campaign;
  const next = c ? nextChapterOf(db, c) : undefined;
  if (!c || !next || c.complete === undefined || s.dayOpen) return;
  if (next.wing) {
    wingChapter(db, s, c, next);
    return;
  }
  // лежащих долечат врачи прежней больницы (spec 2026-10-chapter-4, часть 61б), как вернувшихся: случай закрыт тем, что
  // было на день переезда, пребывание — «передан». Прежде переход ждал выписки, а в главе 3 палаты пусты не бывают
  for (const p of inpatientsOf(s)) closeStay(db, s, p, 'handed', daysIn(p.stay!, s.day));
  const preset = db.presets[next.preset];
  const hired = applicantsOf(db, s.meta.seed, s.day, s.nextStaff ?? 1, builtIn(db, next));
  s.meta.department = next.department;
  s.hospital = presetHospital(db, preset, chapterPlot(db, preset), true).hospital;
  s.staff = presetStaff(db, preset, true);
  s.candidates = hired.list;
  s.nextStaff = hired.next;
  s.economy = { cash: next.budget, reputation: db.economy.reputation.start, ledger: emptyLedger() };
  s.undo = [];
  s.rooms = {};
  s.returns = [];
  delete s.desk;
  s.campaign = { ...startChapter(db, next.id, s.day), ...(c.tips ? { tips: c.tips } : {}) };
}

/** Острый коронарный синдром — задание «без пропущенного инфаркта» (часть 45а). */
const ACS = 'cond.acs';
/** Замечания разбора, с которыми тромболизис не в счёт: вредно, не показан (в том числе поздно), противопоказание нарушено. */
const LYSIS_BAD: readonly string[] = ['tx.harmful', 'tx.notIndicated', 'safety.knownViolation', 'safety.unaskedViolation'];

/**
 * Итоги дня для заданий главы 3 (spec 2026-10-chapter-3, часть 45а), ваш приём: тромболизис — в окне и
 * без противопоказаний (не «вредно» и не «не показан», противопоказания спрошены и не нарушены) или нет;
 * ОКС — был ли и пропущен ли (диагноз не тот).
 */
function campaignCase(db: ContentDb, sum: DaySummary, p: ShiftPatient, closed: ClosedCase) {
  for (const tx of closed.plan.treatments.filter(id => db.treatments[id]?.class === 'thrombolytic')) {
    const contra = new Set(db.treatments[tx].contraindications.map(k => k.id));
    const bad = closed.notes.some(n => ('tx' in n && n.tx === tx && LYSIS_BAD.includes(n.code)) || (n.code === 'safety.notAsked' && contra.has(n.by)));
    const day = (sum.lysis ??= { good: 0, bad: 0 });
    if (bad) day.bad++;
    else day.good++;
  }
  if (primaryOf(p.patient).id === ACS) {
    const day = (sum.acs ??= { seen: 0, missed: 0 });
    day.seen++;
    if (closed.verdict === 'wrong') day.missed++;
  }
}

/**
 * Глава с крылом (spec 2026-10-chapter-3, часть 45а): больница остаётся — штат, построенное, лежащие,
 * кто должен вернуться, репутация и касса, к которой прибавляется бюджет главы; участок прирастает
 * справа клетками крыла. Кандидаты — по стройке новой главы; отмена стройки — с чистого листа: в
 * прежних снимках участок уже.
 */
function wingChapter(db: ContentDb, s: ShiftState, c: CampaignProgress, next: Chapter) {
  const hired = applicantsOf(db, s.meta.seed, s.day, s.nextStaff ?? 1, builtIn(db, next));
  s.meta.department = next.department;
  if (s.hospital) s.hospital = widenPlot(s.hospital, next.wing ?? 0);
  s.candidates = hired.list;
  s.nextStaff = hired.next;
  if (s.economy) s.economy.cash += next.budget;
  s.undo = [];
  s.campaign = { ...startChapter(db, next.id, s.day), ...(c.tips ? { tips: c.tips } : {}) };
}

/**
 * Действие врача или ход времени. Недопустимая команда ничего не меняет (но пишется в журнал).
 * Ходы времени подряд журнал сливает в один: прожить a, затем b — то же, что прожить a + b,
 * а часы на карте тикают по четыре раза в секунду.
 */
export function apply(db: ContentDb, s: ShiftState, cmd: Command, more?: () => boolean): Notice[] {
  // время прошлой команды, ещё не прожитое (0.5.13), — сначала всё: команда видит больницу такой же, как прежде
  const before = catchUp(db, s);
  const last = s.journal[s.journal.length - 1];
  if (cmd.kind === 'advance' && last?.kind === 'advance') last.seconds += cmd.seconds;
  else s.journal.push({ ...cmd });
  tailMore = more;
  try {
    const out = command(db, s, cmd);
    return before.length > 0 ? [...before, ...out] : out;
  } finally {
    tailMore = undefined;
  }
}

function command(db: ContentDb, s: ShiftState, cmd: Command): Notice[] {
  switch (cmd.kind) {
    case 'advance':
      return s.dayOpen ? later(db, s, undefined, cmd.seconds) : [];
    case 'call':
      return call(db, s, cmd.id);
    case 'exam':
      return exam(db, s, cmd.exam);
    case 'waitResults': {
      const p = current(s);
      if (!p || (p.pending.length === 0 && !isOut(s, p))) return [];
      p.step++;
      return later(db, s, p, Math.max(0, waitUntil(s, p) - s.t));
    }
    case 'sendAway': {
      const p = current(s);
      // ждать нечего — «подождите» только ради того, кто срочнее (spec 2026-10-chapter-3, часть 37):
      // иначе срок 10 минут не выполнить, пока идёт долгий опрос
      if (!p || (p.pending.length === 0 && !moreUrgent(db, s, p))) return [];
      p.step++; // что придёт, пока его нет, — «новое» при следующем вызове, а прежнее — нет
      s.current = undefined;
      // ушёл на обследование — после него в зал, не к вам (0.5.12)
      delete p.out;
      if (p.pending.length > 0) {
        p.status = 'away';
        p.wait++;
      } else {
        // в очередь на своё место — как вернувшийся с анализов, по времени прихода
        enqueue(s, p, p.arriveT);
      }
      return later(db, s, p, MIN);
    }
    case 'diagnose': {
      const p = current(s);
      // из болезней отделений, с какими его приняли (часть 30): в амбулатории хирургии нет
      if (p && db.conditions[cmd.id]?.presenting && (p.departments ?? [s.meta.department]).includes(db.conditions[cmd.id].department)) {
        p.draft.diagnosis = cmd.id;
        // у нового диагноза операции здесь нет — в палату, а нет койки — скорая (часть 28)
        if (p.draft.setting === 'surgery' && !canOperate(db, s, cmd.id, p)) p.draft.setting = freeBeds(db, s).length > 0 ? 'admit' : 'ambulance';
      }
      return [];
    }
    case 'hypothesis': {
      // дифференциальный ряд игрока (spec 2026-10-differential): из тех же болезней, что диагноз; новая — в конец
      const p = current(s);
      if (p && db.conditions[cmd.id]?.presenting && (p.departments ?? [s.meta.department]).includes(db.conditions[cmd.id].department)) {
        const row = p.draft.hypotheses ?? [];
        p.draft.hypotheses = row.includes(cmd.id) ? row.filter(x => x !== cmd.id) : [...row, cmd.id];
      }
      return [];
    }
    case 'toggleTreatment': {
      const p = current(s);
      // операцию выбирают «В операционную», а не в списке лечения (часть 28)
      if (!p || !db.treatments[cmd.id] || db.treatments[cmd.id].kind === 'surgery') return [];
      const has = p.draft.treatments.includes(cmd.id);
      // лечение у постели (часть 39а): тромболизис — только лежащему под монитором; лечение реанимации (spec
      // 2026-10-chapter-4, часть 47) — ИВЛ — если в ней есть свободная койка
      const ricu = freeRicuBeds(db, s).length > 0;
      // лечение в кабинете (часть 53а) — гемостаз — если эндоскопический кабинет больницы работает
      if (!has && !txAvailable(db, cmd.id, { bedside: bedsideEquipment(db, s, p), rooms: hospitalCtx(db, s).rooms, ...(ricu ? { ricu } : {}) })) return [];
      p.draft.treatments = has ? p.draft.treatments.filter(x => x !== cmd.id) : [...p.draft.treatments, cmd.id].sort();
      // назначил лечение реанимации — и место «В ОРИТ»: ИВЛ делают там
      const place = db.treatments[cmd.id].place;
      if (!has && place) p.draft.setting = place;
      return [];
    }
    case 'setting': {
      const p = current(s);
      // в свою палату — только если есть свободная койка (часть 26); в операционную — если у
      // диагноза есть операция, операционная её делает и после неё есть койка (часть 28); в ПИТ —
      // если свободна койка под монитором (часть 38а); в реанимацию — если свободна койка с монитором и
      // аппаратом ИВЛ (spec 2026-10-chapter-4, часть 47); в бокс — если он свободен (часть 49а)
      const ok = cmd.setting === 'admit' ? freeBeds(db, s).length > 0
        : cmd.setting === 'surgery' ? canOperate(db, s, p?.draft.diagnosis, p)
        : cmd.setting === 'icu' ? freeIcuBeds(db, s).length > 0
        : cmd.setting === 'ricu' ? freeRicuBeds(db, s).length > 0
        : cmd.setting === 'box' ? freeBoxBeds(db, s).length > 0 : true;
      if (p && ok) {
        p.draft.setting = cmd.setting;
        // лечение реанимации — только «В ОРИТ»: выбрал другое место — оно снимается (часть 47)
        p.draft.treatments = placeBound(db, p.draft.treatments, cmd.setting);
      }
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
    case 'variety':
      if (cmd.on) s.meta.variety = true;
      else delete s.meta.variety;
      return [];
    // умения врача (spec 2026-10-skills, часть 75): умения дня — те, что были, когда он открылся; новое — завтра
    case 'skills':
      if (cmd.today) setSkills(s, cmd.ids);
      else if (sameIds(cmd.ids, s.meta.skills ?? [])) delete s.meta.skillsNext;
      else s.meta.skillsNext = [...cmd.ids];
      return [];
    // «свои больные» (spec 2026-10-own-patients, часть 76): сразу — следующий, кого врач позовёт, уже по ним
    case 'mine':
      if (cmd.systems.length > 0) s.meta.mine = [...cmd.systems];
      else delete s.meta.mine;
      return [];
    case 'nextChapter':
      nextChapter(db, s);
      return [];
  }
}

/** Умения дня (spec 2026-10-skills): пусто — без поля, как в сохранениях до 0.5.18. */
function setSkills(s: ShiftState, ids: readonly Id[]) {
  if (ids.length > 0) s.meta.skills = [...ids];
  else delete s.meta.skills;
}

const sameIds = (a: readonly Id[], b: readonly Id[]) => a.length === b.length && a.every((x, i) => x === b[i]);

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
  // встающий на чужое место (терапевт, специалист) — на место врача, но в вашем кабинете врач — вы
  const postOf = (x: StaffMember) => db.roles[x.role]?.stands ?? x.role;
  const post = postOf(m);
  if (cmd.room !== undefined) {
    const room = s.hospital.rooms.find(r => r.id === cmd.room);
    if (!room || !db.rooms[room.type].staff.includes(post)) return;
    if (post === DOCTOR && room.id === doctorRoom(hospitalCtx(db, s).plan)) return;
  }
  s.staff = s.staff.map(x => {
    if (x.id === m.id) return cmd.room === undefined ? { ...x, room: undefined } : { ...x, room: cmd.room };
    // место одно: специалист сменяет терапевта в кабинете, как терапевт — терапевта (часть 59)
    if (cmd.room !== undefined && x.room === cmd.room && postOf(x) === post) return { ...x, room: undefined };
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
  // песочница: с репутацией записываются и приходят чаще или реже (spec 2026-09-own-hospital); «Закрыли соседнюю
  // больницу» (часть 91) — в полтора раза чаще
  const flow = s.economy ? flowOf(db, s.economy.reputation ?? db.economy.reputation.start) : scenarioFlow(s.meta.scenario);
  const plan: { t: number; kind: VisitKind; key: string; ret?: PlannedReturn; to?: string; only?: readonly Id[]; patient?: Patient }[] = [];
  // какие отделения больница принимает сегодня (часть 30): с работающей смотровой приёмного — и хирургию
  const admits = departmentsOf(db, s);
  // запись: у вашего кабинета и у каждого нанятого врача — своя (spec 2026-09-hired-doctors);
  // ветви вашей записи — прежние, поэтому без врачей день тот же. К специалисту (spec 2026-10-chapter-4,
  // часть 59) записываются с болезнями его профиля, которых больница принимает: нет таких — записи к нему нет
  const desks = colleaguesOf(db, s);
  for (let k = 0; k <= desks.length; k++) {
    const m = k === 0 ? undefined : desks[k - 1];
    const only = m ? profileHere(db, m, admits) : undefined;
    if (only?.length === 0) continue;
    for (let slot = 0; slot < SLOTS; slot++) {
      const key = k === 0 ? `slot:${slot}` : `desk:${k}:slot:${slot}`;
      const sr = r.fork(key);
      if (!sr.chance(Math.min(10000, Math.round((SLOT_BOOKED * flow) / 100)))) continue;
      const late = sr.range(-5, 10);
      plan.push({ t: base + SHIFT_START + Math.max(0, slot * SLOT_MIN + late) * MIN, kind: 'appointment', key, ...(m && only ? { to: m.id, only } : {}) });
    }
  }
  const wr = r.fork('walk-ins');
  const walkIns = Math.round((wr.range(WALK_INS[0], WALK_INS[1]) * flow) / 100);
  for (let i = 0; i < walkIns; i++) {
    const w = wr.fork(`walk:${i}`);
    const minute = Math.min(w.range(0, 330), w.range(0, 330)); // меньшее из двух — ближе к утру
    plan.push({ t: base + SHIFT_START + minute * MIN, kind: 'walkIn', key: `walk:${i}` });
  }
  // вернулся с другой болезнью (часть 41б): инсульт после ТИА привозит скорая — туда, где его
  // принимают; больница его не принимает — человека увезли в другую
  for (const ret of s.returns.filter(x => x.day === d)) {
    const as = ret.as ? db.conditions[ret.as] : undefined;
    if (as && !admits.includes(as.department)) continue;
    const kind: VisitKind = as?.arrival === 'ambulance' ? 'ambulance' : 'return';
    plan.push({ t: base + SHIFT_START + r.fork(`return:${ret.of}`).range(0, 120) * MIN, kind, key: `return:${ret.of}`, ret });
  }
  // кампания: в первый день главы первые пришедшие — с болезнями, заданными главой (обучение
  // с наставником); человек — тот же, что пришёл бы, если болезнь у него обычна. У главы с помещением
  // обучения (часть 45б) — в первый её день, когда оно работает
  const tutorial = s.campaign && d === tutorialDay(db, s) ? (chapterOf(db, s.campaign)?.tutorial ?? []) : [];
  // скорая (spec 2026-09-chapter-2, часть 27): работает смотровая приёмного — машины в любое
  // время смены, из своей ветви дня; без смотровой день прежний
  if (emergencyBays(db, s).length > 0) {
    const ar = r.fork('ambulance');
    const [lo, hi] = ambulanceOf(db, s);
    const cars = ar.range(lo, hi);
    // обучение со скорой (часть 34б): первая машина — в первые двадцать минут смены
    const early = tutorial.some(x => x.ambulance);
    for (let i = 0; i < cars; i++) {
      const minute = ar.fork(`amb:${i}`).range(0, (SHIFT_END - SHIFT_START) / MIN - 30);
      plan.push({ t: base + SHIFT_START + (early && i === 0 ? Math.min(minute, TUTORIAL_AMBULANCE_MIN) : minute) * MIN, kind: 'ambulance', key: `amb:${i}` });
    }
  }
  const departments = admits;
  // «Больные: разнообразие» (spec 2026-10-variety) — кроме кампании: на частоты жизни настроены главы
  const varied = s.meta.variety === true && s.meta.mode !== 'campaign';
  const gen = { department: s.meta.department, departments, season: s.meta.season, ...(varied ? { variety: true } : {}) };
  // пришёл сам (часть 41а): инсульта у него нет — его привозит скорая; к специалисту — с болезнью профиля (часть 59)
  const selfPatient = (a: { key: string; only?: readonly Id[] }) =>
    generatePatient(db, fnv1a(`${s.meta.seed}:${d}:${a.key}`), { ...gen, walkIn: true, ...(a.only ? { only: a.only } : {}) });
  // «Зимний грипп» (часть 91, spec 2026-10-scenarios): на каждого пришедшего сам с ОРВИ, гриппом или пневмонией — ещё один
  // с одной из них, по их частотам, без записи; остальные пришедшие — те же
  if (s.meta.scenario === 'flu') {
    const fr = r.fork('flu');
    for (const a of plan.filter(x => !x.ret && (x.kind === 'appointment' || x.kind === 'walkIn'))) {
      a.patient = selfPatient(a);
      if (!FLU_IDS.includes(a.patient.truth.conditions[0]?.id ?? '')) continue;
      const w = fr.fork(a.key);
      const minute = Math.min(w.range(0, 330), w.range(0, 330));
      plan.push({ t: base + SHIFT_START + minute * MIN, kind: 'walkIn', key: `flu:${a.key}`, only: FLU_IDS });
    }
  }
  // у главы с промежутком обучения (часть 46в) заданные приходят по порядку и не разом
  const gap = s.campaign ? chapterOf(db, s.campaign)?.tutorialGap : undefined;
  const spaced = tutorial.length > 0 && gap !== undefined ? spaceTutorial(tutorial, plan, gap * MIN, base + SHIFT_END - 30 * MIN) : undefined;
  plan.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1));
  // заданного пациента получает первый пришедший того же вида: скорая — скорая (часть 34б); записанный к
  // специалисту — не он: заданный — для вас
  const taught = new Set<number>();
  plan.forEach((a, i) => {
    const id = `${d}-${String(i + 1).padStart(2, '0')}`;
    const k = spaced ? (spaced.get(a) ?? -1) : a.ret || a.to ? -1 : tutorial.findIndex((x, j) => !taught.has(j) && !!x.ambulance === (a.kind === 'ambulance'));
    const teach = k >= 0 ? tutorial[k] : undefined;
    if (teach) taught.add(k);
    const patient = a.ret
      ? returningPatient(db, s, a.ret)
      : teach
        ? typicalPatient(
          db, n => fnv1a(`${s.meta.seed}:${d}:${a.key}${n ? `:${n}` : ''}`), { ...gen, primary: teach.condition, ...(teach.params ? { params: teach.params } : {}) }, TUTORIAL_TRIES, teach.age,
          // с заданными жалобами (часть 60б)
          p => treatable(db, p) && (teach.complaints ?? []).every(f => p.complaints.includes(f)),
        )
        : a.kind === 'ambulance'
          ? ambulancePatient(db, s, d, a.key, departments, varied)
          : (a.patient ?? selfPatient(a));
    // вернувшийся — и с теми отделениями, с какими его приняли в первый раз
    const own = a.ret ? [...new Set([...(s.patients[a.ret.of]?.departments ?? []), ...departments])] : departments;
    s.patients[id] = {
      id, patient, arriveT: a.t, kind: a.kind, triage: 'green', status: 'coming', queuedT: 0, wait: 0, patience: 0,
      results: [], pending: [], done: [], step: 0, spent: { seconds: 0, money: 0 }, draft: { treatments: [], setting: 'home' },
      ...(a.ret ? { returnOf: a.ret.of, returnReason: a.ret.reason } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(teach ? { taught: true as const } : {}),
      // выписали из палаты недолеченным — вернулся хуже: новый случай стационара не оплатят (часть 35)
      ...(a.ret && s.patients[a.ret.of]?.closed?.stay?.end === 'early' ? { afterEarly: true as const } : {}),
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
 * Заданные пациенты главы с промежутком обучения (spec 2026-10-chapter-3, часть 46в): по порядку списка, каждый — первому
 * пришедшему того же вида не раньше чем через `gap` после предыдущего заданного (первый — как прежде, первому пришедшему).
 * Машины скорой позже не нашлось — приезжает ближайшая к этому сроку из оставшихся, но не позже `last`. Кому из плана
 * дня — какой по списку.
 */
function spaceTutorial(tutorial: readonly TutorialPatient[], plan: { t: number; kind: VisitKind; key: string; ret?: PlannedReturn; to?: string }[], gap: number, last: number) {
  const out = new Map<object, number>();
  let after = -Infinity;
  tutorial.forEach((x, j) => {
    const free = plan.filter(a => !a.ret && !a.to && !out.has(a) && !!x.ambulance === (a.kind === 'ambulance')).sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1));
    let a = free.find(e => e.t >= after);
    if (!a && x.ambulance && free.length > 0 && after <= last) {
      a = free[free.length - 1];
      a.t = after;
    }
    if (!a) return;
    out.set(a, j);
    after = a.t + gap;
  });
  return out;
}

/**
 * День смены с обучением в главе (spec 2026-10-chapter-3, часть 45б): первый день главы; у главы с
 * помещениями обучения (`tutorialRoom`) — первый её день, когда они работают, — его запоминает ход главы:
 * главе 3 нужен кабинет КТ, без него неврологию не привозят; главе 4 (spec 2026-10-chapter-4, часть 60б) — эндоскопия и
 * бокс: без них кровотечение и заразного переводят.
 */
function tutorialDay(db: ContentDb, s: ShiftState): number | undefined {
  const c = s.campaign;
  const ch = c ? chapterOf(db, c) : undefined;
  if (!c || !ch) return undefined;
  if (ch.tutorialRoom && c.tutorialDay === undefined && s.day > c.since) {
    const ctx = hospitalCtx(db, s);
    if (ch.tutorialRoom.every(t => ctx.plan.rooms.some(r => r.type === t && ctx.working.has(r.id)))) c.tutorialDay = s.day;
  }
  return tutorialDayOf(ch, c);
}

/**
 * Кого везёт скорая: человек — как любой пришедший, болезнь — из отделений больницы с весом у
 * него (возраст, привычки, камни — часть 30) и по тяжести: лёгкое не везут. У болезни с тяжестью
 * — чаще тяжёлая, жребий ветви машины.
 */
function ambulancePatient(db: ContentDb, s: ShiftState, d: number, key: string, departments: readonly Id[], variety: boolean) {
  const a = db.economy.ambulance;
  const severe = branch(s, `ambulance:${d}:${key}`).fork('severe').chance(a.severe * 100);
  return generatePatient(db, fnv1a(`${s.meta.seed}:${d}:${key}`), {
    department: s.meta.department, departments, season: s.meta.season, carried: a.weight, ...(severe ? { params: { severity: 'severe' } } : {}), ...(variety ? { variety: true } : {}),
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
  // вернулся с другой болезнью (часть 41б) — тот же человек, болезнь новая
  const primary = ret.as ?? prev.patient.truth.conditions[0].id;
  const severe = !ret.as && ret.reason === 'worse' && db.conditions[primary].params?.severity?.severe !== undefined;
  return generatePatient(db, prev.patient.seed, {
    department: s.meta.department, season: s.meta.season, primary, visit, ...(severe ? { params: { severity: 'severe' } } : {}),
  });
}

function closeDay(db: ContentDb, s: ShiftState) {
  if (!s.dayOpen) return;
  // итоги дня — полные: отложенные разборы приёмов нанятых врачей досчитываются (spec 2026-10-engine-speed, ч. 1)
  settleReviews(db, s);
  for (const p of Object.values(s.patients)) {
    if (p.status === 'waiting' || p.status === 'intake' || p.status === 'inRoom' || p.status === 'away' || p.status === 'coming') {
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
  const lying = inpatientsOf(s);
  if (lying.length > 0 || s.summary.ward) {
    const day = wardDay(s);
    day.lying = lying.length;
    // в ПИТ — отдельно (часть 38а), в реанимации — тоже (spec 2026-10-chapter-4, часть 47), в боксах — тоже (часть 49а)
    const ricu = lying.filter(p => inRicu(db, s, p)).length;
    const icu = lying.filter(p => inIcu(db, s, p)).length - ricu;
    const box = lying.filter(p => inBox(db, s, p)).length;
    if (icu > 0) day.icuLying = icu;
    if (ricu > 0) day.ricuLying = ricu;
    if (box > 0) day.boxLying = box;
    const heavy = lying.filter(p => p.stay?.heavy).length;
    if (heavy > 0) day.heavyLying = heavy;
  }
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
    const c = applicantsOf(db, s.meta.seed, s.day, s.nextStaff ?? 1, s.campaign ? (ch ? builtIn(db, ch) : () => false) : undefined);
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
  // ремонт сломанного с утра (FR-EQ-3)
  const repairs = repairsOf(db, s);
  if (repairs > 0) ledger.expenses.repairs = repairs;
  ledger.expenses.rooms = upkeep.rooms;
  // лежащие ночуют в палате: койко-день у каждого (часть 26), по месту и тому, что с ними делают (`bedDayOf`)
  ledger.expenses.ward = inpatientsOf(s).reduce((a, p) => a + bedDayOf(db, s, p), 0);
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
    // вернувшийся с другой болезнью (часть 41б) — тоже: инсульт после ТИА привозит скорая
    returned: today.filter(p => p.returnOf !== undefined && (p.returnReason === 'worse' || p.returnReason === 'reaction')).length,
    ...(waits.length > 0 ? { meanWait: waits.reduce((a, b) => a + b, 0) / waits.length } : {}),
    toilet: ctx.plan.rooms.some(r => r.type === 'room.toilet' && ctx.plan.connected[r.id]),
    died: s.summary.ward?.died ?? 0,
    severe: s.summary.ward?.severe ?? 0,
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
  // сценарий (часть 91) — неделя: после пятой смены следующей нет
  if (s.meta.mode === 'scenario' && s.day >= SCENARIO_DAYS) return;
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
  // утром врач — в своём кабинете (FR-HOS-4)
  delete s.doctorAt;
  // умения врача (spec 2026-10-skills): выросшие за вчера — с утра
  if (s.meta.skillsNext) {
    setSkills(s, s.meta.skillsNext);
    delete s.meta.skillsNext;
  }
  // аппараты, сломавшиеся с утра (FR-EQ-3): до конца дня их нет, к завтра починят; «Рентген сломался» (часть 91) — рентген
  // не работает всю неделю
  const broken = [...new Set([...breakdowns(db, s), ...xrayBroken(db, s.meta.scenario, hospitalCtx(db, s).plan.rooms)])];
  if (broken.length > 0) s.broken = broken;
  else delete s.broken;
  planDay(db, s);
  prune(s);
  // ночью операционная не работала — утром бригада берёт очередь (часть 28)
  startOperations(db, s);
}

/**
 * Что ломается (FR-EQ-3): аппараты обследований в кабинетах; монитор у постели, наркозный и дыхательный аппараты и
 * стол — нет: у них в больнице есть запасной.
 */
export const breaks = (eq: Equipment): boolean => eq.exams.length > 0;
/** Ремонт за счёт больницы — процент цены аппарата (игровая оценка: выезд сервиса и деталь). */
export const REPAIR_PCT = 2;

/**
 * С утра (FR-EQ-3, spec 2026-10-walk-breakdowns): у каждого аппарата обследований — свой жребий по «надёжности»
 * каталога (`breakdown`, доля за рабочий день) из ветви `breakdown:<день>:<помещение>:<место>`. В учебный день главы — нет:
 * его пациенты ждут работающих кабинетов.
 */
export function breakdowns(db: ContentDb, s: ShiftState): string[] {
  if (tutorialDay(db, s) === s.day) return [];
  const out: string[] = [];
  for (const r of hospitalCtx(db, s).plan.rooms) {
    r.equipment.forEach((id, slot) => {
      const eq = id ? db.equipment[id] : undefined;
      if (eq && breaks(eq) && eq.breakdown > 0 && branch(s, `breakdown:${s.day}:${r.id}:${slot}`).chance(eq.breakdown)) out.push(slotKey(r.id, slot));
    });
  }
  return out;
}

/** Сломанные сегодня аппараты — для `examWhere`. */
export const brokenOf = (s: ShiftState): ReadonlySet<string> => (s.broken && s.broken.length > 0 ? new Set(s.broken) : NONE_BROKEN);

/** Сколько стоит починить сломанное сегодня, ₽: процент цены каждого аппарата. */
function repairsOf(db: ContentDb, s: ShiftState): number {
  const plan = hospitalCtx(db, s).plan;
  return (s.broken ?? []).reduce((sum, key) => {
    const [room, slot] = key.split(':');
    const id = plan.rooms.find(r => r.id === room)?.equipment[Number(slot)];
    return sum + (id ? Math.round((db.equipment[id].price * REPAIR_PCT) / 100) : 0);
  }, 0);
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
  // «Нелюдимый врач» (часть 91): аллергии, хронические болезни и лекарства — из карты, без расспроса
  if (s.meta.challenges?.includes('mute')) fromCard(db, s, p);
  // к привезённому скорой врач идёт в смотровую приёмного, к пришедшему сам — в свой кабинет (FR-HOS-4)
  const meet = meetIn(db, s, p);
  goTo(s, p);
  return later(db, s, p, meet);
}

/**
 * Что есть в карте (часть 91, spec 2026-10-challenges, «Нелюдимый врач»): ответы на вопросы карты — своей ветвью зерна, в
 * результатах с пометкой «из карты». Расспросом они не считаются: в `done` их нет. Уже известное не повторяется.
 */
function fromCard(db: ContentDb, s: ShiftState, p: ShiftPatient) {
  for (const id of CARD_EXAMS) {
    const e = db.exams[id];
    if (!e || !examFits(e, p.patient) || p.done.includes(id) || p.results.some(r => r.exam === id)) continue;
    p.results.push({ exam: id, obs: runExam(db, p.patient, id, branch(s, `card:${p.id}:${id}`), NORMAL_SKILL, exact(s)), at: s.t, step: 0, card: true });
  }
}

/**
 * Сколько секунд врачу идти к больному (FR-HOS-4, spec 2026-10-walk-breakdowns): от того места, где он был у прошлого, —
 * до смотровой, где лежит привезённый скорой, или до своего кабинета; от одного лежащего в смотровой к другому — без
 * дороги.
 */
export function walkTo(db: ContentDb, s: ShiftState, p: ShiftPatient): number {
  const plan = hospitalCtx(db, s).plan;
  const office = doctorRoom(plan);
  return walkSeconds(plan, s.doctorAt ?? office, p.bay?.room ?? office);
}

/**
 * Через сколько секунд врач и больной встретятся (FR-HOS-4): позвать — минута, как и прежде, а врач тем временем идёт к
 * нему в смотровую или обратно в кабинет; дорога дольше минуты — столько, сколько идти.
 */
export function meetIn(db: ContentDb, s: ShiftState, p: ShiftPatient): number {
  return Math.max(MIN, walkTo(db, s, p));
}

/** Врач — у этого больного: в смотровой, где он лежит, или в своём кабинете. */
function goTo(s: ShiftState, p: ShiftPatient) {
  if (p.bay) s.doctorAt = p.bay.room;
  else delete s.doctorAt;
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
  return p && cost !== null ? later(db, s, p, cost) : [];
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
 * Обследование у постели (spec 2026-10-chapter-3, часть 37): лежит в смотровой приёмного, она
 * работает, и в ней стоит аппарат из записи `bedside` — запись о том, как и сколько; иначе нет.
 */
export function bedsideOf(db: ContentDb, s: ShiftState, p: ShiftPatient, examId: Id): Exam['bedside'] {
  if (!p.bay) return undefined;
  const ctx = hospitalCtx(db, s);
  return bedsideIn(db, ctx.plan, ctx.working, examId, p.bay.room) ? db.exams[examId].bedside : undefined;
}

/**
 * Где лежит пациент — для сроков (часть 37): вид помещения по номеру, что можно у постели и (часть 43г) что
 * — в этой больнице: у постели или в работающем кабинете.
 */
export function targetPlace(db: ContentDb, s: ShiftState, p: ShiftPatient): TargetPlace {
  const ctx = hospitalCtx(db, s);
  const bedside = (exam: Id) => bedsideOf(db, s, p, exam) !== undefined;
  // испытание (часть 91): что оно запрещает у ваших пациентов, того в срок не сделать — срок, как и без кабинета, не
  // ставится; деньги «Скупого главврача» — не в счёт: расходом игрок управляет сам
  const limits = p.by ? undefined : s.meta.challenges?.filter(c => c !== 'thrifty');
  return {
    roomType: room => ctx.plan.rooms.find(r => r.id === room)?.type,
    bedside,
    can: exam => bedside(exam) || (!challengeBlock(db, limits, 0, exam) && !('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, exam, brokenOf(s)))),
  };
}

/**
 * Назначить обследование пациенту — вашему или нанятого врача. Возвращает, сколько времени
 * занят врач (сама процедура в кабинете, у нанятого — с поправкой `pct` его навыка), или null —
 * сделать нельзя, ничего не меняется.
 */
function orderExam(db: ContentDb, s: ShiftState, p: ShiftPatient, examId: Id, pct = 100): number | null {
  const how = examSetup(db, s, p, examId);
  if (!how) return null;
  const { e, ctx, bed, queued, room, eqId, roomPct, walk, to } = how;
  const reading = room && e.kind === 'imaging' ? imagingSkill(db, ctx.staff, room, eqId) : NORMAL_SKILL;
  // ваше обследование — с умениями дня (spec 2026-10-skills, часть 75); у нанятого врача — без них
  const skill = p.by ? reading : examSkillWith(db, s.meta.skills, examId, reading);

  // песочница: показано ли — по тому, что известно сейчас; показанные оплачивают ОМС и ДМС
  if (s.economy && e.cost > 0 && indicated(db, p.patient, observationsOf(p), candidatesOf(db, p.departments ?? s.meta.department), examId, Math.round((s.t - p.arriveT) / 60))) (p.indicated ??= []).push(examId);
  p.step++;
  p.done.push(examId);
  p.spent.money += e.cost;
  if (!p.by) s.summary.money += e.cost; // в итогах — ваши обследования
  if (s.economy) ledgerOf(s).expenses.consumables += consumablesOf(db, e);
  const obs = runExam(db, p.patient, examId, branch(s, `exam:${p.id}:${p.done.length}:${examId}`), skill, exact(s));
  // ушёл на обследование в другой кабинет (0.5.12, отзыв на 0.5.11) — что делают при нём, то когда вернётся
  const away = Math.max(0, (p.out?.back ?? 0) - s.t);
  if (bed) {
    const cost = Math.round((bed.time.procedure * MIN * pct) / 100);
    p.results.push({ exam: examId, obs, at: s.t + away + cost, step: p.step });
    return away + cost;
  }
  const after = (e.time.report ?? 0) + (e.time.turnaround ?? 0);
  if (queued && room) {
    const order = ORDER_MINUTES * MIN;
    // к аппарату — назначить, и пациент идёт туда сразу (0.5.12): из кабинета или прямо с прошлого обследования
    const go = outFrom(ctx, s, p, room.id, s.t + order);
    const start = Math.max(go.at + go.walk, s.rooms[room.id] ?? 0);
    const end = start + Math.round((e.time.procedure * MIN * roomPct) / 100);
    s.rooms[room.id] = end;
    addPending(s, p, examId, end + after * MIN, obs, { room: room.id, start, end });
    goOut(ctx, p, examId, room.id, end);
    return order;
  }
  // вопрос расспроса у вас — короче с «Быстрым опросом» (spec 2026-10-skills)
  const minutes = p.by ? e.time.procedure : askMinutes(db, s.meta.skills, e, e.time.procedure);
  const cost = Math.round((minutes * MIN * pct) / 100);
  // анализ: пока лаборатория готовит, — с поправкой лаборатории
  const wait = room ? Math.round((after * MIN * roomPct) / 100) : after * MIN;
  // повторный забор (spec 2026-10-chapter-3, часть 39в): его проверки — через `minutes` минут после
  // первого, со своим временем анализа; тропонин по алгоритму 0/1 час
  const again = e.repeat?.checks ?? [];
  const first = obs.filter(o => !again.includes(o.f));
  const second = obs.filter(o => again.includes(o.f));
  // анализ: кровь берут в процедурном — пациент идёт туда сразу, как выписали направление (FR-HOS-4; 0.5.12), и
  // возвращается. С 0.6.9 (spec 2026-10-clinic-flow) — по одному: начнут, когда он дошёл и медсестра свободна; пробирки
  // она несёт в лабораторию, анализ — с минуты, как проба дошла. Берут там, где он лежит, — на месте, несёт его медсестра
  const carry = room && to !== undefined ? walkSeconds(ctx.plan, to, room.id) : 0;
  if (after > 0 && room && to !== undefined && to !== fromRoom(ctx, p)) {
    const order = ORDER_MINUTES * MIN;
    // одна вена — все пробирки (spec 2026-10-code-blue): его забор здесь ещё не кончился — пробирка к тому же забору
    const same = sameDraw(s, p, to);
    if (same) {
      addPending(s, p, examId, same.lab + wait, first, { room: room.id, start: same.start, end: same.end, draw: to, lab: same.lab, sent: same.sent });
    } else {
      const go = outFrom(ctx, s, p, to, s.t + order);
      const { start, open } = drawStart(s, to, go.at + go.walk);
      const end = start + cost;
      if (open) carryLater(s, open, end);
      s.rooms[to] = end + carry + HANDOFF + carry;
      addPending(s, p, examId, end + carry + wait, first, { room: room.id, start, end, draw: to, lab: end + carry, sent: end });
      goOut(ctx, p, examId, to, end);
    }
    if (e.repeat && second.length > 0) {
      const draw = s.t + e.repeat.minutes * MIN + walk;
      addPending(s, p, examId, draw + cost + carry + wait, second, { room: room.id, start: draw, end: draw + cost, draw: to, lab: draw + cost + carry }, true);
    }
    return order;
  }
  const here = room ? { room: room.id, ...(to !== undefined ? { draw: to } : {}) } : undefined;
  const begin = s.t + away + walk;
  if (after > 0) addPending(s, p, examId, begin + cost + carry + wait, first, here && { ...here, start: begin, end: begin + cost, lab: begin + cost + carry });
  else p.results.push({ exam: examId, obs: first, at: s.t + away + cost, step: p.step });
  if (e.repeat && second.length > 0) {
    const draw = s.t + away + e.repeat.minutes * MIN + walk;
    addPending(s, p, examId, draw + cost + carry + wait, second, here && { ...here, start: draw, end: draw + cost, lab: draw + cost + carry }, true);
  }
  return away + cost;
}

/** Ушёл на обследование в другой кабинет и ещё не вернулся (0.5.12). */
export const isOut = (s: ShiftState, p: ShiftPatient) => p.out !== undefined && p.out.back > s.t;

/**
 * До какой минуты «Ждать результатов» (0.5.12): первый результат или его возвращение с обследования — что делают при
 * нём, тогда. Привезла скорая, пока ждали, — до её приезда: врачу пора в смотровую (spec 2026-10-chapter-3, часть 37: ЭКГ
 * при боли в груди — в первые 10 минут).
 */
export function waitUntil(s: ShiftState, p: ShiftPatient): number {
  const target = Math.min(...p.pending.map(x => x.readyAt), ...(isOut(s, p) ? [p.out!.back] : []));
  const car = s.events.find(x => x.t <= target && x.event.kind === 'arrive' && s.patients[x.event.id]?.kind === 'ambulance');
  return car ? car.t : target;
}

/**
 * Идёт «Ждать результатов» этого пациента, и кончится оно этим результатом (spec 2026-10-code-blue): смена доживает до
 * `waitUntil`, а это — его время. Сдвинуть результат — ожидание кончится без него.
 */
const awaited = (s: ShiftState, p: ShiftPatient, x: PendingResult) => s.current === p.id && s.until === x.readyAt && s.until === waitUntil(s, p);

/**
 * Делают ли обследование при враче (0.5.12): вопрос, осмотр, у постели, анализ, взятый на месте, — да; снимок, ЭКГ в
 * кабинете, анализ в процедурном — пациент идёт туда сам. Нельзя сделать — undefined.
 */
export function atDoctor(db: ContentDb, s: ShiftState, p: ShiftPatient, examId: Id): boolean | undefined {
  const how = examSetup(db, s, p, examId);
  if (!how) return undefined;
  const { e, ctx, bed, queued, room, to } = how;
  if (bed) return true;
  if (queued && room) return false;
  const after = (e.time.report ?? 0) + (e.time.turnaround ?? 0);
  return !(after > 0 && room && to !== undefined && to !== fromRoom(ctx, p));
}

/**
 * Откуда и когда пациент пойдёт на обследование в другом кабинете (0.5.12): сейчас на другом обследовании — прямо
 * оттуда, когда оно кончится; иначе — от врача (или со своего места в смотровой), как только выписали направление.
 */
function outFrom(ctx: HospitalCtx, s: ShiftState, p: ShiftPatient, to: string, leave: number): { at: number; walk: number } {
  const out = p.out && p.out.back > s.t ? p.out : undefined;
  return out ? { at: Math.max(leave, out.until), walk: walkSeconds(ctx.plan, out.room, to) } : { at: leave, walk: walkSeconds(ctx.plan, fromRoom(ctx, p), to) };
}

/** Ушёл на обследование (0.5.12): там — до `until`, у врача снова — когда дойдёт обратно. */
function goOut(ctx: HospitalCtx, p: ShiftPatient, exam: Id, room: string, until: number) {
  p.out = { exam, room, until, back: until + walkSeconds(ctx.plan, room, fromRoom(ctx, p)) };
}

/** Где и как сделать обследование этому пациенту сейчас: у постели или в кабинете, время — с поправкой аппарата и человека; нельзя — null. */
function examSetup(db: ContentDb, s: ShiftState, p: ShiftPatient, examId: Id) {
  const e = db.exams[examId];
  if (!e || p.done.includes(examId) || !examFits(e, p.patient)) return null;
  const ctx = hospitalCtx(db, s);
  // у постели (spec 2026-10-chapter-3, часть 37): лежащему в смотровой приёмного с монитором ЭКГ
  // снимают на месте — врач, без очереди в кабинет и без описания
  const bed = bedsideOf(db, s, p, examId);
  // испытание смены (часть 91): у ваших пациентов запрещённое не назначают — ни одним касанием, ни бланком
  if (!p.by && challengeBlock(db, s.meta.challenges, p.spent.money, examId, !!bed)) return null;
  const where = bed ? { rooms: [] } : examWhere(db, ctx.plan, ctx.working, ctx.staffed, examId, brokenOf(s));
  if ('block' in where) return null;
  const queued = !bed && (e.kind === 'imaging' || e.kind === 'functional');
  const rooms = e.room && !bed ? where.rooms.map(id => ctx.plan.rooms.find(r => r.id === id)!) : [];
  const room = queued ? rooms.reduce((a, b) => ((s.rooms[b.id] ?? 0) < (s.rooms[a.id] ?? 0) ? b : a)) : rooms[0];
  const broken = brokenOf(s);
  const eqId = room?.equipment.find((x, slot) => x !== null && (e.equipment ?? []).includes(x) && !broken.has(slotKey(room.id, slot))) ?? undefined;
  const eq = eqId ? db.equipment[eqId] : undefined;
  // время: аппарат и тот, кто делает (первая должность помещения), — в процентах записанного
  const roomPct = room ? Math.round((eq?.speed ?? 1) * speedOf(db, memberAt(ctx.staff, room.id, db.rooms[room.type].staff[0]))) : 100;
  // дорога (FR-HOS-4, spec 2026-10-walk-breakdowns): снимок и функциональное — в своём кабинете, материал берут там, где
  // записано (кровь — в процедурном, тропонин и пункцию — в смотровой приёмного)
  const to = queued ? room?.id : e.collect && !bed ? collectRoom(ctx, p, e.collect) : undefined;
  const walk = to ? walkSeconds(ctx.plan, fromRoom(ctx, p), to) : 0;
  return { e, ctx, bed, queued, room, eqId, roomPct, walk, to };
}

/** Где берут материал (FR-HOS-4): лежит в помещении этого вида — там же, иначе — в первом работающем. */
function collectRoom(ctx: HospitalCtx, p: ShiftPatient, type: Id): string | undefined {
  if (p.bay && ctx.plan.rooms.find(r => r.id === p.bay!.room)?.type === type) return p.bay.room;
  return ctx.plan.rooms.find(r => r.type === type && ctx.working.has(r.id))?.id;
}

/**
 * Откуда пациент идёт на обследование (FR-HOS-4): лежит в смотровой приёмного — оттуда, его ведёт нанятый врач — из
 * кабинета врача, иначе — из вашего кабинета.
 */
function fromRoom(ctx: HospitalCtx, p: ShiftPatient): string | undefined {
  if (p.bay) return p.bay.room;
  if (p.by) return ctx.staff.find(m => m.id === p.by)?.room;
  return doctorRoom(ctx.plan);
}

/**
 * Через сколько минут придёт результат, если назначить обследование сейчас (spec 2026-10-chapter-3, часть 46б): у
 * постели — процедура; снимок — назначить, дождаться аппарата, процедура с поправкой аппарата и человека и описание;
 * анализ — забор и лаборатория. Так разумный врач знает свою больницу: томограф на 16 срезов медленнее записанного.
 * Сделать нельзя — undefined.
 */
export function readyIn(db: ContentDb, s: ShiftState, p: ShiftPatient, examId: Id): number | undefined {
  const how = examSetup(db, s, p, examId);
  if (!how) return undefined;
  const { e, ctx, bed, queued, room, roomPct, walk, to } = how;
  // ушёл на другое обследование (0.5.12): при нём — когда вернётся, в другой кабинет — оттуда
  const away = Math.max(0, (p.out?.back ?? 0) - s.t) / MIN;
  if (bed) return away + bed.time.procedure;
  const after = (e.time.report ?? 0) + (e.time.turnaround ?? 0);
  if (queued && room) {
    const go = outFrom(ctx, s, p, room.id, s.t + ORDER_MINUTES * MIN);
    return (Math.max(go.at + go.walk, s.rooms[room.id] ?? 0) - s.t) / MIN + (e.time.procedure * roomPct) / 100 + after;
  }
  // кровь (spec 2026-10-clinic-flow): процедурная по одному, проба — до лаборатории
  const carry = room && to !== undefined ? walkSeconds(ctx.plan, to, room.id) / MIN : 0;
  if (room && to !== undefined && to !== fromRoom(ctx, p)) {
    // к его забору — пробирка; медсестра ещё не понесла пробы — за последним; понесла — когда вернётся (spec 2026-10-code-blue)
    const same = sameDraw(s, p, to);
    if (same) return (same.lab - s.t) / MIN + (after * roomPct) / 100 + (e.repeat?.minutes ?? 0);
    const go = outFrom(ctx, s, p, to, s.t + ORDER_MINUTES * MIN);
    return (drawStart(s, to, go.at + go.walk).start - s.t) / MIN + e.time.procedure + carry + (after * roomPct) / 100 + (e.repeat?.minutes ?? 0);
  }
  return away + walk / MIN + e.time.procedure + carry + (room ? (after * roomPct) / 100 : after) + (e.repeat?.minutes ?? 0);
}

/** Его забор в этой процедурной, который ещё не кончился (spec 2026-10-code-blue): к нему — ещё пробирка. */
function sameDraw(s: ShiftState, p: ShiftPatient, room: string): { start: number; end: number; lab: number; sent: number } | undefined {
  const x = p.pending.find(q => q.draw === room && !q.repeat && q.start !== undefined && q.end !== undefined && q.lab !== undefined && q.end > s.t);
  return x ? { start: x.start!, end: x.end!, lab: x.lab!, sent: x.sent ?? x.end! } : undefined;
}

type OpenDraws = { sent: number; items: { p: ShiftPatient; x: PendingResult }[] };

/**
 * Когда медсестра процедурной возьмёт кровь у дошедшего в `arrive` (spec 2026-10-code-blue): ещё не понесла пробы
 * последних — следом за ними, а понесёт все разом (`open`); понесла — когда вернётся, как в 0.6.9. Вы ждёте у себя
 * результата одной из проб, что у неё («Ждать результатов» кончится им), — она несёт их сразу, как пробу cito: обещанное
 * время результата не сдвигается.
 */
function drawStart(s: ShiftState, room: string, arrive: number): { start: number; open?: OpenDraws } {
  const open = openDraws(s, room);
  if (open && arrive <= open.sent && !open.items.some(({ p, x }) => awaited(s, p, x))) return { start: open.sent, open };
  return { start: Math.max(arrive, s.rooms[room] ?? 0) };
}

/** Пробы процедурной, которые медсестра понесёт последними (spec 2026-10-code-blue): когда и чьи. */
function openDraws(s: ShiftState, room: string): OpenDraws | undefined {
  let sent = -Infinity;
  let items: { p: ShiftPatient; x: PendingResult }[] = [];
  for (const p of Object.values(s.patients)) {
    for (const x of p.pending) {
      if (x.draw !== room || x.repeat || x.end === undefined) continue;
      const at = x.sent ?? x.end;
      if (at > sent) {
        sent = at;
        items = [];
      }
      if (at === sent) items.push({ p, x });
    }
  }
  return items.length > 0 ? { sent, items } : undefined;
}

/**
 * Медсестра понесёт пробы позже — в `sent` (spec 2026-10-code-blue): их анализ — позже на столько же; нанятый врач,
 * который ждёт результатов у себя, — дождётся их.
 */
function carryLater(s: ShiftState, open: OpenDraws, sent: number) {
  for (const { p, x } of open.items) {
    const shift = sent - (x.sent ?? x.end!);
    x.sent = sent;
    x.lab = (x.lab ?? x.end!) + shift;
    x.readyAt += shift;
    schedule(s, x.readyAt, { kind: 'result', id: p.id });
    const step = p.status === 'inRoom' && p.by !== undefined ? s.events.find(ev => ev.event.kind === 'colleague' && ev.event.id === p.id) : undefined;
    if (step && step.t < x.readyAt) step.t = x.readyAt;
  }
  s.events.sort((a, b) => a.t - b.t || a.seq - b.seq);
}

function addPending(
  s: ShiftState, p: ShiftPatient, examId: Id, readyAt: number, obs: Observation[], at?: { room: string; start: number; end: number; draw?: string; lab?: number; sent?: number }, repeat?: true,
) {
  p.pending.push({ exam: examId, readyAt, obs, ...(at ?? {}), ...(repeat ? { repeat } : {}) });
  schedule(s, readyAt, { kind: 'result', id: p.id });
}

function finish(db: ContentDb, s: ShiftState): Notice[] {
  const p = current(s);
  if (!p || !p.draft.diagnosis) return [];
  closePatient(db, s, p);
  s.current = undefined;
  return later(db, s, p, 2 * MIN); // рецепт, направление
}

/**
 * Закрыть приём — ваш или нанятого врача: оценки, оплата, итоги дня, повторное обращение.
 * Приёмы врача идут в его строку итогов, а ваши строки — только о ваших приёмах.
 */
function closePatient(db: ContentDb, s: ShiftState, p: ShiftPatient): ClosedCase {
  // не дождались — результат приходит в пустоту: случай решён тем, что было известно
  p.pending = [];
  delete p.out;
  // последнюю койку успели занять — направить в стационар другой больницы (часть 26); оперировать
  // этот диагноз здесь нечем или некому — вызвать скорую, как из амбулатории (часть 28)
  if (p.draft.setting === 'admit' && freeBeds(db, s).length === 0) p.draft.setting = 'ward';
  // последнюю койку ПИТ успели занять — перевести, как из больницы без ПИТ (часть 38а); реанимации — так же, и
  // её лечение снимается (spec 2026-10-chapter-4, часть 47)
  if (p.draft.setting === 'icu' && freeIcuBeds(db, s).length === 0) p.draft.setting = 'ambulance';
  if (p.draft.setting === 'ricu' && freeRicuBeds(db, s).length === 0) {
    p.draft.setting = 'ambulance';
    p.draft.treatments = placeBound(db, p.draft.treatments, 'ambulance');
  }
  if (p.draft.setting === 'surgery' && !canOperate(db, s, p.draft.diagnosis, p)) p.draft.setting = 'ambulance';
  // последний бокс успели занять — перевести в инфекционную больницу (spec 2026-10-chapter-4, часть 49а)
  if (p.draft.setting === 'box' && freeBoxBeds(db, s).length === 0) p.draft.setting = 'ambulance';
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
  // сроки за день (часть 37): ваши приёмы — у скольких срок был и у скольких выполнен; с частью 45а —
  // и оценки по порядку закрытия, для заданий «срок у N больных подряд»; срок с серией (часть 60а) — и в строку серии
  if (!p.by) {
    for (const t of closed.targets ?? []) {
      const day = ((s.summary.targets ??= {})[t.id] ??= { onTime: 0, total: 0 });
      day.total++;
      if (t.grade === 'A') day.onTime++;
      const seq = (s.summary.targetSeq ??= {});
      for (const key of [t.id, db.targets[t.id]?.series]) if (key) seq[key] = (seq[key] ?? '') + t.grade;
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
  // кампания (spec 2026-10-chapter-4, часть 60а): заразный, которому нужен бокс, — у всех приёмов больницы; положен ли он в
  // общую палату (строка разбора «соседи по палате — контактные»)
  if (s.campaign && recommendedSetting(db, p.patient, p.results.map(r => r.exam), closed.bedside, closed.rooms) === 'box') {
    const day = (sum.isolation ??= { seen: 0, ward: 0 });
    day.seen++;
    if (closed.plan.setting === 'admit') day.ward++;
  }
  if (p.by) {
    const c = colleagueDay(s, p.by);
    c.seen++;
    c[closed.verdict]++;
    // общая оценка — когда досчитан разбор (`settleReviews`)
    if (!closed.review) c.grades[closed.grades.overall]++;
  } else {
    sum.seen++;
    sum[closed.verdict]++;
    sum.grades[closed.grades.overall]++;
    // кампания: антибиотик, который не показан, — для задания «дни без него»
    if (s.campaign && closed.notes.some(n => n.code === 'tx.notIndicated' && db.treatments[n.tx]?.class?.startsWith('antibiotic.'))) {
      sum.needlessAntibiotic = (sum.needlessAntibiotic ?? 0) + 1;
    }
    if (s.campaign) campaignCase(db, sum, p, closed);
  }
  const back = closed.outcome.returns;
  if (back) {
    s.returns.push({ day: s.day + Math.max(1, back.day), of: p.id, reason: back.reason, ...(back.as ? { as: back.as } : {}) });
    sum.returnsPlanned++;
  }
  if (STAYS.includes(closed.plan.setting)) admit(db, s, p);
  return closed;
}

/** Строка итогов нанятого врача за день (spec 2026-09-hired-doctors) — с его должностью (spec 2026-10-chapter-4, часть 60а). */
function colleagueDay(s: ShiftState, by: string): ColleagueDay {
  const role = s.staff?.find(m => m.id === by)?.role;
  return ((s.summary.colleagues ??= {})[by] ??= { ...(role ? { role } : {}), seen: 0, correct: 0, partly: 0, wrong: 0, grades: { A: 0, B: 0, C: 0, D: 0 } });
}

/** Лечение реанимации (spec 2026-10-chapter-4, часть 47) остаётся, только если место — его: ИВЛ — «В ОРИТ». */
function placeBound(db: ContentDb, treatments: Id[], setting: Setting): Id[] {
  return treatments.filter(tx => db.treatments[tx]?.place === undefined || db.treatments[tx].place === setting);
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

/** Закрыть случай: проверить план по правде, промотать болезнь, поставить оценки (`10` §8–10). */
function closeCase(db: ContentDb, s: ShiftState, p: ShiftPatient): ClosedCase {
  const dx = p.draft.diagnosis!;
  const patient = p.patient;
  const truth = patient.truth.conditions[0].id;
  const cond = db.conditions[truth];
  const obs = observationsOf(p);
  const candidates = candidatesOf(db, p.departments ?? s.meta.department);
  // у ваших приёмов — уверенность разбора, посчитанная заранее (0.5.11): тот же вывод по тем же наблюдениям
  // в «Зимнем гриппе» (часть 91) — с эпидемией, как «Похоже на» и разумный врач разбора
  const beliefs = p.by ? posterior(db, candidates, obs, contextOf(db, patient, obs, scenarioPrior(s.meta.scenario))) : reviewTimeline(db, s.meta, p)[p.results.length];
  const confidence = beliefs.find(b => b.id === dx)?.p ?? 0;
  // в операционную — операцией поставленного диагноза (часть 28): по тому, что видно на снимке (часть 32б)
  const op = p.draft.setting === 'surgery' ? operationFor(db, dx, likelyParams(db, dx, obs, patient)) : undefined;
  const plan = { treatments: op ? [...new Set([...p.draft.treatments, op])].sort() : [...p.draft.treatments], setting: p.draft.setting };
  // аппараты у постели в момент решения (часть 39а): под монитором тромболизис был возможен
  const bedside = bedsideEquipment(db, s, p);
  // окна по часам — на минуту решения (часть 41а): тромболизис при инсульте — в первые 4,5 часа от начала
  const minutes = Math.round((s.t - p.arriveT) / 60);
  const before = freezeClock(db, patient, minutes);
  // и что сделано, хотя результат ещё не пришёл (spec 2026-10-chapter-4, часть 50а): пункция при противопоказании
  // и работающие кабинеты (часть 53а): с эндоскопическим кабинетом кровотечение из язвы останавливают у себя
  const rooms = settingRoomsOf(db, hospitalCtx(db, s).rooms);
  const ev = evaluatePlan(db, patient, plan, obs, { bedside, minutes, done: p.done, rooms }, before);
  // переведённый из больницы с приёмным (часть 39б): инфаркт с подъёмом ST — исход по часам до реперфузии; осложнение
  // обследования (часть 50а) — раньше всего
  const soft = s.meta.soft === true;
  const outcome = examHarmOutcome(db, plan, ev, branch(s, `outcome:${p.id}`), soft) ?? rscFor(db, s, p, plan) ?? observe(db, patient, plan, ev, branch(s, `outcome:${p.id}`), soft);
  // разумный врач разбора — посчитанный заранее (0.5.11, NFR-PRF-1): у вашего приёма — пока вы думаете; не готов —
  // досчитывается здесь. У приёма нанятого врача — по требованию (spec 2026-10-engine-speed, ч. 1): бережливость и общая
  // оценка досчитываются `settleReviews` (в свободное время и при закрытии дня), а читаются `reviewedCase`
  const later = p.by !== undefined;
  const present = new Set(patient.truth.findings.map(f => f.f));
  // та же группа — частично; с частью 48а — и источник сепсиса (пневмония вместо сепсиса из неё)
  const verdict = verdictOf(db, dx, patient);
  // сроки (spec 2026-10-chapter-3, часть 37): лежит в смотровой с болью в груди — ЭКГ за 10 минут
  // с частью 39б — и решения: тромболизис и перевод сделаны в минуту, когда врач закрыл приём
  const targets = targetResults(db, p, targetPlace(db, s, p), { t: s.t, plan });
  const cost = p.done.reduce((a, id) => a + examCost(db, id), 0);
  const base = scoreBase({
    verdict, confidence, cost,
    plan: ev, outcome, selfLimiting: selfLimits(db, primaryOf(patient)), ...(cond.settles ? { settles: true } : {}),
    redFlags: (cond.redFlags ?? []).filter(f => present.has(f)).map(f => ({ f, seen: obs.some(o => o.f === f && o.shown) })),
    // что было правильно выбрать здесь: со своей палатой — положить в неё, со своей операционной — оперировать
    should: choiceFor(recommendedSetting(db, patient, p.results.map(r => r.exam), bedside, rooms), venueOf(db, s, operationFor(db, truth, primaryOf(patient).params) ?? null, plan.setting)),
    ...(targets.length > 0 ? { targets: targets.map(t => t.grade) } : {}),
    // «Практикант» (spec 2026-10-trainee): обоснованность и бережливость — для сведения
    ...(s.meta.difficulty === 'trainee' ? { lenient: true as const } : {}),
  });
  const rational = later ? { cost: 0, money: 0 } : rationalOf(db, s.meta, p);
  // отложенный разбор: бережливость пока «как у разумного» (A), общая — по ней; замечания — без бережливости
  const score = scoreThrift(later ? { ...base, notes: [] } : base, cost, later ? cost : rational.cost);
  const { notes, targets: _worst, ...grades } = score;
  return {
    at: s.t, diagnosis: dx, verdict, confidence, plan, outcome, grades, notes: later ? [...base.notes] : notes, rationalCost: rational.cost, rationalMoney: rational.money,
    ...(targets.length > 0 ? { targets } : {}), ...(bedside.length > 0 ? { bedside } : {}), ...(rooms.length > 0 ? { rooms: [...rooms] } : {}),
    ...(p.arrest !== undefined ? { arrest: true as const } : {}),
    ...(later ? { review: base.lenient ? 'lenient' as const : 'due' as const } : {}),
    // трудность вашего случая (часть 92) — для профиля: доля верных среди трудных
    ...(later ? {} : { hardness: hardnessFor(db, s.meta, p) }),
  };
}

/** Что разбору нужно о смене: зерно, отделения и испытания (часть 91) — разумный врач разбора с теми же запретами. */
export type ReviewMeta = Pick<ShiftState['meta'], 'seed' | 'department' | 'challenges' | 'scenario'>;

/** Цена и деньги разумного врача разбора на этом пациенте. */
function rationalOf(db: ContentDb, meta: ReviewMeta, p: ShiftPatient): { cost: number; money: number } {
  const r = reviewEntry(db, meta, p).run.result();
  return { cost: r.exams.reduce((a, id) => a + examCost(db, id), 0), money: r.money };
}

// --- разбор приёма нанятого врача по требованию (spec 2026-10-engine-speed, ч. 1) -------------------------------------

/** Замечание, которое закрытие приёма дописывает после оценки: сверка сортировки привезённого скорой со шкалой. */
const afterScore = (n: ClosedCase['notes'][number]) => n.code === 'triage.under' || n.code === 'triage.over';

/** Оценка без бережливости — из закрытого приёма: оценки, сроки и замечания оценки, записанные при закрытии. */
function baseOf(c: ClosedCase): ScoreBase {
  const g = c.grades;
  const targets: Grade[] = (c.targets ?? []).map(t => t.grade);
  return {
    verdict: c.verdict, accuracy: g.accuracy, defensibility: g.defensibility, treatment: g.treatment, setting: g.setting, safety: g.safety,
    ...(targets.length > 0 ? { targets: worstGrade(targets) } : {}), lenient: c.review === 'lenient', notes: c.notes.filter(n => !afterScore(n)),
  };
}

/** Досчитать разбор в `c` (тот же объект или его копию): бережливость, общая оценка, замечания, цена разумного пути. */
function finishReview(db: ContentDb, meta: ReviewMeta, p: ShiftPatient, c: ClosedCase): ClosedCase {
  const rational = rationalOf(db, meta, p);
  const score = scoreThrift(baseOf(c), p.done.reduce((a, id) => a + examCost(db, id), 0), rational.cost);
  c.grades.thrift = score.thrift;
  c.grades.overall = score.overall;
  c.notes.splice(0, c.notes.length, ...score.notes, ...c.notes.filter(afterScore));
  c.rationalCost = rational.cost;
  c.rationalMoney = rational.money;
  delete c.review;
  return c;
}

/**
 * Закрытый приём с досчитанным разбором — для экранов, не меняя состояния: тот же до байта, что после `settleReviews`.
 * Разбор досчитан — сам приём.
 */
export function reviewedCase(db: ContentDb, s: ShiftState, p: ShiftPatient): ClosedCase | undefined {
  const c = p.closed;
  if (!c?.review) return c;
  const copy = JSON.parse(JSON.stringify(c)) as ClosedCase;
  return finishReview(db, s.meta, p, copy);
}

/** Сколько приёмов ждут досчёта разбора. */
export function reviewsDue(s: ShiftState): number {
  let n = 0;
  for (const p of Object.values(s.patients)) if (p.closed?.review) n++;
  return n;
}

/**
 * Досчитать отложенные разборы — по порядку закрытия, пока `more()` (разумный врач разбора — по частям); без `more` —
 * все. Строка оценок нанятого врача в итогах того дня, когда приём закрыт, получает его общую оценку. true — всё
 * досчитано.
 */
export function settleReviews(db: ContentDb, s: ShiftState, more?: () => boolean): boolean {
  const due = Object.values(s.patients).filter(p => p.closed?.review).sort((a, b) => a.closed!.at - b.closed!.at || (a.id < b.id ? -1 : 1));
  for (const p of due) {
    const run = reviewEntry(db, s.meta, p).run;
    while (!run.done()) {
      if (more && !more()) return false;
      run.part();
    }
    const c = finishReview(db, s.meta, p, p.closed!);
    const day = Math.floor(c.at / DAY) + 1;
    const sum = s.summary.day === day ? s.summary : s.history.find(h => h.day === day);
    const col = sum?.colleagues?.[c.by!];
    if (col) col.grades[c.grades.overall]++;
  }
  return true;
}

/**
 * Исход переведённого в сосудистый центр (spec 2026-10-chapter-3, часть 39б): из больницы, где
 * работает смотровая приёмного, — по часам от начала болезни до решения, пути и тому, был ли
 * тромболизис. Из амбулатории — прежний: тромболизис там решает бригада скорой. Часов от начала нет
 * (сохранения до 0.3.5) — тоже прежний.
 */
function rscFor(db: ContentDb, s: ShiftState, p: ShiftPatient, plan: { treatments: Id[]; setting: Setting }): Outcome | undefined {
  if ((plan.setting !== 'ambulance' && plan.setting !== 'transfer') || emergencyBays(db, s).length === 0) return undefined;
  const onset = db.conditions[p.patient.truth.conditions[0].id]?.onset;
  const hours = onset ? p.patient.truth.values[onset.f] : undefined;
  if (hours === undefined) return undefined;
  const decided = hours * 60 + Math.round((s.t - p.arriveT) / 60);
  return rscOutcome(db, p.patient, plan, decided, db.economy.transfer, branch(s, `rsc:${p.id}`), s.meta.soft === true);
}

/** Аппараты работающего помещения — то, что стоит у постели лежащего в нём (часть 39а). */
function roomEquipment(db: ContentDb, s: ShiftState, roomId: string | undefined): Id[] {
  if (roomId === undefined) return [];
  const ctx = hospitalCtx(db, s);
  const room = ctx.plan.rooms.find(r => r.id === roomId);
  return room && ctx.working.has(room.id) ? [...new Set(room.equipment.filter((id): id is Id => id !== null))].sort() : [];
}

/**
 * Аппараты у постели больного (spec 2026-10-chapter-3, часть 39а): лежит в работающей смотровой
 * приёмного — её аппараты, монитор с дефибриллятором; в кабинете врача и в амбулатории — ничего.
 */
export function bedsideEquipment(db: ContentDb, s: ShiftState, p: ShiftPatient): Id[] {
  return roomEquipment(db, s, p.bay?.room);
}

/** Аппараты у койки лежащего — для смены лечения на обходе (часть 39а): в ПИТ — монитор, в палате — ничего. */
export function stayEquipment(db: ContentDb, s: ShiftState, p: ShiftPatient): Id[] {
  return roomEquipment(db, s, p.stay?.room);
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
 * Разбор по одной записи пациента: из смены нужны только зерно, отделение и испытания — так его строит и
 * архив профиля; отделения, с какими больница его приняла (часть 30), — в самой записи.
 */
export function reviewFor(db: ContentDb, meta: ReviewMeta, p: ShiftPatient, diagnosis: Id): ReviewData {
  // разбор один на приём (0.5.11): экран разбора и архив профиля его не пересчитывают
  const entry = reviewEntry(db, meta, p);
  const key = `${diagnosis}|${p.results.length}`;
  let out = entry.reviews.get(key);
  if (!out) {
    const beliefs = reviewTimeline(db, meta, p);
    out = buildReview(db, p.patient, p.results.map(r => ({ exam: r.exam, obs: r.obs })), diagnosis, entry.candidates, entry.exams, entry.rng, {
      rational: entry.run.result(), beliefs, ...(entry.prior ? { prior: entry.prior } : {}), hardness: hardnessFor(db, meta, p),
    });
    entry.reviews.set(key, out);
  }
  return out;
}

/**
 * Разумный врач разбора этого приёма и уверенность после каждого результата — по шагу (0.5.11, NFR-PRF-1): их считают
 * заранее, пока игрок думает над пациентом (`prepareReview`), и закрытие приёма не ждёт. Зерно, кандидаты, обследования
 * и наблюдения — те же, что у разбора подряд, поэтому и разбор тот же. В памяти, не в сохранении: после открытия
 * сохранения — заново.
 */
interface ReviewEntry {
  rng: Rng;
  candidates: Id[];
  exams: Id[];
  run: DoctorRun;
  reviews: Map<string, ReviewData>;
  /** уверенность после жалоб и после каждого результата приёма — по порядку, по одному (`reviewBeliefs`) */
  beliefs: Belief[][];
  /** наблюдения, по которым посчитана последняя из них */
  obs: Observation[];
  /** что знает о потоке разумный врач разбора (часть 91): «Зимний грипп» — эпидемия; уверенность разбора — с этим же */
  prior?: Prior;
  /** трудность случая (часть 92): по разумному врачу разбора и уверенности после жалоб */
  hardness?: CaseHardness;
}
const reviewEntries = new WeakMap<ContentDb, WeakMap<ShiftPatient['patient'], Map<string, ReviewEntry>>>();

function reviewEntry(db: ContentDb, meta: ReviewMeta, p: ShiftPatient): ReviewEntry {
  let byDb = reviewEntries.get(db);
  if (!byDb) reviewEntries.set(db, (byDb = new WeakMap()));
  let byPatient = byDb.get(p.patient);
  if (!byPatient) byDb.set(p.patient, (byPatient = new Map()));
  const departments = p.departments ?? meta.department;
  // испытания смены (часть 91) — у ваших пациентов: разумный врач разбора с теми же запретами; у нанятых врачей — как всегда
  const limits = p.by ? undefined : meta.challenges;
  // сценарий (часть 91): «Зимний грипп» — разумный врач знает об эпидемии
  const key = `${meta.seed}|${p.id}|${typeof departments === 'string' ? departments : departments.join(',')}${limits ? `|${limits.join('+')}` : ''}${meta.scenario ? `|sc=${meta.scenario}` : ''}`;
  let entry = byPatient.get(key);
  if (!entry) {
    const rng = Rng.seeded(meta.seed).fork(`review:${p.id}`);
    const candidates = candidatesOf(db, departments);
    const exams = reviewExams(db, limits, Object.keys(db.exams).sort());
    const prior = scenarioPrior(meta.scenario);
    entry = {
      rng, candidates, exams, run: startRational(db, p.patient, rng, { candidates: [...candidates], exams: [...exams], prior }), reviews: new Map(),
      beliefs: [], obs: complaintObservations(p.patient), ...(prior ? { prior } : {}),
    };
    byPatient.set(key, entry);
  }
  return entry;
}

/**
 * Посчитать заранее шаг разумного врача разбора (0.5.11, NFR-PRF-1) — у того, кто у вас в кабинете, а когда он готов —
 * уверенность разбора после очередного пришедшего результата; затем — у приёмов нанятых врачей и у ждущих в очереди.
 * Интерфейс зовёт это в паузах игры, по шагу за раз, и закрытие приёма берёт готовое. Состояния смены не меняет. Вернёт
 * false, когда считать нечего.
 */
export function prepareReview(db: ContentDb, s: ShiftState): boolean {
  const p = s.current ? s.patients[s.current] : undefined;
  if (p && !p.by && !p.closed) {
    const entry = reviewEntry(db, s.meta, p);
    if (entry.run.part() !== true) return true;
    // разумный врач готов — уверенность после пришедших результатов, по одному за раз
    if (entry.beliefs.length <= p.results.length) {
      nextBelief(db, entry, p);
      return true;
    }
    // и трудность случая (часть 92): ещё одна уверенность — после расспроса и осмотра разумного врача
    if (!entry.hardness) {
      hardnessFor(db, s.meta, p);
      return true;
    }
  }
  // затем — у приёмов нанятых врачей и у тех, кто ждёт в очереди: разумный врач разбора нужен при закрытии каждого
  for (const q of ahead(s)) if (reviewEntry(db, s.meta, q).run.part() !== true) return true;
  // и у закрытых приёмов нанятых врачей, чей разбор отложен (spec 2026-10-engine-speed «Больницы»): закрытие дня возьмёт готовое
  for (const q of Object.values(s.patients)) if (q.closed?.review && reviewEntry(db, s.meta, q).run.part() !== true) return true;
  return false;
}

/**
 * Разбор вашего приёма к закрытию — по частям (0.5.13, NFR-PRF-1): разумный врач разбора и уверенность после каждого
 * пришедшего результата, пока `more()`; true — готово, и закрытие приёма берёт готовое. Не успели посчитать заранее —
 * интерфейс доводит это в кадрах и закрывает приём, когда готово. Состояния смены не меняет.
 */
export function prepareFinish(db: ContentDb, s: ShiftState, more: () => boolean = () => true): boolean {
  const p = s.current ? s.patients[s.current] : undefined;
  if (!p || p.by || p.closed) return true;
  const entry = reviewEntry(db, s.meta, p);
  while (!entry.run.done()) {
    if (!more()) return false;
    entry.run.part();
  }
  while (entry.beliefs.length <= p.results.length) {
    if (!more()) return false;
    nextBelief(db, entry, p);
  }
  if (!entry.hardness) {
    if (!more()) return false;
    hardnessFor(db, s.meta, p);
  }
  return true;
}

/** Кого закроют следом: приёмы нанятых врачей — по времени прихода, затем очередь — по порядку. */
function ahead(s: ShiftState): ShiftPatient[] {
  const theirs = Object.values(s.patients)
    .filter(p => p.by !== undefined && !p.closed && (p.status === 'inRoom' || p.status === 'away' || p.status === 'waiting'))
    .sort((a, b) => a.arriveT - b.arriveT || (a.id < b.id ? -1 : 1));
  return [...theirs, ...s.queue.map(id => s.patients[id]).filter(p => p && !p.closed && p.by === undefined)];
}

/** Уверенность после следующего результата приёма (после жалоб — первая). */
function nextBelief(db: ContentDb, entry: ReviewEntry, p: ShiftPatient) {
  const i = entry.beliefs.length;
  if (i > 0) entry.obs.push(...p.results[i - 1].obs);
  entry.beliefs.push(reviewBeliefs(db, p.patient, entry.candidates, entry.obs, entry.prior));
}

/** Уверенность разбора после жалоб и после каждого результата — что не посчитано заранее, досчитывается. */
function reviewTimeline(db: ContentDb, meta: ReviewMeta, p: ShiftPatient): Belief[][] {
  const entry = reviewEntry(db, meta, p);
  while (entry.beliefs.length <= p.results.length) nextBelief(db, entry, p);
  return entry.beliefs.slice(0, p.results.length + 1);
}

/** Трудность случая (часть 92) — по разумному врачу разбора и уверенности после жалоб; одна на приём. */
function hardnessFor(db: ContentDb, meta: ReviewMeta, p: ShiftPatient): CaseHardness {
  const entry = reviewEntry(db, meta, p);
  if (entry.beliefs.length === 0) nextBelief(db, entry, p);
  return (entry.hardness ??= hardnessOf(db, p.patient, entry.candidates, entry.beliefs[0], entry.run.result(), entry.prior));
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

/** Занятые койки — палаты и ПИТ: «помещение:койка» лежащих. */
function takenBeds(s: ShiftState): Set<string> {
  return new Set(Object.values(s.patients).filter(p => p.status === 'admitted' && p.stay).map(p => `${p.stay!.room}:${p.stay!.bed}`));
}

/** Свободные койки: работающие, на которых никто не лежит. */
export function freeBeds(db: ContentDb, s: ShiftState): Bed[] {
  const taken = takenBeds(s);
  return wardBeds(db, s).filter(b => !taken.has(`${b.room}:${b.bed}`));
}

/**
 * Работает ли койка палаты интенсивной терапии: на её месте под аппарат (место с номером койки) что-то стоит —
 * монитор (часть 38а); у реанимации (spec 2026-10-chapter-4, часть 47) места койки названы в `slotsOf` — на
 * каждом свой аппарат: монитор и аппарат ИВЛ.
 */
function bedWorks(db: ContentDb, r: Plan['rooms'][number], bed: number): boolean {
  const of = sizeOf(db, r.type, r.size)?.slotsOf;
  return of ? Object.entries(of).every(([eq, slots]) => r.equipment[slots[bed]] === eq) : !!r.equipment[bed];
}

/** Койки интенсивной терапии в работающих помещениях: ПИТ или реанимация (часть 47), по порядку помещений и коек. */
function careBeds(db: ContentDb, s: ShiftState, vent: boolean): Bed[] {
  if (!s.hospital) return [];
  const ctx = hospitalCtx(db, s);
  return ctx.plan.rooms
    .filter(r => db.rooms[r.type]?.icu && (db.rooms[r.type].vent ?? false) === vent && ctx.working.has(r.id))
    .flatMap(r => r.beds.flatMap((_, bed) => (bedWorks(db, r, bed) ? [{ room: r.id, bed }] : [])));
}

/**
 * Койки палаты интенсивной терапии (spec 2026-10-chapter-3, часть 38а): в работающих ПИТ — те, у
 * которых на своём месте (место под аппарат с номером койки) стоит монитор; по порядку помещений и
 * коек. Монитор продали — койка не работает, а лежащий на ней долежит. Реанимация — не ПИТ (часть 47).
 */
export function icuBeds(db: ContentDb, s: ShiftState): Bed[] {
  return careBeds(db, s, false);
}

/** Свободные койки ПИТ: под монитором и никто не лежит. */
export function freeIcuBeds(db: ContentDb, s: ShiftState): Bed[] {
  const taken = takenBeds(s);
  return icuBeds(db, s).filter(b => !taken.has(`${b.room}:${b.bed}`));
}

/**
 * Койки реанимации (spec 2026-10-chapter-4, часть 47): в работающих — те, у которых стоят и монитор, и аппарат
 * ИВЛ; продали один — койка не работает, а лежащий на ней долежит.
 */
export function ricuBeds(db: ContentDb, s: ShiftState): Bed[] {
  return careBeds(db, s, true);
}

/** Свободные койки реанимации: с монитором и аппаратом ИВЛ, никто не лежит. */
export function freeRicuBeds(db: ContentDb, s: ShiftState): Bed[] {
  const taken = takenBeds(s);
  return ricuBeds(db, s).filter(b => !taken.has(`${b.room}:${b.bed}`));
}

/** Лежит в интенсивной терапии (часть 38а): в ПИТ или в реанимации (часть 47). */
export function inIcu(db: ContentDb, s: ShiftState, p: ShiftPatient): boolean {
  const room = p.stay && s.hospital?.rooms.find(r => r.id === p.stay!.room);
  return !!room && !!db.rooms[room.type]?.icu;
}

/** Лежит в реанимации (spec 2026-10-chapter-4, часть 47). */
export function inRicu(db: ContentDb, s: ShiftState, p: ShiftPatient): boolean {
  const room = p.stay && s.hospital?.rooms.find(r => r.id === p.stay!.room);
  return !!room && !!db.rooms[room.type]?.vent;
}

/** Койки боксов инфекционного отделения в работающих боксах (spec 2026-10-chapter-4, часть 49а), по порядку помещений. */
export function boxBeds(db: ContentDb, s: ShiftState): Bed[] {
  if (!s.hospital) return [];
  const ctx = hospitalCtx(db, s);
  return ctx.plan.rooms
    .filter(r => db.rooms[r.type]?.box && ctx.working.has(r.id))
    .flatMap(r => r.beds.map((_, bed) => ({ room: r.id, bed })));
}

/** Свободные боксы: работают, никто не лежит. */
export function freeBoxBeds(db: ContentDb, s: ShiftState): Bed[] {
  const taken = takenBeds(s);
  return boxBeds(db, s).filter(b => !taken.has(`${b.room}:${b.bed}`));
}

/** Лежит в боксе (spec 2026-10-chapter-4, часть 49а). */
export function inBox(db: ContentDb, s: ShiftState, p: ShiftPatient): boolean {
  const room = p.stay && s.hospital?.rooms.find(r => r.id === p.stay!.room);
  return !!room && !!db.rooms[room.type]?.box;
}

/**
 * Койко-день лежащего, ₽: в палате (часть 26); в ПИТ — дороже (часть 38а); в реанимации на ИВЛ — ещё дороже (spec
 * 2026-10-chapter-4, часть 47): расходники аппарата и наркоз; в реанимации без ИВЛ — как в ПИТ (часть 61б): лежит под
 * монитором, аппарат стоит; в боксе — свой, с изоляцией (часть 49а).
 */
export function bedDayOf(db: ContentDb, s: ShiftState, p: ShiftPatient): number {
  const e = db.economy;
  if (inBox(db, s, p)) return e.box.bedDay;
  if (inRicu(db, s, p)) return p.stay!.plan.treatments.some(tx => db.treatments[tx]?.bedside?.equipment.includes('eq.ventilator')) ? e.ricu.bedDay : e.icu.bedDay;
  return inIcu(db, s, p) ? e.icu.bedDay : e.ward.bedDay;
}

/**
 * Что есть в больнице для решения «где лечить»: своя палата со свободной койкой; операционная, где сделают операцию
 * `op` (не указана — хоть какую; `null` — операции у болезни нет), и койка после неё; ПИТ со свободной койкой под
 * монитором (часть 38а); реанимация со свободной койкой с аппаратом ИВЛ (spec 2026-10-chapter-4, часть 47); свободный
 * бокс (часть 49а). `chosen` — место, куда этого пациента уже положили: его койка — тоже его.
 */
function venueOf(db: ContentDb, s: ShiftState, op?: Id | null, chosen?: Setting): Venue {
  const bed = chosen === 'admit' || chosen === 'surgery' || freeBeds(db, s).length > 0;
  const or = bed && op !== null && orBlock(db, s, op) === null;
  const icu = chosen === 'icu' || freeIcuBeds(db, s).length > 0;
  const ricu = chosen === 'ricu' || freeRicuBeds(db, s).length > 0;
  const box = chosen === 'box' || freeBoxBeds(db, s).length > 0;
  const rooms = hospitalCtx(db, s).rooms;
  return { ...(bed ? { ward: true } : {}), ...(or ? { or: true } : {}), ...(icu ? { icu: true } : {}), ...(ricu ? { ricu: true } : {}), ...(box ? { box: true } : {}), ...(rooms.length > 0 ? { rooms } : {}) };
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
  return later(db, s, undefined, MIN);
}

function wardDay(s: ShiftState): WardDay {
  return (s.summary.ward ??= { admitted: 0, discharged: 0, early: 0, transferred: 0, lying: 0, stayDays: 0, stayNorm: 0 });
}

/**
 * Положить в палату: первая свободная койка, план приёма, как пойдёт болезнь — своя ветвь зерна.
 * В операционную (часть 28) — так же на койку, и в очередь операционной: операция — в плане.
 */
function admit(db: ContentDb, s: ShiftState, p: ShiftPatient) {
  const closed = p.closed!;
  // в ПИТ — на свободную койку под монитором (часть 38а), в реанимацию — с монитором и аппаратом ИВЛ (часть 47), в
  // бокс — свободный бокс (spec 2026-10-chapter-4, часть 49а), иначе — в палату
  const ricu = closed.plan.setting === 'ricu';
  const icu = closed.plan.setting === 'icu' || ricu;
  const box = closed.plan.setting === 'box';
  const bed = (ricu ? freeRicuBeds(db, s) : icu ? freeIcuBeds(db, s) : box ? freeBoxBeds(db, s) : freeBeds(db, s))[0];
  if (!bed) return;
  const plan = { treatments: [...closed.plan.treatments], setting: closed.plan.setting };
  const ev = evaluatePlan(db, p.patient, plan, observationsOf(p));
  // операция — та, что выбрали при закрытии (часть 32б: по снимку)
  const op = plan.setting === 'surgery' ? (plan.treatments.find(tx => db.treatments[tx]?.kind === 'surgery') ?? operationOf(db, p, closed.diagnosis)) : undefined;
  p.stay = {
    ...bed, since: s.day, plan, planFrom: 0, replans: 0, ...wardCourse(db, p.patient, plan, ev, branch(s, `ward:${p.id}:0`)),
    ...(op ? { op: { tx: op, queued: s.t } } : {}),
  };
  // осложнение обследования при противопоказании (spec 2026-10-chapter-4, часть 50а): пункция при коме — смерть в ночь этих
  // суток, раньше любой другой
  if (closed.outcome.examHarm) p.stay.dies = 0;
  // фибрилляция желудочков после поступления (часть 39б): в ПИТ под монитором её снимут разрядом —
  // строка обхода; в палате без монитора — смерть в ночь этих суток (сутки — с 08:00: после полуночи — ещё те же)
  const vf = p.arrest === undefined ? arrestAfter(db, s, p) : undefined;
  if (vf !== undefined && p.arriveT + vf >= s.t) {
    const night = hospitalDay(p.arriveT + vf) - s.day;
    if (icu) p.stay.shock = night;
    else p.stay.dies = Math.min(p.stay.dies ?? night, night);
  }
  // тяжёлый (spec 2026-10-rules, часть 72): по шкале листа передачи, а не по тому, как отсортировали, — и в ПИТ или
  // реанимации; по ним — задание главы 4 о смертности
  if (icu || (p.kind === 'ambulance' && p.scale?.triage === 'red')) p.stay.heavy = true;
  p.status = 'admitted';
  const day = wardDay(s);
  day.admitted++;
  if (p.stay.heavy) day.heavy = (day.heavy ?? 0) + 1;
  if (icu && !ricu) day.icu = (day.icu ?? 0) + 1;
  if (ricu) day.ricu = (day.ricu ?? 0) + 1;
  if (box) day.box = (day.box ?? 0) + 1;
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
/** Операция диагноза для этого пациента (часть 32б): по самому вероятному значению скрытого параметра из того, что видно. */
export function operationOf(db: ContentDb, p: ShiftPatient, diagnosis: Id): Id | undefined {
  return operationFor(db, diagnosis, likelyParams(db, diagnosis, observationsOf(p), p.patient));
}

function canOperate(db: ContentDb, s: ShiftState, diagnosis: Id | undefined, p?: ShiftPatient): boolean {
  const op = !diagnosis ? undefined : p ? operationOf(db, p, diagnosis) : operationFor(db, diagnosis);
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
  // после операции — свой срок стационара от суток операции: в осложнённой стадии (часть 28б) и у
  // того, что лечат и без операции, — после рассечения спаек дольше, чем без него (часть 30в)
  const after = db.conditions[truth]?.surgery;
  // своя операция болезни — и по параметру (часть 32б: винты при переломе шейки бедра без смещения)
  const own = after && surgeriesOf(db, truth).includes(op.tx) ? after.stay : undefined;
  const norm = complicated ? (db.conditions[truth]?.complication?.stay ?? own) : own;
  if (norm && stay.readyAfter !== undefined) stay.readyAfter = daysIn(stay, s.day) + branch(s, `surgery:${p.id}:stay`).range(norm[0], norm[1]);
  if (complicated) {
    op.complicated = true;
    day.complicated = (day.complicated ?? 0) + 1;
    // осложнилось после поступления — пока ждал в больнице (задание главы 2, часть 34)
    if (at > onset) day.waited = (day.waited ?? 0) + 1;
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
  if (!op.complication && stay.dies === undefined) day.good = (day.good ?? 0) + 1;
  // срок — от решения положить: наблюдали, потом оперировали — считается от поступления; у
  // холецистита — от начала болезни (часть 30): пришедшему на третьи сутки оперировать уже поздно
  const plan = db.conditions[p.closed!.diagnosis]?.surgery;
  // срок — у операции, которая по правде была нужна, или после наблюдения; оперировали то, что
  // лечат без операции (часть 30д: дивертикулит без перитонита), — строки срока нет, разбор скажет
  // «больше нужного»
  const needed = recommendedSetting(db, p.patient, p.results.map(r => r.exam)) === 'surgery';
  if (plan && (needed || plan.observe !== undefined)) {
    const fromOnset = plan.from === 'onset';
    const rounded = fromOnset ? Math.round(hours * 10) / 10 : Math.round((op.start - p.closed!.at) / 360) / 10;
    // экстренной операции не было нужно, лечили в палате — срок после наблюдения (часть 30в): у
    // непроходимости без ишемии и перитонита — не позже 72 ч от поступления
    const observed = plan.observe !== undefined && !needed;
    const window = observed ? plan.observe! : plan.window;
    // срока нет (часть 32: закрытый перелом) — строки срока нет
    if (window !== undefined) {
      const onTime = rounded <= window;
      if (onTime) day.onTime++;
      else day.late++;
      p.closed!.notes.push({
        code: onTime ? 'op.onTime' : 'op.late', tx: op.tx, hours: rounded, window,
        ...(fromOnset ? { onset: true as const } : {}), ...(observed ? { observed: true as const } : {}),
      });
    }
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
  const op = operationOf(db, p, p.closed.diagnosis);
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
    // острый период позади (часть 41а): без тромболизиса последствия инсульта остались
    p.closed.outcome = { kind: 'recovered', day: days, cured: stay.settled !== 'residual', ...(stay.settled ? { settled: stay.settled } : {}) };
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
    // тяжёлый раньше срока — потеря для задания о смертности (spec 2026-10-rules, часть 72)
    if (stay.heavy) ward.heavyEarly = (ward.heavyEarly ?? 0) + 1;
  }
  closeStay(db, s, p, end, days);
  return later(db, s, undefined, 2 * MIN); // выписка, эпикриз
}

/**
 * Случай стационара кончился: срок — у выписанных, касса — по тому, как кончился. Без показаний
 * — то, что разбор приёма счёл лишним: по нужде пациента, как оценка «где лечить»; повторный —
 * вернулся хуже после ранней выписки (часть 35); умер — страховая платит за случай, как за
 * законченный (часть 28б).
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
    const chosen = stay.plan.setting === 'surgery' || stay.plan.setting === 'icu' || stay.plan.setting === 'ricu' || stay.plan.setting === 'box' ? stay.plan.setting : 'admit';
    // место — по пришедшим результатам (часть 40): после КТ без крови палата при сотрясении — не ошибка
    const done = p.results.map(r => r.exam);
    // и по аппаратам у постели в момент решения (часть 42б)
    const recommended = recommendedSetting(db, p.patient, done, closed.bedside, closed.rooms);
    const over = settingFit(recommended, chosen, alsoSettings(db, p.patient, done, closed.bedside, closed.rooms)) === 'over';
    const close: WardClose = over ? 'unindicated' : p.afterEarly ? 'repeat' : end === 'discharged' || end === 'died' ? 'full' : 'interrupted';
    const ledger = ledgerOf(s);
    ledger.ward ??= { cases: 0, income: 0, interrupted: 0, unindicated: 0 };
    ledger.ward.cases++;
    // прибавка за ПИТ — только если ПИТ была нужна (часть 38а): без показаний — тариф палаты; за реанимацию с ИВЛ
    // — если она была нужна, нужна была ПИТ — прибавка за ПИТ (spec 2026-10-chapter-4, часть 47); за бокс — если
    // изоляция была нужна (часть 49а)
    const unit = careUnit(chosen, recommended);
    ledger.ward.income += wardIncome(db, closed.diagnosis, closed.grades.defensibility, close, stay.op?.done ? stay.op.tx : undefined, unit);
    if (close === 'interrupted') ledger.ward.interrupted++;
    if (close === 'unindicated') ledger.ward.unindicated++;
    if (close === 'repeat') ledger.ward.repeat = (ledger.ward.repeat ?? 0) + 1;
  }
}

/**
 * За какую интенсивную терапию прибавка ОМС (части 38а и 47): выбранная, если нужна она или меньшая; за бокс (spec
 * 2026-10-chapter-4, часть 49а) — если изоляция была нужна.
 */
export function careUnit(chosen: Setting, recommended: Setting): 'icu' | 'ricu' | 'box' | undefined {
  if (chosen === 'ricu' && recommended === 'ricu') return 'ricu';
  if ((chosen === 'icu' || chosen === 'ricu') && recommended === 'icu') return 'icu';
  if (chosen === 'box' && recommended === 'box') return 'box';
  return undefined;
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
    // осложнение обследования (часть 50а) остаётся в исходе: разбор называет его
    const harm = p.closed.outcome.examHarm ? { examHarm: p.closed.outcome.examHarm } : {};
    if (stay.heavy) ward.heavyDied = (ward.heavyDied ?? 0) + 1;
    if (s.meta.soft) {
      p.closed.outcome = { kind: 'transferred', day: days, cured: false, severe: true, ...harm };
      ward.transferred++;
      ward.severe = (ward.severe ?? 0) + 1;
      closeStay(db, s, p, 'transferred', days);
    } else {
      p.closed.outcome = { kind: 'died', day: days, cured: false, ...harm };
      ward.died = (ward.died ?? 0) + 1;
      closeStay(db, s, p, 'died', days);
    }
  }
}

/** Сменить лечение лежащего на обходе: болезнь идёт дальше с новым планом с этих суток. */
function replan(db: ContentDb, s: ShiftState, id: string, treatments: Id[]): Notice[] {
  const p = s.patients[id];
  if (!s.dayOpen || !p || p.status !== 'admitted' || !p.stay) return [];
  const stay = p.stay;
  // лечение у постели (часть 39а) добавить можно только у койки с его аппаратом; назначенное — остаётся
  const bed = stayEquipment(db, s, p);
  const known = treatments.filter(tx => db.treatments[tx] && db.treatments[tx].kind !== 'surgery'
    && (stay.plan.treatments.includes(tx) || txAvailable(db, tx, { bedside: bed, rooms: hospitalCtx(db, s).rooms })));
  const from = daysIn(stay, s.day);
  // операция остаётся в плане: её меняют «В операционную», а не сменой лечения (часть 28)
  const plan = { treatments: [...new Set([...known, ...(stay.op ? [stay.op.tx] : [])])].sort(), setting: stay.plan.setting };
  // часы идут (часть 41а): на обходе окно тромболизиса давно закрыто — течение по нынешнему часу, а
  // разбор приёма остаётся на минуту решения
  const now = patientAt(db, p.patient, Math.round((s.t - p.arriveT) / 60)).patient;
  const ev = evaluatePlan(db, now, plan, observationsOf(p));
  const replans = stay.replans + 1;
  const course = wardCourse(db, now, plan, ev, branch(s, `ward:${p.id}:${replans}`), from);
  if (stay.op?.done) {
    // после операции причина устранена: новое лечение выписку не сдвигает, своя у него — только реакция
    const { reaction: _, ...kept } = stay;
    p.stay = { ...kept, plan, replans, ...(course.reaction ? { reaction: course.reaction } : {}) };
  } else {
    // смерть в ночь (фибрилляция без монитора, осложнение пункции — часть 50а) сменой лечения не отменить
    p.stay = {
      room: stay.room, bed: stay.bed, since: stay.since, plan, planFrom: from, replans, ...course, ...(stay.op ? { op: stay.op } : {}),
      ...(stay.dies !== undefined ? { dies: stay.dies } : {}), ...(stay.shock !== undefined ? { shock: stay.shock } : {}),
    };
  }
  return later(db, s, undefined, 2 * MIN);
}

// --- время --------------------------------------------------------------------------

function spend(db: ContentDb, s: ShiftState, p: ShiftPatient, seconds: number): Notice[] {
  p.spent.seconds += seconds;
  return advanceBy(db, s, seconds);
}

/** Сколько за раз проживать время в конце команды — даёт сессия (`apply` с `more`); нет — всё сразу. */
let tailMore: (() => boolean) | undefined;

/**
 * Время в конце команды (0.5.13, NFR-PRF-1): обследование, вызов, «подождите», закрытие приёма, промотка часов. С `more`
 * от сессии — по частям (`catchUp`): что не прожито, прожито будет в следующих кадрах, а следующая команда сначала
 * доживёт всё. Без `more` — сразу, как `spend` и `advanceBy`.
 */
function later(db: ContentDb, s: ShiftState, p: ShiftPatient | undefined, seconds: number): Notice[] {
  if (p) p.spent.seconds += seconds;
  if (seconds <= 0) return [];
  s.until = s.t + seconds;
  return catchUp(db, s, tailMore);
}

/**
 * Дожить время команды (0.5.13): события по порядку, пока `more()` перед каждым, — остальное в следующий раз; без `more`
 * — всё. Как `advanceBy`: время идёт по событиям, а в конце — тот час, до которого жили. Нечего доживать — ничего.
 */
export function catchUp(db: ContentDb, s: ShiftState, more?: () => boolean): Notice[] {
  const notices: Notice[] = [];
  const target = s.until;
  if (target === undefined) return notices;
  while (s.events.length > 0 && s.events[0].t <= target) {
    if (more && !more()) return notices;
    // шаг нанятого врача — по частям (0.5.13): часы — уже на его минуте, событие — когда он посчитан
    s.t = Math.max(s.t, s.events[0].t);
    if (more && !colleagueReady(db, s, more)) return notices;
    const { event } = s.events.shift()!;
    handle(db, s, event, notices);
  }
  s.t = target;
  delete s.until;
  return notices;
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
      return colleagueStep(db, s, s.patients[ev.id], ev);
    case 'nurse':
      return nurse(db, s, s.patients[ev.id], notices);
    case 'opEnd':
      return finishOperation(db, s, s.patients[ev.id]);
    case 'arrest': {
      // фибрилляция желудочков в смотровой (часть 39б): под монитором — разряд, ритм восстановлен. Уже
      // закрыт: увезли — в машине дефибриллятор; лежит у нас — решено при поступлении
      const p = s.patients[ev.id];
      if (!p || p.closed || p.kind !== 'ambulance') return;
      p.arrest = s.t;
      notices.push({ kind: 'arrest', id: p.id });
      return;
    }
    case 'free':
      return staffDesks(db, s);
    case 'shiftEnd':
      notices.push({ kind: 'shiftEnd' });
  }
}

/**
 * Пришёл (spec 2026-10-clinic-flow, замечания владельца 24.10.2026): регистратура и медсестра доврачебного кабинета — по
 * одному, за последним в очереди к ним. Пока его оформляют, в очереди врача его нет и срочности он не знает: её и
 * витальные определяет медсестра. Нет её — после регистратуры в зал, срочность не определена, меряет врач.
 */
function arrive(db: ContentDb, s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  if (p.status !== 'coming') return;
  if (p.kind === 'ambulance') return arriveByAmbulance(db, s, p, notices);
  const ctx = hospitalCtx(db, s);
  const nurse = ctx.triage && db.exams['exam.vitals'] !== undefined;
  // до медсестры — по жалобам, но без цвета в очереди: его никто не определил
  p.triage = triageOf(db, p);
  p.triaged = false;
  // терпение — каков он на самом деле: и по тому, что медсестра у него намеряет
  const sure = nurse ? triageOf(db, p, vitalsOf(db, s, p)) : p.triage;
  const [lo, hi] = sure === 'red' ? [0, 0] : PATIENCE[sure];
  p.patience = Math.round(branch(s, `patience:${p.id}`).range(lo, hi) * MIN * patienceOf(s.meta.difficulty));
  // своя больница: пришёл в полную зону ожидания — стоит, и ждать готов вдвое меньше
  if (s.hospital && p.patience > 0 && s.queue.length >= ctx.seats) p.patience = Math.round(p.patience / 2);
  s.summary.arrived++;
  if (p.kind === 'return') s.summary.returnsToday++;
  // без очереди — к медсестре; нет её — регистратура, как у всех: срочность там не определяют
  p.intake = intakeOf(ctx, s, nurse, nurse && rushOf(db, p));
  p.status = 'intake';
  p.queuedT = p.arriveT;
  notices.push({ kind: 'arrived', id: p.id });
  // без очереди медсестра, увидев его, зовёт врача сразу; остальных — в очередь врача, когда она закончила
  const desk = p.intake.nurse ?? p.intake.reg;
  schedule(s, p.intake.rush ? desk.start : desk.end, { kind: 'nurse', id: p.id });
}

/**
 * Без очереди (spec 2026-10-clinic-flow): тревожная жалоба у двери или такая, при которой срок по рекомендациям идёт с
 * порога, — подозрение на инсульт (осмотр в первые 10 минут от поступления, 814_1), рвота кровью. Иначе срок не успеть:
 * регистратура, медсестра и осмотр — уже больше 10 минут.
 */
function rushOf(db: ContentDb, p: ShiftPatient): boolean {
  return p.triage === 'red' || Object.values(db.targets).some(t => !t.room && t.from === 'arrival' && t.complaints.some(c => p.patient.complaints.includes(c)));
}

/**
 * Регистратура и медсестра (spec 2026-10-clinic-flow): у каждой очередь по одному — `s.rooms`, как у аппаратов; из
 * нескольких — та, что освободится раньше. К медсестре — от регистратуры по коридору. Без очереди (`rush`) — регистратор
 * ведёт к медсестре сразу, карту заводит потом, а медсестра берёт его следующим.
 */
function intakeOf(ctx: HospitalCtx, s: ShiftState, nurse: boolean, rush: boolean): { reg: Desk; nurse?: Desk; rush?: true } {
  if (rush) {
    const reg = { room: ctx.plan.rooms.find(r => r.type === 'room.reception' && ctx.working.has(r.id))?.id ?? '', start: s.t, end: s.t };
    const triage = nurse ? nextAtNurse(ctx, s, reg.end, reg.room || undefined) : undefined;
    return { reg, ...(triage ? { nurse: triage } : {}), rush: true };
  }
  const desk = (type: Id, from: number, room?: string): Desk | undefined => {
    const rooms = ctx.plan.rooms.filter(r => r.type === type && ctx.working.has(r.id));
    if (rooms.length === 0) return undefined;
    const at = (r: { id: string }) => Math.max(from + walkSeconds(ctx.plan, room, r.id), s.rooms[r.id] ?? 0);
    const r = rooms.reduce((a, b) => (at(b) < at(a) ? b : a));
    const start = at(r);
    const end = start + (type === 'room.triage' ? TRIAGE : REGISTRATION);
    s.rooms[r.id] = end;
    return { room: r.id, start, end };
  };
  const reg = desk('room.reception', s.t) ?? { room: '', start: s.t, end: s.t };
  const triage = nurse ? desk('room.triage', reg.end, reg.room || undefined) : undefined;
  return { reg, ...(triage ? { nurse: triage } : {}) };
}

/**
 * Медсестра берёт без очереди (spec 2026-10-clinic-flow): после того, кого меряет, когда он дошёл, и после тех, кто без
 * очереди пришёл раньше; кто ждал её по очереди — за ним, по порядку, и их сигнал «оформлен» — тоже позже. Без очереди он
 * в очереди врача с её первой минуты, но у неё — до конца её 3 минут.
 */
function nextAtNurse(ctx: HospitalCtx, s: ShiftState, from: number, room?: string): Desk | undefined {
  const rooms = ctx.plan.rooms.filter(r => r.type === 'room.triage' && ctx.working.has(r.id));
  if (rooms.length === 0) return undefined;
  const sessions = Object.values(s.patients)
    .filter(q => q.intake?.nurse !== undefined && q.intake.nurse.end > s.t)
    .sort((a, b) => a.intake!.nurse!.start - b.intake!.nurse!.start);
  const at = (r: { id: string }) => {
    const come = from + walkSeconds(ctx.plan, room, r.id);
    return sessions.reduce((t, q) => {
      const n = q.intake!.nurse!;
      const busy = n.room === r.id && ((n.start <= come && come < n.end) || (q.intake!.rush === true && n.start >= come));
      return busy ? Math.max(t, n.end) : t;
    }, come);
  };
  const r = rooms.reduce((a, b) => (at(b) < at(a) ? b : a));
  const start = at(r);
  const end = start + TRIAGE;
  const behind = sessions.filter(q => q.intake!.nurse!.room === r.id && !q.intake!.rush && q.intake!.nurse!.start >= start);
  let free = end;
  for (const q of behind) {
    const was = q.intake!.nurse!;
    const at = Math.max(was.start, free);
    free = at + (was.end - was.start);
    if (at === was.start) continue;
    q.intake!.nurse = { room: was.room, start: at, end: free };
    const ev = s.events.find(x => x.event.kind === 'nurse' && x.event.id === q.id);
    if (ev) ev.t = free;
  }
  if (behind.length > 0) s.events.sort((a, b) => a.t - b.t || a.seq - b.seq);
  s.rooms[r.id] = Math.max(s.rooms[r.id] ?? 0, free);
  return { room: r.id, start, end };
}

/** Давление, пульс, температура и сатурация у медсестры — своей ветвью зерна: те же, когда бы она ни мерила. */
const vitalsOf = (db: ContentDb, s: ShiftState, p: ShiftPatient) => runExam(db, p.patient, 'exam.vitals', branch(s, `vitals:${p.id}`), undefined, exact(s));

/**
 * Оформили (spec 2026-10-clinic-flow): медсестра закончила — витальные в карту, срочность по жалобам и по ним; срочный —
 * сигнал. Медсестры нет — регистратура оформила, срочность не определена. Теперь — в очереди врача; терпение — от прихода.
 * Сохранение прежней версии: он уже в очереди — медсестра меряет, если его ещё не позвали.
 */
function nurse(db: ContentDb, s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  if (p.status === 'waiting' && (!p.intake || p.intake.rush)) return vitalsInQueue(db, s, p, notices);
  if (p.status !== 'intake') return;
  if (p.intake?.rush) {
    // без очереди: медсестра увидела — зовёт врача; цвет — по жалобе, витальные — когда закончит, если его не позвали
    delete p.triaged;
    enqueue(s, p, p.arriveT, Math.max(s.t + MIN, p.arriveT + p.patience));
    if (p.intake.nurse) schedule(s, p.intake.nurse.end, { kind: 'nurse', id: p.id });
    if (p.triage === 'red') notices.push({ kind: 'arrived', id: p.id, triage: 'red' });
    staffDesks(db, s);
    return;
  }
  if (p.intake?.nurse) {
    p.done.push('exam.vitals');
    p.results.push({ exam: 'exam.vitals', obs: vitalsOf(db, s, p), at: s.t, step: 0 });
    p.triage = triageOf(db, p);
    delete p.triaged;
  }
  enqueue(s, p, p.arriveT, Math.max(s.t + MIN, p.arriveT + p.patience));
  if (p.triaged !== false && p.triage === 'red') notices.push({ kind: 'arrived', id: p.id, triage: 'red' });
  staffDesks(db, s);
}

/**
 * Медсестра меряет того, кто уже в очереди врача: сохранение до 0.6.9 (0.5.12, в очереди с прихода) и без очереди
 * (spec 2026-10-clinic-flow). Позвали раньше — пришёл к врачу без витальных, меряет врач.
 */
function vitalsInQueue(db: ContentDb, s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  if (p.calledT !== undefined || p.done.includes('exam.vitals')) return;
  const was = p.triage;
  p.done.push('exam.vitals');
  p.results.push({ exam: 'exam.vitals', obs: vitalsOf(db, s, p), at: s.t, step: 0 });
  p.triage = triageOf(db, p);
  if (p.triage === was) return;
  sortQueue(s);
  if (p.triage === 'red') notices.push({ kind: 'arrived', id: p.id, triage: 'red' });
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
  // вернулся с другой болезнью (часть 41б): инсульт после ТИА — тоже повторное обращение
  if (p.returnOf !== undefined) s.summary.returnsToday++;
  ambulanceDay(s).arrived++;
  // фибрилляция желудочков до реперфузии (часть 39б): лежит в смотровой под монитором, ждёт у входа — с
  // бригадой скорой и её дефибриллятором
  const vf = arrestAfter(db, s, p);
  if (vf !== undefined) schedule(s, Math.max(s.t, p.arriveT + vf), { kind: 'arrest', id: p.id });
  notices.push({ kind: 'ambulance', id: p.id });
}

/**
 * Через сколько секунд от прихода у больного фибрилляция желудочков (spec 2026-10-chapter-3, часть
 * 39б): до реперфузии — доля в час из записи болезни, пока от её начала меньше `hours` часов; момент
 * распределён показательно (−ln u / λ), из ветви `minute:<пациент>`. Нет записи, часов от начала или
 * момент за окном — undefined.
 */
export function arrestAfter(db: ContentDb, s: ShiftState, p: ShiftPatient): number | undefined {
  const primary = primaryOf(p.patient);
  const cond = db.conditions[primary.id];
  const a = cond?.arrest;
  if (!a || !cond.onset || a.perHour <= 0 || !whenHolds(a.when, primary.params)) return undefined;
  const onset = p.patient.truth.values[cond.onset.f];
  if (onset === undefined || onset >= a.hours) return undefined;
  const u = branch(s, `minute:${p.id}`).range(1, P_ONE) / P_ONE;
  const hours = (-log2(u) * Math.LN2 * P_ONE) / a.perHour;
  return hours < a.hours - onset ? Math.round(hours * 3600) : undefined;
}

export function triageOf(db: ContentDb, p: ShiftPatient, more: readonly Observation[] = []): Triage {
  const seen = [...p.patient.complaints, ...[...p.results.flatMap(r => r.obs), ...more].filter(o => o.shown).map(o => o.f)];
  const levels = seen.map(f => db.findings[f]?.triage).filter(Boolean);
  return levels.includes('red') ? 'red' : levels.includes('yellow') ? 'yellow' : 'green';
}

const rankOf = (q: ShiftPatient) => (q.triaged === false ? TRIAGE_RANK.green : TRIAGE_RANK[q.triage]);

/**
 * Ждёт ли кто-то срочнее того, кто в кабинете (часть 37): скорая привезла и ещё не рассортировали — по
 * листу передачи он может оказаться «красным»; в очереди — с идущим сроком, который кончается раньше,
 * чем у того, кто в кабинете (часть 43г: ЭКГ привезённому с давлением 180/110 — за 15 минут, а опрос
 * жёлтого в кабинете идёт и полчаса); у того, кто в кабинете, срока нет — и тот, кто выше по срочности.
 */
export function moreUrgent(db: ContentDb, s: ShiftState, p: ShiftPatient): boolean {
  if (Object.values(s.patients).some(q => q.kind === 'ambulance' && q.status === 'waiting' && !q.sorted)) return true;
  const mine = dueIn(db, p, targetPlace(db, s, p), s.t);
  return s.queue.some(id => {
    const q = s.patients[id];
    const left = dueIn(db, q, targetPlace(db, s, q), s.t);
    if (left !== undefined && (mine === undefined || left < mine)) return true;
    return mine === undefined && rankOf(q) < rankOf(p);
  });
}

/** В очередь врача; терпение кончится к `until` — по умолчанию через `patience` от этой минуты. */
function enqueue(s: ShiftState, p: ShiftPatient, queuedT: number, until = s.t + p.patience) {
  p.status = 'waiting';
  p.queuedT = queuedT;
  p.wait++;
  s.queue = [...s.queue.filter(x => x !== p.id), p.id];
  sortQueue(s);
  if (p.patience > 0) schedule(s, until, { kind: 'patience', id: p.id, wait: p.wait });
}

/** Очередь: срочность, если её определили (есть доврачебный кабинет), затем — кто раньше. */
function sortQueue(s: ShiftState) {
  s.queue = [...s.queue].sort((a, b) => {
    const x = s.patients[a];
    const y = s.patients[b];
    return rankOf(x) - rankOf(y) || x.queuedT - y.queuedT || (a < b ? -1 : 1);
  });
}

/** Результаты пришли. Ушедший на анализы возвращается в очередь — впереди, по времени прихода. */
function results(s: ShiftState, p: ShiftPatient, notices: Notice[]) {
  const ready = p.pending.filter(x => x.readyAt <= s.t).sort((a, b) => a.readyAt - b.readyAt || (a.exam < b.exam ? -1 : 1));
  if (ready.length === 0) return;
  p.pending = p.pending.filter(x => x.readyAt > s.t);
  for (const x of ready) p.results.push({ exam: x.exam, obs: x.obs, at: x.readyAt, step: p.step, ...(x.repeat ? { repeat: x.repeat } : {}) });
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
 * и с местом в ординаторской. Порядок — по номеру кабинета, затем человека. «Смена», где принимаете только вы
 * (часть 79), — никто.
 */
function colleaguesOf(db: ContentDb, s: ShiftState): StaffMember[] {
  if (!s.hospital || !s.staff || s.meta.solo) return [];
  const ctx = hospitalCtx(db, s);
  const mine = doctorRoom(ctx.plan);
  return ctx.staff
    .filter(m => db.roles[m.role]?.stands === DOCTOR && m.room !== undefined && m.room !== mine && ctx.working.has(m.room) && ctx.staffed(m.room, DOCTOR))
    .sort((a, b) => (a.room! < b.room! ? -1 : a.room! > b.room! ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * С какими болезнями к специалисту записываются в этой больнице (spec 2026-10-chapter-4, часть 59): его профиль — те,
 * чьё отделение больница принимает. У терапевта профиля нет.
 */
function profileHere(db: ContentDb, m: StaffMember, admits: readonly Id[]): Id[] | undefined {
  return db.roles[m.role]?.profile?.filter(id => admits.includes(db.conditions[id].department));
}

/**
 * Кого берёт нанятый врач: нового пациента, которого ещё никто не смотрел, — не «красного» по
 * сортировке, не повторное обращение и не того, кого вы отпустили ждать результатов. Без
 * доврачебного кабинета срочность никто не определил — берёт по очереди прихода. Специалист (часть 59) —
 * только записанных к нему; терапевт — кроме записанных к специалисту, который сегодня принимает. Заданного пациента
 * первой смены главы (часть 61в) — никто: он для вас. «Своих больных» (часть 76) — тоже: их оставляют вам.
 */
function colleagueTakes(db: ContentDb, s: ShiftState, p: ShiftPatient, m: StaffMember, list: readonly StaffMember[]): boolean {
  if (!newcomer(p)) return false;
  if (db.roles[m.role]?.profile) return p.to === m.id;
  if (bookedHere(p, list)) return false;
  return !forPlayer(db, s, p);
}

/** Новый, кого нанятый врач может позвать: ждёт, никем не взят и не вызван, не повторный, не со скорой, не «красный». */
function newcomer(p: ShiftPatient): boolean {
  return p.status === 'waiting' && p.by === undefined && p.calledT === undefined && p.kind !== 'return' && p.kind !== 'ambulance'
    && !(p.triaged !== false && p.triage === 'red') && !p.taught;
}

/** Записан к специалисту, который сегодня принимает: его берёт только он. */
const bookedHere = (p: ShiftPatient, list: readonly StaffMember[]): boolean => p.to !== undefined && list.some(x => x.id === p.to);

/** Куда направили бы по жалобам — один раз на пациента: вывод по тому, что видно, от времени не зависит. */
const routes = new WeakMap<Patient, BodySystem>();

/**
 * Куда регистратура направила бы нового больного (spec 2026-10-own-patients, часть 76): в группу болезней — систему
 * органов, как в выборе диагноза, — самую вероятную по тому, что видно у двери: жалобы, возраст, пол, сезон, профессия.
 * Тот же вывод, что считает «Похоже на», по болезням отделений, с какими его приняли. Скрытый диагноз не участвует:
 * отметка «ждёт вас» его не выдаёт.
 */
export function routeOf(db: ContentDb, s: ShiftState, p: ShiftPatient): BodySystem {
  const known = routes.get(p.patient);
  if (known !== undefined) return known;
  const obs = complaintObservations(p.patient);
  const by = new Map<BodySystem, number>();
  for (const b of posterior(db, candidatesOf(db, p.departments ?? s.meta.department), obs, contextOf(db, p.patient, obs))) {
    const sys = db.conditions[b.id].system;
    if (sys) by.set(sys, (by.get(sys) ?? 0) + b.p);
  }
  // ничья — по порядку групп в выборе диагноза
  const r = SYSTEMS.reduce<BodySystem>((best, x) => ((by.get(x) ?? 0) > (by.get(best) ?? 0) ? x : best), SYSTEMS[0]);
  routes.set(p.patient, r);
  return r;
}

/** Новый больной — «ваш» (часть 76): его группа — среди выбранных в настройках. */
export function forPlayer(db: ContentDb, s: ShiftState, p: ShiftPatient): boolean {
  return (s.meta.mine?.length ?? 0) > 0 && s.meta.mine!.includes(routeOf(db, s, p));
}

/**
 * Ждёт вас (часть 76): «ваш» новый больной, которого иначе позвал бы нанятый терапевт; записанного к специалисту,
 * который сегодня принимает, тот возьмёт сам, а повторных, срочных и со скорой нанятые врачи и так не берут.
 */
export function leftForPlayer(db: ContentDb, s: ShiftState, p: ShiftPatient): boolean {
  // принимаете только вы (часть 79) — оставлять некому: «ждёт вас» не нужно
  return !s.meta.solo && newcomer(p) && forPlayer(db, s, p) && !bookedHere(p, colleaguesOf(db, s));
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
    if ((s.desk?.[m.id] ?? 0) > s.t) continue;
    if (busy.has(m.id)) {
      releaseWaiting(db, s, all.find(p => p.status === 'inRoom' && p.by === m.id)!, m, list);
      continue;
    }
    const back = all.filter(p => p.status === 'waiting' && p.by === m.id).sort((a, b) => a.queuedT - b.queuedT || (a.id < b.id ? -1 : 1))[0];
    const id = back?.id ?? s.queue.find(x => colleagueTakes(db, s, s.patients[x], m, list));
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
 * Врач ждёт у себя результатов, а пришёл тот, кого он может принять, — отпускает ждать, как отпустил бы, будь тот в
 * очереди сразу (spec 2026-10-chapter-4, часть 59): к специалисту записанные приходят по одному, и прежде он сидел над
 * анализами, пока они уходили. Ожидание, записанное в приём вперёд, снимается; минута — сказать, и врач свободен.
 */
function releaseWaiting(db: ContentDb, s: ShiftState, p: ShiftPatient, m: StaffMember, list: readonly StaffMember[]) {
  if (p.pending.length === 0 || p.results.some(r => r.at > s.t)) return;
  const step = s.events.find(e => e.event.kind === 'colleague' && e.event.id === p.id);
  if (!step || step.t <= s.t || !s.queue.some(x => colleagueTakes(db, s, s.patients[x], m, list))) return;
  s.events = s.events.filter(e => e !== step);
  p.spent.seconds -= step.t - s.t;
  p.status = 'away';
  delete p.out;
  p.wait++;
  p.spent.seconds += MIN;
  (s.desk ??= {})[m.id] = s.t + MIN;
  schedule(s, s.t + MIN, { kind: 'free', by: m.id });
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
  const col = colleagueDay(s, by);
  col.taken = (col.taken ?? 0) + 1;
  let notices: Notice[] = [];
  if (p.status !== 'away') {
    if (!s.current) {
      p.status = 'inRoom';
      p.wait++;
      s.current = p.id;
      // дослушать ответ у врача и дойти до вас; вы — из смотровой приёмного, если были там (FR-HOS-4)
      const meet = meetIn(db, s, p);
      goTo(s, p);
      notices = [...advanceBy(db, s, busy - s.t), ...spend(db, s, p, meet)];
    } else {
      // впереди — по времени прихода, как вернувшийся с обследований
      enqueue(s, p, p.arriveT);
    }
  }
  staffDesks(db, s);
  return notices;
}

/**
 * Обследования, которые в этой больнице можно сделать, — из них выбирает нанятый врач. Больница днями та же, а сломанное
 * с утра — своё у каждого дня (FR-EQ-3): список — по больнице и сломанному.
 */
const examLists = new WeakMap<HospitalCtx, Map<string, Id[]>>();
export function examsHere(db: ContentDb, s: ShiftState): Id[] {
  const ctx = hospitalCtx(db, s);
  let byBroken = examLists.get(ctx);
  if (!byBroken) {
    byBroken = new Map();
    examLists.set(ctx, byBroken);
  }
  const key = (s.broken ?? []).join(',');
  let list = byBroken.get(key);
  if (!list) {
    list = Object.keys(db.exams).sort().filter(id => !('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, id, brokenOf(s))));
    byBroken.set(key, list);
  }
  return list;
}

/**
 * Шаг нанятого врача: тот же разумный врач, что проверяет базу (`nextStep`), с порогами своего
 * навыка. Обследование — как у вас, следующий шаг — когда придут результаты; решение — приём
 * закрыт, пара минут на карту, и врач зовёт следующего.
 */
function colleagueStep(db: ContentDb, s: ShiftState, p: ShiftPatient, ev?: ShiftEvent) {
  const m = colleagueOf(db, s, p);
  if (!m) return;
  const pct = speedOf(db, m);
  // считался по частям, пока больница доживала время команды (0.5.13), — готовый или досчитать; нет — сейчас, тем же счётом
  const job = colleagueJobs.get(s);
  const r = job && job.event === ev ? (job.result ?? whole(job.parts)) : whole(colleagueParts(db, s, p, m));
  colleagueJobs.delete(s);
  p.phase = r.phase;
  if (r.step.kind === 'exam') {
    const cost = orderExam(db, s, p, r.step.exam, pct) ?? 0;
    if (!p.done.includes(r.step.exam)) p.done.push(r.step.exam); // сделать нельзя — дальше без него
    // результатов ждать, а в очереди есть кого принять, — отпустить ждать и позвать следующего, как вы
    const list = colleaguesOf(db, s);
    if (p.pending.length > 0 && s.queue.some(x => colleagueTakes(db, s, s.patients[x], m, list))) {
      p.status = 'away';
      delete p.out;
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

/** Чей это приём, если врач его ведёт: день открыт, пациент у него в кабинете, врач в штате. */
function colleagueOf(db: ContentDb, s: ShiftState, p: ShiftPatient): StaffMember | undefined {
  if (!s.dayOpen || p.status !== 'inRoom' || !p.by) return undefined;
  return hospitalCtx(db, s).staff.find(x => x.id === p.by);
}

/** Шаг нанятого врача по частям (`stepParts`): по тому, что он знает о пациенте сейчас. */
function colleagueParts(db: ContentDb, s: ShiftState, p: ShiftPatient, m: StaffMember): Parts<StepResult> {
  const how = doctorOf(db, m);
  // «Наставник» (spec 2026-10-skills): нанятый врач под вашим началом реже забывает спросить
  const forget = how.forget / mentorOf(db, s.meta.skills, m.role);
  // специалист знает, с чем к нему записываются (spec 2026-10-chapter-4, часть 60а): у записанного к нему болезни профиля
  // вероятнее — во столько раз
  const profile = p.to === m.id ? db.roles[m.role]?.profile : undefined;
  return stepParts(db, p.patient, observationsOf(p), p.done, p.phase ?? {}, {
    candidates: candidatesOf(db, p.departments ?? s.meta.department), exams: examsHere(db, s), threshold: how.threshold, minGain: how.minGain,
    prior: [profile ? { ids: profile, x: PROFILE_PRIOR } : undefined, scenarioPrior(s.meta.scenario)],
    // навык 1–2 иногда забывает спросить перед лечением — жребий своей ветви
    skipAsk: q => forget > 0 && branch(s, `forget:${p.id}:${q}`).chance(forget * 100),
    // и что у постели (часть 39а): под монитором — тромболизис; и сколько прошло с прихода (часть 41а)
    venue: { ...venueOf(db, s), bedside: bedsideEquipment(db, s, p), minutes: Math.round((s.t - p.arriveT) / 60), ready: id => readyIn(db, s, p, id) },
  });
}

/**
 * Шаг нанятого врача по частям (0.5.13, NFR-PRF-1): событие `colleague` в начале очереди считается между кадрами — его
 * шаг, а если он решает, — и разумный врач разбора его приёма; само событие — когда посчитано. Пока считается, больница
 * не меняется: следующая команда сначала доживает всё. В памяти, не в сохранении: после открытия — заново, тем же счётом.
 */
interface ColleagueJob {
  event: ShiftEvent;
  parts: Parts<StepResult>;
  result?: StepResult;
}
const colleagueJobs = new WeakMap<ShiftState, ColleagueJob>();

/**
 * Посчитать шаг нанятого врача в начале очереди: часть — сразу (за неё уже спросили `more()` перед событием), следующие —
 * пока `more()`; true — посчитан или считать нечего.
 */
function colleagueReady(db: ContentDb, s: ShiftState, more: () => boolean): boolean {
  const ev = s.events[0].event;
  if (ev.kind !== 'colleague') return true;
  const p = s.patients[ev.id];
  const m = colleagueOf(db, s, p);
  if (!m) return true;
  let job = colleagueJobs.get(s);
  if (job?.event !== ev) colleagueJobs.set(s, (job = { event: ev, parts: colleagueParts(db, s, p, m) }));
  while (!job.result) {
    const r = job.parts.next();
    if (r.done) job.result = r.value;
    else if (!more()) return false;
  }
  // решил — закроет приём; разумный врач разбора не нужен сейчас: бережливость — по требованию (spec 2026-10-engine-speed)
  return true;
}
