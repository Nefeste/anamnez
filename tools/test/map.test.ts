// Рисунок плана (spec 2026-09-living-map, часть 22): куда повёрнуты предметы и люди.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { clinicLayout } from '../../src/engine/hospital/clinic';
import { CELL, type Grid, type ObjectKind } from '../../src/engine/hospital/grid';
import { angleOf, headingOf, objectTurns, restHeading } from '../../src/render/map/orient';

/** Помещение w × h: стены по краю, пол внутри. */
function room(w: number, h: number): Grid {
  const cells = new Uint8Array(w * h).fill(CELL.floor);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) cells[y * w + x] = CELL.wall;
  return { w, h, cells };
}

const obj = (kind: ObjectKind, x: number, y: number) => ({ kind, x, y });
/** Угол в [0, 2π): -π/2 и 3π/2 — одно и то же. */
const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

describe('план: куда повёрнуты предметы', () => {
  test('кабинет: стулья — к столу, стол — к врачу, шкаф и раковина — спиной к стене', () => {
    const g = room(8, 7);
    const objects = [obj('desk', 3, 3), obj('chair', 3, 2), obj('chair', 3, 4), obj('cabinet', 1, 3), obj('sink', 6, 4), obj('plant', 3, 1)];
    const t = objectTurns(g, objects, [[3, 2]]);
    // стол лицом на север, к врачу; стул врача — лицом на юг, стул пациента — на север
    expect(t.slice(0, 3)).toEqual([2, 0, 2]);
    // шкаф у западной стены — спиной к западу, раковина у восточной — к востоку, растение у северной
    expect(t.slice(3)).toEqual([3, 1, 0]);
  });

  test('стол без врача — лицом к стулу рядом; предмет без стены рядом — как в шаблоне', () => {
    const g = room(8, 7);
    expect(objectTurns(g, [obj('desk', 3, 2), obj('chair', 3, 3), obj('cabinet', 3, 4)])).toEqual([0, 2, 0]);
  });

  test('зал ожидания: два ряда стульев смотрят друг на друга, ряд вдоль стены — от стены', () => {
    const g = room(9, 7);
    const front = [2, 3, 4, 5, 6].map(x => obj('chair', x, 2));
    const back = [2, 3, 4, 5, 6].map(x => obj('chair', x, 4));
    const t = objectTurns(g, [...front, ...back]);
    expect(t.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(t.slice(5)).toEqual([2, 2, 2, 2, 2]);
    // столбец стульев у западной стены — лицом на восток
    const column = [2, 3, 4].map(y => obj('chair', 1, y));
    expect(objectTurns(g, column)).toEqual([3, 3, 3]);
  });

  test('амбулатория практики: каждый стул у стола повёрнут к столу', () => {
    const layout = clinicLayout(db);
    const turns = objectTurns(layout.grid, layout.objects, layout.staff.map(s => s.cell));
    const desks = layout.objects.filter(o => o.kind === 'desk' || o.kind === 'table');
    let checked = 0;
    layout.objects.forEach((o, i) => {
      if (o.kind !== 'chair') return;
      const desk = desks.find(d => Math.abs(d.x - o.x) + Math.abs(d.y - o.y) === 1);
      if (!desk) return;
      // лицо рисунка — на юг; повёрнутое лицо должно смотреть на стол
      const a = angleOf(turns[i]);
      expect({ chair: [o.x, o.y], to: [Math.round(-Math.sin(a)) + 0, Math.round(Math.cos(a)) + 0] }).toEqual({ chair: [o.x, o.y], to: [desk.x - o.x, desk.y - o.y] });
      checked++;
    });
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

describe('план: куда смотрят люди', () => {
  test('идущий повёрнут по ходу: рисунок — лицом на юг', () => {
    expect(norm(headingOf(0, 1))).toBeCloseTo(0);
    expect(norm(headingOf(-1, 0))).toBeCloseTo(Math.PI / 2);
    expect(norm(headingOf(0, -1))).toBeCloseTo(Math.PI);
    expect(norm(headingOf(1, 0))).toBeCloseTo((3 * Math.PI) / 2);
  });

  test('сидящий — как стул; стоящий у стола — к столу; в пустом месте — как шёл', () => {
    const g = room(8, 7);
    const objects = [obj('desk', 3, 3), obj('chair', 3, 2), obj('ecg', 1, 5)];
    const turns = objectTurns(g, objects, [[3, 2]]);
    expect(restHeading(objects, turns, [3, 2])).toBeCloseTo(0);
    // справа от стола — лицом на запад
    expect(norm(restHeading(objects, turns, [4, 3])!)).toBeCloseTo(Math.PI / 2);
    // у аппарата — к аппарату: он западнее
    expect(norm(restHeading(objects, turns, [2, 5])!)).toBeCloseTo(Math.PI / 2);
    expect(restHeading(objects, turns, [6, 1])).toBeUndefined();
  });

  test('стол важнее аппарата: стоящий между ними — к столу', () => {
    const g = room(8, 7);
    const objects = [obj('analyzer', 2, 3), obj('table', 4, 3)];
    const turns = objectTurns(g, objects);
    // стол восточнее — лицом на восток
    expect(norm(restHeading(objects, turns, [3, 3])!)).toBeCloseTo((3 * Math.PI) / 2);
  });
});
