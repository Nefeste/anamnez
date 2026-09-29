// Рентген костей кодом (spec 2026-09-chapter-2, часть 31): геометрия панелей и переломов — чистые
// функции, и сам рисунок без экрана (Skia через CanvasKit, tools/imaging/headless.ts): где светло и
// где темно, то же зерно — тот же рисунок.
import { beforeAll, describe, expect, test } from 'bun:test';
import { BONE_ASPECT, type Bone, type BoneFindings, boneFilm, type BonePanel, type BoneView, CLAVICLE_AXIS, FEMORAL_HEAD, type FractureGeo, MORTISE, panelPoint, type Pt, SITES } from '../../src/render/xray/boneGeometry';
import { centroid, inside, moved } from '../../src/render/xray/boneShapes';
import { BONE_CASES } from '../../src/state/imagingCases';
import { loadSkia, luma, rasterize } from '../imaging/headless';

const VIEWS: BoneView[] = ['wrist', 'ankle', 'knee', 'foot', 'hip', 'clavicle', 'ribs'];
const still = (f: FractureGeo) => f.move.angle === 0 && f.move.dx === 0 && f.move.dy === 0;
const boneOf = (p: BonePanel, id: string) => {
  const b = p.bones.find(x => x.id === id);
  if (!b) throw new Error(`нет кости ${id}`);
  return b;
};
/** Все переломы вида по одному: место и, у рёбер, шестое ребро. */
const everySite = (view: BoneView, displacement?: number): BoneFindings[] => SITES[view].map(site => ({ view, fractures: [{ site, displacement, ...(site === 'rib' ? { rib: 6 } : {}) }] }));

