// Геморрагическая лихорадка с почечным синдромом (spec 2026-10-chapter-4, часть 52б; 347_2): зооноз лесных грызунов, летом и
// осенью, у мужчин чаще; лихорадка, красное лицо и глаза, боль в пояснице с обеих сторон, туман перед глазами, тромбоциты падают,
// в моче белок. Тяжесть — по креатинину и диурезу, осложнённая — с шоком. Всех — в стационар: постельный режим, рибавирин
// среднетяжёлым и тяжёлым в первые 48 часов от начала, растворы при тяжёлой, при шоке — реанимация и глюкокортикоид; салицилаты
// и фуросемид при гиповолемии вредны.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { alsoSettings, evaluatePlan, type Plan, primaryOf, recommendedSetting, selfLimits, settingFit, tacticsFor, txRole, verdictOf } from '../../src/engine/med/plan';
import { examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { whenText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const HFRS = 'cond.hfrs';
const RIBA = 'tx.ribavirin';
const DEPTS = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];

const patient = (severity: string, seed = 6464, carried = false): Patient =>
  generatePatient(db, seed, {
    department: 'dept.therapy', departments: DEPTS, season: 'summer', primary: HFRS, params: { severity }, ...(carried ? { carried: db.economy.ambulance.weight } : { walkIn: true }),
  });
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const paramsOf = (p: Patient) => p.truth.conditions[0].params;

/** Доля больных с признаком — по генератору. */
function share(severity: string, f: string, n = 200): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (has(patient(severity, 105_000 + i), f)) k++;
  return k / n;
}

