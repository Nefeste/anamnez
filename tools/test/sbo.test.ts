// Спаечная кишечная непроходимость (spec 2026-09-chapter-2, часть 30в): кто болеет и что находят,
// скрытая ишемия кишки, где лечить, неоперативное лечение в палате только без ишемии, срок операции
// экстренной и после наблюдения, некроз кишки при ишемии, стационар после операции, энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { generatePatient } from '../../src/engine/med/generate';
import { curesOf, evaluatePlan, primaryOf, recommendedSetting } from '../../src/engine/med/plan';
import type { Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, newSandbox } from '../../src/engine/shift/engine';
import { complicationAt, deathsOf, onsetHours } from '../../src/engine/shift/surgery';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { daysIn } from '../../src/engine/shift/ward';
import { T } from '../../src/i18n';
import { noteText } from '../../src/state/caseView';
import { article, whenText } from '../../src/state/encyclopedia';

const SBO = 'cond.adhesive_sbo';
const OP = 'tx.adhesiolysis';
const BOTH = ['dept.therapy', 'dept.surgery'];
const people = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: BOTH, season: 'winter', primary: SBO }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const share = (xs: Patient[], ok: (p: Patient) => boolean) => xs.filter(ok).length / xs.length;
const ischemic = (p: Patient) => primaryOf(p).params.ischemia === 'yes';
const noAllergy = (p: Patient) => !p.truth.risks.some(r => r.startsWith('risk.allergy_'));

/** Песочница с палатой и операционной (как в surgery.test.ts): бригада навыка 3. */
function withOr(seed: number) {
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
  apply(db, s, { kind: 'nextDay' });
  return { s, or };
}

/** Первого в очереди подменить больным, позвать, назвать диагноз, назначить лечение и место. */
function treat(s: ShiftState, patient: Patient, treatments: Id[], setting: 'admit' | 'surgery'): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const p = s.patients[s.queue[0]];
  p.patient = patient;
  p.departments = [...BOTH];
  apply(db, s, { kind: 'call', id: p.id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'diagnose', id: SBO });
  for (const tx of treatments) apply(db, s, { kind: 'toggleTreatment', id: tx });
  apply(db, s, { kind: 'setting', setting });
  apply(db, s, { kind: 'finish' });
  return p;
}

const night = (s: ShiftState) => {
  apply(db, s, { kind: 'closeDay' });
  apply(db, s, { kind: 'nextDay' });
};

describe('кто болеет и что находят', () => {
  test('хирургия приёмного: в амбулатории её нет; серьёзная, операция — рассечение спаек', () => {
    expect(candidatesOf(db, BOTH)).toContain(SBO);
    expect(candidatesOf(db, 'dept.therapy')).not.toContain(SBO);
    expect(db.conditions[SBO]).toMatchObject({ department: 'dept.surgery', system: 'digestive', severity: 'serious' });
    expect(db.conditions[SBO].surgery).toEqual({ tx: OP, window: 2, observe: 72, stay: [6, 10] });
  });

  test('ишемия кишки — у одного из десяти (Fevang 2002: 18 из 166); уровни в петлях — у каждого, операции в прошлом — у 85 %', () => {
    const ps = people(800);
    expect(share(ps, ischemic)).toBeGreaterThan(0.08);
    expect(share(ps, ischemic)).toBeLessThan(0.14);
    expect(ps.every(p => has(p, 'img.xr_bowel_levels'))).toBe(true);
    expect(share(ps, p => has(p, 'hx.abdominal_surgery'))).toBeGreaterThan(0.8);
    expect(share(ps, p => has(p, 'hx.abdominal_surgery'))).toBeLessThan(0.9);
    // у остальных операции в прошлом — 22 %: специфичность 78 % (327_3, раздел 2.1)
    expect(db.findings['hx.abdominal_surgery'].leak).toBe(2200);
    expect(share(ps, p => has(p, 'sym.colicky_pain'))).toBeGreaterThan(0.65);
    expect(share(ps, p => has(p, 'sym.abdominal_pain'))).toBeGreaterThan(0.9);
  });

  test('раздражение брюшины — у 48 % с ишемией и у 17 % без неё (Sarr 1983); лихорадка при ишемии — 3 % (327_3)', () => {
    const ps = people(1500);
    const yes = ps.filter(ischemic);
    const no = ps.filter(p => !ischemic(p));
    expect(share(yes, p => has(p, 'sign.peritoneal_signs'))).toBeGreaterThan(0.36);
    expect(share(yes, p => has(p, 'sign.peritoneal_signs'))).toBeLessThan(0.6);
    expect(share(no, p => has(p, 'sign.peritoneal_signs'))).toBeGreaterThan(0.13);
    expect(share(no, p => has(p, 'sign.peritoneal_signs'))).toBeLessThan(0.21);
    expect(share(yes, p => has(p, 'vital.fever'))).toBeLessThan(0.1);
  });
});

