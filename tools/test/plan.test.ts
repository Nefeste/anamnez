// План лечения, исход, оценка случая и разбор (`docs/04-medical-model.md` §7–10) на
// настоящей базе: роли назначений, место лечения, противопоказания, исходы и буквы.
import { describe, expect, test } from 'bun:test';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan, type Plan, recommendedSetting, txRole } from '../../src/engine/med/plan';
import { choosePlan } from '../../src/engine/med/policy';
import { buildReview } from '../../src/engine/med/review';
import { type CaseInput, scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { buildDb } from '../content/load';

const { db } = buildDb();
const ctx = { department: 'dept.therapy', season: 'winter' as const };

/** Первый пациент с этим основным заболеванием, для которого выполнено условие. */
function find(primary: string, ok: (p: Patient) => boolean = () => true, from = 1): Patient {
  for (let seed = from; seed < from + 20000; seed++) {
    const p = generatePatient(db, seed, { ...ctx, primary });
    if (p.truth.conditions[0].id === primary && ok(p)) return p;
  }
  throw new Error(`не нашёл пациента ${primary}`);
}
const withAllergy = (p: Patient): Patient => ({ ...p, truth: { ...p.truth, risks: [...p.truth.risks, 'risk.allergy_penicillin'].sort() } });
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const told = (f: string, shown: boolean): Observation => ({ f, shown, exam: 'exam.ask_allergies' });

describe('тактика и место лечения', () => {
  test('роли назначений берутся из тактики истинного состояния', () => {
    expect(txRole(db, 'cond.pneumonia_cap', 'tx.amoxicillin')).toBe('firstLine');
    expect(txRole(db, 'cond.pneumonia_cap', 'tx.macrolide')).toBe('acceptable');
    expect(txRole(db, 'cond.arvi', 'tx.amoxicillin')).toBe('notIndicated');
    expect(txRole(db, 'cond.arvi', 'tx.salbutamol')).toBe('notIndicated'); // не названо — не показано
  });

  test('тяжёлая пневмония и низкая сатурация — в стационар, лёгкая — дома', () => {
    const severe = find('cond.pneumonia_cap', p => p.truth.conditions[0].params.severity === 'severe');
    expect(recommendedSetting(db, severe)).toBe('ward');
    const mild = find('cond.pneumonia_cap', p => p.truth.conditions[0].params.severity === 'mild' && !has(p, 'vital.spo2_low'));
    expect(recommendedSetting(db, mild)).toBe('home');
    const hypoxic = find('cond.pneumonia_cap', p => p.truth.conditions[0].params.severity !== 'severe' && has(p, 'vital.spo2_low'));
    expect(recommendedSetting(db, hypoxic)).toBe('ward');
  });
});

describe('противопоказания', () => {
  const base = find('cond.pneumonia_cap', p => p.truth.conditions[0].params.severity === 'mild' && !has(p, 'vital.spo2_low') && !p.truth.risks.includes('risk.allergy_penicillin'));
  const allergic = withAllergy(base);
  const amox: Plan = { treatments: ['tx.amoxicillin'], setting: 'home' };

  test('аллергия есть, а врач не спросил: нарушение неизвестное, вопрос не задан', () => {
    const ev = evaluatePlan(db, allergic, amox, complaintObservations(allergic));
    expect(ev.violations).toEqual([{ tx: 'tx.amoxicillin', by: 'risk.allergy_penicillin', level: 'absolute', known: false, asked: false }]);
    expect(ev.unaskedRisk).toEqual(['risk.allergy_penicillin']);
    expect(ev.effective).toBe(true);
  });

  test('врач знал об аллергии и всё равно назначил — безопасность D, случай не выше C', () => {
    const obs = [...complaintObservations(allergic), told('hx.allergy_penicillin', true)];
    const ev = evaluatePlan(db, allergic, amox, obs);
    expect(ev.violations[0].known).toBe(true);
    const s = scoreCase(input({ plan: ev }));
    expect(s.safety).toBe('D');
    expect(s.treatment).toBe('D');
    expect(['C', 'D']).toContain(s.overall);
  });

  test('при известной аллергии замена на макролид — лечение A', () => {
    const obs = [...complaintObservations(allergic), told('hx.allergy_penicillin', true)];
    expect(choosePlan(db, 'cond.pneumonia_cap', obs).treatments).toEqual(['tx.macrolide']);
    const ev = evaluatePlan(db, allergic, { treatments: ['tx.macrolide'], setting: 'home' }, obs);
    expect(ev.firstLineBlocked).toBe(true);
    expect(scoreCase(input({ plan: ev })).treatment).toBe('A');
  });

  test('без аллергии и без вопроса о ней: вреда нет, но безопасность B', () => {
    const ev = evaluatePlan(db, base, amox, complaintObservations(base));
    expect(ev.violations).toEqual([]);
    const s = scoreCase(input({ plan: ev }));
    expect(s.safety).toBe('B');
    expect(s.notes).toContainEqual({ code: 'safety.notAsked', by: 'risk.allergy_penicillin' });
  });

  test('реакция при нарушенном противопоказании — с вероятностью из записи (often = 50 %)', () => {
    const ev = evaluatePlan(db, allergic, amox, complaintObservations(allergic));
    let reactions = 0;
    for (let i = 0; i < 2000; i++) if (observe(db, allergic, amox, ev, Rng.seeded(i)).kind === 'reaction') reactions++;
    expect(reactions / 2000).toBeGreaterThan(0.45);
    expect(reactions / 2000).toBeLessThan(0.55);
  });

  function input(over: Partial<CaseInput>): CaseInput {
    const plan = over.plan ?? evaluatePlan(db, base, amox, complaintObservations(base));
    return { verdict: 'correct', confidence: 0.9, cost: 20, rationalCost: 20, plan, outcome: { kind: 'recovered', day: 3, cured: true }, selfLimiting: false, redFlags: [], ...over };
  }
});

describe('исход', () => {
  const mild = find('cond.pneumonia_cap', p => p.truth.conditions[0].params.severity === 'mild' && !has(p, 'vital.spo2_low') && !p.truth.risks.includes('risk.allergy_penicillin'));
  const rate = (p: Patient, plan: Plan, kind: string) => {
    const ev = evaluatePlan(db, p, plan, complaintObservations(p));
    let n = 0;
    for (let i = 0; i < 2000; i++) if (observe(db, p, plan, ev, Rng.seeded(i)).kind === kind) n++;
    return n / 2000;
  };

  test('пневмония без антибиотика чаще всего ухудшается и возвращается', () => {
    const worse = rate(mild, { treatments: ['tx.paracetamol'], setting: 'home' }, 'worse');
    expect(worse).toBeGreaterThan(0.7); // usually = 75 %
    const ev = evaluatePlan(db, mild, { treatments: [], setting: 'home' }, []);
    const out = [...Array(50).keys()].map(i => observe(db, mild, { treatments: [], setting: 'home' }, ev, Rng.seeded(i))).find(o => o.kind === 'worse')!;
    expect(out.returns?.reason).toBe('worse');
    expect(out.returns!.day).toBeGreaterThanOrEqual(2);
  });

  test('пневмония с амоксициллином в основном выздоравливает', () => {
    expect(rate(mild, { treatments: ['tx.amoxicillin'], setting: 'home' }, 'recovered')).toBeGreaterThan(0.72);
  });

  test('тяжёлую пневмонию дома лечить хуже, чем лёгкую', () => {
    const severe = find('cond.pneumonia_cap', p => p.truth.conditions[0].params.severity === 'severe' && !p.truth.risks.includes('risk.allergy_penicillin'));
    const amox: Plan = { treatments: ['tx.amoxicillin'], setting: 'home' };
    expect(rate(severe, amox, 'recovered')).toBeLessThan(rate(mild, amox, 'recovered') - 0.2);
    expect(observe(db, severe, { ...amox, setting: 'ward' }, evaluatePlan(db, severe, { ...amox, setting: 'ward' }, []), Rng.seeded(1)).kind).toBe('transferred');
  });

  test('ОРВИ проходит сама; исход детерминирован по зерну', () => {
    const arvi = find('cond.arvi');
    expect(rate(arvi, { treatments: ['tx.rest_fluids'], setting: 'home' }, 'worse')).toBe(0);
    const plan: Plan = { treatments: ['tx.rest_fluids'], setting: 'home' };
    const ev = evaluatePlan(db, arvi, plan, []);
    expect(observe(db, arvi, plan, ev, Rng.seeded(7))).toEqual(observe(db, arvi, plan, ev, Rng.seeded(7)));
  });
});

describe('оценка случая', () => {
  const arvi = find('cond.arvi', p => !p.truth.risks.includes('risk.allergy_penicillin'));
  const base = (plan: Plan, patient = arvi): CaseInput => ({
    verdict: 'correct', confidence: 0.8, cost: 12, rationalCost: 10, plan: evaluatePlan(db, patient, plan, []),
    outcome: { kind: 'recovered', day: 4, cured: false }, selfLimiting: db.conditions[patient.truth.conditions[0].id].selfLimiting === true, redFlags: [],
  });

  test('ОРВИ: режим и питьё — A, антибиотик — C с замечанием', () => {
    expect(scoreCase(base({ treatments: ['tx.rest_fluids', 'tx.paracetamol'], setting: 'home' })).treatment).toBe('A');
    const s = scoreCase(base({ treatments: ['tx.amoxicillin'], setting: 'home' }));
    expect(s.treatment).toBe('C');
    expect(s.notes).toContainEqual({ code: 'tx.notIndicated', tx: 'tx.amoxicillin' });
  });

  test('пневмония без лечения причины — лечение D', () => {
    const p = find('cond.pneumonia_cap');
    const s = scoreCase(base({ treatments: ['tx.paracetamol'], setting: 'home' }, p));
    expect(s.treatment).toBe('D');
    expect(s.notes).toContainEqual({ code: 'tx.noCure' });
  });

  test('красный флаг видели и всё равно отпустили домой — место и безопасность D', () => {
    const p = find('cond.pneumonia_cap', q => has(q, 'vital.spo2_low'));
    const s = scoreCase({ ...base({ treatments: ['tx.amoxicillin'], setting: 'home' }, p), redFlags: [{ f: 'vital.spo2_low', seen: true }] });
    expect(s.setting).toBe('D');
    expect(s.safety).toBe('D');
    expect(s.notes).toContainEqual({ code: 'safety.redFlagIgnored', f: 'vital.spo2_low' });
  });

  test('обоснованность меряет рассуждение, бережливость — цену против разумного врача', () => {
    const plan: Plan = { treatments: ['tx.rest_fluids'], setting: 'home' };
    expect(scoreCase({ ...base(plan), verdict: 'correct', confidence: 0.3 }).defensibility).toBe('C');
    expect(scoreCase({ ...base(plan), verdict: 'wrong', confidence: 0.9 }).defensibility).toBe('A');
    expect(scoreCase({ ...base(plan), cost: 100, rationalCost: 20 }).thrift).toBe('D');
  });
});

describe('разбор', () => {
  test('график уверенности, «ничего не добавило» и путь разумного врача', () => {
    const p = find('cond.pneumonia_cap', q => has(q, 'img.cxr_infiltrate'));
    const candidates = Object.keys(db.conditions).filter(id => db.conditions[id].presenting);
    const exams = Object.keys(db.exams).sort();
    const arrivals = ['exam.ask_allergies', 'exam.xray_chest'].map((exam, i) => ({ exam, obs: runExam(db, p, exam, Rng.seeded(i).fork(exam)) }));
    const r = buildReview(db, p, arrivals, 'cond.pneumonia_cap', candidates, exams, Rng.seeded(1));
    expect(r.timeline.map(t => t.exam)).toEqual(['complaint', 'exam.ask_allergies', 'exam.xray_chest']);
    expect(r.idle).toContain('exam.ask_allergies'); // вопрос об аллергиях диагноз не двигает
    expect(r.rational.exams.length).toBeGreaterThan(0);
    expect(r.rational.cost).toBeGreaterThan(0);
  });
});
