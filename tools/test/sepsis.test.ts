// Сепсис и септический шок (spec 2026-10-chapter-4, часть 48а; 898_1 «Сепсис (у взрослых)»; EpiSEP): очаг в лёгких или
// мочевых путях и органная дисфункция; qSOFA — давление 100 и ниже, частое дыхание, оглушение — у больного с признаками
// инфекции; срок антибиотика — от того, как qSOFA дал 2 балла: при шоке час, без шока 3 часа; посевы крови, антибиотик и
// раствор — обязательно и до перевода, при шоке — норэпинефрин; место — ПИТ, реанимация закрывает её. Источник угадан —
// диагноз частично верный. Лактат выше 2 — и при кардиогенном и обструктивном шоке.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { curesOf, evaluatePlan, type Plan, primaryOf, settingFit, txAvailable, txRole, untreatedOf, type Venue, verdictOf } from '../../src/engine/med/plan';
import { decisionLimit, type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import { observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { dueIn, minutesTo, targetResults, targetsFor, targetStart } from '../../src/engine/shift/targets';
import { article } from '../../src/state/encyclopedia';
import { T } from '../../src/i18n';

const SEPSIS = 'cond.sepsis';
const QSOFA = 'rule.qsofa';
const ABX = 'tx.antibiotic_iv';
const CULTURE = 'tx.blood_culture';
const BALANCED = 'tx.balanced_fluids';
const NORE = 'tx.norepinephrine';
const SHOCK_T = 'target.sepsis_abx_shock';
const SEPSIS_T = 'target.sepsis_abx';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true };

const paramsOf = (p: Patient) => primaryOf(p).params;
const bySepsis = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f && x.cause === SEPSIS);
const gen = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: SEPSIS, params, carried: db.economy.ambulance.weight });
/** Больные в возрасте болезни. */
function people(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = gen(seed, params);
    const chronic = p.truth.conditions.filter(x => x.role === 'comorbid').map(x => x.id);
    if (presentingWeight(db.conditions[SEPSIS], { sex: p.sex, age: p.age, season: p.season, risks: p.truth.risks, chronic }) > 0) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true, value?: number): Observation => ({ f, shown: on, exam, ...(value !== undefined ? { value } : {}) });
/** Всё, что видит врач, — правда: каждое обследование показало то, что есть. */
const truthful = (p: Patient, exams: Id[]): Observation[] => [
  ...complaintObservations(p),
  ...exams.flatMap((exam, i) => runExam(db, p, exam, Rng.seeded(i).fork(exam), undefined, true)),
];
const plan = (treatments: Id[], setting: Setting = 'icu'): Plan => ({ treatments: [...treatments].sort(), setting });
const ALL = ['exam.ask_chronic', 'exam.ask_complaints', 'exam.vitals', 'exam.neuro_exam', 'exam.lung_auscultation', 'exam.xray_chest', 'exam.urine_dipstick', 'exam.lactate', 'exam.creatinine', 'exam.cbc'];
const rule = () => db.rules[QSOFA];

