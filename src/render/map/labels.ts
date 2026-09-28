// Подпись помещения на плане (spec 2026-09-living-map, часть 22): внутри помещения, от стены до
// стены, кеглем по ширине — «Ординаторская» не обрезается и не заходит на стену; длинное
// название из двух слов — в две строки. Ширина текста — оценкой по числу букв: одинаково на
// телефоне и в вебе, проверяется в Bun.
import { WALL_IN } from './metrics';

/** Средняя ширина буквы полужирного системного шрифта — доля кегля, с запасом. */
export const GLYPH = 0.62;
/** Мельче не читается даже на большом экране. */
export const MIN_FONT = 6;
/** Отступ подписи от стены — доля клетки. */
const PAD = 0.14;

/** Сколько клеток от стены до стены внутри помещения шириной `w` (со стенами). */
export const innerWidth = (w: number) => w - 1 - WALL_IN - 2 * PAD;

/** Высота строки подписи — доля кегля. */
const LINE = 1.25;

/** Дверь в верхней стене: подпись — внизу помещения, чтобы не легла на створку. */
export const doorOnTop = (r: { y: number }, door: readonly (readonly [number, number])[]) => door.some(([, y]) => y === r.y);

/** Самая длинная строка, если разбить название на две по пробелу ближе к середине; одно слово — оно само. */
export function longestLine(name: string): number {
  const words = name.split(' ');
  let best = name.length;
  for (let i = 1; i < words.length; i++) best = Math.min(best, Math.max(words.slice(0, i).join(' ').length, words.slice(i).join(' ').length));
  return best;
}

/**
 * Где и каким кеглем подпись помещения `r` при клетке `cell` точек: у левой стены, сверху — или
 * снизу (`bottom`), если дверь в верхней стене. Кегль — обычный (0,6 клетки, не мельче 6,5); не
 * влезает в строку — по ширине, а если это мельче обычного больше чем на пятую часть и в
 * названии не одно слово — в две строки. Не мельче MIN_FONT.
 */
export function roomLabel(name: string, r: { x: number; y: number; w: number; h?: number }, cell: number, bottom = false): { left: number; top: number; width: number; fontSize: number; lines: 1 | 2 } {
  const edge = 0.5 + WALL_IN / 2 + PAD;
  const width = innerWidth(r.w) * cell;
  const base = Math.max(6.5, cell * 0.6);
  const one = width / (Math.max(1, name.length) * GLYPH);
  const two = width / (Math.max(1, longestLine(name)) * GLYPH);
  const lines = one < base * 0.8 && two > one ? 2 : 1;
  const fontSize = Math.max(MIN_FONT, Math.min(base, lines === 2 ? two : one));
  const top = bottom && r.h !== undefined ? (r.y + r.h - edge) * cell - fontSize * LINE * lines : (r.y + edge) * cell;
  return { left: (r.x + edge) * cell, top, width, fontSize, lines };
}

/**
 * Значок помещения (часть 23): высота, верх и край. По высоте — у стены напротив подписи:
 * подпись сверху — значок внизу, и наоборот. По ширине — в углу дальше от двери, чтобы не лёг
 * на створку: дверь правее середины — в левом углу (`side: 'left'`, `x` — левый край), иначе в
 * правом (`x` — правый край).
 */
export function badgeAt(r: { x: number; y: number; w: number; h: number }, cell: number, labelBottom: boolean, door: readonly [number, number]): { side: 'left' | 'right'; x: number; top: number; size: number } {
  const edge = 0.5 + WALL_IN / 2 + PAD;
  const size = Math.max(12, cell * 0.95);
  const top = labelBottom ? (r.y + edge) * cell : (r.y + r.h - edge) * cell - size;
  const left = door[0] > r.x + (r.w - 1) / 2;
  return { side: left ? 'left' : 'right', x: (left ? r.x + edge : r.x + r.w - edge) * cell, top, size };
}
