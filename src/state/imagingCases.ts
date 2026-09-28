// Варианты снимков для «Проверок» (spec 2026-09-ct-mri-ultrasound): что нарисовать и подпись —
// что нарисовано, а не диагноз. Их же рисует `npm run imaging` без экрана.
import { T } from '@/i18n';
import type { HeadFindings } from '@/render/ct/geometry';

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
