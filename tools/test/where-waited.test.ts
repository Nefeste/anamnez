// Где ждали (spec 2026-10-where-waited, часть 96, вопрос 60, вариант 2): у каждого места за день — сколько прошли,
// сколько ждали и сколько место было в работе; второй процедурный кабинет делит очередь, как второй рентген; лаборант
// ставит партию проб, и следующая ждёт; итоги дня — «Где ждали», касание помещения на карте — «Сегодня: …».
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { doctorRoom } from '../../src/engine/hospital/requirements';
import { speedOf, memberAt } from '../../src/engine/hospital/staff';
import { apply, hospitalCtx, newCampaign, newSandbox, newShift } from '../../src/engine/shift/engine';
import { DAY, SHIFT_SCHEMA_VERSION, SHIFT_START, type PendingResult, type ShiftPatient, type ShiftState, type WaitStat } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { lowerFirst } from '../../src/i18n/case';
import { memoryStore, saveSlot } from '../../src/state/saves';
import { closeDay, forgetShift, loadShift, setStore, shiftView } from '../../src/state/session';

const MIN = 60;
const CBC = 'exam.cbc';
const XRAY = 'exam.xray_chest';

const roomsOf = (s: ShiftState, type: string) => hospitalCtx(db, s).plan.rooms.filter(r => r.type === type).map(r => r.id);
const until = (s: ShiftState, t: number) => apply(db, s, { kind: 'advance', seconds: Math.max(0, t - s.t) });
const none: WaitStat = { n: 0, total: 0, max: 0, busy: 0 };
const waitOf = (s: ShiftState, room: string): WaitStat => ({ ...none, ...s.summary.waits?.[room] });
const cbcOf = (p: ShiftPatient): PendingResult => p.pending.find(x => x.exam === CBC)!;

/** Утро практики: до `hours` часов смены — пришедшие оформлены, врач никого не звал. */
function morning(hours: number, seed = 21): ShiftState {
  const s = newShift(db, { seed, season: 'winter' });
  until(s, (s.day - 1) * DAY + SHIFT_START + hours * 60 * MIN);
  return s;
}

/** Двое из очереди врача — каждому ОАК, оба отпущены ждать; `s` — смена, где это делать. */
function twoDraws(s: ShiftState): { a: ShiftPatient; b: ShiftPatient } {
  for (let i = 0; i < 600 && s.queue.length < 2; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const [a, b] = s.queue.slice(0, 2).map(id => s.patients[id]);
  for (const p of [a, b]) {
    apply(db, s, { kind: 'call', id: p.id });
    apply(db, s, { kind: 'exam', exam: CBC });
    apply(db, s, { kind: 'sendAway' });
  }
  return { a, b };
}

/**
 * Песочница с готовой амбулаторией и ещё одним помещением `type` в новом крыле — с нанятым на него человеком первой
 * должности помещения и, если нужен, аппаратом; первый день открыт.
 */
function sandboxWith(type: string, equipment?: string, seed = 21): ShiftState {
  const s = newSandbox(db, { seed, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type, size: 'S', x: 29, y: 0, rot: 0 } });
  if (equipment) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: s.hospital!.rooms[s.hospital!.rooms.length - 1].id, equipment } });
  apply(db, s, { kind: 'buildEnd' });
  const room = s.hospital!.rooms[s.hospital!.rooms.length - 1];
  const role = db.rooms[type].staff[0];
  const who = s.candidates!.find(c => c.role === role)!;
  apply(db, s, { kind: 'hire', id: who.id });
  apply(db, s, { kind: 'assign', id: who.id, room: room.id });
  apply(db, s, { kind: 'nextDay' });
  expect(s.dayOpen).toBe(true);
  expect(roomsOf(s, type).filter(id => hospitalCtx(db, s).working.has(id))).toHaveLength(2);
  return s;
}

