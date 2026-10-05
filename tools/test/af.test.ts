// Фибрилляция и трепетание предсердий (spec 2026-10-chapter-3, часть 42а): шкала CHA₂DS₂-VASc —
// возраст полосами, балл и порог по полу; давность 48 часов — по часам от начала; нестабильный —
// разряд и гепарин в ПИТ; поздняя кардиоверсия без антикоагулянта — инсульт, вред другой болезнью;
// ЭКГ — вид по атрибуту, трепетание на ленте; часы — сутками; разумный врач.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { choiceFor, evaluatePlan, harmsOf, type Plan, primaryOf, txAvailable, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { ageBand, checkRule, pointsFrom, pointsOf } from '../../src/engine/med/rules';
import { observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { wardCourse } from '../../src/engine/shift/ward';
import { makeCaseView, outcomeText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const AF = 'cond.af';
const STROKE = 'cond.stroke_ischemic';
const RULE = 'rule.cha2ds2vasc';
const CV = 'tx.cardioversion';
const AMIO = 'tx.amiodarone_iv';
const BB = 'tx.beta_blocker';
const VERA = 'tx.verapamil';
const DOAC = 'tx.doac';
const UFH = 'tx.heparin_iv';
const LMWH = 'tx.lmwh';
const ASA = 'tx.aspirin_acs';
const PALP = 'sym.palpitations';
const ECG_AF = 'ecg.af';
const ONSET = 'hx.onset_hours';
const LOW = 'vital.bp_low';
const HF = 'hx.heart_failure';
const HTN = 'hx.hypertension';
const DM = 'hx.diabetes';
const PRIOR = 'hx.stroke_tia';
const VASC = 'hx.vascular';
const ITEMS = [HF, HTN, DM, PRIOR, VASC];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: ['eq.monitor_defib'], icu: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const gen = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: AF, params });
/** Первый больной от зерна `from`, для которого верно `ok`, — в возрасте болезни, без астмы и аллергий. */
function find(ok: (p: Patient) => boolean, params: Record<string, string> = {}, from = 1): Patient {
  for (let seed = from; seed < from + 20_000; seed++) {
    const p = gen(seed, params);
    if (p.age >= 40 && !p.truth.conditions.some(c => c.id === 'cond.asthma') && ok(p)) return p;
  }
  throw new Error('нет такого больного');
}
function people(n: number, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    const p = gen(seed);
    if (p.age >= 40) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true, value?: number): Observation => ({ f, shown: on, exam, ...(value !== undefined ? { value } : {}) });
/** Всё, что меняет тактику, проверено: ЭКГ, давление, часы от начала и пункты шкалы — как у пациента. */
function checked(p: Patient): Observation[] {
  const ecg = p.truth.findings.find(x => x.f === ECG_AF);
  return [
    ...complaintObservations(p),
    { f: ECG_AF, shown: true, exam: 'exam.ecg', ...(ecg?.attrs ? { attrs: ecg.attrs } : {}) },
    seen(LOW, 'exam.vitals', has(p, LOW)),
    seen(ONSET, 'exam.ask_onset', true, p.truth.values[ONSET]),
    ...ITEMS.map(f => seen(f, 'exam.ask_chronic', has(p, f))),
  ];
}
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
const rule = () => db.rules[RULE];

