// Менингококковая инфекция и люмбальная пункция (spec 2026-10-chapter-4, часть 50а): менингит, менингококкемия или их
// сочетание, шок и отёк мозга (1020_1); пункция у постели в смотровой приёмного — ликвор в лабораторию; правило «Можно ли
// пункцию» (приложение А3.3) — пункт есть, и пункция может кончиться вклинением мозга или кровотечением: смерть в первые
// сутки, в разборе — опасное решение. Разумный врач пункцию при противопоказании не делает и сначала проверяет пункты.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { ContentDb } from '../../src/content/types';
import { P_ONE, Rng } from '../../src/engine/core/rng';
import { examHarmOutcome } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan, examHarmsOf, recommendedSetting, settingFit, tacticsFor } from '../../src/engine/med/plan';
import { examMinutes, indicated, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import { checkRule, harmCheck, knownOf } from '../../src/engine/med/rules';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { makeCaseView, noteText, outcomeText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const MC = 'cond.meningococcal';
const LP = 'exam.lumbar_puncture';
const RULE = 'rule.lp_safe';
const DEPTS = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
const MENINGITIS = { form: 'meningitis', shock: 'no', edema: 'no' };
const EDEMA = { form: 'meningitis', shock: 'no', edema: 'yes' };
const SHOCK = { form: 'sepsis', shock: 'yes', edema: 'no' };

const patient = (params: Record<string, string>, seed = 5050): Patient =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: DEPTS, season: 'winter', primary: MC, params, carried: db.economy.ambulance.weight });
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const obs = (f: string, shown: boolean, exam = 'exam.neuro_exam'): Observation => ({ f, shown, exam });

/** Доля больных с признаком — по генератору. */
function share(params: Record<string, string>, f: string, primary = MC, n = 300): number {
  let k = 0;
  for (let i = 0; i < n; i++) {
    const p = generatePatient(db, 50_000 + i, { department: 'dept.therapy', departments: DEPTS, season: 'winter', primary, params, carried: db.economy.ambulance.weight });
    if (has(p, f)) k++;
  }
  return k / n;
}

/** Та же база, но осложнение пункции при противопоказании — всегда: проверяем, что бывает, а не как часто. */
const sure: ContentDb = { ...db, exams: { ...db.exams, [LP]: { ...db.exams[LP], harm: { ...db.exams[LP].harm!, p: P_ONE } } } };

