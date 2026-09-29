// Обзорная рентгенограмма живота стоя, нарисованная кодом (ADR 0013, spec 2026-09-chapter-2,
// часть 30б); геометрия — abdomenGeometry.ts.
//
// Снимок — сумма теней, как грудная клетка (chest.ts): воздух чёрный, мягкие ткани серые, кость
// светлая. Кости накладываются режимом Screen; газ в кишке и под диафрагмой — тёмными пятнами
// поверх мягких тканей. Стоя газ всегда сверху: граница с жидкостью в желудке и в раздутых петлях
// — ровная горизонтальная линия. Правая сторона пациента — слева на снимке.
import { BlendMode, BlurStyle, ClipOp, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, type SkRRect, StrokeCap, StrokeJoin, TileMode } from '@shopify/react-native-skia';
import { Rng } from '@/engine/core/rng';
import { ABDOMEN_ASPECT, type AbdomenFindings, abdomenGeometry, colonAt, domeY, loopFolds, loopGas, loopLevels, type Pt } from './abdomenGeometry';

export type { AbdomenFindings };
export { ABDOMEN_ASPECT };

export function recordAbdomenXray(width: number, findings: AbdomenFindings, seed: number): SkPicture {
  const W = width;
  const H = width * ABDOMEN_ASPECT;
  const X = (x: number) => x * W;
  const Y = (y: number) => y * H;
  const g = abdomenGeometry(findings, seed);
  const rng = Rng.seeded(seed).fork('abdomen-film');
  const u = () => rng.int(1000) / 1000;

  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, H));

  const paint = (color: string, o: { alpha?: number; blend?: BlendMode; blur?: number; stroke?: number } = {}): SkPaint => {
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
  const poly = (pts: readonly Pt[], close = true): SkPath => {
    const p = Skia.Path.Make();
    p.moveTo(X(pts[0][0]), Y(pts[0][1]));
    for (const q of pts.slice(1)) p.lineTo(X(q[0]), Y(q[1]));
    if (close) p.close();
    return p;
  };
  /** Эллипс многоугольником: центр в долях кадра, полуоси — доли ширины (круг остаётся кругом), поворот. */
  const oval = (cx: number, cy: number, rx: number, ry: number, rot = 0): SkPath => {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const pts: Pt[] = Array.from({ length: 28 }, (_, i) => {
      const t = (i / 28) * 2 * Math.PI;
      const x = rx * Math.cos(t), y = ry * Math.sin(t);
      return [cx + x * cs - y * sn, cy + (x * sn + y * cs) / ABDOMEN_ASPECT];
    });
    return poly(pts);
  };
  /** Кость: полупрозрачное тело и светлый кортикальный край. */
  const bone = (outline: SkPath, alpha: number, edge = 0.5) => {
    c.drawPath(outline, paint('#8c8c8c', { alpha: alpha * 0.6, blend: BlendMode.Screen, blur: 0.003 }));
    c.drawPath(outline, paint('#d0d0d0', { alpha: alpha * edge, blend: BlendMode.Screen, stroke: 0.0035, blur: 0.0025 }));
  };
  const boneRR = (rr: SkRRect, alpha: number) => {
    c.drawRRect(rr, paint('#8c8c8c', { alpha: alpha * 0.6, blend: BlendMode.Screen, blur: 0.003 }));
    c.drawRRect(rr, paint('#d0d0d0', { alpha: alpha * 0.45, blend: BlendMode.Screen, stroke: 0.0035, blur: 0.0025 }));
  };

  /** Лента кости по кривой: ширина от w0 к w1 (доли ширины) — замкнутый контур, как в chest.ts. */
  const ribbon = (pts: Pt[], w0: number, w1: number): SkPath => {
    const upper: Pt[] = [], lower: Pt[] = [];
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = (b[0] - a[0]) * W, dy = (b[1] - a[1]) * H;
      const l = Math.hypot(dx, dy) || 1;
      const half = ((w0 + (w1 - w0) * (i / (pts.length - 1))) * W) / 2;
      upper.push([p[0] + (-dy / l) * half / W, p[1] + (dx / l) * half / H]);
      lower.push([p[0] - (-dy / l) * half / W, p[1] - (dx / l) * half / H]);
    });
    return poly([...upper, ...lower.reverse()]);
  };
  /** Точки кубической кривой Безье. */
  const bezier = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): Pt[] => Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, v = 1 - t;
    return [v * v * v * p0[0] + 3 * v * v * t * p1[0] + 3 * v * t * t * p2[0] + t * t * t * p3[0], v * v * v * p0[1] + 3 * v * v * t * p1[1] + 3 * v * t * t * p2[1] + t * t * t * p3[1]];
  });

  // 1. Фон — воздух вокруг тела; всё тело — в слое с лёгкой нерезкостью плёнки.
  c.drawRect(Skia.XYWHRect(0, 0, W, H), paint('#000000'));
  const film = Skia.Paint();
  film.setImageFilter(Skia.ImageFilter.MakeBlur(0.0025 * W, 0.0025 * W, TileMode.Clamp, null));
  c.saveLayer(film);

  // 2. Мягкие ткани живота: бока почти у краёв кадра, книзу шире — к бёдрам.
  const body = Skia.Path.Make();
  body.moveTo(X(0.06), 0);
  body.cubicTo(X(0.035), Y(0.25), X(0.03), Y(0.55), X(0.02), Y(0.8));
  body.lineTo(X(0), Y(1.02));
  body.lineTo(X(1), Y(1.02));
  body.lineTo(X(0.98), Y(0.8));
  body.cubicTo(X(0.97), Y(0.55), X(0.965), Y(0.25), X(0.94), 0);
  body.close();
  const bodyPaint = paint('#707070', { blur: 0.008 });
  bodyPaint.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: 0, y: H }, [Skia.Color('#646464'), Skia.Color('#747474'), Skia.Color('#6e6e6e')], [0, 0.6, 1], TileMode.Clamp));
  c.drawPath(body, bodyPaint);
  c.save();
  c.clipPath(body, ClipOp.Intersect, true);
  // к бокам тело тоньше — снимок темнее; посередине толще всего
  const sides = paint('#000000');
  sides.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: W, y: 0 },
    [Skia.Color('rgba(0,0,0,0.5)'), Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(0,0,0,0.5)')], [0, 0.2, 0.8, 1], TileMode.Clamp));
  c.drawRect(Skia.XYWHRect(0, 0, W, H), sides);
  // предбрюшинный жир по бокам — тёмные полоски вдоль стенки
  for (const s of [-1, 1]) {
    const x = (d: number) => 0.5 + s * d;
    c.drawPath(poly([[x(0.425), 0.32], [x(0.435), 0.46], [x(0.44), 0.6], [x(0.435), 0.7]], false), paint('#2e2e2e', { alpha: 0.3, stroke: 0.006, blur: 0.005 }));
  }

  // 3. Печень под правым куполом — чуть плотнее; почки и края поясничных мышц — еле видны.
  c.drawPath(poly(g.liver), paint('#b0b0b0', { alpha: 0.1, blend: BlendMode.Screen, blur: 0.025 }));
  for (const [cx, cy, rot] of [[0.37, 0.37, 0.25], [0.63, 0.34, -0.25]] as const) {
    c.drawPath(oval(cx, cy, 0.048, 0.085, rot), paint('#a0a0a0', { alpha: 0.07, blend: BlendMode.Screen, blur: 0.012 }));
  }
  for (const s of [-1, 1]) {
    const x = (d: number) => 0.5 + s * d;
    c.drawPath(poly([[x(0.045), 0.27], [x(0.09), 0.48], [x(0.135), 0.68]], false), paint('#3a3a3a', { alpha: 0.2, stroke: 0.006, blur: 0.006 }));
  }

  // 4. Основания лёгких над куполами — чёрные; между ними — тень сердца и средостения: справа
  // край почти прямой, слева сердце спускается к куполу дугой.
  for (const s of [-1, 1] as const) {
    const [x0, x1] = s === -1 ? [0.065, 0.455] : [0.6, 0.935];
    const pts: Pt[] = [];
    for (let i = 0; i <= 30; i++) {
      const x = x0 + ((x1 - x0) * i) / 30;
      pts.push([x, domeY(x)]);
    }
    const inner: Pt[] = s === -1 ? [[0.455, domeY(0.455)], [0.45, 0.08], [0.44, -0.01]] : [[0.6, domeY(0.6)], [0.57, 0.1], [0.55, 0.04], [0.545, -0.01]];
    const outline: Pt[] = s === -1 ? [[0.085, -0.01], ...pts, ...inner] : [...inner.slice().reverse(), ...pts, [0.915, -0.01]];
    const lp = paint('#101010', { blur: 0.004 });
    lp.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: 0, y: Y(0.2) }, [Skia.Color('#242424'), Skia.Color('#101010')], null, TileMode.Clamp));
    c.drawPath(poly(outline), lp);
  }

  // 5. Желудок: газ под левым куполом, внизу — горизонтальный уровень.
  c.drawPath(poly(g.stomach.gas), paint('#222222', { alpha: 0.85, blur: 0.004 }));

  // 6. Ободочная кишка: газ отрезками — просвет из вздутий-гаустр, между ними перегородки не на
  // весь просвет; в слепой и восходящей — каловые массы: мелкие пузырьки газа в сером.
  for (const k of g.colon) {
    // просвет — сплошной столб газа, по краям — вздутия гаустр
    c.drawPath(poly(k.pts, false), paint('#262626', { alpha: 0.6, stroke: k.width * 0.8, blur: 0.006 }));
    const every = Math.max(2, Math.round(k.pts.length / Math.max(1, k.septa.length / 2 + 1)));
    for (let i = 0; i + 1 < k.pts.length; i += every) {
      const j = Math.min(k.pts.length - 1, i + every);
      const [a, b] = [k.pts[i], k.pts[j]];
      const len = Math.hypot(b[0] - a[0], (b[1] - a[1]) * ABDOMEN_ASPECT);
      const rot = Math.atan2((b[1] - a[1]) * ABDOMEN_ASPECT, b[0] - a[0]);
      const r = (k.width / 2) * (0.9 + 0.2 * u());
      c.drawPath(oval((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, len / 2 + r * 0.2, r, rot), paint('#242424', { alpha: 0.45, blur: 0.006 }));
    }
    for (const [p, q] of k.septa) c.drawPath(poly([p, q], false), paint('#8a8a8a', { alpha: 0.22, blend: BlendMode.Screen, stroke: 0.004, blur: 0.0025 }));
  }
  for (let i = 0; i < 40; i++) {
    const [cx, cy] = colonAt(0.01 + 0.17 * u());
    c.drawPath(oval(cx + (u() - 0.5) * 0.028, cy + (u() - 0.5) * 0.018, 0.003 + 0.004 * u(), 0.003 + 0.003 * u()), paint('#2c2c2c', { alpha: 0.4, blur: 0.0018 }));
  }
  // содержимое кишок — неровная пятнистость мягких тканей
  for (let i = 0; i < 18; i++) {
    const cx = 0.3 + 0.4 * u(), cy = 0.35 + 0.4 * u();
    c.drawPath(oval(cx, cy, 0.03 + 0.04 * u(), 0.02 + 0.03 * u(), u() * 3), paint(u() < 0.5 ? '#3a3a3a' : '#9a9a9a', { alpha: 0.06, blend: u() < 0.5 ? BlendMode.SrcOver : BlendMode.Screen, blur: 0.02 }));
  }

  // 7. Раздутые петли тонкой кишки: газ «аркой», поперёк — складки на весь просвет, внизу —
  // ровный уровень жидкости; под уровнем петля не видна, как мягкие ткани.
  for (const l of g.loops) {
    const gasPath = poly(loopGas(l));
    c.drawPath(gasPath, paint('#1c1c1c', { alpha: 0.88, blur: 0.0025 }));
    c.save();
    c.clipPath(gasPath, ClipOp.Intersect, true);
    for (const [p, q] of loopFolds(l)) c.drawPath(poly([p, q], false), paint('#9a9a9a', { alpha: 0.28, blend: BlendMode.Screen, stroke: 0.0025, blur: 0.0015 }));
    // стенка петли — светлее по контуру газа
    c.drawPath(gasPath, paint('#8a8a8a', { alpha: 0.35, blend: BlendMode.Screen, stroke: 0.005, blur: 0.002 }));
    c.restore();
    // уровни: резкая светлая черта — граница газа и жидкости
    for (const [y, xa, xb] of loopLevels(l)) c.drawPath(poly([[xa, y], [xb, y]], false), paint('#b4b4b4', { alpha: 0.6, blend: BlendMode.Screen, stroke: 0.003 }));
  }

  // 8. Свободный газ: серп под правым куполом — между полоской диафрагмы и печенью.
  if (g.crescent) c.drawPath(poly(g.crescent), paint('#0c0c0c', { alpha: 0.95, blur: 0.002 }));

  // 9. Кости. Нижние рёбра — задние отрезки лентами: от позвоночника в стороны и вниз, у бока
  // загибаются книзу; двенадцатое — короткое и круче всех. К концам тают.
  for (const s of [-1, 1]) {
    const x = (d: number) => 0.5 + s * d;
    for (const [y0, reach, drop, w] of [[-0.02, 0.4, 0.26, 0.026], [0.06, 0.29, 0.17, 0.022], [0.145, 0.17, 0.11, 0.018]] as const) {
      const pts = bezier([x(0.055), y0], [x(0.055 + reach * 0.45), y0 + drop * 0.02], [x(0.055 + reach * 0.85), y0 + drop * 0.4], [x(0.055 + reach), y0 + drop], 22);
      const outline = ribbon(pts, w * 0.8, w);
      const body = paint('#8c8c8c', { alpha: 0.2, blend: BlendMode.Screen, blur: 0.003 });
      const edge = paint('#cfcfcf', { alpha: 0.16, blend: BlendMode.Screen, stroke: 0.0025, blur: 0.002 });
      const fade = (rgb: string) => Skia.Shader.MakeLinearGradient({ x: X(x(0.055 + reach * 0.5)), y: Y(y0) }, { x: X(x(0.055 + reach)), y: Y(y0 + drop) },
        [Skia.Color(`rgba(${rgb},1)`), Skia.Color(`rgba(${rgb},0)`)], null, TileMode.Clamp);
      body.setShader(fade('140,140,140'));
      edge.setShader(fade('207,207,207'));
      c.drawPath(outline, body);
      c.drawPath(outline, edge);
    }
  }
  // позвонки Th11–L5: тело с замыкательными пластинками, корни дужек «глазками», поперечные
  // отростки, остистый — каплей посередине
  boneRR(Skia.RRectXY(Skia.XYWHRect(X(0.452), Y(0.07), X(0.096), Y(0.072)), X(0.01), X(0.01)), 0.2);
  g.vertebrae.forEach((v, i) => {
    boneRR(Skia.RRectXY(Skia.XYWHRect(X(0.5 - v.half), Y(v.y), X(2 * v.half), Y(v.h)), X(0.01), X(0.01)), 0.5);
    for (const s of [-1, 1]) {
      c.drawPath(oval(0.5 + s * (v.half - 0.017), v.y + 0.024, 0.008, 0.013), paint('#d8d8d8', { alpha: 0.28, blend: BlendMode.Screen, stroke: 0.003, blur: 0.002 }));
      if (i > 0) {
        const reach = [0, 0.05, 0.065, 0.078, 0.065, 0.058][i];
        const x0 = s === -1 ? 0.5 - v.half - reach + 0.008 : 0.5 + v.half - 0.008;
        boneRR(Skia.RRectXY(Skia.XYWHRect(X(x0), Y(v.y + 0.03), X(reach), Y(0.014)), X(0.006), X(0.006)), 0.28);
      }
    }
    c.drawPath(oval(0.5, v.y + 0.05, 0.007, 0.018), paint('#c8c8c8', { alpha: 0.2, blend: BlendMode.Screen, blur: 0.003 }));
  });
  // крестец с отверстиями; крылья подвздошных костей: плотный гребень на уровне L4, тонкое крыло,
  // пограничная линия входа в таз, внизу — вертлужные впадины с головками бёдер и лобковые кости
  const sacrum = poly([[0.438, 0.69], [0.562, 0.69], [0.548, 0.79], [0.52, 0.9], [0.48, 0.9], [0.452, 0.79]]);
  bone(sacrum, 0.3);
  for (let k = 0; k < 3; k++) {
    for (const s of [-1, 1]) c.drawPath(oval(0.5 + s * (0.03 - k * 0.004), 0.725 + k * 0.045, 0.007, 0.007), paint('#303030', { alpha: 0.35, blur: 0.002 }));
  }
  for (const s of [-1, 1]) {
    const x = (d: number) => 0.5 + s * d;
    // крыло: от крестцово-подвздошного сочленения — гребень, передняя верхняя ость, наружный
    // край вниз к вертлужной впадине, крыша впадины, большая седалищная вырезка обратно к крестцу
    const wing = Skia.Path.Make();
    wing.moveTo(X(x(0.062)), Y(0.69));
    wing.cubicTo(X(x(0.1)), Y(0.6), X(x(0.2)), Y(0.53), X(x(0.3)), Y(0.545));
    wing.cubicTo(X(x(0.36)), Y(0.555), X(x(0.395)), Y(0.6), X(x(0.385)), Y(0.645));
    wing.cubicTo(X(x(0.37)), Y(0.71), X(x(0.335)), Y(0.8), X(x(0.335)), Y(0.9));
    wing.quadTo(X(x(0.265)), Y(0.86), X(x(0.2)), Y(0.9));
    wing.cubicTo(X(x(0.18)), Y(0.83), X(x(0.1)), Y(0.8), X(x(0.065)), Y(0.77));
    wing.close();
    // крыло тонкое посередине: плотнее у вертлужной впадины и у крестца
    const wp = paint('#8c8c8c', { alpha: 0.2, blend: BlendMode.Screen, blur: 0.004 });
    wp.setShader(Skia.Shader.MakeRadialGradient({ x: X(x(0.22)), y: Y(0.88) }, 0.28 * W,
      [Skia.Color('rgba(150,150,150,1)'), Skia.Color('rgba(150,150,150,0.35)')], null, TileMode.Clamp));
    c.drawPath(wing, wp);
    c.drawPath(wing, paint('#d0d0d0', { alpha: 0.06, blend: BlendMode.Screen, stroke: 0.0035, blur: 0.0025 }));
    // гребень — плотный край крыла
    const crest = Skia.Path.Make();
    crest.moveTo(X(x(0.07)), Y(0.68));
    crest.cubicTo(X(x(0.11)), Y(0.6), X(x(0.2)), Y(0.535), X(x(0.3)), Y(0.548));
    crest.cubicTo(X(x(0.36)), Y(0.558), X(x(0.39)), Y(0.6), X(x(0.382)), Y(0.64));
    c.drawPath(crest, paint('#d4d4d4', { alpha: 0.3, blend: BlendMode.Screen, stroke: 0.008, blur: 0.004 }));
    // пограничная линия входа в таз: от сочленения дугой вниз к лобку
    const brim = Skia.Path.Make();
    brim.moveTo(X(x(0.07)), Y(0.745));
    brim.cubicTo(X(x(0.16)), Y(0.77), X(x(0.21)), Y(0.85), X(x(0.19)), Y(0.93));
    brim.quadTo(X(x(0.14)), Y(0.985), X(x(0.03)), Y(0.975));
    c.drawPath(brim, paint('#cfcfcf', { alpha: 0.22, blend: BlendMode.Screen, stroke: 0.006, blur: 0.003 }));
    // верхняя ветвь лобковой кости — к симфизу у нижнего края
    const ramus = ribbon(bezier([x(0.21), 0.925], [x(0.15), 0.95], [x(0.08), 0.975], [x(0.02), 0.99], 14), 0.03, 0.026);
    bone(ramus, 0.3, 0.3);
    // головка бедра под крышей впадины
    c.drawPath(oval(x(0.268), 0.955, 0.056, 0.056), paint('#9a9a9a', { alpha: 0.32, blend: BlendMode.Screen, blur: 0.004 }));
    c.drawPath(oval(x(0.268), 0.955, 0.056, 0.056), paint('#d0d0d0', { alpha: 0.24, blend: BlendMode.Screen, stroke: 0.004, blur: 0.002 }));
    const roof = Skia.Path.Make();
    roof.moveTo(X(x(0.2)), Y(0.905));
    roof.quadTo(X(x(0.268)), Y(0.862), X(x(0.338)), Y(0.905));
    c.drawPath(roof, paint('#d8d8d8', { alpha: 0.32, blend: BlendMode.Screen, stroke: 0.006, blur: 0.003 }));
  }
  c.restore(); // тело
  c.restore(); // слой плёнки

  // 10. Зерно плёнки и затемнение краёв.
  const grain = Skia.Paint();
  grain.setShader(Skia.Shader.MakeFractalNoise(0.8, 0.8, 2, seed % 1000, 0, 0));
  grain.setAlphaf(0.07);
  grain.setBlendMode(BlendMode.Screen);
  c.drawRect(Skia.XYWHRect(0, 0, W, H), grain);
  const vignette = Skia.Paint();
  vignette.setShader(Skia.Shader.MakeRadialGradient({ x: X(0.5), y: Y(0.5) }, 0.85 * W, [Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(0,0,0,0.5)')], [0.6, 1], TileMode.Clamp));
  c.drawRect(Skia.XYWHRect(0, 0, W, H), vignette);

  return rec.finishRecordingAsPicture();
}