describe('где лечить и чем', () => {
  test('ишемия или раздражение брюшины — операция; остальные — в больницу, лечить в палате', () => {
    const ps = people(400);
    for (const p of ps) {
      const urgent = ischemic(p) || has(p, 'sign.peritoneal_signs');
      expect(recommendedSetting(db, p)).toBe(urgent ? 'surgery' : 'ambulance');
    }
    const t = db.conditions[SBO].treatment!;
    expect(t.firstLine).toEqual(['tx.iv_fluids']);
    expect(t.supportive).toEqual(['tx.ng_tube']);
    // антибиотики рутинно — нет (327_3, раздел 3.2); через рот — ничего (WSES 2017)
    expect(t.notIndicated).toEqual(expect.arrayContaining(['tx.amoxicillin_clavulanate', 'tx.ors']));
  });

  test('капельница действует на причину только без ишемии кишки; зонд — облегчает, на причину не действует', () => {
    const ps = people(300);
    const no = ps.find(p => !ischemic(p))!;
    const yes = ps.find(ischemic)!;
    expect(curesOf(db, primaryOf(no), ['tx.iv_fluids', 'tx.ng_tube'])).toEqual([
      { on: SBO, kind: 'cure', p: 7500, days: [1, 3], when: { ischemia: ['no'] } },
    ]);
    expect(curesOf(db, primaryOf(yes), ['tx.iv_fluids', 'tx.ng_tube'])).toEqual([]);
    expect(evaluatePlan(db, no, { treatments: ['tx.iv_fluids'], setting: 'admit' }, []).effective).toBe(true);
    expect(evaluatePlan(db, yes, { treatments: ['tx.iv_fluids'], setting: 'admit' }, []).effective).toBe(false);
    expect(evaluatePlan(db, yes, { treatments: ['tx.iv_fluids', OP], setting: 'surgery' }, []).effective).toBe(true);
    // у панкреатита и холецистита капельница — как была, без условий; у кишечной инфекции — по степени обезвоживания (часть 49а)
    expect(db.treatments['tx.iv_fluids'].effects.filter(e => e.on !== SBO && e.on !== 'cond.gastroenteritis').every(e => e.when === undefined)).toBe(true);
  });
});

describe('операция: сроки, некроз кишки, стационар', () => {
  test('некроз — только при ишемии и через 6 ч от начала болезни (327_3, раздел 1.2); смертность 2,2 и 5,9 % (Нью-Йорк 2024)', () => {
    const ps = people(300);
    for (const p of ps) expect(complicationAt(db, p)).toBe(ischemic(p) ? 6 : Infinity);
    expect(deathsOf(db, OP, false)).toBe(220);
    expect(deathsOf(db, OP, true)).toBe(590);
    expect(deathsOf(db, OP, false, 30)).toBe(220);
    expect(db.treatments[OP].surgery).toMatchObject({ minutes: 90, complications: 2220 });
  });

  test('ишемия — сразу в операционную: срок 2 ч, как у экстренной; после операции — 6–10 суток от её суток', () => {
    const patient = people(600).find(p => ischemic(p) && noAllergy(p) && onsetHours(p) < 4)!;
    const { s } = withOr(51);
    const p = treat(s, patient, ['tx.iv_fluids'], 'surgery');
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.stay!.op).toMatchObject({ tx: OP });
    apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
    expect(p.stay!.op!.end! - p.stay!.op!.start!).toBe(90 * 60);
    const note = p.closed!.notes.find(n => n.code === 'op.onTime')!;
    expect(note).toMatchObject({ tx: OP, window: 2 });
    expect(note).not.toHaveProperty('observed');
    // пришёл раньше 6 ч от начала болезни и прооперирован сразу — кишка жива
    expect(p.stay!.op!.complicated).toBeFalsy();
    const ready = p.stay!.readyAfter! - daysIn(p.stay!, s.day);
    expect(ready).toBeGreaterThanOrEqual(6);
    expect(ready).toBeLessThanOrEqual(10 + 4);
  });

  test('без ишемии — в палату с капельницей; не прошло — с обхода в операционную: срок после наблюдения, до 72 ч', () => {
    const ps = people(600).filter(p => !ischemic(p) && !has(p, 'sign.peritoneal_signs') && noAllergy(p));
    let checked = 0;
    for (let i = 0; i < 40 && checked === 0; i++) {
      const { s } = withOr(60 + i);
      const p = treat(s, ps[i], ['tx.iv_fluids', 'tx.ng_tube'], 'admit');
      expect(p.closed!.grades.setting).toBe('A');
      // лечение помогло — выписка через 3–6 суток; ищем того, кому не помогло
      if (p.stay!.readyAfter !== undefined) {
        expect(p.stay!.readyAfter).toBeGreaterThanOrEqual(3);
        expect(p.stay!.readyAfter).toBeLessThanOrEqual(6);
        continue;
      }
      expect(p.stay!.worseAfter).toBeGreaterThanOrEqual(1);
      expect(p.stay!.worseAfter).toBeLessThanOrEqual(3);
      night(s);
      apply(db, s, { kind: 'operate', id: p.id });
      apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
      const note = p.closed!.notes.find(n => n.code === 'op.onTime')!;
      expect(note).toMatchObject({ tx: OP, window: 72, observed: true });
      expect(noteText(note)).toContain('в срок после наблюдения, до 72');
      expect(p.stay!.op!.complicated).toBeFalsy();
      checked++;
    }
    expect(checked).toBe(1);
  });

  test('ишемия, а положили в палату: капельница не помогает, хуже; прооперировали через сутки — поздно, некроз', () => {
    const patient = people(900).find(p => ischemic(p) && !has(p, 'sign.peritoneal_signs') && noAllergy(p))!;
    const { s } = withOr(81);
    const p = treat(s, patient, ['tx.iv_fluids'], 'admit');
    // по правде нужна была операция — меньше нужного
    expect(p.closed!.grades.setting).toBe('D');
    expect(p.stay!.readyAfter).toBeUndefined();
    expect(p.stay!.worseAfter).toBeGreaterThanOrEqual(1);
    night(s);
    apply(db, s, { kind: 'operate', id: p.id });
    apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
    const late = p.closed!.notes.find(n => n.code === 'op.late')!;
    expect(late).toMatchObject({ tx: OP, window: 2 });
    expect(late).not.toHaveProperty('observed');
    expect(p.stay!.op!.complicated).toBe(true);
    expect(p.closed!.notes.some(n => n.code === 'op.complicated')).toBe(true);
  });
});

