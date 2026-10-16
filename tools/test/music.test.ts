// Музыка по экрану (часть 62; 0.5.12 — отзыв на 0.5.11): на смене и в «Случае дня» — своя, в меню — своя; справочное —
// энциклопедию, настройки, источники — открывают и с приёма, и музыка при этом не меняется.
import { describe, expect, test } from 'bun:test';
import { musicSceneOf } from '../../src/audio/scene';

describe('музыка по экрану', () => {
  test('смена, «Случай дня» и «Разобрать случай» — музыка приёма, меню — своя', () => {
    expect(musicSceneOf('/shift', 'menu')).toBe('shift');
    expect(musicSceneOf('/shift/patient', 'menu')).toBe('shift');
    expect(musicSceneOf('/daily/case', 'menu')).toBe('shift');
    // с 0.5.17 (spec 2026-10-study-case): приём больного из статьи
    expect(musicSceneOf('/study/patient', 'menu')).toBe('shift');
    expect(musicSceneOf('/', 'shift')).toBe('menu');
    expect(musicSceneOf('/campaign', 'shift')).toBe('menu');
  });

  test('энциклопедия, настройки и источники — какая была: с приёма — приёма, из меню — меню', () => {
    for (const path of ['/encyclopedia', '/encyclopedia/conditions', '/encyclopedia/article/cond.arvi', '/settings', '/sources', '/licenses', '/about', '/report']) {
      expect(musicSceneOf(path, 'shift')).toBe('shift');
      expect(musicSceneOf(path, 'menu')).toBe('menu');
    }
    // похожий адрес — не справочное
    expect(musicSceneOf('/settingsx', 'shift')).toBe('menu');
  });
});
