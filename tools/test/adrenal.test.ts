// Надпочечниковый криз (spec 2026-10-chapter-4, часть 56а; 524_3): у больного болезнью Аддисона при инфекции, рвоте и поносе
// — или первым проявлением болезни. Выраженная слабость, рвота, боль в животе, давление падает; натрий ниже 132, калий высокий.
// Гидрокортизон в вену — сразу, не дожидаясь анализов, кровь на кортизол и АКТГ — до первой дозы, если успевают; 0,9 % натрия
// хлорид — обязательно, в первый час. Норэпинефрин без гидрокортизона не поможет. Палата, ПИТ — не ошибка.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { alsoSettings, curesOf, evaluatePlan, recommendedSetting, txRole, type Venue } from '../../src/engine/med/plan';
import { decisionLimit, type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const AC = 'cond.adrenal_crisis';
const HX = 'hx.adrenal_insufficiency';
const NA = 'lab.na_low';
const K = 'lab.k_high';
const LYTES = 'exam.electrolytes';
const HC = 'tx.hydrocortisone_iv';
const SALINE = 'tx.iv_fluids';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.infectious'];

const patients = (n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: AC, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === AC);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];
const seen = (f: Id, shown = true, exam = 'exam.ask_chronic'): Observation => ({ f, shown, exam });

describe('надпочечниковый криз', () => {
  const ps = patients(300, 56_300);

  test('запись по 524_3: терапия, E27.2, без фоновой записи; известна ли болезнь, причина и шок — параметры', () => {
    expect(db.conditions[AC]).toMatchObject({ icd10: 'E27.2', department: 'dept.therapy', severity: 'critical', confirm: 'clinical', params: { known: { yes: 70, no: 30 }, trigger: { gi: 33, infection: 24, none: 43 }, shock: { yes: 50, no: 50 } } });
    expect(db.conditions[AC].requires).toBeUndefined();
    expect(db.conditions[AC].differential).toEqual(['cond.gastroenteritis', 'cond.sepsis', 'cond.appendicitis']);
  });

  test('по табл. 3: слабость — почти у каждого, натрий ниже 132 — обычно, калий — часто; известная болезнь и давление ниже 90 — по параметрам', () => {
    for (const p of ps) {
      expect(has(p, HX)).toBe(param(p, 'known') === 'yes');
      expect(has(p, 'vital.bp_low')).toBe(param(p, 'shock') === 'yes');
    }
    expect(share(ps, p => has(p, 'sym.fatigue'))).toBeGreaterThan(0.9);
    expect(share(ps, p => has(p, NA))).toBeGreaterThan(0.65);
    expect(share(ps, p => has(p, NA))).toBeLessThan(0.85);
    expect(share(ps, p => has(p, K))).toBeGreaterThan(0.4);
    expect(share(ps, p => has(p, K))).toBeLessThan(0.6);
    // кишечная инфекция — понос; без неё понос от криза не бывает
    const gi = ps.filter(p => param(p, 'trigger') === 'gi');
    expect(share(gi, p => has(p, 'sym.diarrhea'))).toBeGreaterThan(0.6);
    expect(ps.filter(p => param(p, 'trigger') !== 'gi').some(p => has(p, 'sym.diarrhea'))).toBe(false);
  });

  test('натрий и калий — один анализ, каждому с известной болезнью Аддисона; о ней — в расспросе о хронических болезнях, кожа — на общем осмотре', () => {
    expect(db.exams[LYTES]).toMatchObject({ kind: 'lab', room: 'room.lab', routineSeen: [HX] });
    expect(db.exams[LYTES].checks.map(c => c.f)).toEqual([NA, K]);
    expect(db.exams['exam.ask_chronic'].checks.map(c => c.f)).toContain(HX);
    expect(db.exams['exam.general_exam'].checks.map(c => c.f)).toContain('sign.hyperpigmentation');
    // ответ — через час: дольше срока раствора, ждать его нельзя
    expect(examMinutes(db.exams[LYTES])).toBeGreaterThan(60);
  });

  test('тактика: гидрокортизон — первая линия, ГКС в вену и кровь на кортизол — можно, раствор — обязательно, норэпинефрин — не нужен', () => {
    const t = db.conditions[AC].treatment!;
    expect(t.firstLine).toEqual([HC]);
    expect(t.acceptable).toEqual(['tx.steroid_iv', 'tx.cortisol_sample', 'tx.dextrose_infusion']);
    expect(t.notIndicated).toEqual(['tx.norepinephrine']);
    expect(t.require).toEqual([SALINE]);
    expect(txRole(db, AC, SALINE, {})).toBe('require');
    expect(curesOf(db, { id: AC, params: {} }, [HC]).map(e => e.p)).toEqual([9500]);
    expect(curesOf(db, { id: AC, params: {} }, ['tx.norepinephrine'])).toEqual([]);
    const p = ps[0];
    const obs = complaintObservations(p);
    const venue: Venue = { ward: true, icu: true };
    expect(evaluatePlan(db, p, { treatments: [HC], setting: 'admit' }, obs, venue).requireMissing).toEqual([SALINE]);
    const ok = evaluatePlan(db, p, { treatments: [HC, SALINE], setting: 'admit' }, obs, venue);
    expect([ok.requireMissing, ok.effective]).toEqual([[], true]);
  });

  test('место — палата; ПИТ — не ошибка и при шоке, и без него', () => {
    for (const p of ps.slice(0, 20)) {
      expect(recommendedSetting(db, p)).toBe('ward');
      expect(alsoSettings(db, p)).toEqual(['icu']);
    }
  });

  test('срок: раствор в первый час от поступления — лежащим в смотровой приёмного, у кого известна болезнь Аддисона', () => {
    expect(db.targets['target.adrenal_saline']).toMatchObject({ from: 'arrival', room: 'room.emergency', findings: [HX], treatments: [SALINE], minutes: 60 });
    expect(decisionLimit(db, [seen(HX)])).toBe(60);
    expect(decisionLimit(db, [seen(HX, false)])).toBeUndefined();
  });
});

