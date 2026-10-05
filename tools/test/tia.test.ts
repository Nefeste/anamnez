// Транзиторная ишемическая атака и шкала ABCD2 (spec 2026-10-chapter-3, часть 41б): первая шкала с
// баллами у правил — у пункта свой вес, «не считается при», возраст пунктом, порог; производные
// параметры по баллам и по порогу; разбор — по тому, что показали обследования; антиагреганты по
// баллам, ПИТ; отпущенный домой без профилактики возвращается с инсультом по риску группы;
// разумный врач, смена, энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { observe } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { paramBeliefs } from '../../src/engine/med/infer';
import { asSeen, choiceFor, evaluatePlan, type Plan, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { checkRule, knownOf, pointsOf } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, departmentsOf, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { makeCaseView, outcomeText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const TIA = 'cond.tia';
const STROKE = 'cond.stroke_ischemic';
const RULE = 'rule.abcd2';
const ASA = 'tx.aspirin_acs';
const CLOP = 'tx.clopidogrel';
const WEAK = 'sym.transient_weakness';
const SPEECH = 'sym.transient_speech';
const BP = 'vital.bp_high';
const DIAB = 'hx.diabetes';
const SHORT = 'hx.tia_short';
const MID = 'hx.tia_mid';
const LONG = 'hx.tia_long';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const VENUE: Venue = { bedside: ['eq.monitor_defib'], icu: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const tia = (seed: number) => generatePatient(db, seed, { department: 'dept.neurology', departments: ED, season: 'winter', primary: TIA });
/** `n` больных ТИА подряд от зерна `from` — в её возрасте (с 40 лет). */
function people(n: number, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    const p = tia(seed);
    if (p.age >= db.conditions[TIA].age.min) out.push(p);
  }
  return out;
}
/** Первый больной ТИА от зерна `from`, для которого верно `ok`, — без аллергии на НПВС. */
function find(ok: (p: Patient) => boolean, from = 1): Patient {
  for (let seed = from; seed < from + 20_000; seed++) {
    const p = tia(seed);
    if (p.age >= 40 && !p.truth.risks.includes('risk.allergy_nsaid') && ok(p)) return p;
  }
  throw new Error('нет такого больного');
}
const seen = (f: Id, exam: Id, on = true): Observation => ({ f, shown: on, exam });
/** Всё, что меняет баллы, проверено: что было, сколько длилось, диабет, давление — как у пациента. */
function checked(p: Patient, override: Partial<Record<Id, boolean>> = {}): Observation[] {
  const on = (f: Id) => override[f] ?? has(p, f);
  return [
    ...complaintObservations(p),
    seen(WEAK, 'exam.ask_tia', on(WEAK)), seen(SPEECH, 'exam.ask_tia', on(SPEECH)),
    ...[SHORT, MID, LONG].map(f => seen(f, 'exam.ask_tia', on(f))),
    seen(DIAB, 'exam.ask_chronic', on(DIAB)), seen(BP, 'exam.vitals', on(BP)),
    seen('hx.allergy_nsaid', 'exam.ask_allergies', false),
  ];
}
const ICU = (treatments: Id[]): Plan => ({ treatments: [...treatments].sort(), setting: 'icu' });
const rule = () => db.rules[RULE];
const truthPoints = (p: Patient) => pointsOf(rule().points!, p.age, f => has(p, f)).min;

describe('каталог', () => {
  test('ТИА — неврология, серьёзная; приходят сами и привозит скорая; КТ — всем; ПИТ', () => {
    const c = db.conditions[TIA];
    expect(c).toMatchObject({ department: 'dept.neurology', severity: 'serious', confirm: ['exam.ct_head'], redFlags: [WEAK, SPEECH], stay: [1, 2], selfLimiting: true });
    expect(c.arrival).toBeUndefined();
    expect(c.treatment!.firstLine).toEqual([]);
    expect(c.treatment!.setting).toEqual({ default: 'icu' });
    expect(c.treatment!.notIndicated).toEqual(expect.arrayContaining(['tx.thrombolysis', 'tx.thrombolysis_stroke']));
    // производные: два антиагреганта — по выводу шкалы, высокий риск — с 6 баллов, умеренный — 4–5
    expect(c.derived).toEqual({ dapt: RULE, high: { rule: RULE, from: 6 }, moderate: { all: { dapt: ['yes'], high: ['no'] } } });
  });

  test('ABCD2 — шкала с баллами: пункты и веса по 814_1 (приложение Г17), порог — больше 3', () => {
    const r = rule();
    expect(r.any).toEqual([]);
    expect(r.points).toEqual({
      items: [
        { f: BP, w: 1 }, { f: WEAK, w: 2 }, { f: SPEECH, w: 1, unless: [WEAK] },
        { f: LONG, w: 2 }, { f: MID, w: 1 }, { f: DIAB, w: 1 },
      ],
      age: [{ from: 60, w: 1 }],
      from: 4,
    });
    expect(r).toMatchObject({ complaints: [WEAK, SPEECH], decides: CLOP, about: [TIA], exams: [] });
  });

  test('расспрос «что было и сколько длилось» — каждому с прошедшей слабостью или речью; длительность — без ошибки', () => {
    const e = db.exams['exam.ask_tia'];
    expect(e).toMatchObject({ kind: 'ask', cost: 0, complaints: [WEAK, SPEECH], routineFor: [WEAK, SPEECH] });
    for (const f of [SHORT, MID, LONG]) expect(e.checks.find(k => k.f === f)).toEqual({ f, sens: 10000, spec: 10000 });
    // строки «нет» у длительности нет: показывают одну, ту, что была
    for (const f of [SHORT, MID, LONG]) expect(db.findings[f].texts.absent ?? []).toEqual([]);
  });

  test('антиагрегант после ТИА снижает риск инсульта на 30 % (игровая оценка: раздел 5.1 — на 20–30 %)', () => {
    for (const tx of [ASA, CLOP]) expect(db.treatments[tx].effects.filter(e => e.on === TIA).map(e => e.p)).toEqual([3000]);
  });

  test('осмотр за 10 минут и КТ за 40 — и при прошедших слабости и речи: всем с подозрением на ОНМК (814_1, разделы 2.2 и 2.4)', () => {
    for (const id of ['target.stroke_exam', 'target.stroke_ct']) expect(db.targets[id].complaints).toEqual(expect.arrayContaining([WEAK, SPEECH]));
    expect(db.targets['target.stroke_swallow'].complaints).not.toContain(WEAK);
  });
});

describe('баллы правила', () => {
  const at = (age: number, on: Id[], off: Id[] = []) => {
    const yes = new Set(on);
    const no = new Set(off);
    return checkRule(rule(), age, f => (yes.has(f) ? true : no.has(f) ? false : undefined));
  };
  const ALL = [BP, WEAK, SPEECH, LONG, MID, SHORT, DIAB];
  const known = (age: number, on: Id[]) => at(age, on, ALL.filter(f => !on.includes(f)));

  test('всё известно — сумма: 7 у старшего с давлением, слабостью, часом и диабетом; 1 — у молодого с короткой речью', () => {
    expect(known(65, [BP, WEAK, LONG, DIAB])).toMatchObject({ verdict: 'yes', points: { min: 7, max: 7 }, left: [] });
    expect(known(50, [SPEECH, SHORT])).toMatchObject({ verdict: 'no', points: { min: 1, max: 1 } });
    // возраст — пунктом: с 60 лет
    expect([known(59, [WEAK, MID]).points, known(60, [WEAK, MID]).points]).toEqual([{ min: 3, max: 3 }, { min: 4, max: 4 }]);
  });

  test('«не считается при»: речь вместе со слабостью — 2 балла, а не 3', () => {
    expect(known(50, [WEAK, SPEECH]).points).toEqual({ min: 2, max: 2 });
    expect(known(50, [SPEECH]).points).toEqual({ min: 1, max: 1 });
  });

  test('не проверено — «пока неизвестно» и что проверить; набрано наверняка или не дотянуть — вывод сразу', () => {
    // слабость (2) и час (2) — уже 4: давление и диабет вывода не изменят
    expect(at(50, [WEAK, LONG], [SPEECH, MID, SHORT])).toMatchObject({ verdict: 'yes', left: [] });
    // слабость и 10–59 минут — 3: давление или диабет решат
    const x = at(50, [WEAK, MID], [SPEECH, LONG, SHORT]);
    expect(x.verdict).toBe('unknown');
    expect([...x.left].sort()).toEqual([BP, DIAB].sort());
    expect(x.points).toEqual({ min: 3, max: 5 });
    // речь без слабости и пара минут, 50 лет — даже давление с диабетом дадут 3: «нет»
    expect(at(50, [SPEECH, SHORT], [WEAK, MID, LONG])).toMatchObject({ verdict: 'no', left: [] });
  });

  test('свой порог: высокий риск — с 6 баллов', () => {
    const all = (age: number, on: Id[]) => checkRule(rule(), age, f => on.includes(f), 6).verdict;
    expect([all(65, [BP, WEAK, LONG]), all(65, [WEAK, LONG]), all(65, [BP, WEAK, MID, DIAB])]).toEqual(['yes', 'no', 'yes']);
  });
});

describe('больные и параметры', () => {
  const xs = people(3000);

  test('жалоба — то, что было: у каждого; сторона слабости — одна; длительность — одна из трёх; на осмотре дефицита нет', () => {
    for (const p of xs) {
      const x = paramsOf(p);
      expect([has(p, WEAK), has(p, SPEECH)]).toEqual([x.episode.startsWith('weakness'), x.episode.endsWith('speech')]);
      expect([SHORT, MID, LONG].filter(f => has(p, f))).toEqual([{ short: SHORT, mid: MID, long: LONG }[x.duration]!]);
      for (const f of ['sign.hemiparesis', 'sign.speech_deficit', 'sign.facial_weakness', 'sign.nihss']) expect(has(p, f)).toBe(false);
      const w = p.truth.findings.find(f => f.f === WEAK);
      if (w) expect(w.attrs).toEqual({ side: x.side });
      expect(p.complaints.some(f => f === WEAK || f === SPEECH)).toBe(true);
    }
  });

  test('производные — по баллам настоящих признаков: два антиагреганта с 4, высокий риск с 6, умеренный — 4–5', () => {
    for (const p of xs) {
      const n = truthPoints(p);
      expect(paramsOf(p)).toMatchObject({ dapt: n >= 4 ? 'yes' : 'no', high: n >= 6 ? 'yes' : 'no', moderate: n >= 4 && n < 6 ? 'yes' : 'no' });
    }
    // группы у пациентов игры — около 22/62/15 % (игровая оценка; у Johnston 2007 — 34/45/21 %), а
    // доли производных в записи — те, что выходят у генератора (±4 п. п.)
    const dist = db.conditions[TIA].params!;
    for (const name of ['dapt', 'high', 'moderate']) {
      const got = xs.filter(p => paramsOf(p)[name] === 'yes').length / xs.length;
      expect({ name, off: Math.abs(got - dist[name].yes / (dist[name].yes + dist[name].no)) < 0.04 }).toEqual({ name, off: true });
    }
  });

  test('вывод о параметре — по правилу на известном: пока не спросили — доли записи; проверено — уверенно', () => {
    const p = find(x => paramsOf(x).dapt === 'yes');
    const before = paramBeliefs(db, TIA, 'dapt', complaintObservations(p), p.age);
    expect(before.find(b => b.value === 'yes')!.p).toBeCloseTo(0.78, 2);
    expect(paramBeliefs(db, TIA, 'dapt', checked(p), p.age)).toEqual([{ value: 'yes', p: 1 }, { value: 'no', p: 0 }]);
  });
});

describe('тактика и разбор', () => {
  test('до 3 баллов — один антиагрегант, больше 3 — оба; тромболизиса нет; ПИТ, без своей ПИТ — скорая', () => {
    const low = find(x => paramsOf(x).dapt === 'no');
    const high = find(x => paramsOf(x).dapt === 'yes');
    const ev = (p: Patient, tx: Id[]) => evaluatePlan(db, p, ICU(tx), checked(p), VENUE);
    expect(ev(low, [ASA]).requireMissing).toEqual([]);
    expect(ev(low, [CLOP]).requireMissing).toEqual([]);
    expect(ev(low, []).requireMissing).toEqual([ASA]);
    expect(ev(high, [ASA]).requireMissing).toEqual([CLOP]);
    expect(ev(high, [ASA, CLOP]).requireMissing).toEqual([]);
    expect(ev(high, [ASA, CLOP]).setting.recommended).toBe('icu');
    expect([choiceFor('icu', VENUE), choiceFor('icu', {})]).toEqual(['icu', 'ambulance']);
    expect(ev(high, [ASA, CLOP, 'tx.thrombolysis_stroke']).roles.find(r => r.tx === 'tx.thrombolysis_stroke')!.role).toBe('notIndicated');
  });

  test('шкалу считают по тому, что показали обследования: тонометр показал норму — 3 балла, хватает одного; не мерили — по правде', () => {
    // 4 балла по правде: 60 лет и старше, давление, речь без слабости, 10–59 минут; давление — решающее
    const p = find(x => x.age >= 60 && has(x, BP) && has(x, SPEECH) && !has(x, WEAK) && has(x, MID) && !has(x, DIAB));
    expect(paramsOf(p).dapt).toBe('yes');
    const normal = checked(p, { [BP]: false });
    expect(asSeen(db, p, normal)).toMatchObject({ dapt: 'no', high: 'no', moderate: 'no' });
    expect(evaluatePlan(db, p, ICU([ASA]), normal, VENUE).requireMissing).toEqual([]);
    // давление не мерили — вывода нет, и разбор судит по правде
    const unmeasured = normal.filter(o => o.f !== BP);
    expect(checkRule(rule(), p.age, knownOf(unmeasured)).verdict).toBe('unknown');
    expect(asSeen(db, p, unmeasured).dapt).toBe('yes');
    expect(evaluatePlan(db, p, ICU([ASA]), unmeasured, VENUE).requireMissing).toEqual([CLOP]);
  });

  test('отпущенный домой без профилактики — инсульт за неделю по группе ABCD2: 1,2, 5,9 и 12 %; с антиагрегантом реже', () => {
    const groups = [
      [find(x => paramsOf(x).dapt === 'no'), 120],
      [find(x => paramsOf(x).moderate === 'yes'), 590],
      [find(x => paramsOf(x).high === 'yes'), 1200],
    ] as const;
    for (const [p, want] of groups) {
      const u = untreatedOf(db, p.truth.conditions[0])!;
      expect({ p: u.p, as: u.as, days: u.days }).toEqual({ p: want, as: STROKE, days: [1, 7] });
    }
    // доля по многим исходам: у высокого риска без лечения — около 12 %, с двумя антиагрегантами — меньше
    const p = groups[2][0];
    const rate = (tx: Id[]) => {
      const plan: Plan = { treatments: tx, setting: 'home' };
      const ev = evaluatePlan(db, p, plan, checked(p), VENUE);
      let n = 0;
      for (let i = 0; i < 4000; i++) {
        const o = observe(db, p, plan, ev, Rng.seeded(i).fork('outcome'));
        if (o.kind === 'worse') {
          expect(o.returns).toMatchObject({ reason: 'worse', as: STROKE });
          expect(o.day).toBeGreaterThanOrEqual(1);
          n++;
        }
      }
      return n / 4000;
    };
    const none = rate([]);
    const dual = rate([ASA, CLOP]);
    expect(Math.abs(none - 0.12)).toBeLessThan(0.015);
    expect(dual).toBeLessThan(none - 0.02);
  });

  test('исход «хуже» с другой болезнью — словами: «на 3-й день — ишемический инсульт: человека привезёт скорая»', () => {
    const text = outcomeText({ kind: 'worse', day: 3, returns: { day: 3, reason: 'worse', as: STROKE }, cured: false }, 'home', false);
    expect(text).toBe('На 3-й день — ишемический инсульт: человека привезёт скорая');
  });
});

describe('карта', () => {
  test('строка шкалы: сколько баллов и за что; меньше порога — с числом баллов', () => {
    const view = (p: Patient, obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [],
      draft: { treatments: [], setting: 'icu' }, arrived: [{ exam: 'exam.ask_tia', step: 1, at: 600, obs }], departments: ED, difficulty: 'student',
    });
    const hi = find(x => x.age >= 60 && has(x, WEAK) && has(x, LONG));
    const line = view(hi, checked(hi)).rules.find(r => r.id === RULE)!;
    expect(line.text).toMatch(/^Риск инсульта выше — нужны два антиагреганта, ацетилсалициловая кислота и клопидогрел: \d балл/);
    expect(line.text).toContain('возраст 60 лет и старше');
    const lo = find(x => x.age < 60 && has(x, SPEECH) && !has(x, WEAK) && has(x, SHORT) && !has(x, DIAB));
    expect(view(lo, checked(lo)).rules.find(r => r.id === RULE)!.text).toMatch(/^\d балл(а|ов)?: риск инсульта низкий — хватит одного антиагреганта$/);
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
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }
  const runs = people(150, 8_000_001).map(p => ({ p, r: run(p, VENUE) }));

  test('диагноз верный; расспрос и осмотр — у каждого, КТ — почти у каждого; ПИТ', () => {
    expect(runs.filter(x => x.r.diagnosis === TIA).length / runs.length).toBeGreaterThan(0.97);
    for (const { r } of runs) {
      expect(r.done).toContain('exam.ask_tia');
      expect(r.done).toContain('exam.neuro_exam');
      expect(r.plan.setting).toBe('icu');
    }
    expect(runs.filter(x => x.r.done.includes('exam.ct_head')).length / runs.length).toBeGreaterThan(0.95);
  });

  test('антиагреганты — по баллам, как их показали обследования: разбор без «не назначено»', () => {
    let dual = 0;
    for (const { p, r } of runs.filter(x => x.r.diagnosis === TIA)) {
      const ev = evaluatePlan(db, p, r.plan, r.obs, VENUE);
      expect({ seed: p.seed, missing: ev.requireMissing }).toEqual({ seed: p.seed, missing: [] });
      if (r.plan.treatments.includes(ASA) && r.plan.treatments.includes(CLOP)) dual++;
    }
    expect(dual).toBeGreaterThan(80);
  });
});

/** Больница с приёмным, КТ и ПИТ (как в тестах инсульта) или без КТ. */
function hospital(ct = true): ShiftState {
  const s = newSandbox(db, { seed: 25, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  s.economy!.cash = 8_000_000;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size: 'M', x: 29, y: 1, rot: 0 } });
  const er = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: er, equipment: 'eq.monitor_defib' } });
  if (ct) {
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ct', size: 'M', x: 29, y: 10, rot: 2 } });
    const room = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    apply(db, s, { kind: 'build', cmd: { kind: 'buy', room, equipment: 'eq.ct_16' } });
  }
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: er });
  if (ct) {
    const room = s.hospital!.rooms.find(r => r.type === 'room.ct')!.id;
    for (const role of ['role.radiographer', 'role.radiologist']) {
      const c = s.candidates!.find(x => x.role === role && !s.staff!.some(m => m.id === x.id))!;
      apply(db, s, { kind: 'hire', id: c.id });
      apply(db, s, { kind: 'assign', id: c.id, room });
    }
  }
  apply(db, s, { kind: 'nextDay' });
  return s;
}

