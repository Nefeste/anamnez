// Срез головы на КТ и МРТ (ADR 0013, spec 2026-09-ct-mri-ultrasound): геометрия — чистые
// функции в долях кадра, рисунок — head.ts. Кадр квадратный; спереди — сверху, правая
// сторона пациента — слева на снимке, как на рентгене. Срез — поперечный, на уровне передних
// рогов и треугольников боковых желудочков: подкорковые ядра, зрительные бугры, третий
// желудочек.
//
// Рисовальщик болезней не знает: очаг задан параметрами — плотность, форма, сторона, часть
// полушария, размер. Что какой признак значит на снимке, запишут признаки базы по источникам.
import { Rng } from '@/engine/core/rng';

export type Pt = [number, number];

export interface HeadFocus {
  /** светлее ткани вокруг или темнее */
  density: 'high' | 'low';
  /** пятно в веществе, серп у свода, линза у свода, клин от коры вглубь */
  shape: 'blob' | 'crescent' | 'lens' | 'wedge';
  /** сторона пациента */
  side: 'right' | 'left';
  /** часть полушария: для пятна и клина — где они, для серпа и линзы — середина по своду */
  region?: 'front' | 'middle' | 'back';
  /** 0–1: доля наибольшего */
  size: number;
}

export interface HeadFindings {
  focus?: HeadFocus;
  /** 0–1: смещение срединных структур в сторону, противоположную очагу; без очага — нет */
  shift?: number;
}

export interface HeadGeometry {
  /** кожа и мягкие ткани головы — внешний контур */
  head: Pt[];
  /** наружная и внутренняя пластинки свода */
  skullOuter: Pt[];
  skullInner: Pt[];
  /** поверхность мозга: у серпа и линзы — отодвинута от свода */
  brain: Pt[];
  /** борозды — от поверхности вглубь (толщина у поверхности — доля ширины), и боковые (сильвиевы) щели */
  sulci: { path: Pt[]; width: number }[];
  sylvian: Pt[][];
  /** межполушарная щель спереди и сзади и серп мозга по ней */
  fissure: Pt[][];
  /** серое вещество в глубине: головки хвостатых ядер, чечевицеобразные ядра, зрительные бугры, островки */
  deepGray: Pt[][];
  /** желудочки: передние рога, третий, треугольники с задними рогами */
  ventricles: Pt[][];
  /** известь: сосудистые сплетения в треугольниках, шишковидное тело */
  calcifications: { c: Pt; r: number }[];
  /** срединная линия на уровне прозрачной перегородки — для проверки смещения */
  midline: number;
  focus?: { shape: HeadFocus['shape']; density: HeadFocus['density']; outline: Pt[] };
}

const CX = 0.5;
const CY = 0.5;
/** полуоси головы: поперёк и спереди назад */
const A = 0.37;
const B = 0.45;
const SCALP = 0.022;
const RIM = 0.005;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Радиус контура головы под углом θ (от оси x по часовой: 0 — слева пациента, π/2 — затылок). */
export function headRadius(t: number): number {
  const a = A * (1 + 0.05 * Math.sin(t)); // к затылку чуть шире
  const c = Math.cos(t), s = Math.sin(t);
  return 1 / Math.sqrt((c * c) / (a * a) + (s * s) / (B * B));
}

/** Толщина свода: спереди и сзади толще, у висков тоньше. */
const skullThickness = (t: number) => 0.018 + 0.012 * Math.abs(Math.sin(t));
export const skullInnerRadius = (t: number) => headRadius(t) - SCALP - skullThickness(t);

const at = (t: number, r: number): Pt => [CX + r * Math.cos(t), CY + r * Math.sin(t)];
const ring = (r: (t: number) => number, n = 180): Pt[] => Array.from({ length: n }, (_, i) => at((i / n) * 2 * Math.PI, r((i / n) * 2 * Math.PI)));

/** Угол середины части полушария у свода: для правой стороны пациента — слева на снимке. */
function regionAngle(side: HeadFocus['side'], region: HeadFocus['region'], spread = 0.55): number {
  const right = region === 'front' ? Math.PI + spread : region === 'back' ? Math.PI - spread : Math.PI;
  return side === 'right' ? right : Math.PI - right;
}

/** Угол в пределах (−π, π] — разница углов. */
const wrap = (t: number) => Math.atan2(Math.sin(t), Math.cos(t));

/**
 * Скопление у свода: сколько оно отнимает у мозга под углом θ. Серп — длинный, почти ровный
 * в середине и тающий к концам; линза — короткая и выпуклая к мозгу.
 */