describe('рентген костей: геометрия', () => {
  test('каждый вид: панели внутри плёнки, пропорции — как у BONE_ASPECT, у костей — контуры и плотность', () => {
    for (const view of VIEWS) {
      const film = boneFilm({ view }, 1);
      expect(film.aspect).toBe(BONE_ASPECT[view]);
      expect(film.panels.length).toBe(view === 'wrist' || view === 'ankle' || view === 'knee' ? 2 : 1);
      for (const p of film.panels) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(p.y + p.h * p.w).toBeLessThanOrEqual(film.aspect + 1e-9);
        expect(p.bones.length).toBeGreaterThanOrEqual(2);
        expect(new Set(p.bones.map(b => b.id)).size).toBe(p.bones.length);
        for (const b of p.bones) {
          expect(b.outline.length).toBeGreaterThanOrEqual(8);
          expect(b.density).toBeGreaterThan(0);
          expect(b.density).toBeLessThanOrEqual(1);
        }
        expect(p.fractures).toHaveLength(0);
        expect(Object.keys(p.carried)).toHaveLength(0);
      }
    }
  });

  test('линия перелома — поперёк своей кости: концы снаружи, середина внутри; кость делится на два отломка', () => {
    for (const view of VIEWS) {
      for (const f of [...everySite(view), ...everySite(view, 0.8)]) {
        const film = boneFilm(f, 3);
        const all = film.panels.flatMap(p => p.fractures.map(x => ({ p, x })));
        expect(all.length).toBeGreaterThanOrEqual(1);
        for (const { p, x } of all) {
          const b = boneOf(p, x.bone);
          const label = `${view}/${x.site}`;
          expect({ label, first: inside(x.line[0], b.outline), last: inside(x.line[x.line.length - 1], b.outline) }).toEqual({ label, first: false, last: false });
          expect(x.line.some(q => inside(q, b.outline))).toBe(true);
          const onMoving = b.outline.filter(q => inside(q, x.moving));
          const onFixed = b.outline.filter(q => inside(q, x.fixed));
          expect(onMoving.length).toBeGreaterThan(0);
          expect(onFixed.length).toBeGreaterThan(0);
          expect(b.outline.some(q => inside(q, x.moving) && inside(q, x.fixed))).toBe(false);
        }
      }
    }
  });

  test('без смещения — отломки на месте; со смещением — отломок сдвинут, и тем дальше, чем больше смещение', () => {
    for (const view of VIEWS) {
      for (const [i, f] of everySite(view).entries()) {
        for (const p of boneFilm(f, 2).panels) {
          for (const x of p.fractures) expect(still(x)).toBe(true);
          expect(Object.keys(p.carried)).toHaveLength(0);
        }
        const shift = (d: number) => {
          const g = everySite(view, d)[i];
          let best = 0;
          for (const p of boneFilm(g, 2).panels) {
            for (const x of p.fractures) {
              const frag = boneOf(p, x.bone).outline.filter(q => inside(q, x.moving));
              const c = centroid(frag);
              const m = moved(c, x.move);
              best = Math.max(best, Math.hypot(m[0] - c[0], m[1] - c[1]));
            }
          }
          return best;
        };
        const half = shift(0.5), full = shift(1);
        expect({ view, site: f.fractures![0].site, half: half > 0.005 }).toEqual({ view, site: f.fractures![0].site, half: true });
        expect(full).toBeGreaterThan(half);
      }
    }
  });

  test('запястье: при смещении шиловидный отросток лучевой уходит вверх, запястье — к лучевой стороне; в боковой суставная поверхность смотрит к тылу', () => {
    const [pa, lat] = boneFilm({ view: 'wrist', fractures: [{ site: 'radius', displacement: 1 }] }, 1).panels;
    const r = pa.fractures[0];
    const styloid: Pt = [0.205, 1.118];
    expect(moved(styloid, r.move)[1]).toBeGreaterThan(styloid[1] + 0.03);
    expect(pa.carried.lunate.dx).toBeLessThan(0);
    expect(pa.carried.lunate.dy).toBeGreaterThan(0);
    // ладонный наклон: тыльный край в норме дальше ладонного; после смещения — ближе
    const volar: Pt = [0.385, 1.25], dorsal: Pt = [0.655, 1.198];
    expect(dorsal[1]).toBeLessThan(volar[1]);
    const l = lat.fractures[0];
    expect(moved(dorsal, l.move)[1]).toBeGreaterThan(moved(volar, l.move)[1]);
    expect(lat.carried.lunate).toEqual(l.move);
    expect(lat.carried.mc3.dx).toBeGreaterThan(0.03);
    expect(lat.carried.mc3.angle).toBe(0);
  });

  test('кисть: большой палец растёт от кости-трапеции — ниже и сбоку от остальных, отведён; у него две фаланги', () => {
    // ось кости — главная ось её контура; основание — конец, ближний к запястью
    const axis = (b: Bone) => {
      const [cx, cy] = centroid(b.outline);
      let xx = 0, xy = 0, yy = 0;
      for (const [x, y] of b.outline) {
        xx += (x - cx) ** 2;
        xy += (x - cx) * (y - cy);
        yy += (y - cy) ** 2;
      }
      const a = 0.5 * Math.atan2(2 * xy, xx - yy);
      const dir: Pt = [Math.cos(a), Math.sin(a)];
      const proj = b.outline.map(([x, y]) => (x - cx) * dir[0] + (y - cy) * dir[1]);
      const [lo, hi] = [Math.min(...proj), Math.max(...proj)];
      const ends: Pt[] = [[cx + dir[0] * lo, cy + dir[1] * lo], [cx + dir[0] * hi, cy + dir[1] * hi]];
      const [base, head] = ends[0][1] > ends[1][1] ? ends : [ends[1], ends[0]];
      return { base, head, len: hi - lo, deg: (Math.atan2(head[0] - base[0], base[1] - head[1]) * 180) / Math.PI };
    };
    const [pa, lat] = boneFilm({ view: 'wrist' }, 1).panels;
    for (const [p, side] of [[pa, 'лучевую'], [lat, 'ладонную']] as const) {
      const mc1 = axis(boneOf(p, 'mc1'));
      const bases = ['mc2', 'mc3', 'mc4', 'mc5'].map(id => axis(boneOf(p, id)));
      // основание первой пястной — ниже оснований остальных (у запястья) и в стороне от них
      for (const b of bases) expect({ side, lower: mc1.base[1] > b.base[1] + 0.02 }).toEqual({ side, lower: true });
      expect(mc1.base[0]).toBeLessThan(Math.min(...bases.map(b => b.base[0])) - 0.05);
      // отведена от второй пястной на 25–40° и короче её
      const angle = bases[0].deg - mc1.deg;
      expect({ side, angle: angle > 25 && angle < 40 }).toEqual({ side, angle: true });
      expect(mc1.len).toBeLessThan(0.8 * bases[0].len);
      // стоит на трапеции: её середина — у основания первой пястной
      const tz = centroid(boneOf(p, 'trapezium').outline);
      expect(Math.hypot(tz[0] - mc1.base[0], tz[1] - mc1.base[1])).toBeLessThan(0.1);
      // у большого пальца две фаланги, средней нет; две сесамовидные кости; у II–V — основные
      // фаланги за головками пястных
      for (const id of ['pp1', 'dp1', 'sesamoid_r', 'sesamoid_u', 'pp2', 'pp3', 'pp4', 'pp5']) boneOf(p, id);
      expect(p.bones.some(b => b.id === 'mp1')).toBe(false);
      // между большим и указательным — воздух: первый межпальцевый промежуток
      const pp1 = axis(boneOf(p, 'pp1')), pp2 = axis(boneOf(p, 'pp2'));
      const web: Pt = [(pp1.head[0] + pp2.base[0]) / 2, (pp1.head[1] + pp2.base[1]) / 2];
      expect({ side, web: p.soft.some(t => inside(web, t.outline)) }).toEqual({ side, web: false });
      expect(p.soft.some(t => inside(mc1.base, t.outline) && inside(pp1.base, t.outline))).toBe(true);
    }
    // при переломе лучевой со смещением большой палец уходит вместе с запястьем
    const [broken] = boneFilm({ view: 'wrist', fractures: [{ site: 'radius', displacement: 1 }] }, 1).panels;
    for (const id of ['mc1', 'pp1', 'dp1', 'sesamoid_r', 'pp2']) expect(broken.carried[id]).toEqual(broken.carried.lunate);
  });

  test('голеностоп: при смещении малоберцовой таранная кость уходит кнаружи — щель у внутренней лодыжки шире 5 мм', () => {
    const clear = (d: number) => {
      const [ap] = boneFilm({ view: 'ankle', fractures: [{ site: 'fibula', displacement: d }] }, 1).panels;
      return MORTISE.medialMalleolus - (MORTISE.talusMedial + (ap.carried.talus?.dx ?? 0));
    };
    // ширина панели — около 9 см: 5 мм — 0,056; шире 5 мм — нестабильный перелом (855_1, раздел 2.4)
    expect(clear(0)).toBeLessThan(0.056);
    expect(clear(1)).toBeGreaterThan(0.056);
    const [ap] = boneFilm({ view: 'ankle', fractures: [{ site: 'fibula', displacement: 1 }] }, 1).panels;
    expect(ap.fractures[0].move.dx).toBeLessThan(0);
    expect(ap.carried.calcaneus).toEqual(ap.carried.talus);
  });

  test('колено: при смещении верхний отломок надколенника уходит вверх; выпот — серая тень жидкости над надколенником вместо жира', () => {
    // перелом надколенника — поперёк, верхний отломок тянет четырёхглавая мышца (970_1, раздел 1.2)
    for (const p of boneFilm({ view: 'knee', fractures: [{ site: 'patella', displacement: 1 }] }, 1).panels) {
      expect(p.fractures).toHaveLength(1);
      expect(p.fractures[0].bone).toBe('patella');
      expect(p.fractures[0].move.dy).toBeLessThan(-0.05);
    }
    const [dryAp, dry] = boneFilm({ view: 'knee' }, 1).panels;
    const [wetAp, wet] = boneFilm({ view: 'knee', effusion: true }, 1).panels;
    expect(wetAp.soft).toEqual(dryAp.soft);
    expect(wet.soft).toHaveLength(dry.soft.length + 1);
    expect(wet.air).toHaveLength(dry.air.length - 1);
    // жидкость — выше надколенника и впереди бедра
    const fluid = centroid(wet.soft[wet.soft.length - 1].outline);
    expect(fluid[1]).toBeLessThan(centroid(boneOf(wet, 'patella').outline)[1]);
    expect(fluid[0]).toBeLessThan(centroid(boneOf(wet, 'femur').outline)[0]);
  });

  test('шейка бедра: при смещении бедро уходит вверх, и отломок шейки заходит на головку', () => {
    const [p] = boneFilm({ view: 'hip', fractures: [{ site: 'femoral_neck', displacement: 1 }] }, 1).panels;
    const f = p.fractures[0];
    expect(f.move.dy).toBeLessThan(0);
    const { c, r } = FEMORAL_HEAD;
    const frag = boneOf(p, 'femur').outline.filter(q => inside(q, f.moving));
    expect(frag.some(q => Math.hypot(q[0] - c[0], q[1] - c[1]) < r)).toBe(false);
    expect(frag.map(q => moved(q, f.move)).some(q => Math.hypot(q[0] - c[0], q[1] - c[1]) < r)).toBe(true);
  });

  test('ключица: при смещении наружный отломок с плечевым поясом опускается и заходит под внутренний', () => {
    const [p] = boneFilm({ view: 'clavicle', fractures: [{ site: 'clavicle', displacement: 1 }] }, 1).panels;
    const f = p.fractures[0];
    const end = CLAVICLE_AXIS[0];
    expect(inside(end, f.moving)).toBe(true);
    const m = moved(end, f.move);
    expect(m[1]).toBeGreaterThan(end[1]);
    expect(m[0]).toBeGreaterThan(end[0]);
    expect(p.carried.acromion).toEqual(f.move);
    expect(p.carried.humerus).toEqual(f.move);
  });

  test('рёбра: у каждого сломанного — свой перелом, ступенька поперёк ребра; номер — от 2 до 10, повтор не рисуется', () => {
    const [p] = boneFilm({ view: 'ribs', fractures: [{ site: 'rib', rib: 6, displacement: 1 }, { site: 'rib', rib: 7 }, { site: 'rib', rib: 6 }] }, 1).panels;
    expect(p.fractures.map(f => f.bone)).toEqual(['rib6', 'rib7']);
    const f = p.fractures[0];
    const a = f.line[0], b = f.line[f.line.length - 1];
    const across = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // сдвиг — вдоль линии перелома, то есть поперёк ребра
    const along = Math.abs((f.move.dx * (b[0] - a[0]) + f.move.dy * (b[1] - a[1])) / across);
    expect(along).toBeGreaterThan(0.8 * Math.hypot(f.move.dx, f.move.dy));
    expect(still(p.fractures[1])).toBe(true);
    const clamp = boneFilm({ view: 'ribs', fractures: [{ site: 'rib', rib: 1 }, { site: 'rib', rib: 15 }] }, 1).panels[0];
    expect(clamp.fractures.map(f => f.bone)).toEqual(['rib2', 'rib10']);
  });

  test('стопа: бугристость пятой плюсневой отходит назад; при переломе третьей со смещением палец уходит с отломком', () => {
    const [p] = boneFilm({ view: 'foot', fractures: [{ site: 'mt5', displacement: 1 }, { site: 'mt3', displacement: 1 }] }, 1).panels;
    const [mt5, mt3] = p.fractures;
    expect(mt5.move.dy).toBeGreaterThan(0);
    expect(p.carried.pp3).toEqual(mt3.move);
    expect(mt3.move.dx).toBeGreaterThan(0);
  });

  test('чужие места не рисуются; смещение вне пределов — ближайшее допустимое; без перелома зерно рисунка не меняет', () => {
    expect(boneFilm({ view: 'hip', fractures: [{ site: 'radius' }, { site: 'rib', rib: 5 }] }, 1).panels[0].fractures).toHaveLength(0);
    const big = boneFilm({ view: 'clavicle', fractures: [{ site: 'clavicle', displacement: 5 }] }, 1);
    const one = boneFilm({ view: 'clavicle', fractures: [{ site: 'clavicle', displacement: 1 }] }, 1);
    expect(JSON.stringify(big)).toBe(JSON.stringify(one));
    const nan = boneFilm({ view: 'clavicle', fractures: [{ site: 'clavicle', displacement: Number.NaN }] }, 1);
    expect(still(nan.panels[0].fractures[0])).toBe(true);
    expect(JSON.stringify(boneFilm({ view: 'wrist' }, 1))).toBe(JSON.stringify(boneFilm({ view: 'wrist' }, 2)));
    const f: BoneFindings = { view: 'wrist', fractures: [{ site: 'radius', displacement: 0.5 }] };
    expect(JSON.stringify(boneFilm(f, 4))).toBe(JSON.stringify(boneFilm(f, 4)));
    expect(JSON.stringify(boneFilm(f, 4).panels[0].fractures[0].line)).not.toBe(JSON.stringify(boneFilm(f, 5).panels[0].fractures[0].line));
  });
});

