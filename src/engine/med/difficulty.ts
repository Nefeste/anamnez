// Трудность случая (часть 92, вопрос 56, spec 2026-10-case-difficulty): по правде больного и разумному врачу разбора —
// поэтому только в разборе закрытого случая и в выборе «Случая дня», не на экране приёма. Мера — сколько болезней в ряду
// у двери и хватает ли разумному врачу расспроса, осмотра и измерений у постели, чтобы на 90 % увериться в верном
// диагнозе.
import type { ContentDb, Exam, Id } from '../../content/types';
import { type Belief, contextOf, posterior, type Prior } from './infer';
import type { DoctorResult } from './policy';
import type { Observation, Patient } from './types';

export type Hardness = 'easy' | 'medium' | 'hard';

export interface CaseHardness {
  level: Hardness;
  /** болезней в ряду у двери: по жалобам вероятность не меньше `ROW_P` — те, что назвал бы «Похоже на» */
  row: number;
  /** разумный врач разбора уверен в верном диагнозе на `SURE` до первого анализа, экспресс-теста, ЭКГ или снимка */
  talk: boolean;
  /** и решил ли он его вообще: верный диагноз с уверенностью `SURE` */
  solved: boolean;
}

/** В ряду у двери — с вероятностью не меньше 1 из 20: «Похоже на» округляет её до «1 из 10». */
export const ROW_P = 0.05;
/** Лёгкий — в ряду не больше трёх и хватает расспроса и осмотра. */
export const EASY_ROW = 3;
/** Трудный — в ряду пять и больше, и расспроса и осмотра мало. */
export const HARD_ROW = 5;
/** Уверенность, с которой разумный врач ставит диагноз (`startRational`). */
export const SURE = 0.9;
/** Расспрос, осмотр и измерения у постели: давление и сатурация, пикфлоуметр, глюкометр, тест глотания. */
export const TALK: ReadonlySet<Exam['kind']> = new Set(['ask', 'physical', 'bedside']);

/** Сколько болезней в ряду у двери: уверенность после одних жалоб. */
export const doorRow = (door: readonly Belief[]) => door.filter(b => b.p >= ROW_P).length;

/** Уровень по ряду у двери и тому, хватило ли расспроса и осмотра. */
export const levelOf = (row: number, talk: boolean): Hardness => (row <= EASY_ROW && talk ? 'easy' : row >= HARD_ROW && !talk ? 'hard' : 'medium');

/**
 * Трудность по разумному врачу разбора `r` — тому же, что в разборе: `door` — уверенность после жалоб, `prior` — что он
 * знает о потоке (эпидемия «Зимнего гриппа»). Хватило ли расспроса и осмотра — по его пути (`talkOf`); весь путь — из них,
 * тогда — его решение.
 */
export function hardnessOf(db: ContentDb, patient: Patient, candidates: readonly Id[], door: readonly Belief[], r: DoctorResult, prior?: Prior): CaseHardness {
  const row = doorRow(door);
  const solved = r.correct && r.confidence >= SURE;
  const talk = talkOf(db, patient, candidates, r.exams, r.observations, prior) ?? solved;
  return { level: levelOf(row, talk), row, talk, solved };
}

/**
 * Хватило ли разумному врачу расспроса и осмотра: всё, что он сделал до первого обследования другого вида, и уверенность в
 * правде после этого. Известно, как только он за такое обследование взялся, — дальше его путь не нужен (подбор «Случая
 * дня» на этом останавливается); undefined — такого в пути нет.
 */
export function talkOf(db: ContentDb, patient: Patient, candidates: readonly Id[], exams: readonly Id[], observations: readonly Observation[], prior?: Prior): boolean | undefined {
  const k = exams.findIndex(id => !TALK.has(db.exams[id].kind));
  if (k < 0) return undefined;
  const truth = patient.truth.conditions.find(c => c.role === 'primary')!.id;
  const before = new Set(exams.slice(0, k));
  const obs = observations.filter(o => o.exam === 'complaint' || before.has(o.exam));
  return (posterior(db, candidates, obs, contextOf(db, patient, obs, prior)).find(b => b.id === truth)?.p ?? 0) >= SURE;
}
