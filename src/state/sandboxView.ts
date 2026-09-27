// Песочница для экранов (spec 2026-09-own-hospital, части 7–9): словами — чего не хватает
// помещению, что мешает открыть смену, почему нельзя поставить; «призрак» помещения, которое
// ставят; касса и репутация за день, оплата приёма. Движок отдаёт коды и числа
// (engine/hospital, engine/economy), здесь они становятся строками игрока.
import type { Cell, ContentDb, Id, RoomSizeId, Rot } from '@/content/types';
import { type CaseIncome, expensesOf, incomeOf, type Ledger, PAYERS, type Payer, type RepChange } from '@/engine/economy/economy';
import type { ClosedCase, DaySummary } from '@/engine/shift/types';
import { type BuildError, canPlace, dims, type HospitalState, type Plan, sizeOf, turn } from '@/engine/hospital/build';
import type { Block, Problem } from '@/engine/hospital/requirements';
import { fnv1a } from '@/engine/core/hash';
import { T } from '@/i18n';

export function problemText(db: ContentDb, p: Problem): string {
  const t = T.sandbox.problem;
  return p.kind === 'noStaff' ? t.noStaff(db.roles[p.role]?.gen.ru ?? p.role) : t[p.kind];
}

/** «Работает» или «Не работает: нет двери в коридор, нет аппарата». */
export function statusText(db: ContentDb, problems: Problem[]): string {
  return problems.length === 0 ? T.sandbox.works : T.sandbox.notWorking(problems.map(p => problemText(db, p)).join(', '));
}

/** Чего не хватает, чтобы открыть смену: «регистратура», «кабинет врача: нет двери в коридор». */
export function blockText(db: ContentDb, b: Block): string {
  const name = db.rooms[b.room]?.name.ru ?? b.room;
  if (b.kind === 'noRoom') return name;
  if (b.kind === 'down') return `${name}: ${problemText(db, b.problem)}`;
  return `${name}: ${T.sandbox.problem.noEquipment}`;
}

/** Почему нельзя — строка под призраком или над кнопками стройки. */
export function buildErrorText(db: ContentDb, e: BuildError, plan: Plan): string {
  const w = T.sandbox.why;
  switch (e.kind) {
    case 'outside':
      return w.outside;
    case 'blocked': {
      if (e.by === 'corridor') return w.corridor;
      if (e.by === 'entrance') return w.entrance;
      const r = plan.rooms.find(x => x.id === e.room);
      return w.room(r ? db.rooms[r.type].name.ru : '');
    }
    case 'money':
      return w.money(T.common.rub(e.need));
    case 'noSlot':
      return w.noSlot;
    case 'badDoor':
      return w.badDoor;
    default:
      return w.other;
  }
}

export interface GhostSpec {
  type: Id;
  size: RoomSizeId;
  x: number;
  y: number;
  rot: Rot;
}

/** Призрак помещения на участке: клетки дверной стороны (без углов) и где не помещается. */
export function ghostOf(db: ContentDb, hs: HospitalState, g: GhostSpec): { x: number; y: number; w: number; h: number; door: Cell[]; blocked: Cell[]; ok: boolean; error?: BuildError } {
  const z = sizeOf(db, g.type, g.size)!;
  const [w, h] = dims(z, g.rot);
  const door: Cell[] = [];
  for (let x = 1; x <= z.w - 2; x++) {
    const [cx, cy] = turn(z, g.rot, x, z.h - 1);
    door.push([g.x + cx, g.y + cy]);
  }
  const error = canPlace(db, hs, g) ?? undefined;
  const blocked = error?.kind === 'blocked' ? error.cells : [];
  return { x: g.x, y: g.y, w, h, door, blocked, ok: !error, ...(error ? { error } : {}) };
}

/** Призрак посреди участка — там, где его видно при «весь участок на экране». */
export function centered(db: ContentDb, hs: HospitalState, type: Id, size: RoomSizeId, rot: Rot = 0): GhostSpec {
  const z = sizeOf(db, type, size)!;
  const [w, h] = dims(z, rot);
  return { type, size, rot, x: Math.floor((hs.w - w) / 2), y: Math.floor((hs.h - h) / 2) };
}

/** Повернуть на 90° по часовой вокруг середины призрака. */
export function rotated(db: ContentDb, g: GhostSpec): GhostSpec {
  const z = sizeOf(db, g.type, g.size)!;
  const [w, h] = dims(z, g.rot);
  const rot = ((g.rot + 1) % 4) as Rot;
  const [nw, nh] = dims(z, rot);
  return { ...g, rot, x: g.x + Math.floor((w - nw) / 2), y: g.y + Math.floor((h - nh) / 2) };
}

/** Почему обследование не сделать: «нет рентген-кабинета», «рентген-кабинет не работает: нет рентгенолога». */
export function examBlockText(db: ContentDb, b: Block): string {
  const t = T.sandbox.examBlock;
  const room = db.rooms[b.room];
  if (b.kind === 'noRoom') return t.none(room?.gen.ru ?? b.room);
  if (b.kind === 'down') return t.down(room?.name.ru ?? b.room, problemText(db, b.problem));
  return t.none(db.equipment[b.equipment[0]]?.gen.ru ?? b.equipment[0]);
}

