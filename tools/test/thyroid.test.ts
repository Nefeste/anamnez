// Тиреотоксикоз и тиреотоксический криз (spec 2026-10-chapter-4, часть 56б; 270_2). Тиреотоксикоз — в поликлинике: сердцебиение,
// похудание при хорошем аппетите, дрожь, потливость; ТТГ ниже 0,1, свободный Т4 высокий. Тиамазол — первая линия и только после
// ТТГ, бета-адреноблокатор — обязательно при пульсе чаще 100; ЭКГ, анализ крови и печёночные пробы — каждому с низким ТТГ. Криз —
// жар, частый пульс, возбуждение или забытьё: тиамазол, глюкокортикоид в вену и бета-адреноблокатор сразу, в ПИТ.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { evaluatePlan, recommendedSetting, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const TT = 'cond.thyrotoxicosis';
const TS = 'cond.thyroid_storm';
const TSH_LOW = 'lab.tsh_low';
const FT4 = 'lab.ft4_high';
const THIA = 'tx.thiamazole';
const PTU = 'tx.propylthiouracil';
const BB = 'tx.beta_blocker';
const BB_IV = 'tx.beta_blocker_iv';
const POLY = ['dept.therapy'];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.infectious'];

const patients = (primary: Id, n: number, from: number, departments: Id[], params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments, season: 'autumn', primary, params }));
const has = (p: Patient, f: string, cause: Id) => p.truth.findings.some(x => x.f === f && x.cause === cause);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];

