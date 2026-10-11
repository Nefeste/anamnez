// ЭГДС кодом (ADR 0013, spec 2026-10-chapter-4, часть 53а-2): геометрия — geometry.ts, здесь — рисунок, одна запись в
// SkPicture. Поле зрения — круг на чёрном. Слизистая желудка — розово-оранжевая, светлее у торца эндоскопа и темнее к
// краю; пищевод — бледнее. Дно язвы — белёсое (фибрин), вокруг — красный отёчный валик; сосуд — тёмно-красный бугорок,
// сгусток — почти чёрный комок, кровь — алая, с бликом; варикозные вены (часть 54а) — синеватые извитые тяжи по пищеводу.
// Влажная слизистая блестит.
import { BlendMode, BlurStyle, ClipOp, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, StrokeCap, StrokeJoin, TileMode } from '@shopify/react-native-skia';
import { egdGeometry, type EgdFindings, type Pt } from './geometry';

export type { EgdFindings };

/** Цвет `#rrggbb` с прозрачностью — строкой для Skia.Color. */
const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

const MUCOSA = ['#f7ad91', '#e2836a', '#b4533f', '#5a1d14'];
const ESOPHAGUS = ['#f4cdc2', '#e3a99c', '#b77a6e', '#62322b'];
const GASTRIC = ['#e88a79', '#cf6a5b'];
const FIBRIN = '#f1e6c6';
const RIM = '#d23f45';
const HYPEREMIA = '#c42c2c';
const VESSEL = '#7e1214';
const VARIX = ['#b7a7d4', '#7f6ca6', '#54457a'];
const CLOT = '#3d0a0a';
const BLOOD = '#b0101a';

