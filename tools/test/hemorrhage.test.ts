// Кровоизлияния в мозг (spec 2026-10-chapter-3, часть 41в): внутримозговое и субарахноидальное по 523_3.
// КТ — кровь и её уточнения только при показанной крови; объём гематомы — одно число на два порога,
// гематома — в полушарии напротив слабости; давление в вену по тонометру, нейтрализация антикоагулянта
// по правилу, консультация нейрохирурга за 60 минут после КТ с кровью, место по объёму; тромболизис —
// вред; разумный врач, смена с приёмным, КТ и ПИТ, энциклопедия, срез КТ.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, RoomSizeId, Rot, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, patientAt } from '../../src/engine/med/generate';
import { expectedGain, contextOf, likelyParams, posterior } from '../../src/engine/med/infer';
import { asSeen, evaluatePlan, harmsOf, type Plan, txAvailable, txRole, type Venue } from '../../src/engine/med/plan';
import { choosePlan, type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, current, newSandbox } from '../../src/engine/shift/engine';
import { targetResults } from '../../src/engine/shift/targets';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { wardCourse } from '../../src/engine/shift/ward';
import { headGeometry } from '../../src/render/ct/geometry';
import { makeCaseView, noteText, outcomeText } from '../../src/state/caseView';
import { article, sectionView } from '../../src/state/encyclopedia';

