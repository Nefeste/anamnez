// УЗИ вен ноги кодом (spec 2026-09-chapter-2, часть 33а): геометрия — чистые функции в долях
// кадра, рисунок — vein.ts. Датчик линейный: кадр — прямоугольники, лучи идут вниз параллельно.
// Поперечный срез через бедро: кожа, подкожная клетчатка с подкожной веной, фасция, мышцы, в
// глубине — артерия и глубокая вена рядом, ниже — дуга кости с тенью. Два кадра рядом: слева
// датчик просто лежит, справа им давят — здоровая вена сжимается в щель, артерия остаётся
// круглой. Вену с тромбом не сжать: в ней серое содержимое (960_1, раздел 2.4: компрессия вены
// датчиком). Надрыв икроножной мышцы — тёмная линза гематомы в мышце.
//
// Рисовальщик болезней не знает: тромб, воспалённая подкожная вена и гематома заданы параметрами.
import { Rng } from '@/engine/core/rng';

export type Pt = [number, number];

export interface VeinFindings {
  view: 'vein';
  /** 0–1: глубокая вена занята тромбом — не сжимается, внутри серое; 0 — вена здорова */
  deep?: number;
  /** 0–1: тромб в подкожной вене — она шире, не сжимается, вокруг светлее от воспаления */
  superficial?: number;
  /** 0–1: надрыв мышцы — тёмная линза гематомы в мышце, чем больше, тем длиннее */
  tear?: number;
}

/** Кадр: левый — без давления, правый — с давлением; по вертикали — от кожи вниз. */
export const PANEL_TOP = 0.08;
export const PANEL_BOTTOM = 0.98;
export const PANELS: readonly [number, number][] = [[0.02, 0.49], [0.51, 0.98]];

/** Эллипс по центру и полуосям. */
export interface Oval {
  c: Pt;
  rx: number;
  ry: number;
}

export interface VeinPanel {
  /** датчиком давят — правый кадр */
  pressed: boolean;
  /** левый и правый край кадра */
  x: [number, number];
  /** граница кожи и клетчатки, клетчатки и фасции — глубины */
  skin: number;
  fat: number;
  /** соединительнотканные перегородки клетчатки — светлые чёрточки */
  septa: [Pt, Pt][];
  /** мышечные волокна — косые светлые штрихи */
  fibers: [Pt, Pt][];
  /** подкожная вена: просвет; `clot` — занята тромбом; `halo` — отёчная клетчатка вокруг */
  gsv: Oval & { clot: boolean; halo?: Oval };
  /** артерия — круглая, со светлой стенкой, датчиком не сжимается */
  artery: Oval;
  /** глубокая вена рядом с артерией; сжата — почти щель; `clot` — внутри тромб */
  vein: Oval & { clot: boolean };
  /** гематома при надрыве мышцы — тёмная линза */
  tear?: Oval;
  /** кость — светлая дуга, под ней тень */
  bone: { arc: Pt[]; shadow: Pt[] };
}

export interface VeinGeometry {
  view: 'vein';
  panels: [VeinPanel, VeinPanel];
}

const clamp01 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? 0 : Math.min(1, Math.max(0, x)));

/** Точки эллипса — для дуги кости и проверок. */
export function ovalPoints(o: Oval, n = 48): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    return [o.c[0] + o.rx * Math.cos(t), o.c[1] + o.ry * Math.sin(t)] as Pt;
  });
}

/**
 * Два кадра УЗИ вены. Анатомия одна и та же; от зерна — лёгкие сдвиги перегородок и волокон. С
 * давлением клетчатка тоньше, здоровые вены сжимаются, артерия и вена с тромбом — нет.
 */
