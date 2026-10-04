// Хирургия живота (spec 2026-09-chapter-2, часть 30а): больница с работающей смотровой приёмного
// принимает и хирургию — пациент помнит, с какими отделениями его приняли; желчная колика и
// холецистит — только при камнях, панкреатит — чаще у пьющих и с камнями; скорая везёт человека,
// а не болезнь; холецистэктомия — в первые 72 ч от начала болезни; идеальный врач считает
// неизвестное о пациенте по его доле; экраны, энциклопедия, повтор.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { P_ONE } from '../../src/engine/core/rng';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { carriedWeight, generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { contextOf, posterior, priorWeight, sharesFor, unknownsOf } from '../../src/engine/med/infer';
import { recommendedSetting } from '../../src/engine/med/plan';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, current, departmentsOf, newSandbox, newShift } from '../../src/engine/shift/engine';
import { onsetHours } from '../../src/engine/shift/surgery';
import { SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { diagnosisGroups, makeCaseView, noteText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';
import { sanitizeProfile } from '../../src/state/profile';
import { memoryStore, saveSlot } from '../../src/state/saves';
import { forgetShift, loadShift, SANDBOX_SLOT, setStore, shiftCaseView } from '../../src/state/session';

const BOTH = ['dept.therapy', 'dept.surgery'];
/** смотровая приёмного принимает и хирургию, и травму (часть 32) */
const ED = [...BOTH, 'dept.trauma'];
// с частью 33а — и вены ног: тромбоз глубоких вен и тромбофлебит лечит хирург
const SURGICAL = ['cond.adhesive_sbo', 'cond.biliary_colic', 'cond.cholecystitis', 'cond.diverticulitis', 'cond.dvt', 'cond.limb_ischemia', 'cond.pancreatitis', 'cond.paraproctitis', 'cond.perforated_ulcer', 'cond.renal_colic', 'cond.strangulated_hernia', 'cond.superficial_thrombophlebitis', 'cond.ulcer_bleeding'];
const OP = 'tx.cholecystectomy';

/** Песочница с готовой амбулаторией и смотровой приёмного справа; медсестра ЭКГ — в смотровую. */
function withEmergency(seed = 21): { s: ShiftState; room: string; nurse: string } {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size: 'M', x: 29, y: 1, rot: 0 } });
  apply(db, s, { kind: 'buildEnd' });
  const room = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const nurse = s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!;
  apply(db, s, { kind: 'assign', id: nurse.id, room });
  return { s, room, nurse: nurse.id };
}

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
  return { s, ward, or };
}

/** Больные из генератора в больнице с приёмным: зёрна подряд. */
const people = (n: number, from = 1, extra: { primary?: Id; carried?: boolean } = {}) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, {
    department: 'dept.therapy', departments: BOTH, season: 'winter',
    ...(extra.primary ? { primary: extra.primary } : {}), ...(extra.carried ? { carried: db.economy.ambulance.weight } : {}),
  }));
const primary = (p: Patient) => p.truth.conditions[0].id;
const has = (p: Patient, id: Id) => p.truth.conditions.some(c => c.id === id) || p.truth.risks.includes(id);
const share = (xs: readonly Patient[], f: (p: Patient) => boolean) => xs.filter(f).length / xs.length;

/** Первый в очереди — этот больной, принятый вместе с хирургией; вызван, осмотрен, с диагнозом. */
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

