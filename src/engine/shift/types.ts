// Смена в амбулатории (spec 2026-09-first-shift, «Движок»; `07-data-model.md` §2).
//
// Состояние — обычный сериализуемый объект: сохранение — снимок (ADR 0010). Случайность
// в нём не хранится: всё берётся из именованных ветвей зерна смены (ADR 0004), поэтому
// одинаковые зерно и команды дают одинаковую смену — на телефоне, в тестах и в повторе.
import type { Id, Season, Setting } from '../../content/types';
import type { Scheduled } from '../core/events';
import type { Outcome } from '../med/course';
import type { BuildCommand, Built, HospitalState } from '../hospital/build';
import type { CampaignProgress } from '../campaign/campaign';
import type { CaseIncome, Ledger, Payer, RepChange } from '../economy/economy';
import type { StaffMember } from '../hospital/staff';
import type { DoctorPhase } from '../med/policy';
import type { Grade, ScoreNote } from '../med/score';
import type { Observation, Patient } from '../med/types';
import type { Bed, Stay, StayResult } from './ward';

export const SHIFT_SCHEMA_VERSION = 1;

/** Время — игровые секунды от полуночи первого дня. */
export const DAY = 24 * 3600;
export const SHIFT_START = 8 * 3600;
/** После 14:00 новые пациенты не приходят; очередь можно допринять. */
export const SHIFT_END = 14 * 3600;

/** Срочность по сортировке: красный — сразу к врачу, не уходит, а ухудшается. */
export type Triage = 'red' | 'yellow' | 'green';

/**
 * coming — ещё не пришёл (запланирован на сегодня); waiting — в очереди; inRoom — в
 * кабинете; away — ушёл на анализы и ждёт результатов; done — приём завершён; left — ушёл,
 * не дождавшись; unseen — день закрыт, а до него не дошли.
 */
/**
 * Сложность (03-game-design.md §14): «Студент» — обследования не ошибаются, пациенты ждут
 * в полтора раза дольше, подсказки «Похоже на» с частотой; «Врач» — всё как в жизни.
 * Медицина — болезни, частоты, точность обследований в базе — одна на обоих уровнях.
 */
export type Difficulty = 'student' | 'doctor';

/** admitted — лежит в палате своей больницы (spec 2026-09-chapter-2, часть 26). */
export type PatientStatus = 'coming' | 'waiting' | 'inRoom' | 'away' | 'done' | 'left' | 'unseen' | 'admitted';

/** Практика в готовой амбулатории или песочница — своя больница (spec 2026-09-own-hospital). */
/** Практика, песочница, кампания (spec 2026-09-campaign) — у каждой свои сохранения. */
/** Практика, песочница, кампания и «Смена» — один день в выбранной больнице (spec 2026-09-campaign, часть 14). */
export type Mode = 'shift' | 'sandbox' | 'campaign' | 'single';

/** ambulance — привезла скорая (spec 2026-09-chapter-2, часть 27) */
export type VisitKind = 'appointment' | 'walkIn' | 'return' | 'ambulance';
export type ReturnReason = 'worse' | 'reaction' | 'unchanged';

/** Результаты одного обследования; step — номер действия врача, за которое они пришли. */
export interface ResultBatch {
  exam: Id;
  obs: Observation[];
  at: number;
  step: number;
}

export interface PendingResult {
  exam: Id;
  readyAt: number;
  obs: Observation[];
  /** где делают (помещение больницы) и когда сама процедура — для карты; нет — в кабинете врача */
  room?: string;
  start?: number;
  end?: number;
}

export interface ShiftPatient {
  id: string;
  patient: Patient;
  arriveT: number;
  kind: VisitKind;
  /** повторное обращение: какой приём и почему вернулся */
  returnOf?: string;
  returnReason?: ReturnReason;
  triage: Triage;
  /** false — доврачебного кабинета нет: срочность никто не определил, очередь — по приходу */
  triaged?: boolean;
  /** песочница: кто платит — ОМС, ДМС или сам (spec 2026-09-own-hospital, часть 9) */
  payer?: Payer;
  /** когда впервые вызвали в кабинет — ожидание для репутации */
  calledT?: number;
  status: PatientStatus;
  /** с какого момента ждёт в очереди — для порядка */
  queuedT: number;
  /** номер ожидания: вызвали или отпустили на анализы — прежняя проверка терпения недействительна */
  wait: number;
  /** сколько секунд готов ждать; 0 — не уходит (красный) */
  patience: number;
  results: ResultBatch[];
  pending: PendingResult[];
  /** обследования, уже сделанные или назначенные этому пациенту */
  done: Id[];
  /** песочница: какие из них были показаны, когда их назначали, — их оплачивают ОМС и ДМС */
  indicated?: Id[];
  /** песочница: что заплатили за закрытый приём и что сняла экспертиза */
  paid?: CaseIncome;
  step: number;
  spent: { seconds: number; money: number };
  draft: { diagnosis?: Id; treatments: Id[]; setting: Setting };
  closed?: ClosedCase;
  /** ведёт нанятый врач — номер человека из штата (spec 2026-09-hired-doctors); нет — вы */
  by?: string;
  /** вы забрали его у нанятого врача (номер человека) и продолжили приём (часть 19) */
  from?: string;
  /** где он в приёме: ищет диагноз или спрашивает о противопоказаниях перед лечением */
  phase?: DoctorPhase;
  /** лежит в палате своей больницы: койка, план, как идёт болезнь (часть 26) */
  stay?: Stay;
  /** привезла скорая (часть 27): место в смотровой приёмного; нет — ждёт у входа */
  bay?: Bed;
  /** скорая: врач отсортировал по листу передачи (цвет — `triage`) */
  sorted?: boolean;
  /** скорая: как отсортировала бы медсестра по шкале NEWS2 и красным флагам — для сверки; `flag` — признак, что поднял цвет выше баллов */
  scale?: { triage: Triage; news2: number; flag?: Id };
}

