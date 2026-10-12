// Ботулизм (spec 2026-10-chapter-4, часть 51в; 911_1): пищевой — туман и двоение в глазах, сухость во рту, у половины начало с
// рвоты и поноса, бульбарные нарушения сверху вниз; диагноз по расспросу и осмотру. Антитоксин всем с подозрением и до перевода,
// перед ним глюкокортикоид; промывание желудка и кишечника, хлорамфеникол; не глотает жидкость — зонд и реанимация, дыхательная
// недостаточность — ИВЛ (разделы 1.5, 3, 3.1).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { companionsOf, evaluatePlan, type Plan, recommendedSetting, tacticsFor, txRole, verdictOf } from '../../src/engine/med/plan';
import { examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { whenText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const BOT = 'cond.botulism';
const ATX = 'tx.botulism_antitoxin';
const DEPTS = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
const SEVERITY = ['mild', 'moderate', 'severe', 'odn'] as const;

const patient = (severity: string, seed = 5353, gi?: string): Patient =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: DEPTS, season: 'autumn', primary: BOT, params: { severity, ...(gi ? { gi } : {}) }, carried: db.economy.ambulance.weight });
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const paramsOf = (severity: string) => patient(severity).truth.conditions[0].params;

/** Доля больных с признаком — по генератору. */
function share(severity: string, f: string, n = 200): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (has(patient(severity, 90_000 + i), f)) k++;
  return k / n;
}

describe('ботулизм: болезнь и признаки', () => {
  test('инфекционное отделение без изоляции, круглый год, диагноз клинический; реже клещевого энцефалита', () => {
    expect(db.conditions[BOT]).toMatchObject({ department: 'dept.infectious', icd10: 'A05.1', confirm: 'clinical' });
    expect(db.conditions[BOT].isolation).toBeUndefined();
    const who = { sex: 'f' as const, age: 50, risks: [], chronic: [] };
    expect(presentingWeight(db.conditions[BOT], { ...who, season: 'winter' })).toBeGreaterThan(0);
    expect(presentingWeight(db.conditions[BOT], { ...who, season: 'summer' })).toBeLessThan(presentingWeight(db.conditions['cond.tbe'], { ...who, season: 'summer' }));
  });

  test('двоение в глазах — у каждого и среди жалоб; глотание — с среднетяжёлого, вода — с тяжёлого, одышка — при дыхательной недостаточности', () => {
    for (const s of SEVERITY) {
      expect(share(s, 'sym.diplopia')).toBe(1);
      expect(patient(s).complaints).toContain('sym.diplopia');
    }
    // при лёгком — только фон признака
    expect(share('mild', 'sym.swallow_trouble')).toBeLessThan(0.05);
    expect(share('moderate', 'sym.swallow_trouble')).toBe(1);
    expect(share('moderate', 'sym.choking_liquids')).toBe(0);
    expect(share('severe', 'sym.choking_liquids')).toBe(1);
    expect(share('severe', 'sym.dyspnea')).toBeLessThan(0.1);
    expect(share('odn', 'sym.dyspnea')).toBe(1);
    const canned = share('moderate', 'hx.home_canned');
    expect(canned).toBeGreaterThan(0.8);
    expect(canned).toBeLessThan(0.97);
    // рвота и понос — только при начале с гастроэнтерита (раздел 1.6)
    expect(has(patient('mild', 5353, 'no'), 'sym.vomiting')).toBe(false);
  });

  test('производное: не глотает жидкость — при тяжёлом течении и с дыхательной недостаточностью', () => {
    expect(SEVERITY.map(s => paramsOf(s).liquids)).toEqual(['no', 'no', 'yes', 'yes']);
  });

  test('расспрос о еде, зрении и глотании — первым при двоении в глазах; птоз и зрачки — на неврологическом осмотре', () => {
    expect(db.exams['exam.ask_food'].routineFor).toContain('sym.diplopia');
    expect(db.exams['exam.ask_food'].checks.map(c => c.f)).toEqual(['hx.home_canned', 'sym.diplopia', 'sym.dry_mouth', 'sym.swallow_trouble', 'sym.choking_liquids']);
    // с частью 54а за ними — хлопающий тремор печёночной энцефалопатии, с частью 57а — узкие зрачки отравления опиоидами, с частью
    // 58б — пятки и носки, ахиллов рефлекс, чувствительность на голени и в промежности, сила обеих ног
    expect(db.exams['exam.neuro_exam'].checks.map(c => c.f).slice(-10)).toEqual(['sign.ptosis', 'sign.mydriasis', 'sign.asterixis', 'sign.miosis', 'sign.heel_walk_weak', 'sign.toe_walk_weak', 'sign.ankle_reflex_low', 'sign.leg_hypoesthesia', 'sign.saddle_anesthesia', 'sign.legs_paresis']);
    expect(db.exams['exam.neuro_exam'].routineFor).toContain('sym.diplopia');
  });
});