const ICH = 'cond.ich';
const SAH = 'cond.sah';
const STROKE = 'cond.stroke_ischemic';
const CT = 'exam.ct_head';
const CTA = 'exam.cta_head';
const NEURO = 'exam.neuro_exam';
const BLOOD = 'img.ct_blood';
const HEMATOMA = 'img.ct_hematoma';
const LARGE = 'img.ct_hematoma_large';
const SAH_CT = 'img.ct_sah';
const BP = 'tx.bp_iv';
const PCC = 'tx.pcc';
const NSG = 'tx.nsg_consult';
const LYSIS = 'tx.thrombolysis_stroke';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR] };
const STROKE_SYMS = ['sym.weakness_one_side', 'sym.speech_trouble', 'sym.face_droop'];

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const gen = (cond: Id, seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.neurology', departments: ED, season: 'winter', primary: cond, params });
/** Первый больной этой болезнью от зерна `from`, в её возрасте, для которого верно `ok`. */
function find(cond: Id, ok: (p: Patient) => boolean = () => true, from = 1, params: Record<string, string> = {}): Patient {
  for (let seed = from; seed < from + 5000; seed++) {
    const p = gen(cond, seed, params);
    if (p.age >= db.conditions[cond].age.min && ok(p)) return p;
  }
  throw new Error('нет такого больного');
}
function people(cond: Id, n: number, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    const p = gen(cond, seed);
    if (p.age >= db.conditions[cond].age.min) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true, value?: number): Observation => ({ f, shown: on, exam, ...(value !== undefined ? { value } : {}) });
const ICU = (treatments: Id[], setting: Setting = 'icu'): Plan => ({ treatments, setting });

describe('каталог', () => {
  test('внутримозговое — неврология, критическое, привозит только скорая; САК — и приходят сами; КТ — каждому', () => {
    const ich = db.conditions[ICH];
    const sah = db.conditions[SAH];
    expect(ich).toMatchObject({ department: 'dept.neurology', system: 'nerves', severity: 'critical', arrival: 'ambulance', icd10: 'I61.9' });
    expect(sah).toMatchObject({ department: 'dept.neurology', system: 'nerves', severity: 'critical', icd10: 'I60.9' });
    expect(sah.arrival).toBeUndefined();
    for (const c of [ich, sah]) {
      expect(c.confirm).toEqual([CT, CTA]);
      expect(c.sources[0].url).toBe('https://cr.minzdrav.gov.ru/view-cr/523_3');
    }
    // мужчин в 1,6 раза больше; аневризмы у женщин в 1,5 раза чаще (523_3, раздел 1.3)
    expect(ich.sex).toEqual({ m: 1, f: 0.63 });
    expect(sah.sex).toEqual({ m: 0.67, f: 1 });
    // внезапная сильнейшая боль — типичное начало у 70 % (раздел 1.6)
    expect(sah.findings.find(l => l.f === 'sym.thunderclap')!.p).toBe(7000);
    expect(db.findings['sym.thunderclap']).toMatchObject({ redFlag: true, triage: 'red', salience: 3 });
  });

  test('КТ: кровь, и только когда она видна, — где она и сколько; объём гематомы — одно число на два порога', () => {
    const checks = db.exams[CT].checks;
    expect(checks.map(c => [c.f, c.given ?? null])).toEqual([[BLOOD, null], [HEMATOMA, BLOOD], [LARGE, null], [SAH_CT, BLOOD]]);
    expect(db.exams[CTA].checks.slice(0, 4)).toEqual(checks);
    expect(db.findings[LARGE].value!.of).toBe(HEMATOMA);
    expect([db.findings[HEMATOMA].value!.present, db.findings[LARGE].value!.present]).toEqual([[5, 29], [30, 80]]);
    // у гематомы строки «нет» нет: без неё КТ об объёме не пишет
    expect(db.findings[HEMATOMA].texts.absent).toBeUndefined();
    expect(db.findings[LARGE].texts.absent).toBeUndefined();
  });

  test('лечение: давление в вену — у постели под монитором; протромбиновый комплекс и консультация нейрохирурга — где угодно', () => {
    expect(db.treatments[BP]).toMatchObject({ kind: 'drug', route: 'iv', class: 'antihypertensive.iv', bedside: { equipment: [MONITOR] } });
    expect([txAvailable(db, BP), txAvailable(db, BP, BAY)]).toEqual([false, true]);
    expect(db.treatments[PCC]).toMatchObject({ kind: 'drug', route: 'iv', class: 'hemostatic.pcc' });
    expect(db.treatments[NSG]).toMatchObject({ kind: 'procedure', class: 'consult.neurosurgeon' });
    expect([txAvailable(db, PCC), txAvailable(db, NSG)]).toEqual([true, true]);
    // тромболизис при кровоизлиянии — вред: кровотечение
    for (const tx of [LYSIS, 'tx.thrombolysis']) expect(db.treatments[tx].effects.filter(e => e.kind === 'harm').map(e => e.on)).toEqual([ICH, SAH]);
  });

  test('сроки: КТ — и при внезапной сильнейшей головной боли, и после КТ с кровью; нейрохирург — 60 минут от КТ с кровью', () => {
    const ct = db.targets['target.stroke_ct'];
    expect(ct.complaints).toContain('sym.thunderclap');
    expect(ct.findings).toEqual([BLOOD]);
    expect(ct.from).toBe('arrival');
    expect(db.targets['target.neurosurgeon']).toMatchObject({ findings: [BLOOD], from: 'finding', treatments: [NSG], minutes: 60 });
  });

  test('скорая привозит на 100 ишемических инсультов около 12 внутримозговых и 3–4 субарахноидальных (523_3, раздел 1.3; 814_1, раздел 1.3)', () => {
    const n: Record<string, number> = {};
    for (let seed = 1; seed <= 15_000; seed++) {
      const p = generatePatient(db, 9_000_000 + seed, { department: 'dept.therapy', departments: ED, season: 'winter', walkIn: false, carried: db.economy.ambulance.weight });
      const id = p.truth.conditions[0].id;
      n[id] = (n[id] ?? 0) + 1;
    }
    const ich = n[ICH] / n[STROKE];
    const sah = n[SAH] / n[STROKE];
    expect(ich).toBeGreaterThan(0.08);
    expect(ich).toBeLessThan(0.17);
    expect(sah).toBeGreaterThan(0.015);
    expect(sah).toBeLessThan(0.07);
  }, 60_000);
});

describe('больные', () => {
  test('гематома — в полушарии напротив слабости; до 30 см³ — одна находка, больше — другая, число одно', () => {
    for (const p of people(ICH, 120, 100)) {
      const x = paramsOf(p);
      const f = x.volume === 'large' ? LARGE : HEMATOMA;
      const hematoma = p.truth.findings.find(t => t.f === f)!;
      expect(hematoma.attrs!.side).toBe(x.side === 'right' ? 'left' : 'right');
      expect(has(p, x.volume === 'large' ? HEMATOMA : LARGE)).toBe(false);
      const v = p.truth.values[HEMATOMA];
      if (x.volume === 'large') expect(v).toBeGreaterThanOrEqual(30);
      else expect(v).toBeLessThan(30);
      expect(has(p, BLOOD)).toBe(true);
      // очаговый дефицит на осмотре — у каждого
      expect(['sign.hemiparesis', 'sign.facial_weakness', 'sign.speech_deficit'].some(f => has(p, f))).toBe(true);
    }
  });

  test('САК: головная боль — почти у каждого, внезапная сильнейшая — примерно у 70 из 100; кровь в бороздах — у всех', () => {
    const all = people(SAH, 400, 100);
    expect(all.every(p => has(p, BLOOD) && has(p, SAH_CT))).toBe(true);
    expect(all.filter(p => has(p, 'sym.headache')).length / all.length).toBeGreaterThan(0.9);
    const sudden = all.filter(p => has(p, 'sym.thunderclap')).length / all.length;
    expect(Math.abs(sudden - 0.7)).toBeLessThan(0.07);
  });

  test('нейтрализация — по правилу на настоящих признаках: принимает антикоагулянты — да', () => {
    const on = find(ICH, p => p.truth.risks.includes('risk.anticoagulants'));
    const off = find(ICH, p => !p.truth.risks.includes('risk.anticoagulants'));
    expect([paramsOf(on).reversal, paramsOf(off).reversal]).toEqual(['yes', 'no']);
  });
});

describe('КТ', () => {
  test('без крови — уточнений нет; с кровью — гематома с полушарием и объёмом или кровь в бороздах', () => {
    const stroke = generatePatient(db, 5, { department: 'dept.neurology', departments: ED, season: 'winter', primary: STROKE });
    expect(runExam(db, stroke, CT, Rng.seeded(1).fork('ct')).map(o => o.f)).toEqual([BLOOD]);
    const small = find(ICH, p => paramsOf(p).volume === 'small');
    const obs = runExam(db, small, CT, Rng.seeded(2).fork('ct'), undefined, true);
    expect(obs.map(o => [o.f, o.shown])).toEqual([[BLOOD, true], [HEMATOMA, true], [LARGE, false], [SAH_CT, false]]);
    expect(obs[1].value).toBe(small.truth.values[HEMATOMA]);
    expect(obs[1].attrs!.side).toBe(paramsOf(small).side === 'right' ? 'left' : 'right');
    const large = find(ICH, p => paramsOf(p).volume === 'large');
    const big = runExam(db, large, CT, Rng.seeded(3).fork('ct'), undefined, true);
    expect(big.find(o => o.f === LARGE)).toMatchObject({ shown: true, attrs: { side: paramsOf(large).side === 'right' ? 'left' : 'right' } });
    const sah = find(SAH);
    expect(runExam(db, sah, CT, Rng.seeded(4).fork('ct'), undefined, true).filter(o => o.shown).map(o => o.f)).toEqual([BLOOD, SAH_CT]);
  });

  test('уточнение без показанной крови не делают, и порога на его числе тоже: противоречия «крови нет, а гематома есть» не бывает', () => {
    for (const p of people(ICH, 60, 300)) {
      for (let k = 0; k < 20; k++) {
        const obs = runExam(db, p, CT, Rng.seeded(k).fork(`ct:${p.seed}`));
        if (!obs.find(o => o.f === BLOOD)!.shown) expect(obs.map(o => o.f)).toEqual([BLOOD]);
      }
    }
  });

  test('ошиблась КТ в объёме — полушарие то же: число у двух находок одно, гематома тоже одна', () => {
    let misread = 0;
    for (const p of people(ICH, 80, 500).filter(x => paramsOf(x).volume === 'large')) {
      const side = p.truth.findings.find(t => t.f === LARGE)!.attrs!.side;
      for (let k = 0; k < 40; k++) {
        const small = runExam(db, p, CT, Rng.seeded(k).fork(`ct:${p.seed}`)).find(o => o.f === HEMATOMA && o.shown);
        if (!small) continue;
        misread++;
        expect(small.attrs!.side).toBe(side);
      }
    }
    // 2 из 100 — у КТ, на этих больных хоть раз
    expect(misread).toBeGreaterThan(0);
  });

  test('срез: гематома — пятно на её стороне, больше 30 см³ — со смещением; САК — светлые борозды и щели', () => {
    const view = (p: Patient, exam: Id) => {
      const obs = runExam(db, p, exam, Rng.seeded(7).fork('ct'), undefined, true);
      return makeCaseView({
        version: 0, patient: p, clock: 0, minutesSpent: 0, money: 0, step: 0, arrived: [{ exam, obs, at: 0, step: 1 }], pending: [], meanwhile: [], done: [exam], draft: { treatments: [], setting: 'icu' },
      }).groups.find(g => g.exam === exam)!.image!;
    };
    const large = find(ICH, p => paramsOf(p).volume === 'large' && paramsOf(p).side === 'right');
    const img = view(large, CTA);
    expect(img).toMatchObject({ kind: 'head', findings: { focus: { density: 'high', shape: 'blob', side: 'left' } } });
    if (img.kind !== 'head') throw new Error('не срез');
    expect(img.findings.shift).toBeGreaterThan(0);
    const small = find(ICH, p => paramsOf(p).volume === 'small');
    const s = view(small, CT);
    if (s.kind !== 'head') throw new Error('не срез');
    expect(s.findings.focus!.size).toBeLessThan(img.findings.focus!.size);
    expect(s.findings.shift).toBeUndefined();
    const sah = view(find(SAH), CT);
    if (sah.kind !== 'head') throw new Error('не срез');
    expect(sah.findings).toEqual({ sah: 0.7 });
    // в геометрии кровь — в доле борозд и в щелях; сам срез — тот же, что без неё
    const g = headGeometry({ sah: 0.7 }, 11);
    const plain = headGeometry({}, 11);
    expect(g.sah).toBe(true);
    expect(g.sulci.map(x => x.path)).toEqual(plain.sulci.map(x => x.path));
    const share = g.sulci.filter(x => x.blood).length / g.sulci.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.95);
    expect(plain.sulci.some(x => x.blood)).toBe(false);
  });

  test('польза уточнения в выводе — умноженная на вероятность, что кровь покажут', () => {
    const p = find(ICH);
    const obs = complaintObservations(p);
    const cands = candidatesOf(db, ED);
    const ctx = contextOf(db, p, obs);
    const beliefs = posterior(db, cands, obs, ctx);
    expect(expectedGain(db, CT, beliefs, ctx, new Set(obs.map(o => o.f)))).toBeGreaterThan(0);
  });
});

