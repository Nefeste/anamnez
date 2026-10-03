// ЭКГ в двенадцати отведениях кодом (spec 2026-10-chapter-3, часть 36; ADR 0013). Сердце — диполь:
// возбуждение предсердий и желудочков — петли вектора во времени (сумма «горбов» по трём осям),
// отведение — проекция вектора на свою ось. Подъём ST — вектор тока повреждения к стенке инфаркта,
// поэтому зеркальная депрессия в противоположных отведениях получается сама. Ритм и проведение —
// моменты возбуждения предсердий и желудочков. Оси: x — влево от пациента, y — вниз, z — вперёд.
// 250 отсчётов в секунду (отсчёт на миллиметр при 25 мм/с). Детерминирована по зерну; рисовальщик
// болезней не знает — что за находку рисовать, решает карта пациента по признакам базы.
import { Rng } from '../../engine/core/rng';

export type Vec = readonly [number, number, number];

export const LEADS = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'] as const;
export type Lead = (typeof LEADS)[number];

/**
 * Ритм и проведение: синусовый; фибрилляция и трепетание предсердий; наджелудочковая и желудочковая
 * тахикардии; АВ-блокады I степени, II степени Мобитц I (Венкебах) и Мобитц II, полная (III степени).
 */
export type EcgRhythm = 'sinus' | 'af' | 'flutter' | 'svt' | 'vt' | 'avb1' | 'avb2w' | 'avb2m' | 'avb3';
export type Wall = 'anterior' | 'inferior' | 'lateral';

export interface EcgFindings {
  /** нет — синусовый */
  rhythm?: EcgRhythm;
  /**
   * частота желудочков, в минуту: у синусового — частота синусового узла, у фибрилляции — средняя, у
   * трепетания — по ней выбирается проведение 2 : 1 … 4 : 1, у полной блокады — выскальзывающий ритм
   */
  rate?: number;
  /** подъём ST в отведениях стенки, высокий T, зеркальная депрессия в противоположных */
  stemi?: Wall;
  /** депрессия ST в отведениях левого желудочка и подъём в aVR — ишемия без подъёма ST */
  stDepression?: boolean;
  /** отрицательные T в отведениях стенки */
  tInversion?: Wall;
  /** патологические зубцы Q в отведениях стенки — инфаркт, перенесённый раньше */
  qWaves?: Wall;
  /** высокие комплексы левого желудочка, плоский T слева */
  lvh?: boolean;
  /** блокада левой или правой ножки пучка Гиса: широкий комплекс, ST и T против него */
  bundle?: 'lbbb' | 'rbbb';
  /** перикардит: подъём ST почти везде, депрессия PQ; в aVR — наоборот */
  pericarditis?: boolean;
  /** низкий вольтаж и чередование высоты комплексов — выпот в перикарде */
  lowVoltage?: boolean;
  /** перегрузка правого желудочка: S в I, Q и отрицательный T в III, отрицательные T в V1–V3 */
  rvStrain?: boolean;
}

export const ECG_HZ = 250;

/** Желудочковый комплекс: обычный, с блокадой ножки, желудочковый (тахикардия, выскальзывающий). */
export type QrsKind = 'normal' | 'lbbb' | 'rbbb' | 'ventricular';

export interface EcgBeat {
  /** начало QRS и его конец (точка J), с */
  qrs: number;
  j: number;
  /** начало P, проведённого к этому комплексу; нет — комплекс без своего P */
  p?: number;
  kind: QrsKind;
}

export interface EcgTrace {
  seconds: number;
  /** мВ по отведениям, ECG_HZ отсчётов в секунду */
  leads: Record<Lead, Float32Array>;
  /** комплексы желудочков по порядку */
  beats: EcgBeat[];
  /** начала возбуждения предсердий: зубцы P или волны трепетания; при фибрилляции — пусто */
  atria: number[];
}

