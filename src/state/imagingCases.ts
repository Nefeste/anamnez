// Варианты снимков для «Проверок» (spec 2026-09-ct-mri-ultrasound): что нарисовать и подпись —
// что нарисовано, а не диагноз. Их же рисует `npm run imaging` без экрана.
import { T } from '@/i18n';
import type { ChestCtFindings } from '@/render/ct/chestGeometry';
import type { HeadFindings } from '@/render/ct/geometry';
import type { EcgFindings } from '@/render/ecg/model';
import type { UsImage } from '@/render/us/sector';
import type { AbdomenFindings } from '@/render/xray/abdomenGeometry';
import type { BoneFindings } from '@/render/xray/boneGeometry';
import type { XrayFindings } from '@/render/xray/chestGeometry';

export interface HeadCase {
  key: string;
  mode: 'ct' | 'mri';
  findings: HeadFindings;
  seed: number;
  label: string;
}

const t = T.spikes.imaging.head;

export const HEAD_CASES: HeadCase[] = [
  { key: 'ct-normal', mode: 'ct', findings: {}, seed: 1, label: t.ctNormal },
  { key: 'ct-blob', mode: 'ct', findings: { focus: { density: 'high', shape: 'blob', side: 'right', region: 'middle', size: 0.55 } }, seed: 2, label: t.ctBlob },
  { key: 'ct-crescent', mode: 'ct', findings: { focus: { density: 'high', shape: 'crescent', side: 'right', size: 0.7 }, shift: 0.7 }, seed: 3, label: t.ctCrescent },
  { key: 'ct-lens', mode: 'ct', findings: { focus: { density: 'high', shape: 'lens', side: 'left', size: 0.7 } }, seed: 4, label: t.ctLens },
  { key: 'ct-wedge', mode: 'ct', findings: { focus: { density: 'low', shape: 'wedge', side: 'left', region: 'middle', size: 0.7 } }, seed: 5, label: t.ctWedge },
  // кровоизлияния (часть 41в): кровь под паутинной оболочкой; гематома больше 30 см³ со смещением
  { key: 'ct-sah', mode: 'ct', findings: { sah: 0.7 }, seed: 8, label: t.ctSah },
  { key: 'ct-blob-large', mode: 'ct', findings: { focus: { density: 'high', shape: 'blob', side: 'left', region: 'middle', size: 0.85 }, shift: 0.6 }, seed: 9, label: t.ctBlobLarge },
  { key: 'mri-normal', mode: 'mri', findings: {}, seed: 6, label: t.mriNormal },
  { key: 'mri-wedge', mode: 'mri', findings: { focus: { density: 'high', shape: 'wedge', side: 'right', region: 'middle', size: 0.6 } }, seed: 7, label: t.mriWedge },
];

export interface ChestCtCase {
  key: string;
  findings: ChestCtFindings;
  seed: number;
  label: string;
}

const cc = T.spikes.imaging.chestCt;

/** КТ-ангиография груди (часть 43а): без расслоения, расслоение типа A и типа B. */
export const CHEST_CT_CASES: ChestCtCase[] = [
  { key: 'cta-chest-normal', findings: {}, seed: 1, label: cc.normal },
  { key: 'cta-chest-a', findings: { dissection: 'a' }, seed: 2, label: cc.typeA },
  { key: 'cta-chest-b', findings: { dissection: 'b' }, seed: 3, label: cc.typeB },
];

export interface UsCase {
  key: string;
  findings: UsImage;
  seed: number;
  label: string;
}

const u = T.spikes.imaging.us;

export const US_CASES: UsCase[] = [
  { key: 'us-gb', findings: { view: 'gallbladder' }, seed: 1, label: u.gb },
  { key: 'us-gb-foci', findings: { view: 'gallbladder', foci: { count: 3, size: 0.5 } }, seed: 2, label: u.gbFoci },
  { key: 'us-gb-wall', findings: { view: 'gallbladder', foci: { count: 3, size: 0.6 }, wall: 0.8, fluid: 0.4 }, seed: 9, label: u.gallbladderWall },
  { key: 'us-kidney', findings: { view: 'kidney' }, seed: 3, label: u.kidney },
  { key: 'us-kidney-pelvis', findings: { view: 'kidney', pelvis: 0.7 }, seed: 4, label: u.kidneyPelvis },
  { key: 'us-kidney-fluid', findings: { view: 'kidney', fluid: 0.6 }, seed: 5, label: u.kidneyFluid },
  { key: 'us-appendix', findings: { view: 'appendix' }, seed: 6, label: u.appendix },
  { key: 'us-appendix-target', findings: { view: 'appendix', appendix: 0.8 }, seed: 7, label: u.appendixTarget },
  { key: 'us-appendix-fluid', findings: { view: 'appendix', appendix: 0.9, fluid: 0.6 }, seed: 8, label: u.appendixFluid },
  { key: 'us-colon', findings: { view: 'colon' }, seed: 10, label: u.colon },
  { key: 'us-colon-diverticulum', findings: { view: 'colon', diverticulum: 0.8 }, seed: 11, label: u.colonDiverticulum },
  // вены ноги линейным датчиком (часть 33а)
  { key: 'us-vein', findings: { view: 'vein' }, seed: 12, label: u.vein },
  { key: 'us-vein-deep', findings: { view: 'vein', deep: 1 }, seed: 13, label: u.veinDeep },
  { key: 'us-vein-superficial', findings: { view: 'vein', superficial: 1 }, seed: 14, label: u.veinSuperficial },
  { key: 'us-vein-tear', findings: { view: 'vein', tear: 0.8 }, seed: 15, label: u.veinTear },
  // артерия закрыта (часть 33б): острая ишемия ноги
  { key: 'us-artery', findings: { view: 'vein', arterial: 1 }, seed: 16, label: u.veinArtery },
];

