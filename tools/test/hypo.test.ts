// Гипогликемия (spec 2026-10-chapter-3, часть 44а; 290_2 «Сахарный диабет 2 типа у взрослых», раздел 3.7; 286_3, раздел
// 3.6; 814_1, раздел 2.3): у больного диабетом на инсулине или сульфонилмочевине сахар ниже 3,0. Лёгкая — дрожь, пот,
// голод: быстрые углеводы и домой. Тяжёлая — спутанность и оглушение: декстроза в вену, без вены — глюкагон, сладкое в
// рот — вред, экстренно в стационар; пьёт сульфонилмочевину — капельница. С нарушением речи — «маска» инсульта: глюкометр
// каждому с признаками инсульта, тромболизис — вред.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { deriveParams, generatePatient } from '../../src/engine/med/generate';
import { paramBeliefs, paramGain } from '../../src/engine/med/infer';
import { curesOf, evaluatePlan, harmsOf, type Plan, settingFit, txAvailable, txRole, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { choosePlan, type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import { complaintText, observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const HYPO = 'cond.hypoglycemia';
const DM = 'cond.diabetes2';
const LOW = 'lab.glucose_low';
const HIGH = 'lab.glucose_high';
const GLU = 'exam.glucometer';
const MEDS = 'exam.ask_meds';
const INSULIN = 'hx.insulin';
const SU = 'hx.sulfonylurea';
const CONFUSED = 'sym.confusion';
const GCS = 'sign.gcs_low';
const SPEECH = 'sym.speech_trouble';
const CARBS = 'tx.fast_carbs';
const DEX = 'tx.dextrose_iv';
const DRIP = 'tx.dextrose_infusion';
const GLUCAGON = 'tx.glucagon';
const LYSIS = 'tx.thrombolysis_stroke';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true, ward: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const by = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f && x.cause === HYPO);
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
function people(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: HYPO, params });
    if (p.age >= db.conditions[HYPO].age.min) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true, value?: number): Observation => ({ f, shown: on, exam, ...(value !== undefined ? { value } : {}) });
const truthful = (p: Patient, exams: Id[]): Observation[] => [
  ...complaintObservations(p),
  ...exams.flatMap((exam, i) => runExam(db, p, exam, Rng.seeded(i).fork(exam), undefined, true)),
];
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
const WORKUP = ['exam.ask_chronic', 'exam.ask_general', 'exam.vitals', 'exam.neuro_exam', GLU, MEDS];

