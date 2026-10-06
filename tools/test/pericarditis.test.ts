// Острый перикардит (spec 2026-10-chapter-3, часть 43д; 746_2 «Перикардиты»; ESC 2015; Imazio 2003, 2004, 2007, 2011):
// острая боль, легче сидя с наклоном вперёд, шум трения, подъём ST почти везде с депрессией PQ, выпот на УЗИ сердца.
// Лечат ацетилсалициловой кислотой или ибупрофеном с колхицином и защитой желудка — дома при низком риске; миоперикардит
// и большой выпот — в палату; тампонада — пункция перикарда и ПИТ, нитроглицерин и фуросемид ей вредны. В кабинете
// поликлиники, где ни тропонина, ни монитора, — в стационар.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { curesOf, evaluatePlan, type Plan, txAvailable, txRole, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import { complaintText, observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView, txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const PERI = 'cond.pericarditis';
const PAIN = 'sym.pericardial_pain';
const RUB = 'sign.pericardial_rub';
const MUFFLED = 'sign.heart_sounds_muffled';
const PARADOX = 'sign.pulsus_paradoxus';
const ECG_PERI = 'ecg.pericarditis';
const LOW = 'ecg.low_voltage';
const EFF = 'img.echo_effusion';
const LARGE = 'img.echo_effusion_large';
const TAMP = 'img.echo_tamponade';
const IBU = 'tx.ibuprofen';
const ASA = 'tx.aspirin_course';
const COLCH = 'tx.colchicine';
const PPI = 'tx.ppi';
const TAP = 'tx.pericardiocentesis';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true, ward: true };
/** Приёмное районной больницы: монитор в смотровой, своя палата, ПИТ нет. */
const DISTRICT: Venue = { bedside: [MONITOR], ward: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const by = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f && x.cause === PERI);
function people(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: PERI, params });
    if (p.age >= db.conditions[PERI].age.min) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true): Observation => ({ f, shown: on, exam });
const truthful = (p: Patient, exams: Id[]): Observation[] => [
  ...complaintObservations(p),
  ...exams.flatMap((exam, i) => runExam(db, p, exam, Rng.seeded(i).fork(exam), undefined, true)),
];
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
const WORKUP = ['exam.ask_chronic', 'exam.ask_chest_pain', 'exam.vitals', 'exam.heart_auscultation', 'exam.ecg', 'exam.echo', 'exam.crp', 'exam.troponin_hs', 'exam.pulsus_paradoxus'];

