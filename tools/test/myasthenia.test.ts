// Миастенический криз (spec 2026-10-chapter-4, часть 58в; 165_2): нарастающая слабость с нарушениями глотания и дыхательной
// недостаточностью, которой нужна вентиляция; угроза криза — бульбарные и дыхательные нарушения без неё. Чаще всего обрушивает
// инфекция, у каждого пятого криз — первое проявление миастении. Иммуноглобулин в вену каждому, при дыхательной недостаточности —
// ИВЛ или маска; фторхинолоны, макролиды, бензодиазепины и опиоиды — опасно. Зрачки обычные — этим криз не похож на ботулизм.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { alsoSettings, curesOf, evaluatePlan, type Plan, recommendedSetting, selfLimits, txRole, type Venue, verdictOf } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

// разумный врач по полусотне больных — дольше 5 секунд
setDefaultTimeout(120_000);

const MG = 'cond.myasthenic_crisis';
const BOT = 'cond.botulism';
const IVIG = 'tx.ivig';
const VENT = 'tx.ventilation';
const CPAP = 'tx.cpap';
const ICE = 'exam.ice_test';
const HARMFUL = ['tx.fluoroquinolone', 'tx.macrolide', 'tx.benzodiazepine', 'tx.morphine_iv'];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.infectious', 'dept.neurology'];
const VENUE: Venue = { ward: true, icu: true, ricu: true, rooms: ['room.ct', 'room.mri'] };

