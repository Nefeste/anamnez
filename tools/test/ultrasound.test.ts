// Кабинет УЗИ своей больницы (spec 2026-09-chapter-2, часть 29): УЗ-аппарат и врач УЗД; без
// них и в амбулатории практики УЗИ серым с причиной; очередь кабинета и время с поправкой
// аппарата и врача; точность — аппарата и того, кто описывает; числа УЗИ при аппендиците — по
// базе; карта — врач УЗД на месте, пациент на кушетке, очередь у кабинета; картинка результата
// — сектор с отростком по тому, что показало УЗИ; кого нанимают в главе 1.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { Rng } from '../../src/engine/core/rng';
import { layoutOf } from '../../src/engine/hospital/clinic';
import { examWhere } from '../../src/engine/hospital/requirements';
import { readingOf, salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { apply, hospitalCtx, imagingSkill, newCampaign, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { type CaseInput, makeCaseView } from '../../src/state/caseView';
import { placements } from '../../src/state/clinicMap';
import { roomSigns } from '../../src/state/roomSigns';
import { examBlockText } from '../../src/state/sandboxView';
import { memoryStore } from '../../src/state/saves';
import { callPatient, forgetShift, setStore, shiftCaseView, shiftView, startShift, tick } from '../../src/state/session';

const US = 'exam.us_abdomen';
const FINDING = 'img.us_appendicitis';

/**
 * Песочница с готовой амбулаторией; справа — коридор, над ним кабинет УЗИ S с аппаратами
 * `equipment` и врачом УЗД навыка `skill` (без `sonographer: false`).
 */
function withUs(seed = 41, o: { equipment?: readonly string[]; skill?: number; sonographer?: boolean } = {}) {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  // экспертный аппарат дороже «щедрого» бюджета после стройки
  s.economy!.cash = 5_000_000;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ultrasound', size: 'S', x: 29, y: 0, rot: 0 } });
  const us = s.hospital!.rooms.find(r => r.type === 'room.ultrasound')!.id;
  for (const equipment of o.equipment ?? ['eq.us_basic']) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: us, equipment } });
  apply(db, s, { kind: 'buildEnd' });
  if (o.sonographer !== false) {
    const skill = o.skill ?? 3;
    const m: StaffMember = { id: 'u1', role: 'role.sonographer', sex: 'f', seed: 200, skill, salary: salaryOf(db, 'role.sonographer', skill), days: 0 };
    s.staff = [...s.staff!, m];
    apply(db, s, { kind: 'assign', id: m.id, room: us });
  }
  apply(db, s, { kind: 'nextDay' });
  return { s, us };
}

const where = (s: ShiftState) => {
  const ctx = hospitalCtx(db, s);
  return examWhere(db, ctx.plan, ctx.working, ctx.staffed, US);
};

/** Первый в очереди вызван в кабинет, ему назначено УЗИ. */
function scanned(s: ShiftState): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const p = s.patients[s.queue[0]];
  apply(db, s, { kind: 'call', id: p.id });
  apply(db, s, { kind: 'exam', exam: US });
  return p;
}

describe('кабинет УЗИ: где можно сделать', () => {
  test('работает с УЗ-аппаратом и врачом УЗД; без аппарата и без врача — серым с причиной', () => {
    const { s, us } = withUs();
    expect(where(s)).toEqual({ rooms: [us] });
    const bare = where(withUs(41, { equipment: [] }).s);
    expect('block' in bare && examBlockText(db, bare.block)).toBe(T.sandbox.examBlock.down('Кабинет УЗИ', T.sandbox.problem.noEquipment));
    const nobody = where(withUs(41, { sonographer: false }).s);
    expect('block' in nobody && examBlockText(db, nobody.block)).toBe(T.sandbox.examBlock.down('Кабинет УЗИ', T.sandbox.problem.noStaff('врача УЗД')));
  });

  describe('в амбулатории практики кабинета УЗИ нет — обследование серым: «нет кабинета УЗИ»', () => {
    beforeEach(() => {
      setStore(memoryStore());
      forgetShift();
    });

    test('в карте пациента — с причиной, остальные обследования доступны', () => {
      startShift(12, 'winter');
      for (let i = 0; i < 180 && shiftView().queue.length === 0; i++) tick(1000);
      callPatient(shiftView().queue[0].id);
      const v = shiftCaseView()!;
      expect(v.unavailable).toEqual({ [US]: T.sandbox.examBlock.none('кабинета УЗИ') });
    });
  });
});

