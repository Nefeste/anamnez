// Сектор УЗИ кодом (ADR 0013). Рисунок записывается один раз в SkPicture
// (src/render/us/sector.ts) и дальше только показывается; `still` — как у рентгена (Xray.tsx).
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { recordUsSector, type UsImage } from './us/sector';

export type { UsImage };

export function UsSector({ width, findings, seed = 1, still = false }: { width: number; findings: UsImage; seed?: number; still?: boolean }) {
  // находки сравниваются по значению: новый объект с теми же полями не перерисовывает сектор; у
  // сектора и у вены (часть 33а) поля разные — ключ из всех
  const key = JSON.stringify(findings);
  const picture = useMemo(() => recordUsSector(width, JSON.parse(key) as UsImage, seed), [width, seed, key]);
  return (
    <Canvas style={{ width, height: width }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
