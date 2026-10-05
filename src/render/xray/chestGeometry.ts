// Обзорный снимок груди в прямой проекции (ADR 0013): геометрия — чистые функции в долях кадра
// (x — доля ширины, y — доля высоты), рисунок — chest.ts. Правая сторона пациента — слева на
// снимке. Контур лёгочных полей и рёбра, а с травмой груди (spec 2026-09-chapter-2, часть 32в) —
// край спавшегося лёгкого при пневмотораксе, верхняя граница крови в плевральной полости,
// смещение средостения и место перелома ребра; с частью 43а — расширенное верхнее средостение.
//
// Рисовальщик болезней не знает: воздух, кровь и переломы заданы параметрами. Что они значат,
// запишут признаки базы по источникам.
import { Rng } from '@/engine/core/rng';

export type Pt = [number, number];
/** Сторона на снимке: −1 — правая сторона пациента (слева), +1 — левая. */
export type FilmSide = -1 | 1;
export type PatientSide = 'right' | 'left';

export interface XrayFindings {
  /** инфильтрат: сторона пациента и насколько плотный (0–1) */
  infiltrate?: { side: 'right' | 'left' | 'both'; density: number };
  /** эмфизема: низкие плоские купола, узкое «капельное» сердце, лёгкие прозрачнее */
  hyperinflation?: boolean;
  /**
   * Пневмоторакс: малый — полоска воздуха у верхушки и стенки, большой — лёгкое поджато к корню;
   * напряжённый — ещё меньше, купол ниже, средостение — в здоровую сторону.
   */
  pneumothorax?: { side: PatientSide; size: 'small' | 'large'; tension?: boolean };
  /**
   * Кровь в плевральной полости: средняя — снизу до угла лопатки, у стенки выше; массивная — выше
   * угла лопатки, средостение — в здоровую сторону; с воздухом — горизонтальный уровень.
   */
  effusion?: { side: PatientSide; massive?: boolean; air?: boolean };
  /** Переломы рёбер: сторона и номера (2–10). */
  ribFractures?: { side: PatientSide; ribs: number[] };
  /**
   * Верхнее средостение расширено (spec 2026-10-chapter-3, часть 43а): тень над сердцем шире в обе
   * стороны — справа выбухает восходящая аорта, слева больше дуга.
   */
  wideMediastinum?: boolean;
}

export const XRAY_ASPECT = 1.1;

export const filmSide = (s: PatientSide): FilmSide => (s === 'right' ? -1 : 1);
export const mirror = (x: number, s: FilmSide) => (s === -1 ? x : 1 - x);

/** Точки кубической кривой Безье. */
export function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** Точки квадратичной кривой Безье. */
export function quad(p0: Pt, p1: Pt, p2: Pt, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}

/**
 * Вершина купола диафрагмы на этой стороне: левый ниже правого на 0,03; при эмфиземе оба ниже
 * и плоские; напряжённый пневмоторакс опускает купол на своей стороне.
 */
export function domeY(s: FilmSide, f: XrayFindings): number {
  const pt = f.pneumothorax;
  const tension = pt?.tension === true && filmSide(pt.side) === s ? 0.045 : 0;
  return (f.hyperinflation ? 0.7 : 0.625) + (s === 1 ? 0.03 : 0) + tension;
}

/**
 * Лёгочное поле — замкнутый контур: верхушка, боковая стенка, острый синус, купол, край у
 * средостения (внутренний край уходит за тень сердца).
 */
export function hemithorax(s: FilmSide, f: XrayFindings): Pt[] {
  const dome = domeY(s, f);
  const emph = f.hyperinflation === true;
  const wide = emph ? 0.012 : 0;
  const m = (x: number) => mirror(x, s);
  const pts: Pt[] = [];
  const add = (seg: Pt[]) => pts.push(...(pts.length > 0 ? seg.slice(1) : seg));
  add(bezier([m(0.47), 0.13], [m(0.45), 0.07], [m(0.34), 0.06], [m(0.265), 0.1], 16));
  add(bezier([m(0.265), 0.1], [m(0.17 - wide), 0.16], [m(0.115 - wide), 0.34], [m(0.11 - wide), 0.55], 24));
  add(quad([m(0.11 - wide), 0.55], [m(0.108 - wide), dome + 0.05], [m(0.12 - wide), dome + 0.125], 12)); // синус
  if (emph) {
    add(bezier([m(0.12 - wide), dome + 0.125], [m(0.18), dome + 0.04], [m(0.3), dome], [m(0.4), dome + 0.01], 18));
  } else {
    add(bezier([m(0.12 - wide), dome + 0.125], [m(0.16), dome + 0.06], [m(0.23), dome], [m(0.31), dome], 14));
    add(quad([m(0.31), dome], [m(0.4), dome + 0.003], [m(0.48), dome + 0.07], 10));
  }
  pts.push([m(0.49), dome + 0.08], [m(0.49), 0.3]);
  return pts;
}

/** Корни лёгких: отсюда расходятся сосуды. */
export const HILUM: Record<FilmSide, Pt> = { [-1]: [0.43, 0.41], [1]: [0.58, 0.38] };

/** Какая доля лёгкого осталась расправленной: малый — почти всё, большой — половина, напряжённый — меньше. */
export function lungScale(size: 'small' | 'large', tension: boolean): number {
  return tension ? 0.4 : size === 'large' ? 0.55 : 0.9;
}

