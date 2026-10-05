// Почечная колика и острый парапроктит (spec 2026-09-chapter-2, часть 30г): кто болеет и что
// находят, скрытая инфекция за камнем, где лечить и чем, УЗИ почек и его картинка; парапроктит —
// поверхностный и глубокий, осмотр промежности и пальцевое исследование, вскрытие в операционной,
// энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { curesOf, evaluatePlan, primaryOf, recommendedSetting, txRole } from '../../src/engine/med/plan';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, newSandbox } from '../../src/engine/shift/engine';
import { complicationAt } from '../../src/engine/shift/surgery';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { makeCaseView, noteText } from '../../src/state/caseView';
import { article, whenText } from '../../src/state/encyclopedia';

const COLIC = 'cond.renal_colic';
const PP = 'cond.paraproctitis';
const OP = 'tx.abscess_drainage';
const BOTH = ['dept.therapy', 'dept.surgery'];
const people = (primary: Id, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: BOTH, season: 'winter', primary }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const share = (xs: Patient[], ok: (p: Patient) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, name: string) => primaryOf(p).params[name];
const infected = (p: Patient) => param(p, 'infection') === 'yes';
const deep = (p: Patient) => param(p, 'depth') === 'deep';
const noAllergy = (p: Patient) => !p.truth.risks.some(r => r.startsWith('risk.allergy_'));

/**
 * Доля мужчин среди пришедших с болезнью — по весам генератора (как etiology в abdomen.test.ts):
 * у заданной болезни пол не выбирается, считаем ожидание по толпе пришедших сами.
 */
function menShare(id: Id): number {
  const ids = Object.keys(db.conditions).filter(c => BOTH.includes(db.conditions[c].department));
  let men = 0;
  let total = 0;
  for (let i = 0; i < 3000; i++) {
    const p = generatePatient(db, 1 + i, { department: 'dept.therapy', departments: BOTH, season: 'winter' });
    const chronic = p.truth.conditions.filter(c => c.role === 'comorbid').map(c => c.id);
    const who = { sex: p.sex, age: p.age, season: p.season, risks: p.truth.risks, chronic };
    const w = (c: Id) => presentingWeight(db.conditions[c], who);
    const pr = w(id) / ids.reduce((a, c) => a + w(c), 0);
    total += pr;
    if (p.sex === 'm') men += pr;
  }
  return men / total;
}

/** Песочница с палатой и операционной (как в sbo.test.ts): бригада навыка 3. */
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
  return s;
}

/** Первого в очереди подменить больным, позвать, осмотреть, назвать диагноз, назначить лечение и место. */
function treat(s: ShiftState, patient: Patient, diagnosis: Id, treatments: Id[], setting: 'admit' | 'surgery'): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const p = s.patients[s.queue[0]];
  p.patient = patient;
  p.departments = [...BOTH];
  apply(db, s, { kind: 'call', id: p.id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'diagnose', id: diagnosis });
  for (const tx of treatments) apply(db, s, { kind: 'toggleTreatment', id: tx });
  apply(db, s, { kind: 'setting', setting });
  apply(db, s, { kind: 'finish' });
  return p;
}