describe('каталог', () => {
  test('перикардит: терапия, сердце, подтверждают ЭКГ или УЗИ сердца; формы 85/7/5/3; дома, палата, ПИТ; без монитора — в стационар', () => {
    const c = db.conditions[PERI];
    expect(c).toMatchObject({ icd10: 'I30.0', department: 'dept.therapy', system: 'heart', severity: 'serious', confirm: ['exam.ecg', 'exam.echo'] });
    expect(c.params!.form).toEqual({ typical: 85, myo: 7, effusion: 5, tamponade: 3 });
    expect(c.redFlags).toEqual([TAMP, PARADOX, LARGE, 'lab.troponin_high']);
    expect(c.differential).toEqual(['cond.acs', 'cond.pe', 'cond.aortic_dissection']);
    expect(c.treatment).toMatchObject({
      firstLine: [IBU, ASA], plan: [IBU], require: [COLCH], prevent: [PPI],
      setting: { default: 'home', param: { name: 'form', map: { typical: 'home', myo: 'ward', effusion: 'ward', tamponade: 'icu' } }, without: { equipment: [MONITOR], setting: 'ward' } },
    });
    expect(c.treatment!.byParam).toEqual([expect.objectContaining({ when: { form: ['tamponade'] }, require: [TAP], beforeTransfer: [TAP] })]);
  });

  test('частота — «очень редко», как криз; с 18 лет, мужчин чуть больше', () => {
    expect(db.conditions[PERI].weight).toBe(10);
    expect(db.conditions[PERI].age).toMatchObject({ min: 18, peak: [25, 65] });
  });

  test('УЗИ сердца — в кабинете УЗИ, без облучения; выпот, выпот больше 20 мм, тампонада; каждому с болью, легче сидя с наклоном вперёд', () => {
    const e = db.exams['exam.echo'];
    expect(e).toMatchObject({ kind: 'imaging', room: 'room.ultrasound', equipment: ['eq.us_basic', 'eq.us_expert'], radiation: 'none', routineFor: [PAIN] });
    expect(e.routineSeen).toEqual([RUB, MUFFLED, ECG_PERI, LOW]);
    expect(e.checks.map(k => [k.f, k.sens, k.spec])).toEqual([[EFF, 9500, 9800], [LARGE, 9500, 9900], [TAMP, 9000, 9900]]);
  });

  test('при такой боли — ЭКГ, СРБ, тропонин, снимок груди и аускультация сердца (746_2, разделы 2.2–2.4); давление на вдохе — при глухих тонах и большом выпоте', () => {
    for (const x of ['exam.ecg', 'exam.crp', 'exam.troponin_hs', 'exam.xray_chest', 'exam.heart_auscultation']) expect({ x, r: db.exams[x].routineFor }).toEqual({ x, r: expect.arrayContaining([PAIN]) });
    expect(db.exams['exam.ecg'].routineSeen).toEqual(expect.arrayContaining([RUB]));
    expect(db.exams['exam.ecg'].checks.filter(k => k.f === ECG_PERI || k.f === LOW).map(k => [k.f, k.sens, k.spec])).toEqual([[ECG_PERI, 9000, 9950], [LOW, 8500, 9950]]);
    expect(db.exams['exam.heart_auscultation'].checks.map(k => k.f)).toEqual([RUB, MUFFLED]);
    expect(db.exams['exam.pulsus_paradoxus']).toMatchObject({ kind: 'bedside', routineSeen: [MUFFLED, LARGE, LOW] });
    expect(db.exams['exam.ask_chest_pain'].checks.some(k => k.f === PAIN)).toBe(true);
    expect(db.exams['exam.ask_onset'].checks.some(k => k.f === 'hx.recent_cold')).toBe(true);
  });

  test('лечение: колхицин — «Сердце и сосуды», АСК курсом — с ибупрофеном; пункция — «Пункции и дренажи», только у постели под монитором', () => {
    expect([COLCH, ASA, IBU, TAP, PPI].map(tx => txGroupOfClass(db.treatments[tx].class))).toEqual(['heart', 'pain', 'pain', 'drainage', 'digestive']);
    expect([txAvailable(db, TAP, {}), txAvailable(db, TAP, BAY), txAvailable(db, COLCH, {})]).toEqual([false, true, true]);
    expect(db.treatments[ASA].name.ru).toBe('Ацетилсалициловая кислота курсом');
    expect(db.treatments['tx.aspirin_acs'].name.ru).toBe('Ацетилсалициловая кислота (разжевать)');
  });
});

