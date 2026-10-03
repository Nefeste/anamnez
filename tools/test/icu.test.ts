// Палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а): койки под мониторами, медсестра и
// анестезиолог-реаниматолог; место `icu` — «В ПИТ»: закрывает и палату, и срочный стационар, а
// палата вместо ПИТ — меньше нужного; нет своей ПИТ — перевод, из амбулатории — скорая. Анафилактический
// шок — в ПИТ (263_2, раздел 6). Касса — койко-день ПИТ дороже, прибавка к тарифу — только по показаниям.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { wardIncome } from '../../src/engine/economy/economy';
import { generatePatient } from '../../src/engine/med/generate';
import { choiceFor, recommendedSetting, settingFit } from '../../src/engine/med/plan';
import { problemsOf } from '../../src/engine/hospital/requirements';
import { apply, freeIcuBeds, hospitalCtx, icuBeds, inIcu, inpatientsOf, newSandbox, wardBeds } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';

const ANAPHYLAXIS = 'cond.anaphylaxis';

/**
 * Песочница с готовой амбулаторией и ПИТ на две койки справа: мониторов — `monitors`, медсестра ЭКГ —
 * в ПИТ, анестезиолог-реаниматолог — из кандидатов.
 */
function withIcu(monitors: number, seed = 21): { s: ShiftState; icu: string } {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.icu', size: 'S', x: 29, y: 0, rot: 0 } });
  const icu = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  for (let i = 0; i < monitors; i++) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: icu, equipment: 'eq.monitor_defib' } });
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: icu });
  const c = s.candidates!.find(x => x.role === 'role.anesthetist')!;
  apply(db, s, { kind: 'hire', id: c.id });
  apply(db, s, { kind: 'assign', id: c.id, room: icu });
  return { s, icu };
}

/** Первый в очереди — с анафилактическим шоком, вызван; диагноз, эпинефрин и кислород — как у разумного врача. */
function shock(s: ShiftState): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const id = s.queue[0];
  const p = s.patients[id];
  p.patient = generatePatient(db, 4747, { department: 'dept.therapy', season: 'winter', primary: ANAPHYLAXIS, params: {} });
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'diagnose', id: ANAPHYLAXIS });
  for (const tx of ['tx.epinephrine_im', 'tx.iv_fluids', 'tx.steroid_iv', 'tx.oxygen_mask']) apply(db, s, { kind: 'toggleTreatment', id: tx });
  return p;
}

describe('ПИТ: где лечить', () => {
  test('ПИТ закрывает палату, срочный стационар и себя; палата вместо ПИТ — меньше нужного; скорая и перевод — ПИТ где-то ещё', () => {
    expect(['ward', 'ambulance', 'icu'].map(need => settingFit(need as 'ward', 'icu'))).toEqual(['ok', 'ok', 'ok']);
    expect(settingFit('icu', 'admit')).toBe('under');
    expect(settingFit('icu', 'ward')).toBe('under');
    expect(settingFit('icu', 'ambulance')).toBe('ok');
    expect(settingFit('icu', 'transfer')).toBe('ok');
    expect(settingFit('home', 'icu')).toBe('over');
    // операцию и центр своя ПИТ не заменяет
    expect([settingFit('surgery', 'icu'), settingFit('transfer', 'icu')]).toEqual(['under', 'under']);
    // своя ПИТ — в неё; нет её — скорая (в больнице — «Вызвать скорую», перевод)
    expect([choiceFor('icu', { icu: true }), choiceFor('icu', { ward: true }), choiceFor('icu')]).toEqual(['icu', 'ambulance', 'ambulance']);
  });

  test('анафилактический шок — в ПИТ (263_2, раздел 6): в реанимации не меньше суток, выписка — через 1–3 суток', () => {
    const p = generatePatient(db, 4747, { department: 'dept.therapy', season: 'winter', primary: ANAPHYLAXIS, params: {} });
    expect(recommendedSetting(db, p)).toBe('icu');
    expect(db.conditions[ANAPHYLAXIS].stay).toEqual([1, 3]);
  });
});

