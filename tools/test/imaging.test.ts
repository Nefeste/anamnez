// Снимки кодом (spec 2026-09-ct-mri-ultrasound, часть 20): срез головы на КТ и МРТ — геометрия
// очагов и смещения, и сам рисунок без экрана (Skia через CanvasKit, tools/imaging/headless.ts):
// где светло и где темно, то же зерно — тот же рисунок.
import { beforeAll, describe, expect, test } from 'bun:test';
import { brainRadius, headGeometry, type HeadFindings, type HeadFocus, inside, skullInnerRadius } from '../../src/render/ct/geometry';
import { HEAD_CASES } from '../../src/state/imagingCases';
import { loadSkia, luma, rasterize } from '../imaging/headless';

const CX = 0.5, CY = 0.5;
const polar = ([x, y]: [number, number]) => ({ t: Math.atan2(y - CY, x - CX), r: Math.hypot(x - CX, y - CY) });
const centroid = (pts: readonly [number, number][]): [number, number] => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
const focus = (o: Partial<HeadFocus>): HeadFocus => ({ density: 'high', shape: 'blob', side: 'right', region: 'middle', size: 0.6, ...o });

describe('срез головы: геометрия', () => {
  test('очаг в веществе — внутри мозга и на своей стороне (правая сторона пациента — слева на снимке)', () => {
    for (const shape of ['blob', 'wedge'] as const) {
      for (const side of ['right', 'left'] as const) {
        for (const region of ['front', 'middle', 'back'] as const) {
          for (const size of [0, 0.5, 1]) {
            const f = focus({ shape, side, region, size });
            const g = headGeometry({ focus: f }, 7);
            for (const p of g.focus!.outline) {
              const { t, r } = polar(p);
              expect(r).toBeLessThanOrEqual(brainRadius(f, t) + 0.002);
            }
            const [x] = centroid(g.focus!.outline);
            expect(side === 'right' ? x < 0.5 : x > 0.5).toBe(true);
          }
        }
      }
    }
  });

  test('серп и линза — у свода: между костью и мозгом, серп длиннее, линза толще', () => {
    const span = (f: HeadFocus) => {
      const g = headGeometry({ focus: f }, 3);
      const ts = g.focus!.outline.map(p => polar(p));
      for (const { t, r } of ts) {
        expect(r).toBeLessThanOrEqual(skullInnerRadius(t) + 0.002);
        expect(r).toBeGreaterThanOrEqual(brainRadius(f, t) - 0.002);
      }
      const angles = ts.map(p => Math.atan2(Math.sin(p.t - Math.PI), Math.cos(p.t - Math.PI)));
      const depth = Math.max(...ts.map(p => skullInnerRadius(p.t) - p.r));
      return { arc: Math.max(...angles) - Math.min(...angles), depth };
    };
    const crescent = span(focus({ shape: 'crescent', size: 0.6 }));
    const lens = span(focus({ shape: 'lens', size: 0.6 }));
    expect(crescent.arc).toBeGreaterThan(2 * lens.arc);
    expect(lens.depth).toBeGreaterThan(crescent.depth);
    // мозг под скоплением отодвинут от свода
    expect(brainRadius(focus({ shape: 'crescent', size: 0.6 }), Math.PI)).toBeLessThan(brainRadius(undefined, Math.PI) - 0.02);
  });

  test('смещение — в сторону, противоположную очагу; передний рог на стороне очага сдавлен; без очага смещения нет', () => {
    const normal = headGeometry({}, 5);
    const right = headGeometry({ focus: focus({ shape: 'crescent', side: 'right' }), shift: 0.8 }, 5);
    const left = headGeometry({ focus: focus({ shape: 'crescent', side: 'left' }), shift: 0.8 }, 5);
    expect(normal.midline).toBe(0.5);
    expect(right.midline).toBeGreaterThan(0.53);
    expect(left.midline).toBeLessThan(0.47);
    const width = (pts: [number, number][]) => Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]));
    // ventricles: передний рог справа пациента, треугольник справа, затем то же слева, затем третий
    expect(width(right.ventricles[0])).toBeLessThan(width(normal.ventricles[0]) * 0.6);
    expect(width(right.ventricles[2])).toBeGreaterThan(width(normal.ventricles[2]));
    expect(headGeometry({ shift: 1 }, 5).midline).toBe(0.5);
  });

  test('то же зерно — та же геометрия; другое — другие борозды при той же анатомии', () => {
    const a = headGeometry({ focus: focus({ shape: 'wedge' }) }, 11);
    expect(JSON.stringify(headGeometry({ focus: focus({ shape: 'wedge' }) }, 11))).toBe(JSON.stringify(a));
    const b = headGeometry({}, 12), c = headGeometry({}, 13);
    expect(JSON.stringify(b.ventricles)).toBe(JSON.stringify(c.ventricles));
    expect(JSON.stringify(b.skullInner)).toBe(JSON.stringify(c.skullInner));
    expect(JSON.stringify(b.sulci)).not.toBe(JSON.stringify(c.sulci));
  });

  test('параметры вне пределов — ближайшие допустимые', () => {
    const big = headGeometry({ focus: focus({ size: 5 }) }, 1);
    const one = headGeometry({ focus: focus({ size: 1 }) }, 1);
    expect(JSON.stringify(big.focus)).toBe(JSON.stringify(one.focus));
    expect(headGeometry({ focus: focus({ size: Number.NaN }) }, 1).focus!.outline.length).toBeGreaterThan(0);
  });
});

