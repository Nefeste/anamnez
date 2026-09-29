// Травма головы (spec 2026-09-chapter-2, часть 32г): сотрясение головного мозга и ушиб мягких тканей
// головы; правило «КТ при лёгкой черепно-мозговой травме» — основные и дополнительные признаки,
// возраст и круг применимости; производный параметр «показана ли КТ» — по правилу на настоящих
// признаках; тактика — перевод, палата или дом; «виртуальный врач»; карта «Студенту»; энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { examFits } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { likelyParams, paramBeliefs, paramGain } from '../../src/engine/med/infer';
import { alsoSettings, evaluatePlan, recommendedSetting, settingFit, txRole } from '../../src/engine/med/plan';
import { choosePlan, runDoctor, tacticParams } from '../../src/engine/med/policy';
import { checkRule, knownOf, ruleFindings } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView } from '../../src/state/caseView';
import { article, whenText } from '../../src/state/encyclopedia';

const CONC = 'cond.concussion';
const BRUISE = 'cond.head_bruise';
const rule = db.rules['rule.ct_head'];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const LOC = 'sym.loss_of_consciousness';
const AMNESIA = 'sym.amnesia';
const VOMIT = 'sym.vomiting';
const SEIZURE = 'sym.seizure_after_injury';
const GCS = 'sign.gcs_low';
const ANTICOAG = 'hx.anticoagulants';
const RTA = 'hx.road_accident';
const TBI = [LOC, AMNESIA, VOMIT, SEIZURE, GCS];
const MAIN = [VOMIT, SEIZURE, ANTICOAG, GCS, RTA];

const people = (primary: Id, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'autumn', primary }));
/** пришедшие в травму: пол и возраст — по весам болезни, а не заданы */
const arrivals = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, 9_100_000 + from + i, { department: 'dept.trauma', departments: ['dept.trauma'], season: 'autumn' }));
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const ct = (p: Patient) => p.truth.conditions[0].params.ct;
/** что известно: список «есть» и «нет»; остального не проверяли */
const knownAs = (yes: Id[], no: Id[] = []) => (f: Id) => (yes.includes(f) ? true : no.includes(f) ? false : undefined);
const obs = (f: Id, shown: boolean, exam: Id = 'exam.ask_head_injury'): Observation => ({ f, shown, exam });
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();
const doctor = (p: Patient) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 });

describe('правило КТ: основные, дополнительные, возраст, к кому применимо', () => {
  test('запись: жалоба «травма головы», признаки ЧМТ, пять основных, потеря сознания и возраст 40–60 — дополнительные; КТ в игре нет', () => {
    expect(rule).toMatchObject({ complaints: ['sym.head_injury'], requires: TBI, any: MAIN, minor: { any: [LOC], count: 2 }, age: { main: 60, minor: [40, 60] }, ageMin: 18, exams: [] });
    expect(rule.texts.exam?.ru).toContain('перевод');
    expect(rule.about).toEqual([CONC, BRUISE]);
    expect(rule.sources.map(s => s.url)).toEqual(expect.arrayContaining(['https://cr.minzdrav.gov.ru/view-cr/734_2', 'https://cr.minzdrav.gov.ru/view-cr/733_2', 'https://pubmed.ncbi.nlm.nih.gov/17371884/']));
    expect(ruleFindings(rule).sort()).toEqual([...new Set([...TBI, ...MAIN])].sort());
  });

  test('ничего не известно: вывода нет, проверить — признаки ЧМТ и основные; потеря сознания в 30 лет ещё не довод — её в «проверить» нет дважды', () => {
    const x = checkRule(rule, 30, () => undefined);
    expect(x).toMatchObject({ verdict: 'unknown', applies: undefined, main: [], ageMain: false, minor: [], ageMinor: false });
    expect(x.left).toEqual([LOC, AMNESIA, VOMIT, SEIZURE, GCS, ANTICOAG, RTA]);
  });

  test('основной признак: рвота — КТ нужна в любом возрасте; старше 60 — как только правило применимо', () => {
    expect(checkRule(rule, 25, knownAs([VOMIT])).verdict).toBe('yes');
    expect(checkRule(rule, 25, knownAs([VOMIT])).main).toEqual([VOMIT]);
    // старше 60, но признаков ЧМТ ещё не спрашивали — сначала они
    const old = checkRule(rule, 65, () => undefined);
    expect(old).toMatchObject({ verdict: 'unknown', ageMain: true });
    expect(old.left).toEqual(TBI);
    expect(checkRule(rule, 65, knownAs([AMNESIA])).verdict).toBe('yes');
    // ровно 60 — не «старше 60», а дополнительный
    expect(checkRule(rule, 60, knownAs([AMNESIA], [LOC, ...MAIN]))).toMatchObject({ verdict: 'no', ageMain: false, ageMinor: true });
  });

  test('дополнительные: потеря сознания и возраст 40–60 — КТ нужна; одна потеря сознания в 30 лет — нет', () => {
    expect(checkRule(rule, 50, knownAs([LOC], MAIN))).toMatchObject({ verdict: 'yes', minor: [LOC], ageMinor: true });
    expect(checkRule(rule, 30, knownAs([LOC], MAIN))).toMatchObject({ verdict: 'no', applies: true });
    // 50 лет, была амнезия, о потере сознания не спросили — она и решает
    const x = checkRule(rule, 50, knownAs([AMNESIA], MAIN));
    expect(x).toMatchObject({ verdict: 'unknown', applies: true });
    expect(x.left).toEqual([LOC]);
    // 30 лет, была потеря сознания, не спросили об антикоагулянтах — только о них
    expect(checkRule(rule, 30, knownAs([LOC], [VOMIT, SEIZURE, GCS, RTA])).left).toEqual([ANTICOAG]);
  });

  test('признаков ЧМТ нет — правило не применяют, даже старше 60 и в ДТП', () => {
    expect(checkRule(rule, 70, knownAs([RTA, ANTICOAG], TBI))).toMatchObject({ verdict: 'no', applies: false, left: [] });
  });

  test('известное по наблюдениям: показал хоть раз — есть, проверили и не показал — нет, не проверяли — неизвестно', () => {
    const k = knownOf([obs(LOC, false), obs(LOC, true, 'exam.neuro_exam'), obs(AMNESIA, false)]);
    expect([k(LOC), k(AMNESIA), k(VOMIT)]).toEqual([true, false, undefined]);
  });
});

