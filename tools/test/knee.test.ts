// Травма колена (spec 2026-09-chapter-2, часть 32д-1): ушиб, повреждение связок — передней
// крестообразной или внутренней боковой — и перелом надколенника со смещением или без; оттавские
// правила для колена с возрастом «55 лет и старше»; положительное правило решения велит
// обследование — разумный врач его делает, страховая оплачивает; снимок колена в карте; энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { likelyParams } from '../../src/engine/med/infer';
import { alsoSettings, curesOf, primaryOf, recommendedSetting, selfLimits, tacticsFor, txRole } from '../../src/engine/med/plan';
import { complaintObservations } from '../../src/engine/med/exams';
import { choosePlan, indicated, MIN_GAIN, nextStep, runDoctor, tacticParams } from '../../src/engine/med/policy';
import { checkRule, knownOf, ruleExams, rulesFor } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const BRUISE = 'cond.knee_contusion';
const LIG = 'cond.knee_ligament';
const PATELLA = 'cond.patella_fracture';
const KNEE = [BRUISE, LIG, PATELLA];
const RULE = 'rule.ottawa_knee';
const XR = 'exam.xray_knee';
const EXAM = 'exam.knee_exam';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const people = (primary: Id, n: number, from = 1, params?: Record<string, string>) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'summer', primary, ...(params ? { params } : {}) }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const ob = (exam: Id, f: Id, shown: boolean): Observation => ({ f, shown, exam });
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();
const doctor = (p: Patient) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 });

describe('кто болеет и что находят', () => {
  test('травма колена — приёмное, «кости и суставы»; подтверждают тесты, осмотр и снимок', () => {
    for (const id of KNEE) {
      expect(db.conditions[id]).toMatchObject({ department: 'dept.trauma', system: 'bones', kind: 'injury' });
      expect(candidates).toContain(id);
      expect(candidatesOf(db, 'dept.therapy')).not.toContain(id);
    }
    expect(db.conditions[BRUISE].confirm).toEqual([EXAM]);
    expect(db.conditions[LIG].confirm).toEqual(['exam.knee_ligament_tests']);
    expect(db.conditions[PATELLA].confirm).toEqual([XR]);
    expect(selfLimits(db, primaryOf(people(BRUISE, 1)[0]))).toBe(true);
    expect(selfLimits(db, primaryOf(people(LIG, 1)[0]))).toBe(false);
  });

  test('связки: передней крестообразной — 70 %, у неё тест Лахмана, у внутренней боковой — вальгус-тест', () => {
    const ps = people(LIG, 2000);
    const acl = ps.filter(p => primaryOf(p).params.ligament === 'acl');
    near(acl.length / ps.length, 0.7, 0.03);
    const mcl = ps.filter(p => primaryOf(p).params.ligament === 'mcl');
    expect(mcl.some(p => has(p, 'sign.lachman_positive'))).toBe(false);
    expect(acl.some(p => has(p, 'sign.valgus_laxity'))).toBe(false);
    expect(share(acl, p => has(p, 'sign.lachman_positive'))).toBeGreaterThan(0.93);
    expect(share(mcl, p => has(p, 'sign.valgus_laxity'))).toBeGreaterThan(0.93);
    // механизм (691_2, раздел 1.2): крестообразная — поворот при стоящей стопе, боковая — удар
    expect(share(acl, p => has(p, 'hx.knee_twist'))).toBeGreaterThan(share(acl, p => has(p, 'hx.knee_blow')) + 0.3);
    expect(share(mcl, p => has(p, 'hx.knee_blow'))).toBeGreaterThan(share(mcl, p => has(p, 'hx.knee_twist')) + 0.3);
    // выпот на снимке в игре — только при переломе: связку ставят не по снимку
    for (const id of [BRUISE, LIG]) expect(people(id, 300, 5000).some(p => has(p, 'img.xr_knee_effusion') || has(p, 'img.xr_patella_fracture'))).toBe(false);
  });

  test('надколенник: мужчин — 61,9 %, половина — без смещения (970_1); болезнен у всех, разгибание теряют при смещении', () => {
    const who = { age: 50, season: 'summer' as const, risks: [], chronic: [] };
    const w = (sex: 'm' | 'f') => presentingWeight(db.conditions[PATELLA], { ...who, sex });
    near(w('m') / (w('m') + w('f')), 0.619, 0.005);
    const ps = people(PATELLA, 2000);
    const shifted = ps.filter(p => primaryOf(p).params.displacement === 'displaced');
    near(shifted.length / ps.length, 0.5, 0.03);
    expect(ps.every(p => has(p, 'img.xr_patella_fracture'))).toBe(true);
    expect(shifted.every(p => has(p, 'img.xr_patella_displaced'))).toBe(true);
    expect(ps.filter(p => primaryOf(p).params.displacement === 'none').some(p => has(p, 'img.xr_patella_displaced') || has(p, 'sign.patella_gap'))).toBe(false);
    expect(share(ps, p => has(p, 'sign.patella_tenderness'))).toBeGreaterThan(0.93);
    const lost = (xs: Patient[]) => share(xs, p => has(p, 'sign.no_active_extension'));
    expect(lost(shifted)).toBeGreaterThan(0.7);
    expect(lost(ps.filter(p => primaryOf(p).params.displacement === 'none'))).toBeLessThan(0.15);
  });

  test('сторона — в жалобе и на снимке одна и та же', () => {
    for (const p of people(PATELLA, 40, 300)) {
      const side = primaryOf(p).params.side;
      expect(p.truth.findings.find(f => f.f === 'sym.knee_pain')!.attrs?.side).toBe(side);
      expect(p.truth.findings.find(f => f.f === 'img.xr_patella_fracture')!.attrs?.side).toBe(side);
    }
  });
});