describe('отделения больницы: с приёмным — и хирургия', () => {
  test('практика и песочница без смотровой — одна терапия; работает смотровая — и хирургия; пациент помнит, с какими приняли', () => {
    const practice = newShift(db, { seed: 5, season: 'winter' });
    expect(departmentsOf(db, practice)).toEqual(['dept.therapy']);
    expect(Object.values(practice.patients).every(p => p.departments === undefined)).toBe(true);
    const plain = newSandbox(db, { seed: 21, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
    expect(departmentsOf(db, plain)).toEqual(['dept.therapy']);

    const { s, nurse } = withEmergency();
    expect(departmentsOf(db, s)).toEqual(ED);
    expect(candidatesOf(db, BOTH)).toEqual(expect.arrayContaining(SURGICAL));
    expect(candidatesOf(db, 'dept.therapy').some(id => SURGICAL.includes(id))).toBe(false);
    apply(db, s, { kind: 'nextDay' });
    const today = Object.values(s.patients);
    expect(today.length).toBeGreaterThan(0);
    for (const p of today) expect(p.departments).toEqual(ED);
    // вечером медсестру вернули в кабинет ЭКГ — смотровая не работает: завтра одна терапия, а
    // принятые сегодня помнят хирургию — их разбор по тем же болезням
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'assign', id: nurse, room: 'r7' });
    expect(departmentsOf(db, s)).toEqual(['dept.therapy']);
    apply(db, s, { kind: 'nextDay' });
    for (const p of today) expect(p.departments).toEqual(ED);
    const tomorrow = Object.values(s.patients).filter(p => !today.includes(p) && !p.returnOf);
    expect(tomorrow.length).toBeGreaterThan(0);
    for (const p of tomorrow) expect(p.departments).toBeUndefined();
  });

  test('диагноз — из болезней этих отделений: в амбулатории холецистит не принимается, с приёмным — да', () => {
    const practice = newShift(db, { seed: 5, season: 'winter' });
    for (let i = 0; i < 60 && practice.queue.length === 0; i++) apply(db, practice, { kind: 'advance', seconds: 10 * 60 });
    apply(db, practice, { kind: 'call', id: practice.queue[0] });
    apply(db, practice, { kind: 'diagnose', id: 'cond.cholecystitis' });
    expect(current(practice)!.draft.diagnosis).toBeUndefined();
    apply(db, practice, { kind: 'diagnose', id: 'cond.appendicitis' });
    expect(current(practice)!.draft.diagnosis).toBe('cond.appendicitis');

    const { s } = withEmergency();
    apply(db, s, { kind: 'nextDay' });
    for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
    apply(db, s, { kind: 'call', id: s.queue[0] });
    apply(db, s, { kind: 'diagnose', id: 'cond.cholecystitis' });
    expect(current(s)!.draft.diagnosis).toBe('cond.cholecystitis');
  });

  test('без приёмного хирургических больных нет; с ним — есть, и отделение пациента — его болезни', () => {
    const therapy = Array.from({ length: 4000 }, (_, i) => generatePatient(db, 1 + i, { department: 'dept.therapy', season: 'winter' }));
    expect(therapy.some(p => SURGICAL.includes(primary(p)))).toBe(false);
    const both = people(4000);
    const surgical = both.filter(p => SURGICAL.includes(primary(p)));
    expect(surgical.length).toBeGreaterThan(40);
    for (const p of surgical) expect(p.department).toBe('dept.surgery');
    for (const p of both.filter(p => !SURGICAL.includes(primary(p)))) expect(p.department).toBe('dept.therapy');
    // у пришедших сами прогон терапии похож на прежний: те же зёрна — те же люди и в основном те же
    // болезни; веса хирургии сдвигают жребий болезни у части (до почечной колики, часть 30г, — у
    // 11 %, с ней — у 18 %, с тромбозом глубоких вен и тромбофлебитом, часть 33а, — у 29 %: по
    // алфавиту они раньше почти всей терапии и сдвигают её доли жребия)
    const same = both.filter((p, i) => primary(p) === primary(therapy[i])).length;
    expect(same / both.length).toBeGreaterThan(0.65);
  }, 30_000);
});

/**
 * Доли причин панкреатита по весам генератора: у каждого человека болезнь выбирается с весом
 * presentingWeight среди болезней отделений (у скорой — ещё и по тяжести), — считаем ожидание,
 * а не бросаем жребий: точнее и быстрее, чем родить десятки тысяч больных.
 */
function etiology(crowd: readonly Patient[], carried = false) {
  const ids = Object.keys(db.conditions).filter(id => BOTH.includes(db.conditions[id].department));
  const k = (id: Id) => (carried ? carriedWeight(db.conditions[id], db.economy.ambulance.weight) : 1);
  let alcohol = 0;
  let stones = 0;
  let total = 0;
  for (const p of crowd) {
    const chronic = p.truth.conditions.filter(c => c.role === 'comorbid').map(c => c.id);
    const who = { sex: p.sex, age: p.age, season: p.season, risks: p.truth.risks, chronic };
    const w = (id: Id) => presentingWeight(db.conditions[id], who) * k(id);
    const pr = w('cond.pancreatitis') / ids.reduce((a, id) => a + w(id), 0);
    total += pr;
    if (p.truth.risks.includes('risk.alcohol')) alcohol += pr;
    else if (chronic.includes('cond.cholelithiasis')) stones += pr;
  }
  return { alcohol: alcohol / total, stones: stones / total, other: 1 - (alcohol + stones) / total, perPatient: total / crowd.length };
}

