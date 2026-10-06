// Закрытая травма груди (spec 2026-09-chapter-2, часть 32в): ушиб грудной клетки, перелом рёбер
// (сколько рёбер — скрытый параметр), травматический пневмоторакс (малый, большой, напряжённый) и
// гемоторакс (средний и большой); место и тактика по параметру; «виртуальный врач»; снимок груди
// с воздухом, кровью и переломом и снимок рёбер в карте; энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { evaluatePlan, recommendedSetting, settingFit, txRole } from '../../src/engine/med/plan';
import { indicated, runDoctor } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { fracturedRibs } from '../../src/render/xray/chestGeometry';
import { makeCaseView } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const CONTUSION = 'cond.chest_contusion';
const RIBS = 'cond.rib_fracture';
const PT = 'cond.traumatic_pneumothorax';
const HT = 'cond.traumatic_hemothorax';
const NEW = [CONTUSION, RIBS, PT, HT];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const people = (primary: Id, n: number, from = 1, params?: Record<string, string>) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'winter', primary, ...(params ? { params } : {}) }));
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const param = (p: Patient, name: string) => p.truth.conditions[0].params[name];
/** у заданной болезни пол и возраст не выбираются — доля по весам генератора */
const weight = (id: Id, sex: 'm' | 'f', age = 60) => presentingWeight(db.conditions[id], { age, sex, season: 'winter', risks: [], chronic: [] });
const maleShare = (id: Id) => weight(id, 'm') / (weight(id, 'f') + weight(id, 'm'));
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();
const doctor = (p: Patient) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 });

describe('кто болеет и что находят', () => {
  test('четыре новых — отделение травмы, только с приёмным; ушиб и переломы — «кости и суставы», воздух и кровь — «лёгкие»', () => {
    for (const id of NEW) {
      expect(db.conditions[id].department).toBe('dept.trauma');
      expect(candidates).toContain(id);
      expect(candidatesOf(db, 'dept.therapy')).not.toContain(id);
    }
    expect([CONTUSION, RIBS].map(id => db.conditions[id].system)).toEqual(['bones', 'bones']);
    expect([PT, HT].map(id => db.conditions[id].system)).toEqual(['lungs', 'lungs']);
  });

  test('перелом рёбер: одно-два — 60 %, три и больше — 37 %, клапан — 3 %; мужчин — 68 % (Peek 2022: 67,8 %)', () => {
    const ps = people(RIBS, 3000, 1);
    near(share(ps, p => param(p, 'ribs') === 'one_two'), 0.6, 0.03);
    near(share(ps, p => param(p, 'ribs') === 'three_plus'), 0.37, 0.03);
    near(share(ps, p => param(p, 'ribs') === 'flail'), 0.03, 0.012);
    near(maleShare(RIBS), 0.678, 0.01);
    // клапан — парадоксальное движение стенки почти всегда (95 %), у остальных — никогда
    expect(share(ps.filter(p => param(p, 'ribs') === 'flail'), p => has(p, 'sign.paradoxical_breathing'))).toBeGreaterThan(0.85);
    expect(ps.filter(p => param(p, 'ribs') !== 'flail').some(p => has(p, 'sign.paradoxical_breathing'))).toBe(false);
    // три ребра и больше — на снимке у каждого (увидит ли снимок — его чувствительность)
    expect(ps.filter(p => param(p, 'ribs') !== 'one_two').every(p => has(p, 'img.xr_rib_multiple'))).toBe(true);
    expect(ps.filter(p => param(p, 'ribs') === 'one_two').some(p => has(p, 'img.xr_rib_multiple'))).toBe(false);
  });

  test('ушиб: симптома прерванного вдоха, крепитации и ступеньки не бывает (728_2, раздел 1.6); перелома на снимке нет', () => {
    const ps = people(CONTUSION, 500, 101);
    for (const f of ['sign.interrupted_inspiration', 'sign.rib_crepitus', 'img.xr_rib_fracture']) expect(ps.some(p => has(p, f))).toBe(false);
    expect(share(ps, p => has(p, 'sign.chest_wall_tenderness'))).toBeGreaterThan(0.9);
  });

  test('пневмоторакс: напряжённый — 7 % (728_2, раздел 1.3), у него шейные вены набухают часто, средостение смещено у каждого; воздух на снимке у всех', () => {
    const ps = people(PT, 3000, 201);
    near(share(ps, p => param(p, 'size') === 'tension'), 0.07, 0.015);
    near(share(ps, p => param(p, 'size') === 'small'), 0.4, 0.03);
    const tension = ps.filter(p => param(p, 'size') === 'tension');
    expect(tension.every(p => has(p, 'img.cxr_mediastinal_shift') && has(p, 'img.cxr_pneumothorax_large'))).toBe(true);
    expect(share(tension, p => has(p, 'sign.neck_veins_distended'))).toBeGreaterThan(0.65);
    expect(ps.filter(p => param(p, 'size') !== 'tension').some(p => has(p, 'img.cxr_mediastinal_shift'))).toBe(false);
    expect(ps.every(p => has(p, 'img.cxr_pneumothorax'))).toBe(true);
    expect(ps.filter(p => param(p, 'size') === 'small').some(p => has(p, 'img.cxr_pneumothorax_large'))).toBe(false);
  });

  test('гемоторакс: большой — 10 %, у него затенение выше угла лопатки у каждого, у среднего — никогда; воздух над кровью — часто', () => {
    const ps = people(HT, 2000, 301);
    near(share(ps, p => param(p, 'volume') === 'massive'), 0.1, 0.02);
    expect(ps.filter(p => param(p, 'volume') === 'massive').every(p => has(p, 'img.cxr_hemothorax_large'))).toBe(true);
    expect(ps.filter(p => param(p, 'volume') === 'moderate').some(p => has(p, 'img.cxr_hemothorax_large'))).toBe(false);
    expect(ps.every(p => has(p, 'img.cxr_hemothorax'))).toBe(true);
    near(share(ps, p => has(p, 'img.cxr_pneumothorax')), 0.5, 0.1);
  });
});

