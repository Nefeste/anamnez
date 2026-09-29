// Снимки, лента и сектор УЗИ в результатах приёма: рисунок по тому, что показало обследование, —
// как в спецификации карты пациента (рентген, ЭКГ и УЗИ кодом, ADR 0013).
import { useWindowDimensions, View } from 'react-native';
import { Ecg } from '@/render/Ecg';
import { UsSector } from '@/render/UsSector';
import { Xray } from '@/render/Xray';
import { XrayAbdomen } from '@/render/XrayAbdomen';
import type { ResultImage } from '@/state/caseView';
import { space } from '@/ui/theme';

/** Плотность инфильтрата на снимке — одна: вид знает сторону, а не тяжесть. */
const DENSITY = 0.75;

export function ResultPicture({ image }: { image: ResultImage }) {
  const { width } = useWindowDimensions();
  // ширина группы результатов: экран без отступов экрана, карточки и группы; колонка — до 640
  const w = Math.round(Math.min(width, 640) - 2 * (space.l + space.l + space.s));
  if (image.kind === 'us') {
    return (
      <View testID="result-us" style={{ borderRadius: 6, overflow: 'hidden', alignSelf: 'center' }}>
        <UsSector width={Math.min(w, 360)} seed={image.seed} findings={image.view === 'appendix'
          ? { view: 'appendix', appendix: image.appendix ?? 0 }
          : image.view === 'kidney'
            ? { view: 'kidney', pelvis: image.pelvis ?? 0 }
            : image.view === 'colon'
              ? { view: 'colon', diverticulum: image.diverticulum ?? 0 }
              : { view: 'gallbladder', foci: { count: image.stones ?? 0, size: 0.5 }, wall: image.wall ?? 0, fluid: image.wall ? 0.4 : 0 }} />
      </View>
    );
  }
  if (image.kind === 'abdomen') {
    // то, что нашёл рентгенолог, — крупно: серп газа и уровни должны быть видны на телефоне
    return (
      <View testID="result-xray-abdomen" style={{ borderRadius: 6, overflow: 'hidden' }}>
        <XrayAbdomen width={w} seed={image.seed} findings={{ freeGas: image.freeGas ? 0.8 : 0, levels: image.levels ? 0.8 : 0 }} />
      </View>
    );
  }
  if (image.kind === 'xray') {
    return (
      <View testID="result-xray" style={{ borderRadius: 6, overflow: 'hidden' }}>
        <Xray width={w} seed={image.seed} findings={{ ...(image.infiltrate ? { infiltrate: { side: image.infiltrate, density: DENSITY } } : {}), hyperinflation: image.hyperinflation }} />
      </View>
    );
  }
  return (
    <View testID="result-ecg" style={{ borderRadius: 6, overflow: 'hidden' }}>
      {/* четыре секунды — крупно: подъём ST на телефоне должен быть виден глазом */}
      <Ecg width={w} height={Math.round(w * 0.45)} spec={{ rhythm: 'sinus', rate: image.rate, seconds: 4, seed: image.seed, st: image.st, rScale: image.rScale }} />
    </View>
  );
}
