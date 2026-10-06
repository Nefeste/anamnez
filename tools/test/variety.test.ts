// Больные: реализм или разнообразие (spec 2026-10-variety, 0.3.11): с разнообразием жребий основного
// заболевания — по сглаженным весу записи и сезону; человек, вывод и разбор — как в жизни. В
// практике, «Смене» и песочнице; кампания — всегда как в жизни. Заодно — «Смена» в больнице главы:
// первый день — в этой больнице.
import { afterEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Season } from '../../src/content/types';
import { generatePatient, VARIETY_POWER } from '../../src/engine/med/generate';
import { apply, newCampaign, newSandbox, newShift, newSingle } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { closeDay, forgetShift, setStore, shiftState, startShift, startSingle } from '../../src/state/session';
import { forgetSettings, sanitize, updateSettings } from '../../src/state/settings';
import { memoryStore } from '../../src/state/saves';

const SEASONS: Season[] = ['winter', 'spring', 'summer', 'autumn'];
const THERAPY = ['dept.therapy'];

/** Доли основного заболевания у пришедших сами, %. */
function shares(n: number, variety: boolean, departments = THERAPY): Record<string, number> {
  const count: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const p = generatePatient(db, 3_100_000 + i, { department: departments[0], departments, season: SEASONS[i % 4], walkIn: true, ...(variety ? { variety: true } : {}) });
    const id = p.truth.conditions[0].id;
    count[id] = (count[id] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(count).map(([id, k]) => [id, (100 * k) / n]));
}

const primaries = (s: ShiftState, day: number) =>
  Object.values(s.patients).filter(p => p.id.startsWith(`${day}-`)).map(p => p.patient.truth.conditions[0].id);

afterEach(() => {
  forgetShift();
  forgetSettings();
});

describe('жребий болезни', () => {
  test('степень сглаживания — ¼: при ½ ОРВИ и грипп остаются по 9–10 %, при 0 пропадает сезон', () => {
    expect(VARIETY_POWER).toBe(0.25);
  });

  test('реализм — как было: без флага и с variety: false пациенты те же, бит в бит', () => {
    for (let i = 0; i < 200; i++) {
      const ctx = { department: 'dept.therapy', season: SEASONS[i % 4] };
      expect(generatePatient(db, 5_000 + i, { ...ctx, variety: false })).toEqual(generatePatient(db, 5_000 + i, ctx));
    }
  });

  test('разнообразие в амбулатории: ни одной болезни больше 8 %, ОРВИ меньше 8 %; ОКС, аппендицит и анафилаксия — не меньше 1,5 %', () => {
    const real = shares(8000, false);
    const varied = shares(8000, true);
    expect(real['cond.arvi']).toBeGreaterThan(15);
    expect(Math.max(...Object.values(varied))).toBeLessThan(8);
    expect(varied['cond.arvi']).toBeLessThan(8);
    for (const id of ['cond.acs', 'cond.appendicitis', 'cond.anaphylaxis']) {
      expect(real[id]).toBeLessThan(1);
      expect(varied[id]).toBeGreaterThanOrEqual(1.5);
    }
    // болезней, которые встретились хоть раз, не меньше
    expect(Object.keys(varied).length).toBeGreaterThanOrEqual(Object.keys(real).length);
  }, 30_000);

  test('человек тот же: пол, возраст, привычки и хронические болезни — как без разнообразия; другое только основное заболевание', () => {
    let differ = 0;
    for (let i = 0; i < 300; i++) {
      const ctx = { department: 'dept.therapy', season: SEASONS[i % 4], walkIn: true };
      const a = generatePatient(db, 8_000 + i, ctx);
      const b = generatePatient(db, 8_000 + i, { ...ctx, variety: true });
      expect([b.sex, b.age, b.truth.risks]).toEqual([a.sex, a.age, a.truth.risks]);
      // порядок не важен: болезнь, которой нужна хроническая (криз — гипертония), ставит её сразу за собой
      const comorbid = (p: typeof a) => p.truth.conditions.filter(c => c.role === 'comorbid').sort((x, y) => (x.id < y.id ? -1 : 1));
      expect(comorbid(b)).toEqual(comorbid(a));
      if (b.truth.conditions[0].id !== a.truth.conditions[0].id) differ++;
    }
    expect(differ).toBeGreaterThan(50);
  });

  test('кто чем болеет — по-прежнему: возраст записи соблюдён, цистит — в основном у женщин', () => {
    let cystitis = 0;
    let women = 0;
    for (let i = 0; i < 4000; i++) {
      const p = generatePatient(db, 11_000 + i, { department: 'dept.therapy', season: SEASONS[i % 4], walkIn: true, variety: true });
      const c = db.conditions[p.truth.conditions[0].id];
      expect(p.age).toBeGreaterThanOrEqual(c.age.min);
      expect(p.age).toBeLessThanOrEqual(c.age.max);
      if (c.id === 'cond.cystitis') {
        cystitis++;
        if (p.sex === 'f') women++;
      }
    }
    expect(cystitis).toBeGreaterThan(20);
    expect(women / cystitis).toBeGreaterThan(0.8);
  }, 30_000);

  test('с неврологией: ТИА и инсульт — чаще, чем в жизни', () => {
    const deps = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
    const real = shares(6000, false, deps);
    const varied = shares(6000, true, deps);
    expect(varied['cond.tia']).toBeGreaterThan(2 * real['cond.tia']);
  }, 30_000);
});