describe('тактика', () => {
  test('ушиб — покой и холод; связки — ортез, лонгета можно, костыли и НПВП в помощь', () => {
    expect(txRole(db, BRUISE, 'tx.rice')).toBe('firstLine');
    expect(txRole(db, BRUISE, 'tx.knee_brace')).toBe('acceptable');
    expect(txRole(db, BRUISE, 'tx.cast_splint')).toBe('notIndicated');
    const lig = (tx: Id) => txRole(db, LIG, tx, { ligament: 'acl', side: 'left' });
    expect(lig('tx.knee_brace')).toBe('firstLine');
    expect(lig('tx.cast_splint')).toBe('acceptable');
    for (const tx of ['tx.crutches', 'tx.rice', 'tx.ibuprofen', 'tx.paracetamol']) expect(lig(tx)).toBe('supportive');
    expect(lig('tx.steroid_systemic_short')).toBe('notIndicated');
  });

  test('надколенник: без смещения — лонгета в разгибании (ортез и операция — можно), со смещением — остеосинтез', () => {
    const role = (tx: Id, displacement: string) => txRole(db, PATELLA, tx, { displacement, side: 'right' });
    expect(role('tx.cast_splint', 'none')).toBe('firstLine');
    expect(role('tx.knee_brace', 'none')).toBe('acceptable');
    expect(role('tx.patella_orif', 'none')).toBe('acceptable');
    expect(role('tx.crutches', 'none')).toBe('supportive');
    expect(role('tx.patella_orif', 'displaced')).toBe('firstLine');
    expect(role('tx.cast_splint', 'displaced')).toBe('supportive');
    expect(role('tx.knee_brace', 'displaced')).toBe('supportive');
    expect(tacticParams(db, PATELLA)).toEqual(['displacement']);
    expect(tacticsFor(db.conditions[PATELLA].treatment!, { displacement: 'none' }).plan).toEqual(['tx.cast_splint', 'tx.crutches', 'tx.ibuprofen']);
  });

  test('что лечит причину: ортез и лонгета — связки и надколенник без смещения, остеосинтез — любой перелом, покой и холод — ушиб', () => {
    const cures = (id: Id, params: Record<string, string>, tx: Id) => curesOf(db, { id, params }, [tx]).length > 0;
    for (const tx of ['tx.knee_brace', 'tx.cast_splint']) {
      expect(cures(LIG, { ligament: 'mcl', side: 'left' }, tx)).toBe(true);
      expect([cures(PATELLA, { displacement: 'none', side: 'left' }, tx), cures(PATELLA, { displacement: 'displaced', side: 'left' }, tx)]).toEqual([true, false]);
    }
    expect([cures(PATELLA, { displacement: 'none', side: 'left' }, 'tx.patella_orif'), cures(PATELLA, { displacement: 'displaced', side: 'left' }, 'tx.patella_orif')]).toEqual([true, true]);
    expect(cures(BRUISE, { side: 'left' }, 'tx.rice')).toBe(true);
    expect(cures(LIG, { ligament: 'acl', side: 'left' }, 'tx.rice')).toBe(false);
    expect(cures(LIG, { ligament: 'acl', side: 'left' }, 'tx.crutches')).toBe(false);
  });

  test('где лечить: ушиб и связки — дома; надколенник без смещения — дома или в палате, со смещением — операция', () => {
    const one = (id: Id, params?: Record<string, string>) => people(id, 1, 40, params)[0];
    expect(recommendedSetting(db, one(BRUISE))).toBe('home');
    expect(recommendedSetting(db, one(LIG))).toBe('home');
    const none = one(PATELLA, { displacement: 'none' });
    expect(recommendedSetting(db, none)).toBe('home');
    expect(alsoSettings(db, none)).toEqual(['ward']);
    expect(recommendedSetting(db, one(PATELLA, { displacement: 'displaced' }))).toBe('surgery');
    expect(db.conditions[PATELLA].surgery).toEqual({ tx: 'tx.patella_orif', stay: [3, 5] });
  });

  test('по снимку: отломки разошлись — операция в своей операционной или скорая; на месте — лонгета дома', () => {
    const fx = [ob(XR, 'img.xr_patella_fracture', true), ob(XR, 'img.xr_patella_displaced', true)];
    expect(likelyParams(db, PATELLA, fx, 50).displacement).toBe('displaced');
    expect(choosePlan(db, PATELLA, fx, 50, { ward: true, or: true }).setting).toBe('surgery');
    expect(choosePlan(db, PATELLA, fx, 50).setting).toBe('ambulance');
    const still = [ob(XR, 'img.xr_patella_fracture', true), ob(XR, 'img.xr_patella_displaced', false)];
    expect(choosePlan(db, PATELLA, still, 50)).toEqual({ treatments: ['tx.cast_splint', 'tx.crutches', 'tx.ibuprofen'], setting: 'home' });
  });
});

