// Травма стопы, бедра и ключицы (spec 2026-09-chapter-2, часть 32б): перелом основания пятой
// плюсневой кости, шейки бедра и ключицы со скрытым смещением и их пары — ушибы; операция по
// скрытому параметру (винты или эндопротез — по снимку); место, которое тоже не ошибка (ключица со
// смещением — операция или повязка дома); оттавские правила для стопы; расспрос о травме не
// выдумывает травму; «виртуальный врач»; снимки в карте; энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { likelyParams } from '../../src/engine/med/infer';
import { alsoSettings, evaluatePlan, recommendedSetting, settingFit, surgeriesOf, surgeryFor, txRole } from '../../src/engine/med/plan';
import { choosePlan, runDoctor, tacticParams } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf, operationOf } from '../../src/engine/shift/engine';
import type { ShiftPatient } from '../../src/engine/shift/types';
import { makeCaseView } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const MT5 = 'cond.mt5_fracture';
const FOOT = 'cond.foot_contusion';
const HIP = 'cond.femoral_neck_fracture';
const HIP_BRUISE = 'cond.hip_contusion';
const CLAVICLE = 'cond.clavicle_fracture';
const SHOULDER = 'cond.shoulder_contusion';
const NEW = [MT5, FOOT, HIP, HIP_BRUISE, CLAVICLE, SHOULDER];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const people = (primary: Id, n: number, from = 1, params?: Record<string, string>) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'winter', primary, ...(params ? { params } : {}) }));
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const xr = (exam: Id, f: Id, shown: boolean): Observation => ({ f, shown, exam });
/** у заданной болезни пол и возраст не выбираются — доля по весам генератора */
const weight = (id: Id, sex: 'm' | 'f', age = 70) => presentingWeight(db.conditions[id], { age, sex, season: 'winter', risks: [], chronic: [] });
const femaleShare = (id: Id) => weight(id, 'f') / (weight(id, 'f') + weight(id, 'm'));
/** перелом шейки бедра — от 60 лет: из заданных болезнью берём таких */
const elderly = (primary: Id, n: number, from: number, params?: Record<string, string>) => people(primary, n * 4, from, params).filter(p => p.age >= 60).slice(0, n);
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();

describe('кто болеет и что находят', () => {
  test('шесть новых — отделение травмы, «кости и суставы», только с приёмным', () => {
    for (const id of NEW) expect(db.conditions[id]).toMatchObject({ department: 'dept.trauma', system: 'bones', presenting: true });
    expect(candidatesOf(db, ['dept.therapy']).some(id => NEW.includes(id))).toBe(false);
  });

  test('перелом основания пятой плюсневой: оперируют 6 % (Pettersen 2022: без операции 94,4 %)', () => {
    near(share(people(MT5, 1500, 1), p => p.truth.conditions[0].params.displacement === 'displaced'), 0.06, 0.02);
  });

  test('перелом шейки бедра: со смещением 76 %, женщин 69 % (Authen 2018), всем от 60 лет', () => {
    const ps = people(HIP, 1200, 2000);
    near(share(ps, p => p.truth.conditions[0].params.displacement === 'displaced'), 0.76, 0.04);
    near(femaleShare(HIP), 0.69, 0.01);
    expect(weight(HIP, 'f', 55)).toBe(0);
    expect(weight(HIP, 'f', 75)).toBeGreaterThan(0);
    // укорочение и ротация — у смещённых
    const shortened = (p: Patient) => p.truth.findings.some(f => f.f === 'sign.leg_shortened_rotated');
    expect(share(ps.filter(p => p.truth.conditions[0].params.displacement === 'displaced'), shortened)).toBeGreaterThan(0.6);
    expect(share(ps.filter(p => p.truth.conditions[0].params.displacement === 'none'), shortened)).toBeLessThan(0.15);
  });

  test('перелом ключицы: со смещением 66 %, мужчин 74 % (Kihlström 2017), слева 61 % (Postacchini 2002)', () => {
    const ps = people(CLAVICLE, 1200, 4000);
    near(share(ps, p => p.truth.conditions[0].params.displacement === 'displaced'), 0.66, 0.04);
    near(1 - femaleShare(CLAVICLE), 0.74, 0.01);
    near(share(ps, p => p.truth.conditions[0].params.side === 'left'), 0.61, 0.04);
    // кожа натянута над отломком — только при смещении
    expect(ps.filter(p => p.truth.findings.some(f => f.f === 'sign.clavicle_skin_tenting')).every(p => p.truth.conditions[0].params.displacement === 'displaced')).toBe(true);
  });

  test('расспрос о травме не выдумывает травму: у тех, кто пришёл без неё, жалобы травмы нет', () => {
    const TRAUMA = ['sym.wrist_pain', 'sym.ankle_pain', 'sym.foot_pain', 'sym.hip_pain', 'sym.shoulder_pain'];
    const ps = Array.from({ length: 600 }, (_, i) => generatePatient(db, 7000 + i, { department: 'dept.therapy', departments: ['dept.therapy'], season: 'winter' }));
    const told = ps.flatMap(p => runExam(db, p, 'exam.ask_injury', Rng.seeded(p.seed).fork('ask')).filter(o => o.shown && TRAUMA.includes(o.f)));
    expect(told).toEqual([]);
  });
});

