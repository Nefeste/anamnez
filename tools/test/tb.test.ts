// Туберкулёз лёгких (часть 110, spec 2026-11-tb; вопрос 77): впервые выявленный инфильтративный туберкулёз у взрослого.
// Врач приёма заподозрит по долгому кашлю, ночной потливости и похуданию, сделает рентген груди и мокроту на КУМ и
// направит к фтизиатру — новое место «К фтизиатру» (приказ № 932н, пункты 9, 11 и 12); лечит диспансер, схем в игре нет.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { choiceFor, evaluatePlan, type Plan, recommendedSetting, settingFit } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { chestMarks, hits } from '../../src/render/xray/marks';
import { tbCavity, tbCenter, XRAY_ASPECT } from '../../src/render/xray/chestGeometry';
import { makeCaseView, outcomeText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

setDefaultTimeout(60_000);

const TB = 'cond.pulmonary_tb';
const patients = (n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 37 + k, { department: 'dept.therapy', season: 'autumn', primary: TB, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === TB);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];

describe('туберкулёз лёгких: запись', () => {
  const ps = patients(300, 110_100);

  test('терапия, A15, лёгкие; передаётся по воздуху; место — к фтизиатру; лечит диспансер — первой линии нет', () => {
    expect(db.conditions[TB]).toMatchObject({ icd10: 'A15', department: 'dept.therapy', system: 'lungs', isolation: 'airborne' });
    const t = db.conditions[TB].treatment!;
    expect(t.setting.default).toBe('phthisiatry');
    expect(t.firstLine).toEqual([]);
    // антибиотики туберкулёз не лечат, глюкокортикоиды — тоже
    expect(t.notIndicated).toEqual(expect.arrayContaining(['tx.amoxicillin', 'tx.fluoroquinolone', 'tx.steroid_systemic_short']));
  });

  test('тени в верхних отделах — у каждого, на стороне параметра; полость — только при распаде; инфильтрата нижней доли нет', () => {
    // «всегда» в базе — 95 %: у немногих снимок без теней
    expect(share(ps, p => has(p, 'img.cxr_tb'))).toBeGreaterThan(0.9);
    expect(share(ps.filter(p => param(p, 'cavity') === 'yes'), p => has(p, 'img.cxr_cavity'))).toBeGreaterThan(0.9);
    for (const p of ps) {
      if (has(p, 'img.cxr_tb')) expect(p.truth.findings.find(x => x.f === 'img.cxr_tb')?.attrs?.side).toBe(param(p, 'side'));
      if (has(p, 'img.cxr_cavity')) expect(param(p, 'cavity')).toBe('yes');
      expect(has(p, 'img.cxr_infiltrate')).toBe(false);
    }
  });

  test('микроскопия находит не больше половины, при распаде — чаще; кашель дольше трёх недель — у большинства', () => {
    const afb = share(ps, p => has(p, 'lab.afb_sputum'));
    expect(afb).toBeGreaterThan(0.3);
    expect(afb).toBeLessThan(0.55);
    const cav = ps.filter(p => param(p, 'cavity') === 'yes');
    const flat = ps.filter(p => param(p, 'cavity') === 'no');
    expect(share(cav, p => has(p, 'lab.afb_sputum'))).toBeGreaterThan(share(flat, p => has(p, 'lab.afb_sputum')) + 0.3);
    expect(share(ps, p => has(p, 'sym.cough_long'))).toBeGreaterThan(0.9);
    expect(share(ps, p => has(p, 'sym.cough_3w'))).toBeGreaterThan(0.6);
    expect(share(ps, p => has(p, 'sym.night_sweats'))).toBeGreaterThan(0.35);
  });

  test('о чём спросить и что сделать: кашель три недели, ночной пот, контакт; снимок видит тени и полость; мокрота — КУМ', () => {
    expect(db.exams['exam.ask_onset'].checks.map(c => c.f)).toContain('sym.cough_3w');
    expect(db.exams['exam.ask_general'].checks.map(c => c.f)).toContain('sym.night_sweats');
    expect(db.exams['exam.ask_contacts'].checks.map(c => c.f)).toContain('hx.tb_contact');
    expect(db.exams['exam.xray_chest'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['img.cxr_tb', 'img.cxr_cavity']));
    expect(db.exams['exam.sputum_afb']).toMatchObject({ kind: 'lab', room: 'room.lab', collect: 'room.procedure' });
    expect(db.exams['exam.sputum_afb'].checks.map(c => c.f)).toEqual(['lab.afb_sputum']);
  });

  test('контакт с больным туберкулёзом — фактор риска: у контактных болезнь чаще', () => {
    expect(db.conditions[TB].risks?.find(r => r.id === 'risk.tb_contact')?.x).toBe(8);
    expect(db.risks['risk.tb_contact'].findings.map(l => l.f)).toEqual(['hx.tb_contact']);
  });
});

describe('место «К фтизиатру»', () => {
  test('закрывает только себя; дома — мало, палата и бокс — больше нужного; кому нужен стационар, тому мало', () => {
    expect(settingFit('phthisiatry', 'phthisiatry')).toBe('ok');
    expect(['home', 'ward', 'admit', 'box', 'ambulance'].map(c => settingFit('phthisiatry', c as 'home'))).toEqual(['under', 'over', 'over', 'over', 'over']);
    expect([settingFit('ward', 'phthisiatry'), settingFit('home', 'phthisiatry')]).toEqual(['under', 'over']);
    // направить к фтизиатру можно отовсюду: и из кабинета, и из больницы со своей палатой и боксом
    expect([choiceFor('phthisiatry'), choiceFor('phthisiatry', { ward: true, box: true, icu: true })]).toEqual(['phthisiatry', 'phthisiatry']);
  });

  test('у больного туберкулёзом — к фтизиатру в любой больнице', () => {
    for (const p of patients(20, 110_500)) expect(recommendedSetting(db, p)).toBe('phthisiatry');
  });

  test('оценка: к фтизиатру — место A и без «лечения нет»; дома — D и «лечения нет»; в общую палату — и соседи контактные', () => {
    const p = patients(1, 110_600)[0];
    const score = (x: Plan) => scoreCase({
      verdict: 'correct', confidence: 0.95, cost: 10, rationalCost: 10, plan: evaluatePlan(db, p, x, []),
      outcome: { kind: 'transferred', day: 0, cured: false }, selfLimiting: false, redFlags: [],
    });
    const there = score({ treatments: [], setting: 'phthisiatry' });
    expect(there.setting).toBe('A');
    expect(there.notes.map(n => n.code)).not.toContain('tx.noCure');
    const home = score({ treatments: [], setting: 'home' });
    expect(home.setting).toBe('D');
    expect(home.notes.map(n => n.code)).toEqual(expect.arrayContaining(['setting.under', 'tx.noCure']));
    expect(score({ treatments: [], setting: 'admit' }).notes.map(n => n.code)).toEqual(expect.arrayContaining(['setting.over', 'setting.contacts']));
    // антибиотик «на всякий случай» — не нужен
    expect(score({ treatments: ['tx.amoxicillin'], setting: 'phthisiatry' }).notes).toEqual(expect.arrayContaining([{ code: 'tx.notIndicated', tx: 'tx.amoxicillin' }]));
  });

  test('исход словами — направлен в противотуберкулёзный диспансер; на экране решения — вариант «К фтизиатру»', () => {
    expect(outcomeText({ kind: 'transferred', day: 0, cured: false }, 'phthisiatry', false)).toMatch(/^Направлен в противотуберкулёзный диспансер/);
    expect(outcomeText({ kind: 'transferred', day: 0, cured: false }, 'phthisiatry', true)).toMatch(/^Направлена в противотуберкулёзный диспансер/);
    const p = patients(1, 110_700)[0];
    const view = makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [], draft: { treatments: [], setting: 'home' },
    });
    expect(view.settings.map(s => s.key)).toEqual(['home', 'ward', 'phthisiatry', 'ambulance']);
    expect(view.settings.find(s => s.key === 'phthisiatry')?.title).toBe('К фтизиатру');
  });
});