describe('тиреотоксикоз', () => {
  const ps = patients(TT, 300, 56_500, POLY);

  test('запись по 270_2: терапия, E05.0, подтверждает ТТГ; причина — параметр, частый пульс — по измерению', () => {
    expect(db.conditions[TT]).toMatchObject({ icd10: 'E05.0', department: 'dept.therapy', severity: 'moderate', confirm: ['exam.tsh'], params: { cause: { graves: 65, nodular: 35 } } });
    expect(db.conditions[TT].derived).toMatchObject({ tachy: { f: 'vital.tachycardia', above: 100, seen: true } });
    expect(db.conditions[TT].differential).toEqual(['cond.af', TS]);
  });

  test('ТТГ ниже 0,1 и свободный Т4 — почти у каждого; пучеглазие — только при болезни Грейвса; частый пульс — тот же, что у параметра', () => {
    expect(share(ps, p => has(p, TSH_LOW, TT) && has(p, FT4, TT))).toBeGreaterThan(0.85);
    expect(ps.filter(p => param(p, 'cause') === 'nodular').some(p => has(p, 'sign.exophthalmos', TT))).toBe(false);
    expect(share(ps.filter(p => param(p, 'cause') === 'graves'), p => has(p, 'sign.exophthalmos', TT))).toBeGreaterThan(0.35);
    expect(share(ps, p => has(p, 'sign.goiter', TT))).toBeGreaterThan(0.6);
    for (const p of ps) expect(param(p, 'tachy') === 'yes').toBe(p.truth.findings.some(x => x.f === 'vital.tachycardia'));
  });

  test('ТТГ — одно измерение на высокий и низкий; при низком — свободный Т4, ЭКГ, анализ крови и печёночные пробы каждому', () => {
    expect(db.exams['exam.tsh'].checks.map(c => c.f)).toEqual(['lab.tsh_high', TSH_LOW]);
    expect(db.findings[TSH_LOW].value?.of).toBe('lab.tsh_high');
    expect(db.exams['exam.ft4'].routineSeen).toEqual([TSH_LOW]);
    for (const id of ['exam.ecg', 'exam.cbc', 'exam.liver_panel']) expect(db.exams[id].routineSeen).toContain(TSH_LOW);
    expect(db.exams['exam.thyroid_palpation'].checks.map(c => c.f)).toEqual(['sign.goiter']);
    expect(db.exams['exam.general_exam'].checks.map(c => c.f)).toContain('sign.exophthalmos');
    expect(db.exams['exam.ask_general'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sym.heat_intolerance', 'sym.appetite_high']));
    expect(db.exams['exam.ask_chronic'].checks.map(c => c.f)).toContain('hx.thyrotoxicosis');
  });

  test('тактика: тиамазол — первая линия и только после ТТГ, пропилтиоурацил — можно, бета-адреноблокатор — обязательно при пульсе чаще 100', () => {
    const t = db.conditions[TT].treatment!;
    expect([t.firstLine, t.acceptable, t.supportive, t.notIndicated]).toEqual([[THIA], [PTU], [BB], ['tx.levothyroxine']]);
    expect(txRole(db, TT, BB, { cause: 'graves', tachy: 'yes' })).toBe('require');
    expect(txRole(db, TT, BB, { cause: 'graves', tachy: 'no' })).toBe('supportive');
    expect([db.treatments[THIA].confirmFirst, db.treatments[PTU].confirmFirst]).toEqual([true, true]);
    // в 1 триместре беременности — пропилтиоурацил (270_2, раздел 3.2.2)
    expect(db.treatments[THIA].contraindications.map(k => k.id)).toEqual(['risk.pregnancy']);
    expect(recommendedSetting(db, ps[0])).toBe('home');
  });
});

describe('тиреотоксический криз', () => {
  const ps = patients(TS, 300, 56_800, ED);

  test('запись по 270_2: E05.5, критический, по признакам; известен ли тиреотоксикоз и причина — параметры', () => {
    expect(db.conditions[TS]).toMatchObject({ icd10: 'E05.5', department: 'dept.therapy', severity: 'critical', confirm: 'clinical', params: { diagnosed: { yes: 70, no: 30 }, cause: { graves: 80, nodular: 20 } } });
    expect(db.conditions[TS].differential).toEqual(['cond.sepsis', 'cond.alcohol_withdrawal', TT]);
    for (const p of ps) expect(has(p, 'hx.thyrotoxicosis', TS)).toBe(param(p, 'diagnosed') === 'yes');
    expect(share(ps, p => has(p, 'vital.fever', TS) && has(p, 'vital.tachycardia', TS))).toBeGreaterThan(0.85);
  });

  test('тактика: тиамазол, глюкокортикоид в вену и бета-адреноблокатор — вместе; место — ПИТ', () => {
    const t = db.conditions[TS].treatment!;
    expect([t.firstLine, t.acceptable, t.supportive, t.require]).toEqual([[THIA], [PTU], ['tx.iv_fluids', 'tx.paracetamol'], ['tx.steroid_iv', [BB, BB_IV]]]);
    const p = ps[0];
    const obs = complaintObservations(p);
    const venue: Venue = { ward: true, icu: true };
    expect(evaluatePlan(db, p, { treatments: [THIA], setting: 'icu' }, obs, venue).requireMissing).toEqual([BB, 'tx.steroid_iv']);
    const ok = evaluatePlan(db, p, { treatments: [THIA, 'tx.steroid_iv', BB], setting: 'icu' }, obs, venue);
    expect([ok.requireMissing, ok.effective]).toEqual([[], true]);
    expect(recommendedSetting(db, p)).toBe('icu');
  });
});

/** Разумный врач по шагам: в поликлинике — без палат, в приёмном — с палатой и ПИТ. */
function doctor(p: Patient, departments: Id[], venue: Venue) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, departments);
  const exams = Object.keys(db.exams).sort();
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, obs };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  test('тиреотоксикоз в поликлинике: верно — у девяти из десяти, тиамазол — только после ТТГ, при низком ТТГ — Т4, ЭКГ и анализы', () => {
    const rs = patients(TT, 60, 56_600, POLY).map(p => ({ p, r: doctor(p, POLY, {}) }));
    expect(share(rs, x => x.r.diagnosis === TT)).toBeGreaterThan(0.9);
    const given = rs.filter(x => x.r.plan.treatments.includes(THIA));
    expect(given.length).toBeGreaterThan(40);
    expect(given.every(x => x.r.done.includes('exam.tsh'))).toBe(true);
    const low = rs.filter(x => x.r.obs.some(o => o.f === TSH_LOW && o.shown));
    expect(share(low, x => ['exam.ft4', 'exam.ecg', 'exam.cbc', 'exam.liver_panel'].every(id => x.r.done.includes(id)))).toBeGreaterThan(0.9);
    // пульс чаще 100 намерили — бета-адреноблокатор; лечат дома
    const fast = rs.filter(x => x.r.diagnosis === TT && x.r.obs.some(o => o.f === 'vital.tachycardia' && o.shown));
    expect(share(fast, x => x.r.plan.treatments.includes(BB))).toBeGreaterThan(0.9);
    expect(share(rs, x => x.r.plan.setting === 'home')).toBeGreaterThan(0.9);
  });

  test('криз в приёмном: верно — у девяти из десяти; при известном тиреотоксикозе — сразу три лекарства и ПИТ, ТТГ не ждут', () => {
    const rs = patients(TS, 60, 56_900, ED).map(p => ({ p, r: doctor(p, ED, { ward: true, icu: true }) }));
    expect(share(rs, x => x.r.diagnosis === TS)).toBeGreaterThan(0.9);
    const known = rs.filter(x => param(x.p, 'diagnosed') === 'yes');
    expect(share(known, x => x.r.plan.setting === 'icu')).toBeGreaterThan(0.9);
    expect(share(known, x => [THIA, 'tx.steroid_iv'].every(tx => x.r.plan.treatments.includes(tx)) && x.r.plan.treatments.some(tx => tx === BB || tx === BB_IV))).toBeGreaterThan(0.9);
    expect(share(known, x => !x.r.done.includes('exam.tsh'))).toBeGreaterThan(0.9);
  });
});

describe('энциклопедия', () => {
  test('тактики — строками, «обязательно» с условием; новые записи — статьями', () => {
    const rows = (id: Id) => Object.fromEntries(article(db, id)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows(TT)).toMatchObject({ 'Первая линия': [THIA], 'Можно также': [PTU], 'Не нужно': ['tx.levothyroxine'], 'Обязательно, при пульсе чаще 100': [BB] });
    expect(rows(TS)).toMatchObject({ 'Первая линия': [THIA], 'Обязательно': ['tx.steroid_iv'], 'Обязательно — одно из': [BB, BB_IV] });
    for (const id of [TT, TS, TSH_LOW, FT4, 'sign.goiter', 'sign.exophthalmos', 'sym.heat_intolerance', 'sym.appetite_high', 'hx.thyrotoxicosis', 'exam.ft4', 'exam.thyroid_palpation', THIA, PTU]) {
      expect(article(db, id)).toBeDefined();
    }
  });
});
