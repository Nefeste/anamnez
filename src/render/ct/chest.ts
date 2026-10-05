// Срез груди на КТ-ангиографии кодом (spec 2026-10-chapter-3, часть 43а; ADR 0013): геометрия —
// chestGeometry.ts, здесь — рисунок, одна запись в SkPicture. Окно — средостенное: воздух и лёгкие
// чёрные, жир тёмно-серый, мышцы и кровь без контраста серые, контраст в артериях и кость — светлые.
// Отслоённая интима — тонкая тёмная линия поперёк светлого просвета; ложный просвет заполнен
// контрастом чуть хуже — темнее истинного. Тромб в ветви лёгочного ствола (часть 43б) — серая, как
// мышца, полоса внутри светлого контраста: дефект наполнения.
import { BlendMode, BlurStyle, ClipOp, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, StrokeCap, StrokeJoin, TileMode } from '@shopify/react-native-skia';
import { chestGeometry, type ChestCtFindings, type Pt, type Round } from './chestGeometry';

export type { ChestCtFindings };

const C = {
  fat: '#383838',
  muscle: '#757575',
  lung: '#060606',
  lungVessel: '#3c3c3c',
  bone: '#ececec',
  marrow: '#bdbdbd',
  canal: '#676767',
  contrast: '#e6e6e6',
  falseLumen: '#a9a9a9',
  vein: '#c4c4c4',
  air: '#000000',
  esophagus: '#6c6c6c',
  intima: '#4a4a4a',
  clot: '#707070',
};

