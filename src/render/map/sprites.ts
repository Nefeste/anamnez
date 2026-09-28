// Текстура спрайтов карты собирается кодом при открытии карты (ADR 0013, 06-architecture.md
// §6): предметы, аппараты и люди — простые плоские формы сверху, одна текстура на все, одно
// обращение к GPU на слой. Рисунок каждого — в клетке, лицом вниз (на юг): куда он повёрнут,
// решает карта (orient.ts). Люди — из двух слоёв с одной матрицей: тело (одежда, форма, обод
// срочности) и голова (кожа, волосы, шапочка) — spec 2026-09-living-map, часть 22.
import { ClipOp, PaintStyle, Skia, type SkCanvas, type SkImage, type SkRect, StrokeCap, StrokeJoin } from '@shopify/react-native-skia';
import type { ObjectKind } from '@/engine/hospital/grid';
import { CLOTHES, HAIR, SKIN } from '@/render/look';
import { BODIES, type Hair, HAIRS, HEADS, STYLES, UNIFORM } from './figures';

export const OBJECT_KINDS: ObjectKind[] = ['bed', 'chair', 'desk', 'couch', 'cabinet', 'machine', 'plant', 'sink', 'bench', 'xray', 'table', 'ecg', 'analyzer'];

export interface SpriteAtlas {
  image: SkImage;
  /** сторона клетки в атласе, точек: RSXform сжимает её в клетку карты */
  px: number;
  objectRect: (k: ObjectKind) => SkRect;
  bodyRect: (i: number) => SkRect;
  headRect: (i: number) => SkRect;
}

/** Клеток в строке атласа; тела и головы — после предметов: их номер — смещение плюс номер фигуры. */
export const COLS = 16;
export const BODY_AT = OBJECT_KINDS.length;
export const HEAD_AT = OBJECT_KINDS.length + BODIES;

/**
 * Сторона клетки атласа, точек: полторы точки экрана на точку клетки — рисунок не мылится при
 * сжатии; не меньше 48 и не больше 128 (экран стройки при наибольшем приближении).
 */
export function atlasPx(cellDp: number, ratio: number): number {
  return Math.min(128, Math.max(48, Math.ceil((cellDp * ratio * 1.5) / 8) * 8));
}

/** Темнее на долю k — край формы на светлом полу. */
export function darker(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * (1 - k)).toString(16).padStart(2, '0');
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

const built = new Map<string, SpriteAtlas>();

/**
 * Атлас: клетка — `px` точек. Размер — под плотность экрана и наибольшее приближение, чтобы
 * рисунок не мылился; `people: false` — без людей (экран стройки). Собранный хранится: карта
 * открывается снова — атлас тот же, без сотни рисунков заново.
 */
export function buildAtlas(px = 64, people = true): SpriteAtlas {
  const key = `${px}:${people}`;
  const ready = built.get(key);
  if (ready) return ready;
  const atlas = drawAtlas(px, people);
  built.set(key, atlas);
  return atlas;
}

function drawAtlas(px: number, people: boolean): SpriteAtlas {
  const count = OBJECT_KINDS.length + (people ? BODIES + HEADS : 0);
  const rows = Math.ceil(count / COLS);
  const surface = Skia.Surface.Make(COLS * px, rows * px);
  if (!surface) throw new Error('Skia surface unavailable');
  const c = surface.getCanvas();
  OBJECT_KINDS.forEach((k, i) => drawAt(c, i, px, u => drawObject(u, k)));
  if (people) {
    for (let i = 0; i < BODIES; i++) drawAt(c, OBJECT_KINDS.length + i, px, u => drawBody(u, i));
    for (let i = 0; i < HEADS; i++) drawAt(c, OBJECT_KINDS.length + BODIES + i, px, u => drawHead(u, i));
  }
  surface.flush();
  const image = surface.makeImageSnapshot();
  const rect = (i: number) => Skia.XYWHRect((i % COLS) * px, Math.floor(i / COLS) * px, px, px);
  return {
    image,
    px,
    objectRect: k => rect(OBJECT_KINDS.indexOf(k)),
    bodyRect: i => rect(OBJECT_KINDS.length + (i % BODIES)),
    headRect: i => rect(OBJECT_KINDS.length + BODIES + (i % HEADS)),
  };
}

