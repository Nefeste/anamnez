// Врачи-специалисты (spec 2026-10-chapter-4, часть 59): гастроэнтеролог, эндокринолог и инфекционист — нанятые врачи со
// специальностью. Встают на место врача в кабинете, как терапевт; у кабинета специалиста своя запись — с болезнями его
// профиля, которых больница принимает, — и принимает он только записанных к нему, а терапевт их не берёт. Кандидаты
// прежних должностей не сдвинулись, в главах 1–3 специалистов нет.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { standInOf, standInsOf } from '../../src/engine/hospital/requirements';
import { applicantsOf, salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { apply, departmentsOf, newCampaign, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { memoryStore } from '../../src/state/saves';
import { assign, buildAction, buildView, endBuild, forgetShift, hire, nextDay, setSpeed, setStore, shiftState, shiftView, staffView, startSandbox, tick } from '../../src/state/session';

const DOCTOR = 'role.doctor';
const THERAPIST = 'role.therapist';
const GASTRO = 'role.gastroenterologist';
const ENDO = 'role.endocrinologist';
const INFECT = 'role.infectionist';
const SPECIALISTS = [ENDO, GASTRO, INFECT];

/**
 * Песочница с готовой амбулаторией; справа — продлённый коридор, ординаторская (два места) и второй кабинет; с `third` —
 * третий кабинет на месте рентгена.
 */
function withOffices(seed = 7, third = false): { s: ShiftState; offices: string[] } {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const last = () => s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
  const offices = [last()];
  if (third) {
    apply(db, s, { kind: 'build', cmd: { kind: 'demolish', room: s.hospital!.rooms.find(r => r.type === 'room.xray')!.id } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 17, y: 10, rot: 2 } });
    offices.push(last());
  }
  apply(db, s, { kind: 'buildEnd' });
  return { s, offices };
}

/** Нанятый врач этой должности навыка 3 — в штат и в кабинет. */
function hireDoctor(s: ShiftState, role: string, office: string, id: string): StaffMember {
  const m: StaffMember = { id, role, sex: 'f', seed: 11, skill: 3, salary: salaryOf(db, role, 3), days: 0 };
  s.staff = [...(s.staff ?? []), m];
  apply(db, s, { kind: 'assign', id, room: office });
  return m;
}

/** День смены целиком: вы не принимаете — только нанятые врачи. */
function playDay(s: ShiftState) {
  apply(db, s, { kind: 'nextDay' });
  for (let i = 0; i < 14 * 60 && s.dayOpen; i++) apply(db, s, { kind: 'advance', seconds: 60 });
}

const truthOf = (p: ShiftPatient) => p.patient.truth.conditions[0].id;

describe('должности специалистов', () => {
  test('нанятые врачи на месте врача, с профилем; место врача по-прежнему называется по терапевту', () => {
    for (const id of SPECIALISTS) {
      const r = db.roles[id];
      expect({ id, stands: r.stands, needs: r.needs, hire: r.hire, office: r.rooms.includes('room.office') }).toEqual({ id, stands: DOCTOR, needs: 'room.staff', hire: true, office: true });
      expect(r.profile!.length).toBeGreaterThan(4);
      for (const c of r.profile!) expect({ id, c, presenting: db.conditions[c].presenting }).toEqual({ id, c, presenting: true });
    }
    expect(db.roles[THERAPIST].profile).toBeUndefined();
    expect(standInOf(db, DOCTOR)).toBe(THERAPIST);
    expect(standInsOf(db, DOCTOR)).toEqual([ENDO, GASTRO, INFECT, THERAPIST]);
    // профили: желудок, кишечник и печень — из терапии; эндокринные болезни; инфекционное отделение
    expect(db.roles[GASTRO].profile!.every(c => db.conditions[c].system === 'digestive' && db.conditions[c].department === 'dept.therapy')).toBe(true);
    expect(db.roles[ENDO].profile!.every(c => db.conditions[c].system === 'metabolic')).toBe(true);
    expect(db.roles[INFECT].profile!.every(c => db.conditions[c].department === 'dept.infectious')).toBe(true);
  });

  test('кандидаты прежних должностей не сдвинулись: специалисты — в конце списка', () => {
    for (const day of [0, 3]) {
      const all = applicantsOf(db, 7, day, 1).list;
      const before = applicantsOf(db, 7, day, 1, role => !db.roles[role].profile).list;
      expect(all.slice(0, before.length)).toEqual(before);
      const rest = all.slice(before.length);
      expect(rest.length).toBeGreaterThan(0);
      expect(rest.every(m => SPECIALISTS.includes(m.role))).toBe(true);
    }
  });

  test('в главах 1–3 специалистов среди кандидатов нет', () => {
    for (const chapter of Object.keys(db.chapters)) {
      const s = newCampaign(db, { seed: 7, season: 'winter', career: 1, chapter });
      expect({ chapter, specialists: (s.candidates ?? []).filter(c => db.roles[c.role].profile).length }).toEqual({ chapter, specialists: 0 });
    }
  });

  test('специалист сменяет терапевта в кабинете: врач в кабинете один', () => {
    const { s, offices } = withOffices();
    hireDoctor(s, THERAPIST, offices[0], 'h1');
    hireDoctor(s, GASTRO, offices[0], 'h2');
    expect(s.staff!.filter(m => m.room === offices[0] && db.roles[m.role].stands).map(m => m.id)).toEqual(['h2']);
    expect(s.staff!.find(m => m.id === 'h1')!.room).toBeUndefined();
  });
});

describe('своя запись и кого берёт врач', () => {
  test('к специалисту записываются с болезнями его профиля; он принимает только их, терапевт — не их', () => {
    const { s, offices } = withOffices(7, true);
    hireDoctor(s, GASTRO, offices[0], 'h1');
    hireDoctor(s, THERAPIST, offices[1], 'h2');
    playDay(s);
    const all = Object.values(s.patients);
    const booked = all.filter(p => p.to === 'h1');
    expect(booked.length).toBeGreaterThan(5);
    expect(booked.every(p => p.kind === 'appointment' && db.roles[GASTRO].profile!.includes(truthOf(p)))).toBe(true);
    // к терапевту не записываются отдельно: у его кабинета запись, как прежде, — в общую очередь
    expect(all.filter(p => p.to !== undefined && p.to !== 'h1')).toEqual([]);
    const byGastro = all.filter(p => p.closed?.by === 'h1');
    const byTherapist = all.filter(p => p.closed?.by === 'h2');
    expect(byGastro.length).toBeGreaterThan(3);
    expect(byTherapist.length).toBeGreaterThan(3);
    expect(byGastro.every(p => p.to === 'h1')).toBe(true);
    expect(byTherapist.some(p => p.to === 'h1')).toBe(false);
    expect(s.summary.colleagues?.h1?.seen).toBe(byGastro.length);
  }, 30_000);

  test('инфекционист без бокса простаивает: записи к нему нет', () => {
    const { s, offices } = withOffices();
    hireDoctor(s, INFECT, offices[0], 'h1');
    expect(departmentsOf(db, s)).not.toContain('dept.infectious');
    playDay(s);
    expect(Object.values(s.patients).filter(p => p.to === 'h1')).toEqual([]);
    expect(Object.values(s.patients).filter(p => p.closed?.by === 'h1')).toEqual([]);
  }, 30_000);

  test('с боксом к инфекционисту записываются с инфекциями — их принимает больница', () => {
    const { s, offices } = withOffices();
    // бокс — на месте ЭКГ, медсестра ЭКГ — в бокс
    const ecg = s.hospital!.rooms.find(r => r.type === 'room.ecg')!.id;
    const nurse = s.staff!.find(m => m.room === ecg)!.id;
    apply(db, s, { kind: 'build', cmd: { kind: 'demolish', room: ecg } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.box', size: 'S', x: 12, y: 10, rot: 2 } });
    apply(db, s, { kind: 'buildEnd' });
    apply(db, s, { kind: 'assign', id: nurse, room: s.hospital!.rooms[s.hospital!.rooms.length - 1].id });
    hireDoctor(s, INFECT, offices[0], 'h1');
    expect(departmentsOf(db, s)).toContain('dept.infectious');
    playDay(s);
    const booked = Object.values(s.patients).filter(p => p.to === 'h1');
    expect(booked.length).toBeGreaterThan(5);
    expect(booked.every(p => db.conditions[truthOf(p)].department === 'dept.infectious')).toBe(true);
  }, 30_000);

  test('те же команды — тот же день: со специалистом повтор точный', () => {
    const day = () => {
      const { s, offices } = withOffices(11, true);
      hireDoctor(s, ENDO, offices[0], 'h1');
      hireDoctor(s, THERAPIST, offices[1], 'h2');
      playDay(s);
      return JSON.stringify({ patients: s.patients, summary: s.summary });
    };
    expect(day()).toBe(day());
  }, 30_000);

  test('врач не сидит над анализами, пока записанный к нему ждёт: отпускает ждущего результатов', () => {
    const { s, offices } = withOffices();
    hireDoctor(s, GASTRO, offices[0], 'h1');
    apply(db, s, { kind: 'nextDay' });
    let sat = 0;
    let released = 0;
    const away = new Set<string>();
    for (let i = 0; i < 14 * 60 && s.dayOpen; i++) {
      apply(db, s, { kind: 'advance', seconds: 60 });
      // у себя ждёт результата, до следующего шага — больше минуты, а записанный к нему ждёт в очереди дольше двух минут;
      // «красного» он не берёт — того ждёте вы
      const p = Object.values(s.patients).find(x => x.by === 'h1' && x.status === 'inRoom');
      const step = p && s.events.find(e => e.event.kind === 'colleague' && e.event.id === p.id);
      const waits = p !== undefined && p.pending.length > 0 && !p.results.some(r => r.at > s.t) && step !== undefined && step.t > s.t + 60;
      const his = (id: string) => s.patients[id].to === 'h1' && s.patients[id].triage !== 'red' && s.patients[id].calledT === undefined;
      if (waits && s.queue.some(id => his(id) && s.t - s.patients[id].queuedT > 120)) sat++;
      for (const x of Object.values(s.patients)) if (x.by === 'h1' && x.status === 'away' && !away.has(x.id)) {
        away.add(x.id);
        released++;
      }
    }
    expect(released).toBeGreaterThan(0);
    expect(sat).toBe(0);
  }, 30_000);
});

describe('экраны: запись, карта, «Персонал»', () => {
  beforeEach(() => {
    setStore(memoryStore());
    forgetShift();
  });

  test('место врача — для терапевта и специалистов; значок записи, кабинет и подпись на карте — по должности', () => {
    startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'doctor', seed: 43, season: 'winter' });
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    expect(buildAction({ kind: 'corridor', cells })).toBeNull();
    expect(buildAction({ kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 })).toBeNull();
    expect(buildAction({ kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 })).toBeNull();
    endBuild();
    const office = buildView()!.plan.rooms[buildView()!.plan.rooms.length - 1].id;
    const post = staffView()!.posts.find(x => x.room === office)!;
    expect(post).toMatchObject({ role: THERAPIST, roleName: 'Терапевт или специалист', roles: [ENDO, GASTRO, INFECT, THERAPIST] });
    const gastro = staffView()!.candidates.find(c => c.role === GASTRO)!;
    hire(gastro.id);
    assign(gastro.id, office);
    expect(staffView()!.posts.find(x => x.room === office)!.who).toBe(gastro.id);
    nextDay();
    expect(shiftView().offices).toEqual({ [office]: 'Кабинет гастроэнтеролога' });
    const minute = () => {
      if (shiftView().paused) setSpeed(1);
      tick(1000);
    };
    const bookedRow = () => shiftView().queue.find(r => shiftState()!.patients[r.id].to === gastro.id);
    for (let i = 0; i < 300 && !bookedRow(); i++) minute();
    expect(bookedRow()!.badges).toContain('по записи к гастроэнтерологу');
    const figure = Object.keys(shiftView().who).find(k => k === `staff.therapist.${office}`)!;
    expect(shiftView().who[figure].title).toMatch(/, гастроэнтеролог · навык \d$/);
  }, 30_000);
});
