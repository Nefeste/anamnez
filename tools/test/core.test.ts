// Ядро движка: генератор случайности, ветви, очередь событий (ADR 0004).
import { describe, expect, test } from 'bun:test';
import { EventQueue } from '../../src/engine/core/events';
import { fingerprint, fnv1a, stableJson } from '../../src/engine/core/hash';
import { Rng } from '../../src/engine/core/rng';

describe('генератор', () => {
  test('одно зерно — одна последовательность', () => {
    const a = Rng.seeded(42), b = Rng.seeded(42);
    const xs = Array.from({ length: 5 }, () => a.u32());
    expect(Array.from({ length: 5 }, () => b.u32())).toEqual(xs);
  });

  test('последовательность закреплена: смена алгоритма ломает сохранения и золотые случаи', () => {
    const r = Rng.seeded(20260926);
    expect(Array.from({ length: 4 }, () => r.u32())).toEqual(GOLDEN_U32);
  });

  test('ветвь не сдвигает родителя и не зависит от других ветвей', () => {
    const a = Rng.seeded(7), b = Rng.seeded(7);
    a.fork('x').u32();
    a.fork('y').u32();
    expect(a.u32()).toBe(b.u32());
    expect(Rng.seeded(7).fork('patients').u32()).toBe(Rng.seeded(7).fork('patients').u32());
    expect(Rng.seeded(7).fork('patients').u32()).not.toBe(Rng.seeded(7).fork('exams').u32());
  });

  test('int в пределах и примерно равномерен', () => {
    const r = Rng.seeded(1);
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < 50_000; i++) counts[r.int(5)]++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(400);
  });

  test('chance(p) сбывается с частотой p/10 000', () => {
    const r = Rng.seeded(2);
    let hits = 0;
    for (let i = 0; i < 100_000; i++) if (r.chance(2500)) hits++;
    expect(Math.abs(hits - 25_000)).toBeLessThan(500);
  });

  test('состояние сохраняется и восстанавливается', () => {
    const a = Rng.seeded(99);
    a.u32();
    const b = Rng.fromState(a.state());
    expect(b.u32()).toBe(a.u32());
  });
});

describe('хеши', () => {
  test('FNV-1a: известное значение', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
  });

  test('отпечаток не зависит от порядка ключей', () => {
    expect(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(fingerprint({ x: 1, y: 2 })).toBe(fingerprint({ y: 2, x: 1 }));
  });
});

describe('очередь событий', () => {
  test('по времени, при равном — по порядку постановки', () => {
    const q = new EventQueue<string>();
    q.push(30, 'c');
    q.push(10, 'a');
    q.push(10, 'b');
    q.push(20, 'x');
    const out: string[] = [];
    for (let e = q.popDue(100); e; e = q.popDue(100)) out.push(e.event);
    expect(out).toEqual(['a', 'b', 'x', 'c']);
  });

  test('не отдаёт будущее и переживает сохранение', () => {
    const q = new EventQueue<number>();
    q.push(50, 1);
    q.push(5, 2);
    expect(q.popDue(4)).toBeUndefined();
    const saved = EventQueue.fromArray(q.toArray());
    expect(saved.popDue(10)?.event).toBe(2);
    saved.push(50, 3);
    expect([saved.popDue(60)?.event, saved.popDue(60)?.event]).toEqual([1, 3]);
  });
});

/** Первые четыре числа sfc32 для зерна 20260926 — записаны при создании генератора. */
const GOLDEN_U32 = [367110760, 1079980886, 1445132124, 3281330693];
