// Экономика своей больницы (spec 2026-09-own-hospital, часть 9): кто платит, что приносит
// приём после экспертизы страховой, что стоит день, долг и процент, репутация и поток. Числа
// баланса берутся из economy.yaml — тесты проверяют правила, а не сами числа.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Cell } from '../../src/content/types';
import {
  caseIncome, confirmed, expensesOf, flowOf, incomeOf, interestOf, levelOf, payerOf, reputationAfter, salariesOf, upkeepOf,
} from '../../src/engine/economy/economy';
import { build, type BuildCommand, planOf } from '../../src/engine/hospital/build';
import { workingRooms } from '../../src/engine/hospital/requirements';
import { staffingOf } from '../../src/engine/hospital/staff';
import { indicated } from '../../src/engine/med/policy';
import { apply, candidatesOf, current, newSandbox, newShift, observationsOf } from '../../src/engine/shift/engine';
import type { Command, ShiftState } from '../../src/engine/shift/types';

const e = db.economy;
const t = e.tariffs;
const run = (s: ShiftState, ...cmds: Command[]) => {
  for (const c of cmds) apply(db, s, c);
  return s;
};
const clinic = (seed: number, budget = e.sandbox.budgets.normal) => newSandbox(db, { seed, season: 'winter', difficulty: 'doctor', start: 'clinic', budget });
const advanceUntil = (s: ShiftState, ok: () => boolean, max = 600) => {
  for (let i = 0; i < max && !ok(); i++) apply(db, s, { kind: 'advance', seconds: 60 });
};
const levelNow = (s: ShiftState) => {
  const plan = planOf(db, s.hospital!);
  const staffed = staffingOf(db, plan, s.staff ?? []);
  return levelOf(db, plan, workingRooms(db, plan, staffed));
};

describe('плательщики и поток', () => {
  test('плательщик — из ветви зерна пациента; с репутацией доля ДМС и платных растёт', () => {
    expect(payerOf(db, 7, '3-04', 50)).toBe(payerOf(db, 7, '3-04', 50));
    const shares = (rep: number) => {
      const n = { oms: 0, dms: 0, self: 0 };
      for (let i = 0; i < 4000; i++) n[payerOf(db, 1, `1-${i}`, rep)]++;
      return { dms: n.dms / 40, self: n.self / 40 };
    };
    for (const [rep, i] of [[0, 0], [50, 1], [100, 2]] as const) {
      const x = shares(rep);
      expect(Math.abs(x.dms - e.payers.dms[i])).toBeLessThan(1.5);
      expect(Math.abs(x.self - e.payers.self[i])).toBeLessThan(1.5);
    }
  });

  test('поток: при 50 — как в практике, при 0 и 100 — на `flow` % меньше и больше', () => {
    expect([flowOf(db, 0), flowOf(db, 50), flowOf(db, 100), flowOf(db, 150)]).toEqual([100 - e.flow, 100, 100 + e.flow, 100 + e.flow]);
    const patients = (rep: number) => {
      const s = clinic(31);
      s.economy!.reputation = rep;
      run(s, { kind: 'nextDay' });
      return Object.keys(s.patients).length;
    };
    expect(patients(100)).toBeGreaterThan(patients(0));
  });
});