describe('почечная колика: кто болеет и что находят', () => {
  test('хирургия приёмного, болезнь мочевой системы: в амбулатории её нет', () => {
    expect(candidatesOf(db, BOTH)).toContain(COLIC);
    expect(candidatesOf(db, 'dept.therapy')).not.toContain(COLIC);
    expect(db.conditions[COLIC]).toMatchObject({ department: 'dept.surgery', system: 'urinary', kind: 'syndrome', severity: 'moderate' });
    expect(db.conditions[COLIC].confirm).toEqual(['exam.us_kidney']);
  });

  test('мужчин — 1,75 на одну женщину; инфекция — у 8 %; боль в пояснице — у каждого, на той стороне, где камень (587_2)', () => {
    expect(menShare(COLIC)).toBeGreaterThan(0.59);
    expect(menShare(COLIC)).toBeLessThan(0.68);
    const ps = people(COLIC, 2000);
    expect(share(ps, infected)).toBeGreaterThan(0.06);
    expect(share(ps, infected)).toBeLessThan(0.1);
    // боль — почти всегда (полоса — 95 %), и всегда на стороне камня
    expect(share(ps, p => has(p, 'sym.flank_pain'))).toBeGreaterThan(0.93);
    for (const p of ps.filter(p => has(p, 'sym.flank_pain'))) {
      const pain = p.truth.findings.find(x => x.f === 'sym.flank_pain')!;
      if (pain.cause === COLIC) expect(pain.attrs?.side).toBe(param(p, 'side'));
    }
    expect(share(ps, p => has(p, 'sym.groin_radiation'))).toBeGreaterThan(0.44);
    expect(share(ps, p => has(p, 'sym.groin_radiation'))).toBeLessThan(0.56);
    // две тысячи больных и доля мужчин по базе — около 5 секунд и на базе 56 (часть 43а)
  }, 30_000);

  test('эритроцитурии нет у 15 %, лейкоцитурия — у 14,5 % всех и при инфекции в 10 раз чаще, лейкоцитоз — у 80 %, лоханка расширена у 89,1 % (587_2)', () => {
    const ps = people(COLIC, 4000);
    const near = (x: number, want: number, tol: number) => {
      expect(x).toBeGreaterThan(want - tol);
      expect(x).toBeLessThan(want + tol);
    };
    near(share(ps, p => has(p, 'lab.urine_blood')), 0.85, 0.02);
    near(share(ps, p => has(p, 'lab.urine_leuk')), 0.145, 0.02);
    near(share(ps, p => has(p, 'lab.wbc_high')), 0.8, 0.025);
    near(share(ps, p => has(p, 'img.us_hydronephrosis')), 0.891, 0.02);
    // инфекция при лейкоцитурии и без неё: подобрано — 9,5 раза
    const leuk = ps.filter(p => has(p, 'lab.urine_leuk'));
    const clean = ps.filter(p => !has(p, 'lab.urine_leuk'));
    const ratio = share(leuk, infected) / share(clean, infected);
    expect(ratio).toBeGreaterThan(6);
    expect(ratio).toBeLessThan(14);
  });
});

describe('почечная колика: где лечить и чем', () => {
  test('без инфекции — дома; инфекция или температура — перевод: урологии нет; беременная — в стационар (587_2, раздел 6)', () => {
    const ps = people(COLIC, 1200);
    for (const p of ps) {
      const want = infected(p) || has(p, 'vital.fever') ? 'transfer' : p.truth.risks.includes('risk.pregnancy') ? 'ward' : 'home';
      expect(recommendedSetting(db, p)).toBe(want);
    }
    const calm = ps.find(p => !infected(p) && !has(p, 'vital.fever'))!;
    expect(recommendedSetting(db, { ...calm, truth: { ...calm.truth, risks: [...calm.truth.risks, 'risk.pregnancy'] } })).toBe('ward');
    expect(share(ps, p => recommendedSetting(db, p) === 'transfer')).toBeLessThan(0.2);
  });

  test('ибупрофен — первая линия, лечит без инфекции; спазмолитик и капельница — не показаны; альфа-адреноблокатор — можно (587_2, раздел 3.1.1)', () => {
    const t = db.conditions[COLIC].treatment!;
    expect(t.firstLine).toEqual(['tx.ibuprofen']);
    expect(t.acceptable).toEqual(['tx.alpha_blocker']);
    expect(t.notIndicated).toEqual(['tx.drotaverine', 'tx.iv_fluids']);
    expect(txRole(db, COLIC, 'tx.drotaverine')).toBe('notIndicated');
    const ps = people(COLIC, 600);
    const clean = ps.find(p => !infected(p) && noAllergy(p))!;
    const sick = ps.find(p => infected(p) && noAllergy(p))!;
    expect(curesOf(db, primaryOf(clean), ['tx.ibuprofen', 'tx.alpha_blocker'])).toEqual([
      { on: COLIC, kind: 'cure', p: 7500, days: [0, 1], when: { infection: ['no'] } },
    ]);
    // с инфекцией за камнем одно обезболивание не лечит: нужна разгрузка почки
    expect(curesOf(db, primaryOf(sick), ['tx.ibuprofen'])).toEqual([]);
    expect(evaluatePlan(db, clean, { treatments: ['tx.ibuprofen'], setting: 'home' }, []).effective).toBe(true);
    expect(evaluatePlan(db, sick, { treatments: ['tx.ibuprofen'], setting: 'home' }, []).effective).toBe(false);
    // альфа-адреноблокатор на причину в игре не действует: размера камня нет
    expect(db.treatments['tx.alpha_blocker'].effects).toEqual([]);
  });

  test('УЗИ почек: в кабинете УЗИ, без облучения; расширенную лоханку находит у 93 % при специфичности 81 % (Herbst 2014)', () => {
    const x = db.exams['exam.us_kidney'];
    expect(x).toMatchObject({ kind: 'imaging', room: 'room.ultrasound', equipment: ['eq.us_basic', 'eq.us_expert'], radiation: 'none' });
    expect(x.checks).toEqual([{ f: 'img.us_hydronephrosis', sens: 9300, spec: 8100 }]);
    // расспрос: иррадиация в пах и камни в прошлом
    expect(db.exams['exam.ask_urinary'].checks).toContainEqual({ f: 'sym.groin_radiation', sens: 8800, spec: 9700 });
    expect(db.exams['exam.ask_chronic'].checks).toContainEqual({ f: 'hx.kidney_stones', sens: 9500, spec: 9900 });
  });

  test('картинка УЗИ почек: почка под печенью, тёмная лоханка расширена — если её показало УЗИ', () => {
    const p = people(COLIC, 1)[0];
    const view = (obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: [{ exam: 'exam.us_kidney', step: 1, at: 600, obs }], pending: [], meanwhile: [], done: ['exam.us_kidney'],
      draft: { treatments: [], setting: 'home' }, departments: BOTH,
    }).groups.find(g => g.exam === 'exam.us_kidney')!.image;
    const us = (shown: boolean): Observation => ({ f: 'img.us_hydronephrosis', shown, exam: 'exam.us_kidney' });
    expect(view([us(true)])).toMatchObject({ kind: 'us', view: 'kidney', pelvis: 0.8 });
    expect(view([us(false)])).toMatchObject({ kind: 'us', view: 'kidney', pelvis: 0 });
  });
});

