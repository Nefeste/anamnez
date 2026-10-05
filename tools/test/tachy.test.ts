// Тахикардии (spec 2026-10-chapter-3, часть 42б): наджелудочковая с узкими комплексами и желудочковая с
// широкими; пульс 150 и чаще — порог по ту же сторону от нормы, что «чаще 100»; без монитора у постели
// приступ не снять — ПИТ или скорая (`setting.without`); спутники кардиоверсии — только при фибрилляции
// (`companionsFor`); верапамил при широких комплексах — вред; строки и лента ЭКГ, сердцебиение «ровно»;
// разумный врач у постели и в кабинете.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { P_ONE, Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { choiceFor, evaluatePlan, harmsOf, type Plan, primaryOf, recommendedSetting, txAvailable, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import { complaintText, observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const SVT = 'cond.svt';
const VT = 'cond.vt';
const AF = 'cond.af';
const VAGAL = 'tx.vagal';
const ATP = 'tx.trifosadenine';
const VERA_IV = 'tx.verapamil_iv';
const VERA = 'tx.verapamil';
const PROC = 'tx.procainamide';
const CV = 'tx.cardioversion';
const AMIO = 'tx.amiodarone_iv';
const BB = 'tx.beta_blocker';
const UFH = 'tx.heparin_iv';
const PALP = 'sym.palpitations';
const SYNC = 'sym.syncope';
const TACHY = 'vital.tachycardia';
const FAST = 'vital.tachycardia_150';
const LOW = 'vital.bp_low';
const ECG_SVT = 'ecg.svt';
const ECG_VT = 'ecg.vt';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const gen = (primary: Id, seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary, params });
/** Больные в возрасте болезни; без астмы и сердечной недостаточности — противопоказания отдельно. */
function people(primary: Id, n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const min = db.conditions[primary].age.min;
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = gen(primary, seed, params);
    if (p.age >= min && !p.truth.conditions.some(c => c.id === 'cond.asthma') && !p.truth.risks.includes('risk.heart_failure')) out.push(p);
  }
  return out;
}
const one = (primary: Id, params: Record<string, string>) => people(primary, 1, params)[0];
const seen = (f: Id, exam: Id, on = true): Observation => ({ f, shown: on, exam });
/** ЭКГ и давление проверены, об астме и сердечной недостаточности спросили — как у пациента. */
const checked = (p: Patient): Observation[] => [
  ...complaintObservations(p),
  seen(ECG_SVT, 'exam.ecg', has(p, ECG_SVT)),
  seen(ECG_VT, 'exam.ecg', has(p, ECG_VT)),
  seen(LOW, 'exam.vitals', has(p, LOW)),
  seen('hx.asthma', 'exam.ask_chronic', has(p, 'hx.asthma')),
  seen('hx.heart_failure', 'exam.ask_chronic', has(p, 'hx.heart_failure')),
];
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });

describe('каталог', () => {
  test('наджелудочковая — терапия, средней тяжести, лечат дома; желудочковая — критическая, в ПИТ; диагноз — по ЭКГ', () => {
    expect(db.conditions[SVT]).toMatchObject({ department: 'dept.therapy', severity: 'moderate', confirm: ['exam.ecg'], redFlags: [LOW] });
    expect(db.conditions[VT]).toMatchObject({ department: 'dept.therapy', severity: 'critical', confirm: ['exam.ecg'], redFlags: [LOW, ECG_VT] });
    expect(db.conditions[SVT].treatment!.setting).toEqual({
      default: 'home', param: { name: 'unstable', map: { yes: 'icu', no: 'home' } }, without: { equipment: [MONITOR], setting: 'icu' },
    });
    expect(db.conditions[VT].treatment!.setting).toEqual({ default: 'icu' });
  });

  test('пульс 150 и чаще — то же измерение, что «чаще 100», и точность из него; ЭКГ различает ширину комплексов', () => {
    expect(db.findings[FAST].value).toMatchObject({ of: TACHY, present: [150, 210] });
    const vitals = db.exams['exam.vitals'].checks;
    expect(vitals.find(k => k.f === FAST)).toMatchObject({ sens: vitals.find(k => k.f === TACHY)!.spec, spec: P_ONE });
    expect(db.exams['exam.ecg'].checks.map(k => k.f)).toEqual(expect.arrayContaining([ECG_SVT, ECG_VT]));
    // после обморока — ЭКГ, пульс и давление каждому, как при сердцебиении; с частью 43в ЭКГ — и при одышке лёжа
    expect(db.exams['exam.ecg'].routineFor).toEqual([PALP, SYNC, 'sym.orthopnea']);
    expect(db.exams['exam.vitals'].routineFor).toEqual(expect.arrayContaining([PALP, SYNC]));
    expect(db.exams['exam.ask_general'].checks.map(k => k.f)).toEqual(expect.arrayContaining([PALP, SYNC]));
  });

  test('лекарства в вену и разряд — у постели с монитором; вагусные пробы — где угодно; спутники разряда и амиодарона — при фибрилляции', () => {
    for (const tx of [ATP, VERA_IV, PROC, CV, AMIO]) expect({ tx, at: db.treatments[tx].bedside?.equipment }).toEqual({ tx, at: [MONITOR] });
    expect(db.treatments[VAGAL].bedside).toBeUndefined();
    for (const tx of [CV, AMIO]) expect(db.treatments[tx].companionsFor).toEqual([AF]);
  });
});

