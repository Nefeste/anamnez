// МРТ поясничного отдела позвоночника кодом (spec 2026-10-chapter-4, часть 58а; ADR 0013): продольный срез по середине
// тела в режиме T2 — тела позвонков от XII грудного до крестца, диски, канал с ликвором, конец спинного мозга и корешки,
// дуги и отростки, спереди аорта и кишка; грыжа диска уровнем и размером, мочевой пузырь. Геометрия — в долях кадра;
// рисунок без экрана (Skia через CanvasKit, tools/imaging/headless.ts): где светло, где темно, то же зерно — те же байты.
import { beforeAll, describe, expect, test } from 'bun:test';
import { COMPRESSION, DISC_LEVELS, type DiscLevel, inside, type Pt, type SpineFindings, type SpineGeometry, spineGeometry } from '../../src/render/mri/spineGeometry';
import { SPINE_CASES } from '../../src/state/imagingCases';
import { loadSkia, luma, rasterize } from '../imaging/headless';

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const NAMES = ['T12', 'L1', 'L2', 'L3', 'L4', 'L5', 'S1', 'S2', 'S3', 'S4'];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const centroid = (pts: readonly Pt[]): Pt => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
const vert = (g: SpineGeometry, name: string) => g.vertebrae.find(v => v.name === name)!;
const disc = (g: SpineGeometry, level: string) => g.discs.find(d => d.level === level)!;
const canal = (g: SpineGeometry) => [...g.canal.front, ...[...g.canal.back].reverse()];
const lineLength = (pts: readonly Pt[]) => pts.slice(1).reduce((a, p, i) => a + dist(p, pts[i]), 0);
/** Точка в канале у заднего края диска или середины тела: `frac` — доля глубины канала от передней стенки. */
function canalPoint(g: SpineGeometry, near: Pt, frac: number): Pt {
  const { front, back } = g.canal;
  let best = 0;
  for (let i = 1; i < front.length; i++) if (dist(front[i], near) < dist(front[best], near)) best = i;
  return [front[best][0] + (back[best][0] - front[best][0]) * frac, front[best][1] + (back[best][1] - front[best][1]) * frac];
}
const postWallMid = (g: SpineGeometry, name: string): Pt => {
  const v = vert(g, name);
  const a = v.top[v.top.length - 1], b = v.bottom[v.bottom.length - 1];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
};