describe('кто болеет и что находят', () => {
  test('обе — травма, только с приёмным, «голова и спина»; сотрясение S06.0 средней тяжести, ушиб S00.0 лёгкий', () => {
    expect(db.conditions[CONC]).toMatchObject({ department: 'dept.trauma', system: 'nerves', icd10: 'S06.0', severity: 'moderate', derived: { ct: 'rule.ct_head' } });
    expect(db.conditions[BRUISE]).toMatchObject({ department: 'dept.trauma', system: 'nerves', icd10: 'S00.0', severity: 'minor' });
    for (const id of [CONC, BRUISE]) {
      expect(candidates).toContain(id);
      expect(candidatesOf(db, 'dept.therapy')).not.toContain(id);
    }
  });

  test('сотрясение: мужчин 75 % (734_2: 70–81 %); потеря сознания 70 %, амнезия 30–50 %, рвота 35 %, нистагм 40 % (разделы 1.6 и 2.2.1)', () => {
    const w = (sex: 'm' | 'f') => presentingWeight(db.conditions[CONC], { age: 50, sex, season: 'autumn', risks: [], chronic: [] });
    near(w('m') / (w('m') + w('f')), 0.75, 0.02);
    const ps = people(CONC, 3000, 1);
    near(share(ps, p => has(p, LOC)), 0.7, 0.03);
    near(share(ps, p => has(p, AMNESIA)), 0.4, 0.03);
    near(share(ps, p => has(p, VOMIT)), 0.355, 0.03);
    near(share(ps, p => has(p, 'sign.nystagmus')), 0.41, 0.03);
    expect(ps.every(p => p.complaints.includes('sym.head_injury'))).toBe(true);
  });

  test('ушиб мягких тканей: признаков ЧМТ нет — потери сознания, амнезии, судорог и оглушения не бывает (733_2, раздел 2)', () => {
    const ps = people(BRUISE, 1000, 5001);
    for (const f of [LOC, AMNESIA, SEIZURE, GCS]) expect(ps.some(p => has(p, f))).toBe(false);
    expect(share(ps, p => has(p, VOMIT))).toBeLessThan(0.03);
    expect(ps.every(p => p.complaints.includes('sym.head_injury'))).toBe(true);
  });
});

