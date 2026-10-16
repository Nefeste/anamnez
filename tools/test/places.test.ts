// «Осмотреть» фигурой (spec 2026-10-patient-card, 0.6.0): у каждого осмотра руками и у постели — место на теле или
// полка, лишних нет; фигура — абсолютные команды SVG в поле рисунка; точки мест — на фигуре.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { BODY_H, BODY_POINTS, BODY_SHAPE, BODY_W } from '../../src/ui/bodyShape';
import { BODY_PLACES, EXAM_PLACES, SHELVES } from '../../src/ui/case/places';

const examined = Object.values(db.exams).filter(e => e.kind === 'physical' || e.kind === 'bedside');

/** Числа контура по командам; у дуги A флаги и радиусы — не координаты, берём только конечную точку. */
function coords(d: string): number[] {
  const out: number[] = [];
  for (const m of d.matchAll(/([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/g)) {
    const nums = (m[2].match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (m[1] === 'A') for (let i = 0; i + 6 < nums.length + 1; i += 7) out.push(nums[i + 5], nums[i + 6]);
    else out.push(...nums);
  }
  return out;
}

describe('фигура в «Осмотреть»', () => {
  test('у каждого осмотра руками и у постели — место, лишних нет', () => {
    expect(Object.keys(EXAM_PLACES).sort()).toEqual(examined.map(e => e.id).sort());
    const places = new Set<string>([...BODY_PLACES, ...SHELVES]);
    for (const [id, place] of Object.entries(EXAM_PLACES)) expect({ id, ok: places.has(place) }).toEqual({ id, ok: true });
  });

  test('приборы у постели — на полке «У постели», осмотры руками — нет', () => {
    for (const e of examined) expect({ id: e.id, bedside: EXAM_PLACES[e.id] === 'bedside' }).toEqual({ id: e.id, bedside: e.kind === 'bedside' });
  });

  test('контуры — абсолютными командами SVG в поле рисунка', () => {
    for (const d of [BODY_SHAPE.body, ...BODY_SHAPE.lines, BODY_SHAPE.navel]) {
      expect(d).toMatch(/^M[\d.\sMLHVCSQTAZ-]+$/);
      const xy = coords(d);
      for (let i = 0; i + 1 < xy.length; i += 2) {
        expect(xy[i] >= 0 && xy[i] <= BODY_W, `x ${xy[i]}`).toBe(true);
        expect(xy[i + 1] >= 0 && xy[i + 1] <= BODY_H, `y ${xy[i + 1]}`).toBe(true);
      }
    }
  });

  test('у каждого места на теле — точка в поле рисунка', () => {
    expect(Object.keys(BODY_POINTS).sort()).toEqual([...BODY_PLACES].sort());
    for (const p of BODY_PLACES) {
      const { x, y } = BODY_POINTS[p];
      expect({ p, inside: x > 0 && x < BODY_W && y > 0 && y < BODY_H }).toEqual({ p, inside: true });
    }
  });
});
