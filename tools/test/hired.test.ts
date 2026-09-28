// Нанятые врачи (spec 2026-09-hired-doctors, часть 18): свой логарифм движка, терапевт на месте
// врача в другом кабинете и место в ординаторской, кого берёт врач, его приёмы в итогах дня,
// повтор дня, шаги разумного врача по одному — те же, что подряд.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { log2 } from '../../src/engine/core/math';
import { Rng } from '../../src/engine/core/rng';
import { planOf } from '../../src/engine/hospital/build';
import { layoutOf } from '../../src/engine/hospital/clinic';
import { doctorRoom, problemsOf } from '../../src/engine/hospital/requirements';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { type DoctorPhase, nextStep, runDoctor } from '../../src/engine/med/policy';
import type { Observation } from '../../src/engine/med/types';
import { apply, candidatesOf, hospitalCtx, newCampaign, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { placements } from '../../src/state/clinicMap';
import { singleResult } from '../../src/state/single';

const THERAPIST = 'role.therapist';

/** Песочница с готовой амбулаторией; справа — продлённый коридор, ординаторская и второй кабинет. */
function withSecondOffice(seed = 7, staffRoom = true): { s: ShiftState; office: string } {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  if (staffRoom) apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
  apply(db, s, { kind: 'buildEnd' });
  return { s, office: s.hospital!.rooms[s.hospital!.rooms.length - 1].id };
}

/** Терапевт нужного навыка — в штат (как нанятый кандидат) и в кабинет. */
function hireTherapist(s: ShiftState, office: string, skill = 3): StaffMember {
  const m: StaffMember = { id: 'h1', role: THERAPIST, sex: 'f', seed: 11, skill, salary: salaryOf(db, THERAPIST, skill), days: 0 };
  s.staff = [...(s.staff ?? []), m];
  apply(db, s, { kind: 'assign', id: m.id, room: office });
  return m;
}

const playIdle = (s: ShiftState) => {
  for (let i = 0; i < 14 * 60 && s.dayOpen; i++) apply(db, s, { kind: 'advance', seconds: 60 });
};

describe('свой логарифм (ADR 0004)', () => {
  test('совпадает с Math.log2 до 1e-15 относительной ошибки — от крошечных вероятностей до больших чисел', () => {
    let worst = 0;
    for (let i = 1; i <= 20000; i++) {
      for (const x of [i / 20000, 10 ** (-300 + (i * 600) / 20000)]) {
        const d = Math.abs(log2(x) - Math.log2(x)) / Math.max(1, Math.abs(Math.log2(x)));
        worst = Math.max(worst, d);
      }
    }
    expect(worst).toBeLessThan(1e-15);
    expect([log2(1), log2(2), log2(0.5), log2(1024)]).toEqual([0, 1, -1, 10]);
    expect(log2(0)).toBe(-Infinity);
    expect(Number.isNaN(log2(-1))).toBe(true);
  });
});

describe('разумный врач по шагам', () => {
  test('шаги по одному дают то же, что подряд: обследования, диагноз, уверенность и план', () => {
    const candidates = candidatesOf(db, 'dept.therapy');
    const exams = Object.keys(db.exams).sort();
    for (let i = 0; i < 40; i++) {
      const patient = generatePatient(db, 5_000 + i, { department: 'dept.therapy', season: 'winter' });
      const whole = runDoctor(db, patient, 'rational', Rng.seeded(patient.seed).fork('d'), { candidates, exams });
      const rng = Rng.seeded(patient.seed).fork('d');
      const obs: Observation[] = complaintObservations(patient);
      const done: string[] = [];
      let phase: DoctorPhase = {};
      for (let guard = 0; guard < 100; guard++) {
        const r = nextStep(db, patient, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: 0.02 });
        phase = r.phase;
        if (r.step.kind === 'decide') {
          expect({ exams: done, diagnosis: r.step.diagnosis, confidence: r.step.confidence, plan: r.step.plan })
            .toEqual({ exams: whole.exams, diagnosis: whole.diagnosis, confidence: whole.confidence, plan: whole.plan });
          break;
        }
        obs.push(...runExam(db, patient, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
        done.push(r.step.exam);
      }
    }
  });
});

describe('терапевт в своей больнице', () => {
  test('встаёт на место врача во втором кабинете и работает, пока есть место в ординаторской', () => {
    const { s, office } = withSecondOffice();
    const room = () => hospitalCtx(db, s).plan.rooms.find(r => r.id === office)!;
    const problems = () => problemsOf(db, hospitalCtx(db, s).plan, room(), hospitalCtx(db, s).staffed);
    expect(problems()).toEqual([{ kind: 'noStaff', role: THERAPIST }]);
    hireTherapist(s, office);
    expect(problems()).toEqual([]);
    // в ваш кабинет терапевта не поставить: там вы
    const mine = doctorRoom(hospitalCtx(db, s).plan)!;
    apply(db, s, { kind: 'assign', id: 'h1', room: mine });
    expect(s.staff!.find(m => m.id === 'h1')!.room).toBe(office);
    // без ординаторской — «нет места в ординаторской»
    const bare = withSecondOffice(7, false);
    hireTherapist(bare.s, bare.office);
    const plan = planOf(db, bare.s.hospital!);
    expect(problemsOf(db, plan, plan.rooms.find(r => r.id === bare.office)!, hospitalCtx(db, bare.s).staffed)).toEqual([{ kind: 'noPlace', room: 'room.staff' }]);
    expect(hospitalCtx(db, bare.s).working.has(bare.office)).toBe(false);
  });

  test('берёт новых, не «красных» и не повторных; его приёмы — в его строке итогов, ваши строки — ваши', () => {
    const { s, office } = withSecondOffice();
    hireTherapist(s, office);
    apply(db, s, { kind: 'nextDay' });
    playIdle(s);
    apply(db, s, { kind: 'closeDay' });
    const theirs = Object.values(s.patients).filter(p => p.by === 'h1');
    expect(theirs.length).toBeGreaterThan(5);
    for (const p of theirs) {
      expect(p.kind).not.toBe('return');
      expect(p.triaged !== false && p.triage === 'red').toBe(false);
    }
    const closed = theirs.filter(p => p.closed);
    expect(closed.every(p => p.closed!.by === 'h1')).toBe(true);
    const day = s.history[s.history.length - 1];
    expect(day.colleagues?.h1.seen).toBe(closed.length);
    expect(day.colleagues!.h1.correct + day.colleagues!.h1.partly + day.colleagues!.h1.wrong).toBe(closed.length);
    // вы никого не принимали — ваши строки пусты, а оценка «Смены» — по вашим приёмам
    expect(day.seen).toBe(0);
    expect(singleResult(s)).toBeUndefined();
    // у второго кабинета — своя запись: пришло больше, чем в тот же день без врача
    const alone = withSecondOffice().s;
    apply(db, alone, { kind: 'nextDay' });
    playIdle(alone);
    expect(day.arrived).toBeGreaterThan(alone.summary.arrived);
  });

  test('на карте: терапевт — в своём кабинете, его пациент — у него, а ваш кабинет — прежний', () => {
    const { s, office } = withSecondOffice();
    hireTherapist(s, office);
    apply(db, s, { kind: 'nextDay' });
    for (let i = 0; i < 240 && !Object.values(s.patients).some(p => p.status === 'inRoom' && p.by); i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const ctx = hospitalCtx(db, s);
    const layout = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role, stands: db.roles[m.role]?.stands }] : [])));
    expect(layout.mine).toBe(doctorRoom(ctx.plan));
    expect(layout.staff.some(x => x.role === 'therapist' && x.id === `therapist.${office}`)).toBe(true);
    const p = Object.values(s.patients).find(q => q.status === 'inRoom' && q.by)!;
    const at = placements(db, layout, s).find(x => x.id === p.id)!;
    expect(at.where).toEqual({ cell: layout.offices[office] });
    expect(at.doing).toEqual({ kind: 'office', by: 'h1' });
  });

  test('день с врачом по журналу повторяется точно', () => {
    const run = () => {
      const { s, office } = withSecondOffice(21);
      hireTherapist(s, office, 2);
      apply(db, s, { kind: 'nextDay' });
      for (let i = 0; i < 90; i++) apply(db, s, { kind: 'advance', seconds: 60 });
      // вы тоже принимаете: зовёте первого из очереди, расспрос — и решение
      const id = s.queue[0];
      apply(db, s, { kind: 'call', id });
      apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
      apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
      apply(db, s, { kind: 'finish' });
      playIdle(s);
      return JSON.stringify({ patients: s.patients, summary: s.summary });
    };
    expect(run()).toBe(run());
  });

  test('в кампании терапевтов нет, пока глава не строит ординаторскую; в песочнице — есть', () => {
    const c = newCampaign(db, { seed: 3, season: 'winter', career: 1 });
    expect(c.candidates!.some(m => m.role === THERAPIST)).toBe(false);
    const sandboxRoles = new Set<string>();
    for (let seed = 1; seed <= 6; seed++) for (const m of newSandbox(db, { seed, season: 'winter', start: 'empty', budget: 1 }).candidates!) sandboxRoles.add(m.role);
    expect(sandboxRoles.has(THERAPIST)).toBe(true);
  });
});
