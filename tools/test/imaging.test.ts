// Снимки кодом (spec 2026-09-ct-mri-ultrasound): срез головы на КТ и МРТ (часть 20) и сектор УЗИ
// (часть 21; подвздошная область с отростком — часть 29), обзорный снимок живота стоя (spec
// 2026-09-chapter-2, часть 30б), снимок груди при травме (часть 32в) — геометрия очагов, и сам
// рисунок без экрана (Skia через CanvasKit, tools/imaging/headless.ts): где светло и где темно, то
// же зерно — тот же рисунок.
import { beforeAll, describe, expect, test } from 'bun:test';
import { brainRadius, headGeometry, type HeadFindings, type HeadFocus, inside, skullInnerRadius } from '../../src/render/ct/geometry';
import { ABDOMEN_CASES, CHEST_CASES, HEAD_CASES, US_CASES } from '../../src/state/imagingCases';
import { ABDOMEN_ASPECT, abdomenGeometry, colonAt, CRESCENT_X, DIAPHRAGM, domeY, type Loop, loopFolds, loopGas, loopLevels } from '../../src/render/xray/abdomenGeometry';
import * as chest from '../../src/render/xray/chestGeometry';
import { inSector, polar as usPolar, R1, usGeometry } from '../../src/render/us/geometry';
import { PANEL_BOTTOM, PANEL_TOP, veinGeometry } from '../../src/render/us/veinGeometry';
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

  test('левая подвздошная область: кишка вдоль, слои по порядку; дивертикул — у ближней стенки, в жиру, за ним тень; стенка толще с параметром', () => {
    const g = usGeometry({ view: 'colon', diverticulum: 0.8 }, 11);
    expect(g.loops).toHaveLength(2);
    for (const v of g.vessels!) expect(inSector(v.c)).toBe(true);
    const c = g.colon!;
    // газ — на ближней стенке просвета; тень под ним — до конца сектора
    for (const p of c.gas) expect(c.lumen).toContainEqual(p);
    expect(c.shadow.filter(p => Math.abs(usPolar(p).r - R1) < 1e-9)).toHaveLength(2);
    // по одному лучу сверху вниз: наружная стенка, подслизистый слой, просвет
    const top = (poly: [number, number][], k: number) => usPolar(poly[k]).r;
    for (const k of [5, 20, 35]) {
      expect(top(c.wall, k)).toBeLessThan(top(c.submucosa, k));
      expect(top(c.submucosa, k)).toBeLessThan(top(c.lumen, k));
    }
    // дивертикул — ближе к датчику, чем стенка кишки под ним; весь в светлом жире; за серединой — тень до конца
    const d = g.diverticulum!;
    const pd = usPolar(d.core.c);
    expect(pd.r).toBeLessThan(top(c.wall, 20));
    for (const p of d.wall) expect(inside(p, g.halo!)).toBe(true);
    expect(d.shadow.filter(p => Math.abs(usPolar(p).r - R1) < 1e-9)).toHaveLength(2);
    // без воспаления — ни дивертикула, ни жира; толще — стенка
    const none = usGeometry({ view: 'colon' }, 11);
    expect([none.diverticulum, none.halo]).toEqual([undefined, undefined]);
    const thick = (t: number) => {
      const x = usGeometry({ view: 'colon', diverticulum: t }, 11).colon!;
      return top(x.lumen, 20) - top(x.wall, 20);
    };
    expect(thick(1)).toBeGreaterThan(thick(0) * 2);
  });
});

