// ЭГДС кодом (ADR 0013, spec 2026-10-chapter-4, часть 53а-2): геометрия — чистые функции в долях кадра, рисунок —
// view.ts. Кадр квадратный, поле зрения эндоскопа — круг. Два вида: желудок — антральный отдел, вдали тёмный просвет
// привратника и складки к нему; кардия — переход пищевода в желудок сверху: посередине просвет, вокруг — зубчатая
// линия, снаружи от неё бледная слизистая пищевода с продольными складками, внутри — красноватая слизистая желудка.
//
// Рисовальщик болезней не знает: язва и то, что в её дне, продольный разрыв и кровь заданы параметрами. Что они значат,
// запишут признаки базы по источникам: дно язвы по Форресту — `277_2`, приложение Г5.
import { Rng } from '@/engine/core/rng';

export type Pt = [number, number];

export interface Round {
  c: Pt;
  r: number;
}

/** Что в дне язвы: чистое дно, плоские тёмные пятна, сосуд, сгусток, идущая кровь. */
export type UlcerBase = 'clean' | 'spots' | 'vessel' | 'clot' | 'bleeding';

export interface EgdFindings {
  /** язва и что в её дне; `size` — 0–1, доля наибольшей */
  ulcer?: { base: UlcerBase; size: number };
  /** продольный разрыв слизистой там, где пищевод переходит в желудок; идёт ли из него кровь; `size` — 0–1 */
  tear?: { bleeding: boolean; size: number };
  /** кровь в просвете, а источника не видно */
  blood?: boolean;
  /** гастрит (часть 53б): диффузное покраснение и отёк слизистой — по Киотской характеристике, при H. pylori */
  gastritis?: boolean;
}

export interface EgdGeometry {
  view: 'stomach' | 'cardia';
  /** поле зрения эндоскопа */
  field: Round;
  /** середина освещённого пятна: свет — от торца эндоскопа */
  light: Pt;
  /** просвет вдали — тёмное отверстие */
  lumen: Round & { outline: Pt[] };
  /** складки: гребень, тень — от света */
  folds: { ridge: Pt[]; width: number }[];
  /** кардия: зубчатая линия — граница пищевода и желудка; внутри неё — слизистая желудка */
  zline?: Pt[];
  /** блики на влажной слизистой */
  glints: { c: Pt; rx: number; ry: number; angle: number }[];
  /** язва: кратер, отёчный валик вокруг и то, что в дне */
  ulcer?: Round & { outline: Pt[]; halo: Pt[]; base: UlcerBase; spots: Round[]; vessel?: Round; clot?: Pt[] };
  /** разрыв: веретено поперёк зубчатой линии, ось — от просвета наружу */
  tear?: { outline: Pt[]; axis: [Pt, Pt]; width: number; bleeding: boolean };
  /** кровь: лужица у источника и струйки — вниз по стенке или в просвет; `tip` — ширина в конце пути, доля начальной */
  blood?: { pool: Pt[]; streams: { path: Pt[]; width: number; tip: number }[] };
  /** гастрит: пятна покраснения по стенке, не в просвете */
  erythema?: Round[];
}

export const FIELD: Round = { c: [0.5, 0.5], r: 0.47 };
const TAU = 2 * Math.PI;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Точка внутри многоугольника (по чётности пересечений). */
export function inside(p: Pt, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Неровный овал: полуоси `a` и `b`, поворот `rot`, неровность края — доля радиуса. */
function blob(rng: Rng, c: Pt, a: number, b: number, rot: number, rough: number, n = 28): Pt[] {
  const u = () => rng.int(1000) / 1000;
  const phase = [u() * TAU, u() * TAU];
  const amp = [rough * (0.5 + u() * 0.5), rough * (0.3 + u() * 0.4)];
  const cr = Math.cos(rot), sr = Math.sin(rot);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * TAU;
    const k = 1 + amp[0] * Math.sin(3 * t + phase[0]) + amp[1] * Math.sin(5 * t + phase[1]);
    const x = a * k * Math.cos(t), y = b * k * Math.sin(t);
    return [c[0] + x * cr - y * sr, c[1] + x * sr + y * cr];
  });
}

/** Точки кривой Безье второго порядка. */
function bezier(a: Pt, ctrl: Pt, b: Pt, n = 16): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, s = 1 - t;
    return [s * s * a[0] + 2 * s * t * ctrl[0] + t * t * b[0], s * s * a[1] + 2 * s * t * ctrl[1] + t * t * b[1]];
  });
}

