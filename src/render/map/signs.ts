// Где на плане знаки помещений (spec 2026-09-living-map, часть 23): лампа над дверью — на стене
// рядом с проёмом, со стороны без петель створки (floor.ts); какой аппарат в каком помещении —
// чей свет у него. Чистые функции без Skia — проверяются в Bun.
import { CELL, type Grid } from '@/engine/hospital/grid';

type Cell = readonly [number, number];
type Rect = { x: number; y: number; w: number; h: number };

/** В каком помещении каждый предмет плана — номер в `rooms`; вне помещений — -1. */
export function objectRooms(rooms: readonly Rect[], objects: readonly { x: number; y: number }[]): number[] {
  return objects.map(o => rooms.findIndex(r => o.x >= r.x && o.x < r.x + r.w && o.y >= r.y && o.y < r.y + r.h));
}

/**
 * Лампа над дверью, в клетках: середина соседней стеновой клетки — восточной у двери в стене с
 * запада на восток, южной у двери в стене с севера на юг (петли створки — с другой стороны).
 * Не дверь или рядом нет стены — undefined.
 */
export function lampAt(g: Grid, [x, y]: Cell): [number, number] | undefined {
  const kind = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h ? CELL.outside : g.cells[cy * g.w + cx]);
  if (kind(x, y) !== CELL.door) return undefined;
  const solid = (cx: number, cy: number) => kind(cx, cy) === CELL.wall || kind(cx, cy) === CELL.door;
  const across = solid(x - 1, y) && solid(x + 1, y);
  const [nx, ny] = across ? [x + 1, y] : [x, y + 1];
  return kind(nx, ny) === CELL.wall ? [nx + 0.5, ny + 0.5] : undefined;
}
