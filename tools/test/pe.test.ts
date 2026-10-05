// Тромбоэмболия лёгочной артерии (spec 2026-10-chapter-3, часть 43б; ESC 2019 в переводе РКЖ 2020;25(8):3848, PIOPED
// II): своя жалоба — внезапная одышка; Женевская шкала решает, сразу КТ-ангиография или сначала D-димер; на
// КТ-ангиографии — тромбы в ветвях лёгочного ствола по стороне, оттуда и срез груди в карте, и расширенный правый
// желудочек; шок — тромболизис с гепарином в вену и ПИТ, без шока тромболизис вреден; место — по sPESI, и врач,
// поставивший ТЭЛА, считает её, даже если КТ-ангиография тромбы пропустила; нелеченый тромбоз вен ноги возвращается
// ТЭЛА.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { knownForRule, paramBeliefs } from '../../src/engine/med/infer';
import { asSeen, evaluatePlan, type Plan, txAvailable, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { checkRule, knownOf, rulesFor } from '../../src/engine/med/rules';
import { observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const PE = 'cond.pe';
const CTA = 'img.cta_pe';
const RV = 'img.cta_rv_overload';
const SUDDEN = 'sym.dyspnea_sudden';
const LYSIS = 'tx.thrombolysis_pe';
const HEPARIN = 'tx.heparin_iv';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const gen = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: PE, params });
/** Больные в возрасте болезни. */
function people(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = gen(seed, params);
    if (p.age >= db.conditions[PE].age.min) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true, attrs?: Record<string, string>): Observation => ({ f, shown: on, exam, ...(attrs ? { attrs } : {}) });
/** Всё, что видит врач, — правда: каждое обследование показало то, что есть. */
const truthful = (p: Patient, exams: Id[]): Observation[] => [
  ...complaintObservations(p),
  ...exams.flatMap((exam, i) => runExam(db, p, exam, Rng.seeded(i).fork(exam), undefined, true)),
];
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
const ALL = ['exam.ask_chronic', 'exam.ask_leg', 'exam.vitals', 'exam.troponin_hs', 'exam.d_dimer', 'exam.cta_chest', 'exam.us_leg_veins'];

