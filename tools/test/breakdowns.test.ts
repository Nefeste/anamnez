// Поломки аппаратов (FR-EQ-1, FR-EQ-3, 0.5.9; spec 2026-10-walk-breakdowns): с утра аппарат обследований может не
// включиться — до конца дня его будто нет, обследование «в ремонте», а есть второй — делают на нём; к завтра починят,
// ремонт — в расходах дня; в учебный день главы поломок нет; каталог аппаратов — с надёжностью.
import { afterEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { P_ONE } from '../../src/engine/core/rng';
import { expensesOf } from '../../src/engine/economy/economy';
import { layoutOf } from '../../src/engine/hospital/clinic';
import { examWhere, NONE_BROKEN, slotKey } from '../../src/engine/hospital/requirements';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { apply, breakdowns, breaks, brokenOf, examsHere, hospitalCtx, newCampaign, newSandbox, readyIn, REPAIR_PCT } from '../../src/engine/shift/engine';
import { SHIFT_SCHEMA_VERSION, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { roomSigns } from '../../src/state/roomSigns';
import { memoryStore, saveSlot } from '../../src/state/saves';
import { cashView, equipmentLine, examBlockText } from '../../src/state/sandboxView';
import { callPatient, forgetShift, loadShift, nextDay, SANDBOX_SLOT, setStore, shiftCaseView, shiftView, startSandbox, tick } from '../../src/state/session';

const XRAY = 'exam.xray_chest';
const CBC = 'exam.cbc';
const budget = db.economy.sandbox.budgets.generous;
const sandbox = (seed: number) => newSandbox(db, { seed, season: 'winter', difficulty: 'doctor', start: 'clinic', budget });
const roomOf = (s: ShiftState, type: string) => hospitalCtx(db, s).plan.rooms.find(r => r.type === type)!;
const where = (s: ShiftState, exam: string) => {
  const ctx = hospitalCtx(db, s);
  return examWhere(db, ctx.plan, ctx.working, ctx.staffed, exam, brokenOf(s));
};

/** Жребий утра дня `day` без самого дня: те же ветви, что у `nextDay`. */
function drawOn(s: ShiftState, day: number): string[] {
  const was = s.day;
  s.day = day;
  const out = breakdowns(db, s);
  s.day = was;
  return out;
}

/** Зерно, при котором в амбулатории песочницы в день `day` сломается только рентген, а назавтра — ничего. */
function seedWithXrayDown(day = 1): number {
  for (let seed = 1; seed < 5000; seed++) {
    const s = sandbox(seed);
    const key = slotKey(roomOf(s, 'room.xray').id, 0);
    if (drawOn(s, day).join() === key && drawOn(s, day + 1).length === 0) return seed;
  }
  throw new Error('за 5000 зёрен не нашлось');
}

afterEach(() => forgetShift());

describe('каталог', () => {
  test('ломаются аппараты обследований; монитор у постели, наркозный и дыхательный аппараты и операционный стол — нет', () => {
    const all = Object.values(db.equipment);
    expect(all.filter(e => !breaks(e)).map(e => e.id).sort()).toEqual(['eq.anesthesia', 'eq.monitor_defib', 'eq.or_table', 'eq.ventilator']);
    for (const e of all.filter(breaks)) expect(e.breakdown).toBeGreaterThan(0);
    // у большинства — 1 из 100 рабочих дней, у старых и сложных — 1,5, у электрокардиографа — 0,5
    const other = all.filter(e => breaks(e) && e.breakdown !== 100);
    expect(Object.fromEntries(other.map(e => [e.id, e.breakdown]))).toEqual({
      'eq.ct_16': 150, 'eq.ecg': 50, 'eq.mri_15': 150, 'eq.videoendoscope': 150, 'eq.xray_analog': 150,
    });
  });

  test('строка каталога: цена и обслуживание, время и точность, если они не как записано, и как часто ломается', () => {
    const t = T.sandbox;
    const rub = T.common.rub;
    expect(equipmentLine(db, 'eq.xray_digital')).toBe(`${t.eqLine(rub(350000), rub(250))} · ${t.eqReliability(100)}`);
    expect(equipmentLine(db, 'eq.xray_analog')).toBe([
      t.eqLine(rub(db.equipment['eq.xray_analog'].price), rub(db.equipment['eq.xray_analog'].upkeep)), t.eqSpeed('1,3'), t.eqQuality('−6', '−3'), t.eqReliability(67),
    ].join(' · '));
    expect(equipmentLine(db, 'eq.ecg')).toEndWith(t.eqReliability(200));
    expect(equipmentLine(db, 'eq.monitor_defib')).toEndWith(t.eqBackup);
    expect(t.eqReliability(100)).toBe('ломается в среднем раз в 100 рабочих дней');
    expect(t.eqReliability(67)).toBe('ломается в среднем раз в 67 рабочих дней');
    expect(t.eqQuality('−6', '−3')).toBe('чувствительность −6, специфичность −3 п. п.');
  });
});

describe('жребий утра', () => {
  test('за 20 000 дней доля поломок у каждого аппарата амбулатории — как в каталоге; у каждого свой жребий', () => {
    const s = sandbox(5);
    const n = 20000;
    const count = new Map<string, number>();
    const days = new Map<string, Set<number>>();
    for (let d = 1; d <= n; d++) {
      for (const k of drawOn(s, d)) {
        count.set(k, (count.get(k) ?? 0) + 1);
        days.set(k, (days.get(k) ?? new Set()).add(d));
      }
    }
    const slots = hospitalCtx(db, s).plan.rooms.flatMap(r => r.equipment.flatMap((id, slot) => (id && breaks(db.equipment[id]) ? [{ key: slotKey(r.id, slot), id }] : [])));
    // лаборатория — четыре анализатора, ЭКГ и рентген
    expect(slots.map(x => x.id).sort()).toEqual(['eq.biochem_analyzer', 'eq.ecg', 'eq.hematology_analyzer', 'eq.immuno_analyzer', 'eq.urine_analyzer', 'eq.xray_digital']);
    for (const { key, id } of slots) {
      const p = db.equipment[id].breakdown / P_ONE;
      const sd = Math.sqrt(n * p * (1 - p));
      expect({ key, off: Math.abs((count.get(key) ?? 0) - n * p) < 4 * sd }).toEqual({ key, off: true });
    }
    expect([...count.keys()].sort()).toEqual(slots.map(x => x.key).sort());
    // у двух анализаторов в одни и те же дни — редко: 20 000 × 1/100 × 1/100 = 2
    const [a, b] = slots.filter(x => x.id.includes('analyzer')).map(x => days.get(x.key)!);
    expect([...a].filter(d => b.has(d)).length).toBeLessThan(12);
  });

  test('жребий — по зерну и дню: та же песочница — те же поломки, другое зерно — другие', () => {
    const [a, b, c] = [sandbox(5), sandbox(5), sandbox(6)];
    const run = (s: ShiftState) => Array.from({ length: 2000 }, (_, i) => drawOn(s, i + 1).join(','));
    expect(run(a)).toEqual(run(b));
    expect(run(a)).not.toEqual(run(c));
  });

  test('в учебный день главы поломок нет, хотя жребий выпал бы; в другие дни главы — бывают', () => {
    // глава 1 — сельская амбулатория: из аппаратов обследований там только электрокардиограф, 1 из 200 дней
    let found: ShiftState | undefined;
    for (let seed = 1; seed < 3000 && !found; seed++) {
      const s = newCampaign(db, { seed, season: 'winter', career: 1 });
      if (drawOn({ ...s, campaign: undefined }, s.campaign!.since + 1).length > 0) found = s;
    }
    const s = found!;
    const first = s.campaign!.since + 1;
    expect(drawOn(s, first)).toEqual([]);
    // первый день главы — учебный: с утра всё работает
    apply(db, s, { kind: 'nextDay' });
    expect([s.day, s.broken]).toEqual([first, undefined]);
    expect(Array.from({ length: 2000 }, (_, i) => drawOn(s, first + 1 + i)).some(x => x.length > 0)).toBe(true);
  });
});

describe('день с поломкой', () => {
  test('сломан рентген: снимка нет — «в ремонте — починят к завтра», время не идёт; назавтра починен', () => {
    const seed = seedWithXrayDown();
    const s = sandbox(seed);
    apply(db, s, { kind: 'nextDay' });
    const xray = roomOf(s, 'room.xray');
    expect(s.broken).toEqual([slotKey(xray.id, 0)]);
    const w = where(s, XRAY);
    expect(w).toEqual({ block: { kind: 'broken', room: 'room.xray', equipment: ['eq.xray_digital'] } });
    expect('block' in w && examBlockText(db, w.block)).toBe('цифровой рентгеновский аппарат в ремонте — починят к завтра');
    // в больнице он есть: без поломок обследование можно
    const ctx = hospitalCtx(db, s);
    expect(examWhere(db, ctx.plan, ctx.working, ctx.staffed, XRAY)).toEqual({ rooms: [xray.id] });
    // пациенту — нельзя: срока нет, назначение ничего не меняет
    for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 5 * 60 });
    const p = s.patients[s.queue[0]];
    apply(db, s, { kind: 'call', id: p.id });
    expect(readyIn(db, s, p, XRAY)).toBeUndefined();
    const [t, done] = [s.t, p.done.length];
    apply(db, s, { kind: 'exam', exam: XRAY });
    expect([s.t, p.done.length, p.pending.some(x => x.exam === XRAY)]).toEqual([t, done, false]);
    // анализы — как всегда
    expect(readyIn(db, s, p, CBC)).toBeDefined();
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
    expect(s.broken).toBeUndefined();
    expect(where(s, XRAY)).toEqual({ rooms: [xray.id] });
  });

  test('ремонт — в расходах дня: 2 % цены аппарата, строкой «Ремонт аппаратов»; без поломок строки нет', () => {
    const seed = seedWithXrayDown();
    const s = sandbox(seed);
    apply(db, s, { kind: 'nextDay' });
    apply(db, s, { kind: 'closeDay' });
    const e = s.summary.economy!;
    const price = db.equipment['eq.xray_digital'].price;
    expect(REPAIR_PCT).toBe(2);
    expect(e.ledger.expenses.repairs).toBe(Math.round((price * REPAIR_PCT) / 100));
    expect(e.ledger.expenses.repairs).toBe(7000);
    const { repairs, ...rest } = e.ledger.expenses;
    expect(expensesOf(e.ledger)).toBe(expensesOf({ ...e.ledger, expenses: rest }) + repairs!);
    expect(cashView(db, e).expenses.find(x => x.key === 'repairs')).toEqual({ key: 'repairs', title: T.sandbox.expense.repairs, sum: T.common.rub(7000) });
    apply(db, s, { kind: 'nextDay' });
    apply(db, s, { kind: 'closeDay' });
    expect(s.summary.economy!.ledger.expenses.repairs).toBeUndefined();
    expect(cashView(db, s.summary.economy!).expenses.some(x => x.key === 'repairs')).toBe(false);
  });

  test('сломан один анализатор — его анализов нет, остальные делают; лаборатория работает', () => {
    const s = sandbox(5);
    apply(db, s, { kind: 'nextDay' });
    const lab = roomOf(s, 'room.lab');
    const slot = lab.equipment.indexOf('eq.hematology_analyzer');
    s.broken = [slotKey(lab.id, slot)];
    expect(where(s, CBC)).toEqual({ block: { kind: 'broken', room: 'room.lab', equipment: ['eq.hematology_analyzer'] } });
    expect(where(s, 'exam.creatinine')).toEqual({ rooms: [lab.id] });
  });

  test('есть второй рентген-кабинет — снимок делают в нём; список обследований нанятого врача — по сломанному сегодня', () => {
    const s = sandbox(5);
    s.economy!.cash = 2_000_000;
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.xray', size: 'M', x: 30, y: 10, rot: 2 } });
    const second = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: second, equipment: 'eq.xray_analog' } });
    apply(db, s, { kind: 'buildEnd' });
    const hire = (id: string, role: string) => {
      const m: StaffMember = { id, role, sex: 'f', seed: 300 + id.length, skill: 3, salary: salaryOf(db, role, 3), days: 0 };
      s.staff = [...s.staff!, m];
      apply(db, s, { kind: 'assign', id: m.id, room: second });
    };
    hire('x1', 'role.radiographer');
    hire('x22', 'role.radiologist');
    apply(db, s, { kind: 'nextDay' });
    delete s.broken;
    const first = roomOf(s, 'room.xray').id;
    expect(where(s, XRAY)).toEqual({ rooms: [first, second] });
    expect(examsHere(db, s)).toContain(XRAY);
    s.broken = [slotKey(first, 0)];
    expect(where(s, XRAY)).toEqual({ rooms: [second] });
    for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 5 * 60 });
    const p = s.patients[s.queue[0]];
    apply(db, s, { kind: 'call', id: p.id });
    apply(db, s, { kind: 'exam', exam: XRAY });
    expect(p.pending.find(x => x.exam === XRAY)!.room).toBe(second);
    // сломаны оба — «в ремонте» с обоими аппаратами; нанятый врач снимка не назначит, а назавтра — снова
    s.broken = [slotKey(first, 0), slotKey(second, 0)];
    expect(where(s, XRAY)).toEqual({ block: { kind: 'broken', room: 'room.xray', equipment: ['eq.xray_digital', 'eq.xray_analog'] } });
    expect(examsHere(db, s)).not.toContain(XRAY);
    delete s.broken;
    expect(examsHere(db, s)).toContain(XRAY);
  });

  test('на карте смены у помещения со сломанным аппаратом — знак «в ремонте»; открыли сохранение посреди дня — строка в журнале снова', async () => {
    const s = sandbox(5);
    apply(db, s, { kind: 'nextDay' });
    const ctx = hospitalCtx(db, s);
    const layout = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
    const xray = roomOf(s, 'room.xray').id;
    s.broken = [slotKey(xray, 0)];
    expect(roomSigns(layout, s).filter(x => x.broken).map(x => x.id)).toEqual([xray]);
    const store = memoryStore();
    setStore(store);
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    expect(shiftView().log.map(l => l.text)).toEqual([T.shift.notice.broken('Цифровой рентгеновский аппарат', 'Рентген-кабинет')]);
    delete s.broken;
    expect(roomSigns(layout, s).some(x => x.broken)).toBe(false);
  });

  test('старое сохранение без поломок: всё работает', () => {
    const s = sandbox(5);
    apply(db, s, { kind: 'nextDay' });
    delete s.broken;
    expect(brokenOf(s)).toBe(NONE_BROKEN);
    expect(where(s, XRAY)).toEqual({ rooms: [roomOf(s, 'room.xray').id] });
  });

  test('день с поломкой по журналу повторяется точно', () => {
    const s = sandbox(seedWithXrayDown());
    apply(db, s, { kind: 'nextDay' });
    expect(s.broken).toHaveLength(1);
    const start = structuredClone(s);
    for (let k = 0; k < 6; k++) {
      for (let i = 0; i < 60 && s.queue.length === 0 && s.dayOpen; i++) apply(db, s, { kind: 'advance', seconds: 5 * 60 });
      if (s.queue.length === 0) break;
      apply(db, s, { kind: 'call', id: s.queue[0] });
      apply(db, s, { kind: 'exam', exam: XRAY });
      apply(db, s, { kind: 'exam', exam: CBC });
      apply(db, s, { kind: 'sendAway' });
    }
    apply(db, s, { kind: 'closeDay' });
    for (const cmd of s.journal) apply(db, start, cmd);
    expect(JSON.stringify({ patients: start.patients, summary: start.summary, broken: start.broken })).toBe(JSON.stringify({ patients: s.patients, summary: s.summary, broken: s.broken }));
  });

  test('журнал смены: утром — «Не работает: … — починят к завтра» первой строкой; в карте пациента снимок — серым с причиной', () => {
    const seed = seedWithXrayDown();
    setStore(memoryStore());
    startSandbox({ start: 'clinic', budget: 'generous', difficulty: 'doctor', seed, season: 'winter' });
    nextDay();
    expect(shiftView().dayOpen).toBe(true);
    expect(shiftView().log[0]?.text).toBe(T.shift.notice.broken('Цифровой рентгеновский аппарат', 'Рентген-кабинет'));
    expect(T.shift.notice.broken('Цифровой рентгеновский аппарат', 'Рентген-кабинет')).toBe('Не работает: цифровой рентгеновский аппарат (рентген-кабинет) — починят к завтра');
    for (let i = 0; i < 180 && shiftView().queue.length === 0; i++) tick(1000);
    expect(callPatient(shiftView().queue[0].id)).toBe(true);
    expect(shiftCaseView()!.unavailable[XRAY]).toBe('цифровой рентгеновский аппарат в ремонте — починят к завтра');
    expect(shiftCaseView()!.unavailable[CBC]).toBeUndefined();
  });
});
