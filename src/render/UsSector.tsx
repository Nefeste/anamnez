// Сектор УЗИ кодом (ADR 0013). Рисунок записывается один раз в SkPicture
// (src/render/us/sector.ts) и дальше только показывается; `still` — как у рентгена (Xray.tsx).
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { recordUsSector, type UsFindings } from './us/sector';

export type { UsFindings };

export function UsSector({ width, findings, seed = 1, still = false }: { width: number; findings: UsFindings; seed?: number; still?: boolean }) {
  const picture = useMemo(
    () => recordUsSector(width, findings, seed),
    // находки сравниваются по значению: новый объект с теми же полями не перерисовывает сектор
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [width, seed, findings.view, findings.foci?.count, findings.foci?.size, findings.pelvis, findings.fluid, findings.appendix],
  );
  return (
    <Canvas style={{ width, height: width }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
