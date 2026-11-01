// «Случай дня» (spec 2026-09-campaign, часть 14): один пациент в сутки, одинаковый у всех с той
// же версией базы, — зерно из даты и номера базы. Любой из последних 30 дней можно сыграть
// когда угодно; засчитывается первая попытка, переиграть можно, разбор — после. Серии дней нет:
// пропущенный день ничего не отнимает (02-values.md). Приём — тем же приёмом одного пациента,
// что прототип П4 (visit.ts); день и дата — по часам телефона, это не движок.
// С 0.6.3 (замечание владельца 17.10.2026: «Назад» с приёма — и весь прогресс пропадает) начатый приём не теряется:
// его шаги — в слоте `daily`, по дням; вошли в тот же день — шаги повторяются от зерна дня, и приём тот же до последнего
// результата: движок детерминирован (ADR 0004). Законченный приём из слота уходит — повтор, как прежде, заново.
// С 0.6.16 (часть 92, ответ владельца на вопрос 56) случай дня — трудный по мере: из зёрен дня — первая загадка, много
// болезней в ряду у двери, правда — не первая в «Похоже на», разумному врачу разбора расспроса и осмотра мало, а с
// обследованиями он ставит верный диагноз.
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id, Season, Setting } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { Rng } from '@/engine/core/rng';
import { doorRow, HARD_ROW, hardnessOf, talkOf } from '@/engine/med/difficulty';
import { complaintObservations } from '@/engine/med/exams';
import { generatePatient } from '@/engine/med/generate';
import type { Belief } from '@/engine/med/infer';
import { type DoctorRun, startRational } from '@/engine/med/policy';
import { reviewBeliefs } from '@/engine/med/review';
import type { Patient } from '@/engine/med/types';
import { T } from '@/i18n';
import { candidates, DEPARTMENT } from './caseView';
import { achievementsBy, dailyKey, type DailyRecord, profile, recordDaily } from './profile';
import { loadSlot, type RawStore, saveSlot } from './saves';
import { createVisit, type VisitView } from './visit';

/** Сколько последних дней можно сыграть. */
export const DAILY_DAYS = 30;

const two = (n: number) => String(n).padStart(2, '0');

