// Присасывание клеща и болезнь Лайма (spec 2026-10-chapter-4, часть 51а): клеща удаляют и исследуют ПЦР; вирус клещевого
// энцефалита у непривитого — иммуноглобулин в первые 72 часа (567_2, раздел 5.1), боррелии — антибиотик не позже 5 суток (566_2,
// раздел 5.1). Без антибиотика после клеща с боррелиями возвращаются с мигрирующей эритемой. Болезнь Лайма — эритема, неврит
// лицевого нерва, кардит с АВ-блокадой; лечат в инфекционном отделении (566_2, разделы 3 и 3.2).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, examFits, runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { evaluatePlan, type Plan, recommendedSetting, tacticsFor, txRole, verdictOf } from '../../src/engine/med/plan';
import { examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { whenText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const TICK = 'cond.tick_bite';
const LYME = 'cond.lyme';
const PCR = 'exam.tick_pcr';
const DEPTS = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
const CLEAN = { attached: 'yes', tbe: 'no', borrelia: 'no', vaccinated: 'no' };
const BORRELIA = { attached: 'no', tbe: 'no', borrelia: 'yes', vaccinated: 'no' };
const VIRUS = { attached: 'yes', tbe: 'yes', borrelia: 'no', vaccinated: 'no' };

const patient = (primary: Id, params: Record<string, string> = {}, seed = 5151): Patient =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: DEPTS, season: 'spring', primary, params, walkIn: true });
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const home = (treatments: string[]): Plan => ({ treatments, setting: 'home' });

/** Доля больных с признаком — по генератору. */
function share(primary: Id, params: Record<string, string>, f: string, n = 300): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (has(patient(primary, params, 70_000 + i), f)) k++;
  return k / n;
}

describe('присасывание клеща: болезнь и признаки', () => {
  test('травма инфекционного отделения, приходят сами, лечат дома; клещи — с весны по осень, зимой их нет', () => {
    expect(db.conditions[TICK]).toMatchObject({ department: 'dept.infectious', kind: 'injury', severity: 'minor', confirm: 'clinical', icd10: 'T14.0' });
    expect(db.conditions[TICK].arrival).toBeUndefined();
    expect(db.conditions[TICK].isolation).toBeUndefined();
    const who = { sex: 'f' as const, age: 50, risks: [], chronic: [] };
    for (const id of [TICK, LYME]) {
      expect(presentingWeight(db.conditions[id], { ...who, season: 'winter' })).toBe(0);
      expect(presentingWeight(db.conditions[id], { ...who, season: 'summer' })).toBeGreaterThan(0);
    }
    expect(presentingWeight(db.conditions[TICK], { ...who, season: 'spring' })).toBeGreaterThan(presentingWeight(db.conditions[LYME], { ...who, season: 'spring' }));
  });

  test('жалоба — у каждого; клещ в коже — у тех, кто его не снял; что нашли в клеще — по параметрам', () => {
    const p = patient(TICK, CLEAN);
    expect(p.complaints).toContain('sym.tick_bite');
    expect([has(p, 'sign.tick_attached'), has(p, 'hx.tick_hours'), has(p, 'lab.tick_tbe'), has(p, 'lab.tick_borrelia')]).toEqual([true, true, false, false]);
    expect(share(TICK, BORRELIA, 'sign.tick_attached')).toBe(0);
    expect(share(TICK, BORRELIA, 'lab.tick_borrelia')).toBe(1);
    expect(share(TICK, VIRUS, 'lab.tick_tbe')).toBe(1);
    expect(share(TICK, { ...CLEAN, vaccinated: 'yes' }, 'hx.tbe_vaccinated')).toBe(1);
  });

  test('часы от присасывания — по записи болезни: в первые 72 часа приходят 9 из 10; окна идут по часам', () => {
    let early = 0;
    const n = 400;
    for (let i = 0; i < n; i++) if (patient(TICK, CLEAN, 71_000 + i).truth.values['hx.tick_hours'] < 72) early++;
    expect(early / n).toBeGreaterThan(0.8);
    expect(early / n).toBeLessThan(0.97);
    expect(db.conditions[TICK].derived).toMatchObject({ h72: { f: 'hx.tick_hours', below: 72, clock: true }, d5: { f: 'hx.tick_hours', below: 120, clock: true } });
  });

  test('ПЦР клеща — только пришедшим с клещом: лаборатория, кровь не нужна — забор клеща в процедурном', () => {
    expect(db.exams[PCR]).toMatchObject({ room: 'room.lab', collect: 'room.procedure', complaints: ['sym.tick_bite'] });
    expect(db.exams[PCR].checks.map(c => c.f)).toEqual(['lab.tick_tbe', 'lab.tick_borrelia']);
    expect(examFits(db.exams[PCR], patient(TICK, CLEAN))).toBe(true);
    expect(examFits(db.exams[PCR], patient(LYME, { form: 'erythema' }))).toBe(false);
    expect(db.exams['exam.ask_tick'].routineFor).toEqual(['sym.tick_bite']);
    expect(db.exams['exam.general_exam'].routineFor).toContain('sym.tick_bite');
  });
});

