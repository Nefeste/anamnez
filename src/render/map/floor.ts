// Пол, стены и двери записываются один раз в SkPicture и перерисовываются только после
// стройки (06-architecture.md §6). Рисунок — как план здания (spec 2026-09-living-map, часть
// 22): стена — тёмная полоса по середине стеновых клеток, по обе стороны — пол того, что за
// ней; дверь — проём со створкой и дугой открывания; наружная стена толще. Пол и стены —
// прямоугольниками, подряд одного цвета — одним: запись проигрывается на каждом кадре.
import { PaintStyle, Skia, type SkPaint, type SkPicture } from '@shopify/react-native-skia';
import { CELL, type Grid, type RoomType } from '@/engine/hospital/grid';
import { CELL_PX, CORRIDOR, OUTSIDE, ROOM_TINT, WALL_IN, WALL_OUT } from './metrics';

export { CELL_PX, CORRIDOR, OUTSIDE } from './metrics';

const SEAM = '#E9E2D4';
export const WALL = '#46555A';
/** Толща между двумя стенами вплотную, где пола рядом нет. */
const MASS = '#C3CBCC';
const LEAF = '#5E6D72';
const MAT = '#8A8272';
/** Длина створки — доля клетки: проём — клетка. */
const LEAF_LEN = 0.92;

/** Помещения — из плана стройки (`room.lab`) или прежней записи (`lab`): оттенок один. */
type FloorRoom = { type: string; x: number; y: number; w: number; h: number };
export const tintOf = (type: string) => ROOM_TINT[(type.startsWith('room.') ? type.slice(5) : type) as RoomType] ?? '#F3F0EA';

const SIDES = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

/**
 * Прямоугольники одного цвета из сетки цветов: подряд в строке — в один, и такой же под ним —
 * тоже, пока совпадает. Так пол помещения — один прямоугольник, а не клетки.
 */
function mergeRects(colors: readonly string[], W: number, H: number): { x: number; y: number; w: number; h: number; color: string }[] {
  const out: { x: number; y: number; w: number; h: number; color: string }[] = [];
  let open = new Map<string, { x: number; y: number; w: number; h: number; color: string }>();
  for (let y = 0; y < H; y++) {
    const next = new Map<string, { x: number; y: number; w: number; h: number; color: string }>();
    let x = 0;
    while (x < W) {
      const color = colors[y * W + x];
      let e = x + 1;
      while (e < W && colors[y * W + e] === color) e++;
      const k = `${x}:${e}:${color}`;
      const r = open.get(k);
      if (r) {
        r.h++;
        open.delete(k);
        next.set(k, r);
      } else {
        next.set(k, { x, y, w: e - x, h: 1, color });
      }
      x = e;
    }
    for (const r of open.values()) out.push(r);
    open = next;
  }
  for (const r of open.values()) out.push(r);
  return out;
}