describe('каталог', () => {
  test('терапия, угрожает жизни, приходят и сами; диагноз — КТ-ангиографией; доли параметров; место — дома, sPESI 1 и больше — палата, красный флаг — ПИТ', () => {
    const c = db.conditions[PE];
    expect(c).toMatchObject({ department: 'dept.therapy', severity: 'critical', confirm: ['exam.cta_chest'], redFlags: ['vital.bp_low', RV] });
    expect(c.arrival).toBeUndefined();
    expect(c.params).toMatchObject({ shock: { no: 95, yes: 5 }, rv: { no: 75, yes: 25 }, dvt: { no: 60, yes: 40 }, side: { both: 60, right: 25, left: 15 } });
    expect(c.derived).toEqual({ spo2_below90: { f: 'vital.spo2_low', below: 90 }, spesi: 'rule.spesi' });
    expect(c.treatment!.setting).toMatchObject({ default: 'home', param: { name: 'spesi', map: { yes: 'ward', no: 'home' } }, redFlag: 'icu', without: { equipment: [MONITOR], setting: 'ward' } });
    // 39–115 на 100 000 в год против около 300 у ОКС: полоса — в 10 раз реже ОКС, у скорой — около 22 на 100 ОКС
    expect(db.conditions['cond.acs'].weight / c.weight).toBe(10);
  });

  test('КТ-ангиография: тромбы — 83 из 100 и 96 (PIOPED II), правый желудочек — только при найденных тромбах; рак — и в расспросе о хронических болезнях', () => {
    const cta = db.exams['exam.cta_chest'];
    expect(cta.checks.find(k => k.f === CTA)).toMatchObject({ sens: 8300, spec: 9600 });
    expect(cta.checks.find(k => k.f === RV)).toMatchObject({ sens: 9000, spec: 9500, given: CTA });
    expect(cta.checks.some(k => k.f === 'img.cta_aortic_dissection')).toBe(true);
    for (const e of ['exam.ask_chronic', 'exam.ask_leg']) expect(db.exams[e].checks.some(k => k.f === 'hx.cancer_active')).toBe(true);
    expect(db.exams['exam.ask_complaints'].checks.some(k => k.f === SUDDEN)).toBe(true);
    // одышка — у каждого, у кого она началась внезапно: на расспросе не будет «одышки нет»
    expect(db.findings['sym.dyspnea'].follows).toEqual([SUDDEN]);
  });

  test('тромболизис при ТЭЛА — у постели под монитором, с гепарином в вену; противопоказания — как в табл. 10', () => {
    expect(db.treatments[LYSIS]).toMatchObject({ route: 'iv', bedside: { equipment: [MONITOR] }, companions: [HEPARIN] });
    expect(db.treatments[LYSIS].contraindications.map(k => [k.id, k.level])).toEqual([
      ['risk.stroke_history', 'absolute'], ['risk.recent_bleed_surgery', 'absolute'], ['risk.bleeding_tendency', 'absolute'],
      ['risk.anticoagulants', 'relative'], ['risk.pregnancy', 'relative'],
    ]);
    expect(txAvailable(db, LYSIS, {})).toBe(false);
    expect(txAvailable(db, LYSIS, BAY)).toBe(true);
    // тромболизис при ТЭЛА вредит при кровоизлиянии в мозг и расслоении аорты, как и другие
    for (const c of ['cond.ich', 'cond.sah', 'cond.aortic_dissection']) expect(db.conditions[c].treatment!.harmful).toContain(LYSIS);
  });

  test('тромбоз вен ноги без лечения возвращается ТЭЛА', () => {
    expect(db.conditions['cond.dvt'].untreated).toEqual([{ p: 5000, days: [3, 21], as: PE }]);
  });
});

describe('больные', () => {
  const xs = people(1500);
  const share = (ps: Patient[], f: Id) => ps.filter(p => p.truth.findings.some(x => x.f === f && x.cause === PE)).length / ps.length;

  test('доли параметров: шок — 5 из 100, расширенный правый желудочек — 25, тромб в венах ноги — 40', () => {
    const part = (name: string, v: string) => xs.filter(p => paramsOf(p)[name] === v).length / xs.length;
    expect(Math.abs(part('shock', 'yes') - 0.05)).toBeLessThan(0.02);
    expect(Math.abs(part('rv', 'yes') - 0.25)).toBeLessThan(0.03);
    expect(Math.abs(part('dvt', 'yes') - 0.4)).toBeLessThan(0.04);
  });

  test('признаки (PIOPED II): одышка — у 73 из 100, внезапно — у 53, и при ней одышка всегда; D-димер — у 95; при шоке давление ниже 90 — у всех; КТ — сторона атрибутом', () => {
    expect(Math.abs(share(xs, SUDDEN) - 0.53)).toBeLessThan(0.04);
    expect(Math.abs(share(xs, 'sym.dyspnea') - 0.73)).toBeLessThan(0.04);
    for (const p of xs) if (has(p, SUDDEN)) expect({ seed: p.seed, dyspnea: has(p, 'sym.dyspnea') }).toEqual({ seed: p.seed, dyspnea: true });
    expect(Math.abs(share(xs, 'lab.d_dimer_high') - 0.95)).toBeLessThan(0.02);
    expect(Math.abs(share(xs, 'sym.hemoptysis') - 0.05)).toBeLessThan(0.02);
    for (const p of xs) {
      expect(p.truth.findings.find(f => f.f === CTA)!.attrs).toEqual({ side: paramsOf(p).side });
      if (paramsOf(p).shock === 'yes') expect(has(p, 'vital.bp_low')).toBe(true);
      const byPe = (f: Id) => p.truth.findings.some(x => x.f === f && x.cause === PE);
      expect({ seed: p.seed, rv: byPe(RV) }).toEqual({ seed: p.seed, rv: paramsOf(p).rv === 'yes' || paramsOf(p).shock === 'yes' });
      expect({ seed: p.seed, us: byPe('img.us_dvt_prox') }).toEqual({ seed: p.seed, us: paramsOf(p).dvt === 'yes' });
      if (paramsOf(p).rv === 'yes') expect(has(p, 'lab.troponin_high')).toBe(true);
    }
  });

  test('sPESI — по настоящим пунктам: хоть один — «yes»', () => {
    const items = db.rules['rule.spesi'].points!.items.map(i => i.f);
    for (const p of xs.slice(0, 400)) {
      const any = p.age >= 81 || items.some(f => has(p, f));
      expect({ seed: p.seed, spesi: paramsOf(p).spesi }).toEqual({ seed: p.seed, spesi: any ? 'yes' : 'no' });
    }
  });

  test('приходят и сами: ТЭЛА бывает у пришедших без скорой', () => {
    let walk = 0;
    for (let seed = 1; seed <= 20_000 && walk === 0; seed++) {
      const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', walkIn: true });
      if (p.truth.conditions[0].id === PE) walk++;
    }
    expect(walk).toBeGreaterThan(0);
  });
});

