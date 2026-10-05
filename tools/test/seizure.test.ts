// Судорожный приступ и эпилептический статус (spec 2026-10-chapter-3, часть 44в): приступ к приезду закончился —
// глюкометр, ЭКГ, неврологический осмотр и расспрос очевидцев; впервые в жизни — КТ головы и палата, при известной
// эпилепсии — свой препарат без пропусков и домой. Судороги не прекращаются — статус: бензодиазепин за 5 минут от
// поступления, кислород при сатурации ниже 90 %, ПИТ. Источник — 741_1.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { paramBeliefs } from '../../src/engine/med/infer';
import { curesOf, evaluatePlan, type Plan, settingFit, txRole, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { choosePlan, decisionLimit, type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { targetResults, type TargetPlace, targetsFor } from '../../src/engine/shift/targets';
import { txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const SEIZURE = 'cond.seizure';
const STATUS = 'cond.status_epilepticus';
const FIT = 'sym.seizure';
const ONGOING = 'sym.seizure_ongoing';
const POSTICTAL = 'sign.postictal';
const STUPOR = 'sign.gcs_low';
const FIRST = 'hx.first_seizure';
const EPILEPSY = 'hx.epilepsy';
const MISSED = 'hx.missed_aed';
const SPO2 = 'vital.spo2_low';
const ASK = 'exam.ask_seizure';
const NEURO = 'exam.neuro_exam';
const GLUCO = 'exam.glucometer';
const ECG = 'exam.ecg';
const CT = 'exam.ct_head';
const VITALS = 'exam.vitals';
const OWN = 'tx.aed_own';
const BENZO = 'tx.benzodiazepine';
const VALPROATE = 'tx.valproate_iv';
const O2 = 'tx.oxygen_mask';
const LYSIS = 'tx.thrombolysis_stroke';
const RULE = 'rule.ct_seizure';
const TARGET = 'target.status_benzo';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: ['eq.monitor_defib'], icu: true, ward: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
/** Привезла скорая (часть 27): больные приступом и статусом — со скорой. */
function people(id: Id, n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = generatePatient(db, seed, { department: 'dept.neurology', departments: ED, season: 'winter', primary: id, params, carried: db.economy.ambulance.weight });
    if (p.age >= db.conditions[id].age.min) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true, value?: number): Observation => ({ f, shown: on, exam, ...(value !== undefined ? { value } : {}) });
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
const roles = (id: Id, params: Record<string, string>, txs: Id[]) => txs.map(tx => txRole(db, id, tx, params));
/** Всё, что о больном знают расспрос и осмотр, — как есть. */
const truthful = (p: Patient): Observation[] => [
  ...complaintObservations(p),
  ...[FIRST, EPILEPSY, MISSED].map(f => seen(f, ASK, has(p, f))),
  seen(POSTICTAL, NEURO, has(p, POSTICTAL)),
  ...(p.truth.values[SPO2] !== undefined ? [seen(SPO2, VITALS, has(p, SPO2), p.truth.values[SPO2])] : []),
];

describe('каталог', () => {
  test('приступ: R56.8, неврология, нервы, тяжёлое, диагноз клинический; «редко», с 18 лет, чаще в 20–80, алкоголь ×1,5; крови на КТ при нём не бывает', () => {
    const c = db.conditions[SEIZURE];
    expect(c).toMatchObject({ icd10: 'R56.8', department: 'dept.neurology', system: 'nerves', severity: 'serious', confirm: 'clinical', weight: 30 });
    expect(c.arrival).toBeUndefined();
    expect(c.age).toMatchObject({ min: 18, peak: [20, 80] });
    expect(c.risks).toEqual([{ id: 'risk.alcohol', x: 1.5 }]);
    expect(c.masks).toEqual(['img.ct_blood']);
    expect(c.differential).toEqual(['cond.hypoglycemia', 'cond.av_block', 'cond.stroke_ischemic']);
    expect(c.params).toEqual({ history: { first: 40, epilepsy: 60 } });
  });

  test('статус: G41.0, критическое, только со скорой, «единичные случаи»; чаще после 60 и у мужчин; красный флаг — судороги не прекращаются', () => {
    const c = db.conditions[STATUS];
    expect(c).toMatchObject({ icd10: 'G41.0', department: 'dept.neurology', system: 'nerves', severity: 'critical', arrival: 'ambulance', confirm: 'clinical', weight: 1 });
    expect(c.age).toMatchObject({ min: 18, peak: [60, 85] });
    expect(c.sex).toEqual({ m: 1.4, f: 1 });
    expect(c.redFlags).toEqual([ONGOING]);
    expect(c.differential).toEqual([SEIZURE, 'cond.hypoglycemia']);
    expect(c.params).toEqual({ history: { first: 50, epilepsy: 50 }, spo2_below90: { no: 85, yes: 15 } });
    expect(c.derived).toEqual({ spo2_below90: { f: SPO2, below: 90 } });
  });

  test('тактика приступа: при эпилепсии — свой препарат, впервые — не нужен; бензодиазепин и вальпроевая кислота после закончившегося приступа не нужны; тромболизис — вред', () => {
    const txs = [OWN, BENZO, VALPROATE, LYSIS];
    expect(roles(SEIZURE, { history: 'epilepsy' }, txs)).toEqual(['firstLine', 'notIndicated', 'notIndicated', 'harmful']);
    expect(roles(SEIZURE, { history: 'first' }, txs)).toEqual(['notIndicated', 'notIndicated', 'notIndicated', 'harmful']);
  });

  test('тактика статуса: бензодиазепин — первая линия, вальпроевая кислота — можно, свой препарат при эпилепсии облегчает, кислород при сатурации ниже 90 — обязательно, тромболизис — вред', () => {
    const txs = [BENZO, VALPROATE, OWN, O2, LYSIS];
    expect(roles(STATUS, { history: 'first', spo2_below90: 'no' }, txs)).toEqual(['firstLine', 'acceptable', 'notIndicated', 'notIndicated', 'harmful']);
    expect(roles(STATUS, { history: 'epilepsy', spo2_below90: 'yes' }, txs)).toEqual(['firstLine', 'acceptable', 'supportive', 'require', 'harmful']);
  });

  test('где лечить: приступ впервые — палата, при эпилепсии — дома, палата тоже не ошибка; статус — ПИТ', () => {
    const s = db.conditions[SEIZURE].treatment!.setting;
    expect([s.default, s.param, s.also]).toEqual(['home', { name: 'history', map: { first: 'ward', epilepsy: 'home' } }, [{ when: { history: ['epilepsy'] }, settings: ['ward'] }]]);
    expect(db.conditions[STATUS].treatment!.setting.default).toBe('icu');
    expect([db.conditions[SEIZURE].stay, db.conditions[STATUS].stay]).toEqual([[2, 5], [3, 7]]);
  });

  test('обследования: расспрос — при приступе; глюкометр — при приступе и статусе; ЭКГ и неврологический осмотр — при приступе; осмотр видит постприступное состояние', () => {
    expect(db.exams[ASK].routineFor).toEqual([FIT]);
    expect(db.exams[ASK].complaints).toEqual([FIT, ONGOING]);
    expect(db.exams[GLUCO].routineFor).toEqual(expect.arrayContaining([FIT, ONGOING]));
    expect(db.exams[ECG].routineFor).toContain(FIT);
    expect(db.exams[NEURO].routineFor).toContain(FIT);
    const k = Object.fromEntries([...db.exams[ASK].checks, ...db.exams[NEURO].checks].map(c => [c.f, [c.sens, c.spec]]));
    expect([k[FIRST], k[EPILEPSY], k[MISSED], k[POSTICTAL]]).toEqual([[9800, 9800], [9800, 9900], [9000, 9700], [9500, 9700]]);
  });

  test('правило КТ: при приступе с 18 лет; впервые в жизни — нужна, бывали раньше — нет, не спросили — не решено', () => {
    const r = db.rules[RULE];
    expect([r.complaints, r.any, r.ageMin, r.exams, r.about]).toEqual([[FIT], [FIRST], 18, [CT], [SEIZURE]]);
    const who = { age: 40, sex: 'f' as const };
    expect(checkRule(r, who, knownOf([seen(FIRST, ASK)])).verdict).toBe('yes');
    expect(checkRule(r, who, knownOf([seen(FIRST, ASK, false)])).verdict).toBe('no');
    expect(checkRule(r, who, knownOf([])).verdict).toBe('unknown');
  });

  test('срок: бензодиазепин за 5 минут от поступления — у лежащих в смотровой приёмного с непрекращающимися судорогами', () => {
    expect(db.targets[TARGET]).toMatchObject({ complaints: [ONGOING], findings: [], room: 'room.emergency', exams: [], treatments: [BENZO], settings: [], from: 'arrival', minutes: 5 });
  });

  test('лечение по группам: бензодиазепин, вальпроевая кислота и свой препарат — «Противосудорожные»', () => {
    expect([BENZO, VALPROATE, OWN].map(tx => txGroupOfClass(db.treatments[tx].class))).toEqual(['seizures', 'seizures', 'seizures']);
  });
});

describe('больные', () => {
  const fits = people(SEIZURE, 1500);
  const statuses = people(STATUS, 600);
  const part = (ys: Patient[], f: (p: Patient) => boolean) => ys.filter(f).length / ys.length;

  test('приступ: у каждого — жалоба на приступ и постприступное состояние; впервые — около 40 из 100; эпилепсия и «впервые» — по параметру, пропуск лекарства — только при эпилепсии', () => {
    for (const p of fits) {
      const first = paramsOf(p).history === 'first';
      expect({ seed: p.seed, fit: p.complaints.includes(FIT), postictal: has(p, POSTICTAL), first: has(p, FIRST), epilepsy: has(p, EPILEPSY), missed: has(p, MISSED) && first, ongoing: has(p, ONGOING) })
        .toEqual({ seed: p.seed, fit: true, postictal: true, first, epilepsy: !first, missed: false, ongoing: false });
    }
    expect(Math.abs(part(fits, p => paramsOf(p).history === 'first') - 0.4)).toBeLessThan(0.04);
    const epi = fits.filter(p => paramsOf(p).history === 'epilepsy');
    expect(Math.abs(part(epi, p => has(p, MISSED)) - 0.5)).toBeLessThan(0.06);
  });

  test('статус: у каждого — непрекращающиеся судороги и оглушение; сатурация ниже 90 — по измеренной', () => {
    for (const p of statuses) {
      const v = p.truth.values[SPO2];
      expect({ seed: p.seed, ongoing: p.complaints.includes(ONGOING), stupor: has(p, STUPOR), fit: has(p, FIT), spo2: paramsOf(p).spo2_below90 })
        .toEqual({ seed: p.seed, ongoing: true, stupor: true, fit: false, spo2: has(p, SPO2) && v !== undefined && v < 90 ? 'yes' : 'no' });
    }
    expect(part(statuses, p => paramsOf(p).spo2_below90 === 'yes')).toBeGreaterThan(0.05);
    expect(part(statuses, p => paramsOf(p).spo2_below90 === 'yes')).toBeLessThan(0.25);
  });
});

describe('вывод', () => {
  const who = { age: 45, sex: 'm' as const };

  test('впервые или эпилепсия — по расспросу: не спрашивали — по долям, сказали — почти наверняка', () => {
    const p = (obs: Observation[]) => Object.fromEntries(paramBeliefs(db, SEIZURE, 'history', obs, who).map(b => [b.value, b.p]));
    expect(p([])).toEqual({ first: 0.4, epilepsy: 0.6 });
    // расспрос ошибается у 1–2 из 100 — уверенность не единица, но выше 0,99
    expect(p([seen(FIRST, ASK), seen(EPILEPSY, ASK, false)]).first).toBeGreaterThan(0.99);
    expect(p([seen(FIRST, ASK, false), seen(EPILEPSY, ASK)]).epilepsy).toBeGreaterThan(0.99);
  });

  test('план: приступ впервые — без лекарств и в палату; при эпилепсии — свой препарат и домой; статус — бензодиазепин и ПИТ, при сатурации ниже 90 — и кислород', () => {
    const fit = [seen(FIT, 'complaint'), seen(POSTICTAL, NEURO)];
    expect(choosePlan(db, SEIZURE, [...fit, seen(FIRST, ASK), seen(EPILEPSY, ASK, false)], who, BAY)).toEqual({ treatments: [], setting: 'admit' });
    expect(choosePlan(db, SEIZURE, [...fit, seen(FIRST, ASK, false), seen(EPILEPSY, ASK)], who, BAY)).toEqual({ treatments: [OWN], setting: 'home' });
    const status = [seen(ONGOING, 'complaint')];
    expect(choosePlan(db, STATUS, [...status, seen(SPO2, VITALS, false, 96)], who, BAY)).toEqual({ treatments: [BENZO], setting: 'icu' });
    expect(choosePlan(db, STATUS, [...status, seen(SPO2, VITALS, true, 86)], who, BAY)).toEqual({ treatments: [BENZO, O2], setting: 'icu' });
  });
});

describe('сроки', () => {
  const p = people(STATUS, 1, {}, 9_100_001)[0];
  const place: TargetPlace = { roomType: () => 'room.emergency', bedside: () => true, can: () => true };
  const visit = { patient: p, bay: { room: 'r1', bed: 0 }, arriveT: 600, results: [] };
  const at = (minutes: number, treatments: Id[]) => targetResults(db, visit, place, { t: 600 + minutes * 60, plan: { treatments, setting: 'icu' } }).map(r => [r.id, r.minutes, r.grade]);

  test('статус в смотровой приёмного — срок бензодиазепина; приступ, который закончился, — без срока', () => {
    expect(targetsFor(db, visit, place).map(t => t.id)).toEqual([TARGET]);
    expect(targetsFor(db, { ...visit, bay: undefined }, place)).toEqual([]);
    const fit = people(SEIZURE, 1, {}, 9_100_001)[0];
    expect(targetsFor(db, { ...visit, patient: fit }, place).map(t => t.id)).not.toContain(TARGET);
  });

  test('бензодиазепин на 3-й минуте — в срок, на 7-й — B, на 12-й — D; не назначили — срока нет, это «не назначено»', () => {
    expect(at(3, [BENZO])).toEqual([[TARGET, 3, 'A']]);
    expect(at(7, [BENZO])).toEqual([[TARGET, 7, 'B']]);
    expect(at(12, [BENZO])).toEqual([[TARGET, 12, 'D']]);
    expect(at(3, [VALPROATE])).toEqual([]);
  });

  test('срок решения разумного врача: 5 минут от прихода, прошло 2 — осталось 3; у закончившегося приступа срока нет', () => {
    expect(decisionLimit(db, [], [ONGOING])).toBe(5);
    expect(decisionLimit(db, [], [ONGOING], 2)).toBe(3);
    expect(decisionLimit(db, [], [FIT])).toBeUndefined();
  });
});

describe('тактика и разбор', () => {
  const first = people(SEIZURE, 1, { history: 'first' }, 9_200_001)[0];
  const epi = people(SEIZURE, 1, { history: 'epilepsy' }, 9_200_001)[0];
  // сатурация — производный параметр: по измеренной, а не по заданной доле
  const statuses = people(STATUS, 200, {}, 9_200_001);
  const status = statuses.find(p => paramsOf(p).spo2_below90 === 'no')!;
  const low = statuses.find(p => paramsOf(p).spo2_below90 === 'yes')!;
  const ev = (p: Patient, x: Plan) => evaluatePlan(db, p, x, truthful(p), BAY);
  const harmful = (p: Patient, x: Plan) => ev(p, x).roles.filter(r => r.role === 'harmful').map(r => r.tx);

  test('приступ впервые: в палату — верно, домой — нет; свой препарат — не нужен; тромболизис — вред', () => {
    const ok = ev(first, plan([], 'admit'));
    expect([ok.setting.recommended, settingFit(ok.setting.recommended, 'admit', ok.setting.also)]).toEqual(['ward', 'ok']);
    const home = ev(first, plan([]));
    expect(settingFit(home.setting.recommended, 'home', home.setting.also)).not.toBe('ok');
    expect(ev(first, plan([OWN], 'admit')).roles.find(r => r.tx === OWN)?.role).toBe('notIndicated');
    expect(harmful(first, plan([LYSIS], 'admit'))).toEqual([LYSIS]);
  });

  test('при эпилепсии: свой препарат и домой — верно, в палату — тоже не ошибка; без препарата — не лечили', () => {
    const ok = ev(epi, plan([OWN]));
    expect([ok.effective, ok.setting.recommended, settingFit(ok.setting.recommended, 'admit', ok.setting.also)]).toEqual([true, 'home', 'ok']);
    expect(ev(epi, plan([])).effective).toBe(false);
  });

  test('статус: бензодиазепин и ПИТ — верно; только вальпроевая кислота — не первая линия; при сатурации ниже 90 без кислорода — обязательное не назначено', () => {
    const ok = ev(status, plan([BENZO], 'icu'));
    expect({ effective: ok.effective, require: ok.requireMissing, setting: ok.setting.recommended }).toEqual({ effective: true, require: [], setting: 'icu' });
    expect(ev(status, plan([VALPROATE], 'icu')).effective).toBe(false);
    expect(ev(low, plan([BENZO], 'icu')).requireMissing).toEqual([O2]);
    expect(ev(low, plan([BENZO, O2], 'icu')).requireMissing).toEqual([]);
    expect(harmful(status, plan([BENZO, LYSIS], 'icu'))).toEqual([LYSIS]);
  });

  test('действие: свой препарат при эпилепсии — обычно; бензодиазепин при статусе — часто за 2–5 дней; без лечения эпилепсия иногда даёт статус, статус почти всегда хуже', () => {
    expect(curesOf(db, { id: SEIZURE, params: { history: 'epilepsy' } }, [OWN]).map(e => [e.p, ...e.days])).toEqual([[7500, 0, 0]]);
    expect(curesOf(db, { id: SEIZURE, params: { history: 'first' } }, [OWN])).toEqual([]);
    expect(curesOf(db, { id: STATUS, params: { history: 'first', spo2_below90: 'no' } }, [BENZO]).map(e => [e.p, ...e.days])).toEqual([[5000, 2, 5]]);
    expect(untreatedOf(db, { id: SEIZURE, params: { history: 'epilepsy' } })).toMatchObject({ p: 2500, days: [0, 3], as: STATUS });
    expect(untreatedOf(db, { id: SEIZURE, params: { history: 'first' } })).toBeUndefined();
    expect(untreatedOf(db, { id: STATUS, params: { history: 'first', spo2_below90: 'no' } })).toMatchObject({ p: 9500, days: [0, 0] });
  });
});

describe('энциклопедия', () => {
  test('приступ: где лечить — по тому, впервые ли; правило КТ; с чем спутать — гипогликемия, АВ-блокада, инсульт', () => {
    const x = article(db, SEIZURE)!;
    expect(x.blocks.find(b => b.key === 'where')!.text).toEqual(['Обычно — дома.', 'При первом в жизни приступе — в стационаре.', 'При известной эпилепсии — можно и в стационаре.', 'В стационаре обычно 2–5 дней.']);
    expect(x.blocks.find(b => b.key === 'rules')!.refs!.map(r => r.id)).toEqual([RULE]);
    expect(x.blocks.find(b => b.key === 'similar')!.refs!.map(r => r.id)).toEqual(['cond.av_block', 'cond.hypoglycemia', 'cond.stroke_ischemic']);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Не нужно, при первом в жизни приступе']).toEqual([OWN]);
  });

  test('статус: ПИТ, без своей — скорая; кислород — при сатурации ниже 90 %, свой препарат — при эпилепсии', () => {
    const x = article(db, STATUS)!;
    expect(x.blocks.find(b => b.key === 'where')!.text).toEqual(['Обычно — палата интенсивной терапии.', 'Своей палаты интенсивной терапии нет — скорая, больница.', 'В стационаре обычно 3–7 дней.']);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Первая линия']).toEqual([BENZO]);
    expect(rows['Можно также']).toEqual([VALPROATE]);
    expect(rows['Обязательно, при сатурации ниже 90 %']).toEqual([O2]);
    expect(rows['Облегчить состояние, при известной эпилепсии']).toEqual([OWN]);
  });
});

describe('разумный врач', () => {
  const exams = Object.keys(db.exams).sort();
  function run(p: Patient) {
    const cands = candidatesOf(db, ED);
    const rng = Rng.seeded(p.seed).fork('doctor');
    // привезла скорая: фельдшер передал витальные (часть 27)
    const obs: Observation[] = [...complaintObservations(p), ...runExam(db, p, VITALS, rng.fork('paramedic'))];
    const done: Id[] = [VITALS];
    let phase: DoctorPhase = {};
    let minutes = 0;
    for (let k = 0; k < 50; k++) {
      minutes = done.slice(1).reduce((acc, id) => acc + examMinutes(db.exams[id]), 0);
      const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...BAY, minutes } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs, minutes };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }
  const shown = (obs: Observation[], f: Id) => obs.some(o => o.f === f && o.shown);

  test('приступ впервые: глюкометр, ЭКГ, неврологический осмотр и расспрос; КТ — раз приступ впервые; без лекарств и в палату', () => {
    for (const p of people(SEIZURE, 30, { history: 'first' }, 8_600_001)) {
      const r = run(p);
      expect({ seed: p.seed, diagnosis: r.diagnosis, routine: [GLUCO, ECG, NEURO, ASK].every(e => r.done.includes(e)), ct: r.done.includes(CT), plan: r.plan })
        .toEqual({ seed: p.seed, diagnosis: SEIZURE, routine: true, ct: shown(r.obs, FIRST), plan: { treatments: [], setting: 'admit' } });
    }
  }, 120_000);

  test('при эпилепсии: КТ не нужна; свой препарат и домой, если расспрос узнал об эпилепсии', () => {
    let home = 0;
    const xs = people(SEIZURE, 30, { history: 'epilepsy' }, 8_600_001);
    for (const p of xs) {
      const r = run(p);
      expect({ seed: p.seed, diagnosis: r.diagnosis, ct: r.done.includes(CT), benzo: r.plan.treatments.includes(BENZO) }).toEqual({ seed: p.seed, diagnosis: SEIZURE, ct: shown(r.obs, FIRST), benzo: false });
      if (shown(r.obs, EPILEPSY) && !shown(r.obs, FIRST)) {
        expect({ seed: p.seed, plan: r.plan }).toEqual({ seed: p.seed, plan: { treatments: [OWN], setting: 'home' } });
        home++;
      }
    }
    // расспрос ошибается у 1–2 из 100 о каждом из двух признаков
    expect(home / xs.length).toBeGreaterThanOrEqual(0.85);
  }, 120_000);

  test('статус: бензодиазепин и ПИТ — в первые 5 минут, с глюкометром; КТ — потом; при сатурации ниже 90 — и кислород', () => {
    for (const p of people(STATUS, 40, {}, 8_600_001)) {
      const r = run(p);
      const v = r.obs.find(o => o.f === SPO2 && o.shown)?.value;
      expect({ seed: p.seed, diagnosis: r.diagnosis, in5: r.minutes <= 5, gluco: r.done.includes(GLUCO), ct: r.done.includes(CT), plan: r.plan })
        .toEqual({ seed: p.seed, diagnosis: STATUS, in5: true, gluco: true, ct: false, plan: { treatments: v !== undefined && v < 90 ? [BENZO, O2] : [BENZO], setting: 'icu' } });
    }
  }, 120_000);
});