describe('что приносит приём', () => {
  const minor = Object.values(db.conditions).find(c => c.presenting && c.severity === 'minor' && c.confirm === 'clinical')!.id;
  const flu = 'cond.influenza';

  test('ОМС: тариф по тяжести, доля по обоснованности и уровню амбулатории', () => {
    expect(caseIncome(db, 'oms', minor, [], [], 'A')).toMatchObject({ paid: t.oms.minor, cut: 0, quality: 100, unconfirmed: false, unindicated: [], level: 100 });
    expect(caseIncome(db, 'oms', minor, [], [], 'C').quality).toBe(t.omsQuality.C);
    expect(caseIncome(db, 'oms', minor, [], [], 'C').paid).toBe(Math.round((t.oms.minor * t.omsQuality.C) / 100));
    expect(caseIncome(db, 'oms', minor, [], [], 'C').cut).toBe(t.oms.minor - Math.round((t.oms.minor * t.omsQuality.C) / 100));
    // уровень — сам тариф, а не снятое экспертизой
    expect(caseIncome(db, 'oms', minor, [], [], 'A', 50)).toMatchObject({ paid: Math.round(t.oms.minor / 2), cut: 0, level: 50 });
  });

  test('ОМС: диагноз не подтверждён — доля тарифа; подтверждающее обследование оплачено, даже если было не показано', () => {
    expect(db.conditions[flu].confirm).toEqual(['exam.flu_rapid']);
    expect(confirmed(db, flu, [])).toBe(false);
    expect(confirmed(db, minor, [])).toBe(true);
    const bare = caseIncome(db, 'oms', flu, [], [], 'A');
    expect(bare).toMatchObject({ paid: Math.round((t.oms.moderate * t.omsUnconfirmed) / 100), unconfirmed: true });
    const test = db.exams['exam.flu_rapid'].cost;
    expect(caseIncome(db, 'oms', flu, ['exam.flu_rapid'], [], 'A')).toMatchObject({ paid: t.oms.moderate + Math.round((test * t.omsExam) / 100), unconfirmed: false, unindicated: [] });
  });

  test('обследования: ОМС и ДМС платят за показанные, платный пациент — за всё; не показанное — в снятом', () => {
    const cbc = db.exams['exam.cbc'].cost;
    const oms = caseIncome(db, 'oms', minor, ['exam.cbc', 'exam.ask_onset'], [], 'A');
    expect(oms).toMatchObject({ paid: t.oms.minor, cut: Math.round((cbc * t.omsExam) / 100), unindicated: ['exam.cbc'] });
    expect(caseIncome(db, 'oms', minor, ['exam.cbc'], ['exam.cbc'], 'A').paid).toBe(t.oms.minor + Math.round((cbc * t.omsExam) / 100));
    expect(caseIncome(db, 'dms', minor, ['exam.cbc'], ['exam.cbc'], 'D').paid).toBe(t.dms.visit + Math.round((cbc * t.dms.price) / 100));
    expect(caseIncome(db, 'dms', minor, ['exam.cbc'], [], 'A')).toMatchObject({ paid: t.dms.visit, unindicated: ['exam.cbc'] });
    expect(caseIncome(db, 'self', minor, ['exam.cbc'], [], 'D')).toMatchObject({ paid: t.self.visit + Math.round((cbc * t.self.price) / 100), cut: 0, unindicated: [] });
  });

  test('показано ли — по тому, что врач знал, когда назначал: так же решает разумный врач', () => {
    const s = clinic(41);
    run(s, { kind: 'nextDay' });
    advanceUntil(s, () => s.queue.length > 0);
    run(s, { kind: 'call', id: s.queue[0] });
    const p = current(s)!;
    const before = observationsOf(p);
    const want = ['exam.cbc', 'exam.tsh', 'exam.xray_chest'].filter(x => indicated(db, p.patient, before, candidatesOf(db, 'dept.therapy'), x));
    run(s, { kind: 'exam', exam: 'exam.cbc' });
    expect(p.indicated?.includes('exam.cbc') ?? false).toBe(want.includes('exam.cbc'));
    // бесплатное (расспрос) не проверяют: платить не за что
    run(s, { kind: 'exam', exam: 'exam.ask_onset' });
    expect(p.indicated ?? []).not.toContain('exam.ask_onset');
  });
});

