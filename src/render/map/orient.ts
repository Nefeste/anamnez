// Куда повёрнуты предметы и люди на плане (spec 2026-09-living-map, часть 22). Чистые функции
// без Skia — проверяются в Bun. Рисунок предмета и фигурки в атласе — лицом вниз (на юг),
// спиной к северу; поворот — четверть оборота по часовой стрелке на экране, где y растёт вниз.
import { CELL, type Grid, type ObjectKind } from '@/engine/hospital/grid';

/** Четверти оборота по часовой: 0 — лицом на юг, 1 — на запад, 2 — на север, 3 — на восток. */
export type Turn = 0 | 1 | 2 | 3;
type Cell = readonly [number, number];
type Obj = { kind: ObjectKind; x: number; y: number };

/** Стороны по порядку: север, восток, юг, запад — в этом порядке ищется стена или стол. */
const DIRS: readonly Cell[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Спиной к стороне `i` из DIRS: к северу — 0, к востоку — 1, к югу — 2, к западу — 3. */
const backTo = (i: number) => i as Turn;
/** Лицом к стороне `i` из DIRS: к югу — 0, к западу — 1, к северу — 2, к востоку — 3. */
const faceTo = (i: number) => ((i + 2) % 4) as Turn;

/** Угол поворота рисунка, радианы по часовой. */
export const angleOf = (t: Turn) => (t * Math.PI) / 2;

/** Куда повёрнута фигурка, идущая на (dx, dy): рисунок — лицом на юг. */
export const headingOf = (dx: number, dy: number) => Math.atan2(-dx, dy);

/** За этими предметами работают или у них стоят: к ним поворачиваются лицом. */
const DESKS: ReadonlySet<ObjectKind> = new Set(['desk', 'table']);
const WORK: ReadonlySet<ObjectKind> = new Set(['desk', 'table', 'couch', 'bed', 'ecg', 'analyzer', 'xray', 'machine', 'sink', 'cabinet']);
/** На этих сидят или лежат: человек на них смотрит, куда повёрнут предмет. */
const SEATS: ReadonlySet<ObjectKind> = new Set(['chair', 'bench', 'couch', 'bed', 'xray']);

const key = (x: number, y: number) => `${x},${y}`;

function isWall(g: Grid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return false;
  return g.cells[y * g.w + x] === CELL.wall;
}

/** Сколько клеток от (x, y) до стены в сторону `i`; стены нет до края — Infinity. */
function wallDistance(g: Grid, x: number, y: number, i: number): number {
  const [dx, dy] = DIRS[i];
  for (let n = 1; ; n++) {
    const cx = x + dx * n;
    const cy = y + dy * n;
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return Infinity;
    const c = g.cells[cy * g.w + cx];
    if (c === CELL.wall) return n;
    if (c !== CELL.floor) return Infinity;
  }
}

/** Спиной к стене вплотную: первая по порядку сторона со стеной; нет — undefined. */
function backToWall(g: Grid, x: number, y: number): Turn | undefined {
  const i = DIRS.findIndex(([dx, dy]) => isWall(g, x + dx, y + dy));
  return i < 0 ? undefined : backTo(i);
}

/**
 * Куда повёрнут каждый предмет плана:
 * - стул у стола — лицом к столу; стул в ряду стульев — спиной к ближней стене поперёк ряда
 *   (два ряда в зале ожидания смотрят друг на друга); одинокий стул — спиной к ближней стене;
 * - стол — лицом к тому, кто за ним работает (`users` — клетки персонала), иначе к стулу рядом,
 *   иначе спиной к стене;
 * - остальное — спиной к стене вплотную.
 * Стены рядом нет — 0, как в шаблоне.
 */
export function objectTurns(g: Grid, objects: readonly Obj[], users: readonly Cell[] = []): Turn[] {
  const at = new Map(objects.map(o => [key(o.x, o.y), o.kind]));
  const people = new Set(users.map(([x, y]) => key(x, y)));
  const nearWall = (x: number, y: number, sides: readonly number[]): Turn | undefined => {
    let best: number | undefined;
    let dist = Infinity;
    for (const i of sides) {
      const d = wallDistance(g, x, y, i);
      if (d < dist) {
        dist = d;
        best = i;
      }
    }
    return best === undefined ? undefined : backTo(best);
  };
  return objects.map(({ kind, x, y }) => {
    const side = (test: (k: ObjectKind | undefined, cx: number, cy: number) => boolean) =>
      DIRS.findIndex(([dx, dy]) => test(at.get(key(x + dx, y + dy)), x + dx, y + dy));
    if (kind === 'chair') {
      const desk = side(k => k !== undefined && DESKS.has(k));
      if (desk >= 0) return faceTo(desk);
      const row = side(k => k === 'chair');
      // сосед по ряду слева или справа — ряд вдоль; спиной к ближней стене поперёк ряда
      if (row === 1 || row === 3) return nearWall(x, y, [0, 2]) ?? 0;
      if (row === 0 || row === 2) return nearWall(x, y, [3, 1]) ?? 0;
      return nearWall(x, y, [0, 1, 2, 3]) ?? 0;
    }
    if (DESKS.has(kind)) {
      const user = side((_k, cx, cy) => people.has(key(cx, cy)));
      if (user >= 0) return faceTo(user);
      const chair = side(k => k === 'chair');
      if (chair >= 0) return faceTo(chair);
    }
    return backToWall(g, x, y) ?? 0;
  });
}

/**
 * Куда смотрит человек, остановившийся в клетке: сидит или лежит на предмете — как повёрнут
 * предмет; рядом стол или аппарат — к нему лицом (стол — первым); иначе undefined — как шёл.
 * Угол — радианы по часовой, рисунок фигурки — лицом на юг.
 */
export function restHeading(objects: readonly Obj[], turns: readonly Turn[], cell: Cell): number | undefined {
  const [x, y] = cell;
  let desk: number | undefined;
  let work: number | undefined;
  for (let n = 0; n < objects.length; n++) {
    const o = objects[n];
    if (o.x === x && o.y === y && SEATS.has(o.kind)) return angleOf(turns[n]);
    const i = DIRS.findIndex(([dx, dy]) => o.x === x + dx && o.y === y + dy);
    if (i < 0 || !WORK.has(o.kind)) continue;
    const angle = angleOf(faceTo(i));
    if (DESKS.has(o.kind)) desk ??= angle;
    else work ??= angle;
  }
  return desk ?? work;
}
