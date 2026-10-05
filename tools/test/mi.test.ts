// Инфаркт с подъёмом ST (spec 2026-10-chapter-3, часть 39а): часы от начала боли и окно 12 часов,
// стенка инфаркта, тромболизис только лежащему под монитором с дефибриллятором, правило «Можно ли
// тромболизис», «обязательно до перевода» и спутники тромболизиса; давление при анафилактическом
// шоке — признак, которого при болезни не бывает (`masks`).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { ContentDb, Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, onsetValue } from '../../src/engine/med/generate';
import { contextOf, expectedGain, findingProbability, posterior } from '../../src/engine/med/infer';
import { evaluatePlan, type Plan, txAvailable, txRole, type Venue } from '../../src/engine/med/plan';
import { choosePlan, type DoctorPhase, nextStep } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import { scoreCase } from '../../src/engine/med/score';
import { observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, bedsideEquipment, candidatesOf, current, newCampaign } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { makeCaseView, noteText, treatmentGroupsFor } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const ACS = 'cond.acs';
const ANA = 'cond.anaphylaxis';
const LYSIS = 'tx.thrombolysis';
const MONITOR = 'eq.monitor_defib';
const ONSET = 'hx.onset_hours';
const CHEST = 'sym.chest_pain_pressing';
const RULE = 'rule.lysis_mi';
const CONTRA = ['hx.anticoagulants', 'hx.bleeding_tendency', 'hx.recent_bleed_surgery', 'hx.stroke_history'];
const RISKS = ['risk.anticoagulants', 'risk.bleeding_tendency', 'risk.recent_bleed_surgery', 'risk.stroke_history'];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const BAY: Venue = { bedside: [MONITOR] };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const acs = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: ACS, params });
/** Инфаркт с подъёмом ST: в окне или позже, с давящей болью в груди и без противопоказаний к тромболизису. */
function stemi(early: boolean, from = 1): Patient {
  for (let seed = from; seed < from + 2000; seed++) {
    const p = acs(seed, { type: 'stemi' });
    if ((paramsOf(p).early === 'yes') === early && p.complaints.includes(CHEST) && !RISKS.some(r => p.truth.risks.includes(r))) return p;
  }
  throw new Error('нет такого больного');
}
const shown = (f: Id, exam: Id, on = true): Observation => ({ f, shown: on, exam });
const scoreOf = (p: Patient, plan: Plan, venue: Venue, obs: Observation[] = []) => {
  const ev = evaluatePlan(db, p, plan, obs, venue);
  return { ev, score: scoreCase({ verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev, outcome: { kind: 'improved', day: 1, cured: true }, selfLimiting: false, redFlags: [] }) };
};
const FULL = ['tx.aspirin_acs', 'tx.clopidogrel', 'tx.enoxaparin_acs', 'tx.nitroglycerin'];

describe('чего при болезни не бывает', () => {
  test('анафилактический шок гасит высокое давление — и у гипертоника; вывод — ноль, откуда бы оно ни шло', () => {
    const xs = Array.from({ length: 3000 }, (_, i) => generatePatient(db, i + 1, { department: 'dept.therapy', season: 'summer', primary: ANA }));
    expect(xs.filter(p => p.truth.findings.some(f => f.f === 'vital.bp_high')).length).toBe(0);
    // гипертоники среди них есть: давление гасит шок, а не случай
    expect(xs.filter(p => p.truth.conditions.some(c => c.id === 'cond.hypertension')).length).toBeGreaterThan(100);
    expect(findingProbability(db, 'vital.bp_high', [ANA, 'cond.hypertension'], [])).toBe(0);
    expect(findingProbability(db, 'vital.bp_high', ['cond.hypertension'], [])).toBeGreaterThan(0.3);
  });
});

