// Гипертонический криз и подъём давления без поражения органов (spec 2026-10-chapter-3, часть 43г; 62_3 «Артериальная
// гипертензия у взрослых», раздел 3.7; Zampaglione 1996): криз — это давление с острым поражением органов, а не число.
// Энцефалопатия (оглушение) и злокачественная гипертензия (глазное дно, почки) — препарат в вену под монитором и ПИТ;
// без поражения органов — таблетки и домой, а препарат в вену — вред. Давление 180/110 и выше — порог на том же
// числе, что «140/90 и выше»; каждому с ним — глазное дно, ЭКГ, креатинин, моча и неврологический осмотр.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { scaleTriage } from '../../src/engine/med/news2';
import { curesOf, evaluatePlan, type Plan, txAvailable, txRole, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import { complaintText, observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { targetsFor } from '../../src/engine/shift/targets';
import { article } from '../../src/state/encyclopedia';

const CRISIS = 'cond.hypertensive_crisis';
const URGENCY = 'cond.bp_uncontrolled';
const HIGH = 'vital.bp_high';
const VERY_HIGH = 'vital.bp_very_high';
const SURGE = 'sym.bp_surge';
const BLURRED = 'sym.vision_blurred';
const RETINA = 'sign.retinopathy_acute';
const GCS = 'sign.gcs_low';
const IV = 'tx.bp_iv';
const ACE = 'tx.ace_inhibitor';
const CCB = 'tx.ccb';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const by = (p: Patient, f: Id, cond: Id) => p.truth.findings.some(x => x.f === f && x.cause === cond);
/** Больные в возрасте болезни. */
function people(id: Id, n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: id, params });
    if (p.age >= db.conditions[id].age.min) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true): Observation => ({ f, shown: on, exam });
/** Всё, что видит врач, — правда: каждое обследование показало то, что есть. */
const truthful = (p: Patient, exams: Id[]): Observation[] => [
  ...complaintObservations(p),
  ...exams.flatMap((exam, i) => runExam(db, p, exam, Rng.seeded(i).fork(exam), undefined, true)),
];
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
const WORKUP = ['exam.ask_chronic', 'exam.ask_complaints', 'exam.vitals', 'exam.neuro_exam', 'exam.fundoscopy', 'exam.ecg', 'exam.creatinine', 'exam.urine_dipstick'];