/** Кисть в долях клетки: всё рисуется в квадрате 0…1, лицом на юг. */
interface Pen {
  rr: (x0: number, y0: number, x1: number, y1: number, r: number, color: string, edge?: string, ew?: number) => void;
  circle: (x: number, y: number, r: number, color: string | null, edge?: string, ew?: number) => void;
  oval: (cx: number, cy: number, rx: number, ry: number, color: string, edge?: string, ew?: number, deg?: number) => void;
  line: (pts: number[], color: string, w: number) => void;
  quad: (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, color: string, w: number) => void;
  arc: (cx: number, cy: number, r: number, from: number, sweep: number, color: string, w: number) => void;
}

/** Рисунок в клетку `i` атласа; по краю клетки — точка пустоты, чтобы соседи не просвечивали. */
function drawAt(c: SkCanvas, i: number, px: number, draw: (pen: Pen) => void) {
  const ox = (i % COLS) * px;
  const oy = Math.floor(i / COLS) * px;
  const k = px - 2;
  const fill = (color: string) => {
    const p = Skia.Paint();
    p.setColor(Skia.Color(color));
    p.setAntiAlias(true);
    return p;
  };
  const stroke = (color: string, w: number) => {
    const p = fill(color);
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeWidth(w * k);
    p.setStrokeCap(StrokeCap.Round);
    p.setStrokeJoin(StrokeJoin.Round);
    return p;
  };
  const X = (v: number) => ox + 1 + v * k;
  const Y = (v: number) => oy + 1 + v * k;
  c.save();
  c.clipRect(Skia.XYWHRect(ox, oy, px, px), ClipOp.Intersect, true);
  draw({
    rr: (x0, y0, x1, y1, r, color, edge, ew = 0.03) => {
      const rr = Skia.RRectXY(Skia.XYWHRect(X(x0), Y(y0), (x1 - x0) * k, (y1 - y0) * k), r * k, r * k);
      c.drawRRect(rr, fill(color));
      if (edge) c.drawRRect(rr, stroke(edge, ew));
    },
    circle: (x, y, r, color, edge, ew = 0.03) => {
      if (color) c.drawCircle(X(x), Y(y), r * k, fill(color));
      if (edge) c.drawCircle(X(x), Y(y), r * k, stroke(edge, ew));
    },
    oval: (cx, cy, rx, ry, color, edge, ew = 0.03, deg = 0) => {
      c.save();
      c.translate(X(cx), Y(cy));
      c.rotate(deg, 0, 0);
      const o = Skia.XYWHRect(-rx * k, -ry * k, 2 * rx * k, 2 * ry * k);
      c.drawOval(o, fill(color));
      if (edge) c.drawOval(o, stroke(edge, ew));
      c.restore();
    },
    line: (pts, color, w) => {
      const b = Skia.PathBuilder.Make();
      b.moveTo(X(pts[0]), Y(pts[1]));
      for (let n = 2; n < pts.length; n += 2) b.lineTo(X(pts[n]), Y(pts[n + 1]));
      c.drawPath(b.detach(), stroke(color, w));
    },
    quad: (x0, y0, cx, cy, x1, y1, color, w) => {
      const b = Skia.PathBuilder.Make();
      b.moveTo(X(x0), Y(y0)).quadTo(X(cx), Y(cy), X(x1), Y(y1));
      c.drawPath(b.detach(), stroke(color, w));
    },
    arc: (cx, cy, r, from, sweep, color, w) => {
      const b = Skia.PathBuilder.Make();
      b.addArc(Skia.XYWHRect(X(cx - r), Y(cy - r), 2 * r * k, 2 * r * k), from, sweep);
      c.drawPath(b.detach(), stroke(color, w));
    },
  });
  c.restore();
}

const STEEL = '#D5DCDF';
const STEEL_EDGE = '#A2AEB2';
const DARK = '#3A4649';

