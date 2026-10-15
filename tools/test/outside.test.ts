// Обследование в другом кабинете (0.5.12, отзыв на 0.5.11): назначили ЭКГ или анализ крови — пациент сразу идёт туда
// (очередь, процедура, обратно), а расспрос и осмотр — когда вернётся; описание ЭКГ и лаборатория — уже без него.
// Прежде ЭКГ «делалось» к сроку, пока пациент сидел у врача.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { apply, newShift } from '../../src/engine/shift/engine';
import type { Command, ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { CLINIC, placements } from '../../src/state/clinicMap';
import { memoryStore } from '../../src/state/saves';
import { callPatient, examine, forgetShift, setSpeed, setStore, shiftCaseView, shiftState, shiftView, startShift, tick, waitForResults } from '../../src/state/session';

const winter = { season: 'winter' as const };
const minute: Command = { kind: 'advance', seconds: 60 };
const MIN = 60;

/** Смена, пациент у вас в кабинете. */
function withPatient(seed = 7): { s: ShiftState; p: ShiftPatient } {
  const s = newShift(db, { seed, ...winter });
  for (let i = 0; i < 300 && s.queue.length === 0; i++) apply(db, s, minute);
  apply(db, s, { kind: 'call', id: s.queue[0] });
  return { s, p: s.patients[s.current!] };
}

describe('обследование в другом кабинете', () => {
  test('ЭКГ: направление — 2 минуты врача, пациент уходит; вопрос — когда вернётся', () => {
    const { s, p } = withPatient();
    const t0 = s.t;
    apply(db, s, { kind: 'exam', exam: 'exam.ecg' });
    expect(s.t - t0).toBe(2 * MIN);
    expect(p.out).toBeDefined();
    const ecg = p.pending.find(x => x.exam === 'exam.ecg')!;
    expect(p.out!.exam).toBe('exam.ecg');
    expect(p.out!.until).toBe(ecg.end!);
    expect(p.out!.back).toBeGreaterThan(p.out!.until);
    expect(ecg.start!).toBeGreaterThan(t0 + 2 * MIN - 1);
    // расспрос — когда вернулся: врач ждал
    const back = p.out!.back;
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    const ask = p.results.find(r => r.exam === 'exam.ask_complaints')!;
    expect(ask.at).toBe(back + db.exams['exam.ask_complaints'].time.procedure * MIN);
    expect(s.t).toBe(ask.at);
  });

  test('анализ крови: пациент идёт в процедурный сразу и возвращается; лаборатория — без него', () => {
    const { s, p } = withPatient();
    const t0 = s.t;
    apply(db, s, { kind: 'exam', exam: 'exam.cbc' });
    expect(s.t - t0).toBe(2 * MIN);
    const cbc = p.pending.find(x => x.exam === 'exam.cbc')!;
    expect(p.out?.exam).toBe('exam.cbc');
    expect(cbc.start).toBeGreaterThanOrEqual(t0 + 2 * MIN);
    expect(cbc.end! - cbc.start!).toBe(db.exams['exam.cbc'].time.procedure * MIN);
    expect(cbc.readyAt).toBeGreaterThan(p.out!.back);
  });

  test('два направления — одно за другим: на второе идёт прямо с первого', () => {
    const { s, p } = withPatient();
    apply(db, s, { kind: 'exam', exam: 'exam.ecg' });
    const ecg = p.pending.find(x => x.exam === 'exam.ecg')!;
    apply(db, s, { kind: 'exam', exam: 'exam.cbc' });
    const cbc = p.pending.find(x => x.exam === 'exam.cbc')!;
    expect(cbc.start!).toBeGreaterThanOrEqual(ecg.end!);
    expect(p.out?.exam).toBe('exam.cbc');
    expect(p.out!.until).toBe(cbc.end!);
  });

  test('на карте — у кабинета обследования, в карте пациента — когда вернётся; вернулся — у врача', () => {
    const { s, p } = withPatient();
    apply(db, s, { kind: 'exam', exam: 'exam.ecg' });
    const ecg = p.pending.find(x => x.exam === 'exam.ecg')!;
    while (s.t < ecg.start!) apply(db, s, { kind: 'advance', seconds: Math.min(60, ecg.start! - s.t) });
    const there = placements(db, CLINIC, s).find(x => x.id === p.id)!;
    expect(there.doing).toEqual({ kind: 'exam', room: 'ecg' });
    apply(db, s, { kind: 'advance', seconds: p.out!.back - s.t });
    expect(placements(db, CLINIC, s).find(x => x.id === p.id)!.doing.kind).toBe('office');
  });

  test('отпустили ждать, пока он на обследовании, — после него в зал, а не к вам', () => {
    const { s, p } = withPatient();
    apply(db, s, { kind: 'exam', exam: 'exam.ecg' });
    apply(db, s, { kind: 'sendAway' });
    expect(p.out).toBeUndefined();
    expect(p.status).toBe('away');
    for (let i = 0; i < 200 && p.status === 'away'; i++) apply(db, s, minute);
    expect(p.status).toBe('waiting');
  });

  test('карта пациента: «На обследовании: ЭКГ — вернётся к вам в…», вопросы — когда вернётся; «Подождать» — до него', () => {
    setStore(memoryStore());
    forgetShift();
    startShift(7, 'winter');
    for (let i = 0; i < 300 && shiftView().queue.length === 0; i++) {
      if (shiftView().paused) setSpeed(1);
      tick(1000);
    }
    callPatient(shiftView().queue[0].id);
    examine('exam.ecg');
    const v = shiftCaseView()!;
    expect(v.away).toMatch(/^На обследовании: ЭКГ — вернётся к вам в \d\d:\d\d\. Расспросить и осмотреть — когда вернётся$/);
    // при нём — когда вернётся: вопрос и осмотр серым, с причиной; снимок — можно, идёт туда прямо с ЭКГ
    expect(v.unavailable['exam.ask_complaints']).toMatch(/^пациент на обследовании — вернётся в \d\d:\d\d$/);
    expect(v.unavailable['exam.lung_auscultation']).toBeDefined();
    expect(v.unavailable['exam.cbc']).toBeUndefined();
    // «Подождать» — до его возвращения
    waitForResults();
    const p = shiftState()!.patients[shiftState()!.current!];
    expect(shiftState()!.t).toBe(p.out!.back);
    expect(shiftCaseView()!.away).toBeUndefined();
    expect(shiftCaseView()!.unavailable['exam.ask_complaints']).toBeUndefined();
  });
});