describe('оттавские правила для колена', () => {
  const rule = db.rules[RULE];
  const known = (obs: Observation[]) => knownOf(obs);
  const quiet = [ob(EXAM, 'sign.patella_tenderness', false), ob(EXAM, 'sign.fibular_head_tenderness', false), ob(EXAM, 'sign.knee_flexion_limited', false), ob(EXAM, 'sign.no_weight_bearing', false)];

  test('запись: жалоба на колено, четыре признака и возраст «55 и старше», снимок колена, с 18 лет; источники', () => {
    expect(rule).toMatchObject({ complaints: ['sym.knee_pain'], age: { from: 55 }, exams: [XR], ageMin: 18, about: KNEE });
    expect(rule.any).toEqual(['sign.patella_tenderness', 'sign.fibular_head_tenderness', 'sign.knee_flexion_limited', 'sign.no_weight_bearing']);
    expect(rule.sources.map(s => s.url)).toEqual(expect.arrayContaining(['https://cr.minzdrav.gov.ru/view-cr/832_2', 'https://pubmed.ncbi.nlm.nih.gov/7574120/', 'https://pubmed.ncbi.nlm.nih.gov/8594242/']));
  });

  test('возраст: с 55 лет — «да» и без осмотра; в 54 без признаков — «нет»', () => {
    expect(checkRule(rule, 55, known([])).verdict).toBe('yes');
    expect(checkRule(rule, 55, known([])).ageMain).toBe(true);
    expect(checkRule(rule, 54, known([])).verdict).toBe('unknown');
    expect(checkRule(rule, 54, known(quiet)).verdict).toBe('no');
    expect(checkRule(rule, 30, known([ob(EXAM, 'sign.knee_flexion_limited', true)])).verdict).toBe('yes');
    // «старше 60» у правила КТ — по-прежнему строго больше
    expect(checkRule(db.rules['rule.ct_head'], 60, known([ob('exam.ask_head_injury', 'sym.loss_of_consciousness', true)])).ageMain).toBe(false);
  });

  test('«Студенту» в карте: с 55 лет — «Снимок нужен: возраст 55 лет и старше»; без признаков — снимок можно не делать', () => {
    const view = (p: Patient, obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: obs.length ? [{ exam: EXAM, step: 1, at: 600, obs }] : [], pending: [], meanwhile: [], done: obs.length ? [EXAM] : [],
      draft: { treatments: [], setting: 'home' }, departments: ED,
    }).rules;
    const old = people(BRUISE, 200, 700).find(p => p.age >= 55)!;
    expect(view(old, [])).toEqual([{ id: RULE, name: rule.name.ru, text: 'Снимок нужен: возраст 55 лет и старше' }]);
    const young = people(BRUISE, 200, 700).find(p => p.age < 55)!;
    expect(view(young, [])[0].text).toContain('Проверьте: болезненность надколенника');
    expect(view(young, quiet)[0].text).toBe(rule.texts.no.ru);
    expect(rulesFor(db, young).map(r => r.id)).toEqual([RULE]);
  });
});

