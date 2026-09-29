// Приёмное и скорая (spec 2026-09-chapter-2, часть 27): шкала NEWS2 и цвет по шкале с красными
// флагами; машины скорой — только когда работает смотровая приёмного; лист передачи фельдшера,
// место в смотровой или ожидание у входа; сортирует врач, сверка со шкалой — в итогах дня и в
// разборе (с тревожным признаком, что поднял цвет); привезённый — всегда ОМС; лист передачи на
// экране; конец дня и повтор по тем же командам.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { news2, scaleTriage } from '../../src/engine/med/news2';
import { apply, atDoorOf, emergencyBays, freeBays, newSandbox } from '../../src/engine/shift/engine';
import { type Difficulty, SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { noteText } from '../../src/state/caseView';
import { memoryStore, saveSlot } from '../../src/state/saves';
import { forgetShift, loadShift, SANDBOX_SLOT, setStore, shiftView } from '../../src/state/session';

/** Песочница с готовой амбулаторией и смотровой приёмного справа; медсестра ЭКГ — в смотровую. */
function withEmergency(seed = 21, size: 'S' | 'M' | 'L' = 'M', difficulty: Difficulty = 'doctor'): { s: ShiftState; room: string } {
  const s = newSandbox(db, { seed, season: 'winter', difficulty, start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size, x: 29, y: 1, rot: 0 } });
  apply(db, s, { kind: 'buildEnd' });
  const room = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const nurse = s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!;
  apply(db, s, { kind: 'assign', id: nurse.id, room });
  return { s, room };
}

const ambulance = (s: ShiftState) => Object.values(s.patients).filter(p => p.kind === 'ambulance').sort((a, b) => a.arriveT - b.arriveT);

/** Часы по минуте, пока не выполнится условие (не дольше смены). */
function until(s: ShiftState, done: () => boolean) {
  for (let i = 0; i < 10 * 60 && !done(); i++) apply(db, s, { kind: 'advance', seconds: 60 });
}

describe('NEWS2 и цвет по шкале', () => {
  test('баллы по таблице RCP 2017: норма — 0, по одному показателю 3 — средний, 7 и больше — высокий', () => {
    const normal = news2(db, { 'vital.tachypnea': 16, 'vital.spo2_low': 98, 'vital.bp_high': 125, 'vital.tachycardia': 80, 'vital.fever': 36.8 })!;
    expect(normal).toMatchObject({ points: 0, level: 'low' });
    // частота дыхания 26 — 3 балла сама по себе: средний уровень, хотя сумма мала
    expect(news2(db, { 'vital.tachypnea': 26 })).toMatchObject({ points: 3, level: 'medium' });
    const sick = news2(db, { 'vital.tachypnea': 26, 'vital.spo2_low': 90, 'vital.bp_high': 95, 'vital.tachycardia': 115, 'vital.fever': 38.5 })!;
    expect(sick.parts.map(p => p.points)).toEqual([3, 3, 2, 2, 1]);
    expect(sick).toMatchObject({ points: 11, level: 'high' });
    // границы полос: 20 — ещё 0, 21 — уже 2; 36,0 — 1, 36,1 — 0; 219 — 0, 220 — 3
    expect([20, 21].map(v => news2(db, { 'vital.tachypnea': v })!.points)).toEqual([0, 2]);
    expect([36.0, 36.1].map(v => news2(db, { 'vital.fever': v })!.points)).toEqual([1, 0]);
    expect([219, 220].map(v => news2(db, { 'vital.bp_high': v })!.points)).toEqual([0, 3]);
    expect(news2(db, {}, { oxygen: true, confused: true })).toMatchObject({ points: 5, level: 'medium' });
  });

  test('цвет: витальные — шкалой, жалобы — флагами; давящая боль за грудиной — красный и при нуле баллов', () => {
    const vitals = [
      { f: 'vital.tachypnea', shown: true, value: 26, exam: 'exam.vitals' },
      { f: 'vital.spo2_low', shown: true, value: 90, exam: 'exam.vitals' },
    ];
    expect(scaleTriage(db, [], vitals)).toEqual({ triage: 'yellow', news2: 6 });
    // флаг витального («сатурация низкая — красный») не считается: для витальных есть шкала
    expect(scaleTriage(db, [], [{ f: 'vital.spo2_low', shown: true, value: 94, exam: 'exam.vitals' }])).toEqual({ triage: 'green', news2: 1 });
    // цвет поднял признак — шкала его помнит: разбор и лист на «Студенте» называют его
    expect(scaleTriage(db, ['sym.chest_pain_pressing'], [{ f: 'vital.tachycardia', shown: false, value: 80, exam: 'exam.vitals' }]))
      .toEqual({ triage: 'red', news2: 0, flag: 'sym.chest_pain_pressing' });
    // баллы уже дали красный — признак цвет не поднял и не запомнен
    const red = [...vitals, { f: 'vital.tachycardia', shown: true, value: 135, exam: 'exam.vitals' }];
    expect(scaleTriage(db, ['sym.chest_pain_pressing'], red)).toEqual({ triage: 'red', news2: 9 });
  });

  test('строка разбора: признак, что поднял цвет, — словами', () => {
    const flagged = noteText({ code: 'triage.under', triage: 'red', news2: 0, flag: 'sym.chest_pain_pressing' });
    expect(flagged).toStartWith('При сортировке недооценили: по листу передачи NEWS2 — 0');
    expect(flagged).toEndWith('но «давящая боль за грудиной» — тревожный признак, по шкале это красный');
    expect(noteText({ code: 'triage.under', triage: 'yellow', news2: 6 })).toEndWith('баллов, по шкале это жёлтый');
    expect(noteText({ code: 'triage.over', triage: 'green', news2: 1 })).toStartWith('При сортировке переоценили: по листу передачи — зелёный (NEWS2 — 1');
  });
});

