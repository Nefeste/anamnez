// Лента ЭКГ на миллиметровке: 25 мм/с, 10 мм/мВ (06-architecture.md §11).
import { Canvas, Group, Line, Path, Rect, Skia, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { ECG_HZ, type EcgSpec, synthEcg } from './ecgSignal';

const PINK_FINE = '#F7D4D4';
const PINK_BOLD = '#EFA3A3';
const INK = '#1C2B2D';

export function Ecg({ spec, width, height = 160 }: { spec: EcgSpec; width: number; height?: number }) {
  // Масштаб: вся лента по ширине; «миллиметр» — ширина одного отсчёта.
  const { path, grid, mm } = useMemo(() => {
    const { mv } = synthEcg(spec);
    const mmPx = width / (spec.seconds * 25);
    const mid = height * 0.6;
    const p = Skia.Path.Make();
    for (let i = 0; i < mv.length; i++) {
      const x = (i / ECG_HZ) * 25 * mmPx;
      const y = mid - mv[i] * 10 * mmPx;
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    const lines: { x0: number; y0: number; x1: number; y1: number; bold: boolean }[] = [];
    for (let k = 0; k * mmPx <= width; k++) lines.push({ x0: k * mmPx, y0: 0, x1: k * mmPx, y1: height, bold: k % 5 === 0 });
    for (let k = 0; k * mmPx <= height; k++) lines.push({ x0: 0, y0: k * mmPx, x1: width, y1: k * mmPx, bold: k % 5 === 0 });
    return { path: p, grid: lines, mm: mmPx };
  }, [spec, width, height]);

  return (
    <Canvas style={{ width, height }}>
      <Rect x={0} y={0} width={width} height={height} color="#FFF8F8" />
      <Group>
        {grid.map((l, i) => (
          <Line key={i} p1={vec(l.x0, l.y0)} p2={vec(l.x1, l.y1)} color={l.bold ? PINK_BOLD : PINK_FINE} strokeWidth={l.bold ? 1 : 0.5} />
        ))}
      </Group>
      <Path path={path} style="stroke" strokeWidth={Math.max(1.2, mm * 0.35)} color={INK} strokeJoin="round" />
    </Canvas>
  );
}
