// Рентгенограмма грудной клетки в прямой проекции, нарисованная кодом (ADR 0013).
//
// Снимок — сумма теней: воздух чёрный, мягкие ткани серые, кость светлая. Поэтому
// кости и сосуды накладываются режимом Screen (перекрытия светлеют, как на плёнке), а
// сердце и средостение — одним силуэтом, который снизу сливается с тенью живота. Правая
// сторона пациента — слева на снимке. Координаты — доли ширины (x) и высоты (y).
import { BlendMode, BlurStyle, ClipOp, PaintStyle, Skia, type SkPaint, type SkPath, type SkPicture, StrokeCap, TileMode } from '@shopify/react-native-skia';
import { Rng } from '@/engine/core/rng';

export interface XrayFindings {
  /** инфильтрат: сторона пациента и насколько плотный (0–1) */
  infiltrate?: { side: 'right' | 'left' | 'both'; density: number };
  /** эмфизема: низкие плоские купола, узкое «капельное» сердце, лёгкие прозрачнее */
  hyperinflation?: boolean;
}

export const XRAY_ASPECT = 1.1;

/** Сторона на снимке: −1 — правая сторона пациента (слева), +1 — левая. */
type Side = -1 | 1;
type Pt = [number, number];

/** Точки кубической кривой Безье. */
function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

