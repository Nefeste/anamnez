// Экономика своей больницы (spec 2026-09-own-hospital, часть 9; 03-game-design.md §9): кто
// платит за пациента, сколько приносит закрытый случай, что стоит день, как меняется
// репутация. Главная мысль — деньги идут за хорошую медицину: ОМС платит за обращение по
// тяжести поставленного диагноза, а страховая проверяет обоснованность, как экспертиза
// качества; ДМС и платные — ещё и за каждое обследование; лишние обследования у пациента ОМС
// стоят больнице расходников и ничего не приносят. Числа — баланс игры (economy.yaml).
import type { ContentDb, Exam, Id } from '../../content/types';
import { Rng } from '../core/rng';
import type { HospitalState, Plan } from '../hospital/build';
import { sizeOf } from '../hospital/build';
import type { StaffMember } from '../hospital/staff';
import type { Grade } from '../med/score';

export type Payer = 'oms' | 'dms' | 'self';
export const PAYERS: Payer[] = ['oms', 'dms', 'self'];

/** Касса за день: доходы по плательщикам, расходы по статьям, что сняла экспертиза страховых, ₽. */
export interface Ledger {
  income: Record<Payer, number>;
  /** сколько приёмов закрыто — по плательщикам */
  cases: Record<Payer, number>;
  /** `ward` — койко-дни лежащих (spec 2026-09-chapter-2, часть 26); нет — сохранение до 0.0.43 */
  expenses: { salaries: number; equipment: number; rooms: number; consumables: number; interest: number; ward?: number };
  /**
   * стационар: сколько случаев закрыто (выписка, перевод), что за них заплатили, ₽; из них
   * прерванных, без показаний и повторных после ранней выписки (часть 35; нет — таких не было)
   */
  ward?: { cases: number; income: number; interrupted: number; unindicated: number; repeat?: number };
  /** экспертиза ОМС и ДМС: сколько не оплатили; диагнозов обоснованных ниже A, без подтверждения; обследований без показаний */
  audit: { cut: number; weak: number; unconfirmed: number; unindicated: number };
}

export const emptyLedger = (): Ledger => ({
  income: { oms: 0, dms: 0, self: 0 },
  cases: { oms: 0, dms: 0, self: 0 },
  expenses: { salaries: 0, equipment: 0, rooms: 0, consumables: 0, interest: 0, ward: 0 },
  ward: { cases: 0, income: 0, interrupted: 0, unindicated: 0 },
  audit: { cut: 0, weak: 0, unconfirmed: 0, unindicated: 0 },
});

export const incomeOf = (l: Ledger) => l.income.oms + l.income.dms + l.income.self + (l.ward?.income ?? 0);
export const expensesOf = (l: Ledger) => l.expenses.salaries + l.expenses.equipment + l.expenses.rooms + l.expenses.consumables + l.expenses.interest + (l.expenses.ward ?? 0);

/**
 * Как закрыт случай стационара — для оплаты: до выписки в срок, прерван (перевод, выписка раньше
 * срока), без показаний, повторный — вернулся хуже после ранней выписки (часть 35).
 */
export type WardClose = 'full' | 'interrupted' | 'unindicated' | 'repeat';

/**
 * Случай стационара (часть 26): ОМС платит за случай, а не за день, — по тяжести диагноза, с той
 * же долей по обоснованности, что у приёма; прерванный — долю `ward.interrupted`; госпитализацию
 * без показаний не оплачивает, как экспертиза, и повторную после ранней выписки — тоже: выписали
 * недолеченным, он вернулся хуже (часть 35), — иначе выгодно выписывать рано и класть снова.
 * Лишние дни ничего не приносят: их цена — койко-дни в расходах. Случай с операцией `op` — с
 * прибавкой за неё и её расходниками: как в КСГ хирургического случая, имплантат входит в тариф
 * (часть 35), — иначе дорогая операция на кости всегда в убыток и выгоднее её не делать.
 */
export function wardIncome(db: ContentDb, diagnosis: Id, defensibility: Grade, close: WardClose, op?: Id, unit?: 'icu' | 'ricu' | 'box'): number {
  if (close === 'unindicated' || close === 'repeat') return 0;
  const t = db.economy.tariffs;
  // с операцией — прибавка за неё и расходники, как КСГ хирургического случая (spec 2026-09-chapter-2, части 28 и 35);
  // с палатой интенсивной терапии по показаниям — прибавка за неё (spec 2026-10-chapter-3, часть 38а), с реанимацией
  // и ИВЛ — своя, больше (spec 2026-10-chapter-4, часть 47); с боксом по показаниям — за изоляцию (часть 49а)
  const care = unit === 'ricu' ? t.omsRicu : unit === 'icu' ? t.omsIcu : unit === 'box' ? t.omsBox : 0;
  const full = t.omsWard[db.conditions[diagnosis]?.severity ?? 'minor'] + (op ? t.omsOperation + (db.treatments[op]?.cost ?? 0) : 0) + care;
  const share = close === 'interrupted' ? db.economy.ward.interrupted : 100;
  return Math.round((full * t.omsQuality[defensibility] * share) / 10000);
}

