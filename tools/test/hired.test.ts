// Нанятые врачи (spec 2026-09-hired-doctors, часть 18): свой логарифм движка, терапевт на месте
// врача в другом кабинете и место в ординаторской, кого берёт врач, его приёмы в итогах дня,
// повтор дня, шаги разумного врача по одному — те же, что подряд.
import { beforeEach, describe, expect, test } from 'bun:test';
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
import { T } from '../../src/i18n';
import { placements } from '../../src/state/clinicMap';
import { memoryStore } from '../../src/state/saves';
import {
  assign, buildAction, buildView, callPatient, chooseDiagnosis, closeDay, endBuild, finishCase, fire, forgetShift, hire, leaveCase, nextDay, openCase,
  openColleagueCase, setSpeed, setStore, shiftCaseView, shiftState, shiftView, staffView, startSandbox, takeOver, tick,
} from '../../src/state/session';
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

describe('забрать себе (часть 19)', () => {
  // `mine` — сначала позвать к себе первого из очереди: вы заняты
  const withBusyColleague = (seed = 7, want: 'inRoom' | 'away' = 'inRoom', mine = false) => {
    const { s, office } = withSecondOffice(seed);
    hireTherapist(s, office);
    apply(db, s, { kind: 'nextDay' });
    const start = structuredClone(s);
    if (mine) {
      for (let i = 0; i < 400 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
      apply(db, s, { kind: 'call', id: s.queue[0] });
    }
    for (let i = 0; i < 400 && !Object.values(s.patients).some(p => p.by === 'h1' && p.status === want && p.results.length > 1); i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const p = Object.values(s.patients).find(q => q.by === 'h1' && q.status === want && q.results.length > 1)!;
    return { s, p, start };
  };

  test('вы свободны — пациент со всем, что пришло, у вас в кабинете; закрыли — приём ваш, «забран у врача»', () => {
    const { s, p, start } = withBusyColleague();
    const results = JSON.stringify(p.results);
    // шаг врача и его время записаны вперёд: начатый вопрос врач доделывает, ожидание у него — не в счёт
    const step = s.events.find(e => e.event.kind === 'colleague' && e.event.id === p.id)!;
    const busy = Math.max(s.t, ...p.results.map(r => r.at));
    const spent = p.spent.seconds - Math.max(0, step.t - busy);
    apply(db, s, { kind: 'takeOver', id: p.id });
    expect(s.t).toBe(busy + 60);
    expect(p.results.every(r => r.at <= s.t)).toBe(true);
    expect(s.current).toBe(p.id);
    expect([p.by, p.from, p.status]).toEqual([undefined, 'h1', 'inRoom']);
    expect(JSON.stringify(p.results.slice(0, JSON.parse(results).length))).toBe(results);
    expect(s.summary.colleagues?.h1.taken).toBe(1);
    expect(p.spent.seconds).toBe(spent + 60);
    expect(s.events.some(e => e.event.kind === 'colleague' && e.event.id === p.id)).toBe(false);
    // прежний шаг врача не закрывает приём за вас
    for (let i = 0; i < 30; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    expect(p.closed).toBeUndefined();
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    expect([p.closed?.by, p.closed?.from]).toEqual([undefined, 'h1']);
    expect(s.summary.seen).toBe(1);
    // день с «Забрать себе» по журналу повторяется точно
    playIdle(s);
    for (const cmd of s.journal) apply(db, start, cmd);
    expect(JSON.stringify({ patients: start.patients, summary: start.summary })).toBe(JSON.stringify({ patients: s.patients, summary: s.summary }));
  });

  test('вы заняты — он в вашей очереди по времени прихода; ушедший на обследования вернётся к вам', () => {
    const busy = withBusyColleague(9, 'inRoom', true);
    const mine = busy.s.current!;
    expect(mine).toBeDefined();
    apply(db, busy.s, { kind: 'takeOver', id: busy.p.id });
    expect([busy.p.status, busy.p.by, busy.s.current]).toEqual(['waiting', undefined, mine]);
    // как вернувшийся с результатами: впереди тех, кто пришёл позже, если они не срочнее
    for (let i = 0; i < 40; i++) apply(db, busy.s, { kind: 'advance', seconds: 60 });
    const green = (id: string) => busy.s.patients[id].triaged === false || busy.s.patients[id].triage === 'green';
    const later = busy.s.queue.filter(id => busy.s.patients[id].arriveT > busy.p.arriveT && green(id));
    expect(green(busy.p.id) && later.length > 0).toBe(true);
    for (const id of later) expect(busy.s.queue.indexOf(busy.p.id)).toBeLessThan(busy.s.queue.indexOf(id));
    const away = withBusyColleague(11, 'away');
    apply(db, away.s, { kind: 'takeOver', id: away.p.id });
    expect(away.p.status).toBe('away');
    for (let i = 0; i < 180 && away.p.status === 'away'; i++) apply(db, away.s, { kind: 'advance', seconds: 60 });
    expect(away.p.status === 'waiting' && away.s.queue.includes(away.p.id)).toBe(true);
    expect(away.p.by).toBeUndefined();
  });

  test('забрать нельзя своего, закрытого или когда день закрыт', () => {
    const { s, p } = withBusyColleague(7, 'inRoom', true);
    const before = JSON.stringify(s.patients);
    expect(s.current).toBeDefined();
    apply(db, s, { kind: 'takeOver', id: s.current! });
    expect(JSON.stringify(s.patients)).toBe(before);
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'takeOver', id: p.id });
    expect(p.from).toBeUndefined();
  });
});

describe('«У врачей» и разбор приёма врача (часть 19, экраны)', () => {
  beforeEach(() => {
    setStore(memoryStore());
    forgetShift();
  });

  /** Песочница сессии с терапевтом во втором кабинете, день 1 открыт. */
  const openWithTherapist = () => {
    startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'doctor', seed: 43, season: 'winter' });
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    expect(buildAction({ kind: 'corridor', cells })).toBeNull();
    expect(buildAction({ kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 })).toBeNull();
    expect(buildAction({ kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 })).toBeNull();
    endBuild();
    const office = buildView()!.plan.rooms[buildView()!.plan.rooms.length - 1].id;
    const therapist = staffView()!.candidates.find(c => c.role === THERAPIST)!;
    hire(therapist.id);
    assign(therapist.id, office);
    nextDay();
    expect(shiftView().dayOpen).toBe(true);
  };
  // минута на карте; автопауза («красный», результаты) — снять
  const minute = () => {
    if (shiftView().paused) setSpeed(1);
    tick(1000);
  };
  const withResults = (id: string) => shiftState()!.patients[id].status === 'inRoom' && shiftState()!.patients[id].results.length > 1;
  const busyWithResults = () => shiftView().colleagues.find(c => withResults(c.id));

  test('раздел «У врачей», карта только для чтения, «Забрать себе»; в итогах — его приёмы к разбору', () => {
    openWithTherapist();
    for (let i = 0; i < 400 && !busyWithResults(); i++) minute();
    const row = busyWithResults()!;
    const t = T.shift.colleagueCase;
    expect(row.hint).toMatch(/^терапевт .+ · на приёме с \d\d:\d\d$/);
    expect(shiftView().who[row.id]?.colleague).toBe(true);
    // открыть: видно, что врач узнал, а действий и решения нет; что он выясняет сейчас — «будет в…»
    openColleagueCase(row.id);
    const v = shiftCaseView()!;
    const now = shiftState()!.t;
    const asking = shiftState()!.patients[row.id].results.filter(r => r.at > now).length;
    expect(v.results.length).toBe(shiftState()!.patients[row.id].results.filter(r => r.at <= now).reduce((n, r) => n + r.obs.length, 0));
    expect(v.pending.length).toBe(asking + shiftState()!.patients[row.id].pending.length);
    expect(v.colleague?.id).toBe(row.id);
    expect(v.colleague?.doctor).toMatch(/^терапевт /);
    expect(v.done.length).toBeGreaterThan(1);
    expect(v.groups.length).toBeGreaterThan(0);
    expect(v.decision).toBeUndefined();
    leaveCase();
    expect(shiftCaseView()).toBeUndefined();
    // забрать: вы свободны — он у вас в кабинете и больше не «у врачей»
    expect(takeOver(row.id)).toBe(true);
    expect(shiftView().inRoom?.id).toBe(row.id);
    expect(shiftCaseView()!.colleague).toBeUndefined();
    expect(shiftView().colleagues.some(c => c.id === row.id)).toBe(false);
    expect(shiftView().log.some(l => l.kind === 'taken')).toBe(false);
    chooseDiagnosis('cond.arvi');
    finishCase();
    expect(shiftCaseView()!.byDoctor).toBeUndefined();
    // врач тем временем принимает дальше
    for (let i = 0; i < 180 && !Object.values(shiftState()!.patients).some(p => p.closed?.by); i++) minute();
    closeDay();
    const sum = shiftView().summary!;
    expect(sum.cases.map(c => c.id)).toContain(row.id);
    expect(sum.colleagues).toHaveLength(1);
    const col = sum.colleagues[0];
    expect(col.line).toEndWith(' · вы забрали: 1');
    expect(col.cases.length).toBeGreaterThan(0);
    expect(col.cases.some(c => c.id === row.id)).toBe(false);
    // разбор приёма врача — как ваш, с его именем; глагол — по полу врача
    const m = shiftState()!.staff!.find(x => x.role === THERAPIST)!;
    openCase(col.cases[0].id);
    const r = shiftCaseView()!;
    expect(r.byDoctor).toBe(`Приём ${m.sex === 'f' ? 'вела' : 'вёл'} ${v.colleague!.doctor}`);
    expect(r.decision).toBeDefined();
    expect(t.note(v.colleague!.doctor)).toStartWith(`Приём ведёт ${v.colleague!.doctor}.`);
    // врача уволили между сменами — его приём остаётся к разбору, без имени
    fire(m.id);
    expect(shiftState()!.staff!.some(x => x.id === m.id)).toBe(false);
    openCase(col.cases[0].id);
    expect(shiftCaseView()!.byDoctor).toBe(T.spikes.patient.byGone);
    expect(shiftView().summary!.colleagues[0].title).toBe(T.shift.summary.colleagueGone);
  });

  test('вы с пациентом — забранный ждёт в вашей очереди, в журнале смены — строка', () => {
    openWithTherapist();
    for (let i = 0; i < 400 && !(busyWithResults() && shiftView().queue.length > 0); i++) minute();
    const row = busyWithResults()!;
    expect(callPatient(shiftView().queue[0].id)).toBe(true);
    const mine = shiftView().inRoom!.id;
    expect(takeOver(row.id)).toBe(false);
    expect(shiftView().inRoom?.id).toBe(mine);
    expect(shiftView().queue.map(q => q.id)).toContain(row.id);
    const name = shiftView().queue.find(q => q.id === row.id)!.name;
    expect(shiftView().log[0]).toMatchObject({ kind: 'taken', text: T.shift.colleagueCase.taken(name, false) });
    // второе касание — уже ваш: ни второй строки, ни перемен
    expect(takeOver(row.id)).toBe(false);
    expect(shiftView().log.filter(l => l.kind === 'taken')).toHaveLength(1);
  });
});

