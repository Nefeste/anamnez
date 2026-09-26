// Пути по сетке больницы: A* по четырём направлениям (`docs/06-architecture.md` §3).
// Люди ходят по полу помещений, коридорам и дверям; стены и улица непроходимы.
import type { Grid } from '../hospital/grid';
import { walkable } from '../hospital/grid';

export type Cell = [number, number];

/** Кратчайший путь от `from` до `to` включительно или `null`, если дойти нельзя. */
export function findPath(grid: Grid, from: Cell, to: Cell): Cell[] | null {
  const { w, h } = grid;
  const idx = (x: number, y: number) => y * w + x;
  const start = idx(from[0], from[1]);
  const goal = idx(to[0], to[1]);
  if (!walkable(grid, from[0], from[1]) || !walkable(grid, to[0], to[1])) return null;
  const g = new Int32Array(w * h).fill(-1);
  const came = new Int32Array(w * h).fill(-1);
  const heap = new MinHeap();
  g[start] = 0;
  heap.push(start, manhattan(from, to));
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) break;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !walkable(grid, nx, ny)) continue;
      const n = idx(nx, ny);
      const cost = g[cur] + 1;
      if (g[n] !== -1 && g[n] <= cost) continue;
      g[n] = cost;
      came[n] = cur;
      heap.push(n, cost + Math.abs(nx - to[0]) + Math.abs(ny - to[1]));
    }
  }
  if (g[goal] === -1) return null;
  const path: Cell[] = [];
  for (let c = goal; c !== -1; c = came[c]) {
    const x = c % w;
    path.push([x, (c - x) / w]);
    if (c === start) break;
  }
  return path.reverse();
}

const manhattan = (a: Cell, b: Cell) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** Двоичная куча по приоритету; при равном — по порядку добавления (детерминированно). */
class MinHeap {
  private items: { v: number; pr: number; seq: number }[] = [];
  private seq = 0;
  get size() {
    return this.items.length;
  }
  push(v: number, pr: number) {
    const a = this.items;
    a.push({ v, pr, seq: this.seq++ });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top.v;
  }
}
const less = (a: { pr: number; seq: number }, b: { pr: number; seq: number }) => a.pr < b.pr || (a.pr === b.pr && a.seq < b.seq);
