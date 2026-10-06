// Вены ног (spec 2026-09-chapter-2, часть 33а): тромбоз глубоких вен по уровню — дистальный,
// бедренно-подколенный, подвздошно-бедренный — и вместе с тромбофлебитом; тромбофлебит подкожной
// вены по риску перехода на глубокие; надрыв икроножной мышцы — то, что похоже на тромбоз, но без
// тромба. Шкала Уэллса и D-димер — правило, которое не применяют при тромбофлебите и беременности, и
// «правило не решено — узнать, что осталось»; тактика и место; вывод по сочетаниям скрытых
// параметров; «виртуальный врач»; УЗИ вен в карте; энциклопедия и группа «Сердце и сосуды».
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, examFits } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { contextOf, posterior } from '../../src/engine/med/infer';
import { evaluatePlan, preHospitalOf, recommendedSetting, tacticsFor, txRole } from '../../src/engine/med/plan';
import { indicated, nextStep, runDoctor, tacticParams } from '../../src/engine/med/policy';
import { checkRule, knownOf, openRuleExams, ruleExams, rulesFor } from '../../src/engine/med/rules';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView, noteText, treatmentGroupsFor } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const DVT = 'cond.dvt';
const TP = 'cond.superficial_thrombophlebitis';
const STRAIN = 'cond.calf_strain';
const RULE = 'rule.wells_dvt';
const ASK = 'exam.ask_leg';
const EXAM = 'exam.leg_exam';
const DD = 'exam.d_dimer';
const US = 'exam.us_leg_veins';
const DOAC = 'tx.doac';
const LMWH = 'tx.lmwh';
const FONDA = 'tx.fondaparinux';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const people = (primary: Id, n: number, from = 1, params?: Record<string, string>) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'autumn', primary, ...(params ? { params } : {}) }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
/** Больной без жалоб правила qSOFA (часть 48а): у кого жар или кашель, первой проверяют её, а здесь — шкала Уэллса. */
const afebrile = (primary: Id) => people(primary, 20).find(p => !db.rules['rule.qsofa'].complaints.some(f => p.complaints.includes(f)))!;
const params = (p: Patient) => p.truth.conditions[0].params;
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const ob = (exam: Id, f: Id, shown: boolean): Observation => ({ f, shown, exam });
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();
const doctor = (p: Patient) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 });
const rule = db.rules[RULE];
/** осмотр и расспрос без находок — шкала Уэллса по нулям */
const quiet = [
  ...['hx.calf_snap', 'hx.cancer_active', 'hx.leg_cast', 'hx.bed_rest', 'hx.prior_dvt', 'hx.travel'].map(f => ob(ASK, f, false)),
  ...['sign.deep_vein_tenderness', 'sign.leg_swollen_whole', 'sign.calf_swelling_3cm', 'sign.pitting_edema', 'sign.collateral_veins', 'sign.superficial_cord', 'sign.varicose_veins', 'sign.calf_muscle_tenderness', 'sign.calf_bruise', 'sign.homans'].map(f => ob(EXAM, f, false)),
];
/** то же, но признаки `shown` — есть */
const with_ = (...shown: Id[]) => quiet.map(o => (shown.includes(o.f) ? { ...o, shown: true } : o));
const scoreOf = (p: Patient, treatments: Id[], setting: 'home' | 'ambulance' | 'ward' = 'home') => {
  const ev = evaluatePlan(db, p, { treatments, setting }, []);
  return { ev, score: scoreCase({ verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev, outcome: { kind: 'recovered', day: 21 } as never, selfLimiting: false, redFlags: [] }) };
};

