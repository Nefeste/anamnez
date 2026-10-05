// АВ-блокада II–III степени (spec 2026-10-chapter-3, часть 42в): пульс реже 50 — порог на том же числе, что
// «чаще 100», по другую сторону от нормы; вид блокады — атрибутом находки ЭКГ, из него же вид в выводе и лента;
// до перевода нестабильному — одно из группы (`beforeTransfer` группами, как `require`): при узких комплексах —
// атропин, стимуляция или допамин, при широких и Мобитц II — стимуляция или допамин; стабильному — перевод без
// лечения на месте; вредно то, что тормозит проведение; разумный врач у постели и в кабинете.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { P_ONE, Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { scaleTriage } from '../../src/engine/med/news2';
import { paramBeliefs } from '../../src/engine/med/infer';
import { choiceFor, evaluatePlan, type Plan, txAvailable, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import { observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const AVB = 'cond.av_block';
const ATROPINE = 'tx.atropine';
const PACING = 'tx.pacing_tc';
const DOPAMINE = 'tx.dopamine';
const HARMFUL = ['tx.beta_blocker', 'tx.verapamil', 'tx.verapamil_iv', 'tx.trifosadenine', 'tx.amiodarone_iv', 'tx.procainamide'];
const BRADY = 'vital.bradycardia';
const TACHY = 'vital.tachycardia';
const LOW = 'vital.bp_low';
const ECG_AVB = 'ecg.av_block';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const gen = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: AVB, params });
/** Больные в возрасте болезни. */
function people(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = gen(seed, params);
    if (p.age >= db.conditions[AVB].age.min) out.push(p);
  }
  return out;
}
const one = (params: Record<string, string>) => people(1, params)[0];
const seen = (f: Id, exam: Id, on = true, attrs?: Record<string, string>): Observation => ({ f, shown: on, exam, ...(attrs ? { attrs } : {}) });
/** ЭКГ и давление проверены — как у пациента. */
const checked = (p: Patient): Observation[] => [
  ...complaintObservations(p),
  seen(ECG_AVB, 'exam.ecg', true, { kind: paramsOf(p).block }),
  seen(LOW, 'exam.vitals', has(p, LOW)),
  seen(BRADY, 'exam.vitals', has(p, BRADY)),
];
const plan = (treatments: Id[], setting: Setting = 'ambulance'): Plan => ({ treatments: [...treatments].sort(), setting });

describe('каталог', () => {
  test('терапия, критическая, диагноз — по ЭКГ, место — перевод в центр; вид блокады и нестабильность — параметры', () => {
    expect(db.conditions[AVB]).toMatchObject({ department: 'dept.therapy', severity: 'critical', confirm: ['exam.ecg'], redFlags: [LOW, ECG_AVB] });
    expect(db.conditions[AVB].treatment!.setting).toEqual({ default: 'transfer' });
    expect(Object.keys(db.conditions[AVB].params!.block)).toEqual(['mobitz2', 'narrow', 'wide']);
    expect(db.conditions[AVB].age.min).toBe(50);
  });

  test('пульс реже 50 — то же измерение, что «чаще 100», без «и то, и другое»; точность из него; ЭКГ — каждому с редким пульсом', () => {
    expect(db.findings[BRADY].value).toMatchObject({ of: TACHY, present: [28, 48] });
    expect(db.findings[BRADY].value!.implies).toBeUndefined();
    const vitals = db.exams['exam.vitals'].checks;
    expect(vitals.find(k => k.f === BRADY)).toMatchObject({ sens: vitals.find(k => k.f === TACHY)!.spec, spec: P_ONE });
    expect(db.exams['exam.ecg'].checks.find(k => k.f === ECG_AVB)).toMatchObject({ sens: 9500, spec: 9900 });
    expect(db.exams['exam.ecg'].routineSeen).toContain(BRADY);
  });

  test('атропин, допамин и наружная стимуляция — у постели под монитором; атропин учащает ритм только при узких комплексах', () => {
    for (const tx of [ATROPINE, PACING, DOPAMINE]) expect({ tx, at: db.treatments[tx].bedside?.equipment }).toEqual({ tx, at: [MONITOR] });
    expect(db.treatments[PACING].kind).toBe('procedure');
    expect(db.treatments[ATROPINE].effects).toEqual([expect.objectContaining({ on: AVB, kind: 'relieve', when: { block: ['narrow'] } })]);
    for (const tx of [PACING, DOPAMINE]) expect(db.treatments[tx].effects[0].when).toBeUndefined();
  });
});

