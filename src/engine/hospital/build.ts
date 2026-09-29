// Стройка своей больницы (spec 2026-09-own-hospital; ADR 0014, 0016). Больница — участок, вход,
// коридор и помещения из каталога (content/hospital); план — сетка, предметы, места людей —
// выводится из неё чистой функцией, поэтому практика и песочница рисуются и ходят одинаково.
// Команды не меняют состояние на месте, а отдают новое: отмена — прежний снимок.
import type { Cell, ContentDb, Id, ObjectKind, Preset, RoomSize, RoomSizeId, Rot } from '../../content/types';
import { CELL, type CellKind, type Grid, walkable } from './grid';

export interface RoomInstance {
  /** номер в больнице: r1, r2… — не меняется, пока помещение стоит */
  id: string;
  type: Id;
  size: RoomSizeId;
  /** левый верхний угол стен на участке */
  x: number;
  y: number;
  rot: Rot;
  /** первая клетка двери вдоль дверной стороны — x в координатах шаблона */
  door: number;
  /** аппарат на каждом месте шаблона; нет — null */
  equipment: (Id | null)[];
}

export interface Decor {
  kind: ObjectKind;
  x: number;
  y: number;
}

export interface HospitalState {
  w: number;
  h: number;
  /** вход — дверь в краю участка */
  entrance: Cell;
  /** клетки коридора — номера y·w + x по возрастанию */
  corridor: number[];
  rooms: RoomInstance[];
  /** предметы коридора: скамьи готовой амбулатории */
  decor: Decor[];
  /** номер следующего помещения */
  next: number;
}

/** Больница и касса — то, что меняет стройка и что возвращает отмена. */
export interface Built {
  hospital: HospitalState;
  cash: number;
}

export type BuildCommand =
  | { kind: 'room'; type: Id; size: RoomSizeId; x: number; y: number; rot: Rot }
  | { kind: 'corridor'; cells: Cell[] }
  | { kind: 'erase'; cells: Cell[] }
  | { kind: 'door'; room: string; at: number }
  | { kind: 'buy'; room: string; equipment: Id }
  | { kind: 'sell'; room: string; slot: number }
  | { kind: 'demolish'; room: string };

/** Почему нельзя: за краем, мешает (помещение, коридор, вход), нет денег, места под аппарат и т. д. */
export type BuildError =
  | { kind: 'outside' }
  | { kind: 'blocked'; cells: Cell[]; by: 'room' | 'corridor' | 'entrance'; room?: string }
  | { kind: 'money'; need: number }
  | { kind: 'unknown' }
  | { kind: 'noSlot' }
  | { kind: 'wrongRoom' }
  | { kind: 'badDoor' }
  | { kind: 'nothing' };

export type BuildResult = { ok: true; state: Built } | { ok: false; error: BuildError };

/** Сколько действий помнит отмена, пока открыт экран стройки. */
export const UNDO_DEPTH = 20;

// --- геометрия --------------------------------------------------------------------------

/** Размер на участке: при повороте на 90° ширина и высота меняются местами. */
export function dims(z: { w: number; h: number }, rot: Rot): [number, number] {
  return rot % 2 === 0 ? [z.w, z.h] : [z.h, z.w];
}

/** Клетка шаблона (x, y) → клетка повёрнутого помещения с углом в (0, 0). Работает и за стеной (y = h). */
export function turn(z: { w: number; h: number }, rot: Rot, x: number, y: number): Cell {
  if (rot === 0) return [x, y];
  if (rot === 1) return [z.h - 1 - y, x];
  if (rot === 2) return [z.w - 1 - x, z.h - 1 - y];
  return [y, z.w - 1 - x];
}

export function sizeOf(db: ContentDb, type: Id, size: RoomSizeId): RoomSize | undefined {
  return db.rooms[type]?.sizes.find(z => z.id === size);
}

const key = (x: number, y: number) => `${x},${y}`;

/** Клетки двери и клетки за ней (снаружи) на участке при положении `at`. */
function doorCells(z: RoomSize, r: { x: number; y: number; rot: Rot }, at: number): { cells: Cell[]; outside: Cell[] } {
  const cells: Cell[] = [];
  const outside: Cell[] = [];
  for (let k = 0; k < z.door.width; k++) {
    const [cx, cy] = turn(z, r.rot, at + k, z.h - 1);
    const [ox, oy] = turn(z, r.rot, at + k, z.h);
    cells.push([r.x + cx, r.y + cy]);
    outside.push([r.x + ox, r.y + oy]);
  }
  return { cells, outside };
}