describe('смена', () => {
  test('новая практика с разнообразием — с первого дня; без него — прежние пациенты', () => {
    const real = newShift(db, { seed: 77, season: 'winter' });
    const varied = newShift(db, { seed: 77, season: 'winter', variety: true });
    expect(real.meta.variety).toBeUndefined();
    expect(varied.meta.variety).toBe(true);
    expect(newShift(db, { seed: 77, season: 'winter', variety: false })).toEqual(real);
    expect(primaries(varied, 1)).not.toEqual(primaries(real, 1));
    // люди те же — приходят в то же время
    expect(Object.values(varied.patients).map(p => [p.arriveT, p.patient.sex, p.patient.age])).toEqual(Object.values(real.patients).map(p => [p.arriveT, p.patient.sex, p.patient.age]));
  });

  test('переключили посреди дня — сегодняшние больные прежние, завтрашние — с новой настройкой', () => {
    const s = newShift(db, { seed: 78, season: 'winter' });
    const same = newShift(db, { seed: 78, season: 'winter' });
    const today = primaries(s, 1);
    apply(db, s, { kind: 'variety', on: true });
    expect(s.meta.variety).toBe(true);
    expect(primaries(s, 1)).toEqual(today);
    for (const x of [s, same]) {
      apply(db, x, { kind: 'closeDay' });
      apply(db, x, { kind: 'nextDay' });
    }
    expect(primaries(s, 2)).not.toEqual(primaries(same, 2));
    apply(db, s, { kind: 'variety', on: false });
    expect(s.meta.variety).toBeUndefined();
  });

  test('в кампании настройка больных не меняет', () => {
    const a = newCampaign(db, { seed: 79, season: 'winter', career: 1 });
    const b = newCampaign(db, { seed: 79, season: 'winter', career: 1 });
    apply(db, b, { kind: 'variety', on: true });
    for (const x of [a, b]) apply(db, x, { kind: 'nextDay' });
    expect(primaries(b, 1)).toEqual(primaries(a, 1));
  });

  test('песочница: с разнообразием — с первого открытого дня', () => {
    const opts = { seed: 80, season: 'winter' as Season, start: 'clinic' as const, budget: db.economy.sandbox.budgets.generous };
    const a = newSandbox(db, opts);
    const b = newSandbox(db, { ...opts, variety: true });
    for (const x of [a, b]) apply(db, x, { kind: 'nextDay' });
    expect(a.day).toBe(1);
    expect(primaries(b, 1)).not.toEqual(primaries(a, 1));
  });

  test('«Смена» в районной больнице — в первый же день скорая и болезни всех её отделений', () => {
    const s = newSingle(db, { seed: 81, season: 'winter', venue: 'preset.district' });
    const ps = Object.values(s.patients);
    expect(ps.some(p => p.kind === 'ambulance')).toBe(true);
    const depts = new Set(ps.flatMap(p => p.departments ?? []));
    expect([...depts].sort()).toEqual(['dept.surgery', 'dept.therapy', 'dept.trauma']);
    // в амбулатории практики — прежние пациенты
    const clinic = newSingle(db, { seed: 81, season: 'winter', venue: 'preset.clinic' });
    expect(Object.values(clinic.patients).map(p => p.patient)).toEqual(Object.values(newShift(db, { seed: 81, season: 'winter' }).patients).map(p => p.patient));
  });
});

describe('настройки', () => {
  test('нет поля или испорчено — реализм', () => {
    expect(sanitize({ sound: 0.35 }).variety).toBe(false);
    expect(sanitize({ variety: true }).variety).toBe(true);
    expect(sanitize({ variety: 'yes' }).variety).toBe(false);
  });

  test('новая игра — с настройкой; посреди игры сессия переносит её в смену перед командой', async () => {
    setStore(memoryStore());
    updateSettings({ variety: true });
    startShift(90, 'winter');
    expect(shiftState()!.meta.variety).toBe(true);
    updateSettings({ variety: false });
    closeDay();
    expect(shiftState()!.meta.variety).toBeUndefined();
    expect(await startSingle({ venue: 'preset.clinic', difficulty: 'student', seed: 91, season: 'winter' })).toBe(true);
    expect(shiftState()!.meta.variety).toBeUndefined();
    updateSettings({ variety: true });
    expect(await startSingle({ venue: 'preset.clinic', difficulty: 'student', seed: 91, season: 'winter' })).toBe(true);
    expect(shiftState()!.meta.variety).toBe(true);
  });
});