describe('желчь и поджелудочная: кто болеет', () => {
  const crowd = people(12000);

  test('камни в желчном пузыре — у каждого восьмого (877_1: 10–15 %), при ожирении — вдвое чаще', () => {
    const stones = share(crowd, p => has(p, 'cond.cholelithiasis'));
    expect(stones).toBeGreaterThan(0.1);
    expect(stones).toBeLessThan(0.15);
    const obese = crowd.filter(p => has(p, 'risk.obesity'));
    const lean = crowd.filter(p => !has(p, 'risk.obesity'));
    expect(share(obese, p => has(p, 'cond.cholelithiasis')) / share(lean, p => has(p, 'cond.cholelithiasis'))).toBeGreaterThan(1.7);
    // камни есть у всех, найдёт ли их УЗИ — точность обследования
    for (const p of crowd.filter(p => has(p, 'cond.cholelithiasis'))) expect(p.truth.findings.some(f => f.f === 'img.us_gallstones')).toBe(true);
  });

  test('колика и холецистит — только у тех, у кого камни; заданная болезнь добавляет их сама', () => {
    const biliary = crowd.filter(p => ['cond.biliary_colic', 'cond.cholecystitis'].includes(primary(p)));
    expect(biliary.length).toBeGreaterThan(20);
    for (const p of biliary) expect(has(p, 'cond.cholelithiasis')).toBe(true);
    for (const p of people(50, 1, { primary: 'cond.cholecystitis' })) expect(has(p, 'cond.cholelithiasis')).toBe(true);
  });

  test('панкреатит: алкогольный — около 55 %, билиарный — 35 %, остальные — 10 % (903_1, раздел 1.2)', () => {
    const e = etiology(crowd);
    expect(e.alcohol).toBeGreaterThan(0.51);
    expect(e.alcohol).toBeLessThan(0.59);
    expect(e.stones).toBeGreaterThan(0.31);
    expect(e.stones).toBeLessThan(0.39);
    expect(e.other).toBeGreaterThan(0.07);
    expect(e.other).toBeLessThan(0.13);
    // и жребий генератора: у пришедших с панкреатитом — те же причины
    const acute = crowd.filter(p => primary(p) === 'cond.pancreatitis');
    expect(acute.length).toBeGreaterThan(100);
    expect(share(acute, p => has(p, 'risk.alcohol'))).toBeGreaterThan(0.4);
    // тяжёлый (некротический) — 15–20 % (903_1, раздел 1.2)
    const severe = share(people(400, 1, { primary: 'cond.pancreatitis' }), p => p.truth.conditions[0].params.severity === 'severe');
    expect(severe).toBeGreaterThan(0.12);
    expect(severe).toBeLessThan(0.23);
  });

  test('панкреатит: лёгкий — в стационар, тяжёлый и с перитонеальными симптомами — перевод (903_1, раздел 6)', () => {
    const mild = people(200, 1, { primary: 'cond.pancreatitis' }).filter(p => p.truth.conditions[0].params.severity === 'mild');
    const calm = mild.find(p => !p.truth.findings.some(f => f.f === 'sign.peritoneal_signs'))!;
    expect(recommendedSetting(db, calm)).toBe('ambulance');
    const flagged = mild.find(p => p.truth.findings.some(f => f.f === 'sign.peritoneal_signs'))!;
    expect(recommendedSetting(db, flagged)).toBe('transfer');
    const severe = generatePatient(db, 7, { department: 'dept.therapy', departments: BOTH, season: 'winter', primary: 'cond.pancreatitis', params: { severity: 'severe' } });
    expect(recommendedSetting(db, severe)).toBe('transfer');
  });
});