describe('ботулизм: лечение и место', () => {
  test('антитоксин, промывание и хлорамфеникол — всем; антитоксин и промывание — и до перевода; перед антитоксином — глюкокортикоид', () => {
    const t = db.conditions[BOT].treatment!;
    expect(t.firstLine).toEqual([]);
    expect(t.require).toEqual([ATX, 'tx.gastric_lavage', 'tx.chloramphenicol']);
    expect(t.beforeTransfer).toEqual([ATX, 'tx.gastric_lavage']);
    expect(companionsOf(db, ATX, BOT)).toEqual(['tx.steroid_iv']);
    expect(txRole(db, BOT, 'tx.steroid_iv', paramsOf('mild'))).toBe('supportive');
    expect(tacticsFor(t, paramsOf('mild')).require).toEqual([ATX, 'tx.gastric_lavage', 'tx.chloramphenicol']);
    expect(tacticsFor(t, paramsOf('severe')).require).toEqual([ATX, 'tx.gastric_lavage', 'tx.chloramphenicol', 'tx.ng_tube']);
    expect(tacticsFor(t, paramsOf('odn')).require).toEqual([ATX, 'tx.gastric_lavage', 'tx.chloramphenicol', 'tx.ng_tube', 'tx.ventilation']);
  });

  test('место: только стационар — палата; не глотает жидкость и дыхательная недостаточность — реанимация', () => {
    expect(recommendedSetting(db, patient('mild'), [])).toBe('ward');
    expect(recommendedSetting(db, patient('moderate'), [])).toBe('ward');
    expect(recommendedSetting(db, patient('severe'), [])).toBe('ricu');
    expect(recommendedSetting(db, patient('odn'), [])).toBe('ricu');
  });

  test('без антитоксина — хуже; с ним — действует, без глюкокортикоида — замечание о спутнике', () => {
    const p = patient('moderate', 91_000);
    const full: Plan = { treatments: [ATX, 'tx.steroid_iv', 'tx.gastric_lavage', 'tx.chloramphenicol'], setting: 'admit' };
    expect(evaluatePlan(db, p, full, []).effective).toBe(true);
    expect(evaluatePlan(db, p, full, []).companionsMissing).toEqual([]);
    expect(evaluatePlan(db, p, { ...full, treatments: [ATX, 'tx.gastric_lavage', 'tx.chloramphenicol'] }, []).companionsMissing).toEqual([{ tx: 'tx.steroid_iv', of: ATX }]);
    const home: Plan = { treatments: ['tx.gastric_lavage', 'tx.chloramphenicol'], setting: 'home' };
    const outs = Array.from({ length: 200 }, (_, i) => observe(db, p, home, evaluatePlan(db, p, home, []), Rng.seeded(i).fork('out')));
    expect(outs.filter(o => o.kind === 'worse').length / outs.length).toBeGreaterThan(0.6);
  });

  test('энциклопедия: тяжесть и глотание словами; «С чем спутать» — инсульт, сальмонеллёз, гастроэнтерит', () => {
    for (const s of SEVERITY) expect(whenText({ severity: [s] })).toEqual(expect.any(String));
    for (const v of ['yes', 'no']) expect(whenText({ liquids: [v] })).toEqual(expect.any(String));
    expect(whenText({ severity: ['moderate', 'severe', 'odn'] })).toBe('при среднетяжёлом течении и тяжелее');
    expect(db.conditions[BOT].differential).toEqual(['cond.stroke_ischemic', 'cond.salmonellosis', 'cond.gastroenteritis']);
    for (const id of [BOT, 'exam.ask_food', ATX, 'tx.gastric_lavage', 'tx.chloramphenicol', 'sym.diplopia', 'sign.mydriasis']) expect(article(db, id)).toBeDefined();
  });
});

describe('разумный врач при ботулизме', () => {
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

  test('ставит ботулизм, вводит антитоксин с глюкокортикоидом; тяжёлое — реанимация с зондом, дыхательная недостаточность — с ИВЛ', () => {
    const n = 20;
    let right = 0, atx = 0, ward = 0, ricu = 0, vent = 0;
    for (let i = 0; i < n; i++) {
      const p = patient('moderate', 92_000 + i);
      const r = run(p);
      if (verdictOf(db, r.diagnosis, p) === 'correct') right++;
      if (r.plan.treatments.includes(ATX) && r.plan.treatments.includes('tx.steroid_iv')) atx++;
      if (r.plan.setting === 'admit' || r.plan.setting === 'icu') ward++;
      const severe = run(patient('severe', 93_000 + i));
      if (severe.plan.setting === 'ricu' && severe.plan.treatments.includes('tx.ng_tube')) ricu++;
      if (run(patient('odn', 94_000 + i)).plan.treatments.includes('tx.ventilation')) vent++;
    }
    expect(right / n).toBeGreaterThan(0.85);
    expect(atx / n).toBeGreaterThan(0.85);
    expect(ward / n).toBeGreaterThan(0.85);
    expect(ricu / n).toBeGreaterThan(0.85);
    expect(vent / n).toBeGreaterThan(0.85);
  }, 120_000);
});