describe('больные', () => {
  const xs = people(2000);
  const part = (ys: Patient[], f: (p: Patient) => boolean) => ys.filter(f).length / ys.length;
  const form = (f: string) => xs.filter(p => paramsOf(p).form === f);

  test('формы — 85, 7, 5 и 3 из 100', () => {
    expect(Math.abs(part(xs, p => paramsOf(p).form === 'typical') - 0.85)).toBeLessThan(0.025);
    expect(Math.abs(part(xs, p => paramsOf(p).form === 'tamponade') - 0.03)).toBeLessThan(0.012);
  });

  test('боль — у 88 заболевших, а среди пришедших больше: без жалобы не приходят; шум трения — у трети, ЭКГ — у 60, выпот — у 60, СРБ — у 78 из 100; у обычного нет тампонады и большого выпота', () => {
    const typical = form('typical');
    expect(part(xs, p => by(p, PAIN))).toBeGreaterThan(0.9);
    expect(Math.abs(part(typical, p => by(p, RUB)) - 0.33)).toBeLessThan(0.04);
    expect(Math.abs(part(xs, p => by(p, ECG_PERI)) - 0.6)).toBeLessThan(0.04);
    expect(Math.abs(part(typical, p => by(p, EFF)) - 0.6)).toBeLessThan(0.04);
    expect(Math.abs(part(xs, p => by(p, 'lab.crp_high')) - 0.78)).toBeLessThan(0.03);
    for (const p of typical) expect([TAMP, LARGE, PARADOX, 'lab.troponin_high'].some(f => by(p, f))).toBe(false);
  });

  test('миоперикардит — тропонин у каждого; большой выпот — у каждого с выпотом больше 20 мм; тампонада — сдавление на УЗИ у каждого, давление ниже 90 обычно', () => {
    for (const p of form('myo')) expect(by(p, 'lab.troponin_high')).toBe(true);
    for (const p of form('effusion')) expect(by(p, LARGE) && by(p, EFF)).toBe(true);
    const tamp = people(300, { form: 'tamponade' });
    for (const p of tamp) expect(by(p, TAMP) && by(p, EFF)).toBe(true);
    expect(Math.abs(part(tamp, p => by(p, 'vital.bp_low')) - 0.75)).toBeLessThan(0.07);
    expect(Math.abs(part(tamp, p => by(p, PARADOX)) - 0.75)).toBeLessThan(0.07);
  });
});

describe('тексты', () => {
  test('жалоба, шум трения, лента, выпот и тампонада', () => {
    const line = (o: Observation) => observationText(db, o, 'm', 1);
    expect(line(seen(PAIN, 'exam.ask_chest_pain'))).toBe('Острая боль за грудиной, сильнее на вдохе и лёжа, легче сидя с наклоном вперёд');
    expect(line(seen(RUB, 'exam.heart_auscultation'))).toBe('Над сердцем — шум трения перикарда');
    expect(line(seen(ECG_PERI, 'exam.ecg'))).toBe('Подъём ST почти во всех отведениях, вогнутый, депрессия PQ, в aVR — наоборот: перикардит');
    expect(line(seen(LARGE, 'exam.echo'))).toBe('Выпот в перикарде большой: больше 20 мм в диастолу');
    expect(line(seen(TAMP, 'exam.echo', false))).toBe('Признаков тампонады нет');
    expect(line(seen(PARADOX, 'exam.pulsus_paradoxus'))).toBe('На вдохе верхнее давление падает больше чем на 10 — парадоксальный пульс');
    const said = new Set(Array.from({ length: 20 }, (_, s) => complaintText(db, seen(PAIN, 'complaint'), 'f', s)));
    expect(said).toEqual(new Set(['Колет за грудиной — сильнее, когда вдыхаю и когда лягу. Сяду, наклонюсь вперёд — легче', 'Острая боль в груди, отдаёт в плечо. Лёжа не могу, легче сидя']));
  });
});

describe('лента ЭКГ', () => {
  test('перикардит — подъём ST почти везде; тампонада с низким вольтажем — и он на ленте', () => {
    const view = (p: Patient) => {
      const arrived = [{ exam: 'exam.ecg', step: 1, at: 600, obs: runExam(db, p, 'exam.ecg', Rng.seeded(3).fork('exam.ecg'), undefined, true) }];
      return makeCaseView({
        version: 0, patient: p, clock: 700, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [],
        draft: { treatments: [], setting: 'home' }, arrived, departments: ED, difficulty: 'doctor',
      }).groups.find(g => g.exam === 'exam.ecg')!.image as { kind: string; ecg: { pericarditis?: boolean; lowVoltage?: boolean } };
    };
    const typical = people(60, { form: 'typical' }).find(p => by(p, ECG_PERI))!;
    expect(view(typical)).toMatchObject({ kind: 'ecg', ecg: { pericarditis: true } });
    expect(view(typical).ecg.lowVoltage).toBeUndefined();
    const tamp = people(60, { form: 'tamponade' }).find(p => by(p, LOW))!;
    expect(view(tamp).ecg.lowVoltage).toBe(true);
  });
});

