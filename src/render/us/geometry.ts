// Сектор УЗИ (ADR 0013, spec 2026-09-ct-mri-ultrasound, часть 21): геометрия — чистые функции
// в долях кадра, рисунок — sector.ts. Кадр квадратный; датчик — сверху, выпуклый, как для
// живота: лучи расходятся веером от мнимой вершины над кадром, поэтому сверху — широкая дуга.
// Глубина — вниз. Три вида: печень с желчным пузырём, почка под печенью и правая подвздошная
// область с петлями кишки — там ищут червеобразный отросток (spec 2026-09-chapter-2, часть 29).
//
// Рисовальщик болезней не знает: светлые точки с тенью, расширенная тёмная середина почки и
// полоса жидкости заданы параметрами. Что они значат, запишут признаки базы по источникам.
import { Rng } from '@/engine/core/rng';

export type Pt = [number, number];

export interface UsFindings {
  view: 'gallbladder' | 'kidney' | 'appendix';
  /** светлые точки у нижней стенки пузыря, за каждой — тень: сколько (0–5) и насколько крупные (0–1) */
  foci?: { count: number; size: number };
  /** 0–1: тёмная середина почки — лоханка с чашечками — расширена */
  pelvis?: number;
  /** 0–1: тёмная полоса жидкости у органа — толщина */
  fluid?: number;
  /** 0–1: стенка желчного пузыря утолщена — яркая, с тёмной полоской отёка посередине («двойной контур», часть 30) */
  wall?: number;
  /**
   * 0–1: в поперечнике виден отросток — «мишень»: слоистая стенка вокруг тёмной середины, вокруг —
   * светлый отёчный жир. 0 — отростка не видно, как обычно у здорового
   */
  appendix?: number;
}

/** Сектор: мнимая вершина над кадром, полураствор (радианы от вертикали), радиус дуги датчика и конца. */
export const APEX: Pt = [0.5, -0.26];
export const HALF = 0.4;
export const R0 = 0.3;
export const R1 = 1.21;
/** Точка на глубине `d` под кожей по лучу `a`. */
function at(a: number, d: number): Pt {
  return ray(a, R0 + d);
}

/** Точка луча: угол от вертикали (вправо — плюс) и глубина от вершины. */
export const ray = (a: number, r: number): Pt => [APEX[0] + r * Math.sin(a), APEX[1] + r * Math.cos(a)];
/** Угол луча и глубина точки. */
export const polar = ([x, y]: Pt): { a: number; r: number } => ({ a: Math.atan2(x - APEX[0], y - APEX[1]), r: Math.hypot(x - APEX[0], y - APEX[1]) });
export const inSector = (p: Pt): boolean => {
  const { a, r } = polar(p);
  return Math.abs(a) <= HALF + 1e-9 && r >= R0 - 1e-9 && r <= R1 + 1e-9;
};

/** Контур сектора: дуга сверху, два края, дуга снизу. */
export function sectorOutline(n = 48): Pt[] {
  const top = Array.from({ length: n + 1 }, (_, i) => ray(-HALF + (2 * HALF * i) / n, R0));
  const bottom = Array.from({ length: n + 1 }, (_, i) => ray(HALF - (2 * HALF * i) / n, R1));
  return [...top, ...bottom];
}

/** Эллипс: центр, полуоси, поворот. */
function ellipse(c: Pt, rx: number, ry: number, rot: number, n = 64, wobble?: (t: number) => number): Pt[] {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const k = wobble ? wobble(t) : 1;
    const x = rx * k * Math.cos(t), y = ry * k * Math.sin(t);
    return [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs] as Pt;
  });
}

const clamp01 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? 0 : Math.min(1, Math.max(0, x)));