describe('записи: кто болеет и что находят', () => {
  test('ТГВ и тромбофлебит — хирургия, «Сердце и сосуды»; надрыв — травма; у всех одна жалоба — боль в ноге', () => {
    expect(db.conditions[DVT]).toMatchObject({ department: 'dept.surgery', system: 'heart', kind: 'disease', severity: 'serious', icd10: 'I80.2' });
    expect(db.conditions[TP]).toMatchObject({ department: 'dept.surgery', system: 'heart', kind: 'disease', icd10: 'I80.0' });
    expect(db.conditions[STRAIN]).toMatchObject({ department: 'dept.trauma', system: 'bones', kind: 'injury', severity: 'minor', icd10: 'S86.1' });
    expect(db.conditions[DVT].sources.map(s => s.url)).toContain('https://cr.minzdrav.gov.ru/view-cr/960_1');
    expect(db.conditions[TP].sources.map(s => s.url)).toContain('https://cr.minzdrav.gov.ru/view-cr/668_2');
    expect(db.conditions[STRAIN].sources.map(s => s.url)).toContain('https://cr.minzdrav.gov.ru/view-cr/832_2');
    for (const id of [DVT, TP, STRAIN]) {
      for (const p of people(id, 60)) expect(p.complaints).toContain('sym.leg_pain');
      expect(db.conditions[id].age.min).toBe(18);
    }
    expect(db.conditions[DVT].confirm).toEqual([US]);
    expect(db.conditions[TP].confirm).toEqual([US]);
    expect(db.conditions[STRAIN].confirm).toEqual([EXAM]);
  });

  test('ТГВ: уровни 45 : 40 : 15, у трети — и тромбофлебит; УЗИ видит тромб своего уровня', () => {
    const xs = people(DVT, 3000);
    near(share(xs, p => params(p).level === 'distal'), 0.45, 0.03);
    near(share(xs, p => params(p).level === 'iliofemoral'), 0.15, 0.02);
    near(share(xs, p => params(p).surface === 'yes'), 1 / 3, 0.03);
    for (const p of xs) {
      const level = params(p).level;
      expect(has(p, 'img.us_dvt_calf')).toBe(level === 'distal');
      expect(has(p, 'img.us_dvt_prox')).toBe(level !== 'distal');
      expect(has(p, 'img.us_dvt_iliac')).toBe(level === 'iliofemoral');
      expect(has(p, 'sign.superficial_cord')).toBe(params(p).surface === 'yes');
      expect(has(p, 'img.us_superficial_thrombus')).toBe(params(p).surface === 'yes');
    }
    // D-димер повышен у 96 % (Stein 2004), отёк всей ноги — чаще при высоком тромбозе
    near(share(xs, p => has(p, 'lab.d_dimer_high')), 0.96, 0.015);
    const whole = (level: string) => share(xs.filter(p => params(p).level === level), p => has(p, 'sign.leg_swollen_whole'));
    expect(whole('iliofemoral')).toBeGreaterThan(whole('femoropopliteal') + 0.3);
    expect(whole('distal')).toBe(0);
  });

  test('тромбофлебит: риск по границе тромба — притоки, ствол, 3 см от соустья; тяж и тромб в подкожной вене у каждого', () => {
    const xs = people(TP, 2000);
    near(share(xs, p => params(p).risk === 'low'), 0.5, 0.03);
    near(share(xs, p => params(p).risk === 'high'), 0.15, 0.02);
    for (const p of xs) {
      const risk = params(p).risk;
      expect(has(p, 'sign.superficial_cord')).toBe(true);
      expect(has(p, 'img.us_superficial_thrombus')).toBe(true);
      expect(has(p, 'img.us_saphenous_trunk')).toBe(risk !== 'low');
      expect(has(p, 'img.us_near_junction')).toBe(risk === 'high');
      expect(has(p, 'img.us_dvt_prox') || has(p, 'img.us_dvt_calf')).toBe(false);
    }
  });

  test('варикоз: у пришедших с тромбофлебитом — у большинства (668_2: до 80 %), у остальных — у каждого пятого', () => {
    // заданная болезнь фактор риска не поднимает — смотрим пришедших как есть
    const all = Array.from({ length: 8000 }, (_, i) => generatePatient(db, 50_000 + i, { department: 'dept.therapy', departments: ED, season: 'autumn' }));
    const tp = all.filter(p => p.truth.conditions[0].id === TP);
    expect(tp.length).toBeGreaterThan(80);
    expect(share(tp, p => has(p, 'sign.varicose_veins'))).toBeGreaterThan(0.5);
    const adults = all.filter(p => p.age >= 25 && p.truth.conditions[0].id !== TP);
    near(share(adults, p => has(p, 'sign.varicose_veins')), 0.22, 0.04);
  }, 30_000);

  test('надрыв: рывок в икре у каждого, D-димер повышен примерно у половины, тромба нет', () => {
    const xs = people(STRAIN, 2000);
    for (const p of xs) {
      expect(has(p, 'hx.calf_snap')).toBe(true);
      expect(has(p, 'img.us_dvt_prox') || has(p, 'img.us_dvt_calf') || has(p, 'sign.superficial_cord')).toBe(false);
    }
    near(share(xs, p => has(p, 'lab.d_dimer_high')), 0.56, 0.04);
    // симптом Хоманса — у надрыва чаще, чем у тромбоза: ловушка (960_1, раздел 1.6: специфичность 30,4 %)
    expect(share(xs, p => has(p, 'sign.homans'))).toBeGreaterThan(share(people(DVT, 2000), p => has(p, 'sign.homans')));
  });
});

