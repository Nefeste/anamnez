// Профиль врача (spec 2026-09-first-shift, «Профиль-минимум»; 07-data-model.md §3): имя и пол,
// статистика приёмов, архив последних 50 с разбором и «встречалось в практике», достижения
// (spec 2026-09-campaign, часть 13) — полученные с датой и счётчики, из которых они. Живёт только
// на телефоне (устав студии, 07-privacy.md): никуда не отправляется. Слот `profile` — тем же
// сырым хранилищем, что смена и настройки (ADR 0010). Случай попадает в профиль один раз:
// ключ — зерно смены и номер пациента, поэтому повтор после сбоя и перечитанное сохранение
// ничего не удваивают; закрытый день — так же, по ключу дня.
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id } from '@/content/types';
import { type CareerFacts, caseFacts, newAchievements } from '@/engine/career/achievements';
import type { Grade } from '@/engine/med/score';
import type { ShiftPatient } from '@/engine/shift/types';
import { loadSlot, type RawStore, saveSlot } from './saves';

export const PROFILE_SLOT = 'profile';
export const PROFILE_SCHEMA_VERSION = 1;
/** Сколько последних приёмов хранит архив. */
export const ARCHIVE_SIZE = 50;
/** Сколько ключей закрытых дней помнить: день не засчитывается достижениям дважды. */
export const DAY_KEYS = 60;
/** Портретов врача на выбор в форме (profileView.DOCTOR_PORTRAITS). */
export const PORTRAITS = 6;
/** «Принесла» прежняя практика: достижение за приёмы до 0.0.26 — строки на итоге у него нет. */
export const EARLIER = 'earlier';
/** Сколько дней «Случая дня» хранить: в списке — последние 30. */
export const DAILY_KEEP = 60;
/** Ключ случая дня — что принесло достижение. */
export const dailyKey = (day: string) => `daily:${day}`;

export interface Doctor {
  first: string;
  last: string;
  sex: 'm' | 'f';
  /** какой из портретов формы врача (profileView.DOCTOR_PORTRAITS); нет — первый */
  portrait?: number;
}

export interface ProfileStats {
  cases: number;
  correct: number;
  partly: number;
  wrong: number;
  grades: Record<Grade, number>;
  /** сколько стоили обследования всех приёмов, ₽ */
  money: number;
  /**
   * С 0.0.30 (spec 2026-09-profile, часть 16): минуты врача — и у скольких приёмов они есть
   * (у прежних нет); антибиотики — назначены и показаны; опасное — встретилось и распознано.
   */
  minutes: number;
  timed: number;
  antibiotics: { given: number; indicated: number };
  danger: { met: number; caught: number };
}

/** Закрытый приём — всё, из чего заново строится его разбор (session.ts, archiveCaseView). */
export interface CaseRecord {
  /** зерно смены и номер пациента */
  key: string;
  seed: number;
  department: Id;
  /** день практики, когда приём закрыт */
  day: number;
  patient: ShiftPatient;
}

/** Достижения: полученные и счётчики, из которых они складываются (engine/career/achievements.ts). */
export interface CareerProgress {
  /** получено: достижение → когда (ISO) и чем — ключ приёма или дня */
  got: Record<Id, { at: string; by: string }>;
  /** рабочие дни; верных подряд сейчас; приёмы на A, бережливые, с вопросом об аллергии; дни, когда приняли всех */
  days: number;
  run: number;
  gradeA: number;
  thrift: number;
  allergy: number;
  noLeftDays: number;
  /** сыгранные случаи дня — первые попытки */
  daily: number;
  /** ключи закрытых дней, новые первыми, не больше DAY_KEYS */
  closedDays: string[];
}

/** «Смена» — лучший результат в больнице: общий балл и оценка, кого приняли, зерно, когда (ISO). */
export interface SingleBest {
  points: number;
  overall: Grade;
  seen: number;
  arrived: number;
  seed: number;
  at: string;
}

/** «Случай дня» — первая попытка: вердикт, итоговая оценка, версия базы, когда сыгран (ISO). */
export interface DailyRecord {
  verdict: 'correct' | 'partly' | 'wrong';
  grade: Grade;
  base: number;
  at: string;
}

