// Прободная язва, язвенное кровотечение, ущемлённая грыжа и обзорный снимок живота (spec
// 2026-09-chapter-2, часть 30б): кто болеет и что у него находят, где лечить, операции — срок,
// давняя перфорация по сроку и смертность по часам ожидания, энциклопедия, картинка снимка.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { generatePatient } from '../../src/engine/med/generate';
import { recommendedSetting } from '../../src/engine/med/plan';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, newSandbox } from '../../src/engine/shift/engine';
import { complicationAt, deathsOf, onsetHours } from '../../src/engine/shift/surgery';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { makeCaseView, noteText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const BOTH = ['dept.therapy', 'dept.surgery'];
const NEW = ['cond.perforated_ulcer', 'cond.ulcer_bleeding', 'cond.strangulated_hernia'];
const people = (n: number, primary: Id, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: BOTH, season: 'winter', primary }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const share = (xs: Patient[], ok: (p: Patient) => boolean) => xs.filter(ok).length / xs.length;

/** Песочница с палатой и операционной (как в surgery.test.ts): бригада навыка 3. */
function withOr(seed = 31) {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ward', size: 'M', x: 29, y: 0, rot: 0 } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.or', size: 'M', x: 29, y: 10, rot: 2 } });
  const ward = s.hospital!.rooms.find(r => r.type === 'room.ward')!.id;
  const or = s.hospital!.rooms.find(r => r.type === 'room.or')!.id;
  for (const equipment of ['eq.or_table', 'eq.anesthesia']) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: or, equipment } });
  apply(db, s, { kind: 'buildEnd' });
  const nurse = s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!;
  apply(db, s, { kind: 'assign', id: nurse.id, room: ward });
  ['role.surgeon', 'role.anesthetist', 'role.or_nurse'].forEach((role, i) => {
    const m: StaffMember = { id: `t${i + 1}`, role, sex: i % 2 === 0 ? 'm' : 'f', seed: 100 + i, skill: 3, salary: salaryOf(db, role, 3), days: 0 };
    s.staff = [...s.staff!, m];
    apply(db, s, { kind: 'assign', id: m.id, room: or });
  });
  return { s, or };
}

/** Первого в очереди подменить пациентом с нужной болезнью, позвать, измерить витальные и назвать диагноз. */
function treatWith(s: ShiftState, patient: Patient, dx: Id): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const p = s.patients[s.queue[0]];
  p.patient = patient;
  p.departments = [...BOTH];
  apply(db, s, { kind: 'call', id: p.id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'diagnose', id: dx });
  return p;
}

describe('кто болеет и что находят', () => {
  test('три новые болезни — хирургия приёмного: в амбулатории их нет', () => {
    expect(candidatesOf(db, BOTH)).toEqual(expect.arrayContaining(NEW));
    expect(candidatesOf(db, 'dept.therapy').some(id => NEW.includes(id))).toBe(false);
    for (const id of NEW) expect(db.conditions[id]).toMatchObject({ department: 'dept.surgery', system: 'digestive', severity: 'critical' });
  });

  test('прободная язва: газ в животе у каждого, «кинжальная» боль — у большинства; мужчин вдвое больше (277_2, раздел 1.3)', () => {
    const ps = people(300, 'cond.perforated_ulcer');
    expect(ps.every(p => has(p, 'img.xr_free_gas'))).toBe(true);
    expect(share(ps, p => has(p, 'sym.dagger_pain'))).toBeGreaterThan(0.85);
    expect(db.conditions['cond.perforated_ulcer'].sex).toEqual({ m: 1, f: 0.5 });
    // на снимке газ находят не у всех: 57 % — середина 30–85 % (277_2, раздел 2.4; WSES 2020)
    const check = db.exams['exam.xray_abdomen'].checks.find(k => k.f === 'img.xr_free_gas')!;
    expect(check.sens).toBe(5700);
  });

  test('ущемлённая грыжа: почти только мужчины (684_2: 82,6 %); с непроходимостью у 14,3 % (Ge 2010) — газы не отходят, на снимке уровни', () => {
    expect(db.conditions['cond.strangulated_hernia'].sex).toEqual({ m: 1, f: 0.21 });
    const ps = people(600, 'cond.strangulated_hernia');
    const obstructed = ps.filter(p => p.truth.conditions[0].params.obstruction === 'yes');
    expect(obstructed.length / ps.length).toBeGreaterThan(0.1);
    expect(obstructed.length / ps.length).toBeLessThan(0.19);
    expect(obstructed.every(p => has(p, 'img.xr_bowel_levels'))).toBe(true);
    expect(share(obstructed, p => has(p, 'sym.no_stool_gas'))).toBeGreaterThan(0.6);
    expect(share(ps.filter(p => !obstructed.includes(p)), p => has(p, 'img.xr_bowel_levels'))).toBeLessThan(0.04);
    // ущемление есть у каждого; найдёт ли его врач — чувствительность осмотра грыжевых ворот
    expect(ps.every(p => has(p, 'sign.hernia_strangulated'))).toBe(true);
    expect(db.exams['exam.hernia_check'].checks).toEqual([expect.objectContaining({ f: 'sign.hernia_strangulated', sens: 8300, spec: 9300 })]);
  });

  test('язвенное кровотечение: рвота кровью или мелена — у девяти из десяти; жалоба — красная', () => {
    const ps = people(300, 'cond.ulcer_bleeding');
    expect(share(ps, p => has(p, 'sym.hematemesis') || has(p, 'sym.melena'))).toBeGreaterThan(0.88);
    expect(db.findings['sym.hematemesis']).toMatchObject({ triage: 'red', redFlag: true });
    expect(db.findings['sym.dagger_pain']).toMatchObject({ triage: 'red', redFlag: true });
  });
});

