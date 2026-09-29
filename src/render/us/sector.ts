// Сектор УЗИ кодом (ADR 0013, spec 2026-09-ct-mri-ultrasound, часть 21): геометрия —
// geometry.ts, здесь — рисунок, одна запись в SkPicture. Ткань — серая зернистость: кожа и
// жир светлее, мышцы и кора почки темнее печени, синус почки светлый; жидкость — чёрная.
// С глубиной сигнал слабеет. За плотной точкой — тень, за жидкостью — светлее. В подвздошной
// области (часть 29) — петли кишки с газом и грязной тенью, сосуды и отросток «мишенью».
import { BlendMode, BlurStyle, ClipOp, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, StrokeCap, StrokeJoin, TileMode } from '@shopify/react-native-skia';
import { APEX, HALF, polar, type Pt, R0, R1, ray, type UsFindings, usGeometry } from './geometry';

export type { UsFindings };

const SKIN = '#9a9a9a';
const MUSCLE = '#4a4a4a';
const LIVER = '#707070';
const FAT = '#9c9c9c';
const PYRAMID = '#3a3a3a';
const CORTEX = '#555555';
const SINUS = '#bdbdbd';
const WALL = '#d8d8d8';
const FLUID = '#060606';
const BOWEL = '#7c7c7c';
const LOOP = '#666666';
const MUSCULARIS = '#2c2c2c';
const SUBMUCOSA = '#c9c9c9';
const HALO = '#b3b3b3';

