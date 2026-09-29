// Рентгенограмма грудной клетки кодом (ADR 0013). Рисунок записывается один раз в
// SkPicture (src/render/xray/chest.ts) и дальше только показывается. `still` — в вебе рисунок
// не держит свой контекст WebGL (их у страницы не больше 16): для экранов, где рисунков много и
// они не меняются. Спрятанный холст (экран ниже в стеке) так перерисовать нельзя — поэтому
// по умолчанию выключено; на телефоне не действует.
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { recordChestXray, XRAY_ASPECT, type XrayFindings } from './xray/chest';

export type { XrayFindings };

export function Xray({ width, findings, seed = 1, still = false }: { width: number; findings?: XrayFindings; seed?: number; still?: boolean }) {
  // находки сравниваются по значению: новый объект с теми же полями не перерисовывает снимок
  const key = JSON.stringify(findings ?? {});
  const picture = useMemo(
    () => recordChestXray(width, JSON.parse(key) as XrayFindings, seed),
    [width, seed, key],
  );
  return (
    <Canvas style={{ width, height: width * XRAY_ASPECT }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
