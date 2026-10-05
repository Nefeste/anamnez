// Ожог (spec 2026-09-chapter-2, часть 32д-2): термический ожог руки или ноги — небольшой
// поверхностный, обширный или глубокий; тактика по виду — туалет раны и повязка дома, перевод в
// ожоговый центр, капельница до перевода при обширном (`preHospital`); столбняк по записям о
// прививках; осмотр ожога каждому, пробы на глубину — когда виден струп; «виртуальный врач»;
// энциклопедия и группы лечения.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, examFits } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan, preHospitalOf, preventOf, recommendedSetting, tacticsFor, txRole } from '../../src/engine/med/plan';
import { nextStep, runDoctor, tacticParams } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { noteText, treatmentGroupsFor } from '../../src/state/caseView';
import { article, similar } from '../../src/state/encyclopedia';

const BURN = 'cond.burn';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const DRESSING = 'tx.burn_dressing';
const SIMPLE = 'tx.wound_dressing';
const IV = 'tx.iv_fluids';
const ORS = 'tx.ors';
const TOXOID = 'tx.tetanus_toxoid';
const TIG = 'tx.tetanus_ig';

const people = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: BURN }));
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const params = (p: Patient) => p.truth.conditions[0].params;
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();
const doctor = (p: Patient) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 });
/** пациент с заданными значениями скрытых параметров — ищем среди сгенерированных */
const find = (want: Record<string, string>, from = 1) => {
  for (let i = 0; i < 4000; i++) {
    const p = people(1, from + i)[0];
    if (Object.entries(want).every(([k, v]) => params(p)[k] === v)) return p;
  }
  throw new Error(`нет ожога ${JSON.stringify(want)}`);
};
const scoreOf = (p: Patient, treatments: Id[], setting: 'home' | 'ambulance' | 'transfer' = 'home', obs: Observation[] = []) => {
  const ev = evaluatePlan(db, p, { treatments, setting }, obs);
  return { ev, score: scoreCase({ verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev, outcome: { kind: 'recovered', day: 14 } as never, selfLimiting: false, redFlags: [] }) };
};

describe('запись ожога', () => {
  test('травма, «Кожа и раны», T30.0, средней тяжести; источник — 687_3; взрослые, мужчины чаще', () => {
    expect(db.conditions[BURN]).toMatchObject({ department: 'dept.trauma', system: 'skin', kind: 'injury', severity: 'moderate', presenting: true, icd10: 'T30.0' });
    expect(db.conditions[BURN].sources.map(s => s.url)).toContain('https://cr.minzdrav.gov.ru/view-cr/687_3');
    expect(db.conditions[BURN].age.min).toBe(18);
    expect(db.conditions[BURN].sex!.m).toBeGreaterThan(db.conditions[BURN].sex!.f);
  });

  test('жалоба у каждого — «Ожог» на руке или ноге; виды — 70 : 20 : 10, рука чаще ноги', () => {
    const xs = people(3000);
    for (const p of xs) expect(p.complaints).toContain('sym.burn');
    near(share(xs, p => params(p).form === 'minor'), 0.7, 0.03);
    near(share(xs, p => params(p).form === 'extensive'), 0.2, 0.025);
    near(share(xs, p => params(p).form === 'deep'), 0.1, 0.02);
    near(share(xs, p => params(p).site === 'arm'), 0.6, 0.03);
    near(share(xs, p => params(p).tetanus === 'none'), 0.3, 0.03);
  });

  test('признаки по виду: струп и нечувствительность — у каждого глубокого, больше 15 ладоней — у каждого обширного, у небольшого — ни того ни другого', () => {
    for (const p of people(2000)) {
      const form = params(p).form;
      expect(has(p, 'sign.burn_insensate')).toBe(form === 'deep');
      expect(has(p, 'sign.burn_large')).toBe(form === 'extensive');
      if (form === 'deep') expect(has(p, 'sign.burn_eschar')).toBe(true);
      expect(has(p, 'hx.tetanus_records')).toBe(params(p).tetanus !== 'none');
      expect(has(p, 'hx.tetanus_recent')).toBe(params(p).tetanus === 'current');
    }
    // тонкий струп бывает и при II степени (687_3, раздел 2.2): у обширного — чаще, чем у небольшого
    const xs = people(3000);
    const eschar = (form: string) => share(xs.filter(p => params(p).form === form), p => has(p, 'sign.burn_eschar'));
    expect(eschar('extensive')).toBeGreaterThan(eschar('minor'));
    expect(eschar('minor')).toBeGreaterThan(0);
  });
});

