// Сетка больницы: клетка 1 × 1 м, вид сверху (ADR 0014).
import { Rng } from '../core/rng';

export const CELL = {
  outside: 0,
  floor: 1,
  corridor: 2,
  wall: 3,
  door: 4,
} as const;
export type CellKind = (typeof CELL)[keyof typeof CELL];

export interface Grid {
  w: number;
  h: number;
  cells: Uint8Array;
}

export interface Room {
  id: string;
  type: RoomType;
  x: number;
  y: number;
  w: number;
  h: number;
  door: [number, number];
}

export type RoomType =
  | 'reception' | 'waiting' | 'office' | 'triage' | 'procedure' | 'lab' | 'ecg' | 'xray'
  | 'ultrasound' | 'ward' | 'surgery' | 'staff' | 'toilet';

/** Что стоит в помещении: вид предмета и клетка. */
export interface Placed {
  kind: ObjectKind;
  x: number;
  y: number;
}

export type ObjectKind = 'bed' | 'chair' | 'desk' | 'couch' | 'cabinet' | 'machine' | 'plant' | 'sink' | 'bench' | 'xray' | 'table';

export const cellAt = (g: Grid, x: number, y: number) => g.cells[y * g.w + x] as CellKind;
export const walkable = (g: Grid, x: number, y: number) => {
  const c = g.cells[y * g.w + x];
  return c === CELL.floor || c === CELL.corridor || c === CELL.door;
};

export interface HospitalLayout {
  grid: Grid;
  rooms: Room[];
  objects: Placed[];
}

/**
 * Больница прототипа П2 (spec 2026-09-spikes): 56 × 40, центральный коридор и два
 * поперечных, 18 помещений по обе стороны, около 600 предметов. Детерминирована по зерну.
 */
export function spikeHospital(seed = 1): HospitalLayout {
  const w = 56;
  const h = 40;
  const cells = new Uint8Array(w * h);
  const grid: Grid = { w, h, cells };
  const set = (x: number, y: number, c: CellKind) => {
    if (x >= 0 && y >= 0 && x < w && y < h) cells[y * w + x] = c;
  };
  const fill = (x0: number, y0: number, x1: number, y1: number, c: CellKind) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
  };

  // Коридоры: центральный (y 18–20) и поперечные (x 18–20, x 36–38).
  fill(1, 18, w - 2, 20, CELL.corridor);
  fill(18, 1, 20, h - 2, CELL.corridor);
  fill(36, 1, 38, h - 2, CELL.corridor);

  const types: RoomType[] = [
    'reception', 'waiting', 'office', 'office', 'triage', 'procedure', 'lab', 'ecg', 'xray',
    'office', 'office', 'ultrasound', 'ward', 'ward', 'ward', 'surgery', 'staff', 'toilet',
  ];
  const rooms: Room[] = [];
  // Шесть блоков: три колонки × верх/низ; каждый делится на три помещения по ширине.
  const columns: [number, number][] = [[1, 17], [21, 35], [39, 54]];
  const bands: [number, number, 'top' | 'bottom'][] = [[1, 17, 'top'], [21, 38, 'bottom']];
  let n = 0;
  for (const [by0, by1, side] of bands) {
    for (const [bx0, bx1] of columns) {
      const width = bx1 - bx0 + 1;
      const cuts = [bx0, bx0 + Math.floor(width / 3), bx0 + Math.floor((2 * width) / 3), bx1 + 1];
      for (let k = 0; k < 3; k++) {
        const x = cuts[k];
        const rw = cuts[k + 1] - cuts[k];
        const room: Room = {
          id: `room.${n}`,
          type: types[n],
          x, y: by0, w: rw, h: by1 - by0 + 1,
          door: [x + Math.floor(rw / 2), side === 'top' ? by1 : by0],
        };
        // Стены — по контуру, пол — внутри, дверь — на стороне коридора.
        fill(room.x, room.y, room.x + room.w - 1, room.y + room.h - 1, CELL.wall);
        fill(room.x + 1, room.y + 1, room.x + room.w - 2, room.y + room.h - 2, CELL.floor);
        set(room.door[0], room.door[1], CELL.door);
        rooms.push(room);
        n++;
      }
    }
  }

  const rng = Rng.seeded(seed).fork('objects');
  const objects: Placed[] = [];
  const free = (x: number, y: number) => cellAt(grid, x, y) === CELL.floor && !objects.some(o => o.x === x && o.y === y);
  for (const room of rooms) {
    const r = rng.fork(room.id);
    const kinds = furniture(room.type);
    // Предметы — плотно, кроме прохода от двери через всё помещение (нагрузка для П2).
    for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
      for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
        if (x === room.door[0]) continue;
        if (!free(x, y) || r.int(100) < 30) continue;
        objects.push({ kind: r.pick(kinds), x, y });
      }
    }
  }
  // Скамейки, растения и каталки вдоль стен коридоров.
  const corridorEdge = (x: number, y: number) => {
    const r = rng.fork(`c${x}.${y}`);
    if (cellAt(grid, x, y) === CELL.corridor && r.int(100) < 70) objects.push({ kind: r.int(3) === 0 ? 'plant' : 'bench', x, y });
  };
  for (let x = 1; x < w - 1; x++) for (const y of [18, 20]) corridorEdge(x, y);
  for (let y = 1; y < h - 1; y++) for (const x of [18, 20, 36, 38]) if (y < 18 || y > 20) corridorEdge(x, y);
  return { grid, rooms, objects };
}

function furniture(type: RoomType): ObjectKind[] {
  switch (type) {
    case 'waiting': return ['chair', 'chair', 'chair', 'plant', 'bench'];
    case 'ward': return ['bed', 'bed', 'cabinet', 'chair', 'machine'];
    case 'lab': return ['machine', 'table', 'cabinet', 'sink'];
    case 'xray': return ['xray', 'cabinet', 'table'];
    case 'surgery': return ['table', 'machine', 'cabinet', 'sink'];
    case 'toilet': return ['sink'];
    case 'staff': return ['table', 'chair', 'couch', 'plant'];
    case 'reception': return ['desk', 'chair', 'cabinet', 'plant'];
    default: return ['desk', 'chair', 'couch', 'cabinet', 'sink', 'plant'];
  }
}
