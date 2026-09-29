// Обзорный снимок живота стоя (ADR 0013, spec 2026-09-chapter-2, часть 30б): геометрия — чистые
// функции в долях кадра (x — доля ширины, y — доля высоты), рисунок — abdomen.ts. Правая сторона
// пациента — слева на снимке. Сверху — основания лёгких и купола диафрагмы, правый выше; под
// правым — печень, под левым — газовый пузырь желудка с горизонтальным уровнем (снимок стоя); по
// рамке живота — ободочная кишка с газом; посередине — поясничные позвонки, внизу — крылья
// подвздошных костей, крестец и головки бёдер.
//
// Рисовальщик болезней не знает: серп газа под правым куполом и раздутые петли «арками» с
// уровнями жидкости заданы параметрами. Что они значат, запишут признаки базы по источникам.
import { Rng } from '@/engine/core/rng';

export type Pt = [number, number];

export interface AbdomenFindings {
  /** 0–1: серп свободного газа под правым куполом диафрагмы — толщина; 0 — газа нет */
  freeGas?: number;
  /** 0–1: раздутые петли тонкой кишки «арками» с горизонтальными уровнями жидкости — насколько раздуты; 0 — нет */
  levels?: number;
}

/** Высота кадра к ширине: от куполов диафрагмы до головок бёдер. */
export const ABDOMEN_ASPECT = 1.2;

/** Вершины куполов: правый (слева на снимке) выше левого. */
export const DOME_R: Pt = [0.3, 0.12];
export const DOME_L: Pt = [0.7, 0.145];
/** Толщина самой диафрагмы: при свободном газе она видна полоской между двумя слоями воздуха. */
export const DIAPHRAGM = 0.008;
/** Где под правым куполом лежит серп: от бокового края к средостению. */
export const CRESCENT_X: [number, number] = [0.11, 0.45];

const clamp01 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? 0 : Math.min(1, Math.max(0, x)));

/** Купол над точкой x: граница лёгкого сверху и живота снизу; к бокам и к середине опускается. */
export function domeY(x: number): number {
  const right = x < 0.5;
  const [cx, cy] = right ? DOME_R : DOME_L;
  const lateral = right ? x < cx : x > cx;
  const half = lateral ? 0.21 : 0.2;
  const d = (x - cx) / half;
  return cy + Math.min(0.11, 0.075 * d * d);
}

/**
 * Раздутая петля тонкой кишки, снимок стоя: «арка» — два колена вниз и дуга сверху, в каждом колене
 * свой уровень жидкости; или «чаша» (чаша Клойбера) — купол газа над ровным уровнем.
 */
export type Loop =
  | {
    kind: 'arch';
    /** середина между коленами */
    cx: number;
    /** низ колен */
    foot: number;
    /** половина расстояния между осями колен — доля ширины */
    w: number;
    /** высота колен от низа до начала дуги — доля высоты */
    h: number;
    /** просвет петли — доля ширины */
    cal: number;
    /** уровни жидкости в левом и правом колене: выше уровня — газ, ниже — жидкость */
    levels: [number, number];
  }
  | {
    kind: 'cup';
    cx: number;
    /** уровень жидкости — ровное дно купола */
    level: number;
    /** полуширина купола — доля ширины, высота — доля высоты */
    a: number;
    b: number;
  };

/** Дуга арки приплюснута: ниже полукруга. */
const ARCH_FLAT = 0.7;