describe('операция по скрытому параметру', () => {
  test('шейка бедра: без смещения — винты, со смещением — эндопротез; другая — «можно также»', () => {
    expect(surgeryFor(db, HIP, { displacement: 'none' })).toBe('tx.hip_screws');
    expect(surgeryFor(db, HIP, { displacement: 'displaced' })).toBe('tx.hip_arthroplasty');
    expect(surgeryFor(db, HIP)).toBe('tx.hip_arthroplasty');
    expect(surgeriesOf(db, HIP)).toEqual(['tx.hip_arthroplasty', 'tx.hip_screws']);
    expect(txRole(db, HIP, 'tx.hip_screws', { displacement: 'none', side: 'left' })).toBe('firstLine');
    expect(txRole(db, HIP, 'tx.hip_arthroplasty', { displacement: 'none', side: 'left' })).toBe('acceptable');
    expect(txRole(db, HIP, 'tx.hip_arthroplasty', { displacement: 'displaced', side: 'left' })).toBe('firstLine');
    expect(txRole(db, HIP, 'tx.hip_screws', { displacement: 'displaced', side: 'left' })).toBe('acceptable');
    // без значений (статья лечения) — обе свои
    expect(txRole(db, HIP, 'tx.hip_screws')).toBe('firstLine');
    // срок — 48 ч после поступления, всем — операция; смещение уточняет снимок
    expect(db.conditions[HIP].surgery).toMatchObject({ window: 48 });
    expect(tacticParams(db, HIP)).toEqual(['displacement']);
  });

  test('в смене — операция по тому, что показал снимок', () => {
    const p = elderly(HIP, 1, 31, { displacement: 'none', side: 'right' })[0];
    const H = 'exam.xray_hip';
    const patient = (obs: Observation[]) => ({ patient: p, results: obs.length ? [{ exam: H, at: 0, step: 1, obs }] : [] }) as unknown as ShiftPatient;
    expect(operationOf(db, patient([]), HIP)).toBe('tx.hip_arthroplasty');
    expect(operationOf(db, patient([xr(H, 'img.xr_femoral_neck_fracture', true), xr(H, 'img.xr_femoral_neck_displaced', false)]), HIP)).toBe('tx.hip_screws');
    expect(operationOf(db, patient([xr(H, 'img.xr_femoral_neck_fracture', true), xr(H, 'img.xr_femoral_neck_displaced', true)]), HIP)).toBe('tx.hip_arthroplasty');
  });

  test('«виртуальный врач» не оперирует шейку бедра без снимка: смещение решает, какая операция', () => {
    const ps = elderly(HIP, 40, 500);
    for (const p of ps) {
      const r = runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 });
      if (r.plan.setting === 'surgery') expect(r.exams).toContain('exam.xray_hip');
    }
    expect(share(ps, p => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 }).exams.includes('exam.xray_hip'))).toBeGreaterThan(0.95);
  });
});

