// Лист ЭКГ в двенадцати отведениях (spec 2026-10-chapter-3, часть 36): рисунок — одна запись в
// SkPicture (src/render/ecg/sheet.ts), подписи отведений — текстом поверх. `still` — как у рентгена
// (Xray.tsx): в списках холст отдаёт WebGL после рисунка.
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type EcgFindings, synthEcg12 } from './ecg/model';
import { ecgSheetLayout, INK, recordEcgSheet } from './ecg/sheet';

export type { EcgFindings };

export function Ecg12({ width, findings, seed = 1, still = false }: { width: number; findings: EcgFindings; seed?: number; still?: boolean }) {
  const layout = useMemo(() => ecgSheetLayout(width), [width]);
  const picture = useMemo(
    () => recordEcgSheet(width, synthEcg12(findings, seed, 10)),
    // находки сравниваются по значению: новый объект с теми же полями не перерисовывает лист
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [width, seed, findings.rhythm, findings.rate, findings.stemi, findings.stDepression, findings.tInversion, findings.qWaves, findings.lvh, findings.bundle, findings.pericarditis, findings.lowVoltage, findings.rvStrain],
  );
  const size = Math.max(9, Math.round(layout.mm * 3));
  return (
    <View style={{ width, height: layout.height }}>
      <Canvas style={{ width, height: layout.height }} __destroyWebGLContextAfterRender={still}>
        <Picture picture={picture} />
      </Canvas>
      {layout.labels.map(l => (
        <Text key={`${l.lead}${l.strip ? '-strip' : ''}`} allowFontScaling={false} style={[styles.label, { left: l.x, top: l.y, fontSize: size, lineHeight: size * 1.15 }]}>
          {l.lead}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { position: 'absolute', color: INK, fontWeight: '600' },
});
