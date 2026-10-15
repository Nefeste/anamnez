// Дорога по больнице (FR-HOS-4, 0.5.9; spec 2026-10-walk-breakdowns): расстояния — поиском в ширину по клеткам плана от
// двери до двери, по коридорам; пациент идёт на снимок и на анализ крови — результат приходит на дорогу позже, у постели
// — без дороги; врач идёт туда, где ждёт следующий: в смотровую приёмного к привезённому и обратно в кабинет; встреча —
// минута, как и прежде, или дорога врача, если она дольше.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { type Plan, planOf, presetHospital } from '../../src/engine/hospital/build';
import { CELL } from '../../src/engine/hospital/grid';
import { doctorRoom } from '../../src/engine/hospital/requirements';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { metersBetween, WALK_SPEED, walkSeconds } from '../../src/engine/hospital/walk';
import { ORDER_MINUTES } from '../../src/engine/med/policy';
import { apply, hospitalCtx, meetIn, newSandbox, readyIn, walkTo } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';

const XRAY = 'exam.xray_chest';
const CBC = 'exam.cbc';
const TROP = 'exam.troponin_hs';
const plan = (preset: string) => planOf(db, presetHospital(db, db.presets[preset]).hospital);
const idOf = (p: Plan, type: string) => p.rooms.find(r => r.type === type)!.id;
/** Шагов по прямой между ближайшими клетками дверей — сквозь стены. */
const straight = (p: Plan, a: string, b: string) => {
  const [da, db_] = [p.rooms.find(r => r.id === a)!.door, p.rooms.find(r => r.id === b)!.door];
  return Math.min(...da.flatMap(([x, y]) => db_.map(([u, v]) => Math.abs(x - u) + Math.abs(y - v))));
};

/** Песочница с готовой амбулаторией; поломки — в своём тесте (breakdowns.test), здесь все аппараты работают. */
function clinic(seed = 31): ShiftState {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  apply(db, s, { kind: 'nextDay' });
  delete s.broken;
  return s;
}

/** Первый, кого ещё не взял нанятый врач, — в кабинете. */
function called(s: ShiftState): ShiftPatient {
  for (let i = 0; i < 60 && !s.queue.some(id => !s.patients[id].by); i++) apply(db, s, { kind: 'advance', seconds: 5 * 60 });
  const p = s.patients[s.queue.find(id => !s.patients[id].by)!];
  apply(db, s, { kind: 'call', id: p.id });
  expect(s.current).toBe(p.id);
  return p;
}

/**
 * Песочница с амбулаторией и смотровой приёмного справа (как в ambulance.test) — с монитором у койки: ЭКГ снимают у
 * постели; медсестра ЭКГ — в смотровую. `far` — смотровая внизу слева, а коридор к ней — вокруг амбулатории: от кабинета
 * врача 72 м.
 */
function withEmergency(seed: number, far = false): { s: ShiftState; room: string } {
  const s = newSandbox(db, { seed, season: 'winter', difficulty: 'doctor', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  if (far) {
    for (let x = 36; x <= 38; x++) for (let y = 10; y <= 26; y++) cells.push([x, y]);
    for (let x = 1; x <= 35; x++) for (let y = 24; y <= 26; y++) cells.push([x, y]);
  }
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size: 'M', x: far ? 1 : 29, y: far ? 18 : 1, rot: 0 } });
  const room = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  apply(db, s, { kind: 'build', cmd: { kind: 'buy', room, equipment: 'eq.monitor_defib' } });
  apply(db, s, { kind: 'buildEnd' });
  const nurse = s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!;
  apply(db, s, { kind: 'assign', id: nurse.id, room });
  return { s, room };
}

/** День, когда привезённый скорой лежит в смотровой и врач свободен; он рассортирован. */
function inBay(far = false): { s: ShiftState; p: ShiftPatient } {
  for (let seed = 21; seed < 61; seed++) {
    const { s } = withEmergency(seed, far);
    apply(db, s, { kind: 'nextDay' });
    delete s.broken;
    for (let i = 0; i < 10 * 60 && s.dayOpen; i++) {
      const p = Object.values(s.patients).find(x => x.kind === 'ambulance' && x.bay && x.status === 'waiting' && !x.closed && !x.by);
      if (p && !s.current) {
        if (!p.sorted) apply(db, s, { kind: 'sort', id: p.id, triage: p.scale?.triage ?? 'yellow' });
        return { s, p };
      }
      apply(db, s, { kind: 'advance', seconds: 60 });
    }
  }
  throw new Error('за 40 зёрен не нашлось');
}

