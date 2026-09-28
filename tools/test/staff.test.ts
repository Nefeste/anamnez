// Персонал и смена в своей больнице (spec 2026-09-own-hospital, часть 8): кандидаты дня, найм,
// назначение и увольнение; смена открывается, только когда работает нужное; обследование —
// там, где есть помещение, аппарат и люди, с их скоростью и точностью; без доврачебного
// кабинета нет сортировки; в полной зоне ожидания стоят и ждут меньше.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Cell } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { applicantsOf, grow, readingOf, salaryOf, speedOf, type StaffMember } from '../../src/engine/hospital/staff';
import { effectiveCheck } from '../../src/engine/med/exams';
import { apply, hospitalCtx, newSandbox } from '../../src/engine/shift/engine';
import type { Command, ShiftState } from '../../src/engine/shift/types';

const row = (x0: number, x1: number, y: number): Cell[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y] as Cell);
const run = (s: ShiftState, ...cmds: Command[]) => {
  for (const c of cmds) apply(db, s, c);
  return s;
};
/** Нанять первого кандидата на должность и назначить в помещение. */
function staffUp(s: ShiftState, role: string, room: string) {
  const c = s.candidates!.find(x => x.role === role);
  expect(c).toBeDefined();
  run(s, { kind: 'hire', id: c!.id }, { kind: 'assign', id: c!.id, room });
}
/** Регистратура, зона ожидания S (6 мест), кабинет — у коридора; регистратор на месте. */
function minimal(seed: number): ShiftState {
  const s = newSandbox(db, { seed, season: 'winter', difficulty: 'doctor', start: 'empty', budget: 5_000_000 });
  run(s,
    { kind: 'build', cmd: { kind: 'corridor', cells: row(4, 30, 13) } },
    { kind: 'build', cmd: { kind: 'room', type: 'room.reception', size: 'S', x: 2, y: 6, rot: 0 } },
    { kind: 'build', cmd: { kind: 'room', type: 'room.waiting', size: 'S', x: 2, y: 14, rot: 2 } },
    { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 12, y: 6, rot: 0 } });
  staffUp(s, 'role.registrar', 'r1');
  return s;
}
const advanceUntil = (s: ShiftState, ok: () => boolean, max = 600) => {
  for (let i = 0; i < max && !ok(); i++) apply(db, s, { kind: 'advance', seconds: 60 });
};