describe('каталог', () => {
  test('фибрилляция и трепетание — терапия, серьёзная; приходят сами и привозит скорая; диагноз — по ЭКГ', () => {
    const c = db.conditions[AF];
    expect(c).toMatchObject({ department: 'dept.therapy', severity: 'serious', confirm: ['exam.ecg'], redFlags: [LOW] });
    expect(c.arrival).toBeUndefined();
    expect(Object.keys(c.params!).sort()).toEqual(['oac', 'recent', 'type', 'unstable']);
    expect(c.derived).toEqual({ recent: { f: ONSET, below: 48 }, oac: RULE });
    expect(c.onset).toEqual({ f: ONSET, hours: [[12, 35], [48, 30], [168, 25], [336, 10]] });
  });

  test('CHA₂DS₂-VASc — пункты и баллы по 382_2 (приложение Г1, табл. П3): возраст полосами, женский пол — балл, порог — мужчинам 2, женщинам 3', () => {
    const r = rule();
    expect(r.any).toEqual([]);
    expect(r.points).toEqual({
      items: [{ f: HF, w: 1 }, { f: HTN, w: 1 }, { f: DM, w: 1 }, { f: PRIOR, w: 2 }, { f: VASC, w: 1 }],
      age: [{ from: 65, w: 1 }, { from: 75, w: 2 }],
      sex: { f: 1 },
      from: 2,
      fromSex: { f: 3 },
    });
    expect([pointsFrom(r.points!, 'm'), pointsFrom(r.points!, 'f'), pointsFrom(r.points!)]).toEqual([2, 3, 2]);
    expect(r).toMatchObject({ complaints: [PALP], requires: [ECG_AF], decides: DOAC, about: [AF], exams: [] });
  });

  test('при сердцебиении ЭКГ, пульс и давление — каждому; пункты шкалы — в расспросе о хронических болезнях', () => {
    expect(db.exams['exam.ecg'].routineFor).toEqual([PALP]);
    expect(db.exams['exam.vitals'].routineFor).toContain(PALP);
    expect(db.exams['exam.vitals'].checks.map(k => k.f)).toContain('sign.pulse_irregular');
    const chronic = db.exams['exam.ask_chronic'].checks.map(k => k.f);
    for (const f of [HF, VASC, PRIOR]) expect(chronic).toContain(f);
    // инсульт с противопоказанием к тромболизису — и инсульт в прошлом: расспросы не спорят
    expect(db.risks['risk.stroke_history'].findings.map(l => l.f)).toEqual(['hx.stroke_history', PRIOR]);
    expect(db.findings['hx.stroke_history'].texts.absent![0].ru).toBe('Кровоизлияния в мозг не было, инфаркта мозга за полгода — тоже');
  });

  test('ABCD2 — по-прежнему одна полоса возраста: с 60 лет 1 балл', () => {
    expect(db.rules['rule.abcd2'].points!.age).toEqual([{ from: 60, w: 1 }]);
    expect(ageBand(db.rules['rule.abcd2'].points!, 80)).toEqual({ from: 60, w: 1 });
  });
});

describe('баллы шкалы', () => {
  /** Всё известно: на ЭКГ фибрилляция, пункты `on` есть, остальные — нет. */
  const at = (age: number, sex: 'm' | 'f', on: Id[], ecg = true) =>
    checkRule(rule(), { age, sex }, f => (f === ECG_AF ? ecg : on.includes(f) ? true : ITEMS.includes(f) ? false : undefined));

  test('возраст — полосами: до 65 — 0, 65–74 — 1, 75 и старше — 2; женский пол — балл', () => {
    expect([64, 65, 74, 75, 90].map(age => at(age, 'm', []).points!.min)).toEqual([0, 1, 1, 2, 2]);
    expect([at(64, 'f', []).points, at(80, 'f', []).points]).toEqual([{ min: 1, max: 1 }, { min: 3, max: 3 }]);
    const p = rule().points!;
    expect([ageBand(p, 50), ageBand(p, 70), ageBand(p, 80)]).toEqual([undefined, { from: 65, to: 74, w: 1 }, { from: 75, w: 2 }]);
  });

  test('порог по полу: мужчине 2 балла — антикоагулянт, женщине 2 — ещё нет, 3 — да; инсульт в прошлом — сразу 2', () => {
    expect(at(50, 'm', [HTN]).verdict).toBe('no');
    expect(at(50, 'm', [HTN, DM]).verdict).toBe('yes');
    expect(at(50, 'f', [HTN]).verdict).toBe('no');
    expect(at(50, 'f', [HTN, DM]).verdict).toBe('yes');
    expect(at(50, 'm', [PRIOR]).verdict).toBe('yes');
    // 80-летней — 3 балла за возраст и пол: и без пунктов
    expect(at(80, 'f', []).verdict).toBe('yes');
    // пол неизвестен — общий порог и без балла за пол
    expect(checkRule(rule(), 50, f => (f === ECG_AF || f === HTN || f === DM ? true : ITEMS.includes(f) ? false : undefined)).points).toEqual({ min: 2, max: 2 });
  });

  test('не спросили — «пока неизвестно» и что проверить; ЭКГ без фибрилляции — шкалу не применяют', () => {
    const x = checkRule(rule(), { age: 70, sex: 'm' }, f => (f === ECG_AF ? true : undefined));
    expect(x.verdict).toBe('unknown');
    expect([...x.left].sort()).toEqual([...ITEMS].sort());
    expect(x.points).toEqual({ min: 1, max: 7 });
    expect(at(70, 'm', [HTN], false)).toMatchObject({ applies: false, verdict: 'no' });
  });
});