describe('менингококковая инфекция: формы и признаки', () => {
  test('шок — у менингококкемии и сочетанной формы, отёк мозга — у менингита и сочетанной: производные параметры по ним', () => {
    const params = (x: Record<string, string>) => patient(x).truth.conditions[0].params;
    expect(params({ form: 'meningitis', shock: 'yes', edema: 'no' })).toMatchObject({ itsh: 'no', ongm: 'no' });
    expect(params(SHOCK)).toMatchObject({ itsh: 'yes', ongm: 'no' });
    expect(params({ form: 'sepsis', shock: 'no', edema: 'yes' })).toMatchObject({ itsh: 'no', ongm: 'no' });
    expect(params({ form: 'mixed', shock: 'yes', edema: 'yes' })).toMatchObject({ itsh: 'yes', ongm: 'yes' });
    // привозит скорая, заразна по воздуху, в инфекционное отделение
    expect(db.conditions[MC]).toMatchObject({ arrival: 'ambulance', isolation: 'airborne', department: 'dept.infectious' });
  });

  test('сыпь — у менингококкемии, у менингита её нет; у менингита — сильная головная боль, ригидность и изменённый ликвор', () => {
    expect(share({ form: 'sepsis', shock: 'no', edema: 'no' }, 'sign.petechial_rash')).toBeGreaterThan(0.9);
    expect(share(MENINGITIS, 'sign.petechial_rash')).toBe(0);
    expect(share(MENINGITIS, 'sym.headache')).toBe(1);
    expect(share(MENINGITIS, 'sign.neck_stiffness')).toBeGreaterThan(0.6);
    expect(share(MENINGITIS, 'lab.csf_pleocytosis')).toBe(1);
    expect(share(MENINGITIS, 'lab.csf_purulent')).toBeGreaterThan(0.6);
    expect(share({ form: 'sepsis', shock: 'no', edema: 'no' }, 'lab.csf_pleocytosis')).toBe(0);
    // шок — давление ниже 90 у каждого, лактат почти у каждого
    expect(share(SHOCK, 'vital.bp_low')).toBe(1);
    expect(share(SHOCK, 'lab.lactate_high')).toBeGreaterThan(0.9);
  });

  test('отёк мозга — кома у каждого: число шкалы Глазго 5–8, оглушения нет — кома его снимает', () => {
    expect(share(EDEMA, 'sign.gcs_coma')).toBe(1);
    expect(share(EDEMA, 'sign.gcs_low')).toBe(0);
    const p = patient(EDEMA);
    const gcs = p.truth.values['sign.gcs_low'];
    expect(gcs).toBeGreaterThanOrEqual(5);
    expect(gcs).toBeLessThanOrEqual(8);
    // неврологический осмотр: число — из комы, «Кома» показана, «сознание ясное» не пишется
    const seen = runExam(db, p, 'exam.neuro_exam', Rng.seeded(7), undefined, true);
    expect(seen.find(o => o.f === 'sign.gcs_low')).toMatchObject({ shown: false, value: gcs });
    expect(seen.find(o => o.f === 'sign.gcs_coma')).toMatchObject({ shown: true, value: gcs });
    expect(db.findings['sign.gcs_low'].texts.absent![0].ru).not.toContain('ясное');
  });

  test('субарахноидальное кровоизлияние — кровь в ликворе у каждого, внутримозговое — у половины', () => {
    expect(share({}, 'lab.csf_blood', 'cond.sah')).toBe(1);
    const ich = share({}, 'lab.csf_blood', 'cond.ich', 400);
    expect(ich).toBeGreaterThan(0.4);
    expect(ich).toBeLessThan(0.6);
  });
});

describe('правило «Можно ли пункцию»', () => {
  const rule = db.rules[RULE];

  test('пункт есть — нельзя; проверено всё и пунктов нет — можно; иначе — пока неизвестно и что осталось', () => {
    expect(db.exams[LP].harm?.rule).toBe(RULE);
    expect(rule.decides).toBe(LP);
    expect(harmCheck(db, LP, knownOf([obs('sign.gcs_coma', true)])).verdict).toBe('yes');
    const none = rule.any.map(f => obs(f, false));
    expect(harmCheck(db, LP, knownOf(none))).toEqual({ verdict: 'no', left: [] });
    const some = harmCheck(db, LP, knownOf(none.filter(o => o.f !== 'lab.platelets_low')));
    expect(some).toEqual({ verdict: 'unknown', left: ['lab.platelets_low'] });
    // у обследования без вреда спрашивать нечего
    expect(harmCheck(db, 'exam.cbc', knownOf([]))).toEqual({ verdict: 'no', left: [] });
  });

  test('в карте — только при менингеальных знаках или геморрагической сыпи: у каждого с головной болью его нет', () => {
    const base = patient(MENINGITIS);
    const rows = (arrived: Observation[]) => makeCaseView({
      version: 0, patient: { ...base, complaints: ['sym.headache', 'sym.fever_hx'] }, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: arrived.length ? [{ exam: 'exam.neuro_exam', step: 1, at: 600, obs: arrived }] : [], pending: [], meanwhile: [], done: arrived.length ? ['exam.neuro_exam'] : [],
      draft: { treatments: [], setting: 'home' }, departments: DEPTS,
    }).rules.filter(r => r.id === RULE);
    expect(rows([])).toEqual([]);
    expect(rows([obs('sign.neck_stiffness', false)])).toEqual([]);
    const open = rows([obs('sign.neck_stiffness', true), obs('sign.gcs_coma', false), obs('sign.hemiparesis', false)]);
    expect(open).toHaveLength(1);
    expect(open[0].text.startsWith('Проверьте: ')).toBe(true);
    expect(open[0].text).toContain('тромбоциты ниже 100');
    expect(open[0].text).not.toContain('кома');
    expect(rows([obs('sign.neck_stiffness', true), obs('sign.gcs_coma', true)])[0].text).toBe('Пункцию нельзя — сначала стабилизировать, лечить не дожидаясь ликвора: кома по шкале комы Глазго');
  });

  test('qSOFA: кома — тот же балл за нарушение сознания', () => {
    const qsofa = db.rules['rule.qsofa'];
    const known = knownOf([obs('sym.fever_hx', true, 'complaint'), obs('vital.bp_low', true, 'exam.vitals'), obs('vital.tachypnea', false, 'exam.vitals'), obs('sign.gcs_low', false), obs('sign.gcs_coma', true)]);
    expect(checkRule(qsofa, 30, known)).toMatchObject({ verdict: 'yes', points: { min: 2, max: 2 } });
  });

  test('энциклопедия: у пункции — «Когда нельзя» с правилом, у правила — что оно решает', () => {
    const exam = article(db, LP)!;
    expect(exam.blocks.find(b => b.key === 'harm')?.refs?.map(r => r.id)).toEqual([RULE]);
    expect(article(db, RULE)!.blocks.find(b => b.key === 'decides')?.refs?.map(r => r.id)).toEqual([LP]);
  });
});

