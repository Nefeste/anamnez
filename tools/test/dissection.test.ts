// Расслоение аорты (spec 2026-10-chapter-3, часть 43а; 946_1): тип по Стэнфорду — скрытый параметр, его показывает
// КТ-ангиография атрибутом находки, оттуда и срез груди в карте; при внезапной рвущей боли — давление на обеих
// руках и КТ-ангиография каждому; обезболивание и антиимпульсная терапия обязательны и до перевода — морфин и
// бета-адреноблокатор в вену, при противопоказании — верапамил; нитроглицерин в вену — только с ними; тип A —
// перевод, тип B — своя ПИТ; тромболизис — вред; разумный врач у постели.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { paramBeliefs } from '../../src/engine/med/infer';
import { companionsOf, evaluatePlan, harmsOf, type Plan, settingFit, txAvailable, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import { observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { wardCourse } from '../../src/engine/shift/ward';
import { makeCaseView } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const AD = 'cond.aortic_dissection';
const MORPHINE = 'tx.morphine_iv';
const BB = 'tx.beta_blocker_iv';
const VERAPAMIL = 'tx.verapamil_iv';
const NITRO = 'tx.nitroglycerin_iv';
const LYSIS = 'tx.thrombolysis';
const PAIN = 'sym.tearing_pain';
const ARMS = 'sign.bp_arm_difference';
const WIDE = 'img.cxr_wide_mediastinum';
const CTA = 'img.cta_aortic_dissection';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const gen = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: AD, params });
/** Больные в возрасте болезни. */
function people(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = gen(seed, params);
    if (p.age >= db.conditions[AD].age.min) out.push(p);
  }
  return out;
}
/** Без астмы и ХОБЛ — противопоказаний бета-адреноблокатора; о них спрошено. */
const one = (params: Record<string, string>) => people(40, params).find(p => !p.truth.conditions.some(c => c.id === 'cond.asthma' || c.id === 'cond.copd'))!;
const seen = (f: Id, exam: Id, on = true, attrs?: Record<string, string>): Observation => ({ f, shown: on, exam, ...(attrs ? { attrs } : {}) });
/** КТ-ангиография показала тип — как у пациента; об астме и ХОБЛ спросили — их нет. */
const checked = (p: Patient): Observation[] => [
  ...complaintObservations(p),
  seen(CTA, 'exam.cta_chest', true, { extent: paramsOf(p).type }),
  seen('hx.asthma', 'exam.ask_chronic', false),
  seen('hx.copd', 'exam.ask_chronic', false),
];
const plan = (treatments: Id[], setting: Setting = 'ambulance'): Plan => ({ treatments: [...treatments].sort(), setting });

