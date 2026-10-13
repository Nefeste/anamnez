// Знак студии и полоса-рушник в «Об игре» (брендбук студии, ADR 0017): рисунок — тот же, что в brand/mark.svg студии и на
// сайте; строка студии — по брендбуку.
import { describe, expect, test } from 'bun:test';
import { T } from '../../src/i18n';
import { BAND, MARK, stitchesOf, THREADS } from '../../src/render/brand';

describe('студия в «Об игре»', () => {
  test('знак — как brand/mark.svg: внешний ромб и середина кумачом, внутренний ромб елью', () => {
    // середины крестиков в единицах знака 28 × 28 — из путей mark.svg (клетка 4, середина клетки — 4 · столбец + 2)
    const kumach = ['14,2', '10,6', '18,6', '6,10', '22,10', '2,14', '14,14', '26,14', '6,18', '22,18', '10,22', '18,22', '14,26'];
    const spruce = ['14,6', '10,10', '18,10', '6,14', '22,14', '10,18', '18,18', '14,22'];
    const at = (thread: 'x' | 'o') => stitchesOf(MARK, 7).filter(s => s.thread === thread).map(s => `${4 * s.col + 2},${4 * s.row + 2}`).sort();
    expect(MARK).toHaveLength(7);
    expect(at('x')).toEqual([...kumach].sort());
    expect(at('o')).toEqual([...spruce].sort());
  });

  test('рушник: пять строк одной ширины, повтор — на столбец короче строки и стыкуется без шва', () => {
    expect(BAND).toHaveLength(5);
    for (const row of BAND) {
      expect(row).toHaveLength(BAND[0].length);
      expect(row[row.length - 1]).toBe(row[0]);
    }
    // три повтора — втрое больше крестиков
    expect(stitchesOf(BAND, BAND[0].length - 1, 3)).toHaveLength(3 * stitchesOf(BAND, BAND[0].length - 1).length);
  });

  test('нити — из брендбука, у тёмной темы свои; строка — «Игра студии „Горница“»', () => {
    expect(THREADS.light).toEqual({ kumach: '#b3162f', spruce: '#1f3c34' });
    expect(THREADS.dark).toEqual({ kumach: '#e5566a', spruce: '#7fb3a3' });
    expect(T.about.studio).toBe('Игра студии «Горница»');
  });
});