describe('шкала Уэллса и D-димер', () => {
  const at = (obs: Observation[], age = 50) => checkRule(rule, age, knownOf(obs));

  test('два пункта шкалы — УЗИ сразу; D-димер повышен — УЗИ; меньше двух и D-димер в норме — тромбоз исключён', () => {
    expect(at(with_('hx.bed_rest', 'sign.calf_swelling_3cm')).verdict).toBe('yes');
    expect(at(with_('sign.pitting_edema')).verdict).toBe('unknown');
    expect(at(with_('sign.pitting_edema')).left).toEqual(['lab.d_dimer_high']);
    expect(at([...with_('sign.pitting_edema'), ob(DD, 'lab.d_dimer_high', true)]).verdict).toBe('yes');
    expect(at([...with_('sign.pitting_edema'), ob(DD, 'lab.d_dimer_high', false)]).verdict).toBe('no');
    expect(rule.exams).toEqual([US]);
    // «другой диагноз столь же вероятен» игра не считает: рывок в икре — не минус два балла
    expect(at(with_('hx.calf_snap', 'hx.bed_rest', 'sign.calf_swelling_3cm')).verdict).toBe('yes');
  });

  test('тяж по ходу подкожной вены или беременность — правило не применяют; пока тяжа не видели — применяют', () => {
    const cord = at(with_('sign.superficial_cord', 'sign.pitting_edema'));
    expect([cord.verdict, cord.applies, cord.left]).toEqual(['no', false, []]);
    const pregnant = at([...with_(), ob('exam.ask_pregnancy', 'hx.pregnancy', true)], 30);
    expect(pregnant.applies).toBe(false);
    expect(at([]).applies).toBe(true);
    expect(rule.excludes).toEqual(['sign.superficial_cord', 'hx.pregnancy', 'sign.foot_pulse_absent']);
  });

  test('правило не решено — узнать, что осталось: шкала меньше двух — D-димер; решено или не применяют — ничего', () => {
    const p = afebrile(STRAIN);
    expect(rulesFor(db, p).map(r => r.id)).toEqual([RULE]);
    expect(openRuleExams(db, p, with_('sign.pitting_edema'))).toEqual([DD]);
    expect(openRuleExams(db, p, with_('hx.bed_rest', 'sign.pitting_edema'))).toEqual([]);
    expect(ruleExams(db, p, with_('hx.bed_rest', 'sign.pitting_edema'))).toEqual([US]);
    expect(openRuleExams(db, p, with_('sign.superficial_cord'))).toEqual([]);
    expect(openRuleExams(db, p, [...with_(), ob(DD, 'lab.d_dimer_high', false)])).toEqual([]);
    // страховая: D-димер при шкале меньше двух показан, пока правило не решено
    expect(indicated(db, p, [...complaintObservations(p), ...with_()], candidates, DD)).toBe(true);
  });

  test('разумный врач: расспрос и осмотр первыми; шкала меньше двух — D-димер, два и больше — УЗИ; тяж — не D-димер', () => {
    const p = people(DVT, 1, 5, { level: 'distal', surface: 'no' })[0];
    const said = complaintObservations(p);
    const opt = { candidates, exams, threshold: 0.9, minGain: 0.02 };
    const steps: Id[] = [];
    // давление уже измерила медсестра на сортировке: с 0.3.19 его меряют и при головной боли (62_3, раздел 2.1)
    let done: Id[] = ['exam.vitals', 'exam.ask_chronic'];
    for (let i = 0; i < 2; i++) {
      const s = nextStep(db, p, said, done, {}, opt).step;
      if (s.kind !== 'exam') break;
      steps.push(s.exam);
      done = [...done, s.exam];
    }
    expect(steps.sort()).toEqual([ASK, EXAM].sort());
    const next = (obs: Observation[]) => nextStep(db, p, [...said, ...obs], [...done], {}, opt).step;
    expect(next(with_('sign.pitting_edema'))).toEqual({ kind: 'exam', exam: DD });
    expect(next(with_('hx.bed_rest', 'sign.pitting_edema'))).toEqual({ kind: 'exam', exam: US });
    const cord = next(with_('sign.superficial_cord'));
    expect(cord.kind === 'exam' && cord.exam).not.toBe(DD);
  });

  test('обследования при боли в ноге — только с этой жалобой; расспрос и осмотр — каждому, первыми', () => {
    const leg = people(DVT, 1)[0];
    const flu = generatePatient(db, 1, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: 'cond.influenza' });
    expect([ASK, EXAM].map(id => examFits(db.exams[id], leg))).toEqual([true, true]);
    expect([ASK, EXAM].map(id => examFits(db.exams[id], flu))).toEqual([false, false]);
    expect(db.exams[ASK].routineFor).toEqual(['sym.leg_pain']);
    expect(db.exams[EXAM].routineFor).toEqual(['sym.leg_pain']);
    expect(db.exams[US]).toMatchObject({ room: 'room.ultrasound', kind: 'imaging', radiation: 'none' });
  });
});