const norm = (x: number, y: number, z: number): Vec => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
const scale = (v: Vec, k: number): Vec => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Оси отведений: от каких точек тела на сердце смотрит отведение, и его усиление. */
const deg = (a: number): Vec => [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180), 0];
const AUG = Math.sqrt(3) / 2;
export const LEAD_AXES: Record<Lead, { axis: Vec; gain: number }> = {
  // от конечностей — во фронтальной плоскости, угол от левой руки вниз (по Эйнтховену)
  I: { axis: deg(0), gain: 1 },
  II: { axis: deg(60), gain: 1 },
  III: { axis: deg(120), gain: 1 },
  aVR: { axis: deg(-150), gain: AUG },
  aVL: { axis: deg(-30), gain: AUG },
  aVF: { axis: deg(90), gain: AUG },
  // грудные — почти в поперечной плоскости, справа спереди к левой подмышке; они ближе к сердцу
  V1: { axis: norm(-0.55, 0.05, 0.83), gain: 1.25 },
  V2: { axis: norm(-0.2, 0.1, 0.97), gain: 1.6 },
  V3: { axis: norm(0.25, 0.15, 0.95), gain: 1.7 },
  V4: { axis: norm(0.55, 0.2, 0.8), gain: 1.6 },
  V5: { axis: norm(0.82, 0.2, 0.53), gain: 1.4 },
  V6: { axis: norm(0.97, 0.15, 0.2), gain: 1.15 },
};

/**
 * К какой стенке смотрит вектор повреждения и какие отведения её видят (II, III, aVF — нижняя). Нижний
 * чуть вправо — к III: при закрытии правой коронарной артерии ST в III выше, чем во II.
 */
const WALL: Record<Wall, Vec> = {
  inferior: norm(-0.2, 1, -0.1),
  anterior: norm(0.2, -0.15, 1),
  lateral: norm(1, -0.5, 0.1),
};

/** «Горб» вектора: время от начала комплекса, ширина слева и справа (с), направление с величиной (мВ). */
interface Bump {
  t: number;
  s: number;
  sRight?: number;
  v: Vec;
}

/** Комплекс QRS по виду: горбы от начала комплекса и длительность до точки J, с. */
function qrsBumps(kind: QrsKind, f: EcgFindings): { bumps: Bump[]; width: number } {
  if (kind === 'ventricular') {
    // возбуждение идёт по мышце, а не по проводящей системе: медленно и необычно направленно
    return {
      width: 0.16,
      bumps: [
        { t: 0.045, s: 0.022, v: scale(norm(-0.55, -0.65, 0.5), 1.15) },
        { t: 0.105, s: 0.026, v: scale(norm(-0.2, -0.4, 0.85), 0.6) },
      ],
    };
  }
  if (kind === 'lbbb') {
    // перегородка возбуждается справа налево, левый желудочек — поздно и медленно: широкий
    // зазубренный R в I и V6, глубокий QS в V1–V2
    return {
      width: 0.14,
      bumps: [
        { t: 0.02, s: 0.012, v: scale(norm(0.6, 0.2, -0.3), 0.25) },
        { t: 0.056, s: 0.018, v: scale(norm(0.85, 0.25, -0.5), 1.1) },
        { t: 0.096, s: 0.02, v: scale(norm(0.75, 0.1, -0.62), 0.9) },
      ],
    };
  }
  const lv = f.lvh ? 1.9 : 1;
  const q = f.qWaves;
  const bumps: Bump[] = [
    // перегородка: слева направо и вперёд — маленький r в V1, q в I, V5, V6
    { t: 0.012, s: 0.006, v: scale(norm(-0.6, 0.35, 0.72), 0.22) },
    // верхушка и передняя стенка
    { t: 0.03, s: 0.009, v: scale(norm(0.45, 0.75, 0.48), q === 'anterior' ? 0.35 : 0.8) },
    // основная масса левого желудочка: влево, вниз, назад
    { t: 0.046, s: 0.0105, v: scale(norm(0.8, 0.42, -0.43), 1.25 * lv) },
    // основание: вправо, вверх, назад — s в II, V5, V6
    { t: 0.068, s: 0.008, v: scale(norm(-0.4, -0.55, -0.73), 0.3 * (f.lvh ? 1.4 : 1)) },
  ];
  // рубец: начальные силы уходят от стенки — зубец Q в её отведениях
  if (q) bumps.push({ t: 0.016, s: 0.008, v: scale(WALL[q], -0.45) });
  // S в I и Q в III — перегрузка правого желудочка
  if (f.rvStrain) {
    bumps.push({ t: 0.075, s: 0.01, v: scale(norm(-0.95, -0.3, 0.1), 0.32) });
    bumps.push({ t: 0.014, s: 0.007, v: scale(norm(0.5, -0.87, 0), 0.3) });
  }
  if (kind === 'rbbb') {
    // правый желудочек — последним и медленно: R' в V1, широкий S в I и V6
    bumps.push({ t: 0.105, s: 0.018, v: scale(norm(-0.65, 0.15, 0.75), 0.55) });
    return { bumps, width: 0.13 };
  }
  return { bumps, width: 0.09 };
}