describe('каталог', () => {
  test('терапия, угрожает жизни, привозит скорая; диагноз клинический; источник — пневмония или пиелонефрит; место — ПИТ', () => {
    const c = db.conditions[SEPSIS];
    expect(c).toMatchObject({
      icd10: 'A41.9', department: 'dept.therapy', system: 'heart', severity: 'critical', arrival: 'ambulance', confirm: 'clinical',
      source: { param: 'source', map: { lungs: 'cond.pneumonia_cap', urinary: 'cond.pyelonephritis' } },
    });
    // очаги у сепсиса — дыхательные пути 43,6 %, мочеполовые 27,1 % (EpiSEP) — на два источника; шок — 42 из 175
    expect(c.params!.source).toEqual({ lungs: 62, urinary: 38 });
    expect(c.params!.shock).toEqual({ no: 76, yes: 24 });
    expect(c.params!.organ).toEqual({ kidney: 40, mind: 30, pressure: 30 });
    expect(c.treatment!.setting).toEqual({ default: 'icu' });
    // реанимация закрывает ПИТ (часть 47)
    expect(settingFit('icu', 'ricu')).toBe('ok');
    expect(settingFit('icu', 'admit')).toBe('under');
  });

  test('давление 100 и ниже — порог того же числа, что 140/90 и ниже 90; лактат — анализ лаборатории; на тонометре и в строке', () => {
    const bp = db.findings['vital.bp_100'];
    expect(bp.value).toMatchObject({ of: 'vital.bp_high', present: [90, 100], ref: [100, 139] });
    expect(bp.leak).toBe(0);
    expect(db.exams['exam.vitals'].checks.find(k => k.f === 'vital.bp_100')).toMatchObject({ sens: 9500, spec: 10000 });
    const lac = db.exams['exam.lactate'];
    expect(lac).toMatchObject({ kind: 'lab', room: 'room.lab' });
    expect(lac.checks).toEqual([expect.objectContaining({ f: 'lab.lactate_high', sens: 9700, spec: 9700 })]);
    expect(db.findings['lab.lactate_high'].value).toMatchObject({ unit: 'ммоль/л', ref: [0.5, 2.0], present: [2.3, 7.5] });
    const line = (o: Observation) => observationText(db, o, 'm', 1);
    expect(line(seen('vital.bp_100', 'exam.vitals'))).toBe('Давление невысокое: верхнее 100 и ниже');
    expect(line(seen('lab.lactate_high', 'exam.lactate', true, 3.4))).toBe('Лактат 3,4 ммоль/л');
  });

  test('лечение: антибиотик широкого спектра и растворы — в вену, норэпинефрин — под монитором; посевы — процедура', () => {
    expect(db.treatments[ABX]).toMatchObject({ kind: 'drug', route: 'iv', class: 'antibiotic.broad_iv' });
    expect(db.treatments[BALANCED]).toMatchObject({ kind: 'drug', route: 'iv' });
    expect(db.treatments[CULTURE].kind).toBe('procedure');
    expect([txAvailable(db, ABX, {}), txAvailable(db, CULTURE, {}), txAvailable(db, NORE, {}), txAvailable(db, NORE, BAY)]).toEqual([true, true, false, true]);
  });
});

describe('qSOFA', () => {
  const who = { age: 70, complaints: ['sym.fever_hx'] };
  const known = (on: Id[], off: Id[] = []) => (f: Id) => (on.includes(f) ? true : off.includes(f) ? false : undefined);
  const ITEMS = ['vital.bp_low', 'vital.bp_100', 'vital.tachypnea', 'sign.gcs_low'];

  test('по баллу: давление 100 и ниже (ниже 90 — тот же балл), дыхание чаще 20, оглушение; от двух — «да»', () => {
    const r = rule();
    expect(r.points!.items.map(i => [i.f, i.w, i.unless ?? []])).toEqual([
      ['vital.bp_low', 1, []], ['vital.bp_100', 1, ['vital.bp_low']], ['vital.tachypnea', 1, []], ['sign.gcs_low', 1, []],
    ]);
    expect([r.points!.from, r.exams, r.about, r.ageMin]).toEqual([2, ['exam.lactate'], [SEPSIS], 18]);
    const verdict = (on: Id[], off: Id[]) => checkRule(r, who, known(['sym.fever_hx', ...on], off)).verdict;
    expect(verdict(['vital.bp_100', 'vital.tachypnea'], ['vital.bp_low', 'sign.gcs_low'])).toBe('yes');
    expect(verdict(['vital.bp_low', 'sign.gcs_low'], ['vital.bp_100', 'vital.tachypnea'])).toBe('yes');
    // давление ниже 90 и 100 и ниже — один балл, а не два
    expect(verdict(['vital.bp_low', 'vital.bp_100'], ['vital.tachypnea', 'sign.gcs_low'])).toBe('no');
    expect(verdict(['vital.tachypnea'], ['vital.bp_low', 'vital.bp_100', 'sign.gcs_low'])).toBe('no');
  });

  test('кому: при жалобе на жар, озноб, кашель, боль в пояснице или при мочеиспускании — и при признаках инфекции; без них не считают', () => {
    const r = rule();
    expect(r.complaints).toEqual(['sym.fever_hx', 'sym.chills', 'sym.cough', 'sym.flank_pain', 'sym.dysuria']);
    expect([r.requires, r.onlyIfApplies]).toEqual([['sym.fever_hx', 'sym.chills', 'vital.fever'], true]);
    // кашель без жара, озноба и температуры: давление ниже 90 и частое дыхание баллов не дают — шкалу не считают
    const cough = { age: 70, complaints: ['sym.cough'] };
    const x = checkRule(r, cough, known(['sym.cough', 'vital.bp_low', 'vital.tachypnea'], ['sym.fever_hx', 'sym.chills', 'vital.fever']));
    expect([x.verdict, x.applies]).toEqual(['no', false]);
    // жар есть, а давление и дыхание ещё не мерили — оглушение не проверяют, пока не набран балл: двух без него не набрать
    const open = checkRule(r, who, known(['sym.fever_hx']));
    expect(open.verdict).toBe('unknown');
    const one = checkRule(r, who, known(['sym.fever_hx', 'vital.tachypnea'], ['vital.bp_low', 'vital.bp_100']));
    expect([one.verdict, one.left]).toEqual(['unknown', ['sign.gcs_low']]);
    for (const f of ITEMS) expect(db.revealedBy[f]?.length ?? 0).toBeGreaterThan(0);
  });

  test('строки правила и энциклопедия: пункты, порог, что делать при «да»', () => {
    expect(rule().texts.yes.ru).toBe('Два балла и больше — подозрение на сепсис: лактат, посевы крови, антибиотик');
    const a = article(db, QSOFA);
    expect(a).toBeDefined();
    expect(JSON.stringify(a)).toContain('Сепсис');
  });
});