describe('сектор УЗИ: рисунок без экрана', () => {
  const S = 240;
  let draw: (f: import('../../src/render/us/sector').UsImage, seed: number) => Promise<{ rgba: Uint8Array; png: Uint8Array }>;
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

  test('кишка: толстая стенка — темнее, чем там же без воспаления; дивертикул — яркая середина в тёмном кольце, вокруг светлее', async () => {
    const f = { view: 'colon' as const, diverticulum: 0.8 };
    const g = usGeometry(f, 11);
    const on = (await draw(f, 11)).rgba;
    const off = (await draw({ view: 'colon' }, 11)).rgba;
    const d = g.diverticulum!;
    const R = (Math.max(...d.wall.map(p => p[0])) - Math.min(...d.wall.map(p => p[0]))) / 2;
    /** Средняя яркость по верхней половине круга радиуса k·R — под дивертикулом тень. */
    const upper = (px: Uint8Array, k: number) => {
      let sum = 0;
      for (let i = 0; i <= 8; i++) sum += at(px, [d.core.c[0] + k * R * Math.cos(Math.PI + (i * Math.PI) / 8), d.core.c[1] + k * R * Math.sin(Math.PI + (i * Math.PI) / 8)]);
      return sum / 9;
    };
    expect(at(on, d.core.c)).toBeGreaterThan(200);
    expect(upper(on, 0.72)).toBeLessThan(at(on, d.core.c) - 100);
    expect(upper(on, 1.6)).toBeGreaterThan(upper(off, 1.6) + 20);
    // мышечный слой толстой стенки — там, где у здоровой кишки уже серая ткань вокруг
    const k = 32;
    const m: [number, number] = [(g.colon!.wall[k][0] + g.colon!.submucosa[k][0]) / 2, (g.colon!.wall[k][1] + g.colon!.submucosa[k][1]) / 2];
    expect(at(on, m)).toBeLessThan(at(off, m) - 20);
  });

  test('то же зерно — те же байты; все варианты «Проверок» рисуются', async () => {
    const a = await draw({ view: 'kidney', fluid: 0.5 }, 9);
    const b = await draw({ view: 'kidney', fluid: 0.5 }, 9);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(US_CASES.length).toBe(15);
    for (const k of US_CASES) expect((await draw(k.findings, k.seed)).png.length).toBeGreaterThan(1000);
  });

  // вены ноги линейным датчиком (часть 33а): слева без давления, справа датчиком давят
  test('вена: артерия и вена чёрные; под давлением здоровая вена сжимается, вена с тромбом — нет, внутри серое', async () => {
    const g = veinGeometry({ view: 'vein' }, 12);
    const [free, pressed] = g.panels;
    const normal = (await draw({ view: 'vein' }, 12)).rgba;
    for (const p of [free, pressed]) expect(at(normal, p.artery.c)).toBeLessThan(30);
    expect(at(normal, free.vein.c)).toBeLessThan(30);
    // где без давления была вена, под давлением — ткань: выше щели на полвысоты вены
    const above: [number, number] = [pressed.vein.c[0], pressed.vein.c[1] - free.vein.ry * 0.6];
    expect(at(normal, above)).toBeGreaterThan(40);
    const clot = veinGeometry({ view: 'vein', deep: 1 }, 12).panels;
    const withClot = (await draw({ view: 'vein', deep: 1 }, 12)).rgba;
    for (const p of clot) {
      expect(at(withClot, p.vein.c)).toBeGreaterThan(at(withClot, p.artery.c) + 12);
      expect(at(withClot, p.vein.c)).toBeLessThan(110);
    }
    const tear = veinGeometry({ view: 'vein', tear: 0.8 }, 15).panels[0].tear!;
    const torn = (await draw({ view: 'vein', tear: 0.8 }, 15)).rgba;
    const intact = (await draw({ view: 'vein' }, 15)).rgba;
    expect(at(torn, tear.c)).toBeLessThan(at(intact, tear.c) - 20);
  });
});