describe('место по параметру: что тоже не ошибка', () => {
  test('ключица со смещением — операция, но повязка дома тоже можно; без смещения операция — больше нужного', () => {
    const [displaced] = people(CLAVICLE, 1, 41, { displacement: 'displaced', side: 'left' });
    const [none] = people(CLAVICLE, 1, 42, { displacement: 'none', side: 'left' });
    expect(recommendedSetting(db, displaced)).toBe('surgery');
    expect(alsoSettings(db, displaced)).toEqual(['home']);
    expect(settingFit('surgery', 'home', alsoSettings(db, displaced))).toBe('ok');
    expect(settingFit('surgery', 'home')).toBe('under');
    expect(evaluatePlan(db, displaced, { treatments: ['tx.arm_sling'], setting: 'home' }, []).setting).toEqual({ chosen: 'home', recommended: 'surgery', also: ['home'] });
    // кожа натянута над отломком — красный флаг, угроза перфорации: только операция (853_1, раздел 6)
    const tenting: Patient = { ...displaced, truth: { ...displaced.truth, findings: [...displaced.truth.findings, { f: 'sign.clavicle_skin_tenting', cause: CLAVICLE }] } };
    expect(recommendedSetting(db, tenting)).toBe('surgery');
    expect(alsoSettings(db, tenting)).toEqual([]);
    expect(evaluatePlan(db, tenting, { treatments: ['tx.arm_sling'], setting: 'home' }, []).setting).toEqual({ chosen: 'home', recommended: 'surgery' });
    expect(recommendedSetting(db, none)).toBe('home');
    expect(alsoSettings(db, none)).toEqual([]);
    expect(settingFit('home', 'surgery', alsoSettings(db, none))).toBe('over');
    // повязка при смещении — не ошибка, но и не лечение выбора
    expect(txRole(db, CLAVICLE, 'tx.arm_sling', displaced.truth.conditions[0].params)).toBe('acceptable');
    expect(txRole(db, CLAVICLE, 'tx.arm_sling', none.truth.conditions[0].params)).toBe('firstLine');
  });

  test('основание пятой плюсневой: план по снимку — обувь дома, значительное смещение — операция', () => {
    const F = 'exam.xray_foot';
    const plain = [xr(F, 'img.xr_mt5_fracture', true), xr(F, 'img.xr_mt5_displaced', false)];
    expect(likelyParams(db, MT5, plain, 40).displacement).toBe('none');
    expect(choosePlan(db, MT5, plain, 40)).toEqual({ treatments: ['tx.ibuprofen', 'tx.rigid_shoe'], setting: 'home' });
    const displaced = [xr(F, 'img.xr_mt5_fracture', true), xr(F, 'img.xr_mt5_displaced', true)];
    expect(choosePlan(db, MT5, displaced, 40, { ward: true, or: true }).setting).toBe('surgery');
  });
});

describe('оттавские правила для стопы', () => {
  const rule = db.rules['rule.ottawa_foot'];
  test('запись: жалоба на стопу, три признака, снимок стопы, с 18 лет; источники', () => {
    expect(rule).toMatchObject({ complaints: ['sym.foot_pain'], any: ['sign.mt5_tenderness', 'sign.navicular_tenderness', 'sign.no_weight_bearing'], exams: ['exam.xray_foot'], ageMin: 18 });
    expect(rule.sources.map(s => s.url)).toEqual(expect.arrayContaining(['https://cr.minzdrav.gov.ru/view-cr/832_2', 'https://cr.minzdrav.gov.ru/view-cr/856_1']));
  });

  test('«Студенту» в карте: «снимок стопы нужен» с признаком; без признаков — можно не делать', () => {
    const p = people(FOOT, 1, 51)[0];
    const view = (obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: obs.length ? [{ exam: 'exam.foot_exam', step: 1, at: 600, obs }] : [], pending: [], meanwhile: [], done: obs.length ? ['exam.foot_exam'] : [],
      draft: { treatments: [], setting: 'home' }, departments: ED,
    }).rules;
    const exam = (f: Id, shown: boolean): Observation => ({ f, shown, exam: 'exam.foot_exam' });
    expect(view([])[0].text).toContain('Проверьте: болезненность у основания пятой плюсневой кости, болезненность ладьевидной кости, не может пройти четыре шага');
    expect(view([exam('sign.mt5_tenderness', true), exam('sign.navicular_tenderness', false), exam('sign.no_weight_bearing', false)])[0].text).toBe('Снимок стопы нужен: болезненность у основания пятой плюсневой кости');
    expect(view([exam('sign.mt5_tenderness', false), exam('sign.navicular_tenderness', false), exam('sign.no_weight_bearing', false)])[0].text).toBe(rule.texts.no.ru);
  });

  test('«виртуальный врач»: ушиб стопы без признаков правил — без снимка', () => {
    const runs = people(FOOT, 200, 600).map(p => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 }));
    const seen = (r: (typeof runs)[number], f: Id) => r.observations.some(o => o.f === f && o.shown);
    const quiet = runs.filter(r => r.exams.includes('exam.foot_exam') && !rule.any.some(f => seen(r, f)));
    expect(quiet.length).toBeGreaterThan(20);
    expect(share(quiet, r => !r.exams.includes('exam.xray_foot'))).toBeGreaterThan(0.9);
  });
});