describe('тактика', () => {
  const role = (id: Id, tx: Id, p: Record<string, string>) => txRole(db, id, tx, p);

  test('ТГВ: ПОАК первой линией, НМГ и фондапаринукс допустимы, компрессия; АСК и постельный режим — не нужно; дома', () => {
    const p = { level: 'femoropopliteal', side: 'left', surface: 'no' };
    expect(role(DVT, DOAC, p)).toBe('firstLine');
    expect([LMWH, FONDA].map(tx => role(DVT, tx, p))).toEqual(['acceptable', 'acceptable']);
    expect(role(DVT, 'tx.compression', p)).toBe('supportive');
    expect(['tx.aspirin_acs', 'tx.bed_rest'].map(tx => role(DVT, tx, p))).toEqual(['notIndicated', 'notIndicated']);
    expect(recommendedSetting(db, people(DVT, 1, 1, p)[0])).toBe('home');
    expect(tacticParams(db, DVT)).toEqual(['level']);
  });

  test('подвздошно-бедренный — перевод в сосудистый центр, до приезда скорой — НМГ; беременная — в стационар, без ПОАК', () => {
    const ilio = { level: 'iliofemoral', side: 'right', surface: 'no' };
    expect(role(DVT, LMWH, ilio)).toBe('firstLine');
    expect(preHospitalOf(db, db.conditions[DVT].treatment, ilio)).toEqual([LMWH]);
    expect(recommendedSetting(db, people(DVT, 1, 1, ilio)[0])).toBe('transfer');
    const pregnant = people(DVT, 400, 1, { level: 'distal' }).find(p => p.truth.risks.includes('risk.pregnancy'))!;
    expect(recommendedSetting(db, pregnant)).toBe('ward');
    expect(db.treatments[DOAC].contraindications.map(k => k.id)).toContain('risk.pregnancy');
    expect(db.treatments[LMWH].contraindications).toEqual([]);
  });

  test('тромбофлебит: притоки — НПВП, ствол — фондапаринукс 45 дней, у соустья — как ТГВ; антибиотики — не нужно; дома', () => {
    expect(role(TP, 'tx.ibuprofen', { risk: 'low' })).toBe('firstLine');
    expect(role(TP, FONDA, { risk: 'moderate' })).toBe('firstLine');
    expect([LMWH, DOAC].map(tx => role(TP, tx, { risk: 'moderate' }))).toEqual(['acceptable', 'acceptable']);
    expect(role(TP, DOAC, { risk: 'high' })).toBe('firstLine');
    for (const tx of ['tx.amoxicillin_clavulanate', 'tx.aspirin_acs']) expect(role(TP, tx, { risk: 'low' })).toBe('notIndicated');
    expect(tacticParams(db, TP)).toEqual(['risk']);
    expect(db.conditions[TP].treatment!.setting.default).toBe('home');
  });

  test('надрыв: покой, холод, бинт; антикоагулянты и гормоны — не нужно', () => {
    expect(role(STRAIN, 'tx.rice', {})).toBe('firstLine');
    for (const tx of [DOAC, LMWH, 'tx.steroid_systemic_short']) expect(role(STRAIN, tx, {})).toBe('notIndicated');
  });

  test('оценка: ТГВ — ПОАК с трикотажем дома — пятёрка; ацетилсалициловая кислота — лечения причины нет; подвздошный без НМГ — замечание', () => {
    const p = people(DVT, 1, 3, { level: 'femoropopliteal', surface: 'no' })[0];
    expect(scoreOf(p, [DOAC, 'tx.compression']).score.overall).toBe('A');
    expect(scoreOf(p, ['tx.aspirin_acs']).score.notes).toContainEqual({ code: 'tx.noCure' });
    const ilio = people(DVT, 1, 3, { level: 'iliofemoral', surface: 'no' })[0];
    const noLmwh = scoreOf(ilio, [DOAC], 'ambulance');
    expect(noLmwh.score.notes).toContainEqual({ code: 'tx.preHospitalMissing', tx: LMWH });
    expect(noteText({ code: 'tx.preHospitalMissing', tx: LMWH })).toBe('До приезда скорой не назначено: низкомолекулярный гепарин под кожу');
    expect(scoreOf(ilio, [LMWH, 'tx.compression'], 'ambulance').score.treatment).toBe('A');
    expect(scoreOf(ilio, [DOAC, 'tx.compression']).score.setting).toBe('D');
  });
});