describe('смена: возврат с инсультом', () => {
  /** Вчерашний отпущенный домой больной ТИА, которому завтра стало хуже. */
  function returned(s: ShiftState) {
    const prev = Object.values(s.patients)[0];
    prev.patient = find(x => paramsOf(x).high === 'yes');
    s.returns.push({ day: s.day + 1, of: prev.id, reason: 'worse', as: STROKE });
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
    return { prev, back: Object.values(s.patients).find(p => p.returnOf === prev.id) };
  }

  test('после ТИА без профилактики — тот же человек с инсультом, его привозит скорая', () => {
    const s = hospital();
    expect(departmentsOf(db, s)).toContain('dept.neurology');
    const { prev, back } = returned(s);
    expect(back).toBeDefined();
    expect(back!.kind).toBe('ambulance');
    expect(back!.patient.truth.conditions[0].id).toBe(STROKE);
    expect([back!.patient.sex, back!.patient.age]).toEqual([prev.patient.sex, prev.patient.age]);
    expect(back!.returnReason).toBe('worse');
  });

  test('больница без кабинета КТ инсульт не принимает — человека увезли в другую', () => {
    const s = hospital(false);
    expect(departmentsOf(db, s)).not.toContain('dept.neurology');
    expect(returned(s).back).toBeUndefined();
  });
});