export interface AbdomenCase {
  key: string;
  findings: AbdomenFindings;
  seed: number;
  label: string;
}

const a = T.spikes.imaging.abdomen;

/** Обзорный снимок живота стоя (часть 30б): норма, свободный газ, непроходимость тонкой кишки. */
export const ABDOMEN_CASES: AbdomenCase[] = [
  { key: 'abd-normal', findings: {}, seed: 1, label: a.normal },
  { key: 'abd-free-gas', findings: { freeGas: 0.8 }, seed: 2, label: a.freeGas },
  { key: 'abd-levels', findings: { levels: 0.8 }, seed: 3, label: a.levels },
];

export interface ChestCase {
  key: string;
  findings: XrayFindings;
  seed: number;
  label: string;
}

const ch = T.spikes.imaging.chest;

/**
 * Снимок груди при травме (часть 32в): пневмоторакс малый, большой и напряжённый, кровь, уровень,
 * переломы рёбер; с частью 43а — расширенное верхнее средостение.
 */
export const CHEST_CASES: ChestCase[] = [
  { key: 'chest-small', findings: { pneumothorax: { side: 'right', size: 'small' } }, seed: 4, label: ch.small },
  { key: 'chest-large', findings: { pneumothorax: { side: 'left', size: 'large' } }, seed: 5, label: ch.large },
  { key: 'chest-tension', findings: { pneumothorax: { side: 'right', size: 'large', tension: true } }, seed: 6, label: ch.tension },
  { key: 'chest-fluid', findings: { effusion: { side: 'left' } }, seed: 7, label: ch.fluid },
  { key: 'chest-massive', findings: { effusion: { side: 'right', massive: true } }, seed: 8, label: ch.massive },
  { key: 'chest-level', findings: { effusion: { side: 'left', air: true }, pneumothorax: { side: 'left', size: 'small' } }, seed: 9, label: ch.level },
  { key: 'chest-rib', findings: { ribFractures: { side: 'right', ribs: [5, 6, 7] } }, seed: 10, label: ch.rib },
  { key: 'chest-mediastinum', findings: { wideMediastinum: true }, seed: 11, label: ch.mediastinum },
];

export interface BoneCase {
  key: string;
  findings: BoneFindings;
  seed: number;
  label: string;
}

const b = T.spikes.bones;