describe('УЗИ вены: геометрия', () => {
  test('без давления вены круглые; под давлением здоровые сжимаются в щель, артерия остаётся круглой', () => {
    const [free, pressed] = veinGeometry({ view: 'vein' }, 12).panels;
    expect([free.pressed, pressed.pressed]).toEqual([false, true]);
    expect(free.vein.ry).toBeGreaterThan(0.03);
    expect(pressed.vein.ry).toBeLessThan(0.01);
    expect(pressed.gsv.ry).toBeLessThan(0.01);
    expect(pressed.artery.ry).toBeGreaterThan(free.artery.ry * 0.85);
    // датчик сдавливает клетчатку: под давлением она тоньше
    expect(pressed.fat - pressed.skin).toBeLessThan(free.fat - free.skin);
  });

  test('тромб: глубокая вена шире и под давлением не сжимается; тромб в подкожной — вокруг светлый отёк', () => {
    const [free, pressed] = veinGeometry({ view: 'vein', deep: 1 }, 13).panels;
    expect([free.vein.clot, pressed.vein.clot]).toEqual([true, true]);
    expect(pressed.vein.ry).toBeCloseTo(free.vein.ry, 9);
    expect(free.vein.rx).toBeGreaterThan(veinGeometry({ view: 'vein' }, 13).panels[0].vein.rx);
    const s = veinGeometry({ view: 'vein', superficial: 1 }, 14).panels;
    for (const p of s) {
      expect(p.gsv.clot).toBe(true);
      expect(p.gsv.halo!.rx).toBeGreaterThan(p.gsv.rx);
      expect(p.gsv.ry).toBeGreaterThan(0.02);
    }
    expect(s[0].vein.clot).toBe(false);
  });

  test('гематома надрыва — в мышце, между фасцией и сосудами; всё — в пределах своего кадра', () => {
    for (const f of [{ view: 'vein' as const }, { view: 'vein' as const, deep: 1, superficial: 1, tear: 1 }]) {
      const g = veinGeometry(f, 15);
      for (const p of g.panels) {
        const [x0, x1] = p.x;
        for (const o of [p.gsv, p.artery, p.vein, ...(p.tear ? [p.tear] : [])]) {
          expect(o.c[0] - o.rx).toBeGreaterThanOrEqual(x0);
          expect(o.c[0] + o.rx).toBeLessThanOrEqual(x1);
          expect(o.c[1] - o.ry).toBeGreaterThanOrEqual(PANEL_TOP);
          expect(o.c[1] + o.ry).toBeLessThanOrEqual(PANEL_BOTTOM);
        }
        expect(p.gsv.c[1]).toBeGreaterThan(p.skin);
        expect(p.gsv.c[1]).toBeLessThan(p.fat);
        if (p.tear) {
          expect(p.tear.c[1] - p.tear.ry).toBeGreaterThan(p.fat);
          expect(p.tear.c[1] + p.tear.ry).toBeLessThan(p.vein.c[1] - p.vein.ry);
        }
      }
    }
    expect(veinGeometry({ view: 'vein' }, 15).panels[0].tear).toBeUndefined();
  });
});