describe('каталог', () => {
  test('терапия, критическая, только со скорой; диагноз — КТ-ангиографией; тип A — 62 из 100; место — ПИТ, тип A — перевод', () => {
    expect(db.conditions[AD]).toMatchObject({ department: 'dept.therapy', severity: 'critical', arrival: 'ambulance', confirm: ['exam.cta_chest'] });
    expect(db.conditions[AD].params!.type).toEqual({ a: 62, b: 38 });
    expect(db.conditions[AD].treatment!.setting).toEqual({ default: 'icu', param: { name: 'type', map: { a: 'transfer', b: 'icu' } } });
    // в 50 раз реже ОКС (946_1 и 157_5): новая полоса частоты — втрое реже ultra_rare
    expect(db.conditions[AD].weight).toBe(0.3);
    expect(db.conditions['cond.acs'].weight / db.conditions[AD].weight).toBe(100);
  });

  test('КТ-ангиография груди — в кабинете КТ, на любом томографе; при рвущей боли — каждому, как и давление на обеих руках', () => {
    const cta = db.exams['exam.cta_chest'];
    expect(cta).toMatchObject({ kind: 'imaging', room: 'room.ct', equipment: ['eq.ct_16', 'eq.ct_64'], radiation: 'high', routineFor: [PAIN] });
    expect(cta.checks).toEqual([{ f: CTA, sens: 9900, spec: 9800 }]);
    expect(db.exams['exam.bp_both_arms']).toMatchObject({ kind: 'bedside', routineFor: [PAIN] });
    expect(db.exams['exam.ask_chest_pain'].checks.some(k => k.f === PAIN)).toBe(true);
    expect(db.exams['exam.xray_chest'].checks.find(k => k.f === WIDE)).toMatchObject({ sens: 9500, spec: 9800 });
    // ЭКГ в первые 10 минут — и при рвущей боли: алгоритм начинается с неё
    expect(db.targets['target.ecg_chest_pain'].complaints).toContain(PAIN);
  });

  test('морфин, бета-адреноблокатор и нитроглицерин в вену — у постели под монитором; нитроглицерин при расслоении — только с урежающим пульс', () => {
    for (const tx of [MORPHINE, BB, NITRO]) expect({ tx, at: db.treatments[tx].bedside?.equipment, route: db.treatments[tx].route }).toEqual({ tx, at: [MONITOR], route: 'iv' });
    expect(companionsOf(db, NITRO, AD)).toEqual([[BB, VERAPAMIL]]);
    expect(companionsOf(db, NITRO, 'cond.acs')).toEqual([]);
    expect(db.treatments[BB].contraindications).toEqual([
      expect.objectContaining({ id: 'cond.asthma', level: 'absolute' }),
      expect.objectContaining({ id: 'cond.copd', level: 'relative' }),
    ]);
    // тип B стабилизируют лекарства; тип A без операции — нет
    for (const tx of [BB, VERAPAMIL]) expect(db.treatments[tx].effects.find(e => e.on === AD)).toMatchObject({ kind: 'cure', when: { type: ['b'] } });
  });
});

describe('больные', () => {
  const xs = people(1500);

  test('тип A — у 62 из 100; КТ-ангиография показывает тип атрибутом; рвущая боль у типа A — чаще в груди, у типа B — в спине', () => {
    const a = xs.filter(p => paramsOf(p).type === 'a');
    expect(Math.abs(a.length / xs.length - 0.62)).toBeLessThan(0.04);
    for (const p of xs) expect(p.truth.findings.find(f => f.f === CTA)!.attrs).toEqual({ extent: paramsOf(p).type });
    const chest = (ps: Patient[]) => ps.filter(p => p.truth.findings.find(f => f.f === PAIN && f.cause === AD)?.attrs?.site === 'chest').length / ps.filter(p => has(p, PAIN)).length;
    expect(chest(a)).toBeGreaterThan(0.75);
    expect(chest(xs.filter(p => paramsOf(p).type === 'b'))).toBeLessThan(0.45);
  });

  test('доли признаков: рвущая боль и D-димер — почти у всех, расширенное средостение — у 85 из 100, разница давления — у 30 при типе A и 15 при типе B', () => {
    const share = (ps: Patient[], f: Id) => ps.filter(p => p.truth.findings.some(x => x.f === f && x.cause === AD)).length / ps.length;
    expect(share(xs, PAIN)).toBeGreaterThan(0.9);
    expect(share(xs, 'lab.d_dimer_high')).toBeGreaterThan(0.94);
    expect(Math.abs(share(xs, WIDE) - 0.85)).toBeLessThan(0.04);
    expect(Math.abs(share(xs.filter(p => paramsOf(p).type === 'a'), ARMS) - 0.3)).toBeLessThan(0.05);
    expect(Math.abs(share(xs.filter(p => paramsOf(p).type === 'b'), ARMS) - 0.15)).toBeLessThan(0.05);
  });

  test('пришедший сам с расслоением не бывает — только со скорой', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', walkIn: true });
      expect(p.truth.conditions[0].id).not.toBe(AD);
    }
  });
});

