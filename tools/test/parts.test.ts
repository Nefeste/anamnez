// Время команды по частям (0.5.13, NFR-PRF-1; spec 2026-10-parts): обследование, вызов, «подождите», закрытие приёма и
// промотка часов проживают своё время в следующих кадрах, а следующая команда сначала доживает всё — та же смена, те же
// события в том же порядке, что сразу; и после открытия сохранения посреди.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { apply, catchUp, newSandbox, prepareFinish } from '../../src/engine/shift/engine';
import type { Command, Notice, ShiftState } from '../../src/engine/shift/types';
import { memoryStore } from '../../src/state/saves';
import {
  assign, buildAction, buildView, callPatient, chooseDiagnosis, endBuild, examine, finishCase, forgetShift, hire, loadShift, nextDay, saved,
  saveNow, sendAway, setSpeed, setStore, shiftCaseView, shiftState, shiftView, skipIdle, staffView, startSandbox, tick, timeInParts,
  waitForResults,
} from '../../src/state/session';

/** Амбулатория песочницы с терапевтом навыка 3 во втором кабинете, первый день открыт. */
function withColleague(): ShiftState {
  const s = newSandbox(db, { seed: 7, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
  apply(db, s, { kind: 'buildEnd' });
  const office = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const m: StaffMember = { id: 'h1', role: 'role.therapist', sex: 'f', seed: 11, skill: 3, salary: salaryOf(db, 'role.therapist', 3), days: 0 };
  s.staff = [...(s.staff ?? []), m];
  apply(db, s, { kind: 'assign', id: m.id, room: office });
  apply(db, s, { kind: 'nextDay' });
  return s;
}

/** Не больше `n` событий за раз — как кадр, которому хватает времени на `n` событий. */
const events = (n: number) => {
  let k = 0;
  return () => k++ < n;
};

/** Что сделал бы врач сейчас: зовёт первого из очереди, спрашивает, слушает, ставит ОРВИ и закрывает приём; иначе ждёт. */
function nextCommand(s: ShiftState): Command[] {
  const p = s.current ? s.patients[s.current] : undefined;
  if (p) {
    const todo = ['exam.ask_complaints', 'exam.lung_auscultation'].filter(e => !p.done.includes(e));
    if (todo.length > 0) return [{ kind: 'exam', exam: todo[0] }];
    return [{ kind: 'diagnose', id: 'cond.arvi' }, { kind: 'finish' }];
  }
  if (s.queue.length > 0) return [{ kind: 'call', id: s.queue[0] }];
  return [{ kind: 'advance', seconds: 60 }];
}

describe('время команды по частям', () => {
  test('по частям — та же смена и те же события по порядку, что сразу; часы идут к концу команды', () => {
    const now = withColleague();
    const parts = structuredClone(now);
    const said: Notice[] = [];
    const heard: Notice[] = [];
    let pending = 0;
    for (let i = 0; i < 400 && now.dayOpen; i++) {
      for (const cmd of nextCommand(now)) {
        said.push(...apply(db, now, cmd));
        heard.push(...apply(db, parts, cmd, events(1)));
        if (parts.until !== undefined) {
          pending++;
          // пока не прожито — часы смены между тем, где они были, и концом команды
          expect(parts.t).toBeLessThanOrEqual(parts.until);
          expect(parts.until).toBe(now.t);
        }
        // кадр: ещё немного
        heard.push(...catchUp(db, parts, events(2)));
      }
    }
    heard.push(...catchUp(db, parts));
    expect(pending).toBeGreaterThan(10);
    expect(parts.until).toBeUndefined();
    expect(parts).toEqual(now);
    expect(heard).toEqual(said);
  }, 60_000);

  test('ничего не прожито — следующая команда сначала доживает всё; сохранение посреди открывается и доживается', () => {
    const now = withColleague();
    const parts = structuredClone(now);
    const seq: Command[] = [{ kind: 'advance', seconds: 3600 }];
    for (const cmd of seq) {
      apply(db, now, cmd);
      apply(db, parts, cmd, () => false);
    }
    expect(parts.until).toBe(now.t);
    expect(parts.t).toBeLessThan(now.t);
    // сохранили посреди и открыли: `until` в сохранении
    const saved: ShiftState = JSON.parse(JSON.stringify(parts));
    expect(saved.until).toBe(now.t);
    // следующая команда — та же у обоих
    const next: Command = { kind: 'advance', seconds: 60 };
    apply(db, now, next);
    apply(db, parts, next);
    apply(db, saved, next);
    expect(parts).toEqual(now);
    expect(saved).toEqual(now);
  }, 60_000);

  test('закрытие вашего приёма: разбор по частям (0.5.13) — тот же закрытый случай, что сразу', () => {
    const now = withColleague();
    for (let i = 0; i < 60 && now.queue.length === 0; i++) apply(db, now, { kind: 'advance', seconds: 60 });
    apply(db, now, { kind: 'call', id: now.queue[0] });
    for (const exam of ['exam.ask_complaints', 'exam.lung_auscultation', 'exam.cbc']) apply(db, now, { kind: 'exam', exam });
    apply(db, now, { kind: 'waitResults' });
    apply(db, now, { kind: 'diagnose', id: 'cond.arvi' });
    const parts = structuredClone(now);
    // по части за раз: разумный врач разбора, затем уверенность после каждого результата
    let pieces = 0;
    while (!prepareFinish(db, parts, events(1))) pieces++;
    expect(pieces).toBeGreaterThan(5);
    // готово — и без запаса: считать нечего
    expect(prepareFinish(db, parts, () => false)).toBe(true);
    const id = now.current!;
    apply(db, now, { kind: 'finish' });
    apply(db, parts, { kind: 'finish' });
    expect(parts.patients[id].closed).toBeDefined();
    expect(parts).toEqual(now);
  }, 60_000);
});

describe('сессия: время команды по частям', () => {
  beforeEach(() => {
    setStore(memoryStore());
    forgetShift();
  });
  afterEach(() => timeInParts(false));

  /** Песочница сессии с терапевтом во втором кабинете, день 1 открыт; по частям — по событию за кадр и за тик. */
  const open = (parts: boolean) => {
    timeInParts(false);
    startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'doctor', seed: 43, season: 'winter' });
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    expect(buildAction({ kind: 'corridor', cells })).toBeNull();
    expect(buildAction({ kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 })).toBeNull();
    expect(buildAction({ kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 })).toBeNull();
    endBuild();
    const office = buildView()!.plan.rooms[buildView()!.plan.rooms.length - 1].id;
    const therapist = staffView()!.candidates.find(c => c.role === 'role.therapist')!;
    hire(therapist.id);
    assign(therapist.id, office);
    nextDay();
    expect(shiftView().dayOpen).toBe(true);
    timeInParts(parts, 0);
  };

  /** Кадры, пока время команды не прожито и пока приём закрывается (0.5.13). */
  const frames = async () => {
    let n = 0;
    for (; (shiftState()?.until !== undefined || shiftCaseView()?.finishing) && n < 1_000_000; n++) await new Promise(r => setTimeout(r, 0));
    return n;
  };

  /**
   * Врач сессии: зовёт первого из очереди, спрашивает, слушает, берёт кровь и ждёт результат, ставит ОРВИ и закрывает
   * приём; никого — промотка.
   */
  const act = () => {
    const s = shiftState()!;
    const p = s.current ? s.patients[s.current] : undefined;
    if (p) {
      const todo = ['exam.ask_complaints', 'exam.lung_auscultation', 'exam.cbc'].find(e => !p.done.includes(e));
      if (todo) examine(todo);
      else if (p.pending.length > 0) waitForResults();
      else {
        chooseDiagnosis('cond.arvi');
        finishCase();
      }
    } else if (s.queue.length > 0) callPatient(s.queue[0]);
    else skipIdle();
  };

  test('действия врача по частям — та же смена и то же «За это время», что сразу; следующее действие доживает всё', async () => {
    const play = async (parts: boolean) => {
      open(parts);
      const seen: string[][] = [];
      let pending = 0;
      let drawn = 0;
      let finishing = 0;
      for (let i = 0; i < 160 && shiftView().dayOpen; i++) {
        const calls = !shiftState()!.current && shiftState()!.queue.length > 0;
        act();
        if (shiftState()!.until !== undefined) pending++;
        // закрытие приёма (0.5.13): разбор не успели посчитать заранее — экран итога ждёт его, приём ещё не закрыт
        if (shiftCaseView()?.finishing) {
          finishing++;
          expect(shiftState()!.current).toBeDefined();
        }
        // после вызова — без кадров: время вызова доживает следующее действие
        if (calls) continue;
        drawn += await frames();
        seen.push(shiftCaseView()?.meanwhile ?? []);
      }
      drawn += await frames();
      return { state: JSON.stringify(shiftState()), seen, pending, drawn, finishing };
    };
    const now = await play(false);
    const parts = await play(true);
    expect(now.pending).toBe(0);
    expect(now.finishing).toBe(0);
    expect(parts.finishing).toBeGreaterThan(0);
    expect(parts.pending).toBeGreaterThan(20);
    expect(parts.drawn).toBeGreaterThan(parts.pending);
    expect(now.seen.filter(m => m.length > 0).length).toBeGreaterThan(2);
    expect(parts.seen).toEqual(now.seen);
    expect(parts.state).toBe(now.state);
  }, 120_000);

  test('ход часов по частям: тик доживает недожитое и отдаёт его события — для звука и автопаузы; журнал повторяет день', () => {
    open(true);
    const start = structuredClone(shiftState()!);
    // ваш пациент — на анализ крови: его результаты придут, пока идут часы, и встанет автопауза
    for (let i = 0; i < 10 && shiftState()!.queue.length === 0; i++) skipIdle();
    callPatient(shiftState()!.queue[0]);
    examine('exam.ask_complaints');
    examine('exam.cbc');
    sendAway();
    const k = shiftState()!.journal.length;
    const heard: Notice[] = [];
    let pending = 0;
    let paused = 0;
    for (let i = 0; i < 400_000 && shiftState()!.t < start.t + 4 * 3600; i++) {
      if (shiftView().paused) setSpeed(1);
      const n = tick(1000);
      heard.push(...n);
      if (shiftState()!.until !== undefined) pending++;
      if (n.some(x => x.kind === 'resultsReady' && shiftState()!.patients[x.id].status === 'waiting')) {
        expect(shiftView().paused).toBe(true);
        paused++;
      }
    }
    expect(shiftState()!.t).toBeGreaterThanOrEqual(start.t + 4 * 3600);
    expect(pending).toBeGreaterThan(100);
    expect(paused).toBeGreaterThan(0);
    const live = shiftState()!;
    heard.push(...catchUp(db, live));
    // тот же день сразу, по журналу: то же состояние, а часы — те же события по порядку
    const said: Notice[] = [];
    live.journal.forEach((cmd, i) => {
      const n = apply(db, start, cmd);
      if (i >= k) said.push(...n);
    });
    expect(heard).toEqual(said);
    expect(start).toEqual(live);
  }, 120_000);

  test('сохранили посреди времени команды — открыли: кадры доживают, смена та же, что сразу', async () => {
    // врач решает по прожитому — после кадров; сохранение — посреди времени последнего действия
    const play = async (parts: boolean, upTo?: number) => {
      open(parts);
      let done = 0;
      while (done < (upTo ?? 40) && shiftView().dayOpen) {
        act();
        done++;
        if (upTo === undefined && done > 20 && shiftState()!.until !== undefined) break;
        if (done < (upTo ?? 40)) await frames();
      }
      const left = shiftState()!.until !== undefined;
      await saveNow();
      await saved();
      forgetShift();
      await loadShift('sandbox');
      expect(shiftState()!.until !== undefined).toBe(left);
      for (let i = 0; i < 20 && shiftView().dayOpen; i++) {
        await frames();
        act();
      }
      await frames();
      return { state: JSON.stringify(shiftState()), left, done };
    };
    const parts = await play(true);
    expect(parts.left).toBe(true);
    expect((JSON.parse(parts.state) as ShiftState).until).toBeUndefined();
    // сразу — то же число действий до сохранения
    const now = await play(false, parts.done);
    expect(now.left).toBe(false);
    expect(now.done).toBe(parts.done);
    expect(parts.state).toBe(now.state);
  }, 120_000);
});
