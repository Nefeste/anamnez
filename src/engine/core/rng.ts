// Генератор случайности движка (ADR 0004): sfc32 с засевом splitmix32, как у «Вотчины» (v2).
//
// Всё случайное в игре берётся отсюда. Подсистемы получают свои ветви (`fork('patients')`):
// новый бросок в одной ветви не сдвигает случайность в другой, и золотые случаи не
// «плывут» от несвязанной правки. Вероятности — целые доли 1/10 000.
import { fnv1a } from './hash';

/** Версия генератора; хранится в состоянии партии рядом с зерном. */
export const RNG_VERSION = 1;

export type RngState = [number, number, number, number];

/** Вероятность в долях 1/10 000: 0 — никогда, 10 000 — всегда. */
export const P_ONE = 10000;

export class Rng {
  private s: Uint32Array;

  private constructor(state: RngState) {
    this.s = new Uint32Array(state);
  }

  /** Генератор из 32-битного зерна: зерно размазывается по 128 битам состояния. */
  static seeded(seed: number): Rng {
    let x = seed >>> 0;
    const mix = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    const r = new Rng([mix(), mix(), mix(), mix()]);
    for (let i = 0; i < 16; i++) r.u32();
    return r;
  }

  static fromState(state: RngState): Rng {
    return new Rng(state);
  }

  state(): RngState {
    return [this.s[0], this.s[1], this.s[2], this.s[3]];
  }

  /** Независимая ветвь по имени: зависит от текущего состояния и имени, но не сдвигает его. */
  fork(name: string): Rng {
    const [a, b, c, d] = this.state();
    let seed = fnv1a(name);
    seed = (seed ^ a) >>> 0;
    seed = Math.imul(seed ^ (b >>> 7), 0x9e3779b1) >>> 0;
    seed = (seed + c) >>> 0;
    seed = Math.imul(seed ^ (d << 3), 0x85ebca6b) >>> 0;
    return Rng.seeded(seed);
  }

  /** Следующее беззнаковое 32-битное число. */
  u32(): number {
    const s = this.s;
    const t = (((s[0] + s[1]) >>> 0) + s[3]) >>> 0;
    s[3] = (s[3] + 1) >>> 0;
    s[0] = s[1] ^ (s[1] >>> 9);
    s[1] = (s[2] + (s[2] << 3)) >>> 0;
    s[2] = ((s[2] << 21) | (s[2] >>> 11)) >>> 0;
    s[2] = (s[2] + t) >>> 0;
    return t;
  }

  /**
   * Целое в [0, n). Произведение u32 · n < 2^53 и деление на степень двойки точны в
   * двойной точности, поэтому результат одинаков в любом движке JS.
   */
  int(n: number): number {
    if (n <= 0) return 0;
    return Math.floor((this.u32() * n) / 4294967296);
  }

  /** Целое в [lo, hi] включительно. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  /** Сбылось ли событие с вероятностью `p` (доли 1/10 000). */
  chance(p: number): boolean {
    return this.int(P_ONE) < p;
  }

  /** Выбор по целым весам; нулевые веса не выпадают никогда. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    let total = 0;
    for (const it of items) total += Math.max(0, Math.floor(weight(it)));
    if (total <= 0) throw new Error('Rng.weighted: all weights are zero');
    let roll = this.int(total);
    for (const it of items) {
      const w = Math.max(0, Math.floor(weight(it)));
      if (roll < w) return it;
      roll -= w;
    }
    return items[items.length - 1];
  }

  /** Выбор ключа словаря «значение → вес» в порядке ключей по алфавиту. */
  weightedKey(weights: Record<string, number>): string {
    const keys = Object.keys(weights).sort();
    return this.weighted(keys, k => weights[k]);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}
