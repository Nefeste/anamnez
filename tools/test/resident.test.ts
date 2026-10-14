// «Ординатор» — уровень между «Студентом» и «Врачом» (spec 2026-10-resident, 0.5.8; 03-game-design.md §14): обследования
// ошибаются, как у «Врача», пациенты ждут в 1,2 раза дольше, «Похоже на» — до трёх болезней, уверенность — словами
// (FR-DX-8: числом, словами или никак).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { generatePatient } from '../../src/engine/med/generate';
import { apply, newShift } from '../../src/engine/shift/engine';
import { type Difficulty, easyLevel } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { confidenceWord, makeCaseView } from '../../src/state/caseView';

const PNEUMONIA = 'cond.pneumonia_cap';

describe('«Ординатор»: смена', () => {
  /** Пришедшие за пять часов приёма — с терпением (у «красных» его нет). */
  const morning = (difficulty: Difficulty) => {
    const s = newShift(db, { seed: 12, season: 'winter', difficulty });
    for (let i = 0; i < 300; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    return Object.values(s.patients).filter(p => p.status !== 'coming' && p.patience > 0).sort((a, b) => (a.id < b.id ? -1 : 1));
  };

  test('пациенты ждут в 1,2 раза дольше, чем у «Врача», и меньше, чем у «Студента»', () => {
    const doctor = morning('doctor');
    const resident = morning('resident');
    const student = morning('student');
    expect(resident.map(p => p.id)).toEqual(doctor.map(p => p.id));
    expect(doctor.length).toBeGreaterThan(3);
    for (const [i, p] of resident.entries()) {
      // терпение — минуты зерна, умноженные на множитель уровня, в секундах с округлением
      expect(Math.abs(p.patience - doctor[i].patience * 1.2)).toBeLessThanOrEqual(1);
      // у «Студента» обследования не ошибаются — срочность бывает другой, а с ней и терпение; сравнимы — при той же
      const same = student.find(x => x.id === p.id);
      if (same && same.triage === p.triage) expect(p.patience).toBeLessThan(same.patience);
    }
  });

  test('обследования ошибаются, как у «Врача»: «Ординатор» — не лёгкий уровень', () => {
    expect(easyLevel('resident')).toBe(false);
    expect(easyLevel('student')).toBe(true);
  });
});

describe('«Ординатор»: карта пациента', () => {
  const p = generatePatient(db, 41, { department: 'dept.therapy', season: 'winter' });
  const view = (difficulty: Difficulty) => makeCaseView({
    version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [],
    draft: { treatments: [], setting: 'home', hypotheses: [PNEUMONIA] }, difficulty,
  });

  test('«Похоже на» — до трёх болезней, словом вместо числа; те же болезни, что у «Студента», по порядку', () => {
    const resident = view('resident');
    const student = view('student');
    expect(resident.hints.length).toBeGreaterThan(0);
    expect(resident.hints.length).toBeLessThanOrEqual(3);
    expect(resident.hints.map(h => h.id)).toEqual(student.hints.slice(0, resident.hints.length).map(h => h.id));
    for (const h of resident.hints) expect(T.spikes.differential.words).toContain(h.word!);
    expect(student.hints.every(h => h.word === undefined)).toBe(true);
  });

  test('уверенность в гипотезе — словом; у «Студента» — числом, у «Врача» — никак', () => {
    const [resident] = view('resident').differential;
    expect(resident.outOf10).toBeUndefined();
    expect(T.spikes.differential.words).toContain(resident.word!);
    expect(view('student').differential[0].outOf10).toBeDefined();
    expect(view('doctor').differential[0].word).toBeUndefined();
    expect(view('doctor').differential[0].outOf10).toBeUndefined();
  });

  test('слова — по шкале: от «едва ли» до «почти наверняка», границы 1, 3, 6 и 9 из 10', () => {
    expect([0, 0.09, 0.1, 0.29, 0.3, 0.59, 0.6, 0.89, 0.9, 1].map(confidenceWord)).toEqual([
      'едва ли', 'едва ли', 'маловероятно', 'маловероятно', 'возможно', 'возможно', 'вероятно', 'вероятно', 'почти наверняка', 'почти наверняка',
    ]);
  });

  test('выбор уровня — четыре вкладки, у каждой своё пояснение', () => {
    const t = T.shift.difficulty;
    for (const d of ['trainee', 'student', 'resident', 'doctor']) {
      expect(t[d].length).toBeGreaterThan(3);
      expect(t[`${d}Text`].length).toBeGreaterThan(20);
    }
    expect(t.resident).toBe('Ординатор');
  });
});
