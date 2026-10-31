// Знак студии и полоса-рушник для «Об игре» (брендбук студии, ADR 0017): рисунок — тот же, что на сайте gornitsa.games,
// кодом из крестиков; узор и нити — в brand.ts.
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { BAND, BAND_CELL, MARK, RUSHNIK_HEIGHT, type Stitch, stitchesOf, THREADS } from './brand';

/** Крестики — две диагонали в клетке с полями; нить кумача и ели — отдельными путями. */
function paths(stitches: readonly Stitch[], cell: number, inset: number) {
  const b = { x: Skia.PathBuilder.Make(), o: Skia.PathBuilder.Make() };
  for (const { col, row, thread } of stitches) {
    const [x0, y0, x1, y1] = [col * cell + inset, row * cell + inset, (col + 1) * cell - inset, (row + 1) * cell - inset];
    b[thread].moveTo(x0, y0);
    b[thread].lineTo(x1, y1);
    b[thread].moveTo(x1, y0);
    b[thread].lineTo(x0, y1);
  }
  return { x: b.x.detach(), o: b.o.detach() };
}

/** Знак студии: `size` — сторона квадрата, px; меньше 16 крестики сливаются (брендбук). */
export function StudioMark({ size, dark }: { size: number; dark: boolean }) {
  const threads = dark ? THREADS.dark : THREADS.light;
  // 28 единиц знака на сторону
  const k = size / 28;
  const p = useMemo(() => paths(stitchesOf(MARK, 7), 4 * k, 0.9 * k), [k]);
  return (
    <Canvas style={{ width: size, height: size }}>
      <Path path={p.x} style="stroke" strokeWidth={1.3 * k} strokeCap="round" color={threads.kumach} />
      <Path path={p.o} style="stroke" strokeWidth={1.3 * k} strokeCap="round" color={threads.spruce} />
    </Canvas>
  );
}

/** Полоса-рушник: узор повторяется по ширине и обрезается по краю. */
export function Rushnik({ width, dark }: { width: number; dark: boolean }) {
  const threads = dark ? THREADS.dark : THREADS.light;
  const cols = BAND[0].length - 1;
  const repeat = Math.max(1, Math.ceil(width / (cols * BAND_CELL)));
  const p = useMemo(() => paths(stitchesOf(BAND, cols, repeat), BAND_CELL, 1), [cols, repeat]);
  return (
    <Canvas style={{ width, height: RUSHNIK_HEIGHT }}>
      <Path path={p.x} style="stroke" strokeWidth={1.6} strokeCap="round" color={threads.kumach} />
      <Path path={p.o} style="stroke" strokeWidth={1.6} strokeCap="round" color={threads.spruce} />
    </Canvas>
  );
}