export function veinGeometry(f: VeinFindings, seed: number): VeinGeometry {
  const deep = clamp01(f.deep);
  const sup = clamp01(f.superficial);
  const tear = clamp01(f.tear);
  const rng = Rng.seeded(seed).fork('us-vein');
  const u = () => rng.int(1000) / 1000;
  // одни и те же случайные сдвиги в обоих кадрах: срез тот же, меняется только давление
  const septaJitter = Array.from({ length: 6 }, () => [u(), u(), u()] as const);
  const fiberJitter = Array.from({ length: 14 }, () => [u(), u()] as const);
  const panel = (pressed: boolean, [x0, x1]: [number, number]): VeinPanel => {
    const w = x1 - x0;
    const X = (k: number) => x0 + k * w;
    const skin = PANEL_TOP + 0.025;
    // клетчатку датчик сдавливает — на треть тоньше
    const fatDepth = (pressed ? 0.12 : 0.17) * (1 + 0.15 * sup);
    const fat = skin + fatDepth;
    const septa: [Pt, Pt][] = septaJitter.map(([a, b, c]) => {
      const y = skin + fatDepth * (0.2 + 0.6 * a);
      const xs = X(0.05 + 0.8 * b);
      return [[xs, y], [xs + w * (0.08 + 0.1 * c), y + fatDepth * 0.05 * (c - 0.5)]];
    });
    const fibers: [Pt, Pt][] = fiberJitter.map(([a, b], i) => {
      const y = fat + 0.04 + (0.48 * (i + a)) / fiberJitter.length;
      const xs = X(0.04 + 0.7 * b);
      return [[xs, y], [xs + w * 0.2, y + 0.018]];
    });
    // подкожная вена — в клетчатке над артерией и веной, с тромбом шире
    const gsvR = 0.018 + 0.014 * sup;
    const gsvClot = sup > 0;
    const gsv: VeinPanel['gsv'] = {
      c: [X(0.66), skin + fatDepth * 0.5],
      rx: gsvR * 1.25,
      ry: pressed && !gsvClot ? 0.0035 : gsvR,
      clot: gsvClot,
      ...(gsvClot ? { halo: { c: [X(0.66), skin + fatDepth * 0.5], rx: gsvR * 2.6, ry: gsvR * 2.1 } } : {}),
    };
    // артерия и вена — на одной глубине; вена снаружи и крупнее; с тромбом — ещё шире
    const vy = fat + 0.25;
    const artery: Oval = { c: [X(0.34), vy], rx: 0.034, ry: pressed ? 0.031 : 0.034 };
    const veinRx = 0.05 * (1 + 0.2 * deep);
    const veinRy = 0.036 * (1 + 0.25 * deep);
    const clot = deep > 0;
    const vein: VeinPanel['vein'] = { c: [X(0.62), vy + 0.004], rx: pressed && !clot ? veinRx * 1.15 : veinRx, ry: pressed && !clot ? 0.004 : veinRy, clot };
    // гематома — линза в мышце над сосудами, давление её чуть уплощает
    const tearOval: Oval | undefined = tear > 0 ? { c: [X(0.42), fat + 0.1], rx: w * (0.18 + 0.14 * tear), ry: (0.018 + 0.014 * tear) * (pressed ? 0.8 : 1) } : undefined;
    // кость — дуга ниже сосудов, под ней тень до низа кадра
    const boneC: Pt = [X(0.48), vy + 0.3];
    const arc: Pt[] = Array.from({ length: 25 }, (_, i) => {
      const t = Math.PI + (i / 24) * Math.PI;
      return [boneC[0] + w * 0.24 * Math.cos(t), boneC[1] + 0.04 * Math.sin(t)] as Pt;
    });
    const shadow: Pt[] = [...arc, [arc[arc.length - 1][0], PANEL_BOTTOM], [arc[0][0], PANEL_BOTTOM]];
    return { pressed, x: [x0, x1], skin, fat, septa, fibers, gsv, artery, vein, ...(tearOval ? { tear: tearOval } : {}), bone: { arc, shadow } };
  };
  return { view: 'vein', panels: [panel(false, PANELS[0]), panel(true, PANELS[1])] };
}
