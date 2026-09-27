// Песочница для экранов (spec 2026-09-own-hospital, часть 7): словами — чего не хватает
// помещению, что мешает открыть смену, почему нельзя поставить; «призрак» помещения, которое
// ставят. Движок отдаёт коды (engine/hospital), здесь они становятся строками игрока.
import type { Cell, ContentDb, Id, RoomSizeId, Rot } from '@/content/types';
import { type BuildError, canPlace, dims, type HospitalState, type Plan, sizeOf, turn } from '@/engine/hospital/build';
import type { Block, Problem } from '@/engine/hospital/requirements';
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
