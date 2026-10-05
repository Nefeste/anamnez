// Срез груди на КТ-ангиографии (spec 2026-10-chapter-3, часть 43а; ADR 0013): геометрия — чистые
// функции в долях кадра, рисунок — chest.ts. Кадр квадратный; спереди — сверху, правая сторона
// пациента — слева на снимке, как на рентгене и срезе головы. Срез поперечный, на уровне деления
// лёгочного ствола: восходящая аорта, лёгочный ствол с правой и левой ветвями, верхняя полая вена,
// главные бронхи, пищевод, нисходящая аорта у позвоночника. Окно — средостенное: лёгкие чёрные,
// жир тёмно-серый, мышцы серые, контраст в артериях и кость — светлые.
//
// Рисовальщик болезней не знает: расслоение задано типом — где отслоённая интима делит просвет
// аорты надвое. Что какой признак значит на снимке, записывают признаки базы по источникам.
import { Rng } from '@/engine/core/rng';

export type Pt = [number, number];

export interface ChestCtFindings {
  /**
   * расслоение аорты: тип A — отслоённая интима в восходящей аорте и дальше в нисходящей, тип B —
   * только в нисходящей; расслоённая аорта шире
   */
  dissection?: 'a' | 'b';
}

/** Сосуд или бронх в поперечном срезе — круг. */
export interface Round {
  c: Pt;
  r: number;
}

/** Отслоённая интима: тонкая кривая поперёк просвета и ложный просвет по одну её сторону. */
export interface Flap {
  /** в каком сосуде */
  vessel: 'ascending' | 'descending';
  path: Pt[];
  /** ложный просвет — контур: кривая интимы и дуга стенки */
  falseLumen: Pt[];
}

export interface ChestGeometry {
  /** кожа — внешний контур тела */
  body: Pt[];
  /** под подкожным жиром — мышцы груди и спины */
  muscle: Pt[];
  /** внутренняя поверхность грудной стенки — граница грудной полости */
  wall: Pt[];
  /** лёгкие: правое (слева на снимке) и левое */
  lungs: [Pt[], Pt[]];
  /** сосуды в лёгких — точки и короткие веточки */
  lungVessels: Round[];
  /** грудина спереди, тело позвонка и позвоночный канал сзади, остистый отросток */
  sternum: { c: Pt; rx: number; ry: number };
  vertebra: Round;
  canal: Round;
  spinous: Pt[];
  /** рёбра в срезе — короткие светлые дуги у стенки */
  ribs: { c: Pt; rx: number; ry: number; angle: number }[];
  ascending: Round;
  descending: Round;
  trunk: Round;
  /** ветви лёгочного ствола: правая — позади восходящей аорты, левая — над левым бронхом */
  branches: { path: Pt[]; width: number }[];
  svc: Round;
  bronchi: [Round, Round];
  esophagus: Round;
  flaps: Flap[];
}

const CX = 0.5;
const CY = 0.5;
/** полуоси тела: поперёк и спереди назад; толщина жира и мышц — доли полуосей */
const A = 0.455;
const B = 0.335;

const at = (c: Pt, rx: number, ry: number, t: number): Pt => [c[0] + rx * Math.cos(t), c[1] + ry * Math.sin(t)];
const ellipse = (c: Pt, rx: number, ry: number, n = 120, wobble?: (t: number) => number): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const k = wobble ? wobble(t) : 1;
    return at(c, rx * k, ry * k, t);
  });

