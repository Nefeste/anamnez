// Стенокардия напряжения и нестабильная по нагрузке (spec 2026-10-chapter-3, часть 39г; 155_2 и
// 154_4, раздел 1.5): одна жалоба — боль за грудиной при нагрузке; стабильную лечат дома, впервые
// возникшую и утяжелившуюся — как ОКС, в больнице.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { scaleTriage } from '../../src/engine/med/news2';
import { evaluatePlan, type Plan, tacticsFor, txRole } from '../../src/engine/med/plan';
import { choosePlan, runDoctor } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { examWhere } from '../../src/engine/hospital/requirements';
import { candidatesOf, hospitalCtx, newShift } from '../../src/engine/shift/engine';
import { targetsFor } from '../../src/engine/shift/targets';
import { noteText } from '../../src/state/caseView';
import { article, whenText } from '../../src/state/encyclopedia';

const ANGINA = 'cond.angina_stable';
const ACS = 'cond.acs';
const EXERTION = 'sym.chest_pain_exertion';
const PRESSING = 'sym.chest_pain_pressing';
const PROGRESSIVE = 'hx.angina_progressive';
const LOW = 'hx.angina_low_threshold';
const BB = 'tx.beta_blocker';
const CCB = 'tx.ccb';
const STATIN = 'tx.statin';
const NITRO = 'tx.nitroglycerin';

