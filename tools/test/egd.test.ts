// ЭГДС кодом (spec 2026-10-chapter-4, часть 53а-2; ADR 0013): поле зрения эндоскопа — язва и что в её дне по Форресту,
// разрыв слизистой кардии, кровь без видимого источника. Геометрия — в долях кадра; рисунок без экрана (Skia через
// CanvasKit, tools/imaging/headless.ts): где бело, где красно и где темно, то же зерно — те же байты. Картинка в карте
// пациента — по тому, что показала ЭГДС.
import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { generatePatient } from '../../src/engine/med/generate';
import type { Observation } from '../../src/engine/med/types';
import { type EgdFindings, egdGeometry, FIELD, inside, type Pt, type UlcerBase } from '../../src/render/egd/geometry';
import { type CaseInput, makeCaseView } from '../../src/state/caseView';
import { EGD_CASES } from '../../src/state/imagingCases';
import { loadSkia, luma, rasterize } from '../imaging/headless';

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const BASES: UlcerBase[] = ['clean', 'spots', 'vessel', 'clot', 'bleeding'];
const SIZES = [0, 0.5, 1];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const centroid = (pts: readonly Pt[]): Pt => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
/** Наибольшее удаление точек контура от середины. */
const reach = (pts: readonly Pt[], c: Pt) => Math.max(...pts.map(p => dist(p, c)));
/** Запас до края поля зрения: больше нуля — внутри. */
const slack = (pts: readonly Pt[]) => Math.min(...pts.map(p => FIELD.r - dist(p, FIELD.c)));

