// Срез головы на КТ или МРТ кодом (ADR 0013). Рисунок записывается один раз в SkPicture
// (src/render/ct/head.ts) и дальше только показывается; `still` — как у рентгена (Xray.tsx).
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { type HeadFindings, type HeadMode, recordHeadSlice } from './ct/head';

export type { HeadFindings, HeadMode };

export function HeadSlice({ width, findings, seed = 1, mode = 'ct', still = false }: { width: number; findings: HeadFindings; seed?: number; mode?: HeadMode; still?: boolean }) {
  const f = findings.focus;
  const picture = useMemo(
    () => recordHeadSlice(width, findings, seed, mode),
    // находки сравниваются по значению: новый объект с теми же полями не перерисовывает срез
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [width, seed, mode, f?.density, f?.shape, f?.side, f?.region, f?.size, findings.shift],
  );
  return (
    <Canvas style={{ width, height: width }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