describe('тактика и разбор', () => {
  test('давление 140 и выше — снизить в вену, и до перевода; ниже 140 — не нужно; судят по тонометру', () => {
    const high = find(ICH, p => paramsOf(p).sbp140 === 'no' && paramsOf(p).reversal === 'no' && paramsOf(p).volume === 'small' && paramsOf(p).dysphagia === 'no');
    const measured = (v: number) => [seen('vital.bp_high', 'exam.vitals', v >= 141, v)];
    const ev = evaluatePlan(db, high, ICU([NSG]), measured(176), BAY);
    expect(ev.requireMissing).toEqual([BP]);
    expect(evaluatePlan(db, high, ICU([NSG], 'ambulance'), measured(176), BAY).beforeTransferMissing).toEqual([BP]);
    // тонометр показал 132: снижать нечего — по тому, что видел врач
    expect(asSeen(db, high, measured(132)).sbp140).toBe('yes');
    expect(evaluatePlan(db, high, ICU([NSG]), measured(132), BAY).requireMissing).toEqual([]);
    expect(evaluatePlan(db, high, ICU([NSG, BP]), measured(132), BAY).roles).toContainEqual({ tx: BP, role: 'notIndicated' });
    // не мерили — по правде
    expect(evaluatePlan(db, high, ICU([NSG]), [], BAY).requireMissing).toEqual([BP]);
    // без монитора у постели снижать в вену нельзя — и не в вину
    expect(evaluatePlan(db, high, ICU([NSG]), measured(176), {}).requireMissing).toEqual([]);
  });

  test('антикоагулянт — протромбиновый комплекс, и до перевода; витамин K1 — можно; без антикоагулянта — не нужно', () => {
    const on = find(ICH, p => p.truth.risks.includes('risk.anticoagulants') && paramsOf(p).sbp140 === 'yes' && paramsOf(p).dysphagia === 'no');
    expect(evaluatePlan(db, on, ICU([NSG]), [], BAY).requireMissing).toEqual([PCC]);
    expect(evaluatePlan(db, on, ICU([NSG], 'ambulance'), [], BAY).beforeTransferMissing).toEqual([PCC]);
    expect(txRole(db, ICH, 'tx.vitamin_k', paramsOf(on))).toBe('supportive');
    const off = find(ICH, p => !p.truth.risks.includes('risk.anticoagulants'));
    expect(txRole(db, ICH, PCC, paramsOf(off))).toBe('notIndicated');
  });

  test('правило «Нейтрализовать ли антикоагулянт»: ждёт крови на КТ; при крови в бороздах не применяют', () => {
    const rule = db.rules['rule.ich_reversal'];
    expect(rule).toMatchObject({ any: ['hx.anticoagulants'], requires: [BLOOD], excludes: [SAH_CT], decides: PCC, onlyIfApplies: true });
    const asked = seen('hx.anticoagulants', 'exam.ask_lysis');
    expect(checkRule(rule, 70, knownOf([asked])).verdict).toBe('unknown');
    expect(checkRule(rule, 70, knownOf([asked, seen(BLOOD, CT)])).verdict).toBe('yes');
    expect(checkRule(rule, 70, knownOf([asked, seen(BLOOD, CT), seen(SAH_CT, CT)])).verdict).toBe('no');
    expect(checkRule(rule, 70, knownOf([asked, seen(BLOOD, CT, false)])).verdict).toBe('no');
  });

  test('консультация нейрохирурга — обязательна у оставленного и до перевода; место — по объёму; САК — перевод', () => {
    const small = find(ICH, p => paramsOf(p).volume === 'small' && paramsOf(p).sbp140 === 'yes' && paramsOf(p).reversal === 'no' && paramsOf(p).dysphagia === 'no');
    expect(evaluatePlan(db, small, ICU([]), [], BAY).requireMissing).toEqual([NSG]);
    expect(evaluatePlan(db, small, ICU([NSG]), [], BAY)).toMatchObject({ requireMissing: [], setting: { recommended: 'icu' } });
    const large = find(ICH, p => paramsOf(p).volume === 'large');
    expect(evaluatePlan(db, large, ICU([NSG], 'ambulance'), [], BAY).setting.recommended).toBe('transfer');
    const sah = find(SAH, p => paramsOf(p).sbp160 === 'yes');
    const ev = evaluatePlan(db, sah, ICU([], 'ambulance'), [], BAY);
    expect(ev.setting.recommended).toBe('transfer');
    expect(ev.beforeTransferMissing).toEqual([NSG]);
    // при САК давление 160 и выше — снизить до перевода
    const hot = find(SAH, p => paramsOf(p).sbp160 === 'no');
    expect(evaluatePlan(db, hot, ICU([NSG], 'ambulance'), [], BAY).beforeTransferMissing).toEqual([BP]);
  });

  test('вредно: тромболизис, антиагреганты, антикоагулянты, глюкокортикоиды при ВМК; транексамовая кислота — не нужно', () => {
    for (const tx of [LYSIS, 'tx.thrombolysis', 'tx.aspirin_acs', 'tx.clopidogrel', 'tx.heparin_iv', 'tx.steroid_iv']) expect(txRole(db, ICH, tx)).toBe('harmful');
    expect(txRole(db, ICH, 'tx.tranexamic')).toBe('notIndicated');
    expect(txRole(db, SAH, LYSIS)).toBe('harmful');
    expect(txRole(db, SAH, 'tx.nimodipine')).toBe('supportive');
  });

  test('тромболизис при кровоизлиянии — кровотечение: дома — реакция и возврат, в ПИТ — реакция на обходе', () => {
    const p = find(ICH);
    expect(harmsOf(db, paramsOf(p) && p.truth.conditions[0], [LYSIS, BP])).toEqual([{ tx: LYSIS, p: 7500 }]);
    let reactions = 0;
    for (let i = 0; i < 200; i++) {
      const plan = ICU([LYSIS], 'home');
      const out = observe(db, p, plan, evaluatePlan(db, p, plan, []), Rng.seeded(i).fork('out'));
      if (out.kind === 'reaction') {
        reactions++;
        expect(out.reaction).toEqual({ tx: LYSIS, by: ICH });
      }
    }
    expect(Math.abs(reactions / 200 - 0.75)).toBeLessThan(0.08);
    expect(outcomeText({ kind: 'reaction', day: 1, cured: false, reaction: { tx: LYSIS, by: ICH } }, 'home', false)).toBe('На следующий день — реакция на тромболизис при ишемическом инсульте (внутримозговое кровоизлияние): вернётся на приём');
    const icu = ICU([LYSIS]);
    const courses = Array.from({ length: 100 }, (_, i) => wardCourse(db, p, icu, evaluatePlan(db, p, icu, [], BAY), Rng.seeded(i).fork('ward')));
    expect(courses.filter(c => c.reaction?.tx === LYSIS && c.reaction.by === ICH).length).toBeGreaterThan(55);
    // без вредного — острый период в ПИТ, последствия остаются
    const fine = ICU([NSG]);
    expect(wardCourse(db, p, fine, evaluatePlan(db, p, fine, [], BAY), Rng.seeded(1).fork('ward'))).toMatchObject({ settled: 'residual' });
  });
});

