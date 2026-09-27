// Профиль для экранов: итоги практики строками, архив приёмов строками, имя по умолчанию.
// Всё — из записей профиля (profile.ts) и базы; разбор приёма из архива строит session.ts.
import { db } from '@/content';
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

/** Имя по умолчанию — из тех же списков, что у пациентов (i18n/sections/names.ts). */
export function suggestDoctor(sex: 'm' | 'f', random: () => number): Doctor {
  const n = T.names;
  const pick = (a: readonly string[]) => a[Math.floor(random() * a.length) % a.length];
  const surname = pick(n.surnames);
  return { sex, first: pick(sex === 'm' ? n.male : n.female), last: sex === 'm' ? surname : n.feminine(surname) };
}