describe('больные и параметры', () => {
  const xs = people(2000);

  test('у каждого — сердцебиение, часы от начала и ЭКГ по виду; нестабильный — с давлением ниже 90', () => {
    for (const p of xs) {
      const x = paramsOf(p);
      expect(p.complaints).toContain(PALP);
      const ecg = p.truth.findings.find(f => f.f === ECG_AF)!;
      expect(ecg.attrs).toEqual({ kind: x.type });
      expect(has(p, LOW)).toBe(x.unstable === 'yes');
      const h = p.truth.values[ONSET];
      expect(h >= 1 && h <= 335).toBe(true);
      expect(x.recent).toBe(h < 48 ? 'yes' : 'no');
      // антикоагулянт — по баллам настоящих признаков и порогу пола
      const pts = pointsOf(rule().points!, p, f => has(p, f)).min;
      expect(x.oac).toBe(pts >= pointsFrom(rule().points!, p.sex) ? 'yes' : 'no');
    }
    // меньше 48 часов — около двух третей (доли записи: 35 + 30 %)
    const early = xs.filter(p => paramsOf(p).recent === 'yes').length / xs.length;
    expect(Math.abs(early - 0.65)).toBeLessThan(0.04);
  });

  test('у фактора риска «мерцательная аритмия» на ЭКГ — фибрилляция, не трепетание', () => {
    let n = 0;
    for (let seed = 1; seed < 40_000 && n < 30; seed++) {
      const p = generatePatient(db, seed, { department: 'dept.therapy', season: 'winter', primary: 'cond.angina_stable' });
      const ecg = p.truth.findings.find(f => f.f === ECG_AF);
      if (!ecg) continue;
      expect(p.truth.risks).toContain('risk.atrial_fibrillation');
      expect(ecg.attrs).toEqual({ kind: 'fibrillation' });
      n++;
    }
    expect(n).toBe(30);
  });
});

describe('тексты', () => {
  test('ЭКГ: строка и лента — по виду; запись из сохранения без вида — фибрилляция', () => {
    const ecg = (attrs?: Record<string, string>): Observation => ({ f: ECG_AF, shown: true, exam: 'exam.ecg', ...(attrs ? { attrs } : {}) });
    expect(observationText(db, ecg({ kind: 'flutter' }), 'm', 1)).toBe('Пилообразные волны F вместо зубцов P — трепетание предсердий');
    expect(observationText(db, ecg({ kind: 'fibrillation' }), 'm', 1)).toBe('Ритм неправильный, зубцов P нет — фибрилляция предсердий');
    expect(observationText(db, ecg(), 'm', 1)).toBe('Ритм неправильный, зубцов P нет — фибрилляция предсердий');
    // лента у постели — пилой
    const p = find(x => paramsOf(x).type === 'flutter', { type: 'flutter' });
    const obs = runExam(db, p, 'exam.ecg', Rng.seeded(3).fork('ecg'), undefined, true);
    const view = makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [],
      draft: { treatments: [], setting: 'home' }, arrived: [{ exam: 'exam.ecg', step: 1, at: 600, obs }], departments: ED, difficulty: 'doctor',
    });
    const image = view.groups.find(g => g.exam === 'exam.ecg')!.image;
    expect(image).toMatchObject({ kind: 'ecg', ecg: { rhythm: 'flutter' } });
  });

  test('часы от начала: до двух суток — часами, дальше — сутками', () => {
    const at = (value: number) => observationText(db, seen(ONSET, 'exam.ask_onset', true, value), 'f', 1);
    expect([at(5), at(47), at(48), at(120), at(335)]).toEqual([
      'Плохо стало около 5 ч назад', 'Плохо стало около 47 ч назад', 'Плохо стало около 2 суток назад',
      'Плохо стало около 5 суток назад', 'Плохо стало около 14 суток назад',
    ]);
  });
});