describe('ЭГДС: геометрия', () => {
  test('вид: при разрыве — кардия с зубчатой линией, иначе — желудок; без находок — ни язвы, ни разрыва, ни крови', () => {
    for (const seed of SEEDS) {
      const normal = egdGeometry({}, seed);
      expect(normal.view).toBe('stomach');
      expect(normal.zline ?? normal.ulcer ?? normal.tear ?? normal.blood).toBeUndefined();
      expect(slack(normal.lumen.outline)).toBeGreaterThan(0.1);
      expect(egdGeometry({ ulcer: { base: 'clean', size: 0.5 } }, seed).view).toBe('stomach');
      expect(egdGeometry({ blood: true }, seed).view).toBe('stomach');
      const cardia = egdGeometry({ tear: { bleeding: false, size: 0.5 } }, seed);
      expect(cardia.view).toBe('cardia');
      // зубчатая линия — вокруг просвета
      expect(inside(cardia.lumen.c, cardia.zline!)).toBe(true);
      expect(cardia.lumen.outline.every(p => inside(p, cardia.zline!))).toBe(true);
    }
  });

  test('язва — ниже просвета, в нижней половине поля и не заходит на просвет; валик — вокруг кратера, в поле зрения', () => {
    for (const seed of SEEDS) {
      for (const base of BASES) {
        for (const size of SIZES) {
          const g = egdGeometry({ ulcer: { base, size } }, seed);
          const u = g.ulcer!;
          expect(u.base).toBe(base);
          expect(u.c[1]).toBeGreaterThan(g.lumen.c[1] + 0.1);
          expect(u.c[1]).toBeGreaterThan(0.55);
          expect(dist(u.c, g.lumen.c)).toBeGreaterThan(reach(g.lumen.outline, g.lumen.c) + reach(u.outline, u.c));
          expect(u.outline.every(p => inside(p, u.halo))).toBe(true);
          expect(slack(u.halo)).toBeGreaterThan(0);
        }
      }
    }
  });

  test('в дне — по Форресту: пятна, сосуд или сгусток — внутри кратера; у чистого дна — ничего; с параметром язва больше', () => {
    for (const seed of SEEDS) {
      const at = (base: UlcerBase, size = 0.6) => egdGeometry({ ulcer: { base, size } }, seed).ulcer!;
      const clean = at('clean');
      expect(clean.spots.length + (clean.vessel ? 1 : 0) + (clean.clot ? 1 : 0)).toBe(0);
      const spots = at('spots');
      expect(spots.spots.length).toBeGreaterThanOrEqual(3);
      expect(spots.spots.length).toBeLessThanOrEqual(5);
      for (const s of spots.spots) expect(inside(s.c, spots.outline)).toBe(true);
      expect(spots.vessel ?? spots.clot).toBeUndefined();
      for (const base of ['vessel', 'bleeding'] as const) {
        const u = at(base);
        expect(inside(u.vessel!.c, u.outline)).toBe(true);
        expect(u.clot).toBeUndefined();
      }
      const clot = at('clot');
      expect(inside(centroid(clot.clot!), clot.outline)).toBe(true);
      expect(clot.vessel).toBeUndefined();
      expect(at('clean', 1).r).toBeGreaterThan(at('clean', 0).r * 1.8);
    }
  });

  test('разрыв — поперёк зубчатой линии: внутренний конец — внутри неё, но не в просвете, наружный — в пищеводе; с параметром длиннее и шире', () => {
    for (const seed of SEEDS) {
      for (const bleeding of [false, true]) {
        for (const size of SIZES) {
          const g = egdGeometry({ tear: { bleeding, size } }, seed);
          const t = g.tear!;
          expect(t.bleeding).toBe(bleeding);
          expect(inside(t.axis[0], g.zline!)).toBe(true);
          expect(inside(t.axis[0], g.lumen.outline)).toBe(false);
          expect(inside(t.axis[1], g.zline!)).toBe(false);
          expect(slack(t.outline)).toBeGreaterThan(0);
        }
      }
      const small = egdGeometry({ tear: { bleeding: false, size: 0 } }, seed).tear!;
      const big = egdGeometry({ tear: { bleeding: false, size: 1 } }, seed).tear!;
      expect(dist(...big.axis)).toBeGreaterThan(dist(...small.axis) + 0.05);
      expect(big.width).toBeGreaterThan(small.width * 1.5);
    }
  });

  test('кровь: из язвы — лужица в дне и струйки вниз по стенке, из разрыва — в просвет, без источника — озерцо внизу поля; без кровотечения — нет', () => {
    for (const seed of SEEDS) {
      const ub = egdGeometry({ ulcer: { base: 'bleeding', size: 0.7 } }, seed);
      const u = ub.ulcer!;
      expect(ub.blood!.streams.length).toBeGreaterThanOrEqual(1);
      for (const s of ub.blood!.streams) {
        const [first, last] = [s.path[0], s.path[s.path.length - 1]];
        expect(first[1]).toBeGreaterThan(u.c[1]);
        expect(last[1]).toBeGreaterThan(first[1] + 0.1);
        expect(slack(s.path)).toBeGreaterThan(s.width / 2);
      }
      expect(slack(ub.blood!.pool)).toBeGreaterThan(0);

      const tb = egdGeometry({ tear: { bleeding: true, size: 0.7 } }, seed);
      const s = tb.blood!.streams[0];
      expect(inside(s.path[s.path.length - 1], tb.lumen.outline)).toBe(true);

      const lake = egdGeometry({ blood: true }, seed).blood!;
      expect(lake.streams).toEqual([]);
      expect(centroid(lake.pool)[1]).toBeGreaterThan(0.75);
      expect(slack(lake.pool)).toBeGreaterThanOrEqual(0);

      for (const f of [{ ulcer: { base: 'clean', size: 0.5 } }, { ulcer: { base: 'vessel', size: 0.5 } }, { ulcer: { base: 'clot', size: 0.5 } }, { tear: { bleeding: false, size: 0.5 } }, {}] as EgdFindings[]) {
        expect(egdGeometry(f, seed).blood).toBeUndefined();
      }
    }
  });

  test('блики — по стенке, но не в просвете и не на находке: дно язвы, разрыв и кровь видны целиком', () => {
    for (const seed of SEEDS) {
      for (const f of [{}, { ulcer: { base: 'clean', size: 1 } }, { ulcer: { base: 'bleeding', size: 0.7 } }, { tear: { bleeding: true, size: 1 } }, { blood: true }] as EgdFindings[]) {
        const g = egdGeometry(f, seed);
        expect(g.glints.length).toBe(8);
        for (const b of g.glints) {
          expect(dist(b.c, g.lumen.c)).toBeGreaterThanOrEqual(g.lumen.r * 1.4);
          if (g.ulcer) expect(dist(b.c, g.ulcer.c)).toBeGreaterThanOrEqual(g.ulcer.r * 1.3 + b.rx);
          if (g.tear) {
            const [a, z] = g.tear.axis;
            expect(dist(b.c, [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2])).toBeGreaterThanOrEqual(dist(a, z) / 2 + b.rx);
          }
          if (g.blood) expect(g.blood.pool.every(p => dist(p, b.c) >= b.rx * 2)).toBe(true);
        }
      }
    }
  });

  test('то же зерно — та же геометрия; стенка и просвет от находок не зависят; параметры вне пределов — ближайшие допустимые', () => {
    const f: EgdFindings = { ulcer: { base: 'vessel', size: 0.6 } };
    expect(JSON.stringify(egdGeometry(f, 11))).toBe(JSON.stringify(egdGeometry(f, 11)));
    const normal = egdGeometry({}, 11);
    expect(JSON.stringify(egdGeometry(f, 11).folds)).toBe(JSON.stringify(normal.folds));
    expect(JSON.stringify(egdGeometry(f, 11).lumen)).toBe(JSON.stringify(normal.lumen));
    expect(JSON.stringify(egdGeometry({}, 12).folds)).not.toBe(JSON.stringify(normal.folds));
    const big = egdGeometry({ ulcer: { base: 'clean', size: 5 } }, 3), one = egdGeometry({ ulcer: { base: 'clean', size: 1 } }, 3);
    expect(JSON.stringify(big.ulcer)).toBe(JSON.stringify(one.ulcer));
    const nan = egdGeometry({ tear: { bleeding: false, size: Number.NaN } }, 3), zero = egdGeometry({ tear: { bleeding: false, size: 0 } }, 3);
    expect(JSON.stringify(nan.tear)).toBe(JSON.stringify(zero.tear));
  });
});

