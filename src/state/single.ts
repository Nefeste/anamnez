// «Смена» (spec 2026-09-campaign, часть 14): итог одного дня в выбранной больнице — оценки по
// категориям (точность, обоснованность, бережливость, безопасность, скорость) и общая.
//
// Точность смены — доля верных диагнозов (почти верный — за половину). Скорость — минуты врача
// на приём: у разумного врача в практике около 23, у ждущего результаты в кабинете — около 40.
// Остальное — средняя оценка приёмов. Общая — средняя с весами (диагноз — главное), но не выше
// точности и не больше чем на ступень выше худшей категории: быстрый врач с неверными
// диагнозами хорошей смены не делает. Проверено на стратегиях «виртуального врача»: разумный —
// A, ждущий результаты в кабинете — B, ленивый и «всё подряд» — C, «всем один диагноз» — D.
// Лучший результат по больницам — в профиле.
import type { Grade } from '@/engine/med/score';
import type { ShiftState } from '@/engine/shift/types';

/** Скорость: не дольше стольких минут на приём — A, B, C; дольше — D. */
export const SPEED_MINUTES: readonly [number, number, number] = [25, 40, 60];
/** Точность: доля верных не меньше стольких процентов — A, B, C; меньше — D. */
export const ACCURACY_SHARE: readonly [number, number, number] = [85, 70, 50];

export type SingleCategory = 'accuracy' | 'defensibility' | 'thrift' | 'safety' | 'speed';
export const SINGLE_CATEGORIES: readonly SingleCategory[] = ['accuracy', 'defensibility', 'thrift', 'safety', 'speed'];

export const POINTS: Record<Grade, number> = { A: 3, B: 2, C: 1, D: 0 };
const GRADE_OF_POINTS: Grade[] = ['D', 'C', 'B', 'A'];
const gradeOf = (mean: number): Grade => (mean >= 2.5 ? 'A' : mean >= 1.75 ? 'B' : mean >= 1 ? 'C' : 'D');
const byScale = (x: number, [a, b, c]: readonly [number, number, number], lower: boolean): Grade =>
  (lower ? (x <= a ? 'A' : x <= b ? 'B' : x <= c ? 'C' : 'D') : x >= a ? 'A' : x >= b ? 'B' : x >= c ? 'C' : 'D');
/** Веса категорий в общей: диагноз — главное. */
const WEIGHTS: Record<SingleCategory, number> = { accuracy: 3, defensibility: 2, safety: 2, thrift: 1, speed: 1 };

export interface SingleResult {
  seen: number;
  arrived: number;
  /** минут врача на приём в среднем */
  minutes: number;
  /** доля верных диагнозов, % (почти — за половину) */
  correct: number;
  grades: Record<SingleCategory, Grade>;
  overall: Grade;
  /** средняя с весами, 0–3 — вторая мерка лучшего результата после общей оценки */
  points: number;
}

/** Итог смены по закрытым приёмам; никого не приняли — итога нет. */
export function singleResult(s: ShiftState): SingleResult | undefined {
  // оценка «Смены» — по вашим приёмам: приёмы нанятых врачей не в счёт
  const cases = Object.values(s.patients).filter(p => p.closed && !p.closed.by);
  if (cases.length === 0) return undefined;
  const mean = (k: 'defensibility' | 'thrift' | 'safety') => cases.reduce((a, p) => a + POINTS[p.closed!.grades[k]], 0) / cases.length;
  const correct = Math.round((100 * cases.reduce((a, p) => a + (p.closed!.verdict === 'correct' ? 1 : p.closed!.verdict === 'partly' ? 0.5 : 0), 0)) / cases.length);
  const minutes = Math.round(cases.reduce((a, p) => a + p.spent.seconds, 0) / cases.length / 60);
  const grades: Record<SingleCategory, Grade> = {
    accuracy: byScale(correct, ACCURACY_SHARE, false),
    defensibility: gradeOf(mean('defensibility')),
    thrift: gradeOf(mean('thrift')),
    safety: gradeOf(mean('safety')),
    speed: byScale(minutes, SPEED_MINUTES, true),
  };
  const means: Record<SingleCategory, number> = {
    accuracy: POINTS[grades.accuracy], defensibility: mean('defensibility'), thrift: mean('thrift'), safety: mean('safety'), speed: POINTS[grades.speed],
  };
  const points = SINGLE_CATEGORIES.reduce((a, k) => a + WEIGHTS[k] * means[k], 0) / SINGLE_CATEGORIES.reduce((a, k) => a + WEIGHTS[k], 0);
  const worst = Math.min(...SINGLE_CATEGORIES.map(k => POINTS[grades[k]]));
  const overall = GRADE_OF_POINTS[Math.min(POINTS[gradeOf(points)], POINTS[grades.accuracy], worst + 1)];
  const day = s.history[s.history.length - 1] ?? s.summary;
  return { seen: cases.length, arrived: day.arrived, minutes, correct, grades, overall, points: Math.round(points * 100) / 100 };
}