export function recordEgdView(width: number, findings: EgdFindings, seed: number): SkPicture {
  const W = width;
  const g = egdGeometry(findings, seed);
  const X = (v: number) => v * W;

  const pathOf = (pts: readonly Pt[], close = true): SkPath => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(X(pts[0][0]), X(pts[0][1]));
    for (const p of pts.slice(1)) b.lineTo(X(p[0]), X(p[1]));
    if (close) b.close();
    return b.detach();
  };
  const paint = (color: string, o: { alpha?: number; blur?: number; stroke?: number } = {}): SkPaint => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    if (o.alpha !== undefined) p.setAlphaf(o.alpha);
    if (o.blur) p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, o.blur * W, true));
    if (o.stroke) {
      p.setStyle(PaintStyle.Stroke);
      p.setStrokeWidth(o.stroke * W);
      p.setStrokeCap(StrokeCap.Round);
      p.setStrokeJoin(StrokeJoin.Round);
    }
    return p;
  };
  const radial = (c: Pt, r: number, colors: readonly string[], stops?: number[]): SkPaint => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setShader(Skia.Shader.MakeRadialGradient({ x: X(c[0]), y: X(c[1]) }, r * W, colors.map(x => Skia.Color(x)), stops ?? null, TileMode.Clamp));
    return p;
  };

  /** Струйка, которая к концу сужается до `tip` начальной ширины: многоугольник вдоль пути, край чуть неровный. */
  const tapered = (path: readonly Pt[], w0: number, tip: number): SkPath => {
    const left: Pt[] = [], right: Pt[] = [];
    const phase = path[0][0] * 37;
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const d = Math.hypot(dx, dy) || 1;
      const s = i / (path.length - 1);
      const w = (w0 / 2) * (1 - (1 - tip) * s) * (1 + 0.1 * Math.sin(s * 9 + phase));
      left.push([path[i][0] - (dy / d) * w, path[i][1] + (dx / d) * w]);
      right.push([path[i][0] + (dy / d) * w, path[i][1] - (dx / d) * w]);
    }
    return pathOf([...left, ...right.reverse()]);
  };

  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, W));
  c.drawRect(Skia.XYWHRect(0, 0, W, W), paint('#000000'));
  const field = Skia.PathBuilder.Make();
  field.addCircle(X(g.field.c[0]), X(g.field.c[1]), g.field.r * W);
  const fieldPath = field.detach();
  c.save();
  c.clipPath(fieldPath, ClipOp.Intersect, true);

  // 1. Слизистая: свет от торца эндоскопа — к краю темнее; в кардии снаружи — бледный пищевод, внутри зубчатой линии —
  // желудок
  c.drawRect(Skia.XYWHRect(0, 0, W, W), radial(g.light, 0.62, g.view === 'cardia' ? ESOPHAGUS : MUCOSA, [0, 0.35, 0.72, 1]));
  if (g.zline) {
    const inner = radial(g.lumen.c, 0.26, ['#a8443a', GASTRIC[1], GASTRIC[0], rgba(GASTRIC[0], 0.85)], [0, 0.35, 0.8, 1]);
    inner.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 0.008 * W, true));
    c.drawPath(pathOf(g.zline), inner);
  }

  // 1а. Гастрит (часть 53б): антральный отдел краснее вокруг привратника, по стенке — размытые поля покраснения и отёка
  if (g.erythema) {
    c.drawRect(Skia.XYWHRect(0, 0, W, W), radial(g.lumen.c, 0.4, [rgba(HYPEREMIA, 0.42), rgba(HYPEREMIA, 0.24), rgba(HYPEREMIA, 0)], [0, 0.55, 1]));
    for (const e of g.erythema) {
      const patch = radial(e.c, e.r, [rgba(HYPEREMIA, 0.55), rgba(HYPEREMIA, 0.32), rgba(HYPEREMIA, 0)], [0, 0.5, 1]);
      patch.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, e.r * 0.4 * W, true));
      c.drawCircle(X(e.c[0]), X(e.c[1]), e.r * W, patch);
    }
  }

  // 2. Складки: тень от света, гребень светлее; в желудке — шире и мягче
  for (const f of g.folds) {
    const ridge = f.ridge;
    const away = ridge.map(([x, y]): Pt => {
      const dx = x - g.light[0], dy = y - g.light[1];
      const d = Math.hypot(dx, dy) || 1;
      return [x + (dx / d) * f.width * 0.55, y + (dy / d) * f.width * 0.55];
    });
    c.drawPath(pathOf(away, false), paint('#6a241e', { stroke: f.width * 0.8, blur: f.width * 0.4, alpha: 0.42 }));
    c.drawPath(pathOf(ridge, false), paint('#ffc6b0', { stroke: f.width * 0.5, blur: f.width * 0.35, alpha: 0.6 }));
  }

  // 2а. Варикозные вены (часть 54а): синеватые тяжи, выбухающие под бледной слизистой пищевода — тень на дальней от света
  // стороне, тело темнее посередине, по ближней к свету стороне — влажный блеск; красные пятна на них
  if (g.varices) {
    const shift = (path: readonly Pt[], k: number): Pt[] => path.map(([x, y]): Pt => {
      const dx = x - g.light[0], dy = y - g.light[1];
      const d = Math.hypot(dx, dy) || 1;
      return [x + (dx / d) * k, y + (dy / d) * k];
    });
    for (const v of g.varices.cords) {
      c.drawPath(tapered(shift(v.path, v.width * 0.35), v.width * 1.15, v.tip), paint('#3b2230', { blur: v.width * 0.3, alpha: 0.5 }));
      const body = tapered(v.path, v.width, v.tip);
      c.drawPath(body, paint(VARIX[1], { blur: v.width * 0.06 }));
      // выпуклость: дальняя от света половина темнее, ближняя — светлее
      c.drawPath(tapered(shift(v.path, v.width * 0.16), v.width * 0.6, v.tip), paint(VARIX[2], { blur: v.width * 0.18, alpha: 0.7 }));
      c.drawPath(tapered(shift(v.path, -v.width * 0.2), v.width * 0.45, v.tip), paint(VARIX[0], { blur: v.width * 0.16, alpha: 0.75 }));
      c.drawPath(pathOf(shift(v.path, -v.width * 0.26), false), paint('#f5eef9', { stroke: v.width * 0.1, blur: v.width * 0.06, alpha: 0.6 }));
      // край тяжа сливается со слизистой: розоватая кайма
      c.drawPath(body, paint('#d9a3a0', { stroke: v.width * 0.1, blur: v.width * 0.1, alpha: 0.45 }));
    }
    for (const sp of g.varices.spots) c.drawCircle(X(sp.c[0]), X(sp.c[1]), sp.r * W, paint('#c42734', { blur: sp.r * 0.4, alpha: 0.9 }));
  }

  // 3. Просвет вдали — почти чёрный, к краю переходит в стенку
  const lum = radial(g.lumen.c, g.lumen.r * 1.25, ['#0c0303', '#2a0b09', rgba('#5c211b', 0)], [0, 0.6, 1]);
  lum.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 0.008 * W, true));
  c.drawPath(pathOf(g.lumen.outline), lum);

  // 4. Язва: красный отёчный валик, белёсое дно с тёмным краем; в дне — пятна, сосуд или сгусток
  const ul = g.ulcer;
  if (ul) {
    const halo = radial(ul.c, ul.r * 1.75, [rgba(RIM, 0.85), rgba(RIM, 0.75), rgba(RIM, 0)], [0, 0.7, 1]);
    halo.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 0.008 * W, true));
    c.drawPath(pathOf(ul.halo), halo);
    const crater = pathOf(ul.outline);
    // отёчный край — приподнят и светлее, по нему — блеск
    c.drawPath(crater, paint('#f5a196', { stroke: ul.r * 0.3, blur: ul.r * 0.14, alpha: 0.55 }));
    c.drawPath(crater, paint('#8e2621', { stroke: 0.006, blur: 0.003, alpha: 0.8 }));
    const base = radial([ul.c[0], ul.c[1] + ul.r * 0.25], ul.r * 1.15, ['#f6efd9', FIBRIN, '#d6c08f', '#c4a271'], [0, 0.45, 0.85, 1]);
    base.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 0.0025 * W, true));
    c.drawPath(crater, base);
    c.save();
    c.clipPath(crater, ClipOp.Intersect, true);
    // верхний край кратера — в тени: дно ниже слизистой
    const rim: Pt[] = ul.outline.map(([x, y]) => [x, y + ul.r * 0.18]);
    c.drawPath(pathOf(rim), paint('#7a2a22', { stroke: ul.r * 0.32, blur: ul.r * 0.22, alpha: 0.28 }));
    for (const s of ul.spots) c.drawCircle(X(s.c[0]), X(s.c[1]), s.r * W, paint('#5e2b1c', { blur: 0.002, alpha: 0.9 }));
    c.restore();
    if (ul.vessel) {
      const v = ul.vessel;
      c.drawCircle(X(v.c[0]), X(v.c[1]), v.r * W * 1.25, paint('#c9474a', { blur: 0.004, alpha: 0.7 }));
      c.drawCircle(X(v.c[0]), X(v.c[1]), v.r * W, radial(v.c, v.r, ['#b72a2c', VESSEL, '#3e0707'], [0, 0.55, 1]));
      c.drawCircle(X(v.c[0] - v.r * 0.3), X(v.c[1] - v.r * 0.35), v.r * W * 0.28, paint('#ffffff', { alpha: 0.75, blur: 0.0015 }));
    }
    if (ul.clot) {
      c.drawPath(pathOf(ul.clot), paint(CLOT, { blur: 0.0025 }));
      const gl = ul.clot[Math.floor(ul.clot.length * 0.6)];
      c.drawCircle(X(gl[0] * 0.7 + ul.c[0] * 0.3), X(gl[1] * 0.7 + ul.c[1] * 0.3), ul.r * W * 0.12, paint('#a33a36', { alpha: 0.5, blur: 0.004 }));
    }
  }

  // 5. Разрыв: веретено с ярко-красными краями и белёсым дном по оси
  if (g.tear) {
    const t = g.tear;
    const shape = pathOf(t.outline);
    c.drawPath(shape, paint(RIM, { blur: 0.012, alpha: 0.5, stroke: t.width * 1.1 }));
    c.drawPath(shape, paint('#9c1f27', { blur: 0.0025 }));
    c.save();
    c.clipPath(shape, ClipOp.Intersect, true);
    const [a, b] = t.axis;
    const inA: Pt = [a[0] + (b[0] - a[0]) * 0.18, a[1] + (b[1] - a[1]) * 0.18], inB: Pt = [a[0] + (b[0] - a[0]) * 0.82, a[1] + (b[1] - a[1]) * 0.82];
    c.drawPath(pathOf([inA, inB], false), paint(FIBRIN, { stroke: t.width * 0.28, blur: 0.003, alpha: 0.65 }));
    c.restore();
    c.drawPath(shape, paint('#6e1216', { stroke: 0.003, blur: 0.0015, alpha: 0.7 }));
  }

  // 6. Кровь: лужица и струйки, алая, сверху — узкий блик
  if (g.blood) {
    const p = g.blood.pool;
    const cx = p.reduce((a, b) => a + b[0], 0) / p.length, cy = p.reduce((a, b) => a + b[1], 0) / p.length;
    const rr = Math.max(...p.map(q => Math.hypot(q[0] - cx, q[1] - cy)));
    for (const s of g.blood.streams) {
      const shape = tapered(s.path, s.width, s.tip);
      const fill = radial(s.path[0], rr * 2.2, ['#c8141d', BLOOD, '#7a0910'], [0, 0.5, 1]);
      fill.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 0.0025 * W, true));
      c.drawPath(shape, fill);
    }
    const pool = radial([cx, cy - rr * 0.3], rr * 1.3, ['#d81c25', BLOOD, '#7d0a10'], [0, 0.55, 1]);
    pool.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 0.003 * W, true));
    c.drawPath(pathOf(p), pool);
    // блик на крови — пара мазков у верхнего края лужицы
    const x0 = Math.min(...p.map(q => q[0])), x1 = Math.max(...p.map(q => q[0]));
    const y0 = Math.min(...p.map(q => q[1])), y1 = Math.max(...p.map(q => q[1]));
    const bw = x1 - x0, bh = y1 - y0;
    c.drawOval(Skia.XYWHRect(X(x0 + bw * 0.24), X(y0 + bh * 0.14), bw * 0.28 * W, bh * 0.12 * W), paint('#ffffff', { alpha: 0.6, blur: 0.0025 }));
    c.drawOval(Skia.XYWHRect(X(x0 + bw * 0.6), X(y0 + bh * 0.28), bw * 0.13 * W, bh * 0.07 * W), paint('#ffffff', { alpha: 0.45, blur: 0.002 }));
  }

  // 7. Блики влажной слизистой
  for (const b of g.glints) {
    c.save();
    c.translate(X(b.c[0]), X(b.c[1]));
    c.rotate((b.angle * 180) / Math.PI, 0, 0);
    c.drawOval(Skia.XYWHRect(-b.rx * W, -b.ry * W, 2 * b.rx * W, 2 * b.ry * W), paint('#ffffff', { alpha: 0.8, blur: 0.0028 }));
    c.restore();
  }

  // 8. Зерно видеоматрицы — чуть, и тень к краю поля зрения
  // прозрачность зерна — в последней строке матрицы: альфа после фильтра постоянная, прозрачность кисти её не меняет
  const grain = Skia.Paint();
  grain.setShader(Skia.Shader.MakeFractalNoise(0.03, 0.03, 3, seed % 1000, 0, 0));
  grain.setColorFilter(Skia.ColorFilter.MakeMatrix([0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0, 0, 0, 0, 0.35]));
  grain.setBlendMode(BlendMode.Overlay);
  c.drawRect(Skia.XYWHRect(0, 0, W, W), grain);
  c.drawRect(Skia.XYWHRect(0, 0, W, W), radial(g.field.c, g.field.r, [rgba('#000000', 0), rgba('#000000', 0), rgba('#000000', 0.55)], [0, 0.78, 1]));
  c.restore();
  return rec.finishRecordingAsPicture();
}