describe('больные', () => {
  const xs = people(1500);

  test('полная блокада: у каждого пульс 28–48 — одно число с «чаще 100», которого при блокаде нет; Мобитц II — редкий пульс обычно; на ЭКГ — вид блокады', () => {
    let m2 = 0;
    let m2slow = 0;
    expect(db.conditions[AVB].masks).toEqual([TACHY]);
    for (const p of xs) {
      const { block, unstable } = paramsOf(p);
      expect(p.truth.findings.find(f => f.f === ECG_AVB)!.attrs).toEqual({ kind: block });
      expect(has(p, TACHY)).toBe(false);
      expect(has(p, LOW)).toBe(unstable === 'yes');
      if (block === 'mobitz2') {
        m2++;
        if (has(p, BRADY)) m2slow++;
      } else expect(has(p, BRADY)).toBe(true);
      if (!has(p, BRADY)) continue;
      const v = p.truth.values[BRADY];
      expect(v >= 28 && v <= 48 && p.truth.values[TACHY] === v).toBe(true);
    }
    expect(Math.abs(m2slow / m2 - 0.75)).toBeLessThan(0.06);
  });

  test('доли: нестабильных — 30 из 100; Мобитц II — 30, полная с узкими — 25, с широкими — 45', () => {
    const share = (name: string, value: string) => xs.filter(p => paramsOf(p)[name] === value).length / xs.length;
    expect(Math.abs(share('unstable', 'yes') - 0.3)).toBeLessThan(0.04);
    for (const [value, x] of [['mobitz2', 0.3], ['narrow', 0.25], ['wide', 0.45]] as const) expect({ value, near: Math.abs(share('block', value) - x) < 0.04 }).toEqual({ value, near: true });
  });

  test('осмотр: пульс 40 — «реже 50» и не «чаще 100»; строка пульса — с числом', () => {
    const p = one({ block: 'wide' });
    const obs = runExam(db, p, 'exam.vitals', Rng.seeded(1).fork('vitals'), undefined, true);
    const a = obs.find(o => o.f === TACHY)!;
    const b = obs.find(o => o.f === BRADY)!;
    expect([a.shown, b.shown, b.value]).toEqual([false, true, a.value]);
    expect(a.value).toBe(p.truth.values[BRADY]);
    expect(observationText(db, a, 'm', 1)).toBe(`Пульс ${a.value} уд/мин`);
    expect(observationText(db, b, 'm', 1)).toBe('Пульс редкий: реже 50 в минуту');
  });

  test('сортировка: пульс 40 и реже — 3 балла NEWS2 по самому числу; реже 50 — жёлтый и при одном балле; с давлением ниже 90 — красный', () => {
    const pulse = (v: number): Observation[] => [{ f: TACHY, shown: false, value: v, exam: 'exam.vitals' }, { f: BRADY, shown: true, value: v, exam: 'exam.vitals' }];
    const low: Observation[] = [{ f: 'vital.bp_high', shown: false, value: 80, exam: 'exam.vitals' }, { f: LOW, shown: true, value: 80, exam: 'exam.vitals' }];
    expect(scaleTriage(db, [], pulse(38))).toEqual({ triage: 'yellow', news2: 3 });
    expect(scaleTriage(db, [], pulse(45))).toEqual({ triage: 'yellow', news2: 1, flag: BRADY });
    expect(scaleTriage(db, [], [...pulse(38), ...low])).toEqual({ triage: 'red', news2: 6, flag: LOW });
  });
});