/** Где на дверной стороне может стоять дверь: не на углу. */
function doorPositions(z: RoomSize): number[] {
  const out: number[] = [];
  for (let at = 1; at + z.door.width - 1 <= z.w - 2; at++) out.push(at);
  return out;
}

// --- занятость участка --------------------------------------------------------------------

const FREE = 0;
const CORRIDOR = 1;
const ENTRANCE = 2;
const WALL = 3;
const FLOOR = 4;
const DOOR = 5;

interface Occupancy {
  kind: Uint8Array;
  /** сколько помещений занимают клетку: у общей стены — два */
  count: Uint8Array;
  /** чья клетка: номер помещения в списке + 1 (у общих стен — первого) */
  owner: Int32Array;
  corridor: Set<number>;
}

function occupancy(db: ContentDb, hs: HospitalState): Occupancy {
  const kind = new Uint8Array(hs.w * hs.h);
  const count = new Uint8Array(hs.w * hs.h);
  const owner = new Int32Array(hs.w * hs.h);
  const corridor = new Set(hs.corridor);
  for (const i of hs.corridor) kind[i] = CORRIDOR;
  kind[hs.entrance[1] * hs.w + hs.entrance[0]] = ENTRANCE;
  hs.rooms.forEach((r, n) => {
    const z = sizeOf(db, r.type, r.size);
    if (!z) return;
    const [w, h] = dims(z, r.rot);
    for (let fy = 0; fy < h; fy++) {
      for (let fx = 0; fx < w; fx++) {
        const i = (r.y + fy) * hs.w + (r.x + fx);
        const wall = fx === 0 || fy === 0 || fx === w - 1 || fy === h - 1;
        kind[i] = wall && kind[i] !== FLOOR ? WALL : FLOOR;
        count[i]++;
        if (!owner[i]) owner[i] = n + 1;
      }
    }
  });
  const occ = { kind, count, owner, corridor };
  // двери, которые смотрят в коридор, — проходы: на них не строят
  for (const r of hs.rooms) {
    const z = sizeOf(db, r.type, r.size);
    if (z && doorOk(z, r, r.door, hs, occ)) for (const [x, y] of doorCells(z, r, r.door).cells) kind[y * hs.w + x] = DOOR;
  }
  return occ;
}

/** Дверь в `at` годится: за каждой её клеткой — коридор, а сама клетка — только своя стена. */
function doorOk(z: RoomSize, r: { x: number; y: number; rot: Rot }, at: number, hs: HospitalState, occ: Pick<Occupancy, 'count' | 'corridor'>): boolean {
  const { cells, outside } = doorCells(z, r, at);
  for (const [x, y] of outside) {
    if (x < 0 || y < 0 || x >= hs.w || y >= hs.h || !occ.corridor.has(y * hs.w + x)) return false;
  }
  return cells.every(([x, y]) => occ.count[y * hs.w + x] === 1);
}

/** Двери, которые никуда не ведут, ищут коридор сами: ближе к положению по шаблону. */
function settleDoors(db: ContentDb, hs: HospitalState): HospitalState {
  const occ = occupancy(db, hs);
  let changed = false;
  const rooms = hs.rooms.map(r => {
    const z = sizeOf(db, r.type, r.size)!;
    if (doorOk(z, r, r.door, hs, occ)) return r;
    const best = doorPositions(z)
      .filter(at => doorOk(z, r, at, hs, occ))
      .sort((a, b) => Math.abs(a - z.door.x) - Math.abs(b - z.door.x) || a - b)[0];
    if (best === undefined) return r;
    changed = true;
    return { ...r, door: best };
  });
  return changed ? { ...hs, rooms } : hs;
}

// --- проверки постройки ---------------------------------------------------------------------