/** Газ петли — замкнутый контур; дно — горизонтальный уровень (в арке — по уровню в каждом колене). */
export function loopGas(l: Loop, n = 24): Pt[] {
  if (l.kind === 'cup') {
    const dome = Array.from({ length: n + 1 }, (_, i) => {
      const t = Math.PI - (Math.PI * i) / n;
      return [l.cx + l.a * Math.cos(t), l.level - l.b * Math.sin(t)] as Pt;
    });
    return dome;
  }
  const top = l.foot - l.h;
  const ro = l.w + l.cal / 2, ri = l.w - l.cal / 2;
  const arc = (r: number, from: number, to: number): Pt[] =>
    Array.from({ length: n + 1 }, (_, i) => {
      const t = from + ((to - from) * i) / n;
      return [l.cx + r * Math.cos(t), top - ((r * ARCH_FLAT) / ABDOMEN_ASPECT) * Math.sin(t)] as Pt;
    });
  return [
    [l.cx - ro, l.levels[0]],
    ...arc(ro, Math.PI, 0),
    [l.cx + ro, l.levels[1]],
    [l.cx + ri, l.levels[1]],
    ...arc(ri, 0, Math.PI),
    [l.cx - ri, l.levels[0]],
  ];
}

/** Уровни жидкости петли — горизонтальные отрезки: [y, от x, до x]. */
export function loopLevels(l: Loop): [number, number, number][] {
  if (l.kind === 'cup') return [[l.level, l.cx - l.a, l.cx + l.a]];
  const ro = l.w + l.cal / 2, ri = l.w - l.cal / 2;
  return [[l.levels[0], l.cx - ro, l.cx - ri], [l.levels[1], l.cx + ri, l.cx + ro]];
}

/**
 * Складки слизистой поперёк всего просвета — так тонкая кишка отличается от толстой, у которой
 * гаустры перегораживают просвет не целиком: отрезки поперёк газа петли.
 */
export function loopFolds(l: Loop): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  if (l.kind === 'cup') {
    const k = Math.max(3, Math.round((2 * l.a) / 0.028));
    for (let i = 1; i < k; i++) {
      const x = l.cx - l.a + (2 * l.a * i) / k;
      const d = (x - l.cx) / l.a;
      out.push([[x, l.level], [x, l.level - l.b * Math.sqrt(Math.max(0, 1 - d * d))]]);
    }
    return out;
  }
  const top = l.foot - l.h;
  const ro = l.w + l.cal / 2, ri = l.w - l.cal / 2;
  const step = 0.026;
  for (const [side, level] of [[-1, l.levels[0]], [1, l.levels[1]]] as const) {
    for (let y = level - step * 0.8; y > top; y -= step) out.push([[l.cx + side * ri, y], [l.cx + side * ro, y]]);
  }
  const k = Math.max(3, Math.round((Math.PI * l.w) / 0.03));
  for (let i = 1; i < k; i++) {
    const t = (Math.PI * i) / k;
    out.push([
      [l.cx + ri * Math.cos(t), top - ((ri * ARCH_FLAT) / ABDOMEN_ASPECT) * Math.sin(t)],
      [l.cx + ro * Math.cos(t), top - ((ro * ARCH_FLAT) / ABDOMEN_ASPECT) * Math.sin(t)],
    ]);
  }
  return out;
}

/**
 * Ход ободочной кишки по рамке живота: слепая в правой подвздошной области, восходящая, печёночный
 * изгиб, провисающая поперечная, селезёночный изгиб выше печёночного, нисходящая, сигмовидная и
 * прямая в малом тазу.
 */
export const COLON: Pt[] = [
  [0.25, 0.76], [0.22, 0.66], [0.2, 0.55], [0.2, 0.45], [0.23, 0.37],
  [0.3, 0.37], [0.4, 0.43], [0.5, 0.46], [0.6, 0.42], [0.7, 0.35], [0.77, 0.29],
  [0.8, 0.35], [0.81, 0.45], [0.81, 0.56], [0.8, 0.66],
  [0.76, 0.74], [0.68, 0.8], [0.6, 0.78], [0.54, 0.82], [0.52, 0.9],
];