export function recordUsSector(width: number, findings: UsFindings, seed: number): SkPicture {
  const W = width;
  const g = usGeometry(findings, seed);
  const X = (v: number) => v * W;

  const pathOf = (pts: readonly Pt[], close = true): SkPath => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(X(pts[0][0]), X(pts[0][1]));
    for (const p of pts.slice(1)) b.lineTo(X(p[0]), X(p[1]));
    if (close) b.close();
    return b.detach();
  };
  const paint = (color: string, o: { alpha?: number; blur?: number; stroke?: number; blend?: BlendMode } = {}): SkPaint => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    if (o.alpha !== undefined) p.setAlphaf(o.alpha);
    if (o.blend !== undefined) p.setBlendMode(o.blend);
    if (o.blur) p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, o.blur * W, true));
    if (o.stroke) {
      p.setStyle(PaintStyle.Stroke);
      p.setStrokeWidth(o.stroke * W);
      p.setStrokeCap(StrokeCap.Round);
      p.setStrokeJoin(StrokeJoin.Round);
    }
    return p;
  };
  /** Кольцевой отрезок сектора между двумя глубинами. */
  const band = (ra: number, rb: number, n = 40): SkPath => {
    const near = Array.from({ length: n + 1 }, (_, i) => ray(-HALF - 0.05 + ((2 * HALF + 0.1) * i) / n, ra));
    const far = Array.from({ length: n + 1 }, (_, i) => ray(HALF + 0.05 - ((2 * HALF + 0.1) * i) / n, rb));
    return pathOf([...near, ...far]);
  };
  const arc = (r: number, n = 40): SkPath => pathOf(Array.from({ length: n + 1 }, (_, i) => ray(-HALF - 0.05 + ((2 * HALF + 0.1) * i) / n, r)), false);

  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, W));
  c.drawRect(Skia.XYWHRect(0, 0, W, W), paint('#000000'));

  const sector = pathOf(g.sector);
  c.save();
  c.clipPath(sector, ClipOp.Intersect, true);

  // 1. Ткани: печень — фоном (в подвздошной области — брыжейка и кишка), сверху кожа и мышцы стенки с яркими фасциями
  c.drawPath(sector, paint(g.view === 'appendix' ? BOWEL : LIVER));
  c.drawPath(band(R0, g.skin), paint(SKIN, { blur: 0.004 }));
  c.drawPath(band(g.skin, g.wall), paint(MUSCLE, { blur: 0.004 }));
  for (const r of [g.skin, g.wall, (g.skin + g.wall) / 2]) c.drawPath(arc(r), paint(WALL, { stroke: r === (g.skin + g.wall) / 2 ? 0.002 : 0.004, alpha: 0.7, blur: 0.002 }));

  // 2. Почка под печенью: ниже края печени — светлый жир, почка — темнее печени, синус — светлый
  if (g.kidney && g.liverBottom) {
    const lb = g.liverBottom;
    const below = pathOf([ray(-HALF - 0.1, polar(lb[0]).r), ...lb, ray(HALF + 0.1, polar(lb[lb.length - 1]).r), ray(HALF + 0.1, R1 + 0.05), ray(-HALF - 0.1, R1 + 0.05)]);
    c.drawPath(below, paint(FAT, { blur: 0.006 }));
    c.drawPath(pathOf(g.kidney), paint(CORTEX, { blur: 0.005 }));
    c.drawPath(pathOf(g.kidney), paint(WALL, { stroke: 0.005, blur: 0.002 }));
    for (const py of g.pyramids ?? []) c.drawPath(pathOf(py), paint(PYRAMID, { blur: 0.006 }));
    if (g.sinus) c.drawPath(pathOf(g.sinus), paint(SINUS, { blur: 0.008 }));
    // край печени — яркая линия капсулы
    c.drawPath(pathOf(lb, false), paint(WALL, { stroke: 0.003, alpha: 0.7, blur: 0.002 }));
  }

  // 2б. Подвздошная область: петли кишки, в глубине — сосуды; вокруг воспалённого отростка — светлый отёчный жир
  for (const l of g.loops ?? []) c.drawPath(pathOf(l.wall), paint(LOOP, { blur: 0.006 }));
  for (const v of g.vessels ?? []) c.drawCircle(X(v.c[0]), X(v.c[1]), v.r * W, paint(FLUID, { blur: 0.003 }));
  if (g.halo) c.drawPath(pathOf(g.halo), paint(HALO, { blur: 0.018 }));
  if (g.target) {
    // «мишень»: мышечный слой — тёмное кольцо, подслизистый — светлое, просвет — тёмный
    c.drawPath(pathOf(g.target[1]), paint(MUSCULARIS, { blur: 0.003 }));
    c.drawPath(pathOf(g.target[2]), paint(SUBMUCOSA, { blur: 0.003 }));
    c.drawPath(pathOf(g.target[3]), paint(FLUID, { blur: 0.003 }));
  }

  // 2в. Утолщённая стенка пузыря (часть 30): яркая, посередине — тёмная полоска отёка
  if (g.gbWall) {
    c.drawPath(pathOf(g.gbWall[0]), paint(SUBMUCOSA, { blur: 0.004 }));
    c.drawPath(pathOf(g.gbWall[1]), paint(MUSCULARIS, { blur: 0.004 }));
  }

  // 3. Жидкость — чёрная: полость пузыря, полоса у органа, расширенная лоханка
  if (g.gallbladder) c.drawPath(pathOf(g.gallbladder), paint(FLUID, { blur: 0.002 }));
  if (g.fluid) c.drawPath(pathOf(g.fluid), paint(FLUID, { blur: 0.003 }));
  for (const part of g.pelvisParts ?? []) c.drawPath(pathOf(part), paint(FLUID, { blur: 0.003 }));

  // 4. Зернистость — серая, поперёк луча вытянута; на чёрном остаётся чёрным
  const speckle = Skia.Paint();
  speckle.setShader(Skia.Shader.MakeFractalNoise(0.16, 0.42, 3, seed % 1000, 0, 0));
  speckle.setColorFilter(Skia.ColorFilter.MakeMatrix([0.5, 0.5, 0.5, 0, -0.25, 0.5, 0.5, 0.5, 0, -0.25, 0.5, 0.5, 0.5, 0, -0.25, 0, 0, 0, 0, 1]));
  speckle.setBlendMode(BlendMode.Overlay);
  c.drawRect(Skia.XYWHRect(0, 0, W, W), speckle);

  // 5. Стенка пузыря — тонкая яркая; за пузырём — светлее, за точками — тень
  if (g.gallbladder) c.drawPath(pathOf(g.gallbladder), paint(WALL, { stroke: 0.005, blur: 0.002 }));
  // кишка: стенка — тонкая яркая, газ — ярче всего, под газом — грязная (не чёрная) тень
  for (const l of g.loops ?? []) {
    c.drawPath(pathOf(l.shadow), paint('#000000', { alpha: 0.45, blur: 0.02 }));
    c.drawPath(pathOf(l.wall), paint(WALL, { stroke: 0.003, alpha: 0.75, blur: 0.002 }));
    c.drawPath(pathOf(l.gas, false), paint('#ffffff', { stroke: 0.008, blur: 0.003 }));
  }
  for (const v of g.vessels ?? []) c.drawCircle(X(v.c[0]), X(v.c[1]), v.r * W, paint(WALL, { stroke: 0.003, alpha: 0.6, blur: 0.002 }));
  if (g.target) c.drawPath(pathOf(g.target[0]), paint(WALL, { stroke: 0.004, blur: 0.002 }));
  if (g.enhancement) c.drawPath(pathOf(g.enhancement), paint('#ffffff', { alpha: 0.24, blur: 0.02, blend: BlendMode.Screen }));
  for (const k of g.foci) c.drawPath(pathOf(k.shadow), paint('#000000', { alpha: 0.85, blur: 0.01 }));
  // точка — яркая дуга: светится поверхность, обращённая к датчику, за ней — уже тень
  for (const k of g.foci) {
    const top = Skia.PathBuilder.Make();
    const toApex = Math.atan2(APEX[1] - k.c[1], APEX[0] - k.c[0]) * (180 / Math.PI);
    top.arcToOval(Skia.XYWHRect(X(k.c[0] - k.r), X(k.c[1] - k.r), 2 * k.r * W, 2 * k.r * W), toApex - 80, 160, true);
    c.drawPath(top.detach(), paint('#ffffff', { stroke: k.r * 0.9, blur: 0.002 }));
    c.drawCircle(X(k.c[0]), X(k.c[1]), k.r * W * 0.8, paint('#bdbdbd', { alpha: 0.55, blur: 0.004 }));
  }

  // 6. С глубиной сигнал слабеет
  const fade = Skia.Paint();
  fade.setShader(Skia.Shader.MakeRadialGradient({ x: X(APEX[0]), y: X(APEX[1]) }, R1 * W, [Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(0,0,0,0.55)')], [0.45, 1], TileMode.Clamp));
  c.drawRect(Skia.XYWHRect(0, 0, W, W), fade);
  c.restore();

  // 7. Шкала глубины справа: деление — десятая доля глубины, крупное — каждое пятое
  const tick = paint('#cfcfcf', { stroke: 0.003 });
  const skinY = APEX[1] + R0;
  for (let i = 1; i <= 9; i++) {
    const y = skinY + (i * (R1 - R0)) / 10;
    c.drawLine(X(i % 5 === 0 ? 0.955 : 0.97), X(y), X(0.985), X(y), tick);
  }
  // метка фокуса — треугольник на середине глубины
  const fy = skinY + (R1 - R0) * 0.45;
  const focus = pathOf([[0.945, fy - 0.012], [0.945, fy + 0.012], [0.93, fy]]);
  c.drawPath(focus, paint('#e0c060'));
  // край сектора сверху — дуга датчика
  c.drawPath(arc(R0 - 0.002, 40), paint('#9a9a9a', { stroke: 0.002, alpha: 0.6 }));

  return rec.finishRecordingAsPicture();
}