/**
 * Реполяризация у комплекса этого вида. `st` и `t` — свои у комплекса: они поворачиваются вместе с
 * осью сердца. `injury` — ток повреждения и ишемии, перикардит и перегрузка правого желудочка: их
 * направление задаёт стенка, а не ось, поэтому картина стенки одна у всех — при нижнем инфаркте ST
 * в III выше, чем во II, и в V4–V6 не опущен ни у кого.
 */
function repolarization(kind: QrsKind, f: EcgFindings): { st: Vec; t: Vec; injury: { st: Vec; t: Vec } } {
  const none: Vec = [0, 0, 0];
  if (kind === 'ventricular') return { st: none, t: scale(norm(0.5, 0.6, -0.6), 0.35), injury: { st: none, t: none } };
  // при блокаде левой ножки ST и T против комплекса
  const st: Vec = kind === 'lbbb' ? scale(norm(-0.85, -0.25, 0.5), 0.1) : none;
  let t: Vec = kind === 'lbbb' ? scale(norm(-0.75, -0.2, 0.62), 0.32) : scale(norm(0.55, 0.65, 0.25), 0.32);
  if (kind === 'rbbb') t = add(t, scale(norm(0.6, 0, -0.8), 0.15));
  if (f.lvh) t = scale(t, 0.55);
  let ist = none, it = none;
  if (f.stemi) {
    ist = add(ist, scale(WALL[f.stemi], f.stemi === 'lateral' ? 0.25 : f.stemi === 'anterior' ? 0.35 : 0.3));
    it = add(it, scale(WALL[f.stemi], 0.25)); // высокий «сверхострый» T
  }
  if (f.stDepression) {
    // субэндокардиальная ишемия: ST вниз в отведениях левого желудочка, в aVR чуть вверх — меньше 1 мм
    ist = add(ist, scale(norm(-0.75, -0.55, -0.35), 0.11));
    t = scale(t, 0.6);
  }
  if (f.tInversion) it = add(it, scale(WALL[f.tInversion], -0.55));
  if (f.pericarditis) ist = add(ist, scale(norm(0.6, 0.6, 0.35), 0.17));
  if (f.rvStrain) it = add(it, scale(norm(0.2, -0.7, -0.7), 0.3));
  return { st, t, injury: { st: ist, t: it } };
}

const P_RA: Vec = scale(norm(0.3, 0.85, 0.45), 0.12);
const P_LA: Vec = scale(norm(0.8, 0.4, -0.45), 0.1);