describe('энциклопедия', () => {
  test('у болезни — операция в 2 ч, наблюдение до 72 ч, стационар после операции, некроз при ишемии', () => {
    const where = article(db, SBO)!.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toEqual([
      T.encyclopedia.whereDefault(T.encyclopedia.setting.ambulance),
      T.encyclopedia.whereIf('при ишемии кишки', T.encyclopedia.setting.surgery),
      T.encyclopedia.whereRedFlag(T.encyclopedia.setting.surgery),
      T.encyclopedia.whereSurgery('Рассечение спаек', 2),
      T.encyclopedia.whereObserve(72),
      T.encyclopedia.whereStay(3, 6),
      T.encyclopedia.whereStayOperated(6, 10),
    ]);
    expect(where[4]).toBe('Без показаний к экстренной операции — лечение в палате; не помогло — операция не позже 72 ч после поступления.');
    const course = article(db, SBO)!.blocks.find(b => b.key === 'course')!.text!;
    expect(course).toContain('При ишемии кишки позже 6 ч от начала болезни — некроз кишки.');
    const treats = article(db, OP)!.blocks.find(b => b.key === 'treats')!.refs!;
    expect(treats).toEqual([expect.objectContaining({ id: SBO, note: 'в первые 2 ч после поступления; после наблюдения — до 72 ч' })]);
    expect(article(db, OP)!.blocks.find(b => b.key === 'outcomes')!.text).toEqual([
      T.encyclopedia.opComplications('22,2', '22,2', 'некроз кишки'),
      T.encyclopedia.opDeaths('2,2', '5,9', 'некроз кишки'),
    ]);
  });

  test('условия по скрытым параметрам — словами: у ущемлённой грыжи «при непроходимости кишки», а не «yes»', () => {
    const hernia = JSON.stringify(article(db, 'cond.strangulated_hernia')!);
    expect(hernia).not.toContain('(yes)');
    expect(hernia).not.toContain('"yes"');
    expect(hernia).toContain('при непроходимости кишки');
    const signs = article(db, SBO)!.blocks.find(b => b.key === 'signs')!;
    expect(JSON.stringify(signs)).toContain('без ишемии кишки');
    // у каждого условия в базе — подпись
    const whens = [
      ...Object.values(db.conditions).flatMap(c => [...c.findings.map(l => l.when), c.complication?.when]),
      ...Object.values(db.treatments).flatMap(t => t.effects.map(e => e.when)),
    ].filter((w): w is Record<string, string[]> => w !== undefined);
    expect(whens.length).toBeGreaterThan(10);
    for (const w of whens) for (const [name, values] of Object.entries(w)) for (const v of values) expect({ name, v, text: whenText({ [name]: [v] }) }).toEqual({ name, v, text: expect.any(String) });
  });
});
