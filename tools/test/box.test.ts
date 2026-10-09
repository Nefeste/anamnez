// Боксы инфекционного отделения (spec 2026-10-chapter-4, часть 49а): заразную болезнь (`isolation`) в стационаре лечат в
// боксе на одного больного; в общей палате — меньше нужного и соседи по палате контактные; своих боксов нет — перевод в
// инфекционную больницу. Острый гастроэнтерит — по степени обезвоживания В. И. Покровского (875_1, приложение А3.1): I–II —
// питьё солевых растворов дома, III — бокс и растворы в вену, IV — дегидратационный шок, интенсивная терапия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { wardIncome } from '../../src/engine/economy/economy';
import { generatePatient } from '../../src/engine/med/generate';
import { alsoSettings, choiceFor, evaluatePlan, recommendedSetting, settingFit, SETTING_ORDER, tacticsFor } from '../../src/engine/med/plan';
import { choosePlan } from '../../src/engine/med/policy';
import { apply, boxBeds, careUnit, freeBoxBeds, inBox, newSandbox, wardBeds } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { article } from '../../src/state/encyclopedia';

const GE = 'cond.gastroenteritis';
const IV = 'tx.balanced_fluids';
const ORS = 'tx.ors';

const patient = (severity: string, seed = 4949) => generatePatient(db, seed, { department: 'dept.therapy', season: 'summer', primary: GE, params: { severity } });

/** Доля пациентов с признаком при этой степени — по генератору. */
function share(severity: string, f: string, n = 400): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (patient(severity, 90_000 + i).truth.findings.some(x => x.f === f)) k++;
  return k / n;
}

/**
 * Песочница с готовой амбулаторией и коридором справа: над ним — бокс, под ним — второй бокс (`boxes` = 2) или общая палата
 * (`ward`). Медсестра ЭКГ — в первый бокс, остальным медсёстрам — по помещению из кандидатов.
 */
function withBox(boxes: 1 | 2, ward = false, seed = 49): { s: ShiftState; rooms: string[]; wardRoom?: string } {
  const s = newSandbox(db, { seed, season: 'summer', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  const last = () => s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const rooms: string[] = [];
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.box', size: 'S', x: 29, y: 0, rot: 0 } });
  rooms.push(last());
  if (boxes === 2) {
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.box', size: 'S', x: 29, y: 10, rot: 2 } });
    rooms.push(last());
  }
  if (ward) apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ward', size: 'S', x: 29, y: 10, rot: 2 } });
  const wardRoom = ward ? last() : undefined;
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: rooms[0] });
  for (const room of [...rooms.slice(1), ...(wardRoom ? [wardRoom] : [])]) {
    const c = s.candidates!.find(x => x.role === 'role.nurse')!;
    apply(db, s, { kind: 'hire', id: c.id });
    apply(db, s, { kind: 'assign', id: c.id, room });
  }
  return { s, rooms, ...(wardRoom ? { wardRoom } : {}) };
}

/** Первый в очереди — с острым гастроэнтеритом этой степени, вызван, осмотрен, диагноз поставлен. */
function gastro(s: ShiftState, severity: string): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const id = s.queue[0];
  const p = s.patients[id];
  p.patient = patient(severity);
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.general_exam' });
  apply(db, s, { kind: 'diagnose', id: GE });
  return p;
}

describe('бокс: где лечить', () => {
  test('бокс — стационар с изоляцией: закрывает палату; заразного направить или перевести — не ошибка, в общую палату — меньше нужного', () => {
    expect(SETTING_ORDER.box).toBeGreaterThan(SETTING_ORDER.admit);
    expect(SETTING_ORDER.box).toBeLessThan(SETTING_ORDER.icu);
    expect(['ward', 'ambulance', 'box'].map(need => settingFit(need as 'ward', 'box'))).toEqual(['ok', 'ok', 'ok']);
    expect(['ward', 'ambulance', 'transfer', 'box'].map(chosen => settingFit('box', chosen as 'ward'))).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect([settingFit('box', 'admit'), settingFit('box', 'home'), settingFit('icu', 'box')]).toEqual(['under', 'under', 'under']);
    expect([settingFit('home', 'box'), settingFit('box', 'icu')]).toEqual(['over', 'over']);
    // свой бокс — в него; нет — скорая в инфекционную больницу, и из амбулатории тоже
    expect([choiceFor('box', { box: true, ward: true }), choiceFor('box', { ward: true, icu: true }), choiceFor('box')]).toEqual(['box', 'ambulance', 'ambulance']);
  });

  test('заразна только болезнь с путём передачи, и бокс есть в её правиле места', () => {
    const isolated = Object.values(db.conditions).filter(c => c.isolation).map(c => [c.id, c.isolation]);
    expect(isolated).toEqual([[GE, 'contact']]);
  });
});