describe('срез головы: рисунок без экрана', () => {
  const S = 240;
  let draw: (f: HeadFindings, seed: number, mode?: 'ct' | 'mri') => Promise<{ rgba: Uint8Array; png: Uint8Array }>;
  beforeAll(async () => {
    await loadSkia();
    const { recordHeadSlice } = await import('../../src/render/ct/head');
    draw = (f, seed, mode = 'ct') => rasterize(recordHeadSlice(S, f, seed, mode), S, S);
  });
  const at = (px: Uint8Array, p: [number, number]) => luma(px, S, S, p[0], p[1]);
  const mirror = ([x, y]: [number, number]): [number, number] => [1 - x, y];

  test('КТ без очага: свод белый, желудочки тёмные, воздух чёрный', async () => {
    const { rgba } = await draw({}, 1);
    const g = headGeometry({}, 1);
    const topBone: [number, number] = [0.5, CY - (skullInnerRadius(-Math.PI / 2) + 0.012)];
    expect(at(rgba, topBone)).toBeGreaterThan(200);
    const horn = centroid(g.ventricles[0]);
    expect(inside(horn, g.ventricles[0])).toBe(true);
    expect(at(rgba, horn)).toBeLessThan(60);
    expect(at(rgba, [0.02, 0.02])).toBeLessThan(5);
    // мозг — серый, между жидкостью и костью
    const brain = at(rgba, [0.5, 0.2]);
    expect(brain).toBeGreaterThan(60);
    expect(brain).toBeLessThan(150);
  });

  test('светлый очаг светлее той же точки на другой стороне, тёмный — темнее; на МРТ светлый клин — светлее', async () => {
    const blob = focus({ shape: 'blob', size: 0.7 });
    const g1 = headGeometry({ focus: blob }, 2);
    const c1 = centroid(g1.focus!.outline);
    const r1 = (await draw({ focus: blob }, 2)).rgba;
    expect(at(r1, c1) - at(r1, mirror(c1))).toBeGreaterThan(60);

    const wedge = focus({ shape: 'wedge', density: 'low', side: 'left', size: 0.8 });
    const g2 = headGeometry({ focus: wedge }, 5);
    // у коры клин плотнее всего
    const outer = g2.focus!.outline[Math.floor(g2.focus!.outline.length / 4)];
    const probe: [number, number] = [CX + (outer[0] - CX) * 0.92, CY + (outer[1] - CY) * 0.92];
    const r2 = (await draw({ focus: wedge }, 5)).rgba;
    expect(at(r2, mirror(probe)) - at(r2, probe)).toBeGreaterThan(15);

    const mri = focus({ shape: 'wedge', density: 'high', size: 0.8 });
    const g3 = headGeometry({ focus: mri }, 7);
    const o3 = g3.focus!.outline[Math.floor(g3.focus!.outline.length / 4)];
    const p3: [number, number] = [CX + (o3[0] - CX) * 0.92, CY + (o3[1] - CY) * 0.92];
    const r3 = (await draw({ focus: mri }, 7, 'mri')).rgba;
    expect(at(r3, p3) - at(r3, mirror(p3))).toBeGreaterThan(60);
  });

  test('серп у свода справа светлый, слева на том же месте — нет', async () => {
    const f = focus({ shape: 'crescent', size: 0.8 });
    const t = Math.PI;
    const mid = (skullInnerRadius(t) + brainRadius(f, t)) / 2;
    const p: [number, number] = [CX + mid * Math.cos(t), CY + mid * Math.sin(t)];
    const { rgba } = await draw({ focus: f }, 3);
    expect(at(rgba, p)).toBeGreaterThan(150);
    expect(at(rgba, mirror(p))).toBeLessThan(120);
  });

  test('то же зерно — те же байты; другое — другой снимок', async () => {
    const a = await draw({ focus: focus({}) }, 4);
    const b = await draw({ focus: focus({}) }, 4);
    const c = await draw({ focus: focus({}) }, 5);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(Buffer.from(a.png).equals(Buffer.from(c.png))).toBe(false);
  });

  test('все варианты «Проверок» рисуются', async () => {
    expect(HEAD_CASES.length).toBe(7);
    for (const k of HEAD_CASES) {
      const { png } = await draw(k.findings, k.seed, k.mode);
      expect(png.length).toBeGreaterThan(1000);
      expect(k.label.length).toBeGreaterThan(0);
    }
  });
});