describe('место и тактика по параметру', () => {
  test('рёбра: одно-два — дома, три и больше — стационар, клапан — перевод в торакальное отделение (728_2, раздел 6)', () => {
    const [one] = people(RIBS, 1, 401, { ribs: 'one_two', side: 'right' });
    const [three] = people(RIBS, 1, 402, { ribs: 'three_plus', side: 'right' });
    const [flail] = people(RIBS, 1, 403, { ribs: 'flail', side: 'right' });
    expect([one, three, flail].map(p => recommendedSetting(db, p))).toEqual(['home', 'ward', 'transfer']);
    // своя палата закрывает стационар, но не торакальное отделение
    expect(settingFit('ward', 'admit')).toBe('ok');
    expect(settingFit('transfer', 'admit')).toBe('under');
    // обезболивание — первая линия, блокада — облегчает при трёх и больше, тугое бинтование — вредно
    expect(txRole(db, RIBS, 'tx.ibuprofen', one.truth.conditions[0].params)).toBe('firstLine');
    expect(txRole(db, RIBS, 'tx.rib_block', three.truth.conditions[0].params)).toBe('supportive');
    for (const id of [RIBS, PT, HT]) expect(txRole(db, id, 'tx.chest_binding')).toBe('harmful');
    expect(txRole(db, CONTUSION, 'tx.chest_binding')).toBe('notIndicated');
  });

  test('пневмоторакс: малый — наблюдение, дренаж «можно»; большой — дренаж; напряжённый — срочно, своя палата с дренажом тоже закрывает', () => {
    const [small] = people(PT, 1, 411, { size: 'small', side: 'left' });
    const [large] = people(PT, 1, 412, { size: 'large', side: 'left' });
    const [tension] = people(PT, 1, 413, { size: 'tension', side: 'left' });
    expect([small, large, tension].map(p => recommendedSetting(db, p))).toEqual(['ward', 'ward', 'ambulance']);
    expect(txRole(db, PT, 'tx.pleural_drainage', small.truth.conditions[0].params)).toBe('acceptable');
    expect(txRole(db, PT, 'tx.pleural_drainage', large.truth.conditions[0].params)).toBe('firstLine');
    expect(settingFit('ambulance', 'admit')).toBe('ok');
    const ev = evaluatePlan(db, tension, { treatments: ['tx.ibuprofen', 'tx.pleural_drainage'], setting: 'admit' }, []);
    expect(ev.effective).toBe(true);
    expect(settingFit(ev.setting.recommended, ev.setting.chosen)).toBe('ok');
  });

  test('гемоторакс: средний — дренаж или пункция, торакотомия не нужна; большой — торакотомия', () => {
    const [moderate] = people(HT, 1, 421, { volume: 'moderate', side: 'right' });
    const [massive] = people(HT, 1, 422, { volume: 'massive', side: 'right' });
    expect([moderate, massive].map(p => recommendedSetting(db, p))).toEqual(['ward', 'surgery']);
    const role = (p: Patient, tx: Id) => txRole(db, HT, tx, p.truth.conditions[0].params);
    expect([role(moderate, 'tx.pleural_drainage'), role(moderate, 'tx.pleural_puncture'), role(moderate, 'tx.thoracotomy')]).toEqual(['firstLine', 'acceptable', 'notIndicated']);
    expect([role(massive, 'tx.thoracotomy'), role(massive, 'tx.pleural_drainage'), role(massive, 'tx.pleural_puncture')]).toEqual(['firstLine', 'supportive', 'notIndicated']);
    expect(db.conditions[HT].surgery).toMatchObject({ tx: 'tx.thoracotomy' });
    expect(db.conditions[HT].surgery?.window).toBeUndefined();
  });
});