describe('больные', () => {
  const xs = people(1500);
  const part = (f: (p: Patient) => boolean, ps = xs) => ps.filter(f).length / ps.length;

  test('очаг — лёгкие 62, мочевые пути 38; шок — 24 из 100; органная дисфункция — почки 40, сознание 30, давление 30', () => {
    for (const [name, v, want] of [['source', 'lungs', 0.62], ['shock', 'yes', 0.24], ['organ', 'kidney', 0.4], ['organ', 'mind', 0.3]] as const) {
      expect(Math.abs(part(p => paramsOf(p)[name] === v) - want)).toBeLessThan(0.035);
    }
  });

  test('у каждого видна органная дисфункция: шок — давление ниже 90 и лактат; почки — креатинин; сознание — оглушение; давление — 100 и ниже', () => {
    for (const p of xs) {
      const q = paramsOf(p);
      const has = (f: Id) => bySepsis(p, f);
      const want = q.shock === 'yes' ? has('vital.bp_low') && has('lab.lactate_high')
        : q.organ === 'kidney' ? has('lab.creatinine_high') : q.organ === 'mind' ? has('sign.gcs_low') : has('vital.bp_100');
      expect({ seed: p.seed, q, want }).toEqual({ seed: p.seed, q, want: true });
      // давление ниже 90 — только при шоке; 100 и ниже — только без него
      expect({ seed: p.seed, low: has('vital.bp_low'), hundred: has('vital.bp_100') && q.shock === 'yes' }).toEqual({ seed: p.seed, low: q.shock === 'yes', hundred: false });
    }
  });

  test('очаг по параметру: в лёгких — инфильтрат на снимке у каждого, в мочевых путях — лейкоциты в моче', () => {
    for (const p of xs) {
      const lungs = paramsOf(p).source === 'lungs';
      expect({ seed: p.seed, xray: bySepsis(p, 'img.cxr_infiltrate'), urine: bySepsis(p, 'lab.urine_leuk') }).toEqual({ seed: p.seed, xray: lungs, urine: !lungs });
    }
  });

  test('qSOFA два балла и больше по правде — у большинства, но не у всех: меньше двух сепсис не исключает', () => {
    const yes = part(p => {
      const has = new Set(p.truth.findings.map(f => f.f));
      return rule().complaints.some(f => p.complaints.includes(f)) && checkRule(rule(), p, f => has.has(f)).verdict === 'yes';
    });
    expect(yes).toBeGreaterThan(0.5);
    expect(yes).toBeLessThan(0.7);
  });

  test('сами не приходят — только скорая', () => {
    for (let seed = 1; seed <= 4000; seed++) {
      const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ['dept.therapy'], season: 'winter', walkIn: true });
      expect(p.truth.conditions[0].id).not.toBe(SEPSIS);
    }
  }, 30_000);
});

