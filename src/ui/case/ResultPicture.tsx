// Снимки, лента, сектор УЗИ и срезы КТ в результатах приёма: рисунок по тому, что показало
// обследование, — как в спецификации карты пациента (рентген, ЭКГ, УЗИ и КТ кодом, ADR 0013).
import { useWindowDimensions, View } from 'react-native';
import { ChestSlice } from '@/render/ChestSlice';
import { Ecg12 } from '@/render/Ecg12';
import { HeadSlice } from '@/render/HeadSlice';
import { type UsImage, UsSector } from '@/render/UsSector';
import { Xray } from '@/render/Xray';
import { XrayAbdomen } from '@/render/XrayAbdomen';
import { XrayBone } from '@/render/XrayBone';
import type { ResultImage } from '@/state/caseView';
import { space } from '@/ui/theme';

/** Плотность инфильтрата на снимке — одна: вид знает сторону, а не тяжесть. */
const DENSITY = 0.75;

/** Что рисует УЗИ по результату: вид и что нашли; вены ноги — линейным датчиком (часть 33а). */
function usImageOf(image: Extract<ResultImage, { kind: 'us' }>): UsImage {
  if (image.view === 'appendix') return { view: 'appendix', appendix: image.appendix ?? 0 };
  if (image.view === 'vein') return { view: 'vein', deep: image.deep ?? 0, superficial: image.superficial ?? 0, tear: image.tear ?? 0, arterial: image.arterial ?? 0 };
  if (image.view === 'kidney') return { view: 'kidney', pelvis: image.pelvis ?? 0 };
  if (image.view === 'colon') return { view: 'colon', diverticulum: image.diverticulum ?? 0 };
  return { view: 'gallbladder', foci: { count: image.stones ?? 0, size: 0.5 }, wall: image.wall ?? 0, fluid: image.wall ? 0.4 : 0 };
}

export function ResultPicture({ image }: { image: ResultImage }) {
  const { width } = useWindowDimensions();
  // ширина группы результатов: экран без отступов экрана, карточки и группы; колонка — до 640
  const w = Math.round(Math.min(width, 640) - 2 * (space.l + space.l + space.s));
  if (image.kind === 'us') {
    return (
      <View testID="result-us" style={{ borderRadius: 6, overflow: 'hidden', alignSelf: 'center' }}>
        <UsSector width={Math.min(w, 360)} seed={image.seed} findings={usImageOf(image)} />
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
  if (image.kind === 'head') {
    // срез КТ (часть 40) — квадрат, не шире колонки сектора УЗИ: кровь у свода видна и на телефоне
    return (
      <View testID="result-ct" style={{ borderRadius: 6, overflow: 'hidden', alignSelf: 'center' }}>
        <HeadSlice width={Math.min(w, 360)} seed={image.seed} findings={image.findings} />
      </View>
    );
  }
  if (image.kind === 'chestCt') {
    // срез груди на КТ-ангиографии (часть 43а) — тот же квадрат, что у среза головы
    return (
      <View testID="result-ct-chest" style={{ borderRadius: 6, overflow: 'hidden', alignSelf: 'center' }}>
        <ChestSlice width={Math.min(w, 360)} seed={image.seed} findings={image.findings} />
      </View>
    );
  }
  if (image.kind === 'bone') {
    // кости (часть 32): две проекции на одной плёнке — во всю ширину, чтобы линия перелома была видна
    return (
      <View testID="result-xray-bone" style={{ borderRadius: 6, overflow: 'hidden' }}>
        <XrayBone width={w} seed={image.seed} findings={image} />
      </View>
    );
  }
  if (image.kind === 'xray') {
    return (
      <View testID="result-xray" style={{ borderRadius: 6, overflow: 'hidden' }}>
        <Xray width={w} seed={image.seed} findings={{
          ...(image.infiltrate ? { infiltrate: { side: image.infiltrate, density: DENSITY } } : {}),
          hyperinflation: image.hyperinflation,
          ...(image.pneumothorax ? { pneumothorax: image.pneumothorax } : {}),
          ...(image.effusion ? { effusion: image.effusion } : {}),
          ...(image.ribFractures ? { ribFractures: image.ribFractures } : {}),
          wideMediastinum: image.wideMediastinum,
          ...(image.congestion ? { congestion: { edema: image.congestion === 'edema' } } : {}),
          cardiomegaly: image.cardiomegaly,
        }} />
      </View>
    );
  }
  return (
    <View testID="result-ecg" style={{ borderRadius: 6, overflow: 'hidden' }}>
      {/* двенадцать отведений во всю ширину: шесть строк по два и полоса ритма (часть 36) */}
      <Ecg12 width={w} findings={image.ecg} seed={image.seed} />
    </View>
  );
}
