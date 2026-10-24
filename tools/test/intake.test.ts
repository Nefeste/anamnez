// Регистратура и медсестра доврачебного кабинета (spec 2026-10-clinic-flow, замечания владельца 24.10.2026): по одному —
// пришли разом, ждут за последним; срочность и витальные — когда медсестра закончила, и только тогда пациент в очереди
// врача: позвать раньше нельзя. Терпение — от прихода. Без очереди — с тревожной жалобой или такой, при которой срок идёт
// с порога (инсульт: осмотр в 10 минут от поступления): к медсестре сразу, она берёт его следующей. Без доврачебного
// кабинета — после регистратуры в зал, срочность не определена. Прежнее сохранение (до 0.6.9) читается: пациент в
// очереди с прихода, медсестра меряет, если не позвали.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { walkSeconds } from '../../src/engine/hospital/walk';
import { apply, hospitalCtx, newSandbox, newShift, triageOf } from '../../src/engine/shift/engine';
import { type Command, type Notice, REGISTRATION, type ShiftState, TRIAGE } from '../../src/engine/shift/types';

const winter = { season: 'winter' as const };
const minute: Command = { kind: 'advance', seconds: 60 };

/** Первые `n` пришедших сами — разом, в минуту первого из них, но не раньше, чем через минуту от сейчас. */
function together(s: ShiftState, n: number): string[] {
  const walkIns = s.events.filter(x => x.event.kind === 'arrive' && s.patients[x.event.id].kind !== 'ambulance').slice(0, n);
  const ids = walkIns.map(x => (x.event as { id: string }).id);
  const t = Math.max(walkIns[0].t, s.t + 60);
  for (const x of walkIns) x.t = t;
  for (const id of ids) s.patients[id].arriveT = t;
  s.events.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return ids;
}

/** Часы смены — до `t`, по минуте; что сказано за это время. */
function until(s: ShiftState, t: number): Notice[] {
  const heard: Notice[] = [];
  while (s.t < t) heard.push(...apply(db, s, { kind: 'advance', seconds: Math.min(60, t - s.t) }));
  return heard;
}