describe('правила', () => {
  const geneva = db.rules['rule.geneva'];
  const spesi = db.rules['rule.spesi'];
  const known = (yes: Id[], no: Id[] = []) => (f: Id) => (yes.includes(f) ? true : no.includes(f) ? false : undefined);

  test('Женевская шкала — при внезапной одышке и кровохарканье, не при всякой одышке', () => {
    const base = { age: 50, complaints: [SUDDEN] };
    expect(rulesFor(db, base).map(r => r.id)).toEqual(expect.arrayContaining(['rule.geneva', 'rule.spesi']));
    expect(rulesFor(db, { age: 50, complaints: ['sym.dyspnea'] }).map(r => r.id)).not.toContain('rule.geneva');
    expect(geneva.exams).toEqual(['exam.cta_chest']);
  });

  test('Женевская шкала: 5 баллов и больше — КТ-ангиография сразу; меньше — по D-димеру', () => {
    const items = ['hx.prior_dvt', 'hx.recent_bleed_surgery', 'hx.leg_cast', 'sym.hemoptysis', 'hx.cancer_active', 'sym.leg_pain', 'sign.deep_vein_tenderness'];
    // пульс чаще 100 — 2 балла, старше 65 — 1, тромбоз в прошлом и рак — по 1: 5 баллов — да без D-димера
    expect(checkRule(geneva, 70, known(['vital.tachycardia', 'hx.prior_dvt', 'hx.cancer_active'], items)).verdict).toBe('yes');
    // 4 балла: D-димер решает
    const four = ['vital.tachycardia', 'hx.prior_dvt', 'hx.cancer_active'];
    expect(checkRule(geneva, 50, known(four, items)).verdict).toBe('unknown');
    expect(checkRule(geneva, 50, known([...four, 'lab.d_dimer_high'], items)).verdict).toBe('yes');
    expect(checkRule(geneva, 50, known(four, [...items, 'lab.d_dimer_high'])).verdict).toBe('no');
  });

  test('sPESI: применяют при тромбах на КТ-ангиографии; 0 баллов — дома, 1 и больше — в стационаре; решает место', () => {
    expect(spesi).toMatchObject({ requires: [CTA], onlyIfApplies: true, place: true, points: { from: 1 } });
    const items = spesi.points!.items.map(i => i.f);
    expect(checkRule(spesi, 50, known([CTA], items)).verdict).toBe('no');
    expect(checkRule(spesi, 50, known([CTA, 'vital.spo2_low'], items)).verdict).toBe('yes');
    expect(checkRule(spesi, 85, known([CTA], items)).verdict).toBe('yes');
    // в карте без тромбов на КТ шкалу не считают
    expect(checkRule(spesi, 50, known(['vital.spo2_low'], [CTA, ...items])).applies).toBe(false);
  });

  test('врач, поставивший ТЭЛА, считает sPESI и при тромбах, которых КТ-ангиография не показала', () => {
    const missed: Observation[] = [seen(CTA, 'exam.cta_chest', false), seen('vital.tachycardia', 'exam.vitals'), seen('vital.spo2_low', 'exam.vitals', false)];
    const k = knownForRule(db.conditions[PE], spesi, missed);
    expect(k(CTA)).toBe(true);
    expect(knownOf(missed)(CTA)).toBe(false);
    const beliefs = (obs: Observation[]) => Object.fromEntries(paramBeliefs(db, PE, 'spesi', obs, 50).map(x => [x.value, x.p]));
    expect(beliefs(missed)).toEqual({ no: 0, yes: 1 });
    const none = ['hx.cancer_active', 'hx.heart_failure', 'hx.copd', 'vital.tachycardia', 'vital.bp_low', 'vital.spo2_low'].map(f => seen(f, 'exam.vitals', false));
    expect(beliefs([seen(CTA, 'exam.cta_chest', false), ...none])).toEqual({ no: 1, yes: 0 });
    // условие, которого у болезни нет всегда (признаки травмы при сотрясении), — по наблюдениям, как раньше
    const ct = db.rules['rule.ct_head'];
    expect(knownForRule(db.conditions['cond.concussion'], ct, [])(ct.requires![0])).toBeUndefined();
    // и в разборе: КТ тромбы пропустила — sPESI по пунктам
    const p = people(200).find(x => paramsOf(x).spesi === 'yes' && has(x, 'vital.tachycardia'))!;
    expect(asSeen(db, p, [seen(CTA, 'exam.cta_chest', false), seen('vital.tachycardia', 'exam.vitals')]).spesi).toBe('yes');
  });
});

