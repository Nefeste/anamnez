// Варианты снимков для «Проверок» (spec 2026-09-ct-mri-ultrasound): что нарисовать и подпись —
// что нарисовано, а не диагноз. Их же рисует `npm run imaging` без экрана.
import { T } from '@/i18n';
import type { HeadFindings } from '@/render/ct/geometry';
import type { UsFindings } from '@/render/us/geometry';
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
  { key: 'mri-normal', mode: 'mri', findings: {}, seed: 6, label: t.mriNormal },
  { key: 'mri-wedge', mode: 'mri', findings: { focus: { density: 'high', shape: 'wedge', side: 'right', region: 'middle', size: 0.6 } }, seed: 7, label: t.mriWedge },
];

export interface UsCase {
  key: string;
  findings: UsFindings;
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

/** Снимок груди при травме (часть 32в): пневмоторакс малый, большой и напряжённый, кровь, уровень, переломы рёбер. */
export const CHEST_CASES: ChestCase[] = [
  { key: 'chest-small', findings: { pneumothorax: { side: 'right', size: 'small' } }, seed: 4, label: ch.small },
  { key: 'chest-large', findings: { pneumothorax: { side: 'left', size: 'large' } }, seed: 5, label: ch.large },
  { key: 'chest-tension', findings: { pneumothorax: { side: 'right', size: 'large', tension: true } }, seed: 6, label: ch.tension },
  { key: 'chest-fluid', findings: { effusion: { side: 'left' } }, seed: 7, label: ch.fluid },
  { key: 'chest-massive', findings: { effusion: { side: 'right', massive: true } }, seed: 8, label: ch.massive },
  { key: 'chest-level', findings: { effusion: { side: 'left', air: true }, pneumothorax: { side: 'left', size: 'small' } }, seed: 9, label: ch.level },
  { key: 'chest-rib', findings: { ribFractures: { side: 'right', ribs: [5, 6, 7] } }, seed: 10, label: ch.rib },
];

export interface BoneCase {
  key: string;
  findings: BoneFindings;
  seed: number;
  label: string;
}

const b = T.spikes.bones;

/** Рентген костей (часть 31): у каждого вида — норма и переломы без смещения и со смещением. */
export const BONE_CASES: BoneCase[] = [
  { key: 'bone-wrist', findings: { view: 'wrist' }, seed: 1, label: b.wrist },
  { key: 'bone-wrist-line', findings: { view: 'wrist', fractures: [{ site: 'radius' }] }, seed: 2, label: b.wristLine },
  { key: 'bone-wrist-displaced', findings: { view: 'wrist', fractures: [{ site: 'radius', displacement: 0.8 }, { site: 'ulnar_styloid' }] }, seed: 3, label: b.wristDisplaced },
  { key: 'bone-ankle', findings: { view: 'ankle' }, seed: 4, label: b.ankle },
  { key: 'bone-ankle-fibula', findings: { view: 'ankle', fractures: [{ site: 'fibula' }] }, seed: 5, label: b.ankleFibula },
  { key: 'bone-ankle-bimalleolar', findings: { view: 'ankle', fractures: [{ site: 'fibula', displacement: 0.9 }, { site: 'medial_malleolus', displacement: 0.9 }] }, seed: 6, label: b.ankleBimalleolar },
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
