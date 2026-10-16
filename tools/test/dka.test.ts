// Кетоацидоз и гиперосмолярное состояние (spec 2026-10-urticaria-dka, часть 73; «Алгоритмы специализированной медицинской
// помощи больным сахарным диабетом», 11-й выпуск, 2023, разделы 8.1–8.2). ДКА: глюкоза выше 13,9, кетоны в моче, ацидоз;
// инсулин в вену, солевой раствор — и до перевода, калий; лёгкий — в отделении, остальные — ПИТ или реанимация. ГГС: у
// пожилого больного диабетом 2 типа глюкоза обычно выше 35, осмолярность выше 320, кетонов и ацидоза нет; сначала растворы,
// мочегонные — ошибка. Глюкоза — одно измерение: пороги 13,9 и 35 — на числе «глюкоза повышена».
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, typicalPatient } from '../../src/engine/med/generate';
import { alsoSettings, evaluatePlan, recommendedSetting, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const DKA = 'cond.dka';
const HHS = 'cond.hhs';
const GLU = 'lab.glucose_high';
const INS = 'tx.insulin_iv';
const SALINE = 'tx.iv_fluids';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];

const patients = (primary: Id, n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'winter', primary, params }));
const has = (p: Patient, f: string, cause?: Id) => p.truth.findings.some(x => x.f === f && (!cause || x.cause === cause));
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];

describe('кетоацидоз', () => {
  const ps = patients(DKA, 300, 73_200);

  test('запись по «Алгоритмам» 2023: терапия, E14.1, обмен веществ; причина и тяжесть — параметры', () => {
    expect(db.conditions[DKA]).toMatchObject({
      icd10: 'E14.1', department: 'dept.therapy', system: 'metabolic', severity: 'critical',
      params: { factor: { infection: 40, missed_insulin: 35, new_onset: 25 }, severity: { mild: 30, moderate: 45, severe: 25 } },
    });
    expect(db.conditions[DKA].confirm).toEqual(['exam.urine_dipstick', 'exam.abg']);
    expect(db.conditions[DKA].differential).toEqual([HHS, 'cond.appendicitis']);
  });

  test('по определению — глюкоза выше 13,9, кетоны в моче и ацидоз у каждого; тяжёлая — сопор и давление ниже 90', () => {
    for (const p of ps) {
      for (const f of [GLU, 'lab.glucose_14', 'lab.urine_ketones', 'lab.acidosis']) expect(has(p, f, DKA)).toBe(true);
      expect(p.truth.values[GLU]).toBeGreaterThanOrEqual(14);
      expect(p.truth.values[GLU]).toBeLessThanOrEqual(30);
      const severe = param(p, 'severity') === 'severe';
      expect(has(p, 'vital.bp_low', DKA)).toBe(severe);
      // сопор — шкала комы Глазго ниже 15, кома — её порог (тогда «ниже 15» снят: одно измерение)
      if (severe) expect(has(p, 'sign.gcs_low', DKA) || has(p, 'sign.gcs_coma', DKA)).toBe(true);
      if (param(p, 'severity') === 'mild') expect(has(p, 'sign.gcs_low', DKA) || has(p, 'sign.gcs_coma', DKA)).toBe(false);
      // диабет известен при пропуске инсулина и инфекции, при манифестации — нет
      expect(has(p, 'hx.diabetes', DKA)).toBe(param(p, 'factor') !== 'new_onset');
      expect(has(p, 'hx.missed_insulin', DKA)).toBe(param(p, 'factor') === 'missed_insulin');
    }
    expect(share(ps, p => has(p, 'sign.acetone_breath', DKA))).toBeGreaterThan(0.65);
    // «часто — абдоминальный синдром»
    expect(share(ps, p => has(p, 'sym.abdominal_pain', DKA))).toBeGreaterThan(0.4);
    expect(share(ps, p => has(p, 'sym.abdominal_pain', DKA))).toBeLessThan(0.75);
  });

  test('кетоны — тест-полоской и в общем анализе мочи, запах ацетона — на общем осмотре, пороги глюкозы — глюкометром', () => {
    for (const e of ['exam.urine_dipstick', 'exam.urinalysis']) expect(db.exams[e].checks.map(c => c.f)).toContain('lab.urine_ketones');
    expect(db.exams['exam.general_exam'].checks.map(c => c.f)).toContain('sign.acetone_breath');
    // порог — то же измерение: точность — из него
    const g = Object.fromEntries(db.exams['exam.glucometer'].checks.map(c => [c.f, c]));
    expect(g['lab.glucose_14']).toMatchObject({ sens: g[GLU].spec, spec: 10_000 });
    expect(g['lab.glucose_35']).toMatchObject({ sens: g[GLU].spec, spec: 10_000 });
  });

  test('тактика: инсулин в вену — первая линия, раствор — обязательно и до перевода, калий и гепарин — в помощь; бикарбонат не нужен', () => {
    const t = db.conditions[DKA].treatment!;
    expect(t.firstLine).toEqual([INS]);
    expect(t.supportive).toEqual(['tx.potassium_iv', 'tx.lmwh']);
    expect(t.notIndicated).toEqual(['tx.sodium_bicarbonate', 'tx.dextrose_iv', 'tx.dextrose_infusion', 'tx.furosemide_iv']);
    expect(txRole(db, DKA, SALINE, {})).toBe('beforeTransfer');
    expect([txRole(db, DKA, 'tx.antibiotic_iv', { factor: 'infection' }), txRole(db, DKA, 'tx.antibiotic_iv', { factor: 'missed_insulin' })]).toEqual(['supportive', 'notIndicated']);
    const p = ps[0];
    const venue: Venue = { ward: true, icu: true };
    expect(evaluatePlan(db, p, { treatments: [INS], setting: 'icu' }, complaintObservations(p), venue).beforeTransferMissing).toEqual([SALINE]);
  });

  test('место: лёгкий — в отделении, умеренный и тяжёлый — ПИТ, реанимация — не ошибка', () => {
    for (const p of ps.slice(0, 60)) {
      const mild = param(p, 'severity') === 'mild';
      expect(recommendedSetting(db, p)).toBe(mild ? 'ward' : 'icu');
      expect(alsoSettings(db, p)).toEqual(mild ? [] : ['ricu']);
    }
  });
});