/** Разумный врач по шагам — в приёмном с палатой и ПИТ. */
function doctor(p: Patient) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ED);
  const exams = Object.keys(db.exams).sort();
  const venue: Venue = { ward: true, icu: true };
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  test('криз верно — у девяти из десяти; при известной болезни — сразу, не дожидаясь натрия: гидрокортизон и раствор', () => {
    const ps = patients(100, 56_100);
    const rs = ps.map(p => ({ p, r: doctor(p) }));
    expect(share(rs, x => x.r.diagnosis === AC)).toBeGreaterThan(0.85);
    const known = rs.filter(x => param(x.p, 'known') === 'yes');
    expect(share(known, x => x.r.diagnosis === AC)).toBeGreaterThan(0.95);
    expect(share(known, x => x.r.plan.treatments.includes(HC) && x.r.plan.treatments.includes(SALINE))).toBeGreaterThan(0.95);
    // ответ натрия — через час: срок раствора важнее
    expect(share(known, x => x.r.minutes <= 60)).toBeGreaterThan(0.9);
    expect(share(known, x => x.r.plan.setting === 'admit')).toBeGreaterThan(0.9);
  });
});

describe('энциклопедия', () => {
  test('криз: гидрокортизон — первая линия, раствор — обязательно, норэпинефрин — не нужен; новые записи — статьями', () => {
    const rows = Object.fromEntries(article(db, AC)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({ 'Первая линия': [HC], 'Обязательно': [SALINE], 'Не нужно': ['tx.norepinephrine'] });
    for (const id of [AC, HX, NA, K, LYTES, HC, 'tx.cortisol_sample', 'sign.hyperpigmentation']) expect(article(db, id)).toBeDefined();
  });
});