describe('часы от начала боли', () => {
  test('у каждого с ОКС — целые часы от 1 до 47 по долям записи; окно — меньше 12 часов', () => {
    const xs = Array.from({ length: 3000 }, (_, i) => acs(i + 1));
    const hours = xs.map(p => p.truth.values[ONSET]);
    expect(hours.every(h => Number.isInteger(h) && h >= 1 && h <= 47)).toBe(true);
    for (const p of xs) expect(paramsOf(p).early).toBe(p.truth.values[ONSET] < 12 ? 'yes' : 'no');
    // доли интервалов записи (±3 п. п.): до 2 ч — 30, 2–6 — 35, 6–12 — 20, 12–24 — 10, 24–48 — 5
    const share = (lo: number, hi: number) => hours.filter(h => h >= lo && h < hi).length / hours.length;
    const want = [[0, 2, 0.3], [2, 6, 0.35], [6, 12, 0.2], [12, 24, 0.1], [24, 48, 0.05]] as const;
    for (const [lo, hi, p] of want) expect(Math.abs(share(lo, hi) - p)).toBeLessThan(0.03);
    // доля «в окне» у вывода — та, что выходит у генератора
    const dist = db.conditions[ACS].params!.early;
    expect(Math.abs(share(0, 12) - dist.yes / (dist.yes + dist.no))).toBeLessThan(0.03);
  });

  test('onsetValue: интервал по долям, в нём — целые часы; в первом — от часа, «0 ч» не бывает', () => {
    const o = { f: ONSET, hours: [[2, 1], [6, 1]] as [number, number][] };
    const xs = Array.from({ length: 400 }, (_, i) => onsetValue(o, Rng.seeded(i).fork('onset')));
    expect([...new Set(xs)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test('часы не сдвигают случайность: без них пациент тот же — кроме самих часов и окна', () => {
    const plain: ContentDb = { ...db, conditions: { ...db.conditions, [ACS]: { ...db.conditions[ACS], onset: undefined } } };
    for (let seed = 1; seed <= 40; seed++) {
      const a = acs(seed);
      const b = generatePatient(plain, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: ACS });
      const strip = (p: Patient) => ({ ...p.truth, values: { ...p.truth.values, [ONSET]: 0 }, conditions: p.truth.conditions.map(c => ({ ...c, params: { ...c.params, early: '' } })) });
      expect(strip(a)).toEqual(strip(b));
    }
  });

  test('расспрос о боли в груди и о начале болезни: «Плохо стало около N ч назад» — без ошибки', () => {
    const p = stemi(true);
    for (const exam of ['exam.ask_chest_pain', 'exam.ask_onset']) {
      const obs = runExam(db, p, exam, Rng.seeded(1).fork('ask')).find(o => o.f === ONSET)!;
      expect(obs.value).toBe(p.truth.values[ONSET]);
      expect(observationText(db, obs, p.sex, p.seed)).toBe(`Плохо стало около ${p.truth.values[ONSET]} ч назад`);
    }
  });

  test('«когда стало плохо» знает всякий, кому плохо остро, — не только больной ОКС: строка инфаркт не выдаёт', () => {
    const leaders = db.findings[ONSET].follows!;
    expect(leaders).toEqual(expect.arrayContaining(['sym.chest_pain_pressing', 'sym.pleuritic_pain', 'sym.dyspnea']));
    let others = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter' });
      const has = p.truth.findings.some(f => f.f === ONSET);
      const acute = p.truth.findings.some(f => leaders.includes(f.f));
      const isAcs = p.truth.conditions.some(c => c.id === ACS);
      expect({ seed, has }).toEqual({ seed, has: acute || isAcs });
      if (has && !isAcs) others++;
      // число — в часах от 1, «0 ч» не бывает
      if (has) expect(p.truth.values[ONSET]).toBeGreaterThanOrEqual(1);
    }
    // у кого есть строка, больных ОКС — меньшинство
    expect(others).toBeGreaterThan(300);
  });

  test('не улика: вывод одинаков со строкой и без, а обследование ради неё ничего не даёт', () => {
    const p = stemi(true);
    const base = complaintObservations(p);
    const ctx = contextOf(db, p, base);
    const cands = candidatesOf(db, ED);
    const onset = { f: ONSET, shown: true, value: 3, exam: 'exam.ask_onset' };
    expect(posterior(db, cands, [...base, onset], ctx)).toEqual(posterior(db, cands, base, ctx));
    // и «нет» не обнуляет вывод: у пациента без острых жалоб строки нет — это тоже не улика
    expect(posterior(db, cands, [...base, { ...onset, shown: false, value: 0 }], ctx)).toEqual(posterior(db, cands, base, ctx));
    const only = { ...db, exams: { ...db.exams, x: { ...db.exams['exam.ask_onset'], id: 'x', checks: [{ f: ONSET, sens: 10_000, spec: 10_000 }] } } };
    expect(expectedGain(only, 'x', posterior(db, cands, base, ctx), ctx, new Set())).toBe(0);
  });
});

describe('стенка инфаркта', () => {
  test('стенка — по долям записи (±4 п. п.), подъём ST несёт её в атрибуте', () => {
    const xs = Array.from({ length: 2000 }, (_, i) => acs(i + 1, { type: 'stemi' }));
    const count: Record<string, number> = {};
    for (const p of xs) {
      const wall = paramsOf(p).wall;
      count[wall] = (count[wall] ?? 0) + 1;
      expect(p.truth.findings.find(f => f.f === 'ecg.st_elevation')!.attrs).toEqual({ wall });
    }
    const dist = db.conditions[ACS].params!.wall;
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    for (const [wall, w] of Object.entries(dist)) expect(Math.abs(count[wall] / xs.length - w / total)).toBeLessThan(0.04);
  });
});

describe('правило «Можно ли тромболизис»', () => {
  test('пока ЭКГ нет — проверить подъём ST, пункты ждут; подъёма нет — «не нужен»; есть — ждёт ответов', () => {
    const rule = db.rules[RULE];
    const before = checkRule(rule, 60, knownOf([]));
    expect([before.verdict, before.left]).toEqual(['unknown', ['ecg.st_elevation']]);
    const none = checkRule(rule, 60, knownOf([shown('ecg.st_elevation', 'exam.ecg', false)]));
    expect([none.verdict, none.left]).toEqual(['no', []]);
    const st = checkRule(rule, 60, knownOf([shown('ecg.st_elevation', 'exam.ecg')]));
    expect([st.verdict, [...st.left].sort()]).toEqual(['unknown', CONTRA]);
  });

  test('на все вопросы «нет» — тромболизис можно; хоть одно «да» — нельзя', () => {
    const rule = db.rules[RULE];
    const st = shown('ecg.st_elevation', 'exam.ecg');
    const answers = (yes?: Id) => CONTRA.map(f => shown(f, 'exam.ask_lysis', f === yes));
    expect(checkRule(rule, 60, knownOf([st, ...answers()])).verdict).toBe('no');
    for (const f of CONTRA) expect(checkRule(rule, 60, knownOf([st, ...answers(f)])).verdict).toBe('yes');
    expect(rule.decides).toBe(LYSIS);
  });

  test('о противопоказаниях спрашивают каждого: подъём ST бывает и без давящей боли', () => {
    expect(db.exams['exam.ask_lysis'].complaints).toBeUndefined();
    for (const f of CONTRA) expect(db.revealedBy[f]).toContain('exam.ask_lysis');
  });
});

describe('тромболизис у постели', () => {
  test('только под монитором с дефибриллятором — и при инсульте (часть 41а), снижение давления в вену (часть 41в), кардиоверсия и амиодарон (часть 42а), трифосаденин, верапамил и прокаинамид в вену (часть 42б), атропин, допамин и наружная стимуляция (часть 42в), морфин, бета-адреноблокатор и нитроглицерин в вену (часть 43а); остальное лечение — где угодно', () => {
    expect(txAvailable(db, LYSIS)).toBe(false);
    expect(txAvailable(db, LYSIS, BAY)).toBe(true);
    expect(txAvailable(db, LYSIS, { bedside: ['eq.ecg'] })).toBe(false);
    expect(Object.values(db.treatments).filter(t => !txAvailable(db, t.id)).map(t => t.id).sort()).toEqual(['tx.amiodarone_iv', 'tx.atropine', 'tx.beta_blocker_iv', 'tx.bp_iv', 'tx.cardioversion', 'tx.dopamine', 'tx.morphine_iv', 'tx.nitroglycerin_iv', 'tx.pacing_tc', 'tx.procainamide', LYSIS, 'tx.thrombolysis_stroke', 'tx.trifosadenine', 'tx.verapamil_iv'].sort());
  });

  test('в карте: без монитора у постели кнопка серая и сказано почему; под монитором — обычная', () => {
    const p = stemi(true);
    const view = (bedsideEquipment?: Id[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [],
      draft: { treatments: [], setting: 'transfer' }, ...(bedsideEquipment ? { bedsideEquipment } : {}),
    }).treatments.find(x => x.id === LYSIS)!;
    expect(view()).toEqual({ id: LYSIS, name: 'Тромболизис при инфаркте', warning: 'У постели нет монитора с дефибриллятором', disabled: true });
    expect(view([MONITOR])).toEqual({ id: LYSIS, name: 'Тромболизис при инфаркте', warning: undefined });
    // на обходе — по аппаратам у койки: в палате монитора нет, в ПИТ — есть
    const at = (bed: Id[]) => treatmentGroupsFor([], bed).flatMap(g => g.items).find(x => x.id === LYSIS)!.disabled;
    expect([at([]), at([MONITOR])]).toEqual([true, undefined]);
    // в группе «Сердце и сосуды» — вместе с клопидогрелом и антикоагулянтами
    const heart = treatmentGroupsFor([], [MONITOR]).find(g => g.key === 'heart')!.items.map(x => x.id);
    for (const tx of [LYSIS, 'tx.clopidogrel', 'tx.enoxaparin_acs']) expect(heart).toContain(tx);
  });

  test('тактика: в окне — обязательно до перевода; через 12 часов — не нужен; без подъёма ST — вреден', () => {
    expect(txRole(db, ACS, LYSIS, { type: 'stemi', early: 'yes' })).toBe('beforeTransfer');
    expect(txRole(db, ACS, LYSIS, { type: 'stemi', early: 'no' })).toBe('notIndicated');
    expect(txRole(db, ACS, LYSIS, { type: 'nste', early: 'yes' })).toBe('harmful');
  });

  test('под монитором без тромболизиса — лечение C, безопасность C и строка разбора; в кабинете — без замечания', () => {
    const p = stemi(true);
    const plan = { treatments: FULL, setting: 'transfer' as Setting };
    const bay = scoreOf(p, plan, BAY);
    expect(bay.ev.beforeTransferMissing).toEqual([LYSIS]);
    const note = bay.score.notes.find(n => n.code === 'tx.beforeTransferMissing')!;
    expect(note).toEqual({ code: 'tx.beforeTransferMissing', tx: LYSIS, when: { type: ['stemi'], early: ['yes'] } });
    expect(noteText(note)).toBe('Не сделано до перевода: тромболизис при инфаркте — обязательно при инфаркте с подъёмом ST и в первые 12 часов от начала симптомов');
    expect([bay.score.treatment, bay.score.safety]).toEqual(['C', 'C']);
    // в кабинете тромболизиса нет — и спроса за него нет
    expect(scoreOf(p, plan, {}).ev.beforeTransferMissing).toEqual([]);
    // с тромболизисом и его спутниками — без замечаний о нём
    const done = scoreOf(p, { treatments: [...FULL, LYSIS].sort(), setting: 'transfer' }, BAY);
    expect([done.ev.beforeTransferMissing, done.ev.companionsMissing]).toEqual([[], []]);
    expect(done.ev.roles).toContainEqual({ tx: LYSIS, role: 'beforeTransfer' });
  });

  test('противопоказание известно — тромболизиса не ждут; через 12 часов и без подъёма ST — тоже', () => {
    const p = stemi(true);
    const plan = { treatments: FULL, setting: 'transfer' as Setting };
    expect(scoreOf(p, plan, BAY, [shown('hx.stroke_history', 'exam.ask_lysis')]).ev.beforeTransferMissing).toEqual([]);
    expect(scoreOf(stemi(false), plan, BAY).ev.beforeTransferMissing).toEqual([]);
    const nste = acs(3, { type: 'nste' });
    expect(scoreOf(nste, plan, BAY).ev.beforeTransferMissing).toEqual([]);
    // без подъёма ST тромболизис вреден (154_4)
    expect(scoreOf(nste, { treatments: [...FULL, LYSIS].sort(), setting: 'transfer' }, BAY).score.notes).toContainEqual({ code: 'tx.harmful', tx: LYSIS });
  });

  test('спутники: без клопидогрела и антикоагулянта — неполное лечение; из группы хватит одного', () => {
    const p = stemi(true);
    const bare = scoreOf(p, { treatments: ['tx.aspirin_acs', LYSIS], setting: 'transfer' }, BAY);
    expect(bare.ev.companionsMissing).toEqual([{ tx: 'tx.clopidogrel', of: LYSIS }, { tx: 'tx.enoxaparin_acs', of: LYSIS }]);
    const note = bare.score.notes.find(n => n.code === 'tx.companionMissing')!;
    expect(noteText(note)).toBe('Тромболизис при инфаркте без обязательного спутника — не назначено: клопидогрел');
    expect(bare.score.treatment).toBe('C');
    const fonda = scoreOf(p, { treatments: ['tx.aspirin_acs', 'tx.clopidogrel', 'tx.fondaparinux', LYSIS], setting: 'transfer' }, BAY);
    expect(fonda.ev.companionsMissing).toEqual([]);
  });
});

describe('разумный врач', () => {
  /** Шаги разумного врача до решения; `venue` — что есть у постели. */
  function run(p: Patient, venue: Venue) {
    const obs: Observation[] = complaintObservations(p);
    const done: Id[] = [];
    let phase: DoctorPhase = {};
    const rng = Rng.seeded(p.seed).fork('doctor');
    for (let k = 0; k < 40; k++) {
      const r = nextStep(db, p, obs, done, phase, { candidates: candidatesOf(db, ED), exams: Object.keys(db.exams).sort(), threshold: 0.9, minGain: 0.02, venue });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }

  test('под монитором: ЭКГ первым делом, вопросы перед тромболизисом, тромболизис со спутниками и перевод', () => {
    let n = 0;
    for (let from = 1; n < 5; from += 300) {
      const p = stemi(true, from);
      const r = run(p, BAY);
      if (r.diagnosis !== ACS || !r.obs.some(o => o.f === 'ecg.st_elevation' && o.shown)) continue;
      n++;
      expect(r.done[0]).toBe('exam.ecg');
      expect(r.done).toContain('exam.ask_lysis');
      expect(r.done.indexOf('exam.ask_lysis')).toBeGreaterThan(0);
      for (const tx of [LYSIS, 'tx.aspirin_acs', 'tx.clopidogrel', 'tx.enoxaparin_acs']) expect(r.plan.treatments).toContain(tx);
      expect(['transfer', 'ambulance']).toContain(r.plan.setting);
      const ev = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect([ev.beforeTransferMissing, ev.companionsMissing]).toEqual([[], []]);
    }
  });

  test('в кабинете врача тромболизиса нет — и спутников без него не добавляет; противопоказание — без тромболизиса', () => {
    const p = stemi(true);
    const st = [...complaintObservations(p), shown('ecg.st_elevation', 'exam.ecg'), ...CONTRA.map(f => shown(f, 'exam.ask_lysis', false))];
    const office = choosePlan(db, ACS, st, p.age);
    expect(office.treatments).not.toContain(LYSIS);
    expect(choosePlan(db, ACS, st, p.age, BAY).treatments).toContain(LYSIS);
    const contra = st.map(o => (o.f === 'hx.recent_bleed_surgery' ? { ...o, shown: true } : o));
    expect(choosePlan(db, ACS, contra, p.age, BAY).treatments).not.toContain(LYSIS);
  });
});

describe('смена', () => {
  /** Районная больница главы 2, открыт первый день. */
  function district(seed: number): ShiftState {
    const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.hospital' });
    apply(db, s, { kind: 'nextDay' });
    return s;
  }
  /** Первый, кто лежит в смотровой приёмного (привезла скорая), и первый, кто сидит в кабинете врача. */
  function find(): { s: ShiftState; bay: ShiftPatient; office: ShiftPatient } {
    for (let seed = 51; seed < 151; seed++) {
      const s = district(seed);
      for (let i = 0; i < 4 * 60; i++) {
        const all = Object.values(s.patients);
        const bay = all.find(q => q.bay && q.status === 'waiting');
        const office = all.find(q => !q.bay && q.kind !== 'ambulance' && q.status === 'waiting');
        if (bay && office) return { s, bay, office };
        apply(db, s, { kind: 'advance', seconds: 60 });
      }
    }
    throw new Error('за 100 зёрен не нашлось');
  }

  test('лежащему в смотровой тромболизис назначается, сидящему в кабинете — нет; итог помнит монитор у постели', () => {
    const { s, bay, office } = find();
    expect(bedsideEquipment(db, s, bay)).toContain(MONITOR);
    expect(bedsideEquipment(db, s, office)).toEqual([]);
    for (const [p, ok] of [[office, false], [bay, true]] as const) {
      if (p.scale) apply(db, s, { kind: 'sort', id: p.id, triage: p.scale.triage });
      apply(db, s, { kind: 'call', id: p.id });
      expect(current(s)?.id).toBe(p.id);
      apply(db, s, { kind: 'toggleTreatment', id: LYSIS });
      expect(current(s)!.draft.treatments.includes(LYSIS)).toBe(ok);
      apply(db, s, { kind: 'diagnose', id: p.patient.truth.conditions[0].id });
      apply(db, s, { kind: 'setting', setting: 'ambulance' });
      apply(db, s, { kind: 'finish' });
    }
    expect(s.patients[bay.id].closed!.bedside).toContain(MONITOR);
    expect(s.patients[office.id].closed!.bedside).toBeUndefined();
  });
});

describe('энциклопедия', () => {
  test('у тромболизиса — где делают и с чем назначают; у ОКС — «Обязательно до перевода»; у правила — о каком лечении', () => {
    const a = article(db, LYSIS)!;
    const where = a.blocks.find(b => b.key === 'where')!;
    expect(where.refs!.map(r => r.id)).toEqual([MONITOR, 'room.emergency', 'room.icu']);
    const companions = a.blocks.find(b => b.key === 'companions')!;
    expect(companions.rows!.map(r => [r.label, r.refs.map(x => x.id)])).toEqual([
      ['Каждое', ['tx.aspirin_acs', 'tx.clopidogrel']],
      ['Одно из', ['tx.enoxaparin_acs', 'tx.fondaparinux', 'tx.heparin_iv']],
    ]);
    const must = a.blocks.flatMap(b => b.rows ?? []).find(r => r.label === 'Обязательно до перевода при')!;
    expect(must.refs.map(r => [r.id, r.note])).toEqual([[ACS, 'при инфаркте с подъёмом ST и в первые 12 часов от начала симптомов']]);
    const rows = article(db, ACS)!.blocks.find(b => b.key === 'treatment')!.rows!;
    expect(rows.find(r => r.label.startsWith('Обязательно до перевода'))!.refs.map(r => r.id)).toEqual([LYSIS]);
    expect(article(db, RULE)!.blocks.find(b => b.key === 'decides')!.refs!.map(r => r.id)).toEqual([LYSIS]);
    // монитор: что им делают — и тромболизис под ним
    expect(article(db, MONITOR)!.blocks.find(b => b.key === 'examsBy')!.refs!.map(r => r.id)).toContain(LYSIS);
  });
});