describe('показана ли КТ — производный параметр', () => {
  test('у каждого сотрясения — вывод правила на настоящих признаках и возрасте; у ушиба параметра нет', () => {
    const ps = people(CONC, 2000, 1);
    for (const p of ps) {
      const truth = new Set(p.truth.findings.map(f => f.f));
      expect(ct(p)).toBe(checkRule(rule, p.age, f => truth.has(f)).verdict === 'yes' ? 'yes' : 'no');
    }
    expect(people(BRUISE, 5, 1).every(p => p.truth.conditions[0].params.ct === undefined)).toBe(true);
    // вернулся «с параметрами» — производный их не слушает
    const p = ps.find(x => ct(x) === 'yes')!;
    const again = generatePatient(db, p.seed, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: CONC, params: { ct: 'no' } });
    expect(ct(again)).toBe('yes');
  });

  test('доля «КТ нужна» в записи — как у пришедших с сотрясением: 68 %', () => {
    const ps = arrivals(20_000).filter(p => p.truth.conditions[0].id === CONC);
    expect(ps.length).toBeGreaterThan(700);
    const dist = db.conditions[CONC].params!.ct;
    near(share(ps, p => ct(p) === 'yes'), dist.yes / (dist.yes + dist.no), 0.05);
    // правило не применимо — у каждого десятого сотрясения: без потери сознания, амнезии, рвоты, судорог и оглушения
    near(share(ps, p => TBI.every(f => !has(p, f))), 0.1, 0.03);
  }, 60_000);

  test('вывод врача: рвота — «да» наверняка; всё проверено и не набралось — «нет»; иначе — доли записи', () => {
    const none = paramBeliefs(db, CONC, 'ct', [], 30);
    expect(none.map(b => b.value)).toEqual(['no', 'yes']);
    near(none[1].p, 0.68, 0.001);
    expect(likelyParams(db, CONC, [], 30)).toEqual({ ct: 'yes' });
    expect(paramBeliefs(db, CONC, 'ct', [obs(VOMIT, true)], 30)).toEqual([{ value: 'no', p: 0 }, { value: 'yes', p: 1 }]);
    const clear = [obs(LOC, true), ...MAIN.map(f => obs(f, false))];
    expect(likelyParams(db, CONC, clear, 30)).toEqual({ ct: 'no' });
    expect(likelyParams(db, CONC, clear, 50)).toEqual({ ct: 'yes' });
    expect(tacticParams(db, CONC)).toEqual(['ct']);
  });

  test('польза: пока вывода нет — расспрос о травме, неврологический осмотр, лекарства; снимок груди — ноль; вывод есть — ноль у всех', () => {
    const gain = (exam: Id, o: Observation[], age = 30) => paramGain(db, CONC, 'ct', exam, o, age);
    for (const e of ['exam.ask_head_injury', 'exam.neuro_exam', 'exam.ask_meds']) expect(gain(e, [])).toBeGreaterThan(0.02);
    expect(gain('exam.xray_chest', [])).toBe(0);
    expect(gain('exam.ask_head_injury', [])).toBeGreaterThan(gain('exam.ask_meds', []));
    for (const e of ['exam.ask_head_injury', 'exam.neuro_exam', 'exam.ask_meds']) expect(gain(e, [obs(VOMIT, true)])).toBe(0);
  });
});

describe('тактика и оценка', () => {
  test('назначения: без экранов 48 часов — первая линия и лечит; обезболивающие — облегчают; постельный режим — не нужен; при ушибе — парацетамол', () => {
    expect(txRole(db, CONC, 'tx.screen_rest')).toBe('firstLine');
    expect(['tx.paracetamol', 'tx.ibuprofen'].map(tx => txRole(db, CONC, tx))).toEqual(['supportive', 'supportive']);
    expect(txRole(db, CONC, 'tx.bed_rest')).toBe('notIndicated');
    expect(db.treatments['tx.screen_rest'].effects).toEqual([expect.objectContaining({ on: CONC, kind: 'cure', days: [3, 4] })]);
    expect([txRole(db, BRUISE, 'tx.paracetamol'), txRole(db, BRUISE, 'tx.ibuprofen')]).toEqual(['firstLine', 'acceptable']);
  });

  test('план врача: КТ нужна — скорая (перевод), не нужна — дома; назначение одно', () => {
    expect(choosePlan(db, CONC, [obs(VOMIT, true)], 30)).toEqual({ treatments: ['tx.paracetamol', 'tx.screen_rest'], setting: 'ambulance' });
    expect(choosePlan(db, CONC, [obs(LOC, true), ...MAIN.map(f => obs(f, false))], 30)).toEqual({ treatments: ['tx.paracetamol', 'tx.screen_rest'], setting: 'home' });
    expect(choosePlan(db, BRUISE, [], 30)).toEqual({ treatments: ['tx.paracetamol'], setting: 'home' });
  });

  test('где лечить по правде: КТ нужна — перевод или своя палата; оглушение — только перевод; не нужна — дома', () => {
    const ps = people(CONC, 600, 1);
    const yes = ps.filter(p => ct(p) === 'yes' && !has(p, GCS) && !has(p, SEIZURE))[0];
    const flag = ps.filter(p => has(p, GCS))[0];
    const no = ps.filter(p => ct(p) === 'no')[0];
    expect([recommendedSetting(db, yes), alsoSettings(db, yes)]).toEqual(['transfer', ['ward']]);
    expect(settingFit(recommendedSetting(db, yes), 'admit', alsoSettings(db, yes))).toBe('ok');
    expect(settingFit(recommendedSetting(db, yes), 'home', alsoSettings(db, yes))).toBe('under');
    expect([recommendedSetting(db, flag), alsoSettings(db, flag)]).toEqual(['transfer', []]);
    expect(settingFit(recommendedSetting(db, flag), 'admit', alsoSettings(db, flag))).toBe('under');
    expect(recommendedSetting(db, no)).toBe('home');
    // отказ от экранов — лечение причины: план действует
    expect(evaluatePlan(db, no, { treatments: ['tx.screen_rest'], setting: 'home' }, []).effective).toBe(true);
    expect(evaluatePlan(db, no, { treatments: ['tx.paracetamol'], setting: 'home' }, []).effective).toBe(false);
  });
});