describe('скорая везёт человека, а не болезнь', () => {
  test('лёгкое не везут; колика — с камнями; у панкреатита причины — от людей, а не доли всех', () => {
    const carried = people(3000, 500_000, { carried: true });
    const w = db.economy.ambulance.weight;
    for (const p of carried) {
      const c = db.conditions[primary(p)];
      expect(w[c.severity]).toBeGreaterThan(0);
      expect(c.treatment).toBeDefined();
    }
    const biliary = carried.filter(p => ['cond.biliary_colic', 'cond.cholecystitis'].includes(primary(p)));
    expect(biliary.length).toBeGreaterThan(10);
    for (const p of biliary) expect(has(p, 'cond.cholelithiasis')).toBe(true);
    // прежде болезнь выбиралась без человека — пьющих среди больных панкреатитом было бы как
    // среди всех, около 9 %; теперь у скорой почти те же причины, что у пришедших сами
    const e = etiology(people(4000, 800_000), true);
    expect(e.alcohol).toBeGreaterThan(0.45);
    expect(e.stones).toBeGreaterThan(0.3);
  });

  test('в песочнице со смотровой скорая привозит и хирургических, ОМС; их можно назвать хирургическим диагнозом', () => {
    const brought: ShiftPatient[] = [];
    const { s } = withEmergency(23);
    for (let d = 0; d < 12; d++) {
      apply(db, s, { kind: 'nextDay' });
      brought.push(...Object.values(s.patients).filter(p => p.kind === 'ambulance' && !brought.includes(p)));
      apply(db, s, { kind: 'closeDay' });
    }
    expect(brought.length).toBeGreaterThan(20);
    for (const p of brought) {
      expect(p.departments).toEqual(ED);
      expect(p.payer).toBe('oms');
    }
    expect(brought.some(p => SURGICAL.includes(primary(p.patient)))).toBe(true);
  });
});

describe('холецистэктомия: срок — от начала болезни', () => {
  /** Больные холециститом без аллергий: первый, у кого начало болезни подходит. */
  const patientWith = (fits: (hours: number) => boolean) => people(400, 1, { primary: 'cond.cholecystitis' })
    .find(p => !p.truth.risks.some(r => r.startsWith('risk.allergy_')) && fits(onsetHours(p)))!;

  test('в запись попадает «от начала болезни»; у аппендицита — прежнее «от поступления»', () => {
    expect(db.conditions['cond.cholecystitis'].surgery).toEqual({ tx: OP, window: 72, from: 'onset' });
    expect(db.conditions['cond.appendicitis'].surgery).toEqual({ tx: 'tx.appendectomy', window: 24 });
  });

  test('заболел сутки назад — в срок; на четвёртые сутки — позже срока в 72 ч, хоть оперировали сразу', () => {
    const { s, or } = withOr(36);
    apply(db, s, { kind: 'nextDay' });
    const early = treatWith(s, patientWith(h => h < 40), 'cond.cholecystitis');
    apply(db, s, { kind: 'setting', setting: 'surgery' });
    apply(db, s, { kind: 'finish' });
    expect(early.stay!.op).toMatchObject({ tx: OP, room: or });
    apply(db, s, { kind: 'advance', seconds: early.stay!.op!.end! - s.t });
    const onTime = early.closed!.notes.find(n => n.code === 'op.onTime')!;
    expect(onTime).toMatchObject({ code: 'op.onTime', tx: OP, window: 72, onset: true });
    const hours = (onTime as { hours: number }).hours;
    expect(hours).toBeGreaterThanOrEqual(onsetHours(early.patient) - 0.05);
    expect(hours).toBeLessThan(40 + 2);
    expect(noteText(onTime)).toBe(T.spikes.patient.note.opOnTime('Холецистэктомия', hours, 72, true));
    expect(noteText(onTime)).toContain('от начала болезни: в срок');
    // 60 минут — игровая оценка длительности
    expect(early.stay!.op!.end! - early.stay!.op!.start!).toBe(60 * 60);

    const late = treatWith(s, patientWith(h => h > 80), 'cond.cholecystitis');
    apply(db, s, { kind: 'setting', setting: 'surgery' });
    apply(db, s, { kind: 'finish' });
    apply(db, s, { kind: 'advance', seconds: late.stay!.op!.end! - s.t });
    const note = late.closed!.notes.find(n => n.code === 'op.late')!;
    expect(note).toMatchObject({ code: 'op.late', tx: OP, window: 72, onset: true });
    expect((note as { hours: number }).hours).toBeGreaterThan(72);
    expect(noteText(note)).toContain('от начала болезни: позже срока в 72 ч');
    expect(s.summary.surgery).toMatchObject({ done: 2, onTime: 1, late: 1 });
  });

  test('энциклопедия: у холецистита — операция в первые 72 ч от начала болезни; у операции — что лечит', () => {
    const cond = JSON.stringify(article(db, 'cond.cholecystitis')!);
    expect(cond).toContain(T.encyclopedia.whereSurgery('Холецистэктомия', 72, true));
    expect(cond).toContain('в первые 72 ч от начала болезни');
    expect(cond).toContain(T.encyclopedia.whereStay(3, 6));
    const op = article(db, OP)!;
    const treats = op.blocks.find(b => b.key === 'treats')!;
    expect(JSON.stringify(treats)).toContain(T.encyclopedia.opWindow(72, true));
    expect(JSON.stringify(article(db, 'cond.appendicitis')!)).toContain(T.encyclopedia.whereSurgery('Аппендэктомия', 24));
  });
});

