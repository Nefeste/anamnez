// Острые гепатиты A и B (spec 2026-10-chapter-4, часть 52а; 718_2, 672_2): желтушная форма — желтуха, тёмная моча, светлый
// кал, увеличенная печень; тяжесть по билирубину и протромбиновому индексу; маркёры различают A и B. Гепатит A — бокс,
// режим и диета, противовирусные не показаны; гепатит B — палата, при тяжёлой и молниеносной форме — энтекавир или
// тенофовир; печёночная кома — реанимация, растворы и глюкокортикоид, перевод на трансплантацию не ошибка.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { evaluatePlan, type Plan, primaryOf, recommendedSetting, selfLimits, tacticsFor, txRole, verdictOf } from '../../src/engine/med/plan';
import { examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { whenText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const HA = 'cond.hepatitis_a';
const HB = 'cond.hepatitis_b';
const NUC = 'tx.nucleoside_analog';
const DEPTS = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];

const patient = (cond: string, severity: string, seed = 5454): Patient =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: DEPTS, season: 'autumn', primary: cond, params: { severity }, carried: db.economy.ambulance.weight });
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const paramsOf = (cond: string, severity: string) => patient(cond, severity).truth.conditions[0].params;

/** Доля больных с признаком — по генератору. */
function share(cond: string, severity: string, f: string, n = 200): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (has(patient(cond, severity, 95_000 + i), f)) k++;
  return k / n;
}

describe('гепатиты: болезни и признаки', () => {
  test('инфекционное отделение; гепатит A — бокс, осень и зима; гепатит B — без изоляции, реже A; оба — вирусный гепатит', () => {
    expect(db.conditions[HA]).toMatchObject({ department: 'dept.infectious', icd10: 'B15', isolation: 'contact', group: 'grp.viral_hepatitis', confirm: ['exam.hepatitis_markers'] });
    expect(db.conditions[HB]).toMatchObject({ department: 'dept.infectious', icd10: 'B16.9', group: 'grp.viral_hepatitis', confirm: ['exam.hepatitis_markers'] });
    expect(db.conditions[HB].isolation).toBeUndefined();
    const who = { sex: 'm' as const, age: 35, risks: [], chronic: [] };
    expect(presentingWeight(db.conditions[HA], { ...who, season: 'autumn' })).toBeGreaterThan(presentingWeight(db.conditions[HA], { ...who, season: 'summer' }));
    expect(presentingWeight(db.conditions[HB], { ...who, season: 'autumn' })).toBeLessThan(presentingWeight(db.conditions[HA], { ...who, season: 'autumn' }));
    expect(verdictOf(db, HB, patient(HA, 'mild'))).toBe('partly');
  });

  test('желтуха — у каждого и среди жалоб; маркёры — свои; билирубин выше 200 и низкий ПТИ — с тяжёлой; кома — со спутанностью', () => {
    for (const [cond, sev] of [[HA, 'mild'], [HA, 'severe'], [HB, 'moderate'], [HB, 'fulminant']] as const) {
      expect(share(cond, sev, 'sign.jaundice')).toBe(1);
      expect(share(cond, sev, 'lab.alt_high')).toBe(1);
    }
    expect(patient(HA, 'mild').complaints).toContain('sym.yellow_skin');
    expect(share(HA, 'moderate', 'lab.hav_igm')).toBe(1);
    expect(share(HA, 'moderate', 'lab.hbv_markers')).toBeLessThan(0.03);
    expect(share(HB, 'moderate', 'lab.hbv_markers')).toBe(1);
    expect(share(HB, 'moderate', 'lab.hav_igm')).toBeLessThan(0.03);
    expect(share(HA, 'moderate', 'lab.bilirubin_200')).toBeLessThan(0.03);
    expect(share(HA, 'severe', 'lab.bilirubin_200')).toBe(1);
    expect(share(HB, 'severe', 'lab.pti_low')).toBe(1);
    expect(share(HA, 'coma', 'sign.gcs_coma')).toBe(1);
    expect(share(HB, 'fulminant', 'sym.confusion')).toBe(1);
    // источник: желтуха рядом — у A, кровь и связи — у B
    expect(share(HA, 'moderate', 'hx.jaundice_contact')).toBeGreaterThan(share(HB, 'moderate', 'hx.jaundice_contact'));
    expect(share(HB, 'moderate', 'hx.parenteral_risk')).toBeGreaterThan(share(HA, 'moderate', 'hx.parenteral_risk'));
  }, 30_000);

  test('обследования: маркёры, коагулограмма, расспрос — первым при желтухе; билирубин выше 200 — в печёночных пробах', () => {
    expect(db.exams['exam.hepatitis_markers']).toMatchObject({ room: 'room.lab', equipment: ['eq.immuno_analyzer'], collect: 'room.procedure' });
    expect(db.exams['exam.hepatitis_markers'].checks.map(c => c.f)).toEqual(['lab.hav_igm', 'lab.hbv_markers']);
    expect(db.exams['exam.coagulation'].checks.map(c => c.f)).toEqual(['lab.pti_low']);
    expect(db.exams['exam.ask_hepatitis'].routineFor).toEqual(['sym.yellow_skin', 'sym.dark_urine']);
    // с частью 54б за ним — «АСТ выше АЛТ»
    expect(db.exams['exam.liver_panel'].checks.map(c => c.f).slice(-2)).toEqual(['lab.bilirubin_200', 'lab.ast_over_alt']);
    // с частью 54а за печенью — селезёнка и асцит
    expect(db.exams['exam.abdomen_palpation'].checks.map(c => c.f)).toContain('sign.hepatomegaly');
  });
});

