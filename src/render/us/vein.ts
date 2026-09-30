// УЗИ вен ноги кодом (spec 2026-09-chapter-2, часть 33а): геометрия — veinGeometry.ts, здесь —
// рисунок, одна запись в SkPicture. Ткани — серая зернистость, как в секторе (sector.ts):
// клетчатка светлее мышц, жидкость и просвет сосудов чёрные, тромб — серый, кость — светлая дуга
// с тенью. Кадр датчика прямоугольный, сигнал слабеет с глубиной. Над правым кадром — стрелки:
// датчиком давят.
import { BlendMode, BlurStyle, ClipOp, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, StrokeCap, StrokeJoin, TileMode } from '@shopify/react-native-skia';
import { type Oval, PANEL_BOTTOM, PANEL_TOP, type Pt, type VeinFindings, veinGeometry } from './veinGeometry';

export type { VeinFindings };

const SKIN = '#b4b4b4';
const FAT = '#6a6a6a';
const MUSCLE = '#4a4a4a';
const WALL = '#d8d8d8';
const FLUID = '#060606';
const CLOT = '#343434';
const HALO = '#b0b0b0';
const MARK = '#e0c060';

export function recordUsVein(width: number, findings: VeinFindings, seed: number): SkPicture {
  const W = width;
  const g = veinGeometry(findings, seed);
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
  const oval = (o: Oval) => Skia.XYWHRect(X(o.c[0] - o.rx), X(o.c[1] - o.ry), 2 * o.rx * W, 2 * o.ry * W);
  const band = (x0: number, x1: number, y0: number, y1: number) => Skia.XYWHRect(X(x0), X(y0), X(x1 - x0), X(y1 - y0));

  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, W));
  c.drawRect(Skia.XYWHRect(0, 0, W, W), paint('#000000'));

  for (const p of g.panels) {
    const [x0, x1] = p.x;
    const frame = band(x0, x1, PANEL_TOP, PANEL_BOTTOM);
    c.save();
    c.clipRect(frame, ClipOp.Intersect, true);

    // 1. Ткани: мышцы фоном, сверху кожа и клетчатка, между клетчаткой и мышцами — яркая фасция
    c.drawRect(frame, paint(MUSCLE));
    c.drawRect(band(x0, x1, PANEL_TOP, p.skin), paint(SKIN, { blur: 0.003 }));
    c.drawRect(band(x0, x1, p.skin, p.fat), paint(FAT, { blur: 0.004 }));
    for (const [a, b] of p.septa) c.drawLine(X(a[0]), X(a[1]), X(b[0]), X(b[1]), paint(WALL, { stroke: 0.003, alpha: 0.6 }));
    for (const [a, b] of p.fibers) c.drawLine(X(a[0]), X(a[1]), X(b[0]), X(b[1]), paint(WALL, { stroke: 0.003, alpha: 0.35 }));
    c.drawLine(X(x0), X(p.fat), X(x1), X(p.fat), paint(WALL, { stroke: 0.004, alpha: 0.75, blur: 0.001 }));

    // 2. Гематома надрыва — тёмная линза в мышце; воспалённая клетчатка вокруг подкожной вены — светлее
    if (p.tear) c.drawOval(oval(p.tear), paint('#141414', { blur: 0.006 }));
    if (p.gsv.halo) c.drawOval(oval(p.gsv.halo), paint(HALO, { blur: 0.012 }));

    // 3. Кость — тень до низа кадра, дуга светлая
    c.drawPath(pathOf(p.bone.shadow), paint('#000000', { alpha: 0.8, blur: 0.012 }));

    // 4. Просветы: артерия и здоровые вены — чёрные, с тромбом — серые
    c.drawOval(oval(p.gsv), paint(p.gsv.clot ? CLOT : FLUID, { blur: 0.002 }));
    c.drawOval(oval(p.artery), paint(FLUID, { blur: 0.002 }));
    c.drawOval(oval(p.vein), paint(p.vein.clot ? CLOT : FLUID, { blur: 0.002 }));

    // 5. Зернистость — серая, поперёк луча вытянута; на чёрном остаётся чёрным
    const speckle = Skia.Paint();
    speckle.setShader(Skia.Shader.MakeFractalNoise(0.16, 0.42, 3, (seed + (p.pressed ? 7 : 0)) % 1000, 0, 0));
    speckle.setColorFilter(Skia.ColorFilter.MakeMatrix([0.5, 0.5, 0.5, 0, -0.25, 0.5, 0.5, 0.5, 0, -0.25, 0.5, 0.5, 0.5, 0, -0.25, 0, 0, 0, 0, 1]));
    speckle.setBlendMode(BlendMode.Overlay);
    c.drawRect(frame, speckle);

    // 6. Стенки: артерия — яркая, толще; вены — тоньше; дуга кости — ярче всего
    c.drawOval(oval(p.artery), paint(WALL, { stroke: 0.005, blur: 0.001 }));
    c.drawOval(oval(p.vein), paint(WALL, { stroke: p.vein.clot ? 0.0035 : 0.0025, alpha: p.vein.clot ? 0.85 : 0.7, blur: 0.001 }));
    c.drawOval(oval(p.gsv), paint(WALL, { stroke: 0.002, alpha: 0.6, blur: 0.001 }));
    c.drawPath(pathOf(p.bone.arc, false), paint('#f2f2f2', { stroke: 0.007, blur: 0.002 }));

    // 7. С глубиной сигнал слабеет
    const fade = Skia.Paint();
    fade.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: X(PANEL_TOP) }, { x: 0, y: X(PANEL_BOTTOM) }, [Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(0,0,0,0.5)')], [0.35, 1], TileMode.Clamp));
    c.drawRect(frame, fade);
    c.restore();

    // 8. Поверхность датчика — светлая черта над кадром; справа датчиком давят — стрелки вниз
    c.drawLine(X(x0 + 0.01), X(PANEL_TOP - 0.006), X(x1 - 0.01), X(PANEL_TOP - 0.006), paint('#9a9a9a', { stroke: 0.004 }));
    if (p.pressed) {
      for (const k of [0.3, 0.7]) {
        const x = x0 + (x1 - x0) * k;
        c.drawPath(pathOf([[x - 0.018, PANEL_TOP - 0.052], [x + 0.018, PANEL_TOP - 0.052], [x, PANEL_TOP - 0.016]]), paint(MARK));
      }
    }
  }
  return rec.finishRecordingAsPicture();
}