describe('тактика и разбор', () => {
  const typical = people(40, { form: 'typical' })[0];
  const tamp = people(40, { form: 'tamponade' }).find(p => by(p, TAMP) && by(p, 'vital.bp_low'))!;
  const ev = (p: Patient, x: Plan, venue: Venue = BAY) => evaluatePlan(db, p, x, truthful(p, WORKUP), venue);
  const harmful = (e: ReturnType<typeof ev>) => e.roles.filter(r => r.role === 'harmful').map(r => r.tx);

  test('обычный: ибупрофен с колхицином и защитой желудка — дома, всё верно; без колхицина — «не назначено», без ИПП — без профилактики', () => {
    const ok = ev(typical, plan([IBU, COLCH, PPI]));
    expect({ missing: ok.requireMissing, prevent: ok.preventMissing, harmful: harmful(ok), setting: ok.setting.recommended, effective: ok.effective }).toEqual({ missing: [], prevent: [], harmful: [], setting: 'home', effective: true });
    expect(ev(typical, plan([IBU, PPI])).requireMissing).toEqual([COLCH]);
    expect(ev(typical, plan([ASA, COLCH])).preventMissing).toEqual([PPI]);
    // в палату низкий риск — место выше нужного
    expect(ev(typical, plan([IBU, COLCH, PPI], 'admit')).setting).toMatchObject({ recommended: 'home', chosen: 'admit' });
  });

  test('как инфаркт — антиагреганты и тромболизис перикардит не лечат; глюкокортикоид — не первая линия', () => {
    const e = ev(typical, plan(['tx.aspirin_acs', 'tx.clopidogrel', 'tx.thrombolysis']));
    expect(e.effective).toBe(false);
    expect(e.roles.map(r => r.role)).toEqual(['notIndicated', 'notIndicated', 'notIndicated']);
    expect(txRole(db, PERI, 'tx.steroid_systemic_short', paramsOf(typical))).toBe('notIndicated');
  });

  test('тампонада: пункция обязательна и до перевода; нитроглицерин, фуросемид, маска CPAP и гепарин — вред; ПИТ', () => {
    const ok = ev(tamp, plan([TAP, IBU, COLCH, PPI], 'icu'));
    expect({ missing: ok.requireMissing, harmful: harmful(ok), setting: ok.setting.recommended }).toEqual({ missing: [], harmful: [], setting: 'icu' });
    expect(ev(tamp, plan([IBU, COLCH, PPI], 'icu')).requireMissing).toEqual([TAP]);
    expect(harmful(ev(tamp, plan([TAP, 'tx.nitroglycerin_iv', 'tx.furosemide_iv', 'tx.cpap', 'tx.heparin_iv'], 'icu')))).toEqual(['tx.cpap', 'tx.furosemide_iv', 'tx.heparin_iv', 'tx.nitroglycerin_iv']);
    // в районной больнице без ПИТ — скорая, но пункция до перевода, раз монитор у постели есть
    expect(ev(tamp, plan([IBU], 'ambulance'), DISTRICT).beforeTransferMissing).toEqual([TAP]);
    // в поликлинике пункции нет — «Вызвать скорую» без замечаний
    expect(ev(tamp, plan([], 'ambulance'), {}).beforeTransferMissing).toEqual([]);
  });

  test('поликлиника: без тропонина и монитора низкий риск не установить — в стационар', () => {
    const e = ev(typical, plan([IBU, COLCH, PPI]), {});
    expect(e.setting.recommended).toBe('ward');
  });

  test('отпустить домой тампонаду — опасное решение: красный флаг на УЗИ видели', () => {
    const e = ev(tamp, plan([IBU, COLCH, PPI]));
    const score = scoreCase({ verdict: 'correct', confidence: 0.9, cost: 10, rationalCost: 10, plan: e, outcome: { kind: 'worse', day: 0, cured: false }, selfLimiting: false, redFlags: [{ f: TAMP, seen: true }] });
    expect(score.safety).toBe('D');
    expect(score.notes).toEqual(expect.arrayContaining([{ code: 'safety.redFlagIgnored', f: TAMP }]));
  });

  test('действие: ибупрофен и АСК курсом — обычно, колхицин — часто, за 7–14 дней; без лечения тампонада хуже сразу', () => {
    expect(curesOf(db, { id: PERI, params: { form: 'typical' } }, [IBU, COLCH]).map(e => [e.p, ...e.days])).toEqual([[7500, 7, 14], [5000, 7, 14]]);
    expect(curesOf(db, { id: PERI, params: { form: 'typical' } }, [ASA]).map(e => e.p)).toEqual([7500]);
    expect(untreatedOf(db, { id: PERI, params: { form: 'tamponade' } })).toMatchObject({ p: 9500, days: [0, 0] });
    expect(untreatedOf(db, { id: PERI, params: { form: 'typical' } })).toMatchObject({ p: 2500, days: [3, 7] });
  });
});