describe('больные', () => {
  test('наджелудочковая: у каждого — сердцебиение ровно, пульс 150–210 и он же «чаще 100», узкие комплексы; нестабильный — с давлением ниже 90', () => {
    const xs = people(SVT, 1500);
    for (const p of xs) {
      expect(p.complaints).toContain(PALP);
      expect(p.truth.findings.find(f => f.f === PALP)!.attrs).toEqual({ rhythm: 'regular' });
      expect([TACHY, FAST, ECG_SVT, ECG_VT].map(f => has(p, f))).toEqual([true, true, true, false]);
      const v = p.truth.values[TACHY];
      expect(v >= 150 && v <= 210 && p.truth.values[FAST] === v).toBe(true);
      expect(has(p, LOW)).toBe(paramsOf(p).unstable === 'yes');
    }
    const unstable = xs.filter(p => paramsOf(p).unstable === 'yes').length / xs.length;
    expect(Math.abs(unstable - 0.05)).toBeLessThan(0.02);
  });

  test('желудочковая: «чаще 100» — у каждого, 150 и чаще — обычно, широкие комплексы; обморок — чаще у нестабильного', () => {
    const xs = people(VT, 1500);
    let fast = 0;
    const faint: Record<string, [number, number]> = { yes: [0, 0], no: [0, 0] };
    for (const p of xs) {
      expect([TACHY, ECG_VT, ECG_SVT].map(f => has(p, f))).toEqual([true, true, false]);
      const v = p.truth.values[TACHY];
      if (has(p, FAST)) fast++;
      expect(has(p, FAST) ? v >= 150 && v <= 210 : v >= 101 && v <= 128).toBe(true);
      const u = paramsOf(p).unstable;
      expect(has(p, LOW)).toBe(u === 'yes');
      faint[u][0]++;
      if (has(p, SYNC)) faint[u][1]++;
    }
    expect(Math.abs(fast / xs.length - 0.75)).toBeLessThan(0.04);
    expect(faint.yes[1] / faint.yes[0]).toBeGreaterThan(faint.no[1] / faint.no[0] + 0.15);
  });

  test('осмотр — одно число на двоих: пульс 180 — и «чаще 100», и «150 и чаще»; низкое давление по-прежнему снимает высокое', () => {
    const p = one(SVT, { unstable: 'yes' });
    const obs = runExam(db, p, 'exam.vitals', Rng.seeded(1).fork('vitals'), undefined, true);
    const a = obs.find(o => o.f === TACHY)!;
    const b = obs.find(o => o.f === FAST)!;
    expect([a.shown, b.shown, b.value]).toEqual([true, true, a.value]);
    expect(a.value).toBe(p.truth.values[TACHY]);
    expect([has(p, LOW), has(p, 'vital.bp_high')]).toEqual([true, false]);
  });
});

