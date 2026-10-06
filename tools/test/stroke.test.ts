// Ишемический инсульт (spec 2026-10-chapter-3, часть 41а): неврология — в больнице с кабинетом КТ,
// больного привозит только скорая; NIHSS неврологического осмотра, часы от начала и окно
// тромболизиса, которое закрывается, пока идёт обследование; польза тромболизиса по минутам, правило
// противопоказаний, окклюзия на КТ-ангиографии и перевод на тромбэктомию, тест глотания и зонд,
// сроки, разумный врач, смена с приёмным, КТ и ПИТ, острый период в ПИТ и исход, энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, RoomSizeId, Rot, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { freezeClock, generatePatient, patientAt } from '../../src/engine/med/generate';
import { findingProbability, likelyParams, paramBeliefs, paramGain } from '../../src/engine/med/infer';
import { evaluatePlan, type Plan, txAvailable, txRole, type Venue } from '../../src/engine/med/plan';
import { choosePlan, type DoctorPhase, examMinutes, indicated, nextStep } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import { scoreCase, WORKUP_MINUTES } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, bedsideEquipment, candidatesOf, current, departmentsOf, newSandbox } from '../../src/engine/shift/engine';
import { targetResults } from '../../src/engine/shift/targets';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { daysIn, wardCourse, wardState } from '../../src/engine/shift/ward';
import { makeCaseView, noteText, outcomeText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const STROKE = 'cond.stroke_ischemic';
const LYSIS = 'tx.thrombolysis_stroke';
const MONITOR = 'eq.monitor_defib';
const ONSET = 'hx.onset_hours';
const CT = 'exam.ct_head';
const CTA = 'exam.cta_head';
const NEURO = 'exam.neuro_exam';
const ASK = 'exam.ask_stroke';
const SWALLOW = 'exam.swallow_test';
const OCCLUSION = 'img.cta_occlusion';
const SYMS = ['sym.weakness_one_side', 'sym.speech_trouble', 'sym.face_droop'];
const ANTI = ['tx.aspirin_acs', 'tx.clopidogrel'];
const CONTRA = ['risk.anticoagulants', 'risk.bleeding_tendency'];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR] };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const stroke = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.neurology', departments: ED, season: 'winter', primary: STROKE, params });
/** Инсульт бывает с 40 лет: младших с ним генератор по заданной болезни делает, а игра — нет. */
const plausible = (p: Patient) => p.age >= db.conditions[STROKE].age.min;
/** `n` больных инсультом подряд от зерна `from` — в возрасте инсульта. */
function people(n: number, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    const p = stroke(seed);
    if (plausible(p)) out.push(p);
  }
  return out;
}
const hours = (p: Patient) => p.truth.values[ONSET];
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
/** Первый больной инсультом от зерна `from`, для которого верно `ok`, — без противопоказаний к тромболизису и АСК. */
function find(ok: (p: Patient) => boolean, from = 1): Patient {
  for (let seed = from; seed < from + 5000; seed++) {
    const p = stroke(seed);
    if (plausible(p) && ![...CONTRA, 'risk.allergy_nsaid'].some(r => p.truth.risks.includes(r)) && ok(p)) return p;
  }
  throw new Error('нет такого больного');
}
/** Тромболизис обязателен: в окне, не малый, без тромбэктомии и без нарушения глотания. */
const lysable = (p: Patient, h?: number) => {
  const x = paramsOf(p);
  return x.window === 'yes' && x.minor === 'no' && x.thrombectomy === 'no' && x.dysphagia === 'no' && (h === undefined || hours(p) === h);
};
const seen = (f: Id, exam: Id, on = true, value?: number): Observation => ({ f, shown: on, exam, ...(value !== undefined ? { value } : {}) });
/** Спросили о противопоказаниях тромболизиса и АСК — их нет. */
const ASKED = [seen('hx.anticoagulants', 'exam.ask_lysis', false), seen('hx.bleeding_tendency', 'exam.ask_lysis', false), seen('hx.allergy_nsaid', 'exam.ask_allergies', false)];
/** То же, но это — есть. */
const answered = (f: Id) => ASKED.map(o => (o.f === f ? { ...o, shown: true } : o));
const scoreOf = (p: Patient, plan: Plan, venue: Venue, obs: Observation[] = ASKED, before: Record<string, string> = {}) => {
  const ev = evaluatePlan(db, p, plan, obs, venue, before);
  const settled = plan.setting === 'admit' || plan.setting === 'icu';
  return {
    ev,
    score: scoreCase({
      verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev, settles: true, selfLimiting: false, redFlags: [],
      outcome: settled ? { kind: 'admitted', day: 0, cured: ev.effective } : plan.setting === 'home' ? { kind: 'worse', day: 1, cured: false } : { kind: 'transferred', day: 0, cured: false },
    }),
  };
};
const ICU = (treatments: Id[]): Plan => ({ treatments: [...treatments].sort(), setting: 'icu' });