describe('«виртуальный врач»', () => {
  test('воздух и кровь — снимок груди почти всем; перелом рёбер — снимок груди или рёбер; без снимка не дренирует', () => {
    const air = [...people(PT, 60, 601), ...people(HT, 60, 701)].map(doctor);
    expect(share(air, r => r.exams.includes('exam.xray_chest'))).toBeGreaterThan(0.95);
    // пункцию и дренирование не выполняют, не убедившись в характере содержимого плевральной полости (728_2, раздел 2.4)
    for (const r of air) if (r.plan.treatments.some(tx => tx === 'tx.pleural_drainage' || tx === 'tx.pleural_puncture')) expect(r.exams).toContain('exam.xray_chest');
    const ribs = people(RIBS, 60, 501).map(doctor);
    expect(share(ribs, r => r.exams.includes('exam.xray_chest') || r.exams.includes('exam.xray_ribs'))).toBeGreaterThan(0.95);
  });

  test('снимок груди — каждому с закрытой травмой груди, и при ушибе (728_2, раздел 2.4); страховая его оплачивает', () => {
    // с частью 43д — и при боли, которая легче сидя с наклоном вперёд: снимок при подозрении на перикардит (746_2)
    expect(db.exams['exam.xray_chest'].routineFor).toEqual(['sym.chest_injury_pain', 'sym.pericardial_pain']);
    for (const id of NEW) {
      for (const p of people(id, 20, 1301)) {
        expect(doctor(p).exams).toContain('exam.xray_chest');
        expect(indicated(db, p, [], candidates, 'exam.xray_chest')).toBe(true);
      }
    }
  });

  test('три ребра и больше не отпускает домой, если снимок их сосчитал; гемоторакс не оперирует без снимка', () => {
    const three = people(RIBS, 60, 901, { ribs: 'three_plus', side: 'left' }).map(doctor);
    const counted = three.filter(r => r.observations.some(o => o.f === 'img.xr_rib_multiple' && o.shown));
    expect(counted.length).toBeGreaterThan(20);
    expect(share(counted, r => r.plan.setting !== 'home')).toBeGreaterThan(0.9);
    for (const r of people(HT, 60, 1001).map(doctor)) if (r.plan.setting === 'surgery') expect(r.exams).toContain('exam.xray_chest');
  });
});

