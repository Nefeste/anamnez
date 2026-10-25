// Профиль для экранов: итоги практики числами — для плиток и графиков (0.6.2), архив приёмов строками, достижения
// по группам, имя по умолчанию. Всё — из записей профиля (profile.ts) и базы; разбор приёма из архива строит
// session.ts.
import { db } from '@/content';
import type { AchievementCategory, Id } from '@/content/types';
import { LEVELS, levelOf, skillsFor, specialtiesOf, toNextLevel } from '@/engine/career/skills';
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

/**
 * Итоги практики — всё время, во всех сменах — числами для плиток и графиков (0.6.2); приёмов нет — нет и итогов.
 * Минуты, антибиотики и опасное — с 0.0.30: у прежних приёмов этих счётчиков нет — у них своё «из скольких».
 */
export interface PracticeView {
  cases: number;
  /** доля верных диагнозов, % — округлённо */
  correctPct: number;
  verdicts: { correct: number; partly: number; wrong: number };
  grades: Record<Grade, number>;
  /** обследования — в среднем на приём, ₽ */
  money: number;
  minutes?: number;
  antibiotics?: { ok: number; of: number };
  danger?: { ok: number; of: number };
  /** трудные случаи (часть 92): верный диагноз — из скольких; с 0.6.16 */
  hard?: { ok: number; of: number };
  seen: { n: number; of: number };
}

export function practiceView(p: Profile): PracticeView | undefined {
  const s = p.stats;
  if (s.cases === 0) return undefined;
  const { seen, total } = seenCount(p);
  return {
    cases: s.cases,
    correctPct: Math.round((s.correct / s.cases) * 100),
    verdicts: { correct: s.correct, partly: s.partly, wrong: s.wrong },
    grades: { A: s.grades.A, B: s.grades.B, C: s.grades.C, D: s.grades.D },
    money: Math.round(s.money / s.cases),
    ...(s.timed > 0 ? { minutes: Math.round(s.minutes / s.timed) } : {}),
    ...(s.antibiotics.given > 0 ? { antibiotics: { ok: s.antibiotics.indicated, of: s.antibiotics.given } } : {}),
    ...(s.danger.met > 0 ? { danger: { ok: s.danger.caught, of: s.danger.met } } : {}),
    ...(s.hard.met > 0 ? { hard: { ok: s.hard.correct, of: s.hard.met } } : {}),
    seen: { n: seen, of: total },
  };
}

/** Доля в процентах — для легенды: у трёх частей сумма может разойтись со 100 на единицу, как у любых округлений. */
export const pctOf = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

export function archiveRows(archive: readonly CaseRecord[]): ArchiveRow[] {
  return archive.map(r => {
    const p = r.patient;
    const c = p.closed!;
    return {
      key: r.key,
      title: T.profile.row(r.day, `${patientName(p.patient)}, ${T.spikes.patient.years(p.patient.age)}`),
      // умер в смотровой до решения (часть 95) — диагноза нет
      diagnosis: db.conditions[c.diagnosis]?.name.ru ?? (c.diagnosis || T.spikes.patient.noDiagnosis),
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

const CATEGORIES: AchievementCategory[] = ['practice', 'diagnosis', 'care', 'knowledge', 'hospital', 'campaign', 'daily', 'challenge'];

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

/**
 * Специальности профиля (spec 2026-10-skills, часть 75): уровень и сколько верных диагнозов до следующего; для шкалы
 * (0.6.2) — очки, порог нынешнего уровня и следующего: шкала идёт от одного к другому, у высшего — без порога.
 */
export function specialtyRows(p: Pick<Profile, 'experience'>): {
  department: Id; name: string; level: string; hint: string; points: number; from: number; of?: number;
}[] {
  const t = T.profile;
  return specialtiesOf(db).map(department => {
    const points = p.experience[department] ?? 0;
    const next = toNextLevel(points);
    const of = LEVELS.find(x => points < x);
    return {
      department, name: t.specialty[department] ?? department, level: t.levelShort(levelOf(points)), hint: next > 0 ? t.toNext(Math.ceil(next)) : t.topLevel,
      points, from: [0, ...LEVELS].filter(x => x <= points).at(-1) ?? 0, ...(of !== undefined ? { of } : {}),
    };
  });
}

/** Умения профиля — строкой: название и что даёт. */
export function skillRows(p: Pick<Profile, 'experience'>): { id: Id; line: string }[] {
  return skillsFor(db, p.experience).map(id => ({ id, line: T.profile.skillLine(db.skills[id].name.ru, db.skills[id].text.ru) }));
}