describe('положительное правило велит обследование', () => {
  test('разумный врач делает снимок каждому, у кого правило положительно, — и при голеностопе, и при стопе', () => {
    const cases = [...KNEE.flatMap(id => people(id, 60, 900)), ...['cond.ankle_sprain', 'cond.foot_contusion'].flatMap(id => people(id, 60, 900))];
    let positive = 0;
    for (const p of cases) {
      const r = doctor(p);
      const told = ruleExams(db, p, r.observations);
      positive += told.length > 0 ? 1 : 0;
      for (const e of told) expect(r.exams).toContain(e);
    }
    expect(positive).toBeGreaterThan(100);
  });

  test('отрицательное правило снимок не запрещает: у колена снимают редко; голеностоп с деформацией — всегда', () => {
    const runs = [BRUISE, LIG].flatMap(id => people(id, 200, 1500)).filter(p => p.age < 55).map(p => ({ p, r: doctor(p) }));
    const quiet = runs.filter(({ p, r }) => checkRule(db.rules[RULE], p.age, knownOf(r.observations)).verdict === 'no');
    expect(quiet.length).toBeGreaterThan(40);
    expect(ruleExams(db, quiet[0].p, quiet[0].r.observations)).toEqual([]);
    expect(share(quiet, ({ r }) => r.exams.includes(XR))).toBeLessThan(0.25);
    // деформация — абсолютный признак перелома, снимок при ней нужен всегда (832_2, раздел 2.4):
    // оттавские правила её не называют, но разумный врач снимает — от снимка зависит всё
    const ANKLE = 'cond.ankle_fracture';
    const A = 'exam.ankle_exam';
    const p = people(ANKLE, 1, 50, { stability: 'unstable' })[0];
    const obs = [...complaintObservations(p), ob(A, 'sign.malleolus_tenderness', false), ob(A, 'sign.no_weight_bearing', false), ob(A, 'sign.ankle_deformity', true)];
    expect(checkRule(db.rules['rule.ottawa_ankle'], p.age, knownOf(obs)).verdict).toBe('no');
    // давление уже измерила медсестра на сортировке: с 0.3.19 его меряют и при головной боли (62_3, раздел 2.1)
    const step = nextStep(db, p, obs, ['exam.vitals', 'exam.ask_chronic', 'exam.ask_injury', A], {}, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN }).step;
    expect(step).toEqual({ kind: 'exam', exam: 'exam.xray_ankle' });
  });

  test('страховая: снимок по положительному правилу показан, даже когда почти ясно, что это ушиб', () => {
    const p = people(BRUISE, 300, 2000).find(x => x.age >= 55)!;
    const obs = [ob(EXAM, 'sign.patella_tenderness', false), ob(EXAM, 'sign.knee_swelling', true), ob('exam.ask_injury', 'hx.knee_blow', true)];
    expect(ruleExams(db, p, obs)).toEqual([XR]);
    expect(indicated(db, p, obs, candidates, XR)).toBe(true);
  });

  test('на пациентах с коленом «виртуальный врач» чаще прав, чем нет: связки — по тестам, перелом — по снимку', () => {
    for (const [id, want] of [[BRUISE, 0.82], [LIG, 0.85], [PATELLA, 0.88]] as const) {
      const ps = people(id, 150, 3000);
      expect(share(ps, p => doctor(p).correct)).toBeGreaterThan(want);
    }
  });
});