/** Между тремя точками (репутация 0, 50, 100) — по прямой, в целых. */
function along(points: [number, number, number], reputation: number): number {
  const r = Math.max(0, Math.min(100, reputation));
  return r <= 50 ? points[0] + ((points[1] - points[0]) * r) / 50 : points[1] + ((points[2] - points[1]) * (r - 50)) / 50;
}

/** Кто платит за пациента — из его ветви зерна; с репутацией растёт доля ДМС и платных. */
export function payerOf(db: ContentDb, seed: number, id: string, reputation: number): Payer {
  const dms = Math.round(along(db.economy.payers.dms, reputation) * 100);
  const self = Math.round(along(db.economy.payers.self, reputation) * 100);
  const roll = Rng.seeded(seed).fork(`payer:${id}`).int(10000);
  return roll < dms ? 'dms' : roll < dms + self ? 'self' : 'oms';
}

/** Сколько пациентов придёт от репутации, % от обычного: ± `flow` при 0 и 100. */
export function flowOf(db: ContentDb, reputation: number): number {
  return Math.round(100 + (db.economy.flow * (Math.max(0, Math.min(100, reputation)) - 50)) / 50);
}

/** Расходники обследования, ₽: доля его цены по виду. */
export function consumablesOf(db: ContentDb, exam: Exam): number {
  return Math.round((exam.cost * db.economy.consumables[exam.kind]) / 100);
}

/** Уровень амбулатории для ОМС, %: базовая доля и прибавки за работающие помещения с обследованиями. */
export function levelOf(db: ContentDb, plan: Plan, working: ReadonlySet<string>): { level: number; rooms: Id[] } {
  const l = db.economy.level;
  const rooms = Object.keys(l.rooms).sort().filter(type => plan.rooms.some(r => r.type === type && working.has(r.id)));
  return { level: rooms.reduce((m, type) => m + l.rooms[type], l.base), rooms };
}

/** Подтверждён ли диагноз: клинически или хотя бы одним обследованием из «Как подтвердить». */
export function confirmed(db: ContentDb, diagnosis: Id, done: readonly Id[]): boolean {
  const c = db.conditions[diagnosis]?.confirm ?? 'clinical';
  return c === 'clinical' || c.some(x => done.includes(x));
}

/** Что принёс закрытый случай и что сняла экспертиза страховой. */
export interface CaseIncome {
  /** заплатили, ₽ */
  paid: number;
  /** не оплатили по экспертизе: обоснованность, подтверждение, обследования без показаний, ₽ */
  cut: number;
  /** ОМС: доля тарифа по обоснованности, % */
  quality: number;
  /** ОМС: диагноз не подтверждён обследованием */
  unconfirmed: boolean;
  /** обследования без показаний — страховая их не оплатила */
  unindicated: Id[];
  /** ОМС: уровень амбулатории, % тарифа за обращение */
  level: number;
}

/**
 * Что приносит закрытый случай. ОМС — тариф за обращение по тяжести поставленного диагноза и
 * уровню амбулатории: доля по обоснованности и, если диагноз не подтверждён, ещё доля; и обследования, которые были
 * показаны, когда их назначали, или подтверждают диагноз. ДМС — обращение и показанные
 * обследования по прайсу. Платный пациент платит за обращение и всё, что сделали.
 */
export function caseIncome(db: ContentDb, payer: Payer, diagnosis: Id, done: readonly Id[], indicatedExams: readonly Id[], defensibility: Grade, level = 100): CaseIncome {
  const t = db.economy.tariffs;
  const c = db.conditions[diagnosis]?.confirm ?? 'clinical';
  const paidFor = (id: Id) => payer === 'self' || indicatedExams.includes(id) || (c !== 'clinical' && c.includes(id));
  const price = payer === 'oms' ? t.omsExam : payer === 'dms' ? t.dms.price : t.self.price;
  let paid = 0;
  let cut = 0;
  const unindicated: Id[] = [];
  for (const id of done) {
    const sum = Math.round(((db.exams[id]?.cost ?? 0) * price) / 100);
    if (sum === 0) continue;
    if (paidFor(id)) paid += sum;
    else {
      cut += sum;
      unindicated.push(id);
    }
  }
  let unconfirmed = false;
  const quality = payer === 'oms' ? t.omsQuality[defensibility] : 100;
  if (payer === 'oms') {
    const full = Math.round((t.oms[db.conditions[diagnosis]?.severity ?? 'minor'] * level) / 100);
    unconfirmed = !confirmed(db, diagnosis, done);
    const visit = Math.round((full * quality * (unconfirmed ? t.omsUnconfirmed : 100)) / 10000);
    paid += visit;
    cut += full - visit;
  } else paid += payer === 'dms' ? t.dms.visit : t.self.visit;
  return { paid, cut, quality, unconfirmed, unindicated, level: payer === 'oms' ? level : 100 };
}

