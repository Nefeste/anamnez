// Острое отравление опиоидами (spec 2026-10-chapter-4, часть 57а; 743_2): привозит скорая — при лёгкой степени оглушение, при
// средней и тяжёлой кома; узкие зрачки, редкое дыхание, синие губы. Расспрос тех, кто вызвал скорую, глюкометр, неврологический
// осмотр и экспресс-тест мочи — каждому, кого нашли без сознания. Налоксон — только при лёгкой степени, и при ней обязателен; при
// коме он противопоказан: интубация и ИВЛ в реанимации, при низком давлении — и растворы в вену. Лёгкую — в ПИТ, палата не ошибка.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import { type Id, SYSTEMS } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { alsoSettings, curesOf, evaluatePlan, harmsOf, recommendedSetting, selfLimits, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { wardCourse } from '../../src/engine/shift/ward';
import { T } from '../../src/i18n';
import { txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const OP = 'cond.opioid_poisoning';
const NALOXONE = 'tx.naloxone';
const VENT = 'tx.ventilation';
const FLUIDS = 'tx.iv_fluids';
const URINE = 'exam.urine_drug_test';
const WITNESSES = 'exam.ask_witnesses';
const FOUND = 'sym.found_unconscious';
const MIOSIS = 'sign.miosis';
const SLOW = 'vital.bradypnea';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.infectious'];
const VENUE: Venue = { ward: true, icu: true, ricu: true };

const patients = (n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: OP, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === OP);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const severity = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params.severity;
const coma = (p: Patient) => severity(p) !== 'mild';

describe('отравление опиоидами', () => {
  const ps = patients(300, 57_000);

  test('запись по 743_2: терапия, T40.3, отравления, только скорая; подтверждает тест мочи; тяжесть — параметр', () => {
    expect(db.conditions[OP]).toMatchObject({
      icd10: 'T40.3', department: 'dept.therapy', system: 'poisoning', kind: 'state', arrival: 'ambulance', severity: 'critical', confirm: [URINE],
      params: { severity: { mild: 30, moderate: 40, severe: 30 } },
    });
    expect(db.conditions[OP].redFlags).toEqual(['sign.gcs_coma', SLOW]);
    expect(db.conditions[OP].differential).toEqual(['cond.hypoglycemia', 'cond.ich', 'cond.meningococcal']);
    // своя группа диагнозов и своя группа лечения
    expect(SYSTEMS.at(-1)).toBe('poisoning');
    expect(T.spikes.decision.system.poisoning).toBe('Отравления');
    expect(txGroupOfClass(db.treatments[NALOXONE].class)).toBe('antidotes');
    expect(T.spikes.decision.txGroup.antidotes).toBe('Антидоты');
  });

  test('лёгкая — оглушение, жалоба родных на спутанность; средняя и тяжёлая — нашли без сознания, кома и редкое дыхание', () => {
    for (const p of ps) {
      const deep = coma(p);
      for (const f of [FOUND, 'sign.gcs_coma', SLOW]) expect(has(p, f)).toBe(deep);
      for (const f of ['sym.confusion', 'sign.gcs_low']) expect(has(p, f)).toBe(!deep);
      expect(p.complaints).toContain(deep ? FOUND : 'sym.confusion');
      expect(has(p, 'lab.opioids_urine')).toBe(true);
    }
    // миоз — ведущий симптом (разделы 1.5 и 1.6): при коме — почти у каждого
    expect(share(ps.filter(coma), p => has(p, MIOSIS))).toBeGreaterThan(0.9);
    const mild = ps.filter(p => !coma(p));
    const severe = ps.filter(p => severity(p) === 'severe');
    expect(share(mild, p => has(p, MIOSIS))).toBeGreaterThan(0.6);
    expect(share(severe, p => has(p, 'vital.spo2_low'))).toBeGreaterThan(0.9);
    expect(share(severe, p => has(p, 'vital.bp_low'))).toBeGreaterThan(0.6);
    // гипотония и гипоксия — не при лёгкой: витальные функции не нарушены (раздел 1.5)
    expect(mild.some(p => has(p, 'vital.bp_low') || has(p, 'vital.spo2_low'))).toBe(false);
    // доля низкого давления — как доля для вывода у параметра
    const low = share(ps, p => p.truth.conditions[0].params.hypotension === 'yes');
    expect(low).toBeGreaterThan(0.15);
    expect(low).toBeLessThan(0.35);
    // следы уколов — «далеко не всегда» (раздел 2.2)
    const marks = share(ps, p => has(p, 'sign.injection_marks'));
    expect(marks).toBeGreaterThan(0.3);
    expect(marks).toBeLessThan(0.7);
  });

  test('обследования: без сознания — расспрос нашедших, глюкометр, неврологический осмотр и тест мочи; узкие зрачки — тест мочи', () => {
    expect(db.exams[URINE]).toMatchObject({ kind: 'rapid', routineFor: [FOUND], routineSeen: [MIOSIS] });
    expect(db.exams[URINE].checks.map(c => [c.f, c.sens, c.spec])).toEqual([['lab.opioids_urine', 9200, 9700]]);
    expect(examMinutes(db.exams[URINE])).toBe(15);
    expect(db.exams[WITNESSES]).toMatchObject({ kind: 'ask', complaints: [FOUND], routineFor: [FOUND] });
    // с частью 57б — и печь или мотор в закрытом помещении, и пожар
    expect(db.exams[WITNESSES].checks.map(c => c.f)).toEqual([FOUND, 'hx.drug_use', 'sym.co_home', 'sym.smoke_inhaled']);
    for (const id of ['exam.glucometer', 'exam.neuro_exam']) expect(db.exams[id].routineFor).toContain(FOUND);
    expect(db.exams['exam.glucometer'].routineSeen).toContain('sign.gcs_coma');
    // где что видно: зрачки — на неврологическом осмотре, дыхание — в показателях, синева и уколы — на общем осмотре
    expect(db.exams['exam.neuro_exam'].checks.map(c => c.f)).toContain(MIOSIS);
    expect(db.exams['exam.vitals'].checks.map(c => c.f)).toContain(SLOW);
    expect(db.exams['exam.general_exam'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sign.cyanosis', 'sign.injection_marks']));
    expect(db.exams['exam.ask_lifestyle'].checks.map(c => c.f)).toContain('hx.drug_use');
    // редкое дыхание — то же измерение, что частое
    expect(db.findings[SLOW].value).toMatchObject({ unit: 'в минуту', ref: [12, 20], of: 'vital.tachypnea' });
  });

  test('тактика: налоксон обязателен при лёгкой; при коме — опасно, обязательна ИВЛ; при низком давлении — растворы; кислород облегчает', () => {
    const t = db.conditions[OP].treatment!;
    expect([t.firstLine, t.acceptable, t.supportive, t.notIndicated, t.harmful, t.require]).toEqual([[], [], ['tx.oxygen_mask', FLUIDS], [], [], undefined]);
    expect(txRole(db, OP, NALOXONE, { severity: 'mild' })).toBe('require');
    expect([FLUIDS, 'tx.oxygen_mask'].map(tx => txRole(db, OP, tx, { severity: 'moderate' }))).toEqual(['supportive', 'supportive']);
    // растворы обязательны при низком давлении — производный параметр по измерению
    expect(['yes', 'no'].map(h => txRole(db, OP, FLUIDS, { severity: 'severe', hypotension: h }))).toEqual(['require', 'supportive']);
    expect(db.conditions[OP].derived).toEqual({ hypotension: { has: 'vital.bp_low' } });
    for (const s of ['moderate', 'severe']) {
      expect(txRole(db, OP, NALOXONE, { severity: s })).toBe('harmful');
      expect(txRole(db, OP, VENT, { severity: s })).toBe('require');
      expect(curesOf(db, { id: OP, params: { severity: s } }, [NALOXONE])).toEqual([]);
      expect(harmsOf(db, { id: OP, params: { severity: s } }, [NALOXONE]).map(h => h.p)).toEqual([2500]);
      // ИВЛ дышит за больного, пока опиоид не выведется
      expect(curesOf(db, { id: OP, params: { severity: s } }, [VENT]).map(e => e.p)).toEqual([10000]);
    }
    expect(curesOf(db, { id: OP, params: { severity: 'mild' } }, [NALOXONE]).map(e => e.p)).toEqual([7500]);
    expect(harmsOf(db, { id: OP, params: { severity: 'mild' } }, [NALOXONE])).toEqual([]);
    // ИВЛ — только в реанимации
    expect(db.treatments[VENT].place).toBe('ricu');
    const deep = ps.find(p => severity(p) === 'severe' && has(p, 'vital.bp_low'))!;
    const obs = complaintObservations(deep);
    // недостающее — по алфавиту идентификаторов
    expect(evaluatePlan(db, deep, { treatments: [], setting: 'ricu' }, obs, VENUE).requireMissing).toEqual([FLUIDS, VENT]);
    const ok = evaluatePlan(db, deep, { treatments: [VENT, FLUIDS], setting: 'ricu' }, obs, VENUE);
    expect([ok.requireMissing, ok.effective]).toEqual([[], true]);
    const light = ps.find(p => severity(p) === 'mild')!;
    expect(evaluatePlan(db, light, { treatments: ['tx.oxygen_mask'], setting: 'icu' }, complaintObservations(light), VENUE).requireMissing).toEqual([NALOXONE]);
  });

  test('течение: лёгкая проходит под наблюдением сама; кома на ИВЛ проходит без последствий, без ИВЛ — хуже', () => {
    expect(db.conditions[OP].settles).toBeUndefined();
    expect(['mild', 'moderate', 'severe'].map(s => selfLimits(db, { id: OP, params: { severity: s } }))).toEqual([true, false, false]);
    const deep = ps.find(p => severity(p) === 'severe' && has(p, 'vital.bp_low'))!;
    const course = (p: Patient, treatments: Id[], setting: 'icu' | 'ricu') => {
      const plan = { treatments, setting };
      return wardCourse(db, p, plan, evaluatePlan(db, p, plan, complaintObservations(p), VENUE), Rng.seeded(p.seed).fork('ward'));
    };
    const ventilated = course(deep, [VENT, FLUIDS], 'ricu');
    expect(ventilated.readyAfter).toBeGreaterThanOrEqual(2);
    expect(ventilated.settled).toBeUndefined();
    expect(course(deep, [FLUIDS], 'ricu')).toMatchObject({ worseAfter: 1 });
    const light = ps.find(p => severity(p) === 'mild')!;
    expect(course(light, [], 'icu').readyAfter).toBeDefined();
  });

  test('место: лёгкая — ПИТ, палата не ошибка; средняя и тяжёлая — реанимация', () => {
    for (const p of ps.slice(0, 40)) {
      expect(recommendedSetting(db, p)).toBe(coma(p) ? 'ricu' : 'icu');
      expect(alsoSettings(db, p)).toEqual(coma(p) ? [] : ['ward']);
    }
  });

  test('без сознания привозят и с печёночной комой и угарным газом: жалоба та же', () => {
    const he = db.conditions['cond.hepatic_encephalopathy'].findings.filter(l => l.f === FOUND);
    expect(he.map(l => [l.p, l.when])).toEqual([[10000, { grade: ['g4'] }]]);
    const users = Object.values(db.conditions).filter(c => c.findings.some(l => l.f === FOUND)).map(c => c.id).sort();
    // с частью 57б — и тяжёлое отравление угарным газом
    expect(users).toEqual(['cond.co_poisoning', 'cond.hepatic_encephalopathy', OP]);
  });
});

/** Разумный врач по шагам: в приёмном с палатой, ПИТ и реанимацией. */
function doctor(p: Patient) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ED);
  const exams = Object.keys(db.exams).sort();
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...VENUE, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  const rs = patients(80, 57_400).map(p => ({ p, r: doctor(p) }));
  const deep = rs.filter(x => coma(x.p));
  const mild = rs.filter(x => !coma(x.p));

  test('верно — почти у каждого; без сознания — расспрос, глюкометр, неврологический осмотр и тест мочи до решения', () => {
    expect(share(rs, x => x.r.diagnosis === OP)).toBeGreaterThan(0.95);
    for (const x of deep) for (const id of [WITNESSES, 'exam.glucometer', 'exam.neuro_exam', URINE]) expect(x.r.done).toContain(id);
    expect(share(mild, x => x.r.done.includes('exam.glucometer'))).toBeGreaterThan(0.95);
  });

  test('при коме — ИВЛ в реанимации и без налоксона, при низком давлении — и растворы; при лёгкой — налоксон и ПИТ', () => {
    // лечение — у тех, кому диагноз поставлен верно: спутанность при циррозе бывает и от него самого
    const right = (xs: typeof rs) => xs.filter(x => x.r.diagnosis === OP);
    expect(share(right(deep), x => x.r.plan.treatments.includes(VENT) && x.r.plan.setting === 'ricu')).toBeGreaterThan(0.95);
    expect(deep.some(x => x.r.plan.treatments.includes(NALOXONE))).toBe(false);
    const low = right(deep.filter(x => has(x.p, 'vital.bp_low')));
    expect(low.length).toBeGreaterThan(5);
    // низкое давление видят на показателях, а они ошибаются: обычно, не всегда
    expect(share(low, x => x.r.plan.treatments.includes(FLUIDS))).toBeGreaterThan(0.85);
    expect(share(right(mild), x => x.r.plan.treatments.includes(NALOXONE))).toBeGreaterThan(0.95);
    expect(share(right(mild), x => x.r.plan.setting === 'icu')).toBeGreaterThan(0.95);
    // тест мочи — 15 минут: решение — меньше чем за час
    expect(share(rs, x => x.r.minutes <= 60)).toBeGreaterThan(0.9);
  });
});

describe('энциклопедия', () => {
  test('тактика строками по степени; новые записи — статьями; в разделе «Отравления»', () => {
    const rows = Object.fromEntries(article(db, OP)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({
      'Облегчить состояние': ['tx.oxygen_mask', FLUIDS],
      'Обязательно, при лёгком течении': [NALOXONE],
      'Опасно, при среднетяжёлом и тяжёлом течении': [NALOXONE],
      'Обязательно, при среднетяжёлом и тяжёлом течении': [VENT],
      'Обязательно, при низком давлении': [FLUIDS],
    });
    for (const id of [OP, NALOXONE, URINE, WITNESSES, FOUND, MIOSIS, SLOW, 'sign.cyanosis', 'sign.injection_marks', 'hx.drug_use', 'lab.opioids_urine']) {
      expect(article(db, id)).toBeDefined();
    }
  });
});
