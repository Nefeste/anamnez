// Синдром раздражённого кишечника и функциональный запор (spec 2026-10-chapter-4, часть 55б; 892_1, 274_3): болезни поликлиники.
// СРК — по Римским критериям IV, без симптомов тревоги; ОАК, СРБ, пальцевое исследование и колоноскопия — каждому взрослому,
// у кого боль связана со стулом; спазмолитик — каждому, по варианту — средство от диареи или слабительное. Запор — стул реже
// трёх раз в неделю, твёрдый, месяцами; ОАК, пальпация и пальцевое — каждому; колоноскопия — старше 50 лет и при симптомах
// тревоги; образ жизни — каждому, псиллиум, макрогол или лактулоза — первая линия.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { evaluatePlan, recommendedSetting, tacticsFor, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import { checkRule, knownOf, ruleExams } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const IBS = 'cond.ibs';
const FC = 'cond.constipation';
const PATTERN = 'sym.pain_with_stool';
const LONG = 'sym.constipation_long';
const BLOOD = 'sym.stool_blood';
const FAMILY = 'hx.family_crc';
const COLONO = 'exam.colonoscopy';
const RULE = 'rule.colonoscopy_constipation';
const SPASM = 'tx.mebeverine';
const PROBIOTIC = 'tx.probiotic';
const LAXATIVES = ['tx.psyllium', 'tx.macrogol', 'tx.lactulose'];
const THERAPY = ['dept.therapy'];

