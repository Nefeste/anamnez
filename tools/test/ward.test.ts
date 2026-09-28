// Стационар своей больницы (spec 2026-09-chapter-2, часть 26): палата и койки, «В палату» в
// решении, болезнь по суткам с назначенным планом, обход — выписка, перевод, смена лечения;
// ранняя выписка — повторное обращение; касса — случай стационара и койко-дни; архив профиля —
// с исходом после выписки.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { emptyLedger, expensesOf, incomeOf, wardIncome } from '../../src/engine/economy/economy';
import { generatePatient } from '../../src/engine/med/generate';
import { choiceFor, settingFit } from '../../src/engine/med/plan';
import { apply, freeBeds, inpatientsOf, newSandbox, wardBeds } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { daysIn, stayNorm, vitalOn, wardState } from '../../src/engine/shift/ward';
import { caseKey, forgetProfile, loadProfile, profile, recordCases, setProfileStore } from '../../src/state/profile';
import { memoryStore } from '../../src/state/saves';

/** Песочница с готовой амбулаторией и палатой на четыре койки справа; медсестра ЭКГ — в палату. */
function withWard(seed = 21): { s: ShiftState; ward: string } {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ward', size: 'M', x: 29, y: 0, rot: 0 } });
  apply(db, s, { kind: 'buildEnd' });
  const ward = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const nurse = s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!;
  apply(db, s, { kind: 'assign', id: nurse.id, room: ward });
  return { s, ward };
}

/** Первый в очереди — пациент с этой болезнью (тяжёлой), вызван в кабинет; диагноз и лечение — как у разумного врача. */
function treat(s: ShiftState, primary: string, treatments: string[], params: Record<string, string> = { severity: 'severe' }): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const id = s.queue[0];
  const p = s.patients[id];
  // без аллергии на назначенное: реакция — отдельный случай
  const n = Number(id.split('-')[1] ?? 0);
  for (let k = 0; ; k++) {
    p.patient = generatePatient(db, 9_000 + 100 * n + k, { department: 'dept.therapy', season: 'winter', primary, params });
    if (!p.patient.truth.risks.some(r => r.startsWith('risk.allergy_'))) break;
  }
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'diagnose', id: primary });
  for (const tx of treatments) apply(db, s, { kind: 'toggleTreatment', id: tx });
  return p;
}

const night = (s: ShiftState) => {
  apply(db, s, { kind: 'closeDay' });
  apply(db, s, { kind: 'nextDay' });
};

