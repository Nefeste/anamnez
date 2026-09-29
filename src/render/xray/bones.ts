// Рентген костей, нарисованный кодом (ADR 0013, spec 2026-09-chapter-2, часть 31); геометрия —
// boneGeometry.ts.
//
// Снимок — сумма теней, как грудная клетка и живот: вне тела — чёрное, мягкие ткани серые, кость
// светлая. Кости накладываются режимом Screen — где две кости перекрываются, светлее, как на
// плёнке. У кости — губчатое вещество с мелкой исчерченностью балок, светлая кайма и толстые
// корковые полосы вдоль диафиза. Перелом — две записи кости с обрезкой по сторонам линии: между
// ними тёмный просвет, смещённый отломок нарисован со своим поворотом и сдвигом; где отломки
// заходят друг на друга — светлее. Снимок левой стороны — те же панели, отражённые по горизонтали.
import { BlendMode, BlurStyle, ClipOp, FillType, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, StrokeCap, StrokeJoin, TileMode } from '@shopify/react-native-skia';
import { type Bone, type BoneFindings, boneFilm, type BonePanel, type Move, type Pt } from './boneGeometry';

export type { BoneFindings };

export function recordBoneXray(width: number, findings: BoneFindings, seed: number): SkPicture {
  const film = boneFilm(findings, seed);
  const W = width;
  const H = width * film.aspect;
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, H));

  // все размеры — в долях ширины панели: холст панели масштабирован
  const paint = (color: string, o: { alpha?: number; blend?: BlendMode; blur?: number; stroke?: number } = {}): SkPaint => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    if (o.alpha !== undefined) p.setAlphaf(Math.min(1, Math.max(0, o.alpha)));
    if (o.blend !== undefined) p.setBlendMode(o.blend);
    if (o.blur) p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, o.blur, true));
    if (o.stroke) {
      p.setStyle(PaintStyle.Stroke);
      p.setStrokeWidth(o.stroke);
      p.setStrokeCap(StrokeCap.Round);
      p.setStrokeJoin(StrokeJoin.Round);
    }
    return p;
  };
  const poly = (pts: readonly Pt[], close = true): SkPath => {
    const p = Skia.Path.Make();
    p.moveTo(pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) p.lineTo(q[0], q[1]);
    if (close) p.close();
    return p;
  };
  const withMove = (m: Move | undefined, draw: () => void) => {
    if (!m || (m.angle === 0 && m.dx === 0 && m.dy === 0)) {
      draw();
      return;
    }
    c.save();
    c.translate(m.dx, m.dy);
    c.rotate((m.angle * 180) / Math.PI, m.pivot[0], m.pivot[1]);
    draw();
    c.restore();
  };

  const drawBone = (b: Bone, grainSeed: number) => {
    const path = poly(b.outline);
    for (const h of b.holes) path.addPath(poly(h));
    if (b.holes.length > 0) path.setFillType(FillType.EvenOdd);
    const d = b.density;
    c.save();
    c.clipPath(path, ClipOp.Intersect, true);
    // губчатое вещество
    c.drawPath(path, paint('#8e8e8e', { alpha: 0.5 * d, blend: BlendMode.Screen, blur: 0.002 }));
    // балки — мелкая неровная исчерченность
    const trab = Skia.Paint();
    trab.setShader(Skia.Shader.MakeFractalNoise(38, 38, 2, grainSeed % 1000, 0, 0));
    trab.setAlphaf(0.16 * d);
    trab.setBlendMode(BlendMode.Screen);
    c.drawPath(path, trab);
    // корковые полосы диафиза и замыкательные пластинки
    for (const w of b.walls) c.drawPath(poly(w), paint('#e2e2e2', { alpha: 0.5 * d, blend: BlendMode.Screen, blur: 0.0025 }));
    for (const l of b.lines) c.drawPath(poly(l.pts, l.closed === true), paint('#dedede', { alpha: l.alpha * d, blend: BlendMode.Screen, stroke: l.width, blur: 0.002 }));
    // светлая кайма: обводка вдвое толще, внутренняя половина — внутри обрезки
    c.drawPath(path, paint('#d2d2d2', { alpha: 0.42 * d, blend: BlendMode.Screen, stroke: 0.011, blur: 0.002 }));
    c.restore();
  };

  const drawPanel = (panel: BonePanel, pi: number) => {
    const s = panel.w * W;
    c.save();
    c.translate(panel.x * W, panel.y * W);
    c.scale(s, s);
    c.clipRect(Skia.XYWHRect(0, 0, 1, panel.h), ClipOp.Intersect, true);
    if (film.mirror) {
      c.translate(1, 0);
      c.scale(-1, 1);
    }
    const layer = Skia.Paint();
    layer.setImageFilter(Skia.ImageFilter.MakeBlur(0.0022, 0.0022, TileMode.Clamp, null));
    c.saveLayer(layer);
    if (panel.zoom) {
      c.translate(panel.zoom.dx, panel.zoom.dy);
      c.scale(panel.zoom.k, panel.zoom.k);
    }
    // мягкие ткани: края размыты, толще — светлее
    for (const t of panel.soft) c.drawPath(poly(t.outline), paint('#3e3e3e', { alpha: 0.5 + 0.5 * t.density, blend: BlendMode.Screen, blur: 0.012 }));
    for (const a of panel.air) c.drawPath(poly(a.outline), paint('#0a0a0a', { alpha: a.density, blur: 0.008 }));
    panel.bones.forEach((b, bi) => {
      const grain = pi * 97 + bi * 13 + 7;
      const f = panel.fractures.find(x => x.bone === b.id);
      withMove(panel.carried[b.id], () => {
        if (!f) {
          drawBone(b, grain);
          return;
        }
        c.save();
        c.clipPath(poly(f.fixed), ClipOp.Intersect, true);
        drawBone(b, grain);
        c.restore();
        withMove(f.move, () => {
          c.save();
          c.clipPath(poly(f.moving), ClipOp.Intersect, true);
          drawBone(b, grain);
          c.restore();
        });
      });
    });
    c.restore(); // слой плёнки
    c.restore();
  };

  c.drawRect(Skia.XYWHRect(0, 0, W, H), paint('#000000'));
  film.panels.forEach(drawPanel);

  // зерно плёнки и затемнение краёв
  const grain = Skia.Paint();
  grain.setShader(Skia.Shader.MakeFractalNoise(0.8, 0.8, 2, seed % 1000, 0, 0));
  grain.setAlphaf(0.07);
  grain.setBlendMode(BlendMode.Screen);
  c.drawRect(Skia.XYWHRect(0, 0, W, H), grain);
  const vignette = Skia.Paint();
  vignette.setShader(Skia.Shader.MakeRadialGradient({ x: W / 2, y: H / 2 }, 0.8 * Math.max(W, H), [Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(0,0,0,0.45)')], [0.6, 1], TileMode.Clamp));
  c.drawRect(Skia.XYWHRect(0, 0, W, H), vignette);

  return rec.finishRecordingAsPicture();
}
