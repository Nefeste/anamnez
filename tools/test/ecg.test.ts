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

  test('одно зерно — одна лента', () => {
    const a = synthEcg({ rhythm: 'af', rate: 90, seconds: 4, seed: 5 }).mv;
    const b = synthEcg({ rhythm: 'af', rate: 90, seconds: 4, seed: 5 }).mv;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
