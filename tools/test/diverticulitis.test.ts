// Острый дивертикулит (spec 2026-09-chapter-2, часть 30д): скрытая форма — неосложнённый,
// инфильтрат, абсцесс до 3 см и больше, перитонит; где лечить по форме; антибиотик лечит не всё,
// неосложнённый проходит и без него — течение по форме; УЗИ и картинка кишки; резекция по Гартману
// при перитоните и без строки срока, если операции не было нужно; энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { observe } from '../../src/engine/med/course';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { curesOf, evaluatePlan, primaryOf, recommendedSetting, selfLimits, untreatedOf } from '../../src/engine/med/plan';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, newSandbox } from '../../src/engine/shift/engine';
import { complicationAt, deathsOf } from '../../src/engine/shift/surgery';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { lowerFirst } from '../../src/i18n/case';
import { makeCaseView, noteText } from '../../src/state/caseView';
import { article, whenText } from '../../src/state/encyclopedia';

const DIV = 'cond.diverticulitis';
const OP = 'tx.hartmann';
const ABX = 'tx.amoxicillin_clavulanate';
const BOTH = ['dept.therapy', 'dept.surgery'];
const people = (n: number, from = 1, params?: Record<string, string>) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: BOTH, season: 'winter', primary: DIV, ...(params ? { params } : {}) }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const share = (xs: Patient[], ok: (p: Patient) => boolean) => xs.filter(ok).length / xs.length;
const form = (p: Patient) => primaryOf(p).params.form;
const noAllergy = (p: Patient) => !p.truth.risks.some(r => r.startsWith('risk.allergy_'));

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
function treat(s: ShiftState, patient: Patient, treatments: Id[], setting: 'admit' | 'surgery'): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const p = s.patients[s.queue[0]];
  p.patient = patient;
  p.departments = [...BOTH];
  apply(db, s, { kind: 'call', id: p.id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'diagnose', id: DIV });
  for (const tx of treatments) apply(db, s, { kind: 'toggleTreatment', id: tx });
  apply(db, s, { kind: 'setting', setting });
  apply(db, s, { kind: 'finish' });
  return p;
}