/** Закрытый день — для достижений: ключ, кого приняли, приняли ли всех, что работает в своей больнице, выполнена ли глава. */
export interface DayRecord {
  key: string;
  seen: number;
  noLeft: boolean;
  rooms: Id[];
  chapters: Id[];
}

export interface Profile {
  doctor?: Doctor;
  stats: ProfileStats;
  /** болезнь → сколько раз встречалась в практике (настоящая, а не поставленная) */
  seen: Record<Id, number>;
  /** новые первыми */
  archive: CaseRecord[];
  achievements: CareerProgress;
  /** «Случай дня»: день (ГГГГ-ММ-ДД) → первая попытка, последние DAILY_KEEP дней */
  daily: Record<string, DailyRecord>;
  /** «Смена»: больница (preset.* или sandbox) → лучший результат */
  best: Record<string, SingleBest>;
}

export interface ProfileView extends Profile {
  status: 'idle' | 'loading' | 'ready';
}

const GRADES: Grade[] = ['A', 'B', 'C', 'D'];
const emptyStats = (): ProfileStats => ({
  cases: 0, correct: 0, partly: 0, wrong: 0, grades: { A: 0, B: 0, C: 0, D: 0 }, money: 0,
  minutes: 0, timed: 0, antibiotics: { given: 0, indicated: 0 }, danger: { met: 0, caught: 0 },
});
const emptyProgress = (): CareerProgress => ({ got: {}, days: 0, run: 0, gradeA: 0, thrift: 0, allergy: 0, noLeftDays: 0, daily: 0, closedDays: [] });
const empty = (): Profile => ({ stats: emptyStats(), seen: {}, archive: [], achievements: emptyProgress(), daily: {}, best: {} });
const VERDICTS = ['correct', 'partly', 'wrong'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

let store: RawStore | null = null;
let current: Profile = empty();
let status: ProfileView['status'] = 'idle';
let loading: Promise<void> | null = null;
let saving: Promise<unknown> = Promise.resolve();
/** приёмы и дни, пришедшие до того, как профиль прочитан с диска: запишутся после чтения */
let waiting: Omit<CaseRecord, 'key'>[] = [];
let waitingDays: DayRecord[] = [];
let waitingDaily: { day: string; r: Omit<DailyRecord, 'at'> }[] = [];
let view: ProfileView = { ...current, status };
const listeners = new Set<() => void>();

function changed() {
  view = { ...current, status };
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setProfileStore(s: RawStore) {
  store = s;
}

export const caseKey = (seed: number, id: string) => `${seed}:${id}`;

/** Смена меняет своих пациентов на месте: в профиль — копия. */
const copy = (p: ShiftPatient): ShiftPatient => JSON.parse(JSON.stringify(p));
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);

/**
 * Прочитанное с диска — поле за полем, как настройки: испорченное поле берётся пустым и не
 * ломает остальные; запись архива без пациента или без итога приёма отбрасывается.
 */
export function sanitizeProfile(data: unknown): Profile {
  const d = isObject(data) ? data : {};
  const out = empty();
  const doc = d.doctor;
  if (isObject(doc) && typeof doc.first === 'string' && typeof doc.last === 'string' && (doc.sex === 'm' || doc.sex === 'f')) {
    out.doctor = { first: doc.first, last: doc.last, sex: doc.sex };
    if (Number.isInteger(doc.portrait) && (doc.portrait as number) >= 0 && (doc.portrait as number) < PORTRAITS) out.doctor.portrait = doc.portrait as number;
  }
  const st = isObject(d.stats) ? d.stats : {};
  const grades = isObject(st.grades) ? st.grades : {};
  const ab = isObject(st.antibiotics) ? st.antibiotics : {};
  const dn = isObject(st.danger) ? st.danger : {};
  out.stats = {
    cases: count(st.cases), correct: count(st.correct), partly: count(st.partly), wrong: count(st.wrong),
    grades: { A: count(grades.A), B: count(grades.B), C: count(grades.C), D: count(grades.D) },
    money: count(st.money),
    minutes: count(st.minutes), timed: count(st.timed),
    antibiotics: { given: count(ab.given), indicated: count(ab.indicated) },
    danger: { met: count(dn.met), caught: count(dn.caught) },
  };
  if (isObject(d.seen)) for (const [id, n] of Object.entries(d.seen)) if (count(n) > 0) out.seen[id] = count(n);
  const a = isObject(d.achievements) ? d.achievements : {};
  if (isObject(a.got)) {
    for (const [id, g] of Object.entries(a.got)) if (isObject(g) && typeof g.at === 'string' && typeof g.by === 'string') out.achievements.got[id] = { at: g.at, by: g.by };
  }
  for (const k of ['days', 'run', 'gradeA', 'thrift', 'allergy', 'noLeftDays', 'daily'] as const) out.achievements[k] = count(a[k]);
  if (isObject(d.daily)) {
    for (const [day, r] of Object.entries(d.daily)) {
      if (DAY.test(day) && isObject(r) && VERDICTS.includes(r.verdict as never) && GRADES.includes(r.grade as Grade) && typeof r.at === 'string') {
        out.daily[day] = { verdict: r.verdict as DailyRecord['verdict'], grade: r.grade as Grade, base: count(r.base), at: r.at };
      }
    }
  }
  if (Array.isArray(a.closedDays)) out.achievements.closedDays = a.closedDays.filter((k): k is string => typeof k === 'string').slice(0, DAY_KEYS);
  if (isObject(d.best)) {
    for (const [venue, b] of Object.entries(d.best)) {
      if (isObject(b) && typeof b.points === 'number' && GRADES.includes(b.overall as Grade) && typeof b.at === 'string') {
        out.best[venue] = { points: b.points, overall: b.overall as Grade, seen: count(b.seen), arrived: count(b.arrived), seed: count(b.seed), at: b.at };
      }
    }
  }
  if (Array.isArray(d.archive)) {
    out.archive = d.archive
      .filter((r): r is CaseRecord => isObject(r) && typeof r.key === 'string' && typeof r.seed === 'number' && typeof r.department === 'string'
        && typeof r.day === 'number' && isObject(r.patient) && isObject((r.patient as Record<string, unknown>).closed))
      .slice(0, ARCHIVE_SIZE);
  }
  return out;
}

/** Прочитать профиль, если ещё не читали; файла нет или он испорчен — пустой профиль. */
export function loadProfile(): Promise<void> {
  if (status === 'ready') return Promise.resolve();
  if (loading) return loading;
  const st = store;
  if (!st) {
    status = 'ready';
    changed();
    return Promise.resolve();
  }
  status = 'loading';
  changed();
  loading = loadSlot<Profile>(st, PROFILE_SLOT)
    .then(r => {
      if (!r) return;
      current = sanitizeProfile(r.envelope.data);
      // приёмы из версий до достижений: полученное по ним — сразу, а не строкой у следующего приёма
      if (earn(current.achievements, factsOf(current.stats, current.seen, current.achievements), EARLIER).length > 0) void persist();
    })
    .catch(() => undefined)
    .finally(() => {
      status = 'ready';
      loading = null;
      const early = waiting;
      const days = waitingDays;
      const dailies = waitingDaily;
      waiting = [];
      waitingDays = [];
      waitingDaily = [];
      const added = recordCases(early);
      for (const d of days) recordDay(d);
      for (const x of dailies) recordDaily(x.day, x.r);
      if (added === 0 && days.length === 0 && dailies.length === 0) changed();
    });
  return loading;
}

function persist(): Promise<unknown> {
  const st = store;
  const data = current;
  if (st) {
    saving = saving
      .then(() => saveSlot(st, PROFILE_SLOT, data, PROFILE_SCHEMA_VERSION, new Date().toISOString()))
      .catch(() => undefined); // не записалось — профиль в памяти, запишется со следующим приёмом
  }
  return saving;
}

/** Имя и пол врача: при первом запуске и из профиля. */
export function setDoctor(doctor: Doctor): Promise<unknown> {
  const portrait = Number.isInteger(doctor.portrait) && doctor.portrait! >= 0 && doctor.portrait! < PORTRAITS ? { portrait: doctor.portrait } : {};
  current = { ...current, doctor: { first: doctor.first.trim(), last: doctor.last.trim(), sex: doctor.sex, ...portrait } };
  changed();
  return persist();
}

/**
 * Записать закрытые приёмы, которых в профиле ещё нет: статистика, «встречалось в
 * практике», архив (новые первыми, не больше ARCHIVE_SIZE). Отдаёт, сколько добавлено.
 * Лежавший в своём стационаре (часть 26) записан при поступлении; выписан или переведён —
 * в архиве его приём заменяется нынешним, с исходом, а статистика не считается второй раз.
 */
export function recordCases(cases: readonly Omit<CaseRecord, 'key'>[]): number {
  // профиль ещё не прочитан: запись поверх файла стёрла бы его — ждём чтения
  if (status !== 'ready') {
    waiting.push(...cases.map(c => ({ ...c, patient: copy(c.patient) })));
    return 0;
  }
  const known = new Set(current.archive.map(r => r.key));
  const left = new Map(cases.filter(c => c.patient.status !== 'admitted').map(c => [caseKey(c.seed, c.patient.id), c]));
  const archive = current.archive.map(r => {
    const now = r.patient.status === 'admitted' ? left.get(r.key) : undefined;
    return now?.patient.closed ? { ...r, patient: copy(now.patient) } : r;
  });
  const discharged = archive.some((r, i) => r !== current.archive[i]);
  const fresh = cases
    .filter(c => c.patient.closed && !known.has(caseKey(c.seed, c.patient.id)))
    .sort((a, b) => a.patient.closed!.at - b.patient.closed!.at);
  if (fresh.length === 0) {
    if (discharged) {
      current = { ...current, archive };
      changed();
      void persist();
    }
    return 0;
  }
  const stats: ProfileStats = {
    ...current.stats, grades: { ...current.stats.grades }, antibiotics: { ...current.stats.antibiotics }, danger: { ...current.stats.danger },
  };
  const seen = { ...current.seen };
  const ach = { ...current.achievements, got: { ...current.achievements.got } };
  const added: CaseRecord[] = [];
  for (const c of fresh) {
    const closed = c.patient.closed!;
    const key = caseKey(c.seed, c.patient.id);
    stats.cases++;
    stats[closed.verdict]++;
    if (GRADES.includes(closed.grades.overall)) stats.grades[closed.grades.overall]++;
    stats.money += c.patient.spent.money;
    for (const cond of c.patient.patient.truth.conditions) seen[cond.id] = (seen[cond.id] ?? 0) + 1;
    const f = caseFacts(db, c.patient);
    stats.minutes += Math.round(c.patient.spent.seconds / 60);
    stats.timed++;
    if (f.antibiotic) {
      stats.antibiotics.given++;
      if (f.antibioticIndicated) stats.antibiotics.indicated++;
    }
    if (f.danger) {
      stats.danger.met++;
      if (f.caught) stats.danger.caught++;
    }
    ach.run = f.correct ? ach.run + 1 : 0;
    if (f.gradeA) ach.gradeA++;
    if (f.thrift) ach.thrift++;
    if (f.allergy) ach.allergy++;
    earn(ach, factsOf(stats, seen, ach), key);
    added.unshift({ ...c, key, patient: copy(c.patient) });
  }
  current = { ...current, stats, seen, achievements: ach, archive: [...added, ...archive].slice(0, ARCHIVE_SIZE) };
  changed();
  void persist();
  return added.length;
}

/** Что есть сейчас — для проверки достижений; помещения и главы — только у закрытого дня. */
function factsOf(stats: ProfileStats, seen: Record<Id, number>, a: CareerProgress, day?: DayRecord): CareerFacts {
  return {
    cases: stats.cases, days: a.days, run: a.run, gradeA: a.gradeA, thrift: a.thrift, allergy: a.allergy, noLeftDays: a.noLeftDays, daily: a.daily, seen,
    rooms: day?.rooms ?? [], chapters: day?.chapters ?? [],
  };
}

/** Новые достижения — в `a.got` с датой и тем, что их принесло; отдаёт их. */
function earn(a: CareerProgress, f: CareerFacts, by: string): Id[] {
  const fresh = newAchievements(db, f, a.got);
  const at = new Date().toISOString();
  for (const id of fresh) a.got[id] = { at, by };
  return fresh;
}

/**
 * Закрытый день — в счёт достижений, один раз по ключу: рабочий ли он, приняты ли все,
 * какие помещения своей больницы работали, выполнена ли глава. Отдаёт новые достижения.
 */
export function recordDay(d: DayRecord): Id[] {
  if (status !== 'ready') {
    waitingDays.push(d);
    return [];
  }
  if (current.achievements.closedDays.includes(d.key)) return [];
  const ach = { ...current.achievements, got: { ...current.achievements.got }, closedDays: [d.key, ...current.achievements.closedDays].slice(0, DAY_KEYS) };
  if (d.seen > 0) ach.days++;
  if (d.noLeft) ach.noLeftDays++;
  const fresh = earn(ach, factsOf(current.stats, current.seen, ach, d), d.key);
  current = { ...current, achievements: ach };
  changed();
  void persist();
  return fresh;
}

/**
 * «Случай дня» сыгран: засчитывается первая попытка, повтор ничего не меняет. Хранятся
 * последние DAILY_KEEP дней; счёт сыгранных — для «семи случаев дня». Отдаёт новые достижения.
 */
export function recordDaily(day: string, r: Omit<DailyRecord, 'at'>): Id[] {
  if (status !== 'ready') {
    waitingDaily.push({ day, r });
    return [];
  }
  if (current.daily[day]) return [];
  const kept = Object.keys(current.daily).sort().reverse().slice(0, DAILY_KEEP - 1);
  const daily: Record<string, DailyRecord> = { [day]: { ...r, at: new Date().toISOString() } };
  for (const k of kept) daily[k] = current.daily[k];
  const ach = { ...current.achievements, got: { ...current.achievements.got }, daily: current.achievements.daily + 1 };
  const fresh = earn(ach, factsOf(current.stats, current.seen, ach), dailyKey(day));
  current = { ...current, daily, achievements: ach };
  changed();
  void persist();
  return fresh;
}

/**
 * «Смена» закрыта: лучший ли это результат в этой больнице — по общей оценке, при равной — по
 * баллу, затем — кого приняли больше. Отдаёт прежний лучший (его не было — undefined) и стал ли
 * этот лучшим.
 */
export function recordSingle(venue: string, r: Omit<SingleBest, 'at'>): { previous?: SingleBest; best: boolean } {
  const previous = current.best[venue];
  const rank = (x: Omit<SingleBest, 'at'>) => [GRADES.length - GRADES.indexOf(x.overall), x.points, x.seen];
  const [a, b] = [rank(r), previous ? rank(previous) : []];
  const better = !previous || a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
  // повтор той же смены (после сбоя) лучшим не становится: равный результат с тем же зерном
  if (previous && previous.seed === r.seed && previous.points === r.points && previous.seen === r.seen) return { best: true };
  if (!better || status !== 'ready') return { ...(previous ? { previous } : {}), best: false };
  current = { ...current, best: { ...current.best, [venue]: { ...r, at: new Date().toISOString() } } };
  changed();
  void persist();
  return { ...(previous ? { previous } : {}), best: true };
}

/** Достижения, которые принёс приём или день (по ключу), — в порядке записи. */
export function achievementsBy(key: string): Id[] {
  const got = current.achievements.got;
  return Object.keys(db.achievements).filter(id => got[id]?.by === key);
}

/** Профиль сейчас — для смены и энциклопедии; экранам — useProfile. */
export function profile(): Profile {
  return current;
}

export function useProfile(): ProfileView {
  return useSyncExternalStore(subscribe, () => view, () => view);
}

/** Запись архива по ключу — для экрана разбора. */
export function archivedCase(key: string): CaseRecord | undefined {
  return current.archive.find(r => r.key === key);
}

/** Для тестов: забыть профиль в памяти, как после перезапуска приложения. */
export function forgetProfile() {
  current = empty();
  status = 'idle';
  loading = null;
  waiting = [];
  waitingDays = [];
  waitingDaily = [];
  changed();
}

/** Дождаться записи — для тестов. */
export function profileSaved(): Promise<unknown> {
  return saving;
}
