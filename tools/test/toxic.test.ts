// Отравления метанолом и этиленгликолем (spec 2026-10-chapter-4, часть 57в; 873_1): одна рекомендация, два диагноза — в диагнозе
// называют вещество. Привозит скорая; о выпитом — стеклоомывателе, дешёвом алкоголе с рук, антифризе — обычно скажут. Метанол бьёт по
// зрению, этиленгликоль — болью в животе и пояснице, потом по почкам; при тяжёлом — кома и ацидоз. Подтверждает хроматография крови,
// ацидоз показывает КОС. Антидот — этанол, при ацидозе — натрия гидрокарбонат, при этиленгликоле с низким кальцием — кальций; всё —
// до перевода: гемодиализа в игре нет (вопрос 31). Лёгкое можно долечить у себя.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { alsoSettings, curesOf, evaluatePlan, type Plan, recommendedSetting, selfLimits, txRole, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(120_000);

const MET = 'cond.methanol_poisoning';
const EG = 'cond.ethylene_glycol_poisoning';
const ABG = 'exam.abg';
const GC = 'exam.toxic_alcohols';
const ETOH = 'tx.ethanol_antidote';
const SODA = 'tx.sodium_bicarbonate';
const FOLIC = 'tx.folic_acid';
const B6 = 'tx.pyridoxine';
const B1 = 'tx.thiamine';
const COAL = 'tx.activated_charcoal';
const LAVAGE = 'tx.gastric_lavage';
const FLUIDS = 'tx.iv_fluids';
const CA = 'tx.calcium_gluconate_iv';
const DRINK = 'sym.methanol_drink';
const ANTIFREEZE = 'sym.antifreeze_drink';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.infectious'];
const VENUE: Venue = { ward: true, icu: true, ricu: true };

const patients = (cond: Id, n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'winter', primary: cond, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === p.truth.conditions.find(c => c.role === 'primary')!.id);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];
const plan = (treatments: Id[], setting: Setting = 'ambulance'): Plan => ({ treatments: [...treatments].sort(), setting });
/** Жалобы, КОС, хроматография, кальций и показатели — как у разумного врача. */
const checked = (p: Patient): Observation[] => {
  const rng = Rng.seeded(p.seed).fork('checked');
  return [...complaintObservations(p), ...[ABG, GC, 'exam.calcium', 'exam.vitals'].flatMap(e => runExam(db, p, e, rng.fork(e)))];
};