export interface UsGeometry {
  view: UsFindings['view'];
  /** контур сектора */
  sector: Pt[];
  /** кожа и подкожный слой, мышцы стенки — границы по глубине */
  skin: number;
  wall: number;
  /** печень — всё под стенкой (вид пузыря) или до нижнего края печени (вид почки) */
  liverBottom?: Pt[];
  /** жёлчный пузырь: полость и стенка — один контур */
  gallbladder?: Pt[];
  /** утолщённая стенка пузыря: наружный контур и середина стенки — полоска отёка */
  gbWall?: [Pt[], Pt[]];
  /** светлые точки и тень за каждой — по лучам от вершины до конца сектора */
  foci: { c: Pt; r: number; shadow: Pt[] }[];
  /** усиление за пузырём — светлее по лучам под ним */
  enhancement?: Pt[];
  /** почка: контур, светлый центр (синус), тёмная расширенная середина — лоханка и чашечки по частям */
  kidney?: Pt[];
  sinus?: Pt[];
  /** пирамиды — тёмные треугольники между корой и синусом, вершиной к синусу */
  pyramids?: Pt[][];
  pelvis?: Pt[];
  pelvisParts?: Pt[][];
  /** полоса жидкости у органа */
  fluid?: Pt[];
  /** подвздошная область: петли кишки — стенка и яркий газ сверху, под газом — грязная тень */
  loops?: { wall: Pt[]; gas: Pt[]; shadow: Pt[] }[];
  /** подвздошные артерия и вена — тёмные круги в глубине */
  vessels?: { c: Pt; r: number }[];
  /** отросток в поперечнике: кольца снаружи внутрь — серозная оболочка, мышечный слой, подслизистый, просвет */
  target?: Pt[][];
  /** светлый отёчный жир вокруг отростка */
  halo?: Pt[];
}

/** Тень за точкой: лучи от вершины через края точки — от точки до конца сектора. */
function shadowOf(c: Pt, r: number): Pt[] {
  const p = polar(c);
  const da = Math.asin(Math.min(0.99, r / p.r));
  const near = p.r + r * 0.4;
  return [ray(p.a - da, near), ray(p.a - da, R1), ray(p.a + da, R1), ray(p.a + da, near)];
}

