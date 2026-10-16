// Острая крапивница (spec 2026-10-urticaria-dka, часть 73; 264_2): волдыри с зудом, бывает отёк губ и век; причина —
// новое лекарство, инфекция, еда или не найдена. Антигистаминные второго поколения дома; уже не помогли — глюкокортикоиды
// коротким курсом; эпинефрин — только при анафилаксии. Двойник анафилактического шока: сыпь та же, давление — нет.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { curesOf, recommendedSetting, txRole } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const UA = 'cond.urticaria_acute';
const AN = 'cond.anaphylaxis';
const AH = 'tx.antihistamine';
const GCS = 'tx.steroid_systemic_short';

const patients = (n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', season: 'spring', primary: UA, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === UA);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];

describe('острая крапивница', () => {
  const ps = patients(300, 73_100);

  test('запись по 264_2: терапия, L50.9, кожа; причина и «таблетки уже не помогли» — параметры; двойник анафилаксии', () => {
    expect(db.conditions[UA]).toMatchObject({
      icd10: 'L50.9', department: 'dept.therapy', system: 'skin', severity: 'minor', confirm: 'clinical',
      params: { trigger: { drug: 30, ari: 25, food: 15, unknown: 30 }, tried: { no: 80, failed: 20 } },
    });
    expect(db.conditions[UA].differential).toEqual([AN]);
    expect(db.conditions[AN].differential).toEqual(['cond.acs', UA]);
  });

  test('волдыри с зудом — у каждого; причина и выпитые таблетки — по параметрам; давления ниже 90 и стридора крапивница не даёт', () => {
    for (const p of ps) {
      expect(has(p, 'sym.hives')).toBe(true);
      expect(has(p, 'hx.new_drug')).toBe(param(p, 'trigger') === 'drug');
      expect(has(p, 'hx.recent_cold')).toBe(param(p, 'trigger') === 'ari');
      expect(has(p, 'hx.trigger_food')).toBe(param(p, 'trigger') === 'food');
      expect(has(p, 'hx.antihistamine_failed')).toBe(param(p, 'tried') === 'failed');
      for (const f of ['vital.bp_low', 'sign.stridor', 'sign.wheezes']) expect(has(p, f)).toBe(false);
    }
    // ангиоотёк — «иногда»
    expect(share(ps, p => has(p, 'sign.angioedema'))).toBeGreaterThan(0.15);
    expect(share(ps, p => has(p, 'sign.angioedema'))).toBeLessThan(0.45);
  });

  test('жалоба на сыпь не говорит об одышке: у крапивницы её нет, у анафилаксии — своя жалоба', () => {
    for (const t of db.findings['sym.hives'].texts.complaint ?? []) expect(t.ru).not.toMatch(/дыш/);
  });

  test('о причине — расспрос «что было перед реакцией» (каждому с сыпью), о простуде — «как началось», о выпитых таблетках — «какие лекарства»', () => {
    expect(db.exams['exam.ask_reaction'].routineFor).toEqual(['sym.hives']);
    expect(db.exams['exam.ask_reaction'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['hx.new_drug', 'hx.trigger_food']));
    // вопрос о реакции о простуде не спрашивает: иначе он отвечал бы о ней и тем, у кого реакции не было, — перикардит
    // без ЭКГ
    expect(db.exams['exam.ask_reaction'].checks.map(c => c.f)).not.toContain('hx.recent_cold');
    expect(db.exams['exam.ask_onset'].checks.map(c => c.f)).toContain('hx.recent_cold');
    expect(db.exams['exam.ask_meds'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['hx.new_drug', 'hx.antihistamine_failed']));
  });

  test('тактика: антигистаминные — первая линия; не помогли — глюкокортикоиды коротким курсом; эпинефрин и растворы — не нужны; дома', () => {
    const t = db.conditions[UA].treatment!;
    expect(t.firstLine).toEqual([AH]);
    expect(t.acceptable).toEqual(['tx.antihistamine_parenteral']);
    expect(t.notIndicated).toEqual(['tx.steroid_iv', 'tx.epinephrine_im', 'tx.iv_fluids']);
    expect([txRole(db, UA, GCS, { tried: 'no' }), txRole(db, UA, GCS, { tried: 'failed' })]).toEqual(['notIndicated', 'firstLine']);
    expect([txRole(db, UA, AH, { tried: 'no' }), txRole(db, UA, AH, { tried: 'failed' })]).toEqual(['firstLine', 'acceptable']);
    // кто их уже пил без толку, тому они и не помогают; гормон до антигистаминных — только облегчение
    expect(curesOf(db, { id: UA, params: { tried: 'no' } }, [AH]).length).toBe(1);
    expect(curesOf(db, { id: UA, params: { tried: 'failed' } }, [AH])).toEqual([]);
    expect(curesOf(db, { id: UA, params: { tried: 'failed' } }, [GCS]).length).toBe(1);
    expect(curesOf(db, { id: UA, params: { tried: 'no' } }, [GCS])).toEqual([]);
    for (const p of ps.slice(0, 20)) expect(recommendedSetting(db, p)).toBe('home');
  });
});

/** Разумный врач по шагам — в амбулатории. */
function doctor(p: Patient) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ['dept.therapy']);
  const exams = Object.keys(db.exams).sort();
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  test('крапивница верно — почти у каждого: дома, антигистаминные; не помогли — гормон', () => {
    const rs = patients(100, 73_500).map(p => ({ p, r: doctor(p) }));
    expect(share(rs, x => x.r.diagnosis === UA)).toBeGreaterThan(0.95);
    const right = rs.filter(x => x.r.diagnosis === UA);
    expect(share(right, x => x.r.plan.setting === 'home')).toBe(1);
    expect(share(right.filter(x => param(x.p, 'tried') === 'no'), x => x.r.plan.treatments.includes(AH) && !x.r.plan.treatments.includes(GCS))).toBeGreaterThan(0.9);
    expect(share(right.filter(x => param(x.p, 'tried') === 'failed'), x => x.r.plan.treatments.includes(GCS))).toBeGreaterThan(0.9);
    // эпинефрин при крапивнице без анафилаксии не нужен
    expect(right.some(x => x.r.plan.treatments.includes('tx.epinephrine_im'))).toBe(false);
  });
});

describe('энциклопедия', () => {
  test('крапивница — статьёй; антигистаминные — первая линия, эпинефрин — не нужен; новые признаки — статьями', () => {
    const rows = Object.fromEntries(article(db, UA)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows['Первая линия']).toEqual([AH]);
    expect(rows['Не нужно']).toEqual(expect.arrayContaining(['tx.epinephrine_im']));
    for (const id of [UA, 'hx.new_drug', 'hx.antihistamine_failed']) expect(article(db, id)).toBeDefined();
  });
});