describe('обследования и карта', () => {
  test('строки: тип A и B на КТ-ангиографии, разница давления числом, средостение', () => {
    const line = (o: Observation) => observationText(db, o, 'm', 1);
    expect(line(seen(CTA, 'exam.cta_chest', true, { extent: 'a' }))).toBe('Отслоённая интима в восходящей и нисходящей аорте, два просвета — расслоение типа A');
    expect(line(seen(CTA, 'exam.cta_chest', true, { extent: 'b' }))).toBe('Отслоённая интима в нисходящей аорте, два просвета; восходящая не расслоена — расслоение типа B');
    expect(line(seen(CTA, 'exam.cta_chest', false))).toBe('Расслоения аорты нет');
    expect(line({ ...seen(ARMS, 'exam.bp_both_arms'), value: 32 })).toBe('Верхнее давление на руках разное: разница 32 мм рт. ст.');
    expect(line({ ...seen(ARMS, 'exam.bp_both_arms', false), value: 4 })).toBe('Давление на обеих руках почти одинаковое: разница 4 мм рт. ст.');
    expect(line(seen(WIDE, 'exam.xray_chest'))).toBe('Верхнее средостение расширено, контур аорты изменён');
  });

  test('тип в выводе — из атрибута находки КТ-ангиографии: до неё — доли, после — то, что видно', () => {
    const p = (obs: Observation[]) => Object.fromEntries(paramBeliefs(db, AD, 'type', obs, 60).map(x => [x.value, Math.round(x.p * 100) / 100]));
    expect(p([])).toEqual({ a: 0.62, b: 0.38 });
    expect(p([seen(CTA, 'exam.cta_chest', true, { extent: 'b' })])).toEqual({ a: 0, b: 1 });
  });

  test('карта: КТ-ангиография — срезом груди с интимой по типу, без расслоения — обычный срез; рентген — расширенное средостение', () => {
    const groups = (p: Patient, exams: Id[]) => {
      const arrived = exams.map((exam, i) => ({ exam, step: i + 1, at: 600 + i, obs: runExam(db, p, exam, Rng.seeded(5).fork(exam), undefined, true) }));
      return makeCaseView({
        version: 0, patient: p, clock: 700, minutesSpent: 0, money: 0, step: exams.length, pending: [], meanwhile: [], done: [],
        draft: { treatments: [], setting: 'home' }, arrived, departments: ED, difficulty: 'doctor',
      }).groups;
    };
    const a = one({ type: 'a' });
    const b = one({ type: 'b' });
    expect(groups(a, ['exam.cta_chest']).find(g => g.exam === 'exam.cta_chest')!.image).toMatchObject({ kind: 'chestCt', findings: { dissection: 'a' } });
    expect(groups(b, ['exam.cta_chest']).find(g => g.exam === 'exam.cta_chest')!.image).toMatchObject({ kind: 'chestCt', findings: { dissection: 'b' } });
    // у больного без расслоения — обычный срез
    const flu = generatePatient(db, 3, { department: 'dept.therapy', departments: ED, season: 'winter', primary: 'cond.influenza' });
    expect(groups(flu, ['exam.cta_chest']).find(g => g.exam === 'exam.cta_chest')!.image).toEqual({ kind: 'chestCt', seed: expect.any(Number), findings: {} });
    const wide = people(40).find(p => has(p, WIDE))!;
    expect(groups(wide, ['exam.xray_chest']).find(g => g.exam === 'exam.xray_chest')!.image).toMatchObject({ kind: 'xray', wideMediastinum: true });
  });
});