describe('присасывание клеща: профилактика', () => {
  const params = (p: Record<string, string>) => patient(TICK, p).truth.conditions[0].params;

  test('клещ в коже — удалить; вирус у непривитого в первые 72 часа — иммуноглобулин; боррелии в первые 5 суток — антибиотик', () => {
    const t = db.conditions[TICK].treatment!;
    expect([t.firstLine, t.setting.default]).toEqual([['tx.tick_watch'], 'home']);
    expect(tacticsFor(t, params(CLEAN)).require).toEqual(['tx.tick_removal']);
    expect(tacticsFor(t, params(VIRUS)).prevent).toEqual(['tx.tbe_ig']);
    expect(tacticsFor(t, params({ ...VIRUS, vaccinated: 'yes' })).prevent).toBeUndefined();
    expect(tacticsFor(t, params(BORRELIA)).require).toEqual([['tx.doxycycline', 'tx.amoxicillin']]);
    expect(tacticsFor(t, { ...params(BORRELIA), d5: 'no' }).require).toBeUndefined();
    expect(tacticsFor(t, { ...params(VIRUS), h72: 'no' }).prevent).toBeUndefined();
  });

  test('без удаления клеща и иммуноглобулина — неполное лечение; иммуноглобулин без вируса — не показан', () => {
    const virus = patient(TICK, VIRUS);
    const ev = evaluatePlan(db, virus, home(['tx.tick_watch']), []);
    expect([ev.requireMissing, ev.preventMissing]).toEqual([['tx.tick_removal'], ['tx.tbe_ig']]);
    expect(evaluatePlan(db, virus, home(['tx.tick_removal', 'tx.tbe_ig', 'tx.tick_watch']), []).preventMissing).toEqual([]);
    expect(txRole(db, TICK, 'tx.tbe_ig', patient(TICK, CLEAN).truth.conditions[0].params)).toBe('notIndicated');
    expect(txRole(db, TICK, 'tx.iodophenazone', patient(TICK, CLEAN).truth.conditions[0].params)).toBe('acceptable');
  });

  test('боррелии: доксициклин или амоксициллин — хватит одного; без антибиотика — неполное, «при боррелиях в клеще»', () => {
    const p = patient(TICK, BORRELIA);
    expect(evaluatePlan(db, p, home(['tx.tick_watch']), []).requireMissing).toEqual(['tx.doxycycline']);
    expect(evaluatePlan(db, p, home(['tx.amoxicillin', 'tx.tick_watch']), []).requireMissing).toEqual([]);
    expect(evaluatePlan(db, p, home(['tx.doxycycline', 'tx.tick_watch']), []).effective).toBe(true);
    expect(whenText({ borrelia: ['yes'], d5: ['yes'] })).toBe('при боррелиях в клеще и в первые 5 суток от присасывания');
  });

  test('без антибиотика после клеща с боррелиями возвращаются с болезнью Лайма — у 12 из 100; с доксициклином — редко', () => {
    const p = patient(TICK, BORRELIA);
    const lyme = (plan: Plan) => Array.from({ length: 1000 }, (_, i) => observe(db, p, plan, evaluatePlan(db, p, plan, []), Rng.seeded(i).fork('out')))
      .filter(o => o.returns?.as === LYME).length / 1000;
    const without = lyme(home(['tx.tick_watch']));
    expect(without).toBeGreaterThan(0.08);
    expect(without).toBeLessThan(0.16);
    expect(lyme(home(['tx.doxycycline', 'tx.tick_watch']))).toBeLessThan(0.04);
    const clean = patient(TICK, CLEAN);
    const plan = home(['tx.tick_removal', 'tx.tick_watch']);
    expect(Array.from({ length: 200 }, (_, i) => observe(db, clean, plan, evaluatePlan(db, clean, plan, []), Rng.seeded(i).fork('out'))).every(o => o.kind === 'recovered')).toBe(true);
  });
});