function collection(f: HeadFocus | undefined, t: number): number {
  if (!f || (f.shape !== 'crescent' && f.shape !== 'lens')) return 0;
  const s = clamp01(f.size);
  const c = regionAngle(f.side, f.region, f.shape === 'lens' ? 0.45 : 0.35);
  const half = f.shape === 'crescent' ? 0.6 + 0.45 * s : 0.22 + 0.16 * s;
  const u = wrap(t - c) / half;
  if (Math.abs(u) >= 1) return 0;
  const max = f.shape === 'crescent' ? 0.012 + 0.03 * s : 0.02 + 0.045 * s;
  return f.shape === 'crescent' ? max * (1 - u * u) ** 0.7 : max * Math.sqrt(1 - u * u);
}

export const brainRadius = (f: HeadFocus | undefined, t: number) => skullInnerRadius(t) - RIM - collection(f, t);

/**
 * Смещение срединных структур: к противоположной очагу стороне, больше всего — у прозрачной
 * перегородки и третьего желудочка, к своду спереди и сзади — на нет (серп прикреплён), к
 * латеральным отделам — меньше.
 */
function shiftField(findings: HeadFindings): (p: Pt) => Pt {
  const f = findings.focus;
  const k = f ? clamp01(findings.shift ?? 0) : 0;
  if (k === 0) return p => p;
  const dir = f!.side === 'right' ? 1 : -1; // очаг справа (слева на снимке) — сдвиг вправо на снимке
  const max = 0.07 * k * dir;
  return ([x, y]) => {
    const along = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (y - 0.1) / 0.8))));
    const across = Math.max(0, 1 - Math.abs(x - CX) / 0.32);
    return [x + max * along * across, y];
  };
}

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

/** Форма правой стороны пациента (слева на снимке) — точки смещением от срединной линии; левая — зеркально. */
const mirror = (pts: Pt[], sign: -1 | 1, mx: number): Pt[] => pts.map(([dx, y]) => [mx + sign * dx, y]);

// передний рог: медиальная стенка у перегородки, кончик — вперёд и кнаружи, латеральная
// стенка вдавлена головкой хвостатого ядра
const FRONTAL_HORN: Pt[] = [[0.005, 0.338], [0.022, 0.322], [0.044, 0.318], [0.056, 0.33], [0.046, 0.352], [0.03, 0.384], [0.02, 0.42], [0.012, 0.448], [0.005, 0.45]];
// треугольник и задний рог: к затылку и немного внутрь
const ATRIUM: Pt[] = [[0.06, 0.622], [0.086, 0.624], [0.1, 0.65], [0.094, 0.684], [0.074, 0.722], [0.064, 0.744], [0.058, 0.712], [0.062, 0.674], [0.054, 0.645]];
// головка хвостатого ядра — у латеральной стенки переднего рога; чечевицеобразное ядро —
// линза выпуклостью кнаружи; зрительный бугор — овал у третьего желудочка; островок — узкая
// полоса коры в глубине боковой щели
const CAUDATE: Pt[] = [[0.036, 0.352], [0.056, 0.358], [0.064, 0.384], [0.052, 0.418], [0.032, 0.43], [0.026, 0.4]];
const LENTIFORM: Pt[] = [[0.1, 0.4], [0.128, 0.408], [0.15, 0.44], [0.155, 0.48], [0.146, 0.515], [0.124, 0.522], [0.104, 0.49], [0.092, 0.45]];
const THALAMUS: Pt[] = [[0.01, 0.478], [0.036, 0.474], [0.056, 0.498], [0.062, 0.535], [0.048, 0.566], [0.022, 0.572], [0.01, 0.545]];
const INSULA: Pt[] = [[0.184, 0.395], [0.194, 0.42], [0.197, 0.465], [0.193, 0.515], [0.184, 0.54], [0.178, 0.5], [0.177, 0.44]];