describe('ЭГДС: рисунок без экрана', () => {
  const S = 240;
  let draw: (f: EgdFindings, seed: number) => Promise<{ rgba: Uint8Array; png: Uint8Array }>;
  beforeAll(async () => {
    await loadSkia();
    const { recordEgdView } = await import('../../src/render/egd/view');
    draw = (f, seed) => rasterize(recordEgdView(S, f, seed), S, S);
  });
  /** Цвет точки (доли кадра) — среднее по квадрату 3 × 3. */
  const rgb = (px: Uint8Array, [x, y]: Pt): [number, number, number] => {
    const cx = Math.round(x * (S - 1)), cy = Math.round(y * (S - 1));
    const sum = [0, 0, 0];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = ((cy + dy) * S + cx + dx) * 4;
        for (let k = 0; k < 3; k++) sum[k] += px[i + k];
      }
    }
    return [sum[0] / 9, sum[1] / 9, sum[2] / 9];
  };
  const at = (px: Uint8Array, p: Pt) => luma(px, S, S, p[0], p[1]);
  const few = SEEDS.slice(0, 6);

  test('вне поля зрения — чёрное; слизистая — розово-красная, у торца эндоскопа светлее, чем у края; просвет — почти чёрный', async () => {
    for (const seed of few) {
      const { rgba } = await draw({}, seed);
      for (const p of [[0.02, 0.02], [0.98, 0.5], [0.5, 0.995]] as Pt[]) expect(Math.max(...rgb(rgba, p))).toBeLessThan(3);
      const near = rgb(rgba, [0.5, 0.62]);
      expect(near[0]).toBeGreaterThan(near[1] * 1.3);
      expect(near[2]).toBeLessThan(near[1]);
      expect(at(rgba, [0.5, 0.62]) - at(rgba, [0.5, 0.93])).toBeGreaterThan(40);
      expect(at(rgba, egdGeometry({}, seed).lumen.c)).toBeLessThan(30);
    }
  });

  test('чистое дно язвы — белёсое: светлее и желтее слизистой на том же месте; валик вокруг — краснее', async () => {
    for (const seed of few) {
      const f: EgdFindings = { ulcer: { base: 'clean', size: 0.6 } };
      const u = egdGeometry(f, seed).ulcer!;
      const sick = (await draw(f, seed)).rgba, well = (await draw({}, seed)).rgba;
      const [r, , b] = rgb(sick, u.c);
      expect(b).toBeGreaterThan(r * 0.75);
      expect(rgb(well, u.c)[2]).toBeLessThan(rgb(well, u.c)[0] * 0.6);
      expect(at(sick, u.c) - at(well, u.c)).toBeGreaterThan(35);
      // валик — по кольцу между кратером и краем отёка: зелёного меньше, чем у здоровой слизистой там же
      const ring = Array.from({ length: 12 }, (_, i): Pt => {
        const t = (i / 12) * 2 * Math.PI;
        return [u.c[0] + 1.3 * u.r * Math.cos(t), u.c[1] + 1.1 * u.r * Math.sin(t)];
      });
      const redness = (px: Uint8Array) => ring.reduce((a, p) => a + rgb(px, p)[0] / rgb(px, p)[1], 0) / ring.length;
      expect(redness(sick)).toBeGreaterThan(redness(well) + 0.25);
    }
  });

  test('сосуд — тёмно-красный бугорок в белёсом дне, сгусток — тёмный комок; кровь — алая: красного больше зелёного в разы', async () => {
    for (const seed of few) {
      const vessel: EgdFindings = { ulcer: { base: 'vessel', size: 0.7 } };
      const v = egdGeometry(vessel, seed).ulcer!.vessel!;
      const pv = rgb((await draw(vessel, seed)).rgba, v.c);
      expect(pv[0]).toBeGreaterThan(pv[1] * 2);
      expect(pv[1]).toBeLessThan(90);

      const clot: EgdFindings = { ulcer: { base: 'clot', size: 0.7 } };
      expect(at((await draw(clot, seed)).rgba, centroid(egdGeometry(clot, seed).ulcer!.clot!))).toBeLessThan(50);

      const bleeding: EgdFindings = { ulcer: { base: 'bleeding', size: 0.7 } };
      const gb = egdGeometry(bleeding, seed).blood!;
      const pb = (await draw(bleeding, seed)).rgba;
      const pool = rgb(pb, centroid(gb.pool));
      expect(pool[0]).toBeGreaterThan(150);
      expect(pool[0]).toBeGreaterThan(pool[1] * 5);
      const path = gb.streams[0].path, mid = rgb(pb, path[Math.floor(path.length / 2)]);
      expect(mid[0]).toBeGreaterThan(mid[1] * 5);

      const lake = centroid(egdGeometry({ blood: true }, seed).blood!.pool);
      const pl = rgb((await draw({ blood: true }, seed)).rgba, lake), pn = rgb((await draw({}, seed)).rgba, lake);
      expect(pl[0]).toBeGreaterThan(pl[1] * 5);
      expect(pn[0]).toBeLessThan(pn[1] * 2.5);
    }
  });

  test('разрыв: края — ярко-красные, по середине — белёсая полоска дна; снаружи — бледная слизистая пищевода', async () => {
    for (const seed of few) {
      const f: EgdFindings = { tear: { bleeding: false, size: 0.6 } };
      const t = egdGeometry(f, seed).tear!;
      const [a, z] = t.axis;
      const mid: Pt = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2];
      const angle = Math.atan2(z[1] - a[1], z[0] - a[0]);
      const off = (k: number): Pt => [mid[0] - Math.sin(angle) * t.width * k, mid[1] + Math.cos(angle) * t.width * k];
      const { rgba } = await draw(f, seed);
      const edge = rgb(rgba, off(0.6)), fibrin = rgb(rgba, mid), out = rgb(rgba, off(3));
      expect(edge[0]).toBeGreaterThan(edge[1] * 3.5);
      expect(fibrin[1]).toBeGreaterThan(edge[1] + 40);
      expect(out[1]).toBeGreaterThan(edge[1] + 80);
    }
  });

  test('то же зерно — те же байты; другое — другой снимок; все варианты «Проверок» рисуются', async () => {
    const f: EgdFindings = { ulcer: { base: 'spots', size: 0.5 } };
    const a = await draw(f, 4), b = await draw(f, 4), c = await draw(f, 5);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(Buffer.from(a.png).equals(Buffer.from(c.png))).toBe(false);
    expect(EGD_CASES.map(k => k.key)).toEqual(['egd-normal', 'egd-clean', 'egd-spots', 'egd-vessel', 'egd-clot', 'egd-bleeding', 'egd-tear', 'egd-tear-bleeding', 'egd-blood']);
    for (const k of EGD_CASES) {
      expect((await draw(k.findings, k.seed)).png.length).toBeGreaterThan(1000);
      expect(k.label.length).toBeGreaterThan(0);
    }
  });
});