const patient = (primary: Id, seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', season: 'winter', primary, params });
const many = (primary: Id, n: number, params: Record<string, string> = {}, from = 1) =>
  Array.from({ length: n }, (_, i) => patient(primary, from + i, params));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
/** признак — от самой болезни, а не фоном (давящая боль в груди бывает и фоном, у 1 %) */
const by = (p: Patient, f: Id, cause: Id) => p.truth.findings.some(x => x.f === f && x.cause === cause);
const share = (xs: Patient[], ok: (p: Patient) => boolean) => xs.filter(ok).length / xs.length;
const paramsOf = (p: Patient) => p.truth.conditions[0].params;

describe('стенокардия напряжения', () => {
  test('жалоба — боль при нагрузке у каждого; прогрессирования нет; III–IV класс — около трети и с порогом нагрузки', () => {
    const xs = many(ANGINA, 1500);
    expect(xs.every(p => has(p, EXERTION) && p.complaints.includes(EXERTION))).toBe(true);
    expect(xs.some(p => has(p, PROGRESSIVE) || by(p, PRESSING, ANGINA))).toBe(false);
    const high = share(xs, p => paramsOf(p).fc === 'iii_iv');
    expect(high).toBeGreaterThan(0.26);
    expect(high).toBeLessThan(0.34);
    for (const p of xs) expect(has(p, LOW)).toBe(paramsOf(p).fc === 'iii_iv');
  });

  test('ЭКГ покоя без признаков ишемии; ЛНП выше 3 — часто; расспрос о боли проверяет нагрузку, давность и порог', () => {
    const xs = many(ANGINA, 400, {}, 5000);
    expect(xs.some(p => by(p, 'ecg.st_depression', ANGINA) || by(p, 'ecg.st_elevation', ANGINA))).toBe(false);
    expect(share(xs, p => has(p, 'lab.ldl_high'))).toBeGreaterThan(0.45);
    const checks = db.exams['exam.ask_chest_pain'].checks.map(c => c.f);
    expect(checks).toEqual(expect.arrayContaining([EXERTION, PROGRESSIVE, LOW]));
    const p = xs.find(x => paramsOf(x).fc === 'iii_iv')!;
    const obs = runExam(db, p, 'exam.ask_chest_pain', Rng.seeded(1).fork('расспрос'));
    expect(obs.find(o => o.f === PROGRESSIVE)).toBeDefined();
    expect(obs.find(o => o.f === LOW)?.shown).toBe(true);
  });

  test('тактика: нитроглицерин и бета-адреноблокатор — первая линия, статин обязателен; при III–IV — ещё и блокатор кальциевых каналов', () => {
    const t = db.conditions[ANGINA].treatment!;
    const low = tacticsFor(t, { fc: 'i_ii' });
    expect(low.firstLine).toEqual(expect.arrayContaining([NITRO, BB]));
    expect(low.require).toEqual([STATIN]);
    expect(txRole(db, ANGINA, CCB, { fc: 'i_ii' })).toBe('acceptable');
    const high = tacticsFor(t, { fc: 'iii_iv' });
    expect(high.require).toEqual(expect.arrayContaining([STATIN, BB, CCB]));
    expect(t.setting.default).toBe('home');
    // бета-адреноблокатор — нельзя при бронхиальной астме (62_3: абсолютное противопоказание)
    expect(db.treatments[BB].contraindications).toEqual([expect.objectContaining({ id: 'cond.asthma', level: 'absolute' })]);
  });

  test('разбор: без статина — «не назначено»; при III–IV классе без блокатора кальциевых каналов — тоже, с условием', () => {
    const p = many(ANGINA, 200, { fc: 'iii_iv' }).find(x => x.truth.risks.length === 0)!;
    const obs: Observation[] = [...p.complaints.map(f => ({ f, shown: true, exam: 'complaint' })), { f: LOW, shown: true, exam: 'exam.ask_chest_pain' }];
    const score = (treatments: Id[]) => {
      const plan: Plan = { treatments, setting: 'home' };
      const ev = evaluatePlan(db, p, plan, obs);
      return { ev, score: scoreCase({ verdict: 'correct', confidence: 0.9, cost: 10, rationalCost: 10, plan: ev, outcome: { kind: 'improved', day: 7, cured: true }, selfLimiting: false, redFlags: [] }) };
    };
    expect(score([NITRO, BB, CCB, STATIN]).ev.requireMissing).toEqual([]);
    const noStatin = score([NITRO, BB, CCB]);
    expect(noStatin.ev.requireMissing).toEqual([STATIN]);
    expect(noteText(noStatin.score.notes.find(n => n.code === 'tx.requireMissing')!)).toBe('Не назначено: статин — без этого лечение неполное');
    const noCcb = score([NITRO, BB, STATIN]);
    expect(noCcb.ev.requireMissing).toEqual([CCB]);
    expect(noteText(noCcb.score.notes.find(n => n.code === 'tx.requireMissing')!)).toBe('Не назначено: блокаторы кальциевых каналов (амлодипин) — обязательно при III–IV функциональном классе');
  });

  test('разумный врач: дома — нитроглицерин, бета-адреноблокатор, статин; при астме — без бета-адреноблокатора', () => {
    const p = many(ANGINA, 200, { fc: 'i_ii' }).find(x => x.truth.risks.length === 0)!;
    const obs: Observation[] = p.complaints.map(f => ({ f, shown: true, exam: 'complaint' }));
    const plan = choosePlan(db, ANGINA, obs, p.age);
    expect(plan.setting).toBe('home');
    expect(plan.treatments).toEqual(expect.arrayContaining([NITRO, BB, STATIN]));
    const asthma = choosePlan(db, ANGINA, [...obs, { f: 'hx.asthma', shown: true, exam: 'exam.ask_chronic' }], p.age);
    expect(asthma.treatments).not.toContain(BB);
    expect(asthma.treatments).toContain(STATIN);
  });
});

describe('нестабильная по нагрузке', () => {
  test('у нестабильной стенокардии по нагрузке — боль при нагрузке и прогрессирование, давящей боли в покое нет; у остальных ОКС — наоборот', () => {
    const ua = many(ACS, 400, { type: 'nste', mi: 'no', pain: 'exertion' }, 7000);
    expect(ua.every(p => has(p, EXERTION) && has(p, PROGRESSIVE) && !by(p, PRESSING, ACS))).toBe(true);
    const others: Record<string, string>[] = [{ type: 'nste', mi: 'no', pain: 'rest' }, { type: 'nste', mi: 'yes', pain: 'exertion' }, { type: 'stemi', pain: 'exertion' }];
    for (const params of others) {
      const xs = many(ACS, 300, params, 8000);
      expect(xs.some(p => has(p, EXERTION) || has(p, PROGRESSIVE))).toBe(false);
      // давящая боль в покое — «обычно», как и до части 39г
      expect(share(xs, p => by(p, PRESSING, ACS))).toBeGreaterThan(0.6);
    }
    expect(share(many(ACS, 2000, { type: 'nste', mi: 'no' }, 9000), p => paramsOf(p).pain === 'exertion')).toBeGreaterThan(0.36);
  });

  test('ЭКГ в первые 10 минут — и при боли при нагрузке у лежащих в смотровой; по шкале — красный', () => {
    const p = patient(ACS, 7001, { type: 'nste', mi: 'no', pain: 'exertion' });
    const at = { roomType: () => 'room.emergency', bedside: (e: Id) => e === 'exam.ecg', can: () => true };
    expect(targetsFor(db, { patient: p, bay: { room: 'r1', slot: 0 } as never, results: [] }, at).map(t => t.id)).toEqual(['target.ecg_chest_pain']);
    // как давящая боль: при сортировке стабильную от нестабильной не отличить, а срок ЭКГ — 10 минут
    expect(scaleTriage(db, [EXERTION], [])).toEqual({ triage: 'red', news2: 0, flag: EXERTION });
  });

  test('разумный врач в поликлинике: стабильную лечит дома, нестабильную по нагрузке отправляет в больницу', () => {
    const s = newShift(db, { seed: 3, season: 'winter' });
    const ctx = hospitalCtx(db, s);
    const exams = Object.keys(db.exams).sort().filter(id => !('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, id)));
    expect(exams).toContain('exam.lipids');
    const candidates = candidatesOf(db, 'dept.therapy');
    const run = (p: Patient, i: number) => runDoctor(db, p, 'rational', Rng.seeded(i).fork('стенокардия'), { candidates, exams });
    const older = (xs: Patient[]) => xs.filter(p => p.age >= 45).slice(0, 40);
    const stable = older(many(ANGINA, 80, {}, 11000)).map(run);
    expect(stable.filter(r => r.diagnosis === ANGINA && r.plan.setting === 'home').length / stable.length).toBeGreaterThan(0.9);
    const ua = older(many(ACS, 80, { type: 'nste', mi: 'no', pain: 'exertion' }, 12000)).map(run);
    expect(ua.filter(r => r.diagnosis === ACS && r.plan.setting !== 'home').length / ua.length).toBeGreaterThan(0.8);
    // отличает расспросом: о прогрессировании спрашивает у каждого
    expect(ua.every(r => r.exams.includes('exam.ask_chest_pain'))).toBe(true);
  }, 30_000);
});

describe('энциклопедия', () => {
  test('у стенокардии — тактика по классу, у ОКС — боль при нагрузке у впервые возникшей и утяжелившейся', () => {
    expect(whenText({ fc: ['iii_iv'] })).toBe('при III–IV функциональном классе');
    const a = article(db, ANGINA)!;
    const rows = a.blocks.find(b => b.key === 'treatment')!.rows!;
    expect(rows.some(r => r.label.includes('при III–IV функциональном классе') && r.refs.some(x => x.id === CCB))).toBe(true);
    const acs = JSON.stringify(article(db, ACS));
    expect(acs).toContain('при впервые возникшей или утяжелившейся стенокардии');
    expect(JSON.stringify(article(db, 'exam.lipids'))).toContain('Липидный спектр');
  });
});