export interface ClosedCase {
  at: number;
  diagnosis: Id;
  verdict: 'correct' | 'partly' | 'wrong';
  /** уверенность идеального врача в поставленном диагнозе, 0–1 */
  confidence: number;
  plan: { treatments: Id[]; setting: Setting };
  outcome: Outcome;
  grades: Record<'accuracy' | 'defensibility' | 'thrift' | 'treatment' | 'setting' | 'safety' | 'overall', Grade>;
  notes: ScoreNote[];
  /** цена разумного пути на этом пациенте — для итогов дня: в условных единицах и в рублях */
  rationalCost: number;
  rationalMoney: number;
  /** принял нанятый врач — номер человека из штата; нет — вы */
  by?: string;
  /** вы продолжили приём, забрав его у нанятого врача (номер человека) */
  from?: string;
  /** лежал в палате: сколько суток, обычный срок, как ушёл (часть 26) */
  stay?: StayResult;
}

export type ShiftEvent =
  | { kind: 'arrive'; id: string }
  /** подошёл срок результатов у пациента */
  | { kind: 'result'; id: string }
  /** проверить, не ушёл ли: то же ожидание (wait) — значит, терпение кончилось */
  | { kind: 'patience'; id: string; wait: number }
  /** нанятый врач: следующее действие с его пациентом (spec 2026-09-hired-doctors) */
  | { kind: 'colleague'; id: string }
  /** нанятый врач дописал карту и свободен — зовёт следующего */
  | { kind: 'free'; by: string }
  /** операция кончилась (spec 2026-09-chapter-2, часть 28): исход и следующий в очереди операционной */
  | { kind: 'opEnd'; id: string }
  | { kind: 'shiftEnd' };

export type Command =
  | { kind: 'call'; id: string }
  | { kind: 'exam'; exam: Id }
  /** в кабинете: подождать ближайший результат этого пациента */
  | { kind: 'waitResults' }
  /** отпустить ждать результатов, а пока принять другого */
  | { kind: 'sendAway' }
  | { kind: 'diagnose'; id: Id }
  | { kind: 'toggleTreatment'; id: Id }
  | { kind: 'setting'; setting: Setting }
  | { kind: 'finish' }
  /** время на карте: часы идут сами (ADR 0005) */
  | { kind: 'advance'; seconds: number }
  | { kind: 'closeDay' }
  | { kind: 'nextDay' }
  /** песочница, между сменами (ADR 0016): постройка, отмена последней, стройка закончена */
  | { kind: 'build'; cmd: BuildCommand }
  | { kind: 'undo' }
  | { kind: 'buildEnd' }
  /** песочница, между сменами: нанять кандидата, уволить, назначить в помещение (нет — в резерв) */
  | { kind: 'hire'; id: string }
  | { kind: 'fire'; id: string }
  | { kind: 'assign'; id: string; room?: string }
  /** забрать себе пациента нанятого врача (spec 2026-09-hired-doctors, часть 19) */
  | { kind: 'takeOver'; id: string }
  /** обход (spec 2026-09-chapter-2, часть 26): выписать, перевести, сменить лечение лежащего */
  | { kind: 'discharge'; id: string }
  | { kind: 'transfer'; id: string }
  | { kind: 'replan'; id: string; treatments: Id[] }
  /** скорая (часть 27): врач сортирует привезённого по листу передачи */
  | { kind: 'sort'; id: string; triage: Triage }
  /** обход (часть 28): лежащего — в операционную, операцией его диагноза */
  | { kind: 'operate'; id: string };

/** Что случилось — для интерфейса: звук, автопауза, сводка «за это время». */
export type Notice =
  | { kind: 'arrived'; id: string; triage: Triage }
  | { kind: 'resultsReady'; id: string }
  | { kind: 'left'; id: string }
  /** привезла скорая (часть 27): звук и автопауза, как у «красного» */
  | { kind: 'ambulance'; id: string }
  | { kind: 'shiftEnd' };