describe('ЭКГ', () => {
  test('вид блокады — своей строкой; запись без вида — широкие; нет — «АВ-блокады II–III степени нет»', () => {
    const line = (attrs?: Record<string, string>, on = true) => observationText(db, seen(ECG_AVB, 'exam.ecg', on, attrs), 'm', 1);
    expect(line({ kind: 'mobitz2' })).toBe('Часть зубцов P без комплексов QRS, PQ перед проведёнными не меняется — АВ-блокада II степени, Мобитц II');
    expect(line({ kind: 'narrow' })).toBe('Зубцы P и комплексы QRS — каждые в своём ритме, комплексы узкие — полная АВ-блокада');
    expect(line({ kind: 'wide' })).toBe('Зубцы P и комплексы QRS — каждые в своём ритме, комплексы широкие и редкие — полная АВ-блокада');
    expect(line()).toBe(line({ kind: 'wide' }));
    expect(line(undefined, false)).toBe('АВ-блокады II–III степени нет');
  });

  test('лента: полная — свой ритм желудочков с частотой пульса, узкий или широкий; Мобитц II — предсердия в полтора раза чаще; пульс не мерили — своя частота', () => {
    const view = (p: Patient, exams: Id[]) => {
      const arrived = exams.map((exam, i) => ({ exam, step: i + 1, at: 600 + i, obs: runExam(db, p, exam, Rng.seeded(3).fork(exam), undefined, true) }));
      return makeCaseView({
        version: 0, patient: p, clock: 700, minutesSpent: 0, money: 0, step: exams.length, pending: [], meanwhile: [], done: [],
        draft: { treatments: [], setting: 'home' }, arrived, departments: ED, difficulty: 'doctor',
      }).groups.find(g => g.exam === 'exam.ecg')!.image as { kind: string; ecg: { rhythm?: string; rate?: number; escape?: string } };
    };
    // без фибрилляции предсердий в прошлом — у таких на ленте фибрилляция
    const plain = (params: Record<string, string>) => people(20, params).find(p => !has(p, 'ecg.af'))!;
    const narrow = plain({ block: 'narrow' });
    expect(view(narrow, ['exam.vitals', 'exam.ecg'])).toMatchObject({ kind: 'ecg', ecg: { rhythm: 'avb3', escape: 'narrow', rate: narrow.truth.values[TACHY] } });
    const wide = view(plain({ block: 'wide' }), ['exam.ecg']).ecg;
    expect([wide.rhythm, wide.rate, wide.escape]).toEqual(['avb3', undefined, 'wide']);
    const m2 = plain({ block: 'mobitz2' });
    const m2view = view(m2, ['exam.vitals', 'exam.ecg']).ecg;
    expect([m2view.rhythm, m2view.rate, m2view.escape]).toEqual(['avb2m', Math.round((m2.truth.values[TACHY] * 3) / 2), undefined]);
    // фибрилляция с полной блокадой — без зубцов P, ритм желудочков ровный
    const af = people(400, { block: 'wide' }).find(p => has(p, 'ecg.af'))!;
    expect(view(af, ['exam.vitals', 'exam.ecg']).ecg).toMatchObject({ rhythm: 'af', escape: 'wide', rate: af.truth.values[TACHY] });
  });

  test('вид блокады в выводе — из атрибута показанной находки: до ЭКГ — доли, после — то, что видно; повторная — по последней', () => {
    const avb = (kind: string): Observation => seen(ECG_AVB, 'exam.ecg', true, { kind });
    const p = (obs: Observation[]) => Object.fromEntries(paramBeliefs(db, AVB, 'block', obs, 70).map(x => [x.value, Math.round(x.p * 100) / 100]));
    expect(p([])).toEqual({ mobitz2: 0.3, narrow: 0.25, wide: 0.45 });
    expect(p([avb('narrow')])).toEqual({ mobitz2: 0, narrow: 1, wide: 0 });
    expect(p([avb('mobitz2'), avb('wide')])).toEqual({ mobitz2: 0, narrow: 0, wide: 1 });
  });
});