describe('тактика по виду ожога', () => {
  const role = (tx: Id, p: Record<string, string>) => txRole(db, BURN, tx, p);
  const minor = { form: 'minor', site: 'arm', tetanus: 'current' };

  test('небольшой — туалет раны и повязка первой линией, дома; антибиотик не нужен, капельница тоже', () => {
    expect(role(DRESSING, minor)).toBe('firstLine');
    for (const tx of ['tx.paracetamol', 'tx.ibuprofen', ORS]) expect(role(tx, minor)).toBe('supportive');
    for (const tx of ['tx.amoxicillin_clavulanate', 'tx.amoxicillin', 'tx.cephalosporin_oral', IV, SIMPLE]) expect(role(tx, minor)).toBe('notIndicated');
    expect(recommendedSetting(db, find({ form: 'minor' }))).toBe('home');
    expect(tacticParams(db, BURN)).toEqual(['form', 'tetanus']);
  });

  test('обширный — капельница первой линией и до приезда скорой; повязка облегчает; перевод в центр', () => {
    const ext = { ...minor, form: 'extensive' };
    expect(role(IV, ext)).toBe('firstLine');
    for (const tx of [DRESSING, SIMPLE, ORS]) expect(role(tx, ext)).toBe('supportive');
    expect(tacticsFor(db.conditions[BURN].treatment!, ext).preHospital).toEqual([IV]);
    expect(preHospitalOf(db, db.conditions[BURN].treatment, ext)).toEqual([IV]);
    expect(recommendedSetting(db, find({ form: 'extensive' }))).toBe('transfer');
  });

  test('глубокий — повязка, перевод; до приезда скорой — лечебная или сухая стерильная повязка', () => {
    const deep = { ...minor, form: 'deep' };
    expect(role(DRESSING, deep)).toBe('firstLine');
    expect(role(SIMPLE, deep)).toBe('supportive');
    expect(role(IV, deep)).toBe('notIndicated');
    expect(preHospitalOf(db, db.conditions[BURN].treatment, deep)).toEqual([DRESSING, SIMPLE]);
    expect(recommendedSetting(db, find({ form: 'deep' }))).toBe('transfer');
    // небольшой лечат дома — до приезда скорой ничего
    expect(preHospitalOf(db, db.conditions[BURN].treatment, minor)).toEqual([]);
  });

  test('столбняк — по записям о прививках, как при ране (687_3, раздел 3.1.17; 856_1, приложение А3.1)', () => {
    const t = db.conditions[BURN].treatment;
    expect(preventOf(t, minor)).toEqual([]);
    expect(preventOf(t, { ...minor, tetanus: 'overdue' })).toEqual([TOXOID]);
    expect(preventOf(t, { ...minor, tetanus: 'none' })).toEqual([TOXOID, TIG]);
  });

  test('где лечить без ожога — прежнее: у ОКС до приезда скорой — первая линия по месту по умолчанию', () => {
    const acs = db.conditions['cond.acs'].treatment!;
    expect(acs.setting.default).not.toBe('home');
    expect(preHospitalOf(db, acs, {})).toEqual(acs.firstLine.filter(tx => db.treatments[tx].kind !== 'surgery'));
    // перерезанное сухожилие — место по параметру, своего «до приезда скорой» нет: как было
    expect(preHospitalOf(db, db.conditions['cond.hand_wound'].treatment, { cause: 'cut', delay: 'fresh', edges: 'apart', tendon: 'cut', tetanus: 'current' })).toEqual([]);
  });
});