describe('где лечить', () => {
  test('прободная язва и ущемлённая грыжа — операция, кровотечение — перевод: эндоскопии нет', () => {
    expect(recommendedSetting(db, people(1, 'cond.perforated_ulcer')[0])).toBe('surgery');
    expect(recommendedSetting(db, people(1, 'cond.strangulated_hernia')[0])).toBe('surgery');
    expect(recommendedSetting(db, people(1, 'cond.ulcer_bleeding')[0])).toBe('transfer');
    expect(db.conditions['cond.perforated_ulcer'].surgery).toEqual({ tx: 'tx.ulcer_suture', window: 2 });
    expect(db.conditions['cond.strangulated_hernia'].surgery).toEqual({ tx: 'tx.hernia_repair', window: 2 });
  });

  test('при кровотечении НПВП — вред (277_2, раздел 3.3), ИПН — допустимо; консервативно прободную язву не лечат', () => {
    const bleeding = db.conditions['cond.ulcer_bleeding'].treatment!;
    expect(bleeding.harmful).toEqual(['tx.ibuprofen']);
    expect(bleeding.acceptable).toEqual(['tx.ppi']);
    expect(db.conditions['cond.perforated_ulcer'].treatment!.notIndicated).toContain('tx.ppi');
  });
});

describe('операции: срок, давняя перфорация и часы ожидания', () => {
  test('ушивание: 1,5 % в первый час; каждый полный час от поступления — выживших на 2,4 % меньше, чем часом раньше (Buck 2013)', () => {
    expect(deathsOf(db, 'tx.ulcer_suture', false, 0)).toBe(150);
    expect(deathsOf(db, 'tx.ulcer_suture', false, 0.99)).toBe(150);
    expect(deathsOf(db, 'tx.ulcer_suture', false, 1)).toBe(Math.round((1 - 0.985 * 0.976) * 10000));
    expect(deathsOf(db, 'tx.ulcer_suture', false, 5.5)).toBe(Math.round((1 - 0.985 * 0.976 ** 5) * 10000));
    // давняя перфорация — 14,4 % по шкале Boey (277_2, Прил. Г8), и тоже с часами ожидания
    expect(deathsOf(db, 'tx.ulcer_suture', true, 0)).toBe(1440);
    expect(deathsOf(db, 'tx.ulcer_suture', true, 2)).toBe(Math.round((1 - 0.856 * 0.976 ** 2) * 10000));
    // у операций без этого поля часы не считаются
    expect(deathsOf(db, 'tx.appendectomy', false, 10)).toBe(deathsOf(db, 'tx.appendectomy', false, 0));
    expect(deathsOf(db, 'tx.hernia_repair', false, 10)).toBe(173);
  });

  test('давняя перфорация — по сроку: через 24 ч от начала болезни, у всех одинаково; у аппендицита — по риску, как было', () => {
    for (const p of people(20, 'cond.perforated_ulcer')) expect(complicationAt(db, p)).toBe(24);
    const appendix = people(20, 'cond.appendicitis').map(p => complicationAt(db, p));
    expect(new Set(appendix).size).toBeGreaterThan(10);
    expect(db.conditions['cond.perforated_ulcer'].complication).toEqual({ name: { ru: 'давняя перфорация' }, after: 24 });
  });

  test('с «кинжальной» болью приходят в первые сутки; ушивание сразу — в срок до 2 ч, 75 минут, без давней перфорации', () => {
    const ps = people(60, 'cond.perforated_ulcer');
    expect(ps.every(p => onsetHours(p) < 24)).toBe(true);
    const { s, or } = withOr(41);
    apply(db, s, { kind: 'nextDay' });
    const patient = ps.find(p => !p.truth.risks.some(r => r.startsWith('risk.allergy_')) && onsetHours(p) < 12)!;
    const p = treatWith(s, patient, 'cond.perforated_ulcer');
    apply(db, s, { kind: 'setting', setting: 'surgery' });
    apply(db, s, { kind: 'finish' });
    expect(p.stay!.op).toMatchObject({ tx: 'tx.ulcer_suture', room: or });
    apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
    expect(p.stay!.op!.end! - p.stay!.op!.start!).toBe(75 * 60);
    expect(p.stay!.op!.complicated).toBeFalsy();
    const note = p.closed!.notes.find(n => n.code === 'op.onTime')!;
    expect(note).toMatchObject({ code: 'op.onTime', tx: 'tx.ulcer_suture', window: 2 });
    expect(noteText(note)).toContain('после поступления: в срок, до 2');
    expect(p.closed!.notes.some(n => n.code === 'op.complicated')).toBe(false);
  });
});

