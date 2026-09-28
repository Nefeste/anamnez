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
  | { kind: 'noStaff'; role: Id };

/** Есть ли человек на должности в помещении — решает штат (часть 8); врач — сам игрок. */
export type Staffing = (room: string, role: Id) => boolean;

/** Кабинет врача — первый, до которого можно дойти; врач один, это игрок. */
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
    const here = role === DOCTOR ? room.id === doctor : staffed(room.id, role);
    if (!here) out.push({ kind: 'noStaff', role });
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
  | { kind: 'noEquipment'; room: Id; equipment: Id[] };

function roomBlock(db: ContentDb, plan: Plan, working: Set<string>, staffed: Staffing, type: Id): Block | null {
  const rooms = plan.rooms.filter(r => r.type === type);
  if (rooms.length === 0) return { kind: 'noRoom', room: type };
  if (rooms.some(r => working.has(r.id))) return null;
  return { kind: 'down', room: type, problem: problemsOf(db, plan, rooms[0], staffed)[0] };
}

/**
 * Можно ли сделать обследование и где: помещения, где его сделают (работают и с подходящим
 * аппаратом), или причина, почему нельзя. Без помещения в записи — у врача в кабинете.
 */
export function examWhere(db: ContentDb, plan: Plan, working: Set<string>, staffed: Staffing, examId: Id): { rooms: string[] } | { block: Block } {
  const e = db.exams[examId];
  const type = e?.room ?? OFFICE;
  const down = roomBlock(db, plan, working, staffed, type);
  if (down) return { block: down };
  let rooms = plan.rooms.filter(r => r.type === type && working.has(r.id));
  if (e?.equipment) {
    const fits = e.equipment;
    rooms = rooms.filter(r => r.equipment.some(id => id !== null && fits.includes(id)));
    if (rooms.length === 0) return { block: { kind: 'noEquipment', room: type, equipment: fits } };
  }
  if (e?.collect) {
    const collect = roomBlock(db, plan, working, staffed, e.collect);
    if (collect) return { block: collect };
  }
  return { rooms: rooms.map(r => r.id) };
}

/** Чего не хватает, чтобы открыть смену; пусто — можно. */
export function openBlocks(db: ContentDb, plan: Plan, working: Set<string>, staffed: Staffing): Block[] {
  return REQUIRED.flatMap(type => {
    const b = roomBlock(db, plan, working, staffed, type);
    return b ? [b] : [];
  });
}