describe('ПИТ: помещение и койки', () => {
  test('койка работает, если на её месте стоит монитор; без мониторов ПИТ не работает', () => {
    const none = withIcu(0);
    const room = hospitalCtx(db, none.s).plan.rooms.find(r => r.id === none.icu)!;
    expect(problemsOf(db, hospitalCtx(db, none.s).plan, room, hospitalCtx(db, none.s).staffed).map(x => x.kind)).toEqual(['noEquipment']);
    expect(icuBeds(db, none.s)).toEqual([]);
    expect(icuBeds(db, withIcu(1).s).map(b => b.bed)).toEqual([0]);
    const two = withIcu(2);
    expect(icuBeds(db, two.s)).toEqual([{ room: two.icu, bed: 0 }, { room: two.icu, bed: 1 }]);
    // койки ПИТ — не палатные: «В палату» их не занимает
    expect(wardBeds(db, two.s)).toEqual([]);
  });

  test('монитор с дефибриллятором ставят и в смотровую приёмного, и в ПИТ; анестезиолог-реаниматолог — и в операционной, и в ПИТ', () => {
    expect(db.equipment['eq.monitor_defib'].rooms).toEqual(['room.emergency', 'room.icu']);
    expect(db.rooms['room.icu'].equipment).toEqual(['eq.monitor_defib']);
    expect(db.roles['role.anesthetist'].rooms).toEqual(['room.icu', 'room.or']);
    // койки и места под мониторы: по одному месту на койку
    expect(db.rooms['room.icu'].sizes.map(z => [z.id, z.beds, z.slots.length])).toEqual([['S', 2, 2], ['M', 4, 4]]);
  });
});

describe('ПИТ: поступление, обход, касса', () => {
  test('шок — «В ПИТ»: место A, лежит на койке ПИТ под монитором, в итогах — поступил в ПИТ; ночь в ПИТ дороже палатной', () => {
    const { s, icu } = withIcu(2);
    apply(db, s, { kind: 'nextDay' });
    const p = shock(s);
    apply(db, s, { kind: 'setting', setting: 'icu' });
    expect(p.draft.setting).toBe('icu');
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.status).toBe('admitted');
    expect(p.stay!.room).toBe(icu);
    expect(inIcu(db, s, p)).toBe(true);
    expect(freeIcuBeds(db, s)).toHaveLength(1);
    expect(s.summary.ward).toMatchObject({ admitted: 1, icu: 1 });
    apply(db, s, { kind: 'closeDay' });
    expect(s.summary.ward).toMatchObject({ lying: 1, icuLying: 1 });
    expect(s.summary.economy!.ledger.expenses.ward).toBe(db.economy.icu.bedDay);
  });

  test('шок — «В палату» вместо ПИТ: меньше нужного, D', () => {
    const { s } = withIcu(2);
    // своя палата есть — четыре койки рядом с ПИТ
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ward', size: 'M', x: 29, y: 10, rot: 2 } });
    apply(db, s, { kind: 'buildEnd' });
    const ward = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r4')!.id, room: ward });
    apply(db, s, { kind: 'nextDay' });
    expect(wardBeds(db, s)).toHaveLength(4);
    const p = shock(s);
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.grades.setting).toBe('D');
    expect(p.closed!.notes).toContainEqual({ code: 'setting.under', recommended: 'icu' });
    expect(inIcu(db, s, p)).toBe(false);
  });

  test('свободных коек ПИТ нет — «В ПИТ» не выбрать; заняли последнюю, пока решали, — перевод', () => {
    const { s } = withIcu(1);
    apply(db, s, { kind: 'nextDay' });
    const first = shock(s);
    apply(db, s, { kind: 'setting', setting: 'icu' });
    apply(db, s, { kind: 'finish' });
    expect(inIcu(db, s, first)).toBe(true);
    const second = shock(s);
    apply(db, s, { kind: 'setting', setting: 'icu' });
    expect(second.draft.setting).not.toBe('icu');
    // выбрали, пока койка была, а её заняли — при закрытии перевод скорой
    second.draft.setting = 'icu';
    apply(db, s, { kind: 'finish' });
    expect(second.closed!.plan.setting).toBe('ambulance');
    expect(second.status).toBe('done');
    expect(inpatientsOf(s).map(p => p.id)).toEqual([first.id]);
  });

  test('прибавка за ПИТ — только по показаниям: ПИТ нужна — тариф с прибавкой, без показаний — тариф палаты', () => {
    const t = db.economy.tariffs;
    const full = wardIncome(db, ANAPHYLAXIS, 'A', 'full');
    expect(wardIncome(db, ANAPHYLAXIS, 'A', 'full', undefined, true)).toBe(full + t.omsIcu);
    expect(t.omsIcu).toBeGreaterThan(0);
    expect(db.economy.icu.bedDay).toBeGreaterThan(db.economy.ward.bedDay);
  });
});