describe('каталог', () => {
  test('гипогликемия: терапия, обмен веществ, E16.0, подтверждает глюкометр; только при диабете 2 типа, с 35 лет, «часто»', () => {
    const c = db.conditions[HYPO];
    expect(c).toMatchObject({ icd10: 'E16.0', department: 'dept.therapy', system: 'metabolic', severity: 'serious', confirm: [GLU], requires: [DM], weight: 300 });
    expect(c.age).toMatchObject({ min: 35, peak: [60, 85] });
    expect(c.params).toEqual({ drug: { insulin: 55, sulfonylurea: 45 }, severity: { mild: 60, severe: 40 }, speech: { no: 80, yes: 20 }, su: { no: 41, yes: 59 } });
    expect(c.derived).toEqual({ su: { has: SU } });
    expect(c.redFlags).toEqual([CONFUSED, GCS, SPEECH]);
    expect(c.differential).toEqual(['cond.stroke_ischemic', 'cond.tia']);
  });

  test('тактика: лёгкая — углеводы и домой; тяжёлая — декстроза в вену, без вены глюкагон, сладкое в рот — вред, скорая; пьёт сульфонилмочевину — капельница', () => {
    const t = db.conditions[HYPO].treatment!;
    expect(t).toMatchObject({ firstLine: [CARBS], acceptable: [DEX], supportive: [], notIndicated: [], harmful: [LYSIS, 'tx.thrombolysis'], setting: { default: 'home', param: { name: 'severity', map: { mild: 'home', severe: 'ambulance' } } } });
    expect(t.byParam).toEqual([
      expect.objectContaining({ when: { severity: ['severe'] }, firstLine: [DEX], acceptable: [GLUCAGON], supportive: [DRIP], harmful: [CARBS], plan: [DEX], preHospital: [DEX, GLUCAGON] }),
      expect.objectContaining({ when: { severity: ['severe'], su: ['yes'] }, require: [DRIP] }),
    ]);
  });

  test('глюкометр — каждому с дрожью, голодом, спутанностью, признаками инсульта и судорогами, при оглушении и на инсулине или сульфонилмочевине; расспрос о лекарствах — при гипогликемии', () => {
    const g = db.exams[GLU];
    // с частью 44в — и при судорожном приступе и статусе (741_1)
    expect(g.routineFor).toEqual(['sym.tremor', 'sym.hunger', CONFUSED, 'sym.weakness_one_side', SPEECH, 'sym.face_droop', 'sym.seizure', 'sym.seizure_ongoing']);
    expect(g.routineSeen).toEqual([GCS, INSULIN, SU]);
    expect(g.checks.filter(k => k.f === LOW).map(k => [k.sens, k.spec])).toEqual([[9300, 10000]]);
    const m = db.exams[MEDS];
    expect(m.routineSeen).toEqual([LOW]);
    expect(m.checks.filter(k => k.f.startsWith('hx.') && k.f !== 'hx.nsaid_use' && k.f !== 'hx.anticoagulants').map(k => [k.f, k.sens, k.spec])).toEqual([[INSULIN, 9800, 9900], [SU, 9000, 9700], ['hx.missed_meal', 9000, 9500]]);
    expect(db.exams['exam.ask_general'].checks.map(k => k.f)).toEqual(expect.arrayContaining(['sym.tremor', 'sym.sweating', 'sym.hunger', CONFUSED]));
  });

  test('лечение — «Обмен веществ»: углеводы внутрь, декстроза струйно и капельно, глюкагон в мышцу; всё можно и в кабинете', () => {
    const txs = [CARBS, DEX, DRIP, GLUCAGON];
    expect(txs.map(tx => txGroupOfClass(db.treatments[tx].class))).toEqual(['metabolic', 'metabolic', 'metabolic', 'metabolic']);
    expect(txs.map(tx => db.treatments[tx].route)).toEqual(['oral', 'iv', 'iv', 'im']);
    expect(txs.map(tx => txAvailable(db, tx, {}))).toEqual([true, true, true, true]);
  });

  test('инсулин и сульфонилмочевина бывают у больного диабетом и без гипогликемии — иначе «колет инсулин» значило бы её', () => {
    const links = Object.fromEntries(db.conditions[DM].findings.map(l => [l.f, l.p]));
    expect([links[INSULIN], links[SU], links['hx.missed_meal']]).toEqual([2500, 2500, 800]);
  });
});

describe('больные', () => {
  const xs = people(2000);
  const part = (ys: Patient[], f: (p: Patient) => boolean) => ys.filter(f).length / ys.length;

  test('у каждого — диабет 2 типа и известный диабет, глюкоза 1,6–2,9 вместо повышенной; лекарство — по параметру', () => {
    for (const p of xs) {
      const d = paramsOf(p).drug;
      expect({
        seed: p.seed, dm: p.truth.conditions.some(c => c.id === DM), low: by(p, LOW), high: has(p, HIGH), known: has(p, 'hx.diabetes'),
        value: p.truth.values[HIGH] >= 1.6 && p.truth.values[HIGH] <= 2.9, drug: by(p, d === 'insulin' ? INSULIN : SU),
      }).toEqual({ seed: p.seed, dm: true, low: true, high: false, known: true, value: true, drug: true });
    }
  });

  test('тяжёлая — у 40 из 100: спутанность и оглушение у каждой, дрожь и голод — только у лёгкой; нарушение речи — с признаком на осмотре и баллами NIH', () => {
    const severe = xs.filter(p => paramsOf(p).severity === 'severe');
    const mild = xs.filter(p => paramsOf(p).severity === 'mild');
    expect(Math.abs(severe.length / xs.length - 0.4)).toBeLessThan(0.03);
    for (const p of severe) expect(by(p, CONFUSED) && by(p, GCS) && !by(p, 'sym.tremor') && !by(p, 'sym.hunger')).toBe(true);
    for (const p of mild) expect(by(p, CONFUSED) || by(p, GCS) || by(p, SPEECH)).toBe(false);
    // дрожь — «обычно» у заболевших, а среди пришедших чаще: без жалоб не приходят
    expect(part(mild, p => by(p, 'sym.tremor'))).toBeGreaterThan(0.75);
    expect(part(mild, p => by(p, 'sym.tremor'))).toBeLessThan(0.9);
    for (const p of severe.filter(q => paramsOf(q).speech === 'yes')) expect(by(p, SPEECH) && by(p, 'sign.speech_deficit') && by(p, 'sign.nihss')).toBe(true);
    for (const p of severe.filter(q => paramsOf(q).speech === 'no')) expect(by(p, SPEECH)).toBe(false);
  });

  test('пьёт ли сульфонилмочевину — по признаку: на ней — всегда, на инсулине — у четверти (по диабету)', () => {
    for (const p of xs) expect({ seed: p.seed, su: paramsOf(p).su }).toEqual({ seed: p.seed, su: has(p, SU) ? 'yes' : 'no' });
    expect(xs.filter(p => paramsOf(p).drug === 'sulfonylurea').every(p => paramsOf(p).su === 'yes')).toBe(true);
    expect(Math.abs(part(xs.filter(p => paramsOf(p).drug === 'insulin'), p => paramsOf(p).su === 'yes') - 0.25)).toBeLessThan(0.04);
  });

  test('производный по признаку не бросается: запись без него досчитывается по признакам', () => {
    const p = xs.find(q => paramsOf(q).su === 'yes')!;
    const conditions = p.truth.conditions.map(c => ({ ...c, params: { ...c.params } }));
    delete conditions.find(c => c.id === HYPO)!.params.su;
    deriveParams(db, conditions, p, p.truth.findings);
    expect(conditions.find(c => c.id === HYPO)!.params.su).toBe('yes');
    deriveParams(db, conditions, p, p.truth.findings.filter(x => x.f !== SU));
    expect(conditions.find(c => c.id === HYPO)!.params.su).toBe('yes');
  });
});

