// Стройка своей больницы (src/engine/hospital/build.ts и requirements.ts; spec
// 2026-09-own-hospital): помещение ставится целиком на участке и не на чужом, соседние делят
// стену; дверь сама ищет коридор; снос и продажа возвращают половину; команды не меняют
// прежние снимки — отмена возвращает участок и кассу точь-в-точь; готовая амбулатория строится
// из каталога, в ней работает всё и доступно каждое обследование; чего не хватает — видно.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Cell, Id, Rot } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { build, type BuildCommand, type Built, canPlace, dims, emptyPlot, planOf, presetHospital, turn } from '../../src/engine/hospital/build';
import { CELL } from '../../src/engine/hospital/grid';
import { examWhere, openBlocks, problemsOf, type Staffing, workingRooms } from '../../src/engine/hospital/requirements';

const START: Built = { hospital: emptyPlot(40, 28, [0, 13], [[1, 13], [2, 13], [3, 13]]), cash: 5_000_000 };

function run(s: Built, ...cmds: BuildCommand[]): Built {
  return cmds.reduce((st, c) => {
    const r = build(db, st, c);
    if (!r.ok) throw new Error(`${c.kind}: ${r.error.kind}`);
    return r.state;
  }, s);
}
const row = (x0: number, x1: number, y: number): Cell[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y] as Cell);
const col = (x: number, y0: number, y1: number): Cell[] => Array.from({ length: y1 - y0 + 1 }, (_, i) => [x, y0 + i] as Cell);
const everybody: Staffing = () => true;
const clinic = db.presets['preset.clinic'];
const presetStaff: Staffing = (room, role) => clinic.staff.some(s => `r${s.room + 1}` === room && s.role === role);

describe('стройка: геометрия', () => {
  test('поворот по часовой: дверная сторона снизу, слева, сверху, справа; на 90° ширина и высота меняются', () => {
    const z = { w: 8, h: 7 };
    // клетка двери (3, 6) и клетка за ней (3, 7)
    expect([0, 1, 2, 3].map(r => turn(z, r as Rot, 3, 6))).toEqual([[3, 6], [0, 3], [4, 0], [6, 4]]);
    expect([0, 1, 2, 3].map(r => turn(z, r as Rot, 3, 7))).toEqual([[3, 7], [-1, 3], [4, -1], [7, 4]]);
    expect(dims(z, 1)).toEqual([7, 8]);
    expect(dims(z, 2)).toEqual([8, 7]);
  });

  test('помещение: у коридора дверь сама смотрит в коридор; за краем, на коридоре, на чужом полу — нельзя; стену делить можно', () => {
    const s = run(START, { kind: 'corridor', cells: row(4, 30, 13) }, { kind: 'room', type: 'room.reception', size: 'S', x: 2, y: 6, rot: 0 });
    const plan = planOf(db, s.hospital);
    expect(plan.rooms[0].door).toEqual([[5, 12]]);
    expect(plan.connected.r1).toBe(true);
    expect(plan.grid.cells[12 * 40 + 5]).toBe(CELL.door);
    expect(s.cash).toBe(START.cash - 27 * db.economy.corridor.cost - db.rooms['room.reception'].sizes[0].cost);

    expect(canPlace(db, s.hospital, { type: 'room.triage', size: 'S', x: 36, y: 0, rot: 0 })).toEqual({ kind: 'outside' });
    expect(canPlace(db, s.hospital, { type: 'room.triage', size: 'S', x: 10, y: 10, rot: 0 })).toMatchObject({ kind: 'blocked', by: 'corridor' });
    expect(canPlace(db, s.hospital, { type: 'room.triage', size: 'S', x: 4, y: 6, rot: 0 })).toMatchObject({ kind: 'blocked', by: 'room', room: 'r1' });
    // вход не застроить
    expect(canPlace(db, START.hospital, { type: 'room.triage', size: 'S', x: 0, y: 10, rot: 0 })).toMatchObject({ kind: 'blocked', by: 'entrance' });
    // соседнее помещение — через общую стену (x = 7)
    expect(canPlace(db, s.hospital, { type: 'room.triage', size: 'S', x: 7, y: 6, rot: 0 })).toBeNull();
    // на двери соседа не строят, даже стеной
    expect(canPlace(db, s.hospital, { type: 'room.triage', size: 'S', x: 5, y: 12, rot: 2 })).toMatchObject({ kind: 'blocked' });
  });

  test('дверь сама находит коридор: без коридора помещение не работает, подошёл коридор — появилась дверь, дошёл до входа — работает', () => {
    let s = run(START, { kind: 'room', type: 'room.office', size: 'M', x: 10, y: 0, rot: 0 });
    const office = () => planOf(db, s.hospital).rooms[0];
    expect(office().door).toEqual([]);
    expect(problemsOf(db, planOf(db, s.hospital), office(), everybody)).toEqual([{ kind: 'noDoor' }]);
    // коридор у дверной стороны, но не у двери по шаблону — дверь переезжает к нему
    s = run(s, { kind: 'corridor', cells: row(15, 20, 7) });
    expect(office().door).toEqual([[15, 6]]);
    expect(problemsOf(db, planOf(db, s.hospital), office(), everybody)).toEqual([{ kind: 'noPath' }]);
    s = run(s, { kind: 'corridor', cells: [...col(20, 8, 12), ...row(4, 20, 13)] });
    expect(problemsOf(db, planOf(db, s.hospital), office(), everybody)).toEqual([]);
    // перенести дверь можно только к коридору и не на угол
    expect(build(db, s, { kind: 'door', room: 'r1', at: 2 })).toMatchObject({ ok: false, error: { kind: 'badDoor' } });
    expect(build(db, s, { kind: 'door', room: 'r1', at: 7 })).toMatchObject({ ok: false, error: { kind: 'badDoor' } });
    s = run(s, { kind: 'corridor', cells: row(11, 14, 7) }, { kind: 'door', room: 'r1', at: 1 });
    expect(office().door).toEqual([[11, 6]]);
  });

  test('коридор: не у края участка и не на помещении; уже проведённое не стоит денег', () => {
    expect(build(db, START, { kind: 'corridor', cells: [[0, 5]] })).toMatchObject({ ok: false, error: { kind: 'blocked' } });
    expect(build(db, START, { kind: 'corridor', cells: [[2, 13]] })).toMatchObject({ ok: false, error: { kind: 'nothing' } });
    const s = run(START, { kind: 'room', type: 'room.toilet', size: 'S', x: 10, y: 10, rot: 0 });
    expect(build(db, s, { kind: 'corridor', cells: [[12, 12]] })).toMatchObject({ ok: false, error: { kind: 'blocked' } });
    const poor = { ...START, cash: db.economy.corridor.cost - 1 };
    expect(build(db, poor, { kind: 'corridor', cells: [[4, 13]] })).toMatchObject({ ok: false, error: { kind: 'money', need: 1 } });
  });
});

