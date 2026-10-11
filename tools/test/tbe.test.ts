// Клещевой энцефалит (spec 2026-10-chapter-4, часть 51б; 567_2): лихорадочная, менингеальная, менингоэнцефалитическая и
// полиомиелитическая формы; интерферон альфа-2b всем в первые 7 суток, иммуноглобулин — только при лихорадочной форме, при
// очаговых — вред (раздел 3.1); палата, при судорогах и слабости шеи — ПИТ, при коме и дыхательной недостаточности —
// реанимация с ИВЛ (раздел 3.2).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { evaluatePlan, type Plan, primaryOf, recommendedSetting, selfLimits, tacticsFor, txRole, verdictOf } from '../../src/engine/med/plan';
import { examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { whenText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const TBE = 'cond.tbe';
const IG = 'tx.tbe_ig';
const IFN = 'tx.interferon_a2b';
const DEPTS = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
const FORMS = ['fever', 'meningeal', 'encephalitic', 'encephalitic_coma', 'polio', 'polio_breath'] as const;

const patient = (form: string, seed = 5252): Patient =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: DEPTS, season: 'summer', primary: TBE, params: { form }, carried: db.economy.ambulance.weight });
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const paramsOf = (form: string) => patient(form).truth.conditions[0].params;

/** Доля больных с признаком — по генератору. */
function share(form: string, f: string, n = 200): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (has(patient(form, 80_000 + i), f)) k++;
  return k / n;
}

describe('клещевой энцефалит: болезнь и признаки', () => {
  test('инфекционное отделение без изоляции, весна и лето, подтверждают антитела; правило пункции — и о нём', () => {
    expect(db.conditions[TBE]).toMatchObject({ department: 'dept.infectious', icd10: 'A84', confirm: ['exam.tbe_elisa'] });
    expect(db.conditions[TBE].isolation).toBeUndefined();
    const who = { sex: 'm' as const, age: 45, risks: [], chronic: [] };
    expect(presentingWeight(db.conditions[TBE], { ...who, season: 'winter' })).toBe(0);
    expect(presentingWeight(db.conditions[TBE], { ...who, season: 'summer' })).toBeGreaterThan(0);
    expect(presentingWeight(db.conditions[TBE], { ...who, season: 'summer' })).toBeLessThan(presentingWeight(db.conditions['cond.lyme'], { ...who, season: 'summer' }));
    expect(db.rules['rule.lp_safe'].about).toContain(TBE);
    expect(db.exams['exam.tbe_elisa']).toMatchObject({ room: 'room.lab', equipment: ['eq.immuno_analyzer'], collect: 'room.procedure' });
  });

  test('по формам: менингеальная — ригидность и цитоз у каждого, у лихорадочной ликвор чистый; кома, свисающая голова, сатурация', () => {
    expect(share('meningeal', 'sign.neck_stiffness')).toBe(1);
    expect(share('meningeal', 'lab.csf_pleocytosis')).toBe(1);
    expect(share('fever', 'lab.csf_pleocytosis')).toBe(0);
    expect(share('encephalitic_coma', 'sign.gcs_coma')).toBe(1);
    expect(share('encephalitic', 'sign.gcs_coma')).toBe(0);
    expect(share('polio', 'sign.head_drop')).toBe(1);
    expect(patient('polio').complaints).toContain('sym.neck_weakness');
    expect(share('polio_breath', 'vital.spo2_low')).toBe(1);
    expect(share('polio', 'vital.spo2_low')).toBeLessThan(0.1);
    const tick = share('meningeal', 'hx.tick_bite_recent');
    expect(tick).toBeGreaterThan(0.65);
    expect(tick).toBeLessThan(0.85);
  });

  test('производные: очаговые — менингоэнцефалитическая и полиомиелитическая, ИВЛ — при коме и дыхательной недостаточности', () => {
    expect([paramsOf('meningeal').focal, paramsOf('encephalitic').focal, paramsOf('polio').focal]).toEqual(['no', 'yes', 'yes']);
    expect([paramsOf('encephalitic').vent, paramsOf('encephalitic_coma').vent, paramsOf('polio_breath').vent]).toEqual(['no', 'yes', 'yes']);
  });
});

