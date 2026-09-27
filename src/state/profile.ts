// Профиль врача (spec 2026-09-first-shift, «Профиль-минимум»; 07-data-model.md §3): имя и пол,
// статистика приёмов, архив последних 50 с разбором и «встречалось в практике». Живёт только
// на телефоне (устав студии, 07-privacy.md): никуда не отправляется. Слот `profile` — тем же
// сырым хранилищем, что смена и настройки (ADR 0010). Случай попадает в профиль один раз:
// ключ — зерно смены и номер пациента, поэтому повтор после сбоя и перечитанное сохранение
// ничего не удваивают.
import { useSyncExternalStore } from 'react';
import type { Id } from '@/content/types';
import type { Grade } from '@/engine/med/score';
import type { ShiftPatient } from '@/engine/shift/types';
import { loadSlot, type RawStore, saveSlot } from './saves';

export const PROFILE_SLOT = 'profile';
export const PROFILE_SCHEMA_VERSION = 1;
/** Сколько последних приёмов хранит архив. */
export const ARCHIVE_SIZE = 50;

export interface Doctor {
  first: string;
  last: string;
  sex: 'm' | 'f';
}

export interface ProfileStats {
  cases: number;
  correct: number;
  partly: number;
  wrong: number;
  grades: Record<Grade, number>;
  /** сколько стоили обследования всех приёмов, ₽ */
  money: number;
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

export interface Profile {
  doctor?: Doctor;
  stats: ProfileStats;
  /** болезнь → сколько раз встречалась в практике (настоящая, а не поставленная) */
  seen: Record<Id, number>;
  /** новые первыми */
  archive: CaseRecord[];
}

export interface ProfileView extends Profile {
  status: 'idle' | 'loading' | 'ready';
}

const GRADES: Grade[] = ['A', 'B', 'C', 'D'];
const emptyStats = (): ProfileStats => ({ cases: 0, correct: 0, partly: 0, wrong: 0, grades: { A: 0, B: 0, C: 0, D: 0 }, money: 0 });
const empty = (): Profile => ({ stats: emptyStats(), seen: {}, archive: [] });

let store: RawStore | null = null;
let current: Profile = empty();
let status: ProfileView['status'] = 'idle';
let loading: Promise<void> | null = null;
let saving: Promise<unknown> = Promise.resolve();
/** приёмы, пришедшие до того, как профиль прочитан с диска: запишутся после чтения */
let waiting: Omit<CaseRecord, 'key'>[] = [];
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
  }
  const st = isObject(d.stats) ? d.stats : {};
  const grades = isObject(st.grades) ? st.grades : {};
  out.stats = {
    cases: count(st.cases), correct: count(st.correct), partly: count(st.partly), wrong: count(st.wrong),
    grades: { A: count(grades.A), B: count(grades.B), C: count(grades.C), D: count(grades.D) },
    money: count(st.money),
  };
  if (isObject(d.seen)) for (const [id, n] of Object.entries(d.seen)) if (count(n) > 0) out.seen[id] = count(n);
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
      if (r) current = sanitizeProfile(r.envelope.data);
    })
    .catch(() => undefined)
    .finally(() => {
      status = 'ready';
      loading = null;
      const early = waiting;
      waiting = [];
      if (recordCases(early) === 0) changed();
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
  current = { ...current, doctor: { first: doctor.first.trim(), last: doctor.last.trim(), sex: doctor.sex } };
  changed();
  return persist();
}

/**
 * Записать закрытые приёмы, которых в профиле ещё нет: статистика, «встречалось в
 * практике», архив (новые первыми, не больше ARCHIVE_SIZE). Отдаёт, сколько добавлено.
 */
export function recordCases(cases: readonly Omit<CaseRecord, 'key'>[]): number {
  // профиль ещё не прочитан: запись поверх файла стёрла бы его — ждём чтения
  if (status !== 'ready') {
    waiting.push(...cases.map(c => ({ ...c, patient: copy(c.patient) })));
    return 0;
  }
  const known = new Set(current.archive.map(r => r.key));
  const fresh = cases
    .filter(c => c.patient.closed && !known.has(caseKey(c.seed, c.patient.id)))
    .sort((a, b) => a.patient.closed!.at - b.patient.closed!.at);
  if (fresh.length === 0) return 0;
  const stats: ProfileStats = { ...current.stats, grades: { ...current.stats.grades } };
  const seen = { ...current.seen };
  const added: CaseRecord[] = [];
  for (const c of fresh) {
    const closed = c.patient.closed!;
    stats.cases++;
    stats[closed.verdict]++;
    if (GRADES.includes(closed.grades.overall)) stats.grades[closed.grades.overall]++;
    stats.money += c.patient.spent.money;
    for (const cond of c.patient.patient.truth.conditions) seen[cond.id] = (seen[cond.id] ?? 0) + 1;
    added.unshift({ ...c, key: caseKey(c.seed, c.patient.id), patient: copy(c.patient) });
  }
  current = { ...current, stats, seen, archive: [...added, ...current.archive].slice(0, ARCHIVE_SIZE) };
  changed();
  void persist();
  return added.length;
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
  changed();
}

/** Дождаться записи — для тестов. */
export function profileSaved(): Promise<unknown> {
  return saving;
}