describe('тексты', () => {
  test('сердцебиение: при фибрилляции — неровно, при тахикардии — часто и ровно; запись из сохранения без ритма — неровно', () => {
    const o = (attrs?: Record<string, string>): Observation => ({ f: PALP, shown: true, exam: 'complaint', ...(attrs ? { attrs } : {}) });
    expect(db.findings[PALP].name.ru).toBe('Сердцебиение');
    expect(observationText(db, o({ rhythm: 'regular' }), 'f', 1)).toBe('Сердцебиение: сердце бьётся часто-часто и ровно');
    expect(observationText(db, o({ rhythm: 'irregular' }), 'f', 1)).toBe('Сердцебиение: сердце бьётся неровно, с перебоями');
    expect(observationText(db, o(), 'f', 1)).toBe('Сердцебиение: сердце бьётся неровно, с перебоями');
    const said = new Set(Array.from({ length: 20 }, (_, seed) => complaintText(db, o({ rhythm: 'regular' }), 'm', seed)));
    expect(said).toEqual(new Set(['Сердце колотится — часто-часто и ровно', 'Сердцебиение: сердце стучит часто-часто и ровно']));
    const af = generatePatient(db, 5, { department: 'dept.therapy', season: 'winter', primary: AF });
    expect(af.truth.findings.find(f => f.f === PALP)!.attrs).toEqual({ rhythm: 'irregular' });
  });

  test('обморок — по полу', () => {
    const o: Observation = { f: SYNC, shown: true, exam: 'complaint' };
    const said = (sex: 'm' | 'f') => new Set(Array.from({ length: 20 }, (_, seed) => complaintText(db, o, sex, seed)));
    expect(said('m')).toEqual(new Set(['Потерял сознание, упал, потом пришёл в себя', 'Был обморок — всё потемнело, очнулся уже на полу']));
    expect(said('f')).toEqual(new Set(['Потеряла сознание, упала, потом пришла в себя', 'Был обморок — всё потемнело, очнулась уже на полу']));
  });

  test('ЭКГ: узкие и широкие комплексы — своими строками; без фибрилляции — не «ритм синусовый»: при тахикардии он не синусовый', () => {
    expect(observationText(db, seen(ECG_SVT, 'exam.ecg'), 'm', 1)).toBe('Ритм частый и правильный, комплексы QRS узкие, зубцов P перед ними нет — наджелудочковая тахикардия');
    expect(observationText(db, seen(ECG_VT, 'exam.ecg'), 'm', 1)).toBe('Ритм частый, комплексы QRS широкие, больше 120 мс, без зубцов P перед ними — желудочковая тахикардия');
    expect(observationText(db, seen('ecg.af', 'exam.ecg', false), 'm', 1)).toBe('Фибрилляции и трепетания предсердий нет');
    expect(observationText(db, seen(FAST, 'exam.vitals'), 'm', 1)).toBe('Пульс очень частый: 150 в минуту и чаще');
  });

  test('лента: узкие или широкие комплексы, частота — по пульсу; пульс не мерили — своя частота тахикардии', () => {
    const view = (p: Patient, exams: Id[]) => {
      const arrived = exams.map((exam, i) => ({ exam, step: i + 1, at: 600 + i, obs: runExam(db, p, exam, Rng.seeded(3).fork(exam), undefined, true) }));
      return makeCaseView({
        version: 0, patient: p, clock: 700, minutesSpent: 0, money: 0, step: exams.length, pending: [], meanwhile: [], done: [],
        draft: { treatments: [], setting: 'home' }, arrived, departments: ED, difficulty: 'doctor',
      }).groups.find(g => g.exam === 'exam.ecg')!.image as { kind: string; ecg: { rhythm?: string; rate?: number } };
    };
    const svt = one(SVT, { unstable: 'no' });
    expect(view(svt, ['exam.vitals', 'exam.ecg'])).toMatchObject({ kind: 'ecg', ecg: { rhythm: 'svt', rate: svt.truth.values[TACHY] } });
    const alone = view(svt, ['exam.ecg']);
    expect([alone.ecg.rhythm, alone.ecg.rate]).toEqual(['svt', undefined]);
    expect(view(one(VT, { unstable: 'no' }), ['exam.ecg']).ecg.rhythm).toBe('vt');
  });
});

