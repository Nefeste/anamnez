// Смена для экранов (src/state/session.ts): часы на карте идут, пока в кабинете никого;
// автопауза на «красного»; «за это время»; итог закрытого случая; итоги дня; сохранение и
// чтение — с откатом к копии и отказом от несовместимого.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ShiftState } from '../../src/engine/shift/types';
import { loadSlot, memoryStore } from '../../src/state/saves';
import {
  callPatient, chooseDiagnosis, chooseSetting, closeDay, examine, finishCase, forgetShift, leaveCase, loadShift, nextDay, openCase,
  pauseClock, saved, sendAway, setSpeed, setStore, shiftCaseView, shiftState, shiftView, skipIdle, startShift, tick, toggleTreatment,
} from '../../src/state/session';
import { forgetSettings, updateSettings } from '../../src/state/settings';

let store = memoryStore();

beforeEach(() => {
  store = memoryStore();
  setStore(store);
  forgetShift();
  forgetSettings();
});

/** Часы на карте до первого в очереди (не больше `limit` игровых минут). */
function untilQueue(limit = 180) {
  for (let i = 0; i < limit && shiftView().queue.length === 0; i++) tick(1000);
}

describe('смена на экране: часы', () => {
  test('новая смена — день 1, 08:00; часы идут по скорости и стоят на паузе', () => {
    startShift(7, 'winter');
    const v = shiftView();
    expect(v.status).toBe('ready');
    expect(v.day).toBe(1);
    expect(v.clock).toBe('08:00');
    setSpeed(1);
    tick(1000); // ×1 — минута в секунду
    expect(shiftView().clock).toBe('08:01');
    setSpeed(4);
    tick(1000);
    expect(shiftView().clock).toBe('08:05');
    pauseClock();
    tick(1000);
    expect(shiftView().clock).toBe('08:05');
    expect(shiftView().paused).toBe(true);
  });

  test('пока в кабинете пациент, часы на карте стоят: время идёт делами', () => {
    startShift(3, 'winter');
    untilQueue();
    const first = shiftView().queue[0];
    callPatient(first.id);
    expect(shiftView().inRoom?.id).toBe(first.id);
    const at = shiftView().clock;
    tick(1000);
    expect(shiftView().clock).toBe(at);
    examine('exam.ask_complaints');
    expect(shiftView().clock).not.toBe(at);
  });

  test('«промотать до следующего»: часы — до прихода, журнал — одной командой', () => {
    startShift(4, 'winter');
    const skipped = skipIdle();
    const v = shiftView();
    expect(v.queue.length).toBeGreaterThan(0);
    expect(skipped.some(n => n.kind === 'arrived')).toBe(true);
    expect(shiftState()!.journal).toEqual([{ kind: 'advance', seconds: shiftState()!.t - 8 * 3600 }]);
    // в очереди есть кто-то — промотать нельзя
    const at = v.clock;
    expect(skipIdle()).toEqual([]);
    expect(shiftView().clock).toBe(at);
  });

  test('промотанное — то же, что прожитое на ×1: та же смена', () => {
    startShift(8, 'winter');
    skipIdle();
    const skipped = JSON.stringify({ ...shiftState(), journal: [] });
    const t = shiftState()!.t;
    forgetShift();
    startShift(8, 'winter');
    setSpeed(1);
    for (let i = 0; i < 1000 && shiftState()!.t < t; i++) tick(1000);
    expect(shiftState()!.t).toBe(t);
    expect(JSON.stringify({ ...shiftState(), journal: [] })).toBe(skipped);
  });

  test('ходы времени сливаются в журнале в один', () => {
    startShift(5, 'winter');
    for (let i = 0; i < 40; i++) tick(250);
    const journal = shiftState()!.journal;
    expect(journal.length).toBe(1);
    expect(journal[0]).toEqual({ kind: 'advance', seconds: 40 * 15 });
  });

  test('пришёл «красный» — автопауза с причиной; вызвали — часы снова идут', () => {
    let found = false;
    for (let seed = 1; seed <= 80 && !found; seed++) {
      forgetShift();
      startShift(seed, 'winter');
      setSpeed(4);
      for (let i = 0; i < 400 && !shiftView().paused; i++) tick(250);
      const v = shiftView();
      if (!v.paused || !v.pauseReason?.includes('срочный')) continue;
      found = true;
      expect(v.log[0].kind).toBe('red');
      expect(v.queue[0].triage).toBe('red');
      callPatient(v.queue[0].id);
      expect(shiftView().paused).toBe(false);
    }
    expect(found).toBe(true);
  });

  test('автопаузу на «красного» выключили в настройках — часы идут, срочный первым в очереди', () => {
    let checked = false;
    for (let seed = 1; seed <= 80 && !checked; seed++) {
      forgetSettings();
      forgetShift();
      startShift(seed, 'winter');
      setSpeed(4);
      let ticks = 0;
      for (; ticks < 400 && !shiftView().paused; ticks++) tick(250);
      if (!shiftView().pauseReason?.includes('срочный')) continue;
      // та же смена, те же такты — без автопаузы на срочного
      updateSettings({ pauseOnRed: false });
      forgetShift();
      startShift(seed, 'winter');
      setSpeed(4);
      for (let i = 0; i < ticks; i++) tick(250);
      const v = shiftView();
      expect(v.pauseReason?.includes('срочный') ?? false).toBe(false);
      expect(v.queue[0].triage).toBe('red');
      checked = true;
    }
    expect(checked).toBe(true);
  });
});