const patients = (cond: Id, n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.neurology', departments: ED, season: 'autumn', primary: cond, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === p.truth.conditions.find(c => c.role === 'primary')!.id);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];
const plan = (treatments: Id[], setting: Setting): Plan => ({ treatments: [...treatments].sort(), setting });

describe('миастенический криз', () => {
  const ps = patients(MG, 300, 58_500);

  test('запись по 165_2: неврология, G70.0, критическое, диагноз клинический; известна ли миастения, причина и дыхание — параметры', () => {
    expect(db.conditions[MG]).toMatchObject({
      icd10: 'G70.0', department: 'dept.neurology', system: 'nerves', kind: 'disease', severity: 'critical', confirm: 'clinical',
      params: { mg: { known: 80, new: 20 }, cause: { infection: 60, none: 40 }, resp: { failure: 60, threat: 40 } },
    });
    expect(db.conditions[MG].arrival).toBeUndefined();
    expect(db.conditions[MG].redFlags).toEqual(['sym.choking_liquids', 'sym.dyspnea']);
    // ботулизм — «в первую очередь» в дифференциальном ряду (раздел 2.3); и криз — у ботулизма
    expect(db.conditions[MG].differential).toEqual([BOT, 'cond.stroke_ischemic']);
    expect(db.conditions[BOT].differential).toContain(MG);
    expect(verdictOf(db, BOT, ps[0])).toBe('wrong');
    // сотни кризов в год, как случаев ботулизма: полоса ниже — критический криз скорая привозит чаще
    expect(db.conditions[MG].weight).toBeLessThan(db.conditions[BOT].weight);
    expect(db.conditions[MG].weight).toBeGreaterThan(db.conditions[BOT].weight / 10);
  });

  test('трудно глотать — у каждого; миастения в анамнезе — у известной; одышка и слабый кашель — у каждого с дыхательной недостаточностью; зрачки не расширены', () => {
    for (const p of ps) {
      expect(has(p, 'sym.swallow_trouble')).toBe(true);
      expect(has(p, 'hx.myasthenia')).toBe(param(p, 'mg') === 'known');
      if (param(p, 'resp') === 'failure') for (const f of ['sym.dyspnea', 'sign.weak_cough']) expect(has(p, f)).toBe(true);
      if (param(p, 'cause') === 'none') expect(has(p, 'vital.fever')).toBe(false);
      for (const f of ['sign.mydriasis', 'hx.home_canned', 'sym.dry_mouth']) expect(has(p, f)).toBe(false);
    }
    for (const f of ['sym.diplopia', 'sign.ptosis', 'sign.nasal_speech', 'sym.fatigue_evening']) expect(share(ps, p => has(p, f))).toBeGreaterThan(0.6);
    expect(share(ps.filter(p => param(p, 'cause') === 'infection'), p => has(p, 'vital.fever'))).toBeGreaterThan(0.6);
    // у каждого пятого криз — первое проявление (раздел 1.3)
    const first = share(ps, p => param(p, 'mg') === 'new');
    expect(first).toBeGreaterThan(0.12);
    expect(first).toBeLessThan(0.28);
  });

  test('тактика: иммуноглобулин — каждому, при дыхательной недостаточности — ИВЛ или маска, при угрозе — можно; опасно — фторхинолоны, макролиды, бензодиазепины и опиоиды', () => {
    const failure = { mg: 'known', cause: 'infection', resp: 'failure' };
    const threat = { mg: 'new', cause: 'none', resp: 'threat' };
    expect([IVIG, VENT, CPAP].map(tx => txRole(db, MG, tx, failure))).toEqual(['require', 'require', 'require']);
    expect([IVIG, VENT, CPAP].map(tx => txRole(db, MG, tx, threat))).toEqual(['require', 'acceptable', 'acceptable']);
    for (const params of [failure, threat]) expect(HARMFUL.map(tx => txRole(db, MG, tx, params))).toEqual(HARMFUL.map(() => 'harmful'));
    // глюкокортикоид и зонд — можно; антибиотик широкого спектра — при инфекции
    expect(['tx.steroid_iv', 'tx.ng_tube'].map(tx => txRole(db, MG, tx, threat))).toEqual(['acceptable', 'acceptable']);
    expect([txRole(db, MG, 'tx.antibiotic_iv', failure), txRole(db, MG, 'tx.antibiotic_iv', threat)]).toEqual(['acceptable', 'notIndicated']);
    // иммуноглобулин — в «Прививках и сыворотках», лечит; сам криз не проходит
    expect(txGroupOfClass(db.treatments[IVIG].class)).toBe('vaccines');
    expect(curesOf(db, { id: MG, params: failure }, [IVIG]).map(e => e.p)).toEqual([9200]);
    expect(selfLimits(db, { id: MG, params: threat })).toBe(false);
  });

  test('место: с дыхательной недостаточностью — реанимация, при угрозе — ПИТ; перевод в центр с плазмообменом — не ошибка', () => {
    for (const p of ps.slice(0, 80)) {
      const failure = param(p, 'resp') === 'failure';
      expect(recommendedSetting(db, p)).toBe(failure ? 'ricu' : 'icu');
      expect(alsoSettings(db, p)).toEqual(failure ? ['transfer'] : ['ricu', 'transfer']);
    }
  });

  test('разбор: иммуноглобулин и ИВЛ в реанимации — без замечаний; без иммуноглобулина — неполно; с макролидом — опасно; домой — ошибка', () => {
    const p = patients(MG, 1, 58_510, { resp: 'failure' })[0];
    const rng = Rng.seeded(p.seed).fork('checked');
    const obs = [...complaintObservations(p), ...['exam.ask_chronic', 'exam.neuro_exam', 'exam.chest_exam'].flatMap(e => runExam(db, p, e, rng.fork(e)))];
    const ev = (x: Plan) => evaluatePlan(db, p, x, obs, VENUE);
    const grade = (x: Plan) => scoreCase({
      verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev(x),
      outcome: x.setting === 'home' ? { kind: 'worse', day: 1, cured: false } : { kind: 'recovered', day: 14, cured: true }, selfLimiting: false, redFlags: [],
    });
    expect(grade(plan([IVIG, VENT], 'ricu'))).toMatchObject({ treatment: 'A', setting: 'A', safety: 'A' });
    expect(grade(plan([IVIG, CPAP], 'ricu')).treatment).toBe('A');
    expect(ev(plan([VENT], 'ricu')).requireMissing).toEqual([IVIG]);
    expect(ev(plan([IVIG], 'ricu')).requireMissing).toEqual([VENT]);
    expect(ev(plan([IVIG, VENT, 'tx.macrolide'], 'ricu')).roles.find(r => r.tx === 'tx.macrolide')!.role).toBe('harmful');
    expect(grade(plan([IVIG], 'home')).setting).toBe('D');
  });
});

describe('обследования', () => {
  test('проба со льдом — у постели, каждому с опущенными веками; специфичность — в пределах 62,5–95 %', () => {
    expect(db.exams[ICE]).toMatchObject({ kind: 'physical', routineSeen: ['sign.ptosis'], cost: 0 });
    expect(db.exams[ICE].room).toBeUndefined();
    // в базе — сотые доли процента
    expect(db.exams[ICE].checks).toEqual([{ f: 'sign.ice_test_positive', sens: 9000, spec: 8000 }]);
    expect(examMinutes(db.exams[ICE])).toBeLessThanOrEqual(5);
  });

  test('миастения — в расспросе о хронических болезнях, слабость к вечеру — в общем расспросе, гнусавость — на неврологическом осмотре, кашель — на осмотре груди', () => {
    expect(db.exams['exam.ask_chronic'].checks.map(c => c.f)).toContain('hx.myasthenia');
    expect(db.exams['exam.ask_general'].checks.map(c => c.f)).toContain('sym.fatigue_evening');
    expect(db.exams['exam.neuro_exam'].checks.map(c => c.f)).toContain('sign.nasal_speech');
    expect(db.exams['exam.neuro_exam'].routineFor).toEqual(expect.arrayContaining(['sym.diplopia', 'sym.neck_weakness', 'sym.swallow_trouble']));
    expect(db.exams['exam.chest_exam'].checks.map(c => c.f)).toContain('sign.weak_cough');
  });
});

/** Разумный врач по шагам: в приёмном с ПИТ, реанимацией, КТ и МРТ. */
function doctor(p: Patient, venue: Venue = VENUE) {
  const exams = Object.keys(db.exams).sort();
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ED);
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, obs, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  const mg = patients(MG, 60, 58_300).map(p => ({ p, r: doctor(p) }));

  test('криз ставит почти у каждого: иммуноглобулин — каждому, ИВЛ — почти каждому с дыхательной недостаточностью, опасного — ничего', () => {
    expect(share(mg, x => x.r.diagnosis === MG)).toBeGreaterThan(0.9);
    const right = mg.filter(x => x.r.diagnosis === MG);
    for (const x of right) {
      expect(x.r.plan.treatments).toContain(IVIG);
      for (const tx of HARMFUL) expect(x.r.plan.treatments).not.toContain(tx);
      expect(['icu', 'ricu']).toContain(x.r.plan.setting);
    }
    const failure = right.filter(x => param(x.p, 'resp') === 'failure');
    expect(share(failure, x => x.r.plan.treatments.includes(VENT) || x.r.plan.treatments.includes(CPAP))).toBeGreaterThan(0.85);
    expect(share(failure, x => x.r.plan.setting === 'ricu')).toBeGreaterThan(0.85);
    // ботулизм исключает расспросом о консервах, миастению ищет в хронических болезнях
    expect(share(mg, x => x.r.done.includes('exam.ask_chronic'))).toBeGreaterThan(0.9);
    expect(share(mg, x => x.r.done.includes('exam.ask_food'))).toBeGreaterThan(0.6);
  });

  test('без своей реанимации — перевод того, кому нужна ИВЛ', () => {
    const noRicu: Venue = { ward: true, icu: true, rooms: ['room.ct', 'room.mri'] };
    const xs = patients(MG, 30, 58_400, { resp: 'failure' }).map(p => doctor(p, noRicu)).filter(r => r.diagnosis === MG);
    expect(share(xs, r => r.plan.setting === 'ambulance')).toBeGreaterThan(0.8);
  });

  test('ботулизм с криза не путает: широкие зрачки и консервы', () => {
    const bot = patients(BOT, 40, 58_600).map(p => doctor(p));
    expect(share(bot, r => r.diagnosis === BOT)).toBeGreaterThan(0.8);
    expect(share(bot, r => r.diagnosis === MG)).toBeLessThan(0.1);
  });
});

describe('энциклопедия', () => {
  test('тактика строками; новые записи — статьями', () => {
    const rows = (id: Id) => Object.fromEntries(article(db, id)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows(MG)).toMatchObject({ 'Обязательно': [IVIG], 'Опасно': HARMFUL, 'Можно также': ['tx.steroid_iv', 'tx.ng_tube'] });
    for (const id of [MG, IVIG, ICE, 'hx.myasthenia', 'sym.fatigue_evening', 'sign.nasal_speech', 'sign.weak_cough', 'sign.ice_test_positive']) expect(article(db, id)).toBeDefined();
  });
});