describe('пункция при противопоказании: разбор и исход', () => {
  const plan = { treatments: ['tx.blood_culture', 'tx.antibiotic_iv'], setting: 'box' as const };

  test('знал о пункте — опасное решение (D), не проверил — C; противопоказания нет — ничего; и когда ликвор ещё не пришёл', () => {
    const p = patient(EDEMA);
    const coma = [...complaintObservations(p), obs('sign.gcs_coma', true)];
    const known = evaluatePlan(db, p, plan, coma, { done: [LP] });
    expect(known.examHarms).toEqual([{ exam: LP, by: ['sign.gcs_coma'], known: true }]);
    const unchecked = evaluatePlan(db, p, plan, complaintObservations(p), { done: [LP] });
    expect(unchecked.examHarms).toEqual([{ exam: LP, by: ['sign.gcs_coma'], known: false }]);
    // результат пришёл — пункция видна и по наблюдениям
    expect(evaluatePlan(db, p, plan, [obs('lab.csf_purulent', true, LP)]).examHarms).toHaveLength(1);
    expect(evaluatePlan(db, patient(MENINGITIS), plan, [], { done: [LP] }).examHarms).toEqual([]);
    const grade = (ev: typeof known) => scoreCase({ verdict: 'correct', confidence: 0.9, cost: 50, rationalCost: 50, selfLimiting: false, redFlags: [], plan: ev, outcome: { kind: 'admitted', day: 0, cured: true } });
    expect(grade(known).safety).toBe('D');
    expect(grade(known).overall).not.toBe('A');
    expect(grade(unchecked).safety).toBe('C');
    const note = grade(known).notes.find(n => n.code === 'safety.examHarmKnown')!;
    expect(noteText(note)).toBe('Люмбальная пункция: противопоказано (кома по шкале комы Глазго), и вы об этом знали');
    expect(noteText(grade(unchecked).notes.find(n => n.code === 'safety.examHarmUnchecked')!)).toBe('Люмбальная пункция: противопоказано (кома по шкале комы Глазго) — вы не проверили, а оно было');
  });

  test('осложнение: отпустили или перевели — смерть в первые сутки, в мягком режиме — перевод в тяжёлом состоянии; лежит у нас — поступил', () => {
    const p = patient(EDEMA);
    const ev = evaluatePlan(sure, p, plan, [], { done: [LP] });
    const rng = () => Rng.seeded(11);
    const home = examHarmOutcome(sure, { ...plan, setting: 'ambulance' }, ev, rng());
    expect(home).toMatchObject({ kind: 'died', day: 0, examHarm: { exam: LP, by: ['sign.gcs_coma'] } });
    expect(examHarmOutcome(sure, { ...plan, setting: 'ambulance' }, ev, rng(), true)).toMatchObject({ kind: 'transferred', severe: true });
    expect(examHarmOutcome(sure, plan, ev, rng())).toMatchObject({ kind: 'admitted', examHarm: { exam: LP } });
    // без противопоказания и с полосой 0 — осложнения нет
    expect(examHarmOutcome(sure, plan, evaluatePlan(sure, patient(MENINGITIS), plan, [], { done: [LP] }), rng())).toBeUndefined();
    const never: ContentDb = { ...db, exams: { ...db.exams, [LP]: { ...db.exams[LP], harm: { ...db.exams[LP].harm!, p: 0 } } } };
    expect(examHarmOutcome(never, plan, ev, rng())).toBeUndefined();
    expect(outcomeText(home!, 'ambulance', false)).toBe('Осложнение после обследования «Люмбальная пункция» — было противопоказание. Умер на 1-е сутки');
  });
});