describe('снимки в карте', () => {
  const view = (patient: Patient, exam: Id, obs: Observation[]) => makeCaseView({
    version: 0, patient, clock: 600, minutesSpent: 0, money: 0, step: 1,
    arrived: [{ exam, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [exam],
    draft: { treatments: [], setting: 'home' }, departments: ED,
  }).groups.find(g => g.exam === exam)!;
  const cxr = (f: Id, shown: boolean, side?: 'right' | 'left'): Observation => ({ f, shown, exam: 'exam.xray_chest', ...(side ? { attrs: { side } } : {}) });

  test('снимок груди: воздух, кровь со смещением, переломы — сторона из находки; номера рёбер — те же, что на снимке рёбер', () => {
    const [p] = people(PT, 1, 1101, { size: 'tension', side: 'left' });
    expect(view(p, 'exam.xray_chest', [cxr('img.cxr_pneumothorax', true, 'left'), cxr('img.cxr_pneumothorax_large', true), cxr('img.cxr_mediastinal_shift', true)]).image)
      .toMatchObject({ kind: 'xray', pneumothorax: { side: 'left', size: 'large', tension: true } });
    const [h] = people(HT, 1, 1102, { volume: 'massive', side: 'right' });
    expect(view(h, 'exam.xray_chest', [cxr('img.cxr_hemothorax', true, 'right'), cxr('img.cxr_hemothorax_large', true), cxr('img.cxr_mediastinal_shift', true), cxr('img.cxr_pneumothorax', false)]).image)
      .toMatchObject({ kind: 'xray', effusion: { side: 'right', massive: true } });
    const [air] = people(HT, 1, 1103, { volume: 'moderate', side: 'left' });
    expect(view(air, 'exam.xray_chest', [cxr('img.cxr_hemothorax', true, 'left'), cxr('img.cxr_pneumothorax', true, 'left')]).image)
      .toMatchObject({ kind: 'xray', effusion: { side: 'left', air: true }, pneumothorax: { side: 'left', size: 'small' } });
    const [r] = people(RIBS, 1, 1104, { ribs: 'three_plus', side: 'right' });
    const film = view(r, 'exam.xray_chest', [cxr('img.xr_rib_fracture', true, 'right'), cxr('img.xr_rib_multiple', true)]).image;
    expect(film).toMatchObject({ kind: 'xray', ribFractures: { side: 'right', ribs: fracturedRibs(r.seed, true) } });
    const ribs = view(r, 'exam.xray_ribs', [{ f: 'img.xr_rib_fracture', shown: true, exam: 'exam.xray_ribs', attrs: { side: 'right' } }, { f: 'img.xr_rib_multiple', shown: true, exam: 'exam.xray_ribs' }]).image;
    expect(ribs).toMatchObject({ kind: 'bone', view: 'ribs', side: 'right' });
    if (ribs?.kind !== 'bone') throw new Error('нет снимка рёбер');
    expect((ribs.fractures ?? []).map(f => f.rib)).toEqual(fracturedRibs(r.seed, true));
  });

  test('уточнения, которых нет, отдельной строкой не пишутся: «средостение не смещено» — лишнее', () => {
    const [p] = people(CONTUSION, 1, 1201);
    const g = view(p, 'exam.xray_chest', [cxr('img.cxr_pneumothorax', false), cxr('img.cxr_mediastinal_shift', false), cxr('img.cxr_hemothorax', false), cxr('img.cxr_hemothorax_large', false)]);
    expect(g.lines.map(l => l.f)).toEqual(['img.cxr_pneumothorax', 'img.cxr_hemothorax']);
    expect(g.lines.map(l => l.text)).toEqual(['Пневмоторакса нет', 'Синусы свободны']);
  });
});

describe('энциклопедия', () => {
  test('где лечить — по параметру; лечение по параметру; обследования и лечения травмы груди', () => {
    const where = (id: Id) => article(db, id)!.blocks.find(b => b.key === 'where')!.text!;
    expect(where(RIBS)).toEqual(expect.arrayContaining(['Обычно — дома.', 'При переломе трёх и более рёбер — в стационаре.', 'При реберном клапане — скорая, перевод в центр.']));
    expect(where(PT)).toContain('При напряжённом пневмотораксе — скорая, больница.');
    expect(where(HT)).toEqual(expect.arrayContaining(['При большом гемотораксе — операция.', 'Операция — торакотомия, остановка кровотечения.']));
    expect(JSON.stringify(article(db, RIBS)!.blocks.find(b => b.key === 'treatment'))).toContain('Облегчить состояние, при переломе трёх и более рёбер и реберном клапане');
    for (const id of ['exam.xray_ribs', 'exam.chest_exam', 'tx.pleural_drainage', 'tx.pleural_puncture', 'tx.thoracotomy', 'tx.rib_block', 'tx.breathing_exercises', 'tx.chest_binding']) {
      expect(article(db, id)).toBeDefined();
    }
  });
});