describe('идеальный врач: неизвестное о пациенте — по его доле', () => {
  const woman = { sex: 'f' as const, age: 50, season: 'winter' as const };
  const base = { ...woman, knownRisks: [] as Id[], knownConditions: [] as Id[] };
  const askedStones = (shown: boolean): Observation => ({ f: 'hx.gallstones', shown, exam: 'exam.ask_chronic' });
  const pObese = db.risks['risk.obesity'].p.f / P_ONE;
  const pStones = (db.conditions['cond.cholelithiasis'].chronic!.p / P_ONE) * (1 - pObese + 2 * pObese);
  const x = (id: Id) => db.conditions['cond.pancreatitis'].risks!.find(r => r.id === id)!.x;
  const [xAlcohol, xStones] = [x('risk.alcohol'), x('cond.cholelithiasis')];

  test('камни: доля у такого человека; «о камнях не знает» — реже; сказал о них — известны наверняка', () => {
    expect(unknownsOf(db, [], base).share.get('cond.cholelithiasis')).toBeCloseTo(pStones, 10);
    // ответ «нет»: камни без жалоб на них не знают три из четырёх (связь «иногда»), расспрос — 95/99
    const yes = 0.25 * 0.05 + 0.75 * 0.99;
    const denied = (pStones * yes) / (pStones * yes + (1 - pStones) * 0.99);
    expect(unknownsOf(db, [askedStones(false)], base).share.get('cond.cholelithiasis')).toBeCloseTo(denied, 10);
    const told = contextOf(db, woman, [askedStones(true)]);
    expect(told.knownConditions).toEqual(['cond.cholelithiasis']);
    expect(told.unknowns.share.has('cond.cholelithiasis')).toBe(false);
  });

  test('у кандидата с множителем риска доля своя: при панкреатите камни и алкоголь чаще', () => {
    const ctx = contextOf(db, woman, []);
    const shares = sharesFor(db, 'cond.pancreatitis', ctx);
    const pa = ctx.unknowns.share.get('risk.alcohol')!;
    expect(shares.get('cond.cholelithiasis')).toBeCloseTo((pStones * xStones) / (pStones * xStones + 1 - pStones), 10);
    expect(shares.get('risk.alcohol')).toBeCloseTo((pa * xAlcohol) / (pa * xAlcohol + 1 - pa), 10);
    // то, без чего кандидат не бывает, — в наборе наверняка, а не фоном
    expect(sharesFor(db, 'cond.biliary_colic', ctx).get('cond.cholelithiasis')).toBe(0);
  });

  test('панкреатит, пока не спросили об алкоголе, — в среднем по доле пьющих; сказал, что пьёт, — в 18 раз чаще', () => {
    const ctx = contextOf(db, woman, []);
    const pa = ctx.unknowns.share.get('risk.alcohol')!;
    const drinks = contextOf(db, woman, [{ f: 'hx.alcohol', shown: true, exam: 'exam.ask_lifestyle' }]);
    expect(drinks.knownRisks).toContain('risk.alcohol');
    expect(priorWeight(db, 'cond.pancreatitis', drinks) / priorWeight(db, 'cond.pancreatitis', ctx)).toBeCloseTo(xAlcohol / (1 - pa + xAlcohol * pa), 6);
  });

  test('камни на УЗИ — довод за колику примерно в 6 раз, а не в 19: у каждого восьмого они есть и без неё', () => {
    const us: Observation = { f: 'img.us_gallstones', shown: true, exam: 'exam.us_abdomen' };
    const pair = ['cond.appendicitis', 'cond.biliary_colic'];
    const odds = (obs: Observation[]) => {
      const b = posterior(db, pair, obs, contextOf(db, woman, obs));
      return b.find(x => x.id === 'cond.biliary_colic')!.p / b.find(x => x.id === 'cond.appendicitis')!.p;
    };
    const lr = odds([us]) / odds([]);
    expect(lr).toBeCloseTo(0.95 / (0.95 * pStones + 0.05 * (1 - pStones)), 6);
    expect(lr).toBeGreaterThan(5);
    expect(lr).toBeLessThan(7);
  });
});