describe('каталог', () => {
  test('криз: терапия, угрожает жизни, клинический диагноз; энцефалопатия 60 и злокачественная 40; препарат в вену обязателен, ПИТ', () => {
    const c = db.conditions[CRISIS];
    expect(c).toMatchObject({ icd10: 'I10', department: 'dept.therapy', severity: 'critical', confirm: 'clinical', redFlags: [GCS, BLURRED, RETINA] });
    expect(c.arrival).toBeUndefined();
    expect(c.params!.organ).toEqual({ encephalopathy: 60, malignant: 40 });
    expect(c.treatment).toMatchObject({ require: [IV], supportive: [ACE, 'tx.arb'], harmful: ['tx.thrombolysis_stroke', 'tx.thrombolysis'], setting: { default: 'icu' } });
    expect(c.differential).toEqual([URGENCY, 'cond.stroke_ischemic', 'cond.ich']);
  });

  test('без поражения органов: умеренное, диагноз по давлению; таблетки и домой, препарат в вену — вред', () => {
    const c = db.conditions[URGENCY];
    expect(c).toMatchObject({ icd10: 'I10', department: 'dept.therapy', severity: 'moderate', confirm: ['exam.vitals'] });
    expect(c.treatment).toMatchObject({ firstLine: [ACE, 'tx.arb', CCB, 'tx.thiazide'], plan: [ACE, CCB], harmful: [IV], setting: { default: 'home' } });
    expect(untreatedOf(db, { id: URGENCY, params: {} })).toMatchObject({ p: 0, days: [7, 7] });
  });

  test('частота: обе — только у гипертоника, как обострение астмы (известна у 92 и 72 из 100); без поражения органов — вдесятеро чаще криза', () => {
    expect([db.conditions[CRISIS].weight, db.conditions[URGENCY].weight]).toEqual([10, 100]);
    const who = { sex: 'f' as const, age: 60, season: 'winter' as const, risks: [] as Id[], chronic: [] as Id[] };
    for (const id of [CRISIS, URGENCY]) {
      expect(db.conditions[id].requires).toEqual(['cond.hypertension']);
      expect(presentingWeight(db.conditions[id], who)).toBe(0);
    }
    const htn = { ...who, chronic: ['cond.hypertension'] };
    expect(presentingWeight(db.conditions[URGENCY], htn) / presentingWeight(db.conditions[CRISIS], htn)).toBeCloseTo(10, 6);
    // с гипертонией в прошлом у каждого больного — и «Разнообразие» их не раздувает: множителя риска нет
    for (const p of [...people(CRISIS, 50), ...people(URGENCY, 50)]) expect(p.truth.conditions.some(c => c.id === 'cond.hypertension' && c.role === 'comorbid')).toBe(true);
  });

  test('«180/110 и выше» — то же измерение, что «140/90 и выше», и порог его не снимает; до 179 — только «140/90»; на сортировке — жёлтый', () => {
    expect(db.findings[VERY_HIGH].value).toMatchObject({ of: HIGH, implies: true, present: [180, 240] });
    expect(db.findings[HIGH].value!.present).toEqual([141, 179]);
    expect(db.findings[VERY_HIGH].triage).toBe('yellow');
    const vitals = db.exams['exam.vitals'].checks;
    expect(vitals.find(k => k.f === VERY_HIGH)).toMatchObject({ sens: vitals.find(k => k.f === HIGH)!.sens, spec: 10000 });
    expect(scaleTriage(db, [SURGE], [{ f: VERY_HIGH, shown: true, exam: 'exam.vitals', value: 210 }]).triage).toBe('yellow');
  });

  test('каждому с давлением 180/110 и выше — глазное дно, ЭКГ, креатинин, моча и неврологический осмотр; при резком подъёме, головной боли и пелене — давление', () => {
    for (const e of ['exam.fundoscopy', 'exam.ecg', 'exam.creatinine', 'exam.urine_dipstick', 'exam.neuro_exam']) expect({ e, seen: db.exams[e].routineSeen }).toEqual({ e, seen: expect.arrayContaining([VERY_HIGH]) });
    // 62_3, разделы 3.7 и 2.1: перемерить при резком подъёме; головные боли и расстройство зрения — симптомы АГ
    expect(db.exams['exam.vitals'].routineFor).toEqual(expect.arrayContaining([SURGE, 'sym.headache', BLURRED]));
    const fundus = db.exams['exam.fundoscopy'];
    expect(fundus).toMatchObject({ kind: 'physical', cost: 0, routineFor: [BLURRED] });
    expect(fundus.checks).toEqual([expect.objectContaining({ f: RETINA, sens: 8500, spec: 9800 })]);
    for (const f of [SURGE, BLURRED]) expect(db.exams['exam.ask_complaints'].checks.some(k => k.f === f)).toBe(true);
  });

  test('ЭКГ за 15 минут от поступления — при жалобе на резкий подъём или при намеренных 180/110 у лежащих в смотровой', () => {
    const t = db.targets['target.ecg_bp_surge'];
    expect(t).toMatchObject({ complaints: [SURGE], findings: [VERY_HIGH], room: 'room.emergency', exams: ['exam.ecg'], minutes: 15, from: 'arrival' });
    const at = { roomType: () => 'room.emergency', bedside: (e: Id) => e === 'exam.ecg', can: () => true };
    const p = people(CRISIS, 40).find(x => !x.complaints.includes(SURGE))!;
    const bay = { room: 'r1', slot: 0 } as never;
    expect(targetsFor(db, { patient: p, bay, results: [] }, at).map(x => x.id)).toEqual([]);
    const vitals = { exam: 'exam.vitals', step: 0, at: 0, obs: [{ f: VERY_HIGH, shown: true, exam: 'exam.vitals', value: 200 }] };
    expect(targetsFor(db, { patient: p, bay, results: [vitals] }, at).map(x => x.id)).toEqual(['target.ecg_bp_surge']);
  });

  test('препарат в вену — у постели под монитором; таблетки — где угодно', () => {
    expect([txAvailable(db, IV, {}), txAvailable(db, IV, BAY), txAvailable(db, ACE, {}), txAvailable(db, CCB, {})]).toEqual([false, true, true, true]);
  });
});