describe('отравление метанолом', () => {
  const ps = patients(MET, 300, 57_600);

  test('запись по 873_1: терапия, T51.1, отравления, только скорая; подтверждает хроматография; тяжесть — параметр, ацидоз — по КОС', () => {
    expect(db.conditions[MET]).toMatchObject({
      icd10: 'T51.1', department: 'dept.therapy', system: 'poisoning', kind: 'state', arrival: 'ambulance', severity: 'critical', confirm: [GC],
      params: { severity: { mild: 30, moderate: 30, severe: 40 } },
      derived: { acidosis: { has: 'lab.acidosis' }, hypotension: { has: 'vital.bp_low' } },
    });
    expect(db.conditions[MET].redFlags).toEqual(['sign.gcs_coma']);
    expect(db.conditions[MET].differential).toEqual([EG, 'cond.opioid_poisoning', 'cond.stroke_ischemic']);
    // стеклоомыватель с метанолом продают зимой (раздел 1.3)
    const season = db.conditions[MET].season!;
    expect(season.winter).toBeGreaterThan(season.summer);
    // реже угарного газа, этиленгликоль — ещё реже (раздел 1.3): игровая оценка
    expect(db.conditions[MET].weight).toBeLessThan(db.conditions['cond.co_poisoning'].weight);
    expect(db.conditions[EG].weight).toBeLessThan(db.conditions[MET].weight);
  });

  test('о выпитом обычно скажут; лёгкое — пелена и мушки, среднее — слепота, тяжёлое — кома и ацидоз; метанол в крови — у каждого', () => {
    for (const p of ps) {
      const s = param(p, 'severity');
      if (has(p, DRINK)) expect(p.complaints).toContain(DRINK);
      expect(has(p, 'sym.vision_loss')).toBe(s === 'moderate');
      for (const f of ['sym.found_unconscious', 'sign.gcs_coma']) expect(has(p, f)).toBe(s === 'severe');
      if (s === 'severe') expect(has(p, 'lab.acidosis')).toBe(true);
      expect(has(p, 'lab.methanol_blood')).toBe(true);
      expect(has(p, 'lab.eg_blood') || has(p, 'lab.oxalate_crystals') || has(p, ANTIFREEZE)).toBe(false);
    }
    const known = share(ps, p => has(p, DRINK));
    expect(known).toBeGreaterThan(0.6);
    expect(known).toBeLessThan(0.9);
    const mild = ps.filter(p => param(p, 'severity') === 'mild');
    expect(share(mild, p => has(p, 'sym.vision_blurred'))).toBeGreaterThan(0.35);
    // глазное дно при лёгкой форме нормальное (раздел 1.5.1)
    expect(mild.some(p => has(p, 'sign.optic_disc_blurred'))).toBe(false);
    expect(share(ps.filter(p => param(p, 'severity') === 'moderate'), p => has(p, 'sign.optic_disc_blurred'))).toBeGreaterThan(0.6);
  });

  test('тактика: этанол — до перевода каждому, при ацидозе — натрия гидрокарбонат; фолиевая кислота и промывание — можно, уголь — не нужен', () => {
    const t = db.conditions[MET].treatment!;
    expect([t.firstLine, t.acceptable, t.supportive, t.notIndicated, t.harmful, t.beforeTransfer]).toEqual([[], [FOLIC, LAVAGE], [FLUIDS], [COAL], [], [ETOH]]);
    expect(['yes', 'no'].map(a => txRole(db, MET, SODA, { severity: 'severe', acidosis: a }))).toEqual(['beforeTransfer', 'notIndicated']);
    expect(['yes', 'no'].map(h => txRole(db, MET, FLUIDS, { severity: 'severe', hypotension: h }))).toEqual(['beforeTransfer', 'supportive']);
    expect([ETOH, SODA, COAL].map(tx => txGroupOfClass(db.treatments[tx].class))).toEqual(['antidotes', 'fluids', 'digestive']);
    // без гемодиализа антидот долечивает только лёгкое (раздел 3.2)
    expect(['mild', 'moderate', 'severe'].map(s => curesOf(db, { id: MET, params: { severity: s } }, [ETOH]).map(e => e.p))).toEqual([[9500], [], []]);
  });

  test('течение и место: без лечения хуже, тяжёлое — в первые сутки; перевод всем, лёгкое — можно и у себя; домой — нельзя', () => {
    expect(['mild', 'moderate', 'severe'].map(s => selfLimits(db, { id: MET, params: { severity: s } }))).toEqual([false, false, false]);
    expect(untreatedOf(db, { id: MET, params: { severity: 'severe' } })).toMatchObject({ p: 9500, days: [0, 1] });
    for (const p of ps.slice(0, 60)) {
      expect(recommendedSetting(db, p)).toBe('transfer');
      expect(alsoSettings(db, p)).toEqual(param(p, 'severity') === 'mild' ? ['ward', 'icu'] : []);
    }
  });

  test('разбор: антидот и натрия гидрокарбонат с переводом — без замечаний; без антидота — неполное лечение; домой — ошибка', () => {
    const p = patients(MET, 1, 57_700, { severity: 'severe' })[0];
    const obs = checked(p);
    const grade = (x: Plan) => scoreCase({
      verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: evaluatePlan(db, p, x, obs, VENUE),
      outcome: { kind: x.setting === 'home' ? 'worse' : 'transferred', day: 0, cured: false }, selfLimiting: false, redFlags: [],
    });
    const full = [ETOH, ...(obs.some(o => o.f === 'lab.acidosis' && o.shown) ? [SODA] : [])];
    expect(evaluatePlan(db, p, plan(full), obs, VENUE).beforeTransferMissing).toEqual([]);
    expect(grade(plan(full))).toMatchObject({ treatment: 'A', setting: 'A' });
    expect(evaluatePlan(db, p, plan(full.filter(tx => tx !== ETOH)), obs, VENUE).beforeTransferMissing).toEqual([ETOH]);
    expect(grade(plan(full.filter(tx => tx !== ETOH))).treatment).toBe('C');
    expect(grade(plan(full, 'home')).setting).toBe('D');
    // уголь — не нужен
    expect(evaluatePlan(db, p, plan([...full, COAL]), obs, VENUE).roles.find(r => r.tx === COAL)!.role).toBe('notIndicated');
  });
});