/** Струйка крови: от точки к цели с лёгким изгибом; к концу сужается до `tip` начальной ширины. */
function stream(rng: Rng, from: Pt, to: Pt, width: number, tip: number): { path: Pt[]; width: number; tip: number } {
  const u = () => rng.int(1000) / 1000;
  const wiggle = (u() - 0.5) * 0.06;
  const mid: Pt = [(from[0] + to[0]) / 2 + wiggle, (from[1] + to[1]) / 2];
  return { path: bezier(from, mid, to, 20), width, tip };
}

/** Конец струйки вниз: до края поля зрения, не дальше `reach`. */
function downTo(from: Pt, reach: number, dx: number): Pt {
  const x = from[0] + dx;
  const dy = Math.sqrt(Math.max(0, (FIELD.r * 0.93) ** 2 - (x - FIELD.c[0]) ** 2));
  return [x, Math.min(FIELD.c[1] + dy, from[1] + reach)];
}

export function egdGeometry(findings: EgdFindings, seed: number): EgdGeometry {
  const rng = Rng.seeded(seed).fork('egd');
  const u = () => rng.int(1000) / 1000;
  // разрыв — у перехода пищевода в желудок: смотрят на кардию; иначе — желудок
  const view: EgdGeometry['view'] = findings.tear ? 'cardia' : 'stomach';
  const field = FIELD;

  // просвет: в желудке — привратник вдали, выше середины; в кардии — посередине
  const lc: Pt = view === 'stomach' ? [0.5 + (u() - 0.5) * 0.12, 0.34 + u() * 0.06] : [0.5 + (u() - 0.5) * 0.05, 0.5 + (u() - 0.5) * 0.05];
  const lr = view === 'stomach' ? 0.06 + u() * 0.025 : 0.085 + u() * 0.02;
  const lumen = { c: lc, r: lr, outline: blob(rng.fork('lumen'), lc, lr * 1.15, lr * 0.9, u() * Math.PI, 0.12) };
  const light: Pt = view === 'stomach' ? [0.5, 0.58] : [0.5, 0.56];
  const zr0 = view === 'cardia' ? 0.2 + u() * 0.03 : 0;

  // складки: в желудке — к привратнику, изогнутые; в кардии — продольные складки пищевода к просвету
  const folds: EgdGeometry['folds'] = [];
  const nFolds = view === 'stomach' ? 5 + rng.int(2) : 9 + rng.int(3);
  const t0 = u() * TAU;
  for (let i = 0; i < nFolds; i++) {
    const t = t0 + (i / nFolds) * TAU + (u() - 0.5) * 0.4;
    const bend = (u() - 0.5) * (view === 'stomach' ? 1.4 : 0.2);
    const from = view === 'stomach' ? lr * (1.7 + u() * 0.8) : zr0 + 0.03;
    const reach = field.r * (view === 'stomach' ? 0.7 + u() * 0.3 : 1);
    const start: Pt = [lc[0] + Math.cos(t) * from, lc[1] + Math.sin(t) * from];
    const end: Pt = [field.c[0] + Math.cos(t + bend * 0.3) * reach, field.c[1] + Math.sin(t + bend * 0.3) * reach];
    const m: Pt = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const len = dist(start, end);
    const ctrl: Pt = [m[0] - Math.sin(t) * bend * len * 0.4, m[1] + Math.cos(t) * bend * len * 0.4];
    folds.push({ ridge: bezier(start, ctrl, end, 20), width: (view === 'stomach' ? 0.03 : 0.012) + u() * (view === 'stomach' ? 0.02 : 0.006) });
  }

  // зубчатая линия кардии: неровное кольцо с «языками» слизистой желудка наружу
  let zline: Pt[] | undefined;
  const zr = zr0;
  if (view === 'cardia') {
    const zrng = rng.fork('zline');
    const n = 48;
    zline = Array.from({ length: n }, (_, i) => {
      const t = (i / n) * TAU;
      const tongue = zrng.int(1000) < 220 ? 0.03 + zrng.int(1000) / 1000 * 0.025 : 0;
      const r = zr + (zrng.int(1000) / 1000 - 0.5) * 0.02 + tongue;
      return [lc[0] + r * Math.cos(t), lc[1] + r * Math.sin(t)];
    });
  }

  // язва: на стенке ниже привратника, не у края поля и не у просвета
  let ulcer: EgdGeometry['ulcer'];
  if (findings.ulcer && view === 'stomach') {
    const urng = rng.fork('ulcer');
    const uu = () => urng.int(1000) / 1000;
    const size = clamp01(findings.ulcer.size);
    const r = 0.05 + 0.055 * size;
    let c: Pt = [0.5, 0.66];
    for (let k = 0; k < 24; k++) {
      const t = Math.PI * (0.2 + 0.6 * uu());
      const d = 0.12 + uu() * 0.12;
      const p: Pt = [field.c[0] + d * Math.cos(t), field.c[1] + d * Math.sin(t)];
      if (dist(p, field.c) + r * 1.5 < field.r * 0.9 && dist(p, lc) > lr + r * 1.6 + 0.03) {
        c = p;
        break;
      }
    }
    const rot = uu() * Math.PI;
    const outline = blob(urng.fork('crater'), c, r * 1.12, r * 0.86, rot, 0.07);
    const halo = blob(urng.fork('halo'), c, r * 1.12 * 1.5, r * 0.86 * 1.5, rot, 0.06);
    const base = findings.ulcer.base;
    const spots: Round[] = [];
    if (base === 'spots') {
      const n = 3 + urng.int(3);
      for (let i = 0; i < n; i++) {
        const t = uu() * TAU, d = uu() * r * 0.55;
        spots.push({ c: [c[0] + d * Math.cos(t), c[1] + d * 0.8 * Math.sin(t)], r: r * (0.08 + uu() * 0.06) });
      }
    }
    // сосуд — бугорок в дне; сгусток — тёмный комок, прикрывший часть дна; кровь идёт — из сосуда в дне
    const near = (k: number): Pt => {
      const t = uu() * TAU, d = uu() * r * k;
      return [c[0] + d * Math.cos(t), c[1] + d * 0.8 * Math.sin(t)];
    };
    const vessel = base === 'vessel' || base === 'bleeding' ? { c: near(0.3), r: r * (0.17 + uu() * 0.05) } : undefined;
    const clot = base === 'clot' ? blob(urng.fork('clot'), near(0.25), r * (0.5 + uu() * 0.12), r * (0.42 + uu() * 0.1), uu() * Math.PI, 0.16, 20) : undefined;
    ulcer = { c, r, outline, halo, base, spots, ...(vessel ? { vessel } : {}), ...(clot ? { clot } : {}) };
  }

  // разрыв: веретено вдоль продольной оси — от зубчатой линии внутрь к просвету и наружу по пищеводу
  let tear: EgdGeometry['tear'];
  if (findings.tear && view === 'cardia') {
    const trng = rng.fork('tear');
    const size = clamp01(findings.tear.size);
    // чаще — по малой кривизне, справа сзади; на снимке — сбоку и снизу
    const t = Math.PI * (0.15 + 0.7 * (trng.int(1000) / 1000));
    const inner = Math.max(lr * 1.45, zr - 0.08);
    const outer = zr + 0.1 + 0.1 * size;
    const a: Pt = [lc[0] + inner * Math.cos(t), lc[1] + inner * Math.sin(t)];
    const b: Pt = [lc[0] + outer * Math.cos(t), lc[1] + outer * Math.sin(t)];
    const width = 0.018 + 0.012 * size;
    const n = 18;
    const side = (sign: number) => Array.from({ length: n + 1 }, (_, i) => {
      const s = i / n;
      const w = width * Math.sin(Math.PI * s) ** 0.7 * (1 + (trng.int(1000) / 1000 - 0.5) * 0.45);
      const along: Pt = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
      return [along[0] - Math.sin(t) * w * sign, along[1] + Math.cos(t) * w * sign] as Pt;
    });
    const outline = [...side(1), ...side(-1).reverse().slice(1, -1)];
    tear = { outline, axis: [a, b], width, bleeding: findings.tear.bleeding };
  }

  // кровь: из идущей кровью язвы — лужица в дне и струйки вниз по стенке; из разрыва — в просвет; источника не
  // видно — озерцо внизу поля
  let blood: EgdGeometry['blood'];
  const brng = rng.fork('blood');
  const bu = () => brng.int(1000) / 1000;
  if (ulcer && ulcer.base === 'bleeding') {
    const from = ulcer.vessel!.c;
    const pool = blob(brng.fork('pool'), [from[0] * 0.5 + ulcer.c[0] * 0.5, from[1] * 0.4 + (ulcer.c[1] + ulcer.r * 0.45) * 0.6], ulcer.r * 0.75, ulcer.r * 0.62, 0, 0.22, 24);
    // главная струйка — широкая, почти не сужается; вторая, если есть, — тонкая
    const streams = Array.from({ length: 1 + brng.int(2) }, (_, i) => {
      const start: Pt = [from[0] + (bu() - 0.5) * ulcer!.r * 0.6, ulcer!.c[1] + ulcer!.r * 0.75];
      const end = downTo(start, 0.13 + bu() * 0.1, (bu() - 0.5) * 0.05);
      return i === 0 ? stream(brng.fork(`s${i}`), start, end, 0.034 + bu() * 0.014, 0.7) : stream(brng.fork(`s${i}`), start, end, 0.014 + bu() * 0.008, 0.35);
    });
    blood = { pool, streams };
  } else if (tear && tear.bleeding) {
    const [a] = tear.axis;
    const pool = blob(brng.fork('pool'), [a[0] * 0.85 + lc[0] * 0.15, a[1] * 0.85 + lc[1] * 0.15], tear.width * 1.1, tear.width * 0.85, 0, 0.25, 22);
    const streams = [stream(brng.fork('s0'), [a[0], a[1]], [lc[0] + (bu() - 0.5) * lr * 0.6, lc[1] + (bu() - 0.5) * lr * 0.6], tear.width * 1.1, 0.5)];
    blood = { pool, streams };
  } else if (findings.blood) {
    // кровь стекла в отлогую часть желудка: снизу озерцо — по краю поля, сверху ровная гладь с лёгкой рябью
    const mid = Math.PI / 2 + (bu() - 0.5) * 0.3;
    const span = 0.8 + bu() * 0.2;
    const n = 24;
    const R = field.r * 0.98;
    const at = (t: number, r: number): Pt => [field.c[0] + r * Math.cos(t), field.c[1] + r * Math.sin(t)];
    const outer = Array.from({ length: n + 1 }, (_, i) => at(mid - span + (2 * span * i) / n, R));
    const [l, r] = [outer[0], outer[n]];
    const edge = Array.from({ length: n - 1 }, (_, i) => {
      const s = (i + 1) / n;
      const ripple = (bu() - 0.5) * 0.008 + Math.sin(s * Math.PI) * 0.012;
      return [r[0] + (l[0] - r[0]) * s, r[1] + (l[1] - r[1]) * s - ripple] as Pt;
    });
    blood = { pool: [...outer, ...edge], streams: [] };
  }

  // гастрит (часть 53б): пятна покраснения по всей стенке антрального отдела, гуще вокруг привратника; не в просвете
  let erythema: Round[] | undefined;
  if (findings.gastritis && view === 'stomach') {
    const erng = rng.fork('erythema');
    const eu = () => erng.int(1000) / 1000;
    erythema = [];
    for (let k = 0; k < 60 && erythema.length < 9; k++) {
      const near = erythema.length < 4;
      const t = eu() * TAU, d = near ? lr * (1.8 + eu() * 2.2) : Math.sqrt(eu()) * field.r * 0.85;
      const c: Pt = near ? [lc[0] + d * Math.cos(t), lc[1] + d * Math.sin(t)] : [field.c[0] + d * Math.cos(t), field.c[1] + d * Math.sin(t)];
      const r = 0.06 + eu() * 0.07;
      if (dist(c, lc) < lr + r * 0.6 || dist(c, field.c) + r * 0.5 > field.r) continue;
      erythema.push({ c, r });
    }
  }

  // блики: несколько мелких по стенке и пара крупных у света — в желудке на стенке под торцом эндоскопа, в кардии на
  // стенке вокруг просвета; не в просвете. Если крупным места нет (свет закрыла большая язва), — только мелкие
  const glints: EgdGeometry['glints'] = [];
  const grng = rng.fork('glints');
  const gu = () => grng.int(1000) / 1000;
  const spot = (big: boolean, t: number, d: number): Pt => {
    if (!big) return [field.c[0] + d * Math.cos(t), field.c[1] + d * Math.sin(t)];
    if (view === 'stomach') return [light[0] + (gu() - 0.5) * 0.18, light[1] + (gu() - 0.5) * 0.12];
    const r = lr * 1.6 + gu() * 0.07;
    return [lc[0] + r * Math.cos(t), lc[1] + r * Math.sin(t)];
  };
  for (let k = 0; k < 80 && glints.length < 8; k++) {
    const big = glints.length < 2 && k < 30;
    const t = gu() * TAU, d = Math.sqrt(gu()) * field.r * 0.85;
    const c = spot(big, t, d);
    const rx = big ? 0.011 + gu() * 0.007 : 0.004 + gu() * 0.006;
    // не в просвете и не на находке: дно язвы, разрыв и кровь видны целиком
    if (dist(c, lc) < lr * 1.4) continue;
    if (ulcer && dist(c, ulcer.c) < ulcer.r * 1.3 + rx) continue;
    if (tear && dist(c, [(tear.axis[0][0] + tear.axis[1][0]) / 2, (tear.axis[0][1] + tear.axis[1][1]) / 2]) < dist(tear.axis[0], tear.axis[1]) / 2 + rx) continue;
    if (blood && blood.pool.some(p => dist(p, c) < rx * 2)) continue;
    glints.push({ c, rx, ry: rx * (0.35 + gu() * 0.3), angle: gu() * Math.PI });
  }

  return { view, field, light, lumen, folds, ...(zline ? { zline } : {}), glints, ...(ulcer ? { ulcer } : {}), ...(tear ? { tear } : {}), ...(blood ? { blood } : {}), ...(erythema ? { erythema } : {}) };
}