describe('каталог: инсульт, КТ-ангиография, тромболизис', () => {
  test('инсульт — неврология, критический; привозит только скорая; неврологию принимает больница с кабинетом КТ', () => {
    const c = db.conditions[STROKE];
    expect(c).toMatchObject({ department: 'dept.neurology', severity: 'critical', arrival: 'ambulance', settles: true, stay: [2, 3], confirm: [CT, CTA], redFlags: SYMS });
    expect(db.rooms['room.ct'].admits).toEqual(['dept.neurology']);
    // первой линии нет: тромболизис — по окну и тяжести, антиагрегант — без него, место — ПИТ или перевод
    expect(c.treatment!.firstLine).toEqual([]);
    expect(c.treatment!.setting).toEqual({ default: 'icu', param: { name: 'thrombectomy', map: { yes: 'transfer', no: 'icu' } } });
  });

  test('КТ-ангиография — в кабинете КТ: кровь и окклюзия за один заход; тест глотания и расспрос — при признаках инсульта', () => {
    expect(db.exams[CTA]).toMatchObject({ kind: 'imaging', room: 'room.ct', equipment: ['eq.ct_16', 'eq.ct_64'], radiation: 'high', time: { procedure: 12, report: 18 }, cost: 6000 });
    // первая серия — КТ без контраста, с уточнениями крови (часть 41в)
    expect(db.exams[CTA].checks).toEqual([...db.exams[CT].checks, { f: OCCLUSION, sens: 9500, spec: 9700 }]);
    // с частью 43а — и КТ-ангиография груди
    expect(db.rooms['room.ct'].exams).toEqual([CT, 'exam.cta_chest', CTA]);
    expect(db.exams[SWALLOW]).toMatchObject({ kind: 'bedside', complaints: SYMS, checks: [{ f: 'sign.dysphagia', sens: 7200, spec: 7100 }] });
    expect(db.exams[ASK]).toMatchObject({ complaints: SYMS, routineFor: SYMS });
    expect(db.exams[ASK].checks.find(k => k.f === ONSET)).toEqual({ f: ONSET, sens: 10000, spec: 10000 });
    // неврологический осмотр — с NIHSS; 6 и больше — то же число
    expect(db.exams[NEURO].checks.map(k => k.f)).toEqual(expect.arrayContaining(['sign.hemiparesis', 'sign.facial_weakness', 'sign.speech_deficit', 'sign.nihss', 'sign.nihss_high']));
    expect(db.findings['sign.nihss_high'].value!.of).toBe('sign.nihss');
  });

  test('тромболизис при инсульте — своё лечение: у постели под монитором, без спутников; польза по минутам — 22, 11 и 5 %', () => {
    const t = db.treatments[LYSIS];
    expect(t).toMatchObject({ class: 'thrombolytic', route: 'iv', bedside: { equipment: [MONITOR] } });
    expect(t.companions ?? []).toEqual([]);
    expect(t.contraindications.map(k => [k.id, k.level])).toEqual([['risk.anticoagulants', 'absolute'], ['risk.bleeding_tendency', 'absolute']]);
    expect([txAvailable(db, LYSIS), txAvailable(db, LYSIS, BAY)]).toEqual([false, true]);
    expect(t.effects.filter(e => e.kind === 'cure').map(e => [e.p, e.when])).toEqual([
      [2200, { window: ['yes'], lysis90: ['yes'], minor: ['no'] }],
      [1100, { window: ['yes'], lysis90: ['no'], lysis180: ['yes'], minor: ['no'] }],
      [500, { window: ['yes'], lysis180: ['no'], minor: ['no'] }],
    ]);
    // при кровоизлиянии в мозг — вред (часть 41в): кровотечение; с частью 43а — и при расслоении аорты
    expect(t.effects.filter(e => e.kind === 'harm').map(e => e.on)).toEqual(['cond.ich', 'cond.sah', 'cond.aortic_dissection']);
    // у инфаркта — своё имя
    expect(db.treatments['tx.thrombolysis'].name.ru).toBe('Тромболизис при инфаркте');
  });
});

describe('кого привозят', () => {
  test('пришедшему самому инсульта не бывает — его привозит скорая', () => {
    let walk = 0;
    let carried = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const ctx = { department: 'dept.therapy', departments: ED, season: 'winter' as const };
      if (generatePatient(db, seed, { ...ctx, walkIn: true }).truth.conditions[0].id === STROKE) walk++;
      if (generatePatient(db, seed, { ...ctx, carried: db.economy.ambulance.weight }).truth.conditions[0].id === STROKE) carried++;
    }
    expect(walk).toBe(0);
    expect(carried).toBeGreaterThan(20);
  });
});