describe('разумный врач и пункция', () => {
  const candidates = Object.keys(db.conditions).filter(id => db.conditions[id].presenting && DEPTS.includes(db.conditions[id].department));
  const exams = Object.keys(db.exams).sort();
  const venue = { ward: true, icu: true, ricu: true, box: true, bedside: ['eq.monitor_defib'] };

  /** Шаги разумного врача до решения: что сделал и что решил. */
  function run(p: Patient): { done: string[]; observations: Observation[]; diagnosis: string; plan: { treatments: string[]; setting: string } } {
    const observations: Observation[] = complaintObservations(p);
    const done: string[] = [];
    const rng = Rng.seeded(p.seed).fork('doctor:rational');
    let phase = {};
    let t = 0;
    for (;;) {
      const r = nextStep(db, p, observations, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes: t } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, observations, diagnosis: r.step.diagnosis, plan: r.step.plan };
      observations.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
      done.push(r.step.exam);
      t += examMinutes(db.exams[r.step.exam]);
    }
  }

  test('при известном противопоказании пункция не показана и её не делают; пункцию — только после проверки пунктов', () => {
    const coma = patient(EDEMA);
    expect(indicated(db, coma, [obs('sign.gcs_coma', true)], candidates, LP)).toBe(false);
    let punctured = 0;
    for (let i = 0; i < 40; i++) {
      const r = run(patient(MENINGITIS, 51_000 + i));
      expect(examHarmsOf(db, patient(MENINGITIS, 51_000 + i), r.done, r.observations)).toEqual([]);
      const at = r.done.indexOf(LP);
      if (at < 0) continue;
      punctured++;
      // к пункции пункты правила проверены: осмотр невролога, давление и сатурация, анализ крови, лекарства
      for (const e of ['exam.neuro_exam', 'exam.vitals', 'exam.cbc', 'exam.ask_meds']) expect(r.done.indexOf(e)).toBeLessThan(at);
    }
    expect(punctured).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) expect(run(patient(EDEMA, 52_000 + i)).done).not.toContain(LP);
  });

  test('лечение: посев крови и антибиотик — всем; шок — растворы и норэпинефрин в ПИТ; отёк мозга — дексаметазон и ИВЛ в реанимации; без осложнений — бокс', () => {
    const t = db.conditions[MC].treatment!;
    const tactic = (params: Record<string, string>) => tacticsFor(t, patient(params).truth.conditions[0].params);
    expect(t.require).toEqual(['tx.blood_culture', 'tx.antibiotic_iv']);
    expect(tactic(SHOCK).require).toEqual(expect.arrayContaining(['tx.norepinephrine', ['tx.balanced_fluids', 'tx.iv_fluids']]));
    expect(tactic(EDEMA).require).toEqual(expect.arrayContaining(['tx.steroid_iv', 'tx.ventilation']));
    expect(tactic(MENINGITIS).acceptable).toContain('tx.steroid_iv');
    expect(tactic({ form: 'sepsis', shock: 'no', edema: 'no' }).notIndicated).toContain('tx.steroid_iv');
    expect(recommendedSetting(db, patient(MENINGITIS), [])).toBe('box');
    expect(recommendedSetting(db, patient(SHOCK), [])).toBe('icu');
    expect(recommendedSetting(db, patient(EDEMA), [])).toBe('ricu');
    expect([settingFit('icu', 'ricu'), settingFit('box', 'home')]).toEqual(['ok', 'under']);
    const shock = run(patient(SHOCK, 53_000));
    expect(shock.diagnosis).toBe(MC);
    expect(shock.plan.treatments).toEqual(expect.arrayContaining(['tx.blood_culture', 'tx.antibiotic_iv', 'tx.norepinephrine']));
    expect(shock.plan.setting).toBe('icu');
  });

  test('сроки: антибиотик — в первый час от сыпи или гнойного ликвора, реанимация — в 30 минут от нарастающей сыпи', () => {
    expect(db.targets['target.meningococcal_abx']).toMatchObject({ from: 'finding', minutes: 60, treatments: ['tx.antibiotic_iv'] });
    expect(db.targets['target.meningococcal_abx'].findings).toEqual(['sign.petechial_rash', 'sign.rash_spreading', 'lab.csf_purulent']);
    expect(db.targets['target.meningococcal_icu']).toMatchObject({ from: 'finding', minutes: 30, findings: ['sign.rash_spreading'] });
  });
});