describe('гепатиты: лечение и место', () => {
  test('режим и диета — первая линия; A — противовирусные не показаны; B — противовирусное при тяжёлой и молниеносной', () => {
    expect(db.conditions[HA].treatment!.firstLine).toEqual(['tx.liver_diet']);
    expect(db.conditions[HB].treatment!.firstLine).toEqual(['tx.liver_diet']);
    expect(txRole(db, HA, NUC, paramsOf(HA, 'severe'))).toBe('notIndicated');
    expect(txRole(db, HA, 'tx.ribavirin', paramsOf(HA, 'mild'))).toBe('notIndicated');
    expect(tacticsFor(db.conditions[HB].treatment!, paramsOf(HB, 'moderate')).require).toBeUndefined();
    expect(tacticsFor(db.conditions[HB].treatment!, paramsOf(HB, 'severe')).require).toEqual([NUC, 'tx.iv_fluids']);
    expect(tacticsFor(db.conditions[HB].treatment!, paramsOf(HB, 'fulminant')).require).toEqual([NUC, 'tx.iv_fluids', 'tx.steroid_iv']);
    expect(tacticsFor(db.conditions[HA].treatment!, paramsOf(HA, 'coma')).require).toEqual(['tx.iv_fluids', 'tx.steroid_iv']);
  });

  test('место: A — бокс, кома — реанимация; B — палата, молниеносная — реанимация', () => {
    expect(recommendedSetting(db, patient(HA, 'mild'), [])).toBe('box');
    expect(recommendedSetting(db, patient(HA, 'severe'), [])).toBe('box');
    expect(recommendedSetting(db, patient(HA, 'coma'), [])).toBe('ricu');
    expect(recommendedSetting(db, patient(HB, 'moderate'), [])).toBe('ward');
    expect(recommendedSetting(db, patient(HB, 'fulminant'), [])).toBe('ricu');
  });

  test('A проходит сам, кроме комы; B — лёгкая и средняя; тяжёлый B без противовирусного — хуже, с ним — действует', () => {
    for (const sev of ['mild', 'moderate', 'severe']) expect(selfLimits(db, primaryOf(patient(HA, sev)))).toBe(true);
    expect(selfLimits(db, primaryOf(patient(HA, 'coma')))).toBe(false);
    expect(selfLimits(db, primaryOf(patient(HB, 'moderate')))).toBe(true);
    expect(selfLimits(db, primaryOf(patient(HB, 'severe')))).toBe(false);
    const p = patient(HB, 'severe', 96_000);
    expect(evaluatePlan(db, p, { treatments: ['tx.liver_diet', NUC, 'tx.iv_fluids'], setting: 'admit' }, []).effective).toBe(true);
    const home: Plan = { treatments: ['tx.liver_diet'], setting: 'home' };
    const outs = Array.from({ length: 200 }, (_, i) => observe(db, p, home, evaluatePlan(db, p, home, []), Rng.seeded(i).fork('out')));
    expect(outs.filter(o => o.kind === 'worse').length / outs.length).toBeGreaterThan(0.3);
  });

  test('энциклопедия: тяжесть словами; «С чем спутать» — другой гепатит, холецистит, желчная колика', () => {
    for (const s of ['coma', 'fulminant']) expect(whenText({ severity: [s] })).toEqual(expect.any(String));
    expect(whenText({ severity: ['severe', 'fulminant'] })).toBe('при тяжёлой и молниеносной форме');
    expect(db.conditions[HA].differential).toEqual([HB, 'cond.cholecystitis', 'cond.biliary_colic']);
    for (const id of [HA, HB, 'exam.hepatitis_markers', 'exam.coagulation', NUC, 'tx.liver_diet', 'sym.yellow_skin', 'lab.pti_low']) expect(article(db, id)).toBeDefined();
  });
});

describe('разумный врач при гепатитах', () => {
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

  test('A — бокс, без противовирусного; тяжёлый B — противовирусное; молниеносный B — реанимация с глюкокортикоидом', () => {
    const n = 20;
    let rightA = 0, boxA = 0, noNuc = 0, nucB = 0, ricuB = 0;
    for (let i = 0; i < n; i++) {
      const a = patient(HA, 'moderate', 97_000 + i);
      const ra = run(a);
      if (verdictOf(db, ra.diagnosis, a) === 'correct') rightA++;
      if (ra.plan.setting === 'box') boxA++;
      if (!ra.plan.treatments.includes(NUC)) noNuc++;
      if (run(patient(HB, 'severe', 98_000 + i)).plan.treatments.includes(NUC)) nucB++;
      const f = run(patient(HB, 'fulminant', 99_000 + i));
      if (f.plan.setting === 'ricu' && f.plan.treatments.includes('tx.steroid_iv')) ricuB++;
    }
    expect(rightA / n).toBeGreaterThan(0.85);
    expect(boxA / n).toBeGreaterThan(0.85);
    expect(noNuc / n).toBeGreaterThan(0.85);
    expect(nucB / n).toBeGreaterThan(0.85);
    expect(ricuB / n).toBeGreaterThan(0.85);
  }, 120_000);
});