describe('признаки и скрытые параметры', () => {
  const xs = people(2000);

  test('что выпало — одним шаблоном: гемипарез, парез лица и речь видны на осмотре у каждого, у кого они есть; сторона — одна', () => {
    for (const p of xs) {
      const d = paramsOf(p).deficit;
      expect([has(p, 'sign.hemiparesis'), has(p, 'sign.facial_weakness'), has(p, 'sign.speech_deficit')]).toEqual([d.includes('motor'), d.includes('face'), d.includes('speech')]);
      // жалоба — только при своём дефиците
      if (!d.includes('motor')) expect(has(p, 'sym.weakness_one_side')).toBe(false);
      if (!d.includes('face')) expect(has(p, 'sym.face_droop')).toBe(false);
      if (!d.includes('speech')) expect(has(p, 'sym.speech_trouble')).toBe(false);
      const side = paramsOf(p).side;
      for (const f of ['sym.weakness_one_side', 'sign.hemiparesis', 'sign.facial_weakness']) {
        const x = p.truth.findings.find(y => y.f === f);
        if (x) expect(x.attrs).toEqual({ side });
      }
    }
    // почти каждый жалуется на что-то из инсульта: со скорой его привозят из-за этого
    expect(xs.filter(p => p.complaints.some(f => SYMS.includes(f))).length / xs.length).toBeGreaterThan(0.98);
  });

  test('NIHSS: до 5 — 1–5 баллов, 6 и больше — 6–24; малый — меньше 5; доли — как в записи (±4 п. п.)', () => {
    for (const p of xs) {
      const v = p.truth.values['sign.nihss'];
      const high = paramsOf(p).nihss === 'high';
      expect(v).toBe(p.truth.values['sign.nihss_high']);
      expect(high ? v >= 6 && v <= 24 : v >= 1 && v <= 5).toBe(true);
      expect([has(p, 'sign.nihss'), has(p, 'sign.nihss_high')]).toEqual([!high, high]);
      expect(paramsOf(p).minor).toBe(v < 5 ? 'yes' : 'no');
    }
    // «около половины… малые (NIHSS < 5)» (814_1, раздел 3.1.2.1.1)
    const minor = xs.filter(p => paramsOf(p).minor === 'yes').length / xs.length;
    expect(Math.abs(minor - 0.48)).toBeLessThan(0.04);
  });

  test('часы от начала — по долям записи (±3 п. п.); окна — по порогам; тромбэктомия — окклюзия, NIHSS 6 и больше и меньше 6 часов', () => {
    const want = [[0, 2, 0.12], [2, 4, 0.18], [4, 6, 0.1], [6, 12, 0.2], [12, 24, 0.22], [24, 48, 0.18]] as const;
    const share = (lo: number, hi: number) => xs.filter(p => hours(p) >= lo && hours(p) < hi).length / xs.length;
    for (const [lo, hi, w] of want) expect(Math.abs(share(lo, hi) - w)).toBeLessThan(0.03);
    for (const p of xs) {
      const x = paramsOf(p);
      const h = hours(p);
      expect([x.window, x.early6, x.lysis90, x.lysis180]).toEqual([h < 4.5, h < 6, h < 1.5, h < 3].map(b => (b ? 'yes' : 'no')));
      expect(x.thrombectomy).toBe(x.lvo === 'yes' && x.nihss === 'high' && x.early6 === 'yes' ? 'yes' : 'no');
      expect(has(p, OCCLUSION)).toBe(x.lvo === 'yes' && x.nihss === 'high');
      expect(has(p, 'sign.dysphagia')).toBe(x.dysphagia === 'yes');
    }
    // доли производных в записи — те, что выходят у генератора: по ним вывод, пока не спросили (±4 п. п.)
    const dist = db.conditions[STROKE].params!;
    for (const name of ['window', 'early6', 'lysis90', 'lysis180', 'minor', 'thrombectomy']) {
      const got = xs.filter(p => paramsOf(p)[name] === 'yes').length / xs.length;
      expect({ name, off: Math.abs(got - dist[name].yes / (dist[name].yes + dist[name].no)) < 0.04 }).toEqual({ name, off: true });
    }
  });

  test('неврологический осмотр: число NIHSS — в строке; «нет» о шкале инсульта не пишет', () => {
    const view = (p: Patient) => {
      const obs = runExam(db, p, NEURO, Rng.seeded(3).fork('neuro'), undefined, true);
      return makeCaseView({
        version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [NEURO],
        draft: { treatments: [], setting: 'icu' }, arrived: [{ exam: NEURO, step: 1, at: 600, obs }],
      }).groups[0].lines.map(l => l.text);
    };
    const low = find(p => paramsOf(p).nihss === 'low');
    const high = find(p => paramsOf(p).nihss === 'high');
    expect(view(low)).toContain(`По шкале инсульта NIH — ${low.truth.values['sign.nihss']}`);
    expect(view(high)).toContain(`По шкале инсульта NIH — ${high.truth.values['sign.nihss']}`);
    for (const p of [low, high]) expect(view(p).filter(t => t.startsWith('По шкале инсульта NIH'))).toHaveLength(1);
    // при травме головы о шкале инсульта осмотр не пишет
    const concussion = generatePatient(db, 5, { department: 'dept.trauma', departments: ED, season: 'winter', primary: 'cond.concussion' });
    expect(view(concussion).some(t => t.includes('NIH'))).toBe(false);
  });
});

describe('часы идут, пока идёт обследование', () => {
  test('patientAt: к часам от начала — минуты от прихода; окна закрываются по порогам, тромбэктомия — следом; сам больной не меняется', () => {
    const p = find(x => hours(x) === 1 && paramsOf(x).lvo === 'yes' && paramsOf(x).nihss === 'high');
    const keys = ['lysis90', 'lysis180', 'window', 'early6', 'thrombectomy'];
    const at = (minutes: number) => patientAt(db, p, minutes);
    expect(keys.map(k => paramsOf(p)[k])).toEqual(['yes', 'yes', 'yes', 'yes', 'yes']);
    expect(at(29).before).toEqual({});
    expect(at(30).before).toEqual({ lysis90: 'yes' });
    expect(at(120).before).toEqual({ lysis90: 'yes', lysis180: 'yes' });
    expect(at(210).before).toEqual({ lysis90: 'yes', lysis180: 'yes', window: 'yes' });
    const late = at(300);
    expect(late.before).toEqual({ lysis90: 'yes', lysis180: 'yes', window: 'yes', early6: 'yes', thrombectomy: 'yes' });
    expect(keys.map(k => paramsOf(late.patient)[k])).toEqual(['no', 'no', 'no', 'no', 'no']);
    // копия: у самого больного окна прежние; остальные параметры — те же
    expect(keys.map(k => paramsOf(p)[k])).toEqual(['yes', 'yes', 'yes', 'yes', 'yes']);
    expect(paramsOf(late.patient).nihss).toBe(paramsOf(p).nihss);
  });

  test('freezeClock меняет параметры основного заболевания и возвращает прежние значения изменившихся; у болезни без часов — ничего', () => {
    const p = find(x => hours(x) === 2);
    const copy = patientAt(db, p, 0).patient;
    expect(freezeClock(db, copy, 0)).toEqual({});
    expect(freezeClock(db, copy, 60)).toEqual({ lysis180: 'yes' });
    expect(paramsOf(copy).lysis180).toBe('no');
    // болезнь без порогов по часам — минуты ничего не меняют
    const flu = generatePatient(db, 3, { department: 'dept.therapy', season: 'winter', primary: 'cond.influenza' });
    expect(freezeClock(db, patientAt(db, flu, 0).patient, 600)).toEqual({});
  });
});