describe('тактика и разбор', () => {
  const unstable = find(x => paramsOf(x).unstable === 'yes', { unstable: 'yes' });
  const early = find(x => paramsOf(x).recent === 'yes' && paramsOf(x).oac === 'no', { unstable: 'no' });
  const late = find(x => paramsOf(x).recent === 'no' && paramsOf(x).oac === 'no', { unstable: 'no' });
  const risky = find(x => paramsOf(x).oac === 'yes', { unstable: 'no' });
  const ev = (p: Patient, x: Plan) => evaluatePlan(db, p, x, checked(p), BAY);

  test('нестабильный — разряд и гепарин у постели, ПИТ; урежать таблетками при низком давлении — не то', () => {
    expect(ev(unstable, plan([CV, UFH], 'icu')).requireMissing).toEqual([]);
    expect(ev(unstable, plan([CV, LMWH], 'icu')).requireMissing).toEqual([]);
    expect(ev(unstable, plan([BB], 'icu')).requireMissing).toEqual([CV, UFH]);
    expect(ev(unstable, plan([CV, UFH], 'icu')).setting.recommended).toBe('icu');
    expect(txRole(db, AF, BB, paramsOf(unstable))).toBe('notIndicated');
    expect(txRole(db, AF, AMIO, paramsOf(unstable))).toBe('acceptable');
    // разряд — только у постели с монитором и дефибриллятором; без своей ПИТ — скорая
    expect([txAvailable(db, CV, {}), txAvailable(db, CV, BAY)]).toEqual([false, true]);
    expect([choiceFor('icu', BAY), choiceFor('icu', {})]).toEqual(['icu', 'ambulance']);
  });

  test('стабильный: меньше 48 часов — урежение или восстановление ритма; 48 и больше — разряд и амиодарон вредны', () => {
    for (const tx of [BB, VERA, CV, AMIO]) expect({ tx, role: txRole(db, AF, tx, paramsOf(early)) }).toEqual({ tx, role: 'firstLine' });
    for (const tx of [BB, VERA]) expect(txRole(db, AF, tx, paramsOf(late))).toBe('firstLine');
    for (const tx of [CV, AMIO]) expect(txRole(db, AF, tx, paramsOf(late))).toBe('harmful');
    expect(ev(late, plan([CV, UFH])).roles.find(r => r.tx === CV)!.role).toBe('harmful');
    // дома; восстанавливать ритм в больницу при раннем — не ошибка
    expect(ev(early, plan([BB])).setting).toEqual({ chosen: 'home', recommended: 'home', also: ['ambulance'] });
    expect(ev(late, plan([BB])).setting).toEqual({ chosen: 'home', recommended: 'home' });
  });

  test('антикоагулянт постоянно — по шкале; ацетилсалициловая кислота и клопидогрел от инсульта не защищают', () => {
    expect(ev(risky, plan([BB])).requireMissing).toEqual([DOAC]);
    expect(ev(risky, plan([BB, DOAC])).requireMissing).toEqual([]);
    expect(ev(early, plan([BB])).requireMissing).toEqual([]);
    expect(txRole(db, AF, DOAC, paramsOf(early))).toBe('acceptable');
    for (const tx of [ASA, 'tx.clopidogrel']) expect(txRole(db, AF, tx, paramsOf(risky))).toBe('notIndicated');
  });

  test('кардиоверсия без антикоагулянта — неполное лечение: антикоагулянт до и после', () => {
    expect(ev(early, plan([CV])).companionsMissing).toEqual([{ tx: UFH, of: CV }]);
    for (const tx of [UFH, LMWH, DOAC]) expect(ev(early, plan([CV, tx])).companionsMissing).toEqual([]);
    expect(ev(early, plan([AMIO])).companionsMissing).toEqual([{ tx: UFH, of: AMIO }]);
  });

  test('поздняя кардиоверсия — инсульт у 6 из 100: возврат с другой болезнью, словами; ранняя — без вреда', () => {
    expect(harmsOf(db, primaryOf(late), [CV, BB])).toEqual([{ tx: CV, p: 600, days: [1, 5], as: STROKE }]);
    expect(harmsOf(db, primaryOf(late), [AMIO])).toEqual([{ tx: AMIO, p: 300, days: [1, 5], as: STROKE }]);
    expect(harmsOf(db, primaryOf(early), [CV, AMIO])).toEqual([]);
    expect(harmsOf(db, primaryOf(unstable), [CV])).toEqual([]);
    const x = plan([CV, UFH]);
    const e = ev(late, x);
    let strokes = 0;
    for (let i = 0; i < 4000; i++) {
      const o = observe(db, late, x, e, Rng.seeded(i).fork('outcome'));
      if (o.returns?.as === STROKE) {
        expect(o).toMatchObject({ kind: 'worse', harmBy: CV, returns: { reason: 'worse', as: STROKE } });
        expect(o.day >= 1 && o.day <= 5).toBe(true);
        strokes++;
      }
    }
    expect(Math.abs(strokes / 4000 - 0.06)).toBeLessThan(0.012);
    const text = outcomeText({ kind: 'worse', day: 3, returns: { day: 3, reason: 'worse', as: STROKE }, cured: false, harmBy: CV }, 'home', false);
    expect(text).toBe('На 3-й день — ишемический инсульт после лечения «Электрическая кардиоверсия»: человека привезёт скорая');
    // в палате — на обходе: инсульт после кардиоверсии
    const ward = plan([CV, UFH], 'admit');
    const we = ev(late, ward);
    const courses = Array.from({ length: 600 }, (_, i) => wardCourse(db, late, ward, we, Rng.seeded(i).fork('ward')));
    const hit = courses.filter(c => c.reaction?.as === STROKE);
    expect(hit.length).toBeGreaterThan(15);
    expect(hit[0].reaction).toEqual({ tx: CV, by: AF, after: 1, as: STROKE });
  });

  test('верапамил при сердечной недостаточности — противопоказан; бета-адреноблокатор при астме — по-прежнему', () => {
    expect(db.treatments[VERA].contraindications).toEqual([{ id: 'risk.heart_failure', level: 'absolute', reaction: 2500 }]);
    expect(db.treatments[BB].contraindications.map(k => k.id)).toEqual(['cond.asthma']);
  });
});