describe('тактика и разбор', () => {
  const stable = one({ unstable: 'no', block: 'narrow' });
  const narrow = one({ unstable: 'yes', block: 'narrow' });
  const wide = one({ unstable: 'yes', block: 'wide' });
  const m2 = one({ unstable: 'yes', block: 'mobitz2' });
  const ev = (p: Patient, x: Plan, venue: Venue = BAY) => evaluatePlan(db, p, x, checked(p), venue);
  const grade = (p: Patient, x: Plan, venue: Venue = BAY) => scoreCase({
    verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev(p, x, venue),
    outcome: { kind: x.setting === 'home' ? 'recovered' : 'transferred', day: 0, cured: true }, selfLimiting: false, redFlags: [],
  });

  test('стабильному — перевод в центр без лечения на месте: кардиостимулятор там; атропин и допамин можно, стимуляция не нужна', () => {
    const e = ev(stable, plan([]));
    expect([e.requireMissing, e.beforeTransferMissing, e.setting.recommended]).toEqual([[], [], 'transfer']);
    expect(grade(stable, plan([]))).toMatchObject({ treatment: 'A', setting: 'A', safety: 'A' });
    expect([choiceFor('transfer', BAY), choiceFor('transfer', {})]).toEqual(['ambulance', 'ambulance']);
    // домой или своя ПИТ — меньше нужного: кардиостимулятор ставят в центре
    for (const at of ['home', 'icu'] as const) expect({ at, grade: grade(stable, plan([], at)).setting }).toEqual({ at, grade: 'D' });
    for (const tx of [ATROPINE, DOPAMINE]) expect(txRole(db, AVB, tx, paramsOf(stable))).toBe('acceptable');
    expect(txRole(db, AVB, PACING, paramsOf(stable))).toBe('notIndicated');
  });

  test('нестабильному с узкими комплексами — до перевода одно из: атропин, стимуляция или допамин', () => {
    expect(ev(narrow, plan([])).beforeTransferMissing).toEqual([ATROPINE]);
    for (const tx of [ATROPINE, PACING, DOPAMINE]) {
      expect({ tx, missing: ev(narrow, plan([tx])).beforeTransferMissing }).toEqual({ tx, missing: [] });
      expect(txRole(db, AVB, tx, paramsOf(narrow))).toBe('beforeTransfer');
    }
    expect(ev(narrow, plan([])).beforeTransferWhen[ATROPINE]).toEqual({ unstable: ['yes'], block: ['narrow'] });
    expect(grade(narrow, plan([ATROPINE]))).toMatchObject({ treatment: 'A', setting: 'A', safety: 'A' });
    expect(grade(narrow, plan([])).treatment).not.toBe('A');
  });

  test('при широких комплексах и Мобитц II блок ниже узла: стимуляция или допамин, атропин не в счёт', () => {
    for (const p of [wide, m2]) {
      expect(ev(p, plan([ATROPINE])).beforeTransferMissing).toEqual([PACING]);
      for (const tx of [PACING, DOPAMINE]) expect(ev(p, plan([tx])).beforeTransferMissing).toEqual([]);
      expect(txRole(db, AVB, ATROPINE, paramsOf(p))).toBe('acceptable');
      expect(grade(p, plan([PACING]))).toMatchObject({ treatment: 'A', setting: 'A', safety: 'A' });
    }
  });

  test('в кабинете без монитора ничего из группы не сделать — не в вину: скорая', () => {
    for (const tx of [ATROPINE, PACING, DOPAMINE]) expect(txAvailable(db, tx, {})).toBe(false);
    for (const p of [narrow, wide]) expect(ev(p, plan([]), {}).beforeTransferMissing).toEqual([]);
    expect(grade(wide, plan([]), {})).toMatchObject({ treatment: 'A', setting: 'A' });
  });

  test('вредно то, что тормозит проведение; вагусные пробы и разряд — не нужны', () => {
    for (const tx of HARMFUL) expect({ tx, role: txRole(db, AVB, tx, paramsOf(stable)) }).toEqual({ tx, role: 'harmful' });
    for (const tx of ['tx.vagal', 'tx.cardioversion']) expect(txRole(db, AVB, tx, paramsOf(wide))).toBe('notIndicated');
    expect(grade(stable, plan(['tx.beta_blocker']))).toMatchObject({ safety: 'C' });
    expect(grade(wide, plan([PACING, 'tx.verapamil_iv'])).treatment).toBe('D');
  });
});

