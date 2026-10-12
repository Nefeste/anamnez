// МРТ поясничного отдела позвоночника кодом (ADR 0013, spec 2026-10-chapter-4, часть 58а): геометрия — чистые функции в
// долях кадра, рисунок — spine.ts. Срез — продольный, по середине тела, режим T2: жидкость и жир светлые, мышцы и связки
// тёмные. Кадр квадратный; спереди — слева, голова — сверху, как принято показывать такие срезы. В кадре — от XII грудного
// позвонка до крестца: тела позвонков и диски, позвоночный канал с ликвором, конец спинного мозга и корешки конского хвоста,
// остистые отростки и жёлтые связки, мышцы и подкожный жир спины; спереди — аорта и петли кишки, внизу — мочевой пузырь.
//
// Рисовальщик болезней не знает: грыжа задана уровнем и размером — какую долю дурального мешка она занимает, пузырь — тем,
// насколько он полон. Что это значит, запишут признаки базы по источникам (`777_1`).
import { Rng } from '@/engine/core/rng';

export type Pt = [number, number];

/** Нижние поясничные диски — уровни, где в игре бывает грыжа. */
export type DiscLevel = 'L3-L4' | 'L4-L5' | 'L5-S1';
export const DISC_LEVELS: readonly DiscLevel[] = ['L3-L4', 'L4-L5', 'L5-S1'];

export interface SpineFindings {
  /**
   * грыжа диска: уровень и `size` — 0–1, какую долю глубины дурального мешка она занимает. От `COMPRESSION` мешок на её
   * уровне почти исчезает — сдавлен конский хвост
   */
  hernia?: { level: DiscLevel; size: number };
  /** 0–1: мочевой пузырь внизу слева — от пустого (не виден) до переполненного */
  bladder?: number;
}

/** С какого размера грыжа перекрывает канал. */
export const COMPRESSION = 0.75;

export interface Vertebra {
  name: string;
  /** середина, ось — книзу, нормаль — назад (единичные) */
  c: Pt;
  axis: Pt;
  back: Pt;
  outline: Pt[];
  /** замыкательные пластинки — спереди назад */
  top: Pt[];
  bottom: Pt[];
  /** выемка базивертебральной вены у задней стенки — светлое пятнышко; у крестца нет */
  vein?: Pt;
  /** костный мозг чуть светлее или темнее соседей: −1…1 */
  tone: number;
}

export interface Disc {
  /** «L4-L5»: верхний и нижний позвонок */
  level: string;
  c: Pt;
  outline: Pt[];
  nucleus: Pt[];
  /** диск с водой — светлое ядро; обезвоженный — тёмный и ниже */
  bright: boolean;
  /** тёмная поперечная щель в ядре — бывает и у здоровых */
  cleft?: [Pt, Pt];
  /** рудимент между крестцовыми позвонками — тонкая тёмная полоска */
  sacral?: true;
}

export interface Loop {
  c: Pt;
  rx: number;
  ry: number;
  angle: number;
  content: 'fluid' | 'gas' | 'soft';
}

export interface SpineGeometry {
  /** всё, что спереди от кожи спины */
  body: Pt[];
  /** кожа спины — сверху вниз */
  skin: Pt[];
  /** мышцы спины и связки между отростками */
  muscle: Pt[];
  vertebrae: Vertebra[];
  discs: Disc[];
  /** позвоночный канал: задняя стенка тел и дисков (сглаженная) и передняя поверхность дуг — сверху вниз, точка в точку */
  canal: { front: Pt[]; back: Pt[] };
  /** задняя продольная связка — по задней стенке тел и дисков, над грыжей — по ней */
  pll: Pt[];
  /** передняя продольная связка — по передней стенке */
  all: Pt[];
  /** дуральный мешок с ликвором */
  sac: Pt[];
  /** спинной мозг до конуса */
  cord: Pt[];
  conusTip: Pt;
  /** терминальная нить — от конуса до конца мешка */
  filum: Pt[];
  /** корешки конского хвоста */
  roots: Pt[][];
  /** остистые отростки с дугами */
  spinous: Pt[][];
  /** задняя стенка крестца — кость за крестцовым каналом */
  sacralLamina: Pt[];
  /** жёлтые связки — между дугами */
  flavum: Pt[][];
  aorta: Pt[];
  bowel: Loop[];
  bladder?: Pt[];
  hernia?: {
    level: DiscLevel;
    outline: Pt[];
    /** глубина мешка там, где он уже всего, — доля обычной */
    residual: number;
    compression: boolean;
    /** где мешок уже всего */
    at: Pt;
  };
}