describe('вывод по сочетаниям скрытых параметров', () => {
  const p = people(DVT, 1, 9, { level: 'distal', surface: 'yes' })[0];
  const beliefs = (obs: Observation[]) => {
    const all = [...complaintObservations(p), ...obs];
    return Object.fromEntries(posterior(db, candidates, all, contextOf(db, p, all)).map(b => [b.id, b.p]));
  };
  const cordUs = [ob(US, 'img.us_superficial_thrombus', true), ob(US, 'img.us_saphenous_trunk', true), ob(US, 'img.us_dvt_prox', false)];

  test('тяж, тромб в подкожной вене и её стволе и тромб в венах голени — это ТГВ с тромбофлебитом, а не тромбофлебит', () => {
    const b = beliefs([...with_('sign.superficial_cord', 'sign.varicose_veins'), ...cordUs, ob(US, 'img.us_dvt_calf', true)]);
    expect(b[DVT]).toBeGreaterThan(b[TP]);
    // вены голени чистые — тромбофлебит
    const clean = beliefs([...with_('sign.superficial_cord', 'sign.varicose_veins'), ...cordUs, ob(US, 'img.us_dvt_calf', false)]);
    expect(clean[TP]).toBeGreaterThan(0.9);
  });

  test('рывок в икре, D-димер в норме — надрыв; без рывка, с отёком и повышенным D-димером — не надрыв', () => {
    const q = people(STRAIN, 1, 4)[0];
    const all = (obs: Observation[]) => [...complaintObservations(q), ...obs];
    const b = (obs: Observation[]) => Object.fromEntries(posterior(db, candidates, all(obs), contextOf(db, q, all(obs))).map(x => [x.id, x.p]));
    expect(b([...with_('hx.calf_snap', 'sign.calf_muscle_tenderness'), ob(DD, 'lab.d_dimer_high', false)])[STRAIN]).toBeGreaterThan(0.95);
    const swollen = b([...with_('sign.calf_swelling_3cm', 'sign.pitting_edema', 'sign.deep_vein_tenderness'), ob(DD, 'lab.d_dimer_high', true)]);
    expect(swollen[DVT]).toBeGreaterThan(swollen[STRAIN]);
  });
});