describe('энциклопедия', () => {
  test('где лечить — перевод в центр; до перевода — одно из, по виду блокады; редкий пульс — при полной', () => {
    const a = article(db, AVB)!;
    expect(a.blocks.find(b => b.key === 'where')!.text).toEqual(['Обычно — скорая, перевод в центр.']);
    const rows = a.blocks.find(b => b.key === 'treatment')!.rows!.filter(r => r.label.startsWith('Обязательно до перевода'));
    expect(rows.map(r => [r.label, r.refs.map(x => x.id)])).toEqual([
      ['Обязательно до перевода, при нестабильной гемодинамике и узких комплексах — блокаде в АВ-узле — одно из', [ATROPINE, PACING, DOPAMINE]],
      ['Обязательно до перевода, при нестабильной гемодинамике и широких комплексах или Мобитц II — блокаде ниже узла — одно из', [PACING, DOPAMINE]],
    ]);
    const signs = a.blocks.find(b => b.key === 'signs')!.rows!.flatMap(r => r.refs);
    expect(signs.find(x => x.id === BRADY)!.note).toBe('при полной блокаде');
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

  test('у постели в приёмном: ЭКГ и давление; стабильному — перевод без лечения, нестабильному — атропин при узких, стимуляция при широких и Мобитц II', () => {
    const xs = people(80, {}, 8_000_001);
    let right = 0;
    let unseen = 0;
    for (const p of xs) {
      const r = run(p, BAY, ED);
      // ЭКГ пропускает блокаду у 5 из 100 — тогда и диагноз другой
      if (r.diagnosis !== AVB) continue;
      right++;
      expect(r.done).toEqual(expect.arrayContaining(['exam.ecg', 'exam.vitals']));
      // тонометр пропускает давление ниже 90 у 5 из 100 — нестабильности врач тогда не видит (с частью 44в при
      // слабости первым идёт неврологический осмотр, и давление у одного из 80 меряют другим жребием)
      if (paramsOf(p).unstable === 'yes' && !r.obs.some(o => o.f === 'vital.bp_low' && o.shown)) {
        unseen++;
        continue;
      }
      const e = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect({ seed: p.seed, harmful: e.roles.filter(x => x.role === 'harmful').map(x => x.tx), missing: [...e.requireMissing, ...e.beforeTransferMissing] })
        .toEqual({ seed: p.seed, harmful: [], missing: [] });
      const { unstable, block } = paramsOf(p);
      const want = unstable === 'no' ? [] : block === 'narrow' ? [ATROPINE] : [PACING];
      expect({ seed: p.seed, plan: r.plan }).toEqual({ seed: p.seed, plan: { treatments: want, setting: 'ambulance' } });
    }
    expect(right / xs.length).toBeGreaterThan(0.9);
    expect(unseen).toBeLessThanOrEqual(2);
  });

  test('в поликлинике без монитора: ЭКГ — и на скорой без лечения', () => {
    const xs = people(40, {}, 8_100_001).map(p => run(p, {}, ['dept.therapy']));
    const sent = xs.filter(r => r.diagnosis === AVB);
    for (const r of sent) expect(r.plan).toEqual({ treatments: [], setting: 'ambulance' });
    expect(sent.length / xs.length).toBeGreaterThan(0.85);
  });
});