describe('ЭГДС: картинка в карте пациента', () => {
  const EGD = 'exam.egd';
  const FINDINGS = ['img.egd_ulcer', 'img.egd_bleeding', 'img.egd_stigmata', 'img.egd_tear'];

  test('по тому, что показала ЭГДС: язва и её дно, разрыв, кровь без источника; ничего — обычная слизистая', () => {
    for (const seed of [5301, 5302]) {
      const p = generatePatient(db, seed, { department: 'dept.surgery', departments: ['dept.therapy', 'dept.surgery'], season: 'autumn', primary: 'cond.ulcer_bleeding', params: {} });
      const odd = p.seed % 2 === 1;
      const input = (shown: readonly string[]): CaseInput => ({
        version: 1, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [EGD],
        draft: { treatments: [], setting: 'home' },
        arrived: [{ exam: EGD, step: 1, at: 600, obs: FINDINGS.map((f): Observation => ({ f, shown: shown.includes(f), exam: EGD })) }],
      });
      const image = (shown: readonly string[]) => makeCaseView(input(shown)).groups.find(g => g.exam === EGD)!.image!;
      const ulcer = (shown: readonly string[]) => (image(shown) as { findings: EgdFindings }).findings.ulcer;
      expect(image(['img.egd_ulcer', 'img.egd_bleeding'])).toMatchObject({ kind: 'egd', findings: { ulcer: { base: 'bleeding' } } });
      // сосуд или сгусток, пятна или чистое дно — одна находка на два класса Форреста: какой из двух, решает зерно пациента
      expect(ulcer(['img.egd_ulcer', 'img.egd_stigmata'])!.base).toBe(odd ? 'vessel' : 'clot');
      expect(ulcer(['img.egd_ulcer'])!.base).toBe(odd ? 'spots' : 'clean');
      const size = ulcer(['img.egd_ulcer'])!.size;
      expect(size).toBeGreaterThanOrEqual(0.35);
      expect(size).toBeLessThanOrEqual(0.75);
      expect(image(['img.egd_tear', 'img.egd_bleeding'])).toMatchObject({ kind: 'egd', findings: { tear: { bleeding: true } } });
      expect(image(['img.egd_tear'])).toMatchObject({ kind: 'egd', findings: { tear: { bleeding: false } } });
      expect(image(['img.egd_bleeding'])).toMatchObject({ kind: 'egd', findings: { blood: true } });
      expect(image([])).toEqual({ kind: 'egd', seed: image(['img.egd_ulcer']).seed, findings: {} });
    }
  });
});