/** Предметы и аппараты сверху: спинка, изголовье, экран — к северу, лицо — к югу. */
function drawObject(u: Pen, k: ObjectKind) {
  switch (k) {
    case 'bed':
      u.rr(0.16, 0.04, 0.84, 0.96, 0.07, '#FFFFFF', '#A9B8BC');
      u.rr(0.24, 0.09, 0.76, 0.27, 0.07, '#EDF1F3', '#C6D0D3', 0.02);
      u.rr(0.18, 0.34, 0.82, 0.94, 0.05, '#9CC3E6');
      u.rr(0.18, 0.34, 0.82, 0.44, 0.03, '#C7DDF1');
      break;
    case 'chair':
      u.rr(0.25, 0.3, 0.75, 0.78, 0.09, '#94714F', '#6E513A');
      u.rr(0.22, 0.18, 0.78, 0.32, 0.06, '#6E513A');
      break;
    case 'desk':
      u.rr(0.05, 0.14, 0.95, 0.86, 0.05, '#B28B61', '#8A6844');
      // монитор — у дальнего края, клавиатура и бумаги — у того, кто сидит
      u.rr(0.3, 0.2, 0.7, 0.28, 0.02, DARK);
      u.rr(0.45, 0.28, 0.55, 0.35, 0.01, '#5A6669');
      u.rr(0.32, 0.56, 0.68, 0.67, 0.02, '#ECE8E0', '#CFC8BB', 0.015);
      u.rr(0.09, 0.46, 0.25, 0.72, 0.01, '#FFFFFF', '#D8D1C4', 0.015);
      break;
    case 'couch':
      u.rr(0.2, 0.04, 0.8, 0.96, 0.1, '#5F8F7A', '#4A7361');
      u.rr(0.24, 0.08, 0.76, 0.3, 0.08, '#7BAA94');
      u.rr(0.39, 0.31, 0.61, 0.92, 0.02, '#F2F5F0');
      break;
    case 'cabinet':
      u.rr(0.08, 0.1, 0.92, 0.8, 0.04, '#A7B2B5', '#7F8B8E');
      u.rr(0.08, 0.68, 0.92, 0.8, 0.03, '#8E9A9D');
      u.line([0.5, 0.14, 0.5, 0.66], '#7F8B8E', 0.025);
      break;
    case 'plant':
      u.circle(0.5, 0.5, 0.24, '#B86F45', '#8E5332', 0.025);
      u.circle(0.5, 0.5, 0.18, '#6B4A32');
      for (let n = 0; n < 7; n++) {
        const a = (n * 360) / 7 + 12;
        const r = (a * Math.PI) / 180;
        u.oval(0.5 + Math.cos(r) * 0.19, 0.5 + Math.sin(r) * 0.19, 0.15, 0.07, n % 2 ? '#3F7547' : '#4E8A55', undefined, 0, a);
      }
      u.circle(0.5, 0.5, 0.07, '#5E9C63');
      break;
    case 'sink':
      u.rr(0.1, 0.08, 0.9, 0.64, 0.05, '#E4E9EB', '#B5C0C3');
      u.rr(0.26, 0.22, 0.74, 0.58, 0.12, '#FFFFFF', '#B5C0C3', 0.02);
      u.circle(0.5, 0.43, 0.03, '#9AA6A9');
      u.rr(0.47, 0.1, 0.53, 0.28, 0.02, '#87949A');
      break;
    case 'bench':
      u.rr(0.03, 0.26, 0.97, 0.34, 0.03, '#8A6A45');
      u.rr(0.03, 0.34, 0.97, 0.72, 0.05, '#B5915F', '#8A6A45', 0.025);
      u.line([0.06, 0.47, 0.94, 0.47], '#9B7A50', 0.02);
      u.line([0.06, 0.59, 0.94, 0.59], '#9B7A50', 0.02);
      break;
    case 'table':
      u.rr(0.08, 0.12, 0.92, 0.88, 0.04, STEEL, STEEL_EDGE);
      u.rr(0.2, 0.28, 0.6, 0.62, 0.04, '#EEF2F4', STEEL_EDGE, 0.02);
      u.circle(0.72, 0.36, 0.045, '#8E7AA6');
      u.circle(0.72, 0.5, 0.045, '#D9A21B');
      u.circle(0.72, 0.64, 0.045, '#5B7FA6');
      break;
    case 'machine':
      u.rr(0.14, 0.14, 0.86, 0.86, 0.08, '#56666B', '#3E4B4F');
      u.rr(0.26, 0.24, 0.74, 0.48, 0.04, '#8FD6B0');
      break;
    case 'xray':
      // стол, штатив сбоку, трубка над серединой стола
      u.rr(0.26, 0.02, 0.74, 0.98, 0.06, '#D3DBDD', '#95A3A7');
      u.rr(0.02, 0.36, 0.16, 0.64, 0.03, '#6F7E82');
      u.rr(0.14, 0.46, 0.5, 0.54, 0.02, '#6F7E82');
      u.rr(0.36, 0.37, 0.64, 0.63, 0.07, '#56666B', '#3E4B4F', 0.02);
      u.circle(0.5, 0.5, 0.07, '#E4EAEC');
      break;
    case 'ecg':
      // тележка: экран с кривой, колёса, провод к пациенту
      u.rr(0.18, 0.2, 0.82, 0.84, 0.08, '#E6EAEC', STEEL_EDGE);
      u.rr(0.26, 0.26, 0.74, 0.52, 0.04, '#2F3B3E');
      u.line([0.29, 0.43, 0.38, 0.43, 0.42, 0.33, 0.46, 0.47, 0.5, 0.41, 0.71, 0.41], '#7FD4A0', 0.025);
      for (const [x, y] of [[0.24, 0.84], [0.76, 0.84], [0.24, 0.2], [0.76, 0.2]]) u.circle(x, y, 0.045, '#56666B');
      u.quad(0.5, 0.84, 0.5, 0.96, 0.7, 0.97, '#56666B', 0.022);
      u.rr(0.34, 0.6, 0.66, 0.72, 0.03, '#CFD6D9');
      break;
    case 'analyzer':
      // настольный прибор: карусель проб слева, экран справа
      u.rr(0.06, 0.1, 0.94, 0.86, 0.06, '#EEF1F2', STEEL_EDGE);
      u.circle(0.36, 0.5, 0.23, STEEL, '#95A3A7', 0.02);
      for (let n = 0; n < 8; n++) {
        const r = (n * Math.PI) / 4;
        u.circle(0.36 + Math.cos(r) * 0.15, 0.5 + Math.sin(r) * 0.15, 0.037, ['#8E7AA6', '#D9A21B', '#5B7FA6', '#7A9E7E'][n % 4]);
      }
      u.circle(0.36, 0.5, 0.06, '#95A3A7');
      u.rr(0.64, 0.2, 0.88, 0.42, 0.03, '#2F3B3E');
      u.line([0.67, 0.34, 0.85, 0.34], '#7FC4E6', 0.025);
      u.circle(0.76, 0.66, 0.045, '#1A8A86');
      break;
  }
}

