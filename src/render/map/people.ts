// Люди прототипа П2: маршруты A* между помещениями, плоскими массивами для UI-потока.
// Движок отдаёт маршруты, а позицию на каждом кадре считает ворклет (06-architecture.md §6).
import { Rng } from '@/engine/core/rng';
import type { HospitalLayout } from '@/engine/hospital/grid';
import { type Cell, findPath } from '@/engine/sim/path';

export interface PeopleRoutes {
  count: number;
  /** x0, y0, x1, y1, … всех маршрутов подряд, в клетках */
  points: number[];
  /** на человека: смещение в points (в точках), число точек, скорость (клеток/с), фаза */
  meta: number[];
  kinds: number[];
}

export function makePeople(layout: HospitalLayout, count: number, seed = 1): PeopleRoutes {
  const rng = Rng.seeded(seed).fork('people');
  const inside = (i: number): Cell => {
    const r = layout.rooms[i];
    return [r.door[0], r.door[1] + (r.door[1] === r.y ? 1 : -1)];
  };
  const points: number[] = [];
  const meta: number[] = [];
  const kinds: number[] = [];
  for (let k = 0; k < count; k++) {
    const r = rng.fork(String(k));
    const a = r.int(layout.rooms.length);
    let b = r.int(layout.rooms.length - 1);
    if (b >= a) b++;
    const path = findPath(layout.grid, inside(a), inside(b)) ?? [inside(a), inside(a)];
    meta.push(points.length / 2, path.length, 1.1 + r.int(80) / 100, r.int(1000) / 10);
    for (const [x, y] of path) points.push(x, y);
    kinds.push(k < 8 ? 0 : k < 16 ? 1 : 2 + (k % 3));
  }
  return { count, points, meta, kinds };
}