describe('снимок живота: геометрия', () => {
  test('серп газа — под правым куполом: сразу под диафрагмой, слева на снимке, толще с параметром; без газа — нет', () => {
    const g = abdomenGeometry({ freeGas: 0.8 }, 2);
    expect(g.crescent!.length).toBeGreaterThan(10);
    for (const [x, y] of g.crescent!) {
      expect(x).toBeGreaterThanOrEqual(CRESCENT_X[0] - 1e-9);
      expect(x).toBeLessThanOrEqual(CRESCENT_X[1] + 1e-9);
      expect(x).toBeLessThan(0.5);
      expect(y).toBeGreaterThanOrEqual(domeY(x) + DIAPHRAGM - 1e-9);
      expect(y).toBeLessThanOrEqual(domeY(x) + DIAPHRAGM + 0.045);
    }
    const thick = (gas: number) => Math.max(...abdomenGeometry({ freeGas: gas }, 2).crescent!.map(([x, y]) => y - domeY(x)));
    expect(thick(1)).toBeGreaterThan(thick(0.2) + 0.015);
    expect(abdomenGeometry({}, 2).crescent).toBeUndefined();
    expect(abdomenGeometry({ freeGas: 0 }, 2).crescent).toBeUndefined();
  });

  test('петли: от трёх до шести по центру живота; дно газа — ровный уровень; в коленах арки — на разной высоте; без непроходимости петель нет', () => {
    const kinds = new Set<Loop['kind']>();
    for (const seed of [1, 3, 5, 8]) {
      const g = abdomenGeometry({ levels: 0.8 }, seed);
      expect(g.loops.length).toBeGreaterThanOrEqual(3);
      expect(g.loops.length).toBeLessThanOrEqual(6);
      for (const l of g.loops) {
        kinds.add(l.kind);
        const gas = loopGas(l);
        for (const [x, y] of gas) {
          expect(x).toBeGreaterThan(0.2);
          expect(x).toBeLessThan(0.8);
          expect(y).toBeGreaterThan(domeY(x) + 0.05);
          expect(y).toBeLessThan(0.8);
        }
        // ниже уровня газа нет: самая нижняя точка газа — на уровне
        const levels = loopLevels(l);
        const lowest = Math.max(...gas.map(p => p[1]));
        expect(lowest).toBeCloseTo(Math.max(...levels.map(v => v[0])), 9);
        if (l.kind === 'arch') {
          expect(Math.abs(l.levels[0] - l.levels[1])).toBeGreaterThan(0.005);
          for (const y of l.levels) {
            expect(y).toBeLessThanOrEqual(l.foot);
            expect(y).toBeGreaterThan(l.foot - l.h);
          }
        }
        // складки — поперёк газа: концы внутри контура петли или на нём
        for (const [p, q] of loopFolds(l)) for (const e of [p, q]) {
          const xs = gas.map(v => v[0]), ys = gas.map(v => v[1]);
          expect(e[0]).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-9);
          expect(e[0]).toBeLessThanOrEqual(Math.max(...xs) + 1e-9);
          expect(e[1]).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-9);
          expect(e[1]).toBeLessThanOrEqual(Math.max(...ys) + 1e-9);
        }
      }
    }
    expect([...kinds].sort()).toEqual(['arch', 'cup']);
    expect(abdomenGeometry({}, 3).loops).toHaveLength(0);
    // больше раздуты — больше петель
    expect(abdomenGeometry({ levels: 1 }, 3).loops.length).toBeGreaterThan(abdomenGeometry({ levels: 0.1 }, 3).loops.length);
  });

  test('при непроходимости тонкой кишки газа в ободочной почти нет; в норме — по рамке, в поперечной — всегда больше всего', () => {
    const length = (seed: number, levels?: number) => abdomenGeometry(levels ? { levels } : {}, seed).colon
      .reduce((a, k) => a + k.pts.slice(1).reduce((b, p, i) => b + Math.hypot(p[0] - k.pts[i][0], (p[1] - k.pts[i][1]) * ABDOMEN_ASPECT), 0), 0);
    let normal = 0, obstructed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      normal += length(seed);
      obstructed += length(seed, 0.8);
    }
    expect(obstructed).toBeLessThan(normal * 0.15);
    // гаустры — у краёв просвета, не на всю ширину
    const k = abdomenGeometry({}, 4).colon[0];
    for (const [edge, tip] of k.septa) expect(Math.hypot(tip[0] - edge[0], (tip[1] - edge[1]) * ABDOMEN_ASPECT)).toBeLessThan(k.width / 2);
    // ход кишки: слепая внизу справа пациента (слева на снимке), прямая — в малом тазу посередине
    expect(colonAt(0)[0]).toBeLessThan(0.3);
    expect(colonAt(1)[1]).toBeGreaterThan(0.85);
  });

  test('то же зерно — та же геометрия; параметры вне пределов — ближайшие допустимые', () => {
    expect(JSON.stringify(abdomenGeometry({ freeGas: 0.5, levels: 0.5 }, 11))).toBe(JSON.stringify(abdomenGeometry({ freeGas: 0.5, levels: 0.5 }, 11)));
    expect(JSON.stringify(abdomenGeometry({ freeGas: 5 }, 1).crescent)).toBe(JSON.stringify(abdomenGeometry({ freeGas: 1 }, 1).crescent));
    expect(abdomenGeometry({ freeGas: Number.NaN, levels: Number.NaN }, 1).crescent).toBeUndefined();
    expect(abdomenGeometry({ levels: -1 }, 1).loops).toHaveLength(0);
  });
});