describe('отравление этиленгликолем', () => {
  const ps = patients(EG, 300, 57_800);

  test('запись по 873_1: терапия, T52.3, только скорая; подтверждает хроматография; ацидоз и низкий кальций — по анализам', () => {
    expect(db.conditions[EG]).toMatchObject({
      icd10: 'T52.3', department: 'dept.therapy', system: 'poisoning', kind: 'state', arrival: 'ambulance', severity: 'critical', confirm: [GC],
      params: { severity: { mild: 30, moderate: 35, severe: 35 } },
      derived: { acidosis: { has: 'lab.acidosis' }, hypocalcemia: { has: 'lab.ca_low' }, hypotension: { has: 'vital.bp_low' } },
    });
    expect(db.conditions[EG].differential).toEqual([MET, 'cond.pancreatitis', 'cond.opioid_poisoning']);
  });

  test('средняя — сильная боль в животе и пояснице, как острый живот; тяжёлая — кома и ацидоз; оксалаты в моче — не у каждого', () => {
    for (const p of ps) {
      const s = param(p, 'severity');
      if (has(p, ANTIFREEZE)) expect(p.complaints).toContain(ANTIFREEZE);
      for (const f of ['sym.found_unconscious', 'sign.gcs_coma']) expect(has(p, f)).toBe(s === 'severe');
      if (s === 'severe') expect(has(p, 'lab.acidosis')).toBe(true);
      expect(has(p, 'lab.eg_blood')).toBe(true);
      expect(has(p, 'lab.methanol_blood') || has(p, 'sym.vision_loss') || has(p, DRINK)).toBe(false);
    }
    const moderate = ps.filter(p => param(p, 'severity') === 'moderate');
    expect(share(moderate, p => has(p, 'sym.abdominal_pain'))).toBeGreaterThan(0.6);
    expect(share(moderate, p => has(p, 'sym.flank_pain'))).toBeGreaterThan(0.6);
    const oxalates = share(ps, p => has(p, 'lab.oxalate_crystals'));
    expect(oxalates).toBeGreaterThan(0.3);
    expect(oxalates).toBeLessThan(0.7);
  });

  test('тактика: этанол до перевода; пиридоксин, тиамин и промывание — можно; при низком кальции — кальций, при ацидозе — гидрокарбонат', () => {
    const t = db.conditions[EG].treatment!;
    expect([t.firstLine, t.acceptable, t.supportive, t.notIndicated, t.harmful, t.beforeTransfer]).toEqual([[], [B6, B1, LAVAGE], [FLUIDS], [COAL], [], [ETOH]]);
    expect(['yes', 'no'].map(h => txRole(db, EG, CA, { severity: 'severe', hypocalcemia: h }))).toEqual(['beforeTransfer', 'notIndicated']);
    expect(['yes', 'no'].map(a => txRole(db, EG, SODA, { severity: 'mild', acidosis: a }))).toEqual(['beforeTransfer', 'notIndicated']);
    expect(['mild', 'moderate', 'severe'].map(s => curesOf(db, { id: EG, params: { severity: s } }, [ETOH]).map(e => e.p))).toEqual([[9500], [], []]);
    for (const p of ps.slice(0, 60)) expect(recommendedSetting(db, p)).toBe('transfer');
  });
});