/** Длины отрезков хода кишки — в пикселях кадра шириной 1, чтобы доли длины были честными. */
const colonLengths = COLON.slice(1).map((b, i) => Math.hypot(b[0] - COLON[i][0], (b[1] - COLON[i][1]) * ABDOMEN_ASPECT));
const colonTotal = colonLengths.reduce((a, b) => a + b, 0);

/** Точка на ходе кишки: t — доля длины от слепой (0) до прямой (1). */
export function colonAt(t: number): Pt {
  let d = Math.min(1, Math.max(0, t)) * colonTotal;
  for (let i = 0; i < colonLengths.length; i++) {
    if (d <= colonLengths[i] || i === colonLengths.length - 1) {
      const k = colonLengths[i] > 0 ? Math.min(1, d / colonLengths[i]) : 0;
      const [a, b] = [COLON[i], COLON[i + 1]];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    d -= colonLengths[i];
  }
  return COLON[COLON.length - 1];
}

/** Газ в отрезке ободочной кишки: ось, ширина просвета (доля ширины) и гаустры — перегородки не на весь просвет. */
export interface ColonGas { pts: Pt[]; width: number; septa: [Pt, Pt][] }

function colonGas(t0: number, t1: number, width: number): ColonGas {
  const n = Math.max(4, Math.round(((t1 - t0) * colonTotal) / 0.012));
  const pts = Array.from({ length: n + 1 }, (_, i) => colonAt(t0 + ((t1 - t0) * i) / n));
  const septa: [Pt, Pt][] = [];
  const every = Math.max(2, Math.round((width * 0.9) / ((t1 - t0) * colonTotal / n)));
  for (let i = every; i < n; i += every) {
    const [a, b] = [pts[i - 1], pts[i + 1]];
    const dx = b[0] - a[0], dy = (b[1] - a[1]) * ABDOMEN_ASPECT;
    const l = Math.hypot(dx, dy) || 1;
    // нормаль в долях: по x — доля ширины, по y — доля высоты
    const nx = -dy / l, ny = dx / l / ABDOMEN_ASPECT;
    const half = width / 2;
    for (const s of [-1, 1]) {
      const edge: Pt = [pts[i][0] + s * nx * half, pts[i][1] + s * ny * half];
      const tip: Pt = [pts[i][0] + s * nx * half * 0.35, pts[i][1] + s * ny * half * 0.35];
      septa.push([edge, tip]);
    }
  }
  return { pts, width, septa };
}

export interface Vertebra { y: number; h: number; half: number }

export interface AbdomenGeometry {
  /** серп свободного газа под правым куполом — замкнутый контур; нет газа — нет */
  crescent?: Pt[];
  /** газовый пузырь желудка: верх по куполу, низ — горизонтальный уровень */
  stomach: { gas: Pt[]; level: number };
  /** газ ободочной кишки — отрезками по ходу; при непроходимости тонкой кишки его почти нет */
  colon: ColonGas[];
  /** раздутые петли тонкой кишки с уровнями */
  loops: Loop[];
  /** печень под правым куполом — чуть плотнее остального живота */
  liver: Pt[];
  /** позвонки от Th12 до L5 */
  vertebrae: Vertebra[];
}

/** Места петель «лесенкой» от левого верха к правому низу — по центру живота: арки и чаши вперемежку. */
const LADDER: { at: Pt; kind: Loop['kind'] }[] = [
  { at: [0.37, 0.37], kind: 'arch' }, { at: [0.62, 0.4], kind: 'cup' }, { at: [0.42, 0.5], kind: 'cup' },
  { at: [0.63, 0.55], kind: 'arch' }, { at: [0.36, 0.63], kind: 'arch' }, { at: [0.58, 0.69], kind: 'cup' },
];

/** Снимок живота: вся геометрия в долях кадра. Анатомия одна и та же; от зерна — газ и петли. */
export function abdomenGeometry(f: AbdomenFindings, seed: number): AbdomenGeometry {
  const rng = Rng.seeded(seed).fork('abdomen');
  const u = () => rng.int(1000) / 1000;
  const gas = clamp01(f.freeGas);
  const obstruction = clamp01(f.levels);

  // серп: верх — сразу под диафрагмой, низ — над печенью; толще посередине, к краям сходит на нет
  let crescent: Pt[] | undefined;
  if (gas > 0) {
    const [x0, x1] = CRESCENT_X;
    const n = 28;
    const top: Pt[] = [], bottom: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const t = 0.008 + 0.03 * gas;
      const k = Math.sin((Math.PI * i) / n) ** 0.7;
      const y = domeY(x) + DIAPHRAGM;
      top.push([x, y]);
      bottom.push([x, y + t * k]);
    }
    crescent = [...top, ...bottom.reverse()];
  }

  // пузырь желудка: под левым куполом, стоя газ сверху, жидкость снизу — ровная граница; свод
  // пузыря скруглён и не выше самого купола
  const level = DOME_L[1] + 0.07;
  const sgas: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = Math.PI - (Math.PI * i) / 24;
    const x = 0.69 + 0.085 * Math.cos(t);
    sgas.push([x, Math.max(domeY(x) + 0.014, level - 0.06 * Math.sin(t))]);
  }

  // газ толстой кишки: в норме — отрезками в поперечной, в изгибах и в прямой; при непроходимости
  // тонкой — только немного в прямой, или нет совсем
  const colon: ColonGas[] = [];
  const parts: [number, number, number][] = obstruction > 0
    ? [[0.93, 0.99, 0.03]]
    : [[0.2, 0.27, 0.06], [0.3, 0.52, 0.072], [0.53, 0.6, 0.06], [0.63, 0.71, 0.045], [0.9, 0.99, 0.062]];
  for (const [a, b, w] of parts) {
    if (u() >= (obstruction > 0 ? 0.5 : 0.8)) continue;
    const t0 = a + (b - a) * 0.25 * u(), t1 = b - (b - a) * 0.25 * u();
    colon.push(colonGas(t0, t1, w * (0.85 + 0.3 * u())));
  }

  // петли: от трёх до шести «лесенкой»; уровни в коленах одной арки — на разной высоте
  const loops: Loop[] = [];
  if (obstruction > 0) {
    const count = 3 + Math.round(3 * obstruction);
    for (let i = 0; i < count; i++) {
      const { at: [bx, by], kind } = LADDER[i];
      const cx = bx + (u() - 0.5) * 0.03;
      const y = by + (u() - 0.5) * 0.02;
      if (kind === 'cup') {
        loops.push({ kind, cx, level: y, a: 0.06 + 0.02 * u() + 0.01 * obstruction, b: 0.035 + 0.015 * u() });
        continue;
      }
      const w = 0.06 + 0.015 * u();
      const h = 0.05 + 0.025 * u();
      const cal = 0.042 + 0.02 * obstruction;
      const lo = y - h * (0.1 + 0.2 * u());
      const hi = y - h * (0.4 + 0.3 * u());
      loops.push({ kind, cx, foot: y, w, h, cal, levels: i % 2 === 0 ? [lo, hi] : [hi, lo] });
    }
  }

  // печень: от купола вниз, нижний край — от правого бока низко к середине вверх
  const liver: Pt[] = [];
  for (let i = 0; i <= 20; i++) {
    const x = 0.05 + (0.45 * i) / 20;
    liver.push([x, domeY(x)]);
  }
  liver.push([0.5, 0.3], [0.38, 0.35], [0.22, 0.41], [0.1, 0.46], [0.05, 0.47]);

  const vertebrae: Vertebra[] = [];
  for (let i = 0; i < 6; i++) vertebrae.push({ y: 0.16 + i * 0.09, h: 0.074, half: 0.05 + i * 0.002 });

  return { ...(crescent ? { crescent } : {}), stomach: { gas: sgas, level }, colon, loops, liver, vertebrae };
}