describe('МРТ позвоночника: геометрия', () => {
  test('позвонки — от XII грудного до IV крестцового сверху вниз, диск — между соседями; лордоз: III поясничный впереди, крестец уходит назад', () => {
    for (const seed of SEEDS) {
      const g = spineGeometry({}, seed);
      expect(g.vertebrae.map(v => v.name)).toEqual(NAMES);
      for (let i = 1; i < g.vertebrae.length; i++) expect(g.vertebrae[i].c[1]).toBeGreaterThan(g.vertebrae[i - 1].c[1]);
      expect(g.discs.map(d => d.level)).toEqual(NAMES.slice(0, -1).map((n, i) => `${n}-${NAMES[i + 1]}`));
      for (const d of g.discs) {
        const [up, down] = d.level.split('-').map(n => vert(g, n));
        expect(d.c[1]).toBeGreaterThan(up.c[1]);
        expect(d.c[1]).toBeLessThan(down.c[1]);
      }
      // верх кадра — XII грудной, внизу — крестец в кадре
      expect(vert(g, 'T12').c[1]).toBeLessThan(0.06);
      expect(vert(g, 'S4').c[1]).toBeGreaterThan(0.85);
      expect(vert(g, 'S4').c[1]).toBeLessThan(1);
      expect(vert(g, 'L3').c[0]).toBeLessThan(vert(g, 'T12').c[0] - 0.02);
      expect(vert(g, 'L3').c[0]).toBeLessThan(vert(g, 'L5').c[0]);
      expect(vert(g, 'S2').c[0]).toBeGreaterThan(vert(g, 'L5').c[0] + 0.05);
    }
  });

  test('диски: поясничные — с водой, у грыжи — обезвоженный и ниже; крестцовые — рудименты без ядра', () => {
    for (const seed of SEEDS) {
      const g = spineGeometry({}, seed);
      for (const d of g.discs) {
        if (d.sacral) expect(d.level.startsWith('S')).toBe(true);
        else if (d.level !== 'L5-S1') expect(d.bright).toBe(true);
      }
      for (const level of DISC_LEVELS) {
        const h = spineGeometry({ hernia: { level, size: 0.5 } }, seed);
        expect(disc(h, level).bright).toBe(false);
        // строение выше диска над грыжей — то же: зерно пациента одно, ниже — сдвинуто, соседний диск бывает обезвожен
        const [upper] = level.split('-');
        for (const n of NAMES.slice(0, NAMES.indexOf(upper))) expect(JSON.stringify(vert(h, n).outline)).toBe(JSON.stringify(vert(g, n).outline));
      }
      // обезвоженный диск ниже: следующий позвонок — ближе
      const h = spineGeometry({ hernia: { level: 'L4-L5', size: 0.5 } }, seed);
      expect(dist(vert(h, 'L4').c, vert(h, 'L5').c)).toBeLessThan(dist(vert(g, 'L4').c, vert(g, 'L5').c));
    }
  });

  test('канал — позади тел и дисков; мешок с ликвором — внутри канала, кончается у II крестцового; спинной мозг — до I поясничного', () => {
    for (const seed of SEEDS) {
      const g = spineGeometry({}, seed);
      expect(g.canal.back).toHaveLength(g.canal.front.length);
      g.canal.front.forEach((p, i) => {
        expect(g.canal.back[i][0]).toBeGreaterThan(p[0]);
        expect(dist(p, g.canal.back[i])).toBeGreaterThan(0.01);
        expect(dist(p, g.canal.back[i])).toBeLessThan(0.08);
      });
      // в кадре: верхний край мешка — за кадром, на кромке канала
      const c = canal(g);
      for (const p of g.sac.filter(q => q[1] > 0)) expect(inside(p, c)).toBe(true);
      // конец мешка — между I и III крестцовыми
      const tip = g.sac.reduce((m, p) => (p[1] > m[1] ? p : m), g.sac[0]);
      expect(tip[1]).toBeGreaterThan(vert(g, 'S1').c[1]);
      expect(tip[1]).toBeLessThan(vert(g, 'S3').c[1]);
      // конус — у I поясничного или диска под ним; мозг выше конуса
      const l1 = vert(g, 'L1');
      expect(g.conusTip[1]).toBeGreaterThan(l1.top[0][1] - 0.03);
      expect(g.conusTip[1]).toBeLessThan(vert(g, 'L2').c[1]);
      for (const p of g.cord) expect(p[1]).toBeLessThan(g.conusTip[1] + 0.01);
      expect(inside(g.conusTip, g.sac)).toBe(true);
    }
  });

  test('корешки — нити внутри мешка от конуса книзу; над перекрытым каналом — извитые', () => {
    for (const seed of SEEDS) {
      const g = spineGeometry({}, seed);
      expect(g.roots.length).toBeGreaterThanOrEqual(4);
      for (const r of g.roots) {
        expect(dist(r[0], g.conusTip)).toBeLessThan(0.06);
        expect(r[r.length - 1][1]).toBeGreaterThan(vert(g, 'L3').c[1]);
        for (const p of r) expect(inside(p, g.sac)).toBe(true);
      }
      const block = spineGeometry({ hernia: { level: 'L4-L5', size: 0.9 } }, seed);
      for (const r of block.roots) for (const p of r) expect(inside(p, block.sac)).toBe(true);
      // извитость — по длине нитей вдоль III поясничного: у той же грыжи без перекрытия строение то же, нити — ровные
      const bulge = spineGeometry({ hernia: { level: 'L4-L5', size: 0.5 } }, seed);
      const l3 = vert(bulge, 'L3');
      const top = l3.top[0][1], bottom = l3.bottom[l3.bottom.length - 1][1];
      const span = (geo: SpineGeometry) => geo.roots.reduce((a, r) => a + lineLength(r.filter(p => p[1] > top && p[1] < bottom)), 0);
      expect(JSON.stringify(vert(block, 'L3'))).toBe(JSON.stringify(l3));
      expect(span(block)).toBeGreaterThan(span(bulge) * 1.03);
    }
  });

  test('грыжа — позади своего диска, в канале; чем больше, тем уже мешок; с 0,75 — канал перекрыт', () => {
    for (const seed of SEEDS) {
      for (const level of DISC_LEVELS) {
        const residuals: number[] = [];
        for (const size of [0.2, 0.4, 0.6, 0.7, 0.8, 0.95]) {
          const g = spineGeometry({ hernia: { level, size } }, seed);
          const h = g.hernia!;
          expect(h.level).toBe(level);
          const d = disc(g, level), [up] = level.split('-').map(n => vert(g, n));
          const c = centroid(h.outline);
          expect(dot(sub(c, d.c), up.back)).toBeGreaterThan(0.045);
          // ближе всего к своему диску
          const nearest = g.discs.reduce((m, x) => (dist(x.c, c) < dist(m.c, c) ? x : m), g.discs[0]);
          expect(nearest.level).toBe(level);
          const cn = canal(g);
          expect(h.outline.filter(p => !inside(p, cn)).length).toBeLessThanOrEqual(2);
          expect(h.compression).toBe(size >= COMPRESSION);
          if (size < COMPRESSION) expect(Math.abs(h.residual - (1 - size))).toBeLessThan(0.12);
          else expect(h.residual).toBeLessThan(0.12);
          expect(inside(h.at, g.sac) || h.residual < 0.12).toBe(true);
          residuals.push(h.residual);
        }
        // до перекрытия — уже с каждым шагом, перекрытый — уже всех
        for (let i = 1; i < 4; i++) expect(residuals[i]).toBeLessThan(residuals[i - 1]);
        expect(Math.max(...residuals.slice(4))).toBeLessThan(residuals[3]);
      }
    }
  });

  test('спереди — аорта перед телами до IV поясничного, петли кишки — впереди позвонков; сзади — отростки, мышцы и жир до гладкой кожи', () => {
    for (const seed of SEEDS) {
      const g = spineGeometry({}, seed);
      const l2 = vert(g, 'L2');
      const ant = l2.top[0][0];
      const near = g.aorta.filter(p => Math.abs(p[1] - l2.c[1]) < 0.03);
      expect(near.length).toBeGreaterThan(0);
      for (const p of near) expect(p[0]).toBeLessThan(ant);
      expect(Math.max(...g.aorta.map(p => p[1]))).toBeLessThan(vert(g, 'L5').c[1]);
      expect(g.bowel.length).toBeGreaterThan(10);
      for (const l of g.bowel) for (const v of g.vertebrae) expect(inside(l.c, v.outline)).toBe(false);
      // всё — в теле, кожа позади отростков
      for (const v of g.vertebrae) for (const p of v.outline) expect(inside(p, g.body)).toBe(true);
      for (const s of g.spinous) {
        for (const p of s) expect(inside(p, g.body)).toBe(true);
        // отросток — позади канала
        expect(centroid(s)[0]).toBeGreaterThan(centroid(g.canal.back.filter(p => Math.abs(p[1] - centroid(s)[1]) < 0.03))[0]);
      }
      expect(g.spinous).toHaveLength(6);
      // кожа гладкая: соседние отрезки поворачивают меньше чем на 15°
      for (let i = 2; i < g.skin.length - 2; i++) {
        const a = sub(g.skin[i], g.skin[i - 1]), b = sub(g.skin[i + 1], g.skin[i]);
        const cos = dot(a, b) / (Math.hypot(...a) * Math.hypot(...b) || 1);
        expect(cos).toBeGreaterThan(Math.cos((15 * Math.PI) / 180));
      }
    }
  });

  test('мочевой пузырь — внизу слева, больше при переполнении, петли на него не ложатся; без параметра — не виден', () => {
    for (const seed of SEEDS) {
      expect(spineGeometry({}, seed).bladder).toBeUndefined();
      expect(spineGeometry({ bladder: 0.02 }, seed).bladder).toBeUndefined();
      const half = spineGeometry({ bladder: 0.5 }, seed), full = spineGeometry({ bladder: 1 }, seed);
      const reach = (g: SpineGeometry) => Math.max(...g.bladder!.map(p => p[0]));
      expect(reach(full)).toBeGreaterThan(reach(half));
      expect(centroid(full.bladder!)[0]).toBeLessThan(0.3);
      expect(centroid(full.bladder!)[1]).toBeGreaterThan(0.85);
      for (const l of full.bowel) expect(inside(l.c, full.bladder!)).toBe(false);
    }
  });

  test('то же зерно — та же геометрия; размер вне 0–1 — к краю, NaN — как ноль', () => {
    for (const seed of [1, 7, 33]) {
      const f: SpineFindings = { hernia: { level: 'L5-S1', size: 0.6 }, bladder: 0.4 };
      expect(JSON.stringify(spineGeometry(f, seed))).toBe(JSON.stringify(spineGeometry(f, seed)));
      expect(JSON.stringify(spineGeometry({ hernia: { level: 'L4-L5', size: 7 } }, seed))).toBe(JSON.stringify(spineGeometry({ hernia: { level: 'L4-L5', size: 1 } }, seed)));
      expect(JSON.stringify(spineGeometry({ hernia: { level: 'L4-L5', size: Number.NaN } }, seed))).toBe(JSON.stringify(spineGeometry({ hernia: { level: 'L4-L5', size: 0 } }, seed)));
      expect(spineGeometry({ hernia: { level: 'L4-L5', size: 0 } }, seed).hernia).toBeUndefined();
    }
    // разные зёрна — разные пациенты
    expect(JSON.stringify(spineGeometry({}, 1).vertebrae)).not.toBe(JSON.stringify(spineGeometry({}, 2).vertebrae));
  });
});

