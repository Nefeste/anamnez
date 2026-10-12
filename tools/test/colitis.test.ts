// Тяжёлая атака язвенного колита (spec 2026-10-chapter-4, часть 55а; 193_2): стул с кровью 6 раз в сутки и чаще и признак
// системного воспаления — по Трулаву–Виттсу. Кишку смотрят сигмоидоскопией: подготовка к колоноскопии осмотическими
// слабительными — фактор риска токсической дилатации, правило «Можно ли колоноскопию с подготовкой». Кал на токсины
// C. difficile — при каждом обострении. Лечат в палате глюкокортикоидами в вену, лоперамид — вред, при сверхтяжёлой атаке —
// колопроктолог.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { curesOf, evaluatePlan, examHarmsOf, recommendedSetting, tacticsFor, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import { harmCheck, knownOf } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const UC = 'cond.uc_attack';
const BLOODY = 'sym.bloody_diarrhea';
const SIGMO = 'exam.sigmoidoscopy';
const COLONO = 'exam.colonoscopy';
const RULE = 'rule.colonoscopy_prep';
const STEROID = 'tx.steroid_iv';
const CONSULT = 'tx.coloproctologist_consult';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];

const therapy = (n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: UC, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const attack = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params.attack;
const seen = (f: Id, shown = true, exam = 'exam.ask_abdomen'): Observation => ({ f, shown, exam });

describe('тяжёлая атака язвенного колита', () => {
  const ps = therapy(300, 55_100);

  test('запись по 193_2: терапия, K51, тяжёлая и сверхтяжёлая атака; подтверждает эндоскопия', () => {
    expect(db.conditions[UC]).toMatchObject({ icd10: 'K51', department: 'dept.therapy', confirm: [SIGMO, COLONO], params: { attack: { severe: 75, fulminant: 25 } } });
    expect(db.conditions[UC].differential).toEqual(['cond.shigellosis', 'cond.cdiff', 'cond.salmonellosis']);
  });

  test('по Трулаву–Виттсу: стул с кровью 6 раз и чаще и СРБ выше 30 — у каждого; при сверхтяжёлой — лихорадка и анемия у каждого; колит на эндоскопии — у каждого', () => {
    for (const p of ps) {
      expect(has(p, BLOODY) && has(p, 'lab.crp_high') && has(p, 'img.colon_uc')).toBe(true);
      expect(p.complaints).toContain(BLOODY);
      if (attack(p) === 'fulminant') expect(has(p, 'vital.fever') && has(p, 'lab.hb_low')).toBe(true);
    }
    const severe = ps.filter(p => attack(p) === 'severe');
    expect(share(severe, p => has(p, 'vital.fever'))).toBeLessThan(0.4);
    // колит уже знают — обычно, бывает и первая атака
    const known = share(ps, p => has(p, 'hx.uc'));
    expect(known).toBeGreaterThan(0.65);
    expect(known).toBeLessThan(0.85);
  });

  test('сигмоидоскопия и колоноскопия — в эндоскопическом кабинете; сигмоидоскопия и тест на C. difficile — каждому со стулом с кровью', () => {
    for (const e of [SIGMO, COLONO]) expect(db.exams[e]).toMatchObject({ room: 'room.endoscopy', equipment: ['eq.videoendoscope'], radiation: 'none' });
    expect(db.exams[SIGMO].routineFor).toEqual([BLOODY]);
    expect(db.exams['exam.cdiff_stool'].routineFor).toEqual([BLOODY]);
    expect(db.exams['exam.cdiff_stool'].complaints).toEqual(['sym.diarrhea', BLOODY]);
    expect(db.exams['exam.ask_meds'].routineFor?.at(-1)).toBe(BLOODY);
    // колоноскопия дольше: кишку готовят слабительными
    expect(examMinutes(db.exams[COLONO])).toBeGreaterThan(examMinutes(db.exams[SIGMO]));
  });

  test('«Можно ли колоноскопию с подготовкой»: стул с кровью — нельзя; о нём не спрашивали — пока неизвестно; нет — можно', () => {
    expect(db.exams[COLONO].harm?.rule).toBe(RULE);
    expect(db.rules[RULE]).toMatchObject({ decides: COLONO, any: [BLOODY], about: [UC] });
    expect(harmCheck(db, COLONO, knownOf([seen(BLOODY)])).verdict).toBe('yes');
    expect(harmCheck(db, COLONO, knownOf([]))).toEqual({ verdict: 'unknown', left: [BLOODY] });
    expect(harmCheck(db, COLONO, knownOf([seen(BLOODY, false)]))).toEqual({ verdict: 'no', left: [] });
    expect(harmCheck(db, SIGMO, knownOf([seen(BLOODY)])).verdict).toBe('no');
  });

  test('колоноскопия при атаке — вред, о котором врач знал: стул с кровью — жалоба; сигмоидоскопия — без вреда', () => {
    const p = ps[0];
    const obs = complaintObservations(p);
    expect(examHarmsOf(db, p, [COLONO], obs)).toEqual([{ exam: COLONO, by: [BLOODY], known: true }]);
    expect(examHarmsOf(db, p, [SIGMO], obs)).toEqual([]);
    const ev = evaluatePlan(db, p, { treatments: [STEROID], setting: 'admit' }, [...obs, ...runExam(db, p, COLONO, Rng.seeded(1))], { ward: true, done: [COLONO] });
    expect(ev.examHarms).toEqual([{ exam: COLONO, by: [BLOODY], known: true }]);
  });

  test('тактика по 193_2: глюкокортикоиды в вену — первая линия; лоперамид — вред; при сверхтяжёлой — колопроктолог обязательно', () => {
    const t = db.conditions[UC].treatment!;
    expect(t.firstLine).toEqual([STEROID]);
    expect(t.harmful).toEqual(['tx.loperamide']);
    expect(t.acceptable).toEqual(['tx.lmwh', 'tx.antibiotic_iv']);
    expect(t.supportive).toEqual(['tx.iv_fluids', 'tx.balanced_fluids']);
    expect(tacticsFor(t, { attack: 'fulminant' }).require).toEqual([CONSULT]);
    expect(tacticsFor(t, { attack: 'severe' }).require).toBeUndefined();
    expect(txRole(db, UC, CONSULT, { attack: 'fulminant' })).toBe('require');
    // глюкокортикоиды излечивают тяжёлую атаку у трёх из четырёх, сверхтяжёлую — не больше чем у половины
    expect(curesOf(db, { id: UC, params: { attack: 'severe' } }, [STEROID]).map(e => e.p)).toEqual([7500]);
    expect(curesOf(db, { id: UC, params: { attack: 'fulminant' } }, [STEROID]).map(e => e.p)).toEqual([5000]);
    const fulminant = ps.find(p => attack(p) === 'fulminant')!;
    const venue: Venue = { ward: true };
    expect(evaluatePlan(db, fulminant, { treatments: [STEROID], setting: 'admit' }, complaintObservations(fulminant), venue).requireMissing).toEqual([CONSULT]);
    expect(evaluatePlan(db, fulminant, { treatments: [STEROID, CONSULT], setting: 'admit' }, complaintObservations(fulminant), venue).requireMissing).toEqual([]);
  });

  test('место — палата при любой атаке', () => {
    for (const p of ps.slice(0, 20)) expect(recommendedSetting(db, p)).toBe('ward');
  });
});

/** Разумный врач по шагам — с эндоскопическим кабинетом. */
function doctor(p: Patient, exams: readonly Id[], venue: Venue) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ED);
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams: [...exams], threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  test('атака колита: сигмоидоскопия и кал на C. difficile каждому, колоноскопии нет; глюкокортикоиды в палате, при сверхтяжёлой — колопроктолог', () => {
    const ps = therapy(60, 5500);
    const rs = ps.map(p => doctor(p, Object.keys(db.exams).sort(), { ward: true, icu: true, rooms: ['room.endoscopy'] }));
    expect(share(rs, r => r.diagnosis === UC)).toBeGreaterThan(0.9);
    expect(share(rs, r => r.done.includes(SIGMO) && r.done.includes('exam.cdiff_stool'))).toBeGreaterThan(0.9);
    expect(rs.some(r => r.done.includes(COLONO))).toBe(false);
    expect(share(rs, r => r.plan.treatments.includes(STEROID) && r.plan.setting === 'admit')).toBeGreaterThan(0.9);
    const fulminant = rs.filter((_, i) => attack(ps[i]) === 'fulminant');
    expect(share(fulminant, r => r.plan.treatments.includes(CONSULT))).toBeGreaterThan(0.8);
  });
});

describe('энциклопедия', () => {
  test('атака колита: глюкокортикоиды — первая линия, лоперамид — опасно, колопроктолог — при сверхтяжёлой; правило — статьёй', () => {
    const rows = Object.fromEntries(article(db, UC)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({ 'Первая линия': [STEROID], 'Опасно': ['tx.loperamide'], 'Обязательно, при сверхтяжёлой атаке': [CONSULT] });
    for (const id of [UC, SIGMO, COLONO, RULE, BLOODY, 'hx.uc', 'img.colon_uc', CONSULT]) expect(article(db, id)).toBeDefined();
    expect(article(db, COLONO)!.blocks.find(b => b.key === 'harm')!.refs!.map(r => r.id)).toEqual([RULE]);
  });
});