/** Содержание за день: аппараты, помещения и коридор, ₽. */
export function upkeepOf(db: ContentDb, h: HospitalState): { equipment: number; rooms: number } {
  let equipment = 0;
  let rooms = h.corridor.length * db.economy.corridor.upkeep;
  for (const r of h.rooms) {
    rooms += sizeOf(db, r.type, r.size)?.upkeep ?? 0;
    for (const e of r.equipment) if (e) equipment += db.equipment[e]?.upkeep ?? 0;
  }
  return { equipment, rooms };
}

export const salariesOf = (staff: readonly StaffMember[]) => staff.reduce((m, s) => m + s.salary, 0);

/** Процент на долг за день, ₽: касса в минусе — растёт долг. */
export function interestOf(db: ContentDb, cash: number): number {
  return cash < 0 ? Math.ceil((-cash * db.economy.interest) / 10000) : 0;
}

export type RepReason = 'correct' | 'wrong' | 'left' | 'unseen' | 'returned' | 'waitShort' | 'waitLong' | 'noToilet' | 'died' | 'severe';

/**
 * Репутация за день: оценка дня из чего сложилась и куда сдвинулась репутация. `score` нет —
 * никто не пришёл, репутация прежняя.
 */
export interface RepChange {
  from: number;
  to: number;
  score?: number;
  /** среднее ожидание до вызова, минуты */
  wait?: number;
  reasons: { key: RepReason; count: number; delta: number }[];
}

export interface RepDay {
  arrived: number; correct: number; wrong: number; left: number; unseen: number; returned: number;
  /** среднее ожидание до вызова, минуты; никого не вызвали — нет */
  meanWait?: number;
  toilet: boolean;
  /** умерли в стационаре; в «мягком режиме» — переведены в тяжёлом состоянии вместо смерти (часть 35) */
  died?: number;
  severe?: number;
}

/**
 * Репутация вечером. Оценка дня 0–100 — доля довольных (верный диагноз) минус доли
 * недовольных (ошибка, ушёл, не дождавшись, не принят, вернулся хуже из-за лечения); короткое
 * ожидание — плюс, долгое и отсутствие санузла — минус, и за каждого умершего в стационаре — минус
 * (часть 35); в «мягком режиме» за переведённого вместо смерти — столько же: режим меняет строку,
 * а не игру. Репутация сдвигается к оценке на `pull` % разницы: один плохой день её не обрушит, а
 * работа изо дня в день — видна.
 */
export function reputationAfter(db: ContentDb, from: number, day: RepDay): RepChange {
  const r = db.economy.reputation;
  if (day.arrived <= 0) return { from, to: from, reasons: [] };
  const reasons: RepChange['reasons'] = [];
  const share = (key: RepReason, count: number, sign: 1 | -1) => {
    if (count > 0) reasons.push({ key, count, delta: sign * Math.round((100 * count) / day.arrived) });
  };
  share('correct', day.correct, 1);
  share('wrong', day.wrong, -1);
  share('left', day.left, -1);
  share('unseen', day.unseen, -1);
  share('returned', day.returned, -1);
  const wait = day.meanWait === undefined ? undefined : Math.round(day.meanWait);
  if (wait !== undefined && wait <= r.waitShortMin && r.waitShort !== 0) reasons.push({ key: 'waitShort', count: 1, delta: r.waitShort });
  if (wait !== undefined && wait > r.waitLongMin && r.waitLong !== 0) reasons.push({ key: 'waitLong', count: 1, delta: r.waitLong });
  if (!day.toilet && r.noToilet !== 0) reasons.push({ key: 'noToilet', count: 1, delta: r.noToilet });
  for (const key of ['died', 'severe'] as const) {
    const n = day[key] ?? 0;
    if (n > 0 && r.died !== 0) reasons.push({ key, count: n, delta: r.died * n });
  }
  const score = Math.max(0, Math.min(100, reasons.reduce((m, x) => m + x.delta, 0)));
  const to = Math.max(0, Math.min(100, from + Math.round(((score - from) * r.pull) / 100)));
  return { from, to, score, ...(wait !== undefined ? { wait } : {}), reasons };
}