describe('вывод', () => {
  const who = { age: 70, sex: 'f' as const };

  test('о сульфонилмочевине врач судит по расспросу: не спрашивал — по долям, «пьёт» — да, «не пьёт» — нет', () => {
    const p = (obs: Observation[]) => Object.fromEntries(paramBeliefs(db, HYPO, 'su', obs, who).map(b => [b.value, b.p]));
    expect(p([])).toEqual({ no: 0.41, yes: 0.59 });
    expect(p([seen(SU, MEDS)])).toEqual({ no: 0, yes: 1 });
    expect(p([seen(SU, MEDS, false)])).toEqual({ no: 1, yes: 0 });
    expect(paramGain(db, HYPO, 'su', MEDS, [], who)).toBeGreaterThan(0.9);
    expect(paramGain(db, HYPO, 'su', MEDS, [seen(SU, MEDS)], who)).toBe(0);
    expect(paramGain(db, HYPO, 'su', GLU, [], who)).toBe(0);
  });

  test('тяжёлая: пьёт сульфонилмочевину — в плане капельница, и вместе с инсулином тоже; только инсулин — без неё', () => {
    const severe = [seen(CONFUSED, 'complaint'), seen(GCS, 'exam.neuro_exam', true, 14), seen(LOW, GLU, true, 2.2)];
    const both = choosePlan(db, HYPO, [...severe, seen(INSULIN, MEDS), seen(SU, MEDS)], who, BAY);
    expect(both).toEqual({ treatments: [DRIP, DEX], setting: 'admit' });
    expect(choosePlan(db, HYPO, [...severe, seen(INSULIN, MEDS), seen(SU, MEDS, false)], who, BAY)).toEqual({ treatments: [DEX], setting: 'admit' });
    // в кабинете поликлиники — скорая, декстроза до неё
    expect(choosePlan(db, HYPO, [...severe, seen(SU, MEDS, false)], who, {}).setting).toBe('ambulance');
  });
});