const patients = (cond: Id, n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: THERAPY, season: 'autumn', primary: cond, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
// от самой болезни, а не фоном: понос бывает и у больного СРК с запором — от других причин
const own = (p: Patient, f: string, cond: Id) => p.truth.findings.some(x => x.f === f && x.cause === cond);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const variant = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params.variant;
const seen = (f: Id, shown = true, exam = 'exam.ask_abdomen'): Observation => ({ f, shown, exam });

describe('синдром раздражённого кишечника', () => {
  const ps = patients(IBS, 300, 55_300);

  test('запись по 892_1: терапия, K58, три варианта; подтверждает колоноскопия, колита на ней нет', () => {
    expect(db.conditions[IBS]).toMatchObject({ icd10: 'K58', department: 'dept.therapy', severity: 'minor', confirm: [COLONO], masks: ['img.colon_uc'], params: { variant: { diarrhea: 35, constipation: 35, mixed: 30 } } });
    expect(db.conditions[IBS].differential).toEqual([FC, 'cond.cdiff', 'cond.diverticulitis']);
  });

  test('Римские критерии IV: боль в животе, связанная со стулом, — у каждого; понос и запор — по варианту; с болью и приходят', () => {
    for (const p of ps) {
      expect(has(p, 'sym.abdominal_pain') && has(p, PATTERN)).toBe(true);
      expect(p.complaints).toContain('sym.abdominal_pain');
      const v = variant(p);
      expect(own(p, 'sym.diarrhea', IBS)).toBe(v !== 'constipation');
      expect(own(p, 'sym.constipation', IBS) && own(p, LONG, IBS)).toBe(v !== 'diarrhea');
    }
    // вздутие — часто; женщин — вдвое больше
    const bloating = share(ps, p => has(p, 'sym.bloating'));
    expect(bloating).toBeGreaterThan(0.35);
    expect(bloating).toBeLessThan(0.65);
    expect(share(ps, p => p.sex === 'f')).toBeGreaterThan(0.55);
  });

  test('связь боли со стулом спрашивают в расспросе о животе; увидели — ОАК, СРБ, пальцевое, колоноскопия, при поносе — тест на C. difficile', () => {
    expect(db.exams['exam.ask_abdomen'].checks.map(c => c.f)).toEqual(expect.arrayContaining([PATTERN, BLOOD]));
    for (const e of ['exam.cbc', 'exam.crp', 'exam.rectal_exam', COLONO, 'exam.cdiff_stool']) expect(db.exams[e].routineSeen).toContain(PATTERN);
    // колоноскопия — и при запоре месяцами: правило решает, нужна ли
    expect(db.exams[COLONO].complaints).toContain(LONG);
    // фона у признака нет: такая боль в игре — только СРК
    expect(db.findings[PATTERN].leak).toBe(0);
  });

  test('тактика по 892_1: спазмолитик — каждому; пробиотик — при любом варианте; при диарее — лоперамид, рифаксимин или пробиотик; при запоре — слабительное', () => {
    const t = db.conditions[IBS].treatment!;
    expect(t.require).toEqual([[SPASM, 'tx.drotaverine']]);
    expect(t.firstLine).toEqual([PROBIOTIC]);
    expect(tacticsFor(t, { variant: 'diarrhea' }).require).toEqual([[SPASM, 'tx.drotaverine'], ['tx.loperamide', 'tx.rifaximin', PROBIOTIC]]);
    expect(tacticsFor(t, { variant: 'constipation' }).require).toEqual([[SPASM, 'tx.drotaverine'], LAXATIVES]);
    expect(tacticsFor(t, { variant: 'mixed' }).require).toEqual([[SPASM, 'tx.drotaverine']]);
    expect(txRole(db, IBS, 'tx.loperamide', { variant: 'constipation' })).toBe('notIndicated');
    expect(txRole(db, IBS, 'tx.macrogol', { variant: 'diarrhea' })).toBe('notIndicated');
    expect(txRole(db, IBS, 'tx.loperamide', { variant: 'diarrhea' })).toBe('require');
    const d = ps.find(p => variant(p) === 'diarrhea')!;
    const home: Venue = {};
    // из группы недостаёт — первого: мебеверина, лоперамида
    expect(evaluatePlan(db, d, { treatments: ['tx.loperamide'], setting: 'home' }, complaintObservations(d), home).requireMissing).toEqual([SPASM]);
    expect(evaluatePlan(db, d, { treatments: [SPASM], setting: 'home' }, complaintObservations(d), home).requireMissing).toEqual(['tx.loperamide']);
    expect(evaluatePlan(db, d, { treatments: ['tx.drotaverine', PROBIOTIC], setting: 'home' }, complaintObservations(d), home).requireMissing).toEqual([]);
    expect(evaluatePlan(db, d, { treatments: [SPASM, 'tx.loperamide'], setting: 'home' }, complaintObservations(d), home).requireMissing).toEqual([]);
  });

  test('место — дома', () => {
    for (const p of ps.slice(0, 20)) expect(recommendedSetting(db, p)).toBe('home');
  });
});

describe('функциональный запор', () => {
  const ps = patients(FC, 300, 55_700);

  test('запись по 274_3: терапия, K59.0, без органических изменений; с СРК и гипотиреозом путают', () => {
    expect(db.conditions[FC]).toMatchObject({ icd10: 'K59.0', department: 'dept.therapy', severity: 'minor', confirm: 'clinical', masks: ['img.colon_uc'] });
    expect(db.conditions[FC].differential).toEqual([IBS, 'cond.hypothyroidism']);
  });

  test('запоры месяцами — у каждого, с ними и приходят; связи боли со стулом нет; старше 50 — немало', () => {
    for (const p of ps) {
      expect(has(p, LONG) && has(p, 'sym.constipation')).toBe(true);
      expect(p.complaints).toContain(LONG);
      expect(has(p, PATTERN)).toBe(false);
    }
    const pain = share(ps, p => has(p, 'sym.abdominal_pain'));
    expect(pain).toBeGreaterThan(0.15);
    expect(pain).toBeLessThan(0.4);
    expect(share(ps, p => p.age > 50)).toBeGreaterThan(0.35);
  });

  test('ОАК, пальпация живота и пальцевое исследование — каждому с запором месяцами; о раке кишки у родных спрашивают', () => {
    for (const e of ['exam.cbc', 'exam.abdomen_palpation', 'exam.rectal_exam']) expect(db.exams[e].routineFor).toContain(LONG);
    expect(db.exams['exam.ask_family'].checks.map(c => c.f)).toContain(FAMILY);
    expect(db.exams['exam.ask_general'].checks.map(c => c.f)).toContain(LONG);
  });

  test('«Нужна ли колоноскопия при запоре»: старше 50 — нужна; моложе — при крови в кале, похудании, анемии или раке кишки у родных', () => {
    const rule = db.rules[RULE];
    expect(rule).toMatchObject({ complaints: [LONG], any: [BLOOD, 'sym.weight_loss', 'lab.hb_low', FAMILY], age: { main: 50 }, exams: [COLONO], about: [FC, IBS] });
    const none = knownOf(rule.any.map(f => seen(f, false)));
    expect(checkRule(rule, 51, knownOf([])).verdict).toBe('yes');
    expect(checkRule(rule, 50, none).verdict).toBe('no');
    expect(checkRule(rule, 40, knownOf([]))).toMatchObject({ verdict: 'unknown', left: rule.any });
    for (const f of rule.any) expect(checkRule(rule, 40, knownOf([seen(f)])).verdict).toBe('yes');
    const young = ps.find(p => p.age <= 50 && !rule.any.some(f => has(p, f)))!;
    expect(ruleExams(db, young, rule.any.map(f => seen(f, false)))).not.toContain(COLONO);
    const old = ps.find(p => p.age > 50)!;
    expect(ruleExams(db, old, complaintObservations(old))).toContain(COLONO);
  });

  test('кровь в кале — у каждого, у кого стул с кровью от болезней базы; в выводе не участвует', () => {
    expect(db.findings[BLOOD]).toMatchObject({ follows: ['sym.mucus_blood_stool', 'sym.bloody_diarrhea', 'sym.melena'], evidence: false });
    const uc = typicalPatient(db, k => 55_900 * 31 + k, { department: 'dept.therapy', departments: THERAPY, season: 'autumn', primary: 'cond.uc_attack' });
    expect(has(uc, BLOOD)).toBe(true);
  });

  test('тактика по 274_3: образ жизни — каждому; псиллиум, макрогол, лактулоза — первая линия; пробиотик — можно; лоперамид — не нужен; дома', () => {
    const t = db.conditions[FC].treatment!;
    expect(t.require).toEqual(['tx.lifestyle']);
    expect(t.firstLine).toEqual(LAXATIVES);
    expect(t.acceptable).toEqual([PROBIOTIC]);
    expect(t.notIndicated).toEqual(['tx.loperamide']);
    const p = ps[0];
    expect(evaluatePlan(db, p, { treatments: ['tx.macrogol'], setting: 'home' }, complaintObservations(p), {}).requireMissing).toEqual(['tx.lifestyle']);
    for (const x of ps.slice(0, 20)) expect(recommendedSetting(db, x)).toBe('home');
  });
});

/** Разумный врач по шагам — в поликлинике с эндоскопическим кабинетом или без него. */
function doctor(p: Patient, exams: readonly Id[], venue: Venue) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, THERAPY);
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams: [...exams], threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, obs };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  const all = Object.keys(db.exams).sort();
  const venue: Venue = { rooms: ['room.endoscopy'] };

  test('СРК: верно почти всегда; спазмолитик каждому, при диарее — лоперамид, при запоре — слабительное; увидел связь боли со стулом — колоноскопия', () => {
    const ps = patients(IBS, 60, 5600);
    const rs = ps.map(p => ({ p, r: doctor(p, all, venue) }));
    expect(share(rs, x => x.r.diagnosis === IBS)).toBeGreaterThan(0.8);
    const right = rs.filter(x => x.r.diagnosis === IBS);
    for (const x of right) expect(x.r.plan.treatments).toContain(SPASM);
    for (const x of right.filter(y => variant(y.p) === 'diarrhea')) expect(x.r.plan.treatments).toContain('tx.loperamide');
    for (const x of right.filter(y => variant(y.p) === 'constipation')) expect(x.r.plan.treatments.some(tx => LAXATIVES.includes(tx))).toBe(true);
    for (const x of right) expect(x.r.plan.setting).toBe('home');
    const asked = right.filter(x => x.r.done.includes('exam.ask_abdomen'));
    expect(share(asked, x => x.r.done.includes(COLONO) && x.r.done.includes('exam.cbc') && x.r.done.includes('exam.crp'))).toBeGreaterThan(0.9);
  });

  test('запор: верно почти всегда; старше 50 — колоноскопия; моложе без симптомов тревоги — без неё; образ жизни и псиллиум', () => {
    const ps = patients(FC, 60, 5700);
    const rs = ps.map(p => ({ p, r: doctor(p, all, venue) }));
    expect(share(rs, x => x.r.diagnosis === FC)).toBeGreaterThan(0.9);
    const right = rs.filter(x => x.r.diagnosis === FC);
    expect(share(right.filter(x => x.p.age > 50), x => x.r.done.includes(COLONO))).toBeGreaterThan(0.9);
    // моложе 50: правило по тому, что врач увидел, — «не нужна», и колоноскопии нет
    const young = right.filter(x => x.p.age <= 50);
    const no = young.filter(x => checkRule(db.rules[RULE], x.p, knownOf(x.r.obs)).verdict === 'no');
    expect(no.length).toBeGreaterThan(young.length / 2);
    expect(no.some(x => x.r.done.includes(COLONO))).toBe(false);
    for (const x of right) {
      expect(x.r.plan.treatments).toEqual(expect.arrayContaining(['tx.lifestyle', 'tx.psyllium']));
      expect(x.r.done).toEqual(expect.arrayContaining(['exam.cbc', 'exam.rectal_exam']));
    }
  });
});

describe('энциклопедия', () => {
  const rows = (id: Id) => Object.fromEntries(article(db, id)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));

  test('СРК: спазмолитик — обязательно одно из; по варианту — своё; запор: образ жизни обязательно, слабительные — первая линия', () => {
    expect(rows(IBS)).toMatchObject({
      'Первая линия': [PROBIOTIC], 'Обязательно — одно из': [SPASM, 'tx.drotaverine'],
      'Обязательно, при СРК с диареей — одно из': ['tx.loperamide', 'tx.rifaximin', PROBIOTIC], 'Обязательно, при СРК с запором — одно из': LAXATIVES,
    });
    expect(rows(FC)).toMatchObject({ 'Первая линия': LAXATIVES, 'Обязательно': ['tx.lifestyle'], 'Не нужно': ['tx.loperamide'] });
    for (const id of [IBS, FC, RULE, PATTERN, LONG, BLOOD, FAMILY, SPASM, PROBIOTIC, ...LAXATIVES]) expect(article(db, id)).toBeDefined();
  });
});