describe('кто болеет и что находят', () => {
  test('хирургия приёмного, болезнь пищеварения: в амбулатории её нет; операция — резекция по Гартману', () => {
    expect(candidatesOf(db, BOTH)).toContain(DIV);
    expect(candidatesOf(db, 'dept.therapy')).not.toContain(DIV);
    expect(db.conditions[DIV]).toMatchObject({ department: 'dept.surgery', system: 'digestive', severity: 'serious' });
    expect(db.conditions[DIV].surgery).toEqual({ tx: OP, window: 2, stay: [7, 12] });
    expect(db.conditions[DIV].confirm).toEqual(['exam.us_abdomen']);
  });

  test('формы: неосложнённый — 75 %, осложнённых (абсцесс и перитонит) — 15 %, перитонит — 2 %; женщин — 60 % (Hupfeld 2018)', () => {
    const ps = people(3000);
    const near = (x: number, want: number, tol: number) => {
      expect(x).toBeGreaterThan(want - tol);
      expect(x).toBeLessThan(want + tol);
    };
    near(share(ps, p => form(p) === 'uncomplicated'), 0.75, 0.03);
    near(share(ps, p => ['abscess_small', 'abscess_large', 'peritonitis'].includes(form(p))), 0.15, 0.025);
    near(share(ps, p => form(p) === 'peritonitis'), 0.02, 0.01);
    // пол у заданной болезни не выбирается — считаем ожидание по весам генератора
    const ids = Object.keys(db.conditions).filter(c => BOTH.includes(db.conditions[c].department));
    let women = 0;
    let total = 0;
    for (let i = 0; i < 3000; i++) {
      const p = generatePatient(db, 1 + i, { department: 'dept.therapy', departments: BOTH, season: 'winter' });
      const chronic = p.truth.conditions.filter(c => c.role === 'comorbid').map(c => c.id);
      const who = { sex: p.sex, age: p.age, season: p.season, risks: p.truth.risks, chronic };
      const w = (c: Id) => presentingWeight(db.conditions[c], who);
      const pr = w(DIV) / ids.reduce((a, c) => a + w(c), 0);
      total += pr;
      if (p.sex === 'f') women += pr;
    }
    near(women / total, 0.6, 0.05);
    // шесть тысяч больных — около 5 секунд: срок как у других тяжёлых тестов (часть 43б: в прогоне под нагрузкой — 5,04 с)
  }, 30_000);

  test('боль слева внизу — почти у всех без перитонита; при инфильтрате выше 38 °C — у 2/3 и пальпируется инфильтрат; при перитоните — раздражение брюшины', () => {
    const local = people(800).filter(p => form(p) !== 'peritonitis');
    expect(share(local, p => has(p, 'sym.llq_pain'))).toBeGreaterThan(0.93);
    const infiltrate = people(900, 1, { form: 'infiltrate' });
    expect(share(infiltrate, p => has(p, 'vital.fever'))).toBeGreaterThan(0.6);
    expect(share(infiltrate, p => has(p, 'vital.fever'))).toBeLessThan(0.74);
    expect(share(infiltrate, p => has(p, 'sign.llq_mass'))).toBeGreaterThan(0.68);
    const plain = people(900, 1, { form: 'uncomplicated' });
    expect(share(plain, p => has(p, 'sign.llq_mass'))).toBeLessThan(0.01);
    const peritonitis = people(300, 1, { form: 'peritonitis' });
    expect(share(peritonitis, p => has(p, 'sign.peritoneal_signs'))).toBeGreaterThan(0.68);
    // УЗИ: воспалённый дивертикул — у каждого, найдёт ли его УЗИ — точность (Laméris 2008)
    for (const p of people(100)) expect(has(p, 'img.us_diverticulitis')).toBe(true);
    expect(db.exams['exam.us_abdomen'].checks).toContainEqual({ f: 'img.us_diverticulitis', sens: 9200, spec: 9000 });
    expect(db.exams['exam.ask_abdomen'].checks).toContainEqual({ f: 'sym.llq_pain', sens: 9000, spec: 9700 });
    expect(db.exams['exam.abdomen_palpation'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sign.llq_tenderness', 'sign.llq_mass']));
  });
});

describe('где лечить и чем', () => {
  test('неосложнённый — дома; инфильтрат и абсцесс до 3 см — в стационар; больше 3 см — перевод; перитонит и раздражение брюшины — операция', () => {
    const want: Record<string, Setting> = { uncomplicated: 'home', infiltrate: 'ward', abscess_small: 'ward', abscess_large: 'transfer', peritonitis: 'surgery' };
    for (const p of people(1500)) expect(recommendedSetting(db, p)).toBe(has(p, 'sign.peritoneal_signs') ? 'surgery' : want[form(p)]);
    const t = db.conditions[DIV].treatment!;
    expect(t.firstLine).toEqual([ABX]);
    expect(t.supportive).toEqual(['tx.drotaverine']);
  });

  test('антибиотик лечит неосложнённый и инфильтрат почти всегда, абсцесс до 3 см — в 80 % (179_3: 19–21 % неудач); большой абсцесс и перитонит — нет', () => {
    const cure = (f: string) => curesOf(db, { id: DIV, params: { form: f } }, [ABX, 'tx.drotaverine']).map(e => e.p);
    expect(cure('uncomplicated')).toEqual([9500]);
    expect(cure('infiltrate')).toEqual([9500]);
    expect(cure('abscess_small')).toEqual([8000]);
    expect(cure('abscess_large')).toEqual([]);
    expect(cure('peritonitis')).toEqual([]);
    expect(curesOf(db, { id: DIV, params: { form: 'peritonitis' } }, [OP])).toHaveLength(1);
  });

  test('неосложнённый проходит и без антибиотика (DIABOLO); остальные без лечения — хуже', () => {
    for (const f of ['uncomplicated', 'infiltrate', 'abscess_small', 'abscess_large', 'peritonitis']) {
      const x = { id: DIV, params: { form: f } };
      expect({ f, self: selfLimits(db, x), worse: untreatedOf(db, x) !== undefined }).toEqual({ f, self: f === 'uncomplicated', worse: f !== 'uncomplicated' });
    }
    // дома без лечения: неосложнённый не возвращается хуже, инфильтрат — почти всегда
    const home = { treatments: [] as Id[], setting: 'home' as const };
    const run = (p: Patient) => observe(db, p, home, evaluatePlan(db, p, home, []), Rng.seeded(p.seed).fork('outcome'));
    const plain = people(200, 1, { form: 'uncomplicated' }).filter(noAllergy);
    expect(plain.every(p => run(p).kind !== 'worse')).toBe(true);
    const infiltrate = people(200, 1, { form: 'infiltrate' });
    expect(share(infiltrate, p => run(p).kind === 'worse')).toBeGreaterThan(0.9);
    // у других болезней без условий — как было: аппендицит без операции хуже, ОРВИ проходит само
    expect(selfLimits(db, { id: 'cond.arvi', params: {} })).toBe(true);
    expect(untreatedOf(db, { id: 'cond.appendicitis', params: {} })).toBeDefined();
  });

  test('картинка УЗИ: воспалённый дивертикул — вид «кишка»; аппендицит — по-прежнему отросток', () => {
    const p = people(1)[0];
    const view = (obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: [{ exam: 'exam.us_abdomen', step: 1, at: 600, obs }], pending: [], meanwhile: [], done: ['exam.us_abdomen'],
      draft: { treatments: [], setting: 'home' }, departments: BOTH,
    }).groups.find(g => g.exam === 'exam.us_abdomen')!.image;
    const us = (f: string, shown: boolean): Observation => ({ f, shown, exam: 'exam.us_abdomen' });
    expect(view([us('img.us_diverticulitis', true), us('img.us_gallstones', false)])).toMatchObject({ kind: 'us', view: 'colon', diverticulum: 0.8 });
    expect(view([us('img.us_diverticulitis', false), us('img.us_gallstones', false)])).toMatchObject({ kind: 'us', view: 'gallbladder' });
    expect(view([us('img.us_appendicitis', true), us('img.us_diverticulitis', true)])).toMatchObject({ view: 'appendix' });
  });
});

describe('операция и палата', () => {
  test('резекция по Гартману: 150 минут, осложнения 44 % (LADIES), смертность 10,8 % (Halim 2019); стадии по часам у дивертикулита нет', () => {
    expect(db.treatments[OP].surgery).toMatchObject({ room: 'room.or', minutes: 150, complications: 4400, death: 1080 });
    expect(deathsOf(db, OP, false)).toBe(1080);
    for (const p of people(30)) expect(complicationAt(db, p)).toBe(Infinity);
  });

  test('перитонит — сразу в операционную: в срок, до 2 ч; после операции — 7–12 суток', () => {
    const patient = people(200, 1, { form: 'peritonitis' }).find(noAllergy)!;
    const s = withOr(91);
    const p = treat(s, patient, [ABX], 'surgery');
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.stay!.op).toMatchObject({ tx: OP });
    apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
    expect(p.stay!.op!.end! - p.stay!.op!.start!).toBe(150 * 60);
    const note = p.closed!.notes.find(n => n.code === 'op.onTime')!;
    expect(note).toMatchObject({ tx: OP, window: 2 });
    expect(noteText(note)).toContain('в срок, до 2');
    if (p.stay!.dies === undefined) {
      const extra = p.stay!.op!.complication ? 4 : 0;
      expect(p.stay!.readyAfter).toBeGreaterThanOrEqual(7);
      expect(p.stay!.readyAfter).toBeLessThanOrEqual(12 + extra);
    }
  });

  test('неосложнённый в операционную: больше нужного, строки срока нет — операции не было нужно', () => {
    const patient = people(200, 1, { form: 'uncomplicated' }).find(p => noAllergy(p) && !has(p, 'sign.peritoneal_signs'))!;
    const s = withOr(92);
    const p = treat(s, patient, [ABX], 'surgery');
    expect(p.closed!.grades.setting).toBe('C');
    apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
    expect(p.stay!.op!.done).toBe(true);
    expect(p.closed!.notes.some(n => n.code === 'op.onTime' || n.code === 'op.late')).toBe(false);
    expect(s.summary.surgery).toMatchObject({ done: 1, onTime: 0, late: 0 });
  });

  test('инфильтрат — в палату с антибиотиком: выписка через 3–7 суток; большой абсцесс в палате — хуже', () => {
    const inf = people(300, 1, { form: 'infiltrate' }).find(noAllergy)!;
    const s = withOr(93);
    const p = treat(s, inf, [ABX], 'admit');
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.stay!.readyAfter).toBeGreaterThanOrEqual(3);
    expect(p.stay!.readyAfter).toBeLessThanOrEqual(7);
    const big = people(300, 1, { form: 'abscess_large' }).find(x => noAllergy(x) && !has(x, 'sign.peritoneal_signs'))!;
    const s2 = withOr(94);
    const q = treat(s2, big, [ABX], 'admit');
    // по правде нужен перевод: палата — меньше нужного
    expect(q.closed!.grades.setting).toBe('D');
    expect(q.stay!.readyAfter).toBeUndefined();
    expect(q.stay!.worseAfter).toBeGreaterThanOrEqual(1);
  });
});