/** Без второго помещения — та же песочница, те же пришедшие. */
function sandboxPlain(seed = 21): ShiftState {
  const s = newSandbox(db, { seed, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  apply(db, s, { kind: 'nextDay' });
  return s;
}

describe('где ждали: у каждого места', () => {
  test('регистратура и медсестра: ждал — от стойки до начала, в работе — оформление', () => {
    const s = morning(3);
    for (const [type, desk] of [['room.reception', 'reg'], ['room.triage', 'nurse']] as const) {
      const [room] = roomsOf(s, type);
      // прошли — те, кого оформили: у них время стойки известно; без очереди регистратуру не ждут
      const past = Object.values(s.patients).filter(p => p.intake?.[desk]?.at !== undefined && p.status !== 'intake' && p.status !== 'coming');
      expect(past.length).toBeGreaterThan(3);
      const w = waitOf(s, room);
      expect(w.n).toBe(past.length);
      expect(w.total).toBe(past.reduce((a, p) => a + p.intake![desk]!.start - p.intake![desk]!.at!, 0));
      expect(w.max).toBe(Math.max(...past.map(p => p.intake![desk]!.start - p.intake![desk]!.at!)));
      expect(w.busy).toBe(past.reduce((a, p) => a + p.intake![desk]!.end - p.intake![desk]!.start, 0));
    }
  });

  test('ваш приём: ждал — от конца оформления до вызова; в работе — время приёмов', () => {
    const s = morning(2);
    const office = doctorRoom(hospitalCtx(db, s).plan)!;
    const p = s.patients[s.queue[0]];
    const i = p.intake!;
    const since = i.rush ? (i.nurse ?? i.reg).start : (i.nurse ?? i.reg).end;
    const at = s.t;
    apply(db, s, { kind: 'call', id: p.id });
    expect(waitOf(s, office)).toEqual({ n: 1, total: at - since, max: at - since, busy: 0 });
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    expect(waitOf(s, office).busy).toBe(p.spent.seconds - 2 * MIN);
    // вернулся с результатами — не новый: второй раз он врача не ждёт в счёт
    expect(waitOf(s, office).n).toBe(1);
  });

  test('рентген: ждал у кабинета — до начала снимка; в работе — сами снимки', () => {
    const s = morning(2);
    const [xray] = roomsOf(s, 'room.xray');
    const [a, b] = s.queue.slice(0, 2).map(id => s.patients[id]);
    for (const p of [a, b]) {
      apply(db, s, { kind: 'call', id: p.id });
      apply(db, s, { kind: 'exam', exam: XRAY });
      apply(db, s, { kind: 'sendAway' });
    }
    const [x, y] = [a, b].map(p => p.pending.find(q => q.exam === XRAY)!);
    // в «Где ждали» — с минуты, как снимок начался, а не как назначили: второй ещё ждёт
    expect(y.start!).toBeGreaterThan(s.t);
    expect(waitOf(s, xray).n).toBeLessThan(2);
    until(s, y.start! + 1);
    const w = waitOf(s, xray);
    expect(w.n).toBe(2);
    expect(w.busy).toBe(x.end! - x.start! + y.end! - y.start!);
    // второй дошёл, пока снимали первого, — ждал до конца первого снимка
    expect(y.start).toBe(x.end);
    expect(w.total).toBeGreaterThan(0);
  });
});

describe('второй процедурный кабинет делит очередь', () => {
  test('двое на забор разом: с одним кабинетом второй ждёт первого, со вторым — идёт туда и ждёт меньше', () => {
    const one = sandboxPlain();
    const two = sandboxWith('room.procedure');
    const r1 = twoDraws(one);
    const r2 = twoDraws(two);
    const [p1, p2] = roomsOf(two, 'room.procedure');
    // один кабинет — второй ждёт конца забора первого
    expect(cbcOf(r1.b).start).toBe(cbcOf(r1.a).end);
    // два — первый в первом, второй во втором, не дожидаясь
    expect([cbcOf(r2.a).draw, cbcOf(r2.b).draw]).toEqual([p1, p2]);
    expect(cbcOf(r2.b).start!).toBeLessThan(cbcOf(r2.a).end!);
    for (const [s, r] of [[one, r1], [two, r2]] as const) until(s, Math.max(cbcOf(r.a).start!, cbcOf(r.b).start!) + 1);
    const total = (s: ShiftState) => roomsOf(s, 'room.procedure').reduce((t, id) => t + waitOf(s, id).total, 0);
    expect(total(two)).toBeLessThan(total(one));
    expect(waitOf(two, p2).n).toBe(1);
  }, 60_000);

  test('его забор ещё идёт — новая пробирка к тому же забору, в тот же кабинет', () => {
    const s = sandboxWith('room.procedure');
    for (let i = 0; i < 600 && s.queue.length < 2; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const [a, b] = s.queue.slice(0, 2).map(id => s.patients[id]);
    apply(db, s, { kind: 'call', id: a.id });
    apply(db, s, { kind: 'exam', exam: CBC });
    apply(db, s, { kind: 'sendAway' });
    apply(db, s, { kind: 'call', id: b.id });
    apply(db, s, { kind: 'exam', exam: CBC });
    const x = cbcOf(b);
    expect(x.draw).toBe(roomsOf(s, 'room.procedure')[1]);
    // ещё анализ, пока у него берут кровь: одна вена — тот же забор, тот же кабинет
    apply(db, s, { kind: 'exam', exam: 'exam.calcium' });
    const y = b.pending.find(q => q.exam === 'exam.calcium')!;
    expect([y.draw, y.start, y.end]).toEqual([x.draw, x.start, x.end]);
  }, 60_000);
});

describe('лаборант ставит партию', () => {
  test('без очереди результат прежний; лаборант занят постановкой — `setup` и по пробе, с поправкой навыка', () => {
    const s = newShift(db, { seed: 21, season: 'winter' });
    const { a, b } = twoDraws(s);
    const [x, y] = [cbcOf(a), cbcOf(b)];
    const [lab] = roomsOf(s, 'room.lab');
    const ready = [x.readyAt, y.readyAt];
    // пробы обоих несут разом (часть 89) — одна партия
    expect(x.lab).toBe(y.lab);
    until(s, x.lab! + 1);
    expect([x.set, y.set]).toEqual([x.lab, y.lab]);
    expect([x.readyAt, y.readyAt]).toEqual(ready);
    const ctx = hospitalCtx(db, s);
    const pct = speedOf(db, memberAt(ctx.staff, lab, 'role.lab_tech'));
    const busy = Math.round(((db.economy.lab.setup + 2 * db.economy.lab.perSample) * MIN * pct) / 100);
    expect(s.rooms[lab]).toBe(x.lab! + busy);
    expect(waitOf(s, lab)).toEqual({ n: 2, total: 0, max: 0, busy });
  });

  test('лаборант ставит другую партию — эта ждёт, и результат позже на столько же; нанятый врач их дождётся', () => {
    const s = newShift(db, { seed: 21, season: 'winter' });
    const { a, b } = twoDraws(s);
    const [x, y] = [cbcOf(a), cbcOf(b)];
    const [lab] = roomsOf(s, 'room.lab');
    const ready = [x.readyAt, y.readyAt];
    // лаборант ещё 20 минут ставит предыдущую партию, когда эта дойдёт
    s.rooms[lab] = x.lab! + 20 * MIN;
    until(s, x.lab! + 1);
    expect([x.set, y.set]).toEqual([x.lab! + 20 * MIN, x.lab! + 20 * MIN]);
    expect([x.readyAt, y.readyAt]).toEqual(ready.map(t => t + 20 * MIN));
    const w = waitOf(s, lab);
    expect([w.n, w.total, w.max]).toEqual([2, 2 * 20 * MIN, 20 * MIN]);
    // результат — в новое время, не раньше
    until(s, ready[0] + 1);
    expect(a.results.some(r => r.exam === CBC)).toBe(false);
    until(s, x.readyAt + 1);
    expect(a.results.some(r => r.exam === CBC)).toBe(true);
  });

  test('вы ждёте результата у себя — партия без очереди, обещанное время не сдвигается', () => {
    const s = newShift(db, { seed: 21, season: 'winter' });
    for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const p = s.patients[s.queue[0]];
    apply(db, s, { kind: 'call', id: p.id });
    apply(db, s, { kind: 'exam', exam: CBC });
    const x = cbcOf(p);
    const [lab] = roomsOf(s, 'room.lab');
    const ready = x.readyAt;
    s.rooms[lab] = x.lab! + 20 * MIN;
    // он уже у вас, а проба ещё в пути: «Ждать результатов» кончится ею
    delete p.out;
    apply(db, s, { kind: 'waitResults' });
    expect(x.set).toBe(x.lab);
    expect(p.results.find(r => r.exam === CBC)?.at).toBe(ready);
    // следующая партия ждёт и её
    expect(s.rooms[lab]).toBeGreaterThan(x.lab! + 20 * MIN);
  });

  test('две лаборатории: первая занята — проба идёт во вторую; обе свободны — в первую', () => {
    const s = sandboxWith('room.lab', 'eq.hematology_analyzer');
    const [l1, l2] = roomsOf(s, 'room.lab');
    for (let i = 0; i < 600 && s.queue.length < 2; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const [a, b] = s.queue.slice(0, 2).map(id => s.patients[id]);
    apply(db, s, { kind: 'call', id: a.id });
    apply(db, s, { kind: 'exam', exam: CBC });
    apply(db, s, { kind: 'sendAway' });
    expect(cbcOf(a).room).toBe(l1);
    s.rooms[l1] = s.t + 60 * MIN;
    apply(db, s, { kind: 'call', id: b.id });
    apply(db, s, { kind: 'exam', exam: CBC });
    expect(cbcOf(b).room).toBe(l2);
  }, 60_000);

  test('сохранение 0.6.18: проба в пути без постановки — анализ по-старому', () => {
    const s = newShift(db, { seed: 21, season: 'winter' });
    const { a } = twoDraws(s);
    const x = cbcOf(a);
    // как в прежней версии: события лаборатории нет, лаборант будто занят
    s.events = s.events.filter(e => e.event.kind !== 'lab');
    const [lab] = roomsOf(s, 'room.lab');
    s.rooms[lab] = x.lab! + 20 * MIN;
    const ready = x.readyAt;
    until(s, ready + 1);
    expect(x.set).toBeUndefined();
    expect(a.results.find(r => r.exam === CBC)?.at).toBe(ready);
  });
});

/** Смену — в сессию, как после «Продолжить»: карьера 1. */
async function load(s: ShiftState) {
  const store = memoryStore();
  setStore(store);
  forgetShift();
  await saveSlot(store, 'campaign-1', s, SHIFT_SCHEMA_VERSION, 'x');
  await loadShift('campaign', 1);
}

describe('где ждали на экране', () => {
  test('итоги дня — места по убыванию среднего, первая строка — узкое место; меньше 5 минут — «Без очереди»; на карте — «Сегодня»', async () => {
    const s = newCampaign(db, { seed: 21, season: 'winter', career: 1 });
    apply(db, s, { kind: 'nextDay' });
    until(s, (s.day - 1) * DAY + SHIFT_START + 2 * 60 * MIN);
    // регистратура: человек ждал 12 минут — строкой; остальные места — быстрее
    const [reg] = roomsOf(s, 'room.reception');
    s.summary.waits = { ...s.summary.waits, [reg]: { n: 2, total: 24 * MIN, max: 15 * MIN, busy: 4 * MIN } };
    await load(s);
    const today = shiftView().rooms?.[reg]?.lines ?? [];
    // на карте — двумя строками: строка помещения в одну строку экрана, длинная обрезалась бы
    expect(today.slice(-2)).toEqual([T.sandbox.roomToday(2, false, 12), T.sandbox.roomTodayMore(15, T.sandbox.waitBusy(4))]);
    closeDay();
    const lines = shiftView().summary?.waitLines ?? [];
    expect(lines[0]).toBe(T.shift.summary.waits.line(db.rooms['room.reception'].name.ru, T.sandbox.waitWhat(2, false, 12, 15, T.sandbox.waitBusy(4))));
    const last = lines[lines.length - 1];
    expect(last.startsWith(T.shift.summary.waits.free('').slice(0, 12))).toBe(true);
    expect(last).toContain(lowerFirst(db.rooms['room.triage'].name.ru));
    forgetShift();
  }, 120_000);

  test('занятость — часами и минутами, с неразрывным пробелом', () => {
    expect(T.sandbox.waitBusy(45)).toBe('45 мин');
    expect(T.sandbox.waitBusy(60)).toBe('1 ч');
    expect(T.sandbox.waitBusy(190)).toBe('3 ч 10 мин');
  });
});
