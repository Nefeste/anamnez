// Разметка находок на рентгене (spec 2026-11-xray-marks, вопрос 76): где на снимке то, что нашёл рентгенолог, — контуры
// в долях кадра (x — доля ширины, y — доля высоты), из той же геометрии, что рисунок. Подпись и находка базы — у
// вызывающего (src/state/imageMarks.ts). Чистые функции, без Skia: их проверяют тесты в Bun.
import { abdomenGeometry, type AbdomenFindings } from './abdomenGeometry';
import { type BoneFindings, boneFilm, type FractureSite, panelPoint } from './boneGeometry';
import {
  batWing, domeY, type FilmSide, filmSide, fluidTop, HILUM, heartScale, hemithorax, infiltrateCenter, type Pt, ribFractureAt,
  ribLayout, type XrayFindings,
} from './chestGeometry';

/** Обведённое место: один или несколько контуров (обе стороны, две проекции) и точка подписи над ними. */
export interface MarkArea {
  outlines: Pt[][];
  anchor: Pt;
}

export type ChestMarkKey = 'infiltrate' | 'air' | 'fluid' | 'rib' | 'mediastinum' | 'heart' | 'congestion' | 'edema';
export type AbdomenMarkKey = 'freeGas' | 'levels';

/** Овал из `n` точек: середина и полуоси в долях кадра. */
export function ellipse(cx: number, cy: number, rx: number, ry: number, n = 28): Pt[] {
  return Array.from({ length: n }, (_, i): Pt => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
}

/** Точка подписи — над самым верхним контуром, по его середине. */
function anchorOf(outlines: Pt[][]): Pt {
  const all = outlines.flat();
  const top = Math.min(...all.map(p => p[1]));
  const first = outlines[0];
  const cx = first.reduce((a, p) => a + p[0], 0) / first.length;
  return [cx, top];
}

const area = (outlines: Pt[][]): MarkArea => ({ outlines, anchor: anchorOf(outlines) });

/** Стороны находки на снимке. */
const sidesOf = (side: 'right' | 'left' | 'both'): FilmSide[] => (side === 'both' ? [-1, 1] : [filmSide(side)]);

/**
 * Обзорный снимок груди: инфильтрат — облако в нижней доле; воздух — плевральная полость стороны; жидкость — от её
 * верхней границы до купола; переломы рёбер — места переломов; расширенное средостение — тень над сердцем; большое
 * сердце — его тень; застой — корни; отёк — «крылья бабочки». Эмфизема — по всему лёгкому, места у неё нет.
 */
export function chestMarks(f: XrayFindings, seed: number): Partial<Record<ChestMarkKey, MarkArea>> {
  const out: Partial<Record<ChestMarkKey, MarkArea>> = {};
  if (f.infiltrate) {
    out.infiltrate = area(sidesOf(f.infiltrate.side).map(s => {
      const [cx, cy] = infiltrateCenter(s, f);
      return ellipse(cx, cy + 0.01, 0.13, 0.1);
    }));
  }
  const air = f.pneumothorax?.side ?? (f.effusion?.air ? f.effusion.side : undefined);
  if (air) out.air = area([hemithorax(filmSide(air), f)]);
  const top = fluidTop(f);
  if (top && f.effusion) {
    const s = filmSide(f.effusion.side);
    const bottom = domeY(s, f) + 0.13;
    out.fluid = area([[...top, [top[top.length - 1][0], bottom], [top[0][0], bottom]]]);
  }
  if (f.ribFractures && f.ribFractures.ribs.length > 0) {
    const s = filmSide(f.ribFractures.side);
    const layout = ribLayout(seed, f.hyperinflation === true);
    const at = f.ribFractures.ribs.map(n => ribFractureAt(s, layout[Math.min(10, Math.max(1, Math.round(n))) - 1]).at);
    const ys = at.map(p => p[1]);
    const cx = at.reduce((a, p) => a + p[0], 0) / at.length;
    out.rib = area([ellipse(cx, (Math.min(...ys) + Math.max(...ys)) / 2, 0.05, (Math.max(...ys) - Math.min(...ys)) / 2 + 0.045)]);
  }
  if (f.wideMediastinum) out.mediastinum = area([ellipse(0.515, 0.2, 0.14, 0.16)]);
  if (f.cardiomegaly) {
    const k = heartScale(f);
    out.heart = area([ellipse(0.565, 0.585, 0.19 * k, 0.17)]);
  }
  if (f.congestion?.edema) {
    out.edema = area(([-1, 1] as FilmSide[]).map(s => {
      const w = batWing(s);
      return ellipse(w.center[0], w.center[1], w.rx, w.ry);
    }));
  } else if (f.congestion) {
    out.congestion = area(([-1, 1] as FilmSide[]).map(s => ellipse(HILUM[s][0], HILUM[s][1], 0.07, 0.085)));
  }
  return out;
}

/** Обзорный снимок живота: серп газа под правым куполом; раздутые петли с уровнями — середина живота. */
export function abdomenMarks(f: AbdomenFindings, seed: number): Partial<Record<AbdomenMarkKey, MarkArea>> {
  const out: Partial<Record<AbdomenMarkKey, MarkArea>> = {};
  const g = abdomenGeometry(f, seed);
  if (g.crescent && g.crescent.length > 0) {
    const xs = g.crescent.map(p => p[0]), ys = g.crescent.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    out.freeGas = area([ellipse(cx, cy, (Math.max(...xs) - Math.min(...xs)) / 2 + 0.04, (Math.max(...ys) - Math.min(...ys)) / 2 + 0.04)]);
  }
  if (g.loops.length > 0) out.levels = area([ellipse(0.5, 0.53, 0.21, 0.23)]);
  return out;
}

/**
 * Снимок костей: каждое место перелома — овал вокруг середины линии перелома, на каждой проекции, где она видна. Точка
 * панели — в долях плёнки: панель сдвинута на (x, y) и растянута на свою ширину; левая сторона — зеркально.
 */
export function boneMarks(f: BoneFindings, seed: number): Partial<Record<FractureSite, MarkArea>> {
  const film = boneFilm(f, seed);
  const aspect = film.aspect;
  const by = new Map<FractureSite, Pt[][]>();
  for (const panel of film.panels) {
    for (const fr of panel.fractures) {
      if (fr.line.length === 0) continue;
      const mid = fr.line[Math.floor(fr.line.length / 2)];
      const [px, py] = panelPoint(panel, mid);
      const x = panel.x + (film.mirror ? 1 - px : px) * panel.w;
      const y = (panel.y + py * panel.w) / aspect;
      const r = 0.075 * panel.w;
      by.set(fr.site, [...(by.get(fr.site) ?? []), ellipse(x, y, r, r / aspect)]);
    }
  }
  const out: Partial<Record<FractureSite, MarkArea>> = {};
  for (const [site, outlines] of by) out[site] = area(outlines);
  return out;
}

/** Внутри ли точка многоугольника (правило чётности пересечений). */
export function inside(pt: Pt, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Расстояние от точки до ломаной контура — в долях ширины кадра (`aspect` — высота к ширине). */
function distance(pt: Pt, poly: readonly Pt[], aspect: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ax = a[0], ay = a[1] * aspect, bx = b[0], by = b[1] * aspect, px = pt[0], py = pt[1] * aspect;
    const dx = bx - ax, dy = by - ay;
    const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/**
 * Попал ли игрок в место (задача «найдите на снимке»): внутри контура или рядом с ним — палец толще линии, поэтому
 * засчитывается и касание в `slack` доли ширины от края.
 */
export function hits(a: MarkArea, pt: Pt, aspect: number, slack = 0.035): boolean {
  return a.outlines.some(o => inside(pt, o) || distance(pt, o, aspect) <= slack);
}