describe('разумный врач', () => {
  const cands = candidatesOf(db, ED);
  const exams = Object.keys(db.exams).sort();
  function run(p: Patient, venue: Venue) {
    const obs: Observation[] = complaintObservations(p);
    const done: Id[] = [];
    let phase: DoctorPhase = {};
    const rng = Rng.seeded(p.seed).fork('doctor');
    for (let k = 0; k < 40; k++) {
      const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
      const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...venue, minutes } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs, minutes };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }
  const venue: Venue = { ...BAY, icu: true };

  test('ВМК: осмотр, КТ — у каждого; диагноз верный почти у всех; консультация нейрохирурга в плане; место — по объёму', () => {
    const runs = people(ICH, 80, 40_001).map(p => ({ p, r: run(p, venue) }));
    const right = runs.filter(x => x.r.diagnosis === ICH);
    expect(right.length / runs.length).toBeGreaterThan(0.95);
    for (const { p, r } of runs) {
      // два срока по 10 минут — по порядку: ЭКГ при давящей боли в груди, потом осмотр
      expect(r.done[0]).toBe(p.complaints.includes('sym.chest_pain_pressing') ? 'exam.ecg' : NEURO);
      expect(r.done.some(e => e === CT || e === CTA)).toBe(true);
      if (r.diagnosis !== ICH) continue;
      expect(r.plan.treatments).toContain(NSG);
      expect(r.plan.treatments).not.toContain(LYSIS);
      const ev = evaluatePlan(db, patientAt(db, p, r.minutes).patient, r.plan, r.obs, { ...venue, minutes: r.minutes });
      // ошибается только там, где обманули тест глотания или КТ в объёме
      expect(ev.requireMissing.every(tx => tx === 'tx.ng_tube')).toBe(true);
      expect(ev.beforeTransferMissing).toEqual([]);
    }
    expect(right.some(x => x.r.plan.setting === 'ambulance')).toBe(true);
    expect(right.some(x => x.r.plan.setting === 'icu')).toBe(true);
  });

  test('САК с внезапной сильнейшей болью: КТ первым из обследований, перевод с консультацией; без ПИТ — так же', () => {
    const runs = people(SAH, 60, 40_001).filter(p => p.complaints.includes('sym.thunderclap')).map(p => ({ p, r: run(p, venue) }));
    expect(runs.length).toBeGreaterThan(20);
    for (const { r } of runs) {
      expect(r.diagnosis).toBe(SAH);
      expect(r.done.filter(e => db.exams[e].kind === 'imaging')[0]).toBe(CT);
      expect(r.plan.setting).toBe('ambulance');
      expect(r.plan.treatments).toContain(NSG);
    }
  });

  test('план по наблюдениям: давление — по тонометру, антикоагулянт — по ответу, место — по объёму', () => {
    const base = [seen(BLOOD, CT), seen(HEMATOMA, CT, true, 18), seen(LARGE, CT, false, 18), seen(SAH_CT, CT, false)];
    const asked = (on: boolean) => seen('hx.anticoagulants', 'exam.ask_lysis', on);
    const bp = (v: number) => seen('vital.bp_high', 'exam.vitals', v >= 141, v);
    expect(choosePlan(db, ICH, [...base, asked(false), bp(150), seen('sign.dysphagia', 'exam.swallow_test', false)], 70, venue)).toEqual({ treatments: [BP, NSG].sort(), setting: 'icu' });
    expect(choosePlan(db, ICH, [...base, asked(true), bp(128), seen('sign.dysphagia', 'exam.swallow_test', false)], 70, venue).treatments).toEqual([NSG, PCC].sort());
    const big = base.map(o => (o.f === HEMATOMA ? { ...o, shown: false, value: 46 } : o.f === LARGE ? { ...o, shown: true, value: 46 } : o));
    expect(likelyParams(db, ICH, big, 70).volume).toBe('large');
    expect(choosePlan(db, ICH, [...big, asked(false), bp(128)], 70, venue).setting).toBe('ambulance');
  });
});

