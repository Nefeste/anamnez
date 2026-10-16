// Значки групп болезней (0.5.20): у каждой группы выбора диагноза — свой значок; контуры — строки SVG только из
// команд, которые понимает Skia, и в пределах сетки 24 × 24 (iconShapes.ts).
import { describe, expect, test } from 'bun:test';
import { SYSTEMS } from '../../src/content/types';
import { ICON_GRID, SYSTEM_ICONS } from '../../src/ui/iconShapes';

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

describe('значки групп', () => {
  test('у каждой группы выбора диагноза — значок, лишних нет', () => {
    expect(Object.keys(SYSTEM_ICONS).sort()).toEqual([...SYSTEMS].sort());
  });

  test('контуры — абсолютными командами SVG, координаты — в сетке 24 × 24', () => {
    for (const [k, shape] of Object.entries(SYSTEM_ICONS)) {
      const all = [...shape.stroke, ...(shape.fill ?? [])];
      expect(all.length, k).toBeGreaterThan(0);
      for (const d of all) {
        expect(d, k).toMatch(/^M[\d.\sMLHVCSQTAZ-]+$/);
        for (const x of coords(d)) expect(x >= 0 && x <= ICON_GRID, `${k}: ${x}`).toBe(true);
      }
    }
  });
});
