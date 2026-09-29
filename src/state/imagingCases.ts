// Варианты снимков для «Проверок» (spec 2026-09-ct-mri-ultrasound): что нарисовать и подпись —
// что нарисовано, а не диагноз. Их же рисует `npm run imaging` без экрана.
import { T } from '@/i18n';
import type { HeadFindings } from '@/render/ct/geometry';
import type { UsFindings } from '@/render/us/geometry';

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
  { key: 'us-kidney', findings: { view: 'kidney' }, seed: 3, label: u.kidney },
  { key: 'us-kidney-pelvis', findings: { view: 'kidney', pelvis: 0.7 }, seed: 4, label: u.kidneyPelvis },
  { key: 'us-kidney-fluid', findings: { view: 'kidney', fluid: 0.6 }, seed: 5, label: u.kidneyFluid },
  { key: 'us-appendix', findings: { view: 'appendix' }, seed: 6, label: u.appendix },
  { key: 'us-appendix-target', findings: { view: 'appendix', appendix: 0.8 }, seed: 7, label: u.appendixTarget },
  { key: 'us-appendix-fluid', findings: { view: 'appendix', appendix: 0.9, fluid: 0.6 }, seed: 8, label: u.appendixFluid },
];
