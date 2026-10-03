// Сроки (spec 2026-10-chapter-3, часть 37): что сделать и за сколько минут от прихода — ЭКГ при
// боли в груди за 10 минут. Отсчёт — от прихода в больницу; сделано — пришёл результат.
import type { ContentDb, Id, Target } from '../../content/types';
import type { Grade } from '../med/score';
import type { ShiftPatient } from './types';

/** Срок закрытого приёма: через сколько минут от прихода пришёл результат; нет — не сделали. */
export interface TargetResult {
  id: Id;
  minutes?: number;
  limit: number;
  grade: Grade;
}

/** Где лежит пациент: вид помещения по его номеру и что ему можно сделать у постели. */
export interface TargetPlace {
  roomType(room: string): Id | undefined;
  bedside(exam: Id): boolean;
}

/**
 * Какие сроки к пациенту относятся: жалоба при поступлении — из записи, и, если срок для лежащих
 * в помещении (смотровая приёмного), он лежит там и одно из обследований срока ему можно сделать у
 * постели — монитор стоит и смотровая работает: без него в срок не успеть не по вине игрока
 * (смотровая из сохранений до 0.3.2 — без монитора, пока его не купят).
 */
export function targetsFor(db: ContentDb, p: Pick<ShiftPatient, 'patient' | 'bay'>, at: TargetPlace): Target[] {
  return Object.values(db.targets).filter(t => t.complaints.some(f => p.patient.complaints.includes(f))
    && (!t.room || (p.bay !== undefined && at.roomType(p.bay.room) === t.room && t.exams.some(e => at.bedside(e)))));
}

/** В срок — A; до полутора сроков — B, до двух — C; позже или не сделано — D. */
export function targetGrade(minutes: number | undefined, limit: number): Grade {
  if (minutes === undefined) return 'D';
  if (minutes <= limit) return 'A';
  if (minutes <= limit * 1.5) return 'B';
  if (minutes <= limit * 2) return 'C';
  return 'D';
}

/** Первый пришедший результат одного из обследований срока — минуты от прихода; нет — undefined. */
export function minutesTo(p: Pick<ShiftPatient, 'arriveT' | 'results'>, t: Target): number | undefined {
  const at = p.results.filter(r => t.exams.includes(r.exam)).reduce((m, r) => Math.min(m, r.at), Infinity);
  return at === Infinity ? undefined : Math.round((at - p.arriveT) / 60);
}

export function targetResults(db: ContentDb, p: Pick<ShiftPatient, 'patient' | 'bay' | 'arriveT' | 'results'>, at: TargetPlace): TargetResult[] {
  return targetsFor(db, p, at).map(t => {
    const minutes = minutesTo(p, t);
    return { id: t.id, ...(minutes !== undefined ? { minutes } : {}), limit: t.minutes, grade: targetGrade(minutes, t.minutes) };
  });
}
