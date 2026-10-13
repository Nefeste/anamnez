// Знак студии и полоса-рушник (брендбук студии, «Как игры носят бренд студии», ADR 0017): рисунок по клеткам — без Skia,
// чтобы его проверял тест (tools/test/studio.test.ts); рисует их Studio.tsx. Это знак студии, а не интерфейс игры: своих
// цветов «Анамнеза» у него нет, нити — из брендбука, у тёмной темы свои.

// из gornitsa: brand/tokens.css @ 23aee8b — нити знака и рушника; не править здесь
export const THREADS = {
  light: { kumach: '#b3162f', spruce: '#1f3c34' },
  dark: { kumach: '#e5566a', spruce: '#7fb3a3' },
};

// из gornitsa: brand/mark.svg @ 23aee8b — ромб на сетке 7 × 7: внешний ромб и крестик в середине — кумачом (x),
// внутренний ромб — елью (o); клетка — 4 единицы из 28, крестик — ±1,1 от середины клетки, нить — 1,3
export const MARK = ['...x...', '..xox..', '.xo.ox.', 'xo.x.ox', '.xo.ox.', '..xox..', '...x...'];

// из gornitsa: site/assets/site.js (Nefeste/gornitsagames, BAND) — узор рушника; последний столбец — начало
// следующего повтора, поэтому повтор — на столбец короче строки
export const BAND = ['..x.....x.....x..', '.x.x...xox...x.x.', 'x.o.x.xo.ox.x.o.x', '.x.x...xox...x.x.', '..x.....x.....x..'];
/** клетка рушника, px: как на сайте */
export const BAND_CELL = 6;
export const RUSHNIK_HEIGHT = BAND.length * BAND_CELL;

export type Thread = 'x' | 'o';
export interface Stitch { col: number; row: number; thread: Thread }

/** Крестики узора по клеткам; `cols` — ширина повтора, `repeat` — сколько раз повторить по ширине. */
export function stitchesOf(rows: readonly string[], cols: number, repeat = 1): Stitch[] {
  const out: Stitch[] = [];
  rows.forEach((line, row) => {
    for (let col = 0; col < cols * repeat; col++) {
      const ch = line[col % cols];
      if (ch === 'x' || ch === 'o') out.push({ col, row, thread: ch });
    }
  });
  return out;
}
