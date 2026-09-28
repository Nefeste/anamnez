// «Случай дня» (spec 2026-09-campaign, часть 14): один пациент в сутки, одинаковый у всех с той
// же версией базы, — зерно из даты и номера базы. Любой из последних 30 дней можно сыграть
// когда угодно; засчитывается первая попытка, переиграть можно, разбор — после. Серии дней нет:
// пропущенный день ничего не отнимает (02-values.md). Приём — тем же приёмом одного пациента,
// что прототип П4 (visit.ts); день и дата — по часам телефона, это не движок.
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Season } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { T } from '@/i18n';
import { achievementsBy, dailyKey, type DailyRecord, profile, recordDaily } from './profile';
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

/** Последние дни — сегодня первым. */
export function dailyDays(today: Date, n = DAILY_DAYS): string[] {
  return Array.from({ length: n }, (_, i) => dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
}

/** Строка списка: день словами, сыгран ли и как (первая попытка). */
export interface DailyRow {
  day: string;
  title: string;
  hint: string;
  played: boolean;
}

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
export function dailyRows(done: Readonly<Record<string, DailyRecord>>, today: Date = new Date()): DailyRow[] {
  const t = T.daily;
  return dailyDays(today).map(day => {
    const r = done[day];
    const hint = !r ? t.notPlayed : r.base === db.contentVersion ? t.played(r.grade, verdictOf(r)) : t.playedBase(r.grade, verdictOf(r), r.base);
    return { day, title: titleOf(day, today), hint, played: !!r };
  });
}

/** Подпись в меню: сегодняшний случай сыгран — с оценкой. */
export function dailyMenuHint(done: Readonly<Record<string, DailyRecord>>, today: Date = new Date()): string {
  const r = done[dayOf(today)];
  return r ? T.daily.menuToday(r.grade) : T.daily.menuHint;
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

/** Открыть случай дня: новый приём того же пациента — и в первый раз, и при повторе. */
export function openDaily(day: string) {
  open = day;
  before = profile().daily[day];
  visit.start(dailySeed(day), seasonOfDay(day));
}

/** Какой день открыт. */
export const openDay = () => open;

export const dailyVisit = visit;

let cache: { base: VisitView; view: VisitView } | null = null;

/** Приём дня: к виду — достижения, что он принёс, и при повторе — чем засчитана первая попытка. */
export function dailyView(): VisitView {
  const base = visit.view();
  if (cache?.base === base) return cache.view;
  const view: VisitView = !base.decision ? base : {
    ...base,
    ...(before ? { firstTry: T.daily.firstTry(before.grade, verdictOf(before)) } : {}),
    ...(before ? {} : { achievements: achievementsBy(dailyKey(open)).map(id => db.achievements[id].name.ru) }),
  };
  cache = { base, view };
  return view;
}

export function useDaily(): VisitView {
  return useSyncExternalStore(visit.subscribe, dailyView, dailyView);
}