const deg = Math.PI / 180;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k];
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const unit = (v: Pt): Pt => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
const axisOf = (tilt: number): Pt => [Math.sin(tilt * deg), Math.cos(tilt * deg)];
/** нормаль назад к оси, идущей книзу: при отвесной оси — вправо */
const backOf = (axis: Pt): Pt => [axis[1], -axis[0]];

/** Отрезок от `a` к `b` без конца, середина прогнута на `sag` по `dir`. */
function side(a: Pt, b: Pt, dir: Pt, sag: number, n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / n;
    return add(lerp(a, b, t), dir, 4 * t * (1 - t) * sag);
  });
}

/** Сглаживание замкнутого контура: углы скругляются (Чайкин). */
function rounded(pts: readonly Pt[], passes = 2): Pt[] {
  let p = [...pts];
  for (let k = 0; k < passes; k++) {
    const q: Pt[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push(lerp(a, b, 0.25), lerp(a, b, 0.75));
    }
    p = q;
  }
  return p;
}

/** Скользящее среднее открытой линии: концы на месте. */
function smoothLine(pts: readonly Pt[], r: number): Pt[] {
  return pts.map((_, i) => {
    let x = 0, y = 0, n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(pts.length - 1, i + r); j++) {
      x += pts[j][0];
      y += pts[j][1];
      n++;
    }
    return [x / n, y / n];
  });
}
const smoothValues = (v: readonly number[], r: number) =>
  v.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(v.length - 1, i + r); j++) {
      s += v[j];
      n++;
    }
    return s / n;
  });

/** Эллипс многоугольником. */
function ellipse(c: Pt, rx: number, ry: number, angle: number, n = 40): Pt[] {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    return [c[0] + x * ca - y * sa, c[1] + x * sa + y * ca];
  });
}