describe('тактика и разбор', () => {
  const mild = people(40, { severity: 'mild', drug: 'insulin' }).find(p => !has(p, SU))!;
  const severe = people(40, { severity: 'severe', drug: 'insulin', speech: 'no' }).find(p => !has(p, SU))!;
  const severeSu = people(40, { severity: 'severe', drug: 'sulfonylurea', speech: 'no' })[0];
  const ev = (p: Patient, x: Plan, venue: Venue = BAY) => evaluatePlan(db, p, x, truthful(p, WORKUP), venue);
  const harmful = (e: ReturnType<typeof ev>) => e.roles.filter(r => r.role === 'harmful').map(r => r.tx);

  test('лёгкая: углеводы — дома, всё верно; декстроза в вену — тоже можно; глюкагон и капельница — не показаны; тромболизис — вред', () => {
    const ok = ev(mild, plan([CARBS]));
    expect({ missing: ok.requireMissing, harmful: harmful(ok), setting: ok.setting.recommended, effective: ok.effective }).toEqual({ missing: [], harmful: [], setting: 'home', effective: true });
    const ps = paramsOf(mild);
    expect([CARBS, DEX, GLUCAGON, DRIP, LYSIS, 'tx.thrombolysis'].map(tx => txRole(db, HYPO, tx, ps))).toEqual(['firstLine', 'acceptable', 'notIndicated', 'notIndicated', 'harmful', 'harmful']);
  });

  test('тяжёлая: декстроза в вену — в палату; сладкое в рот — вред; «В стационар» своим ходом — мало: нужна экстренная госпитализация', () => {
    const ok = ev(severe, plan([DEX], 'admit'));
    expect({ missing: ok.requireMissing, harmful: harmful(ok), setting: ok.setting.recommended, fit: settingFit(ok.setting.recommended, 'admit') }).toEqual({ missing: [], harmful: [], setting: 'ambulance', fit: 'ok' });
    expect(harmful(ev(severe, plan([CARBS, DEX], 'admit')))).toEqual([CARBS]);
    expect([DEX, GLUCAGON, DRIP, CARBS].map(tx => txRole(db, HYPO, tx, paramsOf(severe)))).toEqual(['firstLine', 'acceptable', 'supportive', 'harmful']);
    expect(settingFit('ambulance', 'ward')).toBe('under');
  });

  test('от сульфонилмочевины тяжёлая — капельница обязательна; без неё — «не назначено»', () => {
    expect(ev(severeSu, plan([DEX], 'admit')).requireMissing).toEqual([DRIP]);
    expect(ev(severeSu, plan([DEX, DRIP], 'admit')).requireMissing).toEqual([]);
  });

  test('в поликлинике тяжёлую — на скорой, а до неё декстроза или глюкагон: без них — замечание', () => {
    const score = (x: Plan) => scoreCase({ verdict: 'correct', confidence: 0.95, cost: 10, rationalCost: 10, plan: ev(severe, x, {}), outcome: { kind: 'transferred', day: 0, cured: false }, selfLimiting: false, redFlags: [{ f: CONFUSED, seen: true }] });
    expect(score(plan([], 'ambulance')).notes).toEqual(expect.arrayContaining([{ code: 'tx.preHospitalMissing', tx: DEX }]));
    expect(score(plan([GLUCAGON], 'ambulance')).notes.some(n => n.code === 'tx.preHospitalMissing')).toBe(false);
  });

  test('действие: углеводы снимают лёгкую в тот же день, при тяжёлой — вредят; декстроза — обычно, глюкагон — часто; без лечения лёгкая часто хуже, тяжёлая — почти всегда', () => {
    const m = { id: HYPO, params: { severity: 'mild', drug: 'insulin', speech: 'no', su: 'no' } };
    const s = { id: HYPO, params: { severity: 'severe', drug: 'insulin', speech: 'no', su: 'no' } };
    expect(curesOf(db, m, [CARBS]).map(e => [e.p, ...e.days])).toEqual([[7500, 0, 0]]);
    expect(curesOf(db, s, [CARBS])).toEqual([]);
    expect(harmsOf(db, s, [CARBS]).map(h => h.p)).toEqual([2500]);
    expect(curesOf(db, s, [DEX, GLUCAGON, DRIP]).map(e => [e.p, ...e.days])).toEqual([[7500, 0, 0], [5000, 0, 0], [7500, 0, 1]]);
    expect(untreatedOf(db, m)).toMatchObject({ p: 5000, days: [0, 0] });
    expect(untreatedOf(db, s)).toMatchObject({ p: 9500, days: [0, 0] });
  });
});

describe('тексты', () => {
  test('дрожь, спутанность, пропуск еды, лекарства и глюкоза — по полу', () => {
    const line = (o: Observation, sex: 'm' | 'f' = 'm') => observationText(db, o, sex, 1);
    expect(line(seen('sym.tremor', 'exam.ask_general'))).toBe('Мелкая дрожь в руках');
    expect(line(seen(CONFUSED, 'exam.ask_general', false), 'f')).toBe('Ориентирована в месте и времени');
    expect(line(seen('hx.missed_meal', MEDS), 'f')).toBe('Сделала укол или выпила таблетку от сахара, а поесть не успела');
    expect(line(seen(SU, MEDS))).toBe('Пьёт таблетки сульфонилмочевины: гликлазид или глимепирид');
    expect(line(seen('hx.diabetes', 'exam.ask_chronic'))).toBe('У меня сахарный диабет, лечусь');
    expect(line(seen(LOW, GLU, true, 2.1))).toBe('Глюкоза 2,1 ммоль/л — гипогликемия');
    const said = new Set(Array.from({ length: 20 }, (_, s) => complaintText(db, seen(CONFUSED, 'complaint'), 'f', s)));
    expect(said).toEqual(new Set(['Стала заговариваться, не понимает, где находится, — привезли родные', 'Сидит, на вопросы отвечает невпопад, вся в поту — вызвали скорую соседи']));
  });
});