/** Можно ли поставить помещение: целиком на участке, пол — на свободном, стены — на свободном или на чужих стенах. */
export function canPlace(db: ContentDb, hs: HospitalState, spec: { type: Id; size: RoomSizeId; x: number; y: number; rot: Rot }): BuildError | null {
  const z = sizeOf(db, spec.type, spec.size);
  if (!z) return { kind: 'unknown' };
  const [w, h] = dims(z, spec.rot);
  if (spec.x < 0 || spec.y < 0 || spec.x + w > hs.w || spec.y + h > hs.h) return { kind: 'outside' };
  const occ = occupancy(db, hs);
  const cells: Cell[] = [];
  let by: 'room' | 'corridor' | 'entrance' = 'room';
  let room: string | undefined;
  for (let fy = 0; fy < h; fy++) {
    for (let fx = 0; fx < w; fx++) {
      const x = spec.x + fx;
      const y = spec.y + fy;
      const i = y * hs.w + x;
      const k = occ.kind[i];
      const wall = fx === 0 || fy === 0 || fx === w - 1 || fy === h - 1;
      if (k === FREE || (k === WALL && wall)) continue;
      cells.push([x, y]);
      if (cells.length === 1) {
        by = k === CORRIDOR ? 'corridor' : k === ENTRANCE ? 'entrance' : 'room';
        if (by === 'room') room = hs.rooms[occ.owner[i] - 1]?.id;
      }
    }
  }
  return cells.length > 0 ? { kind: 'blocked', cells, by, ...(room ? { room } : {}) } : null;
}

/** Клетку можно сделать коридором: внутри участка, не у самого края, свободна. */
function corridorFree(occ: Occupancy, hs: HospitalState, x: number, y: number): boolean {
  if (x < 1 || y < 1 || x > hs.w - 2 || y > hs.h - 2) return false;
  const k = occ.kind[y * hs.w + x];
  return k === FREE || k === CORRIDOR;
}

const refund = (db: ContentDb, price: number) => Math.floor((price * db.economy.refund) / 100);

// --- команды --------------------------------------------------------------------------------

/** Постройка, коридор, дверь, аппараты, снос. Ошибка — ничего не меняется. */
export function build(db: ContentDb, s: Built, cmd: BuildCommand): BuildResult {
  const hs = s.hospital;
  const fail = (error: BuildError): BuildResult => ({ ok: false, error });
  const done = (hospital: HospitalState, cash: number): BuildResult => ({ ok: true, state: { hospital: settleDoors(db, hospital), cash } });

  if (cmd.kind === 'room') {
    const z = sizeOf(db, cmd.type, cmd.size);
    if (!z) return fail({ kind: 'unknown' });
    const bad = canPlace(db, hs, cmd);
    if (bad) return fail(bad);
    if (s.cash < z.cost) return fail({ kind: 'money', need: z.cost - s.cash });
    const room: RoomInstance = {
      id: `r${hs.next}`, type: cmd.type, size: cmd.size, x: cmd.x, y: cmd.y, rot: cmd.rot, door: z.door.x, equipment: z.slots.map(() => null),
    };
    return done({ ...hs, rooms: [...hs.rooms, room], next: hs.next + 1 }, s.cash - z.cost);
  }

  if (cmd.kind === 'corridor') {
    const occ = occupancy(db, hs);
    const add = new Set<number>();
    for (const [x, y] of cmd.cells) {
      if (!corridorFree(occ, hs, x, y)) return fail({ kind: 'blocked', cells: [[x, y]], by: occ.kind[y * hs.w + x] === ENTRANCE ? 'entrance' : 'room' });
      const i = y * hs.w + x;
      if (!occ.corridor.has(i)) add.add(i);
    }
    if (add.size === 0) return fail({ kind: 'nothing' });
    const cost = add.size * db.economy.corridor.cost;
    if (s.cash < cost) return fail({ kind: 'money', need: cost - s.cash });
    return done({ ...hs, corridor: [...hs.corridor, ...add].sort((a, b) => a - b) }, s.cash - cost);
  }

  if (cmd.kind === 'erase') {
    const drop = new Set(cmd.cells.map(([x, y]) => y * hs.w + x).filter(i => hs.corridor.includes(i)));
    if (drop.size === 0) return fail({ kind: 'nothing' });
    const decor = hs.decor.filter(d => !drop.has(d.y * hs.w + d.x));
    return done({ ...hs, corridor: hs.corridor.filter(i => !drop.has(i)), decor }, s.cash + drop.size * refund(db, db.economy.corridor.cost));
  }

  const room = hs.rooms.find(r => r.id === cmd.room);
  if (!room) return fail({ kind: 'unknown' });
  const z = sizeOf(db, room.type, room.size)!;
  const replace = (r: RoomInstance) => hs.rooms.map(x => (x.id === r.id ? r : x));

  if (cmd.kind === 'door') {
    if (!doorPositions(z).includes(cmd.at) || !doorOk(z, room, cmd.at, hs, occupancy(db, hs))) return fail({ kind: 'badDoor' });
    return done({ ...hs, rooms: replace({ ...room, door: cmd.at }) }, s.cash);
  }

  if (cmd.kind === 'buy') {
    const eq = db.equipment[cmd.equipment];
    if (!eq) return fail({ kind: 'unknown' });
    if (eq.room !== room.type) return fail({ kind: 'wrongRoom' });
    // у аппарата может быть своё место: стол операционной — под пациентом (часть 28)
    const own = eq.slot !== undefined && room.equipment[eq.slot] === null ? eq.slot : -1;
    const slot = own >= 0 ? own : room.equipment.indexOf(null);
    if (slot < 0) return fail({ kind: 'noSlot' });
    if (s.cash < eq.price) return fail({ kind: 'money', need: eq.price - s.cash });
    const equipment = room.equipment.map((x, i) => (i === slot ? eq.id : x));
    return done({ ...hs, rooms: replace({ ...room, equipment }) }, s.cash - eq.price);
  }

  if (cmd.kind === 'sell') {
    const id = room.equipment[cmd.slot];
    if (!id) return fail({ kind: 'nothing' });
    const equipment = room.equipment.map((x, i) => (i === cmd.slot ? null : x));
    return done({ ...hs, rooms: replace({ ...room, equipment }) }, s.cash + refund(db, db.equipment[id].price));
  }

  // снос: половина цены помещения и аппаратов
  const back = refund(db, z.cost) + room.equipment.reduce((m, id) => m + (id ? refund(db, db.equipment[id].price) : 0), 0);
  return done({ ...hs, rooms: hs.rooms.filter(r => r.id !== room.id) }, s.cash + back);
}