describe('расстояния', () => {
  test('амбулатория: от кабинета врача до ЭКГ 5 м, до процедурного 8, до рентгена 11, до лаборатории 14; в обе стороны одинаково, в своём — 0', () => {
    const p = plan('preset.clinic');
    const office = doctorRoom(p)!;
    const to = (type: string) => metersBetween(p, office, idOf(p, type));
    expect(['room.ecg', 'room.procedure', 'room.xray', 'room.lab'].map(to)).toEqual([5, 8, 11, 14]);
    for (const r of p.rooms) expect(metersBetween(p, r.id, office)).toBe(metersBetween(p, office, r.id)!);
    expect(metersBetween(p, office, office)).toBe(0);
    // метр в секунду: так ходят пожилые и больные
    expect(WALK_SPEED).toBe(1);
    expect(walkSeconds(p, office, idOf(p, 'room.xray'))).toBe(11);
    expect(walkSeconds(p, undefined, idOf(p, 'room.xray'))).toBe(0);
  });

  test('по коридорам, а не сквозь стены: в районной больнице до смотровой приёмного 33 м, по прямой — 23', () => {
    const p = plan('preset.district');
    const [office, ed] = [doctorRoom(p)!, idOf(p, 'room.emergency')];
    expect(metersBetween(p, office, ed)).toBe(33);
    expect(straight(p, office, ed)).toBe(23);
    for (const a of p.rooms) for (const b of p.rooms) expect(metersBetween(p, a.id, b.id)!).toBeGreaterThanOrEqual(straight(p, a.id, b.id));
  });

  test('городская больница: из каждого кабинета врача и из смотровой дойти до каждого места обследований; дальше всего — 70 м', () => {
    const p = plan('preset.city');
    const from = p.rooms.filter(r => r.type === 'room.office' || r.type === 'room.emergency');
    // тропонин и пункции берут в смотровой приёмного
    const to = p.rooms.filter(r => Object.values(db.exams).some(e => e.room === r.type || e.collect === r.type));
    expect(to.map(r => r.type).sort()).toEqual(['room.ct', 'room.ecg', 'room.emergency', 'room.endoscopy', 'room.lab', 'room.mri', 'room.procedure', 'room.ultrasound', 'room.xray']);
    const all = from.flatMap(a => to.map(b => metersBetween(p, a.id, b.id)));
    expect(all.every(d => d !== undefined)).toBe(true);
    expect(Math.max(...(all as number[]))).toBe(70);
  });

  test('не дойти — нет расстояния, и дорога — 0: стена поперёк коридора, помещение без двери', () => {
    const p = plan('preset.clinic');
    const [office, xray] = [doctorRoom(p)!, idOf(p, 'room.xray')];
    // стена на всю высоту участка между кабинетом врача (дверь — x 13) и рентгеном (дверь — x 20)
    const cells = p.grid.cells.slice();
    for (let y = 0; y < p.grid.h; y++) cells[y * p.grid.w + 17] = CELL.wall;
    const cut: Plan = { ...p, grid: { ...p.grid, cells } };
    expect(metersBetween(cut, office, xray)).toBeUndefined();
    expect(walkSeconds(cut, office, xray)).toBe(0);
    expect(metersBetween(cut, office, idOf(p, 'room.ecg'))).toBe(5);
    const doorless: Plan = { ...p, rooms: p.rooms.map(r => (r.id === xray ? { ...r, door: [] } : r)) };
    expect(metersBetween(doorless, office, xray)).toBeUndefined();
  });
});