/** Рентген костей (часть 31): у каждого вида — норма и переломы без смещения и со смещением; у колена — и выпот (часть 32д). */
export const BONE_CASES: BoneCase[] = [
  { key: 'bone-wrist', findings: { view: 'wrist' }, seed: 1, label: b.wrist },
  { key: 'bone-wrist-line', findings: { view: 'wrist', fractures: [{ site: 'radius' }] }, seed: 2, label: b.wristLine },
  { key: 'bone-wrist-displaced', findings: { view: 'wrist', fractures: [{ site: 'radius', displacement: 0.8 }, { site: 'ulnar_styloid' }] }, seed: 3, label: b.wristDisplaced },
  { key: 'bone-ankle', findings: { view: 'ankle' }, seed: 4, label: b.ankle },
  { key: 'bone-ankle-fibula', findings: { view: 'ankle', fractures: [{ site: 'fibula' }] }, seed: 5, label: b.ankleFibula },
  { key: 'bone-ankle-bimalleolar', findings: { view: 'ankle', fractures: [{ site: 'fibula', displacement: 0.9 }, { site: 'medial_malleolus', displacement: 0.9 }] }, seed: 6, label: b.ankleBimalleolar },
  { key: 'bone-knee', findings: { view: 'knee' }, seed: 17, label: b.knee },
  { key: 'bone-knee-effusion', findings: { view: 'knee', effusion: true }, seed: 18, label: b.kneeEffusion },
  { key: 'bone-knee-patella', findings: { view: 'knee', fractures: [{ site: 'patella' }], effusion: true }, seed: 19, label: b.kneePatella },
  { key: 'bone-knee-patella-displaced', findings: { view: 'knee', fractures: [{ site: 'patella', displacement: 0.9 }], effusion: true }, seed: 20, label: b.kneePatellaDisplaced },
  { key: 'bone-foot', findings: { view: 'foot' }, seed: 7, label: b.foot },
  { key: 'bone-foot-mt5', findings: { view: 'foot', fractures: [{ site: 'mt5', displacement: 0.6 }] }, seed: 8, label: b.footMt5 },
  { key: 'bone-foot-mt3', findings: { view: 'foot', fractures: [{ site: 'mt3', displacement: 0.9 }] }, seed: 9, label: b.footMt3 },
  { key: 'bone-hip', findings: { view: 'hip' }, seed: 10, label: b.hip },
  { key: 'bone-hip-line', findings: { view: 'hip', fractures: [{ site: 'femoral_neck' }] }, seed: 11, label: b.hipLine },
  { key: 'bone-hip-displaced', findings: { view: 'hip', fractures: [{ site: 'femoral_neck', displacement: 0.9 }] }, seed: 12, label: b.hipDisplaced },
  { key: 'bone-clavicle', findings: { view: 'clavicle' }, seed: 13, label: b.clavicle },
  { key: 'bone-clavicle-displaced', findings: { view: 'clavicle', fractures: [{ site: 'clavicle', displacement: 0.9 }] }, seed: 14, label: b.clavicleDisplaced },
  { key: 'bone-ribs', findings: { view: 'ribs' }, seed: 15, label: b.ribs },
  { key: 'bone-ribs-broken', findings: { view: 'ribs', fractures: [{ site: 'rib', rib: 6, displacement: 0.9 }, { site: 'rib', rib: 7 }] }, seed: 16, label: b.ribsBroken },
];

export interface EcgCase {
  key: string;
  findings: EcgFindings;
  seed: number;
  label: string;
}

const e = T.spikes.imaging.ecg;

/** ЭКГ в двенадцати отведениях (spec 2026-10-chapter-3, часть 36): ритмы, проведение, стенки инфаркта. */
export const ECG_CASES: EcgCase[] = [
  { key: 'ecg-normal', findings: {}, seed: 1, label: e.normal },
  { key: 'ecg-inferior', findings: { stemi: 'inferior' }, seed: 2, label: e.inferior },
  { key: 'ecg-anterior', findings: { stemi: 'anterior' }, seed: 3, label: e.anterior },
  { key: 'ecg-lateral', findings: { stemi: 'lateral' }, seed: 4, label: e.lateral },
  { key: 'ecg-depression', findings: { stDepression: true }, seed: 5, label: e.depression },
  { key: 'ecg-af', findings: { rhythm: 'af', rate: 110 }, seed: 6, label: e.af },
  { key: 'ecg-flutter', findings: { rhythm: 'flutter', rate: 150 }, seed: 7, label: e.flutter },
  { key: 'ecg-svt', findings: { rhythm: 'svt', rate: 180 }, seed: 8, label: e.svt },
  { key: 'ecg-vt', findings: { rhythm: 'vt', rate: 170 }, seed: 9, label: e.vt },
  { key: 'ecg-avb1', findings: { rhythm: 'avb1' }, seed: 10, label: e.avb1 },
  { key: 'ecg-avb2w', findings: { rhythm: 'avb2w' }, seed: 11, label: e.avb2w },
  { key: 'ecg-avb2m', findings: { rhythm: 'avb2m' }, seed: 12, label: e.avb2m },
  { key: 'ecg-avb3', findings: { rhythm: 'avb3', rate: 38 }, seed: 13, label: e.avb3 },
  // выскальзывающий ритм из АВ-соединения (часть 42в): комплексы узкие
  { key: 'ecg-avb3n', findings: { rhythm: 'avb3', escape: 'narrow', rate: 45 }, seed: 20, label: e.avb3n },
  { key: 'ecg-lbbb', findings: { bundle: 'lbbb' }, seed: 14, label: e.lbbb },
  { key: 'ecg-rbbb', findings: { bundle: 'rbbb' }, seed: 15, label: e.rbbb },
  { key: 'ecg-pericarditis', findings: { pericarditis: true, rate: 95 }, seed: 16, label: e.pericarditis },
  { key: 'ecg-lvh', findings: { lvh: true }, seed: 17, label: e.lvh },
  { key: 'ecg-rv', findings: { rvStrain: true, rate: 110 }, seed: 18, label: e.rv },
  { key: 'ecg-low', findings: { lowVoltage: true, rate: 105 }, seed: 19, label: e.lowVoltage },
];