describe('МРТ позвоночника: рисунок без экрана', () => {
  const S = 240;
  let draw: (f: SpineFindings, seed: number) => Promise<{ rgba: Uint8Array; png: Uint8Array }>;
  beforeAll(async () => {
    await loadSkia();
    const { recordSpineSlice } = await import('../../src/render/mri/spine');
    draw = (f, seed) => rasterize(recordSpineSlice(S, f, seed), S, S);
  });
  const at = (px: Uint8Array, p: Pt) => luma(px, S, S, p[0], p[1]);
  const few = SEEDS.slice(0, 6);

  test('за кожей — чёрный воздух; ликвор в канале и ядра дисков — светлые, костный мозг — серый, кровь в аорте — чёрная', async () => {
    for (const seed of few) {
      const g = spineGeometry({}, seed);
      const { rgba } = await draw({}, seed);
      for (const p of [[0.985, 0.1], [0.985, 0.5], [0.985, 0.9]] as Pt[]) expect(at(rgba, p)).toBeLessThan(5);
      for (const n of ['L1', 'L2', 'L3']) expect(at(rgba, canalPoint(g, postWallMid(g, n), 0.22))).toBeGreaterThan(185);
      for (const d of g.discs.filter(x => x.bright)) expect(at(rgba, centroid(d.nucleus))).toBeGreaterThan(150);
      for (const n of ['L2', 'L3', 'L4']) {
        const v = vert(g, n);
        expect(at(rgba, v.c)).toBeGreaterThan(70);
        expect(at(rgba, v.c)).toBeLessThan(140);
      }
      const l2 = vert(g, 'L2');
      const front: Pt = [(l2.top[0][0] + l2.bottom[0][0]) / 2, (l2.top[0][1] + l2.bottom[0][1]) / 2];
      expect(at(rgba, [front[0] - l2.back[0] * 0.034, front[1] - l2.back[1] * 0.034])).toBeLessThan(40);
    }
  });

  test('грыжа: диск тёмный, на её уровне вместо светлого ликвора — тёмное; переполненный пузырь — светлый', async () => {
    for (const seed of few) {
      for (const level of ['L4-L5', 'L5-S1'] as DiscLevel[]) {
        const f: SpineFindings = { hernia: { level, size: 0.9 } };
        const sick = spineGeometry(f, seed), well = spineGeometry({}, seed);
        const a = (await draw(f, seed)).rgba, b = (await draw({}, seed)).rgba;
        expect(at(a, centroid(disc(sick, level).nucleus))).toBeLessThan(110);
        expect(at(a, canalPoint(sick, disc(sick, level).c, 0.3))).toBeLessThan(120);
        expect(at(b, canalPoint(well, disc(well, level).c, 0.3))).toBeGreaterThan(170);
      }
      const full = (await draw({ bladder: 0.9 }, seed)).rgba;
      expect(at(full, [0.17, 0.96])).toBeGreaterThan(200);
    }
  });

  test('то же зерно — те же байты; варианты «Проверок» нарисованы и различны', async () => {
    const one = await draw({ hernia: { level: 'L4-L5', size: 0.6 } }, 9), two = await draw({ hernia: { level: 'L4-L5', size: 0.6 } }, 9);
    expect(Buffer.from(one.png).equals(Buffer.from(two.png))).toBe(true);
    expect(SPINE_CASES.map(k => k.key)).toEqual(['spine-normal', 'spine-bulge', 'spine-half', 'spine-block', 'spine-block-high']);
    const pngs = await Promise.all(SPINE_CASES.map(k => draw(k.findings, k.seed)));
    expect(new Set(pngs.map(p => Buffer.from(p.png).toString('base64'))).size).toBe(SPINE_CASES.length);
    // перекрытый канал — у вариантов с перекрытием, по подписи
    for (const k of SPINE_CASES) {
      const g = spineGeometry(k.findings, k.seed);
      expect(g.hernia?.compression ?? false).toBe(k.key.startsWith('spine-block'));
    }
  });
});
