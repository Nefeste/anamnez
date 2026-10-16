// Быстродействие смены (0.5.11, NFR-PRF-1; spec 2026-10-performance): разбор приёма — и ваших, и нанятых врачей —
// считается заранее, в паузах игры, и тот же, что подряд; время проматывается срезами — состояние то же, что одним
// куском. С 0.5.16 разумный врач не считает пользу обследования, которое и с наибольшей возможной не обгонит лучшее.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { runDoctor, startRational } from '../../src/engine/med/policy';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { contextOf, expectedGain, gainBound, posterior } from '../../src/engine/med/infer';
import { apply, candidatesOf, newSandbox, prepareReview, reviewedCase, reviewOf } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';

/** Амбулатория песочницы; первый пришедший — у вас в кабинете. */
function withPatient(seed = 13): { s: ShiftState; p: ShiftPatient } {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  apply(db, s, { kind: 'nextDay' });
  delete s.broken;
  for (let i = 0; i < 120 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const p = s.patients[s.queue[0]];
  apply(db, s, { kind: 'call', id: p.id });
  return { s, p };
}

/** Посчитать заранее всё, что можно (`prepareReview`), как в долгой паузе; сколько шагов. */
function prepareAll(s: ShiftState): number {
  let n = 0;
  while (prepareReview(db, s)) n++;
  return n;
}

/** Спросить о жалобах, послушать лёгкие, поставить ОРВИ и закрыть приём. */
function closeIt(s: ShiftState) {
  for (const exam of ['exam.ask_complaints', 'exam.lung_auscultation']) apply(db, s, { kind: 'exam', exam });
  apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
  apply(db, s, { kind: 'finish' });
}

describe('разбор заранее', () => {
  test('разумный врач по шагу — то же, что подряд: обследования, диагноз, уверенность, деньги и минуты', () => {
    const departments = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
    const candidates = candidatesOf(db, departments);
    const exams = Object.keys(db.exams).sort();
    for (let i = 0; i < 12; i++) {
      const p = generatePatient(db, 9_300_000 + i, { department: 'dept.therapy', departments, season: 'winter' });
      const whole = runDoctor(db, p, 'rational', Rng.seeded(5).fork(`r:${i}`), { candidates: [...candidates], exams: [...exams] });
      const run = startRational(db, p, Rng.seeded(5).fork(`r:${i}`), { candidates: [...candidates], exams: [...exams] });
      let steps = 0;
      while (!run.step()) steps++;
      expect(run.result()).toEqual(whole);
      expect(steps).toBe(whole.exams.length);
    }
  });

  test('посчитанный заранее разбор — тот же, что без этого; закрытый приём — тоже; разбор после закрытия не пересчитывается', () => {
    const a = withPatient();
    const b = withPatient();
    // пока «игрок думает» — часть шагов разумного врача разбора; состояния смены это не меняет
    const before = structuredClone(a.s);
    for (let i = 0; i < 3; i++) prepareReview(db, a.s);
    expect(a.s).toEqual(before);
    closeIt(a.s);
    closeIt(b.s);
    expect(a.p.closed).toEqual(b.p.closed);
    const ra = reviewOf(db, a.s, a.p, a.p.closed!.diagnosis);
    expect(ra).toEqual(reviewOf(db, b.s, b.p, b.p.closed!.diagnosis));
    // экран разбора и архив профиля берут запомненный
    expect(reviewOf(db, a.s, a.p, a.p.closed!.diagnosis)).toBe(ra);
  });

  test('уверенность разбора — заранее, по результату за раз: та же, что подряд, и у закрытия приёма', () => {
    const a = withPatient(17);
    const b = withPatient(17);
    expect(prepareAll(a.s)).toBeGreaterThan(0);
    expect(prepareReview(db, a.s)).toBe(false);
    // новый результат — считать снова есть что: уверенность после него
    const before = a.p.results.length;
    for (const s of [a.s, b.s]) apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    expect(a.p.results.length).toBe(before + 1);
    expect(prepareAll(a.s)).toBeGreaterThan(0);
    closeIt(a.s);
    closeIt(b.s);
    expect(a.p.closed).toEqual(b.p.closed);
    expect(reviewOf(db, a.s, a.p, a.p.closed!.diagnosis)).toEqual(reviewOf(db, b.s, b.p, b.p.closed!.diagnosis));
  });
});

describe('нанятый врач', () => {
  /** Амбулатория песочницы с терапевтом навыка 3 во втором кабинете, первый день открыт. */
  function withColleague(): ShiftState {
    const s = newSandbox(db, { seed: 7, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
    apply(db, s, { kind: 'buildEnd' });
    const office = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    const m: StaffMember = { id: 'h1', role: 'role.therapist', sex: 'f', seed: 11, skill: 3, salary: salaryOf(db, 'role.therapist', 3), days: 0 };
    s.staff = [...(s.staff ?? []), m];
    apply(db, s, { kind: 'assign', id: m.id, room: office });
    apply(db, s, { kind: 'nextDay' });
    return s;
  }

  test('его разбор — заранее, в паузах: смена та же, что без этого; бережливость — против разумного врача разбора', () => {
    const a = withColleague();
    const b = structuredClone(a);
    let steps = 0;
    for (let i = 0; i < 4 * 60 && a.dayOpen; i++) {
      // пауза перед каждой минутой: у пришедших и у приёмов нанятого врача разумный врач разбора считается заранее
      steps += prepareAll(a);
      for (const s of [a, b]) apply(db, s, { kind: 'advance', seconds: 60 });
    }
    expect(steps).toBeGreaterThan(0);
    expect(a).toEqual(b);
    const theirs = Object.values(a.patients).filter(p => p.closed?.by === 'h1');
    expect(theirs.length).toBeGreaterThan(3);
    for (const p of theirs) {
      const r = reviewOf(db, a, p, p.closed!.diagnosis).rational;
      // разбор нанятого врача — по требованию: среди дня читается через reviewedCase (tools/test/lazy-review.test.ts)
      const closed = reviewedCase(db, a, p)!;
      expect(closed.rationalCost).toBe(r.cost);
      expect(closed.rationalMoney).toBe(r.money);
    }
  }, 60_000);
});

describe('время срезами', () => {
  test('промотать минуту четырьмя срезами по 15 секунд — то же, что минутой: события те же', () => {
    const one = withPatient(21).s;
    const four = structuredClone(one);
    for (const s of [one, four]) apply(db, s, { kind: 'sendAway' });
    for (let i = 0; i < 60; i++) {
      apply(db, one, { kind: 'advance', seconds: 60 });
      for (let k = 0; k < 4; k++) apply(db, four, { kind: 'advance', seconds: 15 });
    }
    expect(four).toEqual(one);
  });
});

describe('граница пользы', () => {
  test('польза обследования не больше границы — на каждом шаге разумного врача, у каждого обследования', () => {
    const departments = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
    const candidates = candidatesOf(db, departments);
    const exams = Object.keys(db.exams).sort();
    let checked = 0;
    let below = 0;
    let excess = -Infinity;
    for (let i = 0; i < 6; i++) {
      const p = generatePatient(db, 9_400_000 + i, { department: 'dept.therapy', departments, season: 'winter' });
      const r = runDoctor(db, p, 'rational', Rng.seeded(5).fork(`b:${i}`), { candidates: [...candidates], exams: [...exams] });
      const rng = Rng.seeded(7).fork(`b:${i}`);
      const obs = complaintObservations(p);
      for (const done of [undefined, ...r.exams]) {
        if (done) obs.push(...runExam(db, p, done, rng.fork(done)));
        const ctx = contextOf(db, p, obs);
        const beliefs = posterior(db, candidates, obs, ctx);
        const observed = new Set(obs.map(o => o.f));
        for (const id of exams) {
          const gain = expectedGain(db, id, beliefs, ctx, observed);
          const most = gainBound(db, id, beliefs, ctx, observed);
          excess = Math.max(excess, gain - most);
          if (most < 0.05) below++;
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
    // запас врача — 1e-9 (`BOUND_SLACK` в policy.ts): расхождение последних битов много меньше
    expect(excess).toBeLessThan(1e-12);
    // и граница не пустая: у многих обследований она мала — их и не считают
    expect(below / checked).toBeGreaterThan(0.3);
  });
});