describe('острый гастроэнтерит по Покровскому', () => {
  test('степени — I–IV: лёгкое, среднетяжёлое, тяжёлое, очень тяжёлое; тяжёлое у взрослых — редко', () => {
    expect(db.conditions[GE].params?.severity).toEqual({ mild: 76, moderate: 18, severe: 5, critical: 1 });
  });

  test('место: I–II — дома (при II и бокс не ошибка), III — бокс, IV — интенсивная терапия', () => {
    expect(['mild', 'moderate', 'severe', 'critical'].map(v => recommendedSetting(db, patient(v)))).toEqual(['home', 'home', 'box', 'icu']);
    expect(alsoSettings(db, patient('moderate'))).toEqual(['box']);
  });

  test('признаки по степеням: моча, слизистые, тургор, голос, пульс и давление', () => {
    // III и IV — выраженное обезвоживание и мало мочи почти у каждого; I — нет
    for (const [v, f] of [['severe', 'sign.dehydration'], ['critical', 'sign.dehydration'], ['severe', 'sym.less_urine']]) expect(share(v, f)).toBeGreaterThan(0.9);
    expect(share('mild', 'sign.dehydration')).toBeLessThan(0.05);
    expect(share('mild', 'sym.less_urine')).toBeLessThan(0.05);
    // II — суховатые слизистые обычно, пульс чаще 100 редко
    expect(share('moderate', 'sign.dry_mucosa')).toBeGreaterThan(0.7);
    expect(share('moderate', 'vital.tachycardia')).toBeLessThan(0.3);
    // III — осиплость часто, давление 100 и ниже обычно; IV — давление ниже 90 почти у каждого
    expect(share('severe', 'sign.hoarse_voice')).toBeGreaterThan(0.4);
    expect(share('severe', 'vital.bp_100')).toBeGreaterThan(0.7);
    expect(share('critical', 'vital.bp_low')).toBeGreaterThan(0.9);
    // о моче и судорогах спрашивают, слизистые и голос видны при осмотре
    expect(db.exams['exam.ask_abdomen'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sym.less_urine', 'sym.leg_cramps']));
    expect(db.exams['exam.general_exam'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sign.dry_mucosa', 'sign.hoarse_voice']));
  });

  test('лечение: I–II — питьё солевых растворов; III — растворы в вену обязательны; IV — и до перевода, питьё не поможет', () => {
    const t = db.conditions[GE].treatment!;
    expect(tacticsFor(t, { severity: 'mild' }).firstLine).toEqual([ORS]);
    expect(tacticsFor(t, { severity: 'moderate' })).toMatchObject({ firstLine: [ORS], acceptable: expect.arrayContaining([IV, 'tx.iv_fluids']) });
    expect(tacticsFor(t, { severity: 'severe' })).toMatchObject({ firstLine: [], acceptable: [ORS], require: [[IV, 'tx.iv_fluids']] });
    expect(tacticsFor(t, { severity: 'critical' })).toMatchObject({ require: [[IV, 'tx.iv_fluids']], beforeTransfer: [[IV, 'tx.iv_fluids']] });
    expect(tacticsFor(t, { severity: 'critical' }).notIndicated).toContain(ORS);
    // антибиотик не нужен: при вирусной этиологии этиотропное лечение не рекомендовано (875_1, раздел 3.1.1)
    expect(t.notIndicated).toEqual(expect.arrayContaining(['tx.fluoroquinolone', 'tx.antibiotic_iv']));
    // при III в боксе без капельницы — обязательное не назначено, лечения причины нет; с ней — всё на месте
    const severe = patient('severe');
    const dry = evaluatePlan(db, severe, { treatments: [ORS], setting: 'box' }, [], { box: true });
    expect([dry.requireMissing, dry.effective]).toEqual([[IV], false]);
    const wet = evaluatePlan(db, severe, { treatments: [IV, ORS], setting: 'box' }, [], { box: true });
    expect([wet.requireMissing, wet.effective]).toEqual([[], true]);
  });

  test('разумный врач: III в больнице с боксом — растворы в вену и «В бокс»; без бокса — перевод', () => {
    const severe = patient('severe');
    const obs = [
      { exam: 'exam.general_exam', f: 'sign.dehydration', shown: true }, { exam: 'exam.ask_abdomen', f: 'sym.diarrhea', shown: true },
      { exam: 'exam.ask_abdomen', f: 'sym.less_urine', shown: true },
    ];
    const here = choosePlan(db, GE, obs, severe, { ward: true, box: true });
    expect(here.setting).toBe('box');
    expect(here.treatments).toContain(IV);
    expect(choosePlan(db, GE, obs, severe, { ward: true }).setting).toBe('ambulance');
  });
});

describe('бокс: помещение, поступление, касса', () => {
  test('бокс на одного больного с медсестрой: его койка — не палата', () => {
    expect(db.rooms['room.box']).toMatchObject({ box: true, beds: false, icu: false, staff: ['role.nurse'] });
    expect(db.rooms['room.box'].sizes.map(z => [z.id, z.beds])).toEqual([['S', 1]]);
    const { s, rooms } = withBox(2);
    expect(boxBeds(db, s)).toEqual(rooms.map(room => ({ room, bed: 0 })));
    expect(wardBeds(db, s)).toEqual([]);
  });

  test('III степень — «В бокс» и растворы в вену: место A, лежит в боксе; ночь в боксе — свой койко-день', () => {
    const { s, rooms } = withBox(1);
    apply(db, s, { kind: 'nextDay' });
    const p = gastro(s, 'severe');
    apply(db, s, { kind: 'toggleTreatment', id: IV });
    apply(db, s, { kind: 'setting', setting: 'box' });
    expect(p.draft.setting).toBe('box');
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.closed!.notes.filter(n => n.code.startsWith('setting.') || n.code.startsWith('tx.require'))).toEqual([]);
    expect([p.status, p.stay!.room, inBox(db, s, p)]).toEqual(['admitted', rooms[0], true]);
    expect(freeBoxBeds(db, s)).toEqual([]);
    expect(s.summary.ward).toMatchObject({ admitted: 1, box: 1 });
    apply(db, s, { kind: 'closeDay' });
    expect(s.summary.ward).toMatchObject({ lying: 1, boxLying: 1 });
    expect(s.summary.economy!.ledger.expenses.ward).toBe(db.economy.box.bedDay);
  });

  test('бокс занят — «В бокс» не выбрать; заразный в общей палате — меньше нужного, соседи контактные; перевод — не ошибка', () => {
    const { s } = withBox(1, true);
    apply(db, s, { kind: 'nextDay' });
    const first = gastro(s, 'severe');
    apply(db, s, { kind: 'toggleTreatment', id: IV });
    apply(db, s, { kind: 'setting', setting: 'box' });
    apply(db, s, { kind: 'finish' });
    expect(inBox(db, s, first)).toBe(true);
    const second = gastro(s, 'severe');
    apply(db, s, { kind: 'setting', setting: 'box' });
    expect(second.draft.setting).not.toBe('box');
    apply(db, s, { kind: 'toggleTreatment', id: IV });
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    expect(second.closed!.grades.setting).toBe('D');
    expect(second.closed!.notes.map(n => n.code)).toEqual(expect.arrayContaining(['setting.under', 'setting.contacts']));
    const third = gastro(s, 'severe');
    apply(db, s, { kind: 'setting', setting: 'ambulance' });
    apply(db, s, { kind: 'finish' });
    expect(third.closed!.grades.setting).toBe('A');
  });

  test('прибавка за бокс — только если изоляция была нужна; койко-день в боксе дороже палатного', () => {
    const t = db.economy.tariffs;
    expect(wardIncome(db, GE, 'A', 'full', undefined, 'box')).toBe(wardIncome(db, GE, 'A', 'full') + t.omsBox);
    expect(db.economy.box.bedDay).toBeGreaterThan(db.economy.ward.bedDay);
    expect([careUnit('box', 'box'), careUnit('box', 'ward'), careUnit('admit', 'box')]).toEqual(['box', undefined, undefined]);
  });

  test('те же команды — тот же итог: бокс и поступление детерминированы', () => {
    const run = () => {
      const { s } = withBox(1, false, 77);
      apply(db, s, { kind: 'nextDay' });
      gastro(s, 'severe');
      apply(db, s, { kind: 'toggleTreatment', id: IV });
      apply(db, s, { kind: 'setting', setting: 'box' });
      apply(db, s, { kind: 'finish' });
      apply(db, s, { kind: 'closeDay' });
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });
});

describe('бокс: энциклопедия', () => {
  test('у гастроэнтерита — путь передачи и куда без своих боксов; у бокса — медсестра', () => {
    const where = article(db, GE)!.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toEqual(expect.arrayContaining([
      'Заразна: передаётся через руки, посуду и предметы.',
      'Своих боксов нет — скорая или перевод в инфекционную больницу; в общую палату заразного не кладут.',
    ]));
    const needs = article(db, 'room.box')!.blocks.find(b => b.key === 'needs')!.rows!;
    expect(needs.map(r => [r.label, r.refs.map(x => x.id)])).toEqual([['Люди', ['role.nurse']]]);
  });
});
