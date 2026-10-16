// «Свои больные» (spec 2026-10-own-patients, часть 76; вопрос 15, развилка — вопрос 42): новых, кого по жалобам
// направили бы в выбранные группы болезней, нанятые врачи оставляют вам. Группа — по тому, что видно у двери, а не по
// скрытому диагнозу; без опции — как прежде.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { type BodySystem, SYSTEMS } from '../../src/content/types';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { apply, forPlayer, leftForPlayer, newSandbox, routeOf } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { memoryStore } from '../../src/state/saves';
import { forgetShift, setStore, shiftState, startShift, tick } from '../../src/state/session';
import { forgetSettings, loadSettings, sanitize as sanitizeSettings, setSettingsStore, settings, updateSettings } from '../../src/state/settings';

const THERAPIST = 'role.therapist';

/** Песочница с готовой амбулаторией, ординаторской и вторым кабинетом, в нём — нанятый терапевт (как в hired.test.ts). */
function withTherapist(seed: number, mine: BodySystem[]): ShiftState {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
  apply(db, s, { kind: 'buildEnd' });
  const office = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const m: StaffMember = { id: 'h1', role: THERAPIST, sex: 'f', seed: 11, skill: 3, salary: salaryOf(db, THERAPIST, 3), days: 0 };
  s.staff = [...(s.staff ?? []), m];
  apply(db, s, { kind: 'assign', id: m.id, room: office });
  if (mine.length > 0) apply(db, s, { kind: 'mine', systems: mine });
  apply(db, s, { kind: 'nextDay' });
  // вы никого не зовёте — три часа приёма
  for (let i = 0; i < 180; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  return s;
}

const walkIns = (s: ShiftState): ShiftPatient[] => Object.values(s.patients).filter(p => p.kind !== 'return' && p.kind !== 'ambulance');
const taken = (s: ShiftState) => walkIns(s).filter(p => p.by !== undefined);

beforeEach(() => {
  const store = memoryStore();
  setStore(store);
  setSettingsStore(store);
  forgetShift();
  forgetSettings();
});

describe('группа больного', () => {
  test('по тому, что видно у двери: тот же человек с теми же жалобами и другой настоящей болезнью — та же группа', () => {
    const s = withTherapist(76, []);
    const ps = walkIns(s).slice(0, 12);
    expect(ps.length).toBe(12);
    for (const p of ps) {
      const r = routeOf(db, s, p);
      expect(SYSTEMS).toContain(r);
      const twin: ShiftPatient = { ...p, patient: { ...p.patient, truth: { ...p.patient.truth, conditions: [{ ...p.patient.truth.conditions[0], id: 'cond.migraine', params: {} }], findings: [] } } };
      expect(routeOf(db, s, twin)).toBe(r);
    }
    // разные жалобы — разные группы, а не одна на всех
    expect(new Set(walkIns(s).map(p => routeOf(db, s, p))).size).toBeGreaterThan(2);
  });
});

describe('нанятый врач', () => {
  test('без опции берёт новых, как прежде; все группы отмечены — не берёт никого; одна — не берёт только её', () => {
    const free = withTherapist(77, []);
    expect(taken(free).length).toBeGreaterThan(2);
    expect(walkIns(free).some(p => forPlayer(db, free, p))).toBe(false);
    const all = withTherapist(77, [...SYSTEMS]);
    expect(taken(all)).toEqual([]);
    // самая частая группа у двери — её отмечаем
    const counts = new Map<BodySystem, number>();
    for (const p of walkIns(free)) counts.set(routeOf(db, free, p), (counts.get(routeOf(db, free, p)) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const one = withTherapist(77, [top]);
    expect(taken(one).length).toBeGreaterThan(0);
    for (const p of taken(one)) expect(routeOf(db, one, p)).not.toBe(top);
    expect(walkIns(one).some(p => p.by === undefined && routeOf(db, one, p) === top)).toBe(true);
  });

  test('в очереди «ваш» — с отметкой «ждёт вас», кроме записанного к тому, кто сегодня принимает', () => {
    expect(T.shift.badge.mine).toBe('ждёт вас');
    const free = withTherapist(78, []);
    expect(walkIns(free).some(p => leftForPlayer(db, free, p))).toBe(false);
    const all = withTherapist(78, [...SYSTEMS]);
    const waiting = walkIns(all).filter(p => p.status === 'waiting');
    // «красных» по сортировке нанятые врачи и так не берут — отметки нет
    const red = waiting.filter(p => p.triage === 'red');
    expect(red.length).toBeGreaterThan(0);
    for (const p of red) expect(leftForPlayer(db, all, p)).toBe(false);
    const rest = waiting.filter(p => p.triage !== 'red');
    expect(rest.length).toBeGreaterThan(1);
    for (const p of rest) expect(leftForPlayer(db, all, p)).toBe(true);
    // записан к нанятому врачу, который принимает, — его возьмёт он
    rest[0].to = 'h1';
    expect(leftForPlayer(db, all, rest[0])).toBe(false);
  });
});

describe('настройка', () => {
  test('по умолчанию — ничего; только известные группы, без повторов, по порядку выбора диагноза', async () => {
    await loadSettings();
    expect(settings().mine).toEqual([]);
    expect(sanitizeSettings({ mine: ['bones', 'heart', 'nope', 'heart', 7] }).mine).toEqual(['heart', 'bones']);
    expect(sanitizeSettings({ mine: 'heart' }).mine).toEqual([]);
  });

  test('сессия передаёт её смене сразу — командой в журнале', async () => {
    await loadSettings();
    startShift(5, 'winter');
    await updateSettings({ mine: ['heart'] });
    tick(1000);
    expect(shiftState()!.meta.mine).toEqual(['heart']);
    expect(shiftState()!.journal.some(c => c.kind === 'mine')).toBe(true);
    await updateSettings({ mine: [] });
    tick(1000);
    expect(shiftState()!.meta.mine).toBeUndefined();
  });
});