describe('энциклопедия', () => {
  test('где лечить: дома; миоперикардит и большой выпот — стационар; тампонада — ПИТ; обязательно — колхицин, при тампонаде — пункция', () => {
    const x = article(db, PERI)!;
    expect(x.blocks.find(b => b.key === 'where')!.text).toEqual([
      'Обычно — дома.',
      'При миоперикардите — повышенном тропонине — в стационаре.',
      'При выпоте в перикарде больше 20 мм — в стационаре.',
      'При тампонаде — палата интенсивной терапии.',
      'Без монитора с дефибриллятором у постели — в стационаре.',
      'Своей палаты интенсивной терапии нет — скорая, больница.',
      'В стационаре обычно 5–10\u00a0дней.',
    ]);
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Первая линия']).toEqual([IBU, ASA]);
    expect(rows['Обязательно']).toEqual([COLCH]);
    expect(rows['Обязательная профилактика']).toEqual([PPI]);
    expect(x.blocks.find(b => b.key === 'similar')!.refs!.map(r => r.id)).toEqual(expect.arrayContaining(['cond.acs']));
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

  test('обычный в смотровой приёмного: ЭКГ и УЗИ сердца; верный диагноз — ибупрофен или АСК курсом, колхицин, ИПП, почти всегда — домой', () => {
    const xs = people(30, { form: 'typical' }, 8_400_001);
    let right = 0;
    let home = 0;
    for (const p of xs) {
      const r = run(p, BAY);
      if (r.diagnosis !== PERI) continue;
      right++;
      // ложный «повышенный тропонин» или «выпот больше 20 мм» бывает и у обычного — тогда в палату
      if (r.plan.setting === 'home') home++;
      expect({ seed: p.seed, ecg: r.done.includes('exam.ecg'), echo: r.done.includes('exam.echo'), nsaid: r.plan.treatments.some(tx => tx === IBU || tx === ASA), treatments: r.plan.treatments })
        .toEqual({ seed: p.seed, ecg: true, echo: true, nsaid: true, treatments: expect.arrayContaining([COLCH, PPI]) });
    }
    expect(right / xs.length).toBeGreaterThan(0.9);
    expect(home / right).toBeGreaterThan(0.9);
  }, 120_000);

  test('тампонада: пункция перикарда и ПИТ, вредного нет', () => {
    const xs = people(20, { form: 'tamponade' }, 8_400_001);
    let right = 0;
    for (const p of xs) {
      const r = run(p, BAY);
      if (r.diagnosis !== PERI || r.plan.setting !== 'icu') continue;
      right++;
      const e = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect({ seed: p.seed, tap: r.plan.treatments.includes(TAP), harmful: e.roles.filter(x => x.role === 'harmful').map(x => x.tx) }).toEqual({ seed: p.seed, tap: true, harmful: [] });
    }
    expect(right / xs.length).toBeGreaterThan(0.8);
  }, 120_000);
});