describe('кабинет УЗИ: очередь, время и точность', () => {
  test('УЗИ — в очереди кабинета: 20 минут с поправкой аппарата и врача; второй — после первого', () => {
    const { s, us } = withUs(41, { equipment: ['eq.us_expert'] });
    const first = scanned(s);
    const a = first.pending.find(x => x.exam === US)!;
    expect(a.room).toBe(us);
    // экспертный аппарат — 85 % времени, врач навыка 3 — как записано
    expect(a.end! - a.start!).toBe(Math.round(20 * 60 * 0.85));
    // описание — 5 минут после процедуры
    expect(a.readyAt).toBe(a.end! + 5 * 60);
    apply(db, s, { kind: 'sendAway' });
    const second = scanned(s);
    const b = second.pending.find(x => x.exam === US)!;
    expect(b.start!).toBeGreaterThanOrEqual(a.end!);
  });

  test('точность — от аппарата и навыка того, кто описывает: в УЗИ — врач УЗД, в рентгене — рентгенолог', () => {
    const room = { id: 'x', type: 'room.ultrasound' };
    const doc = (skill: number): StaffMember => ({ id: 'u', role: 'role.sonographer', sex: 'f', seed: 1, skill, salary: 0, room: 'x', days: 0 });
    expect(imagingSkill(db, [doc(3)], room, 'eq.us_basic')).toEqual({ sens: 1, spec: 1, sensPp: 0, specPp: 0 });
    expect(imagingSkill(db, [doc(3)], room, 'eq.us_expert')).toEqual({ sens: 1, spec: 1, sensPp: 5, specPp: 1 });
    const [rs, rp] = readingOf(db, doc(5));
    expect(rs).toBeGreaterThan(0);
    expect(imagingSkill(db, [doc(5)], room, 'eq.us_expert')).toEqual({ sens: 1, spec: 1, sensPp: 5 + rs, specPp: 1 + rp });
    // рентген: снимок описывает рентгенолог, навык лаборанта точности не меняет
    const xray = { id: 'y', type: 'room.xray' };
    const tech: StaffMember = { id: 'a', role: 'role.radiographer', sex: 'm', seed: 2, skill: 5, salary: 0, room: 'y', days: 0 };
    const reader: StaffMember = { id: 'b', role: 'role.radiologist', sex: 'f', seed: 3, skill: 1, salary: 0, room: 'y', days: 0 };
    const [xs, xp] = readingOf(db, reader);
    expect(imagingSkill(db, [tech, reader], xray)).toEqual({ sens: 1, spec: 1, sensPp: xs, specPp: xp });
    expect(imagingSkill(db, [tech], xray)).toEqual({ sens: 1, spec: 1, sensPp: 0, specPp: 0 });
  });

  test('УЗИ при аппендиците — по базе (WSES 2020): отросток виден примерно у 76 %, у здоровых ложно — около 5 %', () => {
    const N = 3000;
    let seen = 0;
    let wrong = 0;
    for (let i = 0; i < N; i++) {
      const sick = generatePatient(db, 50_000 + i, { department: 'dept.therapy', season: 'autumn', primary: 'cond.appendicitis', params: {} });
      if (runExam(db, sick, US, Rng.seeded(i).fork('us')).some(o => o.f === FINDING && o.shown)) seen++;
      const other = generatePatient(db, 60_000 + i, { department: 'dept.therapy', season: 'autumn', primary: 'cond.gastroenteritis', params: {} });
      if (runExam(db, other, US, Rng.seeded(i).fork('us')).some(o => o.f === FINDING && o.shown)) wrong++;
    }
    expect(seen / N).toBeGreaterThan(0.73);
    expect(seen / N).toBeLessThan(0.79);
    expect(wrong / N).toBeGreaterThan(0.035);
    expect(wrong / N).toBeLessThan(0.065);
  });
});

describe('кабинет УЗИ: карта и картинка', () => {
  test('врач УЗД на месте; пациент — на кушетке во время УЗИ, следующий — на скамье в очереди; у кабинета — очередь', () => {
    const { s, us } = withUs();
    const ctx = hospitalCtx(db, s);
    const layout = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
    const room = ctx.plan.rooms.find(r => r.id === us)!;
    expect(layout.staff).toContainEqual({ role: 'sonographer', cell: room.staff['role.sonographer'] });
    expect(layout.spots.ultrasound).toEqual(room.patient!);
    const first = scanned(s);
    apply(db, s, { kind: 'sendAway' });
    const second = scanned(s);
    apply(db, s, { kind: 'sendAway' });
    const a = first.pending.find(x => x.exam === US)!;
    apply(db, s, { kind: 'advance', seconds: Math.max(0, a.start! - s.t + 60) });
    const map = placements(db, layout, s);
    expect(map.find(x => x.id === first.id)).toMatchObject({ where: { cell: room.patient }, doing: { kind: 'exam', room: 'ultrasound' } });
    expect(map.find(x => x.id === second.id)).toMatchObject({ where: { bench: true }, doing: { kind: 'examQueue', room: 'ultrasound' } });
    expect(roomSigns(layout, s).find(x => x.id === us)!.queue).toBe(1);
    expect(T.shift.map.doing.exam.ultrasound).toBe('На УЗИ');
    expect(T.shift.map.staff.sonographer).toBe('Врач УЗД');
  });

  test('результат УЗИ — сектором: виден отросток — «мишень», не виден — без неё', () => {
    const sick = generatePatient(db, 5, { department: 'dept.therapy', season: 'autumn', primary: 'cond.appendicitis', params: {} });
    const input = (shown: boolean): CaseInput => ({
      version: 1, patient: sick, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [US],
      draft: { treatments: [], setting: 'home' },
      arrived: [{ exam: US, step: 1, at: 600, obs: [{ f: FINDING, shown, exam: US }] }],
    });
    const image = (shown: boolean) => makeCaseView(input(shown)).groups.find(g => g.exam === US)!.image;
    expect(image(true)).toMatchObject({ kind: 'us', view: 'appendix', appendix: 0.8 });
    expect(image(false)).toMatchObject({ kind: 'us', view: 'appendix', appendix: 0 });
    // зерно — от пациента и обследования: тот же пациент — тот же рисунок
    expect(image(true)!.seed).toBe(image(false)!.seed);
  });

  test('кандидаты: в песочнице — врачи УЗД; в главе 1 кабинета УЗИ нет — и врача УЗД нет', () => {
    const { s } = withUs();
    expect(s.candidates!.some(c => c.role === 'role.sonographer')).toBe(true);
    const c = newCampaign(db, { seed: 5, season: 'winter', career: 1 });
    expect((c.candidates ?? []).some(m => m.role === 'role.sonographer')).toBe(false);
  });
});
