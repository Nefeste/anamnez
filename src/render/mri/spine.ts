// МРТ поясничного отдела позвоночника кодом (ADR 0013, spec 2026-10-chapter-4, часть 58а): геометрия — spineGeometry.ts,
// здесь — рисунок, одна запись в SkPicture. Режим T2: ликвор, вода в дисках и жир светлые, костный мозг тел — серый,
// мышцы, связки и обезвоженные диски — тёмные, кровь в аорте и воздух — чёрные.
import { BlendMode, BlurStyle, ClipOp, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, StrokeCap, StrokeJoin, TileMode } from '@shopify/react-native-skia';
import { type Pt, type SpineFindings, spineGeometry } from './spineGeometry';

export type { SpineFindings };

const C = {
  fat: '#b2b2b2',
  skin: '#525252',
  muscle: '#373737',
  marrow: '#6a6a6a',
  cortex: '#151515',
  annulus: '#2b2b2b',
  nucleus: '#e2e2e2',
  nucleusDark: '#434343',
  csf: '#ececec',
  cord: '#5c5c5c',
  root: '#808080',
  ligament: '#1a1a1a',
  epiFat: '#c2c2c2',
  aorta: '#0d0d0d',
  vessel: '#4a4a4a',
  bowelWall: '#3c3c3c',
  fluid: '#d6d6d6',
  gas: '#070707',
  soft: '#646464',
  urine: '#f0f0f0',
  hernia: '#474747',
  vein: '#a6a6a6',
};
/** сила зерна и нерезкость — доли ширины */
const NOISE = 0.09;
const BLUR = 0.0028;