describe('виртуальный врач', () => {
  const conc = people(CONC, 300, 20_001);
  const runs = conc.map(p => ({ p, r: doctor(p) }));

  test('сотрясение: верно у 90 % и больше; путает только с ушибом', () => {
    expect(share(runs, x => x.r.correct)).toBeGreaterThan(0.9);
    expect(runs.filter(x => !x.r.correct).every(x => x.r.diagnosis === BRUISE)).toBe(true);
  });

  test('решает по правилу: к решению вывод известен, место — по нему; «нет» при применимом правиле — только спросив о лекарствах', () => {
    const right = runs.filter(x => x.r.correct);
    const verdict = (x: (typeof runs)[number]) => checkRule(rule, x.p.age, knownOf(x.r.observations));
    expect(share(right, x => verdict(x).verdict !== 'unknown')).toBeGreaterThan(0.95);
    // ошибается место, только если ошиблись расспрос или осмотр
    expect(share(right, x => x.r.plan.setting === (ct(x.p) === 'yes' ? 'ambulance' : 'home'))).toBeGreaterThan(0.88);
    expect(right.every(x => x.r.plan.setting === (verdict(x).verdict === 'yes' ? 'ambulance' : 'home'))).toBe(true);
    // антикоагулянты — основной признак: без вопроса о них «нет» не сказать
    const no = right.filter(x => verdict(x).verdict === 'no' && verdict(x).applies === true);
    expect(no.length).toBeGreaterThan(20);
    expect(no.every(x => x.r.exams.includes('exam.ask_meds'))).toBe(true);
  });

  test('ушиб мягких тканей: верно у 90 % и больше, дома, парацетамол', () => {
    const b = people(BRUISE, 200, 30_001).map(doctor);
    expect(share(b, r => r.correct)).toBeGreaterThan(0.9);
    expect(share(b.filter(r => r.correct), r => r.plan.setting === 'home' && r.plan.treatments.includes('tx.paracetamol'))).toBeGreaterThan(0.95);
  });
});

describe('расспрос о травме головы — только при травме головы', () => {
  test('кому подходит: с травмой и раной головы — да, с пиелонефритом — нет; разумный врач терапии его не назначает', () => {
    const exam = db.exams['exam.ask_head_injury'];
    // рана головы (часть 32г-2): пока ЧМТ не исключена — те же вопросы (733_2, раздел 2.1)
    expect(exam.complaints).toEqual(['sym.head_injury', 'sym.head_wound']);
    expect(examFits(exam, people(CONC, 1, 1)[0])).toBe(true);
    const pyelo = people('cond.pyelonephritis', 60, 1);
    expect(pyelo.some(p => examFits(exam, p))).toBe(false);
    // раньше он спрашивал о травме ради вопроса о рвоте и тошноте
    const therapy = candidatesOf(db, 'dept.therapy');
    const runs = pyelo.map(p => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates: therapy, exams, threshold: 0.9 }));
    expect(runs.some(r => r.exams.includes('exam.ask_head_injury'))).toBe(false);
    expect(article(db, 'exam.ask_head_injury')!.blocks.find(b => b.key === 'forComplaints')!.refs!.map(r => r.id).sort()).toEqual(['sym.head_injury', 'sym.head_wound']);
  }, 30_000);
});