describe('день в кассе', () => {
  test('уровень ОМС: готовая амбулатория — полный тариф; снесли лабораторию — прибавки за неё нет', () => {
    const s = clinic(51);
    expect(levelNow(s)).toEqual({ level: e.level.base + e.level.rooms['room.lab'] + e.level.rooms['room.xray'], rooms: ['room.lab', 'room.xray'] });
    const lab = s.hospital!.rooms.find(r => r.type === 'room.lab')!;
    run(s, { kind: 'build', cmd: { kind: 'demolish', room: lab.id } });
    expect(levelNow(s)).toEqual({ level: e.level.base + e.level.rooms['room.xray'], rooms: ['room.xray'] });
  });

  test('вечер: доходы за приёмы, зарплаты, содержание, расходники; касса = утро + доходы − расходы', () => {
    const s = clinic(61);
    const morning = s.economy!.cash;
    run(s, { kind: 'nextDay' });
    advanceUntil(s, () => s.queue.length > 0);
    run(s, { kind: 'call', id: s.queue[0] });
    const p = current(s)!;
    run(s, { kind: 'exam', exam: 'exam.ask_onset' }, { kind: 'exam', exam: 'exam.cbc' }, { kind: 'waitResults' },
      { kind: 'diagnose', id: 'cond.arvi' }, { kind: 'finish' }, { kind: 'closeDay' });
    const h = s.history[0].economy!;
    const payer = p.payer!;
    expect(p.paid).toBeDefined();
    expect(h.ledger.cases).toEqual({ oms: 0, dms: 0, self: 0, [payer]: 1 });
    expect(h.ledger.income[payer]).toBe(p.paid!.paid);
    expect(h.ledger.expenses.salaries).toBe(salariesOf(s.staff!));
    expect(h.ledger.expenses.consumables).toBe(Math.round((db.exams['exam.cbc'].cost * e.consumables.lab) / 100));
    const upkeep = upkeepOf(db, s.hospital!);
    expect([h.ledger.expenses.equipment, h.ledger.expenses.rooms]).toEqual([upkeep.equipment, upkeep.rooms]);
    expect(h.ledger.expenses.interest).toBe(0);
    expect(h.cash).toBe(morning + incomeOf(h.ledger) - expensesOf(h.ledger));
    expect(s.economy!.cash).toBe(h.cash);
    // остальные не приняты: оценка дня низкая, репутация вниз
    expect(h.reputation.from).toBe(e.reputation.start);
    expect(h.reputation.to).toBeLessThan(h.reputation.from);
    // следующий день — касса дня с нуля
    run(s, { kind: 'nextDay' });
    expect(incomeOf(s.economy!.ledger!) + expensesOf(s.economy!.ledger!)).toBe(0);
  });

  test('касса в минусе — процент на долг; строить не на что', () => {
    expect([interestOf(db, 1000), interestOf(db, 0), interestOf(db, -1), interestOf(db, -10_000)]).toEqual([0, 0, 1, Math.ceil((10_000 * e.interest) / 10000)]);
    const s = clinic(71, 0);
    s.economy!.cash = -100_000;
    run(s, { kind: 'nextDay' }, { kind: 'closeDay' });
    const h = s.history[0].economy!;
    const before = -100_000 + incomeOf(h.ledger) - (expensesOf(h.ledger) - h.ledger.expenses.interest);
    expect(before).toBeLessThan(0);
    expect(h.ledger.expenses.interest).toBe(interestOf(db, before));
    expect(h.cash).toBe(before - h.ledger.expenses.interest);
    const cmd: BuildCommand = { kind: 'corridor', cells: [[30, 20] as Cell] };
    expect(build(db, { hospital: s.hospital!, cash: s.economy!.cash }, cmd)).toMatchObject({ ok: false, error: { kind: 'money' } });
    const hs = s.hospital;
    run(s, { kind: 'build', cmd });
    expect(s.hospital).toBe(hs);
  });

  test('те же зерно и команды — та же касса, та же репутация', () => {
    const play = () => {
      const s = clinic(81);
      run(s, { kind: 'nextDay' });
      for (let k = 0; k < 4; k++) {
        advanceUntil(s, () => s.queue.length > 0);
        if (s.queue.length === 0) break;
        run(s, { kind: 'call', id: s.queue[0] }, { kind: 'exam', exam: 'exam.ask_onset' }, { kind: 'exam', exam: 'exam.flu_rapid' }, { kind: 'waitResults' },
          { kind: 'diagnose', id: 'cond.influenza' }, { kind: 'finish' });
      }
      run(s, { kind: 'closeDay' });
      return s;
    };
    const a = play();
    const b = play();
    expect(JSON.stringify(b.history)).toBe(JSON.stringify(a.history));
    expect(b.economy).toEqual(a.economy);
  });

  test('практика не меняется: ни плательщиков, ни кассы, ни проверки показаний', () => {
    const s = newShift(db, { seed: 91, season: 'winter' });
    advanceUntil(s, () => s.queue.length > 0);
    run(s, { kind: 'call', id: s.queue[0] }, { kind: 'exam', exam: 'exam.cbc' });
    const p = current(s)!;
    expect(p.payer).toBeUndefined();
    expect(p.indicated).toBeUndefined();
    run(s, { kind: 'waitResults' }, { kind: 'diagnose', id: 'cond.arvi' }, { kind: 'finish' }, { kind: 'closeDay' });
    expect(p.paid).toBeUndefined();
    expect(s.history[0].economy).toBeUndefined();
  });
});

describe('репутация', () => {
  const r = e.reputation;
  const day = { arrived: 10, correct: 0, wrong: 0, left: 0, unseen: 0, returned: 0, toilet: true };

  test('никто не пришёл — прежняя, без оценки', () => {
    expect(reputationAfter(db, 60, { ...day, arrived: 0 })).toEqual({ from: 60, to: 60, reasons: [] });
  });

  test('оценка дня — доли довольных и недовольных и поправки; репутация сдвигается к ней на `pull` %', () => {
    const good = reputationAfter(db, 50, { ...day, correct: 10, meanWait: 20 });
    expect(good.reasons).toEqual([{ key: 'correct', count: 10, delta: 100 }, { key: 'waitShort', count: 1, delta: r.waitShort }]);
    expect(good.score).toBe(100);
    expect(good.to).toBe(50 + Math.round((50 * r.pull) / 100));
    const bad = reputationAfter(db, 50, { ...day, correct: 5, wrong: 3, left: 2, meanWait: 120, toilet: false });
    expect(bad.reasons.map(x => [x.key, x.delta])).toEqual([['correct', 50], ['wrong', -30], ['left', -20], ['waitLong', r.waitLong], ['noToilet', r.noToilet]]);
    expect(bad.score).toBe(Math.max(0, 50 - 30 - 20 + r.waitLong + r.noToilet));
    expect(bad.to).toBe(50 + Math.round(((bad.score! - 50) * r.pull) / 100));
    expect(bad.wait).toBe(120);
    // и в пределах 0–100
    expect(reputationAfter(db, 100, { ...day, correct: 10, meanWait: 1 }).to).toBe(100);
    expect(reputationAfter(db, 0, { ...day, wrong: 10, toilet: false }).to).toBe(0);
  });
});
