// Рентген костей кодом (ADR 0013, spec 2026-09-chapter-2, часть 31): рисунок записывается один раз
// в SkPicture (src/render/xray/bones.ts) и дальше только показывается; `still` — как у снимка
// грудной клетки (Xray.tsx).
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { BONE_ASPECT, type BoneFindings } from './xray/boneGeometry';
import { recordBoneXray } from './xray/bones';

export type { BoneFindings };

export function XrayBone({ width, findings, seed = 1, still = false }: { width: number; findings: BoneFindings; seed?: number; still?: boolean }) {
  // находки — объект: запоминаем рисунок по их записи, а не по тождеству
  const key = JSON.stringify(findings);
  const picture = useMemo(() => recordBoneXray(width, JSON.parse(key) as BoneFindings, seed), [width, seed, key]);
  return (
    <Canvas style={{ width, height: width * BONE_ASPECT[findings.view] }} __destroyWebGLContextAfterRender={still}>
      <Picture picture={picture} />
    </Canvas>
  );
}
