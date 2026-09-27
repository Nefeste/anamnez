// Синтез ЭКГ кодом (ADR 0013, 06-architecture.md §11): ритм задаёт интервалы RR,
// морфология — сумма «горбов» P, Q, R, S, T. Отведение II, 250 отсчётов в секунду
// (отсчёт на миллиметр при 25 мм/с). Детерминирован по зерну.
import { Rng } from '../engine/core/rng';

export type Rhythm = 'sinus' | 'af';

export interface EcgSpec {
  rhythm: Rhythm;
  /** средняя частота, уд/мин */
  rate: number;
  seconds: number;
  seed: number;
  /** смещение сегмента ST, мВ: + подъём (инфаркт с подъёмом ST), − депрессия (ишемия) */
  st?: number;
  /** во сколько раз выше зубец R (гипертрофия левого желудочка) */
  rScale?: number;
}

export const ECG_HZ = 250;

interface Wave { at: number; amp: number; width: number }

/** Морфология одного комплекса в отведении II: время от вершины R, мВ, ширина (с). */
const SINUS_BEAT: Wave[] = [
  { at: -0.18, amp: 0.15, width: 0.025 }, // P
  { at: -0.035, amp: -0.1, width: 0.008 }, // Q
  { at: 0, amp: 1.2, width: 0.01 }, // R
  { at: 0.035, amp: -0.28, width: 0.01 }, // S
  { at: 0.3, amp: 0.3, width: 0.05 }, // T
];

export function synthEcg(spec: EcgSpec): { mv: Float32Array; beats: number[] } {
  const rng = Rng.seeded(spec.seed).fork(`ecg:${spec.rhythm}`);
  const n = Math.round(spec.seconds * ECG_HZ);
  const mv = new Float32Array(n);
  const mean = 60 / spec.rate;
  const rnd = () => rng.u32() / 4294967296;

  // Моменты вершин R.
  const beats: number[] = [];
  for (let t = 0.3 + rnd() * mean; t < spec.seconds; ) {
    beats.push(t);
    // синусовый — почти ровно; фибрилляция — «абсолютно неритмично»
    t += spec.rhythm === 'sinus' ? mean * (0.97 + 0.06 * rnd()) : mean * (0.55 + 0.9 * rnd());
  }
  const rScale = spec.rScale ?? 1;
  const waves = (spec.rhythm === 'af' ? SINUS_BEAT.slice(1) : SINUS_BEAT) // при ФП зубца P нет
    .map(w => (w.at === 0 ? { ...w, amp: w.amp * rScale } : w));
  const st = spec.st ?? 0;
  for (const r of beats) {
    for (const w of waves) {
      const c = r + w.at;
      const from = Math.max(0, Math.floor((c - 4 * w.width) * ECG_HZ));
      const to = Math.min(n - 1, Math.ceil((c + 4 * w.width) * ECG_HZ));
      for (let i = from; i <= to; i++) {
        const d = (i / ECG_HZ - c) / w.width;
        mv[i] += w.amp * Math.exp(-0.5 * d * d);
      }
    }
    // сегмент ST — от точки J после S до конца T: плато с мягкими краями; при подъёме
    // он сливается с зубцом T, как на настоящей ленте
    if (st !== 0) {
      const j = r + 0.05;
      const end = r + 0.34;
      const ramp = 0.03;
      const from = Math.max(0, Math.floor((j - ramp) * ECG_HZ));
      const to = Math.min(n - 1, Math.ceil((end + ramp) * ECG_HZ));
      for (let i = from; i <= to; i++) {
        const t = i / ECG_HZ;
        const up = Math.min(1, Math.max(0, (t - (j - ramp)) / ramp));
        const down = Math.min(1, Math.max(0, (end + ramp - t) / ramp));
        mv[i] += st * up * down;
      }
    }
  }
  // Волны f при фибрилляции, дрейф изолинии и шум — у любой настоящей ленты.
  const phases = [rnd(), rnd(), rnd()].map(p => p * 2 * Math.PI);
  const drift = rnd() * 2 * Math.PI;
  for (let i = 0; i < n; i++) {
    const t = i / ECG_HZ;
    if (spec.rhythm === 'af') mv[i] += 0.05 * Math.sin(2 * Math.PI * 5.3 * t + phases[0]) + 0.035 * Math.sin(2 * Math.PI * 6.7 * t + phases[1]) + 0.025 * Math.sin(2 * Math.PI * 8.1 * t + phases[2]);
    mv[i] += 0.03 * Math.sin(2 * Math.PI * 0.3 * t + drift) + 0.008 * (rnd() * 2 - 1);
  }
  return { mv, beats };
}