describe('снимок живота: рисунок без экрана', () => {
  const S = 240;
  const SH = Math.round(S * ABDOMEN_ASPECT);
  let draw: (f: import('../../src/render/xray/abdomenGeometry').AbdomenFindings, seed: number) => Promise<{ rgba: Uint8Array; png: Uint8Array }>;
  beforeAll(async () => {
    await loadSkia();
    const { recordAbdomenXray } = await import('../../src/render/xray/abdomen');
    draw = (f, seed) => rasterize(recordAbdomenXray(S, f, seed), S, SH);
  });
  const at = (px: Uint8Array, p: [number, number]) => luma(px, S, SH, p[0], p[1]);

  test('лёгкие над куполами — тёмные, позвонок светлее мягких тканей рядом', async () => {
    const { rgba } = await draw({}, 1);
    // над куполом — воздух лёгкого, под ним — печень
    expect(at(rgba, [0.2, 0.09])).toBeLessThan(60);
    expect(at(rgba, [0.2, 0.25]) - at(rgba, [0.2, 0.09])).toBeGreaterThan(40);
    // L1 — выше поперечной ободочной кишки: её газ позвонок не перекрывает
    const l1 = abdomenGeometry({}, 1).vertebrae[1];
    expect(at(rgba, [0.5, l1.y + l1.h / 2])).toBeGreaterThan(at(rgba, [0.34, l1.y + l1.h / 2]) + 12);
  });

  test('серп газа под правым куполом темнее того же места без газа', async () => {
    const x = 0.28;
    const mid = abdomenGeometry({ freeGas: 0.8 }, 2).crescent!;
    const ys = mid.filter(p => Math.abs(p[0] - x) < 0.007).map(p => p[1]);
    const p: [number, number] = [x, (Math.min(...ys) + Math.max(...ys)) / 2];
    const on = (await draw({ freeGas: 0.8 }, 2)).rgba;
    const off = (await draw({}, 2)).rgba;
    expect(at(off, p) - at(on, p)).toBeGreaterThan(30);
  });

  test('в петле над уровнем — тёмный газ, под уровнем — светлее: жидкость как мягкие ткани', async () => {
    const g = abdomenGeometry({ levels: 0.8 }, 3);
    const cup = g.loops.find(l => l.kind === 'cup')!;
    if (cup.kind !== 'cup') throw new Error('нет чаши');
    const { rgba } = await draw({ levels: 0.8 }, 3);
    expect(at(rgba, [cup.cx, cup.level + 0.02]) - at(rgba, [cup.cx, cup.level - cup.b * 0.45])).toBeGreaterThan(25);
  });

  test('то же зерно — те же байты; другое — другой снимок; все варианты «Проверок» рисуются', async () => {
    const a = await draw({ levels: 0.5 }, 9);
    const b = await draw({ levels: 0.5 }, 9);
    const c = await draw({ levels: 0.5 }, 10);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(Buffer.from(a.png).equals(Buffer.from(c.png))).toBe(false);
    expect(ABDOMEN_CASES.map(k => k.key)).toEqual(['abd-normal', 'abd-free-gas', 'abd-levels']);
    for (const k of ABDOMEN_CASES) {
      expect((await draw(k.findings, k.seed)).png.length).toBeGreaterThan(1000);
      expect(k.label.length).toBeGreaterThan(0);
    }
  });
});