export function recordChestXray(width: number, findings: XrayFindings, seed: number): SkPicture {
  const W = width;
  const H = width * XRAY_ASPECT;
  const X = (x: number) => x * W;
  const Y = (y: number) => y * H;
  const emph = findings.hyperinflation === true;
  const rng = Rng.seeded(seed).fork('xray');
  const jitter = (amp: number) => ((rng.int(1000) / 1000) - 0.5) * 2 * amp;

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
    }
    return p;
  };
  const mirror = (x: number, s: Side) => (s === -1 ? x : 1 - x);

  /**
   * Лента кости по кривой: ширина меняется от w0 к w1 (в долях ширины снимка). Возвращает
   * замкнутый контур — его заливают телом кости и обводят светлым кортикальным слоем.
   */
  const ribbon = (pts: Pt[], w0: number, w1: number): SkPath => {
    const upper: Pt[] = [], lower: Pt[] = [];
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = (b[0] - a[0]) * W, dy = (b[1] - a[1]) * H;
      const l = Math.hypot(dx, dy) || 1;
      const half = ((w0 + (w1 - w0) * (i / (pts.length - 1))) * W) / 2;
      const nx = (-dy / l) * half, ny = (dx / l) * half;
      upper.push([X(p[0]) + nx, Y(p[1]) + ny]);
      lower.push([X(p[0]) - nx, Y(p[1]) - ny]);
    });
    const path = Skia.Path.Make();
    path.moveTo(upper[0][0], upper[0][1]);
    for (const q of upper.slice(1)) path.lineTo(q[0], q[1]);
    for (const q of lower.reverse()) path.lineTo(q[0], q[1]);
    path.close();
    return path;
  };
  /** Кость: мягкая полоса с чуть более светлыми краями; fade — затухание к концу. */
  const bone = (outline: SkPath, alpha: number, fade?: [Pt, Pt]) => {
    const body = paint('#909090', { alpha: alpha * 0.75, blend: BlendMode.Screen, blur: 0.003 });
    const edge = paint('#cfcfcf', { alpha: alpha * 0.55, blend: BlendMode.Screen, stroke: 0.0028, blur: 0.0022 });
    if (fade) {
      // тот же цвет, что без затухания, только прозрачность уходит в ноль к концу
      const g = (rgb: string) => Skia.Shader.MakeLinearGradient(
        { x: X(fade[0][0]), y: Y(fade[0][1]) }, { x: X(fade[1][0]), y: Y(fade[1][1]) },
        [Skia.Color(`rgba(${rgb},1)`), Skia.Color(`rgba(${rgb},0)`)], null, TileMode.Clamp);
      body.setShader(g('144,144,144'));
      edge.setShader(g('207,207,207'));
    }
    c.drawPath(outline, body);
    c.drawPath(outline, edge);
  };

  // 1. Фон и мягкие ткани туловища: шея, надплечья, боковые стенки. Вся анатомия — в
  // слое с лёгкой нерезкостью, как на плёнке; зерно ляжет сверху резким.
  c.drawRect(Skia.XYWHRect(0, 0, W, H), paint('#000000'));
  const film = Skia.Paint();
  film.setImageFilter(Skia.ImageFilter.MakeBlur(0.0025 * W, 0.0025 * W, TileMode.Clamp, null));
  c.saveLayer(film);
  const body = Skia.Path.Make();
  body.moveTo(X(0.4), Y(0));
  body.cubicTo(X(0.36), Y(0.05), X(0.2), Y(0.035), X(0.05), Y(0.075));
  body.cubicTo(X(0.015), Y(0.1), X(0.02), Y(0.4), X(0.03), Y(0.7));
  body.lineTo(X(0.05), Y(1.02));
  body.lineTo(X(0.95), Y(1.02));
  body.lineTo(X(0.97), Y(0.7));
  body.cubicTo(X(0.98), Y(0.4), X(0.985), Y(0.1), X(0.95), Y(0.075));
  body.cubicTo(X(0.8), Y(0.035), X(0.64), Y(0.05), X(0.6), Y(0));
  body.close();
  const bodyPaint = paint('#555555', { blur: 0.01 });
  bodyPaint.setShader(Skia.Shader.MakeLinearGradient(
    { x: 0, y: 0 }, { x: 0, y: H }, [Skia.Color('#4a4a4a'), Skia.Color('#5c5c5c')], null, TileMode.Clamp));
  c.drawPath(body, bodyPaint);

  c.save();
  c.clipPath(body, ClipOp.Intersect, true);
  // головки плечевых костей в верхних углах
  for (const s of [-1, 1] as Side[]) {
    c.drawCircle(X(0.5 + s * 0.5), Y(0.07), 0.08 * W, paint('#8a8a8a', { alpha: 0.5, blend: BlendMode.Screen, blur: 0.006 }));
  }

  // 2. Живот под куполами: печень справа, селезёнка и желудок слева. Сверху граница идёт
  // под лёгкими, к боковым стенкам спускается до уровня синусов — без полосы через стенку.
  const domeR = emph ? 0.7 : 0.625; // вершина правого купола; левый ниже на 0,03
  const domeL = domeR + 0.03;
  const belly = Skia.Path.Make();
  belly.moveTo(X(0.02), Y(domeR + 0.2));
  belly.cubicTo(X(0.08), Y(domeR + 0.14), X(0.12), Y(domeR - 0.02), X(0.3), Y(domeR - 0.02));
  belly.lineTo(X(0.7), Y(domeL - 0.02));
  belly.cubicTo(X(0.88), Y(domeL - 0.02), X(0.92), Y(domeL + 0.14), X(0.98), Y(domeL + 0.2));
  belly.lineTo(X(0.98), Y(1.05));
  belly.lineTo(X(0.02), Y(1.05));
  belly.close();
  const bellyPaint = paint('#9a9a9a', { blur: 0.02 });
  bellyPaint.setShader(Skia.Shader.MakeLinearGradient(
    { x: 0, y: Y(domeR) }, { x: 0, y: H }, [Skia.Color('#a2a2a2'), Skia.Color('#7c7c7c')], null, TileMode.Clamp));
  c.drawPath(belly, bellyPaint);
  // газовый пузырь желудка под левым куполом, внизу — горизонтальный уровень жидкости
  const bubble = Skia.Path.Make();
  const bx = 0.7, by = domeL + 0.1;
  bubble.moveTo(X(bx - 0.07), Y(by));
  bubble.cubicTo(X(bx - 0.075), Y(by - 0.07), X(bx + 0.07), Y(by - 0.075), X(bx + 0.075), Y(by));
  bubble.close();
  c.drawPath(bubble, paint('#3c3c3c', { alpha: 0.8, blur: 0.008 }));
  c.restore();

  // 3. Лёгкие: верхушки, боковые стенки, острые синусы, купола диафрагмы. Внутренний
  // край уходит за средостение — видимую границу даст силуэт сердца.
  const lung = (s: Side): SkPath => {
    const dome = s === -1 ? domeR : domeL;
    const wide = emph ? 0.012 : 0;
    const m = (x: number) => mirror(x, s);
    const p = Skia.Path.Make();
    p.moveTo(X(m(0.47)), Y(0.13));
    p.cubicTo(X(m(0.45)), Y(0.07), X(m(0.34)), Y(0.06), X(m(0.265)), Y(0.1));
    p.cubicTo(X(m(0.17 - wide)), Y(0.16), X(m(0.115 - wide)), Y(0.34), X(m(0.11 - wide)), Y(0.55));
    p.quadTo(X(m(0.108 - wide)), Y(dome + 0.05), X(m(0.12 - wide)), Y(dome + 0.125)); // синус
    if (emph) {
      p.cubicTo(X(m(0.18)), Y(dome + 0.04), X(m(0.3)), Y(dome), X(m(0.4)), Y(dome + 0.01));
    } else {
      p.cubicTo(X(m(0.16)), Y(dome + 0.06), X(m(0.23)), Y(dome), X(m(0.31)), Y(dome));
      p.quadTo(X(m(0.4)), Y(dome + 0.003), X(m(0.48)), Y(dome + 0.07));
    }
    p.lineTo(X(m(0.49)), Y(dome + 0.08));
    p.lineTo(X(m(0.49)), Y(0.3));
    p.close();
    return p;
  };
  const lungs = { [-1]: lung(-1), [1]: lung(1) } as Record<Side, SkPath>;
  const both = Skia.Path.Make();
  both.addPath(lungs[-1]);
  both.addPath(lungs[1]);
  c.drawPath(both, paint(emph ? '#0b0b0b' : '#191919', { blur: 0.006 }));

  c.save();
  c.clipPath(both, ClipOp.Intersect, true);
  // к периферии и к основаниям поля светлеют: сверху — мышцы, снизу — мягкие ткани
  const halo = paint('#000000', { blend: BlendMode.Screen });
  halo.setShader(Skia.Shader.MakeRadialGradient(
    { x: X(0.5), y: Y(0.4) }, 0.47 * W, [Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(80,80,80,0.6)')], [0.5, 1], TileMode.Clamp));
  c.drawRect(Skia.XYWHRect(0, 0, W, H), halo);

  // 4. Сосудистый рисунок: толще у корней, тает к наружной трети; внизу заметнее (стоя
  // кровоток больше в нижних отделах).
  const hila: Record<Side, Pt> = { [-1]: [0.43, 0.41], [1]: [0.58, 0.38] };
  const vessel = (s: Side, root: Pt, x: number, y: number, ang: number, len: number, w: number, depth: number) => {
    const a = ang + jitter(0.18);
    const x2 = x + s * Math.cos(a) * len;
    const y2 = y + Math.sin(a) * len * 0.95;
    const far = Math.hypot(x2 - root[0], (y2 - root[1]) * 1.1);
    if (far > 0.3) return;
    const p = Skia.Path.Make();
    p.moveTo(X(x), Y(y));
    const bend = jitter(len * 0.12);
    p.quadTo(X((x + x2) / 2 + bend), Y((y + y2) / 2 - bend), X(x2), Y(y2));
    const lower = Math.max(0, Math.min(1, (y2 - 0.3) / 0.35));
    const alpha = (0.42 - depth * 0.07) * (0.75 + 0.45 * lower) * (1 - far * 2) * (emph ? 0.6 : 1);
    if (alpha > 0.02) c.drawPath(p, paint('#a8a8a8', { alpha, blend: BlendMode.Screen, stroke: w, blur: w * 0.6 }));
    if (depth < 4) {
      const spread = 0.28 + (rng.int(1000) / 1000) * 0.22;
      vessel(s, root, x2, y2, a - spread, len * 0.72, w * 0.68, depth + 1);
      vessel(s, root, x2, y2, a + spread, len * 0.72, w * 0.68, depth + 1);
    }
  };
  for (const s of [-1, 1] as Side[]) {
    const root = hila[s];
    // стволы выходят из корня веером, не из одной точки: иначе в корне — яркая звезда
    for (const ang of [-1.25, -0.8, -0.35, 0.1, 0.55, 0.95, 1.3]) {
      const sx = root[0] + s * Math.cos(ang) * 0.018, sy = root[1] + Math.sin(ang) * 0.03;
      vessel(s, root, sx, sy, ang, 0.07, 0.012, 0);
    }
  }

  // 5. Инфильтрат: облако из сливающихся пятен в нижней доле, внутри — воздушные
  // бронхограммы. Доходит до купола и «стирает» его контур (симптом силуэта).
  const inf = findings.infiltrate;
  if (inf) {
    const sides: Side[] = inf.side === 'both' ? [-1, 1] : [inf.side === 'right' ? -1 : 1];
    const d = Math.max(0, Math.min(1, inf.density));
    for (const s of sides) {
      const dome = s === -1 ? domeR : domeL;
      const cx = mirror(s === -1 ? 0.26 : 0.24, s);
      const cy = dome - 0.06;
      c.save();
      c.clipPath(lungs[s], ClipOp.Intersect, true);
      const n = Math.round(12 + 10 * d);
      for (let i = 0; i < n; i++) {
        const ox = jitter(0.1);
        const oy = jitter(0.08) + 0.012;
        const r = 0.03 + (rng.int(1000) / 1000) * 0.045;
        c.drawOval(Skia.XYWHRect(X(cx + ox - r), Y(cy + oy - r * 0.8), X(2 * r), Y(1.6 * r)),
          paint('#b8b8b8', { alpha: 0.12 + 0.22 * d, blend: BlendMode.Screen, blur: 0.018 }));
      }
      if (d > 0.4) {
        for (let k = 0; k < 3; k++) {
          const p = Skia.Path.Make();
          const sx = cx - s * 0.06 + jitter(0.02);
          const sy = cy - 0.05 + k * 0.03;
          p.moveTo(X(sx), Y(sy));
          p.quadTo(X(sx + s * 0.05), Y(sy + 0.02), X(sx + s * 0.1), Y(sy + 0.05 + k * 0.01));
          c.drawPath(p, paint('#1a1a1a', { alpha: 0.45 * d, stroke: 0.007, blur: 0.002 }));
        }
      }
      c.restore();
    }
  }
  c.restore();

  // корни лёгких плотнее: там крупные артерии и бронхи
  for (const s of [-1, 1] as Side[]) {
    const [hx0, hy0] = hila[s];
    c.drawOval(Skia.XYWHRect(X(hx0 - 0.035), Y(hy0 - 0.06), X(0.07), Y(0.12)), paint('#9a9a9a', { alpha: 0.32, blend: BlendMode.Screen, blur: 0.018 }));
  }

  // 6. Рёбра. Задний отрезок идёт от позвоночника почти горизонтально, выгибается вверх и
  // загибается по боковой стенке; передний — от стенки косо вниз к середине и тает у
  // хряща. Ребро шире к боку, у позвоночника — уже.
  const ribs: { path: SkPath; alpha: number; fade?: [Pt, Pt] }[] = [];
  const step = emph ? 0.064 : 0.058;
  for (let r = 1; r <= 10; r++) {
    const y0 = 0.105 + (r - 1) * step + jitter(0.003);
    const reach = 0.19 + 0.2 * (1 - Math.exp(-r / 2.2)) + (emph ? 0.01 : 0) + jitter(0.004);
    for (const s of [-1, 1] as Side[]) {
      const x = (d: number) => 0.5 + s * d;
      const back = [
        ...bezier([x(0.038), y0], [x(0.13), y0 - 0.024], [x(reach - 0.04), y0 - 0.014], [x(reach), y0 + 0.04], 18),
        ...bezier([x(reach), y0 + 0.04], [x(reach + 0.01), y0 + 0.07], [x(reach + 0.005), y0 + 0.095], [x(reach - 0.008), y0 + 0.118], 8).slice(1),
      ];
      // у позвоночника ребро тает: его перекрывают поперечные отростки и мышцы спины
      ribs.push({ path: ribbon(back, 0.011, 0.02), alpha: r > 8 ? 0.22 : 0.32, fade: [[x(0.16), y0], [x(0.035), y0]] });
      if (r <= 7) {
        const a: Pt = [x(reach - 0.008), y0 + 0.118];
        const b: Pt = [x(0.13 + r * 0.004), y0 + 0.235];
        const front = bezier(a, [x(reach - 0.07), y0 + 0.135], [x(0.22), y0 + 0.2], b, 18);
        ribs.push({ path: ribbon(front, 0.024, 0.02), alpha: 0.16, fade: [[x(reach - 0.1), y0 + 0.15], b] });
      }
    }
  }
  // ключицы: от грудины в стороны и вверх, S-образно, у грудины толще
  for (const s of [-1, 1] as Side[]) {
    const x = (d: number) => 0.5 + s * d;
    const pts = bezier([x(0.04), 0.132], [x(0.15), 0.15], [x(0.24), 0.06], [x(0.36), 0.082], 24);
    ribs.push({ path: ribbon(pts, 0.03, 0.024), alpha: 0.42 });
    // закруглённые концы — акромиальный и грудинный (толще): только заливка, без края
    for (const [ex, ey, rw, rh] of [[x(0.36), 0.082, 0.016, 0.013], [x(0.04), 0.132, 0.017, 0.017]]) {
      c.drawOval(Skia.XYWHRect(X(ex) - rw * W, Y(ey) - rh * W, 2 * rw * W, 2 * rh * W),
        paint('#909090', { alpha: 0.3, blend: BlendMode.Screen, blur: 0.003 }));
    }
  }
  c.save();
  c.clipPath(body, ClipOp.Intersect, true);
  for (const b of ribs) bone(b.path, b.alpha, b.fade);
  c.restore();

  // 7. Средостение и сердце одним силуэтом: справа — верхняя полая вена и правое
  // предсердие, слева — дуга аорты, лёгочный ствол, ушко, левый желудочек до верхушки.
  // Кладётся поверх рёбер чуть прозрачным: сквозь тень сердца рёбра видны еле-еле.
  const heart = Skia.Path.Make();
  const k = emph ? 0.82 : 1; // «капельное» сердце при эмфиземе — уже
  const hx = (x: number) => X(0.52 + (x - 0.52) * k);
  const lo = emph ? 0.06 : 0; // и ниже вместе с куполами
  heart.moveTo(X(0.44), 0);
  heart.cubicTo(X(0.44), Y(0.12), X(0.443), Y(0.28), hx(0.447), Y(0.4));
  heart.cubicTo(hx(0.427), Y(0.46 + lo / 2), hx(0.395), Y(0.54 + lo), hx(0.405), Y(0.62 + lo));
  heart.cubicTo(hx(0.41), Y(0.67 + lo), hx(0.44), Y(0.71 + lo), hx(0.47), Y(0.725 + lo));
  heart.lineTo(hx(0.66), Y(0.745 + lo));
  heart.quadTo(hx(0.705), Y(0.75 + lo), hx(0.725), Y(0.71 + lo));
  heart.cubicTo(hx(0.75), Y(0.645 + lo), hx(0.735), Y(0.53 + lo), hx(0.655), Y(0.47 + lo / 2));
  heart.quadTo(hx(0.625), Y(0.445), hx(0.618), Y(0.41));
  heart.quadTo(hx(0.63), Y(0.38), hx(0.608), Y(0.35));
  heart.quadTo(X(0.59), Y(0.335), X(0.598), Y(0.31));
  heart.cubicTo(X(0.611), Y(0.29), X(0.607), Y(0.248), X(0.576), Y(0.236));
  heart.cubicTo(X(0.565), Y(0.2), X(0.565), Y(0.09), X(0.565), 0);
  heart.close();
  const heartPaint = paint('#909090', { alpha: 0.86, blur: 0.004 });
  heartPaint.setShader(Skia.Shader.MakeLinearGradient(
    { x: 0, y: 0 }, { x: 0, y: Y(0.76) }, [Skia.Color('#595959'), Skia.Color('#6c6c6c'), Skia.Color('#7e7e7e'), Skia.Color('#949494')], [0, 0.18, 0.55, 1], TileMode.Clamp));
  c.drawPath(heart, heartPaint);

  // трахея и главные бронхи — полоса воздуха в средостении; левый бронх длиннее и положе
  const airway = Skia.Path.Make();
  airway.moveTo(X(0.497), 0);
  airway.lineTo(X(0.497), Y(0.285));
  airway.quadTo(X(0.482), Y(0.325), X(0.452), Y(0.365));
  airway.moveTo(X(0.499), Y(0.285));
  airway.quadTo(X(0.522), Y(0.325), X(0.572), Y(0.35));
  c.drawPath(airway, paint('#3a3a3a', { alpha: 0.75, stroke: 0.036, blur: 0.007 }));

  // 8. Позвонки еле видны сквозь тень сердца и средостения; ниже купола — отчётливее.
  const vertH = 0.042, gap = 0.011;
  for (let y = 0.0; y < 1; y += vertH + gap) {
    const behind = y > 0.2 && y < domeR + 0.1 ? 0.5 : 1;
    const rr = Skia.RRectXY(Skia.XYWHRect(X(0.465), Y(y), X(0.07), Y(vertH)), X(0.012), X(0.012));
    c.drawRRect(rr, paint('#8c8c8c', { alpha: 0.1 * behind, blend: BlendMode.Screen, blur: 0.004 }));
    c.drawRRect(rr, paint('#b0b0b0', { alpha: 0.1 * behind, blend: BlendMode.Screen, stroke: 0.003, blur: 0.003 }));
  }

  c.restore(); // слой плёнки

  // 9. Зерно плёнки и затемнение краёв.
  const grain = Skia.Paint();
  grain.setShader(Skia.Shader.MakeFractalNoise(0.8, 0.8, 2, seed % 1000, 0, 0));
  grain.setAlphaf(0.07);
  grain.setBlendMode(BlendMode.Screen);
  c.drawRect(Skia.XYWHRect(0, 0, W, H), grain);
  const vignette = Skia.Paint();
  vignette.setShader(Skia.Shader.MakeRadialGradient(
    { x: X(0.5), y: Y(0.45) }, 0.8 * W, [Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(0,0,0,0.55)')], [0.6, 1], TileMode.Clamp));
  c.drawRect(Skia.XYWHRect(0, 0, W, H), vignette);

  return rec.finishRecordingAsPicture();
}