describe('снимок кости в карте', () => {
  const view = (patient: Patient, exam: Id, obs: Observation[]) => makeCaseView({
    version: 0, patient, clock: 600, minutesSpent: 0, money: 0, step: 1,
    arrived: [{ exam, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [exam],
    draft: { treatments: [], setting: 'home' }, departments: ED,
  }).groups.find(g => g.exam === exam)!.image;

  test('стопа, бедро, ключица — вид, место, смещение и сторона', () => {
    const f = people(MT5, 1, 61, { displacement: 'displaced', side: 'left' })[0];
    expect(view(f, 'exam.xray_foot', [xr('exam.xray_foot', 'img.xr_mt5_fracture', true), xr('exam.xray_foot', 'img.xr_mt5_displaced', true)]))
      .toMatchObject({ kind: 'bone', view: 'foot', side: 'left', fractures: [{ site: 'mt5', displacement: 0.6 }] });
    const h = elderly(HIP, 1, 62, { displacement: 'none', side: 'right' })[0];
    expect(view(h, 'exam.xray_hip', [xr('exam.xray_hip', 'img.xr_femoral_neck_fracture', true), xr('exam.xray_hip', 'img.xr_femoral_neck_displaced', false)]))
      .toMatchObject({ kind: 'bone', view: 'hip', side: 'right', fractures: [{ site: 'femoral_neck', displacement: 0 }] });
    const c = people(CLAVICLE, 1, 63, { displacement: 'displaced', side: 'left' })[0];
    expect(view(c, 'exam.xray_clavicle', [xr('exam.xray_clavicle', 'img.xr_clavicle_fracture', true), xr('exam.xray_clavicle', 'img.xr_clavicle_displaced', true)]))
      .toMatchObject({ kind: 'bone', view: 'clavicle', side: 'left', fractures: [{ site: 'clavicle', displacement: 0.9 }] });
  });
});

describe('энциклопедия', () => {
  test('шейка бедра: операция по смещению и срок; ключица: «можно и дома»; правило стопы — в «Шкалах и правилах»', () => {
    const hip = article(db, HIP)!;
    const where = hip.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toContain('Операция — эндопротезирование тазобедренного сустава: в первые 48 ч после поступления.');
    expect(where).toContain('Без смещения — остеосинтез шейки бедра винтами.');
    expect(JSON.stringify(hip.blocks.find(b => b.key === 'treatment'))).toContain('Операция, без смещения');
    // статья операции по параметру — что ею лечат, со сроком
    expect(JSON.stringify(article(db, 'tx.hip_screws')!.blocks.find(b => b.key === 'treats'))).toContain(HIP);
    expect(article(db, CLAVICLE)!.blocks.find(b => b.key === 'where')!.text).toContain('При смещении без красных флагов — можно и дома.');
    expect(article(db, 'rule.ottawa_foot')).toMatchObject({ section: 'scores', title: 'Оттавские правила для стопы' });
    expect(JSON.stringify(article(db, MT5)!.blocks.find(b => b.key === 'rules'))).toContain('rule.ottawa_foot');
  });
});