describe('тактика и разбор', () => {
  const a = one({ type: 'a' });
  const b = one({ type: 'b' });
  const ev = (p: Patient, x: Plan, venue: Venue = BAY, obs = checked(p)) => evaluatePlan(db, p, x, obs, venue);
  const grade = (p: Patient, x: Plan, venue: Venue = BAY) => scoreCase({
    verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev(p, x, venue),
    outcome: { kind: x.setting === 'home' ? 'recovered' : x.setting === 'icu' ? 'admitted' : 'transferred', day: 0, cured: true }, selfLimiting: false, redFlags: [],
  });

  test('обезболивание и антиимпульсная терапия — обязательно и до перевода: морфин и бета-адреноблокатор или верапамил', () => {
    expect(ev(a, plan([])).requireMissing).toEqual([BB, MORPHINE]);
    expect(ev(a, plan([])).beforeTransferMissing).toEqual([BB, MORPHINE]);
    for (const x of [[MORPHINE, BB], [MORPHINE, VERAPAMIL]]) {
      const e = ev(a, plan(x));
      expect({ x, missing: [...e.requireMissing, ...e.beforeTransferMissing] }).toEqual({ x, missing: [] });
    }
    expect(txRole(db, AD, MORPHINE, paramsOf(a))).toBe('require');
    expect(grade(a, plan([MORPHINE, BB]))).toMatchObject({ treatment: 'A', setting: 'A', safety: 'A' });
    expect(grade(a, plan([])).treatment).not.toBe('A');
  });

  test('астма известна — бета-адреноблокатор нельзя, вместо него верапамил', () => {
    const asthma: Observation[] = [...checked(a).filter(o => o.f !== 'hx.asthma'), seen('hx.asthma', 'exam.ask_chronic')];
    expect(evaluatePlan(db, a, plan([MORPHINE]), asthma, BAY).requireMissing).toEqual([VERAPAMIL]);
  });

  test('где лечить: тип A — перевод, своя ПИТ — меньше нужного; тип B — своя ПИТ, перевод — не ошибка; домой — нельзя', () => {
    expect(ev(a, plan([MORPHINE, BB])).setting.recommended).toBe('transfer');
    expect(ev(b, plan([MORPHINE, BB], 'icu')).setting.recommended).toBe('icu');
    expect([settingFit('transfer', 'icu'), settingFit('icu', 'ambulance'), settingFit('icu', 'home')]).toEqual(['under', 'ok', 'under']);
    expect(grade(a, plan([MORPHINE, BB], 'icu')).setting).toBe('D');
    expect(grade(b, plan([MORPHINE, BB], 'icu'))).toMatchObject({ treatment: 'A', setting: 'A' });
    expect(grade(b, plan([MORPHINE, BB], 'ambulance')).setting).toBe('A');
  });

  test('нитроглицерин в вену — можно, но без бета-адреноблокатора или верапамила лечение неполное', () => {
    expect(txRole(db, AD, NITRO, paramsOf(b))).toBe('acceptable');
    expect(ev(b, plan([MORPHINE, NITRO, VERAPAMIL], 'icu')).companionsMissing).toEqual([]);
    expect(ev(b, plan([MORPHINE, NITRO], 'icu')).companionsMissing).toEqual([{ tx: BB, of: NITRO }]);
  });

  test('тромболизис — вред: дома реакция, в ПИТ — реакция на обходе; антикоагулянты 946_1 не обсуждает — «не нужно»', () => {
    for (const tx of [LYSIS, 'tx.thrombolysis_stroke']) expect(txRole(db, AD, tx, paramsOf(a))).toBe('harmful');
    for (const tx of ['tx.heparin_iv', 'tx.aspirin_acs', 'tx.clopidogrel']) expect(txRole(db, AD, tx, paramsOf(a))).toBe('notIndicated');
    expect(harmsOf(db, b.truth.conditions[0], [LYSIS, MORPHINE])).toEqual([{ tx: LYSIS, p: 7500, days: [0, 1] }]);
    const icu = plan([LYSIS, MORPHINE, BB], 'icu');
    const courses = Array.from({ length: 100 }, (_, i) => wardCourse(db, b, icu, evaluatePlan(db, b, icu, checked(b), BAY), Rng.seeded(i).fork('ward')));
    expect(courses.filter(c => c.reaction?.tx === LYSIS && c.reaction.by === AD).length).toBeGreaterThan(55);
    expect(grade(a, plan([MORPHINE, BB, LYSIS])).safety).not.toBe('A');
  });

  test('тип B в ПИТ: с бета-адреноблокатором — стабилизация и выписка через 5–9 дней; без него — хуже; дома — хуже', () => {
    const icu = plan([MORPHINE, BB], 'icu');
    const fine = Array.from({ length: 200 }, (_, i) => wardCourse(db, b, icu, evaluatePlan(db, b, icu, checked(b), BAY), Rng.seeded(i).fork('ward')));
    const ready = fine.filter(c => c.readyAfter !== undefined);
    expect(Math.abs(ready.length / 200 - 0.75)).toBeLessThan(0.08);
    for (const c of ready) expect(c.readyAfter! >= 5 && c.readyAfter! <= 9).toBe(true);
    const bare = plan([MORPHINE], 'icu');
    expect(wardCourse(db, b, bare, evaluatePlan(db, b, bare, checked(b), BAY), Rng.seeded(1).fork('ward')).worseAfter).toBeDefined();
    const home = plan([MORPHINE, BB], 'home');
    const outs = Array.from({ length: 100 }, (_, i) => observe(db, a, home, evaluatePlan(db, a, home, checked(a)), Rng.seeded(i).fork('out')));
    expect(outs.filter(o => o.kind === 'worse').length).toBeGreaterThan(85);
  });

  test('в кабинете без монитора морфин и бета-адреноблокатор в вену не назначить — не в вину', () => {
    for (const tx of [MORPHINE, BB, VERAPAMIL, NITRO]) expect(txAvailable(db, tx, {})).toBe(false);
    expect([...ev(a, plan([]), {}).requireMissing, ...ev(a, plan([]), {}).beforeTransferMissing]).toEqual([]);
  });
});

