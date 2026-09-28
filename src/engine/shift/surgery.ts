// Операционная своей больницы (spec 2026-09-chapter-2, часть 28): операция — дело бригады,
// хирурга, анестезиолога и операционной медсестры; врач решает, нужна ли она. Решили
// оперировать — пациент ложится на койку и встаёт в очередь операционной; бригада берёт
// следующего, когда стол свободен, и операция идёт по часам смены. Исход — из именованной ветви
// зерна пациента (ADR 0004): осложнение после операции — дольше стационар.
import type { ContentDb, Id } from '../../content/types';
import { P_ONE } from '../core/rng';
import type { StaffMember } from '../hospital/staff';

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
}

/** На сколько суток дольше стационар после осложнения — игровая оценка: сроков источники не дают. */
export const COMPLICATION_DAYS: [number, number] = [2, 4];

/** Операция, которой лечат это состояние; нет — не оперируют. */
export const operationFor = (db: ContentDb, condition: Id): Id | undefined => db.conditions[condition]?.surgery?.tx;

/** Доля осложнений после операции у этого хирурга, 1/10 000: запись операции × поправка навыка (economy.yaml, `staff.surgery`). */
export function complicationsOf(db: ContentDb, tx: Id, surgeon?: StaffMember): number {
  const base = db.treatments[tx]?.surgery?.complications ?? 0;
  const k = surgeon ? db.economy.staff.surgery[surgeon.skill - 1] : 100;
  return Math.min(P_ONE, Math.round((base * k) / 100));
}

/** Часов от решения оперировать до начала операции — для срока `window` болезни. */
export const waitedHours = (op: Operation) => (op.start === undefined ? 0 : (op.start - op.queued) / 3600);