/** Точка внутри многоугольника (чётность пересечений). */
export function inside(p: Pt, poly: readonly Pt[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

// Тела: высота и глубина спереди назад — доли кадра; наклон оси от отвеса, градусы: плюс — книзу назад (поясничный лордоз
// и крестец; крестец вогнут спереди — книзу ось поворачивает вперёд); высота диска под позвонком. Пропорции — игровая
// оценка по анатомии: поясничные тела к низу крупнее, диски выше, у крестца — рудименты.
const SHAPE: { name: string; h: number; d: number; tilt: number; disc: number }[] = [
  { name: 'T12', h: 0.074, d: 0.098, tilt: -9, disc: 0.026 },
  { name: 'L1', h: 0.08, d: 0.104, tilt: -10, disc: 0.03 },
  { name: 'L2', h: 0.083, d: 0.108, tilt: -7, disc: 0.033 },
  { name: 'L3', h: 0.085, d: 0.112, tilt: -2, disc: 0.036 },
  { name: 'L4', h: 0.085, d: 0.114, tilt: 6, disc: 0.037 },
  { name: 'L5', h: 0.082, d: 0.112, tilt: 17, disc: 0.033 },
  { name: 'S1', h: 0.07, d: 0.104, tilt: 36, disc: 0.009 },
  { name: 'S2', h: 0.062, d: 0.086, tilt: 26, disc: 0.007 },
  { name: 'S3', h: 0.054, d: 0.068, tilt: 14, disc: 0.006 },
  { name: 'S4', h: 0.046, d: 0.052, tilt: 2, disc: 0 },
];
const SCALE = 1.1;
/** глубина костного канала по позвонкам: к крестцу уже */
const CANAL: Record<string, number> = { T12: 0.066, L1: 0.066, L2: 0.065, L3: 0.064, L4: 0.063, L5: 0.06, S1: 0.052, S2: 0.04, S3: 0.03, S4: 0.022 };
/** задняя продольная связка и щель перед мешком */
const PLL = 0.004;
const EPI_FRONT = 0.0015;
/** мешок на уровне грыжи не уже этого */
const MIN_SAC = 0.0025;

export function spineGeometry(findings: SpineFindings, seed: number): SpineGeometry {
  const rng = Rng.seeded(seed).fork('spine');
  const u = () => rng.int(1000) / 1000;
  const hernia = findings.hernia ? { level: findings.hernia.level, size: clamp01(findings.hernia.size) } : undefined;
  const herniaDisc: string | undefined = hernia?.level;

  // 1. Позвонки цепочкой сверху вниз: нижняя пластинка, диск, верхняя пластинка следующего. Обезвоженный диск ниже: у
  // грыжи — всегда, у соседних и у L5-S1 — по зерну
  const tiltJitter = SHAPE.map(() => (u() - 0.5) * 4);
  const darkL5S1 = u() < 0.3;
  const darkNext = u() < 0.4;
  const names = SHAPE.map(s => s.name);
  const discName = (i: number) => `${names[i]}-${names[i + 1]}`;
  const dark = (i: number) => {
    const level = discName(i);
    if (level === herniaDisc) return true;
    if (herniaDisc && darkNext) {
      const k = names.indexOf(herniaDisc.split('-')[0]);
      if (Math.abs(k - i) === 1) return true;
    }
    return level === 'L5-S1' && darkL5S1;
  };
  const vertebrae: Vertebra[] = [];
  const discBetween: { i: number; height: number; axis: Pt }[] = [];
  let c: Pt = [0.53 + (u() - 0.5) * 0.02, 0.02 + (u() - 0.5) * 0.01];
  for (let i = 0; i < SHAPE.length; i++) {
    const s = SHAPE[i];
    const h = s.h * SCALE * (0.97 + 0.06 * u());
    const d = s.d * SCALE * (0.97 + 0.06 * u());
    const axis = axisOf(s.tilt + tiltJitter[i]);
    const back = backOf(axis);
    if (i > 0) {
      // середина — от верхней пластинки, которую задал диск над позвонком
      c = add(c, axis, h / 2);
    }
    const top = add(c, axis, -h / 2), bottom = add(c, axis, h / 2);
    const AS = add(top, back, -d / 2), PS = add(top, back, d / 2), AI = add(bottom, back, -d / 2), PI = add(bottom, back, d / 2);
    const sacral = s.name.startsWith('S');
    // пластинки вогнуты внутрь тела, передняя стенка — с «талией», задняя почти прямая
    const topPlate = side(AS, PS, axis, 0.004 * SCALE, 10);
    const postWall = side(PS, PI, [-back[0], -back[1]], 0.0015, 8);
    const bottomPlate = side(PI, AI, [-axis[0], -axis[1]], 0.004 * SCALE, 10);
    const antWall = side(AI, AS, back, sacral ? 0.002 : 0.006, 8);
    const outline = rounded([...topPlate, ...postWall, ...bottomPlate, ...antWall], 2);
    const vein = sacral ? undefined : add(lerp(PS, PI, 0.5), back, -0.008);
    vertebrae.push({ name: s.name, c, axis, back, outline, top: [...topPlate, PS], bottom: [...bottomPlate, AI].reverse(), ...(vein ? { vein } : {}), tone: u() * 2 - 1 });
    if (s.disc > 0) {
      const next = axisOf(SHAPE[i + 1].tilt + tiltJitter[i + 1]);
      const mid = unit(add(axis, next));
      const height = s.disc * SCALE * (dark(i) ? 0.75 : 1) * (0.95 + 0.1 * u());
      discBetween.push({ i, height, axis: mid });
      // середина следующего позвонка — от середины нижней пластинки через диск
      c = add(bottom, mid, height);
    }
  }

  // 2. Диски: нижняя пластинка верхнего позвонка, передний край, верхняя пластинка нижнего, задний край — с выпуклостью
  const discs: Disc[] = discBetween.map(({ i, height, axis }) => {
    const up = vertebrae[i], down = vertebrae[i + 1];
    const level = discName(i);
    const sacral = up.name.startsWith('S');
    const back = backOf(axis);
    const bright = !sacral && !dark(i);
    const upPlate = [...up.bottom].reverse(); // сзади наперёд
    const downPlate = down.top; // спереди назад
    const ant = side(upPlate[upPlate.length - 1], downPlate[0], [-back[0], -back[1]], sacral ? 0 : 0.003, 4).slice(1);
    const bulge = sacral ? 0 : bright ? 0.002 : 0.004;
    const post = side(downPlate[downPlate.length - 1], upPlate[0], back, bulge, 4).slice(1);
    const outline = [...upPlate, ...ant, ...downPlate, ...post];
    const cc = lerp(lerp(upPlate[0], upPlate[upPlate.length - 1], 0.5), lerp(downPlate[0], downPlate[downPlate.length - 1], 0.5), 0.5);
    const depth = Math.hypot(upPlate[0][0] - upPlate[upPlate.length - 1][0], upPlate[0][1] - upPlate[upPlate.length - 1][1]);
    const nc = add(cc, back, depth * 0.06);
    const angle = Math.atan2(back[1], back[0]);
    const nucleus = ellipse(nc, depth * (bright ? 0.32 : 0.24), height * (bright ? 0.3 : 0.2), angle, 32);
    // бросок — у каждого диска: от обезвоженного диска зерно соседей не сдвигается
    const roll = u();
    const cleft: [Pt, Pt] | undefined = bright && roll < 0.6 ? [add(nc, back, -depth * 0.18), add(nc, back, depth * 0.16)] : undefined;
    return { level, c: cc, outline, nucleus, bright, ...(cleft ? { cleft } : {}), ...(sacral ? { sacral: true as const } : {}) };
  });

  // 3. Передняя стенка канала — задняя стенка тел и края дисков сверху вниз; у каждой точки — нормаль назад и глубина
  // канала. Отсюда — мешок, дуги, мышцы и кожа
  type Mark = { p: Pt; depth: number; disc?: string; v?: string };
  const marks: Mark[] = [];
  const lead: Pt = add(vertebrae[0].top[vertebrae[0].top.length - 1], vertebrae[0].axis, -0.06);
  marks.push({ p: lead, depth: CANAL.T12, v: 'T12' });
  for (let i = 0; i < vertebrae.length; i++) {
    const v = vertebrae[i];
    const PS = v.top[v.top.length - 1], PI = v.bottom[v.bottom.length - 1];
    for (const p of side(PS, PI, [-v.back[0], -v.back[1]], 0.0015, 10)) marks.push({ p, depth: CANAL[v.name], v: v.name });
    const d = discs.find(x => x.level === `${v.name}-${vertebrae[i + 1]?.name}`);
    if (d) {
      const next = vertebrae[i + 1];
      const a = PI, b = next.top[next.top.length - 1];
      const bulge = d.sacral ? 0 : d.bright ? 0.002 : 0.004;
      const back = unit(add(v.back, next.back));
      for (const p of side(a, b, back, bulge, 5)) marks.push({ p, depth: (CANAL[v.name] + CANAL[next.name]) / 2, disc: d.level });
    }
  }
  const last = vertebrae[vertebrae.length - 1];
  marks.push({ p: last.bottom[last.bottom.length - 1], depth: CANAL.S4 * 0.6, v: last.name });
  // плотная и ровная линия: равный шаг по длине
  const front: Pt[] = [];
  const depthRaw: number[] = [];
  const tags: { disc?: string; v?: string }[] = [];
  const STEP = 0.003;
  for (let i = 0; i + 1 < marks.length; i++) {
    const a = marks[i], b = marks[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) / STEP));
    for (let k = 0; k < n; k++) {
      front.push(lerp(a.p, b.p, k / n));
      depthRaw.push(a.depth + (b.depth - a.depth) * (k / n));
      tags.push(b.disc ? { disc: b.disc } : { v: b.v ?? a.v });
    }
  }
  front.push(marks[marks.length - 1].p);
  depthRaw.push(marks[marks.length - 1].depth);
  tags.push({ v: last.name });
  const N = front.length;
  // всё, что сзади, откладывается от сглаженной стенки: на углу у крестца канал поворачивает резко, и линии мешка и дуг,
  // отложенные от ломаной, сложились бы зубцом
  const base = smoothLine(front, 8);
  const normals: Pt[] = base.map((_, i) => {
    const a = base[Math.max(0, i - 6)], b = base[Math.min(N - 1, i + 6)];
    return backOf(unit([b[0] - a[0], b[1] - a[1]]));
  });
  const depth = smoothValues(depthRaw, 8);
  const at = (i: number, off: number): Pt => add(base[i], normals[i], off);
  const indexWhere = (f: (t: { disc?: string; v?: string }) => boolean) => {
    const idx = tags.map((t, i) => (f(t) ? i : -1)).filter(i => i >= 0);
    return idx.length ? [idx[0], idx[idx.length - 1]] : [0, 0];
  };
  const discRange = (level: string) => indexWhere(t => t.disc === level);
  const bodyRange = (name: string) => indexWhere(t => t.v === name);
  const back: Pt[] = front.map((_, i) => at(i, depth[i]));

  // 4. Дуральный мешок: спереди — за связкой, сзади — до дуг; между дугами — жировая подушка (светлый треугольник). Конец
  // мешка — у середины S2
  const [s2a, s2b] = bodyRange('S2');
  const endIdx = Math.round(s2a + (s2b - s2a) * (0.35 + 0.3 * u()));
  const fatPad = new Array<number>(N).fill(0);
  for (const d of discs) {
    if (d.sacral) continue;
    const [a, b] = discRange(d.level);
    const mid = (a + b) / 2, half = (b - a) / 2 + 12;
    for (let i = Math.max(0, Math.round(mid - half)); i <= Math.min(N - 1, Math.round(mid + half)); i++) {
      const t = (i - mid) / half;
      fatPad[i] = Math.max(fatPad[i], (1 - t * t) * 0.006);
    }
  }
  const sacFront = front.map(() => PLL + EPI_FRONT);
  const sacBack = front.map((_, i) => depth[i] - 0.002 - fatPad[i]);
  // к концу мешок сходится к середине канала
  const taper = (i: number) => {
    const startT = endIdx - 30;
    if (i <= startT) return 1;
    return clamp01(1 - (i - startT) / (endIdx - startT)) ** 0.7;
  };

  // 5. Грыжа: купол назад от заднего края диска; большая выходит за высоту диска и сползает вниз или вверх; мешок над ней
  // поджат, на уровне сдавления — почти исчезает
  const push = new Array<number>(N).fill(0);
  let herniaOut: SpineGeometry['hernia'];
  if (hernia && herniaDisc && hernia.size > 0) {
    const [a, b] = discRange(herniaDisc);
    const mid = (a + b) / 2;
    const half = ((b - a) / 2) * (0.9 + 1.6 * hernia.size) + 2;
    const shift = (Rng.seeded(seed).fork('hernia').int(1000) / 1000 - 0.25) * hernia.size * (b - a) * 0.8;
    const cIdx = mid + shift;
    const sacDepthAt = (i: number) => sacBack[i] - sacFront[i];
    // с `COMPRESSION` грыжа доходит до дуг: мешок на её уровне — щель
    const fill = hernia.size >= COMPRESSION ? 1 : hernia.size;
    const dmax = fill * sacDepthAt(Math.round(mid)) + PLL + EPI_FRONT;
    for (let i = Math.max(0, Math.floor(cIdx - half)); i <= Math.min(N - 1, Math.ceil(cIdx + half)); i++) {
      const t = (i - cIdx) / half;
      if (Math.abs(t) < 1) push[i] = dmax * Math.sqrt(1 - t * t) ** 0.8;
    }
    const outer: Pt[] = [];
    const inner: Pt[] = [];
    let residual = 1, atPt: Pt = front[Math.round(mid)];
    for (let i = 0; i < N; i++) {
      if (push[i] <= 0) continue;
      inner.push(at(i, 0.0005));
      outer.push(at(i, Math.min(push[i], sacBack[i] - MIN_SAC)));
      const left = (sacBack[i] - Math.max(sacFront[i], Math.min(push[i], sacBack[i] - MIN_SAC))) / sacDepthAt(i);
      if (left < residual) {
        residual = left;
        atPt = at(i, (Math.min(push[i], sacBack[i] - MIN_SAC) + sacBack[i]) / 2);
      }
    }
    herniaOut = { level: hernia.level, outline: [...inner, ...outer.reverse()], residual: Math.max(0, residual), compression: hernia.size >= COMPRESSION, at: atPt };
  }
  const sacA = front.map((_, i) => Math.max(sacFront[i], Math.min(push[i], sacBack[i] - MIN_SAC)));
  const sacMid = (i: number) => (sacA[i] + sacBack[i]) / 2;
  const sacEdge = (i: number, k: 0 | 1) => {
    const m = sacMid(i), half = ((sacBack[i] - sacA[i]) / 2) * taper(i);
    return at(i, k === 0 ? m - half : m + half);
  };
  const sacFrontPts: Pt[] = [], sacBackPts: Pt[] = [];
  for (let i = 0; i <= endIdx; i++) {
    sacFrontPts.push(sacEdge(i, 0));
    sacBackPts.push(sacEdge(i, 1));
  }
  const sac = [...sacFrontPts, ...sacBackPts.reverse()];
  // связка — по задней стенке, над грыжей — по её поверхности
  const pll = front.map((_, i) => at(i, Math.max(PLL * 0.6, push[i] > 0 ? Math.min(push[i], sacBack[i] - MIN_SAC) - 0.001 : PLL * 0.6)));

  // 6. Спинной мозг — до конуса у L1 или диска L1-L2, дальше — терминальная нить и корешки
  const [l1a] = bodyRange('L1');
  const [, d12b] = discRange('L1-L2');
  const conusIdx = Math.round(l1a + (d12b - l1a) * (0.45 + 0.45 * u()));
  const cordR = 0.0115 * SCALE;
  const cordHalf = (i: number) => (i < conusIdx - 22 ? cordR : cordR * clamp01((conusIdx - i) / 22) ** 0.6);
  const cordAt = (i: number) => sacA[i] + (sacBack[i] - sacA[i]) * 0.46;
  const cordFront: Pt[] = [], cordBack: Pt[] = [];
  for (let i = 0; i <= conusIdx; i++) {
    cordFront.push(at(i, cordAt(i) - cordHalf(i)));
    cordBack.push(at(i, cordAt(i) + cordHalf(i)));
  }
  const cord = [...cordFront, ...cordBack.reverse()];
  const conusTip = at(conusIdx, cordAt(conusIdx));
  const filum: Pt[] = [];
  for (let i = conusIdx; i <= endIdx; i += 2) filum.push(at(i, sacMid(i) + (sacBack[i] - sacA[i]) * 0.04 * taper(i)));

  // корешки — нити от конуса книзу, в покое лежат сзади в мешке; выходят на своих уровнях. Над сдавлением — извитые
  // (корешкам некуда деться), на уровне сдавления — сжаты в узкую щель
  const roots: Pt[][] = [];
  const compression = herniaOut?.compression ? (discRange(herniaDisc!)[0] + discRange(herniaDisc!)[1]) / 2 : undefined;
  const EXITS = ['L3-L4', 'L4-L5', 'L5-S1', 'S1-S2', 'S1-S2'];
  for (let j = 0; j < EXITS.length; j++) {
    const f = 0.34 + 0.56 * (j / (EXITS.length - 1)) + (u() - 0.5) * 0.06;
    const start = conusIdx - 6 - Math.round(u() * 10);
    const exit = EXITS[j];
    const end = Math.min(endIdx - 4, discRange(exit)[1] + Math.round(u() * 12));
    const phase = u() * 6.28, freq = 0.08 + u() * 0.05;
    const path: Pt[] = [];
    for (let i = start; i <= end; i += 2) {
      let wiggle = 0.0012 * Math.sin(i * freq + phase);
      if (compression !== undefined && i < compression - 8 && i > compression - 100) {
        const t = (compression - 8 - i) / 92;
        wiggle += 0.0075 * Math.sin(t * Math.PI) * Math.sin(i * 0.32 + phase + j);
      }
      const m = sacMid(i), half = ((sacBack[i] - sacA[i]) / 2) * taper(i);
      const off = m + (f - 0.5) * 2 * half;
      const lo = m - half + 0.0008, hi = m + half - 0.0008;
      path.push(at(i, lo < hi ? Math.min(hi, Math.max(lo, off + wiggle)) : m));
    }
    if (path.length > 1) roots.push(path);
  }

  // 7. Дуги и остистые отростки — сзади от канала, у нижней половины своего позвонка и диска под ним; жёлтые связки — между
  // дугами; задняя стенка крестца — тонкая кость за каналом
  const spinous: Pt[][] = [];
  const flavum: Pt[][] = [];
  for (let k = 0; k < vertebrae.length && !vertebrae[k].name.startsWith('S'); k++) {
    const v = vertebrae[k], next = vertebrae[k + 1];
    const [a, b] = bodyRange(v.name);
    const [, dEnd] = discRange(`${v.name}-${next.name}`);
    const i1 = Math.round(a + (b - a) * 0.2), i2 = Math.round(b + (dEnd - b) * 0.7);
    const len = (v.name === 'L5' ? 0.075 : v.name === 'T12' ? 0.09 : 0.095) * SCALE * (0.95 + 0.1 * u());
    const tilt = 0.18 + 0.08 * u(); // книзу назад
    const dirAt = (i: number): Pt => unit(add(normals[i], v.axis, tilt));
    const base1 = at(i1, depth[i1] - 0.001), base2 = at(i2, depth[i2] - 0.001);
    const tip1 = add(base1, dirAt(i1), len * 0.92), tip2 = add(base2, dirAt(i2), len);
    // верхний край — прогнут книзу, кончик — шире основания
    const topEdge = side(base1, tip1, v.axis, 0.008, 6);
    const tipEdge = side(tip1, tip2, normals[i2], 0.006, 4);
    const lowEdge = side(tip2, base2, [-v.axis[0], -v.axis[1]], 0.004, 6);
    const baseEdge = side(base2, base1, [-normals[i1][0], -normals[i1][1]], 0.002, 4);
    spinous.push(rounded([...topEdge, ...tipEdge, ...lowEdge, ...baseEdge], 2));
  }
  for (const d of discs) {
    if (d.sacral) continue;
    const [a, b] = discRange(d.level);
    const pts: Pt[] = [];
    const i0 = Math.max(0, a - 6), i1 = Math.min(N - 1, b + 14);
    for (let i = i0; i <= i1; i++) {
      const t = (i - i0) / (i1 - i0);
      pts.push(at(i, depth[i] - 0.002 - 0.003 * Math.sin(t * Math.PI)));
    }
    flavum.push(pts);
  }
  const [s1a] = bodyRange('S1');
  const laminaOuter: Pt[] = [], laminaInner: Pt[] = [];
  for (let i = s1a; i < N; i++) {
    const crest = 0.006 * Math.max(0, Math.sin(((i - s1a) / (N - s1a)) * Math.PI * 3.2)) ** 2;
    laminaInner.push(back[i]);
    laminaOuter.push(at(i, depth[i] + 0.014 + crest));
  }
  const sacralLamina = [...laminaInner, ...laminaOuter.reverse()];

  // 8. Мышцы спины — сзади от дуг до концов отростков с запасом, у крестца тоньше; подкожный жир — до кожи. Кожа гладкая
  const fat = 0.045 + 0.03 * u();
  const muscleOff = front.map((_, i) => {
    const t = i < s1a ? 1 : Math.max(0.12, 1 - (i - s1a) / ((N - s1a) * 0.8));
    return depth[i] + 0.125 * SCALE * t + (i >= s1a ? 0.016 * (1 - t) : 0);
  });
  const muscleOffS = smoothValues(muscleOff, 12);
  const muscleLine = smoothLine(front.map((_, i) => at(i, muscleOffS[i])), 10);
  const skinRaw = smoothLine(smoothLine(front.map((_, i) => at(i, muscleOffS[i] + fat + (i >= s1a ? 0.01 : 0))), 24), 24);
  // за пределы кадра: вверх — по оси XII грудного, вниз — к промежности
  const topDir = vertebrae[0].axis;
  const tail = skinRaw[skinRaw.length - 1];
  const skin: Pt[] = [add(skinRaw[0], topDir, -0.12), ...skinRaw, add(tail, [-0.15, 1], 0.12), [tail[0] - 0.03, 1.12]];
  const body: Pt[] = [[-0.05, -0.1], ...skin, [-0.05, 1.12]];
  const muscle: Pt[] = [
    add(back[0], topDir, -0.12),
    ...back,
    ...[add(muscleLine[N - 1], [-0.1, 1], 0.05)],
    ...[...muscleLine].reverse(),
    add(muscleLine[0], topDir, -0.12),
  ];

  // 9. Спереди: передняя продольная связка по передней стенке, аорта перед телами до L4, петли кишки, внизу — пузырь
  const allPts: Pt[] = [];
  for (let i = 0; i < vertebrae.length; i++) {
    const v = vertebrae[i];
    if (v.name.startsWith('S') && v.name !== 'S1') break;
    const AS = v.top[0], AI = v.bottom[0];
    allPts.push(...side(AS, AI, v.back, v.name.startsWith('S') ? 0.002 : 0.006, 8));
    const next = vertebrae[i + 1];
    if (next && !v.name.startsWith('S')) allPts.push(...side(AI, next.top[0], [-v.back[0], -v.back[1]], 0.003, 4));
  }
  const all = smoothLine(allPts, 2);
  const aortaR = 0.028 * (0.92 + 0.16 * u());
  const l4 = vertebrae.find(v => v.name === 'L4')!;
  const aortaEnd = l4.c[1] + (u() - 0.5) * 0.02;
  const aortaAxis: Pt[] = all.filter(p => p[1] < aortaEnd).map((p, i, arr) => {
    const a = arr[Math.max(0, i - 3)], b = arr[Math.min(arr.length - 1, i + 3)];
    const n = backOf(unit([b[0] - a[0], b[1] - a[1]]));
    return add(p, n, -(aortaR + 0.006));
  });
  aortaAxis.unshift(add(aortaAxis[0], topDir, -0.12));
  const aortaFront: Pt[] = [], aortaBack: Pt[] = [];
  for (let i = 0; i < aortaAxis.length; i++) {
    const a = aortaAxis[Math.max(0, i - 2)], b = aortaAxis[Math.min(aortaAxis.length - 1, i + 2)];
    const n = backOf(unit([b[0] - a[0], b[1] - a[1]]));
    // к развилке сужается
    const t = clamp01((aortaEnd - aortaAxis[i][1]) / 0.05);
    const r = aortaR * (0.55 + 0.45 * t);
    aortaFront.push(add(aortaAxis[i], n, -r));
    aortaBack.push(add(aortaAxis[i], n, r));
  }
  const aorta = rounded([...aortaFront, ...aortaBack.reverse()], 1);

  // петли — в животе спереди от аорты и тел, в тазу — спереди от крестца; друг на друга почти не ложатся
  const b = clamp01(findings.bladder ?? 0);
  const bladderC: Pt = [0.17, 1.0], bladderR: [number, number] = [0.07 + 0.12 * b, 0.05 + 0.1 * b];
  const bladder = b > 0.05 ? rounded(ellipse(bladderC, bladderR[0], bladderR[1], -0.12, 40), 1) : undefined;
  const s3 = vertebrae.find(v => v.name === 'S3')!;
  const rectum: Loop = { c: add(add(s3.c, s3.back, -(0.062 + 0.04)), s3.axis, 0.01), rx: 0.03, ry: 0.05, angle: 0.25, content: u() < 0.5 ? 'gas' : 'soft' };
  const bowel: Loop[] = [rectum];
  const clearOf = (p: Pt, r: number) => {
    if (bladder && ((p[0] - bladderC[0]) / (bladderR[0] + r)) ** 2 + ((p[1] - bladderC[1]) / (bladderR[1] + r)) ** 2 < 1) return false;
    // спереди от аорты, тел и крестца с запасом
    for (const q of [...aortaFront, ...all]) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < r + 0.012) return false;
    for (const v of vertebrae) if (inside(p, v.outline)) return false;
    const nearest = all.reduce((m, q) => (Math.abs(q[1] - p[1]) < Math.abs(m[1] - p[1]) ? q : m), all[0]);
    return p[0] < nearest[0] - r - 0.012;
  };
  for (let tries = 0; tries < 900 && bowel.length < 34; tries++) {
    const rx = 0.02 + 0.03 * u(), ry = 0.016 + 0.022 * u();
    const p: Pt = [0.0 + 0.44 * u(), 0.02 + 0.97 * u()];
    const r = Math.max(rx, ry);
    if (!clearOf(p, r)) continue;
    if (bowel.some(b => Math.hypot(b.c[0] - p[0], b.c[1] - p[1]) < (Math.max(b.rx, b.ry) + r) * 0.62)) continue;
    const k = u();
    bowel.push({ c: p, rx, ry, angle: (u() - 0.5) * 1.6, content: k < 0.35 ? 'fluid' : k < 0.55 ? 'gas' : 'soft' });
  }

  return {
    body, skin, muscle, vertebrae, discs, canal: { front: base, back }, pll, all, sac, cord, conusTip, filum, roots, spinous,
    sacralLamina, flavum, aorta, bowel,
    ...(bladder ? { bladder } : {}),
    ...(herniaOut ? { hernia: herniaOut } : {}),
  };
}