describe('парапроктит', () => {
  test('хирургия приёмного; операция — вскрытие и дренирование в первые 12 ч; осложнений — 5,9 % (Causey 2013)', () => {
    expect(candidatesOf(db, BOTH)).toContain(PP);
    expect(candidatesOf(db, 'dept.therapy')).not.toContain(PP);
    expect(db.conditions[PP]).toMatchObject({ department: 'dept.surgery', system: 'digestive', severity: 'serious', confirm: 'clinical' });
    expect(db.conditions[PP].surgery).toEqual({ tx: OP, window: 12 });
    expect(db.treatments[OP].surgery).toMatchObject({ room: 'room.or', minutes: 30, complications: 590 });
    expect(db.treatments[OP].surgery!.death).toBeUndefined();
    // перфорации или некроза, как у аппендицита и непроходимости, нет
    for (const p of people(PP, 50)) expect(complicationAt(db, p)).toBe(Infinity);
    for (const p of people(PP, 300)) expect(recommendedSetting(db, p)).toBe('surgery');
    // антибиотик — можно; обезболивания в 185_3 нет — в тактике его нет
    const t = db.conditions[PP].treatment!;
    expect(t.acceptable).toEqual(['tx.amoxicillin_clavulanate']);
    expect(t.supportive ?? []).toEqual([]);
    // мужчин — 70 % (Khan 2023: 70,3 %)
    expect(menShare(PP)).toBeGreaterThan(0.65);
    expect(menShare(PP)).toBeLessThan(0.75);
  });

  test('подкожный гнойник виден снаружи, глубокий — только пальцем; глубокий — с лихорадкой', () => {
    const ps = people(PP, 1500);
    const d = ps.filter(deep);
    const s = ps.filter(p => !deep(p));
    expect(d.length / ps.length).toBeGreaterThan(0.34);
    expect(d.length / ps.length).toBeLessThan(0.46);
    expect(share(ps, p => has(p, 'sym.perianal_pain'))).toBeGreaterThan(0.95);
    expect(share(s, p => has(p, 'sign.perianal_infiltrate'))).toBeGreaterThan(0.93);
    expect(share(d, p => has(p, 'sign.perianal_infiltrate'))).toBeLessThan(0.12);
    expect(share(d, p => has(p, 'sign.rectal_bulge'))).toBeGreaterThan(0.68);
    expect(share(d, p => has(p, 'vital.fever'))).toBeGreaterThan(share(s, p => has(p, 'vital.fever')) + 0.3);
    // осмотр промежности и пальцевое исследование — физикальное, на приёме
    const x = db.exams['exam.rectal_exam'];
    expect(x).toMatchObject({ kind: 'physical', cost: 0 });
    expect(x.room).toBeUndefined();
    expect(x.checks.map(c => c.f)).toEqual(['sign.perianal_infiltrate', 'sign.rectal_bulge']);
    expect(db.exams['exam.ask_abdomen'].checks).toContainEqual({ f: 'sym.perianal_pain', sens: 9500, spec: 9900 });
  });

  test('в операционную сразу: вскрыли в срок — в палате 3–6 суток', () => {
    const patient = people(PP, 300).find(noAllergy)!;
    const s = withOr(71);
    const p = treat(s, patient, PP, [], 'surgery');
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.stay!.op).toMatchObject({ tx: OP });
    apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
    expect(p.stay!.op!.end! - p.stay!.op!.start!).toBe(30 * 60);
    const note = p.closed!.notes.find(n => n.code === 'op.onTime')!;
    expect(note).toMatchObject({ tx: OP, window: 12 });
    expect(noteText(note)).toContain('в срок, до 12');
    expect(p.stay!.op!.complicated).toBeFalsy();
    const extra = p.stay!.op!.complication ? 4 : 0;
    expect(p.stay!.readyAfter).toBeGreaterThanOrEqual(3);
    expect(p.stay!.readyAfter).toBeLessThanOrEqual(6 + extra);
  });

  test('положили в палату без операции: антибиотик гнойник не лечит — хуже', () => {
    const patient = people(PP, 300).find(noAllergy)!;
    const s = withOr(72);
    const p = treat(s, patient, PP, ['tx.amoxicillin_clavulanate'], 'admit');
    expect(p.closed!.grades.setting).not.toBe('A');
    expect(p.stay!.readyAfter).toBeUndefined();
    expect(p.stay!.worseAfter).toBeGreaterThanOrEqual(1);
    expect(p.stay!.worseAfter).toBeLessThanOrEqual(3);
  });
});

