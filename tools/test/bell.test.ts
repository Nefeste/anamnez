// Невропатия лицевого нерва (spec 2026-10-chapter-3, часть 44б): перекошенное лицо, но не морщится и лоб — не
// инсульт. Невролог видит периферический парез — сроки КТ и теста глотания снимаются, правила тромболизиса не
// применяются; глюкокортикоид — как можно раньше, оптимально в первые 72 часа, тяжёлой в первые 3 дня — в вену и в
// палату; глаз не закрывается — увлажнение. Источник — 895_1.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { paramBeliefs, paramGain } from '../../src/engine/med/infer';
import { curesOf, evaluatePlan, type Plan, settingFit, txRole, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { choosePlan, type DoctorPhase, examMinutes, indicated, nextStep, targetExams, urgentExam } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { type TargetPlace, targetsFor } from '../../src/engine/shift/targets';
import { txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const BELL = 'cond.bell_palsy';
const DROOP = 'sym.face_droop';
const PERIPHERAL = 'sign.facial_palsy_peripheral';
const SEVERE = 'sign.facial_palsy_severe';
const EYE = 'sign.lagophthalmos';
const EAR = 'sym.ear_pain_behind';
const ONSET = 'hx.onset_hours';
const NEURO = 'exam.neuro_exam';
const ASK = 'exam.ask_stroke';
const CT = 'exam.ct_head';
const ORAL = 'tx.steroid_systemic_short';
const IV = 'tx.steroid_iv';
const ANTIVIRAL = 'tx.valaciclovir';
const DROPS = 'tx.eye_lubricant';
const LYSIS = 'tx.thrombolysis_stroke';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: ['eq.monitor_defib'], icu: true, ward: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
function people(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = generatePatient(db, seed, { department: 'dept.neurology', departments: ED, season: 'winter', primary: BELL, params, walkIn: true });
    if (p.age >= db.conditions[BELL].age.min) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true, value?: number): Observation => ({ f, shown: on, exam, ...(value !== undefined ? { value } : {}) });
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
/** Всё, что о больном знает осмотр и расспрос, — как есть. */
const truthful = (p: Patient): Observation[] => [
  ...complaintObservations(p),
  ...[PERIPHERAL, SEVERE, EYE].map(f => seen(f, NEURO, has(p, f))),
  seen(ONSET, ASK, true, p.truth.values[ONSET]),
  seen(EAR, ASK, has(p, EAR)),
];
const anywhere: TargetPlace = { roomType: () => undefined, bedside: () => true, can: () => true };

describe('каталог', () => {
  test('невропатия: неврология, нервы, G51.0, подтверждает осмотр невролога; с 18 лет, чаще в 40–60, осенью и при диабете; «очень редко»', () => {
    const c = db.conditions[BELL];
    // «очень редко» — вес 10; приходят сами, не только со скорой
    expect(c).toMatchObject({ icd10: 'G51.0', department: 'dept.neurology', system: 'nerves', severity: 'moderate', confirm: [NEURO], weight: 10 });
    expect(c.arrival).toBeUndefined();
    expect(c.age).toMatchObject({ min: 18, peak: [40, 60] });
    expect(c.season?.autumn).toBeGreaterThan(c.season!.summer);
    expect(c.risks?.find(r => r.id === 'cond.diabetes2')?.x).toBe(1.5);
    expect(c.differential).toEqual(['cond.stroke_ischemic', 'cond.tia']);
  });

  test('тактика: глюкокортикоид внутрь — каждому; тяжёлой в первые 72 часа — в вену, внутрь можно, противовирусные облегчают; глаз не закрывается — увлажнение; тромболизис — вред', () => {
    const at = (ps: Record<string, string>) => [ORAL, IV, ANTIVIRAL, DROPS, LYSIS].map(tx => txRole(db, BELL, tx, ps));
    expect(at({ severity: 'moderate', h72: 'yes', eye: 'no', iv: 'no' })).toEqual(['firstLine', 'notIndicated', 'notIndicated', 'notIndicated', 'harmful']);
    expect(at({ severity: 'severe', h72: 'yes', eye: 'yes', iv: 'yes' })).toEqual(['acceptable', 'firstLine', 'supportive', 'prevent', 'harmful']);
    expect(at({ severity: 'severe', h72: 'no', eye: 'yes', iv: 'no' })).toEqual(['firstLine', 'notIndicated', 'notIndicated', 'prevent', 'harmful']);
  });

  test('где лечить: дома; тяжёлую в первые 72 часа — в палату (метилпреднизолон в вену), но и дома с таблетками не ошибка', () => {
    const s = db.conditions[BELL].treatment!.setting;
    expect([s.default, s.param, s.also]).toEqual(['home', { name: 'iv', map: { yes: 'ward', no: 'home' } }, [{ when: { iv: ['yes'] }, settings: ['home'] }]]);
    expect(db.conditions[BELL].stay).toEqual([1, 2]);
  });

  test('осмотр невролога видит периферический парез, лагофтальм и тяжёлый парез без ложных; ОАК — каждому с периферическим парезом; расспрос — о боли за ухом', () => {
    const k = Object.fromEntries(db.exams[NEURO].checks.map(c => [c.f, [c.sens, c.spec]]));
    expect([k[PERIPHERAL], k[EYE], k[SEVERE]]).toEqual([[9500, 10000], [9500, 10000], [9200, 10000]]);
    expect(db.exams['exam.cbc'].routineSeen).toEqual([PERIPHERAL]);
    expect(db.exams[ASK].checks.find(c => c.f === EAR)).toMatchObject({ sens: 9500, spec: 9800 });
    // глюкометр — и так каждому с перекошенным лицом (часть 44а)
    expect(db.exams['exam.glucometer'].routineFor).toContain(DROOP);
  });

  test('сроки КТ и теста глотания снимает периферический парез, осмотр за 10 минут — нет; правила тромболизиса и нейтрализации при нём не применяются', () => {
    expect(db.targets['target.stroke_ct'].except).toEqual([PERIPHERAL]);
    expect(db.targets['target.stroke_swallow'].except).toEqual([PERIPHERAL]);
    expect(db.targets['target.stroke_exam'].except).toBeUndefined();
    expect(db.rules['rule.lysis_stroke'].excludes).toEqual([PERIPHERAL]);
    expect(db.rules['rule.ich_reversal'].excludes).toEqual(['img.ct_sah', PERIPHERAL]);
  });

  test('лечение по группам: глюкокортикоиды — «Бронхи и воспаление», противовирусные — свои, капли и гель — «Глаза»', () => {
    expect([ORAL, IV, ANTIVIRAL, DROPS].map(tx => txGroupOfClass(db.treatments[tx].class))).toEqual(['breathing', 'breathing', 'antivirals', 'eyes']);
  });
});

describe('больные', () => {
  const xs = people(2000);
  const part = (ys: Patient[], f: (p: Patient) => boolean) => ys.filter(f).length / ys.length;

  test('у каждого — перекошенное лицо, периферический парез и часы от начала; центрального пареза и баллов NIH нет', () => {
    for (const p of xs) {
      expect({ seed: p.seed, droop: p.complaints.includes(DROOP), peripheral: has(p, PERIPHERAL), onset: has(p, ONSET), central: has(p, 'sign.facial_weakness'), nihss: has(p, 'sign.nihss') })
        .toEqual({ seed: p.seed, droop: true, peripheral: true, onset: true, central: false, nihss: false });
    }
  });

  test('тяжёлая — у 30 из 100, с тяжёлым парезом и лагофтальмом у каждой; лагофтальм всего — у трёх из четырёх; боль за ухом — часто', () => {
    const severe = xs.filter(p => paramsOf(p).severity === 'severe');
    expect(Math.abs(severe.length / xs.length - 0.3)).toBeLessThan(0.03);
    for (const p of severe) expect(has(p, SEVERE) && has(p, EYE)).toBe(true);
    for (const p of xs.filter(q => paramsOf(q).severity === 'moderate')) expect(has(p, SEVERE)).toBe(false);
    expect(Math.abs(part(xs, p => has(p, EYE)) - 0.75)).toBeLessThan(0.03);
    expect(part(xs, p => has(p, EAR))).toBeGreaterThan(0.4);
    expect(part(xs, p => has(p, EAR))).toBeLessThan(0.7);
  });

  test('часы от начала: в первые 72 часа — около 80 из 100; производные — по часам, лагофтальму и тяжести', () => {
    expect(Math.abs(part(xs, p => p.truth.values[ONSET] < 72) - 0.8)).toBeLessThan(0.03);
    for (const p of xs) {
      const ps = paramsOf(p);
      expect({ seed: p.seed, h72: ps.h72, eye: ps.eye, iv: ps.iv }).toEqual({
        seed: p.seed, h72: p.truth.values[ONSET] < 72 ? 'yes' : 'no', eye: has(p, EYE) ? 'yes' : 'no', iv: ps.severity === 'severe' && p.truth.values[ONSET] < 72 ? 'yes' : 'no',
      });
    }
  });
});

describe('вывод', () => {
  const who = { age: 50, sex: 'm' as const };

  test('глаз — по осмотру: не смотрели — по долям, видно — да, не видно — нет; тяжесть — по тяжёлому парезу', () => {
    const p = (name: string, obs: Observation[]) => Object.fromEntries(paramBeliefs(db, BELL, name, obs, who).map(b => [b.value, b.p]));
    expect(p('eye', [])).toEqual({ no: 0.25, yes: 0.75 });
    expect(p('eye', [seen(EYE, NEURO)])).toEqual({ no: 0, yes: 1 });
    expect(p('eye', [seen(EYE, NEURO, false)])).toEqual({ no: 1, yes: 0 });
    expect(paramGain(db, BELL, 'eye', NEURO, [], who)).toBeGreaterThan(0.7);
    expect(p('severity', [seen(SEVERE, NEURO)]).severe).toBe(1);
  });

  test('план: умеренная с лагофтальмом — таблетки и капли дома; тяжёлая в первые 72 часа — метилпреднизолон в вену, капли и палата', () => {
    const base = [seen(DROOP, 'complaint'), seen(PERIPHERAL, NEURO), seen(EYE, NEURO), seen(ONSET, ASK, true, 20)];
    expect(choosePlan(db, BELL, [...base, seen(SEVERE, NEURO, false)], who, BAY)).toEqual({ treatments: [DROPS, ORAL], setting: 'home' });
    expect(choosePlan(db, BELL, [...base, seen(SEVERE, NEURO)], who, BAY)).toEqual({ treatments: [DROPS, IV], setting: 'admit' });
    // через неделю — таблетки и дома, и при тяжёлой
    const late = [seen(DROOP, 'complaint'), seen(PERIPHERAL, NEURO), seen(EYE, NEURO, false), seen(ONSET, ASK, true, 160), seen(SEVERE, NEURO)];
    expect(choosePlan(db, BELL, late, who, BAY)).toEqual({ treatments: [ORAL], setting: 'home' });
  });
});

describe('сроки и правила', () => {
  const p = people(1)[0];
  const at = (results: { exam: Id; obs: Observation[] }[]) => targetsFor(db, { patient: p, bay: undefined, results: results.map((r, i) => ({ ...r, at: 60 * i, step: i + 1 })) }, anywhere).map(t => t.id);

  test('с перекошенным лицом — сроки инсульта; невролог нашёл периферический парез — остаётся только осмотр', () => {
    expect(at([])).toEqual(['target.stroke_ct', 'target.stroke_exam', 'target.stroke_swallow']);
    expect(at([{ exam: NEURO, obs: [seen(PERIPHERAL, NEURO)] }])).toEqual(['target.stroke_exam']);
    // осмотр парез пропустил — сроки остаются
    expect(at([{ exam: NEURO, obs: [seen(PERIPHERAL, NEURO, false)] }])).toEqual(['target.stroke_ct', 'target.stroke_exam', 'target.stroke_swallow']);
  });

  test('разумный врач и страховая: КТ — по сроку, пока пареза не видели; увидели — не срочно и не показано', () => {
    const exams = Object.keys(db.exams).sort();
    const cands = candidatesOf(db, ED);
    const before = complaintObservations(p);
    const after = [...before, seen(PERIPHERAL, NEURO), seen(ONSET, ASK, true, 20)];
    expect(targetExams(db, p)).toEqual(['exam.ct_head', 'exam.cta_head', 'exam.neuro_exam', 'exam.swallow_test']);
    expect(targetExams(db, p, after)).toEqual(['exam.neuro_exam']);
    expect(urgentExam(db, p, [NEURO], exams, Infinity, undefined, before)).toBe(CT);
    expect(urgentExam(db, p, [NEURO], exams, Infinity, undefined, after)).toBeUndefined();
    expect(indicated(db, p, before, cands, CT)).toBe(true);
    expect(indicated(db, p, after, cands, CT)).toBe(false);
  });

  test('правила тромболизиса и нейтрализации при периферическом парезе не применяются', () => {
    const known = knownOf([seen(PERIPHERAL, NEURO)]);
    expect(checkRule(db.rules['rule.lysis_stroke'], p, known)).toMatchObject({ verdict: 'no', applies: false });
    expect(checkRule(db.rules['rule.ich_reversal'], p, known)).toMatchObject({ verdict: 'no', applies: false });
    expect(db.rules['rule.lysis_stroke'].texts.na?.ru).toBe('Не морщится и лоб — это невропатия лицевого нерва, а не инсульт: тромболизис не нужен');
  });
});

describe('тактика и разбор', () => {
  const moderate = people(60, { severity: 'moderate' }).find(p => paramsOf(p).h72 === 'yes' && paramsOf(p).eye === 'yes')!;
  const severe = people(60, { severity: 'severe' }).find(p => paramsOf(p).h72 === 'yes')!;
  const ev = (p: Patient, x: Plan) => evaluatePlan(db, p, x, truthful(p), BAY);

  test('умеренная: таблетки и капли дома — всё верно; без капель — профилактика не назначена; без глюкокортикоида — не лечили', () => {
    const ok = ev(moderate, plan([ORAL, DROPS]));
    expect({ prevent: ok.preventMissing, setting: ok.setting.recommended, effective: ok.effective, harmful: ok.roles.filter(r => r.role === 'harmful') }).toEqual({ prevent: [], setting: 'home', effective: true, harmful: [] });
    expect(ev(moderate, plan([ORAL])).preventMissing).toEqual([DROPS]);
    expect(ev(moderate, plan([DROPS])).effective).toBe(false);
    expect(ev(moderate, plan([ORAL, DROPS, LYSIS])).roles.filter(r => r.role === 'harmful').map(r => r.tx)).toEqual([LYSIS]);
  });

  test('тяжёлая в первые 72 часа: метилпреднизолон в вену и палата — верно; таблетки и дома — тоже не ошибка', () => {
    const ok = ev(severe, plan([IV, DROPS], 'admit'));
    expect({ prevent: ok.preventMissing, setting: ok.setting.recommended, effective: ok.effective, fit: settingFit(ok.setting.recommended, 'admit', ok.setting.also) }).toEqual({ prevent: [], setting: 'ward', effective: true, fit: 'ok' });
    const home = ev(severe, plan([ORAL, DROPS]));
    expect([home.effective, settingFit(home.setting.recommended, 'home', home.setting.also)]).toEqual([true, 'ok']);
  });

  test('действие: глюкокортикоид в первые 72 часа — выздоровление обычно за 2–3 недели, позже — часто; без лечения в первые 72 часа иногда хуже', () => {
    const early = { id: BELL, params: { severity: 'moderate', side: 'left', h72: 'yes', eye: 'no', iv: 'no' } };
    const late = { id: BELL, params: { severity: 'moderate', side: 'left', h72: 'no', eye: 'no', iv: 'no' } };
    expect(curesOf(db, early, [ORAL]).map(e => [e.p, ...e.days])).toEqual([[7500, 14, 21]]);
    expect(curesOf(db, late, [ORAL]).map(e => [e.p, ...e.days])).toEqual([[5000, 21, 42]]);
    expect(curesOf(db, early, [IV]).map(e => [e.p, ...e.days])).toEqual([[7500, 14, 21]]);
    expect(untreatedOf(db, early)).toMatchObject({ p: 2500, days: [1, 3] });
    expect(untreatedOf(db, late)).toBeUndefined();
  });
});

describe('энциклопедия', () => {
  test('где лечить, лечение по тяжести и глазу; с чем спутать — инсульт и ТИА, а у них — невропатия', () => {
    const x = article(db, BELL)!;
    expect(x.blocks.find(b => b.key === 'where')!.text).toEqual(['Обычно — дома.', 'При тяжёлом течении в первые 72\u00a0часа — в стационаре.', 'При тяжёлом течении в первые 72\u00a0часа — можно и дома.', 'В стационаре обычно 1–2\u00a0дня.']);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Первая линия']).toEqual([ORAL]);
    expect(rows['Опасно']).toEqual([LYSIS]);
    expect(rows['Первая линия, при тяжёлом течении в первые 72 часа']).toEqual([IV]);
    expect(rows['Облегчить состояние, при тяжёлом течении в первые 72 часа']).toEqual([ANTIVIRAL]);
    expect(rows['Обязательная профилактика, если глаз не закрывается']).toEqual([DROPS]);
    expect(x.blocks.find(b => b.key === 'similar')!.refs!.map(r => r.id)).toEqual(['cond.stroke_ischemic', 'cond.tia']);
    for (const id of ['cond.stroke_ischemic', 'cond.tia']) expect(article(db, id)!.blocks.find(b => b.key === 'similar')!.refs!.map(r => r.id)).toContain(BELL);
  });
});

describe('разумный врач', () => {
  const exams = Object.keys(db.exams).sort();
  function run(p: Patient) {
    const cands = candidatesOf(db, ED);
    const rng = Rng.seeded(p.seed).fork('doctor');
    const obs: Observation[] = complaintObservations(p);
    const done: Id[] = [];
    let phase: DoctorPhase = {};
    for (let k = 0; k < 50; k++) {
      const minutes = done.reduce((acc, id) => acc + examMinutes(db.exams[id]), 0);
      const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...BAY, minutes } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }

  // осмотр — по сроку первого контакта: при давящей боли в груди ЭКГ с тем же сроком идёт первой
  test('умеренная: осмотр невролога сразу, КТ — только если осмотр пропустил парез; глюкокортикоид внутрь и дома, капли — кому нужны', () => {
    const xs = people(30, { severity: 'moderate' }, 8_500_001);
    for (const p of xs) {
      const r = run(p);
      const missed = !r.obs.some(o => o.f === PERIPHERAL && o.shown);
      expect({ seed: p.seed, early: r.done.indexOf(NEURO) < 2, diagnosis: r.diagnosis, ct: r.done.includes(CT), oral: r.plan.treatments.includes(ORAL), setting: r.plan.setting })
        .toEqual({ seed: p.seed, early: true, diagnosis: BELL, ct: missed, oral: true, setting: 'home' });
      if (r.obs.some(o => o.f === EYE && o.shown)) expect(r.plan.treatments).toContain(DROPS);
    }
  }, 120_000);

  test('тяжёлая в первые 72 часа: метилпреднизолон в вену и палата, если осмотр увидел тяжёлый парез', () => {
    const xs = people(30, { severity: 'severe' }, 8_500_001).filter(p => paramsOf(p).h72 === 'yes');
    let iv = 0;
    for (const p of xs) {
      const r = run(p);
      expect({ seed: p.seed, diagnosis: r.diagnosis, lysis: r.plan.treatments.includes(LYSIS) }).toEqual({ seed: p.seed, diagnosis: BELL, lysis: false });
      if (r.obs.some(o => o.f === SEVERE && o.shown)) {
        expect({ seed: p.seed, plan: r.plan }).toEqual({ seed: p.seed, plan: { treatments: r.obs.some(o => o.f === EYE && o.shown) ? [DROPS, IV] : [IV], setting: 'admit' } });
        iv++;
      }
    }
    expect(iv / xs.length).toBeGreaterThan(0.85);
  }, 120_000);
});