/** Точка внутри многоугольника (чётность пересечений). */
export function inside(p: Pt, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export const inRound = (p: Pt, o: Round) => Math.hypot(p[0] - o.c[0], p[1] - o.c[1]) < o.r;

/** Сгладить замкнутый многоугольник: Чайкин, два прохода — углы скругляются, форма та же. */
function smooth(pts: Pt[], passes = 2): Pt[] {
  let out = pts;
  for (let k = 0; k < passes; k++) {
    const next: Pt[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out = next;
  }
  return out;
}

/**
 * Лёгкое правой стороны пациента (слева на снимке): снаружи — по стенке, изнутри — по средостению.
 * Средостение у грудины узкое, у корня — шире (бронх и ветвь лёгочной артерии), сзади огибает
 * позвоночник. Левое — зеркально, сзади его вдавливает нисходящая аорта.
 */
function lung(side: 'right' | 'left', wallRx: number, wallRy: number, aorta: Round, back: (t: number) => number): Pt[] {
  const s = side === 'right' ? -1 : 1;
  // угол на снимке: 0 — вправо, π/2 — вниз (к спине); правое лёгкое — по левому краю снимка
  const deg = Math.PI / 180;
  const pts: Pt[] = [];
  for (let i = 0; i <= 40; i++) {
    const phi = (8 + (i / 40) * 164) * deg; // от грудины (8°) до позвоночника (172°)
    const t = s === -1 ? 1.5 * Math.PI - phi : -0.5 * Math.PI + phi;
    // сзади стенка плоская — лёгкое тоже
    pts.push(at([CX, CY], wallRx * 0.99 * back(t), wallRy * 0.985 * back(t), t));
  }
  // средостение — от позвоночника вверх к грудине: смещение от середины и высота. Справа его край — у
  // верхней полой вены и восходящей аорты, слева — у лёгочного ствола и левой ветви
  const medial: Pt[] = s === -1
    ? [[0.07, 0.715], [0.09, 0.66], [0.112, 0.6], [0.13, 0.55], [0.15, 0.49], [0.178, 0.43], [0.172, 0.37], [0.12, 0.31], [0.05, 0.262]]
    : [[0.07, 0.715], [0.09, 0.66], [0.11, 0.6], [0.135, 0.55], [0.145, 0.49], [0.14, 0.43], [0.132, 0.37], [0.09, 0.31], [0.04, 0.262]];
  for (const [dx, y] of medial) {
    let x = CX + s * dx;
    // слева нисходящая аорта у позвоночника вдавливает лёгкое
    if (s === 1) {
      const d = y - aorta.c[1];
      const reach = aorta.r * 1.5;
      if (Math.abs(d) < reach) x = Math.max(x, aorta.c[0] + Math.sqrt(reach * reach - d * d));
    }
    pts.push([x, y]);
  }
  return smooth(pts);
}

/**
 * Отслоённая интима в аорте: дуга поперёк просвета — от стенки до стенки, чуть выгнутая; ложный
 * просвет — по выпуклую сторону, обычно больше истинного. Поворот — от зерна.
 */
function flap(vessel: Flap['vessel'], o: Round, turn: number): Flap {
  const a0 = turn, a1 = turn + Math.PI * 0.86;
  const p0 = at(o.c, o.r * 0.94, o.r * 0.94, a0);
  const p1 = at(o.c, o.r * 0.94, o.r * 0.94, a1);
  const mid: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  // выгнута к центру: середина хорды смещается к центру сосуда и за него
  const bow: Pt = [mid[0] + (o.c[0] - mid[0]) * 1.5, mid[1] + (o.c[1] - mid[1]) * 1.5];
  const path: Pt[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, u = 1 - t;
    path.push([u * u * p0[0] + 2 * u * t * bow[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * bow[1] + t * t * p1[1]]);
  }
  // ложный просвет — от конца интимы по стенке назад к её началу, по большей дуге
  const arc: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = a1 + (i / 24) * (2 * Math.PI - (a1 - a0));
    arc.push(at(o.c, o.r * 0.97, o.r * 0.97, t));
  }
  return { vessel, path, falseLumen: [...path, ...arc] };
}

/** Срез груди: вся геометрия в долях кадра. Анатомия одна и та же, от зерна — мелочи и поворот интимы. */
export function chestGeometry(findings: ChestCtFindings, seed: number): ChestGeometry {
  const rng = Rng.seeded(seed).fork('chest-ct');
  const u = () => rng.u32() / 4294967296;
  const type = findings.dissection === 'a' || findings.dissection === 'b' ? findings.dissection : undefined;

  // тело чуть шире или уже, спина плоская
  const k = 0.97 + 0.06 * u();
  const flatBack = (t: number) => (Math.sin(t) > 0 ? 1 - 0.07 * Math.sin(t) ** 3 : 1);
  const body = ellipse([CX, CY], A * k, B * k, 160, flatBack);
  const muscle = ellipse([CX, CY], A * k * 0.9, B * k * 0.87, 160, flatBack);
  const wallRx = A * k * 0.84, wallRy = B * k * 0.8;
  const wall = ellipse([CX, CY], wallRx, wallRy, 160, flatBack);

  // расслоённая аорта шире: восходящая — при типе A, нисходящая — при обоих
  const ascending: Round = { c: [0.452 + 0.006 * (u() - 0.5), 0.42], r: type === 'a' ? 0.068 : 0.053 };
  const descending: Round = { c: [0.598, 0.598], r: type ? 0.05 : 0.04 };
  const trunk: Round = { c: [0.57, 0.39], r: 0.046 };
  const svc: Round = { c: [0.36, 0.39], r: 0.024 };
  const bronchi: [Round, Round] = [{ c: [0.465, 0.515], r: 0.019 }, { c: [0.54, 0.52], r: 0.018 }];
  const esophagus: Round = { c: [0.515, 0.565], r: 0.013 };
  const branches = [
    // правая ветвь — от ствола вправо (на снимке влево), позади восходящей аорты, над правым бронхом
    { path: [[0.55, 0.425], [0.5, 0.475], [0.44, 0.49], [0.385, 0.495]] as Pt[], width: 0.04 },
    // левая — назад и влево (на снимке вправо), над левым бронхом
    { path: [[0.585, 0.41], [0.615, 0.455], [0.632, 0.5]] as Pt[], width: 0.043 },
  ];

  const lungs: [Pt[], Pt[]] = [lung('right', wallRx, wallRy, descending, flatBack), lung('left', wallRx, wallRy, descending, flatBack)];
  // сосуды в лёгких — мелкие точки, гуще у корня
  const lungVessels: Round[] = [];
  for (const poly of lungs) {
    for (let n = 0, guard = 0; n < 26 && guard < 400; guard++) {
      const p: Pt = [0.1 + 0.8 * u(), 0.2 + 0.6 * u()];
      if (!inside(p, poly)) continue;
      const toRoot = Math.hypot(p[0] - CX, p[1] - 0.5);
      lungVessels.push({ c: p, r: 0.003 + 0.006 * u() * Math.max(0.3, 1 - toRoot / 0.4) });
      n++;
    }
  }

  // рёбра — по стенке с каждой стороны, от грудины к позвоночнику; дуга — по касательной к стенке
  const ribs: ChestGeometry['ribs'] = [];
  for (const s of [-1, 1] as const) {
    for (const phi of [30, 55, 80, 105, 130, 155]) {
      const t = s === -1 ? 1.5 * Math.PI - (phi * Math.PI) / 180 : -0.5 * Math.PI + (phi * Math.PI) / 180;
      ribs.push({ c: at([CX, CY], wallRx * 1.05, wallRy * 1.07, t), rx: 0.026, ry: 0.011, angle: t + Math.PI / 2 });
    }
  }

  const flaps: Flap[] = [];
  if (type === 'a') flaps.push(flap('ascending', ascending, 2 * Math.PI * u()));
  if (type) flaps.push(flap('descending', descending, 2 * Math.PI * u()));

  return {
    body, muscle, wall, lungs, lungVessels,
    sternum: { c: [CX, CY - wallRy * 1.02], rx: 0.04, ry: 0.016 },
    vertebra: { c: [CX, 0.655], r: 0.056 },
    canal: { c: [CX, 0.732], r: 0.021 },
    spinous: [[CX - 0.011, 0.755], [CX + 0.011, 0.755], [CX + 0.007, 0.79], [CX - 0.007, 0.79]],
    ribs, ascending, descending, trunk, branches, svc, bronchi, esophagus, flaps,
  };
}