/** Время возбуждений: предсердий (P или волны трепетания) и желудочков — с видом комплекса и PR. */
function timeline(f: EcgFindings, seconds: number, rnd: () => number, pr0: number): { atria: number[]; beats: { qrs: number; p?: number; kind: QrsKind }[] } {
  const rhythm = f.rhythm ?? 'sinus';
  const conducted: QrsKind = f.bundle ?? 'normal';
  const atria: number[] = [];
  const beats: { qrs: number; p?: number; kind: QrsKind }[] = [];
  const start = -1.5; // с запасом до начала ленты: первый комплекс не обрезан
  if (rhythm === 'af') {
    const mean = 60 / (f.rate ?? 110);
    for (let t = start + rnd() * mean; t < seconds + 0.5; ) {
      beats.push({ qrs: t, kind: conducted });
      t += Math.max(0.32, mean * (0.55 + 0.9 * rnd()));
    }
    return { atria, beats };
  }
  if (rhythm === 'flutter') {
    // волны трепетания — 300 в минуту, к желудочкам проходит каждая вторая, третья или четвёртая
    const ratio = Math.min(4, Math.max(2, Math.round(300 / (f.rate ?? 150))));
    let k = 0;
    for (let t = start + rnd() * 0.2; t < seconds + 0.5; t += 0.2, k++) {
      atria.push(t);
      if (k % ratio === 0) beats.push({ qrs: t + 0.26, p: t, kind: conducted });
    }
    return { atria, beats };
  }
  if (rhythm === 'svt' || rhythm === 'vt') {
    const rr = 60 / (f.rate ?? (rhythm === 'svt' ? 180 : 170));
    for (let t = start + rnd() * rr; t < seconds + 0.5; t += rr * (0.995 + 0.01 * rnd())) beats.push({ qrs: t, kind: rhythm === 'vt' ? 'ventricular' : conducted });
    // при желудочковой тахикардии предсердия бьются сами по себе — атриовентрикулярная диссоциация
    if (rhythm === 'vt') for (let t = start + rnd() * 0.8; t < seconds + 0.5; t += 0.8 * (0.98 + 0.04 * rnd())) atria.push(t);
    return { atria, beats };
  }
  if (rhythm === 'avb3') {
    // предсердия и желудочки — каждые в своём ритме: выскальзывающий ритм редкий и широкий
    for (let t = start + rnd() * 0.75; t < seconds + 0.5; t += 0.75 * (0.98 + 0.04 * rnd())) atria.push(t);
    const rr = 60 / (f.rate ?? 38);
    for (let t = start + rnd() * rr; t < seconds + 0.5; t += rr * (0.99 + 0.02 * rnd())) beats.push({ qrs: t, kind: 'ventricular' });
    return { atria, beats };
  }
  // синусовый узел и проведение через АВ-узел
  const rr = 60 / (f.rate ?? 72);
  let k = 0;
  for (let t = start + rnd() * rr; t < seconds + 0.5; t += rr * (0.98 + 0.04 * rnd()), k++) {
    atria.push(t);
    if (rhythm === 'avb1') beats.push({ qrs: t + 0.28, p: t, kind: conducted });
    else if (rhythm === 'avb2w') {
      // Венкебах 4 : 3 — PR удлиняется, пока один P не проведётся
      const step = k % 4;
      if (step < 3) beats.push({ qrs: t + [0.2, 0.3, 0.36][step], p: t, kind: conducted });
    } else if (rhythm === 'avb2m') {
      // Мобитц II 3 : 2 — PR постоянный, каждый третий P без комплекса
      if (k % 3 !== 2) beats.push({ qrs: t + 0.18, p: t, kind: conducted });
    } else beats.push({ qrs: t + pr0, p: t, kind: conducted });
  }
  return { atria, beats };
}