describe('вывод по тому, что видно', () => {
  const age = 70;
  const onset = (h: number) => seen(ONSET, ASK, true, h);
  const high = [seen('sign.nihss', NEURO, false, 14), seen('sign.nihss_high', NEURO, true, 14)];
  const low = [seen('sign.nihss', NEURO, true, 3), seen('sign.nihss_high', NEURO, false, 3)];
  const yes = (name: string, obs: Observation[], minutes = 0) => paramBeliefs(db, STROKE, name, obs, age, minutes).find(b => b.value === 'yes')!.p;

  test('окно — по часам из расспроса и минутам с прихода; не спрашивали — доля из записи', () => {
    expect(likelyParams(db, STROKE, [onset(3)], age).window).toBe('yes');
    expect(likelyParams(db, STROKE, [onset(3)], age, 89).window).toBe('yes');
    expect(likelyParams(db, STROKE, [onset(3)], age, 90).window).toBe('no');
    expect(yes('window', [])).toBeCloseTo(0.35, 5);
    expect(yes('minor', low)).toBe(1);
    expect(yes('minor', high)).toBe(0);
  });

  test('тромбэктомия — произведение трёх: окклюзия видна — да; NIHSS до 5 или 6 часов прошло — нет, что бы ни показала КТ-ангиография', () => {
    const occluded = seen(OCCLUSION, CTA);
    expect(yes('thrombectomy', [onset(2), ...high, occluded])).toBeGreaterThan(0.9);
    expect(yes('thrombectomy', [onset(2), ...high, seen(OCCLUSION, CTA, false)])).toBeLessThan(0.5);
    expect(yes('thrombectomy', [onset(2), ...low, occluded])).toBe(0);
    expect(yes('thrombectomy', [onset(8), ...high, occluded])).toBe(0);
    // и окно 6 часов закрылось, пока искали
    expect(yes('thrombectomy', [onset(5), ...high, occluded], 60)).toBe(0);
  });

  test('польза КТ-ангиографии для тактики: при NIHSS 6 и больше в первые 6 часов — есть, иначе нет; у КТ без контраста — нет', () => {
    const gain = (obs: Observation[], exam = CTA, minutes = 0) => paramGain(db, STROKE, 'thrombectomy', exam, obs, age, minutes);
    expect(gain([onset(2), ...high])).toBeGreaterThan(0.1);
    expect(gain([onset(2), ...low])).toBe(0);
    expect(gain([onset(8), ...high])).toBe(0);
    expect(gain([onset(2), ...high], CT)).toBe(0);
  });
});