describe('больные', () => {
  const crisis = people(CRISIS, 1200);
  const urgency = people(URGENCY, 600);
  const part = (xs: Patient[], f: (p: Patient) => boolean) => xs.filter(f).length / xs.length;

  test('давление — у каждого 180–240, и это же число — «140/90 и выше» и у порога «ниже 90»: два порога на одном измерении', () => {
    for (const p of [...crisis, ...urgency]) {
      const v = p.truth.values[HIGH];
      const one = p.truth.values[VERY_HIGH] === v && p.truth.values['vital.bp_low'] === v;
      expect({ seed: p.seed, high: p.truth.findings.some(x => x.f === HIGH), very: p.truth.findings.some(x => x.f === VERY_HIGH), ok: v >= 180 && v <= 240 && one }).toEqual({ seed: p.seed, high: true, very: true, ok: true });
    }
  });

  test('криз: энцефалопатия и злокачественная — 60 и 40 из 100; оглушение — почти у каждой энцефалопатии, глазное дно — у каждой злокачественной', () => {
    expect(Math.abs(part(crisis, p => paramsOf(p).organ === 'encephalopathy') - 0.6)).toBeLessThan(0.04);
    const enc = crisis.filter(p => paramsOf(p).organ === 'encephalopathy');
    const mal = crisis.filter(p => paramsOf(p).organ === 'malignant');
    expect(Math.abs(part(enc, p => by(p, GCS, CRISIS)) - 0.95)).toBeLessThan(0.03);
    expect(mal.every(p => by(p, RETINA, CRISIS) && !by(p, GCS, CRISIS))).toBe(true);
    expect(Math.abs(part(mal, p => by(p, 'lab.creatinine_high', CRISIS)) - 0.75)).toBeLessThan(0.07);
    expect(Math.abs(part(crisis, p => by(p, SURGE, CRISIS)) - 0.75)).toBeLessThan(0.04);
  });

  test('без поражения органов: жалоба на подъём давления — почти у каждого; оглушения, пелены и кровоизлияний на глазном дне нет', () => {
    for (const p of urgency) expect([GCS, RETINA, BLURRED].some(f => by(p, f, URGENCY))).toBe(false);
    expect(part(urgency, p => p.complaints.includes(SURGE))).toBeGreaterThan(0.9);
  });
});

describe('тексты', () => {
  test('давление 180/110 — без второго числа: число уже в строке «Давление»; глазное дно, пелена, жалоба', () => {
    const line = (o: Observation) => observationText(db, o, 'm', 1);
    expect(line(seen(VERY_HIGH, 'exam.vitals'))).toBe('Давление очень высокое: 180/110 и выше');
    expect(line({ ...seen(HIGH, 'exam.vitals'), value: 204 })).toBe('Давление 204/126 мм рт. ст.');
    expect(line(seen(RETINA, 'exam.fundoscopy'))).toBe('На глазном дне — кровоизлияния, экссудаты и отёк диска зрительного нерва');
    expect(line(seen(RETINA, 'exam.fundoscopy', false))).toBe('Глазное дно без кровоизлияний, диск зрительного нерва не отёчен');
    expect(line(seen(BLURRED, 'exam.ask_complaints', false))).toBe('Видит как обычно, пелены нет');
    const said = (sex: 'm' | 'f') => new Set(Array.from({ length: 20 }, (_, s) => complaintText(db, seen(SURGE, 'complaint'), sex, s)));
    expect(said('f')).toEqual(new Set(['Давление подскочило до двухсот и не сбивается', 'Тонометр показал 200 на 120, выпила таблетку — не помогает']));
  });
});

describe('тактика и разбор', () => {
  const crisis = people(CRISIS, 300);
  const enc = crisis.find(p => paramsOf(p).organ === 'encephalopathy' && by(p, GCS, CRISIS))!;
  const mal = crisis.find(p => paramsOf(p).organ === 'malignant')!;
  const urgent = people(URGENCY, 1)[0];
  const ev = (p: Patient, x: Plan) => evaluatePlan(db, p, x, truthful(p, WORKUP), BAY);
  const harmful = (e: ReturnType<typeof ev>) => e.roles.filter(r => r.role === 'harmful').map(r => r.tx);

  test('криз: без препарата в вену — «не назначено»; с ним в ПИТ — всё верно; таблетки иАПФ и БРА — облегчают; тромболизис — вред', () => {
    for (const p of [enc, mal]) {
      expect(ev(p, plan([], 'icu')).requireMissing).toEqual([IV]);
      const e = ev(p, plan([IV], 'icu'));
      expect({ missing: e.requireMissing, harmful: harmful(e), setting: e.setting.recommended }).toEqual({ missing: [], harmful: [], setting: 'icu' });
    }
    expect([ACE, 'tx.arb', CCB, 'tx.thrombolysis_stroke', 'tx.thrombolysis'].map(tx => txRole(db, CRISIS, tx, paramsOf(mal)))).toEqual(['supportive', 'supportive', 'notIndicated', 'harmful', 'harmful']);
  });

  test('без поражения органов: таблетки и домой — верно; препарат в вену — вред', () => {
    const ok = ev(urgent, plan([ACE, CCB]));
    expect({ harmful: harmful(ok), setting: ok.setting.recommended }).toEqual({ harmful: [], setting: 'home' });
    expect(harmful(ev(urgent, plan([IV], 'icu')))).toEqual([IV]);
  });

  test('отпустить домой криз с оглушением — опасное решение: красный флаг не заметили', () => {
    const e = ev(enc, plan([ACE]));
    const score = scoreCase({ verdict: 'wrong', confidence: 0.9, cost: 10, rationalCost: 10, plan: e, outcome: { kind: 'worse', day: 1, cured: false }, selfLimiting: false, redFlags: [{ f: GCS, seen: true }] });
    expect(score.safety).toBe('D');
    expect(score.notes).toEqual(expect.arrayContaining([{ code: 'safety.redFlagIgnored', f: GCS }]));
  });

  test('действие: препарат в вену снимает криз обычно; таблетки — подъём без поражения обычно; без лечения энцефалопатии — обычно хуже за сутки', () => {
    expect(curesOf(db, { id: CRISIS, params: paramsOf(enc) }, [IV]).map(e => e.p)).toEqual([7500]);
    expect(curesOf(db, { id: URGENCY, params: {} }, [ACE, CCB]).map(e => e.p)).toEqual([7500, 7500]);
    expect(untreatedOf(db, { id: CRISIS, params: { organ: 'encephalopathy' } })).toMatchObject({ p: 7500, days: [0, 1] });
    expect(untreatedOf(db, { id: CRISIS, params: { organ: 'malignant' } })).toMatchObject({ p: 5000, days: [1, 4] });
  });
});