describe('обследования и карта', () => {
  test('строки: тромбы по стороне, правый желудочек, внезапная одышка', () => {
    const line = (o: Observation) => observationText(db, o, 'm', 1);
    expect(line(seen(CTA, 'exam.cta_chest', true, { side: 'both' }))).toBe('Дефекты наполнения в ветвях обеих лёгочных артерий — тромбоэмболия');
    expect(line(seen(CTA, 'exam.cta_chest', true, { side: 'right' }))).toBe('Дефекты наполнения в правой лёгочной артерии и её ветвях — тромбоэмболия');
    expect(line(seen(CTA, 'exam.cta_chest', false))).toBe('Дефектов наполнения в лёгочных артериях нет');
    expect(line(seen(RV, 'exam.cta_chest')).startsWith('Правый желудочек шире левого')).toBe(true);
  });

  test('карта: КТ-ангиография — срез с тромбами по стороне; без ТЭЛА — обычный срез', () => {
    const image = (p: Patient) => {
      const arrived = [{ exam: 'exam.cta_chest', step: 1, at: 600, obs: runExam(db, p, 'exam.cta_chest', Rng.seeded(5).fork('cta'), undefined, true) }];
      return makeCaseView({
        version: 0, patient: p, clock: 700, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [],
        draft: { treatments: [], setting: 'home' }, arrived, departments: ED, difficulty: 'doctor',
      }).groups.find(g => g.exam === 'exam.cta_chest')!.image;
    };
    for (const side of ['both', 'right', 'left'] as const) expect(image(people(1, { side })[0])).toMatchObject({ kind: 'chestCt', findings: { pe: side } });
    const flu = generatePatient(db, 3, { department: 'dept.therapy', departments: ED, season: 'winter', primary: 'cond.influenza' });
    expect(image(flu)).toEqual({ kind: 'chestCt', seed: expect.any(Number), findings: {} });
  });
});

