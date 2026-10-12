// Отравление угарным газом (spec 2026-10-chapter-4, часть 57б; 885_1): привозит скорая — с пожара или угоревшего дома у печи,
// колонки, мотора в закрытом гараже. При лёгкой и средней степени — головная боль, головокружение, тошнота, слабость, при тяжёлой —
// кома. Подтверждает карбоксигемоглобин, но тяжесть по нему при поступлении не читается. Кислород лечит, антидот — каждому
// взрослому, на пожаре можно и антидот цианидов; при коме — ИВЛ, при низком давлении — растворы. Лёгкое — палата, тяжёлое —
// реанимация.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { alsoSettings, curesOf, recommendedSetting, selfLimits, txRole, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const CO = 'cond.co_poisoning';
const COHB = 'exam.cohb';
const OXYGEN = 'tx.oxygen_mask';
const ZINC = 'tx.zinc_bisvinylimidazole';
const THIO = 'tx.sodium_thiosulfate';
const VENT = 'tx.ventilation';
const FLUIDS = 'tx.iv_fluids';
const SMOKE = 'sym.smoke_inhaled';
const HOME = 'sym.co_home';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.infectious'];
const VENUE: Venue = { ward: true, icu: true, ricu: true };
const PLACE = { mild: 'ward', moderate: 'icu', severe: 'ricu' } as const;

const patients = (n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'winter', primary: CO, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === CO);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];