/** Пустой участок: вход в краю и отрезок коридора от него. */
export function emptyPlot(w: number, h: number, entrance: Cell, corridor: Cell[]): HospitalState {
  return { w, h, entrance, corridor: corridor.map(([x, y]) => y * w + x).sort((a, b) => a - b), rooms: [], decor: [], next: 1 };
}

/** Чего не удалось при постройке готовой больницы: номер помещения в записи, команда, причина. */
export interface PresetFailure {
  room: number;
  cmd: BuildCommand['kind'];
  equipment?: Id;
  error: BuildError;
}

/**
 * Готовая больница из записи каталога: помещения ставятся теми же командами, что у игрока,
 * — поэтому запись, которую движок не может построить, валидатор не пропустит.
 * Участок может быть больше записанного (песочница с готовой амбулаторией).
 */
export function presetHospital(db: ContentDb, p: Preset, plot: [number, number] = p.plot): { hospital: HospitalState; failed: PresetFailure[] } {
  const failed: PresetFailure[] = [];
  let s: Built = { hospital: emptyPlot(plot[0], plot[1], p.entrance, p.corridor), cash: Number.MAX_SAFE_INTEGER };
  const run = (room: number, cmd: BuildCommand) => {
    const r = build(db, s, cmd);
    if (r.ok) s = r.state;
    else failed.push({ room, cmd: cmd.kind, ...(cmd.kind === 'buy' ? { equipment: cmd.equipment } : {}), error: r.error });
  };
  p.rooms.forEach((r, n) => {
    run(n, { kind: 'room', type: r.type, size: r.size, x: r.x, y: r.y, rot: r.rot });
    const id = `r${n + 1}`;
    if (r.door !== undefined) run(n, { kind: 'door', room: id, at: r.door });
    for (const eq of r.equipment) run(n, { kind: 'buy', room: id, equipment: eq });
  });
  return { hospital: { ...s.hospital, decor: p.decor }, failed };
}

// --- план ---------------------------------------------------------------------------------

export interface PlacedRoom {
  id: string;
  type: Id;
  size: RoomSizeId;
  rot: Rot;
  x: number;
  y: number;
  w: number;
  h: number;
  /** клетки двери; пусто — двери в коридор нет */
  door: Cell[];
  /** где стоит человек каждой должности */
  staff: Record<Id, Cell>;
  patient?: Cell;
  /** стулья зоны ожидания: ближний к двери ряд — первым */
  seats: Cell[];
  /** койки палаты или смотровой приёмного по порядку — номер койки лежащего или привезённого скорой (spec 2026-09-chapter-2, части 26–27) */
  beds: Cell[];
  slots: Cell[];
  equipment: (Id | null)[];
}

