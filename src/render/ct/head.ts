// Срез головы на КТ и МРТ кодом (ADR 0013, spec 2026-09-ct-mri-ultrasound): геометрия —
// geometry.ts, здесь — рисунок, одна запись в SkPicture. КТ — «мозговое окно»: кость
// белая, серое вещество чуть светлее белого, жидкость тёмная, воздух чёрный. МРТ — режим,
// где очаг светлый на тёмно-сером мозге: кость и жидкость тёмные, известь не видна.
import { BlendMode, BlurStyle, ClipOp, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, StrokeCap, StrokeJoin, TileMode } from '@shopify/react-native-skia';
import { headGeometry, type HeadFindings, type Pt } from './geometry';

export type { HeadFindings };
export type HeadMode = 'ct' | 'mri';

interface Palette {
  scalp: string;
  bone: string;
  csf: string;
  white: string;
  gray: string;
  /** известь; нет — не видна */
  calc?: string;
  high: string;
  low: string;
  /** сила зерна и нерезкость — доли ширины */
  noise: number;
  blur: number;
}

const CT: Palette = { scalp: '#686868', bone: '#f2f2f2', csf: '#222222', white: '#5e5e5e', gray: '#707070', calc: '#e8e8e8', high: '#c6c6c6', low: '#404040', noise: 0.055, blur: 0.0024 };
const MRI: Palette = { scalp: '#2a2a2a', bone: '#0c0c0c', csf: '#101010', white: '#555555', gray: '#626262', high: '#ebebeb', low: '#191919', noise: 0.1, blur: 0.0042 };

/** Цвет `#rrggbb` с прозрачностью — строкой для Skia.Color. */
const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

export function recordHeadSlice(width: number, findings: HeadFindings, seed: number, mode: HeadMode = 'ct'): SkPicture {
  const W = width;
  const g = headGeometry(findings, seed);
  const pal = mode === 'mri' ? MRI : CT;
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

  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, W));
  c.drawRect(Skia.XYWHRect(0, 0, W, W), paint('#000000'));

  // вся анатомия — в слое с лёгкой нерезкостью; зерно ляжет сверху
  const soft = Skia.Paint();
  soft.setImageFilter(Skia.ImageFilter.MakeBlur(pal.blur * W, pal.blur * W, TileMode.Clamp, null));
  c.saveLayer(soft);

  // 1. Мягкие ткани головы и свод: наружная пластинка чуть светлее губчатого слоя
  const head = pathOf(g.head);
  c.drawPath(head, paint(pal.scalp));
  c.drawPath(pathOf(g.skullOuter), paint(pal.bone));
  // 2. Под сводом — жидкость; скопление у свода — между костью и мозгом
  c.drawPath(pathOf(g.skullInner), paint(pal.csf));
  const f = g.focus;
  if (f && (f.shape === 'crescent' || f.shape === 'lens')) {
    c.drawPath(pathOf(f.outline), paint(f.density === 'high' ? pal.high : pal.low, { blur: 0.002 }));
  }

  // 3. Мозг: белое вещество, по краю — кора, в глубине — ядра серого вещества
  const brain = pathOf(g.brain);
  c.drawPath(brain, paint(pal.white));
  c.save();
  c.clipPath(brain, ClipOp.Intersect, true);
  c.drawPath(brain, paint(pal.gray, { stroke: 0.036, blur: 0.005 }));
  for (const d of g.deepGray) c.drawPath(pathOf(d), paint(pal.gray, { blur: 0.005 }));
  // клин — поверх коры и ядер: граница серого и белого в нём стёрта; у коры — сильнее всего,
  // к вершине в глубине — на нет
  if (f?.shape === 'wedge') {
    const color = f.density === 'high' ? pal.high : pal.low;
    const fill = paint(color, { blur: 0.009 });
    fill.setShader(Skia.Shader.MakeRadialGradient(
      { x: X(0.5), y: X(0.5) }, 0.42 * W, [Skia.Color(rgba(color, 0)), Skia.Color(rgba(color, 0.55)), Skia.Color(rgba(color, 0.95))], [0.3, 0.5, 0.8], TileMode.Clamp));
    c.drawPath(pathOf(f.outline), fill);
  }

  // 4. Жидкость: борозды, боковые щели, межполушарная щель с серпом, желудочки
  // борозда сужается вглубь: у поверхности — полная толщина, дальше — тоньше
  for (const s of g.sulci) {
    const half = Math.ceil(s.path.length / 2);
    c.drawPath(pathOf(s.path, false), paint(pal.csf, { stroke: s.width * 0.6, blur: 0.0012 }));
    c.drawPath(pathOf(s.path.slice(0, half), false), paint(pal.csf, { stroke: s.width, blur: 0.0012 }));
  }
  for (const s of g.sylvian) c.drawPath(pathOf(s, false), paint(pal.csf, { stroke: 0.0065, blur: 0.002 }));
  for (const s of g.fissure) {
    c.drawPath(pathOf(s, false), paint(pal.csf, { stroke: 0.008, blur: 0.0015 }));
    c.drawPath(pathOf(s, false), paint(mode === 'mri' ? pal.csf : '#9a9a9a', { stroke: 0.0018 }));
  }
  for (const v of g.ventricles) c.drawPath(pathOf(v), paint(pal.csf, { blur: 0.0015 }));
  if (pal.calc) for (const k of g.calcifications) c.drawCircle(X(k.c[0]), X(k.c[1]), k.r * W, paint(pal.calc, { blur: 0.0015 }));
  // пятно в веществе — поверх: может задеть и желудочек
  if (f?.shape === 'blob') c.drawPath(pathOf(f.outline), paint(f.density === 'high' ? pal.high : pal.low, { blur: 0.003 }));
  c.restore();
  c.restore(); // слой нерезкости

  // 5. Зерно — серое, только в голове; фон остаётся чёрным
  const grain = Skia.Paint();
  grain.setShader(Skia.Shader.MakeFractalNoise(1.6, 1.6, 2, seed % 1000, 0, 0));
  grain.setColorFilter(Skia.ColorFilter.MakeMatrix([0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0, 0, 0, 0, 1]));
  grain.setAlphaf(pal.noise);
  grain.setBlendMode(BlendMode.Overlay);
  c.save();
  c.clipPath(head, ClipOp.Intersect, true);
  c.drawRect(Skia.XYWHRect(0, 0, W, W), grain);
  c.restore();

  return rec.finishRecordingAsPicture();
}