describe('отравление угарным газом', () => {
  const ps = patients(300, 57_200);

  test('запись по 885_1: терапия, T58, отравления, только скорая; подтверждает карбоксигемоглобин; тяжесть и откуда газ — параметры', () => {
    expect(db.conditions[CO]).toMatchObject({
      icd10: 'T58', department: 'dept.therapy', system: 'poisoning', kind: 'state', arrival: 'ambulance', severity: 'critical', confirm: [COHB],
      params: { severity: { mild: 40, moderate: 35, severe: 25 }, exposure: { fire: 75, home: 25 } },
      derived: { hypotension: { has: 'vital.bp_low' } },
    });
    expect(db.conditions[CO].redFlags).toEqual(['sign.gcs_coma']);
    expect(db.conditions[CO].differential).toEqual(['cond.opioid_poisoning', 'cond.hypoglycemia', 'cond.concussion']);
    // печи и колонки — зимой: игровая оценка
    const season = db.conditions[CO].season!;
    expect(season.winter).toBeGreaterThan(season.summer);
    expect([ZINC, THIO].map(tx => txGroupOfClass(db.treatments[tx].class))).toEqual(['antidotes', 'antidotes']);
  });

  test('с пожара — жалоба и копоть; у печи и мотора — обычно скажет скорая; при тяжёлом — кома; карбоксигемоглобин — у каждого', () => {
    for (const p of ps) {
      const fire = param(p, 'exposure') === 'fire';
      const severe = param(p, 'severity') === 'severe';
      expect(has(p, SMOKE)).toBe(fire);
      if (fire) expect(p.complaints).toContain(SMOKE);
      if (!fire) expect(has(p, 'sign.soot_face')).toBe(false);
      if (has(p, HOME)) expect(p.complaints).toContain(HOME);
      for (const f of ['sym.found_unconscious', 'sign.gcs_coma']) expect(has(p, f)).toBe(severe);
      if (severe) expect(has(p, 'sym.headache')).toBe(false);
      expect(has(p, 'lab.cohb_high')).toBe(true);
    }
    const home = ps.filter(p => param(p, 'exposure') === 'home');
    const known = share(home, p => has(p, HOME));
    expect(known).toBeGreaterThan(0.55);
    expect(known).toBeLessThan(0.95);
    const light = ps.filter(p => param(p, 'severity') !== 'severe');
    expect(share(light, p => has(p, 'sym.headache'))).toBeGreaterThan(0.6);
    expect(share(ps.filter(p => param(p, 'exposure') === 'fire'), p => has(p, 'sign.soot_face'))).toBeGreaterThan(0.6);
    // розовые слизистые — патогномоничный признак, но не у каждого
    const pink = share(ps, p => has(p, 'sign.pink_mucosa'));
    expect(pink).toBeGreaterThan(0.1);
    expect(pink).toBeLessThan(0.45);
  });

  test('обследования: карбоксигемоглобин и ЭКГ — каждому с пожара и угоревшему; розовые слизистые и копоть — на общем осмотре', () => {
    expect(db.exams[COHB]).toMatchObject({ kind: 'lab', routineFor: [SMOKE, HOME], routineSeen: ['sign.pink_mucosa', 'sign.soot_face'] });
    expect(db.exams[COHB].checks.map(c => [c.f, c.sens, c.spec])).toEqual([['lab.cohb_high', 9700, 9900]]);
    expect(examMinutes(db.exams[COHB])).toBe(25);
    expect(db.findings['lab.cohb_high'].value).toMatchObject({ unit: '%' });
    expect(db.exams['exam.ecg'].routineFor).toEqual(expect.arrayContaining([SMOKE, HOME]));
    expect(db.exams['exam.general_exam'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sign.pink_mucosa', 'sign.soot_face']));
    for (const id of ['exam.ask_lifestyle', 'exam.ask_witnesses']) expect(db.exams[id].checks.map(c => c.f)).toContain(HOME);
    for (const id of ['exam.ask_complaints', 'exam.ask_witnesses']) expect(db.exams[id].checks.map(c => c.f)).toContain(SMOKE);
  });

  test('тактика: кислород лечит, антидот — каждому; на пожаре можно и натрия тиосульфат; при коме — ИВЛ, при низком давлении — растворы', () => {
    const t = db.conditions[CO].treatment!;
    expect([t.firstLine, t.acceptable, t.supportive, t.notIndicated, t.harmful, t.require]).toEqual([[OXYGEN], [], [FLUIDS], [], [], [ZINC]]);
    expect(['fire', 'home'].map(e => txRole(db, CO, THIO, { severity: 'mild', exposure: e }))).toEqual(['acceptable', 'notIndicated']);
    expect(['mild', 'moderate', 'severe'].map(s => txRole(db, CO, VENT, { severity: s, exposure: 'fire' }))).toEqual(['notIndicated', 'notIndicated', 'require']);
    expect(['yes', 'no'].map(h => txRole(db, CO, FLUIDS, { severity: 'severe', hypotension: h }))).toEqual(['require', 'supportive']);
    for (const s of ['mild', 'moderate', 'severe']) expect(curesOf(db, { id: CO, params: { severity: s } }, [OXYGEN]).map(e => e.p)).toEqual([9500]);
    expect(curesOf(db, { id: CO, params: { severity: 'severe' } }, [VENT]).map(e => e.p)).toEqual([9500]);
    expect(curesOf(db, { id: CO, params: { severity: 'mild' } }, [VENT, ZINC, THIO])).toEqual([]);
  });

  test('течение и место: лёгкое проходит под наблюдением, тяжёлое без лечения — хуже сразу; палата, ПИТ и реанимация по тяжести', () => {
    expect(['mild', 'moderate', 'severe'].map(s => selfLimits(db, { id: CO, params: { severity: s } }))).toEqual([true, false, false]);
    expect(untreatedOf(db, { id: CO, params: { severity: 'severe' } })).toMatchObject({ p: 9500, days: [0, 0] });
    for (const p of ps.slice(0, 60)) {
      const s = param(p, 'severity');
      expect(recommendedSetting(db, p)).toBe(PLACE[s as keyof typeof PLACE]);
      expect(alsoSettings(db, p)).toEqual(s === 'mild' ? ['icu'] : s === 'moderate' ? ['ward'] : []);
    }
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
  const rs = patients(80, 57_300).map(p => ({ p, r: doctor(p) }));
  const right = rs.filter(x => x.r.diagnosis === CO);

  test('верно — почти у каждого; с пожара — у каждого, после карбоксигемоглобина и ЭКГ', () => {
    expect(right.length / rs.length).toBeGreaterThan(0.9);
    const fire = rs.filter(x => param(x.p, 'exposure') === 'fire');
    expect(fire.every(x => x.r.diagnosis === CO && x.r.done.includes(COHB) && x.r.done.includes('exam.ecg'))).toBe(true);
  });

  test('кислород и антидот — каждому с верным диагнозом; при коме — ИВЛ в реанимации', () => {
    expect(right.every(x => [OXYGEN, ZINC].every(tx => x.r.plan.treatments.includes(tx)))).toBe(true);
    const severe = right.filter(x => param(x.p, 'severity') === 'severe');
    expect(severe.length).toBeGreaterThan(5);
    expect(severe.every(x => x.r.plan.treatments.includes(VENT) && x.r.plan.setting === 'ricu')).toBe(true);
    // лёгкое и среднее — в стационар: домой — ошибка
    expect(share(right.filter(x => param(x.p, 'severity') !== 'severe'), x => x.r.plan.setting !== 'home')).toBeGreaterThan(0.95);
  });
});

describe('энциклопедия', () => {
  test('тактика строками; новые записи — статьями', () => {
    const rows = Object.fromEntries(article(db, CO)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({
      'Первая линия': [OXYGEN],
      'Облегчить состояние': [FLUIDS],
      'Обязательно': [ZINC],
      'Можно также, при отравлении дымом пожара': [THIO],
      'Обязательно, при тяжёлом течении': [VENT],
      'Обязательно, при низком давлении': [FLUIDS],
    });
    for (const id of [CO, COHB, ZINC, THIO, SMOKE, HOME, 'sign.pink_mucosa', 'sign.soot_face', 'lab.cohb_high']) expect(article(db, id)).toBeDefined();
  });
});