describe('стационар: где лечить', () => {
  test('своя палата закрывает стационар и «срочно в стационар», но не операцию и не центр', () => {
    expect(settingFit('ward', 'admit')).toBe('ok');
    expect(settingFit('ambulance', 'admit')).toBe('ok');
    expect(settingFit('surgery', 'admit')).toBe('under');
    expect(settingFit('transfer', 'admit')).toBe('under');
    expect(settingFit('home', 'admit')).toBe('over');
    // из амбулатории операцию и центр по-прежнему закрывает скорая
    expect(settingFit('surgery', 'ambulance')).toBe('ok');
    expect(settingFit('transfer', 'ambulance')).toBe('ok');
    expect(settingFit('ward', 'ambulance')).toBe('over');
    expect([choiceFor('ward'), choiceFor('ward', { ward: true }), choiceFor('surgery', { ward: true })]).toEqual(['ward', 'admit', 'ambulance']);
  });

  test('палата работает, когда есть медсестра и проход; койки — по порядку', () => {
    const { s, ward } = withWard();
    expect(wardBeds(db, s)).toEqual([0, 1, 2, 3].map(bed => ({ room: ward, bed })));
    // практика — без палаты: коек нет
    const plain = newSandbox(db, { seed: 3, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
    expect(wardBeds(db, plain)).toEqual([]);
  });
});

describe('стационар: поступление, обход, выписка', () => {
  test('тяжёлая пневмония — в палату: оценка места A, койка занята, лечение идёт по суткам к выписке', () => {
    const { s, ward } = withWard();
    apply(db, s, { kind: 'nextDay' });
    const p = treat(s, 'cond.pneumonia_cap', ['tx.amoxicillin_clavulanate']);
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    expect(p.status).toBe('admitted');
    expect(p.closed!.plan.setting).toBe('admit');
    expect(p.closed!.outcome.kind).toBe('admitted');
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.stay).toMatchObject({ room: ward, bed: 0, since: 1 });
    expect(freeBeds(db, s)).toHaveLength(3);
    // срок — по рекомендации: клиническая стабильность за 3–5 суток
    const ready = p.stay!.readyAfter!;
    expect(ready).toBeGreaterThanOrEqual(3);
    expect(ready).toBeLessThanOrEqual(5);
    expect(stayNorm(db, 'cond.pneumonia_cap')).toBe(5);
    // температура к выписке — в норме, до неё — выше
    const temp = (d: number) => vitalOn(db, p.patient, p.stay!, 'vital.fever', d)!;
    expect(temp(ready)).toBeLessThan(37.3);
    expect(temp(0)).toBeGreaterThanOrEqual(temp(ready));
    // ночи: пока не разрешилось — «лучше», в срок — «можно выписывать»
    for (let d = 1; d < ready; d++) {
      night(s);
      expect(wardState(p.stay!, daysIn(p.stay!, s.day))).toBe('better');
    }
    night(s);
    expect(wardState(p.stay!, daysIn(p.stay!, s.day))).toBe('ready');
    apply(db, s, { kind: 'discharge', id: p.id });
    expect(p.status).toBe('done');
    expect(p.closed!.outcome).toMatchObject({ kind: 'recovered', day: ready });
    expect(p.closed!.stay).toEqual({ days: ready, norm: 5, end: 'discharged' });
    expect(s.summary.ward).toMatchObject({ discharged: 1, early: 0, stayDays: ready, stayNorm: 5 });
    expect(freeBeds(db, s)).toHaveLength(4);
  });

  test('выписан рано — вернётся хуже; касса: ОМС за случай при выписке, койко-дни вечером', () => {
    const { s } = withWard(22);
    apply(db, s, { kind: 'nextDay' });
    const p = treat(s, 'cond.pneumonia_cap', ['tx.amoxicillin_clavulanate']);
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    apply(db, s, { kind: 'closeDay' });
    // первая ночь: одна койка — один койко-день
    expect(s.summary.economy!.ledger.expenses.ward).toBe(db.economy.ward.bedDay);
    expect(s.summary.ward!.lying).toBe(1);
    apply(db, s, { kind: 'nextDay' });
    apply(db, s, { kind: 'discharge', id: p.id });
    expect(p.closed!.stay).toMatchObject({ days: 1, end: 'early' });
    expect(p.closed!.outcome.kind).toBe('worse');
    expect(s.returns.some(r => r.of === p.id && r.reason === 'worse')).toBe(true);
    expect(s.summary.ward).toMatchObject({ discharged: 1, early: 1 });
    // выписан раньше, чем прошло, — случай прерван: доля тарифа
    const paid = wardIncome(db, p.closed!.diagnosis, p.closed!.grades.defensibility, 'interrupted');
    expect(paid).toBe(Math.round(wardIncome(db, p.closed!.diagnosis, p.closed!.grades.defensibility, 'full') * db.economy.ward.interrupted / 100));
    expect(paid).toBeGreaterThan(0);
    expect(s.economy!.ledger!.ward).toEqual({ cases: 1, income: paid, interrupted: 1, unindicated: 0 });
    // вечером — в итогах дня: случай стационара в доходах, итог дня сходится с кассой
    const cash = s.economy!.cash;
    apply(db, s, { kind: 'closeDay' });
    const day = s.summary.economy!;
    expect(day.ledger.ward).toEqual({ cases: 1, income: paid, interrupted: 1, unindicated: 0 });
    expect(day.cash - cash).toBe(incomeOf(day.ledger) - expensesOf(day.ledger));
  });

  test('не помогает — хуже в срок записи; смена лечения на обходе ведёт к выписке от этих суток', () => {
    const { s } = withWard(23);
    apply(db, s, { kind: 'nextDay' });
    // от пневмонии — только жаропонижающее: на причину не действует
    const p = treat(s, 'cond.pneumonia_cap', ['tx.paracetamol']);
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    expect(p.stay!.readyAfter).toBeUndefined();
    const worse = p.stay!.worseAfter!;
    expect(worse).toBeGreaterThanOrEqual(1);
    for (let d = 0; d < worse; d++) night(s);
    expect(wardState(p.stay!, daysIn(p.stay!, s.day))).toBe('worse');
    const from = daysIn(p.stay!, s.day);
    apply(db, s, { kind: 'replan', id: p.id, treatments: ['tx.amoxicillin_clavulanate', 'tx.paracetamol'] });
    expect(p.stay!.planFrom).toBe(from);
    expect(p.stay!.replans).toBe(1);
    expect(p.stay!.readyAfter! - from).toBeGreaterThanOrEqual(3);
    expect(wardState(p.stay!, from)).toBe('better');
  });

  test('перевод — половина случая; все койки заняты — «В палату» нельзя, приём уходит «направить»', () => {
    const { s } = withWard(24);
    apply(db, s, { kind: 'nextDay' });
    const placed: ShiftPatient[] = [];
    for (let i = 0; i < 4; i++) {
      const p = treat(s, 'cond.pneumonia_cap', ['tx.amoxicillin_clavulanate']);
      apply(db, s, { kind: 'setting', setting: 'admit' });
      apply(db, s, { kind: 'finish' });
      placed.push(p);
    }
    expect(inpatientsOf(s)).toHaveLength(4);
    expect(freeBeds(db, s)).toEqual([]);
    const fifth = treat(s, 'cond.pneumonia_cap', ['tx.amoxicillin_clavulanate']);
    apply(db, s, { kind: 'setting', setting: 'admit' });
    expect(fifth.draft.setting).toBe('home'); // нет койки — выбор не принят
    // выбрали, пока койка была, а её заняли (нанятый врач положил своего), — направить
    fifth.draft.setting = 'admit';
    apply(db, s, { kind: 'finish' });
    expect(fifth.status).toBe('done');
    expect(fifth.stay).toBeUndefined();
    expect(fifth.closed!.plan.setting).toBe('ward');
    apply(db, s, { kind: 'transfer', id: placed[0].id });
    expect(placed[0].closed!.outcome.kind).toBe('transferred');
    expect(placed[0].closed!.stay!.end).toBe('transferred');
    const full = wardIncome(db, 'cond.pneumonia_cap', 'A', 'full');
    expect(wardIncome(db, 'cond.pneumonia_cap', 'A', 'interrupted')).toBe(Math.round(full / 2));
    expect(s.economy!.ledger!.ward).toMatchObject({ cases: 1, interrupted: 1, unindicated: 0 });
    expect(freeBeds(db, s)).toHaveLength(1);
  });

  test('госпитализация без показаний: разбор — «лишнее», страховая случай не оплачивает, койко-дни — расход', () => {
    const { s } = withWard(27);
    apply(db, s, { kind: 'nextDay' });
    const p = treat(s, 'cond.arvi', ['tx.rest_fluids'], {});
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.grades.setting).not.toBe('A');
    for (let d = 0; d < (p.stay!.readyAfter ?? 1); d++) night(s);
    apply(db, s, { kind: 'discharge', id: p.id });
    expect(s.economy!.ledger!.ward).toEqual({ cases: 1, income: 0, interrupted: 0, unindicated: 1 });
    expect(s.history.every(h => (h.economy?.ledger.expenses.ward ?? 0) === db.economy.ward.bedDay)).toBe(true);
  });

  test('лежащие не пропадают из смены через неделю; ночи — те же при тех же командах', () => {
    const run = () => {
      const { s } = withWard(25);
      apply(db, s, { kind: 'nextDay' });
      const p = treat(s, 'cond.pyelonephritis', ['tx.fluoroquinolone']);
      apply(db, s, { kind: 'setting', setting: 'admit' });
      apply(db, s, { kind: 'finish' });
      for (let d = 0; d < 9; d++) night(s);
      return { s, p: s.patients[p.id] };
    };
    const a = run();
    const b = run();
    expect(a.p?.status).toBe('admitted');
    expect(a.p.stay).toEqual(b.p.stay);
    expect(expensesOf(a.s.economy!.ledger ?? emptyLedger())).toBe(expensesOf(b.s.economy!.ledger ?? emptyLedger()));
  });
});

describe('стационар: архив профиля', () => {
  test('поступивший записан в профиль один раз; выписан — в архиве его приём с исходом', async () => {
    setProfileStore(memoryStore());
    forgetProfile();
    await loadProfile();
    const { s } = withWard(26);
    apply(db, s, { kind: 'nextDay' });
    const p = treat(s, 'cond.pneumonia_cap', ['tx.amoxicillin_clavulanate']);
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    const rec = () => [{ seed: s.meta.seed, department: s.meta.department, day: 1, patient: s.patients[p.id] }];
    expect(recordCases(rec())).toBe(1);
    const key = caseKey(s.meta.seed, p.id);
    expect(profile().archive.find(r => r.key === key)!.patient.status).toBe('admitted');
    for (let d = 0; d < p.stay!.readyAfter!; d++) night(s);
    apply(db, s, { kind: 'discharge', id: p.id });
    expect(recordCases(rec())).toBe(0);
    const after = profile().archive.find(r => r.key === key)!.patient;
    expect(after.status).toBe('done');
    expect(after.closed!.outcome.kind).toBe('recovered');
    expect(profile().stats.cases).toBe(1);
    expect(profile().archive).toHaveLength(1);
    forgetProfile();
  });
});