describe('энциклопедия и подписи', () => {
  test('«Где лечить» по форме; течение — «при неосложнённом проходит само», остальные без лечения хуже', () => {
    const e = T.encyclopedia;
    const where = article(db, DIV)!.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toEqual(expect.arrayContaining([
      e.whereDefault(e.setting.home),
      e.whereIf('при инфильтрате', e.setting.ward),
      e.whereIf('при абсцессе больше 3 см', e.setting.transfer),
      e.whereIf('при перитоните', e.setting.surgery),
      e.whereSurgery('Резекция по Гартману', 2),
      e.whereStayOperated(7, 12),
    ]));
    // название операции посреди фразы — с маленькой буквы, фамилия — с большой
    expect(where).toContain('Операция — резекция по Гартману: в первые 2 ч после поступления.');
    const course = article(db, DIV)!.blocks.find(b => b.key === 'course')!.text!;
    expect(course).toEqual([
      'При неосложнённом — обычно проходит само.',
      'При инфильтрате, абсцессе до 3 см, абсцессе больше 3 см и перитоните без действенного лечения почти всегда становится хуже — на 1–3-й день.',
    ]);
    expect(whenText({ form: ['infiltrate', 'peritonitis'] })).toBe('при инфильтрате и перитоните');
    const outcomes = article(db, OP)!.blocks.find(b => b.key === 'outcomes')!.text!;
    expect(outcomes).toEqual([e.opComplications('44', undefined, undefined), e.opDeaths('10,8', undefined, undefined)]);
  });

  test('название посреди фразы: первая буква — маленькая, если это не сокращение; «°C», фамилии и сокращения — как есть', () => {
    expect(lowerFirst('Лихорадка 38 °C и выше')).toBe('лихорадка 38 °C и выше');
    expect(lowerFirst('Резекция по Гартману')).toBe('резекция по Гартману');
    expect(lowerFirst('Кабинет УЗИ')).toBe('кабинет УЗИ');
    expect(lowerFirst('ЭКГ')).toBe('ЭКГ');
    expect(lowerFirst('С-реактивный белок выше 30 мг/л')).toBe('С-реактивный белок выше 30 мг/л');
    expect(T.shift.ward.opOn('Резекция по Гартману', '10:30')).toBe('Идёт операция: резекция по Гартману, до 10:30');
    expect(T.spikes.patient.note.redFlagIgnored('Лихорадка 38 °C и выше')).toContain('«лихорадка 38 °C и выше»');
  });
});