describe('энциклопедия', () => {
  test('где лечить, лечение по тяжести и сульфонилмочевине, с чем спутать — инсульт, ТИА и судорожный приступ, а у инсульта и ТИА — гипогликемия', () => {
    const x = article(db, HYPO)!;
    expect(x.blocks.find(b => b.key === 'where')!.text).toEqual(['Обычно — дома.', 'При тяжёлом течении — скорая, больница.', 'В стационаре обычно 1–3 дня.']);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Первая линия']).toEqual([CARBS]);
    expect(rows['Опасно, при тяжёлом течении']).toEqual([CARBS]);
    expect(rows['До приезда скорой, при тяжёлом течении']).toEqual([DEX, GLUCAGON]);
    expect(rows['Обязательно, при тяжёлом течении и если пьёт таблетки сульфонилмочевины']).toEqual([DRIP]);
    // с частью 44в — и судорожный приступ: спутанность и оглушение
    expect(x.blocks.find(b => b.key === 'similar')!.refs!.map(r => r.id)).toEqual(['cond.stroke_ischemic', 'cond.tia', 'cond.seizure']);
    for (const id of ['cond.stroke_ischemic', 'cond.tia']) expect(article(db, id)!.blocks.find(b => b.key === 'similar')!.refs!.map(r => r.id)).toContain(HYPO);
  });
});

describe('разумный врач', () => {
  const exams = Object.keys(db.exams).sort();
  function run(p: Patient, venue: Venue) {
    const cands = candidatesOf(db, ED);
    const rng = Rng.seeded(p.seed).fork('doctor');
    const obs: Observation[] = complaintObservations(p);
    const done: Id[] = [];
    let phase: DoctorPhase = {};
    for (let k = 0; k < 50; k++) {
      const minutes = done.reduce((acc, id) => acc + examMinutes(db.exams[id]), 0);
      const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...venue, minutes } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }

  // без глюкометра гипогликемию не ставят: при сердцебиении и головокружении (без дрожи и голода) «колю инсулин»
  // вело к ней по одному расспросу — у 4 из 100 лёгких
  test('лёгкая в смотровой приёмного: глюкометр, углеводы и домой, вредного нет', () => {
    const xs = people(30, { severity: 'mild' }, 8_400_001);
    let right = 0;
    for (const p of xs) {
      const r = run(p, BAY);
      if (r.diagnosis !== HYPO) continue;
      right++;
      const e = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect({ seed: p.seed, glucometer: r.done.includes(GLU), plan: r.plan, harmful: e.roles.filter(x => x.role === 'harmful').length })
        .toEqual({ seed: p.seed, glucometer: true, plan: { treatments: [CARBS], setting: 'home' }, harmful: 0 });
    }
    expect(right / xs.length).toBeGreaterThan(0.9);
  }, 120_000);

  test('тяжёлая от сульфонилмочевины: глюкометр, декстроза в вену с капельницей и в палату', () => {
    const xs = people(30, { severity: 'severe', drug: 'sulfonylurea', speech: 'no' }, 8_400_001);
    let drip = 0;
    for (const p of xs) {
      const r = run(p, BAY);
      expect({ seed: p.seed, diagnosis: r.diagnosis, glucometer: r.done.includes(GLU), dex: r.plan.treatments.includes(DEX), setting: r.plan.setting })
        .toEqual({ seed: p.seed, diagnosis: HYPO, glucometer: true, dex: true, setting: 'admit' });
      if (r.plan.treatments.includes(DRIP)) drip++;
    }
    // «пьёт» узнают расспросом: чувствительность 90 %
    expect(drip / xs.length).toBeGreaterThan(0.8);
  }, 120_000);

  test('с нарушением речи — как инсульт: осмотр и КТ, но глюкометр до решения — и тромболизиса нет', () => {
    const xs = people(20, { severity: 'severe', speech: 'yes' }, 8_400_001);
    for (const p of xs) {
      const r = run(p, BAY);
      expect({ seed: p.seed, diagnosis: r.diagnosis, glucometer: r.done.includes(GLU), lysis: r.plan.treatments.includes(LYSIS) }).toEqual({ seed: p.seed, diagnosis: HYPO, glucometer: true, lysis: false });
    }
  }, 120_000);
});