describe('энциклопедия', () => {
  test('криз: ПИТ, без своей — скорая; обязательно — препарат в вену; спутать — с подъёмом без поражения органов', () => {
    const x = article(db, CRISIS)!;
    expect(x.blocks.find(b => b.key === 'where')!.text!.slice(0, 2)).toEqual(['Обычно — палата интенсивной терапии.', 'Своей палаты интенсивной терапии нет — скорая, больница.']);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Обязательно']).toEqual([IV]);
    expect(x.blocks.find(b => b.key === 'similar')!.refs!.map(r => r.id)).toContain(URGENCY);
    expect(x.blocks.find(b => b.key === 'course')!.text![0]).toBe('При гипертонической энцефалопатии без действенного лечения обычно становится хуже — на 0–1-й день.');
  });

  test('без поражения органов: дома; препарат в вену — опасно', () => {
    const x = article(db, URGENCY)!;
    expect(x.blocks.find(b => b.key === 'where')!.text).toEqual(['Обычно — дома.']);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Опасно']).toEqual([IV]);
    expect(x.blocks.find(b => b.key === 'similar')!.refs!.map(r => r.id)).toContain(CRISIS);
  });
});

describe('разумный врач в смотровой приёмного', () => {
  const exams = Object.keys(db.exams).sort();
  /** Давление уже измерили — фельдшер скорой или медсестра на сортировке. */
  function run(p: Patient) {
    const cands = candidatesOf(db, ED);
    const rng = Rng.seeded(p.seed).fork('doctor');
    const obs: Observation[] = [...complaintObservations(p), ...runExam(db, p, 'exam.vitals', rng.fork('vitals'))];
    const done: Id[] = ['exam.vitals'];
    let phase: DoctorPhase = {};
    for (let k = 0; k < 40; k++) {
      const minutes = done.reduce((acc, id) => acc + examMinutes(db.exams[id]), 0);
      const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...BAY, minutes } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }

  test('энцефалопатия: глазное дно, ЭКГ и неврологический осмотр — каждому, у кого давление намерили; верный диагноз — препарат в вену и ПИТ, вредного нет', () => {
    const xs = people(CRISIS, 40, { organ: 'encephalopathy' }, 8_400_001);
    let right = 0;
    let workup = 0;
    for (const p of xs) {
      const r = run(p);
      // тонометр пропускает 5 из 100 — тогда «180/110» не видно, и осматривать некому велеть
      if (['exam.fundoscopy', 'exam.neuro_exam', 'exam.ecg'].every(e => r.done.includes(e))) workup++;
      if (r.diagnosis !== CRISIS) continue;
      right++;
      const e = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect({ seed: p.seed, harmful: e.roles.filter(x => x.role === 'harmful').map(x => x.tx), missing: e.requireMissing, setting: r.plan.setting }).toEqual({ seed: p.seed, harmful: [], missing: [], setting: 'icu' });
    }
    expect(right / xs.length).toBeGreaterThan(0.8);
    expect(workup / xs.length).toBeGreaterThan(0.9);
  }, 120_000);

  test('без поражения органов: таблетки и домой, препарата в вену нет', () => {
    const xs = people(URGENCY, 30, {}, 8_400_001);
    let right = 0;
    for (const p of xs) {
      const r = run(p);
      if (r.diagnosis !== URGENCY) continue;
      right++;
      expect({ seed: p.seed, iv: r.plan.treatments.includes(IV), setting: r.plan.setting }).toEqual({ seed: p.seed, iv: false, setting: 'home' });
    }
    expect(right / xs.length).toBeGreaterThan(0.9);
  }, 120_000);
});