describe('стройка: деньги', () => {
  const lab = () => run(START, { kind: 'corridor', cells: row(4, 12, 13) }, { kind: 'room', type: 'room.lab', size: 'S', x: 4, y: 6, rot: 0 });

  test('аппарат — только в своё помещение, на свободное место и на деньги', () => {
    const s = lab();
    expect(build(db, s, { kind: 'buy', room: 'r1', equipment: 'eq.ecg' })).toMatchObject({ ok: false, error: { kind: 'wrongRoom' } });
    const two = run(s, { kind: 'buy', room: 'r1', equipment: 'eq.hematology_analyzer' }, { kind: 'buy', room: 'r1', equipment: 'eq.urine_analyzer' });
    expect(build(db, two, { kind: 'buy', room: 'r1', equipment: 'eq.biochem_analyzer' })).toMatchObject({ ok: false, error: { kind: 'noSlot' } });
    expect(build(db, { ...s, cash: 100 }, { kind: 'buy', room: 'r1', equipment: 'eq.immuno_analyzer' }))
      .toMatchObject({ ok: false, error: { kind: 'money', need: db.equipment['eq.immuno_analyzer'].price - 100 } });
    // купленный аппарат стоит на карте
    expect(planOf(db, two.hospital).objects.filter(o => o.kind === 'analyzer')).toHaveLength(2);
  });

  test('снос возвращает половину цены помещения и аппаратов, продажа — половину цены аппарата, стёртый коридор — половину клетки', () => {
    const half = (n: number) => Math.floor(n / 2);
    const s = run(lab(), { kind: 'buy', room: 'r1', equipment: 'eq.hematology_analyzer' });
    const lab$ = db.rooms['room.lab'].sizes[0].cost;
    const hem$ = db.equipment['eq.hematology_analyzer'].price;
    expect(run(s, { kind: 'demolish', room: 'r1' }).cash).toBe(s.cash + half(lab$) + half(hem$));
    expect(run(s, { kind: 'sell', room: 'r1', slot: 0 }).cash).toBe(s.cash + half(hem$));
    expect(run(s, { kind: 'erase', cells: row(10, 12, 13) }).cash).toBe(s.cash + 3 * half(db.economy.corridor.cost));
    expect(run(s, { kind: 'demolish', room: 'r1' }).hospital.rooms).toEqual([]);
  });

  test('команды не меняют прежние снимки: отмена любого числа шагов возвращает участок и кассу точь-в-точь', () => {
    const rng = Rng.seeded(20260927).fork('build');
    const types = Object.keys(db.rooms);
    const snapshots: { state: Built; json: string }[] = [{ state: START, json: JSON.stringify(START) }];
    let s = START;
    for (let i = 0; i < 400; i++) {
      const rooms = s.hospital.rooms;
      const any = rooms.length > 0 ? rooms[rng.int(rooms.length)] : undefined;
      const pick = rng.int(7);
      let cmd: BuildCommand;
      if (pick === 0 || !any) {
        const type = rng.pick(types);
        cmd = { kind: 'room', type, size: rng.pick(db.rooms[type].sizes).id, x: rng.int(36), y: rng.int(24), rot: rng.int(4) as Rot };
      } else if (pick === 1) {
        const x = 1 + rng.int(30);
        const y = 1 + rng.int(26);
        cmd = { kind: 'corridor', cells: rng.chance(5000) ? row(x, x + rng.int(8), y) : col(x, y, Math.min(26, y + rng.int(8))) };
      } else if (pick === 2) {
        cmd = { kind: 'erase', cells: row(1 + rng.int(30), 38, 1 + rng.int(26)) };
      } else if (pick === 3) {
        const eq = db.rooms[any.type].equipment;
        cmd = { kind: 'buy', room: any.id, equipment: eq.length > 0 ? rng.pick(eq) : 'eq.ecg' };
      } else if (pick === 4) {
        cmd = { kind: 'sell', room: any.id, slot: rng.int(4) };
      } else if (pick === 5) {
        cmd = { kind: 'door', room: any.id, at: 1 + rng.int(6) };
      } else {
        cmd = { kind: 'demolish', room: any.id };
      }
      const r = build(db, s, cmd);
      if (!r.ok) continue;
      s = r.state;
      expect(s.cash).toBeGreaterThanOrEqual(0);
      snapshots.push({ state: s, json: JSON.stringify(s) });
    }
    expect(snapshots.length).toBeGreaterThan(100);
    for (const snap of snapshots) expect(JSON.stringify(snap.state)).toBe(snap.json);
    expect(snapshots[0].state).toEqual(START);

    // и в последнем плане: полы не пересекаются, дверь — стена только своего помещения и смотрит в коридор
    const plan = planOf(db, s.hospital);
    const floors = new Map<string, string>();
    for (const r of plan.rooms) {
      for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
        for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
          expect(floors.get(`${x},${y}`)).toBeUndefined();
          floors.set(`${x},${y}`, r.id);
        }
      }
    }
    const corridor = new Set(s.hospital.corridor);
    for (const r of plan.rooms) for (const [x, y] of r.door) expect([x + 1, x - 1].some(nx => corridor.has(y * 40 + nx)) || [y + 1, y - 1].some(ny => corridor.has(ny * 40 + x))).toBe(true);
  });
});

