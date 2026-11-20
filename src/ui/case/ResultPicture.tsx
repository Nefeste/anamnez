// Снимки, лента, сектор УЗИ и срезы КТ в результатах приёма: рисунок по тому, что показало
// обследование, — как в спецификации карты пациента (рентген, ЭКГ, УЗИ, КТ, МРТ и ЭГДС кодом, ADR 0013). Снимок
// касанием открывается крупно (spec 2026-11-xray, ImageViewer.tsx); ЭКГ — нет: лента и так во всю ширину, а подписи
// отведений — текстом поверх.
import { useMemo, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { T } from '@/i18n';
import { ChestSlice } from '@/render/ChestSlice';
import { recordChestSlice } from '@/render/ct/chest';
import { recordHeadSlice } from '@/render/ct/head';
import { Ecg12 } from '@/render/Ecg12';
import { recordEgdView } from '@/render/egd/view';
import { EgdView } from '@/render/EgdView';
import { HeadSlice } from '@/render/HeadSlice';
import { recordSpineSlice } from '@/render/mri/spine';
import { SpineSlice } from '@/render/SpineSlice';
import { recordUsSector } from '@/render/us/sector';
import { type UsImage, UsSector } from '@/render/UsSector';
import { Xray, type XrayFindings } from '@/render/Xray';
import { ABDOMEN_ASPECT, recordAbdomenXray } from '@/render/xray/abdomen';
import { BONE_ASPECT } from '@/render/xray/boneGeometry';
import { recordBoneXray } from '@/render/xray/bones';
import { recordChestXray, XRAY_ASPECT } from '@/render/xray/chest';
import { XrayAbdomen } from '@/render/XrayAbdomen';
import { XrayBone } from '@/render/XrayBone';
import type { Line, ResultImage } from '@/state/caseView';
import { space } from '@/ui/theme';
import { ImageViewer, type ViewerPicture, ZoomBadge } from './ImageViewer';

/** Плотность инфильтрата на снимке — одна: вид знает сторону, а не тяжесть. */
const DENSITY = 0.75;

/** Что рисует УЗИ по результату: вид и что нашли; вены ноги — линейным датчиком (часть 33а). */
function usImageOf(image: Extract<ResultImage, { kind: 'us' }>): UsImage {
  if (image.view === 'appendix') return { view: 'appendix', appendix: image.appendix ?? 0 };
  if (image.view === 'vein') return { view: 'vein', deep: image.deep ?? 0, superficial: image.superficial ?? 0, tear: image.tear ?? 0, arterial: image.arterial ?? 0 };
  if (image.view === 'kidney') return { view: 'kidney', pelvis: image.pelvis ?? 0, edema: image.edema ?? 0 };
  if (image.view === 'colon') return { view: 'colon', diverticulum: image.diverticulum ?? 0 };
  return { view: 'gallbladder', foci: { count: image.stones ?? 0, size: 0.5 }, wall: image.wall ?? 0, fluid: image.wall ? 0.4 : 0 };
}

/** Находки снимка груди — из результата обследования. */
function chestOf(image: Extract<ResultImage, { kind: 'xray' }>): XrayFindings {
  return {
    ...(image.infiltrate ? { infiltrate: { side: image.infiltrate, density: DENSITY } } : {}),
    hyperinflation: image.hyperinflation,
    ...(image.pneumothorax ? { pneumothorax: image.pneumothorax } : {}),
    ...(image.effusion ? { effusion: image.effusion } : {}),
    ...(image.ribFractures ? { ribFractures: image.ribFractures } : {}),
    wideMediastinum: image.wideMediastinum,
    ...(image.congestion ? { congestion: { edema: image.congestion === 'edema' } } : {}),
    cardiomegaly: image.cardiomegaly,
  };
}

/** Тот же рисунок для просмотра крупно: запись по ширине и высота к ширине. ЭКГ — без просмотра. */
function viewerOf(image: ResultImage): ViewerPicture | undefined {
  switch (image.kind) {
    case 'xray': {
      const f = chestOf(image);
      return { record: w => recordChestXray(w, f, image.seed), aspect: XRAY_ASPECT, sideMark: true };
    }
    case 'abdomen': {
      const f = { freeGas: image.freeGas ? 0.8 : 0, levels: image.levels ? 0.8 : 0 };
      return { record: w => recordAbdomenXray(w, f, image.seed), aspect: ABDOMEN_ASPECT };
    }
    case 'bone':
      return { record: w => recordBoneXray(w, image, image.seed), aspect: BONE_ASPECT[image.view] };
    case 'head':
      return { record: w => recordHeadSlice(w, image.findings, image.seed, image.mode ?? 'ct'), aspect: 1 };
    case 'chestCt':
      return { record: w => recordChestSlice(w, image.findings, image.seed), aspect: 1 };
    case 'egd':
      return { record: w => recordEgdView(w, image.findings, image.seed), aspect: 1 };
    case 'spine':
      return { record: w => recordSpineSlice(w, image.findings, image.seed), aspect: 1 };
    case 'us': {
      const f = usImageOf(image);
      return { record: w => recordUsSector(w, f, image.seed), aspect: 1 };
    }
    default:
      return undefined;
  }
}

export function ResultPicture({ image, title, lines }: { image: ResultImage; title: string; lines: readonly Line[] }) {
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  // ширина группы результатов: экран без отступов экрана, карточки и группы; колонка — до 640
  const w = Math.round(Math.min(width, 640) - 2 * (space.l + space.l + space.s));
  // запись для просмотра — одна на снимок: иначе каждая перерисовка карты перезаписывала бы рисунок
  const viewer = useMemo(() => viewerOf(image), [image]);
  const inline = pictureOf(image, w);
  if (!viewer) return inline;
  // квадратные срезы и сектор — не шире колонки, посередине; снимки — во всю ширину
  const square = image.kind !== 'xray' && image.kind !== 'abdomen' && image.kind !== 'bone';
  return (
    <>
      <Pressable testID="result-open" accessibilityRole="button" accessibilityLabel={T.spikes.patient.viewer.open(title)}
        onPress={() => setOpen(true)} style={square ? { alignSelf: 'center' } : undefined}>
        {inline}
        <ZoomBadge />
      </Pressable>
      <ImageViewer visible={open} onClose={() => setOpen(false)} title={title} picture={viewer} lines={lines} />
    </>
  );
}

/** Рисунок в карте пациента — по виду обследования. */
function pictureOf(image: ResultImage, w: number) {
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
    // срез КТ (часть 40) — квадрат, не шире колонки сектора УЗИ: кровь у свода видна и на телефоне; МРТ (часть 50б) — тот
    // же срез в своём режиме
    return (
      <View testID={image.mode === 'mri' ? 'result-mri' : 'result-ct'} style={{ borderRadius: 6, overflow: 'hidden', alignSelf: 'center' }}>
        <HeadSlice width={Math.min(w, 360)} seed={image.seed} findings={image.findings} mode={image.mode ?? 'ct'} />
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
  if (image.kind === 'egd') {
    // ЭГДС (часть 53а-2) — круг поля зрения эндоскопа, тот же квадрат, что у срезов
    return (
      <View testID="result-egd" style={{ borderRadius: 6, overflow: 'hidden', alignSelf: 'center' }}>
        <EgdView width={Math.min(w, 360)} seed={image.seed} findings={image.findings} />
      </View>
    );
  }
  if (image.kind === 'spine') {
    // МРТ поясничного отдела (часть 58б) — продольный срез, тот же квадрат, что у срезов головы
    return (
      <View testID="result-mri-spine" style={{ borderRadius: 6, overflow: 'hidden', alignSelf: 'center' }}>
        <SpineSlice width={Math.min(w, 360)} seed={image.seed} findings={image.findings} />
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
        <Xray width={w} seed={image.seed} findings={chestOf(image)} />
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
