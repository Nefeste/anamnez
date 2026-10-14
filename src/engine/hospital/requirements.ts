// Требования своей больницы (spec 2026-09-own-hospital, «Движок»): помещение работает, если у
// него есть дверь в коридор, от входа до неё можно дойти, на каждой нужной должности есть
// человек и стоит нужный аппарат. Обследование доступно, если работает его помещение с
// подходящим аппаратом и помещение, где берут материал. Смену открывают, когда работают
// регистратура, зона ожидания и кабинет врача.
import type { ContentDb, Id } from '../../content/types';
import type { Plan, PlacedRoom } from './build';

export const DOCTOR: Id = 'role.doctor';
export const OFFICE: Id = 'room.office';
/** Без них смену не открыть: пациента некому записать, негде ждать и некому принять. */
export const REQUIRED: Id[] = ['room.reception', 'room.waiting', OFFICE];

export type Problem =
  | { kind: 'noDoor' }
  | { kind: 'noPath' }
  | { kind: 'noEquipment' }
  | { kind: 'noStaff'; role: Id }
  /** нанятый есть, а места для него нет — в ординаторской (spec 2026-09-hired-doctors) */
  | { kind: 'noPlace'; room: Id };

/**
 * Есть ли человек на должности в помещении — решает штат (часть 8); в вашем кабинете врач — вы.
 * `unplaced` — назначен ли сюда кто-то, кому не хватило места (терапевт без стола в ординаторской).
 */
export type Staffing = ((room: string, role: Id) => boolean) & { unplaced?: (room: string) => boolean };

/**
 * Кто встаёт на место этой должности — терапевт на место врача; нет — никто. Специалисты (spec 2026-10-chapter-4,
 * часть 59) встают туда же, но место называется по терапевту: «нет терапевта».
 */
export function standInOf(db: ContentDb, role: Id): Id | undefined {
  return Object.values(db.roles).find(r => r.stands === role && r.hire && !r.profile)?.id;
}

/** Все, кто встаёт на место этой должности: терапевт и специалисты — на место врача (часть 59). */
export function standInsOf(db: ContentDb, role: Id): Id[] {
  return Object.values(db.roles).filter(r => r.stands === role && r.hire).map(r => r.id).sort();
}

/** Ваш кабинет — первый кабинет врача, до которого можно дойти; в других — нанятые врачи. */
export function doctorRoom(plan: Plan): string | undefined {
  const offices = plan.rooms.filter(r => r.type === OFFICE);
  return (offices.find(r => plan.connected[r.id]) ?? offices[0])?.id;
}

/** Чего не хватает помещению; пусто — работает. */
export function problemsOf(db: ContentDb, plan: Plan, room: PlacedRoom, staffed: Staffing): Problem[] {
  const out: Problem[] = [];
  if (room.door.length === 0) out.push({ kind: 'noDoor' });
  else if (!plan.connected[room.id]) out.push({ kind: 'noPath' });
  const t = db.rooms[room.type];
  if (t.needsEquipment && !room.equipment.some(Boolean)) out.push({ kind: 'noEquipment' });
  const doctor = doctorRoom(plan);
  for (const role of t.staff) {
    const here = role === DOCTOR ? room.id === doctor || staffed(room.id, DOCTOR) : staffed(room.id, role);
    if (here) continue;
    // в другом кабинете врача — нанятый врач: нет его — «нет терапевта», нет ему места — «нет места»
    const stand = standInOf(db, role);
    const needs = stand ? db.roles[stand].needs : undefined;
    if (needs && staffed.unplaced?.(room.id)) out.push({ kind: 'noPlace', room: needs });
    else out.push({ kind: 'noStaff', role: role === DOCTOR ? (stand ?? role) : role });
  }
  return out;
}

/** Работающие помещения больницы. */
export function workingRooms(db: ContentDb, plan: Plan, staffed: Staffing): Set<string> {
  return new Set(plan.rooms.filter(r => problemsOf(db, plan, r, staffed).length === 0).map(r => r.id));
}