describe('тактика и разбор', () => {
  test('роли: в окне и не малый — тромболизис обязателен, и до перевода, антиагреганты — не нужны; вне окна и при малом — наоборот', () => {
    const at = (params: Record<string, string>, tx: Id) => txRole(db, STROKE, tx, params);
    const open = { window: 'yes', minor: 'no', thrombectomy: 'no', dysphagia: 'no' };
    expect(at(open, LYSIS)).toBe('require');
    expect(ANTI.map(tx => at(open, tx))).toEqual(['notIndicated', 'notIndicated']);
    for (const closed of [{ ...open, window: 'no' }, { ...open, minor: 'yes' }]) {
      expect(at(closed, LYSIS)).toBe('notIndicated');
      expect(ANTI.map(tx => at(closed, tx))).toEqual(['require', 'require']);
    }
    expect(at({ ...open, dysphagia: 'yes' }, 'tx.ng_tube')).toBe('require');
    expect(at(open, 'tx.ng_tube')).toBe('supportive');
    for (const tx of ['tx.thrombolysis', 'tx.doac', 'tx.steroid_iv']) expect(at(open, tx)).toBe('notIndicated');
  });

  test('в ПИТ с тромболизисом — без замечаний; без него под монитором — одно замечание «обязательно», лечение и безопасность C', () => {
    const p = find(x => lysable(x));
    const done = scoreOf(p, ICU([LYSIS]), BAY);
    expect(done.score.notes).toEqual([]);
    expect([done.score.treatment, done.score.safety, done.score.setting]).toEqual(['A', 'A', 'A']);
    expect(done.ev.noFirstLine).toBe(true);
    // у хирургической болезни первая линия есть — её операция: льготы нет
    const appendicitis = generatePatient(db, 7, { department: 'dept.surgery', departments: ED, season: 'winter', primary: 'cond.appendicitis' });
    expect(evaluatePlan(db, appendicitis, { treatments: [], setting: 'surgery' }, []).noFirstLine).toBe(false);
    const bare = scoreOf(p, ICU([]), BAY);
    expect(bare.ev.requireMissing).toEqual([LYSIS]);
    expect(bare.ev.beforeTransferMissing).toEqual([LYSIS]);
    // лежит у нас: «до перевода» не пишется — одна строка
    expect(bare.score.notes).toEqual([{ code: 'tx.requireMissing', tx: LYSIS, when: { window: ['yes'], minor: ['no'] } }]);
    expect(noteText(bare.score.notes[0])).toBe('Не назначено: тромболизис при ишемическом инсульте — обязательно в первые 4,5\u00a0часа от начала и NIHSS от 5 баллов');
    expect([bare.score.treatment, bare.score.safety]).toEqual(['C', 'C']);
  });

  test('своей ПИТ нет — скорая, и тромболизис до неё; в кабинете врача тромболизиса нет — и спроса за него нет; противопоказание известно — тоже', () => {
    const p = find(x => lysable(x));
    const away = scoreOf(p, { treatments: [], setting: 'ambulance' }, BAY);
    expect(away.score.notes).toEqual([{ code: 'tx.beforeTransferMissing', tx: LYSIS, when: { window: ['yes'], minor: ['no'] } }]);
    expect(noteText(away.score.notes[0])).toBe('Не сделано до перевода: тромболизис при ишемическом инсульте — обязательно в первые 4,5\u00a0часа от начала и NIHSS от 5 баллов');
    expect(scoreOf(p, { treatments: [LYSIS], setting: 'ambulance' }, BAY).score.notes).toEqual([]);
    // в кабинете
    const office = scoreOf(p, ICU([]), {});
    expect([office.ev.requireMissing, office.ev.beforeTransferMissing]).toEqual([[], []]);
    // принимает антикоагулянты и сказал об этом — тромболизиса не ждут; назначили — нарушение
    let q = stroke(1);
    for (let seed = 2; !(plausible(q) && lysable(q) && q.truth.risks.includes('risk.anticoagulants')); seed++) q = stroke(seed);
    const known = answered('hx.anticoagulants');
    expect(scoreOf(q, ICU([]), BAY, known).ev.requireMissing).toEqual([]);
    const given = scoreOf(q, ICU([LYSIS]), BAY, known).score;
    expect(given.notes).toContainEqual({ code: 'safety.knownViolation', tx: LYSIS, by: 'risk.anticoagulants' });
    expect(given.safety).toBe('D');
  });

  test('окклюзия в первые 6 часов — перевод на тромбэктомию, тромболизис — до него; ПИТ — меньше нужного', () => {
    const p = find(x => paramsOf(x).thrombectomy === 'yes' && paramsOf(x).window === 'yes' && paramsOf(x).dysphagia === 'no');
    const go = scoreOf(p, { treatments: [LYSIS], setting: 'ambulance' }, BAY);
    expect(go.score.notes).toEqual([]);
    expect(go.ev.setting).toMatchObject({ recommended: 'transfer', chosen: 'ambulance' });
    const stay = scoreOf(p, ICU([LYSIS]), BAY);
    expect(stay.score.setting).toBe('D');
    expect(stay.score.notes).toContainEqual({ code: 'setting.under', recommended: 'ambulance' });
  });

  test('вне окна: в ПИТ — АСК или клопидогрел обязательны, тромболизис не нужен; дома — без лечения причины и меньше нужного', () => {
    const p = find(x => paramsOf(x).window === 'no' && paramsOf(x).thrombectomy === 'no' && paramsOf(x).dysphagia === 'no');
    expect(scoreOf(p, ICU(['tx.aspirin_acs']), BAY).score.notes).toEqual([]);
    expect(scoreOf(p, ICU(['tx.clopidogrel']), BAY).score.notes).toEqual([]);
    const bare = scoreOf(p, ICU([]), BAY);
    expect(bare.score.notes).toEqual([{ code: 'tx.requireMissing', tx: 'tx.aspirin_acs', when: { window: ['no'] } }]);
    const late = scoreOf(p, ICU(['tx.aspirin_acs', LYSIS]), BAY);
    expect(late.score.notes).toContainEqual({ code: 'tx.notIndicated', tx: LYSIS });
    // острый период проходит в стационаре; дома — нет: лечения причины нет, и место меньше нужного
    const home = scoreOf(p, { treatments: ['tx.aspirin_acs'], setting: 'home' }, {});
    expect(home.score.notes).toContainEqual({ code: 'tx.noCure' });
    expect([home.score.treatment, home.score.setting]).toEqual(['D', 'D']);
  });

  test('нарушение глотания — зонд обязателен; без него зонд — не ошибка', () => {
    const p = find(x => paramsOf(x).window === 'no' && paramsOf(x).thrombectomy === 'no' && paramsOf(x).dysphagia === 'yes');
    expect(scoreOf(p, ICU(['tx.aspirin_acs']), BAY).score.notes).toEqual([{ code: 'tx.requireMissing', tx: 'tx.ng_tube', when: { dysphagia: ['yes'] } }]);
    expect(scoreOf(p, ICU(['tx.aspirin_acs', 'tx.ng_tube']), BAY).score.notes).toEqual([]);
    const q = find(x => paramsOf(x).window === 'no' && paramsOf(x).thrombectomy === 'no' && paramsOf(x).dysphagia === 'no');
    expect(scoreOf(q, ICU(['tx.aspirin_acs', 'tx.ng_tube']), BAY).score.notes).toEqual([]);
  });

  test('окно закрылось, пока шло обследование: замечание; оставалось больше часа — лечение C, меньше — без оценки', () => {
    const plan = ICU(['tx.aspirin_acs']);
    const p = find(x => lysable(x, 3));
    const late = patientAt(db, p, 120);
    expect(late.before).toMatchObject({ window: 'yes' });
    const slow = scoreOf(late.patient, plan, { ...BAY, minutes: 120 }, ASKED, late.before);
    expect(slow.ev.windowMissed).toEqual([{ tx: LYSIS, at: 300, left: 90 }]);
    expect(slow.score.notes).toEqual([{ code: 'tx.windowMissed', tx: LYSIS, at: 300 }]);
    expect(noteText(slow.score.notes[0])).toBe('Окно закрылось, пока шло обследование: решение — через 5\u00a0ч от начала болезни, и тромболизис при ишемическом инсульте уже не поможет');
    expect(slow.score.treatment).toBe('C');
    expect(WORKUP_MINUTES).toBe(60);
    // пришёл через 4 часа: на обследование оставалось 30 минут — успеть было нельзя
    const q = find(x => lysable(x, 4));
    const lateQ = patientAt(db, q, 40);
    const tight = scoreOf(lateQ.patient, plan, { ...BAY, minutes: 40 }, ASKED, lateQ.before);
    expect(tight.ev.windowMissed).toEqual([{ tx: LYSIS, at: 280, left: 30 }]);
    expect(noteText(tight.score.notes[0])).toContain('через 4\u00a0ч 40\u00a0мин от начала болезни');
    expect(tight.score.treatment).toBe('A');
    // в кабинете врача тромболизиса не сделать — и окна не было
    expect(scoreOf(late.patient, plan, { minutes: 120 }, ASKED, late.before).ev.windowMissed).toEqual([]);
    // противопоказание известно — тоже
    expect(scoreOf(late.patient, plan, { ...BAY, minutes: 120 }, answered('hx.bleeding_tendency'), late.before).ev.windowMissed).toEqual([]);
  });
});