/** Песочница с амбулаторией и боксом справа от коридора; медсестра ЭКГ — в бокс. */
function withBox(cdb: ContentDb, seed = 50): ShiftState {
  const s = newSandbox(cdb, { seed, season: 'winter', start: 'clinic', budget: cdb.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(cdb, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(cdb, s, { kind: 'build', cmd: { kind: 'room', type: 'room.box', size: 'S', x: 29, y: 0, rot: 0 } });
  const box = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  apply(cdb, s, { kind: 'buildEnd' });
  apply(cdb, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: box });
  return s;
}

/** Первый в очереди — с менингитом и отёком мозга (кома), осмотрен неврологом; пункцию «сделали» — она в списке сделанного. */
function punctured(cdb: ContentDb, s: ShiftState): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(cdb, s, { kind: 'advance', seconds: 10 * 60 });
  const id = s.queue[0];
  const p = s.patients[id];
  p.patient = patient(EDEMA);
  apply(cdb, s, { kind: 'call', id });
  apply(cdb, s, { kind: 'exam', exam: 'exam.neuro_exam' });
  p.done.push(LP);
  apply(cdb, s, { kind: 'diagnose', id: MC });
  apply(cdb, s, { kind: 'toggleTreatment', id: 'tx.blood_culture' });
  apply(cdb, s, { kind: 'toggleTreatment', id: 'tx.antibiotic_iv' });
  apply(cdb, s, { kind: 'setting', setting: 'box' });
  apply(cdb, s, { kind: 'finish' });
  return p;
}

describe('смена: осложнение пункции у лежащего', () => {
  test('лёг в бокс — умирает в ночь этих суток, разбор и исход называют пункцию; в мягком режиме — перевод в тяжёлом состоянии', () => {
    for (const soft of [false, true]) {
      const s = withBox(sure);
      apply(sure, s, { kind: 'nextDay' });
      if (soft) apply(sure, s, { kind: 'soft', on: true });
      const p = punctured(sure, s);
      expect(p.status).toBe('admitted');
      expect(p.closed!.outcome).toMatchObject({ kind: 'admitted', examHarm: { exam: LP, by: ['sign.gcs_coma'] } });
      expect(p.stay!.dies).toBe(0);
      expect(p.closed!.notes.map(n => n.code)).toContain('safety.examHarmKnown');
      apply(sure, s, { kind: 'closeDay' });
      expect(p.closed!.outcome).toMatchObject(soft ? { kind: 'transferred', severe: true, examHarm: { exam: LP } } : { kind: 'died', examHarm: { exam: LP } });
      expect(s.summary.ward).toMatchObject(soft ? { severe: 1 } : { died: 1 });
    }
  });

  test('те же команды — тот же итог', () => {
    const once = () => {
      const s = withBox(db, 77);
      apply(db, s, { kind: 'nextDay' });
      punctured(db, s);
      apply(db, s, { kind: 'closeDay' });
      return JSON.stringify(s);
    };
    expect(once()).toBe(once());
  });
});