describe('диагноз: источник угадан — частично', () => {
  const lungs = people(1, { source: 'lungs' })[0];
  const urinary = people(1, { source: 'urinary' })[0];

  test('сепсис — верно; пневмония при очаге в лёгких и пиелонефрит при мочевом — частично; чужой очаг — неверно', () => {
    expect(verdictOf(db, SEPSIS, lungs)).toBe('correct');
    expect(verdictOf(db, 'cond.pneumonia_cap', lungs)).toBe('partly');
    expect(verdictOf(db, 'cond.pyelonephritis', urinary)).toBe('partly');
    expect(verdictOf(db, 'cond.pyelonephritis', lungs)).toBe('wrong');
    expect(verdictOf(db, 'cond.pneumonia_cap', urinary)).toBe('wrong');
    // и наоборот — нет: у пневмонии сепсис не «частично»
    const pneumonia = generatePatient(db, 5, { department: 'dept.therapy', departments: ED, season: 'winter', primary: 'cond.pneumonia_cap' });
    expect(verdictOf(db, SEPSIS, pneumonia)).toBe('wrong');
  });
});

describe('сроки от правила', () => {
  const at = { roomType: () => undefined, bedside: () => false, can: () => true };
  const arrive = 600;
  const febrile = (params: Record<string, string>) => ({ ...people(1, params)[0], complaints: ['sym.fever_hx'] });

  test('шок: антибиотик в первый час от того, как qSOFA дал 2 балла; без шока — 3 часа, кроме давления ниже 90', () => {
    expect(db.targets[SHOCK_T]).toMatchObject({ from: 'rule', rule: QSOFA, findings: ['vital.bp_low'], treatments: [ABX], minutes: 60 });
    expect(db.targets[SEPSIS_T]).toMatchObject({ from: 'rule', rule: QSOFA, except: ['vital.bp_low'], treatments: [ABX], minutes: 180 });
    expect(T.spikes.patient.targetLine(db.targets[SHOCK_T].name.ru, 42, 60, db.targets[SHOCK_T].texts.from!.ru, db.targets[SHOCK_T].texts.after!.ru))
      .toBe('Антибиотик при септическом шоке: через 42 мин после того, как qSOFA дал 2 балла — в срок');
  });

  test('отсчёт — с результата, после которого правило сказало «да»; до него срока нет', () => {
    const patient = febrile({ shock: 'yes' });
    const vitals = { exam: 'exam.vitals', step: 0, at: arrive + 5 * 60, obs: [seen('vital.bp_low', 'exam.vitals'), seen('vital.bp_100', 'exam.vitals'), seen('vital.tachypnea', 'exam.vitals', false)] };
    const neuro = { exam: 'exam.neuro_exam', step: 1, at: arrive + 20 * 60, obs: [seen('sign.gcs_low', 'exam.neuro_exam')] };
    const before = { patient, arriveT: arrive, results: [vitals], bay: undefined };
    // один балл — давление; срока ещё нет
    expect(targetsFor(db, before, at).map(t => t.id)).not.toContain(SHOCK_T);
    const p = { ...before, results: [vitals, neuro] };
    const shock = db.targets[SHOCK_T];
    expect(targetsFor(db, p, at).map(t => t.id)).toEqual([SHOCK_T]);
    expect(targetStart(db, p, shock)).toBe(neuro.at);
    // идёт: через 30 минут после оглушения — 30 минут в запасе
    expect(dueIn(db, p, at, neuro.at + 30 * 60)).toBe(30);
    // антибиотик назначен через 50 минут от «да» — в срок; не назначили — срок не считают: это «не сделано» в лечении
    const decision = { t: neuro.at + 50 * 60, plan: { treatments: [ABX, CULTURE, BALANCED, NORE], setting: 'icu' as const } };
    expect(minutesTo(db, p, shock, decision)).toBe(50);
    expect(targetResults(db, p, at, decision)).toEqual([{ id: SHOCK_T, minutes: 50, limit: 60, grade: 'A' }]);
    expect(targetResults(db, p, at, { ...decision, plan: { treatments: [CULTURE], setting: 'icu' } })).toEqual([]);
  });

  test('без шока — 3 часа; без жара, озноба и температуры — сроков нет', () => {
    const patient = febrile({ shock: 'no' });
    const vitals = { exam: 'exam.vitals', step: 0, at: arrive + 5 * 60, obs: [seen('vital.bp_100', 'exam.vitals'), seen('vital.tachypnea', 'exam.vitals'), seen('vital.bp_low', 'exam.vitals', false)] };
    const p = { patient, arriveT: arrive, results: [vitals], bay: undefined };
    expect(targetsFor(db, p, at).map(t => t.id)).toEqual([SEPSIS_T]);
    expect(dueIn(db, p, at, vitals.at)).toBe(180);
    const cough = { ...p, patient: { ...patient, complaints: ['sym.cough'] }, results: [{ ...vitals, obs: [...vitals.obs, seen('vital.fever', 'exam.vitals', false)] }] };
    expect(targetsFor(db, cough, at)).toEqual([]);
  });

  test('разумный врач решает до конца срока: при шоке — час от первого признака правила', () => {
    const who = { age: 70, sex: 'f' as const };
    const obs = [seen('sym.fever_hx', 'complaint'), seen('vital.bp_low', 'exam.vitals'), seen('vital.bp_100', 'exam.vitals'), seen('sign.gcs_low', 'exam.neuro_exam')];
    expect(decisionLimit(db, obs, ['sym.fever_hx'], 0, () => 15, who)).toBe(45);
    // правило «нет» — срока нет
    expect(decisionLimit(db, obs.slice(0, 3), ['sym.fever_hx'], 0, () => 15, who)).toBeUndefined();
  });
});