describe('скорая: приезд и лист передачи', () => {
  test('без смотровой приёмного скорой нет; со смотровой — машины за смену по economy.yaml', () => {
    const plain = newSandbox(db, { seed: 21, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
    apply(db, plain, { kind: 'nextDay' });
    expect(ambulance(plain)).toEqual([]);
    const { s, room } = withEmergency();
    expect(emergencyBays(db, s)).toEqual([{ room, bed: 0 }, { room, bed: 1 }]);
    apply(db, s, { kind: 'nextDay' });
    const cars = ambulance(s).length;
    expect(cars).toBeGreaterThanOrEqual(db.economy.ambulance.perDay[0]);
    expect(cars).toBeLessThanOrEqual(db.economy.ambulance.perDay[1]);
    // везут не лёгкое
    for (const p of ambulance(s)) expect(db.economy.ambulance.weight[db.conditions[p.patient.truth.conditions[0].id].severity]).toBeGreaterThan(0);
    // скорая не платит отдельно: привезённый — случай ОМС, пришедшие сами — по-прежнему кто как
    expect(ambulance(s).map(p => p.payer)).toEqual(ambulance(s).map(() => 'oms'));
    expect(new Set(Object.values(s.patients).filter(p => p.kind !== 'ambulance').map(p => p.payer)).size).toBeGreaterThan(1);
  });

  test('приехал: фельдшер измерил витальные, цвет по шкале — для сверки; место в смотровой; в очередь — после сортировки врачом', () => {
    const { s, room } = withEmergency();
    apply(db, s, { kind: 'nextDay' });
    const first = ambulance(s)[0];
    const notices: string[] = [];
    for (let i = 0; i < 10 * 60 && first.status === 'coming'; i++) notices.push(...apply(db, s, { kind: 'advance', seconds: 60 }).map(n => `${n.kind}:${'id' in n ? n.id : ''}`));
    expect(notices).toContain(`ambulance:${first.id}`);
    expect(first.status).toBe('waiting');
    expect(first.results.find(r => r.exam === 'exam.vitals')?.obs.some(o => o.value !== undefined)).toBe(true);
    expect(first.scale).toEqual(scaleTriage(db, first.patient.complaints, first.results.flatMap(r => r.obs)));
    expect(first.bay).toEqual({ room, bed: 0 });
    expect(s.queue).not.toContain(first.id);
    // позвать до сортировки нельзя
    apply(db, s, { kind: 'call', id: first.id });
    expect(first.status).toBe('waiting');
    apply(db, s, { kind: 'sort', id: first.id, triage: 'red' });
    expect(first).toMatchObject({ sorted: true, triage: 'red' });
    // в очереди — среди красных по времени прихода: впереди только красные, пришедшие раньше
    const ahead = s.queue.slice(0, s.queue.indexOf(first.id)).map(id => s.patients[id]);
    expect(s.queue).toContain(first.id);
    for (const q of ahead) expect(q.triage === 'red' && q.queuedT <= first.queuedT).toBe(true);
    // второй раз не сортируют
    apply(db, s, { kind: 'sort', id: first.id, triage: 'green' });
    expect(first.triage).toBe('red');
    const day = s.summary.ambulance!;
    expect(day.sorted).toBe(1);
    expect(day.under + day.over).toBe(first.scale!.triage === 'red' ? 0 : 1);
  });

  test('мест нет — ждёт у входа; закрыли приём на месте — первый у входа занимает его', () => {
    // смотровая S — одно место: ищем день, когда за первым приехал второй
    let found: { s: ShiftState; a: ShiftPatient; b: ShiftPatient } | undefined;
    for (let seed = 30; seed < 60 && !found; seed++) {
      const { s } = withEmergency(seed, 'S');
      apply(db, s, { kind: 'nextDay' });
      const [a, b] = ambulance(s);
      if (!b) continue;
      until(s, () => b.status !== 'coming');
      if (a.status === 'waiting') found = { s, a, b };
    }
    expect(found).toBeDefined();
    const { s, a, b } = found!;
    expect(a.bay).toBeDefined();
    expect(b.bay).toBeUndefined();
    expect(atDoorOf(s).map(p => p.id)).toEqual([b.id]);
    expect(freeBays(db, s)).toEqual([]);
    // первого — сортировать, позвать, отпустить домой: место свободно, его занимает второй
    apply(db, s, { kind: 'sort', id: a.id, triage: 'yellow' });
    apply(db, s, { kind: 'call', id: a.id });
    expect(s.current).toBe(a.id);
    apply(db, s, { kind: 'diagnose', id: a.patient.truth.conditions[0].id });
    apply(db, s, { kind: 'finish' });
    expect(a.status).toBe('done');
    expect(a.bay).toBeUndefined();
    expect(b.bay).toBeDefined();
    expect(atDoorOf(s)).toEqual([]);
  });

  test('сортировка спокойнее шкалы — «недооценили» в итогах и строкой разбора; конец дня — неотсортированные не приняты', () => {
    const { s } = withEmergency(22);
    apply(db, s, { kind: 'nextDay' });
    const list = ambulance(s);
    until(s, () => list.every(p => p.status !== 'coming'));
    const p = list.find(x => x.scale!.triage !== 'green')!;
    expect(p).toBeDefined();
    apply(db, s, { kind: 'sort', id: p.id, triage: 'green' });
    expect(s.summary.ambulance!.under).toBe(1);
    apply(db, s, { kind: 'call', id: p.id });
    apply(db, s, { kind: 'diagnose', id: p.patient.truth.conditions[0].id });
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.notes).toContainEqual({ code: 'triage.under', triage: p.scale!.triage, news2: p.scale!.news2, ...(p.scale!.flag ? { flag: p.scale!.flag } : {}) });
    // остальных не сортировали — вечером они «не приняты»
    const rest = list.filter(x => x.id !== p.id);
    apply(db, s, { kind: 'closeDay' });
    for (const x of rest) expect(x.status).toBe('unseen');
    expect(s.history[s.history.length - 1].ambulance).toMatchObject({ arrived: list.length, sorted: 1, under: 1 });
  });

  test('те же зерно и команды — та же скорая: кто, когда, что измерил фельдшер, цвет по шкале', () => {
    const run = () => {
      const { s } = withEmergency(23);
      apply(db, s, { kind: 'nextDay' });
      until(s, () => ambulance(s).every(p => p.status !== 'coming'));
      return ambulance(s).map(p => ({ id: p.id, at: p.arriveT, dx: p.patient.truth.conditions[0].id, scale: p.scale, bay: p.bay, obs: p.results[0]?.obs }));
    };
    expect(run()).toEqual(run());
  });
});

describe('скорая на экране смены', () => {
  test('лист передачи: повод и что измерил фельдшер; на «Студенте» — баллы NEWS2 и тревожный признак, на «Враче» — нет', async () => {
    // день, когда привезённому цвет поднял тревожный признак
    let found: { s: ShiftState; p: ShiftPatient } | undefined;
    for (let seed = 40; seed < 90 && !found; seed++) {
      const { s } = withEmergency(seed, 'M', 'student');
      apply(db, s, { kind: 'nextDay' });
      const list = ambulance(s);
      until(s, () => list.every(x => x.status !== 'coming'));
      const p = list.find(x => x.scale?.flag);
      if (p) found = { s, p };
    }
    expect(found).toBeDefined();
    const { s, p } = found!;
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    const row = shiftView().ambulance.find(r => r.id === p.id)!;
    expect(row.handover.measured.length).toBeGreaterThan(0);
    expect(row.handover.news2).toBe(T.shift.ambulance.news2(p.scale!.news2));
    expect(row.handover.flag).toBe(T.shift.ambulance.flag(db.findings[p.scale!.flag!].name.ru, p.scale!.triage));
    // на «Враче» — только повод и измерения
    s.meta.difficulty = 'doctor';
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    forgetShift();
    await loadShift('sandbox');
    const plain = shiftView().ambulance.find(r => r.id === p.id)!;
    expect(plain.handover).toEqual({ reason: row.handover.reason, measured: row.handover.measured });
    forgetShift();
  });
});