describe('экраны', () => {
  test('диагнозы: в больнице с приёмным — и хирургические, среди болезней пищеварения, колика — мочевой системы, сосуды ног — сердца и сосудов; в амбулатории — нет', () => {
    const ids = (g: ReturnType<typeof diagnosisGroups>) => g.flatMap(x => x.items.map(i => i.id));
    expect(ids(diagnosisGroups()).some(id => SURGICAL.includes(id))).toBe(false);
    const both = diagnosisGroups(BOTH);
    const group = (key: string) => both.find(g => g.key === key)!.items.map(i => i.id);
    // вены (часть 33а) и артерии ног (часть 33б) — в «Сердце и сосуды»
    const VEINS = ['cond.dvt', 'cond.superficial_thrombophlebitis', 'cond.limb_ischemia'];
    expect(group('digestive')).toEqual(expect.arrayContaining(SURGICAL.filter(id => id !== 'cond.renal_colic' && !VEINS.includes(id))));
    expect(group('urinary')).toEqual(expect.arrayContaining(['cond.renal_colic', 'cond.pyelonephritis']));
    expect(group('heart')).toEqual(expect.arrayContaining([...VEINS, 'cond.acs']));
    expect(ids(both)).not.toContain('cond.cholelithiasis');
  });

  test('УЗИ: желчный пузырь — с камнями и утолщённой стенкой, если их показало; отросток — «мишенью»', () => {
    const p = people(1, 1, { primary: 'cond.cholecystitis' })[0];
    const view = (obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: [{ exam: 'exam.us_abdomen', step: 1, at: 600, obs }], pending: [], meanwhile: [], done: ['exam.us_abdomen'],
      draft: { treatments: [], setting: 'home' }, departments: BOTH,
    }).groups.find(g => g.exam === 'exam.us_abdomen')!.image;
    const us = (f: string, shown: boolean): Observation => ({ f, shown, exam: 'exam.us_abdomen' });
    expect(view([us('img.us_gallstones', true), us('img.us_cholecystitis', true), us('img.us_appendicitis', false)]))
      .toMatchObject({ kind: 'us', view: 'gallbladder', stones: 3, wall: 0.8 });
    expect(view([us('img.us_gallstones', false), us('img.us_cholecystitis', false), us('img.us_appendicitis', false)]))
      .toMatchObject({ kind: 'us', view: 'gallbladder', stones: 0, wall: 0 });
    expect(view([us('img.us_appendicitis', true)])).toMatchObject({ kind: 'us', view: 'appendix', appendix: 0.8 });
  });

  test('приём в песочнице со смотровой: в выборе диагноза — холецистит; в амбулатории практики — нет', async () => {
    const { s } = withEmergency();
    apply(db, s, { kind: 'nextDay' });
    for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
    apply(db, s, { kind: 'call', id: s.queue[0] });
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    const ids = shiftCaseView()!.diagnoses.flatMap(g => g.items.map(i => i.id));
    expect(ids).toEqual(expect.arrayContaining(SURGICAL));
    forgetShift();
  });

  test('архив: отделения пациента — только списком строк; испорченные — как у прежних записей', () => {
    const { s } = withEmergency();
    apply(db, s, { kind: 'nextDay' });
    const p = structuredClone(Object.values(s.patients)[0]);
    p.closed = { at: 0 } as ShiftPatient['closed'];
    const record = { key: 'k', seed: 1, department: 'dept.therapy', day: 1, patient: p };
    const bad = { ...record, key: 'b', patient: { ...p, departments: 'dept.surgery' } };
    const out = sanitizeProfile({ archive: [record, bad] }).archive;
    expect(out.map(r => r.patient.departments)).toEqual([ED, undefined]);
  });
});