/** Тело сверху: плечи — овал поперёк хода, руки по бокам; обод срочности — вокруг. */
function drawBody(u: Pen, i: number) {
  let color: string;
  let edge: string;
  let urgency = 0;
  if (i === UNIFORM.doctor) [color, edge] = ['#FFFFFF', '#8FA3A8'];
  else if (i === UNIFORM.nurse) [color, edge] = ['#6FA8DC', '#3D6E99'];
  else if (i === UNIFORM.staff) [color, edge] = ['#E6E0F0', '#6E5E96'];
  else {
    const n = i - 3;
    urgency = Math.floor(n / CLOTHES.length);
    color = CLOTHES[n % CLOTHES.length];
    edge = darker(color, 0.38);
  }
  if (urgency === 1) u.circle(0.5, 0.5, 0.43, null, '#D9A21B', 0.07);
  if (urgency === 2) u.circle(0.5, 0.5, 0.42, null, '#C8453C', 0.11);
  u.oval(0.21, 0.54, 0.085, 0.14, color, edge, 0.03);
  u.oval(0.79, 0.54, 0.085, 0.14, color, edge, 0.03);
  u.oval(0.5, 0.5, 0.3, 0.19, color, edge, 0.035);
  if (i === UNIFORM.doctor) {
    // стетоскоп на шее — спереди, из-под головы
    u.quad(0.34, 0.52, 0.5, 0.86, 0.66, 0.52, DARK, 0.03);
    u.circle(0.58, 0.68, 0.035, '#8FA3A8');
  }
}

/** Голова сверху: круг кожи, волосы сзади и сверху — спереди видна полоска лица. */
function drawHead(u: Pen, i: number) {
  const capBase = SKIN.length * HAIRS.length * STYLES.length;
  const cap = i >= capBase;
  const skin = SKIN[cap ? i - capBase : Math.floor(i / (HAIRS.length * STYLES.length))];
  const hair = cap ? HAIR[1] : HAIRS[Math.floor(i / STYLES.length) % HAIRS.length];
  const style: Hair = cap ? 'cap' : STYLES[i % STYLES.length];
  const hairEdge = darker(hair, 0.3);
  // длинные волосы спадают на спину — за головой
  if (style === 'long') u.oval(0.5, 0.35, 0.125, 0.14, hair, hairEdge, 0.02);
  u.circle(0.5, 0.5, 0.155, skin, darker(skin, 0.25), 0.02);
  if (style === 'bald') {
    // лысина — волосы подковой по затылку
    u.arc(0.5, 0.5, 0.118, 200, 140, hair, 0.06);
  } else if (style === 'cap') {
    // шапочка закрывает волосы
    u.circle(0.5, 0.455, 0.15, '#FFFFFF', '#AFC4D2', 0.025);
    u.line([0.39, 0.52, 0.61, 0.52], '#AFC4D2', 0.02);
  } else {
    u.circle(0.5, 0.455, 0.148, hair, hairEdge, 0.02);
  }
}