/** Песочница: смотровая приёмного с монитором, кабинет КТ, ПИТ на две койки — как у инсульта. */
function hospital(o: { icu?: boolean } = {}): ShiftState {
  const s = newSandbox(db, { seed: 25, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  s.economy!.cash = 8_000_000;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  for (let y = 10; y <= 16; y++) cells.push([38, y]);
  for (let x = 29; x <= 38; x++) for (let y = 17; y <= 19; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  const build = (type: string, size: RoomSizeId, x: number, y: number, rot: Rot, equipment: string[]) => {
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type, size, x, y, rot } });
    const room = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    for (const e of equipment) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room, equipment: e } });
    return room;
  };
  const er = build('room.emergency', 'M', 29, 1, 0, [MONITOR]);
  const ct = build('room.ct', 'M', 29, 10, 2, ['eq.ct_16']);
  const icu = o.icu === false ? undefined : build('room.icu', 'S', 29, 20, 2, [MONITOR, MONITOR]);
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: er });
  const hire = (role: string, room: string) => {
    const c = s.candidates!.find(x => x.role === role && !s.staff!.some(m => m.id === x.id))!;
    apply(db, s, { kind: 'hire', id: c.id });
    apply(db, s, { kind: 'assign', id: c.id, room });
  };
  for (const role of ['role.radiographer', 'role.radiologist']) hire(role, ct);
  if (icu) for (const role of ['role.nurse', 'role.anesthetist']) hire(role, icu);
  apply(db, s, { kind: 'nextDay' });
  return s;
}