describe('смена на экране: приём', () => {
  test('карта пациента — вид приёма: жалобы, витальные от медсестры, «Похоже на»', () => {
    startShift(3, 'winter');
    untilQueue();
    expect(shiftCaseView()).toBeUndefined();
    callPatient(shiftView().queue[0].id);
    const c = shiftCaseView()!;
    expect(c.groups.map(g => g.exam)).toContain('exam.vitals');
    expect(c.hints.length).toBeGreaterThan(0);
    expect(c.decision).toBeUndefined();
    expect(c.freshCount).toBe(0);
  });

  test('отпустить на анализы: вернётся в очередь с результатами, «новое» — при вызове', () => {
    startShift(9, 'winter');
    untilQueue();
    const id = shiftView().queue[0].id;
    callPatient(id);
    examine('exam.cbc');
    expect(shiftCaseView()!.canSendAway).toBe(true);
    sendAway();
    expect(shiftView().inRoom).toBeUndefined();
    expect(shiftView().away.map(a => a.id)).toContain(id);
    setSpeed(4);
    for (let i = 0; i < 200 && !shiftView().queue.some(q => q.id === id); i++) tick(250);
    const row = shiftView().queue.find(q => q.id === id)!;
    expect(row.badges).toContain('с результатами');
    expect(shiftView().log.some(l => l.kind === 'results')).toBe(true);
    // часы встали на паузу из-за него — вызов её снимает
    callPatient(id);
    const c = shiftCaseView()!;
    expect(c.groups.find(g => g.exam === 'exam.cbc')!.fresh).toBe(true);
  });

  test('завершить приём: итог и разбор; «домой» — исход в итогах следующих дней', () => {
    startShift(6, 'winter');
    untilQueue();
    const id = shiftView().queue[0].id;
    callPatient(id);
    examine('exam.ask_complaints');
    finishCase(); // без диагноза — нельзя
    expect(shiftView().inRoom?.id).toBe(id);
    const dx = shiftCaseView()!.hints[0].id;
    chooseDiagnosis(dx);
    toggleTreatment('tx.rest_fluids');
    chooseSetting('home');
    finishCase();
    expect(shiftView().inRoom).toBeUndefined();
    const c = shiftCaseView()!;
    expect(c.decision!.diagnosis).toBe(dx);
    expect(c.decision!.outcome).toContain('итогах следующих дней');
    expect(['A', 'B', 'C', 'D']).toContain(c.decision!.overall);
    expect(c.decision!.timeline.length).toBeGreaterThan(0);
    leaveCase();
    expect(shiftCaseView()).toBeUndefined();
    openCase(id);
    expect(shiftCaseView()!.decision!.diagnosis).toBe(dx);
  });
});