describe('энциклопедия', () => {
  test('колика: дома, с инфекцией — перевод, беременная — стационар; условия словами', () => {
    const where = article(db, COLIC)!.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toContain(T.encyclopedia.whereDefault(T.encyclopedia.setting.home));
    expect(where).toContain(T.encyclopedia.whereIf('при инфекции мочевых путей', T.encyclopedia.setting.transfer));
    expect(where).toContain(T.encyclopedia.whereRisk('Беременность', T.encyclopedia.setting.ward));
    const text = JSON.stringify(article(db, COLIC)!);
    expect(text).not.toContain('(yes)');
    expect(text).not.toContain('(no)');
    expect(text).toContain('при инфекции мочевых путей');
    expect(whenText({ infection: ['no'] })).toBe('без инфекции');
    expect(whenText({ infection: ['yes'] })).toBe('при инфекции мочевых путей');
    expect(whenText({ depth: ['deep'] })).toBe('при глубоком');
  });

  test('парапроктит: операция в первые 12 ч; вскрытие — лечит парапроктит; УЗИ почек — в кабинете УЗИ', () => {
    const where = article(db, PP)!.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toContain(T.encyclopedia.whereSurgery('Вскрытие и дренирование парапроктита', 12));
    const treats = article(db, OP)!.blocks.find(b => b.key === 'treats')!.refs!;
    expect(treats).toEqual([expect.objectContaining({ id: PP, note: 'в первые 12\u00a0ч после поступления' })]);
    const room = article(db, 'room.ultrasound')!.blocks.find(b => b.key === 'doneHere')!.refs!;
    expect(room.map(r => r.id)).toEqual(expect.arrayContaining(['exam.us_abdomen', 'exam.us_kidney']));
    const signs = JSON.stringify(article(db, PP)!.blocks.find(b => b.key === 'signs')!);
    expect(signs).toContain('при глубоком');
    expect(signs).toContain('при подкожном и подслизистом');
  });
});