describe('ГЛПС: болезнь и признаки', () => {
  test('инфекционное отделение без изоляции; летом и осенью, зимой реже; у мужчин чаще; диагноз — клинический', () => {
    expect(db.conditions[HFRS]).toMatchObject({ department: 'dept.infectious', icd10: 'A98.5', confirm: 'clinical' });
    expect(db.conditions[HFRS].isolation).toBeUndefined();
    const who = { age: 35, risks: [], chronic: [] };
    const w = (sex: 'm' | 'f', season: 'winter' | 'summer' | 'autumn') => presentingWeight(db.conditions[HFRS], { ...who, sex, season });
    expect(w('m', 'autumn')).toBeGreaterThan(w('m', 'winter'));
    expect(w('m', 'summer')).toBeGreaterThan(w('m', 'winter'));
    expect(w('m', 'autumn')).toBeGreaterThan(w('f', 'autumn'));
    expect(db.conditions[HFRS].differential).toEqual(['cond.influenza', 'cond.pyelonephritis', 'cond.tbe']);
  });

  test('лихорадка — у каждого; поясница — с обеих сторон; тромбоциты, белок, креатинин выше 300 и шок — по тяжести', () => {
    expect(share('mild', 'sym.fever_hx')).toBe(1);
    const p = patient('severe');
    expect(p.truth.findings.find(x => x.f === 'sym.flank_pain')?.attrs).toEqual({ side: 'both' });
    expect(share('severe', 'lab.platelets_low')).toBe(1);
    expect(share('moderate', 'lab.urine_protein')).toBe(1);
    expect(share('moderate', 'lab.creatinine_high')).toBe(1);
    expect(share('mild', 'lab.creatinine_high')).toBeLessThan(0.06);
    expect(share('moderate', 'lab.creatinine_300')).toBeLessThan(0.03);
    expect(share('severe', 'lab.creatinine_300')).toBe(1);
    expect(share('complicated', 'vital.bp_low')).toBe(1);
    expect(share('severe', 'vital.bp_low')).toBe(0);
    // IgM — с 6-го дня болезни: у пришедших в первые дни — не у каждого
    const igm = share('moderate', 'lab.hantavirus_igm', 300);
    expect(igm).toBeGreaterThan(0.18);
    expect(igm).toBeLessThan(0.42);
    expect(share('moderate', 'hx.rodent_contact')).toBeGreaterThan(0.6);
  });

  test('часы от начала — у каждого; рибавирин по окну 48 часов: «да» — пока меньше 48, в первые 48 часов — около 40 из 100', () => {
    expect(db.conditions[HFRS].derived?.h48).toEqual({ f: 'hx.onset_hours', below: 48, clock: true });
    let yes = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const p = patient('moderate', 106_000 + i);
      const h = p.truth.values['hx.onset_hours'];
      expect(paramsOf(p).h48).toBe(h < 48 ? 'yes' : 'no');
      if (h < 48) yes++;
    }
    expect(Math.abs(yes / n - 0.4)).toBeLessThan(0.07);
  });

  test('обследования: антитела к хантавирусам; белок — в анализе мочи и полоске; отёк почек на УЗИ; лицо и склеры — на осмотре; дача — в расспросе', () => {
    expect(db.exams['exam.hantavirus_elisa']).toMatchObject({ room: 'room.lab', equipment: ['eq.immuno_analyzer'], collect: 'room.procedure' });
    expect(db.exams['exam.hantavirus_elisa'].checks.map(c => c.f)).toEqual(['lab.hantavirus_igm']);
    expect(db.exams['exam.urinalysis'].checks.map(c => c.f).at(-1)).toBe('lab.urine_protein');
    expect(db.exams['exam.urine_dipstick'].checks.map(c => c.f).at(-1)).toBe('lab.urine_protein');
    expect(db.exams['exam.us_kidney'].checks.map(c => c.f).at(-1)).toBe('img.us_kidney_edema');
    // с частью 54а за ними — звёздочки и ладони при циррозе
    expect(db.exams['exam.general_exam'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sign.face_flushing', 'sign.scleral_injection']));
    expect(db.exams['exam.ask_contacts'].checks.map(c => c.f).at(-1)).toBe('hx.rodent_contact');
    expect(db.exams['exam.creatinine'].checks.map(c => c.f)).toEqual(['lab.creatinine_high', 'lab.creatinine_300']);
  });

  test('креатинин выше 300 и билирубин выше 200 — пороги на одном числе: анализ показывает одно значение', () => {
    const p = patient('severe');
    const [cr, cr300] = runExam(db, p, 'exam.creatinine', Rng.seeded(1), undefined, true);
    expect(cr.value).toBeGreaterThan(300);
    expect(cr300).toMatchObject({ f: 'lab.creatinine_300', shown: true, value: cr.value });
    expect(db.findings['lab.creatinine_300'].value).toMatchObject({ of: 'lab.creatinine_high', implies: true });
    // гепатит (часть 52а): тяжёлая форма — то же число в печёночных пробах
    expect(db.findings['lab.bilirubin_200'].value).toMatchObject({ of: 'lab.bilirubin_high', implies: true });
    const h = generatePatient(db, 6565, { department: 'dept.therapy', departments: DEPTS, season: 'autumn', primary: 'cond.hepatitis_a', params: { severity: 'severe' } });
    const obs = runExam(db, h, 'exam.liver_panel', Rng.seeded(1), undefined, true);
    const bili = obs.find(o => o.f === 'lab.bilirubin_high')!;
    expect(bili.value).toBeGreaterThan(200);
    expect(obs.find(o => o.f === 'lab.bilirubin_200')).toMatchObject({ shown: true, value: bili.value });
  });
});

describe('ГЛПС: лечение и место', () => {
  test('постельный режим — всем; рибавирин — среднетяжёлым и тяжелее в первые 48 часов, позже — не показан; салицилаты — вред', () => {
    const t = db.conditions[HFRS].treatment!;
    expect(t.firstLine).toEqual(['tx.bed_rest']);
    for (const severity of ['moderate', 'severe', 'complicated']) {
      expect(txRole(db, HFRS, RIBA, { severity, h48: 'yes' })).toBe('require');
      expect(txRole(db, HFRS, RIBA, { severity, h48: 'no' })).toBe('notIndicated');
    }
    expect(txRole(db, HFRS, RIBA, { severity: 'mild', h48: 'yes' })).toBe('acceptable');
    expect(txRole(db, HFRS, 'tx.aspirin_course', { severity: 'mild', h48: 'no' })).toBe('harmful');
    expect(txRole(db, HFRS, 'tx.fluoroquinolone', { severity: 'mild', h48: 'no' })).toBe('notIndicated');
  });

  test('тяжёлая — растворы обязательно; осложнённая — растворы и глюкокортикоид, фуросемид — вред', () => {
    const t = db.conditions[HFRS].treatment!;
    expect(tacticsFor(t, { severity: 'moderate', h48: 'no' }).require).toBeUndefined();
    expect(txRole(db, HFRS, 'tx.iv_fluids', { severity: 'moderate', h48: 'no' })).toBe('supportive');
    expect(tacticsFor(t, { severity: 'severe', h48: 'no' }).require).toEqual(['tx.iv_fluids']);
    expect(tacticsFor(t, { severity: 'complicated', h48: 'no' }).require).toEqual(['tx.iv_fluids', 'tx.steroid_iv']);
    expect(txRole(db, HFRS, 'tx.furosemide_iv', { severity: 'complicated', h48: 'no' })).toBe('harmful');
    expect(txRole(db, HFRS, 'tx.furosemide_iv', { severity: 'severe', h48: 'no' })).toBe('notIndicated');
  });

  test('место: палата всем, дома — меньше нужного; осложнённая — реанимация, перевод не ошибка', () => {
    expect(recommendedSetting(db, patient('mild'), [])).toBe('ward');
    expect(recommendedSetting(db, patient('severe'), [])).toBe('ward');
    expect(recommendedSetting(db, patient('complicated'), [])).toBe('ricu');
    expect(settingFit('ward', 'home')).toBe('under');
    expect(db.conditions[HFRS].treatment!.setting.also).toEqual([
      { when: { severity: ['severe'] }, settings: ['icu'] },
      { when: { severity: ['complicated'] }, settings: ['transfer'] },
    ]);
  });

  test('лёгкая и среднетяжёлая проходят сами; тяжёлая без растворов — хуже, с ними — лечение действует', () => {
    for (const sev of ['mild', 'moderate']) expect(selfLimits(db, primaryOf(patient(sev)))).toBe(true);
    for (const sev of ['severe', 'complicated']) expect(selfLimits(db, primaryOf(patient(sev)))).toBe(false);
    const p = patient('severe', 107_000);
    expect(evaluatePlan(db, p, { treatments: ['tx.bed_rest', 'tx.iv_fluids'], setting: 'admit' }, []).effective).toBe(true);
    const home: Plan = { treatments: ['tx.bed_rest'], setting: 'home' };
    const outs = Array.from({ length: 200 }, (_, i) => observe(db, p, home, evaluatePlan(db, p, home, []), Rng.seeded(i).fork('out')));
    expect(outs.filter(o => o.kind === 'worse').length / outs.length).toBeGreaterThan(0.3);
  });

  test('энциклопедия: окно 48 часов и тяжесть словами', () => {
    expect(whenText({ h48: ['yes'] })).toBe('в первые 48 часов от начала болезни');
    expect(whenText({ severity: ['complicated', 'severe'] })).toBe('при тяжёлом и осложнённом течении');
    expect(whenText({ severity: ['moderate', 'severe', 'complicated'], h48: ['yes'] })).toBe('при среднетяжёлом, тяжёлом и осложнённом течении и в первые 48 часов от начала болезни');
    for (const id of [HFRS, 'exam.hantavirus_elisa', 'lab.creatinine_300', 'lab.urine_protein', 'hx.rodent_contact', 'img.us_kidney_edema']) expect(article(db, id)).toBeDefined();
  });
});

describe('разумный врач при ГЛПС', () => {
  const candidates = Object.keys(db.conditions).filter(id => db.conditions[id].presenting && DEPTS.includes(db.conditions[id].department));
  const exams = Object.keys(db.exams).sort();
  const venue = { ward: true, icu: true, ricu: true, box: true, bedside: ['eq.monitor_defib'] };

  function run(p: Patient): { done: string[]; diagnosis: string; plan: Plan; minutes: number } {
    const observations: Observation[] = complaintObservations(p);
    const done: string[] = [];
    const rng = Rng.seeded(p.seed).fork('doctor:rational');
    let phase = {};
    let t = 0;
    for (;;) {
      const r = nextStep(db, p, observations, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes: t } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, diagnosis: r.step.diagnosis, plan: r.step.plan, minutes: t };
      observations.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
      done.push(r.step.exam);
      t += examMinutes(db.exams[r.step.exam]);
    }
  }

  test('среднетяжёлая — в стационар, рибавирин только в окне 48 часов; тяжёлая — растворы; осложнённая — реанимация с глюкокортикоидом', () => {
    const n = 30;
    let right = 0, placed = 0, inWindow = 0, window = 0, late = 0, fluids = 0, ricu = 0;
    for (let i = 0; i < n; i++) {
      const m = patient('moderate', 108_000 + i);
      const rm = run(m);
      if (verdictOf(db, rm.diagnosis, m) === 'correct') right++;
      // место — по тому, что показали обследования: кровотечение из носа или низкая сатурация — и ПИТ, и реанимация не ошибка
      if (settingFit(recommendedSetting(db, m, rm.done, venue.bedside), rm.plan.setting, alsoSettings(db, m, rm.done)) === 'ok') placed++;
      // окно — на минуту решения: пришёл через 47 часов, и два часа ушло на обследование — рибавирин уже не показан
      if (m.truth.values['hx.onset_hours'] + rm.minutes / 60 < 48) {
        window++;
        if (rm.plan.treatments.includes(RIBA)) inWindow++;
      } else if (rm.plan.treatments.includes(RIBA)) late++;
      if (run(patient('severe', 109_000 + i)).plan.treatments.includes('tx.iv_fluids')) fluids++;
      const c = run(patient('complicated', 110_000 + i, true));
      if (c.plan.setting === 'ricu' && c.plan.treatments.includes('tx.steroid_iv')) ricu++;
    }
    expect(right / n).toBeGreaterThan(0.85);
    expect(placed / n).toBeGreaterThan(0.85);
    expect(window).toBeGreaterThan(3);
    expect(inWindow / window).toBeGreaterThan(0.6);
    expect(late).toBe(0);
    expect(fluids / n).toBeGreaterThan(0.85);
    expect(ricu / n).toBeGreaterThan(0.85);
  }, 180_000);
});
