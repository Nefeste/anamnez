// Кардиология и неврология главы 3 (spec 2026-10-chapter-3, критерии приёмки 3 и 4) — болезни таблицы «Медицина
// главы»: в базе это терапия и неврология, а пороги «Виртуального врача» и окупаемость КТ и ПИТ в симуляторе
// районной больницы — свои у каждой группы.
import type { Id } from '../../src/content/types';

export const PROFILES: Record<'cardiology' | 'neurology', Id[]> = {
  cardiology: ['cond.acs', 'cond.angina_stable', 'cond.af', 'cond.svt', 'cond.vt', 'cond.av_block', 'cond.adhf', 'cond.hypertensive_crisis', 'cond.bp_uncontrolled', 'cond.pericarditis', 'cond.aortic_dissection', 'cond.pe'],
  neurology: ['cond.stroke_ischemic', 'cond.tia', 'cond.ich', 'cond.sah', 'cond.seizure', 'cond.status_epilepticus', 'cond.bell_palsy', 'cond.hypoglycemia'],
};

export type Profile = keyof typeof PROFILES;

/** Группа болезни главы 3; не из таблицы — нет. */
export const profileOf = (condition: Id): Profile | undefined => (Object.keys(PROFILES) as Profile[]).find(k => PROFILES[k].includes(condition));