describe('готовая амбулатория', () => {
  test('строится из каталога теми же командами; сетка — та же, что была планом кодом', () => {
    const { hospital, failed } = presetHospital(db, clinic);
    expect(failed).toEqual([]);
    const g = planOf(db, hospital).grid;
    const ascii = Array.from({ length: g.h }, (_, y) => Array.from({ length: g.w }, (_, x) => ' .,#D'[g.cells[y * g.w + x]]).join(''));
    expect(ascii).toEqual([
      '##############################',
      '#....#....#......#....#......#',
      '#....#....#......#....#......#',
      '#....#....#......#....#......#',
      '#....#....#......#....#......#',
      '#....#....#......#....#......#',
      '###D####D####D#####D#####D####',
      '#,,,,,,,,,,,,,,,,,,,,,,,,,,,,#',
      'D,,,,,,,,,,,,,,,,,,,,,,,,,,,,#',
      '#,,,,,,,,,,,,,,,,,,,,,,,,,,,,#',
      '####DDDD######D#####D#####D###',
      '#...........#....#......#....#',
      '#...........#....#......#....#',
      '#...........#....#......#....#',
      '#...........#....#......#....#',
      '#...........#....#......#....#',
      '##############################',
    ]);
  });

  test('работает каждое помещение, доступно каждое обследование, кроме УЗИ, смену можно открыть', () => {
    const plan = planOf(db, presetHospital(db, clinic).hospital);
    const working = workingRooms(db, plan, presetStaff);
    expect(working.size).toBe(plan.rooms.length);
    // кабинета УЗИ в амбулатории нет (spec 2026-09-chapter-2): практика — прежняя амбулатория; кровь на
    // тропонин берут в смотровой приёмного (spec 2026-10-chapter-3, часть 39в) — её в амбулатории тоже нет
    const us = Object.keys(db.exams).filter(id => db.exams[id].room === 'room.ultrasound');
    expect(us).toEqual(['exam.us_abdomen', 'exam.us_kidney', 'exam.us_leg_arteries', 'exam.us_leg_veins']);
    const ed = Object.keys(db.exams).filter(id => db.exams[id].collect === 'room.emergency');
    expect(ed).toEqual(['exam.troponin_hs']);
    for (const id of Object.keys(db.exams).filter(x => !us.includes(x) && !ed.includes(x))) expect({ id, ...examWhere(db, plan, working, presetStaff, id) }).toMatchObject({ id, rooms: expect.any(Array) });
    for (const id of us) expect(examWhere(db, plan, working, presetStaff, id)).toEqual({ block: { kind: 'noRoom', room: 'room.ultrasound' } });
    for (const id of ed) expect(examWhere(db, plan, working, presetStaff, id)).toEqual({ block: { kind: 'noRoom', room: 'room.emergency' } });
    expect(openBlocks(db, plan, working, presetStaff)).toEqual([]);
  });

  test('на участке песочницы 40 × 28 — та же амбулатория в углу', () => {
    const { hospital, failed } = presetHospital(db, clinic, [40, 28]);
    expect(failed).toEqual([]);
    const plan = planOf(db, hospital);
    expect([plan.grid.w, plan.grid.h]).toEqual([40, 28]);
    expect(workingRooms(db, plan, presetStaff).size).toBe(9);
  });
});