describe('правило «Можно ли тромболизис при инсульте»', () => {
  const rule = db.rules['rule.lysis_stroke'];
  const ANY = ['img.ct_blood', 'lab.glucose_low', 'hx.anticoagulants', 'hx.bleeding_tendency'];

  test('кровь на КТ, гипогликемия, антикоагулянты, кровоточивость: хоть одно — нельзя; всё проверили и ничего — можно', () => {
    expect(rule).toMatchObject({ complaints: SYMS, any: ANY, decides: LYSIS, about: [STROKE] });
    const before = checkRule(rule, 70, knownOf([]));
    expect([before.verdict, [...before.left].sort()]).toEqual(['unknown', [...ANY].sort()]);
    const answers = (yes?: Id) => ANY.map(f => seen(f, 'x', f === yes));
    expect(checkRule(rule, 70, knownOf(answers())).verdict).toBe('no');
    for (const f of ANY) expect(checkRule(rule, 70, knownOf(answers(f))).verdict).toBe('yes');
  });

  test('что проверяет: кровь — КТ и КТ-ангиография, глюкозу — глюкометр, лекарства и кровоточивость — вопросы перед тромболизисом', () => {
    expect(db.revealedBy['img.ct_blood']).toEqual(expect.arrayContaining([CT, CTA]));
    expect(db.revealedBy['lab.glucose_low']).toContain('exam.glucometer');
    for (const f of ['hx.anticoagulants', 'hx.bleeding_tendency']) expect(db.revealedBy[f]).toContain('exam.ask_lysis');
    // гипогликемия — «маска» инсульта: у самого инсульта её нет
    expect(findingProbability(db, 'lab.glucose_low', [STROKE], [])).toBe(0);
  });
});

describe('сроки', () => {
  test('осмотр — 10 минут, КТ или КТ-ангиография — 40, тест глотания — 3 часа, и только тем, кто остаётся у нас', () => {
    // с частью 41б осмотр и КТ — и при прошедших слабости и нарушении речи: всем с подозрением на ОНМК
    const onmk = [...SYMS, 'sym.transient_weakness', 'sym.transient_speech'];
    // с частью 41в КТ — и при внезапной сильнейшей головной боли, и всем, у кого КТ показала кровь
    expect([db.targets['target.stroke_exam'], db.targets['target.stroke_ct'], db.targets['target.stroke_swallow']].map(t => [t.complaints, t.findings, t.exams, t.minutes, t.stays ?? false])).toEqual([
      [onmk, [], [NEURO], 10, false],
      [[...onmk, 'sym.thunderclap'], ['img.ct_blood'], [CT, CTA], 40, false],
      [SYMS, [], [SWALLOW], 180, true],
    ]);
    const p = find(x => x.complaints.includes('sym.weakness_one_side'));
    const at = { roomType: () => undefined, bedside: () => false, can: () => true };
    const arrived = (exam: Id, minute: number) => ({ exam, obs: [], at: minute * 60, step: 1 });
    const visit = { patient: p, arriveT: 0, results: [arrived(NEURO, 8), arrived(CTA, 35), arrived(SWALLOW, 50)] };
    const results = (setting: Setting) => targetResults(db, visit, at, { t: 60 * 60, plan: { treatments: [], setting } });
    expect(results('icu').map(r => [r.id, r.minutes, r.grade])).toEqual([['target.stroke_ct', 35, 'A'], ['target.stroke_exam', 8, 'A'], ['target.stroke_swallow', 50, 'A']]);
    // переведённому глотание проверят там, куда везут
    expect(results('transfer').map(r => r.id)).toEqual(['target.stroke_ct', 'target.stroke_exam']);
  });
});

describe('разумный врач', () => {
  const cands = candidatesOf(db, ED);
  const exams = Object.keys(db.exams).sort();
  /** Шаги разумного врача до решения; минуты с прихода — по сделанным обследованиям. */
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
  const runs = people(150, 30_001).filter(p => p.complaints.some(f => SYMS.includes(f))).map(p => ({ p, r: run(p, venue) }));

  test('осмотр с NIHSS — первым делом; КТ — до конца сроков, тест глотания — каждому; диагноз верный почти у всех', () => {
    expect(runs.length).toBeGreaterThan(140);
    const right = runs.filter(x => x.r.diagnosis === STROKE);
    expect(right.length / runs.length).toBeGreaterThan(0.95);
    for (const { p, r } of runs) {
      // два срока по 10 минут — по порядку: ЭКГ при давящей боли в груди, потом осмотр
      expect(r.done[0]).toBe(p.complaints.includes('sym.chest_pain_pressing') ? 'exam.ecg' : NEURO);
      expect(r.done.indexOf(NEURO)).toBeLessThanOrEqual(1);
      expect(r.done.some(e => e === CT || e === CTA)).toBe(true);
      expect(r.done).toContain(SWALLOW);
    }
  });

  test('КТ-ангиография — когда окклюзия решает тактику: при NIHSS 6 и больше в первые 6 часов; иначе — КТ без контраста', () => {
    for (const { p, r } of runs) {
      const x = paramsOf(p);
      const cta = r.done.includes(CTA);
      if (x.nihss === 'low' || hours(p) >= 6) expect({ seed: p.seed, cta }).toEqual({ seed: p.seed, cta: false });
    }
    expect(runs.some(x => x.r.done.includes(CTA))).toBe(true);
  });

  test('план: в окне — тромболизис, вне окна и при малом — антиагрегант; зонд при нарушении глотания; ПИТ или перевод на тромбэктомию', () => {
    let lysed = 0;
    for (const { p, r } of runs.filter(x => x.r.diagnosis === STROKE)) {
      const ev = evaluatePlan(db, patientAt(db, p, r.minutes).patient, r.plan, r.obs, { ...BAY, minutes: r.minutes });
      if (r.plan.treatments.includes(LYSIS)) lysed++;
      // ошибается только там, где обманул осмотр или тест глотания
      if (ev.requireMissing.length > 0) expect(ev.requireMissing.every(tx => tx === 'tx.ng_tube' || tx === LYSIS || ANTI.includes(tx))).toBe(true);
      expect(['icu', 'ambulance']).toContain(r.plan.setting);
      if (r.plan.treatments.includes(LYSIS)) expect(r.plan.treatments.some(tx => ANTI.includes(tx))).toBe(false);
    }
    expect(lysed).toBeGreaterThan(10);
    // без монитора у постели тромболизиса нет — антиагрегант и скорая
    const p = find(x => lysable(x) && x.complaints.some(f => SYMS.includes(f)));
    const office = run(p, {});
    expect(office.plan.treatments).not.toContain(LYSIS);
  });

  test('страховая: КТ-ангиография показана при признаках инсульта — по сроку, как и КТ', () => {
    const p = find(x => x.complaints.includes('sym.weakness_one_side'));
    for (const exam of [CT, CTA, NEURO, SWALLOW]) expect(indicated(db, p, complaintObservations(p), cands, exam)).toBe(true);
  });

  test('план по наблюдениям: часы — на минуту решения, противопоказание — без тромболизиса', () => {
    const obs = [...complaintObservations(find(x => true)), seen(ONSET, ASK, true, 2), seen('sign.nihss', NEURO, true, 4), seen('sign.nihss_high', NEURO, false, 4)];
    expect(choosePlan(db, STROKE, obs, 70, { ...BAY, icu: true }).treatments).toEqual(['tx.aspirin_acs']);
    const moderate = obs.map(o => (o.f === 'sign.nihss' ? { ...o, value: 5 } : o.f === 'sign.nihss_high' ? { ...o, value: 5 } : o));
    expect(choosePlan(db, STROKE, moderate, 70, { ...BAY, icu: true })).toEqual({ treatments: [LYSIS], setting: 'icu' });
    expect(choosePlan(db, STROKE, moderate, 70, { ...BAY, icu: true, minutes: 150 }).treatments).toEqual(['tx.aspirin_acs']);
    expect(choosePlan(db, STROKE, [...moderate, ...answered('hx.anticoagulants')], 70, { ...BAY, icu: true }).treatments).not.toContain(LYSIS);
    // своей ПИТ нет — скорая
    expect(choosePlan(db, STROKE, moderate, 70, BAY).setting).toBe('ambulance');
  });
});

