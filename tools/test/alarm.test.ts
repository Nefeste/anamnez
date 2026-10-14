// Тревога монитора (FR-AV-1, 0.5.7; spec 2026-10-alarm-portraits): у привезённого скорой в смотровой остановилось
// сердце, пока вы у другого больного, — в карте «за это время» строка об этом первая, и звучит тревога монитора, а не
// «готово»; само событие и разряд — в движке с части 39б (rsc.test). Звук — в audio.test.
import { afterEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { apply, newSandbox } from '../../src/engine/shift/engine';
import { SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { patientName } from '../../src/state/caseView';
import { memoryStore, saveSlot } from '../../src/state/saves';
import { examine, forgetShift, loadShift, SANDBOX_SLOT, setStore, shiftCaseView } from '../../src/state/session';

/** Песочница с готовой амбулаторией и смотровой приёмного справа (как в ambulance.test); медсестра ЭКГ — в смотровую. */
function withEmergency(seed: number): ShiftState {
  const s = newSandbox(db, { seed, season: 'winter', difficulty: 'doctor', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size: 'M', x: 29, y: 1, rot: 0 } });
  apply(db, s, { kind: 'buildEnd' });
  const room = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const nurse = s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!;
  apply(db, s, { kind: 'assign', id: nurse.id, room });
  return s;
}

/** День, когда привезённый лежит в смотровой, а в очереди ждёт пришедший сам. */
function bayAndQueue(): { s: ShiftState; bay: ShiftPatient; walkIn: string } {
  for (let seed = 21; seed < 61; seed++) {
    const s = withEmergency(seed);
    apply(db, s, { kind: 'nextDay' });
    for (let i = 0; i < 10 * 60 && s.dayOpen; i++) {
      const bay = Object.values(s.patients).find(p => p.kind === 'ambulance' && p.bay && p.status === 'waiting' && !p.closed);
      const walkIn = s.queue.find(id => s.patients[id].kind !== 'ambulance');
      if (bay && walkIn) return { s, bay, walkIn };
      apply(db, s, { kind: 'advance', seconds: 60 });
    }
  }
  throw new Error('за 40 зёрен не нашлось');
}

afterEach(() => forgetShift());

describe('тревога монитора в карте пациента', () => {
  test('остановка сердца в смотровой, пока вы у другого: строка о ней — первой, сигнал — тревога, а не «готово»', async () => {
    const { s, bay, walkIn } = bayAndQueue();
    apply(db, s, { kind: 'call', id: walkIn });
    expect(s.current).toBe(walkIn);
    // фибрилляция — через секунду: на неё уйдёт первый же расспрос
    s.events.unshift({ t: s.t + 1, seq: s.seq++, event: { kind: 'arrest', id: bay.id } });
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, SANDBOX_SLOT, s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    expect(shiftCaseView()!.alarm).toBeUndefined();
    examine('exam.ask_complaints');
    const v = shiftCaseView()!;
    expect(v.alarm).toBe(true);
    expect(v.meanwhile[0]).toBe(T.shift.notice.arrest(patientName(bay.patient)));
    // следующий расспрос без нового события — без тревоги
    examine('exam.ask_allergies');
    expect(shiftCaseView()!.alarm).toBeUndefined();
  }, 30_000);
});