describe('гиперосмолярное состояние', () => {
  const ps = patients(HHS, 300, 73_700);

  test('запись: терапия, E11.0, у больного диабетом 2 типа старше 45; осмолярность и обезвоживание — у каждого, кетонов и ацидоза нет', () => {
    expect(db.conditions[HHS]).toMatchObject({ icd10: 'E11.0', department: 'dept.therapy', severity: 'critical', requires: ['cond.diabetes2'] });
    for (const p of ps) {
      expect(p.age).toBeGreaterThanOrEqual(45);
      expect(p.truth.conditions.map(c => c.id)).toContain('cond.diabetes2');
      for (const f of [GLU, 'lab.glucose_14', 'lab.osm_high', 'sign.dehydration']) expect(has(p, f, HHS)).toBe(true);
      // «Запаха ацетона и дыхания Куссмауля нет», «кетонурии нет», «Ацидоза нет» — и от других болезней тоже
      for (const f of ['lab.urine_ketones', 'lab.acidosis', 'sign.acetone_breath', 'sign.kussmaul']) expect(has(p, f)).toBe(false);
      expect(p.truth.values[GLU]).toBeGreaterThanOrEqual(has(p, 'lab.glucose_35') ? 35.1 : 14);
    }
    // «как правило» выше 35
    expect(share(ps, p => has(p, 'lab.glucose_35', HHS))).toBeGreaterThan(0.65);
  });

  test('тактика: растворы — первая линия, инсулин и калий — в помощь, мочегонные — вредно; ПИТ, реанимация — не ошибка', () => {
    const t = db.conditions[HHS].treatment!;
    expect(t.firstLine).toEqual([SALINE]);
    expect(t.supportive).toEqual([INS, 'tx.potassium_iv', 'tx.lmwh']);
    expect(t.harmful).toEqual(['tx.furosemide_iv']);
    for (const p of ps.slice(0, 20)) {
      expect(recommendedSetting(db, p)).toBe('icu');
      expect(alsoSettings(db, p)).toEqual(['ricu']);
    }
    expect(db.exams['exam.electrolytes'].checks.map(c => c.f)).toContain('lab.osm_high');
  });
});

describe('глюкоза — одно измерение', () => {
  test('у впервые выявленного диабета 2 типа глюкоза не выше 13,9: выше — только с порогом, порог не спорит с числом', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePatient(db, 73_900 + i, { department: 'dept.therapy', season: 'winter', primary: 'cond.diabetes2_new', params: {} });
      expect(has(p, 'lab.glucose_14', 'cond.diabetes2_new')).toBe(false);
      if (has(p, GLU) && !has(p, 'lab.glucose_14')) expect(p.truth.values[GLU]).toBeLessThanOrEqual(13.9);
      if (has(p, 'lab.glucose_14')) expect(p.truth.values[GLU]).toBeGreaterThanOrEqual(14);
    }
    expect(db.findings['lab.glucose_14'].value).toMatchObject({ of: GLU, implies: true });
    expect(db.findings['lab.glucose_35'].value).toMatchObject({ of: GLU, implies: true });
  });
});

/** Разумный врач по шагам — в приёмном с палатой и ПИТ. */
function doctor(p: Patient) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ED);
  const exams = Object.keys(db.exams).sort();
  const venue: Venue = { ward: true, icu: true };
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  test('кетоацидоз верно — у девяти из десяти: инсулин в вену и раствор', () => {
    const rs = patients(DKA, 100, 73_400).map(p => ({ p, r: doctor(p) }));
    expect(share(rs, x => x.r.diagnosis === DKA)).toBeGreaterThan(0.9);
    const right = rs.filter(x => x.r.diagnosis === DKA);
    expect(share(right, x => x.r.plan.treatments.includes(INS) && x.r.plan.treatments.includes(SALINE))).toBeGreaterThan(0.95);
  });

  test('гиперосмолярное состояние верно — у восьми из десяти: растворы, без мочегонных', () => {
    const rs = patients(HHS, 100, 73_800).map(p => ({ p, r: doctor(p) }));
    expect(share(rs, x => x.r.diagnosis === HHS)).toBeGreaterThan(0.8);
    const right = rs.filter(x => x.r.diagnosis === HHS);
    expect(share(right, x => x.r.plan.treatments.includes(SALINE))).toBeGreaterThan(0.95);
    expect(right.some(x => x.r.plan.treatments.includes('tx.furosemide_iv'))).toBe(false);
  });
});

describe('энциклопедия', () => {
  test('кетоацидоз и ГГС — статьями; новые признаки и лечение — тоже', () => {
    for (const id of [DKA, HHS, 'lab.urine_ketones', 'lab.osm_high', 'lab.glucose_14', 'lab.glucose_35', 'sign.acetone_breath', 'hx.missed_insulin', INS, 'tx.potassium_iv']) {
      expect(article(db, id)).toBeDefined();
    }
  });
});