/**
 * Песочница с готовой амбулаторией и справа — смотровая приёмного с монитором, кабинет КТ с
 * томографом, рентгенолаборантом и рентгенологом, ниже — ПИТ на две койки с мониторами, медсестрой и
 * анестезиологом-реаниматологом (без `icu: false`). Медсестра ЭКГ — в смотровую.
 */
function strokeHospital(o: { icu?: boolean; ct?: boolean } = {}): ShiftState {
  const s = newSandbox(db, { seed: 25, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  // томограф дороже «щедрого» бюджета
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
  const ct = o.ct === false ? undefined : build('room.ct', 'M', 29, 10, 2, ['eq.ct_16']);
  const icu = o.icu === false ? undefined : build('room.icu', 'S', 29, 20, 2, [MONITOR, MONITOR]);
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: er });
  const hire = (role: string, room: string) => {
    const c = s.candidates!.find(x => x.role === role && !s.staff!.some(m => m.id === x.id))!;
    apply(db, s, { kind: 'hire', id: c.id });
    apply(db, s, { kind: 'assign', id: c.id, room });
  };
  if (ct) for (const role of ['role.radiographer', 'role.radiologist']) hire(role, ct);
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
  const night = (s: ShiftState) => {
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
  };

  test('неврологию принимает больница с работающим кабинетом КТ; без него инсульта не привозят', () => {
    expect(departmentsOf(db, strokeHospital())).toContain('dept.neurology');
    expect(departmentsOf(db, strokeHospital({ ct: false }))).not.toContain('dept.neurology');
  });

  test('инсульт в окне: осмотр, расспрос, глюкоза, КТ, вопросы и тест глотания — в срок; тромболизис у постели, ПИТ; выписка — с последствиями или без', () => {
    const s = strokeHospital();
    const patient = find(x => lysable(x, 1) && x.complaints.includes('sym.weakness_one_side'));
    const p = bring(s, patient);
    expect(p.bay).toBeDefined();
    for (const exam of [NEURO, ASK, 'exam.glucometer', CT, 'exam.ask_lysis', SWALLOW]) apply(db, s, { kind: 'exam', exam });
    for (let i = 0; i < 20 && p.pending.length > 0; i++) apply(db, s, { kind: 'waitResults' });
    expect(p.results.some(r => r.exam === CT)).toBe(true);
    expect(bedsideEquipment(db, s, p)).toContain(MONITOR);
    apply(db, s, { kind: 'toggleTreatment', id: LYSIS });
    expect(p.draft.treatments).toEqual([LYSIS]);
    apply(db, s, { kind: 'diagnose', id: STROKE });
    apply(db, s, { kind: 'setting', setting: 'icu' });
    apply(db, s, { kind: 'finish' });
    const closed = p.closed!;
    expect(closed.grades).toMatchObject({ accuracy: 'A', treatment: 'A', setting: 'A', safety: 'A' });
    expect(closed.notes).toEqual([]);
    expect(closed.targets!.map(t => [t.id, t.grade])).toEqual([['target.stroke_ct', 'A'], ['target.stroke_exam', 'A'], ['target.stroke_swallow', 'A']]);
    expect(p.status).toBe('admitted');
    // острый период — 2–3 суток в ПИТ
    const ready = p.stay!.readyAfter!;
    expect(ready).toBeGreaterThanOrEqual(2);
    expect(ready).toBeLessThanOrEqual(3);
    expect(['clear', 'residual']).toContain(p.stay!.settled!);
    for (let d = 1; d < ready; d++) {
      night(s);
      expect(wardState(p.stay!, daysIn(p.stay!, s.day))).toBe('better');
    }
    night(s);
    expect(wardState(p.stay!, daysIn(p.stay!, s.day))).toBe('ready');
    const settled = p.stay!.settled!;
    apply(db, s, { kind: 'discharge', id: p.id });
    expect(p.closed!.outcome).toEqual({ kind: 'recovered', day: ready, cured: settled === 'clear', settled });
    expect(outcomeText(p.closed!.outcome, 'icu', patient.sex === 'f')).toBe(settled === 'clear'
      ? `Через ${ready}\u00a0дня острый период позади, и последствий нет: лечение помогло`
      : `Через ${ready}\u00a0дня острый период позади, но последствия остались — дальше реабилитация`);
  });

  test('без своей ПИТ — «Вызвать скорую» и тромболизис до неё; без него — «Не сделано до перевода»', () => {
    const s = strokeHospital({ icu: false });
    const patient = find(x => lysable(x, 2) && x.complaints.includes('sym.weakness_one_side'));
    const p = bring(s, patient);
    for (const exam of [NEURO, ASK, 'exam.glucometer', CT, 'exam.ask_lysis']) apply(db, s, { kind: 'exam', exam });
    for (let i = 0; i < 20 && p.pending.length > 0; i++) apply(db, s, { kind: 'waitResults' });
    apply(db, s, { kind: 'diagnose', id: STROKE });
    apply(db, s, { kind: 'setting', setting: 'ambulance' });
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.closed!.notes).toContainEqual({ code: 'tx.beforeTransferMissing', tx: LYSIS, when: { window: ['yes'], minor: ['no'] } });
    // переведённому глотание проверят там
    expect(p.closed!.targets!.map(t => t.id)).toEqual(['target.stroke_ct', 'target.stroke_exam']);
  });
});

