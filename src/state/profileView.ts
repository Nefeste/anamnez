// Профиль для экранов: итоги практики строками, архив приёмов строками, достижения по группам,
// имя по умолчанию. Всё — из записей профиля (profile.ts) и базы; разбор приёма из архива
// строит session.ts.
import { db } from '@/content';
import type { AchievementCategory } from '@/content/types';
import type { Grade } from '@/engine/med/score';
import { T } from '@/i18n';
import { patientName } from './caseView';
import type { CaseRecord, Doctor, Profile } from './profile';

export interface ArchiveRow {
  key: string;
  title: string;
  diagnosis: string;
  verdict: 'correct' | 'partly' | 'wrong';
  overall: Grade;
}

export const doctorName = (d: Doctor) => T.profile.doctor(d.first, d.last);

/**
 * Портреты врача на выбор (spec 2026-09-profile, часть 16): зёрна рисунка кодом, как у
 * пациентов. С 0.0.31 у врача-женщины — свои: все шесть с длинными волосами разного цвета;
 * второй, пятый и шестой — прежние, у них волосы и были длинными. Возраст — молодого врача.
 */
export const DOCTOR_PORTRAITS: Readonly<Record<Doctor['sex'], readonly number[]>> = {
  m: [3, 14, 27, 38, 49, 60],
  f: [16, 14, 71, 20, 49, 60],
};
export const DOCTOR_AGE = 31;
export const portraitSeed = (d: Doctor) => DOCTOR_PORTRAITS[d.sex][d.portrait ?? 0] ?? DOCTOR_PORTRAITS[d.sex][0];

/** Звание — по числу принятых пациентов во всех режимах; только растёт. */
export const RANK_CASES = [0, 25, 100, 300] as const;

export function rankOf(cases: number): number {
  let r = 0;
  RANK_CASES.forEach((n, i) => {
    if (cases >= n) r = i;
  });
  return r;
}

export const rankName = (cases: number) => T.profile.ranks[rankOf(cases)];

/** Лестница званий целиком — без «осталось». */
export const rankLadder = () => T.profile.rankLadder(RANK_CASES.map((n, i) => ({ name: T.profile.ranks[i], cases: n })));

/** Сколько болезней базы встречалось в практике и сколько их всего. */
export function seenCount(p: Profile): { seen: number; total: number } {
  const ids = Object.keys(db.conditions);
  return { seen: ids.filter(id => (p.seen[id] ?? 0) > 0).length, total: ids.length };
}

/** Итоги практики — всё время, во всех сменах; приёмов нет — пусто. */
export function practiceLines(p: Profile): string[] {
  const s = p.stats;
  if (s.cases === 0) return [];
  const t = T.profile;
  const { seen, total } = seenCount(p);
  return [
    t.cases(s.cases),
    t.verdicts(s.correct, s.partly, s.wrong, Math.round((s.correct / s.cases) * 100)),
    t.grades(s.grades.A, s.grades.B, s.grades.C, s.grades.D),
    t.money(T.common.rub(Math.round(s.money / s.cases))),
    // с 0.0.30: у прежних приёмов этих счётчиков нет — у строк своё «из скольких»
    ...(s.timed > 0 ? [t.minutes(Math.round(s.minutes / s.timed))] : []),
    ...(s.antibiotics.given > 0 ? [t.antibiotics(s.antibiotics.indicated, s.antibiotics.given)] : []),
    ...(s.danger.met > 0 ? [t.danger(s.danger.caught, s.danger.met)] : []),
    t.seen(seen, total),
  ];
}

export function archiveRows(archive: readonly CaseRecord[]): ArchiveRow[] {
  return archive.map(r => {
    const p = r.patient;
    const c = p.closed!;
    return {
      key: r.key,
      title: T.profile.row(r.day, `${patientName(p.patient)}, ${T.spikes.patient.years(p.patient.age)}`),
      diagnosis: db.conditions[c.diagnosis]?.name.ru ?? c.diagnosis,
      verdict: c.verdict,
      overall: c.grades.overall,
    };
  });
}

/** Достижение в списке: полученное — с датой, остальное — что нужно сделать. */
export interface AchievementRow {
  id: string;
  name: string;
  need: string;
  got?: string;
}

const CATEGORIES: AchievementCategory[] = ['practice', 'diagnosis', 'care', 'knowledge', 'hospital', 'campaign', 'daily'];

/** День получения — числом, по часам телефона: 28.09.2026. */
export function dateText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Сколько получено и сколько всего. */
export function achievementCount(p: Profile): { got: number; total: number } {
  const ids = Object.keys(db.achievements);
  return { got: ids.filter(id => p.achievements.got[id]).length, total: ids.length };
}

/** Достижения по группам, в порядке записи; пустых групп нет. */
export function achievementGroups(p: Profile): { key: AchievementCategory; title: string; items: AchievementRow[] }[] {
  const all = Object.values(db.achievements);
  return CATEGORIES.map(key => ({
    key,
    title: T.profile.achievementGroup[key],
    items: all.filter(a => a.category === key).map(a => {
      const g = p.achievements.got[a.id];
      return { id: a.id, name: a.name.ru, need: a.need.ru, ...(g ? { got: T.profile.gotOn(dateText(g.at)) } : {}) };
    }),
  })).filter(g => g.items.length > 0);
}

/** Имя по умолчанию — из тех же списков, что у пациентов (i18n/sections/names.ts). */
export function suggestDoctor(sex: 'm' | 'f', random: () => number): Doctor {
  const n = T.names;
  const pick = (a: readonly string[]) => a[Math.floor(random() * a.length) % a.length];
  const surname = pick(n.surnames);
  return { sex, first: pick(sex === 'm' ? n.male : n.female), last: sex === 'm' ? surname : n.feminine(surname) };
}
