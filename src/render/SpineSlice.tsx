// МРТ поясничного отдела позвоночника кодом (ADR 0013, spec 2026-10-chapter-4, часть 58а): срез записывается один раз в
// SkPicture (src/render/mri/spine.ts) и дальше только показывается; `still` — как у рентгена (Xray.tsx).
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { recordSpineSlice, type SpineFindings } from './mri/spine';

export type { SpineFindings };

export function SpineSlice({ width, findings, seed = 1, still = false }: { width: number; findings: SpineFindings; seed?: number; still?: boolean }) {
  const { hernia, bladder } = findings;
  const picture = useMemo(
    () => recordSpineSlice(width, findings, seed),
    // находки сравниваются по значению: новый объект с теми же полями не перерисовывает срез
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [width, seed, hernia?.level, hernia?.size, bladder],
  );
  return (
    <Canvas style={{ width, height: width }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
