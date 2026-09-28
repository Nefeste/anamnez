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
import { BRISK, DWELL, SPEED, STRIDE, Walkers } from '../../src/render/map/walkers';
import { assignSeats, type Doing, LEAVING, nearest, type Placement, placements, REGISTRATION, TRIAGE, type Where } from '../../src/state/clinicMap';

const layout = clinicLayout(db);

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

  test('не дождался — идёт к выходу и исчезает', () => {
    const s = newShift(db, { seed: 3, season: 'winter' });
    let left: string | undefined;
    for (let i = 0; i < 600 && !left; i++) {
      apply(db, s, { kind: 'advance', seconds: 60 });
      left = Object.values(s.patients).find(p => p.status === 'left')?.id;
    }
    expect(left).toBeDefined();
    expect(placements(db, layout, s).find(p => p.id === left)).toMatchObject({ where: { cell: layout.entrance }, doing: { kind: 'left' }, leaving: true });
    apply(db, s, { kind: 'advance', seconds: LEAVING });
    expect(whereOf(s, left!)).toBe('gone');
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
    const doingOf = (pid: string) => placements(db, layout, s).find(x => x.id === pid)!.doing;
    if (start2 > s.t) {
      expect(whereOf(s, second)).toEqual({ bench: true });
      expect(doingOf(second)).toEqual({ kind: 'examQueue', room: 'xray' });
      apply(db, s, { kind: 'advance', seconds: start2 - s.t });
    }
    expect(whereOf(s, second)).toEqual({ cell: layout.spots.xray });
    expect(doingOf(second)).toEqual({ kind: 'exam', room: 'xray' });

    // первый после снимка — на скамье, ждёт описания
    expect(whereOf(s, id)).toEqual({ bench: true });
    expect(doingOf(id)).toEqual({ kind: 'results', readyAt: x.readyAt });

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
  const { spots, seats, benches, entrance } = layout;
  const at = (cell: [number, number]) => ({ cell });
  const person = (id: string, where: Placement['where'], doing: Doing, extra: Partial<Placement> = {}): Placement => ({ id, figure: 'patient', where, doing, ...extra });
  const seat = (id: string) => person(id, { seat: true }, { kind: 'waiting' }, { callable: true });
  const bench = (id: string) => person(id, { bench: true }, { kind: 'results', readyAt: 0 });
  const registration = (id: string) => person(id, at(spots.registration), { kind: 'registration' });
  const triage = (id: string) => person(id, at(spots.triage), { kind: 'triage' });
  const office = (id: string) => person(id, at(spots.office), { kind: 'office' });
  const leaving = (id: string) => person(id, at(entrance), { kind: 'leaving' }, { leaving: true });
  const steps = (a: [number, number], b: [number, number]) => findPath(layout.grid, a, b)!.length - 1;
  /** Стоит ли человек в клетке `cell` в момент `t` (часы карты). */
  const isAt = (w: Walkers, id: string, t: number, cell: [number, number]) => {
    const p = w.where(id, t);
    return !!p && Math.abs(p[0] - cell[0]) < 1e-6 && Math.abs(p[1] - cell[1]) < 1e-6;
  };

  test('при открытии все уже на местах; новый входит с улицы, доходит до стойки и стоит у неё', () => {
    const w = new Walkers(layout, 48);
    w.sync([seat('p1')], 0);
    expect(isAt(w, 'p1', 0, seats[0])).toBe(true);
    w.sync([seat('p1'), registration('p2')], 10);
    expect(isAt(w, 'p2', 10, entrance)).toBe(true);
    const reached = 10 + steps(entrance, spots.registration) / SPEED;
    expect(isAt(w, 'p2', reached, spots.registration)).toBe(true);
    expect(w.arrivalOf('p2')).toBeCloseTo(reached + DWELL.registration!);
  });

  test('часы карты нужны, пока кто-то идёт; без перемен на UI-поток ничего не уходит', () => {
    const w = new Walkers(layout, 48);
    expect(w.sync([seat('p1')], 0)).toMatchObject({ changed: true, until: 0 });
    const frame = w.sync([seat('p1'), registration('p2')], 10);
    expect(frame.changed).toBe(true);
    expect(frame.until).toBeCloseTo(10 + steps(entrance, spots.registration) / SPEED + DWELL.registration!);
    expect(w.sync([seat('p1'), registration('p2')], 11).changed).toBe(false);
    // срочность поменялась — другая фигурка
    expect(w.sync([seat('p1'), { ...registration('p2'), figure: 'patientRed' }], 12).changed).toBe(true);
  });

  test('смена спешит, а человек доходит до стойки и до медсестры и стоит у них, потом садится', () => {
    const w = new Walkers(layout, 48);
    w.sync([], 0);
    w.sync([registration('p1')], 0);
    // на ×4 через полсекунды он по смене уже у медсестры, через полторы — в зале
    w.sync([triage('p1')], 0.5);
    w.sync([seat('p1')], 1.5);
    const atDesk = steps(entrance, spots.registration) / SPEED;
    expect(isAt(w, 'p1', atDesk, spots.registration)).toBe(true);
    expect(isAt(w, 'p1', atDesk + DWELL.registration! - 0.05, spots.registration)).toBe(true);
    const atNurse = atDesk + DWELL.registration! + steps(spots.registration, spots.triage) / SPEED;
    expect(isAt(w, 'p1', atNurse, spots.triage)).toBe(true);
    expect(isAt(w, 'p1', atNurse + DWELL.triage! - 0.05, spots.triage)).toBe(true);
    expect(isAt(w, 'p1', 100, seats[0])).toBe(true);
  });

  test('место ожидания, до которого не дошёл, заменяет следующее', () => {
    const w = new Walkers(layout, 48);
    // первые скамьи заняты: ему — скамья справа, в стороне от пути в зал
    const others = ['b1', 'b2', 'b3', 'b4'].map(bench);
    w.sync([...others, office('p1')], 0);
    w.sync([...others, bench('p1')], 0);
    // результаты готовы, пока он шёл к скамье: сразу в зал, без скамьи
    w.sync([...others, seat('p1')], 0.5);
    expect(w.arrivalOf('p1')!).toBeLessThan((steps(spots.office, benches[4]) + steps(benches[4], seats[0])) / SPEED);
    expect(isAt(w, 'p1', w.arrivalOf('p1')!, seats[0])).toBe(true);
  });

  test('приглашённый идёт в кабинет сразу и быстрее — даже от регистратуры', () => {
    const w = new Walkers(layout, 48);
    w.sync([seat('p1')], 0);
    w.sync([office('p1')], 5);
    expect(w.arrivalOf('p1')).toBeCloseTo(5 + steps(seats[0], spots.office) / BRISK);
    expect(isAt(w, 'p1', w.arrivalOf('p1')!, spots.office)).toBe(true);

    w.sync([office('p1'), registration('p2')], 10);
    w.sync([office('p1'), office('p2')], 10.5);
    // к стойке уже не идёт: от того места, где был, прямо в кабинет
    expect(w.arrivalOf('p2')!).toBeLessThan(10.5 + (steps(entrance, spots.office) + 1) / BRISK);
    expect(isAt(w, 'p2', w.arrivalOf('p2')!, spots.office)).toBe(true);
  });

  test('новое место посреди шага — без скачка и без шага назад', () => {
    const w = new Walkers(layout, 48);
    w.sync([], 0);
    w.sync([registration('p1')], 0);
    const mid = w.where('p1', 0.6)!;
    w.sync([office('p1')], 0.6);
    const now = w.where('p1', 0.6)!;
    expect(now[0]).toBeCloseTo(mid[0]);
    expect(now[1]).toBeCloseTo(mid[1]);
    // шагом позже он дальше от входа, а не ближе
    const later = w.where('p1', 0.6 + 0.05)!;
    const d = (p: [number, number]) => Math.abs(p[0] - entrance[0]) + Math.abs(p[1] - entrance[1]);
    expect(d(later)).toBeGreaterThan(d(now));
    expect(isAt(w, 'p1', 100, spots.office)).toBe(true);
  });

  test('дошёл до выхода — исчезает и больше не появляется', () => {
    const w = new Walkers(layout, 48);
    w.sync([office('p1')], 0);
    w.sync([leaving('p1')], 0);
    expect(w.where('p1', 1)).toBeDefined();
    const frame = w.sync([leaving('p1')], 100);
    expect(w.where('p1', 100)).toBeUndefined();
    expect(frame.meta.every((v, i) => i % STRIDE !== 1 || v === 0)).toBe(true);
    w.sync([leaving('p1')], 101);
    expect(w.where('p1', 101)).toBeUndefined();
  });

  test('касание находит любого — пациента, персонал; мимо всех — никого', () => {
    const w = new Walkers(layout, 48);
    const nurse: Placement = { id: 'staff.nurse', figure: 'nurse', where: at(layout.staff[1].cell), doing: { kind: 'staff', role: 'nurse' } };
    w.sync([seat('p1'), office('p2'), nurse], 0);
    const [sx, sy] = seats[0];
    expect(w.hit(sx + 0.5, sy + 0.5, 0)).toBe('p1');
    const [ox, oy] = spots.office;
    expect(w.hit(ox + 0.5, oy + 0.5, 0)).toBe('p2');
    const [nx, ny] = layout.staff[1].cell;
    expect(w.hit(nx + 0.5, ny + 0.5, 0)).toBe('staff.nurse');
    expect(w.hit(27.5, 8.5, 0)).toBeUndefined();
    expect(w.slotOf('p1')).toBeGreaterThanOrEqual(0);
    expect(w.slotOf('nobody')).toBe(-1);
  });
});
