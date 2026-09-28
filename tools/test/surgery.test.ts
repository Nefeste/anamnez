// Операционная своей больницы (spec 2026-09-chapter-2, часть 28): бригада и аппараты, «В
// операционную» в решении и с обхода; очередь операционной и операция по часам смены, ночью —
// без отсрочки до утра; осложнение — по доле операции и навыку хирурга из ветви зерна пациента;
// в срок ли — по окну болезни; касса — прибавка ОМС за операцию и расходники; кого нанимают в
// главе; экраны решения, обхода, карты и итогов; повтор по тем же командам.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { ContentDb } from '../../src/content/types';
import { P_ONE } from '../../src/engine/core/rng';
import { wardIncome } from '../../src/engine/economy/economy';
import { layoutOf } from '../../src/engine/hospital/clinic';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { generatePatient } from '../../src/engine/med/generate';
import { choiceFor, settingFit, txRole } from '../../src/engine/med/plan';
import { apply, freeBeds, hospitalCtx, inpatientsOf, newCampaign, newSandbox, orBlock, orQueueOf } from '../../src/engine/shift/engine';
import { COMPLICATION_DAYS, complicationsOf, operationFor } from '../../src/engine/shift/surgery';
import { SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { noteText } from '../../src/state/caseView';
import { placements } from '../../src/state/clinicMap';
import { article } from '../../src/state/encyclopedia';
import { memoryStore, saveSlot } from '../../src/state/saves';
import { forgetShift, loadShift, roundsView, SANDBOX_SLOT, setStore, shiftCaseView, shiftView } from '../../src/state/session';

const OP = 'tx.appendectomy';
const TEAM = ['role.surgeon', 'role.anesthetist', 'role.or_nurse'];

/**
 * Песочница с готовой амбулаторией; справа — коридор, над ним палата на четыре койки (медсестра
 * ЭКГ — в неё), под ним операционная: стол, наркозный аппарат и бригада навыка `skill`.
 */
function withOr(seed = 31, o: { d?: ContentDb; skill?: number; equipment?: readonly string[]; team?: readonly string[] } = {}) {
  const d = o.d ?? db;
  const s = newSandbox(d, { seed, season: 'winter', start: 'clinic', budget: d.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(d, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(d, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ward', size: 'M', x: 29, y: 0, rot: 0 } });
  apply(d, s, { kind: 'build', cmd: { kind: 'room', type: 'room.or', size: 'M', x: 29, y: 10, rot: 2 } });
  const ward = s.hospital!.rooms.find(r => r.type === 'room.ward')!.id;
  const or = s.hospital!.rooms.find(r => r.type === 'room.or')!.id;
  for (const equipment of o.equipment ?? ['eq.or_table', 'eq.anesthesia']) apply(d, s, { kind: 'build', cmd: { kind: 'buy', room: or, equipment } });
  apply(d, s, { kind: 'buildEnd' });
  const nurse = s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!;
  apply(d, s, { kind: 'assign', id: nurse.id, room: ward });
  (o.team ?? TEAM).forEach((role, i) => {
    const skill = o.skill ?? 3;
    const m: StaffMember = { id: `t${i + 1}`, role, sex: i % 2 === 0 ? 'm' : 'f', seed: 100 + i, skill, salary: salaryOf(d, role, skill), days: 0 };
    s.staff = [...s.staff!, m];
    apply(d, s, { kind: 'assign', id: m.id, room: or });
  });
  return { s, ward, or };
}

/** Первый в очереди — пациент с этой болезнью, вызван в кабинет; диагноз и лечение — как у разумного врача. */
function treat(s: ShiftState, primary: string, treatments: string[] = [], d: ContentDb = db): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(d, s, { kind: 'advance', seconds: 10 * 60 });
  const id = s.queue[0];
  const p = s.patients[id];
  // без аллергии на назначенное: реакция — отдельный случай
  const n = Number(id.split('-')[1] ?? 0);
  for (let k = 0; ; k++) {
    p.patient = generatePatient(d, 9_000 + 100 * n + k, { department: 'dept.therapy', season: 'winter', primary, params: {} });
    if (!p.patient.truth.risks.some(r => r.startsWith('risk.allergy_'))) break;
  }
  apply(d, s, { kind: 'call', id });
  apply(d, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(d, s, { kind: 'diagnose', id: primary });
  for (const tx of treatments) apply(d, s, { kind: 'toggleTreatment', id: tx });
  return p;
}

/** Аппендицит — в операционную. */
function operated(s: ShiftState, d: ContentDb = db): ShiftPatient {
  const p = treat(s, 'cond.appendicitis', [], d);
  apply(d, s, { kind: 'setting', setting: 'surgery' });
  apply(d, s, { kind: 'finish' });
  return p;
}

/** Ждать, пока в очереди не наберётся `n` человек: следующих вызывают сразу, стол ещё занят. */
function crowd(s: ShiftState, n: number) {
  for (let i = 0; i < 60 && s.queue.length < n; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
}

const night = (s: ShiftState, d: ContentDb = db) => {
  apply(d, s, { kind: 'closeDay' });
  apply(d, s, { kind: 'nextDay' });
};

/** База, где у аппендэктомии такая доля осложнений (1/10 000). */
function withComplications(p: number): ContentDb {
  const d = structuredClone(db);
  d.treatments[OP].surgery!.complications = p;
  return d;
}

describe('операционная: где лечить и когда она работает', () => {
  test('своя операционная закрывает «операцию»; без неё — скорая; операция болезни — первая линия', () => {
    expect(choiceFor('surgery', { ward: true, or: true })).toBe('surgery');
    expect(choiceFor('surgery', { ward: true })).toBe('ambulance');
    expect(choiceFor('ward', { ward: true, or: true })).toBe('admit');
    expect(choiceFor('transfer', { ward: true, or: true })).toBe('ambulance');
    expect(settingFit('surgery', 'surgery')).toBe('ok');
    expect(settingFit('ward', 'surgery')).toBe('over');
    expect(settingFit('surgery', 'admit')).toBe('under');
    expect(operationFor(db, 'cond.appendicitis')).toBe(OP);
    expect(operationFor(db, 'cond.pneumonia_cap')).toBeUndefined();
    expect(txRole(db, 'cond.appendicitis', OP)).toBe('firstLine');
    expect(txRole(db, 'cond.pneumonia_cap', OP)).toBe('notIndicated');
  });

  test('работает с бригадой и обоими аппаратами; нет — почему: помещения, людей, аппарата', () => {
    const plain = newSandbox(db, { seed: 3, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
    expect(orBlock(db, plain)).toEqual({ kind: 'noRoom' });
    expect(orBlock(db, withOr(31, { equipment: [], team: [] }).s)).toEqual({ kind: 'down', problem: { kind: 'noEquipment' } });
    expect(orBlock(db, withOr(31, { team: TEAM.slice(1) }).s)).toEqual({ kind: 'down', problem: { kind: 'noStaff', role: 'role.surgeon' } });
    expect(orBlock(db, withOr(31, { equipment: ['eq.or_table'] }).s, OP)).toEqual({ kind: 'noEquipment', equipment: 'eq.anesthesia' });
    const { s, or } = withOr();
    expect(orBlock(db, s, OP)).toBeNull();
    // стол — под пациентом: своё место, даже если его купили первым
    const room = hospitalCtx(db, s).plan.rooms.find(r => r.id === or)!;
    expect(room.equipment).toEqual(['eq.anesthesia', 'eq.or_table']);
  });

  test('кандидаты: в песочнице — хирурги и анестезиологи; в главе 1 — только те, чьё помещение глава строит или уже стоит', () => {
    const { s } = withOr();
    const roles = new Set(s.candidates!.map(c => c.role));
    for (const r of TEAM) expect(roles.has(r)).toBe(true);
    const c = newCampaign(db, { seed: 5, season: 'winter', career: 1 });
    const chapter = new Set((c.candidates ?? []).map(m => m.role));
    for (const r of [...TEAM, 'role.radiographer', 'role.radiologist']) expect(chapter.has(r)).toBe(false);
    expect(chapter.has('role.nurse')).toBe(true);
  });
});

describe('операционная: операция по часам смены', () => {
  test('аппендицит — «В операционную»: койка, операция сразу, 45 минут, в срок; расходники — в кассу', () => {
    const { s, or } = withOr();
    apply(db, s, { kind: 'nextDay' });
    const p = operated(s);
    expect(p.status).toBe('admitted');
    expect(p.closed!.plan.setting).toBe('surgery');
    expect(p.closed!.plan.treatments).toContain(OP);
    expect(p.closed!.outcome.kind).toBe('admitted');
    expect(p.closed!.grades.setting).toBe('A');
    expect(freeBeds(db, s)).toHaveLength(3);
    const op = p.stay!.op!;
    expect(op).toMatchObject({ tx: OP, room: or, surgeon: 't1' });
    expect(op.start).toBe(op.queued);
    expect(op.end! - op.start!).toBe(45 * 60);
    // на столе — ни выписать, ни перевести
    apply(db, s, { kind: 'discharge', id: p.id });
    apply(db, s, { kind: 'transfer', id: p.id });
    expect(p.status).toBe('admitted');
    apply(db, s, { kind: 'advance', seconds: op.end! - s.t - 1 });
    expect(p.stay!.op!.done).toBeUndefined();
    const spent = s.economy!.ledger!.expenses.consumables;
    apply(db, s, { kind: 'advance', seconds: 1 });
    expect(p.stay!.op!.done).toBe(true);
    expect(s.economy!.ledger!.expenses.consumables - spent).toBe(db.treatments[OP].cost);
    expect(p.closed!.notes).toContainEqual({ code: 'op.onTime', tx: OP, hours: 0, window: 24 });
    expect(noteText({ code: 'op.onTime', tx: OP, hours: 0, window: 24 })).toBe(T.spikes.patient.note.opOnTime('Аппендэктомия', 0, 24));
    expect(s.summary.surgery).toMatchObject({ done: 1, onTime: 1, late: 0 });
  });

  test('очередь: пока стол занят, следующий ждёт в палате — выписать нельзя; берут по времени решения', () => {
    const { s } = withOr(32);
    apply(db, s, { kind: 'nextDay' });
    crowd(s, 2);
    const a = operated(s);
    const b = operated(s);
    expect(a.stay!.op!.done).toBeUndefined();
    expect(orQueueOf(s).map(p => p.id)).toEqual([b.id]);
    expect(b.stay!.op!.start).toBeUndefined();
    apply(db, s, { kind: 'discharge', id: b.id });
    expect(b.status).toBe('admitted');
    apply(db, s, { kind: 'advance', seconds: a.stay!.op!.end! - s.t });
    expect(a.stay!.op!.done).toBe(true);
    expect(b.stay!.op!.start).toBe(a.stay!.op!.end);
    expect(orQueueOf(s)).toEqual([]);
  });

  test('ночь: идущая операция кончается, очередь оперируют вечером по одному', () => {
    const { s } = withOr(33);
    apply(db, s, { kind: 'nextDay' });
    crowd(s, 2);
    const a = operated(s);
    const b = operated(s);
    apply(db, s, { kind: 'closeDay' });
    expect(a.stay!.op!.done).toBe(true);
    expect(b.stay!.op!).toMatchObject({ done: true, start: a.stay!.op!.end });
    expect(s.summary.surgery!.done).toBe(2);
    expect(s.history[s.history.length - 1].surgery!.done).toBe(2);
    // вечером — расходники обеих операций в кассе дня
    expect(s.summary.economy!.ledger.expenses.consumables).toBeGreaterThanOrEqual(2 * db.treatments[OP].cost);
  });

  test('с обхода: лежал без операции — «В операционную»; через двое суток — позже срока', () => {
    const { s } = withOr(34);
    apply(db, s, { kind: 'nextDay' });
    const p = treat(s, 'cond.appendicitis', ['tx.paracetamol']);
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    // своя операционная работает — аппендицит в палату без операции: меньше нужного
    expect(p.closed!.grades.setting).toBe('D');
    expect(p.stay!.op).toBeUndefined();
    night(s);
    night(s);
    apply(db, s, { kind: 'operate', id: p.id });
    expect(p.stay!).toMatchObject({ replans: 1, planFrom: 2, plan: { setting: 'surgery', treatments: [OP, 'tx.paracetamol'] } });
    expect(p.stay!.op!.start).toBeDefined();
    // второй раз не оперируют
    apply(db, s, { kind: 'operate', id: p.id });
    expect(p.stay!.replans).toBe(1);
    apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
    const late = p.closed!.notes.find(n => n.code === 'op.late');
    expect(late).toMatchObject({ code: 'op.late', tx: OP, window: 24 });
    expect((late as { hours: number }).hours).toBeGreaterThan(24);
    expect(s.summary.surgery).toMatchObject({ done: 1, onTime: 0, late: 1 });
  });

  test('без операции у диагноза — выбор не принят; сменили диагноз — в палату; вид операции в список лечения не попадает', () => {
    const { s } = withOr(35);
    apply(db, s, { kind: 'nextDay' });
    const p = treat(s, 'cond.pneumonia_cap', ['tx.amoxicillin_clavulanate']);
    apply(db, s, { kind: 'setting', setting: 'surgery' });
    expect(p.draft.setting).toBe('home');
    apply(db, s, { kind: 'toggleTreatment', id: OP });
    expect(p.draft.treatments).toEqual(['tx.amoxicillin_clavulanate']);
    apply(db, s, { kind: 'diagnose', id: 'cond.appendicitis' });
    apply(db, s, { kind: 'setting', setting: 'surgery' });
    expect(p.draft.setting).toBe('surgery');
    apply(db, s, { kind: 'diagnose', id: 'cond.pneumonia_cap' });
    expect(p.draft.setting).toBe('admit');
    // выбрали, пока было можно, а операционная не делает эту операцию, — скорая
    p.draft.setting = 'surgery';
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.plan.setting).toBe('ambulance');
    expect(p.stay).toBeUndefined();
  });
});

describe('операционная: исход, касса, повтор', () => {
  test('доля осложнений — запись операции × поправка навыка хирурга', () => {
    const m = (skill: number): StaffMember => ({ id: 'x', role: 'role.surgeon', sex: 'm', seed: 1, skill, salary: 0, days: 0 });
    expect(complicationsOf(db, OP)).toBe(870);
    expect([1, 2, 3, 4, 5].map(k => complicationsOf(db, OP, m(k)))).toEqual(db.economy.staff.surgery.map(k => Math.round((870 * k) / 100)));
    expect(complicationsOf(db, OP, m(1))).toBeGreaterThan(complicationsOf(db, OP, m(5)));
  });

  test('осложнение — стационар дольше на 2–4 суток, строка разбора и итогов; без него — в срок записи', () => {
    const run = (p: number) => {
      const d = withComplications(p);
      const { s } = withOr(36, { d });
      apply(d, s, { kind: 'nextDay' });
      const x = operated(s, d);
      apply(d, s, { kind: 'closeDay' });
      return { s, x };
    };
    const clean = run(0);
    const bad = run(P_ONE);
    expect(clean.x.stay!.op!.complication).toBeUndefined();
    expect(bad.x.stay!.op!.complication).toBe(true);
    const extra = bad.x.stay!.readyAfter! - clean.x.stay!.readyAfter!;
    expect(extra).toBeGreaterThanOrEqual(COMPLICATION_DAYS[0]);
    expect(extra).toBeLessThanOrEqual(COMPLICATION_DAYS[1]);
    // после аппендэктомии — 1–4 суток (325_2)
    expect(clean.x.stay!.readyAfter!).toBeGreaterThanOrEqual(1);
    expect(clean.x.stay!.readyAfter!).toBeLessThanOrEqual(4);
    expect(bad.x.closed!.notes).toContainEqual({ code: 'op.complication', tx: OP });
    expect(clean.x.closed!.notes.some(n => n.code === 'op.complication')).toBe(false);
    expect(bad.s.summary.surgery).toMatchObject({ done: 1, complications: 1 });
  });

  test('после операции смена лечения выписку не сдвигает и операцию из плана не убирает', () => {
    const { s } = withOr(37);
    apply(db, s, { kind: 'nextDay' });
    const p = operated(s);
    apply(db, s, { kind: 'advance', seconds: p.stay!.op!.end! - s.t });
    const ready = p.stay!.readyAfter;
    apply(db, s, { kind: 'replan', id: p.id, treatments: ['tx.paracetamol', OP] });
    expect(p.stay!.plan.treatments).toEqual([OP, 'tx.paracetamol']);
    expect(p.stay!.readyAfter).toBe(ready);
    expect(p.stay!.op!.done).toBe(true);
    // ждёт операции — смена лечения операцию не снимает
    crowd(s, 2);
    const q = operated(s);
    const r = operated(s);
    expect(r.stay!.op!.start).toBeUndefined();
    apply(db, s, { kind: 'replan', id: r.id, treatments: ['tx.paracetamol'] });
    expect(r.stay!.op).toMatchObject({ tx: OP });
    expect(r.stay!.plan.treatments).toContain(OP);
    expect(q.stay!.op).toBeDefined();
  });

  test('касса: случай с операцией — тариф стационара с прибавкой за операцию', () => {
    const full = wardIncome(db, 'cond.appendicitis', 'A', 'full');
    const withOp = wardIncome(db, 'cond.appendicitis', 'A', 'full', true);
    expect(withOp - full).toBe(Math.round((db.economy.tariffs.omsOperation * db.economy.tariffs.omsQuality.A) / 100));
    const { s } = withOr(38);
    apply(db, s, { kind: 'nextDay' });
    const p = operated(s);
    // срок выписки известен после операции: осложнение его продлевает
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
    const days = p.stay!.readyAfter!;
    for (let i = 1; i < days; i++) night(s);
    apply(db, s, { kind: 'discharge', id: p.id });
    expect(p.status).toBe('done');
    expect(p.closed!.outcome.kind).toBe('recovered');
    expect(s.economy!.ledger!.ward).toEqual({ cases: 1, income: wardIncome(db, 'cond.appendicitis', p.closed!.grades.defensibility, 'full', true), interrupted: 0, unindicated: 0 });
  });

  test('те же команды — те же операции, исходы и касса', () => {
    const run = () => {
      const { s } = withOr(39, { skill: 1 });
      apply(db, s, { kind: 'nextDay' });
      crowd(s, 2);
      const a = operated(s);
      const b = operated(s);
      night(s);
      return { a: s.patients[a.id].stay, b: s.patients[b.id].stay, summary: s.history.map(h => h.surgery), cash: s.economy!.cash };
    };
    expect(run()).toEqual(run());
  });
});

describe('операционная: экраны', () => {
  test('решение — «В операционную» с операцией и койками; обход — строка операции; карта — пациент на столе; итоги дня', async () => {
    const { s, or } = withOr(40);
    apply(db, s, { kind: 'nextDay' });
    crowd(s, 2);
    const p = treat(s, 'cond.appendicitis');
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    const option = shiftCaseView()!.settings.find(o => o.key === 'surgery')!;
    expect(option).toEqual({ key: 'surgery', title: T.shift.ward.operate, hint: T.shift.ward.opHint('Аппендэктомия', 4, 4) });
    forgetShift();

    apply(db, s, { kind: 'setting', setting: 'surgery' });
    apply(db, s, { kind: 'finish' });
    const q = operated(s);
    // на карте: оперируемый — на столе, ждущий — на койке
    const ctx = hospitalCtx(db, s);
    const layout = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
    const map = placements(db, layout, s);
    expect(map.find(x => x.id === p.id)).toMatchObject({ where: { cell: layout.tables![or] }, doing: { kind: 'surgery', tx: OP, end: p.stay!.op!.end } });
    expect(map.find(x => x.id === q.id)!.doing).toMatchObject({ kind: 'ward', op: OP });
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    const cards = roundsView();
    const first = cards.find(c => c.id === p.id)!;
    expect(first).toMatchObject({ canDischarge: false, canTransfer: false });
    expect(first.op).toStartWith(T.shift.ward.opOn('Аппендэктомия', '').slice(0, 20));
    expect(first.operate).toBeUndefined();
    const second = cards.find(c => c.id === q.id)!;
    expect(second).toMatchObject({ op: T.shift.ward.opWaiting('Аппендэктомия', 1), canDischarge: false, canTransfer: true });
    forgetShift();

    apply(db, s, { kind: 'closeDay' });
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    const lines = shiftView().summary!.surgeryLines!;
    expect(lines[0]).toBe(T.shift.summary.surgery.line(2, 2, 0));
    const after = roundsView().find(c => c.id === p.id)!;
    expect(after.op).toStartWith(T.shift.ward.opDone('Аппендэктомия'));
    expect(after).toMatchObject({ canDischarge: true, canTransfer: true });
    forgetShift();
  });

  test('обход: лежит без операции, а у диагноза она есть — кнопка; операционная не работает — почему', async () => {
    const { s } = withOr(41);
    apply(db, s, { kind: 'nextDay' });
    const p = treat(s, 'cond.appendicitis');
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    expect(roundsView().find(c => c.id === p.id)!.operate).toEqual({ hint: 'Аппендэктомия' });
    forgetShift();
    // хирурга уволили вечером — утром кнопка неактивна, с причиной
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'fire', id: 't1' });
    apply(db, s, { kind: 'nextDay' });
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    const card = roundsView().find(c => c.id === p.id)!;
    expect(card.operate!.disabled).toBe(true);
    expect(card.operate!.hint).toStartWith('операционная не работает: ');
    forgetShift();
    expect(inpatientsOf(s)).toHaveLength(1);
  });

  test('энциклопедия: у аппендицита — операция и срок, у операции — что лечит, где и бригада', () => {
    const cond = article(db, 'cond.appendicitis')!;
    const text = JSON.stringify(cond);
    expect(text).toContain(T.encyclopedia.whereSurgery('Аппендэктомия', 24));
    expect(text).toContain(T.encyclopedia.whereStay(1, 4));
    const op = JSON.stringify(article(db, OP)!);
    expect(op).toContain(T.encyclopedia.opTeam);
    expect(op).toContain('Хирург');
    expect(op).toContain('Операционная');
    // операционная: что здесь делают — операции; их аппараты нужны все сразу
    const room = article(db, 'room.or')!;
    expect(room.blocks.find(b => b.key === 'doneHere')!.refs!.map(r => r.id)).toEqual([OP]);
    expect(room.blocks.find(b => b.key === 'needs')!.rows!.map(r => r.label)).toEqual([T.encyclopedia.needPeople, T.encyclopedia.needMachines]);
    expect(article(db, 'eq.or_table')!.blocks.find(b => b.key === 'examsBy')!.refs!.map(r => r.id)).toEqual([OP]);
  });
});