describe('энциклопедия', () => {
  test('где лечить — по типу; без лечения — по типу; обязательно — морфин и одно из; тромболизис — опасно', () => {
    const x = article(db, AD)!;
    expect(x.blocks.find(b => b.key === 'where')!.text).toEqual([
      'Обычно — палата интенсивной терапии.',
      'Своей палаты интенсивной терапии нет — скорая, больница.',
      'При расслоении восходящей аорты (тип A) — скорая, перевод в центр.',
      'В стационаре обычно 5–9\u00a0дней.',
    ]);
    expect(x.blocks.find(b => b.key === 'course')!.text).toEqual([
      'При расслоении восходящей аорты (тип A) без действенного лечения почти всегда становится хуже — на 0–1-й день.',
      'При расслоении без восходящей аорты (тип B) без действенного лечения обычно становится хуже — на 1–3-й день.',
    ]);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Обязательно']).toEqual([MORPHINE]);
    expect(rows['Обязательно — одно из']).toEqual([BB, VERAPAMIL]);
    expect(rows['Опасно']).toEqual([LYSIS, 'tx.thrombolysis_stroke']);
  });

  test('признаки: рвущая боль — без условия, у обоих типов одинаково часто; разница давления — при типе A, у него чаще', () => {
    const signs = article(db, AD)!.blocks.find(b => b.key === 'signs')!.rows!.flatMap(r => r.refs.map(y => ({ band: r.label, id: y.id, note: y.note })));
    expect(signs.find(x => x.id === PAIN)).toEqual({ band: 'Почти всегда', id: PAIN, note: undefined });
    expect(signs.find(x => x.id === ARMS)!.note).toBe('при расслоении восходящей аорты (тип A)');
    // и в статье самого признака
    const where = article(db, PAIN)!.blocks.find(b => b.key === 'inConditions')!.rows!.flatMap(r => r.refs);
    expect(where.find(y => y.id === AD)!.note).toBeUndefined();
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

  test('у постели в приёмном: ЭКГ, давление на обеих руках и КТ-ангиография; морфин и бета-адреноблокатор; тип A — перевод, B — ПИТ', () => {
    const xs = people(60, {}, 8_100_001);
    let right = 0;
    for (const p of xs) {
      const r = run(p, BAY, ED);
      expect(r.done).toEqual(expect.arrayContaining(['exam.ecg', 'exam.bp_both_arms']));
      if (r.diagnosis !== AD) continue;
      right++;
      const e = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect({ seed: p.seed, harmful: e.roles.filter(x => x.role === 'harmful').map(x => x.tx), missing: [...e.requireMissing, ...e.beforeTransferMissing] })
        .toEqual({ seed: p.seed, harmful: [], missing: [] });
      expect(r.plan.treatments).toContain(MORPHINE);
      // КТ-ангиография показала тип — место по нему
      const typed = r.obs.find(o => o.f === CTA && o.shown)?.attrs?.extent;
      if (typed) expect({ seed: p.seed, setting: r.plan.setting }).toEqual({ seed: p.seed, setting: typed === 'a' ? 'ambulance' : 'icu' });
    }
    expect(right / xs.length).toBeGreaterThan(0.9);
    expect(xs.filter(p => run(p, BAY, ED).done.includes('exam.cta_chest')).length / xs.length).toBeGreaterThan(0.9);
  }, 60_000);
});