describe('«виртуальный врач» на болях в ноге', () => {
  const run = (id: Id, n: number, from: number) => people(id, n, from).map(p => ({ p, r: doctor(p) }));
  const dvt = run(DVT, 240, 3000);
  const tp = run(TP, 240, 3000);
  const strain = run(STRAIN, 240, 3000);

  test('диагноз: ТГВ — у 85 % и больше, тромбофлебит и надрыв — у 90 % и больше', () => {
    expect(share(dvt, x => x.r.correct)).toBeGreaterThan(0.85);
    expect(share(tp, x => x.r.correct)).toBeGreaterThan(0.9);
    expect(share(strain, x => x.r.correct)).toBeGreaterThan(0.9);
  });

  test('тромбоз лечат антикоагулянтом у 90 % и больше; надрыв — без него почти всегда; при надрыве D-димер делают чаще УЗИ', () => {
    const ac = (x: { r: { plan: { treatments: Id[] } } }) => x.r.plan.treatments.some(tx => [DOAC, LMWH, FONDA].includes(tx));
    expect(share(dvt, ac)).toBeGreaterThan(0.9);
    expect(share(strain, ac)).toBeLessThan(0.05);
    expect(share(strain, x => x.r.exams.includes(DD))).toBeGreaterThan(share(strain, x => x.r.exams.includes(US)));
    // тромбофлебиту D-димер не нужен: его делают реже, чем при надрыве
    expect(share(tp, x => x.r.exams.includes(DD))).toBeLessThan(0.3);
    expect(share(tp, x => x.r.exams.includes(US))).toBe(1);
  });

  test('положительное правило — УЗИ сделано всегда', () => {
    for (const { p, r } of [...dvt, ...strain]) for (const e of ruleExams(db, p, r.observations)) expect(r.exams).toContain(e);
  });
});

describe('на экране и в энциклопедии', () => {
  const image = (patient: Patient, obs: Observation[]) => makeCaseView({
    version: 0, patient, clock: 600, minutesSpent: 0, money: 0, step: 1,
    arrived: [{ exam: US, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [US],
    draft: { treatments: [], setting: 'home' }, departments: ED,
  }).groups.find(g => g.exam === US)!.image;

  test('УЗИ вен в карте — два кадра: тромб в глубокой вене, в подкожной, гематома надрыва', () => {
    const p = people(DVT, 1)[0];
    expect(image(p, [ob(US, 'img.us_dvt_calf', true)])).toMatchObject({ kind: 'us', view: 'vein', deep: 1, superficial: 0, tear: 0 });
    expect(image(p, [ob(US, 'img.us_dvt_prox', false), ob(US, 'img.us_superficial_thrombus', true)])).toMatchObject({ kind: 'us', view: 'vein', deep: 0, superficial: 1 });
    expect(image(p, [ob(US, 'img.us_muscle_tear', true)])).toMatchObject({ view: 'vein', deep: 0, tear: 0.8 });
  });

  test('«Студенту»: правило в карте — что проверить, что велит, когда не применяют', () => {
    const p = afebrile(STRAIN);
    const view = (obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: obs.length ? [{ exam: EXAM, step: 1, at: 600, obs }] : [], pending: [], meanwhile: [], done: obs.length ? [EXAM] : [],
      draft: { treatments: [], setting: 'home' }, departments: ED,
    }).rules;
    expect(view(with_('sign.pitting_edema'))[0].text).toBe('Проверьте: D-димер выше 500 нг/мл');
    expect(view(with_('sign.pitting_edema', 'sign.calf_swelling_3cm'))[0].text).toContain('УЗИ вен нужно');
    expect(view(with_('sign.superficial_cord'))[0].text).toBe(rule.texts.na!.ru);
  });

  test('антикоагулянты, трикотаж и гель — в группе «Сердце и сосуды»', () => {
    const groups = Object.fromEntries(treatmentGroupsFor([]).map(g => [g.key, { title: g.title, ids: g.items.map(x => x.id) }]));
    expect(groups.heart.title).toBe('Сердце и сосуды');
    expect(groups.heart.ids).toEqual(expect.arrayContaining([DOAC, LMWH, FONDA, 'tx.compression', 'tx.topical_heparin']));
    expect(db.treatments[LMWH].route).toBe('sc');
  });

  test('статья правила: когда не применяют; статья ТГВ: до приезда скорой — НМГ при подвздошно-бедренном', () => {
    const a = article(db, RULE)!;
    const ex = a.blocks.find(b => b.key === 'excludes')!;
    expect(ex.refs!.map(r => r.id)).toEqual(['sign.superficial_cord', 'hx.pregnancy', 'sign.foot_pulse_absent']);
    expect(ex.text).toEqual([rule.texts.na!.ru]);
    const d = article(db, DVT)!;
    const rows = d.blocks.find(b => b.key === 'treatment')!.rows!;
    expect(rows.find(r => r.label.startsWith('До приезда скорой'))!.refs!.map(r => r.id)).toEqual([LMWH]);
    expect(d.subtitle).toContain('Сердце и сосуды');
  });
});
