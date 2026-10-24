// Испытания «Смены» (часть 91, spec 2026-10-challenges, вопрос 50): условие на весь день — у ваших пациентов. «Нелюдимый
// врач» — без расспроса, аллергии, хронические болезни и лекарства — из карты; «Земский врач» — без анализов и снимков,
// только расспрос, осмотр и у постели; «Скупой главврач» — обследования одного пациента не дороже 1 500 ₽. Нанятые врачи
// работают как обычно.
import type { ContentDb, Exam, Id } from '../../content/types';

export type Challenge = 'mute' | 'rural' | 'thrifty';
export const CHALLENGES: readonly Challenge[] = ['mute', 'rural', 'thrifty'];

/** «Скупой главврач»: на обследования одного пациента — не больше, ₽. */
export const BUDGET = 1500;

/**
 * «Нелюдимый врач»: что известно из карты, когда пациента позвали, — ответы на эти вопросы. Без аллергий антибиотик пришлось
 * бы назначать вслепую (вопрос 50); хронические болезни и лекарства в карте тоже есть.
 */
export const CARD_EXAMS: readonly Id[] = ['exam.ask_allergies', 'exam.ask_chronic', 'exam.ask_meds'];

/** «Земский врач»: можно только расспрос, осмотр и то, что у постели; ЭКГ — у постели в смотровой приёмного. */
const RURAL: ReadonlySet<Exam['kind']> = new Set(['ask', 'physical', 'bedside']);

/** Чем испытание запрещает обследование; у «Скупого главврача» — сколько осталось на пациента. */
export type ChallengeBlock = { challenge: 'mute' } | { challenge: 'rural' } | { challenge: 'thrifty'; left: number };

/**
 * Запрещает ли испытание смены обследование `examId` у вашего пациента, потратившего `spent` ₽; `bedside` — его сделают у
 * постели (ЭКГ лежащему в смотровой приёмного с монитором). Испытаний нет — ничего не запрещено.
 */
export function challengeBlock(db: ContentDb, challenges: readonly Challenge[] | undefined, spent: number, examId: Id, bedside = false): ChallengeBlock | undefined {
  if (!challenges || challenges.length === 0) return undefined;
  const e = db.exams[examId];
  if (!e) return undefined;
  if (challenges.includes('mute') && e.kind === 'ask') return { challenge: 'mute' };
  if (challenges.includes('rural') && !RURAL.has(e.kind) && !bedside) return { challenge: 'rural' };
  if (challenges.includes('thrifty') && spent + e.cost > BUDGET) return { challenge: 'thrifty', left: Math.max(0, BUDGET - spent) };
  return undefined;
}

/**
 * Обследования разумного врача разбора при испытаниях смены: без расспроса — без вопросов, кроме тех, что из карты; без
 * анализов и снимков — только расспрос, осмотр и у постели. Деньги ему не ограничены: игрок с лимитом не тратит больше
 * него, и бережливость от лимита не страдает.
 */
export function reviewExams(db: ContentDb, challenges: readonly Challenge[] | undefined, exams: readonly Id[]): Id[] {
  if (!challenges || challenges.length === 0) return [...exams];
  return exams.filter(id => {
    const kind = db.exams[id]?.kind;
    if (!kind) return false;
    if (challenges.includes('mute') && kind === 'ask' && !CARD_EXAMS.includes(id)) return false;
    if (challenges.includes('rural') && !RURAL.has(kind)) return false;
    return true;
  });
}