describe('тактика и разбор', () => {
  const xs = people(600);
  const pick = (f: (q: Record<string, string>) => boolean) => xs.find(p => f(paramsOf(p)))!;
  const warm = pick(q => q.shock === 'no' && q.spo2_below90 === 'no');
  const shock = pick(q => q.shock === 'yes' && q.spo2_below90 === 'no');
  const hypox = pick(q => q.shock === 'no' && q.spo2_below90 === 'yes');
  const ev = (p: Patient, x: Plan, venue: Venue = BAY) => evaluatePlan(db, p, x, truthful(p, ALL), venue);

  test('обязательно: посевы крови, антибиотик и раствор — сбалансированный первый; при шоке — норэпинефрин; ПИТ', () => {
    expect(ev(warm, plan([])).requireMissing).toEqual([ABX, BALANCED, CULTURE]);
    const e = ev(warm, plan([CULTURE, ABX, BALANCED]));
    expect({ missing: e.requireMissing, setting: e.setting.recommended }).toEqual({ missing: [], setting: 'icu' });
    // «Инфузионная терапия» — тоже растворы электролитов: из группы хватит одного
    expect(ev(warm, plan([CULTURE, ABX, 'tx.iv_fluids'])).requireMissing).toEqual([]);
    expect(ev(shock, plan([CULTURE, ABX, BALANCED])).requireMissing).toEqual([NORE]);
    expect(ev(shock, plan([CULTURE, ABX, BALANCED, NORE])).requireMissing).toEqual([]);
    expect(ev(hypox, plan([CULTURE, ABX, BALANCED])).requireMissing).toEqual(['tx.oxygen_mask']);
  });

  test('до перевода — посевы, антибиотик, раствор и при шоке норэпинефрин, если у постели монитор', () => {
    const missing = (p: Patient, venue: Venue) => ev(p, plan([], 'transfer'), venue).beforeTransferMissing;
    expect(missing(shock, BAY)).toEqual([ABX, BALANCED, CULTURE, NORE]);
    expect(missing(shock, {})).toEqual([ABX, BALANCED, CULTURE]);
  });

  test('допамин и антибиотики внутрь — не нужно', () => {
    for (const tx of ['tx.dopamine', 'tx.amoxicillin', 'tx.fluoroquinolone', 'tx.macrolide']) expect(txRole(db, SEPSIS, tx, paramsOf(shock))).toBe('notIndicated');
    expect([txRole(db, SEPSIS, ABX, paramsOf(warm)), txRole(db, SEPSIS, NORE, paramsOf(shock))]).toEqual(['require', 'require']);
  });

  test('действие: антибиотик вылечивает без шока у 88, при шоке у 62 из 100 (EpiSEP); без лечения хуже — при шоке в первые сутки', () => {
    const p = (x: Patient, txs: Id[]) => curesOf(db, { id: SEPSIS, params: paramsOf(x) }, txs).map(e => e.p);
    expect(p(warm, [ABX])).toEqual([8800]);
    expect(p(shock, [ABX, NORE, BALANCED])).toEqual([6200]);
    expect(p(warm, ['tx.amoxicillin', BALANCED])).toEqual([]);
    expect(untreatedOf(db, { id: SEPSIS, params: paramsOf(shock) })).toMatchObject({ p: 9500, days: [0, 1] });
    expect(untreatedOf(db, { id: SEPSIS, params: paramsOf(warm) })).toMatchObject({ p: 7500, days: [1, 3] });
  });
});