export function recordChestSlice(width: number, findings: ChestCtFindings, seed: number): SkPicture {
  const W = width;
  const g = chestGeometry(findings, seed);
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
  const round = (o: Round, color: string, blur = 0.0015) => c.drawCircle(X(o.c[0]), X(o.c[1]), o.r * W, paint(color, { blur }));

  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, W));
  c.drawRect(Skia.XYWHRect(0, 0, W, W), paint(C.air));

  // вся анатомия — в слое с лёгкой нерезкостью; зерно ляжет сверху
  const soft = Skia.Paint();
  soft.setImageFilter(Skia.ImageFilter.MakeBlur(0.0022 * W, 0.0022 * W, TileMode.Clamp, null));
  c.saveLayer(soft);

  // 1. Тело: подкожный жир, под ним мышцы груди и спины, внутри — жир средостения и у стенки
  const body = pathOf(g.body);
  c.drawPath(body, paint(C.fat));
  c.drawPath(pathOf(g.muscle), paint(C.muscle, { blur: 0.003 }));
  c.drawPath(pathOf(g.wall), paint(C.fat, { blur: 0.002 }));

  // 2. Рёбра у стенки и грудина спереди — кость с корой светлее середины
  for (const r of g.ribs) {
    c.save();
    c.translate(X(r.c[0]), X(r.c[1]));
    c.rotate((r.angle * 180) / Math.PI, 0, 0);
    c.drawOval(Skia.XYWHRect(-X(r.rx), -X(r.ry), X(2 * r.rx), X(2 * r.ry)), paint(C.bone, { blur: 0.0015 }));
    c.restore();
  }
  const st = g.sternum;
  c.drawOval(Skia.XYWHRect(X(st.c[0] - st.rx), X(st.c[1] - st.ry), X(2 * st.rx), X(2 * st.ry)), paint(C.bone, { blur: 0.0015 }));
  c.drawOval(Skia.XYWHRect(X(st.c[0] - st.rx * 0.7), X(st.c[1] - st.ry * 0.5), X(1.4 * st.rx), X(st.ry)), paint(C.marrow, { blur: 0.002 }));

  // 3. Лёгкие — чёрные, в них тонкие сосуды
  for (const l of g.lungs) {
    const path = pathOf(l);
    c.drawPath(path, paint(C.lung, { blur: 0.0015 }));
    c.save();
    c.clipPath(path, ClipOp.Intersect, true);
    for (const v of g.lungVessels) round(v, C.lungVessel, 0.001);
    c.restore();
  }

  // 4. Позвонок: тело с корой и губчатой серединой, канал со спинным мозгом, остистый отросток
  round(g.vertebra, C.bone);
  round({ c: g.vertebra.c, r: g.vertebra.r * 0.78 }, C.marrow, 0.004);
  c.drawPath(pathOf(g.spinous), paint(C.bone, { blur: 0.002 }));
  // дуга позвонка вокруг канала и мышцы спины по сторонам от остистого отростка
  for (const s of [-1, 1]) c.drawOval(Skia.XYWHRect(X(g.canal.c[0] + s * 0.062 - 0.04), X(g.canal.c[1] - 0.012), X(0.08), X(0.05)), paint(C.muscle, { blur: 0.004 }));
  c.drawPath(pathOf([[g.canal.c[0] - 0.042, g.canal.c[1] - 0.016], [g.canal.c[0] + 0.042, g.canal.c[1] - 0.016], [g.canal.c[0] + 0.026, g.canal.c[1] + 0.026], [g.canal.c[0] - 0.026, g.canal.c[1] + 0.026]]), paint(C.bone, { blur: 0.003 }));
  round(g.canal, C.canal);

  // 5. Средостение: бронхи — воздух, пищевод, верхняя полая вена, лёгочный ствол с ветвями и аорта с
  // контрастом
  for (const b of g.bronchi) {
    round({ c: b.c, r: b.r * 1.25 }, C.muscle);
    round(b, C.air, 0.001);
  }
  round({ c: g.esophagus.c, r: g.esophagus.r * 1.3 }, C.esophagus);
  round({ c: g.esophagus.c, r: g.esophagus.r * 0.3 }, C.air, 0.0008);
  round(g.svc, C.vein);
  for (const br of g.branches) c.drawPath(pathOf(br.path, false), paint(C.contrast, { stroke: br.width, blur: 0.0015 }));
  // тромбы — поверх контраста в ветвях, под стволом и аортой: что ветвь закрыла аорта, закроет и их
  for (const t of g.clots) c.drawPath(pathOf(t.path, false), paint(C.clot, { stroke: t.width, blur: 0.0015 }));
  round(g.trunk, C.contrast);
  for (const v of [g.ascending, g.descending]) {
    // стенка аорты — тонкое серое кольцо вокруг просвета
    round({ c: v.c, r: v.r * 1.08 }, C.muscle);
    round(v, C.contrast);
  }
  // расслоение: ложный просвет темнее, интима — тонкая тёмная линия поперёк
  for (const f of g.flaps) {
    const vessel = f.vessel === 'ascending' ? g.ascending : g.descending;
    c.save();
    c.clipPath(Skia.PathBuilder.Make().addCircle(X(vessel.c[0]), X(vessel.c[1]), vessel.r * W).detach(), ClipOp.Intersect, true);
    c.drawPath(pathOf(f.falseLumen), paint(C.falseLumen, { blur: 0.002 }));
    c.drawPath(pathOf(f.path, false), paint(C.intima, { stroke: 0.0055, blur: 0.0008 }));
    c.restore();
  }
  c.restore(); // слой нерезкости

  // 6. Зерно — серое, только в теле; фон остаётся чёрным
  const grain = Skia.Paint();
  grain.setShader(Skia.Shader.MakeFractalNoise(1.6, 1.6, 2, seed % 1000, 0, 0));
  grain.setColorFilter(Skia.ColorFilter.MakeMatrix([0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0, 0, 0, 0, 1]));
  grain.setAlphaf(0.05);
  grain.setBlendMode(BlendMode.Overlay);
  c.save();
  c.clipPath(body, ClipOp.Intersect, true);
  c.drawRect(Skia.XYWHRect(0, 0, W, W), grain);
  c.restore();

  return rec.finishRecordingAsPicture();
}
