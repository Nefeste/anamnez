// Кривая ЭКГ под названием игры в «Мониторе» (spec 2026-09-own-look, часть 25): ровная линия
// и один удар — зубец P, комплекс QRS, зубец T. Не бежит и не мигает: вид не торопит. Холст в
// меню один, поэтому WebGL он держит, а не отдаёт после рисунка, как снимки в списках.
// На экране загрузки (spec 2026-10-premium-polish) по той же кривой бежит отрезок: `start` и `end` —
// доли пути, общие значения Reanimated.
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import type { SharedValue } from 'react-native-reanimated';

/** Точки кривой в долях: x — ширины, y — вверх от базовой линии в долях высоты. */
const BEAT: [number, number, 'L' | 'Q', number?, number?][] = [
  [0.3, 0, 'L'],
  // зубец P — пологий
  [0.36, 0, 'Q', 0.33, 0.22],
  [0.41, 0, 'L'],
  // QRS: вниз, высоко вверх, глубоко вниз
  [0.425, -0.16, 'L'],
  [0.45, 0.56, 'L'],
  [0.475, -0.32, 'L'],
  [0.49, 0, 'L'],
  [0.55, 0, 'L'],
  // зубец T — шире и выше P
  [0.65, 0, 'Q', 0.6, 0.3],
  [1, 0, 'L'],
];

/** Путь кривой в холсте `width` × `height`: базовая линия — на 0,62 высоты. */
export function ecgPath(width: number, height: number) {
  const base = height * 0.62;
  const y = (up: number) => base - up * height;
  const p = Skia.PathBuilder.Make();
  p.moveTo(0, base);
  for (const [x, up, kind, cx, cup] of BEAT) {
    if (kind === 'Q') p.quadTo((cx ?? x) * width, y(cup ?? 0), x * width, y(up));
    else p.lineTo(x * width, y(up));
  }
  return p.detach();
}

export function EcgLine({ width, height, color, start, end, strokeWidth = 2 }: {
  width: number; height: number; color: string; start?: SharedValue<number>; end?: SharedValue<number>; strokeWidth?: number;
}) {
  const path = useMemo(() => ecgPath(width, height), [width, height]);
  return (
    <Canvas style={{ width, height }}>
      <Path path={path} style="stroke" strokeWidth={strokeWidth} strokeJoin="round" strokeCap="round" color={color} start={start ?? 0} end={end ?? 1} />
    </Canvas>
  );
}