describe('лактат при других шоках', () => {
  const share = (cond: Id, params: Record<string, string>, n = 300) => {
    let k = 0;
    for (let seed = 1; seed <= n; seed++) {
      const p = generatePatient(db, seed, { department: db.conditions[cond].department, departments: ED, season: 'winter', primary: cond, params });
      if (p.truth.findings.some(f => f.f === 'lab.lactate_high' && f.cause === cond)) k++;
    }
    return k / n;
  };

  test('кардиогенный шок (Killip IV, «холодная» ОДСН) и обструктивный (ТЭЛА с шоком) — обычно; без шока — нет', () => {
    for (const [cond, params] of [['cond.acs', { killip: 'iv' }], ['cond.adhf', { type: 'cold' }], ['cond.pe', { shock: 'yes' }]] as const) {
      expect(Math.abs(share(cond, params) - 0.75)).toBeLessThan(0.08);
    }
    expect([share('cond.acs', { killip: 'i' }), share('cond.adhf', { type: 'congestion' }), share('cond.pe', { shock: 'no' })]).toEqual([0, 0, 0]);
  });
});

describe('энциклопедия', () => {
  test('где лечить — ПИТ, без неё — перевод; обязательно — посевы, антибиотик и раствор; при шоке — норэпинефрин', () => {
    const x = article(db, SEPSIS)!;
    expect(x.blocks.find(b => b.key === 'where')!.text!.slice(0, 2)).toEqual(['Обычно — палата интенсивной терапии.', 'Своей палаты интенсивной терапии нет — скорая, больница.']);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Обязательно']).toEqual([CULTURE, ABX]);
    expect(rows['Обязательно — одно из']).toEqual([BALANCED, 'tx.iv_fluids']);
    expect(rows['Обязательно, при шоке — верхнем давлении ниже 90']).toEqual([NORE]);
    expect(rows['Обязательно до перевода']).toEqual([CULTURE, ABX]);
    // условия признаков — словами: очаг и органная дисфункция
    const signs = JSON.stringify(x.blocks.find(b => b.key === 'signs'));
    for (const w of ['при очаге в лёгких', 'при очаге в мочевых путях', 'при поражении почек', 'при оглушении']) expect(signs).toContain(w);
    expect(signs).not.toContain('"yes"');
  });
});

describe('разумный врач', () => {
  const exams = Object.keys(db.exams).sort();
  function run(p: Patient, venue: Venue, departments: Id[]) {
    const cands = candidatesOf(db, departments);
    const obs: Observation[] = complaintObservations(p);
    const done: Id[] = [];
    let phase: DoctorPhase = {};
    const rng = Rng.seeded(p.seed).fork('doctor');
    for (let k = 0; k < 40; k++) {
      const minutes = done.reduce((acc, id) => acc + examMinutes(db.exams[id]), 0);
      const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...venue, minutes } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }

  test('у постели в приёмном: сепсис узнаёт; посевы, антибиотик, раствор, при шоке — норэпинефрин; ПИТ', () => {
    const xs = people(60, {}, 8_400_001);
    let right = 0;
    for (const p of xs) {
      const r = run(p, BAY, ED);
      if (r.diagnosis !== SEPSIS) continue;
      right++;
      // кислород и норэпинефрин — по тому, что показали пульсоксиметр и тонометр: они ошибаются, а разбор судит по правде
      const low = r.obs.some(o => o.f === 'vital.bp_low' && o.shown);
      const missing = evaluatePlan(db, p, r.plan, r.obs, BAY).requireMissing.filter(tx => tx !== 'tx.oxygen_mask' && (low || tx !== NORE));
      expect({ seed: p.seed, missing, setting: r.plan.setting }).toEqual({ seed: p.seed, missing: [], setting: 'icu' });
    }
    expect(right / xs.length).toBeGreaterThan(0.85);
  }, 60_000);
});
