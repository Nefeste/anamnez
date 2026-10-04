// ОКС без подъёма ST: тропонин по алгоритму 0/1 час, коронарография в первые сутки, своя палата интенсивной
// терапии и антитромботическая развилка (spec 2026-10-chapter-3, часть 39в).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { runExam } from '../../src/engine/med/exams';
import { deriveParams, generatePatient } from '../../src/engine/med/generate';
import { choiceFor, evaluatePlan, type Plan, recommendedSetting, requireOf, tacticsFor, txRole } from '../../src/engine/med/plan';
import { choosePlan, decisionLimit, examMinutes, runDoctor } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { examWhere } from '../../src/engine/hospital/requirements';
import { apply, candidatesOf, current, hospitalCtx, newCampaign, newShift } from '../../src/engine/shift/engine';
import { wardCourse } from '../../src/engine/shift/ward';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { makeCaseView, noteText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const ACS = 'cond.acs';
const TROP = 'exam.troponin_hs';
const HIGH = 'lab.troponin_high';
const RISE = 'lab.troponin_rise';
const RULE = 'rule.acs_invasive';
const CLOP = 'tx.clopidogrel';
const ANTICOAG = ['tx.fondaparinux', 'tx.enoxaparin_acs', 'tx.heparin_iv'];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];

const acs = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: ACS, params });
const people = (n: number, params: Record<string, string> = {}, from = 1) => Array.from({ length: n }, (_, i) => acs(from + i, params));
const paramsOf = (p: Patient) => p.truth.conditions[0].params;
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const share = (xs: Patient[], ok: (p: Patient) => boolean) => xs.filter(ok).length / xs.length;

describe('инфаркт или нестабильная стенокардия', () => {
  test('у ОКС без подъёма ST инфаркт — около четверти (154_4, раздел 1.3: не меньше 23,8 %)', () => {
    const xs = people(2000, { type: 'nste' });
    const mi = share(xs, p => paramsOf(p).mi === 'yes');
    expect(mi).toBeGreaterThan(0.22);
    expect(mi).toBeLessThan(0.28);
  });

  test('тропонин: у инфаркта прирост за час — у каждого, 52 и выше по первому анализу — часто; у нестабильной стенокардии — нет', () => {
    const variants: Record<string, string>[] = [{ type: 'nste', mi: 'yes' }, { type: 'stemi' }];
    for (const params of variants) {
      const xs = people(800, params);
      expect(share(xs, p => has(p, RISE))).toBe(1);
      const high = share(xs, p => has(p, HIGH));
      expect(high).toBeGreaterThan(0.45);
      expect(high).toBeLessThan(0.55);
    }
    const ua = people(800, { type: 'nste', mi: 'no' });
    expect(share(ua, p => has(p, RISE) || has(p, HIGH))).toBe(0);
  });

  test('числа — по алгоритму: 52 и выше или прирост от 5; иначе ниже 12 и прирост меньше 3 — «серой зоны» нет', () => {
    const xs = [...people(300, { type: 'nste', mi: 'yes' }), ...people(300, { type: 'nste', mi: 'no' }, 1000)];
    for (const [i, p] of xs.entries()) {
      const obs = runExam(db, p, TROP, Rng.seeded(i).fork('trop'));
      const high = obs.find(o => o.f === HIGH)!;
      const rise = obs.find(o => o.f === RISE)!;
      expect(high.shown ? high.value! >= 52 : high.value! < 12).toBe(true);
      expect(rise.shown ? rise.value! >= 5 : rise.value! < 3).toBe(true);
    }
  });
});

/** Районная больница главы 2, открыт первый день. */
function district(seed: number): ShiftState {
  const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.hospital' });
  apply(db, s, { kind: 'nextDay' });
  return s;
}

/** Привезённый скорой в смотровую — вместо него больной ОКС с этими параметрами; уже в кабинете врача. */
function inBay(params: Record<string, string>, seed = 7): { s: ShiftState; p: ShiftPatient } {
  const s = district(seed);
  for (let i = 0; i < 6 * 60; i++) {
    const p = Object.values(s.patients).find(q => q.kind === 'ambulance' && q.bay && q.status === 'waiting' && !q.sorted && q.scale);
    if (p) {
      p.patient = acs(4242, params);
      apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
      apply(db, s, { kind: 'call', id: p.id });
      return { s, p: current(s)! };
    }
    apply(db, s, { kind: 'advance', seconds: 60 });
  }
  throw new Error('скорая не приехала');
}