describe('регистратура и медсестра — по одному', () => {
  test('трое разом: регистратор — каждому по 2 минуты за предыдущим, медсестра — по 3 минуты следом', () => {
    const s = newShift(db, { seed: 21, ...winter });
    const ids = together(s, 3);
    const t0 = s.patients[ids[0]].arriveT;
    until(s, t0);
    const regs = ids.map(id => s.patients[id].intake!.reg);
    expect(regs.map(r => [r.start - t0, r.end - t0])).toEqual([[0, REGISTRATION], [REGISTRATION, 2 * REGISTRATION], [2 * REGISTRATION, 3 * REGISTRATION]]);
    expect(new Set(regs.map(r => r.room)).size).toBe(1);
    const nurses = ids.map(id => s.patients[id].intake!.nurse!);
    // от регистратуры к медсестре — по коридору, секунды
    const walk = nurses[0].start - regs[0].end;
    expect(walk).toBeGreaterThan(0);
    expect(walk).toBeLessThan(60);
    for (let i = 1; i < 3; i++) expect(nurses[i].start).toBe(Math.max(nurses[i - 1].end, regs[i].end + walk));
    expect(nurses.every(n => n.end - n.start === TRIAGE)).toBe(true);
    // пока оформляются — в очереди врача их нет
    for (const id of ids) expect(s.patients[id].status).toBe('intake');
    expect(s.queue.filter(id => ids.includes(id))).toEqual([]);
    until(s, nurses[2].end);
    expect(ids.map(id => s.patients[id].status)).toEqual(['waiting', 'waiting', 'waiting']);
  });

  test('до конца сортировки — без цвета и витальных, позвать нельзя; медсестра закончила — витальные, срочность, в очереди', () => {
    const s = newShift(db, { seed: 21, ...winter });
    const [id] = together(s, 1);
    const p = s.patients[id];
    until(s, p.arriveT);
    expect(p.status).toBe('intake');
    expect(p.triaged).toBe(false);
    expect(p.done).not.toContain('exam.vitals');
    apply(db, s, { kind: 'call', id });
    expect(s.current).toBeUndefined();
    const end = p.intake!.nurse!.end;
    until(s, end - 1);
    expect(p.status).toBe('intake');
    until(s, end);
    expect(p.status).toBe('waiting');
    expect(p.triaged).toBeUndefined();
    const v = p.results.find(r => r.exam === 'exam.vitals')!;
    expect(v.at).toBe(end);
    expect(v.step).toBe(0);
    expect(p.triage).toBe(triageOf(db, p));
    expect(s.queue).toContain(id);
    apply(db, s, { kind: 'call', id });
    expect(s.current).toBe(id);
  });

  test('терпение — от прихода, а не от конца сортировки', () => {
    const s = newShift(db, { seed: 21, ...winter });
    const [id] = together(s, 1);
    const p = s.patients[id];
    until(s, p.arriveT);
    until(s, p.intake!.nurse!.end);
    const left = s.events.find(x => x.event.kind === 'patience' && x.event.id === id);
    expect(p.patience).toBeGreaterThan(0);
    expect(left?.t).toBe(Math.max(p.intake!.nurse!.end + 60, p.arriveT + p.patience));
  });

  test('срочный — сигнал, когда медсестра закончила, а не у двери; впереди в очереди — только срочные', () => {
    let found = false;
    for (let seed = 1; seed < 80 && !found; seed++) {
      const s = newShift(db, { seed, ...winter });
      for (let i = 0; i < 420 && !found; i++) {
        for (const n of apply(db, s, minute)) {
          if (n.kind !== 'arrived') continue;
          const p = s.patients[n.id];
          // у двери — без срочности: её определит медсестра
          if (n.triage === undefined) {
            expect(p.triaged).toBe(false);
            continue;
          }
          expect(n.triage).toBe('red');
          expect(p.status).toBe('waiting');
          expect(p.done).toContain('exam.vitals');
          const ahead = s.queue.slice(0, s.queue.indexOf(p.id)).map(id => s.patients[id]);
          expect(ahead.every(q => q.triage === 'red')).toBe(true);
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  }, 60_000);

  test('без очереди — с признаками инсульта: мимо регистратуры к медсестре, она сразу зовёт врача; кто ждал её — за ним', () => {
    const s = newShift(db, { seed: 21, ...winter });
    const ids = together(s, 3);
    // третий пришедший — с внезапной слабостью в руке: срок осмотра идёт с порога
    s.patients[ids[2]].patient.complaints = ['sym.weakness_one_side'];
    const t0 = s.patients[ids[0]].arriveT;
    until(s, t0);
    const [a, b, c] = ids.map(id => s.patients[id].intake!);
    const plan = hospitalCtx(db, s).plan;
    // карту ему заведут потом: у регистратора он не стоит, её время — не его
    expect(c.rush).toBe(true);
    expect([c.reg.start - t0, c.reg.end - t0]).toEqual([0, 0]);
    expect([a.reg.start - t0, b.reg.start - t0]).toEqual([0, REGISTRATION]);
    // медсестра свободна — сразу, как дошёл
    const walk = walkSeconds(plan, c.reg.room, c.nurse!.room);
    expect([c.nurse!.start - t0, c.nurse!.end - t0]).toEqual([walk, walk + TRIAGE]);
    // кто ждал её — за ним: первый — когда она освободилась, второй — после первого
    expect(a.nurse!.start).toBe(Math.max(a.reg.end + walkSeconds(plan, a.reg.room, a.nurse!.room), c.nurse!.end));
    expect(b.nurse!.start).toBe(Math.max(b.reg.end + walkSeconds(plan, b.reg.room, b.nurse!.room), a.nurse!.end));
    // медсестра его увидела — сразу зовёт врача: в очереди он первый, цвет — по жалобе, её витальные — к концу
    const p = s.patients[ids[2]];
    const heard = until(s, c.nurse!.start);
    expect(p.status).toBe('waiting');
    expect([p.triaged, p.triage]).toEqual([undefined, 'red']);
    expect(heard).toContainEqual({ kind: 'arrived', id: p.id, triage: 'red' });
    expect(s.queue[0]).toBe(p.id);
    expect(p.done).not.toContain('exam.vitals');
    until(s, c.nurse!.end);
    expect(p.results.find(r => r.exam === 'exam.vitals')?.at).toBe(c.nurse!.end);
    until(s, b.nurse!.end);
    expect(ids.map(id => s.patients[id].status)).toEqual(['waiting', 'waiting', 'waiting']);
  });

  test('двое без очереди: второй — за первым, и тогда, когда первый уже в очереди врача, а у медсестры ещё стоит', () => {
    for (const late of [0, 60]) {
      const s = newShift(db, { seed: 21, ...winter });
      const ids = together(s, 2);
      for (const id of ids) s.patients[id].patient.complaints = ['sym.weakness_one_side'];
      // второй — разом с первым или через минуту, когда первый уже у медсестры
      const ev = s.events.find(x => x.event.kind === 'arrive' && x.event.id === ids[1])!;
      ev.t += late;
      s.patients[ids[1]].arriveT += late;
      s.events.sort((a, b) => a.t - b.t || a.seq - b.seq);
      until(s, s.patients[ids[1]].arriveT);
      const [a, b] = ids.map(id => s.patients[id].intake!);
      expect([a.rush, b.rush]).toEqual([true, true]);
      if (late > 0) expect(s.patients[ids[0]].status).toBe('waiting');
      // по одному: второй — когда она закончила с первым, и первого не отодвинули
      expect(b.nurse!.start).toBe(a.nurse!.end);
      expect(a.nurse!.start).toBe(s.patients[ids[0]].arriveT + walkSeconds(hospitalCtx(db, s).plan, a.reg.room, a.nurse!.room));
      // второй — в очереди врача с её первой минуты с ним, витальные первого — к концу её минут с первым
      until(s, b.nurse!.start);
      expect(s.patients[ids[1]].status).toBe('waiting');
      expect(s.patients[ids[0]].results.find(r => r.exam === 'exam.vitals')?.at).toBe(a.nurse!.end);
    }
  });

  test('без очереди — и прошедшая слабость (ТИА, жёлтая): осмотр при подозрении на инсульт успевает в 10 минут от прихода', () => {
    const s = newShift(db, { seed: 21, ...winter });
    const [id] = together(s, 1);
    const p = s.patients[id];
    p.patient.complaints = ['sym.transient_weakness'];
    until(s, p.arriveT);
    expect(p.triage).toBe('yellow');
    expect(p.intake!.rush).toBe(true);
    // медсестра увидела — зовёт врача; врач свободен — зовёт его и осматривает
    until(s, p.intake!.nurse!.start);
    expect(p.status).toBe('waiting');
    apply(db, s, { kind: 'call', id });
    apply(db, s, { kind: 'exam', exam: 'exam.neuro_exam' });
    const done = p.results.find(r => r.exam === 'exam.neuro_exam')!;
    expect((done.at - p.arriveT) / 60).toBeLessThanOrEqual(10);
    // позвали раньше, чем медсестра закончила, — её витальных нет: меряет врач
    expect(p.done).not.toContain('exam.vitals');
  });

  test('витальные медсестры — те же, когда бы она ни мерила: та же ветвь зерна', () => {
    const a = newShift(db, { seed: 33, ...winter });
    const b = newShift(db, { seed: 33, ...winter });
    for (let i = 0; i < 180; i++) {
      apply(db, a, minute);
      apply(db, b, minute);
    }
    for (const p of Object.values(a.patients)) {
      const q = b.patients[p.id];
      expect(p.results.find(r => r.exam === 'exam.vitals')?.obs).toEqual(q.results.find(r => r.exam === 'exam.vitals')?.obs);
    }
    const measured = Object.values(a.patients).filter(p => p.done.includes('exam.vitals'));
    expect(measured.length).toBeGreaterThan(5);
  });

  test('без доврачебного кабинета — после регистратуры в зал: витальных нет, срочность не определена', () => {
    const s = newSandbox(db, { seed: 5, ...winter, start: 'clinic', budget: db.economy.sandbox.budgets.normal });
    const triage = s.hospital!.rooms.find(r => r.type === 'room.triage')!;
    apply(db, s, { kind: 'build', cmd: { kind: 'demolish', room: triage.id } });
    apply(db, s, { kind: 'buildEnd' });
    expect(s.hospital!.rooms.some(r => r.type === 'room.triage')).toBe(false);
    apply(db, s, { kind: 'nextDay' });
    expect(s.dayOpen).toBe(true);
    const ids = together(s, 2);
    const t0 = s.patients[ids[0]].arriveT;
    until(s, t0);
    expect(ids.map(id => s.patients[id].intake!.nurse)).toEqual([undefined, undefined]);
    const second = s.patients[ids[1]].intake!.reg;
    expect([second.start - t0, second.end - t0]).toEqual([REGISTRATION, 2 * REGISTRATION]);
    until(s, second.end);
    for (const id of ids) {
      expect(s.patients[id].status).toBe('waiting');
      expect(s.patients[id].done).not.toContain('exam.vitals');
      expect(s.patients[id].triaged).toBe(false);
    }
    // и без очереди некому: со слабостью в руке — тоже регистратура, срочность не определена
    const [id] = together(s, 1);
    const p = s.patients[id];
    p.patient.complaints = ['sym.weakness_one_side'];
    until(s, p.arriveT);
    expect(p.intake!.rush).toBeUndefined();
    expect(p.intake!.reg.end - p.intake!.reg.start).toBe(REGISTRATION);
    until(s, p.intake!.reg.end);
    expect([p.status, p.triaged]).toEqual(['waiting', false]);
  });

  test('сохранение до 0.6.9: пациент уже в очереди с прихода — медсестра меряет, если его не позвали', () => {
    const s = newShift(db, { seed: 21, ...winter });
    const [id] = together(s, 1);
    const p = s.patients[id];
    until(s, p.arriveT);
    // так он лежал в сохранении 0.6.8: в очереди, без пути от двери, событие медсестры — впереди
    p.status = 'waiting';
    delete p.intake;
    delete p.triaged;
    s.queue = [...s.queue, id];
    until(s, p.arriveT + REGISTRATION + TRIAGE + 60);
    expect(p.done).toContain('exam.vitals');
    expect(s.queue).toContain(id);
  });
});