describe('клещевой энцефалит: лечение и место', () => {
  test('интерферон альфа-2b — первая линия; иммуноглобулин: лихорадочная — допустимо, менингеальная — не показано, очаговые — вредно', () => {
    const t = db.conditions[TBE].treatment!;
    expect(t.firstLine).toEqual([IFN]);
    expect(txRole(db, TBE, IG, paramsOf('fever'))).toBe('acceptable');
    expect(txRole(db, TBE, IG, paramsOf('meningeal'))).toBe('notIndicated');
    for (const form of ['encephalitic', 'encephalitic_coma', 'polio', 'polio_breath']) expect(txRole(db, TBE, IG, paramsOf(form))).toBe('harmful');
    expect(tacticsFor(t, paramsOf('encephalitic_coma')).require).toEqual(['tx.ventilation']);
    expect(tacticsFor(t, paramsOf('polio_breath')).require).toEqual(['tx.ventilation']);
    expect(tacticsFor(t, paramsOf('polio')).require).toBeUndefined();
  });

  test('место: палата; судороги и слабость шеи — ПИТ; кома и дыхательная недостаточность — реанимация', () => {
    expect(recommendedSetting(db, patient('fever'), [])).toBe('ward');
    expect(recommendedSetting(db, patient('meningeal'), [])).toBe('ward');
    expect(recommendedSetting(db, patient('polio'), [])).toBe('icu');
    expect(recommendedSetting(db, patient('encephalitic_coma'), [])).toBe('ricu');
    expect(recommendedSetting(db, patient('polio_breath'), [])).toBe('ricu');
  });

  test('лихорадочная и менингеальная проходят сами; очаговые без интерферона — хуже; иммуноглобулин при очаговых — вред', () => {
    for (const form of FORMS) {
      const p = patient(form);
      const expected = form === 'fever' || form === 'meningeal';
      expect(evaluatePlan(db, p, { treatments: [IFN], setting: 'admit' }, []).effective).toBe(true);
      expect(selfLimits(db, primaryOf(p))).toBe(expected);
    }
    const focal = patient('encephalitic', 81_000);
    const home: Plan = { treatments: ['tx.paracetamol'], setting: 'home' };
    const outs = Array.from({ length: 200 }, (_, i) => observe(db, focal, home, evaluatePlan(db, focal, home, []), Rng.seeded(i).fork('out')));
    expect(outs.filter(o => o.kind === 'worse').length / outs.length).toBeGreaterThan(0.6);
    const ig: Plan = { treatments: [IFN, IG], setting: 'home' };
    expect(evaluatePlan(db, focal, ig, []).roles.find(r => r.tx === IG)?.role).toBe('harmful');
  });

  test('энциклопедия: формы и условия словами; «С чем спутать» — менингококковая инфекция, герпетический энцефалит, Лайм', () => {
    for (const form of FORMS) expect(whenText({ form: [form] })).toEqual(expect.any(String));
    for (const k of ['focal', 'vent']) for (const v of ['yes', 'no']) expect(whenText({ [k]: [v] })).toEqual(expect.any(String));
    expect(whenText({ form: ['encephalitic', 'encephalitic_coma', 'polio', 'polio_breath'] })).toBe('при очаговой форме');
    expect(db.conditions[TBE].differential).toEqual(['cond.meningococcal', 'cond.hsv_encephalitis', 'cond.lyme']);
    for (const id of [TBE, 'exam.tbe_elisa', IFN, 'tx.ribavirin', 'sign.head_drop']) expect(article(db, id)).toBeDefined();
  });
});

describe('разумный врач при клещевом энцефалите', () => {
  const candidates = Object.keys(db.conditions).filter(id => db.conditions[id].presenting && DEPTS.includes(db.conditions[id].department));
  const exams = Object.keys(db.exams).sort();
  const venue = { ward: true, icu: true, ricu: true, box: true, bedside: ['eq.monitor_defib'] };

  function run(p: Patient): { done: string[]; diagnosis: string; plan: Plan } {
    const observations: Observation[] = complaintObservations(p);
    const done: string[] = [];
    const rng = Rng.seeded(p.seed).fork('doctor:rational');
    let phase = {};
    let t = 0;
    for (;;) {
      const r = nextStep(db, p, observations, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes: t } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, diagnosis: r.step.diagnosis, plan: r.step.plan };
      observations.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
      done.push(r.step.exam);
      t += examMinutes(db.exams[r.step.exam]);
    }
  }

  test('менингеальная — ставит энцефалит, интерферон, палата; кома — реанимация с ИВЛ; свисающая голова — ПИТ', () => {
    const n = 20;
    let right = 0, ifn = 0, ward = 0, ricu = 0, icu = 0;
    for (let i = 0; i < n; i++) {
      const p = patient('meningeal', 82_000 + i);
      const r = run(p);
      if (verdictOf(db, r.diagnosis, p) === 'correct') right++;
      if (r.plan.treatments.includes(IFN)) ifn++;
      if (r.plan.setting === 'admit') ward++;
      const coma = run(patient('encephalitic_coma', 83_000 + i));
      if (coma.plan.setting === 'ricu' && coma.plan.treatments.includes('tx.ventilation')) ricu++;
      if (run(patient('polio', 84_000 + i)).plan.setting === 'icu') icu++;
    }
    expect(right / n).toBeGreaterThan(0.85);
    expect(ifn / n).toBeGreaterThan(0.85);
    expect(ward / n).toBeGreaterThan(0.85);
    expect(ricu / n).toBeGreaterThan(0.85);
    expect(icu / n).toBeGreaterThan(0.85);
  }, 120_000);
});
