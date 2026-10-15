// Регистратура и медсестра доврачебного кабинета (0.5.12, отзыв на 0.5.11): срочного, которого позвали сразу, он приходил
// к врачу уже измеренным. Теперь у двери — срочность по жалобе (её слышит регистратор), а давление, пульс, температура и
// сатурация — когда пациент дошёл до медсестры и она закончила, через 5 минут; позвали раньше — меряет врач. Срочный по
// витальным — выше в очереди, и об этом сигнал.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { apply, newSandbox, newShift, triageOf } from '../../src/engine/shift/engine';
import { type Command, type Notice, REGISTRATION, type ShiftState, TRIAGE } from '../../src/engine/shift/types';

const winter = { season: 'winter' as const };
const minute: Command = { kind: 'advance', seconds: 60 };

/** Первые пришедшие сами (не по скорой) и что о них сказано. */
function firstArrivals(s: ShiftState, n: number): { ids: string[]; heard: Notice[] } {
  const heard: Notice[] = [];
  for (let i = 0; i < 600 && heard.filter(x => x.kind === 'arrived').length < n; i++) heard.push(...apply(db, s, minute));
  return { ids: heard.filter(x => x.kind === 'arrived').map(x => (x as { id: string }).id).slice(0, n), heard };
}

describe('регистратура и медсестра', () => {
  test('у двери — срочность по жалобе и без витальных; через 5 минут медсестра померила', () => {
    const s = newShift(db, { seed: 21, ...winter });
    const { ids } = firstArrivals(s, 1);
    const p = s.patients[ids[0]];
    expect(s.t - p.arriveT).toBeLessThan(REGISTRATION + TRIAGE);
    expect(p.done).not.toContain('exam.vitals');
    expect(p.results).toEqual([]);
    expect(p.triage).toBe(triageOf(db, p));
    while (s.t < p.arriveT + REGISTRATION + TRIAGE) apply(db, s, minute);
    expect(p.done).toContain('exam.vitals');
    const v = p.results.find(r => r.exam === 'exam.vitals')!;
    expect(v.at).toBe(p.arriveT + REGISTRATION + TRIAGE);
    expect(v.step).toBe(0);
    expect(p.triage).toBe(triageOf(db, p));
  });

  test('позвали раньше — пришёл к врачу без витальных, медсестра его уже не меряет; врач меряет сам', () => {
    const s = newShift(db, { seed: 21, ...winter });
    const { ids } = firstArrivals(s, 1);
    const p = s.patients[ids[0]];
    apply(db, s, { kind: 'call', id: p.id });
    expect(s.current).toBe(p.id);
    for (let i = 0; i < 10; i++) apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'advance', seconds: REGISTRATION + TRIAGE });
    expect(p.results.some(r => r.exam === 'exam.vitals')).toBe(false);
    const t0 = s.t;
    apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
    const v = p.results.find(r => r.exam === 'exam.vitals')!;
    expect(v).toBeDefined();
    expect(v.step).toBeGreaterThan(0);
    expect(s.t - t0).toBe(db.exams['exam.vitals'].time.procedure * 60);
  });

  test('витальные медсестры — те же, когда бы она ни мерила: та же ветвь зерна', () => {
    const a = newShift(db, { seed: 33, ...winter });
    const b = newShift(db, { seed: 33, ...winter });
    for (let i = 0; i < 180; i++) {
      apply(db, a, minute);
      apply(db, b, minute);
    }
    // в смене b никого не зовут, в a — тоже: витальные одни и те же у всех померенных
    for (const p of Object.values(a.patients)) {
      const q = b.patients[p.id];
      expect(p.results.find(r => r.exam === 'exam.vitals')?.obs).toEqual(q.results.find(r => r.exam === 'exam.vitals')?.obs);
    }
    const measured = Object.values(a.patients).filter(p => p.done.includes('exam.vitals'));
    expect(measured.length).toBeGreaterThan(5);
  });

  test('срочный по витальным — сигнал, когда медсестра померила, и выше в очереди', () => {
    let found = false;
    for (let seed = 1; seed < 80 && !found; seed++) {
      const s = newShift(db, { seed, ...winter });
      for (let i = 0; i < 420 && !found; i++) {
        const before = new Map(Object.values(s.patients).map(p => [p.id, p.triage]));
        const heard = apply(db, s, minute);
        for (const n of heard) {
          if (n.kind !== 'arrived' || n.triage !== 'red') continue;
          const p = s.patients[n.id];
          // пришёл раньше не срочным, а медсестра нашла срочное
          if (p.arriveT === s.t || before.get(p.id) === 'red' || !p.done.includes('exam.vitals')) continue;
          expect(p.triage).toBe('red');
          // впереди — только срочные
          const ahead = s.queue.slice(0, s.queue.indexOf(p.id)).map(id => s.patients[id]);
          expect(s.queue).toContain(p.id);
          expect(ahead.every(q => q.triage === 'red')).toBe(true);
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  }, 60_000);

  test('без доврачебного кабинета — как прежде: витальных нет, их меряет врач, срочность не определена', () => {
    const s = newSandbox(db, { seed: 5, ...winter, start: 'clinic', budget: db.economy.sandbox.budgets.normal });
    const triage = s.hospital!.rooms.find(r => r.type === 'room.triage')!;
    apply(db, s, { kind: 'build', cmd: { kind: 'demolish', room: triage.id } });
    apply(db, s, { kind: 'buildEnd' });
    expect(s.hospital!.rooms.some(r => r.type === 'room.triage')).toBe(false);
    apply(db, s, { kind: 'nextDay' });
    expect(s.dayOpen).toBe(true);
    const { ids } = firstArrivals(s, 2);
    apply(db, s, { kind: 'advance', seconds: REGISTRATION + TRIAGE });
    for (const id of ids) {
      expect(s.patients[id].done).not.toContain('exam.vitals');
      expect(s.patients[id].triaged).toBe(false);
    }
  });
});
