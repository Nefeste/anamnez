// Операционная своей больницы (spec 2026-09-chapter-2, часть 28): операция — дело бригады,
// хирурга, анестезиолога и операционной медсестры; врач решает, нужна ли она. Решили
// оперировать — пациент ложится на койку и встаёт в очередь операционной; бригада берёт
// следующего, когда стол свободен, и операция идёт по часам смены. Исход — из именованной ветви
// зерна пациента (ADR 0004): осложнение после операции — дольше стационар. С частью 28б — и
// стадия болезни на момент разреза: чем дольше без операции, тем вероятнее перфорация.
import type { ContentDb, Id } from '../../content/types';
import { log2 } from '../core/math';
import { P_ONE, Rng } from '../core/rng';
import type { StaffMember } from '../hospital/staff';
import { primaryOf } from '../med/plan';
import type { Patient } from '../med/types';

/** Операция лежащего: какая, когда решили, где и когда шла, чем кончилась. */
export interface Operation {
  tx: Id;
  /** когда решили оперировать, время смены */
  queued: number;
  /** операционная и хирург — когда операция началась */
  room?: string;
  surgeon?: string;
  start?: number;
  end?: number;
  /** операция кончилась */
  done?: boolean;
  /** осложнение после операции: стационар дольше (WSES 2020 — инфекция раны, абсцесс, парез кишечника) */
  complication?: boolean;
  /** на момент разреза болезнь была в осложнённой стадии — перфорация (часть 28б) */
  complicated?: boolean;
}

/** На сколько суток дольше стационар после осложнения — игровая оценка: сроков источники не дают. */
export const COMPLICATION_DAYS: [number, number] = [2, 4];

/** Операция, которой лечат это состояние; нет — не оперируют. */
export const operationFor = (db: ContentDb, condition: Id): Id | undefined => db.conditions[condition]?.surgery?.tx;

/**
 * Доля осложнений после операции у этого хирурга, 1/10 000: запись операции — своя для
 * осложнённой стадии болезни (часть 28б) — × поправка навыка (economy.yaml, `staff.surgery`).
 */
export function complicationsOf(db: ContentDb, tx: Id, surgeon?: StaffMember, complicated = false): number {
  const x = db.treatments[tx]?.surgery;
  const base = (complicated && x?.complicated ? x.complicated.complications : x?.complications) ?? 0;
  const k = surgeon ? db.economy.staff.surgery[surgeon.skill - 1] : 100;
  return Math.min(P_ONE, Math.round((base * k) / 100));
}

/**
 * Доля умерших в стационаре после операции, 1/10 000: без осложнённой стадии и с ней (часть 28б).
 * У операции с `delay` — ещё и по ожиданию (часть 30б): каждый полный час от поступления до
 * разреза выживаемость ниже на `delay` (прободная язва, Buck 2013) — умножением, без степени с
 * дробью: так одинаково на всех движках JavaScript (ADR 0004).
 */
export function deathsOf(db: ContentDb, tx: Id, complicated = false, hoursWaited = 0): number {
  const x = db.treatments[tx]?.surgery;
  const base = (complicated && x?.complicated ? x.complicated.death : x?.death) ?? 0;
  if (!x?.delay) return base;
  let survive = 1 - base / P_ONE;
  for (let h = 1; h <= Math.floor(hoursWaited); h++) survive *= 1 - x.delay / P_ONE;
  return Math.min(P_ONE, Math.round((1 - survive) * P_ONE));
}

/** Часов от начала болезни к приходу: сутки болезни — из генератора, час начала в сутках — из ветви зерна пациента. */
export function onsetHours(patient: Patient): number {
  return primaryOf(patient).day * 24 + Rng.seeded(patient.seed).fork('onset').range(0, 23);
}

/**
 * На каком часу от начала болезни без действенного лечения наступит её осложнённая стадия
 * (перфорация аппендикса): один бросок ветви `complication` зерна пациента против риска записи —
 * за первые `early.hours` часов всего `early.p`, дальше `later.p` за каждые `later.every` часов.
 * Осложнённой стадии у болезни нет — никогда.
 */
export function complicationAt(db: ContentDb, patient: Patient): number {
  const c = db.conditions[primaryOf(patient).id]?.complication;
  if (!c) return Infinity;
  // по сроку (часть 30б): прободная язва позже 24 ч от начала — давняя перфорация по шкале Boey
  if (c.after !== undefined) return c.after;
  if (!c.early || !c.later) return Infinity;
  const u = Rng.seeded(patient.seed).fork('complication').range(0, P_ONE - 1) / P_ONE;
  const early = c.early.p / P_ONE;
  if (u < early) return (c.early.hours * u) / early;
  // дальше без осложнения остаётся (1 − early) · (1 − later)^(часы / every) — решить относительно часов
  return c.early.hours + (c.later.every * log2((1 - u) / (1 - early))) / log2(1 - c.later.p / P_ONE);
}

/** Часов от решения оперировать до начала операции — для срока `window` болезни. */
export const waitedHours = (op: Operation) => (op.start === undefined ? 0 : (op.start - op.queued) / 3600);