describe('энциклопедия и снимок', () => {
  test('у прободной язвы — срок давней перфорации; у ушивания — исходы и цена каждого часа ожидания', () => {
    const cond = JSON.stringify(article(db, 'cond.perforated_ulcer')!);
    expect(cond).toContain(T.encyclopedia.complicationAfter('давняя перфорация', 24));
    expect(cond).toContain(T.encyclopedia.whereSurgery('Ушивание прободной язвы', 2));
    const outcomes = article(db, 'tx.ulcer_suture')!.blocks.find(b => b.key === 'outcomes')!.text!;
    expect(outcomes).toEqual([
      T.encyclopedia.opComplications('40', '40', 'давняя перфорация'),
      T.encyclopedia.opDeaths('1,5', '14,4', 'давняя перфорация'),
      T.encyclopedia.opDelay('2,4'),
    ]);
    expect(outcomes[2]).toBe('Каждый час от поступления до операции выживаемость ниже на 2,4 %.');
    // у грыжесечения часов ожидания нет
    expect(JSON.stringify(article(db, 'tx.hernia_repair')!)).not.toContain('Каждый час');
  });

  test('обзорный снимок — картинкой: серп газа и уровни — если их показал снимок', () => {
    const p = people(1, 'cond.perforated_ulcer')[0];
    const view = (obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: [{ exam: 'exam.xray_abdomen', step: 1, at: 600, obs }], pending: [], meanwhile: [], done: ['exam.xray_abdomen'],
      draft: { treatments: [], setting: 'home' }, departments: BOTH,
    }).groups.find(g => g.exam === 'exam.xray_abdomen')!.image;
    const xr = (f: string, shown: boolean): Observation => ({ f, shown, exam: 'exam.xray_abdomen' });
    expect(view([xr('img.xr_free_gas', true), xr('img.xr_bowel_levels', false)])).toMatchObject({ kind: 'abdomen', freeGas: true, levels: false });
    expect(view([xr('img.xr_free_gas', false), xr('img.xr_bowel_levels', true)])).toMatchObject({ kind: 'abdomen', freeGas: false, levels: true });
    expect(view([xr('img.xr_free_gas', false), xr('img.xr_bowel_levels', false)])).toMatchObject({ kind: 'abdomen', freeGas: false, levels: false });
  });
});
