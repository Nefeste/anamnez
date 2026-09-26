// Рентгенограмма грудной клетки кодом (ADR 0013): шаблон с рёбрами, тенью сердца и
// куполами диафрагмы плюс генераторы находок. Правая сторона пациента — слева на снимке.
import { Blur, Canvas, FractalNoise, Group, Oval, Path, Rect, RoundedRect, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';

export interface XrayFindings {
  /** инфильтрат: сторона пациента и насколько плотный (0–1) */
  infiltrate?: { side: 'right' | 'left' | 'both'; density: number };
  hyperinflation?: boolean;
}

export function Xray({ width, findings = {}, seed = 1 }: { width: number; findings?: XrayFindings; seed?: number }) {
  const height = width * 1.1;
  const w = width;
  const h = height;
  const shapes = useMemo(() => {
    const cx = w / 2;
    // Лёгочные поля: правое лёгкое пациента — слева на снимке.
    const lungW = w * (findings.hyperinflation ? 0.3 : 0.28);
    const lungH = h * (findings.hyperinflation ? 0.62 : 0.56);
    const lungs = [
      { x: cx - w * 0.04 - lungW, y: h * 0.14, w: lungW, h: lungH },
      { x: cx + w * 0.04, y: h * 0.14, w: lungW, h: lungH },
    ];
    const ribs: ReturnType<typeof Skia.Path.Make>[] = [];
    for (let k = 0; k < 9; k++) {
      const y = h * 0.16 + k * h * 0.062;
      for (const dir of [-1, 1]) {
        const p = Skia.Path.Make();
        p.moveTo(cx + dir * w * 0.05, y);
        p.cubicTo(cx + dir * w * 0.22, y - h * 0.035, cx + dir * w * 0.36, y + h * 0.01, cx + dir * w * 0.4, y + h * 0.07);
        ribs.push(p);
      }
    }
    // Тень сердца: больше влево от пациента — вправо на снимке.
    const heart = Skia.Path.Make();
    heart.moveTo(cx - w * 0.05, h * 0.36);
    heart.cubicTo(cx - w * 0.12, h * 0.45, cx - w * 0.1, h * 0.66, cx - w * 0.02, h * 0.7);
    heart.cubicTo(cx + w * 0.12, h * 0.74, cx + w * 0.23, h * 0.66, cx + w * 0.2, h * 0.54);
    heart.cubicTo(cx + w * 0.17, h * 0.44, cx + w * 0.06, h * 0.36, cx - w * 0.05, h * 0.36);
    heart.close();
    const domeY = findings.hyperinflation ? h * 0.8 : h * 0.73;
    const dome = Skia.Path.Make();
    dome.moveTo(0, h);
    dome.lineTo(0, domeY + h * 0.03);
    dome.cubicTo(w * 0.15, domeY - h * 0.05, w * 0.4, domeY - h * 0.04, cx, domeY + h * 0.02);
    dome.cubicTo(w * 0.6, domeY - h * 0.02, w * 0.85, domeY - h * 0.03, w, domeY + h * 0.04);
    dome.lineTo(w, h);
    dome.close();
    // Инфильтрат — пятно в нижнем поле нужной стороны.
    const spots: { x: number; y: number; rx: number; ry: number }[] = [];
    const inf = findings.infiltrate;
    if (inf) {
      const sides = inf.side === 'both' ? [0, 1] : [inf.side === 'right' ? 0 : 1];
      for (const s of sides) {
        const L = lungs[s];
        // Латеральнее тени сердца: слева на снимке сердце почти не заходит в поле, справа — заходит.
        spots.push({ x: L.x + L.w * (s === 0 ? 0.12 : 0.3), y: L.y + L.h * 0.58, rx: L.w * 0.32, ry: L.h * 0.18 });
      }
    }
    return { lungs, ribs, heart, dome, spots, cx };
  }, [w, h, findings]);

  const density = findings.infiltrate?.density ?? 0;
  return (
    <Canvas style={{ width: w, height: h }}>
      <Rect x={0} y={0} width={w} height={h} color="#050505" />
      {/* мягкие ткани грудной клетки */}
      <Group>
        <RoundedRect x={w * 0.06} y={h * 0.05} width={w * 0.88} height={h * 0.95} r={w * 0.2} color="#5A5A5A" />
        <Blur blur={w * 0.02} />
      </Group>
      {/* воздух в лёгких темнее мягких тканей */}
      <Group>
        {shapes.lungs.map((L, i) => (
          <Oval key={i} x={L.x} y={L.y} width={L.w} height={L.h} color="#1B1B1B" />
        ))}
        <Blur blur={w * 0.025} />
      </Group>
      {/* позвоночник и средостение */}
      <Group>
        <Rect x={shapes.cx - w * 0.045} y={0} width={w * 0.09} height={h} color="#9A9A9A" opacity={0.55} />
        <Blur blur={w * 0.012} />
      </Group>
      {/* рёбра */}
      <Group opacity={0.5}>
        {shapes.ribs.map((p, i) => (
          <Path key={i} path={p} style="stroke" strokeWidth={w * 0.018} color="#CFCFCF" />
        ))}
        <Blur blur={w * 0.006} />
      </Group>
      {/* инфильтрат */}
      {shapes.spots.length > 0 && (
        <Group opacity={0.55 + 0.4 * density}>
          {shapes.spots.map((s, i) => (
            <Oval key={i} x={s.x} y={s.y} width={s.rx * 2} height={s.ry * 2} color="#E6E6E6" />
          ))}
          <Blur blur={w * 0.028} />
        </Group>
      )}
      {/* сердце и диафрагма — самые плотные тени */}
      <Group>
        <Path path={shapes.heart} color="#E3E3E3" />
        <Path path={shapes.dome} color="#EDEDED" />
        <Blur blur={w * 0.01} />
      </Group>
      {/* зерно плёнки */}
      <Rect x={0} y={0} width={w} height={h} opacity={0.12}>
        <FractalNoise freqX={0.9} freqY={0.9} octaves={2} seed={seed % 100} />
      </Rect>
    </Canvas>
  );
}