describe('кандидаты и найм', () => {
  test('кандидаты дня — на каждую должность, которую нанимают, от одного до двух; те же зерно и день — те же люди', () => {
    const a = applicantsOf(db, 7, 3, 1);
    const roles = Object.values(db.roles).filter(r => r.hire).map(r => r.id);
    for (const role of roles) {
      const n = a.list.filter(c => c.role === role).length;
      expect(n).toBeGreaterThanOrEqual(db.economy.staff.candidates[0]);
      expect(n).toBeLessThanOrEqual(db.economy.staff.candidates[1]);
    }
    expect(a.list.map(c => c.id)).toEqual(a.list.map((_, i) => `s${i + 1}`));
    expect(applicantsOf(db, 7, 3, 1)).toEqual(a);
    expect(applicantsOf(db, 7, 4, 1).list).not.toEqual(a.list);
    // новичок — навык 1–2, опытный — 4–5; зарплата — между «навык 1» и «навык 5»
    for (let day = 0; day < 30; day++) {
      for (const c of applicantsOf(db, 11, day, 1).list) {
        if (c.trait === 'novice') expect(c.skill).toBeLessThanOrEqual(2);
        if (c.trait === 'experienced') expect(c.skill).toBeGreaterThanOrEqual(4);
        expect(c.salary).toBe(salaryOf(db, c.role, c.skill, c.trait));
      }
    }
  });

  test('навык и черта: быстрее, точнее, дороже; навык растёт с отработанными сменами, новичок — вдвое быстрее', () => {
    const m: StaffMember = { id: 'x', role: 'role.radiologist', sex: 'f', seed: 1, skill: 3, salary: 0, room: 'r1', days: 0 };
    expect(speedOf(db, m)).toBe(100);
    expect(speedOf(db, { ...m, skill: 1, trait: 'fast' })).toBe(Math.round((130 * 85) / 100));
    expect(readingOf(db, m)).toEqual([0, 0]);
    expect(readingOf(db, { ...m, skill: 5, trait: 'careful' })).toEqual([6, 3]);
    expect(salaryOf(db, 'role.radiologist', 5, 'experienced')).toBeGreaterThan(salaryOf(db, 'role.radiologist', 5));
    let x = { ...m };
    for (let i = 0; i < db.economy.staff.growthDays; i++) x = grow(db, x);
    expect(x.skill).toBe(4);
    let n: StaffMember = { ...m, trait: 'novice', skill: 1 };
    for (let i = 0; i < db.economy.staff.growthDays / 2; i++) n = grow(db, n);
    expect(n.skill).toBe(2);
    // в резерве не растёт
    expect(grow(db, { ...m, room: undefined })).toEqual({ ...m, room: undefined });
  });

  test('назначить на занятое место — прежний уходит в резерв; уволить; снесли помещение — все его люди в резерве', () => {
    const s = minimal(3);
    const first = s.staff![0].id;
    const second = s.candidates!.find(c => c.role === 'role.registrar');
    if (second) {
      run(s, { kind: 'hire', id: second.id }, { kind: 'assign', id: second.id, room: 'r1' });
      expect(s.staff!.find(m => m.id === first)!.room).toBeUndefined();
      expect(s.staff!.find(m => m.id === second.id)!.room).toBe('r1');
      run(s, { kind: 'fire', id: first });
      expect(s.staff!.map(m => m.id)).toEqual([second.id]);
    }
    // медсестру в регистратуру не назначить
    const nurse = s.candidates!.find(c => c.role === 'role.nurse')!;
    run(s, { kind: 'hire', id: nurse.id }, { kind: 'assign', id: nurse.id, room: 'r1' });
    expect(s.staff!.find(m => m.id === nurse.id)!.room).toBeUndefined();
    run(s, { kind: 'build', cmd: { kind: 'demolish', room: 'r1' } });
    expect(s.staff!.every(m => m.room === undefined)).toBe(true);
  });

  test('вечером — новые кандидаты; кто работал — на смену опытнее', () => {
    const s = minimal(4);
    const before = s.candidates!.map(c => c.id);
    run(s, { kind: 'nextDay' });
    advanceUntil(s, () => s.t > 15 * 3600);
    run(s, { kind: 'closeDay' });
    expect(s.candidates!.map(c => c.id)).not.toEqual(before);
    expect(s.staff![0].days + s.staff![0].skill).toBeGreaterThan(0);
    expect(s.staff![0].days === 1 || s.staff![0].skill > 1).toBe(true);
  });
});

