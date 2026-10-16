// Специальности и умения врача (spec 2026-10-skills, часть 75; spec 2026-09-profile, часть 17): уровень специальности —
// по опыту отделения (верный диагноз — 1, почти верный — 0,5), умения — записи базы по уровням. Смене — умения дня:
// прибавка чувствительности обследованию игрока, вопросы расспроса короче, нанятые врачи реже забывают спросить.
import type { ContentDb, Exam, Id } from '../../content/types';
import type { ExamSkill } from '../med/exams';

/** Пороги уровней 2–5 (spec 2026-09-profile, часть 17): очки опыта отделения. */
export const LEVELS = [10, 40, 100, 250] as const;

/** Уровень специальности 1–5 по очкам опыта. */
export function levelOf(points: number): number {
  return 1 + LEVELS.filter(x => points >= x).length;
}

/** Сколько очков до следующего уровня; на пятом — 0. */
export function toNextLevel(points: number): number {
  const next = LEVELS.find(x => points < x);
  return next === undefined ? 0 : next - points;
}

/** Очки опыта за закрытый приём (spec 2026-10-skills): верный — 1, почти верный — половина, неверный — ничего. */
export const pointsFor = (verdict: 'correct' | 'partly' | 'wrong'): number => (verdict === 'correct' ? 1 : verdict === 'partly' ? 0.5 : 0);

/**
 * Специальности — отделения, с болезнями которых приходят, в порядке глав кампании: терапия, затем отделения, которые
 * принимают помещения больниц глав, — хирургия и травма, неврология, инфекции.
 */
export function specialtiesOf(db: ContentDb): Id[] {
  const out: Id[] = ['dept.therapy'];
  for (const ch of Object.values(db.chapters).sort((a, b) => a.order - b.order)) {
    if (!out.includes(ch.department)) out.push(ch.department);
    for (const r of db.presets[ch.preset]?.rooms ?? []) for (const d of db.rooms[r.type]?.admits ?? []) if (!out.includes(d)) out.push(d);
  }
  return out.filter(d => Object.values(db.conditions).some(c => c.presenting && c.department === d));
}

/** Умения, которые есть при этом опыте, — по порядку базы: специальность, уровень. */
export function skillsFor(db: ContentDb, experience: Readonly<Record<Id, number>>): Id[] {
  return Object.values(db.skills).filter(x => levelOf(experience[x.department] ?? 0) >= x.level).map(x => x.id);
}

/** Обследование игрока с умениями дня: та же прибавка `sensPp`, что у навыка нанятого человека, — тот же бросок. */
export function examSkillWith(db: ContentDb, skills: readonly Id[] | undefined, exam: Id, base: ExamSkill): ExamSkill {
  let pp = 0;
  for (const id of skills ?? []) {
    const e = db.skills[id]?.effect;
    if (e?.kind === 'examSens' && e.exams.includes(exam)) pp += e.pp;
  }
  return pp === 0 ? base : { ...base, sensPp: (base.sensPp ?? 0) + pp };
}

/** Минуты вопроса расспроса с умениями дня: короче, но не меньше минуты; не расспрос — как в базе. */
export function askMinutes(db: ContentDb, skills: readonly Id[] | undefined, exam: Exam, minutes: number): number {
  if (exam.kind !== 'ask') return minutes;
  let cut = 0;
  for (const id of skills ?? []) {
    const e = db.skills[id]?.effect;
    if (e?.kind === 'askTime') cut += e.minutes;
  }
  return cut === 0 ? minutes : Math.max(1, minutes - cut);
}

/** Во сколько раз реже нанятый врач этой должности забывает спросить перед лечением: «Наставник»; нет — 1. */
export function mentorOf(db: ContentDb, skills: readonly Id[] | undefined, role: Id): number {
  let x = 1;
  for (const id of skills ?? []) {
    const e = db.skills[id]?.effect;
    if (e?.kind === 'mentor' && e.role === role) x *= e.forget;
  }
  return x;
}
