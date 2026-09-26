// Сетка, пути и больница прототипа П2 (ADR 0014).
import { describe, expect, test } from 'bun:test';
import { CELL, type Grid, spikeHospital } from '../../src/engine/hospital/grid';
import { findPath } from '../../src/engine/sim/path';

const grid = (rows: string[]): Grid => {
  const h = rows.length, w = rows[0].length;
  const cells = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((ch, x) => (cells[y * w + x] = ch === '#' ? CELL.wall : ch === 'D' ? CELL.door : ch === ' ' ? CELL.outside : CELL.floor)));
  return { w, h, cells };
};

describe('пути', () => {
  test('кратчайший путь обходит стену через дверь', () => {
    const g = grid([
      '.....',
      '###D#',
      '.....',
    ]);
    const p = findPath(g, [0, 0], [0, 2])!;
    expect(p[0]).toEqual([0, 0]);
    expect(p[p.length - 1]).toEqual([0, 2]);
    expect(p.length - 1).toBe(8); // 3 вправо, 2 вниз через дверь, 3 влево
    expect(p.some(([x, y]) => x === 3 && y === 1)).toBe(true);
    for (let i = 1; i < p.length; i++) expect(Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1])).toBe(1);
  });

  test('недостижимое — null, а не путь сквозь стену', () => {
    const g = grid(['..#..', '..#..']);
    expect(findPath(g, [0, 0], [4, 1])).toBeNull();
    expect(findPath(g, [0, 0], [2, 0])).toBeNull();
  });
});

describe('больница прототипа', () => {
  const { grid: g, rooms, objects } = spikeHospital(1);

  test('18 помещений и около шестисот предметов', () => {
    expect(rooms.length).toBe(18);
    expect(objects.length).toBeGreaterThan(550);
    expect(objects.length).toBeLessThan(800);
  });

  test('из каждого помещения можно дойти до любого другого', () => {
    const inside = (i: number): [number, number] => [rooms[i].door[0], rooms[i].door[1] + (rooms[i].door[1] === rooms[i].y ? 1 : -1)];
    for (let i = 1; i < rooms.length; i++) expect(findPath(g, inside(0), inside(i))).not.toBeNull();
  });

  test('детерминирована по зерну', () => {
    expect(spikeHospital(1).objects).toEqual(objects);
    expect(spikeHospital(2).objects).not.toEqual(objects);
  });
});