describe('тактика и разбор', () => {
  const xs = people(800);
  const pick = (f: (p: Patient) => boolean) => xs.find(p => f(p) && !p.truth.risks.some(r => db.treatments[LYSIS].contraindications.some(k => k.id === r)))!;
  const shock = pick(p => paramsOf(p).shock === 'yes');
  const low = pick(p => paramsOf(p).shock === 'no' && paramsOf(p).rv === 'no' && paramsOf(p).spesi === 'no' && paramsOf(p).spo2_below90 === 'no');
  const ward = pick(p => paramsOf(p).shock === 'no' && paramsOf(p).rv === 'no' && paramsOf(p).spesi === 'yes' && paramsOf(p).spo2_below90 === 'no');
  const rv = pick(p => paramsOf(p).shock === 'no' && paramsOf(p).rv === 'yes' && paramsOf(p).spo2_below90 === 'no');
  const hypox = pick(p => paramsOf(p).shock === 'no' && paramsOf(p).spo2_below90 === 'yes');
  const ev = (p: Patient, x: Plan) => evaluatePlan(db, p, x, truthful(p, ALL), BAY);

  test('шок: обязательно тромболизис и гепарин в вену, место — ПИТ; без них — «не назначено»', () => {
    expect(ev(shock, plan([])).requireMissing).toEqual(expect.arrayContaining([HEPARIN, LYSIS]));
    const e = ev(shock, plan([LYSIS, HEPARIN, ...(paramsOf(shock).spo2_below90 === 'yes' ? ['tx.oxygen_mask'] : [])], 'icu'));
    expect({ missing: e.requireMissing, harmful: e.roles.filter(r => r.role === 'harmful').map(r => r.tx) }).toEqual({ missing: [], harmful: [] });
    expect(e.setting.recommended).toBe('icu');
    expect(txRole(db, PE, 'tx.doac', paramsOf(shock))).toBe('notIndicated');
  });

  test('без шока тромболизис вреден; ацетилсалициловая кислота и антибиотики — не нужны', () => {
    expect(txRole(db, PE, LYSIS, paramsOf(low))).toBe('harmful');
    for (const tx of ['tx.aspirin_acs', 'tx.amoxicillin', 'tx.thrombolysis', 'tx.thrombolysis_stroke']) expect(txRole(db, PE, tx, paramsOf(low))).toBe('notIndicated');
  });

  test('низкий риск: ПОАК дома — без замечаний; sPESI 1 и больше — палата; расширенный правый желудочек — ПИТ', () => {
    const e = ev(low, plan(['tx.doac'], 'home'));
    expect({ role: txRole(db, PE, 'tx.doac', paramsOf(low)), setting: e.setting.recommended, missing: e.requireMissing }).toEqual({ role: 'firstLine', setting: 'home', missing: [] });
    expect(ev(ward, plan(['tx.lmwh'], 'admit')).setting.recommended).toBe('ward');
    expect(txRole(db, PE, 'tx.lmwh', paramsOf(ward))).toBe('firstLine');
    expect(ev(rv, plan(['tx.lmwh'], 'icu')).setting.recommended).toBe('icu');
    // низкий риск в стационаре — не ошибка (ранняя выписка — IIa A)
    expect(ev(low, plan(['tx.doac'], 'admit')).setting.also).toEqual(['ward']);
  });

  test('в кабинете поликлиники без монитора — ни КТ-ангиографии, ни ранней выписки: в стационар', () => {
    const e = evaluatePlan(db, low, plan(['tx.lmwh'], 'ward'), truthful(low, ['exam.ask_chronic', 'exam.vitals', 'exam.d_dimer']), {});
    expect(e.setting.recommended).toBe('ward');
    expect(txAvailable(db, 'tx.lmwh', {})).toBe(true);
  });

  test('сатурация ниже 90 — кислород обязателен', () => {
    expect(ev(hypox, plan(['tx.lmwh'], 'icu')).requireMissing).toContain('tx.oxygen_mask');
    expect(ev(hypox, plan(['tx.lmwh', 'tx.oxygen_mask'], 'icu')).requireMissing).toEqual([]);
  });

  test('тромбоз вен ноги без лечения: дома без антикоагулянта — часто возвращаются с ТЭЛА', () => {
    const dvt = generatePatient(db, 11, { department: 'dept.surgery', departments: ED, season: 'winter', primary: 'cond.dvt', params: { level: 'femoropopliteal' } });
    const bare = plan([], 'home');
    const outs = Array.from({ length: 200 }, (_, i) => observe(db, dvt, bare, evaluatePlan(db, dvt, bare, []), Rng.seeded(i).fork('out')));
    const back = outs.filter(o => o.returns?.as === PE);
    expect(Math.abs(back.length / outs.length - 0.5)).toBeLessThan(0.1);
    for (const o of back) expect(o.returns!.day >= 3 && o.returns!.day <= 21).toBe(true);
  });
});