export function recordFloor(layout: { grid: Grid; rooms: readonly FloorRoom[]; entrance?: readonly [number, number] }): SkPicture {
  const { grid, rooms, entrance } = layout;
  const { w, h, cells } = grid;
  const S = CELL_PX;
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, w * S, h * S));
  const paint = (color: string, width = 0) => {
    const p = Skia.Paint();
    p.setColor(Skia.Color(color));
    p.setAntiAlias(true);
    if (width > 0) {
      p.setStyle(PaintStyle.Stroke);
      p.setStrokeWidth(width * S);
    }
    return p;
  };

  // чей пол в клетке: номер помещения по его прямоугольнику
  const owner = new Int32Array(w * h).fill(-1);
  rooms.forEach((r, i) => {
    for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) if (cells[y * w + x] === CELL.floor) owner[y * w + x] = i;
    }
  });
  const kind = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? CELL.outside : cells[y * w + x]);
  const solid = (x: number, y: number) => kind(x, y) === CELL.wall || kind(x, y) === CELL.door;
  /** Цвет пола клетки; у стены и двери своего пола нет — null. */
  const zone = (x: number, y: number): string | null => {
    const k = kind(x, y);
    if (k === CELL.wall || k === CELL.door) return null;
    if (k === CELL.corridor) return CORRIDOR;
    if (k === CELL.floor) {
      const i = owner[y * w + x];
      return tintOf(i >= 0 ? rooms[i].type : '');
    }
    return OUTSIDE;
  };

  // пол — в полклетки: у стены и двери каждая четверть — пол того, к чему она обращена
  const W2 = w * 2;
  const H2 = h * 2;
  const colors = new Array<string>(W2 * H2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const own = zone(x, y);
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        let color = own;
        if (color === null) {
          const hz = zone(x + sx, y);
          const vz = zone(x, y + sy);
          const dz = zone(x + sx, y + sy);
          color = hz && vz ? (hz === vz ? hz : (dz ?? hz)) : (hz ?? vz ?? dz ?? MASS);
        }
        colors[(y * 2 + (sy < 0 ? 0 : 1)) * W2 + x * 2 + (sx < 0 ? 0 : 1)] = color;
      }
    }
  }
  // прямоугольники, а не пути: запись проигрывается на каждом кадре, пока кто-то идёт, а
  // прямоугольник Skia рисует быстрее всего
  const fills = new Map<string, SkPaint>();
  const fillOf = (color: string) => {
    let p = fills.get(color);
    if (!p) {
      p = paint(color);
      fills.set(color, p);
    }
    return p;
  };
  const box = (x0: number, y0: number, x1: number, y1: number, color: string) => c.drawRect(Skia.XYWHRect(x0 * S, y0 * S, (x1 - x0) * S, (y1 - y0) * S), fillOf(color));
  for (const r of mergeRects(colors, W2, H2)) box(r.x / 2, r.y / 2, (r.x + r.w) / 2, (r.y + r.h) / 2, r.color);

  // швы линолеума в коридоре — по границам клеток, подряд одной полоской, едва заметно
  const sw = 0.03;
  for (let x = 0; x < w - 1; x++) {
    let from = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && kind(x, y) === CELL.corridor && kind(x + 1, y) === CELL.corridor;
      if (on && from < 0) from = y;
      if (!on && from >= 0) {
        box(x + 1 - sw / 2, from, x + 1 + sw / 2, y, SEAM);
        from = -1;
      }
    }
  }
  for (let y = 0; y < h - 1; y++) {
    let from = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && kind(x, y) === CELL.corridor && kind(x, y + 1) === CELL.corridor;
      if (on && from < 0) from = x;
      if (!on && from >= 0) {
        box(from, y + 1 - sw / 2, x, y + 1 + sw / 2, SEAM);
        from = -1;
      }
    }
  }

  // стена — полоса по середине клеток, отрезками от середины до середины соседней стены и до
  // косяка двери; подряд одной толщины — одним прямоугольником. У наружной стены (рядом улица)
  // полоса толще; отрезок между толстой и тонкой — по тонкой; конец у стены продлён на
  // полтолщины — углы и концы закрыты
  const outer = (x: number, y: number) => SIDES.some(([dx, dy]) => kind(x + dx, y + dy) === CELL.outside);
  const thick = (x: number, y: number) => (outer(x, y) ? WALL_OUT : WALL_IN);
  type Run = { a: number; b: number; t: number; aWall: boolean; bWall: boolean };
  /** Отрезки вдоль ряда: `at(i)` — клетка i ряда, `put` рисует отрезок [a, b] толщиной t. */
  const runs = (n: number, at: (i: number) => [number, number], put: (a: number, b: number, t: number) => void) => {
    let cur: Run | null = null;
    const flush = () => {
      if (cur) put(cur.aWall ? cur.a - cur.t / 2 : cur.a, cur.bWall ? cur.b + cur.t / 2 : cur.b, cur.t);
      cur = null;
    };
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = at(i);
      const [x1, y1] = at(i + 1);
      const k0 = kind(x0, y0);
      const k1 = kind(x1, y1);
      let seg: Run | null = null;
      if (k0 === CELL.wall && k1 === CELL.wall) seg = { a: i + 0.5, b: i + 1.5, t: Math.min(thick(x0, y0), thick(x1, y1)), aWall: true, bWall: true };
      else if (k0 === CELL.wall && k1 === CELL.door) seg = { a: i + 0.5, b: i + 1, t: thick(x0, y0), aWall: true, bWall: false };
      else if (k0 === CELL.door && k1 === CELL.wall) seg = { a: i + 1, b: i + 1.5, t: thick(x1, y1), aWall: false, bWall: true };
      const run = cur as Run | null;
      if (seg && run && run.b === seg.a && run.t === seg.t) {
        run.b = seg.b;
        run.bWall = seg.bWall;
      } else {
        flush();
        cur = seg;
      }
    }
    flush();
  };
  for (let y = 0; y < h; y++) runs(w, i => [i, y], (a, b, t) => box(a, y + 0.5 - t / 2, b, y + 0.5 + t / 2, WALL));
  for (let x = 0; x < w; x++) runs(h, i => [x, i], (a, b, t) => box(x + 0.5 - t / 2, a, x + 0.5 + t / 2, b, WALL));
  // середина наружной стены и одинокой стены без соседей — квадратом своей толщины
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (kind(x, y) !== CELL.wall) continue;
      if (!outer(x, y) && SIDES.some(([dx, dy]) => solid(x + dx, y + dy))) continue;
      const t = thick(x, y);
      box(x + 0.5 - t / 2, y + 0.5 - t / 2, x + 0.5 + t / 2, y + 0.5 + t / 2, WALL);
    }
  }

  // двери: одностворчатая — створка от косяка внутрь и дуга открывания; широкий проём — без
  // створки; у входа — коврик снаружи
  const leaves = Skia.PathBuilder.Make();
  const arcs = Skia.PathBuilder.Make();
  const L = LEAF_LEN;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (kind(x, y) !== CELL.door) continue;
      // стена идёт с запада на восток — проём с севера на юг
      const across = solid(x - 1, y) && solid(x + 1, y);
      const wide = across ? kind(x - 1, y) === CELL.door || kind(x + 1, y) === CELL.door : kind(x, y - 1) === CELL.door || kind(x, y + 1) === CELL.door;
      const [ax, ay] = across ? [0, 1] : [1, 0];
      // открывается в помещение; у входа — внутрь здания
      const rank = (s: number) => {
        const k = kind(x + ax * s, y + ay * s);
        return k === CELL.floor ? 2 : k === CELL.corridor ? 1 : 0;
      };
      const side = rank(1) >= rank(-1) ? 1 : -1;
      if (entrance && entrance[0] === x && entrance[1] === y && zone(x - ax * side, y - ay * side) === OUTSIDE) {
        const out = -side;
        const m = across
          ? Skia.XYWHRect((x + 0.12) * S, (out < 0 ? y + 0.04 : y + 0.62) * S, 0.76 * S, 0.34 * S)
          : Skia.XYWHRect((out < 0 ? x + 0.04 : x + 0.62) * S, (y + 0.12) * S, 0.34 * S, 0.76 * S);
        c.drawRRect(Skia.RRectXY(m, 0.08 * S, 0.08 * S), paint(MAT));
      }
      if (wide) continue;
      // косяк — край проёма на средней линии стены: у двери в стене с запада на восток — западный
      const hx = across ? x : x + 0.5;
      const hy = across ? y + 0.5 : y;
      const oval = Skia.XYWHRect((hx - L) * S, (hy - L) * S, 2 * L * S, 2 * L * S);
      if (across) {
        leaves.moveTo(hx * S, hy * S).lineTo(hx * S, (hy + side * L) * S);
        arcs.addArc(oval, side > 0 ? 0 : 270, 90);
      } else {
        leaves.moveTo(hx * S, hy * S).lineTo((hx + side * L) * S, hy * S);
        arcs.addArc(oval, side > 0 ? 0 : 90, 90);
      }
    }
  }
  const swing = paint(LEAF, 0.03);
  swing.setAlphaf(0.5);
  c.drawPath(arcs.detach(), swing);
  c.drawPath(leaves.detach(), paint(LEAF, 0.07));
  return rec.finishRecordingAsPicture();
}

/** Сетка клеток участка — на экране стройки видно, куда встанет помещение. */
export function recordGridLines(w: number, h: number): SkPicture {
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, w * CELL_PX, h * CELL_PX));
  const p = Skia.Paint();
  p.setColor(Skia.Color('rgba(40, 60, 64, 0.12)'));
  p.setStrokeWidth(0.6);
  for (let x = 0; x <= w; x++) c.drawLine(x * CELL_PX, 0, x * CELL_PX, h * CELL_PX, p);
  for (let y = 0; y <= h; y++) c.drawLine(0, y * CELL_PX, w * CELL_PX, y * CELL_PX, p);
  return rec.finishRecordingAsPicture();
}