export interface DaySummary {
  day: number;
  arrived: number;
  seen: number;
  left: number;
  unseen: number;
  correct: number;
  partly: number;
  wrong: number;
  grades: Record<Grade, number>;
  money: number;
  /** сколько из сегодняшних случаев вернутся (запланированы повторные обращения) */
  returnsPlanned: number;
  /** сколько повторных обращений пришло сегодня */
  returnsToday: number;
  /** песочница: касса за день, остаток вечером, как изменилась репутация */
  economy?: { ledger: Ledger; cash: number; reputation: RepChange; level: { level: number; rooms: Id[] } };
  /** сколько раз назначен антибиотик, который не показан (задание главы 1) */
  needlessAntibiotic?: number;
  /** кампания: какие задания выполнены за день и какие письма пришли */
  campaign?: { done: string[]; letters: string[] };
  /** нанятые врачи: номер человека из штата → его приёмы за день; прежние строки — ваши приёмы */
  colleagues?: Record<string, ColleagueDay>;
  /** стационар за день (часть 26): поступили, выписаны (из них рано), переведены, лежат вечером; суток и обычных сроков у выписанных */
  ward?: WardDay;
  /** скорая за день (часть 27): привезли, отсортировали, из них недооценили и переоценили по шкале */
  ambulance?: AmbulanceDay;
  /** операционная за день (часть 28): операций, из них в срок `window` и позже; осложнений после операции */
  surgery?: SurgeryDay;
}

export interface SurgeryDay {
  done: number;
  onTime: number;
  late: number;
  complications: number;
}

export interface AmbulanceDay {
  arrived: number;
  sorted: number;
  under: number;
  over: number;
}

export interface WardDay {
  admitted: number;
  discharged: number;
  early: number;
  transferred: number;
  lying: number;
  stayDays: number;
  stayNorm: number;
}

/** Приёмы нанятого врача за день (spec 2026-09-hired-doctors). */
export interface ColleagueDay {
  seen: number;
  correct: number;
  partly: number;
  wrong: number;
  grades: Record<Grade, number>;
  /** сколько его пациентов вы забрали себе (часть 19) */
  taken?: number;
}

export interface PlannedReturn {
  day: number;
  of: string;
  reason: ReturnReason;
}

export interface ShiftState {
  meta: {
    schemaVersion: number;
    contentVersion: number;
    rngVersion: number;
    mode: Mode;
    /** песочница: с чего начали — пустой участок или готовая амбулатория */
    start?: 'empty' | 'clinic';
    /** кампания: номер карьеры — её слот (1–3) */
    career?: number;
    /** «Смена»: в какой больнице — запись готовой больницы (preset.*) или своя из песочницы (sandbox) */
    venue?: Id;
    seed: number;
    season: Season;
    department: Id;
    /** сложность (03-game-design.md §14); нет — «Врач»: так играли до 0.0.16 */
    difficulty?: Difficulty;
  };
  t: number;
  day: number;
  /** false — день закрыт, итоги показаны, ждём «следующий день» */
  dayOpen: boolean;
  patients: Record<string, ShiftPatient>;
  /** ждут врача: по срочности, затем по времени */
  queue: string[];
  /** кто в кабинете */
  current?: string;
  /** очередь событий по (t, seq); seq — сквозной номер постановки, для одинакового порядка */
  events: Scheduled<ShiftEvent>[];
  seq: number;
  /** когда освободится помещение с очередью к аппарату (рентген, ЭКГ): номер помещения → время */
  rooms: Record<string, number>;
  returns: PlannedReturn[];
  summary: DaySummary;
  history: DaySummary[];
  /** команды текущего дня — для отчёта об ошибке и повтора (`06-architecture.md` §8) */
  journal: Command[];
  /** своя больница — только в песочнице; практика идёт в готовой амбулатории каталога */
  hospital?: HospitalState;
  /** песочница: касса, ₽; репутация 0–100; касса текущего дня (нет — сохранение 0.0.20–0.0.21) */
  economy?: { cash: number; reputation?: number; ledger?: Ledger };
  /** «Отменить» на экране стройки: прежние больница и касса, последние UNDO_DEPTH */
  undo?: Built[];
  /** штат песочницы; в практике — штат готовой амбулатории */
  staff?: StaffMember[];
  /** кандидаты — новые каждый вечер */
  candidates?: StaffMember[];
  /** номер следующего человека */
  nextStaff?: number;
  /** кампания: глава, задания, письма (spec 2026-09-campaign) */
  campaign?: CampaignProgress;
  /** нанятые врачи: номер человека → до какого времени дописывает карту после приёма */
  desk?: Record<string, number>;
}