describe('карта «Студенту»', () => {
  const base = people(CONC, 1, 7)[0];
  const at = (age: number, arrived: Observation[]) => makeCaseView({
    version: 0, patient: { ...base, age, complaints: ['sym.head_injury'] }, clock: 600, minutesSpent: 0, money: 0, step: 1,
    arrived: arrived.length ? [{ exam: 'exam.ask_head_injury', step: 1, at: 600, obs: arrived }] : [], pending: [], meanwhile: [], done: arrived.length ? ['exam.ask_head_injury'] : [],
    draft: { treatments: [], setting: 'home' }, departments: ED,
  }).rules;

  test('ничего не спросили — что проверить; рвота — «КТ нужна: рвота»; старше 60 и амнезия — «возраст старше 60 лет»', () => {
    expect(at(30, [])).toEqual([{ id: rule.id, name: rule.name.ru, text: 'Проверьте: потеря сознания при травме, не помнит момент травмы, рвота, судороги сразу после травмы, оглушение по шкале комы Глазго, принимает антикоагулянты, травма в ДТП' }]);
    expect(at(30, [obs(VOMIT, true)])[0].text).toBe('КТ головного мозга нужна: рвота');
    expect(at(65, [obs(AMNESIA, true)])[0].text).toBe('КТ головного мозга нужна: возраст старше 60 лет');
  });

  test('два дополнительных — «потеря сознания при травме, возраст 40–60 лет — дополнительные признаки»; не набралось — «показаний нет»; признаков ЧМТ нет — «не применяют»', () => {
    const negative = MAIN.map(f => obs(f, false));
    expect(at(50, [obs(LOC, true), ...negative])[0].text).toBe('КТ головного мозга нужна: потеря сознания при травме, возраст 40–60 лет — дополнительные признаки');
    expect(at(30, [obs(LOC, true), ...negative])[0].text).toBe(rule.texts.no.ru);
    expect(at(70, TBI.map(f => obs(f, false)))[0].text).toBe(rule.texts.na!.ru);
  });
});

describe('энциклопедия', () => {
  test('правило: к кому применимо, основные с возрастом, «или не меньше двух из этих», чего нет в игре — словами', () => {
    const a = article(db, rule.id)!;
    const block = (key: string) => a.blocks.find(b => b.key === key)!;
    expect(a.blocks.map(b => b.key)).toEqual(['what', 'when', 'requires', 'any', 'minor', 'none', 'exams', 'about', 'sources']);
    expect(block('requires').refs!.map(r => r.id)).toEqual(TBI);
    expect(block('requires').text).toEqual([rule.texts.na!.ru]);
    expect(block('any').text).toEqual(['КТ головного мозга нужна', 'Возраст старше 60 лет — тоже основной признак.']);
    expect(block('minor')).toMatchObject({ title: 'Или не меньше двух из этих', text: ['Возраст 40–60 лет — тоже дополнительный признак.'] });
    expect(block('minor').refs!.map(r => r.id)).toEqual([LOC]);
    expect(block('none').title).toBe('Если проверили все: основных нет, дополнительных не хватает');
    expect(block('exams')).toMatchObject({ refs: [], text: [rule.texts.exam!.ru] });
    // признак — «в правилах», и дополнительный, и из круга применимости
    for (const f of [LOC, AMNESIA, ANTICOAG]) expect(JSON.stringify(article(db, f)!.blocks.find(b => b.key === 'inRules'))).toContain(rule.id);
  });

  test('сотрясение: где лечить — по показаниям к КТ, красные флаги, палата на сутки; правило в статьях обеих болезней', () => {
    expect(whenText({ ct: ['yes'] })).toBe('при показаниях к КТ');
    const where = article(db, CONC)!.blocks.find(b => b.key === 'where')!.text;
    expect(where).toEqual([
      'Обычно — дома.',
      'При показаниях к КТ — скорая, перевод в центр.',
      'При красных флагах — скорая, перевод в центр.',
      'При показаниях к КТ без красных флагов — можно и в стационаре.',
      'В стационаре обычно 1–2 дня.',
    ]);
    for (const id of [CONC, BRUISE]) expect(JSON.stringify(article(db, id)!.blocks.find(b => b.key === 'rules'))).toContain(rule.id);
  });
});