describe('тактика и разбор', () => {
  const stable = one(SVT, { unstable: 'no' });
  const shaky = one(SVT, { unstable: 'yes' });
  const vt = one(VT, { unstable: 'no' });
  const shock = one(VT, { unstable: 'yes' });
  const ev = (p: Patient, x: Plan, venue: Venue = BAY) => evaluatePlan(db, p, x, checked(p), venue);
  const grade = (p: Patient, x: Plan, venue: Venue = BAY) => scoreCase({
    verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev(p, x, venue),
    outcome: { kind: x.setting === 'home' ? 'recovered' : 'transferred', day: 0, cured: true }, selfLimiting: false, redFlags: [],
  });

  test('стабильная наджелудочковая у постели с монитором: вагусные пробы, затем трифосаденин — и домой', () => {
    const e = ev(stable, plan([VAGAL, ATP]));
    expect(e.roles).toEqual([{ tx: ATP, role: 'require' }, { tx: VAGAL, role: 'firstLine' }]);
    expect([e.requireMissing, e.companionsMissing, e.setting]).toEqual([[], [], { chosen: 'home', recommended: 'home' }]);
    expect(grade(stable, plan([VAGAL, ATP]))).toMatchObject({ treatment: 'A', setting: 'A', safety: 'A' });
    // одни вагусные пробы — приступ здесь не снят: трифосаденин обязателен; верапамил в вену или разряд — тоже снимают
    expect(ev(stable, plan([VAGAL])).requireMissing).toEqual([ATP]);
    for (const tx of [VERA_IV, CV]) expect(ev(stable, plan([VAGAL, tx])).requireMissing).toEqual([]);
    // таблетки приступ не снимают — можно, для профилактики; амиодарон — не нужно
    for (const tx of [BB, VERA]) expect(txRole(db, SVT, tx, paramsOf(stable))).toBe('acceptable');
    expect(txRole(db, SVT, AMIO, paramsOf(stable))).toBe('notIndicated');
  });

  test('в кабинете без монитора: трифосаденин, верапамил в вену и разряд не назначить — вагусные пробы, и на скорой', () => {
    for (const tx of [ATP, VERA_IV, CV, PROC]) expect(txAvailable(db, tx, {})).toBe(false);
    expect(txAvailable(db, VAGAL, {})).toBe(true);
    const e = ev(stable, plan([VAGAL], 'ambulance'), {});
    expect([e.requireMissing, e.setting.recommended]).toEqual([[], 'icu']);
    expect([choiceFor('icu', {}), choiceFor('icu', BAY)]).toEqual(['ambulance', 'icu']);
    expect(grade(stable, plan([VAGAL], 'ambulance'), {})).toMatchObject({ treatment: 'A', setting: 'A' });
    // домой из кабинета — меньше нужного; у постели с монитором — то же лечение дома в порядке
    expect(grade(stable, plan([VAGAL], 'home'), {}).setting).toBe('D');
    expect([recommendedSetting(db, stable, [], [MONITOR]), recommendedSetting(db, stable, [], [])]).toEqual(['home', 'icu']);
    // дома из кабинета приступ снимается реже: место ниже нужного — действие вдвое меньше
    const home = plan([VAGAL]);
    const cured = (venue: Venue) => Array.from({ length: 3000 }, (_, i) => observe(db, stable, home, ev(stable, home, venue), Rng.seeded(i).fork('o'))).filter(o => o.cured).length / 3000;
    expect(cured(BAY)).toBeGreaterThan(cured({}) * 1.6);
  });

  test('нестабильная наджелудочковая: разряд сразу и ПИТ; верапамил в вену при низком давлении — вредно, пробы и трифосаденин — не то', () => {
    const e = ev(shaky, plan([CV], 'icu'));
    expect([e.requireMissing, e.companionsMissing, e.setting.recommended]).toEqual([[], [], 'icu']);
    expect(grade(shaky, plan([CV], 'icu'))).toMatchObject({ treatment: 'A', setting: 'A' });
    expect(ev(shaky, plan([VAGAL, ATP], 'icu')).requireMissing).toEqual([CV]);
    expect(txRole(db, SVT, VERA_IV, paramsOf(shaky))).toBe('harmful');
    for (const tx of [VAGAL, ATP, BB, VERA]) expect({ tx, role: txRole(db, SVT, tx, paramsOf(shaky)) }).toEqual({ tx, role: 'notIndicated' });
    expect(harmsOf(db, primaryOf(shaky), [VERA_IV])).toEqual([{ tx: VERA_IV, p: 2500, days: [0, 0] }]);
    expect(harmsOf(db, primaryOf(stable), [VERA_IV])).toEqual([]);
  });

  test('трифосаденин при бронхиальной астме — противопоказан; верапамил в вену при сердечной недостаточности — тоже', () => {
    expect(db.treatments[ATP].contraindications).toEqual([{ id: 'cond.asthma', level: 'absolute', reaction: 2500 }]);
    expect(db.treatments[VERA_IV].contraindications).toEqual([{ id: 'risk.heart_failure', level: 'absolute', reaction: 2500 }]);
    expect(db.treatments[PROC].contraindications).toEqual([{ id: 'risk.heart_failure', level: 'relative', reaction: 2500 }]);
  });

  test('разряд при тахикардии — без антикоагулянта; при фибрилляции предсердий спутник по-прежнему нужен', () => {
    expect(ev(stable, plan([VAGAL, CV])).companionsMissing).toEqual([]);
    expect(ev(shock, plan([CV], 'icu')).companionsMissing).toEqual([]);
    expect(ev(vt, plan([AMIO], 'icu')).companionsMissing).toEqual([]);
    const af = generatePatient(db, 11, { department: 'dept.therapy', season: 'winter', primary: AF, params: { unstable: 'no' } });
    expect(evaluatePlan(db, af, plan([CV]), complaintObservations(af), BAY).companionsMissing).toEqual([{ tx: UFH, of: CV }]);
  });

  test('желудочковая: нестабильной — разряд, и до перевода; стабильной — разряд, прокаинамид или амиодарон; ПИТ или центр', () => {
    expect(ev(shock, plan([CV], 'icu')).requireMissing).toEqual([]);
    expect(ev(shock, plan([PROC], 'icu')).requireMissing).toEqual([CV]);
    expect(ev(shock, plan([], 'transfer')).beforeTransferMissing).toEqual([CV]);
    expect(ev(shock, plan([], 'transfer'), {}).beforeTransferMissing).toEqual([]);
    for (const tx of [PROC, AMIO]) expect(txRole(db, VT, tx, paramsOf(shock))).toBe('notIndicated');
    for (const tx of [CV, PROC, AMIO]) expect(ev(vt, plan([tx], 'icu')).requireMissing).toEqual([]);
    expect(ev(vt, plan([BB], 'icu')).requireMissing).toEqual([CV]);
    expect(grade(vt, plan([PROC], 'icu'))).toMatchObject({ treatment: 'A', setting: 'A' });
    expect(grade(vt, plan([CV], 'transfer')).setting).toBe('A');
    expect(grade(vt, plan([CV], 'home')).setting).toBe('D');
    for (const tx of [VAGAL, ATP]) expect(txRole(db, VT, tx, paramsOf(vt))).toBe('notIndicated');
  });

  test('верапамил при широких комплексах — вред: в вену давление падает у половины, таблетками — тоже ошибка', () => {
    expect(txRole(db, VT, VERA_IV, paramsOf(vt))).toBe('harmful');
    expect(txRole(db, VT, VERA, paramsOf(vt))).toBe('harmful');
    expect(harmsOf(db, primaryOf(vt), [VERA_IV])).toEqual([{ tx: VERA_IV, p: 5000, days: [0, 0] }]);
    expect(grade(vt, plan([CV, VERA_IV], 'icu'))).toMatchObject({ treatment: 'D', safety: 'C' });
    const home = plan([VERA_IV]);
    const e = ev(vt, home);
    const reactions = Array.from({ length: 2000 }, (_, i) => observe(db, vt, home, e, Rng.seeded(i).fork('o'))).filter(o => o.kind === 'reaction').length;
    expect(Math.abs(reactions / 2000 - 0.5)).toBeLessThan(0.04);
  });
});

