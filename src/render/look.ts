// Внешность портрета из зерна (ADR 0013): что рисует Portrait.tsx — кожа, волосы, одежда,
// очки. Отдельно от рисунка и без Skia: подбор портретов врача и тесты берут ту же внешность.
import { Rng } from '@/engine/core/rng';
import type { Trait } from '@/engine/hospital/staff';
import type { Uniform } from './map/figures';

// цвета — общие с фигурками карты (src/render/map/sprites.ts): седой пациент седой и там
export const SKIN = ['#F2D0B5', '#E8BE9A', '#D9A57E', '#C68B63', '#F5DCC8'];
export const HAIR = ['#2B2118', '#4A3222', '#7A5230', '#A67B4B', '#C9A86A', '#1A1A1A'];
export const GREY = '#C8C8C8';
export const CLOTHES = ['#5B7FA6', '#7A9E7E', '#A65B5B', '#8E7AA6', '#C29B48', '#5E6F72'];
const BG = ['#E6EEF0', '#EEE9E2', '#E9EEE4', '#EDE6EE'];

export interface Look {
  skin: string;
  hair: string;
  clothes: string;
  bald: boolean;
  /** длинные волосы — жребий только у женщин */
  long: boolean;
  glasses: boolean;
  beard: boolean;
  wrinkles: boolean;
  bg: string;
}

/** Порядок жребиев не менять: иначе у всех пациентов и врачей сменятся лица. */
export function lookOf(seed: number, sex: 'm' | 'f', age: number): Look {
  const r = Rng.seeded(seed).fork('portrait');
  const grey = age >= 60 ? 0.85 : age >= 48 ? 0.4 : 0;
  const bald = sex === 'm' && age >= 45 && r.int(100) < 35;
  return {
    skin: r.pick(SKIN),
    hair: grey > 0 && r.int(100) < grey * 100 ? GREY : r.pick(HAIR),
    clothes: r.pick(CLOTHES),
    bald,
    long: sex === 'f' && r.int(100) < 70,
    glasses: age >= 40 ? r.int(100) < 45 : r.int(100) < 15,
    beard: sex === 'm' && r.int(100) < 20,
    wrinkles: age >= 55,
    bg: r.pick(BG),
  };
}

/** Портрет сотрудника (FR-AV-4, 0.5.7): лицо — из зерна его имени, возраст — из того же зерна, форма — по должности. */
export interface StaffPortrait {
  seed: number;
  sex: 'm' | 'f';
  age: number;
  uniform: Uniform;
}

/**
 * Возраст на портрете сотрудника (FR-AV-4, 0.5.7) — из зерна его имени, с навыком не меняется: «опытный» — от 40 лет,
 * «новичок» — до 35, остальные — от 25 до 58.
 */
export function staffAge(seed: number, trait?: Trait): number {
  const r = Rng.seeded(seed).fork('age');
  return trait === 'experienced' ? r.range(40, 62) : trait === 'novice' ? r.range(23, 35) : r.range(25, 58);
}