/** Точка внутри многоугольника (чётность пересечений). */
export function inside(p: Pt, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Срез головы: вся геометрия в долях кадра. Анатомия одна и та же, от зерна — борозды. */
export function headGeometry(findings: HeadFindings, seed: number): HeadGeometry {
  const f = findings.focus;
  const rng = Rng.seeded(seed).fork('head');
  const move = shiftField(findings);
  const k = f ? clamp01(findings.shift ?? 0) : 0;
  const focusSign: -1 | 1 = f?.side === 'left' ? 1 : -1; // сторона очага на снимке
  const mx = move([CX, 0.45])[0];

  const head = ring(headRadius);
  const skullOuter = ring(t => headRadius(t) - SCALP);
  const skullInner = ring(skullInnerRadius);
  // извилины: поверхность мозга чуть волнистая
  const wave = [rng.int(1000) / 1000 * 6.28, rng.int(1000) / 1000 * 6.28];
  const brainAt = (t: number) => brainRadius(f, t) - 0.003 * (1 + Math.sin(23 * t + wave[0]) * 0.6 + Math.sin(37 * t + wave[1]) * 0.4);
  const brain = ring(brainAt, 360);

  // клин и пятно — очаг в веществе
  let focus: HeadGeometry['focus'];
  let wedge: { c: number; half: number } | undefined;
  if (f && (f.shape === 'blob' || f.shape === 'wedge')) {
    const s = clamp01(f.size);
    if (f.shape === 'wedge') {
      const c = regionAngle(f.side, f.region, 0.75);
      const half = 0.18 + 0.24 * s;
      const depth = 0.08 + 0.11 * s;
      wedge = { c, half };
      // веер от коры вглубь: глубже всего посередине, к краям мельче; край неровный
      const p1 = rng.int(1000) / 1000 * 6.28, p2 = rng.int(1000) / 1000 * 6.28;
      const outer: Pt[] = [], inner: Pt[] = [];
      for (let i = 0; i <= 40; i++) {
        const q = -1 + (2 * i) / 40;
        const t = c + q * half;
        outer.push(at(t, brainAt(t) - 0.002));
        const d = depth * Math.cos((Math.PI / 2) * q) ** 0.45 * (1 + 0.1 * Math.sin(5 * q + p1) + 0.06 * Math.sin(11 * q + p2));
        const ti = c + q * half * 0.88; // вглубь веер сужается
        inner.push(at(ti, brainAt(ti) - Math.max(0.012, d)));
      }
      focus = { shape: 'wedge', density: f.density, outline: smooth([...outer, ...inner.reverse()], 1).map(move) };
    } else {
      const off: Record<NonNullable<HeadFocus['region']>, Pt> = { front: [0.14, 0.29], middle: [0.135, 0.465], back: [0.12, 0.7] };
      const [dx, cy] = off[f.region ?? 'middle'];
      const center: Pt = [CX + focusSign * dx, cy];
      const r = 0.022 + 0.05 * s;
      const a = rng.int(1000) / 1000 * 6.28, b = rng.int(1000) / 1000 * 6.28;
      const outline: Pt[] = [];
      for (let i = 0; i < 48; i++) {
        const t = (i / 48) * 2 * Math.PI;
        const rr = r * (1 + 0.12 * Math.sin(3 * t + a) + 0.07 * Math.sin(5 * t + b));
        outline.push([center[0] + rr * Math.cos(t), center[1] + rr * 1.1 * Math.sin(t)]);
      }
      // не дальше поверхности мозга: точки снаружи — к ней
      const kept = outline.map(p => {
        const t = Math.atan2(p[1] - CY, p[0] - CX);
        const lim = brainAt(t) - 0.012;
        const d = Math.hypot(p[0] - CX, p[1] - CY);
        return d > lim ? at(t, lim) : p;
      });
      focus = { shape: 'blob', density: f.density, outline: kept.map(move) };
    }
  } else if (f && (f.shape === 'crescent' || f.shape === 'lens')) {
    const outer: Pt[] = [], inner: Pt[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * 2 * Math.PI;
      const w = collection(f, t);
      if (w <= 0) continue;
      outer.push(at(t, skullInnerRadius(t) + 0.001));
      inner.push(at(t, skullInnerRadius(t) - w));
    }
    // дуга может пересекать θ = 0 — упорядочим по углу от середины
    const c = regionAngle(f.side, f.region, f.shape === 'lens' ? 0.45 : 0.35);
    const order = (p: Pt) => wrap(Math.atan2(p[1] - CY, p[0] - CX) - c);
    outer.sort((p, q) => order(p) - order(q));
    inner.sort((p, q) => order(p) - order(q));
    focus = { shape: f.shape, density: f.density, outline: [...outer, ...inner.reverse()] };
  }

  // борозды: от поверхности вглубь — изогнутые, разной глубины, иногда с веткой; реже у
  // межполушарной щели, нет в клине, под скоплением — сдавлены
  const sulci: HeadGeometry['sulci'] = [];
  const u = () => rng.int(1000) / 1000;
  for (let t = -Math.PI + u() * 0.1; t < Math.PI; t += 0.07 + u() * 0.09) {
    const nearMidline = Math.abs(wrap(t + Math.PI / 2)) < 0.1 || Math.abs(wrap(t - Math.PI / 2)) < 0.1;
    const nearSylvian = Math.abs(wrap(t - Math.PI)) < 0.08 || Math.abs(wrap(t)) < 0.08;
    if (nearMidline || nearSylvian) continue;
    // под скоплением борозды сдавлены, в клине — сужены отёком
    const squeezed = collection(f, t) > 0;
    const swollen = wedge !== undefined && Math.abs(wrap(t - wedge.c)) < wedge.half * 1.05;
    const depth = (squeezed ? 0.35 : swollen ? 0.75 : 1) * (0.014 + u() * 0.04);
    const r0 = brainAt(t);
    // изгиб: середина отходит вбок, конец — чуть в другую сторону
    const b1 = (u() - 0.5) * 0.09, b2 = (u() - 0.5) * 0.07;
    const path: Pt[] = [];
    for (let i = 0; i <= 6; i++) {
      const q = i / 6;
      path.push(at(t + b1 * Math.sin(Math.PI * q) + b2 * q * q, r0 + 0.002 - depth * q));
    }
    const width = (squeezed ? 0.5 : swollen ? 0.75 : 1) * (0.0028 + u() * 0.0035);
    sulci.push({ path, width });
    // ветка из середины у глубоких борозд
    if (depth > 0.035 && u() < 0.45) {
      const from = path[3];
      const side = u() < 0.5 ? -1 : 1;
      const tb = Math.atan2(from[1] - CY, from[0] - CX) + side * (0.05 + u() * 0.05);
      const rb = Math.hypot(from[0] - CX, from[1] - CY) - depth * (0.3 + u() * 0.3);
      sulci.push({ path: [from, at(tb, rb)], width: width * 0.7 });
    }
  }

  // боковые щели: от латеральной поверхности к островку, вдоль него вперёд и назад; в клине —
  // стёрты, как борозды
  const sylvian: Pt[][] = ([-1, 1] as const).flatMap(sign => {
    const t = sign === -1 ? Math.PI - 0.03 : 0.03;
    if (wedge && Math.abs(wrap(t - wedge.c)) < wedge.half + 0.05) return [];
    const surf = at(t, brainAt(t) + 0.002);
    const stem: Pt[] = [surf, [CX + sign * 0.245, 0.468], [CX + sign * 0.215, 0.462]];
    const along: Pt[] = [[CX + sign * 0.204, 0.4], [CX + sign * 0.212, 0.43], [CX + sign * 0.215, 0.462], [CX + sign * 0.212, 0.5], [CX + sign * 0.2, 0.535]];
    return [stem.map(move), along.map(move)];
  });

  // межполушарная щель: спереди — от поверхности до передних рогов, сзади — от затылка до треугольников
  const top = brainAt(-Math.PI / 2), bottom = brainAt(Math.PI / 2);
  const fissure: Pt[][] = [
    Array.from({ length: 9 }, (_, i) => move([CX, CY - top + ((0.325 - (CY - top)) * i) / 8])),
    Array.from({ length: 9 }, (_, i) => move([CX, CY + bottom - ((CY + bottom - 0.69) * i) / 8])),
  ];

  // желудочки и ядра: зеркально для двух сторон, со смещением; на стороне очага сдавлены
  const squeeze = (pts: Pt[], sideSign: -1 | 1, amount: number): Pt[] => {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const scale = sideSign === focusSign ? 1 - amount * k : 1 + (amount * k) / 2;
    return pts.map(([x, y]) => [cx + (x - cx) * scale, y]);
  };
  const ventricles: Pt[][] = [];
  const deepGray: Pt[][] = [];
  for (const sign of [-1, 1] as const) {
    // сначала смещение, потом сдавление вокруг смещённой середины: иначе разный сдвиг
    // медиальной и латеральной стенок растянул бы рог обратно
    ventricles.push(smooth(squeeze(mirror(FRONTAL_HORN, sign, CX).map(move), sign, 0.8)));
    ventricles.push(smooth(squeeze(mirror(ATRIUM, sign, CX).map(move), sign, 0.45)));
    for (const g of [CAUDATE, LENTIFORM, THALAMUS, INSULA]) deepGray.push(smooth(mirror(g, sign, CX)).map(move));
  }
  // третий желудочек — узкая щель по срединной линии
  ventricles.push(smooth([[CX - 0.005, 0.475], [CX + 0.005, 0.475], [CX + 0.006, 0.52], [CX + 0.004, 0.565], [CX - 0.004, 0.565], [CX - 0.006, 0.52]], 1).map(move));

  const calcifications = [
    { c: move([CX - 0.082, 0.66]), r: 0.009 },
    { c: move([CX + 0.082, 0.66]), r: 0.009 },
    { c: move([CX, 0.59]), r: 0.006 },
  ];

  return { head, skullOuter, skullInner, brain, sulci, sylvian, fissure, deepGray, ventricles, calcifications, midline: mx, ...(focus ? { focus } : {}) };
}