describe('карта и энциклопедия', () => {
  test('строка шкалы на «Студенте»: баллы и за что — возраст полосой, женский пол, пункты', () => {
    const p = find(x => x.sex === 'f' && x.age >= 65 && x.age < 75 && has(x, HTN) && ITEMS.every(f => f === HTN || !has(x, f)), { unstable: 'no' });
    const view = makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [],
      draft: { treatments: [], setting: 'home' }, arrived: [{ exam: 'exam.ask_chronic', step: 1, at: 600, obs: checked(p) }], departments: ED, difficulty: 'student',
    });
    const line = view.rules.find(r => r.id === RULE)!;
    expect(line.text).toBe('Риск инсульта высокий — нужен антикоагулянт постоянно: 3 балла — возраст 65–74 года, женский пол, известная гипертония');
  });

  test('статья о шкале: возраст полосами, пол, порог у мужчин и женщин; у ABCD2 — как было', () => {
    const blocks = article(db, RULE)!.blocks;
    expect(blocks.find(b => b.key === 'points')!.text).toEqual(['Возраст 65–74 года — 1 балл', 'Возраст 75 лет и старше — 2 балла', 'Женский пол — 1 балл']);
    expect(blocks.find(b => b.key === 'pointsYes')!.title).toBe('Если баллов у мужчин 2 и больше, у женщин — 3 и больше');
    expect(blocks.find(b => b.key === 'none')!.title).toBe('Если у мужчин меньше 2, у женщин — меньше 3');
    const abcd = article(db, 'rule.abcd2')!.blocks;
    expect(abcd.find(b => b.key === 'points')!.text).toEqual(['Возраст 60 лет и старше — 1 балл']);
    expect(abcd.find(b => b.key === 'pointsYes')!.title).toBe('Если баллов 4 и больше');
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
  const xs = people(120, 7_000_001);

  test('в приёмном с монитором: ЭКГ и давление — каждому, диагноз верный; нестабильному — разряд в ПИТ, вредного нет', () => {
    for (const p of xs) {
      const r = run(p, BAY, ED);
      expect({ seed: p.seed, dx: r.diagnosis }).toEqual({ seed: p.seed, dx: AF });
      expect(r.done).toEqual(expect.arrayContaining(['exam.ecg', 'exam.vitals']));
      const ev = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect({ seed: p.seed, harmful: ev.roles.filter(x => x.role === 'harmful').map(x => x.tx) }).toEqual({ seed: p.seed, harmful: [] });
      expect({ seed: p.seed, missing: ev.requireMissing }).toEqual({ seed: p.seed, missing: [] });
      if (paramsOf(p).unstable === 'yes') expect(r.plan).toMatchObject({ setting: 'icu', treatments: expect.arrayContaining([CV]) });
      else expect(r.plan.setting).toBe('home');
    }
  });

  test('в поликлинике без монитора: нестабильного — на скорой, стабильного — урежение дома', () => {
    for (const p of xs.slice(0, 60)) {
      const r = run(p, {}, ['dept.therapy']);
      expect(r.plan.treatments).not.toContain(CV);
      expect(r.plan.setting).toBe(paramsOf(p).unstable === 'yes' ? 'ambulance' : 'home');
    }
  });
});