describe('требования', () => {
  const built = () => ({ hospital: presetHospital(db, clinic).hospital, cash: 10_000_000 });
  const where = (s: Built, staffed: Staffing, exam: Id) => {
    const plan = planOf(db, s.hospital);
    return examWhere(db, plan, workingRooms(db, plan, staffed), staffed, exam);
  };

  test('нет человека — помещение не работает, и обследование в нём — с причиной', () => {
    const noRadiologist: Staffing = (room, role) => role !== 'role.radiologist' && presetStaff(room, role);
    expect(where(built(), noRadiologist, 'exam.xray_chest')).toEqual({ block: { kind: 'down', room: 'room.xray', problem: { kind: 'noStaff', role: 'role.radiologist' } } });
    expect(where(built(), noRadiologist, 'exam.ecg')).toMatchObject({ rooms: ['r7'] });
  });

  test('нет нужного анализатора — анализ недоступен, остальные делаются', () => {
    const s = run(built(), { kind: 'sell', room: 'r5', slot: 3 });
    expect(where(s, presetStaff, 'exam.tsh')).toEqual({ block: { kind: 'noEquipment', room: 'room.lab', equipment: ['eq.immuno_analyzer'] } });
    expect(where(s, presetStaff, 'exam.cbc')).toMatchObject({ rooms: ['r5'] });
    // без всех анализаторов лаборатория не работает вовсе
    const empty = run(s, { kind: 'sell', room: 'r5', slot: 0 }, { kind: 'sell', room: 'r5', slot: 1 }, { kind: 'sell', room: 'r5', slot: 2 });
    expect(where(empty, presetStaff, 'exam.cbc')).toEqual({ block: { kind: 'down', room: 'room.lab', problem: { kind: 'noEquipment' } } });
  });

  test('нет процедурного — анализ некому взять; нет регистратуры — смену не открыть', () => {
    const s = run(built(), { kind: 'demolish', room: 'r4' }, { kind: 'demolish', room: 'r1' });
    expect(where(s, presetStaff, 'exam.cbc')).toEqual({ block: { kind: 'noRoom', room: 'room.procedure' } });
    expect(where(s, presetStaff, 'exam.ask_complaints')).toMatchObject({ rooms: ['r3'] });
    const plan = planOf(db, s.hospital);
    expect(openBlocks(db, plan, workingRooms(db, plan, presetStaff), presetStaff)).toEqual([{ kind: 'noRoom', room: 'room.reception' }]);
  });
});