describe('до приезда скорой в оценке', () => {
  test('обширный ожог отправили без капельницы — замечание, лечение B; с капельницей — A', () => {
    const p = find({ form: 'extensive', tetanus: 'current' });
    const without = scoreOf(p, [DRESSING, 'tx.paracetamol'], 'ambulance');
    expect(without.ev.preHospital).toEqual([IV]);
    expect(without.score.notes).toContainEqual({ code: 'tx.preHospitalMissing', tx: IV });
    expect(without.score.treatment).toBe('B');
    expect(noteText({ code: 'tx.preHospitalMissing', tx: IV })).toBe('До приезда скорой не назначено: инфузионная терапия');
    const full = scoreOf(p, [IV, DRESSING, 'tx.paracetamol'], 'ambulance');
    expect(full.score.notes.some(n => n.code === 'tx.preHospitalMissing')).toBe(false);
    expect(full.score.treatment).toBe('A');
    expect(full.score.setting).toBe('A');
    // домой — недооценили тяжесть
    expect(scoreOf(p, [DRESSING, 'tx.ibuprofen']).score.setting).toBe('D');
  });

  test('глубокий: без повязки — замечание; сухая стерильная повязка тоже годится', () => {
    const p = find({ form: 'deep', tetanus: 'current' });
    expect(scoreOf(p, ['tx.paracetamol'], 'ambulance').score.notes).toContainEqual({ code: 'tx.preHospitalMissing', tx: DRESSING });
    for (const tx of [DRESSING, SIMPLE]) expect(scoreOf(p, [tx, 'tx.paracetamol'], 'ambulance').score.treatment).toBe('A');
  });

  test('небольшой: повязка дома — пятёрка; без повязки — лечения причины нет; с просроченной прививкой без анатоксина — C', () => {
    const p = find({ form: 'minor', tetanus: 'current' });
    expect(scoreOf(p, [DRESSING, 'tx.ibuprofen']).score.overall).toBe('A');
    expect(scoreOf(p, ['tx.ibuprofen']).score.notes).toContainEqual({ code: 'tx.noCure' });
    const late = find({ form: 'minor', tetanus: 'overdue' });
    expect(scoreOf(late, [DRESSING, 'tx.ibuprofen']).score.treatment).toBe('C');
    expect(scoreOf(late, [DRESSING, 'tx.ibuprofen', TOXOID]).score.treatment).toBe('A');
  });
});

describe('обследования ожога', () => {
  test('осмотр ожога, пробы на глубину и расспрос о прививках — при ожоге; терапевтическому больному их нет', () => {
    const burn = people(1)[0];
    const flu = generatePatient(db, 1, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: 'cond.influenza' });
    const ids = ['exam.burn_exam', 'exam.burn_depth_tests', 'exam.ask_tetanus'];
    expect(ids.map(id => examFits(db.exams[id], burn))).toEqual([true, true, true]);
    expect(ids.map(id => examFits(db.exams[id], flu))).toEqual([false, false, false]);
    expect(db.exams['exam.burn_exam'].routineFor).toEqual(['sym.burn']);
    expect(db.exams['exam.burn_depth_tests'].routineFor).toBeUndefined();
  });

  test('осмотр ожога — первым после вопроса о хронических болезнях; струп виден — пробы на глубину', () => {
    const p = find({ form: 'deep' });
    const said = complaintObservations(p);
    // давление уже измерила медсестра на сортировке: с 0.3.19 его меряют и при головной боли (62_3, раздел 2.1)
    const first = nextStep(db, p, said, ['exam.vitals', 'exam.ask_chronic'], {}, { candidates, exams, threshold: 0.9, minGain: 0.02 }).step;
    expect(first).toEqual({ kind: 'exam', exam: 'exam.burn_exam' });
    const seen: Observation[] = [
      ...said,
      { f: 'sign.burn_blisters', shown: false, exam: 'exam.burn_exam' },
      { f: 'sign.burn_eschar', shown: true, exam: 'exam.burn_exam' },
      { f: 'sign.burn_large', shown: false, exam: 'exam.burn_exam' },
    ];
    const done = ['exam.vitals', 'exam.ask_chronic', 'exam.burn_exam', 'exam.ask_injury', 'exam.ask_tetanus'];
    const next = nextStep(db, p, seen, done, {}, { candidates, exams, threshold: 0.9, minGain: 0.02 }).step;
    expect(next).toEqual({ kind: 'exam', exam: 'exam.burn_depth_tests' });
  });
});