describe('энциклопедия', () => {
  test('где лечить — по sPESI и красным флагам; обязательно при шоке — тромболизис и гепарин в вену; без шока тромболизис опасен', () => {
    const x = article(db, PE)!;
    expect(x.blocks.find(b => b.key === 'where')!.text).toEqual([
      'Обычно — дома.',
      'При sPESI 1\u00a0балл и больше — в стационаре.',
      'При красных флагах — палата интенсивной терапии.',
      'Без монитора с дефибриллятором у постели — в стационаре.',
      'Своей палаты интенсивной терапии нет — скорая, больница.',
      'При sPESI 0\u00a0баллов без красных флагов — можно и в стационаре.',
      'В стационаре обычно 5–9\u00a0дней.',
    ]);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Обязательно, при шоке — верхнем давлении ниже 90']).toEqual([LYSIS, HEPARIN]);
    expect(rows['Опасно, без шока']).toEqual([LYSIS]);
    expect(rows['Первая линия, без шока, без перегрузки правого желудочка и sPESI 0\u00a0баллов']).toEqual(['tx.doac']);
    expect(x.blocks.find(b => b.key === 'rules')!.refs!.map(y => y.id)).toEqual(['rule.geneva', 'rule.spesi']);
  });

  test('sPESI в энциклопедии решает место; тромбоз вен ноги без лечения — ТЭЛА', () => {
    expect(article(db, 'rule.spesi')!.blocks.find(b => b.key === 'place')!.text).toEqual(['Где лечить: дома или в стационаре.']);
    expect(article(db, 'cond.dvt')!.blocks.find(b => b.key === 'course')!.text).toEqual(['Без действенного лечения на 3–21-й день — тромбоэмболия лёгочной артерии у 50\u00a0%.']);
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

  test('у постели в приёмном: D-димер и КТ-ангиография; антикоагулянт — всем, тромболизис — только при шоке', () => {
    const xs = people(60, {}, 8_200_001);
    let right = 0;
    let cta = 0;
    for (const p of xs) {
      const r = run(p, BAY, ED);
      if (r.done.includes('exam.cta_chest')) cta++;
      if (r.diagnosis !== PE) continue;
      right++;
      const e = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect({ seed: p.seed, harmful: e.roles.filter(x => x.role === 'harmful').map(x => x.tx) }).toEqual({ seed: p.seed, harmful: [] });
      expect(r.plan.treatments.some(tx => ['tx.lmwh', 'tx.fondaparinux', HEPARIN, 'tx.doac'].includes(tx))).toBe(true);
      if (r.plan.treatments.includes(LYSIS)) expect(paramsOf(p).shock).toBe('yes');
    }
    expect(right / xs.length).toBeGreaterThan(0.85);
    // остальным ТЭЛА подтвердил тромб в венах ноги на УЗИ (ESC 2019, раздел 4.10, I A)
    expect(cta / xs.length).toBeGreaterThan(0.75);
  }, 60_000);
});