describe('энциклопедия', () => {
  test('шкала: баллы пунктов, что значит сумма; ТИА: риск инсульта по группам долями, ПИТ', () => {
    const r = article(db, RULE)!;
    const points = r.blocks.find(b => b.key === 'points')!;
    // возраст — строкой, пункты-признаки — ссылками с баллами: названия не повторяются дважды
    expect(points.text).toEqual(['Возраст 60\u00a0лет и старше — 1\u00a0балл']);
    expect(points.refs!.map(x => `${x.title} · ${x.note}`)).toEqual([
      'Давление 140/90 и выше · 1\u00a0балл', 'Прошедшая слабость в руке и ноге · 2\u00a0балла',
      'Прошедшее нарушение речи · 1\u00a0балл, если нет пункта «Прошедшая слабость в руке и ноге»',
      'Длилось час и дольше · 2\u00a0балла', 'Длилось от 10 до 59 минут · 1\u00a0балл', 'Известный сахарный диабет · 1\u00a0балл',
    ]);
    expect(r.blocks.find(b => b.key === 'pointsYes')!.title).toBe('Если баллов 4 и больше');
    expect(r.blocks.find(b => b.key === 'none')!.title).toBe('Если меньше 4');
    const c = article(db, TIA)!;
    // факторы риска: «в 5 раз», а не «в 5 раза»; при дробном — «в 1,5 раза»
    const risks = c.blocks.flatMap(b => b.rows ?? []).find(x => x.label === 'Факторы риска')!.refs.map(x => x.note);
    expect(risks).toEqual(expect.arrayContaining(['в 5\u00a0раз чаще', 'в 2\u00a0раза чаще', 'в 1,5\u00a0раза чаще']));
    const course = c.blocks.find(b => b.key === 'course')!.text!;
    expect(course).toEqual(expect.arrayContaining([
      'При ABCD2 до 3 баллов без действенного лечения на 1–7-й день — ишемический инсульт у 1,2\u00a0%.',
      'При ABCD2 4–5 баллов без действенного лечения на 1–7-й день — ишемический инсульт у 5,9\u00a0%.',
      'При ABCD2 6 баллов и больше без действенного лечения на 1–7-й день — ишемический инсульт у 12\u00a0%.',
    ]));
  });
});