/** Вид УЗИ: вся геометрия в долях кадра. Анатомия одна и та же; от зерна — лёгкая неровность контуров. */
export function usGeometry(f: UsFindings, seed: number): UsGeometry {
  const rng = Rng.seeded(seed).fork('us');
  const u = () => rng.int(1000) / 1000;
  const skin = R0 + 0.045, wall = R0 + 0.11;
  const base: UsGeometry = { view: f.view, sector: sectorOutline(), skin, wall, foci: [] };

  if (f.view === 'gallbladder') {
    // пузырь — груша под углом, в середине сектора, на средней глубине
    const c = at(0.05, 0.4);
    const p1 = u() * 6.28;
    const gb = ellipse(c, 0.165, 0.075, -0.2, 72, t => 1 + 0.05 * Math.sin(2 * t + p1) + 0.06 * Math.cos(t));
    const count = Math.round(Math.min(5, Math.max(0, f.foci?.count ?? 0)));
    const size = clamp01(f.foci?.size);
    const foci: UsGeometry['foci'] = [];
    // у нижней (дальней от датчика) стенки, вплотную друг к другу — в самой нижней части
    const lower = gb.filter(p => polar(p).r > polar(c).r).sort((p, q) => polar(p).a - polar(q).a);
    const deepest = lower.reduce((best, p, i) => (polar(p).r > polar(lower[best]).r ? i : best), 0);
    const r = 0.013 + 0.017 * size;
    // соседние точки — на диаметр друг от друга вдоль стенки
    const spacing = lower.length > 1 ? Math.hypot(lower[1][0] - lower[0][0], lower[1][1] - lower[0][1]) : 1;
    const step = Math.max(1, Math.round((2 * r) / spacing));
    for (let i = 0; i < count; i++) {
      const idx = Math.min(lower.length - 1, Math.max(0, Math.round(deepest + (i - (count - 1) / 2) * step)));
      const wallPt = lower[idx];
      // внутрь от стенки на свой радиус — к датчику
      const toward = polar(wallPt);
      const fc = ray(toward.a, toward.r - r * 1.15);
      foci.push({ c: fc, r, shadow: shadowOf(fc, r) });
    }
    const angles = gb.map(p => polar(p).a);
    const aMin = Math.min(...angles), aMax = Math.max(...angles);
    const far = Math.max(...gb.map(p => polar(p).r));
    const enhancement: Pt[] = [ray(aMin + 0.02, far - 0.02), ray(aMin + 0.02, R1), ray(aMax - 0.02, R1), ray(aMax - 0.02, far - 0.02)];
    const fluid = clamp01(f.fluid);
    const out: UsGeometry = { ...base, gallbladder: gb, foci, enhancement };
    const thick = clamp01(f.wall);
    // стенка утолщена: наружный контур шире полости, посередине стенки — тёмная полоска отёка
    const k = 1.1 + 0.16 * thick;
    const around = (m: number) => gb.map(p => [c[0] + (p[0] - c[0]) * m, c[1] + (p[1] - c[1]) * m] as Pt);
    if (thick > 0) out.gbWall = [around(k), around((1 + k) / 2)];
    if (fluid > 0) {
      // тёмная полоса вдоль нижней стенки пузыря, снаружи (снаружи утолщённой стенки, если она есть)
      const lower0 = thick > 0 ? around(k).filter(p => polar(p).r > polar(c).r).sort((p, q) => polar(p).a - polar(q).a) : lower;
      const w = 0.006 + 0.03 * fluid;
      const band = lower0.map(p => {
        const q = polar(p);
        return [ray(q.a, q.r + 0.004), ray(q.a, q.r + 0.004 + w)] as const;
      });
      out.fluid = [...band.map(b => b[0]), ...band.map(b => b[1]).reverse()];
    }
    return out;
  }

  if (f.view === 'appendix') {
    // петли кишки справа, слева и в глубине: овал стенки, газ — яркая дуга у ближней к датчику стенки
    const loops: NonNullable<UsGeometry['loops']> = [];
    for (const [a, d, rx, ry, rot] of [[-0.25, 0.34, 0.1, 0.05, 0.3], [0.27, 0.4, 0.09, 0.05, -0.35], [-0.08, 0.74, 0.14, 0.055, 0.05]] as const) {
      const c = at(a, d);
      const ph = u() * 6.28;
      const wall = ellipse(c, rx, ry, rot, 56, t => 1 + 0.06 * Math.sin(3 * t + ph));
      const near = wall.filter(p => polar(p).r < polar(c).r).sort((p, q) => polar(p).a - polar(q).a);
      const gas = near.slice(Math.floor(near.length * 0.2), Math.ceil(near.length * 0.8));
      const pa = polar(gas[0]), pb = polar(gas[gas.length - 1]);
      loops.push({ wall, gas, shadow: [ray(pa.a, pa.r + 0.01), ray(pa.a, R1), ray(pb.a, R1), ray(pb.a, pb.r + 0.01)] });
    }
    const vessels = [{ c: at(0.13, 0.86), r: 0.028 }, { c: at(0.22, 0.88), r: 0.038 }];
    const out: UsGeometry = { ...base, loops, vessels };
    const t = clamp01(f.appendix);
    if (t > 0) {
      // «мишень» посередине сектора: наружный радиус растёт с толщиной, слои — доли радиуса
      const c = at(0.02, 0.5);
      const R = 0.03 + 0.045 * t;
      const ph = u() * 6.28;
      const ring = (k: number) => ellipse(c, R * k, R * k * 0.92, 0.2, 48, x => 1 + 0.03 * Math.sin(2 * x + ph));
      out.target = [ring(1), ring(0.9), ring(0.62), ring(0.34)];
      out.halo = ellipse(c, R * (1.7 + 0.5 * t), R * (1.45 + 0.4 * t), 0.2, 48, x => 1 + 0.08 * Math.sin(3 * x + ph));
      const fluid = clamp01(f.fluid);
      if (fluid > 0) {
        // тёмный серп жидкости под отростком — дальше от датчика
        const far = ellipse(c, R * (1.25 + 0.6 * fluid), R * (1.1 + 0.5 * fluid), 0.2, 48).filter(p => polar(p).r > polar(c).r + R * 0.4);
        const inner = far.map(p => {
          const q = polar(p);
          return ray(q.a, q.r - 0.008 - 0.02 * fluid);
        });
        out.fluid = [...far, ...inner.reverse()];
      }
    }
    return out;
  }

  // почка под печенью: вытянутый боб, ворота снизу; нижний край печени — дуга над почкой
  const kc = at(-0.03, 0.5);
  const kp = u() * 6.28;
  const kidney = ellipse(kc, 0.22, 0.085, 0.1, 80, t => 1 + 0.03 * Math.sin(3 * t + kp) - 0.12 * Math.max(0, Math.sin(t)) ** 8);
  const sinus = ellipse(kc, 0.12, 0.028, 0.1, 48, t => 1 + 0.09 * Math.sin(5 * t + kp));
  const fluid = clamp01(f.fluid);
  const gap = 0.012 + 0.035 * fluid;
  // нижний край печени — над верхним краем почки на ширину щели
  const top = kidney.filter(p => p[1] < kc[1]).sort((p, q) => p[0] - q[0]);
  const liverBottom: Pt[] = top.map(([x, y]) => [x, y - gap]);
  // пирамиды: по четыре над синусом и три под ним, основанием к коре
  const rot = 0.1, cs = Math.cos(rot), sn = Math.sin(rot);
  const local = (x: number, y: number): Pt => [kc[0] + x * cs - y * sn, kc[1] + x * sn + y * cs];
  const pyramids: Pt[][] = [];
  for (const [x, side] of [[-0.13, -1], [-0.05, -1], [0.04, -1], [0.12, -1], [-0.09, 1], [0.0, 1], [0.09, 1]] as const) {
    const tipY = side * 0.03, baseY = side * 0.062, half = 0.022 * (1 - Math.abs(x) * 1.8);
    pyramids.push([local(x, tipY), local(x - half, baseY), local(x + half, baseY)]);
  }
  const out: UsGeometry = { ...base, liverBottom, kidney, sinus, pyramids };
  if (fluid > 0) out.fluid = [...top.map(([x, y]) => [x, y - gap + 0.003] as Pt), ...top.map(([x, y]) => [x, y - 0.002] as Pt).reverse()];
  const p = clamp01(f.pelvis);
  if (p > 0) {
    // лоханка — тёмный овал посередине; чашечки — округлые, на шейках к коре — на месте пирамид
    const shapes: Pt[][] = [ellipse(kc, 0.035 + 0.05 * p, 0.012 + 0.018 * p, rot, 40)];
    const cups: [number, number][] = [[-0.13, -0.04], [-0.05, -0.046], [0.04, -0.047], [0.12, -0.04], [-0.09, 0.04], [0.0, 0.044], [0.09, 0.04]];
    const cupR = 0.012 + 0.018 * p;
    for (const [x, y] of cups) {
      // внутри почки, с корой не тоньше 0,01: у полюсов почка ниже, у ворот — вдавлена
      const hh = 0.085 * 0.85 * Math.sqrt(Math.max(0, 1 - (x / 0.22) ** 2));
      const cy = Math.sign(y) * Math.min(Math.abs(y) * (0.8 + 0.2 * p), Math.max(0, hh - cupR - 0.01));
      const cup = local(x * (0.85 + 0.15 * p), cy);
      shapes.push(ellipse(cup, cupR, cupR * 0.85, rot, 24));
      // шейка — узкий многоугольник от лоханки к чашечке
      const from = local(x * 0.3, y * 0.2);
      const dx = cup[0] - from[0], dy = cup[1] - from[1], l = Math.hypot(dx, dy) || 1;
      const w = (0.005 + 0.009 * p) / l;
      shapes.push([[from[0] - dy * w, from[1] + dx * w], [cup[0] - dy * w, cup[1] + dx * w], [cup[0] + dy * w, cup[1] - dx * w], [from[0] + dy * w, from[1] - dx * w]]);
    }
    out.pelvis = shapes.flat();
    out.pelvisParts = shapes;
  }
  return out;
}