describe('снимок: тени, полость и разметка', () => {
  test('затенение — в верхнем отделе своей стороны, полость — внутри него; правое лёгкое — слева на снимке', () => {
    for (const s of [-1, 1] as const) {
      const [x, y] = tbCenter(s);
      expect(y).toBeLessThan(0.3);
      expect(s === -1 ? x < 0.5 : x > 0.5).toBe(true);
      const { center } = tbCavity(s);
      expect(Math.hypot(center[0] - x, center[1] - y)).toBeLessThan(0.03);
    }
  });

  test('разметка: «очаги» — вокруг затенения, «полость» — вокруг кольца; касание полости попадает в обе', () => {
    const m = chestMarks({ tb: { side: 'right', cavity: true } }, 1);
    expect(Object.keys(m).sort()).toEqual(['cavity', 'tb']);
    const { center } = tbCavity(-1);
    expect(hits(m.tb!, center, XRAY_ASPECT)).toBe(true);
    expect(hits(m.cavity!, center, XRAY_ASPECT)).toBe(true);
    // другая сторона — мимо
    expect(hits(m.tb!, tbCenter(1), XRAY_ASPECT)).toBe(false);
    // без полости — только тени; с обеих сторон — два контура
    expect(Object.keys(chestMarks({ tb: { side: 'left' } }, 1))).toEqual(['tb']);
    expect(chestMarks({ tb: { side: 'both' } }, 1).tb!.outlines.length).toBe(2);
  });
});

/** Разумный врач по шагам — в амбулатории. */
function doctor(p: Patient) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ['dept.therapy']);
  const exams = Object.keys(db.exams).sort();
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  test('туберкулёз верно — у большинства: снимок груди сделан, направлен к фтизиатру', () => {
    const rs = patients(60, 110_900).map(p => ({ p, r: doctor(p) }));
    expect(share(rs, x => x.r.diagnosis === TB)).toBeGreaterThan(0.8);
    const right = rs.filter(x => x.r.diagnosis === TB);
    // направляют по снимку (приказ № 932н, пункты 9 и 12): сначала рентген груди
    expect(share(right, x => x.r.done.includes('exam.xray_chest'))).toBe(1);
    expect(share(right, x => x.r.plan.setting === 'phthisiatry')).toBe(1);
  });
});

describe('энциклопедия', () => {
  test('статья: где лечить — к фтизиатру; заразна по воздуху; новые признаки и мокрота — статьями', () => {
    const a = article(db, TB)!;
    const text = JSON.stringify(a);
    expect(text).toMatch(/к фтизиатру, в противотуберкулёзный диспансер/);
    expect(text).toMatch(/передаётся по воздуху/);
    for (const id of ['sym.cough_3w', 'sym.night_sweats', 'hx.tb_contact', 'lab.afb_sputum', 'img.cxr_tb', 'img.cxr_cavity', 'exam.sputum_afb']) {
      expect(article(db, id)).toBeDefined();
    }
  });
});