describe('рентген костей: рисунок без экрана', () => {
  const S = 240;
  let draw: (f: BoneFindings, seed: number) => Promise<{ rgba: Uint8Array; png: Uint8Array }>;
  beforeAll(async () => {
    await loadSkia();
    const { recordBoneXray } = await import('../../src/render/xray/bones');
    draw = (f, seed) => rasterize(recordBoneXray(S, f, seed), S, Math.round(S * BONE_ASPECT[f.view]));
  });
  /** Яркость точки панели: координаты — в долях ширины панели. */
  const atPanel = (px: Uint8Array, view: BoneView, p: BonePanel, [x, y]: Pt) => {
    const h = Math.round(S * BONE_ASPECT[view]);
    return luma(px, S, h, p.x + x * p.w, ((p.y + y * p.w) * S) / (h - 1));
  };
  /** Яркость точки рисунка — с масштабом панели. */
  const at = (px: Uint8Array, view: BoneView, p: BonePanel, q: Pt) => atPanel(px, view, p, panelPoint(p, q));

  test('кость светлее мягких тканей, мягкие ткани светлее воздуха; корковый слой диафиза светлее середины', async () => {
    const { rgba } = await draw({ view: 'wrist' }, 1);
    const [pa] = boneFilm({ view: 'wrist' }, 1).panels;
    const air = at(rgba, 'wrist', pa, [0.03, 1.8]);
    const soft = at(rgba, 'wrist', pa, [0.18, 1.8]);
    const canal = at(rgba, 'wrist', pa, [0.37, 1.8]);
    const cortex = at(rgba, 'wrist', pa, [0.288, 1.8]);
    expect(soft - air).toBeGreaterThan(25);
    expect(canal - soft).toBeGreaterThan(25);
    expect(cortex - canal).toBeGreaterThan(12);
  });

  test('линия перелома без смещения — тёмная полоса поперёк кости', async () => {
    for (const [view, site] of [['wrist', 'radius'], ['hip', 'femoral_neck'], ['clavicle', 'clavicle']] as const) {
      const f: BoneFindings = { view, fractures: [{ site }] };
      const p = boneFilm(f, 2).panels[0];
      const line = p.fractures[0].line;
      const b = boneOf(p, p.fractures[0].bone);
      const mid = line.filter(q => inside(q, b.outline));
      const q = mid[Math.floor(mid.length / 2)];
      const normal = (await draw({ view }, 2)).rgba;
      const broken = (await draw(f, 2)).rgba;
      expect({ view, darker: at(normal, view, p, q) - at(broken, view, p, q) > 12 }).toEqual({ view, darker: true });
    }
  });

  test('смещённый отломок — там, где прежде были мягкие ткани: в боковой проекции запястья кость ушла к тылу', async () => {
    const f: BoneFindings = { view: 'wrist', fractures: [{ site: 'radius', displacement: 0.8 }] };
    const lat = boneFilm(f, 3).panels[1];
    const q = moved([0.63, 1.3], lat.fractures[0].move);
    const normal = (await draw({ view: 'wrist' }, 3)).rgba;
    const displaced = (await draw(f, 3)).rgba;
    expect(at(displaced, 'wrist', lat, q) - at(normal, 'wrist', lat, q)).toBeGreaterThan(20);
  });

  test('левая сторона — зеркало правой: где у правой кость, у левой — промежуток между костями', async () => {
    const [pa] = boneFilm({ view: 'wrist' }, 1).panels;
    expect(boneFilm({ view: 'wrist', side: 'left' }, 1).mirror).toBe(true);
    expect(boneFilm({ view: 'wrist' }, 1).mirror).toBe(false);
    const right = (await draw({ view: 'wrist' }, 1)).rgba;
    const left = (await draw({ view: 'wrist', side: 'left' }, 1)).rgba;
    // у правой здесь — локтевая кость, а в зеркальной точке панели — воздух за предплечьем
    const bone = panelPoint(pa, [0.69, 1.8]);
    const air: Pt = [1 - bone[0], bone[1]];
    expect(atPanel(right, 'wrist', pa, bone) - atPanel(right, 'wrist', pa, air)).toBeGreaterThan(20);
    expect(atPanel(left, 'wrist', pa, air) - atPanel(left, 'wrist', pa, bone)).toBeGreaterThan(20);
    expect(Math.abs(atPanel(left, 'wrist', pa, air) - atPanel(right, 'wrist', pa, bone))).toBeLessThan(12);
  });

  test('то же зерно — те же байты; другое — другой снимок перелома; все варианты «Проверок» рисуются', async () => {
    const f: BoneFindings = { view: 'ankle', fractures: [{ site: 'fibula', displacement: 0.5 }] };
    const a = await draw(f, 9);
    const b = await draw(f, 9);
    const c = await draw(f, 10);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(Buffer.from(a.png).equals(Buffer.from(c.png))).toBe(false);
    expect(BONE_CASES).toHaveLength(20);
    expect(new Set(BONE_CASES.map(k => k.findings.view))).toEqual(new Set(VIEWS));
    for (const k of BONE_CASES) {
      expect((await draw(k.findings, k.seed)).png.length).toBeGreaterThan(1000);
      expect(k.label.length).toBeGreaterThan(0);
    }
  });
});
