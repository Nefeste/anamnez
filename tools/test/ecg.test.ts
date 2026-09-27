// Синтез ЭКГ (06-architecture.md §11): ритм похож на правду и детерминирован.
import { describe, expect, test } from 'bun:test';
import { synthEcg } from '../../src/render/ecgSignal';

const cv = (xs: number[]) => {
  const d = xs.slice(1).map((x, i) => x - xs[i]);
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  return Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length) / m;
};

describe('ЭКГ', () => {
  test('синусовый ритм 72: около двенадцати комплексов за 10 с, интервалы почти равны', () => {
    const { beats, mv } = synthEcg({ rhythm: 'sinus', rate: 72, seconds: 10, seed: 1 });
    expect(beats.length).toBeGreaterThanOrEqual(11);
    expect(beats.length).toBeLessThanOrEqual(13);
    expect(cv(beats)).toBeLessThan(0.04);
    expect(Math.max(...mv)).toBeGreaterThan(1);
  });

  test('фибрилляция предсердий: интервалы неравные', () => {
    const { beats } = synthEcg({ rhythm: 'af', rate: 110, seconds: 10, seed: 1 });
    expect(beats.length).toBeGreaterThan(12);
    expect(cv(beats)).toBeGreaterThan(0.15);
  });

  test('подъём ST виден на ленте: сегмент после комплекса выше изолинии; депрессия — ниже', () => {
    const spec = { rhythm: 'sinus' as const, rate: 75, seconds: 6, seed: 3 };
    const segment = (mv: Float32Array, beats: number[]) => {
      let sum = 0, k = 0;
      for (const r of beats) {
        for (let i = Math.round((r + 0.08) * 250); i < Math.round((r + 0.18) * 250) && i < mv.length; i++) { sum += mv[i]; k++; }
      }
      return sum / k;
    };
    const base = synthEcg(spec);
    const up = synthEcg({ ...spec, st: 0.25 });
    const down = synthEcg({ ...spec, st: -0.15 });
    expect(segment(up.mv, up.beats) - segment(base.mv, base.beats)).toBeGreaterThan(0.2);
    expect(segment(down.mv, down.beats) - segment(base.mv, base.beats)).toBeLessThan(-0.12);
    // гипертрофия — зубец R выше
    expect(Math.max(...synthEcg({ ...spec, rScale: 1.5 }).mv)).toBeGreaterThan(Math.max(...base.mv) * 1.3);
  });

  test('одно зерно — одна лента', () => {
    const a = synthEcg({ rhythm: 'af', rate: 90, seconds: 4, seed: 5 }).mv;
    const b = synthEcg({ rhythm: 'af', rate: 90, seconds: 4, seed: 5 }).mv;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