/** Почему нельзя: нет помещения, оно не работает (и первая причина), нет подходящего аппарата. */
export type Block =
  | { kind: 'noRoom'; room: Id }
  | { kind: 'down'; room: Id; problem: Problem }
  | { kind: 'noEquipment'; room: Id; equipment: Id[] }
  /** аппарат есть, но с утра сломан (FR-EQ-3, spec 2026-10-walk-breakdowns): починят к завтра; `equipment` — сломанные */
  | { kind: 'broken'; room: Id; equipment: Id[] };

/** Сломанные сегодня аппараты: «помещение:место» (FR-EQ-3); пусто — всё работает. */
export const NONE_BROKEN: ReadonlySet<string> = new Set();
export const slotKey = (room: string, slot: number) => `${room}:${slot}`;

function roomBlock(db: ContentDb, plan: Plan, working: Set<string>, staffed: Staffing, type: Id): Block | null {
  const rooms = plan.rooms.filter(r => r.type === type);
  if (rooms.length === 0) return { kind: 'noRoom', room: type };
  if (rooms.some(r => working.has(r.id))) return null;
  return { kind: 'down', room: type, problem: problemsOf(db, plan, rooms[0], staffed)[0] };
}

/**
 * Можно ли сделать обследование и где: помещения, где его сделают (работают и с подходящим
 * аппаратом), или причина, почему нельзя. Без помещения в записи — у врача в кабинете. `broken` — сломанные сегодня
 * аппараты (FR-EQ-3): их будто нет, а если других нет — «в ремонте».
 */
export function examWhere(db: ContentDb, plan: Plan, working: Set<string>, staffed: Staffing, examId: Id, broken: ReadonlySet<string> = NONE_BROKEN): { rooms: string[] } | { block: Block } {
  const e = db.exams[examId];
  const type = e?.room ?? OFFICE;
  const down = roomBlock(db, plan, working, staffed, type);
  if (down) return { block: down };
  let rooms = plan.rooms.filter(r => r.type === type && working.has(r.id));
  if (e?.equipment) {
    const fits = e.equipment;
    const placed = rooms.filter(r => r.equipment.some(id => id !== null && fits.includes(id)));
    rooms = placed.filter(r => r.equipment.some((id, slot) => id !== null && fits.includes(id) && !broken.has(slotKey(r.id, slot))));
    if (placed.length === 0) return { block: { kind: 'noEquipment', room: type, equipment: fits } };
    // в ремонте — те, что стоят: их и назвать
    if (rooms.length === 0) return { block: { kind: 'broken', room: type, equipment: [...new Set(placed.flatMap(r => r.equipment.filter((id): id is Id => id !== null && fits.includes(id))))] } };
  }
  if (e?.collect) {
    const collect = roomBlock(db, plan, working, staffed, e.collect);
    if (collect) return { block: collect };
  }
  return { rooms: rooms.map(r => r.id) };
}

/**
 * Можно ли сделать обследование у постели (spec 2026-10-chapter-3, часть 37): лежащему в
 * смотровой приёмного `room` (номер помещения плана) — если она работает и в ней стоит аппарат из
 * записи `bedside`.
 */
export function bedsideIn(db: ContentDb, plan: Plan, working: Set<string>, examId: Id, room: string): boolean {
  const b = db.exams[examId]?.bedside;
  if (!b) return false;
  const r = plan.rooms.find(x => x.id === room);
  return !!r && r.type === b.room && working.has(r.id) && r.equipment.some(id => id !== null && b.equipment.includes(id));
}

/** Чего не хватает, чтобы открыть смену; пусто — можно. */
export function openBlocks(db: ContentDb, plan: Plan, working: Set<string>, staffed: Staffing): Block[] {
  return REQUIRED.flatMap(type => {
    const b = roomBlock(db, plan, working, staffed, type);
    return b ? [b] : [];
  });
}