describe('смена в своей больнице', () => {
  test('без регистратора смену не открыть; с ним — день 1 и пациенты', () => {
    const s = newSandbox(db, { seed: 5, season: 'winter', start: 'empty', budget: 5_000_000 });
    run(s,
      { kind: 'build', cmd: { kind: 'corridor', cells: row(4, 30, 13) } },
      { kind: 'build', cmd: { kind: 'room', type: 'room.reception', size: 'S', x: 2, y: 6, rot: 0 } },
      { kind: 'build', cmd: { kind: 'room', type: 'room.waiting', size: 'S', x: 2, y: 14, rot: 2 } },
      { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 12, y: 6, rot: 0 } },
      { kind: 'nextDay' });
    expect([s.day, s.dayOpen]).toEqual([0, false]);
    staffUp(s, 'role.registrar', 'r1');
    run(s, { kind: 'nextDay' });
    expect([s.day, s.dayOpen]).toEqual([1, true]);
    expect(Object.keys(s.patients).length).toBeGreaterThan(5);
  });

  test('без доврачебного кабинета: срочность никто не определил, давление не измерено, очередь — по приходу', () => {
    const s = minimal(6);
    run(s, { kind: 'nextDay' });
    advanceUntil(s, () => s.queue.length >= 3);
    const q = s.queue.map(id => s.patients[id]);
    for (const p of q) {
      expect(p.triaged).toBe(false);
      expect(p.done).not.toContain('exam.vitals');
    }
    expect(q.map(p => p.queuedT)).toEqual([...q.map(p => p.queuedT)].sort((a, b) => a - b));
    expect(hospitalCtx(db, s).triage).toBe(false);
  });

  test('в полной зоне ожидания стоят: ждать готовы вдвое меньше', () => {
    const s = minimal(8);
    s.meta.difficulty = 'student'; // терпения больше — очередь дорастает до полной зоны
    const seats = hospitalCtx(db, s).seats;
    expect(seats).toBe(db.rooms['room.waiting'].sizes[0].seats);
    run(s, { kind: 'nextDay' });
    let full = 0;
    let free = 0;
    for (let i = 0; i < 6 * 3600; i++) {
      const before = s.queue.length;
      const notices = apply(db, s, { kind: 'advance', seconds: 1 });
      const came = notices.filter(n => n.kind === 'arrived');
      if (came.length !== 1 || notices.length !== 1) continue;
      const p = s.patients[came[0].id];
      if (p.triage === 'red') continue;
      const [lo, hi] = p.triage === 'yellow' ? [120, 180] : [60, 150];
      const base = Math.round(Rng.seeded(s.meta.seed).fork(`patience:${p.id}`).range(lo, hi) * 60 * 1.5);
      if (before >= seats) {
        expect(p.patience).toBe(Math.round(base / 2));
        full++;
      } else {
        expect(p.patience).toBe(base);
        free++;
      }
    }
    expect(full).toBeGreaterThan(0);
    expect(free).toBeGreaterThan(0);
  });

  test('обследования нет в больнице — не назначается; есть — в своём помещении, со скоростью аппарата и людей', () => {
    const s = newSandbox(db, { seed: 9, season: 'winter', start: 'clinic', budget: 10_000_000 });
    // рентген: цифровой → плёночный (медленнее в 1,3 раза, снимок хуже)
    run(s, { kind: 'build', cmd: { kind: 'sell', room: 'r8', slot: 0 } }, { kind: 'build', cmd: { kind: 'buy', room: 'r8', equipment: 'eq.xray_analog' } });
    // лаборатория без иммунохимического анализатора — ТТГ не сделать
    run(s, { kind: 'build', cmd: { kind: 'sell', room: 'r5', slot: 3 } }, { kind: 'nextDay' });
    advanceUntil(s, () => s.queue.length > 0);
    const id = s.queue[0];
    run(s, { kind: 'call', id }, { kind: 'exam', exam: 'exam.tsh' });
    expect(s.patients[id].done).not.toContain('exam.tsh');
    run(s, { kind: 'exam', exam: 'exam.xray_chest' });
    const x = s.patients[id].pending.find(p => p.exam === 'exam.xray_chest')!;
    expect(x.room).toBe('r8');
    expect(x.end! - x.start!).toBe(Math.round((15 * 60 * Math.round(1.3 * 100)) / 100));
    expect(s.rooms.r8).toBe(x.end!);
  });

  test('точность снимка: аппарат и рентгенолог сдвигают в процентных пунктах, в пределах 50–99,5 %', () => {
    const skill = { sens: 1, spec: 1, sensPp: -14, specPp: -7 };
    expect(effectiveCheck(8000, 9300, skill)).toEqual({ sens: 6600, spec: 8600 });
    expect(effectiveCheck(9800, 5200, { sens: 1, spec: 1, sensPp: 10, specPp: -10 })).toEqual({ sens: 9950, spec: 5000 });
    // без поправок — ровно как в базе, без округлений
    expect(effectiveCheck(8123, 9321, { sens: 1, spec: 1, sensPp: 0, specPp: 0 })).toEqual({ sens: 8123, spec: 9321 });
  });

  test('готовая амбулатория в песочнице работает как практика: всё доступно, сортировка есть', () => {
    const s = newSandbox(db, { seed: 10, season: 'winter', start: 'clinic', budget: 1 });
    const c = hospitalCtx(db, s);
    expect(c.working.size).toBe(9);
    expect(c.triage).toBe(true);
    run(s, { kind: 'nextDay' });
    expect(s.dayOpen).toBe(true);
  });
});
