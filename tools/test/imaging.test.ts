// Снимки кодом (spec 2026-09-ct-mri-ultrasound): срез головы на КТ и МРТ (часть 20) и сектор УЗИ
// (часть 21; подвздошная область с отростком — часть 29) — геометрия очагов, и сам рисунок без экрана (Skia через CanvasKit,
// tools/imaging/headless.ts): где светло и где темно, то же зерно — тот же рисунок.
import { beforeAll, describe, expect, test } from 'bun:test';
import { brainRadius, headGeometry, type HeadFindings, type HeadFocus, inside, skullInnerRadius } from '../../src/render/ct/geometry';
import { HEAD_CASES, US_CASES } from '../../src/state/imagingCases';
import { inSector, polar as usPolar, R1, usGeometry } from '../../src/render/us/geometry';
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

describe('сектор УЗИ: геометрия', () => {
  test('всё внутри сектора; точки — в пузыре у нижней стенки, тень — по лучу до конца сектора', () => {
    const g = usGeometry({ view: 'gallbladder', foci: { count: 3, size: 0.5 } }, 2);
    for (const p of g.gallbladder!) expect(inSector(p)).toBe(true);
    const gbCenter = centroid(g.gallbladder!);
    expect(g.foci).toHaveLength(3);
    for (const k of g.foci) {
      expect(inside(k.c, g.gallbladder!)).toBe(true);
      // дальше центра пузыря от датчика — у нижней стенки
      expect(usPolar(k.c).r).toBeGreaterThan(usPolar(gbCenter).r);
      // тень: два дальних угла — на конце сектора, по обе стороны луча точки
      const far = k.shadow.filter(p => Math.abs(usPolar(p).r - R1) < 1e-9);
      expect(far).toHaveLength(2);
      const a = usPolar(k.c).a;
      expect(Math.min(...far.map(p => usPolar(p).a))).toBeLessThan(a);
      expect(Math.max(...far.map(p => usPolar(p).a))).toBeGreaterThan(a);
    }
    // без точек — ни точек, ни теней; больше пяти — пять
    expect(usGeometry({ view: 'gallbladder' }, 2).foci).toHaveLength(0);
    expect(usGeometry({ view: 'gallbladder', foci: { count: 9, size: 1 } }, 2).foci).toHaveLength(5);
  });

  test('почка: синус и лоханка внутри почки; жидкость — между печенью и почкой, шире с параметром', () => {
    const g = usGeometry({ view: 'kidney', pelvis: 1, fluid: 1 }, 3);
    for (const p of g.sinus!) expect(inside(p, g.kidney!)).toBe(true);
    for (const part of g.pelvisParts!) for (const p of part) expect(inside(p, g.kidney!)).toBe(true);
    const thick = (f: number) => {
      const band = usGeometry({ view: 'kidney', fluid: f }, 3).fluid!;
      const ys = band.map(p => p[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(thick(1)).toBeGreaterThan(thick(0.2));
    expect(usGeometry({ view: 'kidney' }, 3).fluid).toBeUndefined();
    expect(usGeometry({ view: 'kidney' }, 3).pelvisParts).toBeUndefined();
  });

  test('утолщённая стенка пузыря (часть 30): наружный контур и полоска отёка — снаружи полости, толще с параметром; без неё — нет', () => {
    const g = usGeometry({ view: 'gallbladder', wall: 0.8 }, 2);
    const [outer, middle] = g.gbWall!;
    for (const p of g.gallbladder!) expect(inside(p, middle)).toBe(true);
    for (const p of middle) expect(inside(p, outer)).toBe(true);
    const width = (w: number) => {
      const xs = usGeometry({ view: 'gallbladder', wall: w }, 2).gbWall![0].map(p => p[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(width(1)).toBeGreaterThan(width(0.2));
    expect(usGeometry({ view: 'gallbladder' }, 2).gbWall).toBeUndefined();
    // жидкость — снаружи утолщённой стенки, дальше от датчика
    const wet = usGeometry({ view: 'gallbladder', wall: 0.8, fluid: 0.6 }, 2);
    const far = Math.max(...wet.gbWall![0].map(p => usPolar(p).r));
    expect(Math.max(...wet.fluid!.map(p => usPolar(p).r))).toBeGreaterThan(far);
  });

  test('подвздошная область: петли и сосуды — в секторе; «мишень» — кольца одно в другом, вокруг — жир; растёт с толщиной', () => {
    const g = usGeometry({ view: 'appendix', appendix: 0.8 }, 7);
    expect(g.loops).toHaveLength(3);
    for (const l of g.loops!) {
      // петля может уходить за край сектора — рисунок обрезан по нему; середина — в секторе
      expect(inSector(centroid(l.wall))).toBe(true);
      for (const p of l.gas) expect(l.wall).toContainEqual(p);
      // тень под газом — по лучам до конца сектора
      expect(l.shadow.filter(p => Math.abs(usPolar(p).r - R1) < 1e-9)).toHaveLength(2);
    }
    expect(g.vessels).toHaveLength(2);
    for (const v of g.vessels!) expect(inSector(v.c)).toBe(true);
    const rings = g.target!;
    expect(rings).toHaveLength(4);
    for (const p of rings[0]) expect(inSector(p)).toBe(true);
    for (let k = 1; k < rings.length; k++) for (const p of rings[k]) expect(inside(p, rings[k - 1])).toBe(true);
    for (const p of rings[0]) expect(inside(p, g.halo!)).toBe(true);
    // без отростка — ни мишени, ни жира, ни жидкости у него; толще — шире
    const none = usGeometry({ view: 'appendix', fluid: 1 }, 7);
    expect([none.target, none.halo, none.fluid]).toEqual([undefined, undefined, undefined]);
    const width = (t: number) => {
      const xs = usGeometry({ view: 'appendix', appendix: t }, 7).target![0].map(p => p[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(width(1)).toBeGreaterThan(width(0.3));
    // жидкость — серп под отростком: дальше от датчика, чем его середина
    const wet = usGeometry({ view: 'appendix', appendix: 0.9, fluid: 0.6 }, 8);
    const c = centroid(wet.target![0]);
    for (const p of wet.fluid!) expect(usPolar(p).r).toBeGreaterThan(usPolar(c).r);
    expect(usGeometry({ view: 'appendix', appendix: 0.9 }, 8).fluid).toBeUndefined();
  });
});

describe('сектор УЗИ: рисунок без экрана', () => {
  const S = 240;
  let draw: (f: import('../../src/render/us/geometry').UsFindings, seed: number) => Promise<{ rgba: Uint8Array; png: Uint8Array }>;
  beforeAll(async () => {
    await loadSkia();
    const { recordUsSector } = await import('../../src/render/us/sector');
    draw = (f, seed) => rasterize(recordUsSector(S, f, seed), S, S);
  });
  const at = (px: Uint8Array, p: [number, number]) => luma(px, S, S, p[0], p[1]);
  /** Средняя яркость по лучу `a` на глубинах от r0 до r1 — зерно усредняется. */
  const along = (px: Uint8Array, a: number, r0: number, r1: number) => {
    let sum = 0;
    for (let i = 0; i <= 20; i++) {
      const r = r0 + ((r1 - r0) * i) / 20;
      sum += at(px, [0.5 + r * Math.sin(a), -0.26 + r * Math.cos(a)]);
    }
    return sum / 21;
  };

  test('пузырь чёрный, за ним светлее, чем сбоку; за точкой — темнее', async () => {
    const g = usGeometry({ view: 'gallbladder' }, 1);
    const { rgba } = await draw({ view: 'gallbladder' }, 1);
    const c = centroid(g.gallbladder!);
    expect(at(rgba, c)).toBeLessThan(25);
    const pc = usPolar(c);
    const behind = along(rgba, pc.a, pc.r + 0.12, pc.r + 0.3);
    const beside = along(rgba, pc.a - 0.3, pc.r + 0.12, pc.r + 0.3);
    expect(behind).toBeGreaterThan(beside);

    const f = { view: 'gallbladder' as const, foci: { count: 1, size: 0.8 } };
    const k = usGeometry(f, 2).foci[0];
    const r2 = (await draw(f, 2)).rgba;
    const pk = usPolar(k.c);
    expect(along(r2, pk.a, pk.r + 0.12, pk.r + 0.3)).toBeLessThan(along(r2, pk.a - 0.25, pk.r + 0.12, pk.r + 0.3) - 20);
  });

  test('расширенная середина почки — тёмная; без расширения там светлый синус', async () => {
    const plain = usGeometry({ view: 'kidney' }, 4);
    const c = centroid(plain.sinus!);
    const normal = (await draw({ view: 'kidney' }, 4)).rgba;
    const wide = (await draw({ view: 'kidney', pelvis: 0.8 }, 4)).rgba;
    expect(at(normal, c)).toBeGreaterThan(90);
    expect(at(wide, c)).toBeLessThan(30);
  });

  test('отросток «мишенью»: тёмный просвет, светлый подслизистый слой, тёмный мышечный; вокруг — светлый жир', async () => {
    const f = { view: 'appendix' as const, appendix: 0.8 };
    const ring = usGeometry(f, 7).target![0];
    const c = centroid(ring);
    const xs = ring.map(p => p[0]);
    const R = (Math.max(...xs) - Math.min(...xs)) / 2;
    /** Средняя яркость по кругу радиуса k·R вокруг середины отростка. */
    const round = (px: Uint8Array, k: number) => {
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += at(px, [c[0] + k * R * Math.cos((i * Math.PI) / 8), c[1] + k * R * Math.sin((i * Math.PI) / 8)]);
      return sum / 16;
    };
    const on = (await draw(f, 7)).rgba;
    const off = (await draw({ view: 'appendix' }, 7)).rgba;
    expect(at(on, c)).toBeLessThan(30);
    expect(round(on, 0.45)).toBeGreaterThan(at(on, c) + 100);
    expect(round(on, 0.45)).toBeGreaterThan(round(on, 0.72) + 60);
    // вокруг — светлее, чем кишка там же без отростка; без отростка в середине — серая кишка
    expect(round(on, 1.3)).toBeGreaterThan(round(off, 1.3) + 25);
    expect(at(off, c)).toBeGreaterThan(60);
  });

  test('то же зерно — те же байты; все варианты «Проверок» рисуются', async () => {
    const a = await draw({ view: 'kidney', fluid: 0.5 }, 9);
    const b = await draw({ view: 'kidney', fluid: 0.5 }, 9);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(US_CASES.length).toBe(9);
    for (const k of US_CASES) expect((await draw(k.findings, k.seed)).png.length).toBeGreaterThan(1000);
  });
});