describe('снимок груди при травме: геометрия', () => {
  const minX = (pts: readonly [number, number][]) => Math.min(...pts.map(p => p[0]));
  const maxX = (pts: readonly [number, number][]) => Math.max(...pts.map(p => p[0]));

  test('пневмоторакс: край лёгкого — в своём поле; у большого дальше от стенки, чем у малого; без воздуха края нет', () => {
    const wall = minX(chest.hemithorax(-1, {}));
    const small = chest.collapsedLung({ pneumothorax: { side: 'right', size: 'small' } })!;
    const large = chest.collapsedLung({ pneumothorax: { side: 'right', size: 'large' } })!;
    // правая сторона пациента — слева на снимке
    expect(maxX(small)).toBeLessThan(0.5);
    expect(maxX(large)).toBeLessThan(0.5);
    // малый — узкая полоса у стенки, большой — лёгкое поджато к корню
    expect(minX(small) - wall).toBeGreaterThan(0.01);
    expect(minX(small) - wall).toBeLessThan(0.05);
    expect(minX(large) - wall).toBeGreaterThan(0.1);
    // стоя воздух собирается вверху: у верхушки полоса шире, чем у купола
    const top = (pts: readonly [number, number][]) => Math.min(...pts.map(p => p[1]));
    const bottom = (pts: readonly [number, number][]) => Math.max(...pts.map(p => p[1]));
    const field = chest.hemithorax(-1, {});
    expect(top(small) - top(field)).toBeGreaterThan(bottom(field) - bottom(small));
    // левый — справа на снимке
    expect(minX(chest.collapsedLung({ pneumothorax: { side: 'left', size: 'large' } })!)).toBeGreaterThan(0.5);
    expect(chest.collapsedLung({})).toBeUndefined();
    // гемопневмоторакс: воздух над кровью — край лёгкого тоже есть
    expect(chest.collapsedLung({ effusion: { side: 'left', air: true } })).toBeDefined();
  });

  test('напряжённый пневмоторакс и массивная кровь сдвигают средостение в здоровую сторону, купол на стороне воздуха ниже', () => {
    expect(chest.mediastinalShift({ pneumothorax: { side: 'right', size: 'large', tension: true } })).toBeGreaterThan(0);
    expect(chest.mediastinalShift({ pneumothorax: { side: 'left', size: 'large', tension: true } })).toBeLessThan(0);
    expect(chest.mediastinalShift({ effusion: { side: 'right', massive: true } })).toBeGreaterThan(0);
    expect(chest.mediastinalShift({ effusion: { side: 'left', massive: true } })).toBeLessThan(0);
    expect(chest.mediastinalShift({ pneumothorax: { side: 'right', size: 'large' } })).toBe(0);
    expect(chest.mediastinalShift({ effusion: { side: 'right' } })).toBe(0);
    expect(chest.mediastinalShift({})).toBe(0);
    const tension = { pneumothorax: { side: 'right' as const, size: 'large' as const, tension: true } };
    expect(chest.domeY(-1, tension)).toBeGreaterThan(chest.domeY(-1, {}));
    expect(chest.domeY(1, tension)).toBe(chest.domeY(1, {}));
  });

  test('кровь: внизу своего поля, у стенки выше, чем у средостения; массивная — выше средней; с воздухом — ровный уровень', () => {
    const mid = chest.fluidTop({ effusion: { side: 'right' } })!;
    const big = chest.fluidTop({ effusion: { side: 'right', massive: true } })!;
    const level = chest.fluidTop({ effusion: { side: 'right', air: true } })!;
    expect(maxX(mid)).toBeLessThanOrEqual(0.5);
    expect(minX(chest.fluidTop({ effusion: { side: 'left' } })!)).toBeGreaterThanOrEqual(0.5);
    // у стенки (первая точка) граница выше — меньше y
    expect(mid[0][1]).toBeLessThan(mid[mid.length - 1][1]);
    // средняя — над куполом, но ниже середины поля; массивная — выше
    expect(mid[0][1]).toBeLessThan(chest.domeY(-1, {}));
    expect(mid[0][1]).toBeGreaterThan(0.45);
    expect(big[0][1]).toBeLessThan(mid[0][1] - 0.15);
    expect(new Set(level.map(p => p[1])).size).toBe(1);
    expect(chest.fluidTop({})).toBeUndefined();
  });

  test('перелом ребра — в боковом отделе своего ребра, на своей стороне; номера по зерну одни, три — соседние вокруг одного', () => {
    const layout = chest.ribLayout(5, false);
    for (const n of [4, 6, 8]) {
      const rib = layout[n - 1];
      const right = chest.ribFractureAt(-1, rib);
      const left = chest.ribFractureAt(1, rib);
      expect(right.at[0]).toBeLessThan(0.5 - 0.2);
      expect(left.at[0]).toBeGreaterThan(0.5 + 0.2);
      expect(Math.abs(right.at[1] - rib.y0)).toBeLessThan(0.06);
    }
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const [one] = chest.fracturedRibs(seed, false);
      expect(one).toBeGreaterThanOrEqual(4);
      expect(one).toBeLessThanOrEqual(8);
      expect(chest.fracturedRibs(seed, true)).toEqual([one - 1, one, one + 1]);
      expect(chest.fracturedRibs(seed, false)).toEqual([one]);
    }
    expect(chest.ribLayout(5, false)).toEqual(layout);
  });
});

