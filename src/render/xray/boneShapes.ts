// Помощники рентгена костей (spec 2026-09-chapter-2, часть 31): гладкие контуры через опорные
// точки, корковый слой вдоль диафиза, сдвиг и поворот отломка, деление кости линией перелома.
// Всё — чистые функции; координаты — в долях ширины панели по обеим осям, чтобы поворот не
// искажал форму.

export type Pt = [number, number];

/** Точка сплайна Катмулла — Рома между p1 и p2. */
function catmull(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t, t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/** Замкнутый гладкий контур через опорные точки: n точек на отрезок. */
export function closedSpline(pts: readonly Pt[], n = 6): Pt[] {
  const m = pts.length;
  const out: Pt[] = [];
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m], p3 = pts[(i + 2) % m];
    for (let k = 0; k < n; k++) out.push(catmull(p0, p1, p2, p3, k / n));
  }
  return out;
}

/** Открытая гладкая линия через опорные точки: от первой до последней. */
export function openSpline(pts: readonly Pt[], n = 6): Pt[] {
  const m = pts.length;
  if (m < 3) return pts.map(p => [p[0], p[1]] as Pt);
  const out: Pt[] = [];
  for (let i = 0; i < m - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(m - 1, i + 2)];
    for (let k = 0; k < n; k++) out.push(catmull(p0, p1, p2, p3, k / n));
  }
  out.push([pts[m - 1][0], pts[m - 1][1]]);
  return out;
}

/** Эллипс многоугольником: центр, полуоси, поворот (радианы, по часовой на экране). */
export function ellipse(c: Pt, rx: number, ry: number, rot = 0, n = 24): Pt[] {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    return [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs] as Pt;
  });
}

/** Точки в системе кости: u — вдоль оси от центра, v — поперёк; ось задана углом. */
export function frame(c: Pt, angle: number, pts: readonly Pt[]): Pt[] {
  const cs = Math.cos(angle), sn = Math.sin(angle);
  return pts.map(([u, v]) => [c[0] + u * cs - v * sn, c[1] + u * sn + v * cs] as Pt);
}

const nearest = (p: Pt, line: readonly Pt[]): Pt => {
  let best = line[0], d = Infinity;
  for (const q of line) {
    const e = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (e < d) { d = e; best = q; }
  }
  return best;
};

/**
 * Корковый слой вдоль края диафиза: полоса от края внутрь кости, к оси `center`. Толщина — от t0
 * к t1 вдоль края; у концов полоса сходит на нет, как кортикальный слой к метафизу.
 */
export function strip(edge: readonly Pt[], center: readonly Pt[], t0: number, t1: number, fade = 0.2, smooth = true): Pt[] {
  const e = smooth ? openSpline(edge, 4) : edge.map(p => [p[0], p[1]] as Pt);
  const inner: Pt[] = e.map((p, i) => {
    const a = e[Math.max(0, i - 1)], b = e[Math.min(e.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    let nx = -dy / l, ny = dx / l;
    const q = nearest(p, center);
    if (nx * (q[0] - p[0]) + ny * (q[1] - p[1]) < 0) { nx = -nx; ny = -ny; }
    const s = i / (e.length - 1);
    const taper = Math.min(1, s / fade, (1 - s) / fade);
    const t = (t0 + (t1 - t0) * s) * Math.max(0, taper) ** 0.6;
    return [p[0] + nx * t, p[1] + ny * t];
  });
  return [...e, ...inner.reverse()];
}

/** Смещение отломка: поворот вокруг точки, затем сдвиг. */
export interface Move {
  pivot: Pt;
  /** радианы, по часовой на экране (ось y — вниз) */
  angle: number;
  dx: number;
  dy: number;
}

export const STILL: Move = { pivot: [0, 0], angle: 0, dx: 0, dy: 0 };

export function moved(p: Pt, m: Move): Pt {
  const cs = Math.cos(m.angle), sn = Math.sin(m.angle);
  const x = p[0] - m.pivot[0], y = p[1] - m.pivot[1];
  return [m.pivot[0] + x * cs - y * sn + m.dx, m.pivot[1] + x * sn + y * cs + m.dy];
}

/** Точка внутри многоугольника — правило чётности пересечений. */
export function inside(p: Pt, poly: readonly Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function centroid(pts: readonly Pt[]): Pt {
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

/**
 * Линия перелома поперёк кости: через точку оси `c`, поперёк оси `axis` (единичный вектор к
 * смещаемому отломку) с наклоном `oblique` (радианы от поперечного), длиной `span` в обе стороны;
 * мелкие зубцы — от зерна. Концы — за контуром кости.
 */
export function fractureLine(c: Pt, axis: Pt, span: number, oblique: number, jag: () => number, n = 9): Pt[] {
  // поперёк оси — повёрнутая на 90° ось, затем наклон
  const cs = Math.cos(oblique), sn = Math.sin(oblique);
  const tx = -axis[1], ty = axis[0];
  const dx = tx * cs - ty * sn, dy = tx * sn + ty * cs;
  return Array.from({ length: n + 1 }, (_, i) => {
    const s = -span + (2 * span * i) / n;
    // зубцы — вдоль оси кости, у концов меньше
    const z = i === 0 || i === n ? 0 : jag();
    return [c[0] + dx * s + axis[0] * z, c[1] + dy * s + axis[1] * z] as Pt;
  });
}

/**
 * Две стороны линии перелома — большие многоугольники для обрезки: `moving` — там, куда смотрит
 * `axis`, `fixed` — с другой стороны. Между ними — просвет `gap` вдоль оси: линия перелома тёмная,
 * даже когда отломки не смещены.
 */
export function sides(line: readonly Pt[], axis: Pt, gap: number, far = 3): { fixed: Pt[]; moving: Pt[] } {
  const shift = (d: number) => line.map(([x, y]) => [x + axis[0] * d, y + axis[1] * d] as Pt);
  const a = line[0], b = line[line.length - 1];
  const tx = b[0] - a[0], ty = b[1] - a[1];
  const l = Math.hypot(tx, ty) || 1;
  const ux = (tx / l) * far, uy = (ty / l) * far;
  const cap = (pts: Pt[], s: number): Pt[] => {
    const f = pts[0], e = pts[pts.length - 1];
    return [
      [f[0] - ux, f[1] - uy], ...pts, [e[0] + ux, e[1] + uy],
      [e[0] + ux + axis[0] * far * s, e[1] + uy + axis[1] * far * s],
      [f[0] - ux + axis[0] * far * s, f[1] - uy + axis[1] * far * s],
    ];
  };
  return { moving: cap(shift(gap / 2), 1), fixed: cap(shift(-gap / 2), -1) };
}