describe('дорога в смене', () => {
  test('снимок начинается не раньше, чем пациент дошёл: 2 минуты назначить и 11 секунд до рентгена; срок готовности — с дорогой', () => {
    const s = clinic();
    const p = called(s);
    const t0 = s.t;
    const ready = readyIn(db, s, p, XRAY)!;
    apply(db, s, { kind: 'exam', exam: XRAY });
    const x = p.pending.find(e => e.exam === XRAY)!;
    expect(x.start! - t0).toBe(ORDER_MINUTES * 60 + 11);
    expect(x.readyAt - x.end!).toBe(db.exams[XRAY].time.report! * 60);
    expect(x.readyAt - t0).toBeCloseTo(ready * 60, 6);
  });

  // с 0.5.12 — и направление, как к аппарату: пациент идёт в процедурный, когда врач его выписал
  test('анализ крови: кровь берут в процедурном — забор после направления и 8 секунд дороги, результат — на столько же позже', () => {
    const s = clinic();
    const p = called(s);
    const t0 = s.t;
    const ready = readyIn(db, s, p, CBC)!;
    apply(db, s, { kind: 'exam', exam: CBC });
    const x = p.pending.find(e => e.exam === CBC)!;
    expect(x.start! - t0).toBe(ORDER_MINUTES * 60 + 8);
    expect(x.end! - x.start!).toBe(db.exams[CBC].time.procedure * 60);
    expect(x.readyAt - t0).toBeCloseTo(ready * 60, 6);
  });

  test('тропонин пришедшему самому — кровь берут в смотровой приёмного: забор — после направления и дороги до неё', () => {
    const { s, room } = withEmergency(21);
    apply(db, s, { kind: 'nextDay' });
    delete s.broken;
    for (let i = 0; i < 60 && !s.queue.some(id => s.patients[id].kind !== 'ambulance'); i++) apply(db, s, { kind: 'advance', seconds: 5 * 60 });
    const p = s.patients[s.queue.find(id => s.patients[id].kind !== 'ambulance')!];
    apply(db, s, { kind: 'call', id: p.id });
    const pl = hospitalCtx(db, s).plan;
    const t = s.t;
    apply(db, s, { kind: 'exam', exam: TROP });
    const x = p.pending.find(e => e.exam === TROP)!;
    expect(x.start! - t).toBe(ORDER_MINUTES * 60 + walkSeconds(pl, doctorRoom(pl), room));
    expect(x.start! - t - ORDER_MINUTES * 60).toBeGreaterThan(20);
  });

  test('пациент нанятого врача идёт из его кабинета: срок снимка — на разницу дороги позже', () => {
    const s = newSandbox(db, { seed: 7, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
    apply(db, s, { kind: 'buildEnd' });
    const office = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    const m: StaffMember = { id: 'h1', role: 'role.therapist', sex: 'f', seed: 11, skill: 3, salary: salaryOf(db, 'role.therapist', 3), days: 0 };
    s.staff = [...s.staff!, m];
    apply(db, s, { kind: 'assign', id: m.id, room: office });
    apply(db, s, { kind: 'nextDay' });
    delete s.broken;
    const pl = hospitalCtx(db, s).plan;
    const xray = idOf(pl, 'room.xray');
    const [mine, theirs] = [walkSeconds(pl, doctorRoom(pl), xray), walkSeconds(pl, office, xray)];
    expect(theirs).toBeGreaterThan(mine);
    const p = called(s);
    const own = readyIn(db, s, p, XRAY)!;
    const colleague = readyIn(db, s, { ...p, by: m.id }, XRAY)!;
    // рентген может быть занят снимками его пациентов: тогда начнут, когда освободится
    const start = (walk: number) => Math.max(s.t + ORDER_MINUTES * 60 + walk, s.rooms[xray] ?? 0);
    expect((colleague - own) * 60).toBeCloseTo(start(theirs) - start(mine), 6);
    expect(colleague).toBeGreaterThanOrEqual(own);
  });

  test('врач идёт к лежащему в смотровой и остаётся там: снова к нему — без дороги, к пришедшему сам — обратно в кабинет; у постели ЭКГ — без дороги, на снимок — из смотровой', () => {
    const { s, p } = inBay();
    const pl = hospitalCtx(db, s).plan;
    // закрытый приём место в смотровой освобождает — запомнить его
    const bay = p.bay!.room;
    const walk = walkSeconds(pl, doctorRoom(pl), bay);
    expect(walk).toBe(metersBetween(pl, doctorRoom(pl)!, p.bay!.room)!);
    expect(walk).toBe(22);
    expect(walkTo(db, s, p)).toBe(walk);
    // встреча — минута, как у пришедшего самого: 22 м врач проходит быстрее
    expect(meetIn(db, s, p)).toBe(60);
    let t = s.t;
    apply(db, s, { kind: 'call', id: p.id });
    expect([s.current, s.doctorAt, s.t - t]).toEqual([p.id, p.bay!.room, 60]);
    // ЭКГ монитором у постели — без дороги
    t = s.t;
    apply(db, s, { kind: 'exam', exam: 'exam.ecg' });
    expect(p.results.find(r => r.exam === 'exam.ecg')!.at - t).toBe(db.exams['exam.ecg'].bedside!.time.procedure * 60);
    // тропонин берут в смотровой приёмного — у лежащего там же, без дороги
    t = s.t;
    apply(db, s, { kind: 'exam', exam: TROP });
    expect(p.pending.find(e => e.exam === TROP)!.start! - t).toBe(0);
    // снимок — из смотровой до рентгена (если рентген не занят дольше)
    const xray = idOf(pl, 'room.xray');
    t = s.t;
    const free = s.rooms[xray] ?? 0;
    apply(db, s, { kind: 'exam', exam: XRAY });
    const x = p.pending.find(e => e.exam === XRAY)!;
    expect(walkSeconds(pl, p.bay!.room, xray)).toBeGreaterThan(walkSeconds(pl, doctorRoom(pl), xray));
    expect(x.start!).toBe(Math.max(t + ORDER_MINUTES * 60 + walkSeconds(pl, p.bay!.room, xray), free));
    // попросил подождать снимка — сам остаётся в смотровой
    t = s.t;
    apply(db, s, { kind: 'sendAway' });
    expect([s.current, s.doctorAt, s.t - t]).toEqual([undefined, p.bay!.room, 60]);
    // снимок готов — к нему снова, уже без дороги; приём закрыт — две минуты, врач ещё там
    for (let i = 0; i < 120 && p.status !== 'waiting'; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    expect(p.status).toBe('waiting');
    t = s.t;
    apply(db, s, { kind: 'call', id: p.id });
    expect(s.t - t).toBe(60);
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    t = s.t;
    apply(db, s, { kind: 'finish' });
    expect([p.closed !== undefined, s.doctorAt, s.t - t]).toEqual([true, bay, 2 * 60]);
    // к пришедшему сам — обратно в свой кабинет
    for (let i = 0; i < 120 && !s.queue.some(id => !s.patients[id].bay && !s.patients[id].by); i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const next = s.patients[s.queue.find(id => !s.patients[id].bay && !s.patients[id].by)!];
    expect(walkTo(db, s, next)).toBe(walk);
    t = s.t;
    apply(db, s, { kind: 'call', id: next.id });
    expect([s.current, s.doctorAt, s.t - t]).toEqual([next.id, undefined, 60]);
  });

  test('дорога дольше минуты — столько, сколько идти: до смотровой за 72 м врач идёт 72 секунды, к пришедшему сам — столько же обратно', () => {
    const { s, p } = inBay(true);
    const pl = hospitalCtx(db, s).plan;
    expect(walkTo(db, s, p)).toBe(72);
    expect(meetIn(db, s, p)).toBe(72);
    let t = s.t;
    apply(db, s, { kind: 'call', id: p.id });
    expect([s.current, s.doctorAt, s.t - t]).toEqual([p.id, p.bay!.room, 72]);
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    for (let i = 0; i < 120 && !s.queue.some(id => !s.patients[id].bay && !s.patients[id].by); i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const next = s.patients[s.queue.find(id => !s.patients[id].bay && !s.patients[id].by)!];
    expect(walkSeconds(pl, s.doctorAt, doctorRoom(pl))).toBe(72);
    t = s.t;
    apply(db, s, { kind: 'call', id: next.id });
    expect([s.current, s.doctorAt, s.t - t]).toEqual([next.id, undefined, 72]);
  });

  test('утром врач — в своём кабинете', () => {
    const { s, p } = inBay();
    apply(db, s, { kind: 'call', id: p.id });
    expect(s.doctorAt).toBe(p.bay!.room);
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
    expect(s.doctorAt).toBeUndefined();
  });

  test('пришедший сам — врач никуда не идёт: вызов — минута, приём закрыт — две', () => {
    const s = clinic();
    for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 5 * 60 });
    const p = s.patients[s.queue[0]];
    const t = s.t;
    apply(db, s, { kind: 'call', id: p.id });
    expect([s.current, s.t - t]).toEqual([p.id, 60]);
    const before = s.t;
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    expect(p.closed).toBeDefined();
    expect(s.t - before).toBe(2 * 60);
  });
});