describe('острый период в ПИТ', () => {
  test('тромболизис помог — выписка без последствий; нет — к сроку стационара, последствия остались', () => {
    const p = find(x => lysable(x, 1));
    const ev = evaluatePlan(db, p, ICU([LYSIS]), [], BAY);
    const courses = Array.from({ length: 400 }, (_, i) => wardCourse(db, p, ICU([LYSIS]), ev, Rng.seeded(i).fork('ward')));
    for (const c of courses) {
      expect(c.readyAfter).toBeGreaterThanOrEqual(2);
      expect(c.readyAfter).toBeLessThanOrEqual(3);
    }
    // в первые 90 минут помогает каждому четвёртому-пятому (±5 п. п.)
    const clear = courses.filter(c => c.settled === 'clear').length / courses.length;
    expect(Math.abs(clear - 0.22)).toBeLessThan(0.05);
    expect(courses.every(c => c.settled === 'clear' || c.settled === 'residual')).toBe(true);
    // без тромболизиса — всегда с последствиями
    const none = evaluatePlan(db, p, ICU(['tx.aspirin_acs']), [], BAY);
    expect(wardCourse(db, p, ICU(['tx.aspirin_acs']), none, Rng.seeded(1).fork('ward')).settled).toBe('residual');
  });
});

describe('энциклопедия', () => {
  test('у инсульта: обязательно и до перевода — тромболизис в окне; где лечить — ПИТ, без неё скорая, тромбэктомия — перевод; острый период', () => {
    const a = article(db, STROKE)!;
    const rows = a.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]);
    expect(rows).toContainEqual(['Обязательно, в первые 4,5\u00a0часа от начала и NIHSS от 5 баллов', [LYSIS]]);
    expect(rows).toContainEqual(['Обязательно до перевода, в первые 4,5\u00a0часа от начала и NIHSS от 5 баллов', [LYSIS]]);
    expect(rows).toContainEqual(['Обязательно, через 4,5\u00a0часа от начала и позже — одно из', ANTI]);
    expect(rows).toContainEqual(['Обязательно, при нарушении глотания', ['tx.ng_tube']]);
    const where = a.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toEqual(expect.arrayContaining([
      'Обычно — палата интенсивной терапии.',
      'Своей палаты интенсивной терапии нет — скорая, больница.',
      'При окклюзии крупной артерии, NIHSS 6 и больше, в первые 6\u00a0часов — скорая, перевод в центр.',
    ]));
    // признаки по шаблону выпадений — одной подписью набора
    const signs = a.blocks.find(b => b.key === 'signs')!.rows!.flatMap(r => r.refs);
    expect(signs.find(r => r.id === 'sign.hemiparesis')!.note).toBe('при слабости в руке и ноге');
    expect(signs.find(r => r.id === 'sign.facial_weakness')!.note).toBe('при парезе лица');
    expect(signs.find(r => r.id === 'sign.speech_deficit')!.note).toBe('при нарушении речи');
    expect(a.blocks.find(b => b.key === 'course')!.text).toContain(
      'Острый период проходит под наблюдением в стационаре; помогло лечение — последствий нет, нет — остаются, и дальше реабилитация.',
    );
  });

  test('у тромболизиса — где делают и при чём обязателен; у правила — о каком лечении; у КТ-ангиографии — кабинет КТ', () => {
    const t = article(db, LYSIS)!;
    expect(t.blocks.find(b => b.key === 'where')!.refs!.map(r => r.id)).toEqual([MONITOR, 'room.emergency', 'room.icu']);
    const used = t.blocks.find(b => b.key === 'usedAs')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]);
    // с частью 41в — опасно при кровоизлияниях в мозг: кровь на КТ — абсолютное противопоказание; с частью 43а — и при
    // расслоении аорты; с частью 43г — и при гипертоническом кризе: давление выше 185/110 — противопоказание
    expect(used).toEqual([['Опасно при', ['cond.ich', 'cond.hypertensive_crisis', 'cond.aortic_dissection', 'cond.sah']], ['Обязательно при', [STROKE]], ['Обязательно до перевода при', [STROKE]]]);
    expect(article(db, 'rule.lysis_stroke')!.blocks.find(b => b.key === 'decides')!.refs!.map(r => r.id)).toEqual([LYSIS]);
    expect(article(db, CTA)!.blocks.find(b => b.key === 'where')!.refs!.map(r => r.id)).toEqual(['room.ct', 'eq.ct_16', 'eq.ct_64']);
    expect(article(db, 'room.ct')!.blocks.flatMap(b => b.refs ?? []).map(r => r.id)).toContain(CTA);
  });
});