describe('«виртуальный врач» на ожогах', () => {
  const xs = people(600, 700).map(p => ({ p, r: doctor(p) }));
  const of = (form: string) => xs.filter(x => params(x.p).form === form);

  test('диагноз верен у всех; небольшой — дома с повязкой у 90 % и больше', () => {
    expect(share(xs, x => x.r.correct)).toBe(1);
    const minor = of('minor');
    expect(share(minor, x => x.r.plan.setting === 'home' && x.r.plan.treatments.includes(DRESSING))).toBeGreaterThan(0.9);
    expect(share(minor, x => x.r.plan.treatments.some(tx => db.treatments[tx].class?.startsWith('antibiotic')))).toBe(0);
  });

  test('обширный — капельница и скорая у 90 % и больше; глубокий — скорая у 80 % и больше', () => {
    expect(share(of('extensive'), x => x.r.plan.setting === 'ambulance' && x.r.plan.treatments.includes(IV))).toBeGreaterThan(0.9);
    expect(share(of('deep'), x => x.r.plan.setting === 'ambulance')).toBeGreaterThan(0.8);
  });
});

describe('на экране и в энциклопедии', () => {
  test('решение: повязка — в «Раны и повязки», капельница и растворы для питья — в «Растворы и капельницы»', () => {
    const groups = Object.fromEntries(treatmentGroupsFor([]).map(g => [g.key, { title: g.title, ids: g.items.map(x => x.id) }]));
    expect(groups.wounds.ids).toContain(DRESSING);
    expect(groups.fluids).toEqual({ title: 'Растворы и капельницы', ids: expect.arrayContaining([IV, ORS]) });
    expect(groups.fluids.ids).toHaveLength(2);
    expect(groups.digestive.ids).not.toContain(IV);
  });

  test('статья ожога: капельница до приезда скорой при обширном; где лечить — перевод при обширном и глубоком', () => {
    const a = article(db, BURN)!;
    const rows = a.blocks.find(b => b.key === 'treatment')!.rows!;
    const row = (label: string) => rows.find(r => r.label === label)?.refs?.map(r => r.id);
    expect(row('Первая линия')).toEqual([DRESSING]);
    expect(row('Первая линия, при обширном ожоге')).toEqual([IV]);
    expect(row('До приезда скорой, при обширном ожоге')).toEqual([IV]);
    expect(row('До приезда скорой, при глубоком ожоге')).toEqual([DRESSING, SIMPLE]);
    const where = a.blocks.find(b => b.key === 'where')!.text!.join(' ');
    expect(where).toContain('При обширном ожоге — скорая, перевод в центр.');
    expect(where).toContain('При глубоком ожоге — скорая, перевод в центр.');
    expect(a.subtitle).toContain('Кожа и раны');
  });

  test('с чем спутать: не с раной — записи о прививках от столбняка болезни не различают', () => {
    expect(similar(db, BURN)).toEqual([]);
    expect(article(db, BURN)!.blocks.some(b => b.key === 'similar')).toBe(false);
    expect(similar(db, 'cond.hand_wound')).toEqual(['cond.head_wound']);
  });

  test('статья капельницы: «До приезда скорой при» — ожог с условием', () => {
    const rows = article(db, IV)!.blocks.find(b => b.key === 'usedAs')!.rows!;
    expect(rows.find(r => r.label === 'До приезда скорой при')!.refs!.map(r => r.id)).toEqual([BURN]);
  });
});
