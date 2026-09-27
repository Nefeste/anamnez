// Карта амбулатории (src/engine/hospital/clinic.ts, src/state/clinicMap.ts): план проходим —
// до каждого места можно дойти от входа; пациент идёт по смене так, как по ней движется
// приём: регистратура → медсестра → зал → кабинет → рентген → скамья → выход.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { clinicLayout } from '../../src/engine/hospital/clinic';
import { walkable } from '../../src/engine/hospital/grid';
import { apply, newShift } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { findPath } from '../../src/engine/sim/path';
import { SPEED, Walkers } from '../../src/render/map/walkers';
import { assignSeats, LEAVING, nearest, type Placement, placements, REGISTRATION, TRIAGE, type Where } from '../../src/state/clinicMap';

const layout = clinicLayout();

describe('амбулатория: план', () => {
  test('все помещения среза на месте', () => {
    expect(layout.rooms.map(r => r.type).sort()).toEqual(['ecg', 'lab', 'office', 'procedure', 'reception', 'toilet', 'triage', 'waiting', 'xray']);
  });

  test('до каждого места — от входа: персонал, пациенты, стулья, скамьи', () => {
    const cells = [
      ...layout.staff.map(s => s.cell),
      ...Object.values(layout.spots),
      ...layout.seats,
      ...layout.benches,
    ];
    for (const c of cells) {
      expect({ c, walkable: walkable(layout.grid, c[0], c[1]) }).toEqual({ c, walkable: true });
      expect({ c, path: findPath(layout.grid, layout.entrance, c) !== null }).toEqual({ c, path: true });
    }
  });

  test('стульев хватает на очередь, места не повторяются', () => {
    expect(layout.seats.length).toBeGreaterThanOrEqual(16);
    const keys = [...layout.seats, ...layout.benches].map(([x, y]) => `${x},${y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/** Где пациент по карте: клетка, стул, скамья или нет его. */
function whereOf(s: ShiftState, id: string): Where | 'gone' {
  const p = placements(db, layout, s).find(x => x.id === id);
  return p ? p.where : 'gone';
}

describe('амбулатория: кто где', () => {
  test('персонал — на своих местах всегда', () => {
    const s = newShift(db, { seed: 3, season: 'winter' });
    const staff = placements(db, layout, s).filter(p => p.id.startsWith('staff.'));
    expect(staff.map(p => p.id).sort()).toEqual(layout.staff.map(x => `staff.${x.role}`).sort());
  });

  test('пришедший: регистратура → медсестра → стул в зале; ещё не пришедших нет', () => {
    const s = newShift(db, { seed: 3, season: 'winter' });
    expect(placements(db, layout, s).filter(p => !p.id.startsWith('staff.'))).toEqual([]);
    // до первого пришедшего
    for (let i = 0; i < 300 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const id = s.queue[0];
    const p = s.patients[id];
    apply(db, s, { kind: 'advance', seconds: Math.max(0, p.arriveT - s.t) });
    expect(whereOf(s, id)).toEqual({ cell: layout.spots.registration });
    apply(db, s, { kind: 'advance', seconds: REGISTRATION });
    expect(whereOf(s, id)).toEqual({ cell: layout.spots.triage });
    apply(db, s, { kind: 'advance', seconds: TRIAGE });
    expect(whereOf(s, id)).toEqual({ seat: true });
    expect(placements(db, layout, s).find(x => x.id === id)!.callable).toBe(true);
  });

  test('пока в кабинете кто-то есть, ждущего в зале касанием не вызвать — как и из очереди', () => {
    const s = newShift(db, { seed: 5, season: 'winter' });
    for (let i = 0; i < 600 && s.queue.length < 2; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const [first, second] = s.queue;
    apply(db, s, { kind: 'advance', seconds: REGISTRATION + TRIAGE });
    expect(placements(db, layout, s).find(x => x.id === second)).toMatchObject({ where: { seat: true }, callable: true });
    apply(db, s, { kind: 'call', id: first });
    expect(placements(db, layout, s).find(x => x.id === second)).toMatchObject({ where: { seat: true }, callable: false });
  });

  test('вызвали — в кабинет; рентген — ждёт на скамье, снимается в кабинете рентгена; принят — к выходу и нет его', () => {
    const s = newShift(db, { seed: 5, season: 'winter' });
    for (let i = 0; i < 300 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const id = s.queue[0];
    apply(db, s, { kind: 'call', id });
    expect(whereOf(s, id)).toEqual({ cell: layout.spots.office });

    apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
    apply(db, s, { kind: 'sendAway' });
    expect(s.patients[id].status).toBe('away');
    const e = db.exams['exam.xray_chest'];
    const startOf = (pid: string) => s.patients[pid].pending.find(r => r.exam === 'exam.xray_chest')!.readyAt - (e.time.procedure + (e.time.report ?? 0)) * 60;
    const x = s.patients[id].pending.find(r => r.exam === 'exam.xray_chest')!;
    // кабинет свободен — снимок сразу: у аппарата на время процедуры
    const start = startOf(id);
    expect(s.t).toBeGreaterThanOrEqual(start);
    expect(whereOf(s, id)).toEqual({ cell: layout.spots.xray });

    // второму рентген, пока аппарат занят: ждёт на скамье, потом — к аппарату
    for (let i = 0; i < 300 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const second = s.queue[0];
    apply(db, s, { kind: 'call', id: second });
    apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
    apply(db, s, { kind: 'sendAway' });
    const start2 = startOf(second);
    if (start2 > s.t) {
      expect(whereOf(s, second)).toEqual({ bench: true });
      apply(db, s, { kind: 'advance', seconds: start2 - s.t });
    }
    expect(whereOf(s, second)).toEqual({ cell: layout.spots.xray });

    // первый после снимка — на скамье, ждёт описания
    expect(whereOf(s, id)).toEqual({ bench: true });

    // результаты готовы — снова в очереди, уже без регистратуры: сразу на стул
    apply(db, s, { kind: 'advance', seconds: x.readyAt - s.t });
    expect(s.patients[id].status).toBe('waiting');
    expect(whereOf(s, id)).toEqual({ seat: true });

    apply(db, s, { kind: 'call', id });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'toggleTreatment', id: 'tx.rest_fluids' });
    apply(db, s, { kind: 'finish' });
    expect(placements(db, layout, s).find(p => p.id === id)).toMatchObject({ where: { cell: layout.entrance }, leaving: true });
    apply(db, s, { kind: 'advance', seconds: LEAVING });
    expect(whereOf(s, id)).toBe('gone');
  });
});

describe('амбулатория: места и касание', () => {
  test('кто сел — сидит; новым — первые свободные; мест нет — -1', () => {
    const a = assignSeats(new Map(), ['p1', 'p2', 'p3'], 3);
    expect([...a]).toEqual([['p1', 0], ['p2', 1], ['p3', 2]]);
    // p1 ушёл к врачу, пришёл p4: p2 и p3 не пересаживаются, p4 — на место p1
    const b = assignSeats(a, ['p2', 'p3', 'p4'], 3);
    expect([...b].sort()).toEqual([['p2', 1], ['p3', 2], ['p4', 0]]);
    expect(assignSeats(b, ['p2', 'p3', 'p4', 'p5'], 3).get('p5')).toBe(-1);
  });

  test('касание — ближайший, не дальше клетки', () => {
    const pts = [{ id: 'a', x: 2, y: 12 }, { id: 'b', x: 3, y: 12 }];
    expect(nearest(pts, 2.2, 12.1)).toBe('a');
    expect(nearest(pts, 2.8, 12)).toBe('b');
    expect(nearest(pts, 6, 6)).toBeUndefined();
  });
});

describe('амбулатория: люди идут', () => {
  const at = (cell: [number, number]) => ({ cell });
  const patient = (id: string, where: Placement['where'], extra: Partial<Placement> = {}): Placement => ({ id, figure: 'patient', where, ...extra });

  test('при открытии все уже на местах; новый входит с улицы и доходит', () => {
    const w = new Walkers(layout, 48);
    w.sync([patient('p1', { seat: true }, { callable: true })], 0);
    expect(w.where('p1', 0)).toEqual(layout.seats[0]);
    w.sync([patient('p1', { seat: true }, { callable: true }), patient('p2', at(layout.spots.registration))], 10);
    expect(w.where('p2', 10)).toEqual(layout.entrance);
    const steps = findPath(layout.grid, layout.entrance, layout.spots.registration)!.length - 1;
    expect(w.where('p2', 10 + steps / SPEED)).toEqual(layout.spots.registration);
  });

  test('часы карты нужны, пока кто-то идёт; без перемен на UI-поток ничего не уходит', () => {
    const w = new Walkers(layout, 48);
    const seated = patient('p1', { seat: true }, { callable: true });
    expect(w.sync([seated], 0)).toMatchObject({ changed: true, until: 0 });
    const walking = patient('p2', at(layout.spots.registration));
    const steps = findPath(layout.grid, layout.entrance, layout.spots.registration)!.length - 1;
    expect(w.sync([seated, walking], 10)).toMatchObject({ changed: true, until: 10 + steps / SPEED });
    expect(w.sync([seated, walking], 11).changed).toBe(false);
    // срочность поменялась — другая фигурка
    expect(w.sync([seated, { ...walking, figure: 'patientRed' }], 12).changed).toBe(true);
  });

  test('новое место посреди пути — без скачка', () => {
    const w = new Walkers(layout, 48);
    w.sync([], 0);
    w.sync([patient('p1', at(layout.spots.registration))], 0);
    const mid = w.where('p1', 0.6)!;
    w.sync([patient('p1', at(layout.spots.triage))], 0.6);
    expect(w.where('p1', 0.6)).toEqual(mid);
    expect(w.where('p1', 100)).toEqual(layout.spots.triage);
  });

  test('дошёл до выхода — исчезает и больше не появляется', () => {
    const w = new Walkers(layout, 48);
    w.sync([patient('p1', at(layout.spots.office))], 0);
    w.sync([patient('p1', at(layout.entrance), { leaving: true })], 0);
    expect(w.where('p1', 1)).toBeDefined();
    const frame = w.sync([patient('p1', at(layout.entrance), { leaving: true })], 100);
    expect(w.where('p1', 100)).toBeUndefined();
    expect(frame.meta.every((v, i) => i % 3 !== 1 || v === 0)).toBe(true);
    w.sync([patient('p1', at(layout.entrance), { leaving: true })], 101);
    expect(w.where('p1', 101)).toBeUndefined();
  });

  test('касание находит только ждущих в зале', () => {
    const w = new Walkers(layout, 48);
    w.sync([patient('p1', { seat: true }, { callable: true }), patient('p2', at(layout.spots.office))], 0);
    const [sx, sy] = layout.seats[0];
    expect(w.hit(sx + 0.5, sy + 0.5, 0)).toBe('p1');
    const [ox, oy] = layout.spots.office;
    expect(w.hit(ox + 0.5, oy + 0.5, 0)).toBeUndefined();
  });
});
