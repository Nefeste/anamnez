// ЭГДС кодом (ADR 0013, spec 2026-10-chapter-4, часть 53а-2): поле зрения эндоскопа записывается один раз в SkPicture
// (src/render/egd/view.ts) и дальше только показывается; `still` — как у рентгена (Xray.tsx).
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { type EgdFindings, recordEgdView } from './egd/view';

export type { EgdFindings };

export function EgdView({ width, findings, seed = 1, still = false }: { width: number; findings: EgdFindings; seed?: number; still?: boolean }) {
  const { ulcer, tear, blood } = findings;
  const picture = useMemo(
    () => recordEgdView(width, findings, seed),
    // находки сравниваются по значению: новый объект с теми же полями не перерисовывает поле зрения
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [width, seed, ulcer?.base, ulcer?.size, tear?.bleeding, tear?.size, blood],
  );
  return (
    <Canvas style={{ width, height: width }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