export function recordSpineSlice(width: number, findings: SpineFindings, seed: number): SkPicture {
  const W = width;
  const g = spineGeometry(findings, seed);
  const X = (v: number) => v * W;
  const pathOf = (pts: readonly Pt[], close = true): SkPath => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(X(pts[0][0]), X(pts[0][1]));
    for (const p of pts.slice(1)) b.lineTo(X(p[0]), X(p[1]));
    if (close) b.close();
    return b.detach();
  };
  const paint = (color: string, o: { blur?: number; stroke?: number } = {}): SkPaint => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    if (o.blur) p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, o.blur * W, true));
    if (o.stroke) {
      p.setStyle(PaintStyle.Stroke);
      p.setStrokeWidth(o.stroke * W);
      p.setStrokeCap(StrokeCap.Round);
      p.setStrokeJoin(StrokeJoin.Round);
    }
    return p;
  };
  const ellipsePath = (c: Pt, rx: number, ry: number, angle: number) => {
    const pts: Pt[] = Array.from({ length: 36 }, (_, i) => {
      const t = (i / 36) * 2 * Math.PI;
      const x = rx * Math.cos(t), y = ry * Math.sin(t);
      return [c[0] + x * Math.cos(angle) - y * Math.sin(angle), c[1] + x * Math.sin(angle) + y * Math.cos(angle)];
    });
    return pathOf(pts);
  };

  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, W));
  c.drawRect(Skia.XYWHRect(0, 0, W, W), paint('#000000'));

  const soft = Skia.Paint();
  soft.setImageFilter(Skia.ImageFilter.MakeBlur(BLUR * W, BLUR * W, TileMode.Clamp, null));
  c.saveLayer(soft);

  // 1. Тело — жир; спереди — петли кишки и пузырь, аорта перед телами
  const body = pathOf(g.body);
  c.drawPath(body, paint(C.fat));
  for (const l of g.bowel) c.drawPath(ellipsePath(l.c, l.rx + 0.006, l.ry + 0.006, l.angle), paint(C.bowelWall, { blur: 0.004 }));
  for (const l of g.bowel) {
    const fill = l.content === 'fluid' ? C.fluid : l.content === 'gas' ? C.gas : C.soft;
    c.drawPath(ellipsePath(l.c, l.rx, l.ry, l.angle), paint(fill, { blur: 0.004 }));
  }
  if (g.bladder) {
    const b = pathOf(g.bladder);
    c.drawPath(b, paint(C.bowelWall, { stroke: 0.006 }));
    c.drawPath(b, paint(C.urine, { blur: 0.002 }));
  }
  const aorta = pathOf(g.aorta);
  c.drawPath(aorta, paint(C.aorta));
  c.drawPath(aorta, paint(C.vessel, { stroke: 0.003 }));

  // 2. Сзади: мышцы, канал с жиром, дуги с отростками, задняя стенка крестца, жёлтые связки
  c.drawPath(pathOf(g.muscle), paint(C.muscle, { blur: 0.003 }));
  c.drawPath(pathOf([...g.canal.front, ...[...g.canal.back].reverse()]), paint(C.epiFat));
  for (const s of g.spinous) {
    const p = pathOf(s);
    c.drawPath(p, paint(C.marrow));
    c.drawPath(p, paint(C.cortex, { stroke: 0.004 }));
  }
  const lamina = pathOf(g.sacralLamina);
  c.drawPath(lamina, paint(C.marrow));
  c.drawPath(lamina, paint(C.cortex, { stroke: 0.003 }));
  for (const f of g.flavum) c.drawPath(pathOf(f, false), paint(C.ligament, { stroke: 0.0065 }));

  // 3. Мешок с ликвором, в нём — конец спинного мозга, нить и корешки
  c.drawPath(pathOf(g.sac), paint(C.csf, { blur: 0.0012 }));
  for (const r of g.roots) c.drawPath(pathOf(r, false), paint(C.root, { stroke: 0.0013 }));
  c.drawPath(pathOf(g.filum, false), paint(C.root, { stroke: 0.0012 }));
  c.drawPath(pathOf(g.cord), paint(C.cord, { blur: 0.0012 }));

  // 4. Диски и тела позвонков: фиброзное кольцо тёмное, ядро с водой светлое; костный мозг серый, кортикальный слой —
  // тёмная кайма
  for (const d of g.discs) {
    c.drawPath(pathOf(d.outline), paint(C.annulus));
    if (d.sacral) continue;
    c.drawPath(pathOf(d.nucleus), paint(d.bright ? C.nucleus : C.nucleusDark, { blur: 0.0045 }));
    if (d.cleft) c.drawPath(pathOf(d.cleft, false), paint(C.annulus, { stroke: 0.0022, blur: 0.001 }));
  }
  for (const v of g.vertebrae) {
    const p = pathOf(v.outline);
    const k = Math.round(parseInt(C.marrow.slice(1, 3), 16) + v.tone * 7);
    const hex = k.toString(16).padStart(2, '0');
    c.drawPath(p, paint(`#${hex}${hex}${hex}`));
    if (v.vein) c.drawCircle(X(v.vein[0]), X(v.vein[1]), 0.0055 * W, paint(C.vein, { blur: 0.0025 }));
    c.drawPath(p, paint(C.cortex, { stroke: 0.0035 }));
  }

  // 5. Грыжа — поверх мешка; связки — по задней и передней стенке; кожа
  if (g.hernia) {
    const h = pathOf(g.hernia.outline);
    c.drawPath(h, paint(C.hernia, { blur: 0.0012 }));
    c.drawPath(h, paint(C.annulus, { stroke: 0.0018 }));
  }
  c.drawPath(pathOf(g.pll, false), paint(C.ligament, { stroke: 0.0026 }));
  c.drawPath(pathOf(g.all, false), paint(C.ligament, { stroke: 0.003 }));
  c.drawPath(pathOf(g.skin, false), paint(C.skin, { stroke: 0.005 }));
  c.restore();

  // 6. Зерно — только в теле; воздух остаётся чёрным
  const grain = Skia.Paint();
  grain.setShader(Skia.Shader.MakeFractalNoise(1.5, 1.5, 2, seed % 1000, 0, 0));
  grain.setColorFilter(Skia.ColorFilter.MakeMatrix([0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0, 0, 0, 0, 1]));
  grain.setAlphaf(NOISE);
  grain.setBlendMode(BlendMode.Overlay);
  c.save();
  c.clipPath(body, ClipOp.Intersect, true);
  c.drawRect(Skia.XYWHRect(0, 0, W, W), grain);
  c.restore();
  return rec.finishRecordingAsPicture();
}