describe('смена на экране: карта', () => {
  test('коснулись человека — кто это и что делает; пригласить можно, пока кабинет свободен', () => {
    startShift(3, 'winter');
    untilQueue();
    const q = shiftView().queue[0];
    const who = shiftView().who[q.id];
    expect(who).toMatchObject({ title: `${q.name}, ${q.age}`, complaint: q.complaint, triage: q.triage, callable: true });
    expect(who.doing).toBe('В регистратуре: заводят карту');
    // персонал — должность и зачем он: медсестра меряет и решает, кто срочный
    const nurse = shiftView().who['staff.nurse'];
    expect(nurse.title).toBe('Медсестра доврачебного кабинета');
    expect(nurse.doing).toContain('давление');
    expect(nurse.callable).toBe(false);
    untilQueue();
    callPatient(q.id);
    expect(shiftView().who[q.id]).toMatchObject({ doing: 'У вас в кабинете', callable: false });
    for (const id of Object.keys(shiftView().who)) expect(shiftView().who[id].callable).toBe(false);
  });
});

describe('смена на экране: день', () => {
  test('закрыть день — итоги с приёмами; следующий день — с 08:00, журнал заново', () => {
    startShift(21, 'winter');
    untilQueue();
    callPatient(shiftView().queue[0].id);
    examine('exam.ask_complaints');
    chooseDiagnosis(shiftCaseView()!.hints[0].id);
    finishCase();
    leaveCase();
    closeDay();
    const v = shiftView();
    expect(v.dayOpen).toBe(false);
    const sum = v.summary!;
    expect(sum.day).toBe(1);
    expect(sum.seen).toBe(1);
    expect(sum.cases.length).toBe(1);
    expect(sum.seen + sum.left + sum.unseen).toBe(sum.arrived);
    nextDay();
    expect(shiftView().day).toBe(2);
    expect(shiftView().clock).toBe('08:00');
    expect(shiftView().summary).toBeUndefined();
  });
});

describe('смена на экране: сохранение', () => {
  test('сохранили — прочитали после «перезапуска»: та же смена', async () => {
    startShift(5, 'winter');
    untilQueue();
    callPatient(shiftView().queue[0].id);
    examine('exam.ask_complaints');
    examine('exam.xray_chest');
    sendAway();
    await saved();
    const before = JSON.stringify(shiftState());
    forgetShift();
    expect(shiftView().status).toBe('idle');
    await loadShift();
    expect(shiftView().status).toBe('ready');
    expect(JSON.stringify(shiftState())).toBe(before);
    expect(shiftView().restored).toBe(false);
  });

  test('текущий файл испорчен — продолжаем с предыдущей копии и говорим об этом', async () => {
    startShift(5, 'winter');
    await saved(); // первая запись — будущая предыдущая копия
    untilQueue();
    callPatient(shiftView().queue[0].id);
    sendAway(); // без назначений не отпустить — ничего не меняет
    examine('exam.cbc');
    sendAway();
    await saved();
    store.files.set('shift.json', '{ broken');
    forgetShift();
    await loadShift();
    expect(shiftView().status).toBe('ready');
    expect(shiftView().restored).toBe(true);
  });

  test('сохранение от другой базы (нет такой болезни) — не читается', async () => {
    startShift(5, 'winter');
    await saved();
    const r = await loadSlot<ShiftState>(store, 'shift');
    const data = r!.envelope.data;
    const first = Object.values(data.patients)[0];
    first.patient.truth.conditions[0].id = 'cond.removed_in_update';
    store.files.set('shift.json', JSON.stringify({ ...r!.envelope, data }));
    store.files.delete('shift.prev-1.json');
    forgetShift();
    await loadShift();
    expect(shiftView().status).toBe('none');
  });

  test('просьбы сохранить подряд дают одну запись — после касания, а не посреди него', async () => {
    startShift(5, 'winter');
    untilQueue();
    callPatient(shiftView().queue[0].id);
    examine('exam.cbc');
    sendAway();
    expect(store.files.has('shift.json')).toBe(false); // ещё не записано: отложено
    await saved();
    expect(store.files.has('shift.json')).toBe(true);
    expect(store.files.has('shift.prev-1.json')).toBe(false); // одна запись, а не три
  });

  test('сохранения нет — статус «нет», новая смена его создаёт', async () => {
    await loadShift();
    expect(shiftView().status).toBe('none');
    startShift(1, 'winter');
    await saved();
    expect(store.files.has('shift.json')).toBe(true);
  });
});