/** Воздух в плевральной полости — пневмоторакс или воздух над кровью (гемопневмоторакс). */
function airOf(f: XrayFindings): { side: PatientSide; size: 'small' | 'large'; tension: boolean } | undefined {
  if (f.pneumothorax) return { side: f.pneumothorax.side, size: f.pneumothorax.size, tension: f.pneumothorax.tension === true };
  if (f.effusion?.air) return { side: f.effusion.side, size: 'small', tension: false };
  return undefined;
}

/**
 * Край спавшегося лёгкого (висцеральная плевра): контур поля, поджатый к точке у корня над
 * куполом. Стоя воздух собирается вверху: у верхушки полоса шире, у купола — уже. Нет воздуха —
 * `undefined`.
 */
export function collapsedLung(f: XrayFindings): Pt[] | undefined {
  const air = airOf(f);
  if (!air) return undefined;
  const s = filmSide(air.side);
  const k = lungScale(air.size, air.tension);
  const c: Pt = [HILUM[s][0], domeY(s, f) - 0.02];
  return hemithorax(s, f).map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]);
}

/**
 * Смещение средостения — сердца и трахеи — в долях ширины: напряжённый пневмоторакс и
 * массивная кровь толкают его в здоровую сторону; иначе 0.
 */
export function mediastinalShift(f: XrayFindings): number {
  if (f.pneumothorax?.tension) return -filmSide(f.pneumothorax.side) * 0.06;
  if (f.effusion?.massive) return -filmSide(f.effusion.side) * 0.05;
  return 0;
}

/**
 * Верхняя граница крови в плевральной полости — точки от боковой стенки к средостению: у стенки
 * выше (жидкость поднимается по ней, «косая линия»), к середине ниже. Средняя — до угла лопатки,
 * массивная — выше; с воздухом над ней — ровный горизонтальный уровень. Нет крови — `undefined`.
 */
export function fluidTop(f: XrayFindings): Pt[] | undefined {
  const e = f.effusion;
  if (!e) return undefined;
  const s = filmSide(e.side);
  const top = e.massive ? 0.27 : domeY(s, f) - 0.11;
  const wall = mirror(0.08, s), med = mirror(0.5, s);
  const n = 24;
  return Array.from({ length: n + 1 }, (_, i): Pt => {
    const t = i / n;
    return [wall + (med - wall) * t, e.air ? top + 0.03 : top + (e.massive ? 0.1 : 0.06) * (1 - (1 - t) ** 2)];
  });
}

/** Ребро: высота заднего отрезка у позвоночника и насколько далеко вбок он уходит. */
export interface RibLayout {
  y0: number;
  reach: number;
}

/** Рёбра I–X: шаг по высоте (при эмфиземе межрёберья шире) и дрожь по зерну. */
export function ribLayout(seed: number, emph: boolean): RibLayout[] {
  const rng = Rng.seeded(seed).fork('ribs');
  const jitter = (amp: number) => ((rng.int(1000) / 1000) - 0.5) * 2 * amp;
  const step = emph ? 0.064 : 0.058;
  return Array.from({ length: 10 }, (_, i) => {
    const r = i + 1;
    const y0 = 0.105 + i * step + jitter(0.003);
    const reach = 0.19 + 0.2 * (1 - Math.exp(-r / 2.2)) + (emph ? 0.01 : 0) + jitter(0.004);
    return { y0, reach };
  });
}

/** Задний отрезок ребра: от позвоночника почти горизонтально, выгибается вверх и загибается по боковой стенке. */
export function ribBack(s: FilmSide, { y0, reach }: RibLayout): Pt[] {
  const x = (d: number) => 0.5 + s * d;
  return [
    ...bezier([x(0.038), y0], [x(0.13), y0 - 0.024], [x(reach - 0.04), y0 - 0.014], [x(reach), y0 + 0.04], 18),
    ...bezier([x(reach), y0 + 0.04], [x(reach + 0.01), y0 + 0.07], [x(reach + 0.005), y0 + 0.095], [x(reach - 0.008), y0 + 0.118], 8).slice(1),
  ];
}

/** Передний отрезок ребра (I–VII): от боковой стенки косо вниз к середине; `r` — номер ребра. */
export function ribFront(s: FilmSide, { y0, reach }: RibLayout, r: number): Pt[] {
  const x = (d: number) => 0.5 + s * d;
  return bezier([x(reach - 0.008), y0 + 0.118], [x(reach - 0.07), y0 + 0.135], [x(0.22), y0 + 0.2], [x(0.13 + r * 0.004), y0 + 0.235], 18);
}

/**
 * Место перелома на обзорном снимке — боковой отдел заднего отрезка, где ребро начинает
 * загибаться по стенке: точка на средней линии ребра и направление ребра в ней.
 */
export function ribFractureAt(s: FilmSide, rib: RibLayout): { at: Pt; dir: Pt } {
  const pts = ribBack(s, rib);
  const i = 15;
  const a = pts[i - 1], b = pts[i + 1];
  return { at: pts[i], dir: [b[0] - a[0], b[1] - a[1]] };
}

/**
 * Какие рёбра сломаны — одна функция зерна для обзорного снимка и снимка рёбер, чтобы на обоих
 * было одно и то же: одно — с IV по VIII, три — соседние.
 */
export function fracturedRibs(seed: number, multiple: boolean): number[] {
  const n = 4 + Rng.seeded(seed).fork('rib-fracture').int(5);
  return multiple ? [n - 1, n, n + 1] : [n];
}
