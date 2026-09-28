// Матрица рисунка атласа в клетку плана с поворотом вокруг её середины — и для записи предметов,
// и в ворклете UI-потока для людей (spec 2026-09-living-map, часть 22). Без Skia: четыре числа
// RSXform — scos, ssin, tx, ty.
import { CELL_PX } from './metrics';

/**
 * RSXform клетки (x, y) — в клетках, с поворотом `a` радиан по часовой; рисунок атласа — `px`
 * точек; `size` — во сколько клеток рисунок (люди чуть крупнее клетки: их видно лучше мебели).
 */
export function cellXform(a: number, x: number, y: number, px: number, size = 1): [number, number, number, number] {
  'worklet';
  const k = (size * CELL_PX) / px;
  const sc = k * Math.cos(a);
  const ss = k * Math.sin(a);
  const half = px / 2;
  return [sc, ss, (x + 0.5) * CELL_PX - (sc - ss) * half, (y + 0.5) * CELL_PX - (ss + sc) * half];
}
