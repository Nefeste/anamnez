// Обзорная рентгенограмма живота стоя кодом (ADR 0013, spec 2026-09-chapter-2, часть 30б):
// рисунок записывается один раз в SkPicture (src/render/xray/abdomen.ts) и дальше только
// показывается; `still` — как у снимка грудной клетки (Xray.tsx).
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { ABDOMEN_ASPECT, type AbdomenFindings, recordAbdomenXray } from './xray/abdomen';

export type { AbdomenFindings };

export function XrayAbdomen({ width, findings, seed = 1, still = false }: { width: number; findings?: AbdomenFindings; seed?: number; still?: boolean }) {
  const freeGas = findings?.freeGas ?? 0;
  const levels = findings?.levels ?? 0;
  const picture = useMemo(() => recordAbdomenXray(width, { freeGas, levels }, seed), [width, seed, freeGas, levels]);
  return (
    <Canvas style={{ width, height: width * ABDOMEN_ASPECT }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