describe('энциклопедия', () => {
  test('где лечить наджелудочковую: дома, нестабильную — в ПИТ, без монитора у постели — в ПИТ, своей нет — скорая', () => {
    expect(article(db, SVT)!.blocks.find(b => b.key === 'where')!.text).toEqual([
      'Обычно — дома.',
      'При нестабильной гемодинамике — палата интенсивной терапии.',
      'Без монитора с дефибриллятором у постели — палата интенсивной терапии.',
      'Своей палаты интенсивной терапии нет — скорая, больница.',
      'В стационаре обычно 1\u00a0день.',
    ]);
    expect(article(db, VT)!.blocks.find(b => b.key === 'where')!.text!.slice(0, 2)).toEqual(['Обычно — палата интенсивной терапии.', 'Своей палаты интенсивной терапии нет — скорая, больница.']);
  });

  test('у разряда спутники — только при фибрилляции предсердий; у трифосаденина — где делают', () => {
    const rows = article(db, CV)!.blocks.find(b => b.key === 'companions')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]);
    expect(rows).toEqual([['Одно из', [UFH, 'tx.lmwh', 'tx.doac']], ['Только при', [AF]]]);
    expect(article(db, ATP)!.blocks.find(b => b.key === 'where')!.refs!.map(r => r.id)).toEqual([MONITOR, 'room.emergency', 'room.icu']);
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
      const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
      const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...venue, minutes } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }

  test('в приёмном у постели: ЭКГ и давление — каждому, диагноз по ширине комплексов; лечение по стабильности, вредного нет', () => {
    let atp = 0;
    let stable = 0;
    for (const [id, xs] of [[SVT, people(SVT, 60, {}, 7_000_001)], [VT, people(VT, 60, {}, 7_000_001)]] as const) {
      let right = 0;
      for (const p of xs) {
        const r = run(p, BAY, ED);
        expect(r.done).toEqual(expect.arrayContaining(['exam.ecg', 'exam.vitals']));
        // ЭКГ пропускает широкие комплексы у 5 из 100 и узкие у 3 — тогда и диагноз другой
        if (r.diagnosis !== id) continue;
        right++;
        const ev = evaluatePlan(db, p, r.plan, r.obs, BAY);
        expect({ seed: p.seed, harmful: ev.roles.filter(x => x.role === 'harmful').map(x => x.tx), missing: ev.requireMissing }).toEqual({ seed: p.seed, harmful: [], missing: [] });
        if (id === VT || paramsOf(p).unstable === 'yes') {
          expect({ seed: p.seed, plan: r.plan }).toEqual({ seed: p.seed, plan: { treatments: [CV], setting: 'icu' } });
          continue;
        }
        // стабильному — вагусные пробы и трифосаденин; сказал «астма» — вместо него верапамил в вену
        stable++;
        const [other, ...rest] = r.plan.treatments.filter(tx => tx !== VAGAL);
        expect({ seed: p.seed, setting: r.plan.setting, vagal: r.plan.treatments.includes(VAGAL), rest }).toEqual({ seed: p.seed, setting: 'home', vagal: true, rest: [] });
        expect([ATP, VERA_IV]).toContain(other);
        if (other === ATP) atp++;
        else expect(r.obs.some(o => o.f === 'hx.asthma' && o.shown)).toBe(true);
      }
      expect({ id, right: right / xs.length > 0.9 }).toEqual({ id, right: true });
    }
    expect(atp / stable).toBeGreaterThan(0.9);
  });

  test('в поликлинике без монитора: вагусные пробы и скорая; разряда и трифосаденина нет', () => {
    for (const p of people(SVT, 30, { unstable: 'no' }, 7_100_001)) {
      const r = run(p, {}, ['dept.therapy']);
      expect({ seed: p.seed, dx: r.diagnosis, plan: r.plan }).toEqual({ seed: p.seed, dx: SVT, plan: { treatments: [VAGAL], setting: 'ambulance' } });
    }
    // желудочковую — на скорой; ЭКГ пропускает широкие комплексы у 5 из 100 — тогда и диагноз другой
    const vts = people(VT, 40, {}, 7_100_001).map(p => run(p, {}, ['dept.therapy']));
    for (const r of vts) expect(r.plan.treatments).not.toContain(CV);
    const sent = vts.filter(r => r.diagnosis === VT && r.plan.setting === 'ambulance' && r.plan.treatments.length === 0).length;
    expect(sent / vts.length).toBeGreaterThan(0.85);
  });
});