describe('анализ 0/1 час', () => {
  test('одно назначение — два забора: первый результат через 65 минут, прирост — через час после второго забора', () => {
    const { s, p } = inBay({ type: 'nste', mi: 'yes' });
    const t0 = s.t;
    apply(db, s, { kind: 'exam', exam: TROP });
    expect(p.done).toContain(TROP);
    expect(p.pending.map(x => [(x.readyAt - t0) / 60, x.repeat ?? false, x.obs.map(o => o.f)])).toEqual([[65, false, [HIGH]], [125, true, [RISE]]]);
    apply(db, s, { kind: 'waitResults' });
    expect(p.results.filter(r => r.exam === TROP).map(r => r.repeat ?? false)).toEqual([false]);
    apply(db, s, { kind: 'waitResults' });
    const both = p.results.filter(r => r.exam === TROP);
    expect(both.map(r => [(r.at - t0) / 60, r.repeat ?? false])).toEqual([[65, false], [125, true]]);
    // в карте — свои имена забору и повтору, новые сверху
    const view = makeCaseView({
      version: 0, patient: p.patient, clock: 600, minutesSpent: 0, money: 0, step: p.step,
      arrived: both.map(r => ({ exam: r.exam, step: r.step, at: 600, obs: r.obs, ...(r.repeat ? { repeat: r.repeat } : {}) })),
      pending: [], meanwhile: [], done: p.done, draft: p.draft,
    });
    expect(view.groups.filter(g => g.exam === TROP).map(g => g.name)).toEqual(['Тропонин через час', 'Тропонин высокочувствительный: 0 и 1 час']);
  });

  test('ушёл ждать — вернётся, когда готовы оба результата', () => {
    const { s, p } = inBay({ type: 'nste', mi: 'no' });
    apply(db, s, { kind: 'exam', exam: TROP });
    apply(db, s, { kind: 'sendAway' });
    expect(p.status).toBe('away');
    apply(db, s, { kind: 'advance', seconds: 70 * 60 });
    expect(p.status).toBe('away');
    expect(p.results.some(r => r.exam === TROP)).toBe(true);
    apply(db, s, { kind: 'advance', seconds: 60 * 60 });
    expect(p.status).toBe('waiting');
  });

  test('в амбулатории без смотровой приёмного тропонина нет: догоспитально маркеры не определяют', () => {
    // готовая амбулатория практики: лаборатория с иммунохимическим анализатором есть, смотровой приёмного нет
    const s = newShift(db, { seed: 3, season: 'winter' });
    const ctx = hospitalCtx(db, s);
    expect('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, 'exam.tsh')).toBe(false);
    expect('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, TROP)).toBe(true);
    const d = district(3);
    const dc = hospitalCtx(db, d);
    expect('block' in examWhere(db, dc.plan, dc.working, dc.staffed, TROP)).toBe(false);
  });
});

describe('коронарография в первые сутки', () => {
  const rule = db.rules[RULE];
  const verdict = (known: Record<Id, boolean>) => checkRule(rule, 60, f => known[f]).verdict;
  const none = { 'ecg.st_elevation': false, 'ecg.st_depression': false, [HIGH]: false, [RISE]: false, 'vital.bp_low': false, 'sign.crackles_local': false };

  test('правило: хватит одного — подъём или депрессия ST, тропонин, прирост, давление ниже 90, хрипы; пока нет прироста — не решено', () => {
    expect(verdict(none)).toBe('no');
    for (const f of Object.keys(none)) expect(verdict({ ...none, [f]: true })).toBe('yes');
    const early: Record<Id, boolean> = { ...none };
    delete early[RISE];
    expect(verdict(early)).toBe('unknown');
    expect(checkRule(rule, 60, f => early[f]).left).toEqual([RISE]);
  });

  test('параметр — по правилу на настоящих признаках: с подъёмом ST — всегда; без подъёма — по тропонину, ST и признакам сердечной недостаточности', () => {
    expect(people(200, { type: 'stemi' }).every(p => paramsOf(p).invasive === 'yes')).toBe(true);
    expect(people(200, { type: 'nste', mi: 'yes' }).every(p => paramsOf(p).invasive === 'yes')).toBe(true);
    // у нестабильной стенокардии без сердечной недостаточности — по ST и тому, что пришло от других причин:
    // хрипы, низкое давление
    const ua = people(800, { type: 'nste', mi: 'no', killip: 'i' });
    for (const p of ua) expect(paramsOf(p).invasive).toBe(db.rules[RULE].any.some(f => has(p, f)) ? 'yes' : 'no');
    expect(share(ua, p => paramsOf(p).invasive === 'no')).toBeGreaterThan(0.35);
    // доли для вывода — как в записи
    const all = people(2000, {}, 20000);
    const yes = share(all, p => paramsOf(p).invasive === 'yes');
    expect(Math.abs(yes - db.conditions[ACS].params!.invasive.yes / 100)).toBeLessThan(0.025);
  });

  test('место: невысокий риск — ПИТ, коронарография в первые сутки и подъём ST — перевод; без своей ПИТ — скорая', () => {
    const low = people(400, { type: 'nste', mi: 'no', killip: 'i' }).find(p => paramsOf(p).invasive === 'no')!;
    const high = people(5, { type: 'nste', mi: 'yes' })[0];
    expect(recommendedSetting(db, low)).toBe('icu');
    expect(recommendedSetting(db, high)).toBe('transfer');
    expect(recommendedSetting(db, people(1, { type: 'stemi' })[0])).toBe('transfer');
    expect(choiceFor('icu', { icu: true })).toBe('icu');
    expect(choiceFor('icu', { ward: true })).toBe('ambulance');
  });

  test('из сохранения до 0.3.7 параметр досчитывается при загрузке по правилу', () => {
    const p = people(1, { type: 'stemi' })[0];
    delete paramsOf(p).invasive;
    deriveParams(db, p.truth.conditions, p.age, p.truth.findings);
    expect(paramsOf(p).invasive).toBe('yes');
  });
});

describe('антитромботическая развилка', () => {
  const t = db.conditions[ACS].treatment!;

  test('перевод на коронарографию — клопидогрел не нужен; лечат здесь — клопидогрел и антикоагулянт обязательны', () => {
    expect(txRole(db, ACS, CLOP, { type: 'nste', invasive: 'yes' })).toBe('notIndicated');
    expect(txRole(db, ACS, CLOP, { type: 'nste', invasive: 'no' })).toBe('require');
    for (const tx of ANTICOAG) expect(txRole(db, ACS, tx, { type: 'nste', invasive: 'no' })).toBe('require');
    expect(requireOf(t, { type: 'nste', invasive: 'no', spo2_below90: 'no' })).toEqual([[CLOP], ANTICOAG]);
    // при подъёме ST — прежнее: клопидогрел облегчает, а при тромболизисе — его спутник
    expect(txRole(db, ACS, CLOP, { type: 'stemi', invasive: 'yes' })).toBe('supportive');
    expect(tacticsFor(t, { type: 'nste', invasive: 'no' }).require).toContainEqual(ANTICOAG);
  });

  /** Больной ОКС без подъёма ST невысокого риска и что о нём известно. */
  function lowRisk(): { p: Patient; obs: Observation[] } {
    const p = people(400, { type: 'nste', mi: 'no', killip: 'i' }).find(x => paramsOf(x).invasive === 'no' && paramsOf(x).spo2_below90 === 'no' && x.truth.risks.length === 0)!;
    const obs: Observation[] = ['ecg.st_elevation', 'ecg.st_depression', HIGH, RISE, 'vital.bp_low', 'sign.crackles_local', 'vital.spo2_low']
      .map(f => ({ f, shown: false, exam: 'x' }));
    return { p, obs: [...p.complaints.map(f => ({ f, shown: true, exam: 'complaint' })), ...obs] };
  }

  test('из группы хватит одного; без антикоагулянта — «не назначено» со строкой условия', () => {
    const { p, obs } = lowRisk();
    const base = ['tx.aspirin_acs', 'tx.nitroglycerin', CLOP];
    const score = (treatments: Id[]) => {
      const plan: Plan = { treatments, setting: 'icu' };
      const ev = evaluatePlan(db, p, plan, obs, { icu: true });
      return { ev, score: scoreCase({ verdict: 'correct', confidence: 0.9, cost: 10, rationalCost: 10, plan: ev, outcome: { kind: 'admitted', day: 0, cured: true }, selfLimiting: false, redFlags: [] }) };
    };
    for (const tx of ANTICOAG) expect(score([...base, tx]).ev.requireMissing).toEqual([]);
    const without = score(base);
    expect(without.ev.requireMissing).toEqual(['tx.fondaparinux']);
    expect(without.score.treatment).toBe('C');
    const note = without.score.notes.find(n => n.code === 'tx.requireMissing')!;
    expect(noteText(note)).toBe('Не назначено: фондапаринукс натрия под кожу — обязательно при ОКС без подъёма ST и без показаний к коронарографии в первые сутки');
    // переведённому их дают в центре
    expect(evaluatePlan(db, p, { treatments: base, setting: 'ambulance' }, obs).requireMissing).toEqual(['tx.fondaparinux']);
    expect(scoreCase({ verdict: 'correct', confidence: 0.9, cost: 10, rationalCost: 10, plan: evaluatePlan(db, p, { treatments: base, setting: 'ambulance' }, obs), outcome: { kind: 'transferred', day: 0, cured: false }, selfLimiting: false, redFlags: [] }).notes.some(n => n.code === 'tx.requireMissing')).toBe(false);
  });

  test('разумный врач: невысокий риск в своей ПИТ — клопидогрел и фондапаринукс; высокий — перевод без клопидогрела', () => {
    const { p, obs } = lowRisk();
    const plan = choosePlan(db, ACS, obs, p.age, { icu: true, ward: true });
    expect(plan.setting).toBe('icu');
    expect(plan.treatments).toEqual(expect.arrayContaining([CLOP, 'tx.fondaparinux']));
    const risky = obs.map(o => (o.f === RISE ? { ...o, shown: true } : o));
    const transfer = choosePlan(db, ACS, risky, p.age, { icu: true, ward: true });
    expect(transfer.setting).toBe('ambulance');
    expect(transfer.treatments).not.toContain(CLOP);
  });
});

describe('срок решения', () => {
  test('подъём ST на ЭКГ — срок решения 10 минут (тромболизис), а тропонин — 125: сейчас и через час, по часу на анализ', () => {
    const ecg = (shown: boolean): Observation[] => [{ f: 'ecg.st_elevation', shown, exam: 'exam.ecg' }];
    expect(decisionLimit(db, ecg(true))).toBe(10);
    expect(decisionLimit(db, ecg(false))).toBeUndefined();
    expect(examMinutes(db.exams[TROP])).toBe(125);
  });

  test('разумный врач: без подъёма ST — тропонин; с подъёмом на ЭКГ решает, не дожидаясь тропонина (157_5, раздел 2.3)', () => {
    const exams = Object.keys(db.exams).sort();
    const candidates = candidatesOf(db, ED);
    const pressing = (params: Record<string, string>, from: number) => people(120, params, from).filter(p => p.complaints.includes('sym.chest_pain_pressing')).slice(0, 30);
    const run = (p: Patient, i: number) => runDoctor(db, p, 'rational', Rng.seeded(i).fork('срок'), { candidates, exams });
    const ste = (r: ReturnType<typeof run>) => r.observations.some(o => o.f === 'ecg.st_elevation' && o.shown);
    const nste = pressing({ type: 'nste', killip: 'i' }, 30000).map(run).filter(r => !ste(r));
    expect(nste.filter(r => r.exams.includes(TROP)).length / nste.length).toBeGreaterThan(0.5);
    const stemi = pressing({ type: 'stemi' }, 31000).map(run);
    expect(stemi.filter(ste).length).toBeGreaterThan(20);
    for (const r of stemi.filter(ste)) expect(r.exams).not.toContain(TROP);
  }, 30_000);
});

describe('палата интенсивной терапии', () => {
  test('с АСК, клопидогрелом и антикоагулянтом стабилизируется чаще; без антикоагулянта чаще хуже — повод перевести', () => {
    const xs = people(1500, { type: 'nste', mi: 'no', killip: 'i' }).filter(p => paramsOf(p).invasive === 'no');
    const ready = (treatments: Id[]) => share(xs, p => {
      const plan: Plan = { treatments, setting: 'icu' };
      return wardCourse(db, p, plan, evaluatePlan(db, p, plan, []), Rng.seeded(p.seed).fork('ward')).readyAfter !== undefined;
    });
    const full = ready(['tx.aspirin_acs', CLOP, 'tx.fondaparinux']);
    const aspirin = ready(['tx.aspirin_acs']);
    expect(full).toBeGreaterThan(0.8);
    expect(aspirin).toBeLessThan(0.35);
    expect(db.conditions[ACS].stay).toEqual([1, 3]);
  });
});

describe('энциклопедия', () => {
  test('у ОКС — правило, место по риску и обязательное «одно из»; у анализа — забор в смотровой приёмного', () => {
    const a = article(db, ACS)!;
    expect(a.blocks.find(b => b.key === 'rules')!.refs!.map(r => r.id)).toContain(RULE);
    expect(a.blocks.find(b => b.key === 'where')!.text).toContain('При показаниях к коронарографии в первые сутки — скорая, перевод в центр.');
    const rows = a.blocks.find(b => b.key === 'treatment')!.rows!;
    expect(rows.find(r => r.label.endsWith('— одно из'))!.refs.map(r => r.id)).toEqual(ANTICOAG);
    const e = article(db, TROP)!;
    expect(e.blocks.find(b => b.key === 'where')!.refs!.map(r => r.id)).toContain('room.emergency');
  });
});
