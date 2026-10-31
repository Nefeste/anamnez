// Значки групп болезней (0.5.20) и вкладок карты пациента (0.6.0): у каждой группы выбора диагноза — свой значок;
// контуры — строки SVG только из команд, которые понимают Skia и браузер, и в пределах сетки 24 × 24 (iconShapes.ts).
import { describe, expect, test } from 'bun:test';
import { SYSTEMS } from '../../src/content/types';
import { AWARD_ICON, CARD_ICONS, ICON_GRID, SHELF_ICONS, SYSTEM_ICONS } from '../../src/ui/iconShapes';

/** Числа контура по командам: у дуги A флаги — не координаты, их не проверяем. */
function coords(d: string): number[] {
  const out: number[] = [];
  for (const m of d.matchAll(/([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/g)) {
    const nums = (m[2].match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (m[1] === 'A') for (let i = 0; i + 6 < nums.length + 1; i += 7) out.push(nums[i + 5], nums[i + 6]);
    else out.push(...nums);
  }
  return out;
}

describe('значки кодом', () => {
  test('у каждой группы выбора диагноза — значок, лишних нет', () => {
    expect(Object.keys(SYSTEM_ICONS).sort()).toEqual([...SYSTEMS].sort());
  });

  test('у вкладок карты пациента и «Решения» — значки', () => {
    expect(Object.keys(CARD_ICONS).sort()).toEqual(['ask', 'card', 'decide', 'examine', 'order']);
  });

  test('контуры — абсолютными командами SVG, координаты — в сетке 24 × 24', () => {
    for (const [k, shape] of [...Object.entries(SYSTEM_ICONS), ...Object.entries(CARD_ICONS), ...Object.entries(SHELF_ICONS), ['award', AWARD_ICON] as const]) {
      const all = [...shape.stroke, ...(shape.fill ?? [])];
      expect(all.length, k).toBeGreaterThan(0);
      for (const d of all) {
        expect(d, k).toMatch(/^M[\d.\sMLHVCSQTAZ-]+$/);
        for (const x of coords(d)) expect(x >= 0 && x <= ICON_GRID, `${k}: ${x}`).toBe(true);
      }
    }
  });
});
