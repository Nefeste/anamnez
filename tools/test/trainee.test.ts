// «Практикант» — самый простой уровень (spec 2026-10-trainee, 0.5.4): как «Студент», и в карте пациента сверху — то,
// что относится к жалобе, а разбор мягче.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { generatePatient } from '../../src/engine/med/generate';
import type { PlanEval } from '../../src/engine/med/plan';
import { scoreCase } from '../../src/engine/med/score';
import { apply, newShift } from '../../src/engine/shift/engine';
import { easyLevel } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { complaintExams, examsByAction, makeCaseView, noteText } from '../../src/state/caseView';

const SEASONS = ['winter', 'spring', 'summer', 'autumn'] as const;
const CITY = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];

describe('«Практикант»: что относится к жалобе', () => {
  // настоящая болезнь — среди болезней с жалобой: её признаки всегда сверху
  for (const [where, departments, n] of [['амбулатория', ['dept.therapy'], 1000], ['больница главы 4', CITY, 400]] as const) {
    test(`${where}: настоящая болезнь — среди болезней с жалобой у каждого с жалобами; списки короче`, () => {
      let withComplaints = 0;
      let listed = 0;
      let all = 0;
      for (let i = 0; i < n; i++) {
        const p = generatePatient(db, 9_000_000 + i, { department: 'dept.therapy', departments: [...departments], season: SEASONS[i % 4] });
        const focus = new Set(complaintExams(p, departments));
        if (p.complaints.length === 0) {
          expect(focus.size).toBe(0);
          continue;
        }
        withComplaints++;
        const truth = db.conditions[p.truth.conditions[0].id];
        expect({ id: truth.id, told: truth.findings.some(l => p.complaints.includes(l.f) && l.p > 0) }).toEqual({ id: truth.id, told: true });
        // признак болезни, который проверяет обследование, — сверху: хоть одно обследование её признаков
        expect(examsByAction(p).ask.concat(examsByAction(p).examine, examsByAction(p).order).some(e => focus.has(e))).toBe(true);
        const fits = Object.values(examsByAction(p)).flat();
        listed += fits.filter(e => focus.has(e)).length;
        all += fits.length;
      }
      expect(withComplaints).toBeGreaterThan(0.9 * n);
      // сверху — меньше половины того, что подходит пациенту
      expect(listed / all).toBeLessThan(0.6);
    }, 60_000);
  }

  test('факторы риска и противопоказания — сверху: о хронических болезнях и об аллергии при кашле спрашивают', () => {
    const p = generatePatient(db, 1, { department: 'dept.therapy', season: 'winter', primary: 'cond.pneumonia_cap' });
    const focus = complaintExams(p, ['dept.therapy']);
    expect(p.complaints.length).toBeGreaterThan(0);
    // ХОБЛ — множитель пневмонии, аллергия на пенициллин — противопоказание к амоксициллину
    expect(focus).toContain('exam.ask_chronic');
    expect(focus).toContain('exam.ask_allergies');
  });

  test('вид приёма: список — только у «Практиканта» и только у пациента с жалобами; подсказки — как у «Студента»', () => {
    const p = generatePatient(db, 5, { department: 'dept.therapy', season: 'winter', primary: 'cond.pneumonia_cap' });
    const view = (difficulty: 'trainee' | 'student' | 'doctor', patient = p) => makeCaseView({
      version: 0, patient, clock: 600, minutesSpent: 0, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [],
      draft: { treatments: [], setting: 'home' }, difficulty,
    });
    expect(view('trainee').focus).toEqual(complaintExams(p, ['dept.therapy']));
    expect(view('student').focus).toBeUndefined();
    expect(view('doctor').focus).toBeUndefined();
    expect(view('trainee').hints.length).toBeGreaterThan(0);
    expect(view('doctor').hints).toEqual([]);
    expect(view('trainee', { ...p, complaints: [] }).focus).toBeUndefined();
  });
});

describe('«Практикант»: как «Студент» и разбор мягче', () => {
  test('обследования без ошибок и терпение ×1,5 — как у «Студента»', () => {
    expect(easyLevel('trainee')).toBe(true);
    expect(easyLevel('student')).toBe(true);
    expect(easyLevel('doctor')).toBe(false);
    expect(easyLevel(undefined)).toBe(false);
    // терпение назначается пришедшему; те же люди на всех уровнях (то же зерно), но на «Враче» измерения медсестры
    // ошибаются, и срочность может выйти другой — сравниваются пришедшие с терпением на обоих уровнях
    const patience = (difficulty: 'trainee' | 'student' | 'doctor') => {
      const s = newShift(db, { seed: 77, season: 'winter', difficulty });
      for (let i = 0; i < 180; i++) apply(db, s, { kind: 'advance', seconds: 60 });
      return Object.fromEntries(Object.values(s.patients).filter(x => x.patience > 0).map(x => [x.id, { patience: x.patience, triage: x.triage }]));
    };
    const [trainee, student, doctor] = [patience('trainee'), patience('student'), patience('doctor')];
    expect(Object.keys(trainee).length).toBeGreaterThanOrEqual(3);
    expect(trainee).toEqual(student);
    const both = Object.keys(trainee).filter(id => doctor[id]?.triage === trainee[id].triage);
    expect(both.length).toBeGreaterThanOrEqual(3);
    for (const id of both) expect(trainee[id].patience).toBeGreaterThan(doctor[id].patience);
  });

  test('обоснованность и бережливость в общую оценку не входят; строка разбора — когда они ниже «A»', () => {
    const plan = {
      roles: [{ tx: 'tx.amoxicillin', role: 'firstLine' }], effective: true, violations: [], unaskedRisk: [], examHarms: [], preventMissing: [],
      requireMissing: [], requireWhen: {}, beforeTransferMissing: [], beforeTransferWhen: {}, companionsMissing: [], preHospital: [],
      setting: { chosen: 'home', recommended: 'home', also: [] },
    } as unknown as PlanEval;
    // верный диагноз и лечение, но наугад (уверенность 0,1) и вчетверо дороже разумного пути
    const base = { verdict: 'correct' as const, confidence: 0.1, cost: 400, rationalCost: 100, plan, outcome: { kind: 'recovered' } as never, selfLimiting: false, redFlags: [] };
    const doctor = scoreCase(base);
    const trainee = scoreCase({ ...base, lenient: true });
    expect([doctor.defensibility, doctor.thrift]).toEqual(['D', 'D']);
    expect([trainee.defensibility, trainee.thrift]).toEqual(['D', 'D']);
    expect(doctor.overall).toBe('B');
    expect(trainee.overall).toBe('A');
    expect(trainee.notes.map(n => n.code)).toContain('level.lenient');
    expect(doctor.notes.map(n => n.code)).not.toContain('level.lenient');
    expect(noteText({ code: 'level.lenient' })).toContain('«Практикант»');
    // всё на «A» — строки нет
    expect(scoreCase({ ...base, confidence: 0.9, cost: 100, lenient: true }).notes.map(n => n.code)).not.toContain('level.lenient');
  });

  test('выбор сложности: три уровня, у каждого своя подпись', () => {
    for (const k of ['trainee', 'student', 'doctor']) {
      expect(T.shift.difficulty[k].length).toBeGreaterThan(0);
      expect(T.shift.difficulty[`${k}Text`].length).toBeGreaterThan(0);
    }
    expect(T.shift.difficulty.trainee).toBe('Практикант');
  });
});