/** Синтез двенадцати отведений. То же зерно и те же находки — та же лента. */
export function synthEcg12(f: EcgFindings, seed: number, seconds = 10): EcgTrace {
  const rng = Rng.seeded(seed).fork('ecg12');
  const rnd = () => rng.u32() / 4294967296;
  const n = Math.round(seconds * ECG_HZ);
  const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
  // у каждого своё сердце: ось чуть повёрнута, комплексы чуть выше или ниже
  const turn = ((rnd() - 0.5) * 24 * Math.PI) / 180;
  const roll = ((rnd() - 0.5) * 20 * Math.PI) / 180;
  const amp = (0.88 + 0.24 * rnd()) * (f.lowVoltage ? 0.35 : 1);
  const pr0 = 0.14 + 0.04 * rnd();
  const rotate = (v: Vec): Vec => {
    // поворот во фронтальной плоскости (x, y), затем в поперечной (x, z)
    const x1 = v[0] * Math.cos(turn) - v[1] * Math.sin(turn);
    const y1 = v[0] * Math.sin(turn) + v[1] * Math.cos(turn);
    return [x1 * Math.cos(roll) - v[2] * Math.sin(roll), y1, x1 * Math.sin(roll) + v[2] * Math.cos(roll)];
  };
  /** `turned` — повернуть вместе с осью сердца; ток повреждения — нет (см. `repolarization`). */
  const put = (b: Bump, at: number, k = 1, turned = true) => {
    if (b.v[0] === 0 && b.v[1] === 0 && b.v[2] === 0) return;
    const v = turned ? rotate(scale(b.v, amp * k)) : scale(b.v, amp * k);
    const sl = b.s, sr = b.sRight ?? b.s;
    const c = at + b.t;
    const from = Math.max(0, Math.floor((c - 4 * sl) * ECG_HZ));
    const to = Math.min(n - 1, Math.ceil((c + 4 * sr) * ECG_HZ));
    for (let i = from; i <= to; i++) {
      const d = i / ECG_HZ - c;
      const g = Math.exp(-0.5 * (d / (d < 0 ? sl : sr)) ** 2);
      X[i] += v[0] * g;
      Y[i] += v[1] * g;
      Z[i] += v[2] * g;
    }
  };
  /** Плато с мягкими краями — сегмент ST или PQ. */
  const plateau = (vec: Vec, from: number, to: number, ramp = 0.03, turned = true) => {
    if (vec[0] === 0 && vec[1] === 0 && vec[2] === 0) return;
    const v = turned ? rotate(scale(vec, amp)) : scale(vec, amp);
    const i0 = Math.max(0, Math.floor((from - ramp) * ECG_HZ));
    const i1 = Math.min(n - 1, Math.ceil((to + ramp) * ECG_HZ));
    for (let i = i0; i <= i1; i++) {
      const t = i / ECG_HZ;
      const w = Math.min(1, Math.max(0, (t - (from - ramp)) / ramp)) * Math.min(1, Math.max(0, (to + ramp - t) / ramp));
      X[i] += v[0] * w;
      Y[i] += v[1] * w;
      Z[i] += v[2] * w;
    }
  };

  const { atria, beats: plan } = timeline(f, seconds, rnd, pr0);
  const rhythm = f.rhythm ?? 'sinus';
  // зубцы P: у синусового узла и при блокадах, и сами по себе при желудочковой тахикардии
  if (rhythm !== 'af' && rhythm !== 'flutter' && rhythm !== 'svt') {
    for (const p of atria) {
      put({ t: 0.035, s: 0.017, v: P_RA }, p);
      put({ t: 0.065, s: 0.018, v: P_LA }, p);
      // перикардит: ток повреждения предсердий опускает сегмент PQ; как и ток желудочков, не поворачивается
      if (f.pericarditis) plateau(scale(norm(0.55, 0.8, 0.2), -0.05), p + 0.11, p + pr0 - 0.01, 0.015, false);
    }
  }
  const beats: EcgBeat[] = [];
  plan.forEach((b, k) => {
    const next = plan[k + 1]?.qrs ?? b.qrs + (plan[k]?.qrs - (plan[k - 1]?.qrs ?? b.qrs - 0.8));
    const rr = Math.min(1.6, Math.max(0.3, next - b.qrs));
    const { bumps, width } = qrsBumps(b.kind, f);
    // чередование высоты комплексов при выпоте в перикарде
    const alt = f.lowVoltage ? (k % 2 === 0 ? 1.25 : 0.75) : 1;
    for (const x of bumps) put(x, b.qrs, alt);
    const j = b.qrs + width;
    const { st, t, injury } = repolarization(b.kind, f);
    // QT короче при частом ритме (по Базетту)
    const qt = 0.4 * Math.sqrt(rr) + (width - 0.09);
    const tPeak = b.qrs + qt - 0.08;
    plateau(st, j + 0.02, tPeak, 0.03);
    plateau(injury.st, j + 0.02, tPeak, 0.03, false);
    const tWave = { t: 0, s: 0.05 * Math.sqrt(rr), sRight: 0.034 * Math.sqrt(rr) };
    put({ ...tWave, v: t }, tPeak);
    put({ ...tWave, v: injury.t }, tPeak, 1, false);
    // ретроградный P после комплекса при наджелудочковой тахикардии — «псевдо-r'» в V1
    if (rhythm === 'svt') put({ t: 0.07, s: 0.012, v: scale(norm(-0.1, -0.9, 0.4), 0.06) }, b.qrs);
    if (b.qrs + width > 0 && b.qrs < seconds) beats.push({ qrs: b.qrs, j, ...(b.p !== undefined ? { p: b.p } : {}), kind: b.kind });
  });

  // волны f при фибрилляции и пила трепетания — у предсердий
  if (rhythm === 'af') {
    const dir = rotate(scale(norm(0.2, 0.6, 0.8), 0.06 * amp));
    const ph = [rnd(), rnd(), rnd()].map(p => p * 2 * Math.PI);
    for (let i = 0; i < n; i++) {
      const t = i / ECG_HZ;
      const s = Math.sin(2 * Math.PI * 5.3 * t + ph[0]) + 0.7 * Math.sin(2 * Math.PI * 6.7 * t + ph[1]) + 0.5 * Math.sin(2 * Math.PI * 8.1 * t + ph[2]);
      X[i] += dir[0] * s;
      Y[i] += dir[1] * s;
      Z[i] += dir[2] * s;
    }
  }
  if (rhythm === 'flutter') {
    // медленный спуск и быстрый подъём: в II, III, aVF — «пила» зубьями вниз, в V1 — вверх
    const dir = rotate(scale(norm(0.1, 0.95, -0.3), 0.24 * amp));
    const t0 = atria[0] ?? 0;
    for (let i = 0; i < n; i++) {
      const ph = (((i / ECG_HZ - t0) % 0.2) + 0.2) % 0.2 / 0.2;
      const s = ph < 0.75 ? 1 - (2 * ph) / 0.75 : -1 + (2 * (ph - 0.75)) / 0.25;
      X[i] += dir[0] * s;
      Y[i] += dir[1] * s;
      Z[i] += dir[2] * s;
    }
  }

  const leads = {} as Record<Lead, Float32Array>;
  for (const lead of LEADS) {
    const { axis, gain } = LEAD_AXES[lead];
    const out = new Float32Array(n);
    // дрейф изолинии и шум — у каждого отведения свои
    const drift = rnd() * 2 * Math.PI;
    const wander = 0.02 + 0.015 * rnd();
    for (let i = 0; i < n; i++) {
      const t = i / ECG_HZ;
      out[i] = gain * dot([X[i], Y[i], Z[i]], axis) + wander * Math.sin(2 * Math.PI * 0.28 * t + drift) + 0.008 * (rnd() * 2 - 1);
    }
    leads[lead] = out;
  }
  return { seconds, leads, beats, atria: atria.filter(t => t >= 0 && t < seconds) };
}