/** Имя сотрудника — из того же словаря, что имена пациентов: пол и зерно. */
export function personName(sex: 'm' | 'f', seed: number): string {
  const n = T.names;
  const first = sex === 'm' ? n.male : n.female;
  const surname = n.surnames[fnv1a(`${seed}:s`) % n.surnames.length];
  return `${sex === 'm' ? surname : n.feminine(surname)} ${first[fnv1a(`${seed}:f`) % first.length]}`;
}

// --- касса и репутация (часть 9) ----------------------------------------------------------------

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const rub = (n: number) => (n < 0 ? `−${T.common.rub(-n)}` : T.common.rub(n));
const signed = (n: number) => (n > 0 ? `+${T.common.rub(n)}` : rub(n));
const signedN = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/** Тариф ОМС за приём по уровню амбулатории: «— 100 %» или «— 50 %: нет лаборатории и рентген-кабинета». */
export function levelText(db: ContentDb, l: { level: number; rooms: Id[] }): string {
  const missing = Object.keys(db.economy.level.rooms).sort().filter(r => !l.rooms.includes(r)).map(r => db.rooms[r]?.gen.ru ?? r);
  return missing.length === 0 ? T.sandbox.level(l.level) : T.sandbox.levelMissing(l.level, T.sandbox.andList(missing));
}

export interface CashView {
  income: { key: Payer; title: string; sum: string }[];
  /** экспертиза страховых: сколько не оплатила и почему */
  audit?: { sum: string; why: string };
  level: string;
  expenses: { key: keyof Ledger['expenses']; title: string; sum: string }[];
  net: string;
  cash: string;
  /** касса в минусе: долг и процент за день */
  debt?: string;
  reputation: {
    line: string;
    /** оценка дня; нет — никто не пришёл */
    score?: string;
    reasons: { key: string; text: string; delta: string }[];
    hint: string;
  };
}

function reasonText(r: RepChange['reasons'][number], wait: number | undefined): string {
  const t = T.sandbox.repReason;
  switch (r.key) {
    case 'waitShort':
      return t.waitShort(wait ?? 0);
    case 'waitLong':
      return t.waitLong(wait ?? 0);
    case 'noToilet':
      return t.noToilet;
    default:
      return t[r.key](r.count);
  }
}

/** Касса и репутация за день — строками для итогов дня. */
export function cashView(db: ContentDb, e: NonNullable<DaySummary['economy']>): CashView {
  const t = T.sandbox;
  const l = e.ledger;
  const net = incomeOf(l) - expensesOf(l);
  const rep = e.reputation;
  return {
    income: PAYERS.filter(k => l.cases[k] > 0 || l.income[k] > 0).map(k => ({ key: k, title: t.payerLine(cap(t.payers[k]), l.cases[k]), sum: rub(l.income[k]) })),
    ...(l.audit.cut > 0 ? { audit: { sum: t.audit(rub(l.audit.cut)), why: t.auditWhy(l.audit.weak, l.audit.unconfirmed, l.audit.unindicated) } } : {}),
    level: levelText(db, e.level),
    expenses: (['salaries', 'equipment', 'rooms', 'consumables', 'interest'] as const)
      .filter(k => k !== 'interest' || l.expenses.interest > 0)
      .map(k => ({ key: k, title: t.expense[k], sum: rub(l.expenses[k]) })),
    net: t.net(signed(net)),
    cash: t.cashNow(rub(e.cash)),
    ...(e.cash < 0 ? { debt: t.debt(rub(-e.cash), rub(l.expenses.interest)) } : {}),
    reputation: {
      line: t.repLine(rep.from, rep.to),
      ...(rep.score !== undefined ? { score: t.repScore(rep.score) } : {}),
      reasons: rep.score === undefined ? [] : rep.reasons.map(r => ({ key: r.key, text: reasonText(r, rep.wait), delta: signedN(r.delta) })),
      hint: rep.score === undefined ? t.repNobody : t.repHint(db.economy.reputation.pull),
    },
  };
}

/** Оплата закрытого приёма: кто сколько заплатил и что сняла экспертиза. */
export function paymentText(db: ContentDb, payer: Payer, paid: CaseIncome, closed: ClosedCase): string[] {
  const t = T.sandbox;
  const lines = [t.paid(cap(t.payers[payer]), rub(paid.paid))];
  if (payer === 'oms') {
    if (paid.level < 100) lines.push(t.level(paid.level));
    if (paid.quality < 100) lines.push(t.payQuality(closed.grades.defensibility, paid.quality));
    const c = db.conditions[closed.diagnosis]?.confirm;
    if (paid.unconfirmed && c && c !== 'clinical') lines.push(t.payUnconfirmed(t.orList(c.map(id => db.exams[id]?.name.ru ?? id)), db.economy.tariffs.omsUnconfirmed));
  }
  if (paid.unindicated.length > 0) lines.push(t.payUnindicated(paid.unindicated.map(id => db.exams[id]?.name.ru ?? id).join(', ')));
  if (paid.cut > 0) lines.push(t.payCut(rub(paid.cut)));
  return lines;
}