describe('болезнь Лайма', () => {
  test('формы: эритема — у каждого с эритемной, неврит лицевого нерва — с нейроборрелиозом, АВ-блокада — с кардитом', () => {
    expect(share(LYME, { form: 'erythema' }, 'sign.erythema_migrans')).toBe(1);
    expect(patient(LYME, { form: 'erythema' }).complaints).toContain('sym.rash_ring');
    expect(share(LYME, { form: 'neuro' }, 'sign.facial_palsy_peripheral')).toBe(1);
    expect(share(LYME, { form: 'carditis' }, 'ecg.av_block')).toBe(1);
    expect(share(LYME, { form: 'erythema' }, 'ecg.av_block')).toBe(0);
    const tick = share(LYME, { form: 'erythema' }, 'hx.tick_bite_recent');
    expect(tick).toBeGreaterThan(0.7);
    expect(tick).toBeLessThan(0.9);
  });

  test('эритема — доксициклин внутрь; нервы и сердце — антибиотик в вену; палата, при блокаде — ПИТ', () => {
    const t = db.conditions[LYME].treatment!;
    expect(t.firstLine).toEqual(['tx.doxycycline']);
    expect(tacticsFor(t, { form: 'neuro' }).firstLine).toEqual(['tx.antibiotic_iv']);
    expect(tacticsFor(t, { form: 'carditis' }).firstLine).toEqual(['tx.antibiotic_iv']);
    expect(recommendedSetting(db, patient(LYME, { form: 'erythema' }), [])).toBe('ward');
    expect(recommendedSetting(db, patient(LYME, { form: 'carditis' }), [])).toBe('icu');
    expect(db.conditions[LYME].isolation).toBeUndefined();
    const p = patient(LYME, { form: 'erythema' });
    expect(evaluatePlan(db, p, { treatments: ['tx.doxycycline'], setting: 'admit' }, []).effective).toBe(true);
    expect(evaluatePlan(db, patient(LYME, { form: 'carditis' }), { treatments: ['tx.amoxicillin'], setting: 'icu' }, []).effective).toBe(false);
  });

  test('энциклопедия: условия по клещу и форме — словами; «С чем спутать» — присасывание, паралич Белла, АВ-блокада', () => {
    for (const [name, values] of [['attached', ['yes', 'no']], ['tbe', ['yes', 'no']], ['borrelia', ['yes', 'no']], ['vaccinated', ['yes', 'no']], ['d5', ['yes', 'no']], ['form', ['erythema', 'neuro', 'carditis']]] as const) {
      for (const v of values) expect(whenText({ [name]: [v] })).toEqual(expect.any(String));
    }
    expect(db.conditions[LYME].differential).toEqual([TICK, 'cond.bell_palsy', 'cond.av_block']);
    for (const id of [TICK, LYME, PCR, 'exam.borrelia_elisa', 'tx.tbe_ig']) expect(article(db, id)).toBeDefined();
  });
});

describe('разумный врач при клеще и болезни Лайма', () => {
  const candidates = Object.keys(db.conditions).filter(id => db.conditions[id].presenting && DEPTS.includes(db.conditions[id].department));
  const exams = Object.keys(db.exams).sort();
  const venue = { ward: true, icu: true, ricu: true, box: true, bedside: ['eq.monitor_defib'] };

  function run(p: Patient): { done: string[]; diagnosis: string; plan: Plan } {
    const observations: Observation[] = complaintObservations(p);
    const done: string[] = [];
    const rng = Rng.seeded(p.seed).fork('doctor:rational');
    let phase = {};
    let t = 0;
    for (;;) {
      const r = nextStep(db, p, observations, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes: t } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, diagnosis: r.step.diagnosis, plan: r.step.plan };
      observations.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
      done.push(r.step.exam);
      t += examMinutes(db.exams[r.step.exam]);
    }
  }

  test('с клещом — расспрос, осмотр и ПЦР клеща; профилактика по ответу; дома', () => {
    const n = 20;
    let pcr = 0, doxy = 0, ig = 0, home = 0;
    for (let i = 0; i < n; i++) {
      const borrelia = run(patient(TICK, BORRELIA, 72_000 + i));
      const virus = run(patient(TICK, VIRUS, 73_000 + i));
      for (const r of [borrelia, virus]) {
        if (r.done.includes(PCR) && r.done.includes('exam.ask_tick')) pcr++;
        if (r.plan.setting === 'home' && r.diagnosis === TICK) home++;
      }
      if (borrelia.plan.treatments.includes('tx.doxycycline')) doxy++;
      if (virus.plan.treatments.includes('tx.tbe_ig')) ig++;
    }
    expect(pcr).toBe(2 * n);
    expect(home).toBe(2 * n);
    expect(doxy / n).toBeGreaterThan(0.7);
    expect(ig / n).toBeGreaterThan(0.6);
  }, 60_000);

  test('с растущим пятном ставит болезнь Лайма и назначает доксициклин', () => {
    const n = 20;
    let right = 0, doxy = 0;
    for (let i = 0; i < n; i++) {
      const p = patient(LYME, { form: 'erythema' }, 74_000 + i);
      const r = run(p);
      if (verdictOf(db, r.diagnosis, p) === 'correct') right++;
      if (r.plan.treatments.includes('tx.doxycycline')) doxy++;
    }
    expect(right / n).toBeGreaterThan(0.85);
    expect(doxy / n).toBeGreaterThan(0.85);
  }, 60_000);
});