export interface Plan {
  grid: Grid;
  rooms: PlacedRoom[];
  objects: { kind: ObjectKind; x: number; y: number }[];
  entrance: Cell;
  /** помещения, до двери которых можно дойти от входа */
  connected: Record<string, boolean>;
}

/** План больницы: сетка, помещения на участке, предметы, места людей, связность от входа. */
export function planOf(db: ContentDb, hs: HospitalState): Plan {
  const cells = new Uint8Array(hs.w * hs.h).fill(CELL.outside);
  const set = (x: number, y: number, c: CellKind) => {
    cells[y * hs.w + x] = c;
  };
  for (const i of hs.corridor) cells[i] = CELL.corridor;
  const occ = occupancy(db, hs);
  const rooms: PlacedRoom[] = [];
  const objects: Plan['objects'] = [];
  for (const r of hs.rooms) {
    const z = sizeOf(db, r.type, r.size);
    if (!z) continue;
    const [w, h] = dims(z, r.rot);
    for (let fy = 0; fy < h; fy++) {
      for (let fx = 0; fx < w; fx++) {
        const wall = fx === 0 || fy === 0 || fx === w - 1 || fy === h - 1;
        set(r.x + fx, r.y + fy, wall ? CELL.wall : CELL.floor);
      }
    }
    const at = (c: Cell): Cell => {
      const [x, y] = turn(z, r.rot, c[0], c[1]);
      return [r.x + x, r.y + y];
    };
    for (const o of z.objects) {
      const [x, y] = at([o.x, o.y]);
      objects.push({ kind: o.kind, x, y });
    }
    const slots = z.slots.map(at);
    r.equipment.forEach((id, i) => {
      if (id && slots[i]) objects.push({ kind: db.equipment[id].sprite, x: slots[i][0], y: slots[i][1] });
    });
    const staff: Record<Id, Cell> = {};
    for (const [role, c] of Object.entries(z.staff)) staff[role] = at(c);
    // передний ряд — ближний к двери (в шаблоне — больший y), дальше по клеткам участка
    const seats = db.rooms[r.type].seats
      ? z.objects.filter(o => o.kind === 'chair')
        .map(o => ({ row: o.y, cell: at([o.x, o.y]) }))
        .sort((a, b) => b.row - a.row || a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0])
        .map(o => o.cell)
      : [];
    const beds = db.rooms[r.type].beds || db.rooms[r.type].emergency ? z.objects.filter(o => o.kind === 'bed').map(o => at([o.x, o.y])) : [];
    const ok = doorOk(z, r, r.door, hs, occ);
    rooms.push({
      id: r.id, type: r.type, size: r.size, rot: r.rot, x: r.x, y: r.y, w, h,
      door: ok ? doorCells(z, r, r.door).cells : [], staff, ...(z.patient ? { patient: at(z.patient) } : {}), seats, beds, slots, equipment: r.equipment,
    });
  }
  for (const r of rooms) for (const [x, y] of r.door) set(x, y, CELL.door);
  // улица у коридора — наружная стена здания
  for (const i of hs.corridor) {
    const x = i % hs.w;
    const y = (i - x) / hs.w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < hs.w && ny < hs.h && cells[ny * hs.w + nx] === CELL.outside) set(nx, ny, CELL.wall);
      }
    }
  }
  set(hs.entrance[0], hs.entrance[1], CELL.door);
  for (const d of hs.decor) objects.push(d);
  const grid: Grid = { w: hs.w, h: hs.h, cells };

  // от входа — по полу, коридору и дверям
  const seen = new Uint8Array(hs.w * hs.h);
  const queue = [hs.entrance[1] * hs.w + hs.entrance[0]];
  seen[queue[0]] = 1;
  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % hs.w;
    const y = (i - x) / hs.w;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= hs.w || ny >= hs.h) continue;
      const n = ny * hs.w + nx;
      if (seen[n] || !walkable(grid, nx, ny)) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  const connected: Record<string, boolean> = {};
  for (const r of rooms) connected[r.id] = r.door.length > 0 && r.door.every(([x, y]) => seen[y * hs.w + x] === 1);
  return { grid, rooms, objects, entrance: hs.entrance, connected };
}

export { key as cellKey };