describe('снимок груди при травме: рисунок без экрана', () => {
  const S = 240;
  const SH = Math.round(S * chest.XRAY_ASPECT);
  let draw: (f: chest.XrayFindings, seed: number) => Promise<{ rgba: Uint8Array; png: Uint8Array }>;
  beforeAll(async () => {
    await loadSkia();
    const { recordChestXray } = await import('../../src/render/xray/chest');
    draw = (f, seed) => rasterize(recordChestXray(S, f, seed), S, SH);
  });
  const at = (px: Uint8Array, p: [number, number]) => luma(px, S, SH, p[0], p[1]);

  test('воздух между краем лёгкого и стенкой — темнее того же места без пневмоторакса: сосудов там нет', async () => {
    const off = (await draw({}, 3)).rgba;
    const on = (await draw({ pneumothorax: { side: 'left', size: 'large' } }, 3)).rgba;
    for (const p of [[0.8, 0.45], [0.78, 0.3], [0.82, 0.55]] as [number, number][]) expect(at(off, p) - at(on, p)).toBeGreaterThan(12);
  });

  test('кровь внизу поля — светлее того же места без неё: мягкие ткани, а не воздух', async () => {
    const off = (await draw({}, 3)).rgba;
    const on = (await draw({ effusion: { side: 'left' } }, 3)).rgba;
    for (const p of [[0.8, 0.62], [0.75, 0.6], [0.85, 0.63]] as [number, number][]) expect(at(on, p) - at(off, p)).toBeGreaterThan(40);
  });

  test('напряжённый пневмоторакс справа сдвигает сердце влево: за прежним краем тени сердца светло', async () => {
    const off = (await draw({}, 3)).rgba;
    const on = (await draw({ pneumothorax: { side: 'right', size: 'large', tension: true } }, 3)).rgba;
    for (const p of [[0.76, 0.62], [0.77, 0.58]] as [number, number][]) expect(at(on, p) - at(off, p)).toBeGreaterThan(40);
  });

  test('то же зерно — те же байты; все варианты «Проверок» рисуются', async () => {
    const a = await draw({ ribFractures: { side: 'right', ribs: [5, 6, 7] } }, 9);
    const b = await draw({ ribFractures: { side: 'right', ribs: [5, 6, 7] } }, 9);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    const plain = await draw({}, 9);
    expect(Buffer.from(a.png).equals(Buffer.from(plain.png))).toBe(false);
    expect(CHEST_CASES.map(k => k.key)).toEqual(['chest-small', 'chest-large', 'chest-tension', 'chest-fluid', 'chest-massive', 'chest-level', 'chest-rib']);
    for (const k of CHEST_CASES) {
      expect((await draw(k.findings, k.seed)).png.length).toBeGreaterThan(1000);
      expect(k.label.length).toBeGreaterThan(0);
    }
  });
});
