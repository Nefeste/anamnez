// Фигурки карты без Skia (spec 2026-09-living-map, часть 22): какое тело и какая голова из
// атласа (sprites.ts) у человека. Пациент — как на портрете (`lookOf`): кожа, волосы,
// причёска, одежда; персонал — форма по должности, лицо — из номера места. Проверяется в Bun.
import { fnv1a } from '@/engine/core/hash';
import { CLOTHES, GREY, HAIR, type Look, SKIN } from '@/render/look';

/** Форма персонала: белый халат врача, голубая форма медсестры, сиреневая — прочих. */
export const UNIFORM = { doctor: 0, nurse: 1, staff: 2 } as const;
export type Uniform = keyof typeof UNIFORM;
/** Срочность пациента — обод: жёлтый тоньше, красный толще (цвет — не единственный признак). */
export type Urgency = 0 | 1 | 2;
/** Причёска: короткие волосы, длинные, лысина с волосами по краю; шапочка — у медсестёр. */
export type Hair = 'short' | 'long' | 'bald' | 'cap';

/** Цвета волос карты: как у портрета и седина — последней. */
export const HAIRS = [...HAIR, GREY];
export const STYLES: Hair[] = ['short', 'long', 'bald'];

/** Тел в атласе: три формы и одежда пациента × три обода. */
export const BODIES = 3 + 3 * CLOTHES.length;
/** Голов в атласе: кожа × волосы × причёска и шапочки по коже. */
export const HEADS = SKIN.length * HAIRS.length * STYLES.length + SKIN.length;

/** Номер тела в атласе: форма персонала или одежда пациента с ободом срочности. */
export function bodyIndex(b: { uniform: Uniform } | { clothes: number; urgency: Urgency }): number {
  if ('uniform' in b) return UNIFORM[b.uniform];
  return 3 + b.urgency * CLOTHES.length + (b.clothes % CLOTHES.length);
}

/** Номер головы в атласе: кожа × волосы × причёска; шапочка медсестры — только по коже. */
export function headIndex(skin: number, hair: number, style: Hair): number {
  const s = skin % SKIN.length;
  if (style === 'cap') return SKIN.length * HAIRS.length * STYLES.length + s;
  return (s * HAIRS.length + (hair % HAIRS.length)) * STYLES.length + STYLES.indexOf(style);
}

/** Что рисовать: тело и голова из атласа. */
export interface Figure {
  body: number;
  head: number;
}

const at = (list: readonly string[], color: string) => Math.max(0, list.indexOf(color));

/** Пациент — как на своём портрете; обод — по срочности. */
export function patientFigure(look: Look, urgency: Urgency): Figure {
  const style: Hair = look.bald ? 'bald' : look.long ? 'long' : 'short';
  return {
    body: bodyIndex({ clothes: at(CLOTHES, look.clothes), urgency }),
    head: headIndex(at(SKIN, look.skin), at(HAIRS, look.hair), style),
  };
}

/** Персонал: форма по должности; кожа, волосы и причёска — из номера места, всегда те же. */
export function staffFigure(uniform: Uniform, id: string): Figure {
  const h = fnv1a(`figure:${id}`);
  const style: Hair = uniform === 'nurse' ? 'cap' : h % 7 === 0 ? 'bald' : (h >>> 4) % 2 ? 'long' : 'short';
  // седина у персонала — вдвое реже любого другого цвета волос
  const hair = ((h >>> 8) % (HAIRS.length * 2 - 1)) % HAIRS.length;
  return { body: bodyIndex({ uniform }), head: headIndex((h >>> 12) % SKIN.length, hair, style) };
}