/** Первая машина скорой дня везёт этого больного; приехал — сортирован и вызван. */
function bring(s: ShiftState, patient: Patient): ShiftPatient {
  const p = Object.values(s.patients).filter(q => q.kind === 'ambulance' && q.status === 'coming').sort((a, b) => a.arriveT - b.arriveT)[0];
  p.patient = patient;
  for (let i = 0; i < 10 * 60 && p.status === 'coming'; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
  apply(db, s, { kind: 'call', id: p.id });
  if (current(s)?.id !== p.id) throw new Error('не вызвали');
  return p;
}

describe('смена: приёмное, КТ и ПИТ', () => {
  test('ВМК до 30 см³: осмотр, расспрос, давление, КТ, вопросы и глотание — в срок; давление в вену и нейрохирург; ПИТ', () => {
    const s = hospital();
    const patient = find(ICH, p => paramsOf(p).volume === 'small' && paramsOf(p).sbp140 === 'no' && paramsOf(p).reversal === 'no' && paramsOf(p).dysphagia === 'no' && has(p, 'vital.bp_high'), 1);
    const p = bring(s, patient);
    for (const exam of [NEURO, 'exam.ask_stroke', 'exam.vitals', CT, 'exam.ask_lysis', 'exam.swallow_test']) apply(db, s, { kind: 'exam', exam });
    for (let i = 0; i < 20 && p.pending.length > 0; i++) apply(db, s, { kind: 'waitResults' });
    const shownBp = p.results.flatMap(r => r.obs).find(o => o.f === 'vital.bp_high')!;
    for (const id of [NSG, ...(shownBp.value! >= 140 ? [BP] : [])]) apply(db, s, { kind: 'toggleTreatment', id });
    apply(db, s, { kind: 'diagnose', id: ICH });
    apply(db, s, { kind: 'setting', setting: 'icu' });
    apply(db, s, { kind: 'finish' });
    const closed = p.closed!;
    expect(closed.grades).toMatchObject({ accuracy: 'A', setting: 'A' });
    const ct = p.results.find(r => r.exam === CT)!;
    if (ct.obs.find(o => o.f === BLOOD)!.shown) {
      expect(closed.targets!.map(t => t.id)).toEqual(['target.neurosurgeon', 'target.stroke_ct', 'target.stroke_exam', 'target.stroke_swallow']);
      expect(closed.targets!.find(t => t.id === 'target.neurosurgeon')!.grade).toBe('A');
    }
    expect(p.status).toBe('admitted');
    expect(p.stay!.settled).toBe('residual');
    expect(p.stay!.readyAfter).toBeGreaterThanOrEqual(3);
    expect(p.stay!.readyAfter).toBeLessThanOrEqual(5);
  });

  test('без консультации нейрохирурга — «Не назначено», и срока нет: срок у назначения — только тем, кому его сделали', () => {
    const p = find(ICH, x => paramsOf(x).volume === 'small');
    const at = { roomType: () => undefined, bedside: () => false };
    const ct = { exam: CT, obs: [seen(BLOOD, CT)], at: 30 * 60, step: 1 };
    const visit = { patient: p, arriveT: 0, results: [ct] };
    const results = (treatments: Id[]) => targetResults(db, visit, at, { t: 75 * 60, plan: { treatments, setting: 'icu' } }).map(r => [r.id, r.minutes, r.grade]);
    expect(results([NSG])).toContainEqual(['target.neurosurgeon', 45, 'A']);
    expect(results([]).map(r => r[0])).not.toContain('target.neurosurgeon');
    expect(noteText({ code: 'tx.requireMissing', tx: NSG })).toBe('Не назначено: консультация нейрохирурга — без этого лечение неполное');
  });
});

describe('энциклопедия', () => {
  test('ВМК: обязательное по давлению и антикоагулянту, нейрохирург; где лечить — ПИТ, больше 30 см³ — перевод', () => {
    const a = article(db, ICH)!;
    const rows = a.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]);
    expect(rows).toContainEqual(['Обязательно, при верхнем давлении 140 и выше', [BP]]);
    expect(rows).toContainEqual(['Обязательно, при приёме антикоагулянтов', [PCC]]);
    expect(rows.some(([label, refs]) => String(label).startsWith('Обязательно') && (refs as Id[]).includes(NSG))).toBe(true);
    const where = a.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toContain('При гематоме больше 30 см³ — скорая, перевод в центр.');
    // лечения, которое сняло бы последствия, нет — они остаются
    expect(a.blocks.find(b => b.key === 'course')!.text![0]).toBe('Острый период проходит под наблюдением в стационаре; последствия остаются, и дальше реабилитация.');
    const rule = article(db, 'rule.ich_reversal')!;
    expect(rule.blocks.find(b => b.key === 'decides')!.refs!.map(r => r.id)).toEqual([PCC]);
  });

  test('консультация нейрохирурга — в группе «Консультации»; САК: перевод, внезапная боль — тревожный признак', () => {
    const groups = sectionView(db, 'treatments').groups;
    expect(groups.find(g => g.key === 'consult')).toMatchObject({ title: 'Консультации' });
    expect(groups.find(g => g.key === 'consult')!.items.map(r => r.id)).toEqual([NSG]);
    const sah = article(db, SAH)!;
    expect(JSON.stringify(sah)).toContain('sym.thunderclap');
    expect(sah.blocks.find(b => b.key === 'where')!.text!.some(t => t.includes('перевод'))).toBe(true);
  });
});