describe('обследования', () => {
  test('КОС и хроматография — каждому, кто пил метанол или антифриз; КОС — и при дыхании Куссмауля, хроматография — и при ацидозе', () => {
    expect(db.exams[ABG]).toMatchObject({ kind: 'lab', routineFor: [DRINK, ANTIFREEZE], routineSeen: ['sign.kussmaul'] });
    expect(db.exams[ABG].checks.map(c => [c.f, c.sens, c.spec])).toEqual([['lab.acidosis', 9700, 9800]]);
    expect(db.exams[GC]).toMatchObject({ kind: 'lab', routineFor: [DRINK, ANTIFREEZE], routineSeen: ['lab.acidosis'] });
    expect(db.exams[GC].checks.map(c => c.f)).toEqual(['lab.methanol_blood', 'lab.eg_blood']);
    expect([ABG, GC].map(e => examMinutes(db.exams[e]))).toEqual([25, 65]);
    // ЭКГ и глюкоза в первый час — всем (разделы 2.3 и 2.4); глазное дно при метаноле, кальций и моча при антифризе
    for (const e of ['exam.ecg', 'exam.glucometer']) expect(db.exams[e].routineFor).toEqual(expect.arrayContaining([DRINK, ANTIFREEZE]));
    expect(db.exams['exam.fundoscopy'].routineFor).toEqual(expect.arrayContaining(['sym.vision_loss', DRINK]));
    expect(db.exams['exam.calcium'].routineFor).toContain(ANTIFREEZE);
    expect(db.exams['exam.urinalysis'].routineFor).toEqual([ANTIFREEZE]);
    expect(db.exams['exam.urinalysis'].checks.map(c => c.f)).toContain('lab.oxalate_crystals');
    expect(db.exams['exam.vitals'].checks.map(c => c.f)).toContain('sign.kussmaul');
    expect(db.exams['exam.fundoscopy'].checks.map(c => c.f)).toContain('sign.optic_disc_blurred');
    for (const id of ['exam.ask_lifestyle', 'exam.ask_witnesses']) expect(db.exams[id].checks.map(c => c.f)).toEqual(expect.arrayContaining([DRINK, ANTIFREEZE]));
    expect(db.exams['exam.ask_complaints'].checks.map(c => c.f)).toContain('sym.vision_loss');
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
    if (r.step.kind === 'decide') return { ...r.step, done, obs, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}
const saw = (x: { obs: Observation[] }, f: Id) => x.obs.some(o => o.f === f && o.shown);

describe('разумный врач', () => {
  const met = patients(MET, 60, 57_500).map(p => ({ p, r: doctor(p) }));
  const eg = patients(EG, 60, 57_500).map(p => ({ p, r: doctor(p) }));

  test('метанол — верно почти у каждого, этиленгликоль — у большинства; о выпитом знали — верно почти у каждого, после хроматографии', () => {
    expect(share(met, x => x.r.diagnosis === MET)).toBeGreaterThan(0.9);
    // без рассказа о выпитом этиленгликоль принимают за панкреатит, почечную колику, кишечную инфекцию — как в жизни (раздел 1.6.2)
    expect(share(eg, x => x.r.diagnosis === EG)).toBeGreaterThan(0.8);
    for (const [xs, cond, story] of [[met, MET, DRINK], [eg, EG, ANTIFREEZE]] as const) {
      const known = xs.filter(x => x.p.complaints.includes(story));
      expect(known.length).toBeGreaterThan(30);
      expect(share(known, x => x.r.diagnosis === cond && x.r.done.includes(GC) && x.r.done.includes(ABG))).toBeGreaterThan(0.95);
    }
  });

  test('с верным диагнозом — этанол каждому, гидрокарбонат — при ацидозе, кальций — при низком кальции; перевод, лёгкое — и у себя', () => {
    for (const [xs, cond] of [[met, MET], [eg, EG]] as const) {
      const right = xs.filter(x => x.r.diagnosis === cond);
      expect(right.every(x => x.r.plan.treatments.includes(ETOH))).toBe(true);
      expect(right.filter(x => saw(x.r, 'lab.acidosis')).every(x => x.r.plan.treatments.includes(SODA))).toBe(true);
      expect(right.filter(x => saw(x.r, 'lab.ca_low')).every(x => x.r.plan.treatments.includes(CA))).toBe(true);
      expect(right.every(x => x.r.plan.setting === 'ambulance' || (param(x.p, 'severity') === 'mild' && ['admit', 'icu'].includes(x.r.plan.setting)))).toBe(true);
    }
  });
});

describe('энциклопедия', () => {
  test('тактика строками; новые записи — статьями', () => {
    const rows = (id: Id) => Object.fromEntries(article(db, id)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows(MET)).toMatchObject({
      'Можно также': [FOLIC, LAVAGE],
      'Облегчить состояние': [FLUIDS],
      'Не нужно': [COAL],
      'Обязательно до перевода': [ETOH],
      'Обязательно до перевода, при ацидозе': [SODA],
      'Обязательно до перевода, при низком давлении — одно из': ['tx.balanced_fluids', FLUIDS],
    });
    expect(rows(EG)).toMatchObject({ 'Обязательно до перевода, при низком кальции — одно из': [CA, 'tx.calcium_chloride_iv'] });
    for (const id of [MET, EG, ABG, GC, ETOH, SODA, FOLIC, B6, COAL, DRINK, ANTIFREEZE, 'sym.vision_loss', 'sign.kussmaul', 'sign.optic_disc_blurred', 'lab.acidosis', 'lab.methanol_blood', 'lab.eg_blood', 'lab.oxalate_crystals']) {
      expect(article(db, id)).toBeDefined();
    }
  });
});
