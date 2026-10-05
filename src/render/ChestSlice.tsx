// Срез груди на КТ-ангиографии кодом (spec 2026-10-chapter-3, часть 43а; ADR 0013). Рисунок
// записывается один раз в SkPicture (src/render/ct/chest.ts) и дальше только показывается; `still` —
// как у рентгена (Xray.tsx).
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { type ChestCtFindings, recordChestSlice } from './ct/chest';

export type { ChestCtFindings };

export function ChestSlice({ width, findings, seed = 1, still = false }: { width: number; findings: ChestCtFindings; seed?: number; still?: boolean }) {
  const picture = useMemo(
    () => recordChestSlice(width, findings, seed),
    // находки сравниваются по значению: новый объект с теми же полями не перерисовывает срез
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [width, seed, findings.dissection],
  );
  return (
    <Canvas style={{ width, height: width }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