describe('снимок колена в карте и энциклопедия', () => {
  const image = (patient: Patient, obs: Observation[]) => makeCaseView({
    version: 0, patient, clock: 600, minutesSpent: 0, money: 0, step: 1,
    arrived: [{ exam: XR, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [XR],
    draft: { treatments: [], setting: 'home' }, departments: ED,
  }).groups.find(g => g.exam === XR)!.image;

  test('вид «колено», сторона из жалобы; поперечная линия, отломки разошлись, выпот', () => {
    const p = people(PATELLA, 1, 11, { displacement: 'displaced', side: 'left' })[0];
    expect(image(p, [ob(XR, 'img.xr_patella_fracture', true), ob(XR, 'img.xr_patella_displaced', false), ob(XR, 'img.xr_knee_effusion', false)])).toMatchObject({ kind: 'bone', view: 'knee', side: 'left', fractures: [{ site: 'patella', displacement: 0 }] });
    const full = image(p, [ob(XR, 'img.xr_patella_fracture', true), ob(XR, 'img.xr_patella_displaced', true), ob(XR, 'img.xr_knee_effusion', true)]);
    expect(full).toMatchObject({ fractures: [{ site: 'patella', displacement: 0.9 }], effusion: true });
    expect(image(p, [ob(XR, 'img.xr_patella_fracture', false)])).toMatchObject({ kind: 'bone', fractures: [] });
    expect(image(p, [ob(XR, 'img.xr_patella_fracture', false)])).not.toHaveProperty('effusion');
  });

  test('статьи: где лечить надколенник, связки словами, правило с возрастом и снимком', () => {
    const where = article(db, PATELLA)!.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toContain('При смещении — операция.');
    expect(where).toContain('Операция — остеосинтез надколенника.');
    expect(JSON.stringify(article(db, LIG)!.blocks)).toContain('при повреждении передней крестообразной связки');
    const r = article(db, RULE)!;
    expect(r).toMatchObject({ section: 'scores', title: 'Оттавские правила для колена' });
    expect(r.blocks.find(b => b.key === 'any')!.text).toContain('Возраст 55 лет и старше — тоже основной признак.');
    expect(JSON.stringify(r.blocks.find(b => b.key === 'exams'))).toContain(XR);
    expect(JSON.stringify(article(db, 'sign.patella_tenderness')!.blocks.find(b => b.key === 'inRules'))).toContain(RULE);
    expect(JSON.stringify(article(db, 'tx.patella_orif')!.blocks)).toContain(PATELLA);
  });
});
