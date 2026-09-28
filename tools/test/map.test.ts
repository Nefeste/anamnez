// Рисунок плана (spec 2026-09-living-map): куда повёрнуты предметы и люди (часть 22) и что
// показывает помещение — свет аппарата, лампа над дверью, очередь (часть 23).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { clinicLayout } from '../../src/engine/hospital/clinic';
import { CELL, type Grid, type ObjectKind, type RoomType } from '../../src/engine/hospital/grid';
import { apply, newShift } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { angleOf, headingOf, objectTurns, restHeading } from '../../src/render/map/orient';
import { lampAt, objectRooms } from '../../src/render/map/signs';
import { DWELL, litAt, Walkers } from '../../src/render/map/walkers';
import { placements } from '../../src/state/clinicMap';
import { LAMP_ROOMS, roomSigns } from '../../src/state/roomSigns';

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

describe('план: знаки помещений (часть 23)', () => {
  const layout = clinicLayout(db);
  const indexOf = (type: string) => layout.rooms.findIndex(x => x.type === type);
  const signOf = (s: ShiftState, type: string, down?: ReadonlySet<string>) => roomSigns(layout, s, down)[indexOf(type)];
  const first = (s: ShiftState) => {
    for (let i = 0; i < 300 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    return s.queue[0];
  };

  test('очередь к вашему кабинету — ждущие вас; лампа — пока пациент на карте у вас в кабинете', () => {
    const s = newShift(db, { seed: 5, season: 'winter' });
    const id = first(s);
    const waiting = Object.values(s.patients).filter(p => p.status === 'waiting' && !p.by).length;
    expect(signOf(s, 'office').queue).toBe(waiting);
    const w = new Walkers(layout, 48);
    const office = indexOf('office');
    expect(litAt(w.sync(placements(db, layout, s), 0).lights, office, 0)).toBe(false);
    apply(db, s, { kind: 'call', id });
    expect(signOf(s, 'office').queue).toBe(waiting - 1);
    // позвали — идёт; лампа загорается, когда вошёл
    const f = w.sync(placements(db, layout, s), 10);
    const at = w.arrivalOf(id)!;
    expect(at).toBeGreaterThan(10);
    expect(litAt(f.lights, office, at - 0.05)).toBe(false);
    expect(litAt(f.lights, office, at)).toBe(true);
    expect(litAt(f.lights, office, at + 600)).toBe(true);
    // ушёл из кабинета — погасла
    apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
    apply(db, s, { kind: 'sendAway' });
    const g = w.sync(placements(db, layout, s), at + 5);
    expect(litAt(g.lights, office, at + 5)).toBe(false);
    // регистратура и зал ожидания — без лампы и без очереди
    expect(signOf(s, 'waiting')).toMatchObject({ lit: false, queue: 0 });
  });

  test('к рентгену очередь — кто ждёт его на скамье', () => {
    const s = newShift(db, { seed: 5, season: 'winter' });
    for (let i = 0; i < 600 && s.queue.length < 2; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const [a, b] = s.queue;
    for (const id of [a, b]) {
      apply(db, s, { kind: 'call', id });
      apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
      apply(db, s, { kind: 'sendAway' });
    }
    // первого снимают, второй ждёт аппарат на скамье
    const xb = s.patients[b].pending.find(r => r.exam === 'exam.xray_chest')!;
    expect(xb.start!).toBeGreaterThan(s.t);
    expect(signOf(s, 'xray').queue).toBe(1);
    apply(db, s, { kind: 'advance', seconds: xb.start! - s.t });
    expect(signOf(s, 'xray').queue).toBe(0);
  });

  test('рентген горит, пока пациент на карте у аппарата, — и на ×4, когда смена его обогнала', () => {
    const s = newShift(db, { seed: 5, season: 'winter' });
    const id = first(s);
    const w = new Walkers(layout, 48);
    w.sync(placements(db, layout, s), 0);
    apply(db, s, { kind: 'call', id });
    apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
    apply(db, s, { kind: 'sendAway' });
    const x = s.patients[id].pending.find(r => r.exam === 'exam.xray_chest')!;
    expect(x.start!).toBeLessThanOrEqual(s.t);
    const xray = indexOf('xray');
    const f = w.sync(placements(db, layout, s), 1);
    // дошёл до аппарата — за стоянку до конца пути
    const came = w.arrivalOf(id)! - DWELL.exam!;
    expect(came).toBeGreaterThan(1);
    expect(litAt(f.lights, xray, came - 0.05)).toBe(false);
    expect(litAt(f.lights, xray, came)).toBe(true);
    // смена ушла вперёд, пока он шёл: снимок кончился — он всё равно доходит и стоит у аппарата
    apply(db, s, { kind: 'advance', seconds: x.end! - s.t });
    const g = w.sync(placements(db, layout, s), 1.1);
    expect(litAt(g.lights, xray, came - 0.05)).toBe(false);
    expect(litAt(g.lights, xray, came + 0.05)).toBe(true);
    expect(litAt(g.lights, xray, came + DWELL.exam! - 0.05)).toBe(true);
    expect(litAt(g.lights, xray, came + DWELL.exam! + 0.05)).toBe(false);
  });

  test('лаборатория светится, пока анализ крови не готов', () => {
    const s = newShift(db, { seed: 5, season: 'winter' });
    const id = first(s);
    apply(db, s, { kind: 'call', id });
    apply(db, s, { kind: 'exam', exam: 'exam.cbc' });
    apply(db, s, { kind: 'sendAway' });
    const x = s.patients[id].pending.find(r => r.exam === 'exam.cbc')!;
    // кровь уже взята, анализ ещё идёт
    expect(x.end!).toBeLessThanOrEqual(s.t);
    expect(s.t).toBeLessThan(x.readyAt);
    expect(signOf(s, 'lab').lit).toBe(true);
    apply(db, s, { kind: 'advance', seconds: x.readyAt - s.t });
    expect(signOf(s, 'lab').lit).toBe(false);
  });

  test('«нет персонала» — только у помещений из списка неработающих', () => {
    const s = newShift(db, { seed: 5, season: 'winter' });
    const ecg = layout.rooms.find(r => r.type === 'ecg')!;
    expect(signOf(s, 'ecg', new Set([ecg.id])).noStaff).toBe(true);
    expect(signOf(s, 'xray', new Set([ecg.id])).noStaff).toBe(false);
    expect(roomSigns(layout, s).every(x => !x.noStaff)).toBe(true);
  });

  test('лампа — на стене у двери каждого кабинета с лампой; аппараты — в своих помещениях', () => {
    for (const r of layout.rooms) {
      const at = lampAt(layout.grid, r.door);
      if (!LAMP_ROOMS.has(r.type)) continue;
      expect(at).toBeDefined();
      const [x, y] = [Math.floor(at![0]), Math.floor(at![1])];
      expect(layout.grid.cells[y * layout.grid.w + x]).toBe(CELL.wall);
      expect(Math.abs(x - r.door[0]) + Math.abs(y - r.door[1])).toBe(1);
    }
    const owners = objectRooms(layout.rooms, layout.objects);
    const where: Record<string, RoomType> = { ecg: 'ecg', analyzer: 'lab', xray: 'xray' };
    layout.objects.forEach((o, i) => {
      if (where[o.kind]) expect(layout.rooms[owners[i]].type).toBe(where[o.kind]);
    });
    expect(layout.objects.some(o => o.kind === 'analyzer')).toBe(true);
  });
});