/** День по часам телефона: 2026-09-28. */
export function dayOf(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Зерно дня: дата и номер базы — у всех с той же базой пациент тот же. */
export const dailySeed = (day: string, base: number = db.contentVersion) => fnv1a(`daily:${day.replace(/-/g, '')}:${base}`);

/** Время года дня — для пациента: зимой больше гриппа. */
export function seasonOfDay(day: string): Season {
  const m = Number(day.slice(5, 7)) - 1;
  return m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}

// --- подбор случая дня (часть 92, spec 2026-10-case-difficulty) -------------------------------

/** Сколько зёрен дня пробует подбор: трудной решаемой загадки среди них нет — случай дня — по первому. За 365 дней она
 * находится в среднем на 8-м зерне, у каждого сотого дня — дальше 60-го, позже 81-го — ни разу. */
export const DAILY_TRIES = 100;
/** Версия подбора: начатый приём, подобранный иначе (до 0.6.16 — первое зерно дня), начинается заново. */
export const DAILY_PICK = 1;

const pickSeed = (day: string, base: number, k: number) => (k === 0 ? dailySeed(day, base) : fnv1a(`${dailySeed(day, base)}:${k}`));

/** Подбор, который ещё идёт: какое зерно по счёту и разумный врач разбора у того, кто похож на загадку; `hard` — уже трудный. */
interface Picking {
  k: number;
  trial?: { seed: number; patient: Patient; door: Belief[]; doctor: DoctorRun; hard?: true };
}
const picked = new Map<string, number>();
const picking = new Map<string, Picking>();

/**
 * Шаг подбора; true — подобран. Загадка — много болезней в ряду у двери, и правда — не первая из них в «Похоже на»: иначе
 * каждый третий случай дня — ОРВИ, где загадка лишь в экспресс-тесте. У загадки — разумный врач разбора, по частям, тем же
 * зерном, что разбор приёма дня (`visit.ts`): трудный по мере (`hardnessOf`) и решаемый — к концу пути врач ставит верный
 * диагноз — он и есть случай дня; без этого у каждого четвёртого дня ошибался и разумный врач. Хватило ли расспроса и
 * осмотра, известно, как только врач взялся за первый анализ (`talkOf`): у кого хватило, дальше его не ведём.
 */
function pickStep(day: string, base: number): boolean {
  const key = `${day}:${base}`;
  if (picked.has(key)) return true;
  let st = picking.get(key);
  if (!st) picking.set(key, (st = { k: 0 }));
  const done = (seed: number) => {
    picked.set(key, seed);
    picking.delete(key);
    return true;
  };
  if (st.k >= DAILY_TRIES) return done(pickSeed(day, base, 0));
  const cands = candidates();
  if (!st.trial) {
    const seed = pickSeed(day, base, st.k);
    const patient = generatePatient(db, seed, { department: DEPARTMENT, season: seasonOfDay(day) });
    const door = reviewBeliefs(db, patient, cands, complaintObservations(patient));
    if (doorRow(door) < HARD_ROW || door[0].id === patient.truth.conditions[0].id) {
      st.k++;
      return false;
    }
    const doctor = startRational(db, patient, Rng.seeded(seed).fork('visit').fork('review'), { candidates: [...cands], exams: Object.keys(db.exams).sort() });
    st.trial = { seed, patient, door, doctor };
    return false;
  }
  const trial = st.trial;
  const decided = trial.doctor.part();
  if (decided === undefined) return false;
  if (!trial.hard) {
    const sofar = trial.doctor.sofar();
    // весь путь из расспроса и осмотра — тогда по его решению
    const talk = talkOf(db, trial.patient, cands, sofar.exams, sofar.observations) ?? (decided ? hardnessOf(db, trial.patient, cands, trial.door, trial.doctor.result()).talk : undefined);
    if (talk === undefined) return false;
    // в ряду у двери — пять и больше: трудный, если расспроса и осмотра мало
    if (!talk) trial.hard = true;
  }
  // трудный — и решаемый: разумный врач доходит до конца пути, и диагноз верный
  if (trial.hard && !decided) return false;
  if (trial.hard && trial.doctor.result().correct) return done(trial.seed);
  st.k++;
  st.trial = undefined;
  return false;
}

/** Зерно случая дня (часть 92): трудный по мере и решаемый — одинаковый у всех с той же базой; не подобран заранее — подбирается здесь. */
export function dailyCaseSeed(day: string, base: number = db.contentVersion): number {
  while (!pickStep(day, base));
  return picked.get(`${day}:${base}`)!;
}

/** Подобран ли случай дня: тогда приём открывается сразу. */
export const dailyPicked = (day: string, base: number = db.contentVersion) => picked.has(`${day}:${base}`);

/**
 * Сколько миллисекунд за раз подбирать случай дня и как часто (часть 92, NFR-PRF-1 — ни одного подвисания дольше 100 мс):
 * заранее — пока меню или список дней стоят на месте; после касания неподобранного дня — каждый кадр.
 */
const PREPARE_MS = 12;
const PREPARE_EVERY_MS = 25;
const PICK_EVERY_MS = 16;

/**
 * Подбирать случаи дней заранее, пока экран на виду: меню — сегодняшний, список — и прошлые дни по порядку; касание дня его
 * не ждёт. Отдаёт, чем остановить, — для `useFocusEffect`: меню остаётся под другими экранами, а смене этот счёт ни к чему.
 */
export function prepareDailyEvery(days: () => readonly string[] = () => [dayOf(new Date())]): () => void {
  const id = setInterval(() => prepareDaily(days(), PREPARE_MS), PREPARE_EVERY_MS);
  return () => clearInterval(id);
}

/**
 * Подобрать касанием открытый день, которого не успели заранее: по частям каждый кадр, затем `then` — открыть приём. Без
 * JIT подбор — до двух с половиной секунд, и касание его не ждёт: строка дня тем временем говорит «Подбираю случай…».
 */
export function pickDaily(day: string, then: () => void): () => void {
  const id = setInterval(() => {
    prepareDaily(day, PREPARE_MS);
    if (!dailyPicked(day)) return;
    clearInterval(id);
    then();
  }, PICK_EVERY_MS);
  return () => clearInterval(id);
}

/** Подобрать случаи дней — по порядку, по шагу, пока не кончится `budget` мс. */
export function prepareDaily(days: string | readonly string[] = dayOf(new Date()), budget = 8) {
  const t0 = performance.now();
  for (const day of typeof days === 'string' ? [days] : days) {
    // шаг за шагом: один шаг на телефоне может быть дольше бюджета — тогда один
    while (!pickStep(day, db.contentVersion)) if (performance.now() - t0 >= budget) return;
  }
}

/** Последние дни — сегодня первым. */
export function dailyDays(today: Date, n = DAILY_DAYS): string[] {
  return Array.from({ length: n }, (_, i) => dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
}

/** Строка списка: день словами, сыгран ли и как (первая попытка), начат ли приём. */
export interface DailyRow {
  day: string;
  title: string;
  hint: string;
  played: boolean;
}

// --- начатые приёмы --------------------------------------------------------------------------

export const DAILY_SLOT = 'daily';
export const DAILY_SCHEMA_VERSION = 1;

/** Шаг приёма — то, что сделал врач; от зерна дня те же шаги дают тот же приём. */
export type DailyStep = { act: Id } | { wait: true } | { dx: Id } | { tx: Id } | { setting: Setting } | { hyp: Id };

/** Начатый и не законченный приём дня: номер базы, на которой начат, версия подбора (часть 92) и шаги по порядку. */
export interface DailyStarted {
  base: number;
  pick?: number;
  steps: DailyStep[];
}

/** Начатый приём того же подбора, что сейчас: тот же пациент, его шаги можно повторить. */
const sameCase = (s: DailyStarted | undefined): s is DailyStarted => s?.base === db.contentVersion && s.pick === DAILY_PICK;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SETTINGS: readonly string[] = ['home', 'ward', 'ambulance', 'admit', 'surgery', 'transfer', 'icu', 'ricu', 'box'];
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isId = (x: unknown): x is Id => typeof x === 'string' && x.length > 0;

function stepOf(x: unknown): DailyStep | null {
  if (!isObject(x)) return null;
  if (isId(x.act)) return { act: x.act };
  if (x.wait === true) return { wait: true };
  if (isId(x.dx)) return { dx: x.dx };
  if (isId(x.tx)) return { tx: x.tx };
  if (typeof x.setting === 'string' && SETTINGS.includes(x.setting)) return { setting: x.setting as Setting };
  if (isId(x.hyp)) return { hyp: x.hyp };
  return null;
}

/** Прочитанное с диска: день — датой, база — числом, шаги — известного вида; испорченное отбрасывается. */
export function sanitizeDaily(data: unknown): Record<string, DailyStarted> {
  const out: Record<string, DailyStarted> = {};
  if (!isObject(data)) return out;
  for (const [day, s] of Object.entries(data)) {
    if (!DAY.test(day) || !isObject(s) || typeof s.base !== 'number' || !Array.isArray(s.steps)) continue;
    const steps = s.steps.map(stepOf);
    if (steps.every((x): x is DailyStep => x !== null)) out[day] = { base: s.base, ...(typeof s.pick === 'number' ? { pick: s.pick } : {}), steps };
  }
  return out;
}

let store: RawStore | null = null;
/** Начатые приёмы по дням; объект заменяется целиком — список дней перерисовывается по ссылке. */
let started: Readonly<Record<string, DailyStarted>> = {};
let saving: Promise<unknown> = Promise.resolve();
/**
 * Кто ждёт перемен в начатых — список дней. Сигнал свой, не приёма: шаг сначала меняет приём, и приём сообщает о себе
 * раньше, чем шаг записан в начатые.
 */
const listeners = new Set<() => void>();

function changed(next: Readonly<Record<string, DailyStarted>>) {
  started = next;
  for (const l of listeners) l();
}

export function subscribeDailyStarted(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setDailyStore(s: RawStore) {
  store = s;
}

/** Прочитать начатые приёмы; хранятся только дни, которые ещё можно сыграть. */
export async function loadDaily(today: Date = new Date()): Promise<void> {
  if (!store) return;
  const got = await loadSlot<unknown>(store, DAILY_SLOT);
  const all = sanitizeDaily(got?.envelope.data);
  const days = new Set(dailyDays(today));
  // начатое, пока читали, — главнее прочитанного
  changed({ ...Object.fromEntries(Object.entries(all).filter(([day]) => days.has(day))), ...started });
}

function setStarted(next: Record<string, DailyStarted>) {
  changed(next);
  const s = store;
  if (s) saving = saving.then(() => saveSlot(s, DAILY_SLOT, started, DAILY_SCHEMA_VERSION, new Date().toISOString())).catch(() => undefined);
}

/** Записано ли на диск (для тестов). */
export const dailySaved = () => saving;

/** Забыть начатое в памяти — как после перезапуска игры (для тестов). */
export function forgetDaily() {
  changed({});
}

/** Начатые приёмы — для списка дней. */
export const dailyStarted = () => started;

const verdictOf = (r: DailyRecord) => T.daily.verdict[r.verdict];

function titleOf(day: string, today: Date): string {
  const t = T.daily;
  if (day === dayOf(today)) return t.today;
  if (day === dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return t.yesterday;
  return t.date(Number(day.slice(8, 10)), Number(day.slice(5, 7)) - 1);
}

/**
 * Список последних 30 дней: у сыгранных — оценка первой попытки, у остальных — «можно
 * сыграть». Записи — параметром (из useProfile): экран перестраивается, когда день сыгран.
 */
export function dailyRows(
  done: Readonly<Record<string, DailyRecord>>,
  today: Date = new Date(),
  open: Readonly<Record<string, DailyStarted>> = started,
): DailyRow[] {
  const t = T.daily;
  return dailyDays(today).map(day => {
    const r = done[day];
    const begun = sameCase(open[day]) && open[day].steps.length > 0;
    const hint = !r ? (begun ? t.started : t.notPlayed) : r.base === db.contentVersion ? t.played(r.grade, verdictOf(r)) : t.playedBase(r.grade, verdictOf(r), r.base);
    return { day, title: titleOf(day, today), hint, played: !!r };
  });
}

/** Подпись в меню: сегодняшний случай сыгран — с оценкой; начат и не закончен — «начат» (0.6.5). */
export function dailyMenuHint(done: Readonly<Record<string, DailyRecord>>, today: Date = new Date(), open: Readonly<Record<string, DailyStarted>> = started): string {
  const day = dayOf(today);
  const r = done[day];
  return r ? T.daily.menuToday(r.grade) : sameCase(open[day]) ? T.daily.menuStarted : T.daily.menuHint;
}

// --- приём случая дня ------------------------------------------------------------------------

/** Открытый день и его запись в профиле до этого приёма — чтобы сказать про первую попытку. */
let open = dayOf(new Date());
let before: DailyRecord | undefined;

const visit = createVisit(dailySeed(open), {
  season: seasonOfDay(open),
  onFinish: d => {
    recordDaily(open, { verdict: d.verdict, grade: d.overall, base: db.contentVersion });
  },
});

const apply = (s: DailyStep) => {
  if ('act' in s) visit.act(s.act);
  else if ('wait' in s) visit.waitForResults();
  else if ('dx' in s) visit.chooseDiagnosis(s.dx);
  else if ('tx' in s) visit.toggleTreatment(s.tx);
  else if ('setting' in s) visit.chooseSetting(s.setting);
  else visit.toggleHypothesis(s.hyp);
};

/**
 * Открыть случай дня: тот же пациент — и в первый раз, и при повторе. Начатый и не законченный приём этого дня —
 * с того же места: его шаги повторяются от зерна дня; начат на другой базе — заново.
 */
export function openDaily(day: string) {
  open = day;
  before = profile().daily[day];
  visit.start(dailyCaseSeed(day), seasonOfDay(day));
  const s = started[day];
  if (s && !sameCase(s)) {
    const { [day]: _, ...rest } = started;
    setStarted(rest);
  } else if (s) {
    for (const step of s.steps) apply(step);
  }
}

/** Шаг врача: сделать и записать — выйдет с приёма, вернётся на то же место. */
function step(s: DailyStep) {
  if (visit.view().decision) return;
  apply(s);
  const was = started[open];
  setStarted({ ...started, [open]: { base: db.contentVersion, pick: DAILY_PICK, steps: [...(sameCase(was) ? was.steps : []), s] } });
}

/** Действия приёма дня — с записью шагов; итог убирает начатый приём: повтор — заново. */
export const dailyPlay = {
  act: (id: Id) => step({ act: id }),
  waitForResults: () => step({ wait: true }),
  chooseDiagnosis: (id: Id) => step({ dx: id }),
  toggleTreatment: (id: Id) => step({ tx: id }),
  chooseSetting: (setting: Setting) => step({ setting }),
  toggleHypothesis: (id: Id) => step({ hyp: id }),
  finish: () => {
    visit.finish();
    if (!visit.view().decision || !started[open]) return;
    const { [open]: _, ...rest } = started;
    setStarted(rest);
  },
};

/** Какой день открыт. */
export const openDay = () => open;

export const dailyVisit = visit;

let cache: { base: VisitView; view: VisitView } | null = null;

/** Достижения, что принёс приём дня; не принёс — поля нет, пустой рамки на итоге нет (часть 103). */
function achievementsOf(key: string): Pick<VisitView, 'achievements'> {
  const names = achievementsBy(key).map(id => db.achievements[id].name.ru);
  return names.length > 0 ? { achievements: names } : {};
}

/** Приём дня: к виду — достижения, что он принёс, и при повторе — чем засчитана первая попытка. */
export function dailyView(): VisitView {
  const base = visit.view();
  if (cache?.base === base) return cache.view;
  const view: VisitView = !base.decision ? base : {
    ...base,
    ...(before ? { firstTry: T.daily.firstTry(before.grade, verdictOf(before)) } : {}),
    ...(before ? {} : achievementsOf(dailyKey(open))),
  };
  cache = { base, view };
  return view;
}

export function useDaily(): VisitView {
  return useSyncExternalStore(visit.subscribe, dailyView, dailyView);
}

/** Начатые приёмы для списка дней: шаг приёма меняет и их. */
export function useDailyStarted(): Readonly<Record<string, DailyStarted>> {
  return useSyncExternalStore(subscribeDailyStarted, dailyStarted, dailyStarted);
}
